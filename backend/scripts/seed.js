require('dotenv').config();
const mongoose = require('mongoose');
const Product = require('../models/Product');

const products = [
  {
    name: 'AMNESIA',
    category: 'fleurs',
    buyPrice: 2.8,
    variants: new Map([
      ['3.33G', { price: 20, stock: 50 }],
      ['5G', { price: 30, stock: 45 }],
      ['10G', { price: 60, stock: 30 }],
      ['50G', { price: 250, stock: 10 }],
      ['100G', { price: 450, stock: 5 }]
    ]),
    active: true
  },
  {
    name: 'EL JEFE',
    category: 'blanche',
    buyPrice: 17.5,
    variants: new Map([
      ['0.5G', { price: 30, stock: 20 }],
      ['1G', { price: 50, stock: 15 }],
      ['2G', { price: 100, stock: 10 }],
      ['5G', { price: 250, stock: 5 }],
      ['10G', { price: 430, stock: 3 }]
    ]),
    active: true
  },
  {
    name: 'DEMBELE',
    category: 'resines',
    buyPrice: 2.7,
    variants: new Map([
      ['3.5G', { price: 20, stock: 60 }],
      ['5G', { price: 30, stock: 50 }],
      ['10G', { price: 50, stock: 40 }],
      ['50G', { price: 190, stock: 15 }],
      ['100G', { price: 370, stock: 8 }]
    ]),
    active: true
  },
  {
    name: 'LEMON X GELATO',
    category: 'cali',
    buyPrice: 5.3,
    variants: new Map([
      ['1.66G', { price: 20, stock: 25 }],
      ['3.5G', { price: 40, stock: 20 }],
      ['5G', { price: 60, stock: 15 }],
      ['10G', { price: 110, stock: 10 }]
    ]),
    active: true
  },
  {
    name: 'NEEDLES KETA',
    category: 'keta',
    buyPrice: 3.9,
    variants: new Map([
      ['1G', { price: 20, stock: 30 }],
      ['2G', { price: 40, stock: 25 }],
      ['3G', { price: 50, stock: 20 }],
      ['5G', { price: 80, stock: 15 }],
      ['10G', { price: 150, stock: 10 }]
    ]),
    active: true
  },
  {
    name: 'CHAMPAGNE',
    category: 'mdma',
    buyPrice: 3.9,
    variants: new Map([
      ['1G', { price: 20, stock: 35 }],
      ['2G', { price: 40, stock: 30 }],
      ['3G', { price: 50, stock: 25 }],
      ['5G', { price: 80, stock: 20 }],
      ['10G', { price: 150, stock: 12 }]
    ]),
    active: true
  },
  {
    name: 'SKITTLEZ CAKE 120u',
    category: 'filtré',
    buyPrice: 3,
    variants: new Map([
      ['2.5G', { price: 20, stock: 40 }],
      ['5G', { price: 40, stock: 35 }],
      ['10G', { price: 70, stock: 25 }],
      ['50G', { price: 290, stock: 8 }]
    ]),
    active: true
  },
  {
    name: 'DOMINO 280mg',
    category: 'bonbon',
    buyPrice: 1.5,
    variants: new Map([
      ['3 unités', { price: 20, stock: 50 }],
      ['10 unités', { price: 60, stock: 30 }],
      ['50 unités', { price: 150, stock: 10 }]
    ]),
    active: true
  },
  {
    name: 'PURPLE HAZE',
    category: 'fleurs',
    buyPrice: 2.7,
    variants: new Map([
      ['3.33G', { price: 20, stock: 45 }],
      ['5G', { price: 30, stock: 40 }],
      ['10G', { price: 60, stock: 35 }],
      ['50G', { price: 250, stock: 12 }],
      ['100G', { price: 480, stock: 6 }]
    ]),
    active: true
  }
];

async function seed() {
  try {
    console.log('🌱 Connexion à MongoDB...');
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('✅ Connecté');

    console.log('🧹 Nettoyage des produits existants...');
    await Product.deleteMany({});
    
    console.log('📦 Insertion des produits...');
    await Product.insertMany(products);
    
    const count = await Product.countDocuments();
    console.log(`✅ ${count} produits insérés avec succès!`);
    
    console.log('\n📊 CATALOGUE DROGUA CENTER');
    console.log('============================');
    const allProducts = await Product.find();
    allProducts.forEach(p => {
      const variants = Array.from(p.variants.entries());
      const totalStock = variants.reduce((sum, [k, v]) => sum + v.stock, 0);
      console.log(`${p.name} (${p.category}) - ${totalStock} unités`);
    });
    
    console.log('\n✅ SEED TERMINÉ!\n');
    process.exit(0);
  } catch (error) {
    console.error('❌ Erreur:', error);
    process.exit(1);
  }
}

seed();
