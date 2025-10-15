const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');
const cors = require('cors');
const path = require('path');
const axios = require('axios');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');

// ✅ IMPORTER LES UTILITAIRES
const { Logger } = require('./utils/logger');
const { 
  asyncHandler, 
  requestLogger, 
  errorHandler, 
  notFoundHandler,
  validateContentType,
  rateLimiter
} = require('./utils/middleware');
const { 
  ValidationError,
  sanitizeString,
  validateOrderInput,
  validateAddress
} = require('./utils/validation');

const logger = new Logger('Server');
const app = express();
app.set('trust proxy', 1);

const PORT = process.env.PORT || 3000;

// ==================== CONFIGURATION ====================
const config = {
  telegram: {
    token: process.env.TELEGRAM_TOKEN,
    adminChatId: process.env.ADMIN_CHAT_ID || '',
    supportChatId: process.env.SUPPORT_CHAT_ID || '',
    driverMillauId: process.env.DRIVER_MILLAU_ID || '',
    driverExterieurId: process.env.DRIVER_EXTERIEUR_ID || '',
  },
  mapbox: {
    key: process.env.MAPBOX_KEY || '',
  },
  admin: {
    password: process.env.ADMIN_PASS,
    tokenExpiry: 24 * 60 * 60 * 1000,
  },
  webapp: {
    url: process.env.WEBAPP_URL || 'http://localhost:3000',
  },
  loyalty: {
    defaultThreshold: 10,
    maxDiscount: 20,
    discountPercent: 0.1,
  },
  deliveryZones: {
    millau: {
      name: 'Millau',
      keywords: ['millau'],
      driverIdKey: 'driverMillauId',
    },
    exterieur: {
      name: 'Extérieur',
      keywords: ['extérieur', 'exterieur'],
      driverIdKey: 'driverExterieurId',
    },
  },
};

// ✅ VALIDATION DE LA CONFIGURATION
function validateConfig() {
  const errors = [];
  
  if (!config.telegram.token) {
    errors.push('❌ TELEGRAM_TOKEN est requis');
  }
  
  if (!config.admin.password) {
    errors.push('❌ ADMIN_PASS est requis');
  } else if (config.admin.password.length < 12) {
    errors.push('❌ ADMIN_PASS doit faire au moins 12 caractères');
  }
  
  if (errors.length > 0) {
    console.error('\n⚠️  ERREURS DE CONFIGURATION:\n');
    errors.forEach(err => console.error(err));
    console.error('\n💡 Vérifiez votre fichier .env\n');
    throw new Error('Configuration invalide');
  }
  
  logger.success('Configuration validée');
}

// ==================== MIDDLEWARE ====================
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.static(path.join(__dirname, '..', 'public')));
app.use(requestLogger);
app.use(validateContentType);

// ==================== RATE LIMITERS ====================
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: { ok: false, error: 'Trop de requêtes, réessayez plus tard' },
  standardHeaders: true,
  legacyHeaders: false,
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: { ok: false, error: 'Trop de tentatives de connexion' },
  standardHeaders: true,
  legacyHeaders: false,
});

const orderLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 3,
  message: { ok: false, error: 'Trop de commandes. Attendez 5 minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// ==================== STORES ====================
class TokenStore {
  constructor(expiryMs) {
    this.tokens = new Map();
    this.expiryMs = expiryMs;
  }

  add(token) {
    this.tokens.set(token, Date.now() + this.expiryMs);
    this.cleanup();
  }

  has(token) {
    const expiry = this.tokens.get(token);
    if (!expiry || Date.now() > expiry) {
      this.tokens.delete(token);
      return false;
    }
    return true;
  }

  cleanup() {
    const now = Date.now();
    for (const [token, expiry] of this.tokens.entries()) {
      if (now > expiry) this.tokens.delete(token);
    }
  }

  generateToken() {
    return Math.random().toString(36).substr(2) + Date.now().toString(36);
  }
}

const adminTokens = new TokenStore(config.admin.tokenExpiry);
const activeConversations = new Map();

// ==================== DATABASE ====================
let db;

async function initDB() {
  logger.info('Initialisation de la base de données...');
  
  db = await open({
    filename: './boutique.db',
    driver: sqlite3.Database
  });

  await db.exec(`
    CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer TEXT NOT NULL,
      type TEXT NOT NULL,
      address TEXT,
      items TEXT NOT NULL,
      total REAL NOT NULL,
      discount REAL DEFAULT 0,
      status TEXT DEFAULT 'pending',
      delivery_time INTEGER,
      assigned_driver_zone TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS stock (
      product_id INTEGER NOT NULL,
      variant TEXT NOT NULL,
      qty INTEGER DEFAULT 0,
      PRIMARY KEY (product_id, variant)
    );

    CREATE TABLE IF NOT EXISTS stock_movements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id INTEGER NOT NULL,
      variant TEXT NOT NULL,
      type TEXT NOT NULL,
      quantity INTEGER NOT NULL,
      stock_after INTEGER NOT NULL,
      reason TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS reviews (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id INTEGER,
      name TEXT,
      stars INTEGER NOT NULL CHECK(stars BETWEEN 1 AND 5),
      text TEXT NOT NULL,
      approved INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL CHECK(type IN ('revenue', 'expense')),
      category TEXT NOT NULL,
      description TEXT NOT NULL,
      amount REAL NOT NULL CHECK(amount >= 0),
      payment_method TEXT,
      note TEXT,
      date DATE NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS employees (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      position TEXT NOT NULL,
      type TEXT NOT NULL,
      salary REAL NOT NULL CHECK(salary >= 0),
      hire_date DATE NOT NULL,
      status TEXT DEFAULT 'active' CHECK(status IN ('active', 'inactive')),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS payroll (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      employee_id INTEGER NOT NULL,
      employee_name TEXT NOT NULL,
      month INTEGER NOT NULL CHECK(month BETWEEN 1 AND 12),
      year INTEGER NOT NULL,
      gross_amount REAL NOT NULL CHECK(gross_amount >= 0),
      bonus REAL DEFAULT 0 CHECK(bonus >= 0),
      net_amount REAL NOT NULL CHECK(net_amount >= 0),
      status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'paid', 'cancelled')),
      payment_date DATE,
      note TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (employee_id) REFERENCES employees(id)
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS loyalty (
      customer TEXT PRIMARY KEY,
      orders_count INTEGER DEFAULT 0,
      last_order_date DATETIME
    );

    CREATE TABLE IF NOT EXISTS customers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      contact TEXT NOT NULL UNIQUE,
      status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'approved', 'blocked')),
      first_order_date DATETIME DEFAULT CURRENT_TIMESTAMP,
      approved_date DATETIME,
      approved_by TEXT,
      blocked_reason TEXT,
      notes TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
    CREATE INDEX IF NOT EXISTS idx_orders_created_at ON orders(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_orders_customer ON orders(customer);
    CREATE INDEX IF NOT EXISTS idx_transactions_date ON transactions(date DESC);
    CREATE INDEX IF NOT EXISTS idx_customers_status ON customers(status);
    CREATE INDEX IF NOT EXISTS idx_customers_contact ON customers(contact);
    CREATE INDEX IF NOT EXISTS idx_loyalty_customer ON loyalty(customer);
  `);

  await db.run(`
    INSERT OR IGNORE INTO settings (key, value) VALUES 
    ('shop_name', 'DROGUA CENTER'),
    ('delivery_fee', '20'),
    ('loyalty_threshold', '${config.loyalty.defaultThreshold}'),
    ('cash_balance', '0'),
    ('monthly_goal', '5000')
  `);

  logger.success('Base de données initialisée');
}

// ==================== UTILITIES ====================
function getTimeAgo(timestamp) {
  const now = new Date();
  const past = new Date(timestamp);
  const diffMs = now - past;
  const diffMins = Math.floor(diffMs / 60000);
  
  if (diffMins < 1) return 'À l\'instant';
  if (diffMins < 60) return `Il y a ${diffMins} min`;
  
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `Il y a ${diffHours}h`;
  
  const diffDays = Math.floor(diffHours / 24);
  return `Il y a ${diffDays}j`;
}

// ==================== TELEGRAM SERVICE ====================
class TelegramService {
  constructor(token) {
    this.token = token;
    this.baseUrl = `https://api.telegram.org/bot${token}`;
    this.logger = new Logger('Telegram');
  }

  async sendMessage(chatId, text, options = {}) {
    if (!this.token || !chatId) {
      this.logger.warn('Configuration Telegram incomplète');
      return null;
    }

    try {
      const response = await axios.post(`${this.baseUrl}/sendMessage`, {
        chat_id: chatId,
        text,
        parse_mode: 'HTML',
        ...options
      }, { timeout: 10000 });
      
      this.logger.info('Message envoyé', { chatId });
      return response.data;
    } catch (error) {
      this.logger.error('Erreur envoi message', { chatId, error: error.message });
      return null;
    }
  }
}

const telegram = new TelegramService(config.telegram.token);

// ==================== BUSINESS LOGIC ====================
async function getOrCreateCustomer(contact) {
  let customer = await db.get(
    'SELECT * FROM customers WHERE contact = ?',
    [contact]
  );
  
  if (!customer) {
    try {
      const result = await db.run(
        'INSERT INTO customers (contact, status) VALUES (?, ?)',
        [contact, 'pending']
      );
      
      customer = await db.get('SELECT * FROM customers WHERE id = ?', [result.lastID]);
      logger.info('Nouveau client', { contact, id: customer.id });
    } catch (error) {
      if (error.message && error.message.includes('UNIQUE')) {
        customer = await db.get('SELECT * FROM customers WHERE contact = ?', [contact]);
      } else {
        throw error;
      }
    }
  }
  
  return customer;
}

async function isCustomerBlocked(contact) {
  const customer = await db.get(
    'SELECT status, blocked_reason FROM customers WHERE contact = ?',
    [contact]
  );
  
  return customer && customer.status === 'blocked' ? customer : null;
}

async function calculateLoyaltyDiscount(customer, total) {
  const loyalty = await db.get('SELECT * FROM loyalty WHERE customer = ?', [customer]);
  const threshold = config.loyalty.defaultThreshold;
  
  let discount = 0;
  if (loyalty && (loyalty.orders_count + 1) % threshold === 0) {
    discount = Math.min(total * config.loyalty.discountPercent, config.loyalty.maxDiscount);
  }
  
  return { discount, willEarnDiscount: discount > 0 };
}

async function updateLoyaltyProgram(customer) {
  const existing = await db.get('SELECT * FROM loyalty WHERE customer = ?', [customer]);
  
  if (existing) {
    await db.run(
      'UPDATE loyalty SET orders_count = orders_count + 1, last_order_date = CURRENT_TIMESTAMP WHERE customer = ?',
      [customer]
    );
  } else {
    await db.run(
      'INSERT INTO loyalty (customer, orders_count, last_order_date) VALUES (?, 1, CURRENT_TIMESTAMP)',
      [customer]
    );
  }
}

// ✅ VÉRIFICATION DES STOCKS
async function checkStockAvailability(items) {
  const unavailable = [];
  
  for (const item of items) {
    const stock = await db.get(
      'SELECT qty FROM stock WHERE product_id = ? AND variant = ?',
      [item.product_id, item.variant]
    );
    
    if (!stock || stock.qty < item.qty) {
      unavailable.push({
        name: item.name,
        variant: item.variant,
        available: stock?.qty || 0,
        requested: item.qty
      });
    }
  }
  
  return { ok: unavailable.length === 0, unavailable };
}

async function updateStockForOrder(items, orderId) {
  for (const item of items) {
    await db.run(
      'UPDATE stock SET qty = MAX(0, qty - ?) WHERE product_id = ? AND variant = ?',
      [item.qty, item.product_id, item.variant]
    );
    
    const stockAfter = await db.get(
      'SELECT qty FROM stock WHERE product_id = ? AND variant = ?',
      [item.product_id, item.variant]
    );
    
    await db.run(
      `INSERT INTO stock_movements (product_id, variant, type, quantity, stock_after, reason)
       VALUES (?, ?, 'out', ?, ?, ?)`,
      [item.product_id, item.variant, item.qty, stockAfter?.qty || 0, `Commande #${orderId}`]
    );
  }
}

// ==================== PUBLIC ROUTES ====================

app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    telegram: !!config.telegram.token,
    database: !!db
  });
});

// ✅ VÉRIFIER LES STOCKS
app.post('/api/check-stock', apiLimiter, asyncHandler(async (req, res) => {
  const { items } = req.body;
  
  if (!Array.isArray(items)) {
    throw new ValidationError('Items doit être un tableau');
  }
  
  const result = await checkStockAvailability(items);
  res.json(result);
}));

// ✅ CRÉER UNE COMMANDE (AMÉLIORÉ)
app.post('/api/create-order', orderLimiter, asyncHandler(async (req, res) => {
  logger.info('Nouvelle commande', { customer: req.body.customer });
  
  // ✅ Validation stricte
  validateOrderInput(req.body);
  
  const { customer, type, address, items, total } = req.body;
  
  // ✅ Sanitization
  const sanitizedCustomer = sanitizeString(customer, 'contact', 100);
  const sanitizedType = sanitizeString(type, 'text', 50);
  const sanitizedAddress = sanitizeString(address, 'address', 200);
  
  // ✅ Vérifier si client bloqué
  const blockedCustomer = await isCustomerBlocked(sanitizedCustomer);
  if (blockedCustomer) {
    const reason = blockedCustomer.blocked_reason || 'Compte bloqué';
    throw new ValidationError(`Compte bloqué: ${reason}. Contactez le support.`);
  }
  
  // ✅ Vérifier les stocks
  const stockCheck = await checkStockAvailability(items);
  if (!stockCheck.ok) {
    const details = stockCheck.unavailable.map(u => 
      `${u.name} (${u.variant}): ${u.available} dispo, ${u.requested} demandé`
    ).join(', ');
    
    throw new ValidationError(`Stock insuffisant: ${details}`);
  }
  
  const customerRecord = await getOrCreateCustomer(sanitizedCustomer);
  const isNewCustomer = customerRecord.status === 'pending';
  const isApproved = customerRecord.status === 'approved';
  
  let discount = 0;
  if (isApproved) {
    const loyaltyResult = await calculateLoyaltyDiscount(sanitizedCustomer, total);
    discount = loyaltyResult.discount;
  }
  
  const finalTotal = total - discount;
  const orderStatus = isNewCustomer ? 'pending_approval' : 'pending';
  
  // ✅ Transaction atomique
  await db.run('BEGIN TRANSACTION');
  
  try {
    const result = await db.run(
      `INSERT INTO orders (customer, type, address, items, total, discount, status) 
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [sanitizedCustomer, sanitizedType, sanitizedAddress, JSON.stringify(items), finalTotal, discount, orderStatus]
    );
    
    const orderId = result.lastID;
    
    await updateStockForOrder(items, orderId);
    
    if (isApproved) {
      await updateLoyaltyProgram(sanitizedCustomer);
      
      await db.run(
        `INSERT INTO transactions (type, category, description, amount, payment_method, date)
         VALUES ('revenue', 'vente', ?, ?, 'online', DATE('now'))`,
        [`Commande #${orderId}`, finalTotal]
      );
    }
    
    await db.run('COMMIT');
    
    // Notification
    if (config.telegram.adminChatId) {
      const statusMsg = isNewCustomer ? '🆕 NOUVEAU CLIENT - VALIDATION REQUISE' : '📦 NOUVELLE COMMANDE';
      await telegram.sendMessage(
        config.telegram.adminChatId,
        `${statusMsg}\n\n#${orderId}\n👤 ${sanitizedCustomer}\n💰 ${finalTotal}€`
      );
    }
    
    logger.success('Commande créée', { orderId, total: finalTotal });
    
    res.json({ 
      ok: true, 
      orderId, 
      discount,
      requiresApproval: isNewCustomer,
      message: isNewCustomer 
        ? 'Commande en attente de validation' 
        : 'Commande confirmée !'
    });
    
  } catch (error) {
    await db.run('ROLLBACK');
    throw error;
  }
}));

// ==================== ADMIN ROUTES ====================
function requireAdmin(req, res, next) {
  const token = req.headers['x-admin-token'];
  if (!token || !adminTokens.has(token)) {
    return res.status(401).json({ ok: false, error: 'Non autorisé' });
  }
  next();
}

app.post('/api/admin/login', authLimiter, asyncHandler(async (req, res) => {
  const { password } = req.body;
  
  if (!password) {
    throw new ValidationError('Mot de passe requis');
  }
  
  if (password === config.admin.password) {
    const token = adminTokens.generateToken();
    adminTokens.add(token);
    logger.info('Connexion admin réussie');
    res.json({ ok: true, token });
  } else {
    logger.warn('Tentative de connexion admin échouée');
    throw new ValidationError('Mot de passe incorrect');
  }
}));

app.get('/api/admin/stats', requireAdmin, asyncHandler(async (req, res) => {
  const stats = {};
  
  const revenue = await db.get("SELECT SUM(total) as total FROM orders WHERE status != 'cancelled'");
  stats.totalCA = revenue?.total || 0;
  
  const orders = await db.get("SELECT COUNT(*) as count FROM orders WHERE status != 'cancelled'");
  stats.totalOrders = orders?.count || 0;
  
  stats.avgOrder = stats.totalOrders > 0 ? stats.totalCA / stats.totalOrders : 0;
  
  const stock = await db.all('SELECT * FROM stock');
  stats.stockOut = stock.filter(s => s.qty === 0).length;
  stats.stockLow = stock.filter(s => s.qty > 0 && s.qty < 10).length;
  
  res.json({ ok: true, stats });
}));

app.get('/api/admin/orders', requireAdmin, asyncHandler(async (req, res) => {
  const { status, limit = 100 } = req.query;
  let query = 'SELECT * FROM orders';
  const params = [];
  
  if (status && status !== 'all') {
    query += ' WHERE status = ?';
    params.push(status);
  }
  
  query += ' ORDER BY created_at DESC LIMIT ?';
  params.push(Math.min(parseInt(limit), 500));
  
  const orders = await db.all(query, params);
  
  orders.forEach(order => {
    try {
      order.items = JSON.parse(order.items);
    } catch (e) {
      order.items = [];
    }
  });
  
  res.json({ ok: true, orders });
}));

// ==================== ERROR HANDLERS ====================
app.use(notFoundHandler);
app.use(errorHandler);

// ==================== STARTUP ====================
async function start() {
  try {
    validateConfig();
    await initDB();
    
    app.listen(PORT, () => {
      logger.success('🚀 Serveur démarré');
      logger.info('Configuration', {
        port: PORT,
        telegram: !!config.telegram.token
      });
      console.log('');
      console.log('📱 Frontend: http://localhost:' + PORT);
      console.log('🔐 Admin: http://localhost:' + PORT + '/admin.html');
      console.log('💚 Health: http://localhost:' + PORT + '/health');
      console.log('');
    });
    
  } catch (error) {
    logger.error('Erreur fatale', { error: error.message });
    process.exit(1);
  }
}

process.on('SIGTERM', async () => {
  logger.info('Arrêt en cours...');
  if (db) await db.close();
  process.exit(0);
});

process.on('SIGINT', async () => {
  logger.info('Arrêt en cours...');
  if (db) await db.close();
  process.exit(0);
});

start();
