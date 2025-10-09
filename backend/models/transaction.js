// models/Transaction.js
const mongoose = require('mongoose');

const transactionSchema = new mongoose.Schema({
  type: {
    type: String,
    enum: ['income', 'expense', 'adjustment'],
    required: true
  },
  amount: { 
    type: Number, 
    required: true 
  },
  category: {
    type: String,
    enum: [
      'sale', 
      'purchase', 
      'expense', 
      'adjustment', 
      'other', 
      'supplier', 
      'operating', 
      'service', 
      'correction'
    ],
    default: 'other'
  },
  description: String,
  balanceAfter: Number,
  relatedOrder: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Order'
  },
  createdBy: String
}, {
  timestamps: true
});

// Index pour requêtes rapides
transactionSchema.index({ type: 1, createdAt: -1 });
transactionSchema.index({ createdAt: -1 });

// Méthode statique pour calculer la balance actuelle
transactionSchema.statics.getCurrentBalance = async function() {
  const transactions = await this.find().sort({ createdAt: 1 });
  let balance = 2500; // Montant de départ de la caisse
  
  transactions.forEach(t => {
    if (t.type === 'income') {
      balance += t.amount;
    } else if (t.type === 'expense') {
      balance -= t.amount;
    } else if (t.type === 'adjustment') {
      balance = t.amount;
    }
  });
  
  return balance;
};

module.exports = mongoose.model('Transaction', transactionSchema);
