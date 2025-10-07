const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');
const cors = require('cors');
const path = require('path');
const axios = require('axios');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');

const app = express();
app.set('trust proxy', 1);

const PORT = process.env.PORT || 3000;

// ==================== CONFIGURATION ====================
const config = {
  telegram: {
    token: process.env.TELEGRAM_TOKEN || '7364804422:AAGsiuQhHUVUxb1BfXsb28lKWcot8gxHD30',
    adminChatId: process.env.ADMIN_CHAT_ID || '',
    supportChatId: process.env.SUPPORT_CHAT_ID || '',
    driverMillauId: process.env.DRIVER_MILLAU_ID || '',
    driverExterieurId: process.env.DRIVER_EXTERIEUR_ID || '',
  },
  mapbox: {
    key: process.env.MAPBOX_KEY || '',
  },
  admin: {
    password: process.env.ADMIN_PASS || 'gangstaforlife12',
    tokenExpiry: 24 * 60 * 60 * 1000,
  },
  webapp: {
    url: process.env.WEBAPP_URL || 'https://shop-2-production.up.railway.app',
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

// ==================== SECURITY MIDDLEWARE ====================
app.use(helmet({
  contentSecurityPolicy: false,
}));

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: { ok: false, error: 'Trop de requêtes, réessayez plus tard' },
  validate: false,
  standardHeaders: true,
  legacyHeaders: false,
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: { ok: false, error: 'Trop de tentatives de connexion' },
  validate: false,
  standardHeaders: true,
  legacyHeaders: false,
});

// ==================== MIDDLEWARE ====================
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.static(path.join(__dirname, '..', 'public')));

// ==================== IN-MEMORY STORES ====================
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
      product_id INTEGER NOT NULL,
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
    CREATE INDEX IF NOT EXISTS idx_transactions_date ON transactions(date DESC);
    CREATE INDEX IF NOT EXISTS idx_stock_movements_created_at ON stock_movements(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_customers_status ON customers(status);
    CREATE INDEX IF NOT EXISTS idx_customers_contact ON customers(contact);
    CREATE INDEX IF NOT EXISTS idx_customers_created_at ON customers(created_at DESC);
  `);

  await db.run(`
    INSERT OR IGNORE INTO settings (key, value) VALUES 
    ('shop_name', 'DROGUA CENTER'),
    ('delivery_fee', '20'),
    ('loyalty_threshold', '${config.loyalty.defaultThreshold}'),
    ('cash_balance', '0'),
    ('monthly_goal', '5000')
  `);

  console.log('✅ Database initialized with indexes');
}

// ==================== UTILITIES ====================
class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
  }
}

function sanitizeString(str, maxLength = 500) {
  if (typeof str !== 'string') return '';
  return str.trim().slice(0, maxLength);
}

function validateOrderInput(data) {
  const { customer, type, items, total } = data;
  
  if (!customer || typeof customer !== 'string' || customer.trim().length < 2) {
    throw new ValidationError('Contact client invalide');
  }
  
  if (!type || typeof type !== 'string') {
    throw new ValidationError('Type de livraison invalide');
  }
  
  if (!Array.isArray(items) || items.length === 0) {
    throw new ValidationError('Panier vide');
  }
  
  if (typeof total !== 'number' || total < 0) {
    throw new ValidationError('Montant invalide');
  }
  
  for (const item of items) {
    if (!item.product_id || !item.name || !item.variant || !item.qty || !item.lineTotal) {
      throw new ValidationError('Données article invalides');
    }
    if (item.qty < 1 || item.lineTotal < 0) {
      throw new ValidationError('Quantité ou prix invalide');
    }
  }
  
  return true;
}

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
  }

  async sendMessage(chatId, text, options = {}) {
    if (!this.token || !chatId) {
      console.warn('⚠️ Telegram not configured');
      return null;
    }

    try {
      const response = await axios.post(`${this.baseUrl}/sendMessage`, {
        chat_id: chatId,
        text,
        parse_mode: 'HTML',
        ...options
      }, { timeout: 10000 });
      
      console.log(`✅ Telegram message sent to ${chatId}`);
      return response.data;
    } catch (error) {
      console.error(`❌ Telegram error (${chatId}):`, error.message);
      if (error.response?.data) {
        console.error('Response:', error.response.data);
      }
      return null;
    }
  }

  async answerCallback(callbackQueryId, text = '', showAlert = false) {
    if (!this.token) return null;

    try {
      await axios.post(`${this.baseUrl}/answerCallbackQuery`, {
        callback_query_id: callbackQueryId,
        text,
        show_alert: showAlert
      }, { timeout: 5000 });
    } catch (error) {
      console.error('❌ Answer callback error:', error.message);
    }
  }
}

const telegram = new TelegramService(config.telegram.token);

// ==================== DELIVERY ZONE LOGIC ====================
function getDriverForDeliveryType(deliveryType) {
  const type = deliveryType.toLowerCase();
  
  for (const [zone, zoneConfig] of Object.entries(config.deliveryZones)) {
    if (zoneConfig.keywords.some(keyword => type.includes(keyword))) {
      return {
        zone,
        driverId: config.telegram[zoneConfig.driverIdKey],
        driverName: zoneConfig.name
      };
    }
  }
  
  return {
    zone: 'millau',
    driverId: config.telegram.driverMillauId,
    driverName: 'Millau'
  };
}

// ==================== CUSTOMER VALIDATION ====================
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
      
      customer = await db.get(
        'SELECT * FROM customers WHERE id = ?',
        [result.lastID]
      );
      
      console.log(`🆕 New customer registered: ${contact} (ID: ${customer.id})`);
    } catch (error) {
      if (error.message && error.message.includes('UNIQUE')) {
        customer = await db.get(
          'SELECT * FROM customers WHERE contact = ?',
          [contact]
        );
        console.log(`ℹ️ Customer already exists: ${contact}`);
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

// ==================== LOYALTY SYSTEM ====================
async function calculateLoyaltyDiscount(customer, total) {
  const loyalty = await db.get(
    'SELECT * FROM loyalty WHERE customer = ?',
    [customer]
  );
  
  const loyaltyThreshold = await db.get(
    'SELECT value FROM settings WHERE key = ?',
    ['loyalty_threshold']
  );
  const threshold = parseInt(loyaltyThreshold?.value || config.loyalty.defaultThreshold);
  
  let discount = 0;
  if (loyalty && (loyalty.orders_count + 1) % threshold === 0) {
    discount = Math.min(total * config.loyalty.discountPercent, config.loyalty.maxDiscount);
  }
  
  return { discount, willEarnDiscount: discount > 0 };
}

async function updateLoyaltyProgram(customer) {
  const existing = await db.get(
    'SELECT * FROM loyalty WHERE customer = ?',
    [customer]
  );
  
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

// ==================== STOCK MANAGEMENT ====================
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

// ==================== NOTIFICATION SYSTEM ====================
async function notifyNewCustomerOrder(order, items, customerRecord) {
  if (config.telegram.adminChatId) {
    const message = `🆕 <b>NOUVEAU CLIENT - VALIDATION REQUISE</b>

📦 <b>Commande #${order.id}</b>

👤 <b>Client:</b> ${order.customer}
📅 <b>Première commande:</b> ${new Date(customerRecord.first_order_date).toLocaleString('fr-FR')}

📍 Type: ${order.type}
🏠 Adresse: ${order.address || 'Sur place'}

📦 <b>Articles:</b>
${items.map(item => `• ${item.name} - ${item.variant} ×${item.qty} = ${item.lineTotal}€`).join('\n')}

💰 <b>TOTAL: ${order.total}€</b>

⚠️ <b>Cette commande nécessite votre validation</b>
👇 Utilisez les boutons ci-dessous`;

    const keyboard = {
      inline_keyboard: [
        [
          { text: '✅ APPROUVER', callback_data: `approve_${order.id}` },
          { text: '❌ BLOQUER', callback_data: `block_${order.id}` }
        ],
        [
          { text: '📋 Voir détails', callback_data: `details_${order.id}` }
        ]
      ]
    };

    await telegram.sendMessage(config.telegram.adminChatId, message, { reply_markup: keyboard });
  }
  
  if (config.telegram.supportChatId) {
    const supportMessage = `🆕 <b>NOUVEAU CLIENT</b>

📦 Commande #${order.id}
👤 Client: ${order.customer}
💰 Total: ${order.total}€

⏳ En attente de validation admin`;
    
    await telegram.sendMessage(config.telegram.supportChatId, supportMessage);
  }
}

async function notifyNewOrder(order, items) {
  const driverInfo = getDriverForDeliveryType(order.type);
  
  if (config.telegram.supportChatId) {
    const supportMessage = `🔔 NOUVELLE COMMANDE #${order.id}

👤 Client: ${order.customer}
📍 Type: ${order.type}
💰 Total: ${order.total}€
📦 Articles: ${items.length} produit(s)

⚡ Contacter le client`;
    
    await telegram.sendMessage(config.telegram.supportChatId, supportMessage);
  }
  
  if (config.telegram.adminChatId) {
    let adminMessage = `📦 <b>COMMANDE #${order.id}</b>

👤 Client: ${order.customer}
📍 Type: ${order.type}
🏠 Adresse: ${order.address || 'Sur place'}

📦 Articles:
${items.map(item => `• ${item.name} - ${item.variant} ×${item.qty} = ${item.lineTotal}€`).join('\n')}

${order.discount > 0 ? `🎁 Remise fidélité: -${order.discount}€\n` : ''}💰 TOTAL: ${order.total}€

🚚 <b>Assigné à:</b> ${driverInfo.driverName}
🌍 <b>Zone:</b> ${driverInfo.zone.toUpperCase()}

⏰ ${new Date(order.created_at).toLocaleString('fr-FR')}`;
    
    await telegram.sendMessage(config.telegram.adminChatId, adminMessage);
  }
  
  if (driverInfo.driverId) {
    const allPendingOrders = await db.all(
      "SELECT * FROM orders WHERE status = 'pending' AND assigned_driver_zone = ? ORDER BY created_at ASC",
      [driverInfo.zone]
    );
    
    const orderPosition = allPendingOrders.findIndex(o => o.id === order.id) + 1;
    const totalPending = allPendingOrders.length;
    
    let driverMessage = `🚚 <b>NOUVELLE COMMANDE #${order.id}</b>

🔢 <b>Position: ${orderPosition}/${totalPending}</b> ${orderPosition === 1 ? '⚡ PRIORITÉ' : ''}

📍 Type: ${order.type}
🏠 Adresse: ${order.address || 'Sur place'}
💰 Total à encaisser: ${order.total}€
📦 ${items.length} article(s)

${items.map(item => `• ${item.name} - ${item.variant} ×${item.qty}`).join('\n')}

🎭 <b>Client: Anonyme</b>
💬 <b>Communication: Via le bot uniquement</b>

⏰ Reçue: ${new Date(order.created_at).toLocaleString('fr-FR')}`;

    if (totalPending > 1) {
      driverMessage += `\n\n━━━━━━━━━━━━━━━━━━━
📋 <b>TOUTES VOS COMMANDES (${totalPending})</b>\n`;
      
      allPendingOrders.forEach((o, index) => {
        const emoji = index === 0 ? '⚡' : (index + 1).toString() + '️⃣';
        const highlight = o.id === order.id ? ' 🆕' : '';
        driverMessage += `\n${emoji} #${o.id} - ${o.total}€${highlight}`;
      });
    }
    
    const keyboard = {
      inline_keyboard: [
        [{ text: '🚀 START - DÉMARRER', callback_data: `start_delivery_${order.id}` }],
        [{ text: '💬 Contacter le client', callback_data: `contact_client_${order.id}` }],
        [{ text: '📋 Voir toutes mes livraisons', callback_data: `my_deliveries_${driverInfo.zone}` }],
        [{ text: '❌ Refuser', callback_data: `refuse_delivery_${order.id}` }]
      ]
    };
    
    await telegram.sendMessage(driverInfo.driverId, driverMessage, { reply_markup: keyboard });
    
    activeConversations.set(order.id, {
      driverId: driverInfo.driverId,
      customerId: order.customer,
      orderId: order.id,
      driverInConversation: false,
      zone: driverInfo.zone
    });
    
    await db.run(
      'UPDATE orders SET assigned_driver_zone = ? WHERE id = ?',
      [driverInfo.zone, order.id]
    );
  }
}

async function notifyClientViaSupport(customerContact, orderId, status, estimatedTime = null) {
  if (!config.telegram.supportChatId) return;
  
  let message = '';
  
  if (status === 'en_route') {
    message = `🚚 <b>LIVRAISON DÉMARRÉE #${orderId}</b>

Client: ${customerContact}
ETA: ${estimatedTime} minutes

<b>📱 TRANSMETTEZ CE MESSAGE:</b>
---
🚚 Votre commande #${orderId} est en route !
⏱️ Arrivée estimée: ${estimatedTime} minutes
---`;
  } else if (status === 'delivered') {
    message = `✅ <b>LIVRAISON TERMINÉE #${orderId}</b>

Client: ${customerContact}

<b>📱 TRANSMETTEZ CE MESSAGE:</b>
---
✅ Commande #${orderId} livrée !
Merci pour votre confiance ! 💚
---`;
  }
  
  if (message) {
    await telegram.sendMessage(config.telegram.supportChatId, message);
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

app.post('/api/create-order', apiLimiter, async (req, res) => {
  try {
    console.log('📨 New order received');
    
    validateOrderInput(req.body);
    
    const { customer, type, address, items, total } = req.body;
    
    const sanitizedCustomer = sanitizeString(customer, 100);
    const sanitizedType = sanitizeString(type, 50);
    const sanitizedAddress = sanitizeString(address, 200);
    
    const blockedCustomer = await isCustomerBlocked(sanitizedCustomer);
    if (blockedCustomer) {
      const reason = blockedCustomer.blocked_reason || 'Compte bloqué';
      console.log(`🚫 Blocked customer attempt: ${sanitizedCustomer}`);
      return res.status(403).json({ 
        ok: false, 
        error: `Votre compte a été bloqué. Raison: ${reason}. Contactez le support.`
      });
    }
    
    const customerRecord = await getOrCreateCustomer(sanitizedCustomer);
    
    if (!customerRecord) {
      return res.status(500).json({ 
        ok: false, 
        error: 'Erreur lors de la création du profil client' 
      });
    }
    
    const isNewCustomer = customerRecord.status === 'pending';
    const isApproved = customerRecord.status === 'approved';
    
    let discount = 0;
    if (isApproved) {
      const loyaltyResult = await calculateLoyaltyDiscount(sanitizedCustomer, total);
      discount = loyaltyResult.discount;
    }
    
    const finalTotal = total - discount;
    const orderStatus = isNewCustomer ? 'pending_approval' : 'pending';
    
    const result = await db.run(
      `INSERT INTO orders (customer, type, address, items, total, discount, status) 
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [sanitizedCustomer, sanitizedType, sanitizedAddress, JSON.stringify(items), finalTotal, discount, orderStatus]
    );
    
    const orderId = result.lastID;
    console.log(`✅ Order #${orderId} created with status: ${orderStatus}`);
    
    if (isApproved) {
      await updateLoyaltyProgram(sanitizedCustomer);
    }
    
    await updateStockForOrder(items, orderId);
    
    if (!isNewCustomer) {
      await db.run(
        `INSERT INTO transactions (type, category, description, amount, payment_method, date)
         VALUES ('revenue', 'vente', ?, ?, 'online', DATE('now'))`,
        [`Commande #${orderId}`, finalTotal]
      );
    }
    
    const order = await db.get('SELECT * FROM orders WHERE id = ?', [orderId]);
    
    if (isNewCustomer) {
      await notifyNewCustomerOrder(order, items, customerRecord).catch(err => 
        console.error('Notification error:', err.message)
      );
      
      res.json({ 
        ok: true, 
        orderId, 
        discount,
        requiresApproval: true,
        message: 'Votre commande est en attente de validation. Vous serez notifié sous peu.' 
      });
    } else {
      await notifyNewOrder(order, items).catch(err => 
        console.error('Notification error:', err.message)
      );
      
      res.json({ ok: true, orderId, discount });
    }
    
  } catch (error) {
    console.error('Create order error:', error);
    
    if (error instanceof ValidationError) {
      return res.status(400).json({ ok: false, error: error.message });
    }
    
    res.status(500).json({ ok: false, error: 'Erreur serveur' });
  }
});

app.get('/api/geocode', apiLimiter, async (req, res) => {
  if (!config.mapbox.key) {
    return res.json({ features: [] });
  }
  
  try {
    const { q } = req.query;
    if (!q || q.length < 2) {
      return res.json({ features: [] });
    }
    
    const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(q)}.json`;
    const response = await axios.get(url, {
      params: {
        access_token: config.mapbox.key,
        country: 'FR',
        limit: 5,
        language: 'fr'
      },
      timeout: 5000
    });
    res.json(response.data);
  } catch (error) {
    console.error('Geocode error:', error.message);
    res.json({ features: [] });
  }
});

// ==================== ADMIN MIDDLEWARE ====================
function requireAdmin(req, res, next) {
  const token = req.headers['x-admin-token'];
  if (!token || !adminTokens.has(token)) {
    return res.status(401).json({ ok: false, error: 'Non autorisé' });
  }
  next();
}

// ==================== ADMIN ROUTES ====================

app.post('/api/admin/login', authLimiter, (req, res) => {
  const { password } = req.body;
  
  if (password === config.admin.password) {
    const token = adminTokens.generateToken();
    adminTokens.add(token);
    res.json({ ok: true, token });
  } else {
    res.status(401).json({ ok: false, error: 'Mot de passe incorrect' });
  }
});

app.get('/api/admin/stats', requireAdmin, async (req, res) => {
  try {
    const stats = {};
    
    const revenue = await db.get(
      "SELECT SUM(total) as total FROM orders WHERE status != 'cancelled'"
    );
    stats.totalCA = revenue?.total || 0;
    
    const orders = await db.get(
      "SELECT COUNT(*) as count FROM orders WHERE status != 'cancelled'"
    );
    stats.totalOrders = orders?.count || 0;
    
    stats.avgOrder = stats.totalOrders > 0 ? stats.totalCA / stats.totalOrders : 0;
    
    const allOrders = await db.all("SELECT items FROM orders WHERE status != 'cancelled'");
    const productCounts = {};
    
    allOrders.forEach(order => {
      try {
        const items = JSON.parse(order.items);
        items.forEach(item => {
          productCounts[item.name] = (productCounts[item.name] || 0) + item.qty;
        });
      } catch (e) {}
    });
    
    const sorted = Object.entries(productCounts).sort((a, b) => b[1] - a[1]);
    stats.topProduct = sorted[0]?.[0] || '-';
    
    const stock = await db.all('SELECT * FROM stock');
    stats.stockOut = stock.filter(s => s.qty === 0).length;
    stats.stockLow = stock.filter(s => s.qty > 0 && s.qty < 10).length;
    
    res.json({ ok: true, stats });
  } catch (error) {
    console.error('Stats error:', error);
    res.status(500).json({ ok: false, error: 'Erreur serveur' });
  }
});

app.get('/api/admin/orders', requireAdmin, async (req, res) => {
  try {
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
  } catch (error) {
    console.error('Orders error:', error);
    res.status(500).json({ ok: false, error: 'Erreur serveur' });
  }
});

app.put('/api/admin/orders/:id', requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const updates = req.body;
    
    delete updates.id;
    
    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ ok: false, error: 'Aucune mise à jour fournie' });
    }
    
    const fields = Object.keys(updates).map(key => `${key} = ?`).join(', ');
    const values = [...Object.values(updates), id];
    
    await db.run(`UPDATE orders SET ${fields} WHERE id = ?`, values);
    
    res.json({ ok: true });
  } catch (error) {
    console.error('Update order error:', error);
    res.status(500).json({ ok: false, error: 'Erreur serveur' });
  }
});

app.delete('/api/admin/orders/:id', requireAdmin, async (req, res) => {
  try {
    await db.run('DELETE FROM orders WHERE id = ?', [req.params.id]);
    res.json({ ok: true });
  } catch (error) {
    console.error('Delete order error:', error);
    res.status(500).json({ ok: false, error: 'Erreur serveur' });
  }
});

app.get('/api/admin/stock', requireAdmin, async (req, res) => {
  try {
    const stock = await db.all('SELECT * FROM stock ORDER BY product_id, variant');
    res.json({ ok: true, stock });
  } catch (error) {
    console.error('Stock error:', error);
    res.status(500).json({ ok: false, error: 'Erreur serveur' });
  }
});

app.post('/api/admin/stock/movement', requireAdmin, async (req, res) => {
  try {
    const { product_id, variant, type, quantity, reason } = req.body;
    
    if (!['in', 'out'].includes(type)) {
      return res.status(400).json({ ok: false, error: 'Type invalide' });
    }
    
    if (quantity < 0) {
      return res.status(400).json({ ok: false, error: 'Quantité invalide' });
    }
    
    let current = await db.get(
      'SELECT qty FROM stock WHERE product_id = ? AND variant = ?',
      [product_id, variant]
    );
    
    if (!current) {
      await db.run(
        'INSERT INTO stock (product_id, variant, qty) VALUES (?, ?, 0)',
        [product_id, variant]
      );
      current = { qty: 0 };
    }
    
    const newQty = type === 'in' 
      ? current.qty + quantity 
      : Math.max(0, current.qty - quantity);
    
    await db.run(
      'UPDATE stock SET qty = ? WHERE product_id = ? AND variant = ?',
      [newQty, product_id, variant]
    );
    
    await db.run(
      `INSERT INTO stock_movements (product_id, variant, type, quantity, stock_after, reason)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [product_id, variant, type, quantity, newQty, reason || '']
    );
    
    res.json({ ok: true, newQty });
  } catch (error) {
    console.error('Stock movement error:', error);
    res.status(500).json({ ok: false, error: 'Erreur serveur' });
  }
});

app.get('/api/admin/stock/movements', requireAdmin, async (req, res) => {
  try {
    const movements = await db.all(
      'SELECT * FROM stock_movements ORDER BY created_at DESC LIMIT 100'
    );
    res.json({ ok: true, movements });
  } catch (error) {
    console.error('Movements error:', error);
    res.status(500).json({ ok: false, error: 'Erreur serveur' });
  }
});

app.get('/api/admin/transactions', requireAdmin, async (req, res) => {
  try {
    const { type, category, period } = req.query;
    let query = 'SELECT * FROM transactions WHERE 1=1';
    const params = [];
    
    if (type && type !== 'all') {
      query += ' AND type = ?';
      params.push(type);
    }
    
    if (category && category !== 'all') {
      query += ' AND category = ?';
      params.push(category);
    }
    
    if (period === 'today') {
      query += " AND date = DATE('now')";
    } else if (period === 'week') {
      query += " AND date >= DATE('now', '-7 days')";
    } else if (period === 'month') {
      query += " AND date >= DATE('now', 'start of month')";
    } else if (period === 'year') {
      query += " AND date >= DATE('now', 'start of year')";
    }
    
    query += ' ORDER BY date DESC, created_at DESC LIMIT 500';
    
    const transactions = await db.all(query, params);
    res.json({ ok: true, transactions });
  } catch (error) {
    console.error('Transactions error:', error);
    res.status(500).json({ ok: false, error: 'Erreur serveur' });
  }
});

app.post('/api/admin/transactions', requireAdmin, async (req, res) => {
  try {
    const { type, category, description, amount, payment_method, note, date } = req.body;
    
    if (!['revenue', 'expense'].includes(type)) {
      return res.status(400).json({ ok: false, error: 'Type invalide' });
    }
    
    if (amount < 0) {
      return res.status(400).json({ ok: false, error: 'Montant invalide' });
    }
    
    await db.run(
      `INSERT INTO transactions (type, category, description, amount, payment_method, note, date)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [type, category, description, amount, payment_method || '', note || '', date]
    );
    
    if (payment_method === 'especes') {
      const cashBalance = await db.get("SELECT value FROM settings WHERE key = 'cash_balance'");
      const currentBalance = parseFloat(cashBalance?.value || 0);
      const newBalance = type === 'revenue' 
        ? currentBalance + amount 
        : currentBalance - amount;
      
      await db.run(
        "UPDATE settings SET value = ? WHERE key = 'cash_balance'",
        [newBalance.toString()]
      );
    }
    
    res.json({ ok: true });
  } catch (error) {
    console.error('Add transaction error:', error);
    res.status(500).json({ ok: false, error: 'Erreur serveur' });
  }
});

app.delete('/api/admin/transactions/:id', requireAdmin, async (req, res) => {
  try {
    await db.run('DELETE FROM transactions WHERE id = ?', [req.params.id]);
    res.json({ ok: true });
  } catch (error) {
    console.error('Delete transaction error:', error);
    res.status(500).json({ ok: false, error: 'Erreur serveur' });
  }
});

app.get('/api/admin/reviews', requireAdmin, async (req, res) => {
  try {
    const reviews = await db.all('SELECT * FROM reviews ORDER BY created_at DESC');
    res.json({ ok: true, reviews });
  } catch (error) {
    console.error('Reviews error:', error);
    res.status(500).json({ ok: false, error: 'Erreur serveur' });
  }
});

app.put('/api/admin/reviews/:id', requireAdmin, async (req, res) => {
  try {
    const { approved } = req.body;
    await db.run(
      'UPDATE reviews SET approved = ? WHERE id = ?',
      [approved ? 1 : 0, req.params.id]
    );
    res.json({ ok: true });
  } catch (error) {
    console.error('Update review error:', error);
    res.status(500).json({ ok: false, error: 'Erreur serveur' });
  }
});

app.delete('/api/admin/reviews/:id', requireAdmin, async (req, res) => {
  try {
    await db.run('DELETE FROM reviews WHERE id = ?', [req.params.id]);
    res.json({ ok: true });
  } catch (error) {
    console.error('Delete review error:', error);
    res.status(500).json({ ok: false, error: 'Erreur serveur' });
  }
});

app.get('/api/admin/settings', requireAdmin, async (req, res) => {
  try {
    const rows = await db.all('SELECT * FROM settings');
    const settings = {};
    rows.forEach(row => {
      settings[row.key] = row.value;
    });
    res.json({ ok: true, settings });
  } catch (error) {
    console.error('Settings error:', error);
    res.status(500).json({ ok: false, error: 'Erreur serveur' });
  }
});

app.put('/api/admin/settings', requireAdmin, async (req, res) => {
  try {
    const { settings } = req.body;
    
    for (const [key, value] of Object.entries(settings)) {
      await db.run(
        'INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)',
        [key, value]
      );
    }
    
    res.json({ ok: true });
  } catch (error) {
    console.error('Save settings error:', error);
    res.status(500).json({ ok: false, error: 'Erreur serveur' });
  }
});

app.get('/api/admin/orders/export/csv', requireAdmin, async (req, res) => {
  try {
    const orders = await db.all('SELECT * FROM orders ORDER BY created_at DESC');
    
    let csv = 'ID,Date,Client,Type,Adresse,Articles,Total,Remise,Statut\n';
    
    orders.forEach(order => {
      const date = new Date(order.created_at).toLocaleString('fr-FR');
      const items = JSON.parse(order.items || '[]');
      const itemsStr = items.map(i => `${i.name} x${i.qty}`).join('; ');
      
      csv += `${order.id},"${date}","${order.customer}","${order.type}","${order.address || ''}","${itemsStr}",${order.total},${order.discount || 0},"${order.status}"\n`;
    });
    
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename=orders.csv');
    res.send('\uFEFF' + csv);
  } catch (error) {
    console.error('Export error:', error);
    res.status(500).json({ ok: false, error: 'Erreur serveur' });
  }
});

// ==================== CUSTOMER MANAGEMENT ROUTES ====================

app.get('/api/admin/customers', requireAdmin, async (req, res) => {
  try {
    const { status } = req.query;
    let query = 'SELECT c.*, COUNT(o.id) as total_orders, SUM(o.total) as total_spent FROM customers c LEFT JOIN orders o ON c.contact = o.customer WHERE 1=1';
    const params = [];
    
    if (status && status !== 'all') {
      query += ' AND c.status = ?';
      params.push(status);
    }
    
    query += ' GROUP BY c.id ORDER BY c.created_at DESC';
    
    const customers = await db.all(query, params);
    res.json({ ok: true, customers });
  } catch (error) {
    console.error('Customers error:', error);
    res.status(500).json({ ok: false, error: 'Erreur serveur' });
  }
});

app.get('/api/admin/customers/:contact', requireAdmin, async (req, res) => {
  try {
    const { contact } = req.params;
    
    const customer = await db.get(
      'SELECT * FROM customers WHERE contact = ?',
      [contact]
    );
    
    if (!customer) {
      return res.status(404).json({ ok: false, error: 'Client introuvable' });
    }
    
    const orders = await db.all(
      'SELECT * FROM orders WHERE customer = ? ORDER BY created_at DESC',
      [contact]
    );
    
    const stats = await db.get(
      `SELECT 
        COUNT(*) as total_orders,
        SUM(total) as total_spent,
        AVG(total) as avg_order
       FROM orders 
       WHERE customer = ? AND status != 'cancelled'`,
      [contact]
    );
    
    res.json({ 
      ok: true, 
      customer: {
        ...customer,
        orders,
        stats
      }
    });
  } catch (error) {
    console.error('Customer details error:', error);
    res.status(500).json({ ok: false, error: 'Erreur serveur' });
  }
});

app.post('/api/admin/customers/:contact/approve', requireAdmin, async (req, res) => {
  try {
    const { contact } = req.params;
    
    const customer = await db.get(
      'SELECT * FROM customers WHERE contact = ?',
      [contact]
    );
    
    if (!customer) {
      return res.status(404).json({ ok: false, error: 'Client introuvable' });
    }
    
    if (customer.status === 'approved') {
      return res.json({ ok: true, message: 'Client déjà approuvé' });
    }
    
    await db.run(
      'UPDATE customers SET status = ?, approved_date = CURRENT_TIMESTAMP WHERE contact = ?',
      ['approved', contact]
    );
    
    const pendingOrders = await db.all(
      'SELECT * FROM orders WHERE customer = ? AND status = ?',
      [contact, 'pending_approval']
    );
    
    await db.run(
      'UPDATE orders SET status = ? WHERE customer = ? AND status = ?',
      ['pending', contact, 'pending_approval']
    );
    
    for (const order of pendingOrders) {
      await db.run(
        `INSERT INTO transactions (type, category, description, amount, payment_method, date)
         VALUES ('revenue', 'vente', ?, ?, 'online', DATE('now'))`,
        [`Commande #${order.id}`, order.total]
      );
      
      try {
        const items = JSON.parse(order.items);
        await notifyNewOrder(order, items);
      } catch (err) {
        console.error(`Error notifying for order #${order.id}:`, err);
      }
    }
    
    console.log(`✅ Customer ${contact} approved`);
    res.json({ ok: true, ordersApproved: pendingOrders.length });
  } catch (error) {
    console.error('Approve customer error:', error);
    res.status(500).json({ ok: false, error: 'Erreur serveur' });
  }
});

app.post('/api/admin/customers/:contact/block', requireAdmin, async (req, res) => {
  try {
    const { contact } = req.params;
    const { reason } = req.body;
    
    const customer = await db.get(
      'SELECT * FROM customers WHERE contact = ?',
      [contact]
    );
    
    if (!customer) {
      return res.status(404).json({ ok: false, error: 'Client introuvable' });
    }
    
    if (customer.status === 'blocked') {
      return res.json({ ok: true, message: 'Client déjà bloqué' });
    }
    
    await db.run(
      'UPDATE customers SET status = ?, blocked_reason = ? WHERE contact = ?',
      ['blocked', reason || 'Bloqué par admin', contact]
    );
    
    const cancelledOrders = await db.all(
      'SELECT id FROM orders WHERE customer = ? AND status IN (?, ?)',
      [contact, 'pending', 'pending_approval']
    );
    
    await db.run(
      'UPDATE orders SET status = ? WHERE customer = ? AND status IN (?, ?)',
      ['cancelled', contact, 'pending', 'pending_approval']
    );
    
    for (const [orderId, conv] of activeConversations.entries()) {
      if (conv.customerId === contact) {
        activeConversations.delete(orderId);
      }
    }
    
    console.log(`🚫 Customer ${contact} blocked`);
    res.json({ ok: true, ordersCancelled: cancelledOrders.length });
  } catch (error) {
    console.error('Block customer error:', error);
    res.status(500).json({ ok: false, error: 'Erreur serveur' });
  }
});

app.put('/api/admin/customers/:contact', requireAdmin, async (req, res) => {
  try {
    const { contact } = req.params;
    const { notes } = req.body;
    
    await db.run(
      'UPDATE customers SET notes = ? WHERE contact = ?',
      [notes || '', contact]
    );
    
    res.json({ ok: true });
  } catch (error) {
    console.error('Update customer error:', error);
    res.status(500).json({ ok: false, error: 'Erreur serveur' });
  }
});

// ==================== TELEGRAM BOT ====================
if (config.telegram.token) {
  console.log('🤖 Configuring Telegram bot...');

  app.post(`/bot${config.telegram.token}`, async (req, res) => {
    try {
      const { message, callback_query } = req.body;
      
      if (message) {
        await handleTelegramMessage(message);
      }
      
      if (callback_query) {
        await handleTelegramCallback(callback_query);
      }
      
      res.sendStatus(200);
    } catch (error) {
      console.error('❌ Bot error:', error.message);
      res.sendStatus(500);
    }
  });
}

// ==================== CLAVIER PERMANENT POUR CHAQUE UTILISATEUR ====================
function getPermanentKeyboard(chatId) {
  const isDriver = chatId.toString() === config.telegram.driverMillauId || 
                   chatId.toString() === config.telegram.driverExterieurId;
  const isAdmin = chatId.toString() === config.telegram.adminChatId;
  
  if (isDriver) {
    // Clavier pour les livreurs
    return {
      keyboard: [
        [{ text: '📋 Mes Livraisons' }],
        [{ text: '📊 Mes Stats' }],
        [{ text: '🛍️ Boutique', web_app: { url: config.webapp.url } }],
        [{ text: '❓ Aide' }]
      ],
      resize_keyboard: true,
      persistent: true,
      one_time_keyboard: false
    };
  } else if (isAdmin) {
    // Clavier pour l'admin
    return {
      keyboard: [
        [{ text: '📱 Mini-App', web_app: { url: config.webapp.url } }],
        [
          { text: '🍽️ Menu' },
          { text: '📦 Catalogue' }
        ],
        [
          { text: '📞 Contact' },
          { text: '🔐 Admin', web_app: { url: `${config.webapp.url}/admin.html` } }
        ]
      ],
      resize_keyboard: true,
      persistent: true,
      one_time_keyboard: false
    };
  } else {
    // Clavier pour les clients normaux
    return {
      keyboard: [
        [{ text: '📱 Mini-App', web_app: { url: config.webapp.url } }],
        [
          { text: '🍽️ Menu' },
          { text: '📦 Catalogue' }
        ],
        [{ text: '📞 Contact' }]
      ],
      resize_keyboard: true,
      persistent: true,
      one_time_keyboard: false
    };
  }
}

async function handleTelegramMessage(message) {
  const chatId = message.chat.id;
  const text = message.text;
  const firstName = message.from.first_name || 'Client';
  
  console.log(`💬 Message from ${firstName} (${chatId}): ${text}`);
  
  // Gestion des boutons du clavier permanent
  if (text === '📱 Mini-App' || text === '🛍️ Boutique') {
    await sendShopMessage(chatId);
  } else if (text === '🍽️ Menu') {
    await sendMenuMessage(chatId);
  } else if (text === '📦 Catalogue') {
    await sendCatalogMessage(chatId);
  } else if (text === '📞 Contact') {
    await sendSupportMessage(chatId);
  } else if (text === '🔐 Admin') {
    await sendAdminMessage(chatId);
  } else if (text === '📋 Mes Livraisons') {
    await sendDriverDeliveries(chatId);
  } else if (text === '📊 Mes Stats') {
    await sendDriverStats(chatId);
  } else if (text === '❓ Aide') {
    await sendHelpMessage(chatId);
  }
  // Commandes standards avec /
  else if (text === '/start') {
    await sendWelcomeMessage(chatId, firstName);
  } else if (text === '/shop' || text === '/boutique') {
    await sendShopMessage(chatId);
  } else if (text === '/admin') {
    await sendAdminMessage(chatId);
  } else if (text === '/help' || text === '/aide') {
    await sendHelpMessage(chatId);
  } else if (text === '/meslivraisons' || text === '/livraisons') {
    await sendDriverDeliveries(chatId);
  } else if (text === '/stats') {
    await sendDriverStats(chatId);
  } else if (text === '/stop') {
    await stopDriverConversations(chatId);
  } else if (text === '/zones' && chatId.toString() === config.telegram.adminChatId) {
    await sendZoneStats(chatId);
  } else if (!text.startsWith('/')) {
    await handleDriverMessage(chatId, text);
  }
}

async function handleTelegramCallback(callback_query) {
  const chatId = callback_query.message.chat.id;
  const data = callback_query.data;
  
  console.log(`🔘 Callback: ${data} from ${chatId}`);
  
  await telegram.answerCallback(callback_query.id);
  
  if (data.startsWith('approve_')) {
    const orderId = data.replace('approve_', '');
    if (/^\d+$/.test(orderId)) {
      await approveCustomerFromTelegram(chatId, orderId);
      return;
    }
  } else if (data.startsWith('block_')) {
    const orderId = data.replace('block_', '');
    if (/^\d+$/.test(orderId)) {
      await blockCustomerFromTelegram(chatId, orderId);
      return;
    }
  } else if (data.startsWith('details_')) {
    const orderId = data.replace('details_', '');
    if (/^\d+$/.test(orderId)) {
      await sendOrderCustomerDetails(chatId, orderId);
      return;
    }
  }
  
  if (data.startsWith('start_delivery_')) {
    const orderId = data.replace('start_delivery_', '');
    await showDeliveryTimeOptions(chatId, orderId);
  } else if (data.startsWith('set_time_')) {
    const parts = data.replace('set_time_', '').split('_');
    await startDelivery(chatId, parts[0], parts[1]);
  } else if (data.startsWith('contact_client_')) {
    const orderId = data.replace('contact_client_', '');
    await startDriverConversation(chatId, orderId);
  } else if (data.startsWith('stop_conversation_')) {
    const orderId = data.replace('stop_conversation_', '');
    await stopDriverConversation(chatId, orderId);
  } else if (data.startsWith('complete_delivery_')) {
    const orderId = data.replace('complete_delivery_', '');
    await completeDelivery(chatId, orderId);
  } else if (data.startsWith('refuse_delivery_')) {
    const orderId = data.replace('refuse_delivery_', '');
    await refuseDelivery(chatId, orderId);
  } else if (data.startsWith('my_deliveries_')) {
    const zone = data.replace('my_deliveries_', '');
    await sendDetailedDriverDeliveries(chatId, zone);
  } else if (data === 'driver_stats') {
    await sendDriverStats(chatId);
  } else if (data === 'contact_support') {
    await sendSupportMessage(chatId);
  } else if (data === 'show_info') {
    await sendInfoMessage(chatId);
  } else if (data === 'open_shop') {
    await sendShopMessage(chatId);
  } else if (data === 'open_admin') {
    await sendAdminMessage(chatId);
  }
}

// ==================== MESSAGES AVEC CLAVIER PERMANENT ====================

async function sendWelcomeMessage(chatId, firstName) {
  const text = `🌟 <b>Bienvenue ${firstName} chez DROGUA CENTER !</b> 🌟

Votre boutique premium accessible directement depuis Telegram.

<b>🛍️ Utilisez le menu en bas pour naviguer</b>

✨ <i>Programme de fidélité actif !</i>
Bénéficiez d'une remise tous les ${config.loyalty.defaultThreshold} achats.

Tapez sur les boutons ci-dessous pour commencer ! 👇`;

  const keyboard = getPermanentKeyboard(chatId);
  await telegram.sendMessage(chatId, text, { reply_markup: keyboard });
}

async function sendMenuMessage(chatId) {
  const text = `🍽️ <b>MENU DROGUA CENTER</b>

Découvrez nos différentes catégories :

• 🌿 <b>Fleurs Premium</b> - Sélection de qualité
• 💎 <b>Concentrés</b> - Extractions pures
• 🍫 <b>Edibles</b> - Gourmandises infusées
• 🔥 <b>Vape & Accessoires</b> - Discrétion maximale
• 🎁 <b>Packs & Promos</b> - Offres spéciales

📱 <b>Cliquez sur "Mini-App" pour voir tous les produits !</b>

💎 Livraison rapide et discrète
🎁 Programme de fidélité
🔒 Paiement sécurisé`;

  const keyboard = {
    inline_keyboard: [
      [{ text: '🛒 Ouvrir la Boutique Complète', web_app: { url: config.webapp.url } }]
    ]
  };
  
  await telegram.sendMessage(chatId, text, { reply_markup: keyboard });
}

async function sendCatalogMessage(chatId) {
  const text = `📦 <b>CATALOGUE COMPLET</b>

🏆 <b>Nos produits vedettes :</b>

🌿 <b>Fleurs Premium</b>
   • Amnesia Haze
   • OG Kush
   • Purple Haze
   • White Widow

💎 <b>Concentrés</b>
   • Wax 80% THC
   • Shatter
   • Live Resin

🍫 <b>Edibles</b>
   • Brownies THC
   • Gummies
   • Chocolats

🔥 <b>Vape & Accessoires</b>
   • Vape Pen
   • Cartouches
   • Batteries

💰 <b>Prix et disponibilité en temps réel</b>
📦 <b>Stock mis à jour quotidiennement</b>
🚚 <b>Livraison express</b>

<b>📱 Ouvrez la Mini-App pour voir le catalogue complet avec photos et prix !</b>`;

  const keyboard = {
    inline_keyboard: [
      [{ text: '🛒 Voir tous les produits', web_app: { url: config.webapp.url } }]
    ]
  };
  
  await telegram.sendMessage(chatId, text, { reply_markup: keyboard });
}

async function sendShopMessage(chatId) {
  const text = `🛍️ <b>BOUTIQUE DROGUA CENTER</b>

Cliquez sur le bouton ci-dessous pour accéder à notre catalogue complet.

💎 Livraison rapide et discrète
🔒 Paiement sécurisé
📦 Suivi de commande en temps réel
🎁 Programme de fidélité actif

<b>⏰ Horaires d'ouverture :</b>
7j/7 de 12H à 00H (minuit)`;

  const keyboard = {
    inline_keyboard: [
      [{ text: '🛒 Ouvrir la Boutique', web_app: { url: config.webapp.url } }]
    ]
  };
  
  await telegram.sendMessage(chatId, text, { reply_markup: keyboard });
}

async function sendAdminMessage(chatId) {
  const text = `🔐 <b>PANNEAU ADMINISTRATEUR</b>

Accédez au tableau de bord pour gérer :

📊 Statistiques et ventes
📦 Commandes en cours
📋 Gestion du stock
💰 Finances et transactions
👥 Gestion des clients
⚙️ Paramètres de la boutique

<i>⚠️ Authentification requise</i>`;

  const keyboard = {
    inline_keyboard: [
      [{ text: '🔐 Ouvrir le Panneau Admin', web_app: { url: `${config.webapp.url}/admin.html` } }]
    ]
  };
  
  await telegram.sendMessage(chatId, text, { reply_markup: keyboard });
}

async function sendHelpMessage(chatId) {
  const text = `❓ <b>AIDE & SUPPORT</b>

<b>📍 Livraison :</b>
• Gratuite sur Millau
• +20€ pour l'extérieur

<b>💰 Paiement :</b>
• Espèces à la livraison
• Virement bancaire
• Crypto-monnaies

<b>🎁 Programme fidélité :</b>
• Remise automatique tous les ${config.loyalty.defaultThreshold} achats
• Jusqu'à ${Math.floor(config.loyalty.discountPercent * 100)}% ou ${config.loyalty.maxDiscount}€ de réduction

<b>📞 Contact support :</b>
@assistancenter

<b>⏰ Horaires d'ouverture :</b>
7j/7 de 12H à 00H (minuit)
Livraison rapide pendant les heures d'ouverture

<b>💡 Astuce :</b>
Utilisez les boutons en bas de votre écran pour naviguer rapidement ! 👇`;

  const keyboard = {
    inline_keyboard: [
      [{ text: '💬 Contacter le Support', url: 'https://t.me/assistancenter' }],
      [
        { text: '🛒 Boutique', callback_data: 'open_shop' },
        { text: 'ℹ️ Infos', callback_data: 'show_info' }
      ]
    ]
  };
  
  await telegram.sendMessage(chatId, text, { reply_markup: keyboard });
}

async function sendSupportMessage(chatId) {
  const text = `💬 <b>SUPPORT CLIENT</b>

Pour toute question ou assistance :

<b>📱 Telegram :</b> @assistancenter
<b>📸 Snapchat :</b> https://snapchat.com/t/l9gurvAj
<b>🆘 Snap Secours :</b> https://snapchat.com/t/jR2yW7xa

Notre équipe est disponible <b>7j/7</b> pour vous aider !

<i>Réponse sous 24h maximum</i>

📢 <b>Rejoignez nos canaux :</b>
• Canal Principal - Actualités et offres
• Canal Photo - Nouveaux produits en images`;

  const keyboard = {
    inline_keyboard: [
      [{ text: '💬 Support Telegram', url: 'https://t.me/assistancenter' }],
      [{ text: '📸 Snapchat', url: 'https://snapchat.com/t/l9gurvAj' }],
      [
        { text: '📢 Canal Principal', url: 'https://t.me/+MToYP95G9zY2ZTJk' },
        { text: '📸 Canal Photo', url: 'https://t.me/+usSUbJOfYsk5ZTg0' }
      ]
    ]
  };
  
  await telegram.sendMessage(chatId, text, { reply_markup: keyboard });
}

async function sendInfoMessage(chatId) {
  const text = `ℹ️ <b>À PROPOS DE DROGUA CENTER</b>

<b>🏪 Votre boutique de confiance depuis 2024</b>

✅ Livraison rapide à domicile
✅ Paiement sécurisé
✅ Programme de fidélité
✅ Support client 7j/7
✅ Produits de qualité garantis

<b>📊 Nos chiffres :</b>
• +1000 clients satisfaits
• Livraison rapide
• Note moyenne : ⭐⭐⭐⭐⭐

<b>📍 Zone de livraison :</b>
Millau et alentours

<b>⏰ Horaires :</b>
7j/7 de 12H à 00H (minuit)

Merci de votre confiance ! 💚`;

  const keyboard = {
    inline_keyboard: [
      [{ text: '🛒 Commander Maintenant', web_app: { url: config.webapp.url } }]
    ]
  };
  
  await telegram.sendMessage(chatId, text, { reply_markup: keyboard });
}

async function sendDriverDeliveries(chatId) {
  let driverZone = null;
  if (chatId.toString() === config.telegram.driverMillauId) {
    driverZone = 'millau';
  } else if (chatId.toString() === config.telegram.driverExterieurId) {
    driverZone = 'exterieur';
  }
  
  if (!driverZone) return;
  
  await sendDetailedDriverDeliveries(chatId, driverZone);
}

async function sendDetailedDriverDeliveries(chatId, driverZone) {
  const pendingOrders = await db.all(
    "SELECT * FROM orders WHERE status = 'pending' AND assigned_driver_zone = ? ORDER BY created_at ASC",
    [driverZone]
  );
  
  const enRouteOrders = await db.all(
    "SELECT * FROM orders WHERE status = 'en_route' AND assigned_driver_zone = ? ORDER BY created_at ASC",
    [driverZone]
  );
  
  const totalOrders = pendingOrders.length + enRouteOrders.length;
  
  if (totalOrders === 0) {
    await telegram.sendMessage(chatId, `📭 <b>Aucune livraison en cours</b>\n\nZone : ${driverZone.toUpperCase()}\n\nProfitez de votre pause ! 😎`);
    return;
  }
  
  let message = `🚚 <b>VOS LIVRAISONS (${driverZone.toUpperCase()})</b>\n`;
  message += `📊 Total: ${totalOrders} commande(s)\n`;
  message += `━━━━━━━━━━━━━━━━━━━\n\n`;
  
  if (enRouteOrders.length > 0) {
    message += `🚀 <b>EN COURS DE LIVRAISON (${enRouteOrders.length})</b>\n\n`;
    
    enRouteOrders.forEach((order, index) => {
      const items = JSON.parse(order.items || '[]');
      const timeAgo = getTimeAgo(order.created_at);
      
      message += `🚀 <b>#${order.id}</b> ${index === 0 ? '⚡ PRIORITÉ' : ''}\n`;
      message += `📍 ${order.address}\n`;
      message += `💰 ${order.total}€ | 📦 ${items.length} article(s)\n`;
      if (order.delivery_time) {
        message += `⏱️ ETA: ${order.delivery_time} min\n`;
      }
      message += `🕐 ${timeAgo}\n\n`;
    });
    
    message += `━━━━━━━━━━━━━━━━━━━\n\n`;
  }
  
  if (pendingOrders.length > 0) {
    message += `⏳ <b>EN ATTENTE (${pendingOrders.length})</b>\n`;
    message += `<i>Ordre de priorité (du plus ancien au plus récent)</i>\n\n`;
    
    pendingOrders.forEach((order, index) => {
      const items = JSON.parse(order.items || '[]');
      const timeAgo = getTimeAgo(order.created_at);
      const priorityEmoji = index === 0 ? '⚡' : (index + 1).toString() + '️⃣';
      
      message += `${priorityEmoji} <b>#${order.id}</b>${index === 0 ? ' ⚡ À FAIRE EN PREMIER' : ''}\n`;
      message += `📍 ${order.address}\n`;
      message += `💰 ${order.total}€ | 📦 ${items.length} article(s)\n`;
      message += `🕐 ${timeAgo}\n\n`;
    });
  }
  
  message += `━━━━━━━━━━━━━━━━━━━\n`;
  message += `💡 <i>Les commandes les plus anciennes sont prioritaires</i>`;
  
  const keyboard = {
    inline_keyboard: []
  };
  
  if (pendingOrders.length > 0) {
    keyboard.inline_keyboard.push([
      { text: `🚀 START #${pendingOrders[0].id}`, callback_data: `start_delivery_${pendingOrders[0].id}` }
    ]);
  }
  
  if (enRouteOrders.length > 0) {
    keyboard.inline_keyboard.push([
      { text: `✅ TERMINER #${enRouteOrders[0].id}`, callback_data: `complete_delivery_${enRouteOrders[0].id}` }
    ]);
  }
  
  keyboard.inline_keyboard.push([
    { text: '🔄 Actualiser', callback_data: `my_deliveries_${driverZone}` }
  ]);
  
  await telegram.sendMessage(chatId, message, { reply_markup: keyboard });
}

async function sendDriverStats(chatId) {
  let driverZone = null;
  if (chatId.toString() === config.telegram.driverMillauId) {
    driverZone = 'millau';
  } else if (chatId.toString() === config.telegram.driverExterieurId) {
    driverZone = 'exterieur';
  }
  
  if (!driverZone) return;
  
  const today = await db.get(`
    SELECT COUNT(*) as count, SUM(total) as revenue
    FROM orders 
    WHERE status = 'delivered' 
    AND assigned_driver_zone = ?
    AND DATE(created_at) = DATE('now')
  `, [driverZone]);
  
  const week = await db.get(`
    SELECT COUNT(*) as count, SUM(total) as revenue
    FROM orders 
    WHERE status = 'delivered' 
    AND assigned_driver_zone = ?
    AND DATE(created_at) >= DATE('now', '-7 days')
  `, [driverZone]);
  
  const message = `📊 <b>VOS STATISTIQUES (${driverZone.toUpperCase()})</b>

<b>📅 AUJOURD'HUI</b>
🚚 Livraisons : ${today?.count || 0}
💰 CA : ${(today?.revenue || 0).toFixed(2)}€

<b>📈 CETTE SEMAINE</b>
🚚 Livraisons : ${week?.count || 0}
💰 CA : ${(week?.revenue || 0).toFixed(2)}€

Continue comme ça ! 🚀`;
  
  await telegram.sendMessage(chatId, message);
}

async function sendZoneStats(chatId) {
  const statsMillau = await db.get(`
    SELECT COUNT(*) as count, SUM(total) as revenue
    FROM orders 
    WHERE assigned_driver_zone = 'millau'
    AND DATE(created_at) >= DATE('now', '-7 days')
  `);
  
  const statsExterieur = await db.get(`
    SELECT COUNT(*) as count, SUM(total) as revenue
    FROM orders 
    WHERE assigned_driver_zone = 'exterieur'
    AND DATE(created_at) >= DATE('now', '-7 days')
  `);
  
  const message = `🌍 <b>CONFIGURATION DES ZONES</b>

<b>🏙️ MILLAU</b>
Livreur : ${config.telegram.driverMillauId ? '✅ Configuré' : '❌ Non configuré'}
ID : ${config.telegram.driverMillauId || 'N/A'}

<b>🌐 EXTÉRIEUR</b>
Livreur : ${config.telegram.driverExterieurId ? '✅ Configuré' : '❌ Non configuré'}
ID : ${config.telegram.driverExterieurId || 'N/A'}

<b>📊 STATISTIQUES (7 derniers jours)</b>

🏙️ Millau : ${statsMillau?.count || 0} livraisons, ${(statsMillau?.revenue || 0).toFixed(2)}€
🌐 Extérieur : ${statsExterieur?.count || 0} livraisons, ${(statsExterieur?.revenue || 0).toFixed(2)}€`;
  
  await telegram.sendMessage(chatId, message);
}

async function stopDriverConversations(chatId) {
  if (chatId.toString() !== config.telegram.driverMillauId && 
      chatId.toString() !== config.telegram.driverExterieurId) return;
  
  for (const [orderId, conv] of activeConversations.entries()) {
    if (conv.driverId === chatId.toString()) {
      conv.driverInConversation = false;
      activeConversations.set(orderId, conv);
    }
  }
  
  await telegram.sendMessage(chatId, `✅ Conversations fermées`);
}

async function handleDriverMessage(chatId, text) {
  let driverConversation = null;
  for (const [orderId, conv] of activeConversations.entries()) {
    if (conv.driverId === chatId.toString() && conv.driverInConversation) {
      driverConversation = { orderId, ...conv };
      break;
    }
  }
  
  if (!driverConversation) return;
  
  console.log(`📨 Driver → Client (order #${driverConversation.orderId})`);
  
  if (config.telegram.supportChatId) {
    const supportMsg = `📨 <b>MESSAGE LIVREUR → CLIENT</b>
Commande #${driverConversation.orderId}

Client : ${driverConversation.customerId}

Message du livreur :
"${text}"

<b>Transmettez ce message au client :</b>
---
💬 Message du livreur (Commande #${driverConversation.orderId}) :

${text}

Répondez pour lui envoyer un message.
---`;
    
    await telegram.sendMessage(config.telegram.supportChatId, supportMsg);
    await telegram.sendMessage(chatId, `✅ Message envoyé au client\n\n"${text}"`);
  }
}

async function showDeliveryTimeOptions(chatId, orderId) {
  const conversation = activeConversations.get(parseInt(orderId));
  
  if (!conversation || conversation.driverId !== chatId.toString()) {
    await telegram.sendMessage(chatId, '❌ Cette commande n\'est pas assignée à vous');
    return;
  }
  
  const keyboard = {
    inline_keyboard: [
      [
        { text: '⏱️ 10 min', callback_data: `set_time_${orderId}_10` },
        { text: '⏱️ 15 min', callback_data: `set_time_${orderId}_15` },
        { text: '⏱️ 20 min', callback_data: `set_time_${orderId}_20` }
      ],
      [
        { text: '⏱️ 30 min', callback_data: `set_time_${orderId}_30` },
        { text: '⏱️ 45 min', callback_data: `set_time_${orderId}_45` },
        { text: '⏱️ 60 min', callback_data: `set_time_${orderId}_60` }
      ]
    ]
  };
  
  await telegram.sendMessage(chatId, `⏱️ <b>Temps estimé pour la livraison #${orderId} ?</b>`, { reply_markup: keyboard });
}

async function startDelivery(chatId, orderId, estimatedTime) {
  const order = await db.get('SELECT * FROM orders WHERE id = ?', [orderId]);
  
  if (!order) {
    await telegram.sendMessage(chatId, '❌ Commande introuvable');
    return;
  }
  
  await db.run(
    'UPDATE orders SET status = ?, delivery_time = ? WHERE id = ?',
    ['en_route', estimatedTime, orderId]
  );
  
  const remainingOrders = await db.all(
    "SELECT * FROM orders WHERE status = 'pending' AND assigned_driver_zone = ? ORDER BY created_at ASC",
    [order.assigned_driver_zone]
  );
  
  let message = `✅ <b>LIVRAISON DÉMARRÉE #${orderId}</b>

⏱️ Temps estimé : ${estimatedTime} minutes
📍 ${order.address}
💰 ${order.total}€

🎭 <b>Client : Anonyme</b>
💬 Utilisez le bouton "Contacter" pour envoyer un message`;

  if (remainingOrders.length > 0) {
    message += `\n\n━━━━━━━━━━━━━━━━━━━
📋 <b>COMMANDES EN ATTENTE (${remainingOrders.length})</b>
<i>À faire après celle-ci :</i>\n`;
    
    remainingOrders.slice(0, 5).forEach((o, index) => {
      const emoji = index === 0 ? '⚡' : (index + 1).toString() + '️⃣';
      message += `\n${emoji} #${o.id} - ${o.total}€`;
    });
    
    if (remainingOrders.length > 5) {
      message += `\n\n... et ${remainingOrders.length - 5} autre(s)`;
    }
  }

  const keyboard = {
    inline_keyboard: [
      [{ text: '💬 Contacter le client', callback_data: `contact_client_${orderId}` }],
      [{ text: '✅ LIVRAISON TERMINÉE', callback_data: `complete_delivery_${orderId}` }],
      [{ text: '📍 Ouvrir Maps', url: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(order.address)}` }],
      [{ text: '📋 Voir toutes mes livraisons', callback_data: `my_deliveries_${order.assigned_driver_zone}` }]
    ]
  };
  
  await telegram.sendMessage(chatId, message, { reply_markup: keyboard });
  await notifyClientViaSupport(order.customer, orderId, 'en_route', estimatedTime);
}

async function startDriverConversation(chatId, orderId) {
  const conversation = activeConversations.get(parseInt(orderId));
  
  if (!conversation) {
    await telegram.sendMessage(chatId, '❌ Conversation introuvable');
    return;
  }
  
  conversation.driverInConversation = true;
  activeConversations.set(parseInt(orderId), conversation);
  
  const message = `💬 <b>MODE CONVERSATION ACTIVÉ</b>

Commande #${orderId}
Client : 🎭 Anonyme

Tapez votre message, il sera transmis au client.

Exemples :
• "Je suis en route"
• "Je suis devant l'immeuble"
• "Quel bâtiment ?"

Pour quitter : /stop`;

  const keyboard = {
    inline_keyboard: [
      [{ text: '❌ Quitter la conversation', callback_data: `stop_conversation_${orderId}` }]
    ]
  };
  
  await telegram.sendMessage(chatId, message, { reply_markup: keyboard });
}

async function stopDriverConversation(chatId, orderId) {
  const conversation = activeConversations.get(parseInt(orderId));
  
  if (conversation) {
    conversation.driverInConversation = false;
    activeConversations.set(parseInt(orderId), conversation);
  }
  
  await telegram.sendMessage(chatId, `✅ Conversation terminée`);
}

async function completeDelivery(chatId, orderId) {
  const order = await db.get('SELECT * FROM orders WHERE id = ?', [orderId]);
  
  if (!order) {
    await telegram.sendMessage(chatId, '❌ Commande introuvable');
    return;
  }
  
  await db.run('UPDATE orders SET status = ? WHERE id = ?', ['delivered', orderId]);
  activeConversations.delete(parseInt(orderId));
  
  const nextOrder = await db.get(
    "SELECT * FROM orders WHERE status = 'pending' AND assigned_driver_zone = ? ORDER BY created_at ASC LIMIT 1",
    [order.assigned_driver_zone]
  );
  
  const remainingCount = await db.get(
    "SELECT COUNT(*) as count FROM orders WHERE status = 'pending' AND assigned_driver_zone = ?",
    [order.assigned_driver_zone]
  );
  
  let message = `✅ <b>LIVRAISON #${orderId} CONFIRMÉE</b>

💰 Montant encaissé : ${order.total}€

⚠️ Remettez l'argent à l'admin !`;

  if (nextOrder) {
    const nextItems = JSON.parse(nextOrder.items || '[]');
    message += `\n\n━━━━━━━━━━━━━━━━━━━
⚡ <b>PROCHAINE COMMANDE PRIORITAIRE</b>

📦 #${nextOrder.id}
📍 ${nextOrder.address}
💰 ${nextOrder.total}€
📦 ${nextItems.length} article(s)

📋 ${remainingCount.count} commande(s) restante(s)`;
    
    const keyboard = {
      inline_keyboard: [
        [{ text: `🚀 START #${nextOrder.id}`, callback_data: `start_delivery_${nextOrder.id}` }],
        [{ text: '📋 Voir toutes mes livraisons', callback_data: `my_deliveries_${order.assigned_driver_zone}` }],
        [{ text: '📊 Mes statistiques', callback_data: 'driver_stats' }]
      ]
    };
    
    await telegram.sendMessage(chatId, message, { reply_markup: keyboard });
  } else {
    message += `\n\n🎉 <b>AUCUNE COMMANDE EN ATTENTE</b>\n\nBravo ! Toutes les livraisons sont terminées ! 🚀`;
    
    const keyboard = {
      inline_keyboard: [
        [{ text: '📊 Voir mes statistiques', callback_data: 'driver_stats' }]
      ]
    };
    
    await telegram.sendMessage(chatId, message, { reply_markup: keyboard });
  }
  
  if (config.telegram.adminChatId) {
    const adminMsg = `✅ <b>LIVRAISON TERMINÉE #${orderId}</b>

💰 À récupérer : ${order.total}€
📍 ${order.address}`;
    
    await telegram.sendMessage(config.telegram.adminChatId, adminMsg);
  }
  
  await notifyClientViaSupport(order.customer, orderId, 'delivered');
}

async function refuseDelivery(chatId, orderId) {
  await db.run('UPDATE orders SET status = ? WHERE id = ?', ['cancelled', orderId]);
  activeConversations.delete(parseInt(orderId));
  
  if (config.telegram.adminChatId) {
    await telegram.sendMessage(config.telegram.adminChatId, `❌ Livraison #${orderId} refusée par le livreur`);
  }
  
  await telegram.sendMessage(chatId, '❌ Livraison refusée');
}

async function approveCustomerFromTelegram(chatId, orderId) {
  if (chatId.toString() !== config.telegram.adminChatId) {
    await telegram.sendMessage(chatId, '❌ Action non autorisée');
    return;
  }
  
  try {
    const order = await db.get('SELECT * FROM orders WHERE id = ?', [orderId]);
    
    if (!order) {
      await telegram.sendMessage(chatId, '❌ Commande introuvable');
      return;
    }
    
    const contact = order.customer;
    const customer = await db.get('SELECT * FROM customers WHERE contact = ?', [contact]);
    
    if (!customer) {
      await telegram.sendMessage(chatId, '❌ Client introuvable');
      return;
    }
    
    if (customer.status === 'approved') {
      await telegram.sendMessage(chatId, '✅ Ce client est déjà approuvé');
      return;
    }
    
    await db.run(
      'UPDATE customers SET status = ?, approved_date = CURRENT_TIMESTAMP, approved_by = ? WHERE contact = ?',
      ['approved', 'Admin via Telegram', contact]
    );
    
    const pendingOrders = await db.all(
      'SELECT * FROM orders WHERE customer = ? AND status = ?',
      [contact, 'pending_approval']
    );
    
    for (const pendingOrder of pendingOrders) {
      await db.run(
        'UPDATE orders SET status = ? WHERE id = ?',
        ['pending', pendingOrder.id]
      );
      
      await db.run(
        `INSERT INTO transactions (type, category, description, amount, payment_method, date)
         VALUES ('revenue', 'vente', ?, ?, 'online', DATE('now'))`,
        [`Commande #${pendingOrder.id}`, pendingOrder.total]
      );
      
      try {
        const items = JSON.parse(pendingOrder.items);
        await notifyNewOrder(pendingOrder, items);
      } catch (err) {
        console.error(`Error notifying driver for order #${pendingOrder.id}:`, err);
      }
    }
    
    const message = `✅ <b>CLIENT APPROUVÉ</b>

👤 Client: ${contact}
📦 ${pendingOrders.length} commande(s) validée(s)

Les livreurs ont été notifiés.
Le client peut maintenant commander librement.`;
    
    await telegram.sendMessage(chatId, message);
    
    if (config.telegram.supportChatId) {
      await telegram.sendMessage(
        config.telegram.supportChatId, 
        `✅ Client ${contact} approuvé par l'admin\n${pendingOrders.length} commande(s) en cours de traitement`
      );
    }
    
    console.log(`✅ Customer ${contact} approved from Telegram (order #${orderId})`);
  } catch (error) {
    console.error('Approve customer error:', error);
    await telegram.sendMessage(chatId, '❌ Erreur lors de l\'approbation');
  }
}

async function blockCustomerFromTelegram(chatId, orderId) {
  if (chatId.toString() !== config.telegram.adminChatId) {
    await telegram.sendMessage(chatId, '❌ Action non autorisée');
    return;
  }
  
  try {
    const order = await db.get('SELECT * FROM orders WHERE id = ?', [orderId]);
    
    if (!order) {
      await telegram.sendMessage(chatId, '❌ Commande introuvable');
      return;
    }
    
    const contact = order.customer;
    
    await db.run(
      'UPDATE customers SET status = ?, blocked_reason = ? WHERE contact = ?',
      ['blocked', 'Bloqué par admin via Telegram', contact]
    );
    
    const cancelledOrders = await db.all(
      'SELECT * FROM orders WHERE customer = ? AND status IN (?, ?)',
      [contact, 'pending', 'pending_approval']
    );
    
    await db.run(
      'UPDATE orders SET status = ? WHERE customer = ? AND status IN (?, ?)',
      ['cancelled', contact, 'pending', 'pending_approval']
    );
    
    for (const [convOrderId, conv] of activeConversations.entries()) {
      if (conv.customerId === contact) {
        activeConversations.delete(convOrderId);
      }
    }
    
    const message = `🚫 <b>CLIENT BLOQUÉ</b>

👤 Client: ${contact}
📦 ${cancelledOrders.length} commande(s) annulée(s)

Le client ne peut plus commander.`;
    
    await telegram.sendMessage(chatId, message);
    
    if (config.telegram.supportChatId) {
      await telegram.sendMessage(
        config.telegram.supportChatId, 
        `🚫 Client ${contact} bloqué par l'admin`
      );
    }
    
    console.log(`🚫 Customer ${contact} blocked from Telegram (order #${orderId})`);
  } catch (error) {
    console.error('Block customer error:', error);
    await telegram.sendMessage(chatId, '❌ Erreur lors du blocage');
  }
}

async function sendOrderCustomerDetails(chatId, orderId) {
  if (chatId.toString() !== config.telegram.adminChatId) {
    await telegram.sendMessage(chatId, '❌ Action non autorisée');
    return;
  }
  
  try {
    const order = await db.get('SELECT * FROM orders WHERE id = ?', [orderId]);
    
    if (!order) {
      await telegram.sendMessage(chatId, '❌ Commande introuvable');
      return;
    }
    
    const contact = order.customer;
    await sendCustomerDetails(chatId, contact);
  } catch (error) {
    console.error('Send order customer details error:', error);
    await telegram.sendMessage(chatId, '❌ Erreur lors de la récupération des détails');
  }
}

async function sendCustomerDetails(chatId, contact) {
  if (chatId.toString() !== config.telegram.adminChatId) {
    await telegram.sendMessage(chatId, '❌ Action non autorisée');
    return;
  }
  
  try {
    const customer = await db.get(
      'SELECT * FROM customers WHERE contact = ?',
      [contact]
    );
    
    if (!customer) {
      await telegram.sendMessage(chatId, '❌ Client introuvable');
      return;
    }
    
    const stats = await db.get(
      `SELECT 
        COUNT(*) as total_orders,
        SUM(CASE WHEN status != 'cancelled' THEN total ELSE 0 END) as total_spent,
        COUNT(CASE WHEN status = 'delivered' THEN 1 END) as delivered_orders,
        COUNT(CASE WHEN status = 'cancelled' THEN 1 END) as cancelled_orders,
        COUNT(CASE WHEN status = 'pending_approval' THEN 1 END) as pending_orders
       FROM orders 
       WHERE customer = ?`,
      [contact]
    );
    
    const lastOrders = await db.all(
      'SELECT id, total, status, created_at FROM orders WHERE customer = ? ORDER BY created_at DESC LIMIT 5',
      [contact]
    );
    
    const statusEmoji = {
      'pending': '⏳',
      'approved': '✅',
      'blocked': '🚫'
    };
    
    let message = `📋 <b>DÉTAILS CLIENT</b>

👤 <b>Contact:</b> ${contact}
📊 <b>Statut:</b> ${statusEmoji[customer.status] || '❓'} ${customer.status.toUpperCase()}
📅 <b>Inscrit le:</b> ${new Date(customer.first_order_date).toLocaleString('fr-FR')}`;

    if (customer.approved_date && customer.status === 'approved') {
      message += `\n✅ <b>Approuvé le:</b> ${new Date(customer.approved_date).toLocaleString('fr-FR')}`;
    }

    message += `\n\n<b>📈 STATISTIQUES</b>
🛒 Total commandes: ${stats.total_orders}
✅ Livrées: ${stats.delivered_orders}
❌ Annulées: ${stats.cancelled_orders}`;

    if (stats.pending_orders > 0) {
      message += `\n⏳ En attente: ${stats.pending_orders}`;
    }

    message += `\n💰 CA total: ${(stats.total_spent || 0).toFixed(2)}€`;

    if (customer.notes) {
      message += `\n\n📝 <b>Notes:</b> ${customer.notes}`;
    }
    
    if (customer.blocked_reason) {
      message += `\n\n⚠️ <b>Raison blocage:</b> ${customer.blocked_reason}`;
    }
    
    if (lastOrders.length > 0) {
      message += `\n\n<b>📦 DERNIÈRES COMMANDES</b>`;
      lastOrders.forEach(order => {
        const statusIcon = {
          'pending': '⏳',
          'pending_approval': '🔍',
          'en_route': '🚚',
          'delivered': '✅',
          'cancelled': '❌'
        };
        message += `\n${statusIcon[order.status] || '📦'} #${order.id} - ${order.total}€ (${new Date(order.created_at).toLocaleDateString('fr-FR')})`;
      });
    }
    
    await telegram.sendMessage(chatId, message);
  } catch (error) {
    console.error('Send customer details error:', error);
    await telegram.sendMessage(chatId, '❌ Erreur lors de la récupération des détails');
  }
}

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

async function start() {
  try {
    await initDB();
    
    app.listen(PORT, () => {
      console.log('🚀 ================================');
      console.log(`   Server running on port ${PORT}`);
      console.log('🚀 ================================');
      console.log(`📱 Frontend: http://localhost:${PORT}`);
      console.log(`🔐 Admin: http://localhost:${PORT}/admin.html`);
      
      if (!config.telegram.token) {
        console.log('⚠️  TELEGRAM_TOKEN not set - bot disabled');
      } else {
        console.log('✅ Telegram bot enabled');
        console.log(`🔗 Webhook: ${config.webapp.url}/bot${config.telegram.token}`);
      }
      
      console.log('');
      console.log('📍 Configuration status:');
      console.log(`   Support: ${config.telegram.supportChatId ? '✅' : '❌'}`);
      console.log(`   Admin: ${config.telegram.adminChatId ? '✅' : '❌'}`);
      console.log(`   Driver Millau: ${config.telegram.driverMillauId ? '✅' : '❌'}`);
      console.log(`   Driver Extérieur: ${config.telegram.driverExterieurId ? '✅' : '❌'}`);
      console.log(`   Mapbox: ${config.mapbox.key ? '✅' : '❌'}`);
      console.log('🚀 ================================');
    });
  } catch (error) {
    console.error('❌ Server start error:', error);
    process.exit(1);
  }
}

process.on('SIGTERM', async () => {
  console.log('📛 SIGTERM received, closing server...');
  if (db) await db.close();
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('📛 SIGINT received, closing server...');
  if (db) await db.close();
  process.exit(0);
});

start().catch(console.error);
