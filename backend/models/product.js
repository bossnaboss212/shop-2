// models/Product.js
const mongoose = require('mongoose');

const productSchema = new mongoose.Schema({
  name: { 
    type: String, 
    required: true, 
    unique: true 
  },
  category: {
    type: String,
    required: true,
    enum: ['blanche', 'keta', 'mdma', 'bonbon', 'cali', 'fleurs', 'filtré', 'resines']
  },
  buyPrice: { 
    type: Number, 
    required: true 
  },
  variants: {
    type: Map,
    of: {
      price: Number,
      stock: Number
    },
    required: true
  },
  active: { 
    type: Boolean, 
    default: true 
  },
  description: String,
  image: String
}, {
  timestamps: true
});

// Index pour recherche
productSchema.index({ name: 'text', category: 1 });

// Méthode pour obtenir les variants avec stock bas
productSchema.methods.getLowStockVariants = function() {
  const lowStock = [];
  for (let [variant, data] of this.variants) {
    if (data.stock > 0 && data.stock < 10) {
      lowStock.push({ variant, stock: data.stock });
    }
  }
  return lowStock;
};

// Méthode pour calculer la valeur totale du stock
productSchema.methods.getTotalStockValue = function() {
  let total = 0;
  for (let [variant, data] of this.variants) {
    total += data.stock * data.price;
  }
  return total;
};

module.exports = mongoose.model('Product', productSchema);
