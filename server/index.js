// ===== CETTE LIGNE DOIT ÊTRE LA TOUTE PREMIÈRE =====
require('dotenv').config();

const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');
const cors = require('cors');
const path = require('path');
const axios = require('axios');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const bcrypt = require('bcrypt');

const app = express();
app.set('trust proxy', 1);

const PORT = process.env.PORT || 3000;

// ==================== CONFIGURATION SÉCURISÉE ====================
const config = {
  telegram: {
    token: process.env.TELEGRAM_TOKEN,
    adminChatIds: (process.env.ADMIN_CHAT_ID || '').split(',').map(id => id.trim()).filter(id => id),
    supportChatId: process.env.SUPPORT_CHAT_ID || '',
    driverMillauId: process.env.DRIVER_MILLAU_ID || '',
    driverExterieurId: process.env.DRIVER_EXTERIEUR_ID || '',
    channelId: process.env.TELEGRAM_CHANNEL_ID || '',
    photoChannelId: process.env.TELEGRAM_PHOTO_CHANNEL_ID || '',
    secoursChannelId: process.env.TELEGRAM_SECOURS_CHANNEL_ID || '',
  },
  mapbox: {
    key: process.env.MAPBOX_KEY || '',
  },
  admin: {
    password: process.env.ADMIN_PASS,
    tokenExpiry: 24 * 60 * 60 * 1000,
  },
  webapp: {
    url: process.env.WEBAPP_URL || 'https://shop-2-production-2d5f.up.railway.app',
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

// ==================== VALIDATION ENVIRONNEMENT ====================
if (!config.telegram.token) {
  console.error('❌ ERREUR CRITIQUE: TELEGRAM_TOKEN manquant !');
  console.error('   Définissez la variable d\'environnement TELEGRAM_TOKEN');
  process.exit(1);
}

if (!config.admin.password) {
  console.error('❌ ERREUR CRITIQUE: ADMIN_PASS manquant !');
  console.error('   Définissez la variable d\'environnement ADMIN_PASS');
  process.exit(1);
}

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
app.use(cors({
  origin: [config.webapp.url, 'http://localhost:3000'],
  credentials: true
}));
app.use(express.json({ limit: '10mb' }));

// Debug: Logger toutes les requêtes POST
app.use((req, res, next) => {
  if (req.method === 'POST') {
    console.log(`📨 POST ${req.path} - Body: ${JSON.stringify(req.body).substring(0, 100)}`);
  }
  next();
});

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
    return crypto.randomBytes(32).toString('hex');
  }
}

const adminTokens = new TokenStore(config.admin.tokenExpiry);

// Hash du mot de passe admin avec bcrypt (ne jamais comparer en clair)
const BCRYPT_ROUNDS = 12;
let adminPasswordHash = null;

async function initAdminPassword() {
  adminPasswordHash = await bcrypt.hash(config.admin.password, BCRYPT_ROUNDS);
}

async function verifyAdminPassword(password) {
  return bcrypt.compare(password || '', adminPasswordHash);
}

// Admins authentifiés en session (via /adminlogin)
const sessionAdmins = new Set();

// État conversationnel pour les admins (chatId -> { action, step, data })
const adminStates = new Map();

// Helper pour obtenir la liste des admin IDs (lecture dynamique de l'env)
function getAdminChatIds() {
  return (process.env.ADMIN_CHAT_ID || '').split(',').map(id => id.trim()).filter(id => id);
}

// Helper pour vérifier si un utilisateur est admin
function isAdmin(chatId) {
  const chatIdStr = chatId.toString();
  // Vérifier d'abord les admins connectés en session
  if (sessionAdmins.has(chatIdStr)) return true;
  // Ensuite vérifier l'env
  const adminIds = getAdminChatIds();
  return adminIds.includes(chatIdStr);
}

// Helper pour envoyer un message à tous les admins
async function notifyAdmins(message, options = {}) {
  const adminIds = getAdminChatIds();
  for (const adminId of adminIds) {
    try {
      await telegram.sendMessage(adminId, message, options);
    } catch (error) {
      console.error(`Failed to notify admin ${adminId}:`, error.message);
    }
  }
}

// ==================== CHAT SYSTEM ====================
class ChatManager {
  constructor() {
    this.activeConversations = new Map();
    this._locks = new Map(); // Verrous par orderId pour éviter les modifications concurrentes
  }

  // Verrou async par orderId pour sérialiser les opérations sur une même conversation
  async _withLock(orderId, fn) {
    while (this._locks.get(orderId)) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    this._locks.set(orderId, true);
    try {
      return await fn();
    } finally {
      this._locks.delete(orderId);
    }
  }

  createConversation(orderId, driverId, clientTelegramId) {
    this.activeConversations.set(orderId, {
      orderId,
      driverId,
      clientTelegramId,
      driverActive: false,
      clientActive: false,
      messagesCount: 0,
      startedAt: Date.now(),
      lastActivity: Date.now()
    });
    console.log(`💬 Conversation created for order #${orderId}`);
  }

  getConversation(orderId) {
    return this.activeConversations.get(orderId);
  }

  findConversationByChatId(chatId, role) {
    for (const [orderId, conv] of this.activeConversations.entries()) {
      if (role === 'driver' && conv.driverId === chatId.toString() && conv.driverActive) {
        return { orderId, ...conv };
      }
      if (role === 'client' && conv.clientTelegramId === chatId.toString() && conv.clientActive) {
        return { orderId, ...conv };
      }
    }
    return null;
  }

  async activateDriver(orderId) {
    return this._withLock(orderId, async () => {
      const conv = this.activeConversations.get(orderId);
      if (conv) {
        conv.driverActive = true;
        conv.lastActivity = Date.now();
      }
    });
  }

  async activateClient(orderId) {
    return this._withLock(orderId, async () => {
      const conv = this.activeConversations.get(orderId);
      if (conv) {
        conv.clientActive = true;
        conv.lastActivity = Date.now();
      }
    });
  }

  async deactivateDriver(orderId) {
    return this._withLock(orderId, async () => {
      const conv = this.activeConversations.get(orderId);
      if (conv) {
        conv.driverActive = false;
      }
    });
  }

  async deactivateClient(orderId) {
    return this._withLock(orderId, async () => {
      const conv = this.activeConversations.get(orderId);
      if (conv) {
        conv.clientActive = false;
      }
    });
  }

  closeConversation(orderId) {
    this.activeConversations.delete(orderId);
    this._locks.delete(orderId);
    console.log(`🔒 Conversation closed for order #${orderId}`);
  }

  async incrementMessageCount(orderId) {
    return this._withLock(orderId, async () => {
      const conv = this.activeConversations.get(orderId);
      if (conv) {
        conv.messagesCount++;
        conv.lastActivity = Date.now();
      }
    });
  }

  cleanupInactive() {
    const now = Date.now();
    const timeout = 30 * 60 * 1000;

    for (const [orderId, conv] of this.activeConversations.entries()) {
      if (now - conv.lastActivity > timeout) {
        this.activeConversations.delete(orderId);
        this._locks.delete(orderId);
        console.log(`🧹 Auto-closed inactive conversation #${orderId}`);
      }
    }
  }
}

const chatManager = new ChatManager();

// Cleanup automatique toutes les 15 minutes (optimisé)
setInterval(() => chatManager.cleanupInactive(), 15 * 60 * 1000);

// Cleanup paniers expirés toutes les 5 minutes (30min d'expiration)
setInterval(async () => {
  try {
    if (!db) return;
    const result = await db.run(
      "DELETE FROM carts WHERE updated_at < datetime('now', '-30 minutes')"
    );
    if (result.changes > 0) {
      console.log(`🧹 ${result.changes} panier(s) expiré(s) supprimé(s)`);
    }
  } catch (e) {
    console.error('Cart cleanup error:', e.message);
  }
}, 5 * 60 * 1000);

// ==================== DATABASE ====================
let db;

async function initDB() {
  db = await open({
    filename: './boutique.db',
    driver: sqlite3.Database
  });

  // Optimisation SQLite pour accès concurrent (flux de clients)
  await db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    PRAGMA foreign_keys = ON;
  `);
  console.log('✅ SQLite WAL mode + busy_timeout activés');

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
      client_telegram_id TEXT,
      cancel_reason TEXT,
      cancelled_at DATETIME,
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

    CREATE TABLE IF NOT EXISTS telegram_clients (
      telegram_id TEXT PRIMARY KEY,
      contact TEXT UNIQUE,
      first_name TEXT,
      username TEXT,
      registered_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      last_seen DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS chat_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER NOT NULL,
      sender_type TEXT NOT NULL CHECK(sender_type IN ('driver', 'client')),
      sender_id TEXT NOT NULL,
      message TEXT NOT NULL,
      delivered INTEGER DEFAULT 0,
      read INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (order_id) REFERENCES orders(id)
    );

    CREATE TABLE IF NOT EXISTS referrals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      referral_code TEXT NOT NULL UNIQUE,
      customer_contact TEXT NOT NULL,
      credit_balance REAL DEFAULT 0,
      total_referrals INTEGER DEFAULT 0,
      total_earned REAL DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS referral_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      referrer_code TEXT NOT NULL,
      referrer_contact TEXT NOT NULL,
      referred_contact TEXT NOT NULL,
      order_id INTEGER,
      referrer_credit REAL NOT NULL,
      referred_credit REAL NOT NULL,
      status TEXT DEFAULT 'completed' CHECK(status IN ('pending', 'completed', 'cancelled')),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (order_id) REFERENCES orders(id)
    );

    CREATE TABLE IF NOT EXISTS announcements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      channel_id TEXT NOT NULL,
      message_id INTEGER,
      type TEXT DEFAULT 'text',
      content TEXT,
      photo_url TEXT,
      pin INTEGER DEFAULT 0,
      status TEXT DEFAULT 'posted',
      post_at DATETIME,
      delete_at DATETIME,
      recurring TEXT,
      pin_schedule TEXT,
      posted_by TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS scheduled_actions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      announcement_id INTEGER NOT NULL,
      action TEXT NOT NULL,
      execute_at DATETIME NOT NULL,
      status TEXT DEFAULT 'pending',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (announcement_id) REFERENCES announcements(id)
    );

    CREATE TABLE IF NOT EXISTS carts (
      session_id TEXT PRIMARY KEY,
      items TEXT NOT NULL DEFAULT '[]',
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS favorites (
      session_id TEXT PRIMARY KEY,
      product_ids TEXT NOT NULL DEFAULT '[]',
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS staff_data (
      role TEXT PRIMARY KEY CHECK(role IN ('nourrice', 'gerant', 'livreur')),
      data TEXT NOT NULL DEFAULT '{}',
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_carts_updated ON carts(updated_at);
    CREATE INDEX IF NOT EXISTS idx_scheduled_actions_status ON scheduled_actions(status, execute_at);
    CREATE INDEX IF NOT EXISTS idx_announcements_channel ON announcements(channel_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_announcements_status ON announcements(status);
    CREATE INDEX IF NOT EXISTS idx_announcements_post_at ON announcements(post_at);
    CREATE INDEX IF NOT EXISTS idx_announcements_delete_at ON announcements(delete_at);
    CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
    CREATE INDEX IF NOT EXISTS idx_orders_created_at ON orders(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_transactions_date ON transactions(date DESC);
    CREATE INDEX IF NOT EXISTS idx_stock_movements_created_at ON stock_movements(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_customers_status ON customers(status);
    CREATE INDEX IF NOT EXISTS idx_customers_contact ON customers(contact);
    CREATE INDEX IF NOT EXISTS idx_customers_created_at ON customers(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_chat_messages_order ON chat_messages(order_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_telegram_clients_contact ON telegram_clients(contact);
    CREATE INDEX IF NOT EXISTS idx_referrals_code ON referrals(referral_code);
    CREATE INDEX IF NOT EXISTS idx_referrals_contact ON referrals(customer_contact);
    CREATE INDEX IF NOT EXISTS idx_referral_history_referrer ON referral_history(referrer_code);
    CREATE INDEX IF NOT EXISTS idx_referral_history_order ON referral_history(order_id);
  `);

  await db.run(`
    INSERT OR IGNORE INTO settings (key, value) VALUES 
    ('shop_name', 'DROGUA CENTER'),
    ('delivery_fee', '20'),
    ('loyalty_threshold', '${config.loyalty.defaultThreshold}'),
    ('cash_balance', '0'),
    ('monthly_goal', '5000')
  `);

  console.log('✅ Database initialized with chat system');
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
  const { customer, type, items, total, address } = data;
  
  if (!customer || typeof customer !== 'string' || customer.trim().length < 2) {
    throw new ValidationError('Contact client invalide');
  }
  
  if (!type || typeof type !== 'string') {
    throw new ValidationError('Type de livraison invalide');
  }
  
  if (!address || typeof address !== 'string' || address.trim().length < 5) {
    throw new ValidationError('Adresse de livraison invalide');
  }
  
  if (address.length > 200) {
    throw new ValidationError('Adresse trop longue (max 200 caractères)');
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

// ==================== CLIENT TELEGRAM REGISTRATION ====================

async function registerTelegramClient(message) {
  const telegramId = message.chat.id.toString();
  const firstName = message.from.first_name || 'Client';
  const username = message.from.username || null;
  
  try {
    await db.run(`
      INSERT INTO telegram_clients (telegram_id, first_name, username, last_seen)
      VALUES (?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(telegram_id) DO UPDATE SET
        first_name = excluded.first_name,
        username = excluded.username,
        last_seen = CURRENT_TIMESTAMP
    `, [telegramId, firstName, username]);
    
    console.log(`✅ Telegram client registered: ${telegramId} (${firstName})`);
    return true;
  } catch (error) {
    console.error('Error registering telegram client:', error);
    return false;
  }
}

async function linkTelegramToContact(telegramId, contact) {
  try {
    await db.run(`
      UPDATE telegram_clients SET contact = ? WHERE telegram_id = ?
    `, [contact, telegramId]);
    
    console.log(`🔗 Linked Telegram ${telegramId} to contact ${contact}`);
    return true;
  } catch (error) {
    console.error('Error linking telegram to contact:', error);
    return false;
  }
}

async function getClientTelegramId(contact) {
  const result = await db.get(
    'SELECT telegram_id FROM telegram_clients WHERE contact = ?',
    [contact]
  );
  return result?.telegram_id || null;
}

async function getClientContact(telegramId) {
  const result = await db.get(
    'SELECT contact FROM telegram_clients WHERE telegram_id = ?',
    [telegramId]
  );
  return result?.contact || null;
}

// ==================== BIDIRECTIONAL MESSAGING ====================

async function saveMessage(orderId, senderType, senderId, message) {
  try {
    await db.run(`
      INSERT INTO chat_messages (order_id, sender_type, sender_id, message)
      VALUES (?, ?, ?, ?)
    `, [orderId, senderType, senderId, message]);
    
    await chatManager.incrementMessageCount(orderId);
  } catch (error) {
    console.error('Error saving message:', error);
  }
}

async function relayDriverMessage(driverChatId, text, conv) {
  console.log(`📤 Driver → Client (order #${conv.orderId}): "${text}"`);
  
  await saveMessage(conv.orderId, 'driver', driverChatId.toString(), text);
  
  const clientMsg = `🚚 <b>Votre livreur</b> (Commande #${conv.orderId})

💬 ${text}

<i>Répondez directement pour lui parler</i>`;
  
  const clientKeyboard = {
    inline_keyboard: [
      [{ text: '✍️ Répondre (tapez votre message)', callback_data: 'noop' }],
      [{ text: '❌ Fermer conversation', callback_data: `end_conv_${conv.orderId}` }]
    ]
  };
  
  try {
    await telegram.sendMessage(conv.clientTelegramId, clientMsg, { 
      reply_markup: clientKeyboard 
    });
    
    await chatManager.activateClient(conv.orderId);
    
    await telegram.sendMessage(driverChatId, `✅ Message envoyé

"${text}"

⏳ <i>En attente de réponse du client...</i>`);
    
    if (config.telegram.supportChatId) {
      await telegram.sendMessage(config.telegram.supportChatId, 
        `📨 Driver → Client (#${conv.orderId})\n💬 "${text}"`
      );
    }
  } catch (error) {
    console.error('Error relaying driver message:', error);
    
    await telegram.sendMessage(driverChatId, 
      '⚠️ Erreur temporaire. Le support va transmettre votre message.'
    );
    
    if (config.telegram.supportChatId) {
      const order = await db.get('SELECT customer FROM orders WHERE id = ?', [conv.orderId]);
      await telegram.sendMessage(config.telegram.supportChatId, 
        `🚨 URGENT - Erreur de transmission
        
Commande #${conv.orderId}
Client: ${order?.customer}
Message du livreur: "${text}"

Transmettez manuellement au client.`
      );
    }
  }
}

async function relayClientMessage(clientChatId, text, conv) {
  console.log(`📤 Client → Driver (order #${conv.orderId}): "${text}"`);
  
  await saveMessage(conv.orderId, 'client', clientChatId.toString(), text);
  
  const driverMsg = `👤 <b>Message du client</b> (Commande #${conv.orderId})

💬 ${text}

<i>Tapez votre réponse ci-dessous</i>`;
  
  try {
    await telegram.sendMessage(conv.driverId, driverMsg);
    
    await telegram.sendMessage(clientChatId, `✅ Message envoyé au livreur

"${text}"

🚚 <i>Le livreur va vous répondre...</i>`);
    
    if (config.telegram.supportChatId) {
      await telegram.sendMessage(config.telegram.supportChatId, 
        `📨 Client → Driver (#${conv.orderId})\n💬 "${text}"`
      );
    }
  } catch (error) {
    console.error('Error relaying client message:', error);
    
    await telegram.sendMessage(clientChatId, 
      '⚠️ Erreur temporaire. Nous allons transmettre votre message.'
    );
    
    if (config.telegram.supportChatId) {
      await telegram.sendMessage(config.telegram.supportChatId, 
        `🚨 URGENT - Erreur transmission client
        
Commande #${conv.orderId}
Message: "${text}"

Transmettez au livreur.`
      );
    }
  }
}

async function stopConversationForOrder(chatId, orderId) {
  const conv = chatManager.getConversation(orderId);
  
  if (!conv) {
    await telegram.sendMessage(chatId, 'ℹ️ Conversation déjà fermée');
    return;
  }
  
  const isDriver = conv.driverId === chatId.toString();
  const isClient = conv.clientTelegramId === chatId.toString();
  
  if (isDriver) {
    await chatManager.deactivateDriver(orderId);
    await telegram.sendMessage(chatId, '✅ Conversation fermée');
    
    try {
      await telegram.sendMessage(conv.clientTelegramId, 
        `⚠️ Le livreur a fermé la conversation (Commande #${orderId})`
      );
    } catch (e) {}
  }
  
  if (isClient) {
    await chatManager.deactivateClient(orderId);
    await telegram.sendMessage(chatId, '✅ Conversation fermée');
    
    try {
      await telegram.sendMessage(conv.driverId, 
        `⚠️ Le client a fermé la conversation (Commande #${orderId})`
      );
    } catch (e) {}
  }
}

async function showChatHistory(chatId, orderId) {
  const messages = await db.all(
    `SELECT * FROM chat_messages 
     WHERE order_id = ? 
     ORDER BY created_at ASC 
     LIMIT 50`,
    [orderId]
  );
  
  if (messages.length === 0) {
    await telegram.sendMessage(chatId, 'ℹ️ Aucun message dans l\'historique');
    return;
  }
  
  let history = `📜 <b>HISTORIQUE CONVERSATION #${orderId}</b>\n`;
  history += `Total: ${messages.length} message(s)\n`;
  history += `━━━━━━━━━━━━━━━━━━━\n\n`;
  
  for (const msg of messages) {
    const emoji = msg.sender_type === 'driver' ? '🚚' : '👤';
    const time = new Date(msg.created_at).toLocaleTimeString('fr-FR', { 
      hour: '2-digit', 
      minute: '2-digit' 
    });
    
    history += `${emoji} <b>${msg.sender_type === 'driver' ? 'Livreur' : 'Client'}</b> [${time}]\n`;
    history += `💬 ${msg.message}\n\n`;
  }
  
  await telegram.sendMessage(chatId, history);
}

async function stopUserConversations(chatId) {
  let closed = 0;
  
  for (const [orderId, conv] of chatManager.activeConversations.entries()) {
    if (conv.driverId === chatId.toString()) {
      await chatManager.deactivateDriver(orderId);
      closed++;
      
      try {
        await telegram.sendMessage(conv.clientTelegramId, 
          `⚠️ Le livreur a fermé la conversation pour la commande #${orderId}`
        );
      } catch (e) {}
    }
    
    if (conv.clientTelegramId === chatId.toString()) {
      await chatManager.deactivateClient(orderId);
      closed++;
      
      try {
        await telegram.sendMessage(conv.driverId, 
          `⚠️ Le client a fermé la conversation pour la commande #${orderId}`
        );
      } catch (e) {}
    }
  }
  
  if (closed > 0) {
    await telegram.sendMessage(chatId, 
      `✅ ${closed} conversation(s) fermée(s)`
    );
  } else {
    await telegram.sendMessage(chatId, 
      'ℹ️ Aucune conversation active'
    );
  }
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

  async setWebhook(url) {
    if (!this.token) return null;

    try {
      const response = await axios.post(`${this.baseUrl}/setWebhook`, {
        url,
        allowed_updates: ['message', 'callback_query']
      }, { timeout: 10000 });

      if (response.data?.ok) {
        console.log(`✅ Webhook enregistré: ${url}`);
        return true;
      } else {
        console.error('❌ Webhook registration failed:', response.data);
        return false;
      }
    } catch (error) {
      console.error('❌ Set webhook error:', error.message);
      return false;
    }
  }

  async setMyCommands(commands) {
    if (!this.token) return null;
    try {
      const response = await axios.post(`${this.baseUrl}/setMyCommands`, {
        commands
      }, { timeout: 5000 });
      return response.data?.ok;
    } catch (error) {
      console.error('❌ Set commands error:', error.message);
      return false;
    }
  }

  async getWebhookInfo() {
    if (!this.token) return null;

    try {
      const response = await axios.get(`${this.baseUrl}/getWebhookInfo`, { timeout: 5000 });
      return response.data?.result;
    } catch (error) {
      console.error('❌ Get webhook info error:', error.message);
      return null;
    }
  }

  async sendPhoto(chatId, photo, caption = '', options = {}) {
    if (!this.token || !chatId) return null;

    try {
      const response = await axios.post(`${this.baseUrl}/sendPhoto`, {
        chat_id: chatId,
        photo,
        caption,
        parse_mode: 'HTML',
        ...options
      }, { timeout: 15000 });

      console.log(`✅ Photo sent to ${chatId}`);
      return response.data;
    } catch (error) {
      console.error(`❌ Send photo error (${chatId}):`, error.message);
      return null;
    }
  }

  async deleteMessage(chatId, messageId) {
    if (!this.token || !chatId || !messageId) return false;

    try {
      const response = await axios.post(`${this.baseUrl}/deleteMessage`, {
        chat_id: chatId,
        message_id: messageId
      }, { timeout: 5000 });

      console.log(`✅ Message ${messageId} deleted from ${chatId}`);
      return response.data?.ok || false;
    } catch (error) {
      console.error(`❌ Delete message error (${chatId}/${messageId}):`, error.message);
      return false;
    }
  }

  async forwardMessage(chatId, fromChatId, messageId) {
    if (!this.token || !chatId) return null;

    try {
      const response = await axios.post(`${this.baseUrl}/forwardMessage`, {
        chat_id: chatId,
        from_chat_id: fromChatId,
        message_id: messageId
      }, { timeout: 10000 });

      console.log(`✅ Message forwarded to ${chatId}`);
      return response.data;
    } catch (error) {
      console.error(`❌ Forward message error:`, error.message);
      return null;
    }
  }

  async pinChatMessage(chatId, messageId, disableNotification = false) {
    if (!this.token || !chatId || !messageId) return false;

    try {
      const response = await axios.post(`${this.baseUrl}/pinChatMessage`, {
        chat_id: chatId,
        message_id: messageId,
        disable_notification: disableNotification
      }, { timeout: 5000 });

      console.log(`📌 Message ${messageId} pinned in ${chatId}`);
      return response.data?.ok || false;
    } catch (error) {
      console.error(`❌ Pin message error (${chatId}/${messageId}):`, error.message);
      return false;
    }
  }

  async unpinChatMessage(chatId, messageId) {
    if (!this.token || !chatId || !messageId) return false;

    try {
      const response = await axios.post(`${this.baseUrl}/unpinChatMessage`, {
        chat_id: chatId,
        message_id: messageId
      }, { timeout: 5000 });

      console.log(`📌 Message ${messageId} unpinned from ${chatId}`);
      return response.data?.ok || false;
    } catch (error) {
      console.error(`❌ Unpin message error (${chatId}/${messageId}):`, error.message);
      return false;
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
  // INSERT OR IGNORE atomique pour éviter la race condition entre SELECT et INSERT
  await db.run(
    'INSERT OR IGNORE INTO customers (contact, status) VALUES (?, ?)',
    [contact, 'pending']
  );

  const customer = await db.get(
    'SELECT * FROM customers WHERE contact = ?',
    [contact]
  );

  if (customer && customer.created_at === customer.first_order_date) {
    console.log(`🆕 New customer registered: ${contact} (ID: ${customer.id})`);
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
  await db.run('BEGIN IMMEDIATE');
  try {
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
    await db.run('COMMIT');
  } catch (err) {
    await db.run('ROLLBACK');
    throw err;
  }
}

async function restoreStockForOrder(items, orderId) {
  await db.run('BEGIN IMMEDIATE');
  try {
    for (const item of items) {
      await db.run(
        'UPDATE stock SET qty = qty + ? WHERE product_id = ? AND variant = ?',
        [item.qty, item.product_id, item.variant]
      );

      const stockAfter = await db.get(
        'SELECT qty FROM stock WHERE product_id = ? AND variant = ?',
        [item.product_id, item.variant]
      );

      await db.run(
        `INSERT INTO stock_movements (product_id, variant, type, quantity, stock_after, reason)
         VALUES (?, ?, 'in', ?, ?, ?)`,
        [item.product_id, item.variant, item.qty, stockAfter?.qty || 0, `Annulation commande #${orderId}`]
      );
    }
    await db.run('COMMIT');
  } catch (err) {
    await db.run('ROLLBACK');
    throw err;
  }
}

// ==================== REFERRAL SYSTEM ====================
async function generateReferralCode(customer, orderId) {
  // Générer code unique basé sur le nom du client et l'ID de commande
  const cleanCustomer = customer.toUpperCase().replace(/[^A-Z0-9]/g, '').substring(0, 6);
  const code = `${cleanCustomer}${orderId}`;
  return code;
}

async function getOrCreateReferralCode(customer, orderId) {
  // INSERT OR IGNORE atomique pour éviter les doublons en cas de requêtes concurrentes
  const code = await generateReferralCode(customer, orderId);
  await db.run(
    'INSERT OR IGNORE INTO referrals (referral_code, customer_contact) VALUES (?, ?)',
    [code, customer]
  );

  const referral = await db.get(
    'SELECT * FROM referrals WHERE customer_contact = ?',
    [customer]
  );

  return referral;
}

async function validateReferralCode(code) {
  if (!code || code.length === 0) {
    return null;
  }

  const referral = await db.get(
    'SELECT * FROM referrals WHERE referral_code = ?',
    [code]
  );

  return referral;
}

async function applyReferralCredits(referrerCode, newCustomer, orderId) {
  const referrer = await db.get(
    'SELECT * FROM referrals WHERE referral_code = ?',
    [referrerCode]
  );

  if (!referrer) {
    console.log(`⚠️ Referral code not found: ${referrerCode}`);
    return { referrerCredit: 0, referredCredit: 0 };
  }

  if (referrer.customer_contact === newCustomer) {
    console.log(`⚠️ Self-referral attempt blocked: ${newCustomer}`);
    return { referrerCredit: 0, referredCredit: 0 };
  }

  const REFERRER_CREDIT = 500;
  const REFERRED_CREDIT = 300;

  // Transaction IMMEDIATE pour empêcher les doublons de parrainage en cas de requêtes concurrentes
  await db.run('BEGIN IMMEDIATE');
  try {
    // Re-vérifier dans la transaction (un autre client concurrent a pu insérer entre-temps)
    const existingReferral = await db.get(
      'SELECT * FROM referral_history WHERE referred_contact = ?',
      [newCustomer]
    );

    if (existingReferral) {
      await db.run('COMMIT');
      console.log(`⚠️ Customer already referred: ${newCustomer}`);
      return { referrerCredit: 0, referredCredit: 0 };
    }

    const totalReferrals = referrer.total_referrals || 0;
    let vipBonus = 0;
    let vipTier = 'Bronze';

    if (totalReferrals >= 10) {
      vipBonus = 0.5;
      vipTier = 'Diamant 💎';
    } else if (totalReferrals >= 6) {
      vipBonus = 0.2;
      vipTier = 'Or 🥇';
    } else if (totalReferrals >= 3) {
      vipBonus = 0.1;
      vipTier = 'Argent 🥈';
    } else {
      vipBonus = 0;
      vipTier = 'Bronze 🥉';
    }

    const bonusAmount = Math.floor(REFERRER_CREDIT * vipBonus);
    const totalReferrerCredit = REFERRER_CREDIT + bonusAmount;

    console.log(`👑 VIP Tier: ${vipTier} - Bonus: ${vipBonus * 100}% (+${bonusAmount} DA)`);

    // Créditer le parrain avec bonus VIP
    await db.run(
      `UPDATE referrals
       SET credit_balance = credit_balance + ?,
           total_referrals = total_referrals + 1,
           total_earned = total_earned + ?
       WHERE referral_code = ?`,
      [totalReferrerCredit, totalReferrerCredit, referrerCode]
    );

    // Créer le code de parrainage pour le nouveau client
    const code = await generateReferralCode(newCustomer, orderId);
    await db.run(
      'INSERT OR IGNORE INTO referrals (referral_code, customer_contact) VALUES (?, ?)',
      [code, newCustomer]
    );

    // Créditer le filleul
    await db.run(
      `UPDATE referrals
       SET credit_balance = credit_balance + ?
       WHERE customer_contact = ?`,
      [REFERRED_CREDIT, newCustomer]
    );

    // Enregistrer dans l'historique
    await db.run(
      `INSERT INTO referral_history
       (referrer_code, referrer_contact, referred_contact, order_id, referrer_credit, referred_credit, status)
       VALUES (?, ?, ?, ?, ?, ?, 'completed')`,
      [referrerCode, referrer.customer_contact, newCustomer, orderId, REFERRER_CREDIT, REFERRED_CREDIT]
    );

    await db.run('COMMIT');

    console.log(`✅ Referral applied: ${referrer.customer_contact} → ${newCustomer} (${totalReferrerCredit} DA + ${REFERRED_CREDIT} DA)`);

    // Notification de montée de palier (hors transaction)
    const newTotalReferrals = totalReferrals + 1;
    let tierUpgrade = false;
    let newTier = '';

    if (newTotalReferrals === 3) {
      tierUpgrade = true;
      newTier = 'Argent 🥈';
    } else if (newTotalReferrals === 6) {
      tierUpgrade = true;
      newTier = 'Or 🥇';
    } else if (newTotalReferrals === 10) {
      tierUpgrade = true;
      newTier = 'Diamant 💎';
    }

    if (tierUpgrade) {
      await notifyVIPTierUpgrade(referrer.customer_contact, newTier, newTotalReferrals).catch(err =>
        console.error('VIP tier notification error:', err.message)
      );
    }

    return {
      referrerCredit: totalReferrerCredit,
      referredCredit: REFERRED_CREDIT,
      referrerContact: referrer.customer_contact,
      vipTier,
      vipBonus: vipBonus * 100,
      bonusAmount
    };
  } catch (err) {
    await db.run('ROLLBACK');
    throw err;
  }
}

async function getReferralStats(customer) {
  const referral = await db.get(
    'SELECT * FROM referrals WHERE customer_contact = ?',
    [customer]
  );

  if (!referral) {
    return null;
  }

  const history = await db.all(
    `SELECT * FROM referral_history
     WHERE referrer_contact = ?
     ORDER BY created_at DESC`,
    [customer]
  );

  return {
    code: referral.referral_code,
    creditBalance: referral.credit_balance,
    totalReferrals: referral.total_referrals,
    totalEarned: referral.total_earned,
    history
  };
}

// ==================== NOTIFICATION SYSTEM ====================
async function notifyReferralSuccess(referrerContact, newCustomerContact, creditAmount, orderId, vipInfo = {}) {
  // Essayer de trouver l'ID Telegram du parrain
  const referrerTelegramId = await getClientTelegramId(referrerContact);

  if (referrerTelegramId && config.telegram.botToken) {
    let vipMessage = '';
    if (vipInfo.vipTier && vipInfo.bonusAmount > 0) {
      vipMessage = `\n👑 <b>BONUS VIP ${vipInfo.vipTier}:</b> +${vipInfo.bonusAmount} DA (${vipInfo.vipBonus}%)\n`;
    } else if (vipInfo.vipTier) {
      vipMessage = `\n🥉 <b>Palier actuel:</b> ${vipInfo.vipTier}\n`;
    }

    const message = `🎉 <b>FÉLICITATIONS ! PARRAINAGE RÉUSSI !</b>

💰 <b>+${creditAmount} DA ajoutés à votre crédit !</b>${vipMessage}
👤 <b>Nouveau client parrainé:</b> ${newCustomerContact}
📦 <b>Commande:</b> #${orderId}

💳 <b>Votre crédit est disponible immédiatement</b>
Utilisez-le lors de votre prochaine commande !

🚀 Continuez à partager votre code et gagnez encore plus !`;

    try {
      await telegram.sendMessage(referrerTelegramId, message);
      console.log(`✅ Referral notification sent to ${referrerContact}`);
    } catch (error) {
      console.error(`❌ Failed to send referral notification to ${referrerContact}:`, error.message);
    }
  }

  // Notification admin optionnelle
  if (getAdminChatIds().length > 0) {
    const adminMessage = `💰 <b>PARRAINAGE RÉUSSI</b>

👤 Parrain: ${referrerContact} → +${creditAmount} DA
🆕 Filleul: ${newCustomerContact}
📦 Commande: #${orderId}`;

    await notifyAdmins(adminMessage);
  }
}

async function notifyVIPTierUpgrade(referrerContact, newTier, totalReferrals) {
  // Essayer de trouver l'ID Telegram du parrain
  const referrerTelegramId = await getClientTelegramId(referrerContact);

  if (referrerTelegramId && config.telegram.botToken) {
    let bonusPercent = 0;
    let nextTierText = '';

    if (newTier === 'Argent 🥈') {
      bonusPercent = 10;
      nextTierText = '\n\n🎯 <b>Prochain palier :</b> Or 🥇 (6 parrainages)';
    } else if (newTier === 'Or 🥇') {
      bonusPercent = 20;
      nextTierText = '\n\n🎯 <b>Prochain palier :</b> Diamant 💎 (10 parrainages)';
    } else if (newTier === 'Diamant 💎') {
      bonusPercent = 50;
      nextTierText = '\n\n🏆 <b>PALIER MAXIMUM ATTEINT !</b>';
    }

    const message = `👑 <b>NOUVEAU PALIER VIP DÉBLOQUÉ !</b>

🎊 <b>Félicitations ${referrerContact} !</b>

Vous venez de passer au palier <b>${newTier}</b> !

⚡ <b>Nouveau bonus :</b> +${bonusPercent}%
💰 <b>Vous gagnez maintenant ${Math.floor(500 * (1 + bonusPercent/100))} DA</b> par parrainage
📊 <b>Parrainages réussis :</b> ${totalReferrals}${nextTierText}

🚀 Continuez à partager votre code et maximisez vos gains !

Tapez /parrainage pour voir votre progression complète 📈`;

    try {
      await telegram.sendMessage(referrerTelegramId, message);
      console.log(`✅ VIP tier upgrade notification sent to ${referrerContact}`);
    } catch (error) {
      console.error(`❌ Failed to send VIP tier notification to ${referrerContact}:`, error.message);
    }
  }

  // Notification admin
  if (getAdminChatIds().length > 0) {
    const adminMessage = `👑 <b>MONTÉE DE PALIER VIP</b>

👤 Client: ${referrerContact}
🎯 Nouveau palier: ${newTier}
📊 Total parrainages: ${totalReferrals}`;

    await notifyAdmins(adminMessage);
  }
}

async function notifyNewCustomerOrder(order, items, customerRecord) {
  if (getAdminChatIds().length > 0) {
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

    await notifyAdmins(message, { reply_markup: keyboard });
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
🏠 Adresse: ${order.address || 'Sur place'}
💰 Total: ${order.total}€
📦 Articles: ${items.length} produit(s)

⚡ Contacter le client si besoin`;
    
    await telegram.sendMessage(config.telegram.supportChatId, supportMessage);
  }
  
  if (getAdminChatIds().length > 0) {
    // Récupérer les infos client complètes
    const customerInfo = await db.get('SELECT * FROM customers WHERE contact = ?', [order.customer]);
    const telegramInfo = await db.get('SELECT * FROM telegram_clients WHERE contact = ?', [order.customer]);

    let adminMessage = `📦 <b>COMMANDE #${order.id}</b>

👤 <b>Client: ${order.customer}</b>`;

    if (telegramInfo) {
      adminMessage += `\n📱 Telegram: @${telegramInfo.username || telegramInfo.telegram_id}`;
      adminMessage += `\n✅ Compte Telegram: Vérifié`;
    } else {
      adminMessage += `\n⚠️ Compte Telegram: Non lié`;
    }

    if (customerInfo) {
      const statusEmoji = {
        'pending': '⏳',
        'approved': '✅',
        'blocked': '🚫'
      };
      adminMessage += `\n${statusEmoji[customerInfo.status] || '❓'} Statut: ${customerInfo.status.toUpperCase()}`;

      const totalOrders = await db.get(
        'SELECT COUNT(*) as count FROM orders WHERE customer = ? AND status = "delivered"',
        [order.customer]
      );
      adminMessage += `\n📊 Commandes livrées: ${totalOrders?.count || 0}`;
    }

    adminMessage += `\n\n📍 Type: ${order.type}
🏠 Adresse: ${order.address || 'Sur place'}

📦 Articles:
${items.map(item => `• ${item.name} - ${item.variant} ×${item.qty} = ${item.lineTotal}€`).join('\n')}

${order.discount > 0 ? `🎁 Remise fidélité: -${order.discount}€\n` : ''}💰 TOTAL: ${order.total}€

🚚 <b>Assigné à:</b> ${driverInfo.driverName}
🌍 <b>Zone:</b> ${driverInfo.zone.toUpperCase()}

⏰ ${new Date(order.created_at).toLocaleString('fr-FR')}`;

    await notifyAdmins(adminMessage);
  }
  
  // ==================== NOTIFICATIONS LIVREUR DÉSACTIVÉES ====================
  // Le livreur doit recevoir les commandes UNIQUEMENT via le bot (bot.js)
  // Les notifications directes sont désactivées ci-dessous

  if (driverInfo.driverId) {
    // ⚠️ NOTIFICATION DIRECTE DÉSACTIVÉE - Le livreur reçoit via bot.js uniquement
    /*
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

    // Créer la conversation (sans l'activer encore)
    const clientTelegramId = order.client_telegram_id || await getClientTelegramId(order.customer);
    if (clientTelegramId) {
      chatManager.createConversation(order.id, driverInfo.driverId, clientTelegramId);
    }
    */

    // Mise à jour de la zone du livreur (conservée)
    await db.run(
      'UPDATE orders SET assigned_driver_zone = ? WHERE id = ?',
      [driverInfo.zone, order.id]
    );

    console.log(`📦 Commande #${order.id} assignée à ${driverInfo.driverName} (${driverInfo.zone})`);
    console.log(`ℹ️  Le livreur recevra la notification via le bot uniquement`);
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

// ==================== NOUVEAU : API PRODUITS ====================
app.get('/api/products', apiLimiter, async (req, res) => {
  try {
    const productsData = await db.get(
      "SELECT value FROM settings WHERE key = 'products'"
    );
    
    const products = productsData?.value ? JSON.parse(productsData.value) : [];
    
    res.json({ ok: true, products });
  } catch (error) {
    console.error('Products error:', error);
    res.status(500).json({ ok: false, error: 'Erreur serveur' });
  }
});

// ==================== NOUVEAU : VÉRIFICATION STOCK ====================
app.get('/api/stock/:productId/:variant', apiLimiter, async (req, res) => {
  try {
    const { productId, variant } = req.params;
    
    const stock = await db.get(
      'SELECT qty FROM stock WHERE product_id = ? AND variant = ?',
      [productId, decodeURIComponent(variant)]
    );
    
    res.json({ 
      ok: true, 
      stock: stock?.qty || 0,
      available: (stock?.qty || 0) > 0
    });
  } catch (error) {
    console.error('Stock check error:', error);
    res.status(500).json({ ok: false, error: 'Erreur serveur' });
  }
});

// ==================== NOUVEAU : ANNULATION COMMANDE ====================
app.post('/api/cancel-order', apiLimiter, async (req, res) => {
  try {
    const { orderId, reason } = req.body;

    if (!orderId) {
      return res.status(400).json({ ok: false, error: 'ID commande manquant' });
    }

    const order = await db.get('SELECT * FROM orders WHERE id = ?', [orderId]);

    if (!order) {
      return res.status(404).json({ ok: false, error: 'Commande introuvable' });
    }

    if (order.status === 'cancelled') {
      return res.status(400).json({ ok: false, error: 'Commande déjà annulée' });
    }

    if (order.status === 'delivered') {
      return res.status(400).json({ ok: false, error: 'Impossible d\'annuler une commande livrée' });
    }

    // Vérifier la limite de 30 minutes
    const orderCreatedAt = new Date(order.created_at);
    const now = new Date();
    const timeDiffMinutes = (now - orderCreatedAt) / (1000 * 60);

    if (timeDiffMinutes > 30) {
      return res.status(400).json({
        ok: false,
        error: 'Délai d\'annulation dépassé (30 minutes maximum)',
        timeElapsed: Math.floor(timeDiffMinutes)
      });
    }

    // Restaurer les stocks
    const items = JSON.parse(order.items);
    await restoreStockForOrder(items, orderId);

    // Supprimer la transaction
    await db.run(
      'DELETE FROM transactions WHERE description = ?',
      [`Commande #${orderId}`]
    );

    // Marquer comme annulée
    await db.run(
      'UPDATE orders SET status = ?, cancel_reason = ?, cancelled_at = CURRENT_TIMESTAMP WHERE id = ?',
      ['cancelled', reason || 'Annulée par le client', orderId]
    );

    // Fermer les conversations liées
    chatManager.closeConversation(parseInt(orderId));

    console.log(`✅ Order #${orderId} cancelled. Stocks restored.`);

    res.json({
      ok: true,
      message: 'Commande annulée et stocks restaurés',
      orderAmount: order.total
    });
  } catch (error) {
    console.error('Cancel order error:', error);
    res.status(500).json({ ok: false, error: 'Erreur serveur' });
  }
});

// ==================== ANNULATION PARTIELLE ====================
app.post('/api/cancel-order-items', apiLimiter, async (req, res) => {
  try {
    const { orderId, itemsToCancel, reason } = req.body;

    if (!orderId || !itemsToCancel || !Array.isArray(itemsToCancel) || itemsToCancel.length === 0) {
      return res.status(400).json({ ok: false, error: 'Données invalides' });
    }

    const order = await db.get('SELECT * FROM orders WHERE id = ?', [orderId]);

    if (!order) {
      return res.status(404).json({ ok: false, error: 'Commande introuvable' });
    }

    if (order.status === 'cancelled') {
      return res.status(400).json({ ok: false, error: 'Commande déjà annulée' });
    }

    if (order.status === 'delivered') {
      return res.status(400).json({ ok: false, error: 'Impossible d\'annuler une commande livrée' });
    }

    // Vérifier la limite de 30 minutes
    const orderCreatedAt = new Date(order.created_at);
    const now = new Date();
    const timeDiffMinutes = (now - orderCreatedAt) / (1000 * 60);

    if (timeDiffMinutes > 30) {
      return res.status(400).json({
        ok: false,
        error: 'Délai d\'annulation dépassé (30 minutes maximum)',
        timeElapsed: Math.floor(timeDiffMinutes)
      });
    }

    const allItems = JSON.parse(order.items);

    // Vérifier que tous les articles à annuler existent dans la commande
    const itemsToRemove = [];
    let amountToRefund = 0;

    for (const cancelItem of itemsToCancel) {
      const foundItem = allItems.find(item =>
        item.product_id === cancelItem.product_id &&
        item.variant === cancelItem.variant
      );

      if (!foundItem) {
        return res.status(400).json({
          ok: false,
          error: `Article introuvable: ${cancelItem.product_id} - ${cancelItem.variant}`
        });
      }

      if (cancelItem.qty > foundItem.qty) {
        return res.status(400).json({
          ok: false,
          error: `Quantité invalide pour ${cancelItem.product_id}`
        });
      }

      itemsToRemove.push({
        ...foundItem,
        qty: cancelItem.qty
      });

      // Calculer le montant à rembourser
      amountToRefund += foundItem.price * cancelItem.qty;
    }

    // Restaurer le stock pour les articles annulés
    await restoreStockForOrder(itemsToRemove, orderId);

    // Mettre à jour la commande
    const remainingItems = [];
    for (const item of allItems) {
      const cancelItem = itemsToCancel.find(ci =>
        ci.product_id === item.product_id && ci.variant === item.variant
      );

      if (cancelItem) {
        const remainingQty = item.qty - cancelItem.qty;
        if (remainingQty > 0) {
          remainingItems.push({
            ...item,
            qty: remainingQty
          });
        }
      } else {
        remainingItems.push(item);
      }
    }

    // Si tous les articles sont annulés, annuler complètement la commande
    if (remainingItems.length === 0) {
      await db.run(
        'DELETE FROM transactions WHERE description = ?',
        [`Commande #${orderId}`]
      );

      await db.run(
        'UPDATE orders SET status = ?, cancel_reason = ?, cancelled_at = CURRENT_TIMESTAMP WHERE id = ?',
        ['cancelled', reason || 'Annulation totale des articles', orderId]
      );

      chatManager.closeConversation(parseInt(orderId));

      console.log(`✅ Order #${orderId} fully cancelled (all items removed)`);

      return res.json({
        ok: true,
        message: 'Tous les articles annulés - Commande complètement annulée',
        fullyCancelled: true,
        refundAmount: amountToRefund
      });
    }

    // Recalculer le total de la commande
    let newTotal = 0;
    for (const item of remainingItems) {
      newTotal += item.price * item.qty;
    }

    // Appliquer la réduction si elle existe
    if (order.discount > 0) {
      newTotal = newTotal * (1 - order.discount / 100);
    }

    // Mettre à jour la commande avec les articles restants
    await db.run(
      'UPDATE orders SET items = ?, total = ? WHERE id = ?',
      [JSON.stringify(remainingItems), newTotal, orderId]
    );

    // Mettre à jour la transaction
    await db.run(
      'UPDATE transactions SET amount = ? WHERE description = ?',
      [newTotal, `Commande #${orderId}`]
    );

    console.log(`✅ Order #${orderId} partially cancelled. ${itemsToRemove.length} item(s) removed.`);

    res.json({
      ok: true,
      message: 'Articles annulés avec succès',
      fullyCancelled: false,
      refundAmount: amountToRefund,
      newTotal: newTotal,
      remainingItems: remainingItems.length
    });
  } catch (error) {
    console.error('Partial cancel error:', error);
    res.status(500).json({ ok: false, error: 'Erreur serveur' });
  }
});

app.post('/api/create-order', apiLimiter, async (req, res) => {
  try {
    console.log('📨 New order received');

    validateOrderInput(req.body);

    const { customer, type, address, items, total, referralCode, useCredit, telegramId } = req.body;
    
    const sanitizedCustomer = sanitizeString(customer, 100);
    const sanitizedType = sanitizeString(type, 50);
    const sanitizedAddress = sanitizeString(address, 200);

    // ✅ VÉRIFICATION DE STOCK TEMPORAIREMENT DÉSACTIVÉE
    // TODO: Initialiser le stock en base de données
    /*
    for (const item of items) {
      const stock = await db.get(
        'SELECT qty FROM stock WHERE product_id = ? AND variant = ?',
        [item.product_id, item.variant]
      );

      const available = stock?.qty || 0;

      if (available < item.qty) {
        return res.status(400).json({
          ok: false,
          error: `Stock insuffisant pour ${item.name} ${item.variant} (${available} disponible${available > 1 ? 's' : ''})`,
          stockError: true,
          product: item.name,
          variant: item.variant,
          available: available,
          requested: item.qty
        });
      }
    }
    */
    
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

    // ==================== AUTO-APPROBATION DES CLIENTS EXISTANTS ====================
    // Si le client a déjà des commandes livrées, l'approuver automatiquement
    if (customerRecord.status === 'pending') {
      const previousOrders = await db.get(
        'SELECT COUNT(*) as count FROM orders WHERE customer = ? AND status = "delivered"',
        [sanitizedCustomer]
      );

      if (previousOrders && previousOrders.count > 0) {
        // Client avec historique de commandes livrées → auto-approuver
        await db.run(
          'UPDATE customers SET status = ?, approved_date = CURRENT_TIMESTAMP, approved_by = ? WHERE contact = ?',
          ['approved', 'Auto (commandes existantes)', sanitizedCustomer]
        );
        customerRecord.status = 'approved';
        console.log(`✅ Auto-approved existing customer: ${sanitizedCustomer} (${previousOrders.count} delivered orders)`);
      }
    }

    const isNewCustomer = customerRecord.status === 'pending';
    const isApproved = customerRecord.status === 'approved';

    let discount = 0;
    if (isApproved) {
      const loyaltyResult = await calculateLoyaltyDiscount(sanitizedCustomer, total);
      discount = loyaltyResult.discount;
    }

    // ==================== UTILISATION DU CRÉDIT ====================
    let creditUsed = 0;
    let remainingCredit = 0;

    if (useCredit === true || useCredit === 'true') {
      const totalAfterDiscount = total - discount;

      // Transaction IMMEDIATE pour verrouiller la lecture+écriture du crédit
      // Empêche le double-spending si 2 commandes arrivent en même temps
      await db.run('BEGIN IMMEDIATE');
      try {
        const customerReferralCheck = await db.get(
          'SELECT credit_balance FROM referrals WHERE customer_contact = ?',
          [sanitizedCustomer]
        );

        if (customerReferralCheck && customerReferralCheck.credit_balance > 0) {
          const availableCredit = customerReferralCheck.credit_balance;
          creditUsed = Math.min(availableCredit, totalAfterDiscount);
          remainingCredit = availableCredit - creditUsed;

          await db.run(
            'UPDATE referrals SET credit_balance = ? WHERE customer_contact = ?',
            [remainingCredit, sanitizedCustomer]
          );
        }
        await db.run('COMMIT');
      } catch (creditErr) {
        await db.run('ROLLBACK');
        throw creditErr;
      }

      if (creditUsed > 0) {
        console.log(`💳 Credit used: ${creditUsed} DA (remaining: ${remainingCredit} DA)`);
      }
    }

    const finalTotal = total - discount - creditUsed;
    const orderStatus = isNewCustomer ? 'pending_approval' : 'pending';

    // Si un telegram_id a été fourni, lier ce telegram_id au contact du client
    if (telegramId) {
      try {
        await db.run(`
          INSERT INTO telegram_clients (telegram_id, contact)
          VALUES (?, ?)
          ON CONFLICT(telegram_id) DO UPDATE SET
            contact = excluded.contact
        `, [telegramId, sanitizedCustomer]);
        console.log(`🔗 Linked Telegram ID ${telegramId} to contact ${sanitizedCustomer}`);
      } catch (error) {
        console.error('Error linking telegram_id to contact:', error);
      }
    }

    // Récupérer l'ID Telegram du client s'il existe
    const clientTelegramId = telegramId || await getClientTelegramId(sanitizedCustomer);
    
    const result = await db.run(
      `INSERT INTO orders (customer, type, address, items, total, discount, status, client_telegram_id) 
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [sanitizedCustomer, sanitizedType, sanitizedAddress, JSON.stringify(items), finalTotal, discount, orderStatus, clientTelegramId]
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

    // ==================== SYSTÈME DE PARRAINAGE ====================
    // Créer ou récupérer le code de parrainage du client
    const customerReferral = await getOrCreateReferralCode(sanitizedCustomer, orderId);
    let referralResult = null;

    // Appliquer les crédits de parrainage si un code a été fourni
    if (referralCode && referralCode.trim().length > 0) {
      referralResult = await applyReferralCredits(referralCode.trim(), sanitizedCustomer, orderId);
    }

    // Notification Telegram pour le parrain si un code a été utilisé
    if (referralResult && referralResult.referrerContact) {
      await notifyReferralSuccess(
        referralResult.referrerContact,
        sanitizedCustomer,
        referralResult.referrerCredit,
        orderId,
        {
          vipTier: referralResult.vipTier,
          vipBonus: referralResult.vipBonus,
          bonusAmount: referralResult.bonusAmount
        }
      ).catch(err => console.error('Referral notification error:', err.message));
    }

    if (isNewCustomer) {
      await notifyNewCustomerOrder(order, items, customerRecord).catch(err =>
        console.error('Notification error:', err.message)
      );

      res.json({
        ok: true,
        orderId,
        discount,
        creditUsed,
        remainingCredit,
        requiresApproval: true,
        message: 'Votre commande est en attente de validation. Vous serez notifié sous peu.',
        referralCode: customerReferral.referral_code,
        referralCredit: referralResult?.referredCredit || 0
      });
    } else {
      await notifyNewOrder(order, items).catch(err =>
        console.error('Notification error:', err.message)
      );

      res.json({
        ok: true,
        orderId,
        discount,
        creditUsed,
        remainingCredit,
        referralCode: customerReferral.referral_code,
        referralCredit: referralResult?.referredCredit || 0
      });
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

// ==================== REFERRAL ENDPOINTS ====================
app.post('/api/validate-referral', apiLimiter, async (req, res) => {
  try {
    const { code } = req.body;

    if (!code || code.trim().length === 0) {
      return res.json({ valid: false, error: 'Code vide' });
    }

    const referral = await validateReferralCode(code.trim());

    if (!referral) {
      return res.json({ valid: false, error: 'Code invalide' });
    }

    res.json({
      valid: true,
      referrerContact: referral.customer_contact,
      totalReferrals: referral.total_referrals
    });
  } catch (error) {
    console.error('Validate referral error:', error);
    res.status(500).json({ valid: false, error: 'Erreur serveur' });
  }
});

app.get('/api/referral-stats', apiLimiter, async (req, res) => {
  try {
    const { customer } = req.query;

    if (!customer) {
      return res.status(400).json({ ok: false, error: 'Contact client manquant' });
    }

    const stats = await getReferralStats(customer);

    if (!stats) {
      return res.json({
        ok: true,
        exists: false,
        code: null,
        creditBalance: 0,
        totalReferrals: 0,
        totalEarned: 0,
        history: []
      });
    }

    res.json({
      ok: true,
      exists: true,
      ...stats
    });
  } catch (error) {
    console.error('Referral stats error:', error);
    res.status(500).json({ ok: false, error: 'Erreur serveur' });
  }
});

app.get('/api/referral-leaderboard', apiLimiter, async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 10;

    const leaderboard = await db.all(`
      SELECT
        customer_contact,
        referral_code,
        total_referrals,
        total_earned,
        credit_balance
      FROM referrals
      WHERE total_referrals > 0
      ORDER BY total_referrals DESC, total_earned DESC
      LIMIT ?
    `, [limit]);

    // Calculer les paliers VIP
    const leaderboardWithTiers = leaderboard.map((user, index) => {
      const totalReferrals = user.total_referrals || 0;
      let vipTier = 'Bronze 🥉';
      let vipBonus = 0;

      if (totalReferrals >= 10) {
        vipTier = 'Diamant 💎';
        vipBonus = 50;
      } else if (totalReferrals >= 6) {
        vipTier = 'Or 🥇';
        vipBonus = 20;
      } else if (totalReferrals >= 3) {
        vipTier = 'Argent 🥈';
        vipBonus = 10;
      }

      // Masquer une partie du numéro de téléphone
      const maskedContact = user.customer_contact.replace(/(\d{2})\d+(\d{4})/, '$1****$2');

      return {
        rank: index + 1,
        contact: maskedContact,
        totalReferrals,
        totalEarned: user.total_earned,
        vipTier,
        vipBonus
      };
    });

    res.json({
      ok: true,
      leaderboard: leaderboardWithTiers
    });
  } catch (error) {
    console.error('Leaderboard error:', error);
    res.status(500).json({ ok: false, error: 'Erreur serveur' });
  }
});

app.get('/api/credit-balance', apiLimiter, async (req, res) => {
  try {
    const { customer } = req.query;

    if (!customer) {
      return res.status(400).json({ ok: false, error: 'Contact client manquant' });
    }

    const referral = await db.get(
      'SELECT credit_balance FROM referrals WHERE customer_contact = ?',
      [customer]
    );

    res.json({
      ok: true,
      creditBalance: referral?.credit_balance || 0
    });
  } catch (error) {
    console.error('Credit balance error:', error);
    res.status(500).json({ ok: false, error: 'Erreur serveur' });
  }
});

// ==================== ADMIN MIDDLEWARE ====================
function requireAdmin(req, res, next) {
  const token = req.headers['x-admin-token'] || req.query.token;
  if (!token || !adminTokens.has(token)) {
    return res.status(401).json({ ok: false, error: 'Non autorisé' });
  }
  next();
}

// ==================== ADMIN ROUTES ====================

app.post('/api/admin/login', authLimiter, async (req, res) => {
  const { password } = req.body;

  try {
    const isValid = await verifyAdminPassword(password);
    if (isValid) {
      const token = adminTokens.generateToken();
      adminTokens.add(token);
      res.json({ ok: true, token });
    } else {
      res.status(401).json({ ok: false, error: 'Mot de passe incorrect' });
    }
  } catch (err) {
    console.error('Erreur lors de la vérification du mot de passe:', err);
    res.status(500).json({ ok: false, error: 'Erreur interne' });
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

    // Récupérer l'ancien statut avant mise à jour
    const oldOrder = await db.get('SELECT status, client_telegram_id, customer FROM orders WHERE id = ?', [id]);

    const fields = Object.keys(updates).map(key => `${key} = ?`).join(', ');
    const values = [...Object.values(updates), id];

    await db.run(`UPDATE orders SET ${fields} WHERE id = ?`, values);

    // Notification Telegram au client si le statut a changé
    if (updates.status && oldOrder && updates.status !== oldOrder.status) {
      const clientTelegramId = oldOrder.client_telegram_id || await getClientTelegramId(oldOrder.customer);
      if (clientTelegramId) {
        const statusMessages = {
          'pending': '⏳ Votre commande #' + id + ' est en attente de traitement.',
          'confirmed': '✅ Votre commande #' + id + ' a été confirmée !',
          'preparing': '👨‍🍳 Votre commande #' + id + ' est en préparation.',
          'en_route': '🚚 Votre commande #' + id + ' est en route !',
          'delivered': '✅ Votre commande #' + id + ' a été livrée. Merci !',
          'cancelled': '❌ Votre commande #' + id + ' a été annulée.'
        };
        const msg = statusMessages[updates.status] || `📦 Votre commande #${id} a changé de statut: ${updates.status}`;
        try {
          await telegram.sendMessage(clientTelegramId, msg);
          console.log(`📱 Notification statut envoyée au client ${clientTelegramId} pour commande #${id}`);
        } catch (e) {
          console.error(`Failed to notify client ${clientTelegramId}:`, e.message);
        }
      }
    }

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

// ==================== PUBLIC: GET APPROVED REVIEWS ====================
app.get('/api/reviews', apiLimiter, async (req, res) => {
  try {
    const reviews = await db.all(
      'SELECT id, name, stars, text, created_at FROM reviews WHERE approved = 1 ORDER BY created_at DESC LIMIT 50'
    );
    res.json({ ok: true, reviews });
  } catch (error) {
    console.error('Public reviews error:', error);
    res.status(500).json({ ok: false, error: 'Erreur serveur' });
  }
});

// ==================== PUBLIC: SUBMIT A REVIEW ====================
app.post('/api/reviews', apiLimiter, async (req, res) => {
  try {
    const { name, stars, text } = req.body;

    if (!text || typeof text !== 'string' || text.trim().length < 10) {
      return res.status(400).json({ ok: false, error: 'Avis trop court (min 10 caractères)' });
    }
    if (!stars || stars < 1 || stars > 5) {
      return res.status(400).json({ ok: false, error: 'Note invalide (1-5)' });
    }

    const safeName = (name && typeof name === 'string') ? name.trim().substring(0, 50) : 'Anonyme';
    const safeText = text.trim().substring(0, 500);

    const result = await db.run(
      'INSERT INTO reviews (product_id, name, stars, text, approved) VALUES (0, ?, ?, ?, 0)',
      [safeName, parseInt(stars), safeText]
    );

    // Notify admins via Telegram
    const reviewId = result.lastID;
    const starsStr = '⭐'.repeat(parseInt(stars));
    const adminMsg = `📝 <b>NOUVEL AVIS</b>\n\n` +
      `👤 <b>${safeName}</b>\n` +
      `${starsStr} (${stars}/5)\n\n` +
      `💬 "${safeText}"\n\n` +
      `⏳ En attente d'approbation`;

    const adminKeyboard = {
      inline_keyboard: [
        [
          { text: '✅ Approuver', callback_data: `rev_approve_${reviewId}` },
          { text: '❌ Refuser', callback_data: `rev_reject_${reviewId}` }
        ]
      ]
    };

    const adminIds = getAdminChatIds();
    for (const adminId of adminIds) {
      try {
        await telegram.sendMessage(adminId, adminMsg, { reply_markup: JSON.stringify(adminKeyboard) });
      } catch (e) {
        console.error(`Failed to notify admin ${adminId}:`, e.message);
      }
    }
    // Also notify session admins
    for (const adminId of sessionAdmins) {
      if (!adminIds.includes(adminId)) {
        try {
          await telegram.sendMessage(adminId, adminMsg, { reply_markup: JSON.stringify(adminKeyboard) });
        } catch (e) {
          console.error(`Failed to notify session admin ${adminId}:`, e.message);
        }
      }
    }

    res.json({ ok: true, message: 'Avis soumis, en attente de validation' });
  } catch (error) {
    console.error('Submit review error:', error);
    res.status(500).json({ ok: false, error: 'Erreur serveur' });
  }
});

// ==================== PUBLIC: GET REVIEW STATS ====================
app.get('/api/reviews/stats', apiLimiter, async (req, res) => {
  try {
    const stats = await db.get(
      'SELECT COUNT(*) as count, ROUND(AVG(stars), 1) as average FROM reviews WHERE approved = 1'
    );
    res.json({ ok: true, count: stats?.count || 0, average: stats?.average || 0 });
  } catch (error) {
    console.error('Review stats error:', error);
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

// ==================== CART PERSISTENCE (30min expiry) ====================

app.put('/api/cart/:sessionId', apiLimiter, async (req, res) => {
  try {
    const { sessionId } = req.params;
    const { items } = req.body;
    if (!sessionId || typeof sessionId !== 'string' || sessionId.length > 100) {
      return res.status(400).json({ ok: false, error: 'Session invalide' });
    }
    if (!Array.isArray(items)) {
      return res.status(400).json({ ok: false, error: 'Items invalides' });
    }
    await db.run(
      `INSERT INTO carts (session_id, items, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(session_id) DO UPDATE SET items = excluded.items, updated_at = CURRENT_TIMESTAMP`,
      [sessionId, JSON.stringify(items)]
    );
    res.json({ ok: true });
  } catch (error) {
    console.error('Save cart error:', error);
    res.status(500).json({ ok: false, error: 'Erreur serveur' });
  }
});

app.get('/api/cart/:sessionId', apiLimiter, async (req, res) => {
  try {
    const { sessionId } = req.params;
    const cart = await db.get(
      "SELECT items, updated_at FROM carts WHERE session_id = ? AND updated_at >= datetime('now', '-30 minutes')",
      [sessionId]
    );
    if (!cart) {
      return res.json({ ok: true, items: [], expired: true });
    }
    res.json({ ok: true, items: JSON.parse(cart.items), expired: false });
  } catch (error) {
    console.error('Load cart error:', error);
    res.status(500).json({ ok: false, error: 'Erreur serveur' });
  }
});

app.delete('/api/cart/:sessionId', apiLimiter, async (req, res) => {
  try {
    await db.run('DELETE FROM carts WHERE session_id = ?', [req.params.sessionId]);
    res.json({ ok: true });
  } catch (error) {
    console.error('Delete cart error:', error);
    res.status(500).json({ ok: false, error: 'Erreur serveur' });
  }
});

// ==================== FAVORITES SYNC ====================

app.put('/api/favorites/:sessionId', apiLimiter, async (req, res) => {
  try {
    const { sessionId } = req.params;
    const { productIds } = req.body;
    if (!sessionId || typeof sessionId !== 'string' || sessionId.length > 100) {
      return res.status(400).json({ ok: false, error: 'Session invalide' });
    }
    if (!Array.isArray(productIds)) {
      return res.status(400).json({ ok: false, error: 'Données invalides' });
    }
    await db.run(
      `INSERT INTO favorites (session_id, product_ids, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(session_id) DO UPDATE SET product_ids = excluded.product_ids, updated_at = CURRENT_TIMESTAMP`,
      [sessionId, JSON.stringify(productIds)]
    );
    res.json({ ok: true });
  } catch (error) {
    console.error('Save favorites error:', error);
    res.status(500).json({ ok: false, error: 'Erreur serveur' });
  }
});

app.get('/api/favorites/:sessionId', apiLimiter, async (req, res) => {
  try {
    const { sessionId } = req.params;
    const fav = await db.get('SELECT product_ids FROM favorites WHERE session_id = ?', [sessionId]);
    if (!fav) {
      return res.json({ ok: true, productIds: [] });
    }
    res.json({ ok: true, productIds: JSON.parse(fav.product_ids) });
  } catch (error) {
    console.error('Load favorites error:', error);
    res.status(500).json({ ok: false, error: 'Erreur serveur' });
  }
});

// ==================== STAFF DATA SYNC (Nourrice/Gérant/Livreur) ====================

app.put('/api/admin/staff/:role', requireAdmin, async (req, res) => {
  try {
    const { role } = req.params;
    if (!['nourrice', 'gerant', 'livreur'].includes(role)) {
      return res.status(400).json({ ok: false, error: 'Rôle invalide' });
    }
    const { data } = req.body;
    if (!data || typeof data !== 'object') {
      return res.status(400).json({ ok: false, error: 'Données invalides' });
    }
    await db.run(
      `INSERT INTO staff_data (role, data, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(role) DO UPDATE SET data = excluded.data, updated_at = CURRENT_TIMESTAMP`,
      [role, JSON.stringify(data)]
    );
    res.json({ ok: true });
  } catch (error) {
    console.error('Save staff data error:', error);
    res.status(500).json({ ok: false, error: 'Erreur serveur' });
  }
});

app.get('/api/admin/staff/:role', requireAdmin, async (req, res) => {
  try {
    const { role } = req.params;
    if (!['nourrice', 'gerant', 'livreur'].includes(role)) {
      return res.status(400).json({ ok: false, error: 'Rôle invalide' });
    }
    const row = await db.get('SELECT data, updated_at FROM staff_data WHERE role = ?', [role]);
    if (!row) {
      return res.json({ ok: true, data: null });
    }
    res.json({ ok: true, data: JSON.parse(row.data), updated_at: row.updated_at });
  } catch (error) {
    console.error('Load staff data error:', error);
    res.status(500).json({ ok: false, error: 'Erreur serveur' });
  }
});

// ==================== STAFF DATA EXPORT (CSV) ====================

app.get('/api/admin/staff/:role/export', requireAdmin, async (req, res) => {
  try {
    const { role } = req.params;
    if (!['nourrice', 'gerant', 'livreur'].includes(role)) {
      return res.status(400).json({ ok: false, error: 'Rôle invalide' });
    }
    const row = await db.get('SELECT data FROM staff_data WHERE role = ?', [role]);
    if (!row) {
      return res.status(404).json({ ok: false, error: 'Aucune donnée' });
    }
    const data = JSON.parse(row.data);
    let csv = '';

    if (role === 'nourrice') {
      csv += 'Type,Produit,Quantité (g),Date\n';
      if (data.stock) {
        Object.entries(data.stock).forEach(([product, qty]) => {
          csv += `Stock,"${product}",${qty},-\n`;
        });
      }
      csv += `\nArgent en caisse,${data.cash || 0}€,,\n`;
      if (data.history && data.history.length > 0) {
        csv += '\nHistorique\nType,Détail,Quantité,Date\n';
        data.history.forEach(h => {
          csv += `"${h.type || ''}","${h.detail || h.product || ''}","${h.qty || h.amount || ''}","${h.date || ''}"\n`;
        });
      }
    } else {
      csv += 'Section,Produit/Variant,Quantité,Date\n';
      if (data.gros) {
        Object.entries(data.gros).forEach(([product, qty]) => {
          csv += `Gros,"${product}",${qty}g,-\n`;
        });
      }
      if (data.variants) {
        Object.entries(data.variants).forEach(([key, qty]) => {
          csv += `Variant,"${key.replace('::', ' - ')}",${qty},-\n`;
        });
      }
      csv += `\nArgent en caisse,${data.cash || 0}€,,\n`;
      if (data.history && data.history.length > 0) {
        csv += '\nHistorique\nType,Détail,Quantité,Date\n';
        data.history.forEach(h => {
          csv += `"${h.type || ''}","${h.detail || h.product || ''}","${h.qty || h.amount || ''}","${h.date || ''}"\n`;
        });
      }
    }

    const roleName = { nourrice: 'Nourrice', gerant: 'Gerant', livreur: 'Livreur' }[role];
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename=stock_${roleName}.csv`);
    res.send('\uFEFF' + csv);
  } catch (error) {
    console.error('Staff export error:', error);
    res.status(500).json({ ok: false, error: 'Erreur serveur' });
  }
});

// ==================== EMPLOYEES / PAYROLL CRUD ====================

app.get('/api/admin/employees', requireAdmin, async (req, res) => {
  try {
    const { status } = req.query;
    let query = 'SELECT * FROM employees';
    const params = [];
    if (status && status !== 'all') {
      query += ' WHERE status = ?';
      params.push(status);
    }
    query += ' ORDER BY created_at DESC';
    const employees = await db.all(query, params);
    res.json({ ok: true, employees });
  } catch (error) {
    console.error('Employees error:', error);
    res.status(500).json({ ok: false, error: 'Erreur serveur' });
  }
});

app.post('/api/admin/employees', requireAdmin, async (req, res) => {
  try {
    const { name, position, type, salary, hire_date } = req.body;
    if (!name || !position || !type || salary == null || !hire_date) {
      return res.status(400).json({ ok: false, error: 'Champs requis manquants' });
    }
    const result = await db.run(
      'INSERT INTO employees (name, position, type, salary, hire_date) VALUES (?, ?, ?, ?, ?)',
      [name, position, type, Math.max(0, parseFloat(salary)), hire_date]
    );
    res.json({ ok: true, id: result.lastID });
  } catch (error) {
    console.error('Add employee error:', error);
    res.status(500).json({ ok: false, error: 'Erreur serveur' });
  }
});

app.put('/api/admin/employees/:id', requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { name, position, type, salary, status } = req.body;
    const fields = [];
    const values = [];
    if (name) { fields.push('name = ?'); values.push(name); }
    if (position) { fields.push('position = ?'); values.push(position); }
    if (type) { fields.push('type = ?'); values.push(type); }
    if (salary != null) { fields.push('salary = ?'); values.push(Math.max(0, parseFloat(salary))); }
    if (status) { fields.push('status = ?'); values.push(status); }
    if (fields.length === 0) {
      return res.status(400).json({ ok: false, error: 'Aucune mise à jour' });
    }
    values.push(id);
    await db.run(`UPDATE employees SET ${fields.join(', ')} WHERE id = ?`, values);
    res.json({ ok: true });
  } catch (error) {
    console.error('Update employee error:', error);
    res.status(500).json({ ok: false, error: 'Erreur serveur' });
  }
});

app.delete('/api/admin/employees/:id', requireAdmin, async (req, res) => {
  try {
    await db.run('DELETE FROM employees WHERE id = ?', [req.params.id]);
    res.json({ ok: true });
  } catch (error) {
    console.error('Delete employee error:', error);
    res.status(500).json({ ok: false, error: 'Erreur serveur' });
  }
});

app.get('/api/admin/payroll', requireAdmin, async (req, res) => {
  try {
    const { month, year, status } = req.query;
    let query = 'SELECT p.*, e.position FROM payroll p LEFT JOIN employees e ON p.employee_id = e.id WHERE 1=1';
    const params = [];
    if (month) { query += ' AND p.month = ?'; params.push(parseInt(month)); }
    if (year) { query += ' AND p.year = ?'; params.push(parseInt(year)); }
    if (status && status !== 'all') { query += ' AND p.status = ?'; params.push(status); }
    query += ' ORDER BY p.year DESC, p.month DESC, p.created_at DESC';
    const payroll = await db.all(query, params);
    res.json({ ok: true, payroll });
  } catch (error) {
    console.error('Payroll error:', error);
    res.status(500).json({ ok: false, error: 'Erreur serveur' });
  }
});

app.post('/api/admin/payroll', requireAdmin, async (req, res) => {
  try {
    const { employee_id, month, year, gross_amount, bonus, note } = req.body;
    if (!employee_id || !month || !year || gross_amount == null) {
      return res.status(400).json({ ok: false, error: 'Champs requis manquants' });
    }
    const employee = await db.get('SELECT name FROM employees WHERE id = ?', [employee_id]);
    if (!employee) {
      return res.status(404).json({ ok: false, error: 'Employé introuvable' });
    }
    const bonusAmount = parseFloat(bonus) || 0;
    const netAmount = parseFloat(gross_amount) + bonusAmount;
    const result = await db.run(
      `INSERT INTO payroll (employee_id, employee_name, month, year, gross_amount, bonus, net_amount, note)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [employee_id, employee.name, parseInt(month), parseInt(year), parseFloat(gross_amount), bonusAmount, netAmount, note || '']
    );
    res.json({ ok: true, id: result.lastID });
  } catch (error) {
    console.error('Add payroll error:', error);
    res.status(500).json({ ok: false, error: 'Erreur serveur' });
  }
});

app.put('/api/admin/payroll/:id', requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { status, payment_date } = req.body;
    if (!status) {
      return res.status(400).json({ ok: false, error: 'Statut requis' });
    }
    await db.run(
      'UPDATE payroll SET status = ?, payment_date = ? WHERE id = ?',
      [status, payment_date || null, id]
    );
    res.json({ ok: true });
  } catch (error) {
    console.error('Update payroll error:', error);
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
    
    for (const [orderId, conv] of chatManager.activeConversations.entries()) {
      const order = await db.get('SELECT customer FROM orders WHERE id = ?', [orderId]);
      if (order && order.customer === contact) {
        chatManager.closeConversation(orderId);
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

// ==================== ADMIN REFERRAL ENDPOINTS ====================
app.get('/api/admin/referrals', requireAdmin, async (req, res) => {
  try {
    const referrals = await db.all(`
      SELECT
        r.*,
        COUNT(rh.id) as total_referrals_count,
        SUM(rh.referrer_credit) as total_earned_from_history
      FROM referrals r
      LEFT JOIN referral_history rh ON r.referral_code = rh.referrer_code
      GROUP BY r.id
      ORDER BY r.total_earned DESC
    `);

    // Calculate VIP tiers for each referral
    const referralsWithTiers = referrals.map(ref => {
      const totalReferrals = ref.total_referrals || 0;
      let vipTier = 'Bronze 🥉';
      let vipBonus = 0;

      if (totalReferrals >= 10) {
        vipTier = 'Diamant 💎';
        vipBonus = 50;
      } else if (totalReferrals >= 6) {
        vipTier = 'Or 🥇';
        vipBonus = 20;
      } else if (totalReferrals >= 3) {
        vipTier = 'Argent 🥈';
        vipBonus = 10;
      }

      return {
        ...ref,
        vipTier,
        vipBonus
      };
    });

    res.json({ ok: true, referrals: referralsWithTiers });
  } catch (error) {
    console.error('Get referrals error:', error);
    res.status(500).json({ ok: false, error: 'Erreur serveur' });
  }
});

app.get('/api/admin/referrals/export', requireAdmin, async (req, res) => {
  try {
    const referrals = await db.all(`
      SELECT
        r.*,
        COUNT(rh.id) as total_referrals_count
      FROM referrals r
      LEFT JOIN referral_history rh ON r.referral_code = rh.referrer_code
      GROUP BY r.id
      ORDER BY r.created_at DESC
    `);

    // Create CSV
    let csv = 'Code Parrainage,Contact Client,Solde Crédit,Total Parrainages,Total Gagné,Palier VIP,Date Création\n';

    referrals.forEach(ref => {
      const totalReferrals = ref.total_referrals || 0;
      let vipTier = 'Bronze';
      if (totalReferrals >= 10) vipTier = 'Diamant';
      else if (totalReferrals >= 6) vipTier = 'Or';
      else if (totalReferrals >= 3) vipTier = 'Argent';

      csv += `${ref.referral_code},${ref.customer_contact},${ref.credit_balance},${ref.total_referrals},${ref.total_earned},${vipTier},${ref.created_at}\n`;
    });

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename=referrals_export.csv');
    res.send(csv);
  } catch (error) {
    console.error('Export referrals error:', error);
    res.status(500).json({ ok: false, error: 'Erreur serveur' });
  }
});

// ==================== CHANNEL ANNOUNCEMENTS ====================

function resolveChannelId(channel) {
  if (channel === 'photo') return process.env.TELEGRAM_PHOTO_CHANNEL_ID || config.telegram.photoChannelId;
  if (channel === 'secours') return process.env.TELEGRAM_SECOURS_CHANNEL_ID || config.telegram.secoursChannelId;
  return process.env.TELEGRAM_CHANNEL_ID || config.telegram.channelId; // principal par défaut
}

// Poster une annonce texte (immédiat ou programmé)
// Body: { text, channel?, pin?, post_at?, delete_at?, pin_times?: ["HH:MM", ...] }
app.post('/api/admin/announcements', requireAdmin, async (req, res) => {
  try {
    const { text, channel, pin, post_at, delete_at, pin_times, recurring } = req.body;
    if (!text || text.trim().length === 0) {
      return res.status(400).json({ ok: false, error: 'Le texte est requis' });
    }

    const channelId = resolveChannelId(channel);

    if (!channelId) {
      return res.status(400).json({ ok: false, error: 'Channel ID non configuré' });
    }

    const hasPins = (pin_times && pin_times.length > 0) || pin;

    // Annonce programmée
    if (post_at) {
      const pinScheduleJson = (pin_times && pin_times.length > 0) ? JSON.stringify(pin_times) : null;
      const result = await db.run(
        `INSERT INTO announcements (channel_id, message_id, type, content, pin, status, post_at, delete_at, recurring, pin_schedule, posted_by)
         VALUES (?, NULL, 'text', ?, ?, 'scheduled', ?, ?, ?, ?, 'admin')`,
        [channelId, text.trim(), hasPins ? 1 : 0, post_at, delete_at || null, recurring || null, pinScheduleJson]
      );
      const annId = result.lastID;

      // Ajouter les actions de pin programmées
      if (pin_times && pin_times.length > 0) {
        for (const pt of pin_times) {
          await db.run(
            `INSERT INTO scheduled_actions (announcement_id, action, execute_at, status) VALUES (?, 'pin', ?, 'pending')`,
            [annId, pt]
          );
        }
      }
      if (delete_at) {
        await db.run(
          `INSERT INTO scheduled_actions (announcement_id, action, execute_at, status) VALUES (?, 'delete', ?, 'pending')`,
          [annId, delete_at]
        );
      }

      return res.json({ ok: true, scheduled: true, id: annId, post_at, delete_at, pin_times });
    }

    // Envoi immédiat
    const sendResult = await telegram.sendMessage(channelId, text.trim());
    if (!sendResult || !sendResult.result) {
      return res.status(500).json({ ok: false, error: 'Échec de l\'envoi sur le canal' });
    }

    const messageId = sendResult.result.message_id;

    if (pin) {
      await telegram.pinChatMessage(channelId, messageId, true);
    }

    const dbResult = await db.run(
      `INSERT INTO announcements (channel_id, message_id, type, content, pin, status, delete_at, posted_by)
       VALUES (?, ?, 'text', ?, ?, 'posted', ?, 'admin')`,
      [channelId, messageId, text.trim(), hasPins ? 1 : 0, delete_at || null]
    );
    const annId = dbResult.lastID;

    // Actions programmées sur un message déjà posté
    if (pin_times && pin_times.length > 0) {
      for (const pt of pin_times) {
        await db.run(
          `INSERT INTO scheduled_actions (announcement_id, action, execute_at, status) VALUES (?, 'pin', ?, 'pending')`,
          [annId, pt]
        );
      }
    }
    if (delete_at) {
      await db.run(
        `INSERT INTO scheduled_actions (announcement_id, action, execute_at, status) VALUES (?, 'delete', ?, 'pending')`,
        [annId, delete_at]
      );
    }

    res.json({ ok: true, messageId, channelId, id: annId, pinned: !!pin });
  } catch (error) {
    console.error('Post announcement error:', error);
    res.status(500).json({ ok: false, error: 'Erreur serveur' });
  }
});

// Poster une annonce photo (immédiat ou programmé)
app.post('/api/admin/announcements/photo', requireAdmin, async (req, res) => {
  try {
    const { photo, caption, channel, pin, post_at, delete_at } = req.body;
    if (!photo) {
      return res.status(400).json({ ok: false, error: 'L\'URL de la photo est requise' });
    }

    const channelId = resolveChannelId(channel);

    if (!channelId) {
      return res.status(400).json({ ok: false, error: 'Channel ID non configuré' });
    }

    // Programmé
    if (post_at) {
      await db.run(
        `INSERT INTO announcements (channel_id, message_id, type, content, photo_url, pin, status, post_at, delete_at, posted_by)
         VALUES (?, NULL, 'photo', ?, ?, ?, 'scheduled', ?, ?, 'admin')`,
        [channelId, caption || '', photo, pin ? 1 : 0, post_at, delete_at || null]
      );
      return res.json({ ok: true, scheduled: true, post_at, delete_at });
    }

    // Immédiat
    const result = await telegram.sendPhoto(channelId, photo, caption || '');
    if (!result || !result.result) {
      return res.status(500).json({ ok: false, error: 'Échec de l\'envoi de la photo' });
    }

    const messageId = result.result.message_id;

    if (pin) {
      await telegram.pinChatMessage(channelId, messageId, true);
    }

    await db.run(
      `INSERT INTO announcements (channel_id, message_id, type, content, photo_url, pin, status, delete_at, posted_by)
       VALUES (?, ?, 'photo', ?, ?, ?, 'posted', ?, 'admin')`,
      [channelId, messageId, caption || '', photo, pin ? 1 : 0, delete_at || null]
    );

    res.json({ ok: true, messageId, channelId, pinned: !!pin });
  } catch (error) {
    console.error('Post photo announcement error:', error);
    res.status(500).json({ ok: false, error: 'Erreur serveur' });
  }
});

// Lister les annonces
app.get('/api/admin/announcements', requireAdmin, async (req, res) => {
  try {
    const announcements = await db.all(
      `SELECT * FROM announcements WHERE status IN ('posted', 'scheduled')
       ORDER BY CASE WHEN status = 'scheduled' THEN 0 ELSE 1 END, created_at DESC
       LIMIT 50`
    );
    res.json({ ok: true, announcements });
  } catch (error) {
    console.error('List announcements error:', error);
    res.status(500).json({ ok: false, error: 'Erreur serveur' });
  }
});

// Supprimer une annonce du canal
app.delete('/api/admin/announcements/:id', requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const announcement = await db.get('SELECT * FROM announcements WHERE id = ?', [id]);

    if (!announcement) {
      return res.status(404).json({ ok: false, error: 'Annonce non trouvée' });
    }

    // Annonce programmée non encore postée → juste la supprimer
    if (announcement.status === 'scheduled') {
      await db.run('DELETE FROM scheduled_actions WHERE announcement_id = ?', [id]);
      await db.run('DELETE FROM announcements WHERE id = ?', [id]);
      return res.json({ ok: true, message: 'Annonce programmée annulée' });
    }

    // Annonce postée → supprimer du canal
    if (announcement.pin && announcement.message_id) {
      await telegram.unpinChatMessage(announcement.channel_id, announcement.message_id);
    }

    if (announcement.message_id) {
      const deleted = await telegram.deleteMessage(announcement.channel_id, announcement.message_id);
      if (!deleted) {
        return res.status(500).json({ ok: false, error: 'Échec de la suppression sur Telegram' });
      }
    }

    await db.run('DELETE FROM scheduled_actions WHERE announcement_id = ?', [id]);
    await db.run('UPDATE announcements SET status = ? WHERE id = ?', ['deleted', id]);
    res.json({ ok: true, message: 'Annonce supprimée' });
  } catch (error) {
    console.error('Delete announcement error:', error);
    res.status(500).json({ ok: false, error: 'Erreur serveur' });
  }
});

// ==================== TELEGRAM BOT ====================
if (config.telegram.token) {
  console.log('🤖 Configuring Telegram bot...');

  try {
    // Handler commun pour le webhook Telegram
    async function handleWebhookRequest(req, res) {
      console.log('📥 Webhook reçu:', JSON.stringify(req.body).substring(0, 200));

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
        console.error(error.stack);
        res.sendStatus(500);
      }
    }

    // Test endpoint pour vérifier que la route fonctionne
    app.get('/telegram-webhook', (req, res) => {
      res.json({ ok: true, message: 'Webhook endpoint is working' });
    });

    // Endpoint principal du webhook
    app.post('/telegram-webhook', handleWebhookRequest);

    // Endpoint alternatif compatible bot.js (au cas où le webhook Telegram pointe vers /bot<TOKEN>)
    app.post(`/bot${config.telegram.token}`, handleWebhookRequest);

    // Route /setup-webhook pour reconfigurer le webhook depuis le navigateur ou curl
    app.post('/setup-webhook', async (req, res) => {
      try {
        const webhookUrl = `${config.webapp.url}/telegram-webhook`;
        await telegram.setWebhook(webhookUrl);
        res.json({ success: true, webhook: webhookUrl });
      } catch (error) {
        res.status(500).json({ success: false, error: error.message });
      }
    });

    console.log('✅ Telegram bot webhook configured successfully');
    console.log(`   📡 Endpoints: /telegram-webhook + /bot<TOKEN>`);
  } catch (error) {
    console.error('❌ Failed to configure Telegram bot:', error.message);
    console.error(error.stack);
  }
}

// ==================== CLAVIER PERMANENT POUR CHAQUE UTILISATEUR ====================
function getPermanentKeyboard(chatId) {
  const isDriver = chatId.toString() === config.telegram.driverMillauId || 
                   chatId.toString() === config.telegram.driverExterieurId;
  const userIsAdmin = isAdmin(chatId);
  
  if (isDriver) {
    return {
      keyboard: [
        [{ text: '📋 Mes Livraisons' }],
        [{ text: '📊 Mes Stats' }],
        [{ text: '🛍️ Boutique', web_app: { url: `${config.webapp.url}/clear-cache.html` } }],
        [{ text: '❓ Aide' }]
      ],
      resize_keyboard: true,
      persistent: true,
      one_time_keyboard: false
    };
  } else if (userIsAdmin) {
    return {
      keyboard: [
        [{ text: '🛒 Ouvrir la Boutique', web_app: { url: `${config.webapp.url}/clear-cache.html` } }],
        [
          { text: 'ℹ️ Info' },
          { text: '📞 Contact' }
        ],
        [
          { text: '📖 Comment Commander' },
          { text: '🔐 Admin', web_app: { url: `${config.webapp.url}/admin.html` } }
        ]
      ],
      resize_keyboard: true,
      persistent: true,
      one_time_keyboard: false
    };
  } else {
    return {
      keyboard: [
        [{ text: '🛒 Ouvrir la Boutique', web_app: { url: `${config.webapp.url}/clear-cache.html` } }],
        [
          { text: '💰 Mon Crédit' },
          { text: '🎁 Parrainage' }
        ],
        [
          { text: 'ℹ️ Info' },
          { text: '📞 Contact' }
        ],
        [{ text: '📖 Comment Commander' }]
      ],
      resize_keyboard: true,
      persistent: true,
      one_time_keyboard: false
    };
  }
}

// ==================== ANNOUNCEMENT BOT HANDLERS ====================

// Parse l'heure au format HH:MM et retourne un Date pour aujourd'hui ou demain
function parseTime(timeStr) {
  const match = timeStr.match(/^(\d{1,2})[h:](\d{2})$/);
  if (!match) return null;
  const hours = parseInt(match[1]);
  const minutes = parseInt(match[2]);
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;
  const now = new Date();
  const target = new Date(now);
  target.setHours(hours, minutes, 0, 0);
  // Si l'heure est déjà passée aujourd'hui, programmer pour demain
  if (target <= now) {
    target.setDate(target.getDate() + 1);
  }
  return target;
}

function formatDateTime(dateStr) {
  if (!dateStr) return '-';
  const d = new Date(dateStr);
  return d.toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

// Remplace les placeholders dans le texte d'annonce par la date du jour
// {jour} → 30, {mois} → janvier, {date} → 30 janvier, {DATE} → 30/01/2026
const MOIS_FR = ['janvier','février','mars','avril','mai','juin','juillet','août','septembre','octobre','novembre','décembre'];
const JOURS_FR = ['dimanche','lundi','mardi','mercredi','jeudi','vendredi','samedi'];

function renderTemplate(template, date) {
  if (!date) date = new Date();
  const jour = date.getDate();
  const mois = MOIS_FR[date.getMonth()];
  const jourSemaine = JOURS_FR[date.getDay()];
  const dateFormatted = date.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric' });

  return template
    .replace(/\{jour\}/gi, jour)
    .replace(/\{mois\}/gi, mois)
    .replace(/\{joursemaine\}/gi, jourSemaine)
    .replace(/\{date\}/gi, `${jour} ${mois}`)
    .replace(/\{DATE\}/g, dateFormatted);
}

// Poster une annonce immédiatement
// Parse le préfixe #canal optionnel : #photo, #secours, ou rien (= principal)
function parseChannelPrefix(text) {
  const match = text.match(/^#(photo|secours)\s+/i);
  if (match) {
    return { channel: match[1].toLowerCase(), text: text.substring(match[0].length) };
  }
  return { channel: 'principal', text };
}

async function handlePostAnnouncement(chatId, text) {
  if (!text || text.length === 0) {
    await telegram.sendMessage(chatId, '❌ Usage: /annonce [#photo|#secours] <texte>');
    return;
  }

  const parsed = parseChannelPrefix(text);
  const channelId = resolveChannelId(parsed.channel === 'principal' ? null : parsed.channel);

  if (!channelId) {
    await telegram.sendMessage(chatId, `❌ Canal "${parsed.channel}" non configuré.`);
    return;
  }

  const result = await telegram.sendMessage(channelId, parsed.text);
  if (!result || !result.result) {
    await telegram.sendMessage(chatId, '❌ Échec de l\'envoi. Vérifiez que le bot est admin du canal.');
    return;
  }

  const messageId = result.result.message_id;
  await db.run(
    `INSERT INTO announcements (channel_id, message_id, type, content, posted_by, status)
     VALUES (?, ?, 'text', ?, ?, 'posted')`,
    [channelId, messageId, parsed.text, chatId.toString()]
  );

  const label = parsed.channel === 'principal' ? '' : ` (${parsed.channel})`;
  await telegram.sendMessage(chatId, `✅ Annonce publiée${label} !\n📝 Message ID: ${messageId}\n\n/supprannonce ${messageId}`);
}

// Poster + épingler immédiatement
async function handlePostAndPinAnnouncement(chatId, text) {
  if (!text || text.length === 0) {
    await telegram.sendMessage(chatId, '❌ Usage: /annoncepin [#photo|#secours] <texte>');
    return;
  }

  const parsed = parseChannelPrefix(text);
  const channelId = resolveChannelId(parsed.channel === 'principal' ? null : parsed.channel);

  if (!channelId) {
    await telegram.sendMessage(chatId, `❌ Canal "${parsed.channel}" non configuré.`);
    return;
  }

  const result = await telegram.sendMessage(channelId, parsed.text);
  if (!result || !result.result) {
    await telegram.sendMessage(chatId, '❌ Échec de l\'envoi.');
    return;
  }

  const messageId = result.result.message_id;
  await telegram.pinChatMessage(channelId, messageId, true);

  await db.run(
    `INSERT INTO announcements (channel_id, message_id, type, content, pin, posted_by, status)
     VALUES (?, ?, 'text', ?, 1, ?, 'posted')`,
    [channelId, messageId, parsed.text, chatId.toString()]
  );

  const label = parsed.channel === 'principal' ? '' : ` (${parsed.channel})`;
  await telegram.sendMessage(chatId, `✅ Annonce publiée et épinglée${label} !\n📌 Message ID: ${messageId}\n\n/supprannonce ${messageId}`);
}

// Programmer une annonce : /programmer HH:MM [suppr HH:MM] [pin] texte
async function handleScheduleAnnouncement(chatId, args) {
  if (!args || args.length === 0) {
    await telegram.sendMessage(chatId,
      '❌ <b>Usage:</b>\n\n' +
      '<code>/programmer HH:MM texte</code>\n' +
      '<code>/programmer HH:MM pin HH:MM,HH:MM suppr HH:MM texte</code>\n' +
      '<code>/programmer HH:MM quotidien texte avec {jour} {mois}</code>\n' +
      '<code>/programmer #secours HH:MM texte</code>\n\n' +
      '<b>Canaux:</b> #photo #secours (par défaut = principal)\n' +
      '<b>Mot-clé quotidien</b> = répète chaque jour\n' +
      '<b>Placeholders:</b> {jour} {mois} {date} {joursemaine} {DATE}\n\n' +
      '<b>Exemples:</b>\n' +
      '<code>/programmer 12:00 pin 15:00,17:00 suppr 00:00 Boutique ouverte !</code>\n' +
      '<code>/programmer #secours 12:00 quotidien suppr 00:00 Backup le {jour} {mois}</code>'
    );
    return;
  }

  const parts = args.split(' ');
  let idx = 0;

  // Optionnel : #canal en premier
  let targetChannel = null;
  if (parts[idx] && parts[idx].match(/^#(photo|secours)$/i)) {
    targetChannel = parts[idx].substring(1).toLowerCase();
    idx++;
  }

  const channelId = resolveChannelId(targetChannel);
  if (!channelId) {
    await telegram.sendMessage(chatId, `❌ Canal "${targetChannel || 'principal'}" non configuré.`);
    return;
  }

  const postTime = parseTime(parts[idx]);
  if (!postTime) {
    await telegram.sendMessage(chatId, `❌ Heure invalide: "${parts[idx]}". Format: HH:MM ou HHhMM`);
    return;
  }
  idx++;

  let deleteTime = null;
  let pinTimes = [];
  let pinTimesRaw = []; // Garder les heures en texte pour la récurrence
  let recurring = null;

  while (idx < parts.length) {
    const word = parts[idx].toLowerCase();
    if (word === 'suppr' && idx + 1 < parts.length) {
      idx++;
      deleteTime = parseTime(parts[idx]);
      if (!deleteTime) {
        await telegram.sendMessage(chatId, `❌ Heure de suppression invalide: "${parts[idx]}"`);
        return;
      }
      if (deleteTime <= postTime) {
        deleteTime.setDate(deleteTime.getDate() + 1);
      }
      idx++;
    } else if (word === 'pin' && idx + 1 < parts.length) {
      idx++;
      const pinArg = parts[idx];
      const pinParts = pinArg.split(',');
      for (const p of pinParts) {
        const t = parseTime(p.trim());
        if (!t) {
          await telegram.sendMessage(chatId, `❌ Heure de pin invalide: "${p.trim()}"`);
          return;
        }
        if (t < postTime) {
          t.setDate(t.getDate() + 1);
        }
        pinTimes.push(t);
        // Sauvegarder le format brut HH:MM pour la récurrence
        const match = p.trim().match(/^(\d{1,2})[h:](\d{2})$/);
        if (match) {
          pinTimesRaw.push(`${match[1].padStart(2, '0')}:${match[2]}`);
        }
      }
      idx++;
    } else if (word === 'quotidien' || word === 'daily') {
      recurring = 'daily';
      idx++;
    } else {
      break;
    }
  }

  const text = parts.slice(idx).join(' ').trim();
  if (!text) {
    await telegram.sendMessage(chatId, '❌ Le texte de l\'annonce est requis.');
    return;
  }

  const hasPins = pinTimes.length > 0;
  const pinScheduleJson = pinTimesRaw.length > 0 ? JSON.stringify(pinTimesRaw) : null;

  const result = await db.run(
    `INSERT INTO announcements (channel_id, message_id, type, content, pin, status, post_at, delete_at, recurring, pin_schedule, posted_by)
     VALUES (?, NULL, 'text', ?, ?, 'scheduled', ?, ?, ?, ?, ?)`,
    [channelId, text, hasPins ? 1 : 0, postTime.toISOString(), deleteTime?.toISOString() || null, recurring, pinScheduleJson, chatId.toString()]
  );
  const announcementId = result.lastID;

  for (const pinTime of pinTimes) {
    await db.run(
      `INSERT INTO scheduled_actions (announcement_id, action, execute_at, status)
       VALUES (?, 'pin', ?, 'pending')`,
      [announcementId, pinTime.toISOString()]
    );
  }

  if (deleteTime) {
    await db.run(
      `INSERT INTO scheduled_actions (announcement_id, action, execute_at, status)
       VALUES (?, 'delete', ?, 'pending')`,
      [announcementId, deleteTime.toISOString()]
    );
  }

  // Confirmation
  const fmtOpts = { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' };
  let msg = `✅ Annonce programmée !\n\n`;
  msg += `📅 Publication: <b>${postTime.toLocaleString('fr-FR', fmtOpts)}</b>\n`;
  if (pinTimes.length > 0) {
    const pinStrs = pinTimes.map(t => t.toLocaleString('fr-FR', { hour: '2-digit', minute: '2-digit' }));
    msg += `📌 Épinglages: <b>${pinStrs.join(', ')}</b>\n`;
  }
  if (deleteTime) {
    msg += `🗑 Suppression: <b>${deleteTime.toLocaleString('fr-FR', fmtOpts)}</b>\n`;
  }
  if (recurring === 'daily') {
    msg += `🔄 <b>Quotidien</b> (se répète chaque jour)\n`;
  }
  msg += `\n📝 "${text.substring(0, 80)}${text.length > 80 ? '...' : ''}"`;
  if (text.includes('{')) {
    msg += `\n🔤 Aujourd'hui: "${renderTemplate(text, new Date()).substring(0, 80)}"`;
  }
  msg += `\n\n❌ Annuler: /annulprog ${announcementId}`;

  await telegram.sendMessage(chatId, msg);
}

// Programmer suppression d'une annonce existante
async function handleScheduleDelete(chatId, args) {
  if (!args || args.length === 0) {
    await telegram.sendMessage(chatId, '❌ Usage: /supprprog <message_id> <HH:MM>');
    return;
  }

  const parts = args.split(' ');
  if (parts.length < 2) {
    await telegram.sendMessage(chatId, '❌ Usage: /supprprog <message_id> <HH:MM>');
    return;
  }

  const messageId = parseInt(parts[0]);
  if (isNaN(messageId)) {
    await telegram.sendMessage(chatId, '❌ message_id invalide.');
    return;
  }

  const deleteTime = parseTime(parts[1]);
  if (!deleteTime) {
    await telegram.sendMessage(chatId, `❌ Heure invalide: "${parts[1]}"`);
    return;
  }

  const announcement = await db.get(
    'SELECT * FROM announcements WHERE message_id = ?',
    [messageId]
  );

  if (!announcement) {
    await telegram.sendMessage(chatId, '❌ Annonce non trouvée.');
    return;
  }

  await db.run(
    'UPDATE announcements SET delete_at = ?, status = ? WHERE message_id = ?',
    [deleteTime.toISOString(), announcement.status === 'posted' ? 'posted' : announcement.status, messageId]
  );

  await telegram.sendMessage(chatId,
    `✅ Suppression programmée pour le message #${messageId}\n🗑 ${deleteTime.toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}`
  );
}

// Lister les annonces (postées + programmées)
async function handleListAnnouncements(chatId) {
  const announcements = await db.all(
    `SELECT * FROM announcements WHERE status IN ('posted', 'scheduled')
     ORDER BY CASE WHEN status = 'scheduled' THEN 0 ELSE 1 END, created_at DESC
     LIMIT 20`
  );

  if (!announcements || announcements.length === 0) {
    await telegram.sendMessage(chatId, '📭 Aucune annonce.');
    return;
  }

  let msg = '📢 <b>Annonces</b>\n\n';

  const scheduled = announcements.filter(a => a.status === 'scheduled');
  const posted = announcements.filter(a => a.status === 'posted');

  if (scheduled.length > 0) {
    msg += '⏰ <b>Programmées:</b>\n';
    for (const a of scheduled) {
      const preview = (a.content || '').substring(0, 40);
      msg += `  📅 ${formatDateTime(a.post_at)}`;
      if (a.delete_at) msg += ` → 🗑${formatDateTime(a.delete_at)}`;
      if (a.pin) msg += ' 📌';

      // Afficher les actions programmées (pins)
      const actions = await db.all(
        `SELECT * FROM scheduled_actions WHERE announcement_id = ? AND status = 'pending' ORDER BY execute_at`,
        [a.id]
      );
      const pinActions = actions.filter(ac => ac.action === 'pin');
      if (pinActions.length > 0) {
        const pinStrs = pinActions.map(ac => formatDateTime(ac.execute_at));
        msg += `\n  📌 Pins: ${pinStrs.join(', ')}`;
      }

      if (a.recurring === 'daily') msg += `\n  🔄 Quotidien`;
      msg += `\n  📝 ${preview}${(a.content || '').length > 40 ? '...' : ''}\n  ❌ /annulprog ${a.id}`;
      if (a.recurring === 'daily') msg += ` | /stopquotidien ${a.id}`;
      msg += '\n\n';
    }
  }

  if (posted.length > 0) {
    msg += '✅ <b>Publiées:</b>\n';
    for (const a of posted) {
      const preview = (a.content || '').substring(0, 40);
      msg += `  #${a.message_id} | ${formatDateTime(a.created_at)}`;
      if (a.delete_at) msg += ` → 🗑${formatDateTime(a.delete_at)}`;
      if (a.pin) msg += ' 📌';

      // Actions restantes
      const actions = await db.all(
        `SELECT * FROM scheduled_actions WHERE announcement_id = ? AND status = 'pending' ORDER BY execute_at`,
        [a.id]
      );
      if (actions.length > 0) {
        const actStrs = actions.map(ac => `${ac.action === 'pin' ? '📌' : ac.action === 'delete' ? '🗑' : ac.action}${formatDateTime(ac.execute_at)}`);
        msg += `\n  ⏰ Actions: ${actStrs.join(', ')}`;
      }

      if (a.recurring === 'daily') msg += `\n  🔄 Quotidien`;
      msg += `\n  📝 ${preview}${(a.content || '').length > 40 ? '...' : ''}\n  ➡️ /supprannonce ${a.message_id}`;
      if (a.recurring === 'daily') msg += ` | /stopquotidien ${a.id}`;
      msg += '\n\n';
    }
  }

  await telegram.sendMessage(chatId, msg);
}

// Annuler une annonce programmée
async function handleCancelScheduled(chatId, idStr) {
  const id = parseInt(idStr);
  if (isNaN(id)) {
    await telegram.sendMessage(chatId, '❌ Usage: /annulprog <id>');
    return;
  }

  const announcement = await db.get(
    'SELECT * FROM announcements WHERE id = ?',
    [id]
  );

  if (!announcement) {
    await telegram.sendMessage(chatId, '❌ Annonce non trouvée.');
    return;
  }

  // Si déjà postée, supprimer du canal aussi
  if (announcement.status === 'posted' && announcement.message_id) {
    if (announcement.pin) {
      await telegram.unpinChatMessage(announcement.channel_id, announcement.message_id);
    }
    await telegram.deleteMessage(announcement.channel_id, announcement.message_id);
  }

  // Nettoyer les actions programmées
  await db.run('DELETE FROM scheduled_actions WHERE announcement_id = ?', [id]);
  await db.run('DELETE FROM announcements WHERE id = ?', [id]);
  await telegram.sendMessage(chatId, `✅ Annonce #${id} et toutes ses actions supprimées.`);
}

// Supprimer une annonce postée
async function handleDeleteAnnouncement(chatId, messageIdStr) {
  const messageId = parseInt(messageIdStr);
  if (isNaN(messageId)) {
    await telegram.sendMessage(chatId, '❌ Usage: /supprannonce <message_id>');
    return;
  }

  const announcement = await db.get(
    'SELECT * FROM announcements WHERE message_id = ?',
    [messageId]
  );

  if (!announcement) {
    const channelId = config.telegram.channelId;
    if (channelId) {
      const deleted = await telegram.deleteMessage(channelId, messageId);
      if (deleted) {
        await telegram.sendMessage(chatId, `✅ Message ${messageId} supprimé du canal.`);
        return;
      }
    }
    await telegram.sendMessage(chatId, '❌ Annonce non trouvée.');
    return;
  }

  if (announcement.pin) {
    await telegram.unpinChatMessage(announcement.channel_id, messageId);
  }
  const deleted = await telegram.deleteMessage(announcement.channel_id, messageId);
  if (deleted) {
    await db.run('UPDATE announcements SET status = ? WHERE message_id = ?', ['deleted', messageId]);
    await telegram.sendMessage(chatId, `✅ Annonce #${messageId} supprimée du canal.`);
  } else {
    await telegram.sendMessage(chatId, '❌ Échec de la suppression (déjà supprimé ou bot pas admin).');
  }
}

// Arrêter la récurrence d'une annonce quotidienne
async function handleStopRecurring(chatId, idStr) {
  const id = parseInt(idStr);
  if (isNaN(id)) {
    await telegram.sendMessage(chatId, '❌ Usage: /stopquotidien <id>');
    return;
  }

  // Chercher l'annonce (postée ou programmée) avec récurrence
  const ann = await db.get(
    `SELECT * FROM announcements WHERE id = ? AND recurring = 'daily'`,
    [id]
  );

  if (!ann) {
    await telegram.sendMessage(chatId, '❌ Annonce quotidienne non trouvée avec cet ID.');
    return;
  }

  // Retirer la récurrence (l'annonce reste mais ne se recrée plus)
  await db.run('UPDATE announcements SET recurring = NULL WHERE id = ?', [id]);

  // Supprimer aussi les futures annonces programmées qui en découlent
  await db.run(
    `UPDATE announcements SET recurring = NULL WHERE recurring = 'daily' AND status = 'scheduled' AND content = ? AND channel_id = ?`,
    [ann.content, ann.channel_id]
  );

  await telegram.sendMessage(chatId, `✅ Récurrence quotidienne arrêtée pour l'annonce #${id}.\nL'annonce actuelle reste mais ne se répétera plus demain.`);
}

// ==================== ANNOUNCEMENT SCHEDULER ====================
// Recréer l'annonce pour le lendemain (récurrence quotidienne)
async function recreateForNextDay(ann) {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);

  // Recalculer post_at pour demain à la même heure
  const oldPostAt = new Date(ann.post_at);
  const newPostAt = new Date(tomorrow);
  newPostAt.setHours(oldPostAt.getHours(), oldPostAt.getMinutes(), 0, 0);

  // Recalculer delete_at pour demain
  let newDeleteAt = null;
  if (ann.delete_at) {
    const oldDeleteAt = new Date(ann.delete_at);
    newDeleteAt = new Date(tomorrow);
    newDeleteAt.setHours(oldDeleteAt.getHours(), oldDeleteAt.getMinutes(), 0, 0);
    // Si delete est avant post (ex: suppr 00:00 → lendemain du post)
    if (newDeleteAt <= newPostAt) {
      newDeleteAt.setDate(newDeleteAt.getDate() + 1);
    }
  }

  const result = await db.run(
    `INSERT INTO announcements (channel_id, message_id, type, content, photo_url, pin, status, post_at, delete_at, recurring, pin_schedule, posted_by)
     VALUES (?, NULL, ?, ?, ?, ?, 'scheduled', ?, ?, ?, ?, ?)`,
    [ann.channel_id, ann.type, ann.content, ann.photo_url || null, ann.pin, newPostAt.toISOString(), newDeleteAt?.toISOString() || null, ann.recurring, ann.pin_schedule || null, ann.posted_by]
  );
  const newId = result.lastID;

  // Recréer les actions programmées (pins) pour demain
  if (ann.pin_schedule) {
    try {
      const pinHours = JSON.parse(ann.pin_schedule);
      for (const timeStr of pinHours) {
        const [h, m] = timeStr.split(':').map(Number);
        const pinDate = new Date(tomorrow);
        pinDate.setHours(h, m, 0, 0);
        if (pinDate < newPostAt) {
          pinDate.setDate(pinDate.getDate() + 1);
        }
        await db.run(
          `INSERT INTO scheduled_actions (announcement_id, action, execute_at, status) VALUES (?, 'pin', ?, 'pending')`,
          [newId, pinDate.toISOString()]
        );
      }
    } catch (e) {
      console.error('❌ Error recreating pin schedule:', e.message);
    }
  }

  if (newDeleteAt) {
    await db.run(
      `INSERT INTO scheduled_actions (announcement_id, action, execute_at, status) VALUES (?, 'delete', ?, 'pending')`,
      [newId, newDeleteAt.toISOString()]
    );
  }

  console.log(`🔄 Recurring announcement recreated for ${newPostAt.toLocaleDateString('fr-FR')} (new ID: ${newId})`);
}

async function runAnnouncementScheduler() {
  const now = new Date();
  const nowISO = now.toISOString();

  // 1. Publier les annonces programmées dont l'heure est arrivée
  const toPost = await db.all(
    `SELECT * FROM announcements WHERE status = 'scheduled' AND post_at <= ?`,
    [nowISO]
  );

  for (const ann of toPost) {
    try {
      // Appliquer le template ({jour}, {mois}, {date}, etc.)
      const renderedContent = renderTemplate(ann.content || '', now);

      let result = null;
      if (ann.type === 'photo' && ann.photo_url) {
        result = await telegram.sendPhoto(ann.channel_id, ann.photo_url, renderedContent);
      } else {
        result = await telegram.sendMessage(ann.channel_id, renderedContent);
      }

      if (result && result.result) {
        const messageId = result.result.message_id;

        if (ann.pin) {
          await telegram.pinChatMessage(ann.channel_id, messageId, true);
        }

        await db.run(
          'UPDATE announcements SET status = ?, message_id = ? WHERE id = ?',
          ['posted', messageId, ann.id]
        );

        console.log(`📢 Scheduled announcement #${ann.id} posted (msg: ${messageId})${ann.recurring ? ' [récurrent]' : ''}`);

        if (ann.posted_by) {
          const recurLabel = ann.recurring === 'daily' ? ' (quotidien)' : '';
          await telegram.sendMessage(ann.posted_by,
            `📢 Annonce publiée${recurLabel} !\n📝 "${renderedContent.substring(0, 60)}${renderedContent.length > 60 ? '...' : ''}"\n📌 ID: ${messageId}`
          ).catch(() => {});
        }
      } else {
        console.error(`❌ Failed to post scheduled announcement #${ann.id}`);
      }
    } catch (err) {
      console.error(`❌ Scheduler post error for #${ann.id}:`, err.message);
    }
  }

  // 2. Exécuter les actions programmées (pin, unpin, delete)
  const pendingActions = await db.all(
    `SELECT sa.*, a.channel_id, a.message_id, a.content, a.posted_by, a.status AS ann_status, a.recurring, a.pin_schedule, a.post_at, a.delete_at, a.type, a.photo_url, a.pin AS ann_pin
     FROM scheduled_actions sa
     JOIN announcements a ON sa.announcement_id = a.id
     WHERE sa.status = 'pending' AND sa.execute_at <= ?`,
    [nowISO]
  );

  for (const action of pendingActions) {
    try {
      if (action.ann_status !== 'posted' || !action.message_id) {
        continue;
      }

      if (action.action === 'pin') {
        await telegram.pinChatMessage(action.channel_id, action.message_id, true);
        console.log(`📌 Scheduled pin: msg ${action.message_id} pinned`);
      } else if (action.action === 'unpin') {
        await telegram.unpinChatMessage(action.channel_id, action.message_id);
        console.log(`📌 Scheduled unpin: msg ${action.message_id} unpinned`);
      } else if (action.action === 'delete') {
        await telegram.unpinChatMessage(action.channel_id, action.message_id);
        await telegram.deleteMessage(action.channel_id, action.message_id);
        await db.run('UPDATE announcements SET status = ? WHERE id = ?', ['deleted', action.announcement_id]);
        console.log(`🗑 Scheduled delete: msg ${action.message_id} deleted`);

        if (action.posted_by) {
          await telegram.sendMessage(action.posted_by,
            `🗑 Annonce auto-supprimée !\n📝 "${(action.content || '').substring(0, 60)}..."`
          ).catch(() => {});
        }

        // Si récurrent → recréer pour demain
        if (action.recurring === 'daily') {
          await recreateForNextDay({
            channel_id: action.channel_id,
            type: action.type,
            content: action.content,
            photo_url: action.photo_url,
            pin: action.ann_pin,
            post_at: action.post_at,
            delete_at: action.delete_at,
            recurring: action.recurring,
            pin_schedule: action.pin_schedule,
            posted_by: action.posted_by
          });
        }
      }

      await db.run('UPDATE scheduled_actions SET status = ? WHERE id = ?', ['done', action.id]);
    } catch (err) {
      console.error(`❌ Scheduled action error #${action.id}:`, err.message);
    }
  }

  // 3. Supprimer les annonces (simple delete_at, sans scheduled_actions)
  const toDelete = await db.all(
    `SELECT * FROM announcements
     WHERE status = 'posted' AND delete_at IS NOT NULL AND delete_at <= ?
     AND id NOT IN (SELECT announcement_id FROM scheduled_actions WHERE action = 'delete' AND status IN ('pending', 'done'))`,
    [nowISO]
  );

  for (const ann of toDelete) {
    try {
      if (ann.pin && ann.message_id) {
        await telegram.unpinChatMessage(ann.channel_id, ann.message_id);
      }

      if (ann.message_id) {
        await telegram.deleteMessage(ann.channel_id, ann.message_id);
      }

      await db.run(
        'UPDATE announcements SET status = ? WHERE id = ?',
        ['deleted', ann.id]
      );

      console.log(`🗑 Auto-delete: announcement #${ann.id} (msg: ${ann.message_id}) deleted`);

      if (ann.posted_by) {
        await telegram.sendMessage(ann.posted_by,
          `🗑 Annonce auto-supprimée !\n📝 "${(ann.content || '').substring(0, 60)}..."`
        ).catch(() => {});
      }

      // Si récurrent → recréer pour demain
      if (ann.recurring === 'daily') {
        await recreateForNextDay(ann);
      }
    } catch (err) {
      console.error(`❌ Scheduler delete error for #${ann.id}:`, err.message);
    }
  }
}

// Démarrer le scheduler (vérifie toutes les 30 secondes)
function startAnnouncementScheduler() {
  setInterval(async () => {
    try {
      await runAnnouncementScheduler();
    } catch (err) {
      console.error('❌ Announcement scheduler error:', err.message);
    }
  }, 30 * 1000);
  console.log('⏰ Announcement scheduler started (30s interval)');
}

async function handleTelegramMessage(message) {
  const chatId = message.chat.id;
  const text = message.text;
  const firstName = message.from.first_name || 'Client';

  await registerTelegramClient(message);

  console.log(`💬 Message from ${chatId} (${firstName}): ${text}`);

  // Ignorer les messages sans texte (photos, stickers, etc.)
  if (!text) {
    return;
  }
  
  if (text === '🛒 Ouvrir la Boutique' || text === '🛍️ Boutique' || text === '📱 Mini-App') {
    await sendShopMessage(chatId);
    return;
  } else if (text === 'ℹ️ Info') {
    await sendInfoMessage(chatId);
    return;
  } else if (text === '📞 Contact') {
    await sendSupportMessage(chatId);
    return;
  } else if (text === '📖 Comment Commander') {
    await sendHowToOrderMessage(chatId);
    return;
  } else if (text === '🔐 Admin') {
    await sendAdminMessage(chatId);
    return;
  } else if (text === '📋 Mes Livraisons') {
    await sendDriverDeliveries(chatId);
    return;
  } else if (text === '📊 Mes Stats') {
    await sendDriverStats(chatId);
    return;
  } else if (text === '❓ Aide') {
    await sendHelpMessage(chatId);
    return;
  } else if (text === '💰 Mon Crédit') {
    await sendCreditBalance(chatId);
    return;
  } else if (text === '🎁 Parrainage') {
    await sendReferralStats(chatId);
    return;
  }

  // Vérifier si un admin a un flux conversationnel en cours (boutons du panel admin)
  if (isAdmin(chatId) && !text.startsWith('/')) {
    const handled = await handleAdminTextInput(chatId, text);
    if (handled) return;
  }

  // Commande /adminlogin <mot_de_passe> - authentification admin par mot de passe
  if (text.startsWith('/adminlogin ')) {
    const password = text.substring(12).trim();
    const isValid = await verifyAdminPassword(password);
    if (isValid) {
      sessionAdmins.add(chatId.toString());
      console.log(`✅ Admin login success for chatId ${chatId} | sessionAdmins=[${[...sessionAdmins].join(',')}]`);
      await telegram.sendMessage(chatId, `✅ Authentification réussie !`);
      // Afficher directement le panel admin bot
      await sendAdminBotPanel(chatId);
    } else {
      console.log(`❌ Admin login failed for chatId ${chatId} - wrong password`);
      await telegram.sendMessage(chatId, `❌ Mot de passe incorrect.`);
    }
    return;
  }

  if (text === '/start' || text.startsWith('/start ')) {
    await sendWelcomeMessage(chatId, firstName);
    return;
  } else if (text === '/shop' || text === '/boutique') {
    await sendShopMessage(chatId);
    return;
  } else if (text === '/admin') {
    console.log(`🔐 /admin from ${chatId} | isAdmin=${isAdmin(chatId)} | sessionAdmins=[${[...sessionAdmins].join(',')}] | envAdmins=[${getAdminChatIds().join(',')}]`);
    if (isAdmin(chatId)) {
      try {
        await sendAdminMessage(chatId);
      } catch (err) {
        console.error('❌ sendAdminMessage error:', err);
        await telegram.sendMessage(chatId, `❌ Erreur panneau admin: ${err.message}`);
      }
    } else {
      await telegram.sendMessage(chatId, `⛔ Accès refusé.\n\nTapez /adminlogin <mot_de_passe> pour vous connecter.`);
    }
    return;
  } else if (text === '/orders' || text === '/commandes') {
    await sendUserOrders(chatId);
    return;
  } else if (text === '/help' || text === '/aide') {
    await sendHelpMessage(chatId);
    return;
  } else if (text === '/meslivraisons' || text === '/livraisons') {
    await sendDriverDeliveries(chatId);
    return;
  } else if (text === '/stats') {
    await sendDriverStats(chatId);
    return;
  } else if (text === '/stop') {
    await stopUserConversations(chatId);
    return;
  } else if (text === '/zones' && isAdmin(chatId)) {
    await sendZoneStats(chatId);
    return;
  } else if (text.startsWith('/annonce ') && isAdmin(chatId)) {
    await handlePostAnnouncement(chatId, text.substring(9).trim());
    return;
  } else if (text.startsWith('/annoncepin ') && isAdmin(chatId)) {
    await handlePostAndPinAnnouncement(chatId, text.substring(12).trim());
    return;
  } else if (text.startsWith('/programmer ') && isAdmin(chatId)) {
    await handleScheduleAnnouncement(chatId, text.substring(12).trim());
    return;
  } else if (text.startsWith('/supprprog ') && isAdmin(chatId)) {
    await handleScheduleDelete(chatId, text.substring(11).trim());
    return;
  } else if (text.startsWith('/annulprog ') && isAdmin(chatId)) {
    await handleCancelScheduled(chatId, text.substring(11).trim());
    return;
  } else if (text.startsWith('/stopquotidien ') && isAdmin(chatId)) {
    await handleStopRecurring(chatId, text.substring(15).trim());
    return;
  } else if (text === '/annonces' && isAdmin(chatId)) {
    await handleListAnnouncements(chatId);
    return;
  } else if (text.startsWith('/supprannonce ') && isAdmin(chatId)) {
    await handleDeleteAnnouncement(chatId, text.substring(14).trim());
    return;
  } else if (text === '/credit' || text === '/solde') {
    await sendCreditBalance(chatId);
    return;
  } else if (text === '/parrainage' || text === '/referral') {
    await sendReferralStats(chatId);
    return;
  } else if (text === '/moncode') {
    await sendMyReferralCode(chatId);
    return;
  }

  // Détection des commandes admin utilisées par un non-admin
  const adminCommands = ['/annonce', '/annoncepin', '/programmer', '/supprprog', '/annulprog', '/stopquotidien', '/annonces', '/supprannonce', '/zones'];
  const usedAdminCmd = adminCommands.find(cmd => text === cmd || text.startsWith(cmd + ' '));
  if (usedAdminCmd && !isAdmin(chatId)) {
    console.log(`⚠️ Non-admin ${chatId} tried admin command: ${usedAdminCmd}`);
    await telegram.sendMessage(chatId,
      `⛔ Commande réservée aux administrateurs.\n\n` +
      `Tapez /adminlogin <mot_de_passe> pour vous connecter en tant qu'admin.`
    );
    return;
  }

  if (!text.startsWith('/')) {
    const driverConv = chatManager.findConversationByChatId(chatId, 'driver');
    if (driverConv) {
      await relayDriverMessage(chatId, text, driverConv);
      return;
    }

    const clientConv = chatManager.findConversationByChatId(chatId, 'client');
    if (clientConv) {
      await relayClientMessage(chatId, text, clientConv);
      return;
    }
  }
}

async function handleTelegramCallback(callback_query) {
  if (!callback_query.message || !callback_query.data) {
    console.warn('⚠️ Callback query sans message ou data, ignoré');
    if (callback_query.id) await telegram.answerCallback(callback_query.id);
    return;
  }

  const chatId = callback_query.message.chat.id;
  const data = callback_query.data;

  console.log(`🔘 Callback: ${data} from ${chatId}`);

  await telegram.answerCallback(callback_query.id);
  
  if (data === 'noop') {
    return;
  }

  // Callbacks pour crédit et parrainage
  if (data === 'show_credit') {
    await sendCreditBalance(chatId);
    return;
  } else if (data === 'show_referral_code') {
    await sendMyReferralCode(chatId);
    return;
  } else if (data === 'show_referral_stats') {
    await sendReferralStats(chatId);
    return;
  }

  if (data.startsWith('end_conv_')) {
    const orderId = parseInt(data.replace('end_conv_', ''));
    await stopConversationForOrder(chatId, orderId);
    return;
  }
  
  if (data.startsWith('chat_history_')) {
    const orderId = parseInt(data.replace('chat_history_', ''));
    await showChatHistory(chatId, orderId);
    return;
  }
  
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
    await stopConversationForOrder(chatId, parseInt(orderId));
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

  // ==================== REVIEW APPROVE/REJECT CALLBACKS ====================
  if (data.startsWith('rev_approve_')) {
    console.log(`📝 Review approve callback from ${chatId}, isAdmin: ${isAdmin(chatId)}`);
    if (!isAdmin(chatId)) {
      await telegram.sendMessage(chatId, '⚠️ Session expirée. Tapez /adminlogin <motdepasse> pour vous reconnecter.');
      return;
    }
    const reviewId = parseInt(data.replace('rev_approve_', ''));
    try {
      const review = await db.get('SELECT * FROM reviews WHERE id = ?', [reviewId]);
      if (!review) {
        await telegram.sendMessage(chatId, `⚠️ Avis #${reviewId} introuvable (déjà traité ?)`);
        return;
      }
      await db.run('UPDATE reviews SET approved = 1 WHERE id = ?', [reviewId]);
      await telegram.sendMessage(chatId, `✅ Avis #${reviewId} de "${review.name}" approuvé ! Visible par tous les clients.`);
    } catch (e) {
      console.error('Review approve error:', e);
      await telegram.sendMessage(chatId, `❌ Erreur: ${e.message}`);
    }
    return;
  }
  if (data.startsWith('rev_reject_')) {
    console.log(`📝 Review reject callback from ${chatId}, isAdmin: ${isAdmin(chatId)}`);
    if (!isAdmin(chatId)) {
      await telegram.sendMessage(chatId, '⚠️ Session expirée. Tapez /adminlogin <motdepasse> pour vous reconnecter.');
      return;
    }
    const reviewId = parseInt(data.replace('rev_reject_', ''));
    try {
      const review = await db.get('SELECT * FROM reviews WHERE id = ?', [reviewId]);
      if (!review) {
        await telegram.sendMessage(chatId, `⚠️ Avis #${reviewId} introuvable (déjà traité ?)`);
        return;
      }
      await db.run('DELETE FROM reviews WHERE id = ?', [reviewId]);
      await telegram.sendMessage(chatId, `🗑 Avis #${reviewId} de "${review.name}" refusé et supprimé.`);
    } catch (e) {
      console.error('Review reject error:', e);
      await telegram.sendMessage(chatId, `❌ Erreur: ${e.message}`);
    }
    return;
  }

  // ==================== ADMIN BOT CALLBACKS ====================
  if (!isAdmin(chatId)) return;

  if (data === 'adm_botpanel') {
    await sendAdminBotPanel(chatId);
    return;
  }
  if (data === 'adm_mainmenu') {
    clearAdminState(chatId);
    await sendAdminMessage(chatId);
    return;
  }
  if (data === 'adm_back') {
    clearAdminState(chatId);
    await sendAdminBotPanel(chatId);
    return;
  }
  if (data === 'adm_close') {
    clearAdminState(chatId);
    await telegram.sendMessage(chatId, '👋 Menu admin fermé.');
    return;
  }

  // --- Poster ---
  if (data === 'adm_post') {
    await sendChannelPicker(chatId, 'post');
    return;
  }
  if (data.startsWith('adm_ch_post_')) {
    const channel = data.replace('adm_ch_post_', '');
    setAdminState(chatId, 'post', 'text', { channel });
    await telegram.sendMessage(chatId, `📝 <b>Canal: ${channel}</b>\n\nTapez le texte de l'annonce :`, {
      reply_markup: { inline_keyboard: [[{ text: '🔙 Annuler', callback_data: 'adm_back' }]] }
    });
    return;
  }

  // --- Poster + Pin ---
  if (data === 'adm_postpin') {
    await sendChannelPicker(chatId, 'postpin');
    return;
  }
  if (data.startsWith('adm_ch_postpin_')) {
    const channel = data.replace('adm_ch_postpin_', '');
    setAdminState(chatId, 'postpin', 'text', { channel });
    await telegram.sendMessage(chatId, `📌 <b>Canal: ${channel}</b>\n\nTapez le texte de l'annonce (sera épinglée) :`, {
      reply_markup: { inline_keyboard: [[{ text: '🔙 Annuler', callback_data: 'adm_back' }]] }
    });
    return;
  }

  // --- Programmer ---
  if (data === 'adm_schedule') {
    await sendChannelPicker(chatId, 'sched');
    return;
  }
  if (data.startsWith('adm_ch_sched_')) {
    const channel = data.replace('adm_ch_sched_', '');
    setAdminState(chatId, 'schedule', 'time', { channel });
    await telegram.sendMessage(chatId, `⏰ <b>Canal: ${channel}</b>\n\nHeure de publication ? (format: <b>HH:MM</b>)`, {
      reply_markup: { inline_keyboard: [[{ text: '🔙 Annuler', callback_data: 'adm_back' }]] }
    });
    return;
  }
  if (data === 'adm_sched_pin') {
    const state = getAdminState(chatId);
    if (state && state.action === 'schedule') {
      setAdminState(chatId, 'schedule', 'pintimes', state.data);
      await telegram.sendMessage(chatId, `📌 Heures d'épinglage ? (format: <b>HH:MM,HH:MM,HH:MM</b>)`, {
        reply_markup: { inline_keyboard: [[{ text: '🔙 Annuler', callback_data: 'adm_back' }]] }
      });
    }
    return;
  }
  if (data === 'adm_sched_suppr') {
    const state = getAdminState(chatId);
    if (state && state.action === 'schedule') {
      setAdminState(chatId, 'schedule', 'deletetime', state.data);
      await telegram.sendMessage(chatId, `🗑 Heure de suppression ? (format: <b>HH:MM</b>)`, {
        reply_markup: { inline_keyboard: [[{ text: '🔙 Annuler', callback_data: 'adm_back' }]] }
      });
    }
    return;
  }
  if (data === 'adm_sched_daily') {
    const state = getAdminState(chatId);
    if (state && state.action === 'schedule') {
      state.data.recurring = 'daily';
      setAdminState(chatId, 'schedule', 'options', state.data);
      const keyboard = {
        inline_keyboard: [
          [
            { text: '📌 Ajouter pins', callback_data: 'adm_sched_pin' },
            { text: '🗑 Heure suppression', callback_data: 'adm_sched_suppr' }
          ],
          [{ text: '➡️ Passer au texte', callback_data: 'adm_sched_text' }],
          [{ text: '🔙 Annuler', callback_data: 'adm_back' }]
        ]
      };
      await telegram.sendMessage(chatId, `🔄 <b>Mode quotidien activé !</b>\n\nPlaceholders disponibles: {jour} {mois} {date} {joursemaine} {DATE}\n\nAjoutez d'autres options ou passez au texte :`, { reply_markup: keyboard });
    }
    return;
  }
  if (data === 'adm_sched_text') {
    const state = getAdminState(chatId);
    if (state && state.action === 'schedule') {
      setAdminState(chatId, 'schedule', 'content', state.data);
      let recap = `📝 <b>Récapitulatif :</b>\n`;
      recap += `📡 Canal: ${state.data.channel}\n`;
      recap += `⏰ Publication: ${state.data.postTime.toLocaleString('fr-FR', { hour: '2-digit', minute: '2-digit' })}\n`;
      if (state.data.pinTimes && state.data.pinTimes.length > 0) {
        const pinStrs = state.data.pinTimes.map(t => t.toLocaleString('fr-FR', { hour: '2-digit', minute: '2-digit' }));
        recap += `📌 Pins: ${pinStrs.join(', ')}\n`;
      }
      if (state.data.deleteTime) {
        recap += `🗑 Suppression: ${state.data.deleteTime.toLocaleString('fr-FR', { hour: '2-digit', minute: '2-digit' })}\n`;
      }
      if (state.data.recurring) recap += `🔄 Quotidien\n`;
      recap += `\n<b>Tapez le texte de l'annonce :</b>`;
      await telegram.sendMessage(chatId, recap, {
        reply_markup: { inline_keyboard: [[{ text: '🔙 Annuler', callback_data: 'adm_back' }]] }
      });
    }
    return;
  }

  // --- Liste des annonces ---
  if (data === 'adm_list') {
    await handleListAnnouncements(chatId);
    return;
  }

  // --- Supprimer annonce ---
  if (data === 'adm_delete') {
    setAdminState(chatId, 'delete', 'msgid', {});
    await telegram.sendMessage(chatId, `🗑 <b>Supprimer une annonce</b>\n\nEntrez le <b>Message ID</b> de l'annonce à supprimer :\n\n<i>(visible dans /annonces ou après publication)</i>`, {
      reply_markup: { inline_keyboard: [[{ text: '🔙 Annuler', callback_data: 'adm_back' }]] }
    });
    return;
  }

  // --- Stop quotidien ---
  if (data === 'adm_stoprecur') {
    setAdminState(chatId, 'stoprecur', 'id', {});
    await telegram.sendMessage(chatId, `⏹ <b>Arrêter une récurrence</b>\n\nEntrez l'<b>ID</b> de l'annonce quotidienne à arrêter :\n\n<i>(visible dans /annonces)</i>`, {
      reply_markup: { inline_keyboard: [[{ text: '🔙 Annuler', callback_data: 'adm_back' }]] }
    });
    return;
  }

  // --- Annuler programmée ---
  if (data === 'adm_cancel') {
    setAdminState(chatId, 'cancel', 'id', {});
    await telegram.sendMessage(chatId, `❌ <b>Annuler une annonce programmée</b>\n\nEntrez l'<b>ID</b> de l'annonce à annuler :\n\n<i>(visible dans /annonces)</i>`, {
      reply_markup: { inline_keyboard: [[{ text: '🔙 Annuler', callback_data: 'adm_back' }]] }
    });
    return;
  }

  // --- Suppr. programmée ---
  if (data === 'adm_scheddelete') {
    setAdminState(chatId, 'scheddelete', 'input', {});
    await telegram.sendMessage(chatId, `🗑⏰ <b>Programmer une suppression</b>\n\nFormat: <code>MESSAGE_ID HH:MM</code>\n\nExemple: <code>123 00:00</code>`, {
      reply_markup: { inline_keyboard: [[{ text: '🔙 Annuler', callback_data: 'adm_back' }]] }
    });
    return;
  }
}

// ==================== MESSAGES AVEC CLAVIER PERMANENT ====================

async function sendWelcomeMessage(chatId, firstName) {
  const text = `🌟 <b>Bienvenue ${firstName} chez DROGUA CENTER !</b> 🌟

Votre boutique premium accessible directement depuis Telegram.

<b>🛍️ Utilisez le menu en bas pour naviguer</b>

<b>🎁 PROGRAMME DE PARRAINAGE EXCLUSIF :</b>
💰 Gagnez 500 DA par ami parrainé !
🎉 Vos amis reçoivent 300 DA de bienvenue
👑 Débloquez des bonus VIP jusqu'à +50%

✨ <i>Programme de fidélité actif !</i>
Bénéficiez d'une remise tous les ${config.loyalty.defaultThreshold} achats.

Tapez sur les boutons ci-dessous pour commencer ! 👇`;

  const keyboard = getPermanentKeyboard(chatId);
  await telegram.sendMessage(chatId, text, { reply_markup: keyboard });
}

async function sendUserOrders(chatId) {
  try {
    const contact = await getClientContact(chatId.toString());
    if (!contact) {
      await telegram.sendMessage(chatId, '📦 Vous n\'avez pas encore de commandes.\n\nPassez votre première commande via la boutique !');
      return;
    }

    const orders = await db.all(
      'SELECT * FROM orders WHERE customer = ? ORDER BY created_at DESC LIMIT 5',
      [contact]
    );

    if (!orders || orders.length === 0) {
      await telegram.sendMessage(chatId, '📦 Vous n\'avez pas encore de commandes.\n\nPassez votre première commande via la boutique !');
      return;
    }

    const statusEmoji = {
      pending: '⏳', pending_approval: '🔍', confirmed: '✅',
      preparing: '🔧', delivering: '🚗', delivered: '✅', cancelled: '❌'
    };

    let text = '📦 <b>MES DERNIÈRES COMMANDES</b>\n\n';
    for (const order of orders) {
      const emoji = statusEmoji[order.status] || '📦';
      const date = new Date(order.created_at).toLocaleDateString('fr-FR');
      text += `${emoji} <b>#${order.id}</b> - ${date}\n`;
      text += `   Status: ${order.status} | Total: ${order.total} DA\n\n`;
    }

    await telegram.sendMessage(chatId, text);
  } catch (error) {
    console.error('Error sending user orders:', error);
    await telegram.sendMessage(chatId, '❌ Erreur lors de la récupération de vos commandes.');
  }
}

async function sendShopMessage(chatId) {
  const text = `🛍️ <b>BOUTIQUE DROGUA CENTER</b>

Cliquez sur le bouton ci-dessous pour accéder à notre catalogue complet.

💎 Livraison rapide et discrète
🔒 Paiement sécurisé
📦 Suivi de commande en temps réel
🎁 Programme de fidélité actif

<b>⏰ Horaires d'ouverture :</b>
7j/7 de 12H à 00H (minuit)

<b>✨ NOUVEAUTÉ : 2 nouveaux produits FROZEN !</b>
🍊 FF MANDARINA
🍓 FF FRUITS`;

  const keyboard = {
    inline_keyboard: [
      [{ text: '🛒 Ouvrir la Boutique', web_app: { url: `${config.webapp.url}/clear-cache.html` } }]
    ]
  };

  await telegram.sendMessage(chatId, text, { reply_markup: keyboard });
}

async function sendAdminMessage(chatId) {
  const text = `🔐 <b>PANNEAU ADMINISTRATEUR</b>\n\nChoisissez :`;
  const keyboard = {
    inline_keyboard: [
      [{ text: '🤖 Admin Bot (Annonces)', callback_data: 'adm_botpanel' }],
      [{ text: '🔐 Dashboard Web (Stats, Stock)', web_app: { url: `${config.webapp.url}/admin.html` } }]
    ]
  };
  await telegram.sendMessage(chatId, text, { reply_markup: JSON.stringify(keyboard) });
}

async function sendAdminBotPanel(chatId) {
  // Annuler tout état conversationnel en cours
  adminStates.delete(chatId.toString());

  const text = `🤖 <b>ADMIN BOT — ANNONCES</b>\n\n` +
    `Gérez vos annonces sur les canaux :\n\n` +
    `Choisissez une action :`;

  const keyboard = {
    inline_keyboard: [
      [
        { text: '📢 Poster', callback_data: 'adm_post' },
        { text: '📌 Poster + Pin', callback_data: 'adm_postpin' }
      ],
      [
        { text: '⏰ Programmer', callback_data: 'adm_schedule' },
        { text: '📋 Mes annonces', callback_data: 'adm_list' }
      ],
      [
        { text: '🗑 Supprimer annonce', callback_data: 'adm_delete' },
        { text: '⏹ Stop quotidien', callback_data: 'adm_stoprecur' }
      ],
      [
        { text: '❌ Annuler programmée', callback_data: 'adm_cancel' },
        { text: '🗑⏰ Suppr. programmée', callback_data: 'adm_scheddelete' }
      ],
      [{ text: '🔙 Retour menu admin', callback_data: 'adm_mainmenu' }]
    ]
  };

  await telegram.sendMessage(chatId, text, { reply_markup: JSON.stringify(keyboard) });
}

// ==================== ADMIN BOT - FLUX CONVERSATIONNEL ====================

function setAdminState(chatId, action, step, data = {}) {
  adminStates.set(chatId.toString(), { action, step, data, ts: Date.now() });
}

function getAdminState(chatId) {
  const state = adminStates.get(chatId.toString());
  // Expire après 5 minutes
  if (state && Date.now() - state.ts > 5 * 60 * 1000) {
    adminStates.delete(chatId.toString());
    return null;
  }
  return state || null;
}

function clearAdminState(chatId) {
  adminStates.delete(chatId.toString());
}

async function sendChannelPicker(chatId, action) {
  const keyboard = {
    inline_keyboard: [
      [{ text: '📢 Principal', callback_data: `adm_ch_${action}_principal` }],
      [{ text: '📸 Photo', callback_data: `adm_ch_${action}_photo` }],
      [{ text: '🆘 Secours', callback_data: `adm_ch_${action}_secours` }],
      [{ text: '🔙 Retour', callback_data: 'adm_back' }]
    ]
  };
  await telegram.sendMessage(chatId, '📡 <b>Sur quel canal ?</b>', { reply_markup: JSON.stringify(keyboard) });
}

async function handleAdminTextInput(chatId, text) {
  const state = getAdminState(chatId);
  if (!state) return false;

  const { action, step, data } = state;

  // === POSTER UNE ANNONCE ===
  if (action === 'post' && step === 'text') {
    clearAdminState(chatId);
    const channelId = resolveChannelId(data.channel === 'principal' ? null : data.channel);
    if (!channelId) {
      await telegram.sendMessage(chatId, `❌ Canal "${data.channel}" non configuré.`);
      return true;
    }
    const result = await telegram.sendMessage(channelId, text);
    if (!result || !result.result) {
      await telegram.sendMessage(chatId, '❌ Échec de l\'envoi. Vérifiez que le bot est admin du canal.');
      return true;
    }
    const messageId = result.result.message_id;
    await db.run(
      `INSERT INTO announcements (channel_id, message_id, type, content, posted_by, status) VALUES (?, ?, 'text', ?, ?, 'posted')`,
      [channelId, messageId, text, chatId.toString()]
    );
    const label = data.channel === 'principal' ? '' : ` (${data.channel})`;
    await telegram.sendMessage(chatId, `✅ Annonce publiée${label} !\n📝 Message ID: ${messageId}\n\n🗑 /supprannonce ${messageId}`, {
      reply_markup: { inline_keyboard: [[{ text: '🔙 Menu Admin', callback_data: 'adm_back' }]] }
    });
    return true;
  }

  // === POSTER + ÉPINGLER ===
  if (action === 'postpin' && step === 'text') {
    clearAdminState(chatId);
    const channelId = resolveChannelId(data.channel === 'principal' ? null : data.channel);
    if (!channelId) {
      await telegram.sendMessage(chatId, `❌ Canal "${data.channel}" non configuré.`);
      return true;
    }
    const result = await telegram.sendMessage(channelId, text);
    if (!result || !result.result) {
      await telegram.sendMessage(chatId, '❌ Échec de l\'envoi.');
      return true;
    }
    const messageId = result.result.message_id;
    await telegram.pinChatMessage(channelId, messageId, true);
    await db.run(
      `INSERT INTO announcements (channel_id, message_id, type, content, pin, posted_by, status) VALUES (?, ?, 'text', ?, 1, ?, 'posted')`,
      [channelId, messageId, text, chatId.toString()]
    );
    const label = data.channel === 'principal' ? '' : ` (${data.channel})`;
    await telegram.sendMessage(chatId, `✅ Annonce publiée et épinglée${label} !\n📌 Message ID: ${messageId}\n\n🗑 /supprannonce ${messageId}`, {
      reply_markup: { inline_keyboard: [[{ text: '🔙 Menu Admin', callback_data: 'adm_back' }]] }
    });
    return true;
  }

  // === PROGRAMMER - ÉTAPE HEURE ===
  if (action === 'schedule' && step === 'time') {
    const postTime = parseTime(text.trim());
    if (!postTime) {
      await telegram.sendMessage(chatId, `❌ Heure invalide: "${text}". Format: <b>HH:MM</b> ou <b>HHhMM</b>\n\nRéessayez :`);
      return true;
    }
    data.postTime = postTime;
    setAdminState(chatId, 'schedule', 'options', data);
    const keyboard = {
      inline_keyboard: [
        [
          { text: '📌 Ajouter pins', callback_data: 'adm_sched_pin' },
          { text: '🗑 Heure suppression', callback_data: 'adm_sched_suppr' }
        ],
        [
          { text: '🔄 Quotidien', callback_data: 'adm_sched_daily' },
          { text: '➡️ Passer au texte', callback_data: 'adm_sched_text' }
        ],
        [{ text: '🔙 Annuler', callback_data: 'adm_back' }]
      ]
    };
    const timeStr = postTime.toLocaleString('fr-FR', { hour: '2-digit', minute: '2-digit' });
    await telegram.sendMessage(chatId, `⏰ Publication à <b>${timeStr}</b>\n\nAjoutez des options ou passez au texte :`, { reply_markup: keyboard });
    return true;
  }

  // === PROGRAMMER - HEURES PIN ===
  if (action === 'schedule' && step === 'pintimes') {
    const pinParts = text.split(',');
    const pinTimes = [];
    const pinTimesRaw = [];
    for (const p of pinParts) {
      const t = parseTime(p.trim());
      if (!t) {
        await telegram.sendMessage(chatId, `❌ Heure invalide: "${p.trim()}". Réessayez (format: HH:MM,HH:MM) :`);
        return true;
      }
      if (t < data.postTime) t.setDate(t.getDate() + 1);
      pinTimes.push(t);
      const match = p.trim().match(/^(\d{1,2})[h:](\d{2})$/);
      if (match) pinTimesRaw.push(`${match[1].padStart(2, '0')}:${match[2]}`);
    }
    data.pinTimes = pinTimes;
    data.pinTimesRaw = pinTimesRaw;
    setAdminState(chatId, 'schedule', 'options', data);
    const pinStrs = pinTimes.map(t => t.toLocaleString('fr-FR', { hour: '2-digit', minute: '2-digit' }));
    const keyboard = {
      inline_keyboard: [
        [
          { text: '📌 Modifier pins', callback_data: 'adm_sched_pin' },
          { text: '🗑 Heure suppression', callback_data: 'adm_sched_suppr' }
        ],
        [
          { text: '🔄 Quotidien', callback_data: 'adm_sched_daily' },
          { text: '➡️ Passer au texte', callback_data: 'adm_sched_text' }
        ],
        [{ text: '🔙 Annuler', callback_data: 'adm_back' }]
      ]
    };
    await telegram.sendMessage(chatId, `📌 Pins: <b>${pinStrs.join(', ')}</b>\n\nAjoutez d'autres options ou passez au texte :`, { reply_markup: keyboard });
    return true;
  }

  // === PROGRAMMER - HEURE SUPPRESSION ===
  if (action === 'schedule' && step === 'deletetime') {
    const deleteTime = parseTime(text.trim());
    if (!deleteTime) {
      await telegram.sendMessage(chatId, `❌ Heure invalide: "${text}". Réessayez (format: HH:MM) :`);
      return true;
    }
    if (deleteTime <= data.postTime) deleteTime.setDate(deleteTime.getDate() + 1);
    data.deleteTime = deleteTime;
    setAdminState(chatId, 'schedule', 'options', data);
    const timeStr = deleteTime.toLocaleString('fr-FR', { hour: '2-digit', minute: '2-digit' });
    const keyboard = {
      inline_keyboard: [
        [
          { text: '📌 Ajouter pins', callback_data: 'adm_sched_pin' },
          { text: '🗑 Modifier suppr.', callback_data: 'adm_sched_suppr' }
        ],
        [
          { text: '🔄 Quotidien', callback_data: 'adm_sched_daily' },
          { text: '➡️ Passer au texte', callback_data: 'adm_sched_text' }
        ],
        [{ text: '🔙 Annuler', callback_data: 'adm_back' }]
      ]
    };
    await telegram.sendMessage(chatId, `🗑 Suppression à <b>${timeStr}</b>\n\nAjoutez d'autres options ou passez au texte :`, { reply_markup: keyboard });
    return true;
  }

  // === PROGRAMMER - TEXTE FINAL ===
  if (action === 'schedule' && step === 'content') {
    clearAdminState(chatId);
    const channelId = resolveChannelId(data.channel === 'principal' ? null : data.channel);
    const hasPins = data.pinTimes && data.pinTimes.length > 0;
    const pinScheduleJson = data.pinTimesRaw && data.pinTimesRaw.length > 0 ? JSON.stringify(data.pinTimesRaw) : null;

    const result = await db.run(
      `INSERT INTO announcements (channel_id, message_id, type, content, pin, status, post_at, delete_at, recurring, pin_schedule, posted_by)
       VALUES (?, NULL, 'text', ?, ?, 'scheduled', ?, ?, ?, ?, ?)`,
      [channelId, text, hasPins ? 1 : 0, data.postTime.toISOString(), data.deleteTime?.toISOString() || null, data.recurring || null, pinScheduleJson, chatId.toString()]
    );
    const announcementId = result.lastID;

    if (data.pinTimes) {
      for (const pinTime of data.pinTimes) {
        await db.run(`INSERT INTO scheduled_actions (announcement_id, action, execute_at, status) VALUES (?, 'pin', ?, 'pending')`, [announcementId, pinTime.toISOString()]);
      }
    }
    if (data.deleteTime) {
      await db.run(`INSERT INTO scheduled_actions (announcement_id, action, execute_at, status) VALUES (?, 'delete', ?, 'pending')`, [announcementId, data.deleteTime.toISOString()]);
    }

    const fmtOpts = { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' };
    let msg = `✅ <b>Annonce programmée !</b>\n\n`;
    msg += `📅 Publication: <b>${data.postTime.toLocaleString('fr-FR', fmtOpts)}</b>\n`;
    if (data.pinTimes && data.pinTimes.length > 0) {
      const pinStrs = data.pinTimes.map(t => t.toLocaleString('fr-FR', { hour: '2-digit', minute: '2-digit' }));
      msg += `📌 Pins: <b>${pinStrs.join(', ')}</b>\n`;
    }
    if (data.deleteTime) {
      msg += `🗑 Suppression: <b>${data.deleteTime.toLocaleString('fr-FR', fmtOpts)}</b>\n`;
    }
    if (data.recurring) msg += `🔄 <b>Quotidien</b>\n`;
    msg += `\n📝 "${text.substring(0, 80)}${text.length > 80 ? '...' : ''}"`;
    if (text.includes('{')) msg += `\n🔤 Rendu: "${renderTemplate(text, new Date()).substring(0, 80)}"`;
    msg += `\n\n❌ /annulprog ${announcementId}`;

    await telegram.sendMessage(chatId, msg, {
      reply_markup: { inline_keyboard: [[{ text: '🔙 Menu Admin', callback_data: 'adm_back' }]] }
    });
    return true;
  }

  // === SUPPRIMER ANNONCE ===
  if (action === 'delete' && step === 'msgid') {
    clearAdminState(chatId);
    await handleDeleteAnnouncement(chatId, text.trim());
    return true;
  }

  // === ANNULER PROGRAMMÉE ===
  if (action === 'cancel' && step === 'id') {
    clearAdminState(chatId);
    await handleCancelScheduled(chatId, text.trim());
    return true;
  }

  // === STOP QUOTIDIEN ===
  if (action === 'stoprecur' && step === 'id') {
    clearAdminState(chatId);
    await handleStopRecurring(chatId, text.trim());
    return true;
  }

  // === SUPPR PROGRAMMÉE ===
  if (action === 'scheddelete' && step === 'input') {
    clearAdminState(chatId);
    await handleScheduleDelete(chatId, text.trim());
    return true;
  }

  return false;
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

async function sendHowToOrderMessage(chatId) {
  const text = `📖 <b>COMMENT COMMANDER ?</b>

<b>🛒 C'est très simple :</b>

<b>1️⃣ Ouvrir la Boutique</b>
   • Cliquez sur "🛒 Ouvrir la Boutique"
   • Parcourez notre catalogue

<b>2️⃣ Ajouter au Panier</b>
   • Sélectionnez vos produits
   • Choisissez les quantités
   • Vérifiez votre panier

<b>3️⃣ Choisir la Livraison</b>
   • 🏠 Millau (gratuit)
   • 🌍 Extérieur (+20€)

<b>4️⃣ Confirmer</b>
   • Entrez votre adresse
   • Validez la commande
   • Vous serez contacté par notre équipe

<b>💰 Paiement :</b>
Espèces à la livraison

<b>🎁 Programme Fidélité :</b>
Remise automatique tous les ${config.loyalty.defaultThreshold} achats !

<b>⏰ Horaires :</b>
7j/7 de 12H à 00H (minuit)

Des questions ? Contactez le support ! 💬`;

  const keyboard = {
    inline_keyboard: [
      [{ text: '🛒 Commander Maintenant', web_app: { url: config.webapp.url } }],
      [
        { text: '💬 Support', url: 'https://t.me/assistancenter' },
        { text: 'ℹ️ Plus d\'infos', callback_data: 'show_info' }
      ]
    ]
  };
  
  await telegram.sendMessage(chatId, text, { reply_markup: keyboard });
}

// ==================== FONCTIONS CRÉDIT & PARRAINAGE ====================
async function sendCreditBalance(chatId) {
  try {
    // Récupérer le contact client depuis telegram_clients
    const client = await db.get(
      'SELECT contact FROM telegram_clients WHERE telegram_id = ?',
      [chatId.toString()]
    );

    if (!client || !client.contact) {
      const text = `💰 <b>MON CRÉDIT</b>

❌ <b>Aucun crédit disponible</b>

Pour obtenir du crédit, passez une commande et utilisez un code de parrainage, ou parrainez vos amis !

<b>🎁 Comment gagner du crédit ?</b>
1️⃣ Utilisez un code ami lors de votre première commande → <b>300 DA</b>
2️⃣ Parrainez des amis et gagnez <b>500 DA</b> par filleul !
3️⃣ Débloquez des bonus VIP jusqu'à <b>+50%</b> !

Tapez /parrainage pour voir votre code personnel 🚀`;

      await telegram.sendMessage(chatId, text);
      return;
    }

    // Récupérer les stats de parrainage
    const stats = await getReferralStats(client.contact);

    if (!stats) {
      const text = `💰 <b>MON CRÉDIT</b>

<b>Solde actuel :</b> 0 DA

Pour obtenir du crédit, parrainez vos amis ou utilisez un code ami lors de votre commande !

Tapez /parrainage pour voir votre code personnel 🚀`;

      await telegram.sendMessage(chatId, text);
      return;
    }

    // Calculer le palier VIP
    const totalReferrals = stats.totalReferrals || 0;
    let vipTier = 'Bronze 🥉';
    let vipBonus = 0;

    if (totalReferrals >= 10) {
      vipTier = 'Diamant 💎';
      vipBonus = 50;
    } else if (totalReferrals >= 6) {
      vipTier = 'Or 🥇';
      vipBonus = 20;
    } else if (totalReferrals >= 3) {
      vipTier = 'Argent 🥈';
      vipBonus = 10;
    }

    const text = `💰 <b>MON CRÉDIT</b>

<b>💵 Solde disponible :</b> <b>${stats.creditBalance.toFixed(0)} DA</b>

<b>👑 Palier VIP :</b> ${vipTier}
<b>⚡ Bonus actuel :</b> +${vipBonus}%

<b>📊 Statistiques :</b>
• Total gagné : ${stats.totalEarned.toFixed(0)} DA
• Parrainages réussis : ${totalReferrals}

<b>💡 Utilisation :</b>
Votre crédit sera automatiquement proposé lors de votre prochaine commande sur la boutique !

🎁 Parrainez plus d'amis pour débloquer de meilleurs bonus VIP !`;

    const keyboard = {
      inline_keyboard: [
        [{ text: '🎁 Voir Mon Code Parrainage', callback_data: 'show_referral_code' }],
        [{ text: '🛒 Commander', web_app: { url: config.webapp.url } }]
      ]
    };

    await telegram.sendMessage(chatId, text, { reply_markup: keyboard });
  } catch (error) {
    console.error('Error sending credit balance:', error);
    await telegram.sendMessage(chatId, '❌ Erreur lors de la récupération de votre crédit. Réessayez plus tard.');
  }
}

async function sendReferralStats(chatId) {
  try {
    // Récupérer le contact client
    const client = await db.get(
      'SELECT contact FROM telegram_clients WHERE telegram_id = ?',
      [chatId.toString()]
    );

    if (!client || !client.contact) {
      const text = `🎁 <b>PROGRAMME DE PARRAINAGE</b>

❌ <b>Pas encore de code parrainage</b>

Pour obtenir votre code personnel, passez votre première commande sur la boutique !

<b>💰 Comment ça marche ?</b>
1️⃣ Vous parrainez un ami → Vous gagnez <b>500 DA</b>
2️⃣ Votre ami reçoit <b>300 DA</b> de bienvenue
3️⃣ Plus vous parrainez, plus vous gagnez de bonus !

<b>🏆 Paliers VIP :</b>
🥉 Bronze : 0% bonus (départ)
🥈 Argent : +10% bonus (3 parrainages)
🥇 Or : +20% bonus (6 parrainages)
💎 Diamant : +50% bonus (10 parrainages)

Commandez maintenant pour débloquer votre code ! 🚀`;

      const keyboard = {
        inline_keyboard: [
          [{ text: '🛒 Commander', web_app: { url: config.webapp.url } }]
        ]
      };

      await telegram.sendMessage(chatId, text, { reply_markup: keyboard });
      return;
    }

    // Récupérer les stats
    const stats = await getReferralStats(client.contact);

    if (!stats) {
      await sendMyReferralCode(chatId);
      return;
    }

    // Calculer VIP
    const totalReferrals = stats.totalReferrals || 0;
    let vipTier = 'Bronze 🥉';
    let vipBonus = 0;
    let nextTier = 'Argent 🥈';
    let nextTierCount = 3;

    if (totalReferrals >= 10) {
      vipTier = 'Diamant 💎';
      vipBonus = 50;
      nextTier = 'Maximum atteint';
      nextTierCount = totalReferrals;
    } else if (totalReferrals >= 6) {
      vipTier = 'Or 🥇';
      vipBonus = 20;
      nextTier = 'Diamant 💎';
      nextTierCount = 10;
    } else if (totalReferrals >= 3) {
      vipTier = 'Argent 🥈';
      vipBonus = 10;
      nextTier = 'Or 🥇';
      nextTierCount = 6;
    }

    const progressText = nextTier === 'Maximum atteint'
      ? '🏆 Palier maximum atteint !'
      : `${totalReferrals}/${nextTierCount} pour ${nextTier}`;

    const text = `🎁 <b>MON PARRAINAGE</b>

<b>🔑 Votre code personnel :</b>
<code>${stats.code}</code>

<b>👑 Palier VIP :</b> ${vipTier}
<b>⚡ Bonus actuel :</b> +${vipBonus}%
<b>📈 Progression :</b> ${progressText}

<b>📊 Statistiques :</b>
• Parrainages réussis : ${totalReferrals}
• Total gagné : ${stats.totalEarned.toFixed(0)} DA
• Crédit disponible : ${stats.creditBalance.toFixed(0)} DA

<b>💰 Gains par parrainage :</b>
Base : 500 DA + ${vipBonus}% bonus = <b>${Math.floor(500 * (1 + vipBonus/100))} DA</b>

<b>🚀 Partagez votre code :</b>
Vos amis gagneront 300 DA en l'utilisant lors de leur première commande !

Plus vous parrainez, plus vos bonus augmentent ! 💪`;

    const shareText = encodeURIComponent(`🎉 Commande sur DROGUA CENTER et reçois 300 DA de crédit !\n\n🎁 Utilise mon code : ${stats.code}\n\n💰 Profite de réductions et de la roue de la fortune !\n\n👉 ${config.webapp.url}`);

    const keyboard = {
      inline_keyboard: [
        [{ text: '📤 Partager sur WhatsApp', url: `https://wa.me/?text=${shareText}` }],
        [{ text: '📤 Partager sur Telegram', url: `https://t.me/share/url?url=${encodeURIComponent(config.webapp.url)}&text=${shareText}` }],
        [{ text: '💰 Voir Mon Crédit', callback_data: 'show_credit' }]
      ]
    };

    await telegram.sendMessage(chatId, text, { reply_markup: keyboard });
  } catch (error) {
    console.error('Error sending referral stats:', error);
    await telegram.sendMessage(chatId, '❌ Erreur lors de la récupération de vos stats. Réessayez plus tard.');
  }
}

async function sendMyReferralCode(chatId) {
  try {
    const client = await db.get(
      'SELECT contact FROM telegram_clients WHERE telegram_id = ?',
      [chatId.toString()]
    );

    if (!client || !client.contact) {
      await telegram.sendMessage(chatId, '❌ Passez d\'abord une commande pour obtenir votre code personnel !');
      return;
    }

    // Créer ou récupérer le code
    const referral = await getOrCreateReferralCode(client.contact, 0);

    const text = `🎁 <b>VOTRE CODE PARRAINAGE</b>

<b>🔑 Code personnel :</b>
<code>${referral}</code>

<b>💰 Partagez et gagnez :</b>
• Vous : 500 DA par parrainage
• Votre ami : 300 DA de bienvenue

<b>🏆 Débloquez des bonus VIP :</b>
Plus vous parrainez, plus vos gains augmentent !

Partagez dès maintenant ! 🚀`;

    const shareText = encodeURIComponent(`🎉 Commande sur DROGUA CENTER et reçois 300 DA !\n\n🎁 Code : ${referral}\n\n👉 ${config.webapp.url}`);

    const keyboard = {
      inline_keyboard: [
        [{ text: '📤 Partager', url: `https://wa.me/?text=${shareText}` }],
        [{ text: '📊 Voir Mes Stats', callback_data: 'show_referral_stats' }]
      ]
    };

    await telegram.sendMessage(chatId, text, { reply_markup: keyboard });
  } catch (error) {
    console.error('Error sending referral code:', error);
    await telegram.sendMessage(chatId, '❌ Erreur. Réessayez plus tard.');
  }
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

async function showDeliveryTimeOptions(chatId, orderId) {
  const conv = chatManager.getConversation(parseInt(orderId));
  
  if (!conv) {
    const order = await db.get('SELECT * FROM orders WHERE id = ?', [orderId]);
    if (!order) {
      await telegram.sendMessage(chatId, '❌ Commande introuvable');
      return;
    }
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
  const order = await db.get('SELECT * FROM orders WHERE id = ?', [orderId]);
  
  if (!order) {
    await telegram.sendMessage(chatId, '❌ Commande introuvable');
    return;
  }
  
  let clientTelegramId = order.client_telegram_id;
  
  if (!clientTelegramId) {
    clientTelegramId = await getClientTelegramId(order.customer);
  }
  
  if (!clientTelegramId) {
    await telegram.sendMessage(chatId, 
      `⚠️ <b>Client non disponible sur Telegram</b>

Le client n'a pas encore interagi avec le bot.

<b>📱 Options :</b>
1. Le support transmettra vos messages
2. Attendez que le client démarre le bot

<b>💡 Conseil :</b>
Demandez au support de dire au client d'ouvrir le bot Telegram.`
    );
    
    if (config.telegram.supportChatId) {
      await telegram.sendMessage(config.telegram.supportChatId,
        `⚠️ Livreur tente de contacter client

Commande #${orderId}
Client: ${order.customer}

👉 Dites au client d'ouvrir le bot Telegram pour activer le chat direct.`
      );
    }
    return;
  }
  
  let conv = chatManager.getConversation(parseInt(orderId));
  if (!conv) {
    chatManager.createConversation(parseInt(orderId), chatId.toString(), clientTelegramId);
    conv = chatManager.getConversation(parseInt(orderId));
  }
  
  await chatManager.activateDriver(parseInt(orderId));
  
  const driverMessage = `💬 <b>CHAT DIRECT ACTIVÉ</b>

📦 Commande #${orderId}
🔒 Communication sécurisée et anonyme

✅ <b>Vous pouvez maintenant discuter avec le client</b>

Tapez simplement votre message ci-dessous, il sera transmis instantanément.

<b>💡 Exemples de messages :</b>
• "Je pars maintenant, j'arrive dans 10 minutes"
• "Je suis devant, quel bâtiment?"
• "Je ne trouve pas l'adresse, pouvez-vous m'aider?"

<b>📱 Le client recevra une notification</b> pour chaque message.

Pour fermer : /stop ou utilisez le bouton ci-dessous`;

  const keyboard = {
    inline_keyboard: [
      [{ text: '📜 Voir historique', callback_data: `chat_history_${orderId}` }],
      [{ text: '❌ Fermer conversation', callback_data: `stop_conversation_${orderId}` }]
    ]
  };
  
  await telegram.sendMessage(chatId, driverMessage, { reply_markup: keyboard });
  
  const clientMessage = `📱 <b>Votre livreur souhaite vous contacter</b>

📦 Commande #${orderId}
🚚 Livraison en cours

💬 <b>Chat direct activé !</b>

Votre livreur peut maintenant vous envoyer des messages pour faciliter la livraison.

✅ <b>Vous pouvez lui répondre directement</b> en tapant votre message.

<i>⏳ En attente du premier message...</i>`;

  const clientKeyboard = {
    inline_keyboard: [
      [{ text: '✍️ Prêt à discuter', callback_data: 'noop' }]
    ]
  };
  
  try {
    await telegram.sendMessage(clientTelegramId, clientMessage, { 
      reply_markup: clientKeyboard 
    });
    
    await chatManager.activateClient(parseInt(orderId));
  } catch (error) {
    console.error('Cannot notify client:', error);
    await telegram.sendMessage(chatId, 
      '⚠️ Impossible de notifier le client. Le support va le contacter.'
    );
  }
}

async function completeDelivery(chatId, orderId) {
  const order = await db.get('SELECT * FROM orders WHERE id = ?', [orderId]);
  
  if (!order) {
    await telegram.sendMessage(chatId, '❌ Commande introuvable');
    return;
  }
  
  await db.run('UPDATE orders SET status = ? WHERE id = ?', ['delivered', orderId]);
  
  const conv = chatManager.getConversation(parseInt(orderId));
  if (conv) {
    try {
      await telegram.sendMessage(conv.clientTelegramId, 
        `✅ <b>Livraison terminée !</b>

📦 Commande #${orderId} livrée avec succès

💚 Merci pour votre confiance !
La conversation est maintenant fermée.

N'hésitez pas à recommander ! 🛒`
      );
    } catch (e) {}
    
    chatManager.closeConversation(parseInt(orderId));
  }
  
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
  
  if (getAdminChatIds().length > 0) {
    const adminMsg = `✅ <b>LIVRAISON TERMINÉE #${orderId}</b>

👤 Client: ${order.customer}
📍 ${order.address}
💰 À récupérer : ${order.total}€

🚚 Livreur: ${order.assigned_driver_zone}
⏰ Terminée: ${new Date().toLocaleString('fr-FR')}`;

    await notifyAdmins(adminMsg);
  }
  
  await notifyClientViaSupport(order.customer, orderId, 'delivered');
}

async function refuseDelivery(chatId, orderId) {
  await db.run('UPDATE orders SET status = ? WHERE id = ?', ['cancelled', orderId]);
  chatManager.closeConversation(parseInt(orderId));
  
  if (getAdminChatIds().length > 0) {
    await notifyAdmins(`❌ Livraison #${orderId} refusée par le livreur`);
  }
  
  await telegram.sendMessage(chatId, '❌ Livraison refusée');
}

async function approveCustomerFromTelegram(chatId, orderId) {
  if (!isAdmin(chatId)) {
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
  if (!isAdmin(chatId)) {
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
    
    for (const [convOrderId, conv] of chatManager.activeConversations.entries()) {
      const convOrder = await db.get('SELECT customer FROM orders WHERE id = ?', [convOrderId]);
      if (convOrder && convOrder.customer === contact) {
        chatManager.closeConversation(convOrderId);
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
  if (!isAdmin(chatId)) {
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
    
    await telegram.sendMessage(chatId, message);
  } catch (error) {
    console.error('Send order customer details error:', error);
    await telegram.sendMessage(chatId, '❌ Erreur lors de la récupération des détails');
  }
}

app.get('*', (req, res) => {
  // Headers pour empêcher le cache (important pour Telegram WebApp)
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

async function start() {
  try {
    await initAdminPassword();
    await initDB();
    
    app.listen(PORT, async () => {
      console.log('🚀 ================================');
      console.log(`   Server running on port ${PORT}`);
      console.log('🚀 ================================');
      console.log(`📱 Frontend: http://localhost:${PORT}`);
      console.log(`🔐 Admin: http://localhost:${PORT}/admin.html`);

      if (!config.telegram.token) {
        console.log('⚠️  TELEGRAM_TOKEN not set - bot disabled');
      } else {
        console.log('✅ Telegram bot enabled');
        const webhookUrl = `${config.webapp.url}/telegram-webhook`;
        console.log(`🔗 Webhook: ${webhookUrl}`);

        // Toujours enregistrer le webhook au démarrage
        console.log('📡 Enregistrement du webhook...');
        await telegram.setWebhook(webhookUrl);
        console.log('✅ Webhook enregistré');

        // Configurer les commandes du bot (bouton Menu dans Telegram)
        await telegram.setMyCommands([
          { command: 'start', description: 'Démarrer / Accueil' },
          { command: 'shop', description: 'Voir la boutique' },
          { command: 'orders', description: 'Mes commandes' },
          { command: 'help', description: 'Aide' }
        ]);
        console.log('✅ Bot commands configured (Menu button)');
      }

      console.log('');
      console.log('📍 Configuration status:');
      console.log(`   Support: ${config.telegram.supportChatId ? '✅' : '❌'}`);
      console.log(`   Admin(s): ${getAdminChatIds().length > 0 ? '✅ (' + getAdminChatIds().length + ')' : '❌'}`);
      console.log(`   Driver Millau: ${config.telegram.driverMillauId ? '✅' : '❌'}`);
      console.log(`   Driver Extérieur: ${config.telegram.driverExterieurId ? '✅' : '❌'}`);
      console.log(`   Mapbox: ${config.mapbox.key ? '✅' : '❌'}`);
      console.log(`   Canal Principal: ${config.telegram.channelId ? '✅' : '❌'}`);
      console.log(`   Canal Photo: ${config.telegram.photoChannelId ? '✅' : '❌'}`);
      console.log(`   Canal Secours: ${config.telegram.secoursChannelId ? '✅' : '❌'}`);
      console.log('💬 Chat System: ✅ Enabled');

      // Démarrer le scheduler d'annonces
      startAnnouncementScheduler();

      console.log('🚀 ================================');
    });
  } catch (error) {
    console.error('❌ Server start error:', error);
    process.exit(1);
  }
}

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  console.error('❌ Uncaught Exception:', error.message);
  console.error(error.stack);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Unhandled Rejection at:', promise);
  console.error('❌ Reason:', reason);
});

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
