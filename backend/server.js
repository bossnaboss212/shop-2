require('dotenv').config();
const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const mongoose = require('mongoose');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const axios = require('axios');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIO(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH']
  }
});

const PORT = process.env.PORT || 3000;

// Middleware
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100
});
app.use('/api/', limiter);

// MongoDB Connection
mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('✅ MongoDB connecté'))
  .catch(err => console.error('❌ Erreur MongoDB:', err));

// Import Models
const Order = require('./models/Order');
const Product = require('./models/Product');
const Transaction = require('./models/Transaction');

// WebSocket Management
const connectedClients = new Set();

io.on('connection', (socket) => {
  console.log('🔌 Client connecté:', socket.id);
  connectedClients.add(socket);

  socket.on('admin-auth', (password) => {
    const validPassword = process.env.ADMIN_PASS || 'gangstaforlife12';
    if (password === validPassword) {
      socket.emit('auth-success');
      console.log('✅ Admin authentifié:', socket.id);
    } else {
      socket.emit('auth-failed');
    }
  });

  socket.on('disconnect', () => {
    console.log('🔌 Client déconnecté:', socket.id);
    connectedClients.delete(socket);
  });
});

// Fonction pour notifier tous les clients
const notifyClients = (event, data) => {
  io.emit(event, data);
};

// ============ TELEGRAM NOTIFICATIONS ============

async function sendTelegramNotification(order) {
  const message = `
🛍️ *NOUVELLE COMMANDE*

📦 Commande: #${order.orderNumber}
👤 Client: ${order.customerName}
📱 Téléphone: ${order.phone}
📍 Adresse: ${order.address}

🛒 *Articles:*
${order.items.map(item => `• ${item.quantity}x ${item.name}${item.variant ? ' ' + item.variant : ''} - ${item.price}€`).join('\n')}

💰 *Total: ${order.total}€*
💳 Paiement: ${order.paymentMethod}
${order.deliveryTime ? `🕐 Livraison: ${order.deliveryTime}` : ''}
${order.notes ? `📝 Note: ${order.notes}` : ''}

🔗 Admin: ${process.env.ADMIN_URL || 'Votre URL admin'}
  `.trim();

  try {
    await axios.post(
      `https://api.telegram.org/bot${process.env.TELEGRAM_TOKEN}/sendMessage`,
      {
        chat_id: process.env.ADMIN_CHAT_ID,
        text: message,
        parse_mode: 'Markdown'
      }
    );
    console.log('✅ Notification Telegram envoyée');
  } catch (error) {
    console.error('❌ Erreur notification Telegram:', error.message);
  }
}

async function sendTelegramMessage(text) {
  if (!process.env.TELEGRAM_TOKEN || !process.env.ADMIN_CHAT_ID) {
    console.log('⚠️ Telegram non configuré');
    return;
  }

  try {
    await axios.post(
      `https://api.telegram.org/bot${process.env.TELEGRAM_TOKEN}/sendMessage`,
      {
        chat_id: process.env.ADMIN_CHAT_ID,
        text: text,
        parse_mode: 'HTML'
      }
    );
  } catch (error) {
    console.error('❌ Erreur Telegram:', error.message);
  }
}

async function sendLowStockAlert(product, variant, stock) {
  const text = `⚠️ <b>ALERTE STOCK BAS</b>\n\n📦 Produit: ${product}\n🔖 Variant: ${variant}\n📊 Stock: <b>${stock} unités</b>\n\n⚡ Réapprovisionner rapidement !`;
  await sendTelegramMessage(text);
}

async function sendLargeTransactionAlert(transaction) {
  const emoji = transaction.type === 'income' ? '💰' : '💸';
  const typeText = transaction.type === 'income' ? 'ENTRÉE' : 'SORTIE';
  const text = `${emoji} <b>${typeText} IMPORTANTE</b>\n\n💵 Montant: <b>${transaction.amount.toFixed(2)}€</b>\n📝 ${transaction.description || 'Transaction importante'}\n\n🕐 ${new Date().toLocaleString('fr-FR')}`;
  await sendTelegramMessage(text);
}

// ============ ROUTES ============

// Health check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    mongodb: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
    telegram: process.env.TELEGRAM_TOKEN ? 'configured' : 'not configured',
    websocket: `${connectedClients.size} clients connectés`,
    timestamp: new Date().toISOString()
  });
});

// ============ ORDERS ROUTES ============

app.get('/api/orders', async (req, res) => {
  try {
    const { status, search, limit = 50 } = req.query;
    let query = {};
    
    if (status && status !== 'all') query.status = status;
    if (search) {
      query.$or = [
        { customerName: { $regex: search, $options: 'i' } },
        { phone: { $regex: search, $options: 'i' } }
      ];
    }
    
    const orders = await Order.find(query)
      .sort({ createdAt: -1 })
      .limit(parseInt(limit));
    
    res.json(orders);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/orders/:id', async (req, res) => {
  try {
    const order = await Order.findById(req.params.id);
    if (!order) {
      return res.status(404).json({ error: 'Commande non trouvée' });
    }
    res.json(order);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/orders', async (req, res) => {
  try {
    const count = await Order.countDocuments();
    const orderNumber = req.body.orderNumber || `ORD${Date.now()}-${count + 1}`;
    
    const orderData = {
      ...req.body,
      orderNumber,
      createdAt: new Date(),
      updatedAt: new Date()
    };

    const order = new Order(orderData);
    await order.save();

    // Notifications
    notifyClients('new-order', order);
    await sendTelegramNotification(order);

    res.status(201).json(order);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.put('/api/orders/:id', async (req, res) => {
  try {
    const order = await Order.findByIdAndUpdate(
      req.params.id,
      { ...req.body, updatedAt: new Date() },
      { new: true }
    );
    
    if (!order) {
      return res.status(404).json({ error: 'Commande non trouvée' });
    }

    notifyClients('order-updated', order);
    res.json(order);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.patch('/api/orders/:id/status', async (req, res) => {
  try {
    const { status } = req.body;
    const order = await Order.findByIdAndUpdate(
      req.params.id,
      { status, updatedAt: new Date() },
      { new: true }
    );
    
    if (!order) {
      return res.status(404).json({ error: 'Commande non trouvée' });
    }

    notifyClients('order-updated', order);
    
    if (status === 'delivered') {
      await sendTelegramMessage(`✅ <b>COMMANDE LIVRÉE</b>\n\n📦 #${order.orderNumber}\n👤 ${order.customerName}\n💰 ${order.total}€`);
    }

    res.json(order);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.delete('/api/orders/:id', async (req, res) => {
  try {
    const order = await Order.findByIdAndDelete(req.params.id);
    
    if (!order) {
      return res.status(404).json({ error: 'Commande non trouvée' });
    }

    notifyClients('order-deleted', req.params.id);
    res.json({ message: 'Commande supprimée', order });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============ PRODUCTS ROUTES ============

app.get('/api/products', async (req, res) => {
  try {
    const { category } = req.query;
    let query = {};
    
    if (category && category !== 'all') query.category = category;
    
    const products = await Product.find(query);
    res.json(products);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/products', async (req, res) => {
  try {
    const product = new Product(req.body);
    await product.save();
    
    notifyClients('product-added', product);
    await sendTelegramMessage(`📦 <b>Nouveau produit ajouté</b>\n\n${product.name}\nCatégorie: ${product.category}`);
    
    res.status(201).json(product);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.put('/api/products/:id', async (req, res) => {
  try {
    const product = await Product.findByIdAndUpdate(
      req.params.id,
      req.body,
      { new: true }
    );
    
    if (!product) {
      return res.status(404).json({ error: 'Produit non trouvé' });
    }
    
    notifyClients('product-updated', product);
    res.json(product);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.put('/api/products/:id/stock', async (req, res) => {
  try {
    const { variant, quantity, operation } = req.body;
    const product = await Product.findById(req.params.id);
    
    if (!product) {
      return res.status(404).json({ error: 'Produit non trouvé' });
    }
    
    const variantData = product.variants.get(variant);
    if (!variantData) {
      return res.status(404).json({ error: 'Variant non trouvé' });
    }
    
    if (operation === 'add') {
      variantData.stock += quantity;
    } else if (operation === 'set') {
      variantData.stock = quantity;
    } else if (operation === 'subtract') {
      variantData.stock -= quantity;
    }
    
    product.variants.set(variant, variantData);
    await product.save();
    
    // Alerte stock bas
    if (variantData.stock > 0 && variantData.stock < 10) {
      await sendLowStockAlert(product.name, variant, variantData.stock);
      notifyClients('low-stock-alert', { product: product.name, variant, stock: variantData.stock });
    }
    
    notifyClients('stock-updated', product);
    res.json(product);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.delete('/api/products/:id', async (req, res) => {
  try {
    await Product.findByIdAndDelete(req.params.id);
    notifyClients('product-deleted', req.params.id);
    res.json({ message: 'Produit supprimé' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============ CASH/TRANSACTIONS ROUTES ============

app.get('/api/cash', async (req, res) => {
  try {
    const transactions = await Transaction.find()
      .sort({ createdAt: -1 })
      .limit(100);
    
    const total = await Transaction.getCurrentBalance();
    
    res.json({ total, transactions });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/cash/transaction', async (req, res) => {
  try {
    const transaction = new Transaction(req.body);
    await transaction.save();
    
    notifyClients('new-transaction', transaction);
    
    if (transaction.amount >= 100) {
      await sendLargeTransactionAlert(transaction);
    }
    
    res.status(201).json(transaction);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.get('/api/cash/today', async (req, res) => {
  try {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    
    const transactions = await Transaction.find({
      createdAt: { $gte: todayStart }
    });
    
    const income = transactions
      .filter(t => t.type === 'income')
      .reduce((sum, t) => sum + t.amount, 0);
    
    const expense = transactions
      .filter(t => t.type === 'expense')
      .reduce((sum, t) => sum + t.amount, 0);
    
    res.json({
      income,
      expense,
      balance: income - expense,
      transactions
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============ STATS ROUTES ============

app.get('/api/stats', async (req, res) => {
  try {
    const totalOrders = await Order.countDocuments();
    const pendingOrders = await Order.countDocuments({ status: 'pending' });
    const deliveredOrders = await Order.countDocuments({ status: 'delivered' });
    
    const orders = await Order.find();
    const totalRevenue = orders.reduce((sum, order) => sum + order.total, 0);

    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    
    const todayOrders = await Order.countDocuments({
      createdAt: { $gte: todayStart }
    });
    
    const todayRevenue = await Order.aggregate([
      { $match: { createdAt: { $gte: todayStart } } },
      { $group: { _id: null, total: { $sum: '$total' } } }
    ]);

    res.json({
      totalOrders,
      pendingOrders,
      deliveredOrders,
      totalRevenue,
      averageOrder: totalOrders > 0 ? (totalRevenue / totalOrders).toFixed(2) : 0,
      todayOrders,
      todayRevenue: todayRevenue[0]?.total || 0
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/analytics/sales', async (req, res) => {
  try {
    const { days = 7 } = req.query;
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - parseInt(days));
    
    const salesByDay = await Order.aggregate([
      { $match: { createdAt: { $gte: startDate } } },
      {
        $group: {
          _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
          total: { $sum: '$total' },
          count: { $sum: 1 }
        }
      },
      { $sort: { _id: 1 } }
    ]);
    
    res.json(salesByDay);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============ AUTH ============

app.post('/api/auth/login', (req, res) => {
  const { password } = req.body;
  const validPassword = process.env.ADMIN_PASS || 'gangstaforlife12';
  
  if (password === validPassword) {
    res.json({ success: true, token: 'admin-token-' + Date.now() });
  } else {
    res.status(401).json({ success: false, message: 'Mot de passe incorrect' });
  }
});

// ============ TELEGRAM TEST ============

app.post('/api/test-telegram', async (req, res) => {
  try {
    await axios.post(
      `https://api.telegram.org/bot${process.env.TELEGRAM_TOKEN}/sendMessage`,
      {
        chat_id: process.env.ADMIN_CHAT_ID,
        text: '✅ Test de notification Telegram réussi !',
        parse_mode: 'Markdown'
      }
    );
    res.json({ success: true, message: 'Notification test envoyée' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Serve admin panel (si dans public/)
app.get('/', (req, res) => {
  const adminPath = path.join(__dirname, 'public', 'admin.html');
  res.sendFile(adminPath, (err) => {
    if (err) {
      res.send('<h1>🚀 DROGUA Backend API</h1><p>Server running. Admin panel: configure <code>public/admin.html</code></p>');
    }
  });
});

// 404 Handler
app.use((req, res) => {
  res.status(404).json({ error: 'Route non trouvée' });
});

// Error Handler
app.use((err, req, res, next) => {
  console.error('❌ Erreur:', err);
  res.status(500).json({ error: 'Erreur serveur' });
});

// Start Server
server.listen(PORT, () => {
  console.log(`
╔═══════════════════════════════════════╗
║   🚀 DROGUA CENTER ADMIN BACKEND     ║
║                                       ║
║   Server: http://localhost:${PORT}     ║
║   WebSocket: ✅ ${connectedClients.size} clients           ║
║   MongoDB: ✅ Connecté                ║
║   Telegram: ✅ Configuré              ║
╚═══════════════════════════════════════╝
  `);
});

module.exports = { app, io, notifyClients };
