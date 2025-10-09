// models/Order.js
const mongoose = require('mongoose');

const orderSchema = new mongoose.Schema({
  orderNumber: { type: String, required: true, unique: true },
  customerName: { type: String, required: true },
  phone: { type: String, required: true },
  address: { type: String, required: true },
  email: String,
  items: [{
    name: String,
    variant: String,
    quantity: Number,
    price: Number
  }],
  total: { type: Number, required: true },
  status: { 
    type: String, 
    default: 'pending',
    enum: ['pending', 'confirmed', 'processing', 'preparing', 'delivering', 'delivered', 'cancelled']
  },
  paymentMethod: { 
    type: String, 
    default: 'cash',
    enum: ['cash', 'card', 'crypto', 'transfer', 'Espèces', 'CB', 'Crypto', 'Virement']
  },
  deliveryTime: String,
  deliveryType: String,
  notes: String,
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

// Index pour recherche rapide
orderSchema.index({ orderNumber: 1 });
orderSchema.index({ customerName: 'text', phone: 'text' });
orderSchema.index({ status: 1, createdAt: -1 });

module.exports = mongoose.model('Order', orderSchema);
