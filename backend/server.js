require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const app = express();
const PORT = process.env.PORT || 3000;

// ==================== MIDDLEWARES ====================
app.use(helmet());
app.use(cors({
  origin: process.env.FRONTEND_URL || '*',
  credentials: true
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limite par IP
  message: 'Trop de requêtes, réessayez plus tard'
});
app.use('/api/', limiter);

// ==================== MONGODB CONNECTION ====================
mongoose.connect(process.env.MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true
})
.then(() => console.log('✅ MongoDB connecté avec succès'))
.catch(err => {
  console.error('❌ Erreur MongoDB:', err);
  process.exit(1);
});

// ==================== MODELS ====================
const orderSchema = new mongoose.Schema({
  orderId: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  customer: {
    type: String,
    required: true
  },
  items: [{
    productId: Number,
    name: String,
    variant: String,
    qty: Number,
    price: Number,
    lineTotal: Number
  }],
  deliveryAddress: {
    type: String,
    required: true
  },
  deliveryType: {
    type: String,
    required: true
  },
  total: {
    type: Number,
    required: true
  },
  status: {
    type: String,
    enum: ['pending', 'confirmed', 'preparing', 'delivering', 'delivered', 'cancelled'],
    default: 'pending'
  },
  paymentMethod: {
    type: String,
    default: 'Espèces'
  },
  notes: String,
  createdAt: {
    type: Date,
    default: Date.now
  },
  updatedAt: {
    type: Date,
    default: Date.now
  }
});

orderSchema.index({ createdAt: -1 });

const Order = mongoose.model('Order', orderSchema);

// ==================== TELEGRAM NOTIFICATIONS ====================
let bot = null;
if (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_ADMIN_CHAT_ID) {
  const TelegramBot = require('node-telegram-bot-api');
  bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: false });
  
  async function sendTelegramNotification(order) {
    try {
      const message = `🛒 *NOUVELLE COMMANDE*\n\n` +
        `📋 ID: \`${order.orderId}\`\n` +
        `👤 Client: ${order.customer}\n` +
        `📍 Adresse: ${order.deliveryAddress}\n` +
        `🚚 Type: ${order.deliveryType}\n` +
        `💰 Total: ${order.total.toFixed(2)} €\n\n` +
        `📦 *Articles:*\n` +
        order.items.map(item => 
          `• ${item.name} (${item.variant}) x${item.qty} = ${item.lineTotal.toFixed(2)}€`
        ).join('\n') +
        `\n\n🕐 ${new Date(order.createdAt).toLocaleString('fr-FR')}`;
      
      await bot.sendMessage(process.env.TELEGRAM_ADMIN_CHAT_ID, message, {
        parse_mode: 'Markdown'
      });
      console.log('✅ Notification Telegram envoyée');
    } catch (error) {
      console.error('❌ Erreur notification Telegram:', error);
    }
  }
} else {
  console.log('⚠️ Telegram non configuré (pas de bot token)');
}

// ==================== ROUTES ====================

// Health check
app.get('/', (req, res) => {
  res.json({
    status: 'online',
    message: 'DROGUA CENTER API v1.0',
    timestamp: new Date().toISOString()
  });
});

// Créer une commande (PUBLIC - depuis la boutique)
app.post('/api/create-order', async (req, res) => {
  try {
    const { customer, type, address, items, total } = req.body;
    
    // Validation
    if (!customer || !address || !items || !total) {
      return res.status(400).json({
        ok: false,
        error: 'Données manquantes'
      });
    }
    
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({
        ok: false,
        error: 'Panier vide'
      });
    }
    
    // Générer ID unique
    const orderId = 'DC' + Date.now().toString().slice(-8);
    
    // Créer la commande
    const order = new Order({
      orderId,
      customer,
      items,
      deliveryAddress: address,
      deliveryType: type,
      total,
      status: 'pending',
      paymentMethod: 'Espèces'
    });
    
    await order.save();
    
    // Envoyer notification Telegram
    if (bot) {
      await sendTelegramNotification(order);
    }
    
    console.log(`✅ Commande créée: ${orderId}`);
    
    res.json({
      ok: true,
      orderId: orderId,
      message: 'Commande créée avec succès'
    });
    
  } catch (error) {
    console.error('❌ Erreur création commande:', error);
    res.status(500).json({
      ok: false,
      error: 'Erreur serveur'
    });
  }
});

// Récupérer toutes les commandes (ADMIN)
app.get('/api/orders', authenticateAdmin, async (req, res) => {
  try {
    const { status, limit = 100, skip = 0 } = req.query;
    
    const filter = status ? { status } : {};
    
    const orders = await Order.find(filter)
      .sort({ createdAt: -1 })
      .limit(parseInt(limit))
      .skip(parseInt(skip));
    
    const total = await Order.countDocuments(filter);
    
    res.json({
      ok: true,
      orders,
      total,
      page: Math.floor(skip / limit) + 1,
      totalPages: Math.ceil(total / limit)
    });
    
  } catch (error) {
    console.error('❌ Erreur récupération commandes:', error);
    res.status(500).json({
      ok: false,
      error: 'Erreur serveur'
    });
  }
});

// Récupérer une commande spécifique (ADMIN)
app.get('/api/orders/:orderId', authenticateAdmin, async (req, res) => {
  try {
    const order = await Order.findOne({ orderId: req.params.orderId });
    
    if (!order) {
      return res.status(404).json({
        ok: false,
        error: 'Commande introuvable'
      });
    }
    
    res.json({
      ok: true,
      order
    });
    
  } catch (error) {
    console.error('❌ Erreur récupération commande:', error);
    res.status(500).json({
      ok: false,
      error: 'Erreur serveur'
    });
  }
});

// Mettre à jour le statut d'une commande (ADMIN)
app.put('/api/orders/:orderId', authenticateAdmin, async (req, res) => {
  try {
    const { status, notes } = req.body;
    
    const validStatuses = ['pending', 'confirmed', 'preparing', 'delivering', 'delivered', 'cancelled'];
    if (status && !validStatuses.includes(status)) {
      return res.status(400).json({
        ok: false,
        error: 'Statut invalide'
      });
    }
    
    const update = {
      updatedAt: Date.now()
    };
    
    if (status) update.status = status;
    if (notes) update.notes = notes;
    
    const order = await Order.findOneAndUpdate(
      { orderId: req.params.orderId },
      update,
      { new: true }
    );
    
    if (!order) {
      return res.status(404).json({
        ok: false,
        error: 'Commande introuvable'
      });
    }
    
    console.log(`✅ Commande ${req.params.orderId} mise à jour: ${status}`);
    
    res.json({
      ok: true,
      order
    });
    
  } catch (error) {
    console.error('❌ Erreur mise à jour commande:', error);
    res.status(500).json({
      ok: false,
      error: 'Erreur serveur'
    });
  }
});

// Supprimer une commande (ADMIN)
app.delete('/api/orders/:orderId', authenticateAdmin, async (req, res) => {
  try {
    const order = await Order.findOneAndDelete({ orderId: req.params.orderId });
    
    if (!order) {
      return res.status(404).json({
        ok: false,
        error: 'Commande introuvable'
      });
    }
    
    console.log(`🗑️ Commande ${req.params.orderId} supprimée`);
    
    res.json({
      ok: true,
      message: 'Commande supprimée'
    });
    
  } catch (error) {
    console.error('❌ Erreur suppression commande:', error);
    res.status(500).json({
      ok: false,
      error: 'Erreur serveur'
    });
  }
});

// Statistiques (ADMIN)
app.get('/api/stats', authenticateAdmin, async (req, res) => {
  try {
    const totalOrders = await Order.countDocuments();
    const pendingOrders = await Order.countDocuments({ status: 'pending' });
    const deliveredOrders = await Order.countDocuments({ status: 'delivered' });
    
    const totalRevenue = await Order.aggregate([
      { $match: { status: { $ne: 'cancelled' } } },
      { $group: { _id: null, total: { $sum: '$total' } } }
    ]);
    
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    
    const todayOrders = await Order.countDocuments({
      createdAt: { $gte: todayStart }
    });
    
    res.json({
      ok: true,
      stats: {
        totalOrders,
        pendingOrders,
        deliveredOrders,
        todayOrders,
        totalRevenue: totalRevenue[0]?.total || 0
      }
    });
    
  } catch (error) {
    console.error('❌ Erreur statistiques:', error);
    res.status(500).json({
      ok: false,
      error: 'Erreur serveur'
    });
  }
});

// ==================== AUTHENTICATION MIDDLEWARE ====================
function authenticateAdmin(req, res, next) {
  const authHeader = req.headers.authorization;
  
  if (!authHeader) {
    return res.status(401).json({
      ok: false,
      error: 'Non authentifié'
    });
  }
  
  // Simple token-based auth (vous pouvez améliorer avec JWT)
  const token = authHeader.replace('Bearer ', '');
  
  if (token !== process.env.ADMIN_TOKEN) {
    return res.status(403).json({
      ok: false,
      error: 'Token invalide'
    });
  }
  
  next();
}

// ==================== ERROR HANDLING ====================
app.use((err, req, res, next) => {
  console.error('❌ Erreur:', err);
  res.status(500).json({
    ok: false,
    error: 'Erreur serveur interne'
  });
});

// 404
app.use((req, res) => {
  res.status(404).json({
    ok: false,
    error: 'Route introuvable'
  });
});

// ==================== START SERVER ====================
app.listen(PORT, () => {
  console.log(`🚀 Serveur démarré sur le port ${PORT}`);
  console.log(`📍 URL: http://localhost:${PORT}`);
  console.log(`🔗 MongoDB: ${process.env.MONGODB_URI ? 'Connecté' : 'Non configuré'}`);
  console.log(`📱 Telegram: ${bot ? 'Actif' : 'Désactivé'}`);
});
