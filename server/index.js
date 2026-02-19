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

const fs = require('fs');

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
    tokenExpiry: 2 * 60 * 60 * 1000, // 2 heures
  },
  webapp: {
    url: process.env.WEBAPP_URL || 'https://shop-2-production-2d5f.up.railway.app',
  },
  loyalty: {
    defaultThreshold: 10,
    fixedDiscount: 10,
  },
  deliveryZones: {
    millau: {
      name: 'Millau',
      keywords: ['millau'],
      driverIdKey: 'driverMillauId',
    },
    exterieur: {
      name: 'Extérieur',
      keywords: ['extérieur', 'exterieur', 'zone 1', 'zone 2', 'zone 3', 'zone 4'],
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

if (!process.env.TELEGRAM_WEBHOOK_SECRET) {
  console.warn('⚠️  TELEGRAM_WEBHOOK_SECRET non défini !');
  console.warn('   Les webhooks pourraient échouer après un redémarrage.');
  console.warn('   Générez un secret: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
}

// ==================== SECURITY MIDDLEWARE ====================
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "https://api.mapbox.com", "https://cdn.jsdelivr.net", "https://cdnjs.cloudflare.com", "https://telegram.org"],
      scriptSrcAttr: ["'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://api.mapbox.com", "https://fonts.googleapis.com"],
      imgSrc: ["'self'", "data:", "blob:", "https://api.mapbox.com", "https://api.telegram.org"],
      connectSrc: ["'self'", "https://api.mapbox.com", "https://events.mapbox.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      frameSrc: ["'none'"],
      objectSrc: ["'none'"],
    },
  },
}));

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 500,
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
const allowedOrigins = [config.webapp.url];
if (process.env.NODE_ENV !== 'production') {
  allowedOrigins.push('http://localhost:3000');
}
app.use(cors({
  origin: allowedOrigins,
  credentials: true
}));
app.use(express.json({ limit: '10mb' }));

// Logger les requêtes POST (sans données sensibles)
const SENSITIVE_PATHS = ['/api/admin/login', '/telegram-webhook', '/adminlogin'];
app.use((req, res, next) => {
  if (req.method === 'POST') {
    const isSensitive = SENSITIVE_PATHS.some(p => req.path.includes(p));
    if (isSensitive) {
      console.log(`📨 POST ${req.path} - [body masqué]`);
    } else {
      console.log(`📨 POST ${req.path}`);
    }
  }
  next();
});

// Pas de cache pour les fichiers HTML (éviter les versions périmées dans Telegram WebApp)
app.use((req, res, next) => {
  if (req.path.endsWith('.html') || req.path === '/') {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.setHeader('Surrogate-Control', 'no-store');
  }
  next();
});

// Route dédiée pour admin.html avec cache-busting (Telegram WebApp cache agressivement)
app.get('/admin.html', (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('Surrogate-Control', 'no-store');
  res.setHeader('ETag', `"${Date.now()}"`);
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
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

// ==================== TELEGRAM INITDATA VALIDATION ====================
// Valide les données signées du Telegram Mini App pour authentifier les utilisateurs
function validateTelegramInitData(initData) {
  if (!initData || !config.telegram.token) return null;

  try {
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    if (!hash) return null;

    // Construire la chaîne de vérification (tous les params sauf hash, triés alphabétiquement)
    const checkParams = [];
    for (const [key, value] of params.entries()) {
      if (key !== 'hash') checkParams.push(`${key}=${value}`);
    }
    checkParams.sort();
    const dataCheckString = checkParams.join('\n');

    // HMAC-SHA256 avec "WebAppData" + bot token
    const secretKey = crypto.createHmac('sha256', 'WebAppData').update(config.telegram.token).digest();
    const computedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

    // Comparaison en temps constant pour éviter les timing attacks
    if (!crypto.timingSafeEqual(Buffer.from(computedHash, 'hex'), Buffer.from(hash, 'hex'))) {
      return null;
    }

    // Extraire l'utilisateur des données validées
    const userParam = params.get('user');
    if (!userParam) return null;
    return JSON.parse(userParam);
  } catch (err) {
    console.error('Telegram initData validation error:', err.message);
    return null;
  }
}

// Extraire le telegramId vérifié depuis initData ou fallback sur le body (moins sécurisé)
function getVerifiedTelegramId(req) {
  const { initData, telegramId } = req.body;

  // Priorité : validation cryptographique via initData
  if (initData) {
    const validatedUser = validateTelegramInitData(initData);
    if (validatedUser && validatedUser.id) {
      return String(validatedUser.id);
    }
  }

  // Fallback : telegramId du body (cohérent avec create-order qui l'accepte aussi)
  if (telegramId) {
    return String(telegramId);
  }

  return null;
}


// Hash du mot de passe admin avec bcrypt (ne jamais comparer en clair)
const BCRYPT_ROUNDS = 12;
let adminPasswordHash = null;

async function initAdminPassword() {
  adminPasswordHash = await bcrypt.hash(config.admin.password, BCRYPT_ROUNDS);
}

async function verifyAdminPassword(password) {
  return bcrypt.compare(password || '', adminPasswordHash);
}

// Admins authentifiés en session (via /adminlogin) — avec expiration automatique
const SESSION_ADMIN_EXPIRY_MS = 60 * 60 * 1000; // 1 heure
const sessionAdmins = new Map(); // chatId -> timestamp d'expiration

// État conversationnel pour les admins (chatId -> { action, step, data })
const adminStates = new Map();

// Helper pour obtenir la liste des admin IDs (lecture dynamique de l'env)
function getAdminChatIds() {
  return (process.env.ADMIN_CHAT_ID || '').split(',').map(id => id.trim()).filter(id => id);
}

// Helper pour vérifier si un utilisateur est admin
function isAdmin(chatId) {
  const chatIdStr = chatId.toString();
  // Vérifier d'abord les admins connectés en session (avec expiration)
  const sessionExpiry = sessionAdmins.get(chatIdStr);
  if (sessionExpiry) {
    if (Date.now() < sessionExpiry) return true;
    // Session expirée → supprimer
    sessionAdmins.delete(chatIdStr);
  }
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
      driverId: String(driverId),
      clientTelegramId: String(clientTelegramId),
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
    const chatIdStr = String(chatId);
    for (const [orderId, conv] of this.activeConversations.entries()) {
      if (role === 'driver' && String(conv.driverId) === chatIdStr && conv.driverActive) {
        return { orderId, ...conv };
      }
      if (role === 'client' && String(conv.clientTelegramId) === chatIdStr && conv.clientActive) {
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
  const dbPath = process.env.DATABASE_PATH || './boutique.db';

  // Créer le dossier parent si nécessaire (ex: /data/boutique.db)
  const dbDir = path.dirname(dbPath);
  if (dbDir !== '.' && !fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  // Diagnostic de persistance au démarrage
  const isVolumePath = dbPath.startsWith('/data');
  const dbExists = fs.existsSync(dbPath);

  console.log('📂 ======= DATABASE CONFIG =======');
  console.log(`   Path: ${dbPath}`);
  console.log(`   Exists: ${dbExists ? '✅ OUI (données conservées)' : '❌ NON (nouvelle base)'}`);
  console.log(`   Volume: ${isVolumePath ? '✅ Persistant (/data)' : '⚠️  NON PERSISTANT - données perdues au redeploy !'}`);

  if (!isVolumePath) {
    console.warn('');
    console.warn('⚠️  ========= ATTENTION =========');
    console.warn('⚠️  La base de données N\'EST PAS sur un volume persistant !');
    console.warn('⚠️  Toutes les données seront PERDUES au prochain redéploiement.');
    console.warn('⚠️  ');
    console.warn('⚠️  Pour corriger :');
    console.warn('⚠️  1. Railway → Service → Settings → Volumes');
    console.warn('⚠️  2. Créer un volume avec Mount Path: /data');
    console.warn('⚠️  3. Railway → Service → Variables');
    console.warn('⚠️  4. Ajouter: DATABASE_PATH=/data/boutique.db');
    console.warn('⚠️  5. Redéployer');
    console.warn('⚠️  ================================');
    console.warn('');
  }

  // Auto-migration : si la base est sur /data mais n'existe pas,
  // et qu'il y a une ancienne base à ./boutique.db, la copier
  if (isVolumePath && !dbExists && fs.existsSync('./boutique.db')) {
    console.log('🔄 Migration détectée : copie de ./boutique.db vers ' + dbPath);
    fs.copyFileSync('./boutique.db', dbPath);
    // Copier aussi les fichiers WAL si présents
    if (fs.existsSync('./boutique.db-wal')) fs.copyFileSync('./boutique.db-wal', dbPath + '-wal');
    if (fs.existsSync('./boutique.db-shm')) fs.copyFileSync('./boutique.db-shm', dbPath + '-shm');
    console.log('✅ Migration terminée ! Anciennes données récupérées.');
  }

  if (dbExists) {
    const stats = fs.statSync(dbPath);
    console.log(`   Taille: ${(stats.size / 1024 / 1024).toFixed(2)} MB`);
  }
  console.log('📂 ==================================');

  db = await open({
    filename: dbPath,
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
      manual INTEGER DEFAULT 0,
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

    CREATE TABLE IF NOT EXISTS drivers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      telegram_id TEXT NOT NULL UNIQUE,
      active INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS driver_schedule (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      driver_id INTEGER NOT NULL,
      zone TEXT NOT NULL CHECK(zone IN ('millau', 'exterieur')),
      day_of_week INTEGER NOT NULL CHECK(day_of_week BETWEEN 0 AND 6),
      UNIQUE(zone, day_of_week),
      FOREIGN KEY (driver_id) REFERENCES drivers(id)
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
    CREATE INDEX IF NOT EXISTS idx_referral_history_referred ON referral_history(referred_contact);
    CREATE INDEX IF NOT EXISTS idx_orders_customer ON orders(customer);
    CREATE INDEX IF NOT EXISTS idx_orders_telegram_id ON orders(client_telegram_id);
    CREATE INDEX IF NOT EXISTS idx_telegram_clients_telegram_id ON telegram_clients(telegram_id);
  `);

  // Migrations (idempotent)
  try {
    await db.run("ALTER TABLE orders ADD COLUMN time_slot TEXT DEFAULT 'asap'");
  } catch (e) { /* colonne existe déjà */ }
  try {
    await db.run("ALTER TABLE orders ADD COLUMN reminder_sent INTEGER DEFAULT 0");
  } catch (e) { /* colonne existe déjà */ }
  try {
    await db.run("ALTER TABLE orders ADD COLUMN customer_description TEXT DEFAULT ''");
  } catch (e) { /* colonne existe déjà */ }
  try {
    await db.run("ALTER TABLE orders ADD COLUMN credit_used REAL DEFAULT 0");
  } catch (e) { /* colonne existe déjà */ }
  try {
    await db.run("ALTER TABLE orders ADD COLUMN delivery_fee REAL DEFAULT 0");
  } catch (e) { /* colonne existe déjà */ }
  try {
    await db.run("ALTER TABLE orders ADD COLUMN customer_name TEXT DEFAULT ''");
  } catch (e) { /* colonne existe déjà */ }
  try {
    await db.run("ALTER TABLE stock ADD COLUMN manual INTEGER DEFAULT 0");
  } catch (e) { /* colonne existe déjà */ }

  await db.run(`
    INSERT OR IGNORE INTO settings (key, value) VALUES
    ('shop_name', 'DROGUA CENTER'),
    ('delivery_fee', '20'),
    ('loyalty_threshold', '${config.loyalty.defaultThreshold}'),
    ('cash_balance', '0'),
    ('monthly_goal', '5000')
  `);

  // === Produits par défaut - auto-merge des nouveaux produits ===
  const DEFAULT_PRODUCTS = [
    {
      id: 1, name: 'AMNESIA', category: 'weed',
      description: "Venu tout droit des Coffee BARCELONAIS \u{1F1EA}\u{1F1F8} cette variété tans convoité il y a 3-4ans maintenant devenu très rares à trouver dans les grands points de ventes nous l'avons trouvé la VRAI LA VÉRITABLE pas la commercial que certain croient goûter depuis sa disparition.",
      video: '/videos/amnesia.MP4',
      variants: { '3.33G': { price: 20, grams: 3.33, stock: 999 }, '5G': { price: 30, grams: 5, stock: 999 }, '10G': { price: 60, grams: 10, stock: 999 }, '50G': { price: 250, grams: 50, stock: 999 }, '100G': { price: 450, grams: 100, stock: 999 } }
    },
    {
      id: 2, name: 'NEEDLES KETA', category: 'keta',
      description: "Cela procure un profond sentiment d'euphorie et de légèreté.\n\nDes éclats de rire spontanés ou un sentiment d'émerveillement peuvent survenir.\n\nLes couleurs, les sons et les sensations peuvent sembler plus intenses et agréables.",
      video: '/videos/needles.MP4',
      variants: { '1G': { price: 20, grams: 1, stock: 999 }, '2G': { price: 40, grams: 2, stock: 999 }, '3G': { price: 50, grams: 3, stock: 999 }, '5G': { price: 80, grams: 5, stock: 999 }, '10G': { price: 150, grams: 10, stock: 999 }, '50G': { price: 450, grams: 50, stock: 999 }, '100G': { price: 870, grams: 100, stock: 999 } }
    },
    {
      id: 3, name: 'CANADIENNE', category: 'cali',
      description: "Ultra puissante. Ultra raffinée.\nUne claque élégante, effet velvet, présence impossible à ignorer \u2728\nDu haut de gamme qui fait sourire… puis lâcher un WOW \u{1F60C}\u{1F525}\n\u{1F341} Made in Canada — pour palais exigeants only \u{1F451}\u{1F48E}",
      video: '/videos/canadienne.MP4',
      variants: { '1.6G': { price: 20, grams: 1.6, stock: 999 }, '3.2G': { price: 40, grams: 3.2, stock: 999 }, '5G': { price: 60, grams: 5, stock: 999 }, '10G': { price: 110, grams: 10, stock: 999 } }
    },
    {
      id: 4, name: 'BLACK PURPLE', category: 'cali',
      description: "Une frappe nette et élégante, effet velvet, présence impossible à ignorer \u2728\nDu premium qui fait sourire… puis lâcher un WOW \u{1F60C}\u{1F525}\n\u{1F1FA}\u{1F1F8} Made in USA — pour palais élites only \u{1F451}\u{1F48E}",
      video: '/videos/black_purple.MP4',
      variants: { '2.2G': { price: 20, grams: 2.2, stock: 999 }, '5G': { price: 40, grams: 5, stock: 999 }, '10G': { price: 80, grams: 10, stock: 999 }, '100G': { price: 500, grams: 100, stock: 999 } }
    },
    {
      id: 5, name: 'MIMOSA PIE', category: 'cali',
      description: "Une frappe nette et élégante, effet velvet, présence impossible à ignorer \u2728\nDu premium qui fait sourire… puis lâcher un WOW \u{1F60C}\u{1F525}\n\u{1F1FA}\u{1F1F8} Made in USA — pour palais élites only \u{1F451}\u{1F48E}",
      video: '/videos/mimosa_pie.MP4',
      variants: { '1.8G': { price: 20, grams: 1.8, stock: 999 }, '3.6G': { price: 40, grams: 3.6, stock: 999 }, '5G': { price: 50, grams: 5, stock: 999 }, '10G': { price: 100, grams: 10, stock: 999 } }
    },
    {
      id: 6, name: 'GEORGIA PIE', category: 'cali',
      description: "Une frappe nette et élégante, effet velvet, présence impossible à ignorer \u2728\nDu premium qui fait sourire… puis lâcher un WOW \u{1F60C}\u{1F525}\n\u{1F1FA}\u{1F1F8} Made in USA — pour palais élites only \u{1F451}\u{1F48E}",
      video: '/videos/gorgia_pie.MP4',
      variants: { '1.8G': { price: 20, grams: 1.8, stock: 999 }, '3.6G': { price: 40, grams: 3.6, stock: 999 }, '5G': { price: 50, grams: 5, stock: 999 }, '10G': { price: 100, grams: 10, stock: 999 } }
    },
    {
      id: 7, name: 'BLACK CHEESE', category: 'cali',
      description: "Une frappe nette et élégante, effet velvet, présence impossible à ignorer \u2728\nDu premium qui fait sourire… puis lâcher un WOW \u{1F60C}\u{1F525}\n\u{1F1FA}\u{1F1F8} Made in USA — pour palais élites only \u{1F451}\u{1F48E}",
      video: '/videos/black_cheese.MP4',
      variants: { '1.8G': { price: 20, grams: 1.8, stock: 999 }, '3.6G': { price: 40, grams: 3.6, stock: 999 }, '5G': { price: 50, grams: 5, stock: 999 }, '10G': { price: 100, grams: 10, stock: 999 } }
    },
    {
      id: 8, name: 'FAST BOY 120u', category: 'filtre',
      description: "Ce produit d'une qualité RARISSIME, un goût INOUBLIABLE vous procurera des effets MÉMORABLES.\n\nCurer a 100% muter à 100% qualités Universal \u{1F440}",
      video: '/videos/morroco2025-compressed.mov',
      variants: { '2G': { price: 20, grams: 2, stock: 999 }, '5G': { price: 40, grams: 5, stock: 999 }, '10G': { price: 70, grams: 10, stock: 999 }, '50G': { price: 260, grams: 50, stock: 999 }, '100G': { price: 490, grams: 100, stock: 999 } }
    },
    {
      id: 9, name: 'COURCHEVEL', category: 'blanche',
      description: "Origine : COLOMBIE \u{1F1E8}\u{1F1F4}\n\nQUALITY'S: \u2B50\u2B50\u2B50\u2B50\u2B50\n\nNotre produit est pure\nSa texture est comme de la neige \u{1F60B}\n\nElle procure un sentiment de puissance, d'euphorie et de bonheur \u{1F525}\n\nAinsi qu'un besoin irrépressible de parler, danser \u{1F5E3}\u{1F483}\nou même faire l'amour \u{1F609}\u{1F975}",
      video: '/videos/courchevel2.MOV',
      variants: { '0.5G': { price: 30, grams: 0.5, stock: 999 }, '1G': { price: 50, grams: 1, stock: 999 }, '2G': { price: 80, grams: 2, stock: 999 }, '5G': { price: 190, grams: 5, stock: 999 }, '10G': { price: 340, grams: 10, stock: 999 }, '50G': { price: 1200, grams: 50, stock: 999 } }
    },
    {
      id: 10, name: 'PIINK KUSH', category: 'mousseux',
      description: "Direct du Maroc \u{1F1F2}\u{1F1E6}, pure et puissante \u{1F48E}\nCouleur dorée, texture mousseuse, effet smooth et velouté \u{1F60C}\nChaque bouffée frappe fort… intense, raffinée, et 100 % WOW \u2728\nPour les connaisseurs qui veulent du haut de gamme qui se remarque \u{1F451}\u{1F49B}",
      video: '/videos/piink_kush.MOV',
      variants: { '4G': { price: 20, grams: 4, stock: 999 }, '6.5G': { price: 30, grams: 6.5, stock: 999 }, '12G': { price: 50, grams: 12, stock: 999 }, '50G': { price: 180, grams: 50, stock: 999 }, '100G': { price: 350, grams: 100, stock: 999 } }
    },
    {
      id: 11, name: 'ORIGINAL STATIC', category: 'frozen',
      description: "Ce produit d'une qualité RARISSIME, un goût INOUBLIABLE vous procurera des effets MÉMORABLES.\n\nCurer a 100% muter à 100% qualités Universal \u{1F440}",
      video: '/videos/original-static.mp4',
      variants: { '1.5G': { price: 20, grams: 1.5, stock: 999 }, '3G': { price: 40, grams: 3, stock: 999 }, '5G': { price: 60, grams: 5, stock: 999 }, '10G': { price: 110, grams: 10, stock: 999 } }
    },
    {
      id: 12, name: 'PANDA CAKE \u{1F43C}', category: 'cali',
      description: "\u{1F43C}\u{1F370}     PANDA-CAKE     \u{1F370}\u{1F43C}\n\n\u{1F1FA}\u{1F1F8} CALI-US \u{1F1FA}\u{1F1F8}\n\nQuality's : \u{1F31F}\u{1F31F}\u{1F31F}\u{1F31F}\u{1F31F}\n\nVenu tout droit de Californie notre PANDA-CAKE fait son apparition dans notre shop.",
      video: '/videos/panda-kake.mp4',
      variants: { '1.8G': { price: 20, grams: 1.8, stock: 999 }, '3.6G': { price: 40, grams: 3.6, stock: 999 }, '5G': { price: 50, grams: 5, stock: 999 }, '10G': { price: 100, grams: 10, stock: 999 } }
    }
  ];

  try {
    const productsData = await db.get("SELECT value FROM settings WHERE key = 'products'");
    if (productsData?.value) {
      // Products exist in DB - merge any missing default products
      const existingProducts = JSON.parse(productsData.value);

      // Renommages de produits (ancien nom → nouveau nom)
      const RENAMES = {
        "ZOUR'S 120U": "FAST BOY 120u",
        "PANDA KAKE \u{1F43C}": "PANDA CAKE \u{1F43C}"
      };
      for (const p of existingProducts) {
        const newName = RENAMES[p.name.toUpperCase()];
        if (newName) {
          console.log(`✏️ Renommage: ${p.name} → ${newName}`);
          p.name = newName;
        }
      }

      const existingNames = existingProducts.map(p => p.name.toUpperCase());
      const maxId = Math.max(...existingProducts.map(p => p.id), 0);
      let nextId = maxId + 1;
      let added = 0;

      let updated = 0;
      for (const defaultProduct of DEFAULT_PRODUCTS) {
        if (!existingNames.includes(defaultProduct.name.toUpperCase())) {
          existingProducts.push({ ...defaultProduct, id: nextId++ });
          added++;
          console.log(`➕ Produit ajouté automatiquement: ${defaultProduct.name}`);
        } else {
          // Update category, description, and video for existing products
          const existing = existingProducts.find(p => p.name.toUpperCase() === defaultProduct.name.toUpperCase());
          if (existing) {
            let changed = false;
            if (existing.category !== defaultProduct.category) {
              existing.category = defaultProduct.category;
              changed = true;
            }
            if (defaultProduct.description && existing.description !== defaultProduct.description) {
              existing.description = defaultProduct.description;
              changed = true;
            }
            if (defaultProduct.video && existing.video !== defaultProduct.video) {
              existing.video = defaultProduct.video;
              changed = true;
            }
            // Ajouter les nouvelles variantes qui n'existent pas encore (sans écraser le stock existant)
            if (defaultProduct.variants && existing.variants) {
              for (const [varName, varData] of Object.entries(defaultProduct.variants)) {
                if (!existing.variants[varName]) {
                  existing.variants[varName] = { ...varData };
                  changed = true;
                }
              }
            }
            if (changed) {
              updated++;
              console.log(`🔄 Produit mis à jour: ${existing.name}`);
            }
          }
        }
      }

      // Supprimer les produits qui ne sont plus dans DEFAULT_PRODUCTS
      const defaultNames = DEFAULT_PRODUCTS.map(p => p.name.toUpperCase());
      const beforeCount = existingProducts.length;
      const cleanedProducts = existingProducts.filter(p => defaultNames.includes(p.name.toUpperCase()));
      const removed = beforeCount - cleanedProducts.length;
      if (removed > 0) {
        existingProducts.length = 0;
        cleanedProducts.forEach(p => existingProducts.push(p));
        console.log(`🗑️ ${removed} ancien(s) produit(s) supprimé(s) de la base`);
      }

      if (added > 0 || updated > 0 || removed > 0) {
        await db.run(
          "UPDATE settings SET value = ? WHERE key = 'products'",
          JSON.stringify(existingProducts)
        );
        if (added > 0) console.log(`✅ ${added} nouveau(x) produit(s) ajouté(s) à la base`);
        if (updated > 0) console.log(`✅ ${updated} produit(s) mis à jour dans la base`);
        if (removed > 0) console.log(`✅ Anciens produits nettoyés`);
      }
    } else {
      // No products in DB - seed with defaults
      await db.run(
        "INSERT OR REPLACE INTO settings (key, value) VALUES ('products', ?)",
        JSON.stringify(DEFAULT_PRODUCTS)
      );
      console.log('✅ Produits par défaut initialisés dans la base');
    }
  } catch (err) {
    console.error('⚠️ Erreur lors du merge des produits:', err);
  }

  // ==================== STOCK TABLE INITIALIZATION ====================
  // Ensure every product variant has a row in the stock table
  // Also fix rows stuck at qty=0 when default stock > 0 (e.g. after DB reset without volume)
  try {
    const productsData = await db.get("SELECT value FROM settings WHERE key = 'products'");
    if (productsData?.value) {
      const products = JSON.parse(productsData.value);
      let initialized = 0;
      let repaired = 0;
      for (const product of products) {
        if (product.variants) {
          for (const [variantName, variantData] of Object.entries(product.variants)) {
            const defaultQty = variantData.stock || 0;
            // Insert new rows
            const result = await db.run(
              'INSERT OR IGNORE INTO stock (product_id, variant, qty) VALUES (?, ?, ?)',
              [product.id, variantName, defaultQty]
            );
            if (result.changes > 0) {
              initialized++;
            } else if (defaultQty > 0) {
              // Row exists - if stuck at 0 and default is > 0, repair it
              // BUT skip if admin manually set the stock (manual = 1)
              const current = await db.get(
                'SELECT qty, manual FROM stock WHERE product_id = ? AND variant = ?',
                [product.id, variantName]
              );
              if (current && current.qty === 0 && !current.manual) {
                await db.run(
                  'UPDATE stock SET qty = ? WHERE product_id = ? AND variant = ?',
                  [defaultQty, product.id, variantName]
                );
                repaired++;
              }
            }
          }
        }
      }
      if (initialized > 0) {
        console.log(`✅ ${initialized} entrée(s) stock initialisée(s) dans la table stock`);
      }
      if (repaired > 0) {
        console.log(`🔧 ${repaired} stock(s) à 0 réparé(s) avec les valeurs par défaut`);
      }
    }
  } catch (err) {
    console.error('⚠️ Erreur lors de l\'initialisation du stock:', err);
  }

  // Seed reviews if empty
  try {
    const reviewCount = await db.get('SELECT COUNT(*) as count FROM reviews');
    if (!reviewCount || reviewCount.count === 0) {
      const defaultReviews = [
        { product_id: 1, name: 'Lucas M.', stars: 5, text: 'La vraie Amnesia comme à Barcelona ! Effet cérébral puissant, parfait pour la créativité. Livraison rapide à Millau.' },
        { product_id: 1, name: 'Sophie K.', stars: 5, text: 'Enfin retrouvé ce goût unique de l\'Amnesia. Qualité au rendez-vous, je recommande les yeux fermés !' },
        { product_id: 1, name: 'Maxime R.', stars: 4, text: 'Très bonne qualité, effet smooth et durable. Le service client est top aussi.' },
        { product_id: 2, name: 'Antoine D.', stars: 5, text: 'Effet euphorie garanti ! Qualité exceptionnelle, fondait dans la bouche. Merci pour la livraison express.' },
        { product_id: 2, name: 'Léa P.', stars: 5, text: 'Produit premium, sensations incroyables. Ça vaut vraiment le prix.' },
        { product_id: 2, name: 'Thomas B.', stars: 4, text: 'Très satisfait, effet comme décrit. Service impeccable.' },
        { product_id: 3, name: 'Julie F.', stars: 5, text: 'La Canadienne est juste WOW ! Saveur boisée unique, effet relaxant parfait pour le soir.' },
        { product_id: 3, name: 'Romain G.', stars: 5, text: 'Qualité exceptionnelle venue du Canada. Le goût est authentique, je suis fan !' },
        { product_id: 4, name: 'Emma L.', stars: 5, text: 'Produit haut de gamme, on sent la différence. Parfait pour les connaisseurs.' },
        { product_id: 4, name: 'Nicolas V.', stars: 5, text: 'La couleur violette est magnifique et l\'effet est puissant. Top qualité !' },
        { product_id: 5, name: 'Camille D.', stars: 5, text: 'Saveur sucrée incroyable, comme une vraie tarte ! Effet joyeux et créatif.' },
        { product_id: 5, name: 'Hugo M.', stars: 4, text: 'Bon produit, goût fruité agréable. Livraison rapide sur Rodez.' },
        { product_id: 6, name: 'Chloé R.', stars: 5, text: 'Georgia Pie au top ! Goût sucré et effet relaxant, parfait après une longue journée.' },
        { product_id: 6, name: 'Mathis L.', stars: 5, text: 'Excellent rapport qualité-prix. La saveur est unique et l\'effet très agréable.' },
        { product_id: 7, name: 'Manon S.', stars: 5, text: 'Black Cheese délicieux ! Le goût fromager est subtil et l\'effet puissant.' },
        { product_id: 7, name: 'Alexandre T.', stars: 4, text: 'Bonne qualité, goût original. Je recommande pour les amateurs de saveurs uniques.' },
        { product_id: 8, name: 'Inès B.', stars: 5, text: 'Fast Boy porte bien son nom ! Effet rapide et efficace. Texture parfaite.' },
        { product_id: 8, name: 'Théo D.', stars: 5, text: 'Qualité premium, effet comme promis. Service client réactif et sympa.' },
        { product_id: 9, name: 'Clara M.', stars: 5, text: 'Courchevel c\'est du lourd ! Qualité alpine, effet puissant et durable. Mon préféré !' },
        { product_id: 9, name: 'Enzo P.', stars: 5, text: 'Produit d\'exception, on sent la qualité dès l\'ouverture. Livraison parfaite.' },
        { product_id: 10, name: 'Léna V.', stars: 5, text: 'Pink Kush marocain authentique ! Couleur dorée magnifique, effet velouté.' },
        { product_id: 10, name: 'Raphaël C.', stars: 5, text: 'Direct du Maroc, ça se sent ! Qualité exceptionnelle, je suis client fidèle maintenant.' },
        { product_id: 1, name: 'Sarah B.', stars: 5, text: 'Commande reçue en 30 min sur Millau ! Produit frais et de qualité. Merci !' },
        { product_id: 3, name: 'Kevin L.', stars: 5, text: 'Meilleur produit que j\'ai testé. La Canadienne est vraiment au-dessus du lot.' },
        { product_id: 5, name: 'Marine D.', stars: 5, text: 'Mimosa Pie, un délice ! Goût fruité et effet créatif. Parfait pour travailler.' },
        { product_id: 7, name: 'Dylan R.', stars: 4, text: 'Black Cheese original et efficace. Bon rapport qualité-prix.' },
        { product_id: 9, name: 'Pauline G.', stars: 5, text: 'Courchevel m\'a conquise ! Qualité irréprochable et service au top.' },
        { product_id: 2, name: 'Florian M.', stars: 5, text: 'Needles Keta extraordinaire ! Effet euphorique garanti. Je recommande à 100%.' },
        { product_id: 4, name: 'Océane T.', stars: 5, text: 'Black Purple magnifique ! La couleur et le goût sont incroyables.' },
        { product_id: 10, name: 'Bastien H.', stars: 5, text: 'Pink Kush marocain de folie ! Texture mousseuse parfaite, effet smooth.' }
      ];

      for (const review of defaultReviews) {
        await db.run(
          'INSERT INTO reviews (product_id, name, stars, text, approved) VALUES (?, ?, ?, ?, 1)',
          [review.product_id, review.name, review.stars, review.text]
        );
      }
      console.log('✅ 30 avis par défaut ajoutés');
    }
  } catch (err) {
    console.error('⚠️ Erreur lors de l\'ajout des avis:', err);
  }

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
  return str.trim().slice(0, maxLength).replace(/[<>]/g, '');
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

  if (items.length > 50) {
    throw new ValidationError('Trop d\'articles dans le panier (max 50)');
  }

  if (typeof total !== 'number' || total < 0) {
    throw new ValidationError('Montant invalide');
  }

  if (total > 100000) {
    throw new ValidationError('Montant total trop élevé');
  }

  for (const item of items) {
    if (!item.product_id || !item.name || !item.variant || !item.qty || !item.lineTotal) {
      throw new ValidationError('Données article invalides');
    }
    if (typeof item.price !== 'number' || item.price < 0) {
      throw new ValidationError('Prix article invalide');
    }
    if (item.qty < 1 || item.lineTotal < 0) {
      throw new ValidationError('Quantité ou prix invalide');
    }
    // Vérifier l'intégrité du lineTotal (protection contre la manipulation de prix)
    const expectedLineTotal = item.price * item.qty;
    if (Math.abs(item.lineTotal - expectedLineTotal) > 0.01) {
      throw new ValidationError('Calcul du total article incorrect');
    }
  }

  // Note : le total final est recalculé côté serveur (items + frais de livraison serveur)
  // La validation du total se fait après le calcul des frais de zone

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
  if (result?.contact) return result.contact;

  // Fallback: chercher dans les commandes par client_telegram_id
  const order = await db.get(
    'SELECT customer FROM orders WHERE client_telegram_id = ? LIMIT 1',
    [telegramId]
  );
  if (order?.customer) {
    // Corriger le lien dans telegram_clients pour les prochaines fois
    await db.run(
      `UPDATE telegram_clients SET contact = ? WHERE telegram_id = ? AND (contact IS NULL OR contact = '')`,
      [order.customer, telegramId]
    );
    console.log(`🔗 Auto-linked Telegram ${telegramId} to contact ${order.customer} via orders`);
    return order.customer;
  }

  return null;
}

async function getCustomerDisplayName(contact) {
  // Chercher le nom dans telegram_clients
  const result = await db.get(
    'SELECT first_name FROM telegram_clients WHERE contact = ? OR telegram_id = ?',
    [contact, contact]
  );
  return result?.first_name || contact;
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
    force_reply: true,
    selective: true,
    input_field_placeholder: 'Tapez votre réponse au livreur...'
  };

  try {
    await telegram.sendMessage(conv.clientTelegramId, clientMsg, {
      reply_markup: clientKeyboard
    });

    // Envoyer aussi un bouton pour fermer la conversation
    await telegram.sendMessage(conv.clientTelegramId, '👆 <i>Répondez au message ci-dessus, ou fermez la conversation :</i>', {
      reply_markup: {
        inline_keyboard: [
          [{ text: '📜 Historique', callback_data: `chat_history_${conv.orderId}` }],
          [{ text: '❌ Fermer conversation', callback_data: `end_conv_${conv.orderId}` }]
        ]
      }
    });

    await chatManager.activateClient(conv.orderId);
    await chatManager.incrementMessageCount(conv.orderId);
    
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
  await chatManager.incrementMessageCount(conv.orderId);

  const driverMsg = `👤 <b>Message du client</b> (Commande #${conv.orderId})

💬 ${text}

<i>Tapez votre réponse ci-dessous</i>`;

  const driverKeyboard = {
    inline_keyboard: [
      [{ text: '📜 Historique', callback_data: `chat_history_${conv.orderId}` }],
      [{ text: '❌ Fermer conversation', callback_data: `stop_conversation_${conv.orderId}` }]
    ]
  };

  try {
    await telegram.sendMessage(conv.driverId, driverMsg, { reply_markup: driverKeyboard });

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

  async setWebhook(url, secretToken = null) {
    if (!this.token) return null;

    try {
      const payload = {
        url,
        allowed_updates: ['message', 'callback_query']
      };
      if (secretToken) {
        payload.secret_token = secretToken;
      }
      const response = await axios.post(`${this.baseUrl}/setWebhook`, payload, { timeout: 10000 });

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

  async setMyCommands(commands, scope = null) {
    if (!this.token) return null;
    try {
      const payload = { commands };
      if (scope) {
        if (scope.chat_id && (!Number.isFinite(scope.chat_id) || scope.chat_id === 0)) {
          console.warn(`⚠️ setMyCommands ignoré: chat_id invalide (${scope.chat_id})`);
          return false;
        }
        payload.scope = scope;
      }
      const response = await axios.post(`${this.baseUrl}/setMyCommands`, payload, { timeout: 5000 });
      return response.data?.ok;
    } catch (error) {
      const detail = error.response?.data?.description || error.message;
      console.error(`❌ Set commands error: ${detail}${scope ? ` (scope: ${JSON.stringify(scope)})` : ''}`);
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

  async setChatMenuButton(chatId, url, text = '🛒 Boutique') {
    if (!this.token) return null;
    try {
      const payload = {
        chat_id: chatId,
        menu_button: {
          type: 'web_app',
          text: text,
          web_app: { url }
        }
      };
      const response = await axios.post(`${this.baseUrl}/setChatMenuButton`, payload, { timeout: 5000 });
      return response.data?.ok;
    } catch (error) {
      console.error(`❌ setChatMenuButton error (${chatId}):`, error.message);
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
async function getDriverForDeliveryType(deliveryType) {
  const type = deliveryType.toLowerCase();

  // Déterminer la zone à partir du type de livraison
  let matchedZone = 'millau'; // défaut
  for (const [zone, zoneConfig] of Object.entries(config.deliveryZones)) {
    if (zoneConfig.keywords.some(keyword => type.includes(keyword))) {
      matchedZone = zone;
      break;
    }
  }

  // Vérifier le planning du jour pour cette zone
  const today = new Date().getDay(); // 0=dimanche, 1=lundi, ..., 6=samedi
  try {
    const scheduled = await db.get(`
      SELECT ds.driver_id, d.name, d.telegram_id
      FROM driver_schedule ds
      JOIN drivers d ON d.id = ds.driver_id AND d.active = 1
      WHERE ds.zone = ? AND ds.day_of_week = ?
    `, [matchedZone, today]);

    if (scheduled) {
      return {
        zone: matchedZone,
        driverId: scheduled.telegram_id,
        driverName: scheduled.name
      };
    }
  } catch (err) {
    console.error('Erreur lecture planning livreur:', err.message);
  }

  // Fallback: utiliser les IDs par défaut du .env
  const zoneConfig = config.deliveryZones[matchedZone];
  return {
    zone: matchedZone,
    driverId: config.telegram[zoneConfig ? zoneConfig.driverIdKey : 'driverMillauId'],
    driverName: zoneConfig ? zoneConfig.name : 'Millau'
  };
}

async function getDriverForDeliveryZone(zone) {
  const today = new Date().getDay();
  try {
    const scheduled = await db.get(`
      SELECT ds.driver_id, d.name, d.telegram_id
      FROM driver_schedule ds
      JOIN drivers d ON d.id = ds.driver_id AND d.active = 1
      WHERE ds.zone = ? AND ds.day_of_week = ?
    `, [zone, today]);

    if (scheduled) {
      return { zone, driverId: scheduled.telegram_id, driverName: scheduled.name };
    }
  } catch (err) {
    console.error('Erreur lecture planning livreur:', err.message);
  }

  const zoneConfig = config.deliveryZones[zone];
  return {
    zone,
    driverId: config.telegram[zoneConfig ? zoneConfig.driverIdKey : 'driverMillauId'],
    driverName: zoneConfig ? zoneConfig.name : 'Millau'
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
  // Remise uniquement si le client a déjà au moins 1 commande enregistrée
  // et que sa prochaine commande atteint le palier (ex: 10ème, 20ème, etc.)
  if (loyalty && loyalty.orders_count >= 1 && (loyalty.orders_count + 1) % threshold === 0) {
    discount = Math.min(config.loyalty.fixedDiscount, total);
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
async function updateStockForOrder(items, orderId, { inTransaction = false } = {}) {
  if (!inTransaction) await db.run('BEGIN IMMEDIATE');
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
    if (!inTransaction) await db.run('COMMIT');
  } catch (err) {
    if (!inTransaction) await db.run('ROLLBACK');
    throw err;
  }
}

async function restoreStockForOrder(items, orderId, { inTransaction = false } = {}) {
  if (!inTransaction) await db.run('BEGIN IMMEDIATE');
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
    if (!inTransaction) await db.run('COMMIT');
  } catch (err) {
    if (!inTransaction) await db.run('ROLLBACK');
    throw err;
  }
}

// ==================== REFERRAL SYSTEM ====================
// Le code de parrainage = le Telegram user ID du client

async function getOrCreateReferralCode(customer) {
  // Le code de parrainage est directement le Telegram user ID
  const existing = await db.get(
    'SELECT * FROM referrals WHERE customer_contact = ?',
    [customer]
  );
  if (existing) {
    // Mettre à jour le code si c'est un ancien code aléatoire
    if (existing.referral_code !== customer) {
      await db.run(
        'UPDATE referrals SET referral_code = ? WHERE customer_contact = ?',
        [customer, customer]
      );
      existing.referral_code = customer;
    }
    return existing;
  }

  // Créer avec le Telegram ID comme code
  await db.run(
    'INSERT OR IGNORE INTO referrals (referral_code, customer_contact) VALUES (?, ?)',
    [customer, customer]
  );

  return await db.get(
    'SELECT * FROM referrals WHERE customer_contact = ?',
    [customer]
  );
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

  // Système : 10€ pour le parrain à chaque filleul parrainé
  const REFERRAL_REWARD = 10; // 10€ par parrainage

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
    const newTotalReferrals = totalReferrals + 1;

    // Chaque parrainage donne 10€ de crédit (cumulable)
    const referrerCredit = REFERRAL_REWARD;

    // Incrémenter le compteur de parrainages
    await db.run(
      `UPDATE referrals
       SET credit_balance = credit_balance + ?,
           total_referrals = total_referrals + 1,
           total_earned = total_earned + ?
       WHERE referral_code = ?`,
      [referrerCredit, referrerCredit, referrerCode]
    );

    // Créer le code de parrainage pour le nouveau client (son Telegram ID)
    await db.run(
      'INSERT OR IGNORE INTO referrals (referral_code, customer_contact) VALUES (?, ?)',
      [newCustomer, newCustomer]
    );

    // Enregistrer dans l'historique (0€ pour le filleul)
    await db.run(
      `INSERT INTO referral_history
       (referrer_code, referrer_contact, referred_contact, order_id, referrer_credit, referred_credit, status)
       VALUES (?, ?, ?, ?, ?, ?, 'completed')`,
      [referrerCode, referrer.customer_contact, newCustomer, orderId, referrerCredit, 0]
    );

    await db.run('COMMIT');

    console.log(`✅ Referral applied: ${referrer.customer_contact} → ${newCustomer} (parrain: ${referrerCredit}€, filleul: 0€, total: ${newTotalReferrals})`);

    // Notification au parrain (hors transaction)
    await notifyReferralMilestone(referrer.customer_contact, newTotalReferrals, REFERRAL_REWARD).catch(err =>
      console.error('Referral notification error:', err.message)
    );

    return {
      referrerCredit,
      referredCredit: 0,
      referrerContact: referrer.customer_contact,
      hitMilestone: true,
      newTotalReferrals
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
async function notifyReferralSuccess(referrerContact, newCustomerContact, orderId, referralInfo = {}) {
  // Essayer de trouver l'ID Telegram du parrain
  const referrerTelegramId = await getClientTelegramId(referrerContact);
  const referrerName = await getCustomerDisplayName(referrerContact);
  const newCustomerName = await getCustomerDisplayName(newCustomerContact);

  if (referrerTelegramId && config.telegram.token) {
    const progressText = `🎉 Vous avez débloqué <b>10€ de crédit</b> !`;

    const message = `🤝 <b>NOUVEAU PARRAINAGE ENREGISTRÉ !</b>

👤 <b>Nouveau filleul :</b> ${newCustomerName}
📦 <b>Commande :</b> #${orderId}
📊 <b>Total parrainages :</b> ${referralInfo.newTotalReferrals || 0}

${progressText}

🚀 Continuez à partager votre code !`;

    try {
      await telegram.sendMessage(referrerTelegramId, message);
      console.log(`✅ Referral notification sent to ${referrerContact}`);
    } catch (error) {
      console.error(`❌ Failed to send referral notification to ${referrerContact}:`, error.message);
    }
  }

  // Notification admin
  if (getAdminChatIds().length > 0) {
    const adminMessage = `🤝 <b>PARRAINAGE</b>

👤 Parrain: ${referrerName} (total: ${referralInfo.newTotalReferrals || 0})
🆕 Filleul: ${newCustomerName}
📦 Commande: #${orderId}`;

    await notifyAdmins(adminMessage);
  }
}

async function notifyReferralMilestone(referrerContact, totalReferrals, reward) {
  // Essayer de trouver l'ID Telegram du parrain
  const referrerTelegramId = await getClientTelegramId(referrerContact);
  const referrerName = await getCustomerDisplayName(referrerContact);

  if (referrerTelegramId && config.telegram.token) {
    const message = `🎉 <b>FÉLICITATIONS ${referrerName} !</b>

🏆 Vous avez atteint <b>${totalReferrals} parrainages</b> !

💰 <b>+${reward}€ ajoutés à votre crédit !</b>

💳 Votre crédit est disponible immédiatement pour votre prochaine commande.

🚀 Continuez à parrainer, chaque ami parrainé = 10€ de crédit !

Tapez /parrainage pour voir vos stats 📈`;

    try {
      await telegram.sendMessage(referrerTelegramId, message);
      console.log(`✅ Referral milestone notification sent to ${referrerContact}`);
    } catch (error) {
      console.error(`❌ Failed to send referral milestone notification to ${referrerContact}:`, error.message);
    }
  }

  // Notification admin
  if (getAdminChatIds().length > 0) {
    const adminMessage = `🏆 <b>PALIER PARRAINAGE</b>

👤 Client: ${referrerName}
📊 Parrainages: ${totalReferrals}
💰 Bonus: +${reward}€`;

    await notifyAdmins(adminMessage);
  }
}

function getTimeSlotLabel(slot) {
  if (slot === 'asap' || !slot) return '⚡ Dès que possible';
  return '🕐 ' + slot;
}

async function notifyNewCustomerOrder(order, items, customerRecord) {
  const displayName = await getCustomerDisplayName(order.customer);
  if (getAdminChatIds().length > 0) {
    const message = `🆕 <b>NOUVEAU CLIENT - VALIDATION REQUISE</b>

📦 <b>Commande #${order.id}</b>

👤 <b>Client:</b> ${displayName}
📅 <b>Première commande:</b> ${new Date(customerRecord.first_order_date).toLocaleString('fr-FR')}

📍 Type: ${order.type}
🏠 Adresse: ${order.address || 'Sur place'}
🕐 Créneau: ${getTimeSlotLabel(order.time_slot)}
${order.customer_description ? `🧍 Description: ${order.customer_description}` : ''}

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
👤 Client: ${displayName}
💰 Total: ${order.total}€
🕐 Créneau: ${getTimeSlotLabel(order.time_slot)}

⏳ En attente de validation admin`;

    await telegram.sendMessage(config.telegram.supportChatId, supportMessage);
  }
}

async function notifyNewOrder(order, items) {
  const driverInfo = await getDriverForDeliveryType(order.type);
  const displayName = await getCustomerDisplayName(order.customer);

  if (config.telegram.supportChatId) {
    const supportMessage = `🔔 NOUVELLE COMMANDE #${order.id}

👤 Client: ${displayName}
📍 Type: ${order.type}
🏠 Adresse: ${order.address || 'Sur place'}
🕐 Créneau: ${getTimeSlotLabel(order.time_slot)}
${order.customer_description ? `🧍 Description: ${order.customer_description}\n` : ''}💰 Total: ${order.total}€
📦 Articles: ${items.length} produit(s)

⚡ Contacter le client si besoin`;

    await telegram.sendMessage(config.telegram.supportChatId, supportMessage);
  }

  if (getAdminChatIds().length > 0) {
    // Récupérer les infos client complètes
    const customerInfo = await db.get('SELECT * FROM customers WHERE contact = ?', [order.customer]);
    const telegramInfo = await db.get('SELECT * FROM telegram_clients WHERE contact = ?', [order.customer]);

    let adminMessage = `📦 <b>COMMANDE #${order.id}</b>

👤 <b>Client: ${displayName}</b>`;

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
🕐 Créneau: ${getTimeSlotLabel(order.time_slot)}`;
    if (order.customer_description) adminMessage += `\n🧍 Description: ${order.customer_description}`;
    adminMessage += `

📦 Articles:
${items.map(item => `• ${item.name} - ${item.variant} ×${item.qty} = ${item.lineTotal}€`).join('\n')}

${order.discount > 0 ? `🎁 Remise fidélité: -${order.discount}€\n` : ''}💰 TOTAL: ${order.total}€

🚚 <b>Assigné à:</b> ${driverInfo.driverName}
🌍 <b>Zone:</b> ${driverInfo.zone.toUpperCase()}

⏰ ${new Date(order.created_at).toLocaleString('fr-FR')}`;

    await notifyAdmins(adminMessage);
  }
  
  // ==================== NOTIFICATION LIVREUR AUTO ====================
  // Toujours assigner la zone (même sans livreur disponible)
  await db.run(
    'UPDATE orders SET assigned_driver_zone = ? WHERE id = ?',
    [driverInfo.zone, order.id]
  );

  if (driverInfo.driverId) {
    // Envoyer la liste actualisée au livreur automatiquement
    try {
      await telegram.sendMessage(driverInfo.driverId, `🔔 <b>NOUVELLE COMMANDE #${order.id}</b> reçue !`);
      await sendDetailedDriverDeliveries(driverInfo.driverId, driverInfo.zone);
    } catch (err) {
      console.error(`❌ Erreur notification livreur:`, err.message);
    }

    console.log(`📦 Commande #${order.id} assignée à ${driverInfo.driverName} (${driverInfo.zone}) - livreur notifié`);
  } else {
    console.log(`⚠️ Commande #${order.id} zone ${driverInfo.zone} - aucun livreur configuré pour aujourd'hui`);
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

app.get('/health', async (req, res) => {
  const dbPath = process.env.DATABASE_PATH || './boutique.db';
  const dbExists = fs.existsSync(dbPath);
  let dbSize = 0;
  let orderCount = 0;
  let loyaltyCount = 0;

  if (dbExists) {
    dbSize = fs.statSync(dbPath).size;
  }
  if (db) {
    try {
      const o = await db.get('SELECT COUNT(*) as c FROM orders');
      const l = await db.get('SELECT COUNT(*) as c FROM loyalty');
      orderCount = o?.c || 0;
      loyaltyCount = l?.c || 0;
    } catch (e) {}
  }

  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    telegram: !!config.telegram.token,
    database: {
      connected: !!db,
      path: dbPath,
      exists: dbExists,
      persistent: dbPath.startsWith('/data'),
      sizeMB: (dbSize / 1024 / 1024).toFixed(2),
      orders: orderCount,
      loyaltyRecords: loyaltyCount
    }
  });
});

// ==================== NOUVEAU : API PRODUITS ====================
app.get('/api/products', apiLimiter, async (req, res) => {
  try {
    const productsData = await db.get(
      "SELECT value FROM settings WHERE key = 'products'"
    );

    const products = productsData?.value ? JSON.parse(productsData.value) : [];

    // Merge real stock quantities from the stock table into product variants
    const stockRows = await db.all('SELECT product_id, variant, qty FROM stock');
    const stockMap = {};
    for (const row of stockRows) {
      if (!stockMap[row.product_id]) stockMap[row.product_id] = {};
      stockMap[row.product_id][row.variant] = row.qty;
    }

    for (const product of products) {
      if (product.variants) {
        for (const [variantName, variantData] of Object.entries(product.variants)) {
          const realQty = (stockMap[product.id] && stockMap[product.id][variantName]) || 0;
          variantData.stock = realQty;
        }
      }
    }

    res.json({ ok: true, products });
  } catch (error) {
    console.error('Products error:', error);
    res.status(500).json({ ok: false, error: 'Erreur serveur' });
  }
});

// ==================== ENREGISTREMENT TELEGRAM VISITEURS ====================
app.post('/api/register-telegram', apiLimiter, async (req, res) => {
  try {
    const { telegram_id, first_name, last_name, username } = req.body;

    if (!telegram_id) {
      return res.status(400).json({ ok: false, error: 'telegram_id requis' });
    }

    const fullName = [first_name, last_name].filter(Boolean).join(' ') || 'Visiteur';

    await db.run(`
      INSERT INTO telegram_clients (telegram_id, first_name, username, last_seen)
      VALUES (?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(telegram_id) DO UPDATE SET
        first_name = excluded.first_name,
        username = excluded.username,
        last_seen = CURRENT_TIMESTAMP
    `, [String(telegram_id), fullName, username || null]);

    console.log(`📱 Visiteur Telegram enregistré: ${telegram_id} (${fullName})`);
    res.json({ ok: true });
  } catch (error) {
    console.error('Register telegram error:', error);
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

    // Vérifier l'identité du demandeur (initData signé ou fallback telegramId)
    const verifiedTelegramId = getVerifiedTelegramId(req);
    if (!verifiedTelegramId || (order.client_telegram_id !== verifiedTelegramId && order.customer !== verifiedTelegramId)) {
      return res.status(403).json({ ok: false, error: 'Non autorisé' });
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

    // Transaction atomique : restauration stock + suppression revenu + remboursement crédit + annulation commande
    const items = JSON.parse(order.items);
    await db.run('BEGIN IMMEDIATE');
    try {
      await restoreStockForOrder(items, orderId, { inTransaction: true });

      await db.run(
        'DELETE FROM transactions WHERE description = ?',
        [`Commande #${orderId}`]
      );

      // Rembourser le crédit utilisé si applicable
      if (order.credit_used > 0) {
        await db.run(
          'UPDATE referrals SET credit_balance = credit_balance + ? WHERE customer_contact = ?',
          [order.credit_used, order.customer]
        );
      }

      await db.run(
        'UPDATE orders SET status = ?, cancel_reason = ?, cancelled_at = CURRENT_TIMESTAMP WHERE id = ?',
        ['cancelled', reason || 'Annulée par le client', orderId]
      );

      await db.run('COMMIT');
    } catch (txErr) {
      await db.run('ROLLBACK');
      throw txErr;
    }

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

    // Vérifier l'identité du demandeur (initData signé ou fallback telegramId)
    const verifiedTelegramId = getVerifiedTelegramId(req);
    if (!verifiedTelegramId || (order.client_telegram_id !== verifiedTelegramId && order.customer !== verifiedTelegramId)) {
      return res.status(403).json({ ok: false, error: 'Non autorisé' });
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
    }

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
            qty: remainingQty,
            lineTotal: item.price * remainingQty
          });
        }
      } else {
        remainingItems.push(item);
      }
    }

    // Si tous les articles sont annulés, annuler complètement la commande
    if (remainingItems.length === 0) {
      // Transaction atomique : restauration stock + annulation commande + suppression revenu + remboursement crédit
      await db.run('BEGIN IMMEDIATE');
      try {
        await restoreStockForOrder(itemsToRemove, orderId, { inTransaction: true });

        await db.run(
          'DELETE FROM transactions WHERE description = ?',
          [`Commande #${orderId}`]
        );

        // Rembourser le crédit utilisé si applicable
        if (order.credit_used > 0) {
          await db.run(
            'UPDATE referrals SET credit_balance = credit_balance + ? WHERE customer_contact = ?',
            [order.credit_used, order.customer]
          );
        }

        await db.run(
          'UPDATE orders SET status = ?, cancel_reason = ?, cancelled_at = CURRENT_TIMESTAMP WHERE id = ?',
          ['cancelled', reason || 'Annulation totale des articles', orderId]
        );

        await db.run('COMMIT');
      } catch (txErr) {
        await db.run('ROLLBACK');
        throw txErr;
      }

      chatManager.closeConversation(parseInt(orderId));

      console.log(`✅ Order #${orderId} fully cancelled (all items removed)`);

      return res.json({
        ok: true,
        message: 'Tous les articles annulés - Commande complètement annulée',
        fullyCancelled: true,
        refundAmount: order.total
      });
    }

    // Recalculer le total de la commande
    let newItemsTotal = 0;
    for (const item of remainingItems) {
      newItemsTotal += item.price * item.qty;
    }

    // Ajouter les frais de livraison (ne sont pas remboursés lors d'une annulation partielle)
    const orderDeliveryFee = order.delivery_fee || 0;
    let newTotalBeforeCredit = newItemsTotal + orderDeliveryFee;

    // Appliquer la réduction si elle existe (discount est une valeur absolue, pas un pourcentage)
    if (order.discount > 0) {
      newTotalBeforeCredit = Math.max(0, newTotalBeforeCredit - order.discount);
    }

    // Recalculer le crédit : rembourser proportionnellement si le nouveau total est inférieur au crédit utilisé
    const originalCreditUsed = order.credit_used || 0;
    const creditToKeep = Math.min(originalCreditUsed, newTotalBeforeCredit);
    const creditToRefund = originalCreditUsed - creditToKeep;
    const newTotal = Math.round((newTotalBeforeCredit - creditToKeep) * 100) / 100;

    // Calculer le remboursement réel (basé sur ce que le client a payé en espèces)
    const actualRefund = order.total - newTotal;

    // Transaction atomique : restauration stock + mise à jour commande + mise à jour revenu + remboursement crédit
    await db.run('BEGIN IMMEDIATE');
    try {
      await restoreStockForOrder(itemsToRemove, orderId, { inTransaction: true });

      // Mettre à jour la commande avec les articles restants et le crédit ajusté
      await db.run(
        'UPDATE orders SET items = ?, total = ?, credit_used = ? WHERE id = ?',
        [JSON.stringify(remainingItems), newTotal, creditToKeep, orderId]
      );

      // Rembourser le crédit excédentaire au client
      if (creditToRefund > 0) {
        await db.run(
          'UPDATE referrals SET credit_balance = credit_balance + ? WHERE customer_contact = ?',
          [creditToRefund, order.customer]
        );
      }

      // Mettre à jour la transaction
      await db.run(
        'UPDATE transactions SET amount = ? WHERE description = ?',
        [newTotal, `Commande #${orderId}`]
      );

      await db.run('COMMIT');
    } catch (txErr) {
      await db.run('ROLLBACK');
      throw txErr;
    }

    console.log(`✅ Order #${orderId} partially cancelled. ${itemsToRemove.length} item(s) removed.${creditToRefund > 0 ? ` ${creditToRefund}€ credit refunded.` : ''}`);

    res.json({
      ok: true,
      message: 'Articles annulés avec succès',
      fullyCancelled: false,
      refundAmount: actualRefund,
      creditRefunded: creditToRefund,
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

    const { customer, customerName, type, address, city, items, total, referralCode, useCredit, telegramId, timeSlot, customerDescription, deliveryFee: rawDeliveryFee } = req.body;

    // ==================== VALIDATION DES PRIX CÔTÉ SERVEUR ====================
    // Charger le catalogue produit et vérifier chaque article contre les prix réels
    const productsData = await db.get("SELECT value FROM settings WHERE key = 'products'");
    const productCatalog = productsData?.value ? JSON.parse(productsData.value) : [];

    for (const item of items) {
      const catalogProduct = productCatalog.find(p => p.id === item.product_id);
      if (!catalogProduct) {
        return res.status(400).json({ ok: false, error: `Produit introuvable (ID: ${item.product_id})` });
      }

      if (!catalogProduct.variants || !catalogProduct.variants[item.variant]) {
        return res.status(400).json({ ok: false, error: `Variante "${item.variant}" introuvable pour ${catalogProduct.name}` });
      }

      const catalogPrice = catalogProduct.variants[item.variant].price;
      if (Math.abs(item.price - catalogPrice) > 0.01) {
        console.warn(`⚠️ Tentative de manipulation de prix: ${catalogProduct.name} ${item.variant} — envoyé ${item.price}€, réel ${catalogPrice}€`);
        return res.status(400).json({ ok: false, error: `Prix incorrect pour ${catalogProduct.name} ${item.variant}. Rechargez la page.` });
      }

      // Forcer le prix du catalogue (ne jamais faire confiance au client)
      item.price = catalogPrice;
      item.lineTotal = catalogPrice * item.qty;
    }

    // Valider les frais de livraison côté serveur (ne pas faire confiance au client)
    const deliveryZoneRules = {
      'millau': { fee: 0, min: 0, level: 0 },
      'zone 1': { fee: 10, min: 50, level: 1 },
      'zone 2': { fee: 20, min: 80, level: 2 },
      'zone 3': { fee: 30, min: 100, level: 3 },
      'zone 4': { fee: 40, min: 150, level: 4 },
    };
    const typeLower = (type || '').toLowerCase();
    let serverZone = null;
    let serverZoneKey = null;
    for (const [zone, rules] of Object.entries(deliveryZoneRules)) {
      if (typeLower.includes(zone)) { serverZone = rules; serverZoneKey = zone; break; }
    }
    const deliveryFee = serverZone ? serverZone.fee : 0;

    // Valider que la zone correspond au code postal / commune du client
    const postalCodeMinZone = {
      '12100': 'millau',
      '12520': 'zone 1', '12640': 'zone 1',
      '12400': 'zone 2', '12490': 'zone 2', '12150': 'zone 2', '12410': 'zone 2',
      '12620': 'zone 2', '12230': 'zone 2', '12250': 'zone 2', '12720': 'zone 2',
      '12170': 'zone 3', '12290': 'zone 3', '12780': 'zone 3',
      '12360': 'zone 3', '12370': 'zone 3', '12540': 'zone 3',
      '12550': 'zone 3', '12380': 'zone 3', '12480': 'zone 3',
      '12000': 'zone 4', '12850': 'zone 4', '12800': 'zone 4',
      '12500': 'zone 4', '48500': 'zone 4', '48100': 'zone 4',
    };
    const communeZone = {
      'Millau': 'millau',
      'Aguessac': 'zone 1', 'Comprégnac': 'zone 1', 'Compeyre': 'zone 1', 'Creissels': 'zone 1',
      'La Cresse': 'zone 1', 'Paulhe': 'zone 1', 'Rivière-sur-Tarn': 'zone 1',
      'Saint-Georges-de-Luzençon': 'zone 1', 'Verrières': 'zone 1',
      'La Roque-Sainte-Marguerite': 'zone 2', 'Mostuéjouls': 'zone 2', 'Peyreleau': 'zone 2',
      'Saint-André-de-Vézines': 'zone 2', 'Veyreau': 'zone 2',
      'La Bastide-Pradines': 'zone 2', 'La Cavalerie': 'zone 2', 'Cornus': 'zone 2',
      'La Couvertoirade': 'zone 2', "L'Hospitalet-du-Larzac": 'zone 2', 'Lapanouse-de-Cernon': 'zone 2',
      'Nant': 'zone 2', 'Roquefort-sur-Soulzon': 'zone 2', 'Saint-Beaulize': 'zone 2',
      'Sainte-Eulalie-de-Cernon': 'zone 2', "Saint-Jean-d'Alcapiès": 'zone 2',
      'Saint-Jean-du-Bruel': 'zone 2', 'Saint-Jean-et-Saint-Paul': 'zone 2',
      'Saint-Rome-de-Cernon': 'zone 2', 'Sauclières': 'zone 2', 'Tournemire': 'zone 2',
      'Viala-du-Pas-de-Jaux': 'zone 2',
      'Alrance': 'zone 2', 'Castelnau-Pégayrols': 'zone 2', 'Comps-la-Grand-Ville': 'zone 2',
      'Curan': 'zone 2', 'Flavin': 'zone 2', 'Saint-Beauzély': 'zone 2',
      'Saint-Laurent-de-Lévézou': 'zone 2', 'Salles-Curan': 'zone 2', 'Villefranche-de-Panat': 'zone 2',
      'Les Costes-Gozon': 'zone 2', 'Le Truel': 'zone 2', 'Montjaux': 'zone 2',
      'Peux-et-Couffouleux': 'zone 2', 'Saint-Rome-de-Tarn': 'zone 2',
      'Saint-Victor-et-Melvieu': 'zone 2', 'Viala-du-Tarn': 'zone 2',
      'Calmels-et-le-Viala': 'zone 2', 'Le Clapier': 'zone 2', 'Montclar': 'zone 2',
      'Saint-Affrique': 'zone 2', "Vabres-l'Abbaye": 'zone 2',
      'Arnac-sur-Dourdou': 'zone 3', 'Brusque': 'zone 3', 'Camarès': 'zone 3', 'Combret': 'zone 3',
      'Fayet': 'zone 3', 'Montagnol': 'zone 3', 'Montlaur': 'zone 3', 'Mounes-Prohencoux': 'zone 3',
      'Plaisance': 'zone 3', 'Saint-Félix-de-Sorgues': 'zone 3', 'Saint-Sever-du-Moustier': 'zone 3',
      'La Serre': 'zone 3', 'Sylvanès': 'zone 3', 'Tauriac-de-Camarès': 'zone 3',
      'La Bastide-Solages': 'zone 3', 'Belmont-sur-Rance': 'zone 3', 'Coupiac': 'zone 3',
      'Laval-Roquecezière': 'zone 3', 'Martrin': 'zone 3', 'Murasson': 'zone 3',
      'Balaguier-sur-Rance': 'zone 3', 'Brasc': 'zone 3', 'Connac': 'zone 3', 'Gissac': 'zone 3',
      'Marnhagues-et-Latour': 'zone 3', 'Montfranc': 'zone 3', 'Pousthomy': 'zone 3',
      'Rebourguil': 'zone 3', 'Saint-Sernin-sur-Rance': 'zone 3', 'La Selve': 'zone 3',
      'Versols-et-Lapeyre': 'zone 3',
      'Fondamente': 'zone 3', 'Mélagues': 'zone 3',
      'Ayssènes': 'zone 3', 'Broquiès': 'zone 3', 'Brousse-le-Château': 'zone 3', 'Saint-Izaire': 'zone 3',
      'Arques': 'zone 3', 'Auriac-Lagast': 'zone 3', 'Durenque': 'zone 3', 'Lédergues': 'zone 3',
      'Lestrade-et-Thouels': 'zone 3', 'Réquista': 'zone 3', 'Rullac-Saint-Cirq': 'zone 3',
      'Saint-Jean-Delnous': 'zone 3', 'Saint-Juéry': 'zone 3', 'Salmiech': 'zone 3',
      "Agen-d'Aveyron": 'zone 3', 'Arvieu': 'zone 3', 'Pont-de-Salars': 'zone 3',
      'Canet-de-Salars': 'zone 3', 'Ségur': 'zone 3', 'Prades-Salars': 'zone 3',
      'Trémouilles': 'zone 3', 'Le Vibal': 'zone 3', 'Saint-Léons': 'zone 3',
      'Vézins-de-Lévézou': 'zone 3',
    };
    const cityStr = (city || '').trim();
    const cpServerMatch = cityStr.match(/\((\d{5})\)/);
    const communeServerMatch = cityStr.match(/^(.+?)\s*\(/);
    const communeName = communeServerMatch ? communeServerMatch[1].trim() : '';
    if (cpServerMatch) {
      const cp = cpServerMatch[1];
      // Priorité à la commune, sinon fallback au code postal
      const requiredZoneKey = (communeName && communeZone[communeName]) || postalCodeMinZone[cp] || 'zone 4';
      const requiredZone = deliveryZoneRules[requiredZoneKey];
      const selectedLevel = serverZone ? serverZone.level : 0;
      if (requiredZone && selectedLevel < requiredZone.level) {
        console.warn(`⚠️ Zone incorrecte: ${communeName || cp} nécessite ${requiredZoneKey}, client a sélectionné ${serverZoneKey || 'millau'}`);
        return res.status(400).json({ ok: false, error: `Votre ville (${communeName || cp}) nécessite au minimum la ${requiredZoneKey}. Rechargez la page.` });
      }
    }

    // Vérifier le minimum de commande pour la zone (avec les prix vérifiés du catalogue)
    const itemsSubtotal = items.reduce((sum, item) => sum + (item.price * item.qty), 0);
    if (serverZone && serverZone.min > 0 && itemsSubtotal < serverZone.min) {
      return res.status(400).json({ ok: false, error: `Minimum ${serverZone.min}€ requis pour cette zone de livraison` });
    }

    const sanitizedCustomer = sanitizeString(customer, 100);
    const sanitizedType = sanitizeString(type, 50);
    let sanitizedTimeSlot = 'asap';
    if (!timeSlot || timeSlot === 'asap') {
      sanitizedTimeSlot = 'asap';
    } else if (typeof timeSlot === 'string' && /^([01]\d|2[0-3]):(00|30)$/.test(timeSlot)) {
      sanitizedTimeSlot = timeSlot;
    } else {
      throw new ValidationError('Créneau de livraison invalide');
    }
    const sanitizedAddress = sanitizeString(address, 200);
    const sanitizedDescription = sanitizeString(customerDescription || '', 200);

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

    // Remise automatique : -10€ dès 100€ de commande (pour tout le monde)
    // Utiliser itemsSubtotal (articles seuls) et non total (qui inclut livraison)
    if (itemsSubtotal >= 100) {
      discount += 10;
      console.log(`🎉 Remise 10€ appliquée (sous-total articles ${itemsSubtotal}€ >= 100€)`);
    }

    // ==================== TRANSACTION ATOMIQUE ====================
    // Tout dans une seule transaction : crédit + commande + stock + fidélité + revenu
    let creditUsed = 0;
    let remainingCredit = 0;
    let orderId;
    let order;

    const sanitizedName = customerName ? sanitizeString(customerName, 100) : sanitizedCustomer;
    const orderStatus = isNewCustomer ? 'pending_approval' : 'pending';

    await db.run('BEGIN IMMEDIATE');
    try {
      // 0. Vérifier la disponibilité du stock avant de procéder
      // Auto-repair: si un stock est à 0 ou manquant, le réinitialiser depuis la config produit
      const productsConfig = await db.get("SELECT value FROM settings WHERE key = 'products'");
      const allProducts = productsConfig?.value ? JSON.parse(productsConfig.value) : [];
      for (const item of items) {
        let stockRow = await db.get(
          'SELECT qty, manual FROM stock WHERE product_id = ? AND variant = ?',
          [item.product_id, item.variant]
        );
        // Auto-repair: stock manquant ou à 0 → remettre la valeur par défaut
        // SAUF si l'admin a manuellement mis le stock (manual = 1)
        if ((!stockRow || stockRow.qty === 0) && !stockRow?.manual) {
          const productCfg = allProducts.find(p => p.id === item.product_id);
          const defaultQty = productCfg?.variants?.[item.variant]?.stock || 0;
          if (defaultQty > 0) {
            if (!stockRow) {
              await db.run('INSERT INTO stock (product_id, variant, qty) VALUES (?, ?, ?)', [item.product_id, item.variant, defaultQty]);
            } else {
              await db.run('UPDATE stock SET qty = ? WHERE product_id = ? AND variant = ?', [defaultQty, item.product_id, item.variant]);
            }
            stockRow = { qty: defaultQty };
            console.log(`🔧 Auto-repair stock: ${item.name} ${item.variant} → ${defaultQty}`);
          }
        }
        if (!stockRow || stockRow.qty < item.qty) {
          const available = stockRow?.qty || 0;
          await db.run('ROLLBACK');
          return res.status(400).json({
            ok: false,
            error: `Stock insuffisant pour "${item.name} ${item.variant}". Disponible: ${available}, demandé: ${item.qty}`
          });
        }
      }

      // 1. Déduire le crédit si demandé
      if (useCredit === true || useCredit === 'true') {
        const totalAfterDiscount = total - discount;
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
      }

      // Recalculer le total côté serveur (ne pas faire confiance au client)
      const serverItemsTotal = items.reduce((sum, item) => sum + (item.price * item.qty), 0);
      const finalTotal = Math.round((serverItemsTotal + deliveryFee - discount - creditUsed) * 100) / 100;

      // 2. Lier telegram_id au contact
      if (telegramId) {
        await db.run(`
          INSERT INTO telegram_clients (telegram_id, contact, first_name)
          VALUES (?, ?, ?)
          ON CONFLICT(telegram_id) DO UPDATE SET
            contact = excluded.contact,
            first_name = excluded.first_name
        `, [telegramId, sanitizedCustomer, sanitizedName]);
      }

      // 3. Récupérer l'ID Telegram du client
      const clientTelegramId = telegramId || await getClientTelegramId(sanitizedCustomer);

      // 4. Créer la commande
      const result = await db.run(
        `INSERT INTO orders (customer, type, address, items, total, discount, status, client_telegram_id, time_slot, customer_description, credit_used, delivery_fee, customer_name)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [sanitizedCustomer, sanitizedType, sanitizedAddress, JSON.stringify(items), finalTotal, discount, orderStatus, clientTelegramId, sanitizedTimeSlot, sanitizedDescription, creditUsed, deliveryFee, sanitizedName]
      );
      orderId = result.lastID;

      // 5. Mettre à jour la fidélité
      if (isApproved) {
        await updateLoyaltyProgram(sanitizedCustomer);
      }

      // 6. Déduire le stock (dans la même transaction)
      await updateStockForOrder(items, orderId, { inTransaction: true });

      // 7. Enregistrer la transaction de revenu
      if (!isNewCustomer) {
        await db.run(
          `INSERT INTO transactions (type, category, description, amount, payment_method, date)
           VALUES ('revenue', 'vente', ?, ?, 'online', DATE('now'))`,
          [`Commande #${orderId}`, finalTotal]
        );
      }

      await db.run('COMMIT');
    } catch (txErr) {
      await db.run('ROLLBACK');
      console.error('❌ Order transaction failed, all changes rolled back:', txErr.message);
      throw txErr;
    }

    console.log(`✅ Order #${orderId} created atomically with status: ${orderStatus}`);
    if (creditUsed > 0) {
      console.log(`💳 Credit used: ${creditUsed} DA (remaining: ${remainingCredit} DA)`);
    }

    order = await db.get('SELECT * FROM orders WHERE id = ?', [orderId]);

    // ==================== SYSTÈME DE PARRAINAGE ====================
    // Créer ou récupérer le code de parrainage du client
    const customerReferral = await getOrCreateReferralCode(sanitizedCustomer);
    let referralResult = null;

    // Appliquer les crédits de parrainage uniquement pour la première commande d'un nouveau client
    if (referralCode && referralCode.trim().length > 0) {
      const previousOrderCount = await db.get(
        'SELECT COUNT(*) as count FROM orders WHERE customer = ? AND id != ?',
        [sanitizedCustomer, orderId]
      );
      if (previousOrderCount && previousOrderCount.count > 0) {
        console.log(`⚠️ Referral code ignored: ${sanitizedCustomer} already has ${previousOrderCount.count} previous orders`);
      } else {
        referralResult = await applyReferralCredits(referralCode.trim(), sanitizedCustomer, orderId);
      }
    }

    // Notification Telegram pour le parrain si un code a été utilisé
    if (referralResult && referralResult.referrerContact) {
      await notifyReferralSuccess(
        referralResult.referrerContact,
        sanitizedCustomer,
        orderId,
        {
          hitMilestone: referralResult.hitMilestone,
          newTotalReferrals: referralResult.newTotalReferrals
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
    const { customer, initData } = req.query;

    if (!customer) {
      return res.status(400).json({ ok: false, error: 'Contact client manquant' });
    }

    // Vérifier que le demandeur est bien le propriétaire des données
    if (initData) {
      const validatedUser = validateTelegramInitData(initData);
      if (!validatedUser || String(validatedUser.id) !== String(customer)) {
        return res.status(403).json({ ok: false, error: 'Non autorisé' });
      }
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

    // Un seul JOIN au lieu de N+1 queries (1 query par utilisateur)
    const leaderboard = await db.all(`
      SELECT
        r.customer_contact,
        r.total_referrals,
        r.total_earned,
        COALESCE(tc.first_name, r.customer_contact) AS display_name
      FROM referrals r
      LEFT JOIN telegram_clients tc ON tc.contact = r.customer_contact OR tc.telegram_id = r.customer_contact
      WHERE r.total_referrals > 0
      ORDER BY r.total_referrals DESC, r.total_earned DESC
      LIMIT ?
    `, [limit]);

    const leaderboardWithInfo = leaderboard.map((user, index) => {
      const displayName = user.display_name || user.customer_contact;
      const maskedName = displayName.length > 2
        ? displayName.substring(0, 2) + '***'
        : displayName[0] + '***';

      return {
        rank: index + 1,
        contact: maskedName,
        totalReferrals: user.total_referrals || 0,
        totalEarned: user.total_earned
      };
    });

    res.json({
      ok: true,
      leaderboard: leaderboardWithInfo
    });
  } catch (error) {
    console.error('Leaderboard error:', error);
    res.status(500).json({ ok: false, error: 'Erreur serveur' });
  }
});

app.get('/api/credit-balance', apiLimiter, async (req, res) => {
  try {
    const { customer, initData } = req.query;

    if (!customer) {
      return res.status(400).json({ ok: false, error: 'Contact client manquant' });
    }

    // Vérifier que le demandeur est bien le propriétaire des données
    if (initData) {
      const validatedUser = validateTelegramInitData(initData);
      if (!validatedUser || String(validatedUser.id) !== String(customer)) {
        return res.status(403).json({ ok: false, error: 'Non autorisé' });
      }
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
  const token = req.headers['x-admin-token'];
  if (!token || !adminTokens.has(token)) {
    return res.status(401).json({ ok: false, error: 'Non autorisé' });
  }
  next();
}

// ==================== ADMIN ROUTES ====================

app.post('/api/admin/login', authLimiter, async (req, res) => {
  const { password } = req.body;

  try {
    console.log('🔐 Tentative de connexion admin');
    const isValid = await verifyAdminPassword(password);
    if (isValid) {
      console.log('✅ Admin login réussi');
      const token = adminTokens.generateToken();
      adminTokens.add(token);
      res.json({ ok: true, token });
    } else {
      console.log('❌ Admin login échoué: mot de passe incorrect');
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

    // Revenus aujourd'hui / semaine / mois
    const todayRev = await db.get(
      "SELECT COALESCE(SUM(total),0) as total FROM orders WHERE status != 'cancelled' AND DATE(created_at) = DATE('now')"
    );
    stats.todayCA = todayRev?.total || 0;

    const weekRev = await db.get(
      "SELECT COALESCE(SUM(total),0) as total FROM orders WHERE status != 'cancelled' AND created_at >= DATE('now', '-7 days')"
    );
    stats.weekCA = weekRev?.total || 0;

    const monthRev = await db.get(
      "SELECT COALESCE(SUM(total),0) as total FROM orders WHERE status != 'cancelled' AND created_at >= DATE('now', '-30 days')"
    );
    stats.monthCA = monthRev?.total || 0;

    // Commandes en cours
    const pending = await db.get(
      "SELECT COUNT(*) as count FROM orders WHERE status IN ('pending', 'pending_approval')"
    );
    stats.pendingOrders = pending?.count || 0;

    // Évolution des ventes (7 derniers jours)
    const dailySales = await db.all(
      `SELECT DATE(created_at) as day, COALESCE(SUM(total),0) as total
       FROM orders WHERE status != 'cancelled' AND created_at >= DATE('now', '-6 days')
       GROUP BY DATE(created_at) ORDER BY day ASC`
    );
    // Remplir les jours manquants
    stats.dailySales = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(); d.setDate(d.getDate() - i);
      const dayStr = d.toISOString().split('T')[0];
      const found = dailySales.find(r => r.day === dayStr);
      const dayNames = ['Dim', 'Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam'];
      stats.dailySales.push({ day: dayNames[d.getDay()], total: found?.total || 0 });
    }

    // Top produits (vraies ventes)
    const allOrders = await db.all("SELECT items FROM orders WHERE status != 'cancelled'");
    const productCounts = {};
    const categoryRevenue = {};

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
    stats.topProducts = sorted.slice(0, 5).map(([name, qty]) => ({ name, qty }));

    // Catégories (depuis les produits stockés en settings + ventes)
    const productsData = await db.get("SELECT value FROM settings WHERE key = 'products'");
    const products = productsData?.value ? JSON.parse(productsData.value) : [];
    const productCategories = {};
    products.forEach(p => { productCategories[p.name] = (p.category || 'autres').toLowerCase(); });

    allOrders.forEach(order => {
      try {
        const items = JSON.parse(order.items);
        items.forEach(item => {
          const cat = productCategories[item.name] || 'autres';
          categoryRevenue[cat] = (categoryRevenue[cat] || 0) + (item.lineTotal || item.qty * (item.price || 0));
        });
      } catch (e) {}
    });
    stats.categories = Object.entries(categoryRevenue)
      .sort((a, b) => b[1] - a[1])
      .map(([name, revenue]) => ({ name, revenue }));

    // Stock
    const stock = await db.all('SELECT * FROM stock');
    stats.stockOut = stock.filter(s => s.qty === 0).length;
    stats.stockLow = stock.filter(s => s.qty > 0 && s.qty < 10).length;

    // Clients
    const customers = await db.get("SELECT COUNT(*) as count FROM customers");
    stats.totalCustomers = customers?.count || 0;

    res.json({ ok: true, stats });
  } catch (error) {
    console.error('Stats error:', error);
    res.status(500).json({ ok: false, error: 'Erreur serveur' });
  }
});

app.get('/api/admin/driver-caisse', requireAdmin, async (req, res) => {
  try {
    const { zone, days = 30 } = req.query;

    let query = `
      SELECT id, address, items, total, created_at, assigned_driver_zone
      FROM orders
      WHERE status = 'delivered'
      AND DATE(created_at) >= DATE('now', '-' || ? || ' days')
    `;
    const params = [days];

    if (zone && zone !== 'all') {
      query += ' AND assigned_driver_zone = ?';
      params.push(zone);
    }

    query += ' ORDER BY created_at DESC';

    const orders = await db.all(query, params);

    const millauOrders = orders.filter(o => o.assigned_driver_zone === 'millau');
    const exterieurOrders = orders.filter(o => o.assigned_driver_zone === 'exterieur');

    res.json({
      ok: true,
      millau: {
        count: millauOrders.length,
        total: millauOrders.reduce((s, o) => s + (o.total || 0), 0),
        orders: millauOrders.map(o => ({
          id: o.id,
          address: o.address,
          items: JSON.parse(o.items || '[]'),
          total: o.total,
          date: o.created_at
        }))
      },
      exterieur: {
        count: exterieurOrders.length,
        total: exterieurOrders.reduce((s, o) => s + (o.total || 0), 0),
        orders: exterieurOrders.map(o => ({
          id: o.id,
          address: o.address,
          items: JSON.parse(o.items || '[]'),
          total: o.total,
          date: o.created_at
        }))
      }
    });
  } catch (error) {
    console.error('Error fetching driver caisse:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

// ==================== GESTION LIVREURS & PLANNING ====================

// Liste des livreurs
app.get('/api/admin/drivers', requireAdmin, async (req, res) => {
  try {
    const drivers = await db.all('SELECT * FROM drivers ORDER BY name');
    res.json({ ok: true, drivers });
  } catch (error) {
    console.error('Error fetching drivers:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

// Ajouter un livreur
app.post('/api/admin/drivers', requireAdmin, async (req, res) => {
  try {
    const { name, telegram_id } = req.body;
    if (!name || !telegram_id) {
      return res.status(400).json({ ok: false, error: 'Nom et Telegram ID requis' });
    }
    const result = await db.run(
      'INSERT INTO drivers (name, telegram_id) VALUES (?, ?)',
      [name.trim(), telegram_id.trim()]
    );
    res.json({ ok: true, id: result.lastID });
  } catch (error) {
    if (error.message.includes('UNIQUE')) {
      return res.status(400).json({ ok: false, error: 'Ce Telegram ID existe déjà' });
    }
    console.error('Error adding driver:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

// Supprimer un livreur
app.delete('/api/admin/drivers/:id', requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    await db.run('DELETE FROM driver_schedule WHERE driver_id = ?', [id]);
    await db.run('DELETE FROM drivers WHERE id = ?', [id]);
    res.json({ ok: true });
  } catch (error) {
    console.error('Error deleting driver:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

// Récupérer le planning de la semaine
app.get('/api/admin/driver-schedule', requireAdmin, async (req, res) => {
  try {
    const schedule = await db.all(`
      SELECT ds.id, ds.zone, ds.day_of_week, ds.driver_id, d.name as driver_name, d.telegram_id
      FROM driver_schedule ds
      LEFT JOIN drivers d ON d.id = ds.driver_id
      WHERE d.id IS NOT NULL
      ORDER BY ds.day_of_week, ds.zone
    `);
    res.json({ ok: true, schedule });
  } catch (error) {
    console.error('Error fetching schedule:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

// Mettre à jour le planning (assigner un livreur à une zone pour un jour)
app.post('/api/admin/driver-schedule', requireAdmin, async (req, res) => {
  try {
    const { driver_id, zone, day_of_week } = req.body;
    if (!zone || day_of_week === undefined || day_of_week === null) {
      return res.status(400).json({ ok: false, error: 'Zone et jour requis' });
    }
    if (!['millau', 'exterieur'].includes(zone)) {
      return res.status(400).json({ ok: false, error: 'Zone invalide' });
    }
    if (day_of_week < 0 || day_of_week > 6) {
      return res.status(400).json({ ok: false, error: 'Jour invalide (0-6)' });
    }

    if (!driver_id) {
      // Supprimer l'assignation pour ce jour/zone
      await db.run('DELETE FROM driver_schedule WHERE zone = ? AND day_of_week = ?', [zone, day_of_week]);
    } else {
      // Vérifier que le livreur existe
      const driver = await db.get('SELECT id FROM drivers WHERE id = ? AND active = 1', [driver_id]);
      if (!driver) {
        return res.status(400).json({ ok: false, error: 'Livreur introuvable ou inactif' });
      }
      // Upsert: remplacer l'assignation existante
      await db.run(`
        INSERT INTO driver_schedule (driver_id, zone, day_of_week) VALUES (?, ?, ?)
        ON CONFLICT(zone, day_of_week) DO UPDATE SET driver_id = excluded.driver_id
      `, [driver_id, zone, day_of_week]);
    }

    res.json({ ok: true });
  } catch (error) {
    console.error('Error updating schedule:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

// Compter les clients enregistrés pour le broadcast
app.get('/api/admin/broadcast/count', requireAdmin, async (req, res) => {
  try {
    const result = await db.get('SELECT COUNT(*) as count FROM telegram_clients');
    res.json({ ok: true, count: result?.count || 0 });
  } catch (error) {
    console.error('Broadcast count error:', error);
    res.status(500).json({ ok: false, error: 'Erreur serveur' });
  }
});

app.post('/api/admin/broadcast', requireAdmin, async (req, res) => {
  try {
    const { message } = req.body;
    if (!message || !message.trim()) {
      return res.status(400).json({ ok: false, error: 'Message requis' });
    }

    const clients = await db.all('SELECT telegram_id, first_name FROM telegram_clients');

    if (clients.length === 0) {
      return res.json({ ok: true, sent: 0, failed: 0, total: 0 });
    }

    let sent = 0;
    let failed = 0;

    for (const client of clients) {
      try {
        await telegram.sendMessage(client.telegram_id, message);
        sent++;
      } catch (err) {
        failed++;
      }
      // Délai anti-spam : 50ms entre chaque message (max 20 msg/sec)
      await new Promise(r => setTimeout(r, 50));
    }

    res.json({ ok: true, sent, failed, total: clients.length });
  } catch (error) {
    console.error('Error broadcasting:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

// ==================== CUSTOMER ORDERS (status sync) ====================
const customerOrdersLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 20,
  message: { ok: false, error: 'Trop de requêtes' },
  validate: false,
});
app.get('/api/customer/orders', customerOrdersLimiter, async (req, res) => {
  try {
    const { telegram_id } = req.query;
    if (!telegram_id) {
      return res.status(400).json({ ok: false, error: 'telegram_id requis' });
    }

    const sanitizedId = sanitizeString(telegram_id, 50);

    // Vérifier que le telegram_id correspond à un client enregistré
    const client = await db.get('SELECT telegram_id FROM telegram_clients WHERE telegram_id = ?', [sanitizedId]);
    if (!client) {
      return res.status(403).json({ ok: false, error: 'Client non reconnu' });
    }
    const orders = await db.all(
      `SELECT id, status, type, total, discount, items, cancel_reason, cancelled_at, delivery_time, created_at
       FROM orders
       WHERE client_telegram_id = ? OR customer = ?
       ORDER BY created_at DESC
       LIMIT 50`,
      [sanitizedId, sanitizedId]
    );

    orders.forEach(order => {
      try {
        order.items = JSON.parse(order.items);
      } catch (e) {
        order.items = [];
      }
    });

    res.json({ ok: true, orders });
  } catch (error) {
    console.error('Customer orders error:', error);
    res.status(500).json({ ok: false, error: 'Erreur serveur' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// SYSTÈME DE PRIORITÉ DES COMMANDES
// 1 = URGENT (rouge)  : programmé < 30 min OU ASAP > 45 min d'attente
// 2 = HAUTE  (orange) : programmé < 1h OU ASAP > 20 min d'attente
// 3 = NORMALE (bleu)  : commandes récentes
// 4 = BASSE  (gris)   : déjà livrées / annulées / programmées loin
// ═══════════════════════════════════════════════════════════════════════════
function calculateOrderPriority(order) {
  // Commandes terminées = priorité basse
  if (order.status === 'delivered' || order.status === 'cancelled') {
    return { level: 4, label: 'Terminée', emoji: '✅' };
  }

  const now = new Date();
  const orderDate = new Date(order.created_at);
  const waitingMinutes = (now - orderDate) / 60000;

  // Commande en cours de livraison
  if (order.status === 'en_route') {
    return { level: 2, label: 'En route', emoji: '🚚' };
  }

  // Commandes programmées (pas ASAP)
  if (order.time_slot && order.time_slot !== 'asap') {
    const [hours, minutes] = order.time_slot.split(':').map(Number);
    let targetDate;
    if (order.time_slot === '00:00') {
      targetDate = new Date(orderDate.getFullYear(), orderDate.getMonth(), orderDate.getDate(), 23, 59, 0);
    } else {
      targetDate = new Date(orderDate.getFullYear(), orderDate.getMonth(), orderDate.getDate(), hours, minutes, 0);
    }
    const minutesLeft = (targetDate - now) / 60000;

    // Créneau dépassé ou imminent (≤15 min) = IMMÉDIAT → passe devant TOUT
    if (minutesLeft <= 15) {
      return { level: 0, label: `IMMÉDIAT (${order.time_slot})`, emoji: '⚡' };
    }
    if (minutesLeft <= 30) {
      return { level: 1, label: `URGENT (${order.time_slot})`, emoji: '🔴' };
    }
    if (minutesLeft <= 60) {
      return { level: 2, label: `Bientôt (${order.time_slot})`, emoji: '🟠' };
    }
    return { level: 3, label: `Programmé ${order.time_slot}`, emoji: '🔵' };
  }

  // Commandes ASAP
  if (waitingMinutes > 45) {
    return { level: 1, label: `URGENT (${Math.round(waitingMinutes)} min)`, emoji: '🔴' };
  }
  if (waitingMinutes > 20) {
    return { level: 2, label: `${Math.round(waitingMinutes)} min`, emoji: '🟠' };
  }
  return { level: 3, label: 'Récente', emoji: '🟢' };
}

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
      order.priority = calculateOrderPriority(order);
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
    const body = req.body;

    // Whitelist des champs autorisés pour éviter l'injection SQL
    const allowedFields = ['status', 'type', 'address', 'total', 'discount', 'notes', 'driver_zone', 'assigned_driver', 'assigned_driver_zone'];
    const updates = {};
    for (const key of allowedFields) {
      if (body[key] !== undefined) {
        updates[key] = body[key];
      }
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ ok: false, error: 'Aucune mise à jour fournie' });
    }

    // Récupérer l'ancien statut avant mise à jour
    const oldOrder = await db.get('SELECT status, client_telegram_id, customer FROM orders WHERE id = ?', [id]);

    // Si passage en 'cancelled', restaurer stock/revenu/crédit dans une transaction atomique
    if (updates.status === 'cancelled' && oldOrder && oldOrder.status !== 'cancelled') {
      const order = await db.get('SELECT * FROM orders WHERE id = ?', [id]);
      const items = JSON.parse(order.items);
      await db.run('BEGIN IMMEDIATE');
      try {
        await restoreStockForOrder(items, id, { inTransaction: true });
        await db.run('DELETE FROM transactions WHERE description = ?', [`Commande #${id}`]);
        if (order.credit_used > 0) {
          await db.run(
            'UPDATE referrals SET credit_balance = credit_balance + ? WHERE customer_contact = ?',
            [order.credit_used, order.customer]
          );
        }
        const fields = Object.keys(updates).map(key => `${key} = ?`).join(', ');
        const values = [...Object.values(updates), id];
        await db.run(`UPDATE orders SET ${fields}, cancel_reason = 'Annulée par admin', cancelled_at = CURRENT_TIMESTAMP WHERE id = ?`, values);
        await db.run('COMMIT');
      } catch (txErr) {
        await db.run('ROLLBACK');
        throw txErr;
      }
    } else {
      const fields = Object.keys(updates).map(key => `${key} = ?`).join(', ');
      const values = [...Object.values(updates), id];
      await db.run(`UPDATE orders SET ${fields} WHERE id = ?`, values);
    }

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

    // Notification livreur si la zone a changé
    let driverNotified = false;
    if (updates.assigned_driver_zone) {
      try {
        const driverInfo = await getDriverForDeliveryZone(updates.assigned_driver_zone);
        if (driverInfo && driverInfo.driverId) {
          await telegram.sendMessage(driverInfo.driverId, `🔔 <b>COMMANDE #${id} REASSIGNÉE</b>\n\nCette commande vous a été assignée par l'admin.\nZone: ${updates.assigned_driver_zone.toUpperCase()}`);
          await sendDetailedDriverDeliveries(driverInfo.driverId, updates.assigned_driver_zone);
          driverNotified = true;
          console.log(`📦 Commande #${id} réassignée à zone ${updates.assigned_driver_zone} - livreur notifié`);
        }
      } catch (err) {
        console.error('Erreur notification livreur lors réassignation:', err.message);
      }
    }

    res.json({ ok: true, driver_notified: driverNotified });
  } catch (error) {
    console.error('Update order error:', error);
    res.status(500).json({ ok: false, error: 'Erreur serveur' });
  }
});

app.delete('/api/admin/orders/:id', requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;

    // Récupérer la commande avant suppression pour restaurer le stock
    const order = await db.get('SELECT * FROM orders WHERE id = ?', [id]);
    if (!order) {
      return res.status(404).json({ ok: false, error: 'Commande introuvable' });
    }

    // Transaction atomique : restauration stock/revenu/crédit + suppression
    await db.run('BEGIN IMMEDIATE');
    try {
      if (order.status !== 'cancelled') {
        const items = JSON.parse(order.items);
        await restoreStockForOrder(items, id, { inTransaction: true });
        await db.run('DELETE FROM transactions WHERE description = ?', [`Commande #${id}`]);
        if (order.credit_used > 0) {
          await db.run(
            'UPDATE referrals SET credit_balance = credit_balance + ? WHERE customer_contact = ?',
            [order.credit_used, order.customer]
          );
        }
      }
      await db.run('DELETE FROM orders WHERE id = ?', [id]);
      await db.run('COMMIT');
    } catch (txErr) {
      await db.run('ROLLBACK');
      throw txErr;
    }

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
      'UPDATE stock SET qty = ?, manual = 1 WHERE product_id = ? AND variant = ?',
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

app.post('/api/admin/stock/reset', requireAdmin, async (req, res) => {
  try {
    const productsData = await db.get("SELECT value FROM settings WHERE key = 'products'");
    if (!productsData?.value) {
      return res.status(404).json({ ok: false, error: 'Produits non trouvés' });
    }
    const products = JSON.parse(productsData.value);
    let repaired = 0;
    for (const product of products) {
      if (product.variants) {
        for (const [variantName, variantData] of Object.entries(product.variants)) {
          const defaultQty = variantData.stock || 0;
          if (defaultQty > 0) {
            const current = await db.get(
              'SELECT qty FROM stock WHERE product_id = ? AND variant = ?',
              [product.id, variantName]
            );
            if (!current) {
              await db.run(
                'INSERT INTO stock (product_id, variant, qty) VALUES (?, ?, ?)',
                [product.id, variantName, defaultQty]
              );
              repaired++;
            } else if (current.qty === 0) {
              await db.run(
                'UPDATE stock SET qty = ?, manual = 0 WHERE product_id = ? AND variant = ?',
                [defaultQty, product.id, variantName]
              );
              repaired++;
            }
          }
        }
      }
    }
    console.log(`🔧 Admin stock reset: ${repaired} stock(s) réparé(s)`);
    res.json({ ok: true, repaired });
  } catch (error) {
    console.error('Stock reset error:', error);
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
    const transaction = await db.get('SELECT * FROM transactions WHERE id = ?', [req.params.id]);
    if (!transaction) {
      return res.status(404).json({ ok: false, error: 'Transaction introuvable' });
    }

    // Reverser le cash_balance si la transaction était en espèces
    if (transaction.payment_method === 'especes') {
      const cashBalance = await db.get("SELECT value FROM settings WHERE key = 'cash_balance'");
      const currentBalance = parseFloat(cashBalance?.value || 0);
      const newBalance = transaction.type === 'revenue'
        ? currentBalance - transaction.amount
        : currentBalance + transaction.amount;
      await db.run(
        "UPDATE settings SET value = ? WHERE key = 'cash_balance'",
        [newBalance.toString()]
      );
    }

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

      // Quand les produits sont sauvegardés, s'assurer que les nouvelles variantes ont une entrée stock
      // INSERT OR IGNORE : ne jamais écraser le stock réel existant
      if (key === 'products') {
        try {
          const products = JSON.parse(value);
          for (const product of products) {
            if (product.variants) {
              for (const [variantName, variantData] of Object.entries(product.variants)) {
                const defaultQty = variantData.stock || 0;
                await db.run(
                  'INSERT OR IGNORE INTO stock (product_id, variant, qty) VALUES (?, ?, ?)',
                  [product.id, variantName, defaultQty]
                );
              }
            }
          }
          console.log('✅ Nouvelles variantes stock synchronisées');
        } catch (parseErr) {
          console.error('Erreur sync stock:', parseErr);
        }
      }
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

// ==================== CLIENTS TELEGRAM EXPORT (CSV) ====================

app.get('/api/admin/clients/export/csv', requireAdmin, async (req, res) => {
  try {
    const clients = await db.all(`
      SELECT tc.telegram_id, tc.username, tc.first_name, tc.contact, tc.registered_at, tc.last_seen,
             COUNT(o.id) as total_orders,
             COALESCE(SUM(o.total), 0) as total_spent
      FROM telegram_clients tc
      LEFT JOIN orders o ON o.client_telegram_id = tc.telegram_id
      GROUP BY tc.telegram_id
      ORDER BY tc.last_seen DESC
    `);

    let csv = 'Telegram ID,Username,Prénom,Contact,Inscrit le,Dernière visite,Nb commandes,Total dépensé\n';

    clients.forEach(c => {
      const registered = c.registered_at ? new Date(c.registered_at).toLocaleString('fr-FR') : '';
      const lastSeen = c.last_seen ? new Date(c.last_seen).toLocaleString('fr-FR') : '';
      csv += `${c.telegram_id},"${c.username || ''}","${c.first_name || ''}","${c.contact || ''}","${registered}","${lastSeen}",${c.total_orders},${(c.total_spent || 0).toFixed(2)}\n`;
    });

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename=clients_telegram.csv');
    res.send('\uFEFF' + csv);
  } catch (error) {
    console.error('Export clients error:', error);
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

    // Calculer les bonus de parrainage (10€ par parrainage)
    const referralsWithInfo = referrals.map(ref => {
      const totalReferrals = ref.total_referrals || 0;
      const milestonesReached = totalReferrals;
      const nextMilestone = totalReferrals + 1;

      return {
        ...ref,
        milestonesReached,
        nextMilestone,
        totalBonusEarned: totalReferrals * 10
      };
    });

    res.json({ ok: true, referrals: referralsWithInfo });
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
    let csv = 'Code Parrainage,Contact Client,Solde Crédit,Total Parrainages,Total Gagné,Bonus Parrainages,Date Création\n';

    referrals.forEach(ref => {
      const totalReferrals = ref.total_referrals || 0;
      const milestonesReached = totalReferrals;

      csv += `${ref.referral_code},${ref.customer_contact},${ref.credit_balance},${ref.total_referrals},${ref.total_earned},${milestonesReached}x10€,${ref.created_at}\n`;
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
// Secret token pour authentifier les requêtes webhook de Telegram
// Utiliser une variable d'environnement pour persister entre les redémarrages
const WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET || crypto.randomBytes(32).toString('hex');
if (!process.env.TELEGRAM_WEBHOOK_SECRET) {
  console.warn('⚠️  TELEGRAM_WEBHOOK_SECRET non défini - secret généré aléatoirement (les webhooks pourraient échouer après un redémarrage)');
}

if (config.telegram.token) {
  console.log('🤖 Configuring Telegram bot...');

  try {
    // Handler commun pour le webhook Telegram
    async function handleWebhookRequest(req, res) {
      // Vérifier le secret token envoyé par Telegram
      const receivedSecret = req.headers['x-telegram-bot-api-secret-token'];
      if (receivedSecret !== WEBHOOK_SECRET) {
        console.log('⚠️ Webhook rejeté: secret token invalide');
        return res.sendStatus(403);
      }

      console.log('📥 Webhook reçu');

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

    // Endpoint principal du webhook (protégé par le secret token)
    app.post('/telegram-webhook', handleWebhookRequest);

    // Route /setup-webhook protégée par authentification admin
    app.post('/setup-webhook', requireAdmin, async (req, res) => {
      try {
        const webhookUrl = `${config.webapp.url}/telegram-webhook`;
        await telegram.setWebhook(webhookUrl, WEBHOOK_SECRET);
        res.json({ success: true, webhook: webhookUrl });
      } catch (error) {
        res.status(500).json({ success: false, error: error.message });
      }
    });

    console.log('✅ Telegram bot webhook configured successfully');
    console.log(`   📡 Endpoint: /telegram-webhook`);
  } catch (error) {
    console.error('❌ Failed to configure Telegram bot:', error.message);
    console.error(error.stack);
  }
}

// ==================== CLAVIER PERMANENT POUR CHAQUE UTILISATEUR ====================
async function isDriverChatId(chatId) {
  const chatStr = chatId.toString();
  // Vérifier config .env
  if (chatStr === config.telegram.driverMillauId || chatStr === config.telegram.driverExterieurId) return true;
  // Vérifier dans la table drivers
  try {
    const driver = await db.get('SELECT id FROM drivers WHERE telegram_id = ? AND active = 1', [chatStr]);
    return !!driver;
  } catch (err) { return false; }
}

async function getPermanentKeyboard(chatId) {
  const isDriver = await isDriverChatId(chatId);
  const userIsAdmin = isAdmin(chatId);
  const shopUrl = `${config.webapp.url}?tg_id=${chatId}`;

  if (isDriver) {
    return {
      keyboard: [
        [{ text: '📋 Mes Livraisons' }],
        [{ text: '📊 Mes Stats' }],
        [{ text: '💰 Caisse' }],
        [{ text: '🛍️ Boutique', web_app: { url: shopUrl } }],
        [{ text: '💬 Support' }],
        [{ text: '❓ Aide' }]
      ],
      resize_keyboard: true,
      persistent: true,
      one_time_keyboard: false
    };
  } else if (userIsAdmin) {
    return {
      keyboard: [
        [{ text: '🛒 Ouvrir la Boutique', web_app: { url: shopUrl } }],
        [
          { text: 'ℹ️ Info' },
          { text: '📞 Contact' }
        ],
        [
          { text: '📖 Comment Commander' },
          { text: '🔐 Admin', web_app: { url: `${config.webapp.url}/admin.html?v=${Date.now()}` } }
        ]
      ],
      resize_keyboard: true,
      persistent: true,
      one_time_keyboard: false
    };
  } else {
    return {
      keyboard: [
        [{ text: '🛒 Ouvrir la Boutique', web_app: { url: shopUrl } }],
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

// ═══════════════════════════════════════════════════════════════════════════
// RAPPELS DE LIVRAISON PROGRAMMÉE (30 min avant l'heure choisie)
// ═══════════════════════════════════════════════════════════════════════════
async function checkDeliveryReminders() {
  try {
    // Récupérer les commandes programmées (pas 'asap') non livrées, rappel pas encore envoyé
    const orders = await db.all(`
      SELECT o.*, c.contact as customer_contact
      FROM orders o
      LEFT JOIN customers c ON c.contact = o.customer
      WHERE o.time_slot != 'asap'
        AND o.time_slot IS NOT NULL
        AND o.reminder_sent = 0
        AND o.status IN ('pending', 'pending_approval')
    `);

    if (orders.length === 0) return;

    const now = new Date();
    const todayStr = now.toISOString().split('T')[0]; // YYYY-MM-DD

    for (const order of orders) {
      // Construire la date/heure de livraison prévue (aujourd'hui à l'heure choisie)
      const orderDate = new Date(order.created_at);
      const orderDateStr = orderDate.toISOString().split('T')[0];

      // L'heure de livraison est pour le jour de la commande
      // Si 00:00, c'est minuit (fin de journée de commande)
      let targetDate;
      if (order.time_slot === '00:00') {
        targetDate = new Date(orderDateStr + 'T23:59:00');
      } else {
        targetDate = new Date(orderDateStr + 'T' + order.time_slot + ':00');
      }

      // Si la date cible est déjà passée de plus de 2h, marquer comme envoyé pour ne pas spammer
      const diffMs = targetDate - now;
      if (diffMs < -2 * 60 * 60 * 1000) {
        await db.run('UPDATE orders SET reminder_sent = 1 WHERE id = ?', [order.id]);
        continue;
      }

      // Envoyer le rappel 30 minutes avant
      const thirtyMinMs = 30 * 60 * 1000;
      if (diffMs <= thirtyMinMs && diffMs > -5 * 60 * 1000) {
        // Envoyer le rappel
        const displayName = await getCustomerDisplayName(order.customer);
        const items = JSON.parse(order.items || '[]');
        const itemsList = items.map(i => `• ${i.qty}x ${i.name} ${i.variant}`).join('\n');

        const minutesLeft = Math.max(0, Math.round(diffMs / 60000));

        const reminderMsg = `⏰ <b>RAPPEL LIVRAISON</b>

📦 <b>Commande #${order.id}</b>
👤 Client: ${displayName}
🕐 Heure prévue: <b>${order.time_slot}</b>
⏳ Dans <b>${minutesLeft} min</b>

📍 ${order.type}
🏠 ${order.address || 'Sur place'}
${order.customer_description ? `🧍 Description: ${order.customer_description}\n` : ''}
${itemsList}

💰 Total: ${order.total}€`;

        await notifyAdmins(reminderMsg);

        // Marquer le rappel comme envoyé
        await db.run('UPDATE orders SET reminder_sent = 1 WHERE id = ?', [order.id]);
        console.log(`⏰ Rappel envoyé pour commande #${order.id} (livraison à ${order.time_slot})`);
      }
    }
  } catch (err) {
    console.error('❌ Delivery reminder error:', err.message);
  }
}

function startDeliveryReminderScheduler() {
  setInterval(async () => {
    try {
      await checkDeliveryReminders();
    } catch (err) {
      console.error('❌ Delivery reminder scheduler error:', err.message);
    }
  }, 60 * 1000); // Vérifie toutes les minutes
  console.log('⏰ Delivery reminder scheduler started (60s interval)');
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

  // Masquer les mots de passe dans les logs
  const logText = text && text.startsWith('/adminlogin ') ? '/adminlogin ***' : text;
  console.log(`💬 Message from ${chatId} (${firstName}): ${logText}`);

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
  } else if (text === '💰 Caisse') {
    await sendDriverCaisse(chatId);
    return;
  } else if (text === '💬 Support') {
    await sendSupportMessage(chatId);
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
    // Supprimer immédiatement le message contenant le mot de passe
    try {
      await telegram.deleteMessage(chatId, message.message_id);
    } catch (e) {
      console.warn('⚠️ Impossible de supprimer le message /adminlogin (le bot n\'est peut-être pas admin du chat)');
    }
    const password = text.substring(12).trim();
    const isValid = await verifyAdminPassword(password);
    if (isValid) {
      sessionAdmins.set(chatId.toString(), Date.now() + SESSION_ADMIN_EXPIRY_MS);
      console.log(`✅ Admin login success for chatId ${chatId}`);
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
    console.log(`🔐 /admin from ${chatId} | isAdmin=${isAdmin(chatId)}`);
    if (isAdmin(chatId)) {
      try {
        await sendAdminMessage(chatId);
      } catch (err) {
        console.error('❌ sendAdminMessage error:', err);
        await telegram.sendMessage(chatId, '❌ Erreur panneau admin. Réessayez.');
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
  } else if (text === '/caisse') {
    await sendDriverCaisse(chatId);
    return;
  } else if (text === '/stop') {
    await stopUserConversations(chatId);
    return;
  } else if (text === '/logout') {
    const chatIdStr = chatId.toString();
    if (sessionAdmins.has(chatIdStr)) {
      sessionAdmins.delete(chatIdStr);
      adminStates.delete(chatIdStr);
      await telegram.sendMessage(chatId, '🔒 Déconnexion admin réussie.');
    } else {
      await telegram.sendMessage(chatId, 'Vous n\'étiez pas connecté en tant qu\'admin.');
    }
    return;
  } else if (text === '/zones' && isAdmin(chatId)) {
    await sendZoneStats(chatId);
    return;
  } else if (text.startsWith('/broadcast ') && isAdmin(chatId)) {
    await handleBroadcast(chatId, text.substring(11).trim());
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

    // Vérifier s'il y a une conversation inactive pour ce client (clientActive = false)
    const chatIdStr = String(chatId);
    for (const [orderId, conv] of chatManager.activeConversations.entries()) {
      if (String(conv.clientTelegramId) === chatIdStr && !conv.clientActive) {
        // Réactiver le client et relayer le message
        await chatManager.activateClient(orderId);
        await relayClientMessage(chatId, text, { orderId, ...conv });
        return;
      }
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

<b>🆔 Votre ID Telegram :</b> <code>${chatId}</code>

<b>🛍️ Utilisez le menu en bas pour naviguer</b>

<b>🎁 PROGRAMME DE PARRAINAGE :</b>
🤝 Parrainez 1 ami = 10€ de crédit !

✨ <i>Programme de fidélité actif !</i>
Bénéficiez d'une remise tous les ${config.loyalty.defaultThreshold} achats.

Tapez sur les boutons ci-dessous pour commencer ! 👇`;

  // Configurer le Menu Button personnalisé avec tg_id pour cet utilisateur
  const shopUrl = `${config.webapp.url}?tg_id=${chatId}`;
  telegram.setChatMenuButton(chatId, shopUrl).catch(() => {});

  const keyboard = await getPermanentKeyboard(chatId);
  const result = await telegram.sendMessage(chatId, text, { reply_markup: keyboard });

  // Si l'envoi avec clavier échoue (ex: URL web_app invalide), renvoyer sans clavier
  if (!result) {
    console.warn(`⚠️ Envoi welcome avec clavier échoué pour ${chatId}, renvoi sans clavier web_app`);
    const fallbackKeyboard = {
      keyboard: [
        [{ text: '🛒 Ouvrir la Boutique' }],
        [{ text: '💰 Mon Crédit' }, { text: '🎁 Parrainage' }],
        [{ text: 'ℹ️ Info' }, { text: '📞 Contact' }],
        [{ text: '📖 Comment Commander' }]
      ],
      resize_keyboard: true,
      persistent: true,
      one_time_keyboard: false
    };
    await telegram.sendMessage(chatId, text, { reply_markup: fallbackKeyboard });
  }
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
      [{ text: '🛒 Ouvrir la Boutique', web_app: { url: `${config.webapp.url}?tg_id=${chatId}` } }]
    ]
  };

  await telegram.sendMessage(chatId, text, { reply_markup: keyboard });
}

async function sendAdminMessage(chatId) {
  const text = `🔐 <b>PANNEAU ADMINISTRATEUR</b>\n\nChoisissez :`;
  const keyboard = {
    inline_keyboard: [
      [{ text: '🤖 Admin Bot (Annonces)', callback_data: 'adm_botpanel' }],
      [{ text: '🔐 Dashboard Web (Stats, Stock)', web_app: { url: `${config.webapp.url}/admin.html?v=${Date.now()}` } }]
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
  const isDriver = await isDriverChatId(chatId);

  if (isDriver) {
    const text = `📖 <b>GUIDE DU LIVREUR</b>

━━━━━━━━━━━━━━━━━━━

<b>📋 MENU PRINCIPAL</b>
Les boutons en bas de votre écran :

📋 <b>Mes Livraisons</b> → Voir toutes vos commandes en cours
📊 <b>Mes Stats</b> → Vos statistiques (livraisons du jour/semaine)
💰 <b>Caisse</b> → Détail de l'argent encaissé (30 derniers jours)
🛍️ <b>Boutique</b> → Accéder à la boutique
💬 <b>Support</b> → Contacter le support
❓ <b>Aide</b> → Ce guide

━━━━━━━━━━━━━━━━━━━

<b>🚚 COMMENT GÉRER UNE LIVRAISON</b>

<b>Étape 1 :</b> Vous recevez une notification automatique quand une commande arrive

<b>Étape 2 :</b> Cliquez sur 📋 <b>Mes Livraisons</b>
→ Les commandes sont triées par priorité :
  🔴 Urgent (+ de 30 min d'attente)
  🟠 Bientôt urgent (15-30 min)
  🟢 Normal (moins de 15 min)

<b>Étape 3 :</b> Appuyez sur 🚀 <b>START #XX</b>
→ Choisissez le temps estimé (10, 15, 20, 30, 45 ou 60 min)
→ Le client est prévenu automatiquement

<b>Étape 4 :</b> La livraison est lancée ! Vous avez 4 boutons :
  💬 <b>Contacter le client</b> → Envoyer un message au client
  ✅ <b>LIVRAISON TERMINÉE</b> → Quand c'est livré
  📍 <b>Ouvrir Maps</b> → GPS vers l'adresse du client
  📋 <b>Voir toutes mes livraisons</b> → Retour à la liste

<b>Étape 5 :</b> Appuyez sur ✅ <b>LIVRAISON TERMINÉE</b>
→ La commande passe en "livrée"
→ Le client est prévenu
→ La prochaine commande s'affiche automatiquement

━━━━━━━━━━━━━━━━━━━

<b>💬 CONTACTER UN CLIENT</b>
Après avoir cliqué START, appuyez sur "Contacter le client"
→ Tapez votre message, il sera envoyé au client
→ Le client peut répondre directement
→ Tapez /stop pour fermer la conversation

━━━━━━━━━━━━━━━━━━━

<b>🔄 BOUTON ACTUALISER</b>
Appuyez dessus pour rafraîchir la liste des commandes

<b>⚠️ IMPORTANT</b>
→ Remettez l'argent encaissé à l'admin régulièrement
→ Traitez les commandes 🔴 urgentes en priorité
→ Utilisez 📍 Maps pour ne pas vous perdre`;

    const keyboard = {
      inline_keyboard: [
        [{ text: '📋 Voir mes livraisons', callback_data: 'my_deliveries_millau' }],
        [{ text: '📊 Mes Stats', callback_data: 'driver_stats' }]
      ]
    };

    await telegram.sendMessage(chatId, text, { reply_markup: keyboard });
    return;
  }

  const text = `❓ <b>AIDE & SUPPORT</b>

<b>📍 Livraison :</b>
• Gratuite sur Millau
• +20€ pour l'extérieur

<b>💰 Paiement :</b>
• Espèces à la livraison uniquement

<b>🎁 Programme fidélité :</b>
• Remise automatique tous les ${config.loyalty.defaultThreshold} achats
• ${config.loyalty.fixedDiscount}€ de remise à chaque ${config.loyalty.defaultThreshold}ème achat

<b>📞 Contact support :</b>
@newassistance4

<b>⏰ Horaires d'ouverture :</b>
7j/7 de 12H à 00H (minuit)
Livraison rapide pendant les heures d'ouverture

<b>💡 Astuce :</b>
Utilisez les boutons en bas de votre écran pour naviguer rapidement ! 👇`;

  const keyboard = {
    inline_keyboard: [
      [{ text: '💬 Contacter le Support', url: 'https://t.me/newassistance4' }],
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

<b>📱 Telegram :</b> @newassistance4
<b>📸 Snapchat :</b> https://www.snapchat.com/add/cocoland-12
<b>🆘 Snap Secours :</b> https://www.snapchat.com/add/droguacenter12?share_id=GiyUiJLIwEU&locale

Notre équipe est disponible <b>7j/7</b> pour vous aider !

<i>Réponse sous 24h maximum</i>

📢 <b>Rejoignez nos canaux :</b>
• Canal Principal - Actualités et offres
• Canal Photo - Nouveaux produits en images`;

  const keyboard = {
    inline_keyboard: [
      [{ text: '💬 Support Telegram', url: 'https://t.me/newassistance4' }],
      [{ text: '📸 Snapchat', url: 'https://www.snapchat.com/add/cocoland-12' }],
      [{ text: '🆘 Snap Secours', url: 'https://www.snapchat.com/add/droguacenter12?share_id=GiyUiJLIwEU&locale' }],
      [
        { text: '📢 Canal Principal', url: 'https://t.me/+jQmeiR0Cd3I2YjFk' },
        { text: '📸 Canal Photo', url: 'https://t.me/+MeIiGFxcXDA5MjFk' }
      ],
      [{ text: '🆘 Canal Secours', url: 'https://t.me/+LQ07z8Ts4ftiNzk0' }]
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
      [{ text: '🛒 Commander Maintenant', web_app: { url: `${config.webapp.url}?tg_id=${chatId}` } }]
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
      [{ text: '🛒 Commander Maintenant', web_app: { url: `${config.webapp.url}?tg_id=${chatId}` } }],
      [
        { text: '💬 Support', url: 'https://t.me/newassistance4' },
        { text: 'ℹ️ Plus d\'infos', callback_data: 'show_info' }
      ]
    ]
  };
  
  await telegram.sendMessage(chatId, text, { reply_markup: keyboard });
}

// ==================== FONCTIONS CRÉDIT & PARRAINAGE ====================
async function sendCreditBalance(chatId) {
  try {
    // Récupérer le contact client (avec fallback orders)
    const contact = await getClientContact(chatId.toString());

    if (!contact) {
      const text = `💰 <b>MON CRÉDIT</b>

❌ <b>Aucun crédit disponible</b>

Pour obtenir du crédit, parrainez vos amis !

<b>🎁 Comment ça marche ?</b>
Parrainez 1 ami → Gagnez <b>10€</b> de crédit !

Tapez /parrainage pour voir votre code personnel 🚀`;

      await telegram.sendMessage(chatId, text);
      return;
    }

    // Récupérer les stats de parrainage
    const stats = await getReferralStats(contact);

    if (!stats) {
      const text = `💰 <b>MON CRÉDIT</b>

<b>Solde actuel :</b> 0€

Pour obtenir du crédit, parrainez vos amis !
1 parrainage = 10€ de crédit

Tapez /parrainage pour voir votre code personnel 🚀`;

      await telegram.sendMessage(chatId, text);
      return;
    }

    const totalReferrals = stats.totalReferrals || 0;
    const text = `💰 <b>MON CRÉDIT</b>

<b>💵 Solde disponible :</b> <b>${stats.creditBalance.toFixed(0)}€</b>

<b>📊 Statistiques :</b>
• Total gagné : ${stats.totalEarned.toFixed(0)}€
• Parrainages réussis : ${totalReferrals}

<b>💡 Utilisation :</b>
Votre crédit sera automatiquement proposé lors de votre prochaine commande sur la boutique !

🎁 1 ami parrainé = 10€ de crédit !`;

    const keyboard = {
      inline_keyboard: [
        [{ text: '🎁 Voir Mon Code Parrainage', callback_data: 'show_referral_code' }],
        [{ text: '🛒 Commander', web_app: { url: `${config.webapp.url}?tg_id=${chatId}` } }]
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
    // Récupérer le contact client (avec fallback orders)
    const contact = await getClientContact(chatId.toString());

    if (!contact) {
      const text = `🎁 <b>PROGRAMME DE PARRAINAGE</b>

❌ <b>Pas encore de code parrainage</b>

Pour obtenir votre code personnel, passez votre première commande sur la boutique !

<b>💰 Comment ça marche ?</b>
Parrainez <b>1 ami</b> → Gagnez <b>10€</b> de crédit !
Le filleul ne gagne rien, sauf s'il parraine à son tour.

Commandez maintenant pour débloquer votre code ! 🚀`;

      const keyboard = {
        inline_keyboard: [
          [{ text: '🛒 Commander', web_app: { url: `${config.webapp.url}?tg_id=${chatId}` } }]
        ]
      };

      await telegram.sendMessage(chatId, text, { reply_markup: keyboard });
      return;
    }

    // Récupérer les stats
    const stats = await getReferralStats(contact);

    if (!stats) {
      await sendMyReferralCode(chatId);
      return;
    }

    const totalReferrals = stats.totalReferrals || 0;
    const text = `🎁 <b>MON PARRAINAGE</b>

<b>🔑 Votre code personnel :</b>
<code>${stats.code}</code>

<b>📊 Statistiques :</b>
• Parrainages réussis : ${totalReferrals}
• Total gagné : ${stats.totalEarned.toFixed(0)}€
• Crédit disponible : ${stats.creditBalance.toFixed(0)}€

<b>💰 Récompense :</b>
1 parrainage = <b>10€ de crédit</b>

<b>🚀 Partagez votre code :</b>
Invitez vos amis à commander avec votre code !`;

    const shareText = encodeURIComponent(`🎉 Commande sur DROGUA CENTER !\n\n🎁 Code parrainage : ${stats.code}\n\n👉 ${config.webapp.url}`);

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
    // Récupérer le contact client (avec fallback orders)
    const contact = await getClientContact(chatId.toString());

    if (!contact) {
      await telegram.sendMessage(chatId, '❌ Passez d\'abord une commande pour obtenir votre code personnel !');
      return;
    }

    // Créer ou récupérer le code
    const referral = await getOrCreateReferralCode(contact);

    const text = `🎁 <b>VOTRE CODE PARRAINAGE</b>

<b>🔑 Code personnel :</b>
<code>${referral.referral_code}</code>

<b>💰 Parrainez et gagnez :</b>
1 ami parrainé = <b>10€ de crédit</b> !

Partagez dès maintenant ! 🚀`;

    const shareText = encodeURIComponent(`🎉 Commande sur DROGUA CENTER !\n\n🎁 Code parrainage : ${referral.referral_code}\n\n👉 ${config.webapp.url}`);

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

// Résoudre les zones d'un livreur par son chatId (planning du jour + fallback config)
async function getDriverZonesByChatId(chatId) {
  const chatStr = chatId.toString();
  const zones = [];

  // 1) Vérifier dans le planning du jour (peut avoir 2 zones)
  const today = new Date().getDay();
  try {
    const scheduled = await db.all(`
      SELECT ds.zone FROM driver_schedule ds
      JOIN drivers d ON d.id = ds.driver_id
      WHERE d.telegram_id = ? AND ds.day_of_week = ?
    `, [chatStr, today]);
    for (const s of scheduled) {
      if (!zones.includes(s.zone)) zones.push(s.zone);
    }
  } catch (err) {
    console.error('Erreur getDriverZonesByChatId schedule:', err.message);
  }

  // 2) Fallback: IDs par défaut du .env (seulement si pas trouvé via planning)
  if (zones.length === 0) {
    if (chatStr === config.telegram.driverMillauId) zones.push('millau');
    if (chatStr === config.telegram.driverExterieurId) zones.push('exterieur');
  }

  return zones;
}

async function sendDriverDeliveries(chatId) {
  const zones = await getDriverZonesByChatId(chatId);
  if (zones.length === 0) return;

  for (const zone of zones) {
    await sendDetailedDriverDeliveries(chatId, zone);
  }
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

  // Trier les commandes en attente par priorité
  pendingOrders.forEach(o => { o.priority = calculateOrderPriority(o); });
  pendingOrders.sort((a, b) => a.priority.level - b.priority.level || new Date(a.created_at) - new Date(b.created_at));

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
      if (order.customer_description) message += `🧍 ${order.customer_description}\n`;
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
    message += `<i>Trié par priorité : 🔴 urgent → 🟢 normal</i>\n\n`;

    pendingOrders.forEach((order, index) => {
      const items = JSON.parse(order.items || '[]');
      const timeAgo = getTimeAgo(order.created_at);
      const p = order.priority;

      message += `${p.emoji} <b>#${order.id}</b> - ${p.label}${index === 0 ? ' ⚡ À FAIRE EN PREMIER' : ''}\n`;
      message += `📍 ${order.address}\n`;
      if (order.customer_description) message += `🧍 ${order.customer_description}\n`;
      message += `💰 ${order.total}€ | 📦 ${items.length} article(s)\n`;
      if (order.time_slot && order.time_slot !== 'asap') message += `🕐 Prévu à ${order.time_slot}\n`;
      message += `⏳ ${timeAgo}\n\n`;
    });
  }

  message += `━━━━━━━━━━━━━━━━━━━\n`;
  message += `💡 <i>🔴 Urgent  🟠 Bientôt  🟢 Normal</i>`;

  const keyboard = {
    inline_keyboard: []
  };

  if (pendingOrders.length > 0) {
    keyboard.inline_keyboard.push([
      { text: `🚀 START #${pendingOrders[0].id} (${pendingOrders[0].priority.emoji})`, callback_data: `start_delivery_${pendingOrders[0].id}` }
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
  const zones = await getDriverZonesByChatId(chatId);
  if (zones.length === 0) return;

  let message = `📊 <b>VOS STATISTIQUES</b>\n`;

  for (const driverZone of zones) {
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

    message += `\n━━━ ${driverZone.toUpperCase()} ━━━

<b>📅 AUJOURD'HUI</b>
🚚 Livraisons : ${today?.count || 0}
💰 CA : ${(today?.revenue || 0).toFixed(2)}€

<b>📈 CETTE SEMAINE</b>
🚚 Livraisons : ${week?.count || 0}
💰 CA : ${(week?.revenue || 0).toFixed(2)}€
`;
  }

  message += `\nContinue comme ça ! 🚀`;
  await telegram.sendMessage(chatId, message);
}

async function sendDriverCaisse(chatId) {
  const zones = await getDriverZonesByChatId(chatId);
  if (zones.length === 0) return;

  for (const driverZone of zones) {
    const deliveredOrders = await db.all(`
      SELECT id, customer, address, items, total, created_at
      FROM orders
      WHERE status = 'delivered'
      AND assigned_driver_zone = ?
      AND DATE(created_at) >= DATE('now', '-30 days')
      ORDER BY created_at DESC
    `, [driverZone]);

    const totalCount = deliveredOrders.length;
    const totalRevenue = deliveredOrders.reduce((sum, o) => sum + (o.total || 0), 0);

    let message = `💰 <b>CAISSE LIVREUR (${driverZone.toUpperCase()})</b>\n`;
    message += `━━━━━━━━━━━━━━━━━━━\n\n`;
    message += `🚚 <b>Total livraisons :</b> ${totalCount}\n`;
    message += `💶 <b>Total encaissé :</b> ${totalRevenue.toFixed(2)}€\n\n`;
    message += `━━━━━━━━━━━━━━━━━━━\n`;
    message += `📋 <b>DÉTAIL DES COMMANDES (30 derniers jours)</b>\n\n`;

    if (deliveredOrders.length === 0) {
      message += `<i>Aucune livraison sur cette période</i>`;
    } else {
      deliveredOrders.forEach((order, index) => {
        const items = JSON.parse(order.items || '[]');
        const date = new Date(order.created_at).toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit' });
        const time = new Date(order.created_at).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
        const itemsList = items.map(i => `${i.name} ${i.variant} ×${i.qty}`).join(', ');

        message += `${index + 1}. <b>#${order.id}</b> — ${date} ${time}\n`;
        message += `   📦 ${itemsList}\n`;
        message += `   📍 ${order.address}\n`;
        message += `   💰 <b>${order.total}€</b>\n\n`;
      });
    }

    message += `━━━━━━━━━━━━━━━━━━━\n`;
    message += `⚠️ <i>Remettez l'argent à l'admin régulièrement !</i>`;

    // Telegram a une limite de 4096 caractères par message
    if (message.length > 4000) {
      const header = `💰 <b>CAISSE LIVREUR (${driverZone.toUpperCase()})</b>\n━━━━━━━━━━━━━━━━━━━\n\n🚚 <b>Total livraisons :</b> ${totalCount}\n💶 <b>Total encaissé :</b> ${totalRevenue.toFixed(2)}€\n\n━━━━━━━━━━━━━━━━━━━\n📋 <b>DÉTAIL DES COMMANDES (30 derniers jours)</b>\n\n`;
      await telegram.sendMessage(chatId, header);

      let chunk = '';
      for (let i = 0; i < deliveredOrders.length; i++) {
        const order = deliveredOrders[i];
        const items = JSON.parse(order.items || '[]');
        const date = new Date(order.created_at).toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit' });
        const time = new Date(order.created_at).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
        const itemsList = items.map(it => `${it.name} ${it.variant} ×${it.qty}`).join(', ');

        const line = `${i + 1}. <b>#${order.id}</b> — ${date} ${time}\n   📦 ${itemsList}\n   📍 ${order.address}\n   💰 <b>${order.total}€</b>\n\n`;

        if ((chunk + line).length > 3800) {
          await telegram.sendMessage(chatId, chunk);
          chunk = '';
        }
        chunk += line;
      }

      if (chunk) {
        chunk += `━━━━━━━━━━━━━━━━━━━\n⚠️ <i>Remettez l'argent à l'admin régulièrement !</i>`;
        await telegram.sendMessage(chatId, chunk);
      }
    } else {
      await telegram.sendMessage(chatId, message);
    }
  }
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

async function handleBroadcast(adminChatId, messageText) {
  if (!messageText) {
    await telegram.sendMessage(adminChatId, `📢 <b>BROADCAST</b>

Envoyez un message à tous les clients enregistrés.

<b>Usage :</b>
<code>/broadcast Votre message ici</code>

Le message sera envoyé en MP à chaque client qui a interagi avec le bot.`);
    return;
  }

  const clients = await db.all('SELECT telegram_id, first_name FROM telegram_clients');

  if (clients.length === 0) {
    await telegram.sendMessage(adminChatId, '❌ Aucun client enregistré dans la base.');
    return;
  }

  await telegram.sendMessage(adminChatId, `📢 <b>Envoi en cours...</b>\n\n📨 ${clients.length} destinataires\n💬 "${messageText.substring(0, 100)}${messageText.length > 100 ? '...' : ''}"`);

  let sent = 0;
  let failed = 0;

  for (const client of clients) {
    try {
      await telegram.sendMessage(client.telegram_id, messageText);
      sent++;
    } catch (err) {
      failed++;
      console.log(`❌ Broadcast failed for ${client.telegram_id} (${client.first_name}): ${err.message}`);
    }
    // Délai anti-spam : 50ms entre chaque message (max 20 msg/sec)
    await new Promise(r => setTimeout(r, 50));
  }

  await telegram.sendMessage(adminChatId, `📢 <b>BROADCAST TERMINÉ</b>

✅ Envoyés : ${sent}
❌ Échoués : ${failed}
📊 Total : ${clients.length}`);
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
${order.customer_description ? `🧍 ${order.customer_description}\n` : ''}💰 ${order.total}€

🎭 <b>Client : Anonyme</b>
💬 Utilisez le bouton "Contacter" pour envoyer un message`;

  // Trier les commandes restantes par priorité
  remainingOrders.forEach(o => { o.priority = calculateOrderPriority(o); });
  remainingOrders.sort((a, b) => a.priority.level - b.priority.level || new Date(a.created_at) - new Date(b.created_at));

  if (remainingOrders.length > 0) {
    message += `\n\n━━━━━━━━━━━━━━━━━━━
📋 <b>COMMANDES EN ATTENTE (${remainingOrders.length})</b>
<i>Par priorité :</i>\n`;

    remainingOrders.slice(0, 5).forEach((o, index) => {
      const p = o.priority;
      message += `\n${p.emoji} #${o.id} - ${o.total}€ - ${p.label}`;
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
      [{ text: '📜 Historique', callback_data: `chat_history_${orderId}` }],
      [{ text: '❌ Fermer conversation', callback_data: `end_conv_${orderId}` }]
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
  const order = await db.get('SELECT * FROM orders WHERE id = ?', [orderId]);
  if (!order) {
    await telegram.sendMessage(chatId, '❌ Commande introuvable');
    return;
  }

  const items = JSON.parse(order.items);
  await db.run('BEGIN IMMEDIATE');
  try {
    await restoreStockForOrder(items, orderId, { inTransaction: true });
    await db.run('DELETE FROM transactions WHERE description = ?', [`Commande #${orderId}`]);
    if (order.credit_used > 0) {
      await db.run(
        'UPDATE referrals SET credit_balance = credit_balance + ? WHERE customer_contact = ?',
        [order.credit_used, order.customer]
      );
    }
    await db.run('UPDATE orders SET status = ?, cancel_reason = ?, cancelled_at = CURRENT_TIMESTAMP WHERE id = ?',
      ['cancelled', 'Refusée par le livreur', orderId]);
    await db.run('COMMIT');
  } catch (txErr) {
    await db.run('ROLLBACK');
    throw txErr;
  }

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
    let customer = await db.get('SELECT * FROM customers WHERE contact = ?', [contact]);

    // Créer le client s'il n'existe pas (pour les anciennes commandes)
    if (!customer) {
      await db.run(
        'INSERT OR IGNORE INTO customers (contact, status) VALUES (?, ?)',
        [contact, 'pending']
      );
      customer = await db.get('SELECT * FROM customers WHERE contact = ?', [contact]);

      if (!customer) {
        await telegram.sendMessage(chatId, '❌ Erreur: impossible de créer le profil client');
        return;
      }
      console.log(`📝 Customer record created for old order: ${contact}`);
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

    // Créer le client s'il n'existe pas (pour les anciennes commandes)
    let customer = await db.get('SELECT * FROM customers WHERE contact = ?', [contact]);
    if (!customer) {
      await db.run(
        'INSERT OR IGNORE INTO customers (contact, status) VALUES (?, ?)',
        [contact, 'pending']
      );
      console.log(`📝 Customer record created for old order (blocking): ${contact}`);
    }

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

    // Actualiser la liste des livreurs concernés
    if (cancelledOrders.length > 0) {
      const zones = [...new Set(cancelledOrders.map(o => o.assigned_driver_zone).filter(Boolean))];
      for (const zone of zones) {
        // Chercher le livreur planifié aujourd'hui pour cette zone
        const today = new Date().getDay();
        let driverId = null;
        try {
          const scheduled = await db.get(`
            SELECT d.telegram_id FROM driver_schedule ds
            JOIN drivers d ON d.id = ds.driver_id
            WHERE ds.zone = ? AND ds.day_of_week = ?
          `, [zone, today]);
          if (scheduled) driverId = scheduled.telegram_id;
        } catch (err) { /* ignore */ }
        // Fallback config
        if (!driverId) {
          const driverIdKey = zone === 'millau' ? 'driverMillauId' : 'driverExterieurId';
          driverId = config.telegram[driverIdKey];
        }
        if (driverId) {
          try {
            await telegram.sendMessage(driverId, `🚫 ${cancelledOrders.length} commande(s) annulée(s) (client bloqué)`);
            await sendDetailedDriverDeliveries(driverId, zone);
          } catch (err) { console.error('Driver refresh error:', err.message); }
        }
      }
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
    let customer = await db.get('SELECT * FROM customers WHERE contact = ?', [contact]);

    // Créer le client s'il n'existe pas (pour les anciennes commandes)
    if (!customer) {
      await db.run(
        'INSERT OR IGNORE INTO customers (contact, status) VALUES (?, ?)',
        [contact, 'pending']
      );
      customer = await db.get('SELECT * FROM customers WHERE contact = ?', [contact]);

      if (!customer) {
        await telegram.sendMessage(chatId, '❌ Erreur: impossible de créer le profil client');
        return;
      }
      console.log(`📝 Customer record created for old order (details): ${contact}`);
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

// ==================== SYSTÈME DE BACKUP ====================
const BACKUP_CONFIG = {
  maxBackups: 7,
  backupDir: process.env.BACKUP_DIR || path.join(path.dirname(process.env.DATABASE_PATH || './boutique.db'), 'backups'),
  intervalMs: 24 * 60 * 60 * 1000 // 24h
};

function getDbPath() {
  return process.env.DATABASE_PATH || './boutique.db';
}

function ensureBackupDir() {
  if (!fs.existsSync(BACKUP_CONFIG.backupDir)) {
    fs.mkdirSync(BACKUP_CONFIG.backupDir, { recursive: true });
  }
}

function listBackups() {
  ensureBackupDir();
  const files = fs.readdirSync(BACKUP_CONFIG.backupDir)
    .filter(f => f.startsWith('boutique_backup_') && f.endsWith('.db'))
    .sort()
    .reverse();

  return files.map(f => {
    const stats = fs.statSync(path.join(BACKUP_CONFIG.backupDir, f));
    return {
      filename: f,
      size: stats.size,
      sizeFormatted: (stats.size / 1024 / 1024).toFixed(2) + ' MB',
      created: stats.mtime.toISOString()
    };
  });
}

async function createBackup() {
  const dbPath = getDbPath();
  if (!fs.existsSync(dbPath)) {
    throw new Error('Base de données introuvable');
  }

  ensureBackupDir();

  // Forcer un checkpoint WAL avant le backup pour avoir des données cohérentes
  if (db) {
    try {
      await db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    } catch (e) {
      console.warn('⚠️ WAL checkpoint failed, backup will still proceed:', e.message);
    }
  }

  const now = new Date();
  const timestamp = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const backupFilename = `boutique_backup_${timestamp}.db`;
  const backupPath = path.join(BACKUP_CONFIG.backupDir, backupFilename);

  fs.copyFileSync(dbPath, backupPath);

  // Rotation : supprimer les anciens backups au-delà de maxBackups
  const backups = listBackups();
  if (backups.length > BACKUP_CONFIG.maxBackups) {
    const toDelete = backups.slice(BACKUP_CONFIG.maxBackups);
    for (const old of toDelete) {
      fs.unlinkSync(path.join(BACKUP_CONFIG.backupDir, old.filename));
      console.log(`🗑️ Ancien backup supprimé: ${old.filename}`);
    }
  }

  const stats = fs.statSync(backupPath);
  console.log(`✅ Backup créé: ${backupFilename} (${(stats.size / 1024 / 1024).toFixed(2)} MB)`);

  return {
    filename: backupFilename,
    size: stats.size,
    sizeFormatted: (stats.size / 1024 / 1024).toFixed(2) + ' MB',
    created: now.toISOString()
  };
}

// Endpoint: Créer un backup et le télécharger
app.get('/api/admin/backup', requireAdmin, async (req, res) => {
  try {
    const backup = await createBackup();
    const backupPath = path.join(BACKUP_CONFIG.backupDir, backup.filename);

    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename=${backup.filename}`);
    res.setHeader('Content-Length', backup.size);

    const stream = fs.createReadStream(backupPath);
    stream.pipe(res);
  } catch (error) {
    console.error('Backup download error:', error);
    res.status(500).json({ ok: false, error: 'Erreur lors du backup: ' + error.message });
  }
});

// Endpoint: Créer un backup (sans télécharger)
app.post('/api/admin/backup', requireAdmin, async (req, res) => {
  try {
    const backup = await createBackup();
    res.json({ ok: true, backup });
  } catch (error) {
    console.error('Backup creation error:', error);
    res.status(500).json({ ok: false, error: 'Erreur lors du backup: ' + error.message });
  }
});

// Endpoint: Lister les backups disponibles
app.get('/api/admin/backups', requireAdmin, async (req, res) => {
  try {
    const backups = listBackups();
    const dbPath = getDbPath();
    const dbSize = fs.existsSync(dbPath) ? fs.statSync(dbPath).size : 0;

    res.json({
      ok: true,
      backups,
      totalBackups: backups.length,
      maxBackups: BACKUP_CONFIG.maxBackups,
      backupDir: BACKUP_CONFIG.backupDir,
      databaseSize: (dbSize / 1024 / 1024).toFixed(2) + ' MB',
      autoBackupInterval: '24h'
    });
  } catch (error) {
    console.error('List backups error:', error);
    res.status(500).json({ ok: false, error: 'Erreur serveur' });
  }
});

// Endpoint: Télécharger un backup spécifique
app.get('/api/admin/backups/:filename', requireAdmin, (req, res) => {
  const { filename } = req.params;

  // Validation du nom de fichier pour éviter le path traversal
  if (!/^boutique_backup_[\d-T]+\.db$/.test(filename)) {
    return res.status(400).json({ ok: false, error: 'Nom de fichier invalide' });
  }

  const filePath = path.join(BACKUP_CONFIG.backupDir, filename);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ ok: false, error: 'Backup non trouvé' });
  }

  const stats = fs.statSync(filePath);
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename=${filename}`);
  res.setHeader('Content-Length', stats.size);

  const stream = fs.createReadStream(filePath);
  stream.pipe(res);
});

// Endpoint: Supprimer un backup
app.delete('/api/admin/backups/:filename', requireAdmin, (req, res) => {
  const { filename } = req.params;

  if (!/^boutique_backup_[\d-T]+\.db$/.test(filename)) {
    return res.status(400).json({ ok: false, error: 'Nom de fichier invalide' });
  }

  const filePath = path.join(BACKUP_CONFIG.backupDir, filename);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ ok: false, error: 'Backup non trouvé' });
  }

  fs.unlinkSync(filePath);
  console.log(`🗑️ Backup supprimé manuellement: ${filename}`);
  res.json({ ok: true, message: 'Backup supprimé' });
});

// Backup automatique toutes les 24h
let backupInterval;
function startAutoBackup() {
  // Premier backup 5 min après le démarrage
  setTimeout(async () => {
    try {
      await createBackup();
      console.log('✅ Backup automatique initial terminé');
    } catch (error) {
      console.error('❌ Erreur backup automatique initial:', error.message);
    }
  }, 5 * 60 * 1000);

  // Puis toutes les 24h
  backupInterval = setInterval(async () => {
    try {
      await createBackup();
      console.log('✅ Backup automatique quotidien terminé');
    } catch (error) {
      console.error('❌ Erreur backup automatique:', error.message);
    }
  }, BACKUP_CONFIG.intervalMs);

  console.log(`📦 Backup automatique activé (toutes les 24h, max ${BACKUP_CONFIG.maxBackups} backups)`);
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
    startAutoBackup();

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

        // Toujours enregistrer le webhook au démarrage avec le secret token
        console.log('📡 Enregistrement du webhook...');
        const webhookResult = await telegram.setWebhook(webhookUrl, WEBHOOK_SECRET);
        if (webhookResult) {
          console.log('✅ Webhook enregistré (avec secret token)');
        } else {
          console.error('❌ ÉCHEC enregistrement webhook ! Le bot ne recevra pas de messages.');
          console.error('   Vérifiez WEBAPP_URL et TELEGRAM_TOKEN');
        }

        // Vérifier le webhook après enregistrement
        const webhookInfo = await telegram.getWebhookInfo();
        if (webhookInfo) {
          console.log(`📡 Webhook info: url=${webhookInfo.url}, pending=${webhookInfo.pending_update_count || 0}`);
          if (webhookInfo.last_error_message) {
            console.error(`❌ Dernière erreur webhook: ${webhookInfo.last_error_message} (${webhookInfo.last_error_date ? new Date(webhookInfo.last_error_date * 1000).toISOString() : 'inconnu'})`);
          }
        }

        // Configurer les commandes du bot (bouton Menu dans Telegram)
        const cmdResult = await telegram.setMyCommands([
          { command: 'start', description: 'Menu principal' },
          { command: 'shop', description: 'Ouvrir la boutique' },
          { command: 'tuto', description: 'Comment commander' },
          { command: 'orders', description: 'Mes commandes' },
          { command: 'status', description: 'Suivi de commande' },
          { command: 'catalogue', description: 'Voir les produits' },
          { command: 'credit', description: 'Mon solde crédit' },
          { command: 'fidelite', description: 'Programme de fidélité' },
          { command: 'parrainage', description: 'Programme de parrainage' },
          { command: 'moncode', description: 'Mon code parrainage' },
          { command: 'horaires', description: 'Horaires d\'ouverture' },
          { command: 'help', description: 'Aide et support' }
        ]);
        if (cmdResult) {
          console.log('✅ Bot commands configured (Menu button)');
        } else {
          console.error('❌ ÉCHEC configuration des commandes du bot ! Vérifiez TELEGRAM_TOKEN');
        }

        // Commandes spécifiques aux livreurs
        const driverCommands = [
          { command: 'start', description: 'Menu principal' },
          { command: 'meslivraisons', description: 'Mes livraisons en cours' },
          { command: 'stats', description: 'Mes statistiques' },
          { command: 'caisse', description: 'Ma caisse' },
          { command: 'help', description: 'Aide' }
        ];

        const driverMillauId = parseInt(config.telegram.driverMillauId);
        if (driverMillauId && Number.isFinite(driverMillauId)) {
          await telegram.setMyCommands(driverCommands, { type: 'chat', chat_id: driverMillauId });
        }

        const driverExtId = parseInt(config.telegram.driverExterieurId);
        if (driverExtId && Number.isFinite(driverExtId) && config.telegram.driverExterieurId !== '0') {
          await telegram.setMyCommands(driverCommands, { type: 'chat', chat_id: driverExtId });
        }

        // Configurer les commandes pour les livreurs enregistrés en DB
        try {
          const dbDrivers = await db.all('SELECT telegram_id FROM drivers WHERE active = 1');
          for (const drv of dbDrivers) {
            const drvId = parseInt(drv.telegram_id);
            if (drvId && Number.isFinite(drvId)) {
              await telegram.setMyCommands(driverCommands, { type: 'chat', chat_id: drvId });
            }
          }
        } catch (err) { console.error('Error setting DB driver commands:', err.message); }

        // Commandes spécifiques aux admins
        const adminIds = getAdminChatIds();
        for (const adminId of adminIds) {
          await telegram.setMyCommands([
            { command: 'start', description: 'Démarrer / Accueil' },
            { command: 'shop', description: 'Voir la boutique' },
            { command: 'admin', description: 'Panneau admin' },
            { command: 'broadcast', description: 'Envoyer un message à tous' },
            { command: 'annonce', description: 'Poster une annonce' },
            { command: 'annonces', description: 'Lister les annonces' },
            { command: 'zones', description: 'Statistiques des zones' },
            { command: 'orders', description: 'Mes commandes' },
            { command: 'help', description: 'Aide' }
          ], { type: 'chat', chat_id: parseInt(adminId) });
        }

        console.log('✅ Role-specific commands configured');
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

      // Démarrer les schedulers
      startAnnouncementScheduler();
      startDeliveryReminderScheduler();

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
