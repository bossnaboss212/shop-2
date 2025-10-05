const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');
const cors = require('cors');
const path = require('path');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

// Configuration Telegram Bot
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || '';
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID || '';
const DRIVER_CHAT_ID = process.env.DRIVER_CHAT_ID || '';
const SUPPORT_CHAT_ID = process.env.SUPPORT_CHAT_ID || '';
const MAPBOX_KEY = process.env.MAPBOX_KEY || '';
const ADMIN_PASS = process.env.ADMIN_PASS || 'gangstaforlife12';
const WEBAPP_URL = process.env.WEBAPP_URL || 'https://shop-2-production.up.railway.app';

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.static(path.join(__dirname, '..', 'public')));

// Database initialization
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
      stars INTEGER NOT NULL,
      text TEXT NOT NULL,
      approved INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      category TEXT NOT NULL,
      description TEXT NOT NULL,
      amount REAL NOT NULL,
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
      salary REAL NOT NULL,
      hire_date DATE NOT NULL,
      status TEXT DEFAULT 'active',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS payroll (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      employee_id INTEGER NOT NULL,
      employee_name TEXT NOT NULL,
      month INTEGER NOT NULL,
      year INTEGER NOT NULL,
      gross_amount REAL NOT NULL,
      bonus REAL DEFAULT 0,
      net_amount REAL NOT NULL,
      status TEXT DEFAULT 'pending',
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
  `);

  await db.run(`
    INSERT OR IGNORE INTO settings (key, value) VALUES 
    ('shop_name', 'DROGUA CENTER'),
    ('delivery_fee', '20'),
    ('loyalty_threshold', '10'),
    ('cash_balance', '0'),
    ('monthly_goal', '5000')
  `);

  console.log('✅ Database initialized');
}

// Helper functions
async function sendTelegramMessage(chatId, message, options = {}) {
  if (!TELEGRAM_TOKEN) {
    console.error('❌ TELEGRAM_TOKEN non défini');
    return;
  }
  
  if (!chatId) {
    console.error('❌ chatId non défini');
    return;
  }
  
  try {
    const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
    console.log(`📡 Envoi vers Telegram (chatId: ${chatId})...`);
    
    const response = await axios.post(url, {
      chat_id: chatId,
      text: message,
      parse_mode: 'HTML',
      ...options
    });
    
    console.log('✅ Message Telegram envoyé avec succès');
    return response.data;
  } catch (error) {
    console.error('❌ Erreur Telegram:', error.message);
    if (error.response) {
      console.error('📄 Réponse Telegram:', error.response.data);
    }
    throw error;
  }
}

function formatOrder(order, items) {
  let message = `📦 <b>Nouvelle commande #${order.id}</b>\n\n`;
  message += `👤 Client: ${order.customer}\n`;
  message += `📍 Type: ${order.type}\n`;
  if (order.address) message += `🏠 Adresse: ${order.address}\n`;
  message += `\n<b>Articles:</b>\n`;
  
  items.forEach(item => {
    message += `• ${item.name} - ${item.variant} x${item.qty} = ${item.lineTotal}€\n`;
  });
  
  if (order.discount > 0) {
    message += `\n🎁 Remise fidélité: -${order.discount}€`;
  }
  
  message += `\n💰 <b>Total: ${order.total}€</b>`;
  message += `\n⏰ ${new Date().toLocaleString('fr-FR')}`;
  
  return message;
}

// Routes

// === Public API ===

// Create order
app.post('/api/create-order', async (req, res) => {
  try {
    const { customer, type, address, items, total } = req.body;
    
    // Check loyalty program
    const loyalty = await db.get(
      'SELECT * FROM loyalty WHERE customer = ?',
      [customer]
    );
    
    let discount = 0;
    const loyaltyThreshold = await db.get(
      'SELECT value FROM settings WHERE key = ?',
      ['loyalty_threshold']
    );
    const threshold = parseInt(loyaltyThreshold?.value || 10);
    
    if (loyalty && (loyalty.orders_count + 1) % threshold === 0) {
      discount = Math.min(total * 0.1, 20);
    }
    
    const finalTotal = total - discount;
    
    // Insert order
    const result = await db.run(
      `INSERT INTO orders (customer, type, address, items, total, discount) 
       VALUES (?, ?, ?, ?, ?, ?)`,
      [customer, type, address, JSON.stringify(items), finalTotal, discount]
    );
    
    // Update loyalty
    if (loyalty) {
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
    
    // Update stock
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
        [item.product_id, item.variant, item.qty, stockAfter?.qty || 0, `Commande #${result.lastID}`]
      );
    }
    
    // Add transaction
    await db.run(
      `INSERT INTO transactions (type, category, description, amount, payment_method, date)
       VALUES ('revenue', 'vente', ?, ?, 'online', DATE('now'))`,
      [`Commande #${result.lastID}`, finalTotal]
    );
    
    // ========== NOTIFICATIONS TELEGRAM ==========
    console.log('📤 Préparation des notifications Telegram...');
    console.log('🔑 TELEGRAM_TOKEN:', TELEGRAM_TOKEN ? 'Défini ✅' : 'Non défini ❌');
    console.log('🔑 SUPPORT_CHAT_ID:', SUPPORT_CHAT_ID || 'Non défini ❌');
    console.log('🔑 ADMIN_CHAT_ID:', ADMIN_CHAT_ID || 'Non défini ❌');
    console.log('🔑 DRIVER_CHAT_ID:', DRIVER_CHAT_ID || 'Non défini ❌');
    
    if (!TELEGRAM_TOKEN) {
      console.log('⚠️ TELEGRAM_TOKEN non défini - notifications désactivées');
    } else {
      // 1️⃣ SUPPORT - Message simplifié
      if (SUPPORT_CHAT_ID) {
        try {
          console.log(`📤 Envoi au SUPPORT (${SUPPORT_CHAT_ID})...`);
          
          const supportMessage = `🔔 NOUVELLE COMMANDE #${result.lastID}

👤 Client: ${customer}
📍 Type: ${type}
💰 Total: ${finalTotal}€

📦 Articles: ${items.length} produit(s)

⚡ Contacter le client`;
          
          await sendTelegramMessage(SUPPORT_CHAT_ID, supportMessage);
          console.log('✅ Notification SUPPORT envoyée avec succès');
        } catch (err) {
          console.error('❌ Erreur SUPPORT:', err.message);
          console.error('Stack:', err.stack);
        }
      } else {
        console.log('⚠️ SUPPORT_CHAT_ID non défini - notification ignorée');
      }
      
      // 2️⃣ ADMIN - Message détaillé
      if (ADMIN_CHAT_ID) {
        try {
          console.log(`📤 Envoi à l'ADMIN (${ADMIN_CHAT_ID})...`);
          
          let itemsList = '';
          items.forEach(item => {
            itemsList += `• ${item.name} - ${item.variant} x${item.qty} = ${item.lineTotal}€\n`;
          });
          
          const adminMessage = `📦 COMMANDE #${result.lastID}

👤 Client: ${customer}
📍 Type: ${type}
🏠 Adresse: ${address || 'Sur place'}

📦 Articles:
${itemsList}
${discount > 0 ? `🎁 Remise fidélité: -${discount}€\n` : ''}💰 TOTAL: ${finalTotal}€

⏰ ${new Date().toLocaleString('fr-FR')}`;
          
          await sendTelegramMessage(ADMIN_CHAT_ID, adminMessage);
          console.log('✅ Notification ADMIN envoyée avec succès');
        } catch (err) {
          console.error('❌ Erreur ADMIN:', err.message);
          console.error('Stack:', err.stack);
        }
      } else {
        console.log('⚠️ ADMIN_CHAT_ID non défini - notification ignorée');
      }
      
      // 3️⃣ LIVREUR - Message court
      if (DRIVER_CHAT_ID) {
        try {
          console.log(`📤 Envoi au LIVREUR (${DRIVER_CHAT_ID})...`);
          
          const driverMessage = `🚚 LIVRAISON #${result.lastID}

📍 ${type}
🏠 ${address || 'Sur place'}
💰 ${finalTotal}€
📦 ${items.length} article(s)

⚡ Contactez l'admin pour les détails`;
          
          await sendTelegramMessage(DRIVER_CHAT_ID, driverMessage);
          console.log('✅ Notification LIVREUR envoyée avec succès');
        } catch (err) {
          console.error('❌ Erreur LIVREUR:', err.message);
          console.error('Stack:', err.stack);
        }
      } else {
        console.log('⚠️ DRIVER_CHAT_ID non défini - notification ignorée');
      }
    }
    
    // ✅ RÉPONSE AU CLIENT - CODE CORRIGÉ ICI
    console.log('✅ Commande créée avec succès');
    res.json({ ok: true, orderId: result.lastID, discount });
    
  } catch (error) {
    console.error('Create order error:', error);
    res.status(500).json({ ok: false, error: 'Erreur serveur' });
  }
});

// Geocode proxy for Mapbox
app.get('/api/geocode', async (req, res) => {
  if (!MAPBOX_KEY) {
    return res.json({ features: [] });
  }
  
  try {
    const { q } = req.query;
    const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(q)}.json`;
    const response = await axios.get(url, {
      params: {
        access_token: MAPBOX_KEY,
        country: 'FR',
        limit: 5,
        language: 'fr'
      }
    });
    res.json(response.data);
  } catch (error) {
    console.error('Geocode error:', error.message);
    res.json({ features: [] });
  }
});

// === Admin API ===

let adminTokens = new Set();

app.post('/api/admin/login', (req, res) => {
  const { password } = req.body;
  
  if (password === ADMIN_PASS) {
    const token = Math.random().toString(36).substr(2) + Date.now().toString(36);
    adminTokens.add(token);
    res.json({ ok: true, token });
  } else {
    res.status(401).json({ ok: false, error: 'Mot de passe incorrect' });
  }
});

function requireAdmin(req, res, next) {
  const token = req.headers['x-admin-token'];
  if (!token || !adminTokens.has(token)) {
    return res.status(401).json({ ok: false, error: 'Non autorisé' });
  }
  next();
}

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
    
    const topProduct = await db.get(`
      SELECT items FROM orders WHERE status != 'cancelled'
    `);
    
    if (topProduct) {
      const productCounts = {};
      const allOrders = await db.all("SELECT items FROM orders WHERE status != 'cancelled'");
      
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
    } else {
      stats.topProduct = '-';
    }
    
    const stock = await db.all('SELECT * FROM stock');
    stats.stockValue = 0;
    stats.stockOut = 0;
    stats.stockLow = 0;
    
    stock.forEach(s => {
      if (s.qty === 0) stats.stockOut++;
      else if (s.qty < 10) stats.stockLow++;
    });
    
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
    params.push(parseInt(limit));
    
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
    
    const fields = Object.keys(updates).map(key => `${key} = ?`).join(', ');
    const values = Object.values(updates);
    values.push(id);
    
    await db.run(
      `UPDATE orders SET ${fields} WHERE id = ?`,
      values
    );
    
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
    
    query += ' ORDER BY date DESC, created_at DESC';
    
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
      [approved, req.params.id]
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
    
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename=orders.csv');
    res.send(csv);
  } catch (error) {
    console.error('Export error:', error);
    res.status(500).json({ ok: false, error: 'Erreur serveur' });
  }
});

// ==================== TELEGRAM BOT ====================
if (TELEGRAM_TOKEN) {
  console.log('🤖 Configuration du bot Telegram...');

  app.post(`/bot${TELEGRAM_TOKEN}`, async (req, res) => {
    try {
      const { message, callback_query } = req.body;
      
      console.log('📩 Message reçu du bot:', JSON.stringify(req.body));
      
      if (message) {
        const chatId = message.chat.id;
        const text = message.text;
        const firstName = message.from.first_name || 'Client';
        
        console.log(`💬 Message de ${firstName}: ${text}`);
        
        if (text === '/start') {
          const welcomeText = `🌟 <b>Bienvenue ${firstName} chez DROGUA CENTER !</b> 🌟

Votre boutique premium accessible directement depuis Telegram.

<b>🛍️ Que souhaitez-vous faire ?</b>

• <b>Boutique</b> - Parcourir et commander
• <b>Admin</b> - Gérer votre boutique
• <b>Support</b> - Aide et assistance

✨ <i>Programme de fidélité actif !</i>
Bénéficiez d'une remise tous les 10 achats.`;

          const keyboard = {
            inline_keyboard: [
              [{
                text: '🛍️ Accéder à la Boutique',
                web_app: { url: WEBAPP_URL }
              }],
              [{
                text: '🔐 Panneau Admin',
                web_app: { url: `${WEBAPP_URL}/admin.html` }
              }],
              [
                {
                  text: '📢 Canal Principal',
                  url: 'https://t.me/+MToYP95G9zY2ZTJk'
                },
                {
                  text: '📸 Canal Photo',
                  url: 'https://t.me/+usSUbJOfYsk5ZTg0'
                }
              ],
              [
                {
                  text: '💬 Support',
                  callback_data: 'contact_support'
                },
                {
                  text: 'ℹ️ Infos',
                  callback_data: 'show_info'
                }
              ]
            ]
          };
          
          await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
            chat_id: chatId,
            text: welcomeText,
            parse_mode: 'HTML',
            reply_markup: keyboard
          });
          
          console.log('✅ Message /start envoyé à', chatId);
        }
        else if (text === '/shop' || text === '/boutique') {
          const shopText = `🛍️ <b>BOUTIQUE DROGUA CENTER</b>

Cliquez sur le bouton ci-dessous pour accéder à notre catalogue complet.

💎 Livraison rapide et discrète
🔒 Paiement sécurisé
📦 Suivi de commande en temps réel
🎁 Programme de fidélité actif`;

          const keyboard = {
            inline_keyboard: [
              [{
                text: '🛒 Ouvrir la Boutique',
                web_app: { url: WEBAPP_URL }
              }]
            ]
          };
          
          await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
            chat_id: chatId,
            text: shopText,
            parse_mode: 'HTML',
            reply_markup: keyboard
          });
          
          console.log('✅ Message /shop envoyé à', chatId);
        }
        else if (text === '/admin') {
          const adminText = `🔐 <b>PANNEAU ADMINISTRATEUR</b>

Accédez au tableau de bord pour gérer :

📊 Statistiques et ventes
📦 Commandes en cours
📋 Gestion du stock
💰 Finances et transactions
⚙️ Paramètres de la boutique

<i>⚠️ Authentification requise</i>`;

          const keyboard = {
            inline_keyboard: [
              [{
                text: '🔐 Ouvrir le Panneau Admin',
                web_app: { url: `${WEBAPP_URL}/admin.html` }
              }]
            ]
          };
          
          await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
            chat_id: chatId,
            text: adminText,
            parse_mode: 'HTML',
            reply_markup: keyboard
          });
          
          console.log('✅ Message /admin envoyé à', chatId);
        }
        else if (text === '/help' || text === '/aide') {
          const helpText = `❓ <b>AIDE & SUPPORT</b>

<b>📍 Livraison :</b>
• Gratuite sur Millau
• +20€ pour l'extérieur

<b>💰 Paiement :</b>
• Espèces à la livraison
• Virement bancaire
• Crypto-monnaies

<b>🎁 Programme fidélité :</b>
• Remise automatique tous les 10 achats
• Jusqu'à 10% ou 20€ de réduction

<b>📞 Contact support :</b>
@assistancenter

<b>⏰ Horaires d'ouverture :</b>
7j/7 de 12H à 00H (minuit)
Livraison rapide pendant les heures d'ouverture`;

          const keyboard = {
            inline_keyboard: [
              [{
                text: '💬 Contacter le Support',
                url: 'https://t.me/assistancenter'
              }],
              [
                {
                  text: '🛒 Boutique',
                  callback_data: 'open_shop'
                },
                {
                  text: '🔐 Admin',
                  callback_data: 'open_admin'
                }
              ]
            ]
          };
          
          await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
            chat_id: chatId,
            text: helpText,
            parse_mode: 'HTML',
            reply_markup: keyboard
          });
          
          console.log('✅ Message /help envoyé à', chatId);
        }
      }
      
      if (callback_query) {
        const chatId = callback_query.message.chat.id;
        const data = callback_query.data;
        
        console.log(`🔘 Callback reçu: ${data} de ${chatId}`);
        
        await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/answerCallbackQuery`, {
          callback_query_id: callback_query.id
        }).catch(err => console.error('Erreur answerCallback:', err.message));
        
        if (data === 'contact_support') {
          const supportText = `💬 <b>SUPPORT CLIENT</b>

Pour toute question ou assistance :

<b>📱 Telegram :</b> @assistancenter
<b>📸 Snapchat :</b> https://snapchat.com/t/l9gurvAj
<b>🆘 Snap Secours :</b> https://snapchat.com/t/jR2yW7xa

Notre équipe est disponible <b>7j/7</b> pour vous aider !

<i>Réponse sous 24h maximum</i>`;

          const keyboard = {
            inline_keyboard: [
              [{
                text: '💬 Support Telegram',
                url: 'https://t.me/assistancenter'
              }],
              [{
                text: '📸 Snapchat',
                url: 'https://snapchat.com/t/l9gurvAj'
              }]
            ]
          };
          
          await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
            chat_id: chatId,
            text: supportText,
            parse_mode: 'HTML',
            reply_markup: keyboard
          });
        }
        else if (data === 'show_info') {
          const infoText = `ℹ️ <b>À PROPOS DE DROGUA CENTER</b>

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
              [{
                text: '🛒 Commander Maintenant',
                web_app: { url: WEBAPP_URL }
              }]
            ]
          };
          
          await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
            chat_id: chatId,
            text: infoText,
            parse_mode: 'HTML',
            reply_markup: keyboard
          });
        }
        else if (data === 'open_shop') {
          const shopText = `🛍️ <b>BOUTIQUE DROGUA CENTER</b>

Cliquez sur le bouton ci-dessous pour accéder à notre catalogue complet.

💎 Livraison rapide et discrète
🔒 Paiement sécurisé
📦 Suivi de commande en temps réel
🎁 Programme de fidélité actif`;

          const keyboard = {
            inline_keyboard: [
              [{
                text: '🛒 Ouvrir la Boutique',
                web_app: { url: WEBAPP_URL }
              }]
            ]
          };
          
          await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
            chat_id: chatId,
            text: shopText,
            parse_mode: 'HTML',
            reply_markup: keyboard
          });
        }
        else if (data === 'open_admin') {
          const adminText = `🔐 <b>PANNEAU ADMINISTRATEUR</b>

Accédez au tableau de bord pour gérer :

📊 Statistiques et ventes
📦 Commandes en cours
📋 Gestion du stock
💰 Finances et transactions
⚙️ Paramètres de la boutique

<i>⚠️ Authentification requise</i>`;

          const keyboard = {
            inline_keyboard: [
              [{
                text: '🔐 Ouvrir le Panneau Admin',
                web_app: { url: `${WEBAPP_URL}/admin.html` }
              }]
            ]
          };
          
          await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
            chat_id: chatId,
            text: adminText,
            parse_mode: 'HTML',
            reply_markup: keyboard
          });
        }
      }
      
      res.sendStatus(200);
    } catch (error) {
      console.error('❌ Erreur bot:', error.message);
      console.error('Stack:', error.stack);
      res.sendStatus(500);
    }
  });

  console.log(`✅ Bot endpoint configuré: /bot${TELEGRAM_TOKEN.substring(0, 10)}...`);
  console.log(`📍 URL complète: ${WEBAPP_URL}/bot${TELEGRAM_TOKEN.substring(0, 10)}...`);
}

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

async function start() {
  await initDB();
  
  app.listen(PORT, () => {
    console.log('🚀 ================================');
    console.log(`   Server running on port ${PORT}`);
    console.log('🚀 ================================');
    console.log(`📱 Frontend: http://localhost:${PORT}`);
    console.log(`🔐 Admin: http://localhost:${PORT}/admin.html`);
    
    if (!TELEGRAM_TOKEN) {
      console.log('⚠️  TELEGRAM_TOKEN not set - bot disabled');
    } else {
      console.log('✅ Bot Telegram activé');
      console.log(`🔗 Webhook: ${WEBAPP_URL}/bot${TELEGRAM_TOKEN}`);
    }
    
    if (SUPPORT_CHAT_ID) {
      console.log('✅ Notifications SUPPORT activées');
    } else {
      console.log('⚠️  SUPPORT_CHAT_ID not set - support notifications disabled');
    }
    
    if (!MAPBOX_KEY) {
      console.log('⚠️  MAPBOX_KEY not set - geocoding disabled');
    }
    
    console.log('🚀 ================================');
  });
}

start().catch(console.error);
