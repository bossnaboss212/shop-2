require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// MongoDB Connection
mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('✅ MongoDB connecté'))
  .catch(err => console.error('❌ Erreur MongoDB:', err));

// Order Schema
const orderSchema = new mongoose.Schema({
  orderNumber: { type: String, required: true, unique: true },
  customerName: { type: String, required: true },
  phone: { type: String, required: true },
  address: { type: String, required: true },
  items: [{
    name: String,
    quantity: Number,
    price: Number
  }],
  total: { type: Number, required: true },
  status: { 
    type: String, 
    default: 'pending',
    enum: ['pending', 'confirmed', 'preparing', 'delivering', 'delivered', 'cancelled']
  },
  paymentMethod: { type: String, default: 'cash' },
  deliveryTime: String,
  notes: String,
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

const Order = mongoose.model('Order', orderSchema);

// Telegram notification function
async function sendTelegramNotification(order) {
  const message = `
🛍️ *NOUVELLE COMMANDE*

📦 Commande: #${order.orderNumber}
👤 Client: ${order.customerName}
📱 Téléphone: ${order.phone}
📍 Adresse: ${order.address}

🛒 *Articles:*
${order.items.map(item => `• ${item.quantity}x ${item.name} - ${item.price}€`).join('\n')}

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

// Routes

// Health check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    mongodb: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
    telegram: process.env.TELEGRAM_TOKEN ? 'configured' : 'not configured',
    timestamp: new Date().toISOString()
  });
});

// Get all orders
app.get('/api/orders', async (req, res) => {
  try {
    const orders = await Order.find().sort({ createdAt: -1 });
    res.json(orders);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get single order
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

// Create order
app.post('/api/orders', async (req, res) => {
  try {
    // Generate order number
    const count = await Order.countDocuments();
    const orderNumber = `ORD${Date.now()}-${count + 1}`;
    
    const orderData = {
      ...req.body,
      orderNumber,
      createdAt: new Date(),
      updatedAt: new Date()
    };

    const order = new Order(orderData);
    await order.save();

    // Send Telegram notification
    await sendTelegramNotification(order);

    res.status(201).json(order);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// Update order status
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

    res.json(order);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// Update order
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

    res.json(order);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// Delete order
app.delete('/api/orders/:id', async (req, res) => {
  try {
    const order = await Order.findByIdAndDelete(req.params.id);
    
    if (!order) {
      return res.status(404).json({ error: 'Commande non trouvée' });
    }

    res.json({ message: 'Commande supprimée', order });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get statistics
app.get('/api/stats', async (req, res) => {
  try {
    const totalOrders = await Order.countDocuments();
    const pendingOrders = await Order.countDocuments({ status: 'pending' });
    const deliveredOrders = await Order.countDocuments({ status: 'delivered' });
    
    const orders = await Order.find();
    const totalRevenue = orders.reduce((sum, order) => sum + order.total, 0);

    res.json({
      totalOrders,
      pendingOrders,
      deliveredOrders,
      totalRevenue,
      averageOrder: totalOrders > 0 ? (totalRevenue / totalOrders).toFixed(2) : 0
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Test Telegram notification
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

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Serveur démarré sur le port ${PORT}`);
  console.log(`📊 Health check: http://localhost:${PORT}/health`);
});
