const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');
const cors = require('cors');
const path = require('path');
const axios = require('axios');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');

const app = express();
const PORT = process.env.PORT || 3000;

// ==================== CONFIGURATION ====================
const config = {
  telegram: {
    token: process.env.TELEGRAM_TOKEN || '',
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
    tokenExpiry: 24 * 60 * 60 * 1000, // 24 hours
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
  contentSecurityPolicy: false, // Disable for web apps
}));

// Rate limiters
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100,
  message: { ok: false, error: 'Trop de requêtes, réessayez plus tard' },
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: { ok: false, error: 'Trop de tentatives de connexion' },
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

    CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
    CREATE INDEX IF NOT EXISTS idx_orders_created_at ON orders(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_transactions_date ON transactions(date DESC);
    CREATE INDEX IF NOT EXISTS idx_stock_movements_created_at ON stock_movements(created_at DESC);
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

function validateEmail(email) {
  const re = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return re.test(email);
}

function validatePhone(phone) {
  const re = /^[\d\s\+\-\(\)]{8,20}$/;
  return re.test(phone);
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
  
  // Validate each item
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

// ==================== TELEGRAM HELPERS ====================
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

  formatOrderMessage(order, items, includeZone = false) {
    let message = `📦 <b>COMMANDE #${order.id}</b>\n\n`;
    message += `👤 Client: ${order.customer}\n`;
    message += `📍 Type: ${order.type}\n`;
    if (order.address) message += `🏠 Adresse: ${order.address}\n`;
    
    message += `\n📦 Articles:\n`;
    items.forEach(item => {
      message += `• ${item.name} - ${item.variant} ×${item.qty} = ${item.lineTotal}€\n`;
    });
    
    if (order.discount > 0) {
      message += `\n🎁 Remise fidélité: -${order.discount}€`;
    }
    
    message += `\n💰 <b>TOTAL: ${order.total}€</b>`;
    
    if (includeZone && order.assigned_driver_zone) {
      message += `\n🌍 Zone: ${order.assigned_driver_zone.toUpperCase()}`;
    }
    
    message += `\n⏰ ${new Date(order.created_at).toLocaleString('fr-FR')}`;
    
    return message;
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
  
  // Default to Millau
  return {
    zone: 'millau',
    driverId: config.telegram.driverMillauId,
    driverName: 'Millau'
  };
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
async function notifyNewOrder(order, items) {
  const driverInfo = getDriverForDeliveryType(order.type);
  
  // Notify support
  if (config.telegram.supportChatId) {
    const supportMessage = `🔔 NOUVELLE COMMANDE #${order.id}

👤 Client: ${order.customer}
📍 Type: ${order.type}
💰 Total: ${order.total}€
📦 Articles: ${items.length} produit(s)

⚡ Contacter le client`;
    
    await telegram.sendMessage(config.telegram.supportChatId, supportMessage);
  }
  
  // Notify admin
  if (config.telegram.adminChatId) {
    const adminMessage = telegram.formatOrderMessage(order, items, true);
    await telegram.sendMessage(config.telegram.adminChatId, adminMessage);
  }
  
  // Notify driver
  if (driverInfo.driverId) {
    const driverMessage = `🚚 <b>NOUVELLE COMMANDE #${order.id}</b>

📍 Type: ${order.type}
🏠 Adresse: ${order.address || 'Sur place'}
💰 Total à encaisser: ${order.total}€
📦 ${items.length} article(s)

${items.map(item => `• ${item.name} - ${item.variant} ×${item.qty}`).join('\n')}

🎭 <b>Client: Anonyme</b>
💬 <b>Communication: Via le bot uniquement</b>

⏰ ${new Date(order.created_at).toLocaleString('fr-FR')}`;
    
    const keyboard = {
      inline_keyboard: [
        [{ text: '🚀 DÉMARRER LA LIVRAISON', callback_data: `start_delivery_${order.id}` }],
        [{ text: '💬 Contacter le client', callback_data: `contact_client_${order.id}` }],
        [{ text: '❌ Refuser', callback_data: `refuse_delivery_${order.id}` }]
      ]
    };
    
    await telegram.sendMessage(driverInfo.driverId, driverMessage, { reply_markup: keyboard });
    
    // Store conversation
    activeConversations.set(order.id, {
      driverId: driverInfo.driverId,
      customerId: order.customer,
      orderId: order.id,
      driverInConversation: false,
      zone: driverInfo.zone
    });
    
    // Update order with assigned zone
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

// Health check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    telegram: !!config.telegram.token,
    database: !!db
  });
});

// Create order
app.post('/api/create-order', apiLimiter, async (req, res) => {
  try {
    console.log('📨 New order received');
    
    // Validate input
    validateOrderInput(req.body);
    
    const { customer, type, address, items, total } = req.body;
    
    // Sanitize inputs
    const sanitizedCustomer = sanitizeString(customer, 100);
    const sanitizedType = sanitizeString(type, 50);
    const sanitizedAddress = sanitizeString(address, 200);
    
    // Calculate loyalty discount
    const { discount } = await calculateLoyaltyDiscount(sanitizedCustomer, total);
    const finalTotal = total - discount;
    
    // Insert order
    const result = await db.run(
      `INSERT INTO orders (customer, type, address, items, total, discount) 
       VALUES (?, ?, ?, ?, ?, ?)`,
      [sanitizedCustomer, sanitizedType, sanitizedAddress, JSON.stringify(items), finalTotal, discount]
    );
    
    const orderId = result.lastID;
    console.log(`✅ Order #${orderId} created`);
    
    // Update loyalty
    await updateLoyaltyProgram(sanitizedCustomer);
    
    // Update stock
    await updateStockForOrder(items, orderId);
    
    // Add transaction
    await db.run(
      `INSERT INTO transactions (type, category, description, amount, payment_method, date)
       VALUES ('revenue', 'vente', ?, ?, 'online', DATE('now'))`,
      [`Commande #${orderId}`, finalTotal]
    );
    
    // Get full order for notifications
    const order = await db.get('SELECT * FROM orders WHERE id = ?', [orderId]);
    
    // Send notifications (non-blocking)
    notifyNewOrder(order, items).catch(err => 
      console.error('Notification error:', err.message)
    );
    
    res.json({ ok: true, orderId, discount });
    
  } catch (error) {
    console.error('Create order error:', error);
    
    if (error instanceof ValidationError) {
      return res.status(400).json({ ok: false, error: error.message });
    }
    
    res.status(500).json({ ok: false, error: 'Erreur serveur' });
  }
});

// Geocode proxy
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

// Admin login
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

// Admin stats
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
    
    // Top product
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
    
    // Stock stats
    const stock = await db.all('SELECT * FROM stock');
    stats.stockOut = stock.filter(s => s.qty === 0).length;
    stats.stockLow = stock.filter(s => s.qty > 0 && s.qty < 10).length;
    
    res.json({ ok: true, stats });
  } catch (error) {
    console.error('Stats error:', error);
    res.status(500).json({ ok: false, error: 'Erreur serveur' });
  }
});

// Get orders
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
    params.push(Math.min(parseInt(limit), 500)); // Max 500
    
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

// Update order
app.put('/api/admin/orders/:id', requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const updates = req.body;
    
    // Prevent ID update
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

// Delete order
app.delete('/api/admin/orders/:id', requireAdmin, async (req, res) => {
  try {
    await db.run('DELETE FROM orders WHERE id = ?', [req.params.id]);
    res.json({ ok: true });
  } catch (error) {
    console.error('Delete order error:', error);
    res.status(500).json({ ok: false, error: 'Erreur serveur' });
  }
});

// Stock routes
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

// Transaction routes
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

// Review routes
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

// Settings routes
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

// Export orders
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
    res.send('\uFEFF' + csv); // Add BOM for Excel
  } catch (error) {
    console.error('Export error:', error);
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

async function handleTelegramMessage(message) {
  const chatId = message.chat.id;
  const text = message.text;
  const firstName = message.from.first_name || 'Client';
  
  console.log(`💬 Message from ${firstName} (${chatId}): ${text}`);
  
  // Command handlers
  if (text === '/start') {
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

// Bot message handlers (continued in next section due to length)
async function sendWelcomeMessage(chatId, firstName) {
  const text = `🌟 <b>Bienvenue ${firstName} chez DROGUA CENTER !</b> 🌟

Votre boutique premium accessible directement depuis Telegram.

<b>🛍️ Que souhaitez-vous faire ?</b>

• <b>Boutique</b> - Parcourir et commander
• <b>Admin</b> - Gérer votre boutique
• <b>Support</b> - Aide et assistance

✨ <i>Programme de fidélité actif !</i>
Bénéficiez d'une remise tous les ${config.loyalty.defaultThreshold} achats.`;

  const keyboard = {
    inline_keyboard: [
      [{ text: '🛍️ Accéder à la Boutique', web_app: { url: config.webapp.url } }],
      [{ text: '🔐 Panneau Admin', web_app: { url: `${config.webapp.url}/admin.html` } }],
      [
        { text: '📢 Canal Principal', url: 'https://t.me/+MToYP95G9zY2ZTJk' },
        { text: '📸 Canal Photo', url: 'https://t.me/+usSUbJOfYsk5ZTg0' }
      ],
      [
        { text: '💬 Support', callback_data: 'contact_support' },
        { text: 'ℹ️ Infos', callback_data: 'show_info' }
      ]
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
🎁 Programme de fidélité actif`;

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
Livraison rapide pendant les heures d'ouverture`;

  const keyboard = {
    inline_keyboard: [
      [{ text: '💬 Contacter le Support', url: 'https://t.me/assistancenter' }],
      [
        { text: '🛒 Boutique', callback_data: 'open_shop' },
        { text: '🔐 Admin', callback_data: 'open_admin' }
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

<i>Réponse sous 24h maximum</i>`;

  const keyboard = {
    inline_keyboard: [
      [{ text: '💬 Support Telegram', url: 'https://t.me/assistancenter' }],
      [{ text: '📸 Snapchat', url: 'https://snapchat.com/t/l9gurvAj' }]
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
  
  const activeDeliveries = await db.all(
    "SELECT * FROM orders WHERE status IN ('pending', 'en_route') AND assigned_driver_zone = ? ORDER BY created_at DESC",
    [driverZone]
  );
  
  if (activeDeliveries.length === 0) {
    await telegram.sendMessage(chatId, `📭 <b>Aucune livraison en cours</b>\n\nZone : ${driverZone.toUpperCase()}`);
    return;
  }
  
  let message = `🚚 <b>VOS LIVRAISONS (${driverZone.toUpperCase()})</b>\n\n`;
  
  for (const order of activeDeliveries) {
    const items = JSON.parse(order.items || '[]');
    const statusEmoji = order.status === 'pending' ? '⏳' : '🚀';
    const statusText = order.status === 'pending' ? 'En attente' : 'En route';
    
    message += `${statusEmoji} <b>#${order.id}</b> - ${statusText}\n`;
    message += `📍 ${order.address}\n`;
    message += `💰 ${order.total}€\n`;
    message += `📦 ${items.length} article(s)\n`;
    message += `🎭 Client : Anonyme\n`;
    
    if (order.status === 'en_route' && order.delivery_time) {
      message += `⏱️ ETA: ${order.delivery_time} min\n`;
    }
    
    message += `\n`;
  }
  
  await telegram.sendMessage(chatId, message);
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
  
  const message = `✅ <b>LIVRAISON DÉMARRÉE #${orderId}</b>

⏱️ Temps estimé : ${estimatedTime} minutes
📍 ${order.address}
💰 ${order.total}€

🎭 <b>Client : Anonyme</b>
💬 Utilisez le bouton "Contacter" pour envoyer un message`;

  const keyboard = {
    inline_keyboard: [
      [{ text: '💬 Contacter le client', callback_data: `contact_client_${orderId}` }],
      [{ text: '✅ LIVRAISON TERMINÉE', callback_data: `complete_delivery_${orderId}` }],
      [{ text: '📍 Ouvrir Maps', url: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(order.address)}` }]
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
  
  const message = `✅ <b>LIVRAISON #${orderId} CONFIRMÉE</b>

💰 Montant encaissé : ${order.total}€

⚠️ Remettez l'argent à l'admin !`;
  
  await telegram.sendMessage(chatId, message);
  
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

// ==================== FALLBACK ROUTE ====================
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ==================== SERVER START ====================
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

// Graceful shutdown
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
