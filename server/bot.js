const express = require('express');
const axios = require('axios');

// ============================================================
// BOT TELEGRAM AMÉLIORÉ - DROGUA CENTER
// ============================================================
// 
// FONCTIONNALITÉS PRINCIPALES :
// 
// 1. CLAVIER PERSISTANT (Reply Keyboard)
//    - Boutons toujours visibles en bas de l'écran
//    - Navigation rapide : Menu, Boutique, Admin, Aide, Support
//    - Activé automatiquement au premier /start
//    - Toggle avec /keyboard
//
// 2. BOUTONS INLINE (Inline Keyboard)
//    - Boutons dans les messages
//    - WebApp pour ouvrir la boutique/admin
//    - Liens vers canaux et support
//
// 3. NAVIGATION INTELLIGENTE
//    - Bouton "🏠 Menu Principal" sur chaque écran
//    - Édition des messages au lieu de nouveaux envois
//    - Fallback automatique en cas d'erreur
//
// 4. COMMANDES DISPONIBLES
//    /start - Menu principal
//    /shop ou /boutique - Boutique
//    /admin - Panneau admin
//    /help ou /aide - Aide
//    /keyboard - Activer/Désactiver clavier persistant
//    /status - Suivi de commandes
//    /parrainage - Programme de parrainage
//    /fidelite - Programme de fidélité
//    /horaires - Horaires d'ouverture
//    /catalogue - Voir les catégories de produits
//    /tuto - Tutoriel comment commander
//
// ============================================================

// ============================================================
// CONFIGURATION
// ============================================================
const CONFIG = {
  BOT_TOKEN: process.env.TELEGRAM_TOKEN,
  WEBAPP_URL: process.env.WEBAPP_URL || 'https://shop-2-production-6505.up.railway.app',
  WEBHOOK_DOMAIN: process.env.RAILWAY_PUBLIC_DOMAIN || 'https://shop-2-production-6505.up.railway.app',
  PORT: process.env.BOT_PORT || 3001,
  SUPPORT_USERNAME: '@newassistance4',
  BUSINESS_HOURS: '7j/7 de 12H à 00H (minuit)',
  DELIVERY_INFO: {
    free: 'Gratuite sur Millau',
    paid: '+20€ pour l\'extérieur'
  }
};

// Validation de la configuration
if (!CONFIG.BOT_TOKEN) {
  console.error('❌ ERREUR: TELEGRAM_TOKEN manquant dans les variables d\'environnement');
  process.exit(1);
}

// ============================================================
// INITIALISATION EXPRESS
// ============================================================
const app = express();
app.use(express.json());

// Middleware de logging
app.use((req, res, next) => {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${req.method} ${req.path}`);
  next();
});

// ============================================================
// TELEGRAM API HELPERS
// ============================================================
class TelegramAPI {
  static async sendMessage(chatId, text, keyboard = null, options = {}) {
    const url = `https://api.telegram.org/bot${CONFIG.BOT_TOKEN}/sendMessage`;
    
    const data = {
      chat_id: chatId,
      text: text,
      parse_mode: 'HTML',
      ...options
    };
    
    if (keyboard) {
      data.reply_markup = keyboard;
    }
    
    try {
      const response = await axios.post(url, data);
      return response.data;
    } catch (error) {
      console.error('❌ Error sending message:', error.response?.data || error.message);
      throw error;
    }
  }

  static async sendPhoto(chatId, photoUrl, caption, keyboard = null) {
    const url = `https://api.telegram.org/bot${CONFIG.BOT_TOKEN}/sendPhoto`;
    
    const data = {
      chat_id: chatId,
      photo: photoUrl,
      caption: caption,
      parse_mode: 'HTML'
    };
    
    if (keyboard) {
      data.reply_markup = keyboard;
    }
    
    try {
      const response = await axios.post(url, data);
      return response.data;
    } catch (error) {
      console.error('❌ Error sending photo:', error.response?.data || error.message);
      throw error;
    }
  }

  static async answerCallbackQuery(callbackQueryId, text = null) {
    const url = `https://api.telegram.org/bot${CONFIG.BOT_TOKEN}/answerCallbackQuery`;
    
    const data = { callback_query_id: callbackQueryId };
    if (text) {
      data.text = text;
      data.show_alert = false;
    }
    
    try {
      await axios.post(url, data);
    } catch (error) {
      console.error('❌ Error answering callback:', error.message);
    }
  }

  static async editMessageText(chatId, messageId, text, keyboard = null) {
    const url = `https://api.telegram.org/bot${CONFIG.BOT_TOKEN}/editMessageText`;
    
    const data = {
      chat_id: chatId,
      message_id: messageId,
      text: text,
      parse_mode: 'HTML'
    };
    
    if (keyboard) {
      data.reply_markup = keyboard;
    }
    
    try {
      await axios.post(url, data);
    } catch (error) {
      console.error('❌ Error editing message:', error.message);
    }
  }

  static async setWebhook(webhookUrl) {
    const url = `https://api.telegram.org/bot${CONFIG.BOT_TOKEN}/setWebhook`;
    
    try {
      const response = await axios.post(url, {
        url: webhookUrl,
        allowed_updates: ['message', 'callback_query'],
        drop_pending_updates: false
      });
      
      console.log('✅ Webhook configuré:', webhookUrl);
      return response.data;
    } catch (error) {
      console.error('❌ Erreur webhook:', error.response?.data || error.message);
      throw error;
    }
  }

  static async setBotCommands() {
    const url = `https://api.telegram.org/bot${CONFIG.BOT_TOKEN}/setMyCommands`;
    
    const commands = [
      { command: 'start', description: '🏠 Menu principal' },
      { command: 'shop', description: '🛒 Ouvrir la boutique' },
      { command: 'tuto', description: '📖 Comment commander' },
      { command: 'orders', description: '📦 Mes commandes' },
      { command: 'status', description: '📊 Suivi de commande' },
      { command: 'catalogue', description: '📋 Voir les produits' },
      { command: 'fidelite', description: '🎁 Programme de fidélité' },
      { command: 'parrainage', description: '🤝 Programme de parrainage' },
      { command: 'horaires', description: '🕐 Horaires d\'ouverture' },
      { command: 'admin', description: '🔐 Panneau admin' },
      { command: 'help', description: '❓ Aide et support' },
      { command: 'keyboard', description: '⌨️ Afficher/Masquer le clavier' }
    ];
    
    try {
      await axios.post(url, { commands });
      console.log('✅ Commandes du bot configurées');
    } catch (error) {
      console.error('❌ Erreur commandes:', error.message);
    }
  }

  static async setMenuButton() {
    const url = `https://api.telegram.org/bot${CONFIG.BOT_TOKEN}/setChatMenuButton`;
    
    try {
      await axios.post(url, {
        menu_button: {
          type: 'web_app',
          text: '🛒 Boutique',
          web_app: { url: CONFIG.WEBAPP_URL }
        }
      });
      console.log('✅ Bouton menu configuré');
    } catch (error) {
      console.error('❌ Erreur bouton menu:', error.message);
    }
  }

  static async getWebhookInfo() {
    const url = `https://api.telegram.org/bot${CONFIG.BOT_TOKEN}/getWebhookInfo`;
    const response = await axios.get(url);
    return response.data;
  }
}

// ============================================================
// SERVER API HELPERS (appels vers le serveur principal)
// ============================================================
class ServerAPI {
  static get baseUrl() {
    return CONFIG.WEBAPP_URL;
  }

  static async getCustomerOrders(telegramId) {
    try {
      const response = await axios.get(`${this.baseUrl}/api/customer/orders`, {
        params: { telegram_id: telegramId },
        timeout: 5000
      });
      return response.data;
    } catch (error) {
      console.error('❌ Error fetching orders:', error.message);
      return null;
    }
  }

  static async getProducts() {
    try {
      const response = await axios.get(`${this.baseUrl}/api/products`, { timeout: 5000 });
      return response.data;
    } catch (error) {
      console.error('❌ Error fetching products:', error.message);
      return null;
    }
  }

  static async getReferralStats(customer) {
    try {
      const response = await axios.get(`${this.baseUrl}/api/referral-stats`, {
        params: { customer },
        timeout: 5000
      });
      return response.data;
    } catch (error) {
      console.error('❌ Error fetching referral stats:', error.message);
      return null;
    }
  }

  static async getCreditBalance(customer) {
    try {
      const response = await axios.get(`${this.baseUrl}/api/credit-balance`, {
        params: { customer },
        timeout: 5000
      });
      return response.data;
    } catch (error) {
      console.error('❌ Error fetching credit balance:', error.message);
      return null;
    }
  }
}

// ============================================================
// KEYBOARDS (CLAVIERS)
// ============================================================
const Keyboards = {
  // Clavier de réponse persistant (toujours visible)
  replyKeyboard: {
    keyboard: [
      [
        { text: '🏠 Menu Principal' },
        { text: '🛍️ Boutique' }
      ],
      [
        { text: '📦 Mes Commandes' },
        { text: '📊 Suivi Commande' }
      ],
      [
        { text: '🎁 Fidélité' },
        { text: '🤝 Parrainage' }
      ],
      [
        { text: '📋 Catalogue' },
        { text: '📖 Tuto' }
      ],
      [
        { text: '🕐 Horaires' },
        { text: '❓ Aide' }
      ],
      [
        { text: '💬 Support' }
      ]
    ],
    resize_keyboard: true,
    persistent: true
  },

  welcome: {
    inline_keyboard: [
      [
        {
          text: '🛍️ Accéder à la Boutique',
          web_app: { url: CONFIG.WEBAPP_URL }
        }
      ],
      [
        {
          text: '📋 Catalogue',
          callback_data: 'show_catalogue'
        },
        {
          text: '📊 Suivi',
          callback_data: 'show_orders'
        }
      ],
      [
        {
          text: '🎁 Fidélité',
          callback_data: 'show_fidelite'
        },
        {
          text: '🤝 Parrainage',
          callback_data: 'show_parrainage'
        }
      ],
      [
        {
          text: '📢 Canal Principal',
          url: 'https://t.me/+jQmeiR0Cd3I2YjFk'
        },
        {
          text: '📸 Canal Photo',
          url: 'https://t.me/+MeIiGFxcXDA5MjFk'
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
  },

  shop: {
    inline_keyboard: [
      [
        {
          text: '🛒 Ouvrir la Boutique',
          web_app: { url: CONFIG.WEBAPP_URL }
        }
      ],
      [
        {
          text: '🏠 Menu Principal',
          callback_data: 'start'
        }
      ]
    ]
  },

  admin: {
    inline_keyboard: [
      [
        {
          text: '🔐 Ouvrir le Panneau Admin',
          web_app: { url: `${CONFIG.WEBAPP_URL}/admin.html` }
        }
      ],
      [
        {
          text: '🏠 Menu Principal',
          callback_data: 'start'
        }
      ]
    ]
  },

  help: {
    inline_keyboard: [
      [
        {
          text: '💬 Contacter le Support',
          url: `https://t.me/${CONFIG.SUPPORT_USERNAME.replace('@', '')}`
        }
      ],
      [
        {
          text: '🛒 Boutique',
          callback_data: 'open_shop'
        },
        {
          text: '🔐 Admin',
          callback_data: 'open_admin'
        }
      ],
      [
        {
          text: '🏠 Menu Principal',
          callback_data: 'start'
        }
      ]
    ]
  },

  support: {
    inline_keyboard: [
      [
        {
          text: '💬 Support Telegram',
          url: `https://t.me/${CONFIG.SUPPORT_USERNAME.replace('@', '')}`
        }
      ],
      [
        {
          text: '📸 Snapchat',
          url: 'https://www.snapchat.com/add/cocoland-12'
        }
      ],
      [
        {
          text: '🆘 Snap Secours',
          url: 'https://www.snapchat.com/add/droguacenter12?share_id=GiyUiJLIwEU&locale'
        }
      ],
      [
        {
          text: '🛒 Boutique',
          callback_data: 'open_shop'
        },
        {
          text: 'ℹ️ Infos',
          callback_data: 'show_info'
        }
      ],
      [
        {
          text: '🏠 Menu Principal',
          callback_data: 'start'
        }
      ]
    ]
  },

  info: {
    inline_keyboard: [
      [
        {
          text: '🛒 Commander Maintenant',
          web_app: { url: CONFIG.WEBAPP_URL }
        }
      ],
      [
        {
          text: '💬 Support',
          callback_data: 'contact_support'
        },
        {
          text: '❓ Aide',
          callback_data: 'show_help'
        }
      ],
      [
        {
          text: '🏠 Menu Principal',
          callback_data: 'start'
        }
      ]
    ]
  },

  orders: {
    inline_keyboard: [
      [
        {
          text: '📱 Voir Mes Commandes',
          web_app: { url: `${CONFIG.WEBAPP_URL}#orders` }
        }
      ],
      [
        {
          text: '🛒 Nouvelle Commande',
          web_app: { url: CONFIG.WEBAPP_URL }
        }
      ],
      [
        {
          text: '💬 Support',
          callback_data: 'contact_support'
        },
        {
          text: '🏠 Menu',
          callback_data: 'start'
        }
      ]
    ]
  },

  status: {
    inline_keyboard: [
      [
        {
          text: '📱 Voir Toutes Mes Commandes',
          web_app: { url: `${CONFIG.WEBAPP_URL}#orders` }
        }
      ],
      [
        {
          text: '💬 Support',
          callback_data: 'contact_support'
        },
        {
          text: '🏠 Menu',
          callback_data: 'start'
        }
      ]
    ]
  },

  parrainage: {
    inline_keyboard: [
      [
        {
          text: '🛍️ Inviter via la Boutique',
          web_app: { url: CONFIG.WEBAPP_URL }
        }
      ],
      [
        {
          text: '📊 Classement Parrains',
          callback_data: 'show_leaderboard'
        }
      ],
      [
        {
          text: '🏠 Menu Principal',
          callback_data: 'start'
        }
      ]
    ]
  },

  fidelite: {
    inline_keyboard: [
      [
        {
          text: '🛒 Commander Maintenant',
          web_app: { url: CONFIG.WEBAPP_URL }
        }
      ],
      [
        {
          text: '🤝 Parrainage',
          callback_data: 'show_parrainage'
        },
        {
          text: '🏠 Menu',
          callback_data: 'start'
        }
      ]
    ]
  },

  horaires: {
    inline_keyboard: [
      [
        {
          text: '🛒 Commander Maintenant',
          web_app: { url: CONFIG.WEBAPP_URL }
        }
      ],
      [
        {
          text: '💬 Support',
          callback_data: 'contact_support'
        },
        {
          text: '🏠 Menu',
          callback_data: 'start'
        }
      ]
    ]
  },

  catalogue: {
    inline_keyboard: [
      [
        {
          text: '🛍️ Voir Tout le Catalogue',
          web_app: { url: CONFIG.WEBAPP_URL }
        }
      ],
      [
        {
          text: '🏠 Menu Principal',
          callback_data: 'start'
        }
      ]
    ]
  },

  tuto: {
    inline_keyboard: [
      [
        {
          text: '➡️ Étape 2 : Choisir les Produits',
          callback_data: 'tuto_step2'
        }
      ],
      [
        {
          text: '🛍️ Commander Maintenant',
          web_app: { url: CONFIG.WEBAPP_URL }
        }
      ],
      [
        {
          text: '💬 Besoin d\'aide ?',
          callback_data: 'contact_support'
        },
        {
          text: '🏠 Menu',
          callback_data: 'start'
        }
      ]
    ]
  },

  tutoStep2: {
    inline_keyboard: [
      [
        {
          text: '➡️ Étape 3 : Panier & Paiement',
          callback_data: 'tuto_step3'
        }
      ],
      [
        {
          text: '⬅️ Retour Étape 1',
          callback_data: 'tuto_step1'
        },
        {
          text: '🏠 Menu',
          callback_data: 'start'
        }
      ]
    ]
  },

  tutoStep3: {
    inline_keyboard: [
      [
        {
          text: '➡️ Étape 4 : Livraison & Suivi',
          callback_data: 'tuto_step4'
        }
      ],
      [
        {
          text: '⬅️ Retour Étape 2',
          callback_data: 'tuto_step2'
        },
        {
          text: '🏠 Menu',
          callback_data: 'start'
        }
      ]
    ]
  },

  tutoStep4: {
    inline_keyboard: [
      [
        {
          text: '🛍️ Commander Maintenant',
          web_app: { url: CONFIG.WEBAPP_URL }
        }
      ],
      [
        {
          text: '⬅️ Retour Étape 3',
          callback_data: 'tuto_step3'
        },
        {
          text: '🏠 Menu',
          callback_data: 'start'
        }
      ]
    ]
  }
};

// ============================================================
// MESSAGES
// ============================================================
const Messages = {
  welcome: (firstName) => `🌟 <b>Bienvenue ${firstName} chez DROGUA CENTER !</b> 🌟

Votre boutique premium accessible directement depuis Telegram.

<b>🛍️ Que souhaitez-vous faire ?</b>

• <b>Boutique</b> - Parcourir et commander
• <b>Catalogue</b> - Voir nos produits
• <b>Suivi</b> - Suivre vos commandes
• <b>Fidélité</b> - Vos récompenses
• <b>Parrainage</b> - Inviter des amis
• <b>Support</b> - Aide et assistance

✨ <i>Programme de fidélité & parrainage actifs !</i>`,

  shop: `🛍️ <b>BOUTIQUE DROGUA CENTER</b>

Cliquez sur le bouton ci-dessous pour accéder à notre catalogue complet et passer commande.

💎 Livraison rapide et discrète
🔒 Paiement sécurisé
📦 Suivi de commande en temps réel
🎁 Programme de fidélité actif`,

  admin: `🔐 <b>PANNEAU ADMINISTRATEUR</b>

Accédez au tableau de bord pour gérer :

📊 Statistiques et ventes
📦 Commandes en cours
📋 Gestion du stock
💰 Finances et transactions
⚙️ Paramètres de la boutique

<i>⚠️ Authentification requise</i>`,

  help: `❓ <b>AIDE & SUPPORT</b>

<b>📍 Livraison :</b>
• ${CONFIG.DELIVERY_INFO.free}
• ${CONFIG.DELIVERY_INFO.paid}

<b>💰 Paiement :</b>
• Espèces à la livraison uniquement

<b>🎁 Programme fidélité :</b>
• Remise automatique tous les 10 achats
• 10€ de remise tous les 10 achats

<b>📞 Contact support :</b>
${CONFIG.SUPPORT_USERNAME}

<b>⏰ Horaires d'ouverture :</b>
${CONFIG.BUSINESS_HOURS}
Livraison rapide pendant les heures d'ouverture

<b>📱 Commandes disponibles :</b>
/start - Menu principal
/shop - Ouvrir la boutique
/tuto - Comment commander
/orders - Mes commandes
/status - Suivi de commande
/catalogue - Voir les produits
/fidelite - Programme de fidélité
/parrainage - Programme de parrainage
/horaires - Horaires d'ouverture
/admin - Panneau admin
/help - Cette aide`,

  support: `💬 <b>SUPPORT CLIENT</b>

Pour toute question ou assistance :

<b>📱 Telegram :</b> ${CONFIG.SUPPORT_USERNAME}
<b>📸 Snapchat :</b> https://www.snapchat.com/add/cocoland-12
<b>🆘 Snap Secours :</b> https://www.snapchat.com/add/droguacenter12?share_id=GiyUiJLIwEU&locale

Notre équipe est disponible <b>7j/7</b> pour vous aider !

<i>Réponse sous 24h maximum</i>`,

  info: `ℹ️ <b>À PROPOS DE DROGUA CENTER</b>

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
${CONFIG.BUSINESS_HOURS}

Merci de votre confiance ! 💚`,

  orders: `📦 <b>MES COMMANDES</b>

Consultez l'historique de vos commandes et suivez leur statut en temps réel.

<b>🔍 Vous pourrez voir :</b>
• Toutes vos commandes passées
• Le statut de chaque commande
• Les détails et montants
• Possibilité d'annulation (sous 30 min)

<b>📱 Programme de fidélité :</b>
Suivez votre progression vers votre prochaine remise !
🎁 Une remise tous les 10 achats

Cliquez sur le bouton ci-dessous pour accéder à vos commandes.`,

  horaires: `🕐 <b>HORAIRES D'OUVERTURE</b>

<b>📅 Jours :</b> 7 jours sur 7
<b>⏰ Heures :</b> ${CONFIG.BUSINESS_HOURS}

<b>📍 Livraison :</b>
• ${CONFIG.DELIVERY_INFO.free}
• ${CONFIG.DELIVERY_INFO.paid}

<b>⚡ Délai de livraison :</b>
Livraison rapide pendant les heures d'ouverture

<b>📞 En dehors des horaires ?</b>
Passez commande en ligne, elle sera traitée dès l'ouverture !`,

  parrainage: `🤝 <b>PROGRAMME DE PARRAINAGE</b>

Parrainez vos amis et gagnez du crédit !

<b>🎯 Comment ça marche :</b>
1. Partagez votre code de parrainage
2. Vos amis passent commande avec votre code
3. Au bout de <b>5 parrainages</b>, vous gagnez <b>10€</b> de crédit !

<b>💡 Le filleul ne gagne rien</b>, sauf s'il parraine à son tour.

<b>🔄 Cumulable :</b> 10 parrainages = 20€, 15 = 30€, etc.

<i>Partagez votre code pour commencer à gagner !</i>`,

  fidelite: `🎁 <b>PROGRAMME DE FIDÉLITÉ</b>

Gagnez des réductions automatiques en commandant !

<b>📊 Le principe :</b>
• Remise automatique tous les <b>10 achats</b>
• <b>10€</b> de remise à chaque <b>10ème achat</b>
• Calcul automatique, rien à faire !

<b>🔄 Comment ça fonctionne :</b>
1. Passez vos commandes normalement
2. Au 10ème achat, remise appliquée
3. Le compteur recommence à zéro

<b>💡 Astuce :</b>
Combinez fidélité + parrainage pour maximiser vos économies !`,

  catalogue: (products) => {
    if (!products || products.length === 0) {
      return `📋 <b>CATALOGUE</b>\n\nLe catalogue est en cours de chargement. Accédez à la boutique pour voir tous les produits.`;
    }

    // Regrouper par catégorie
    const categories = {};
    for (const p of products) {
      const cat = p.category || 'Autre';
      if (!categories[cat]) categories[cat] = [];
      categories[cat].push(p);
    }

    let text = `📋 <b>CATALOGUE DROGUA CENTER</b>\n\n`;

    for (const [category, items] of Object.entries(categories)) {
      text += `<b>📂 ${category}</b>\n`;
      for (const item of items) {
        const variantCount = item.variants ? Object.keys(item.variants).length : 0;
        const prices = item.variants
          ? Object.values(item.variants).map(v => v.price).filter(Boolean)
          : [];
        const minPrice = prices.length > 0 ? Math.min(...prices) : 0;
        const maxPrice = prices.length > 0 ? Math.max(...prices) : 0;

        let priceStr = '';
        if (minPrice > 0 && maxPrice > 0) {
          priceStr = minPrice === maxPrice
            ? ` - ${minPrice}€`
            : ` - ${minPrice}€ à ${maxPrice}€`;
        }

        text += `  • ${item.name}${priceStr}\n`;
      }
      text += '\n';
    }

    text += `<i>Cliquez ci-dessous pour voir le catalogue complet avec photos et vidéos.</i>`;
    return text;
  },

  statusNoOrders: `📊 <b>SUIVI DE COMMANDE</b>

Aucune commande trouvée pour votre compte.

<b>💡 Pour passer une commande :</b>
Cliquez sur "Boutique" et complétez le formulaire.

<i>Si vous pensez que c'est une erreur, contactez le support.</i>`,

  statusOrders: (orders) => {
    const statusEmojis = {
      'pending': '⏳',
      'approved': '✅',
      'delivered': '🚀',
      'cancelled': '❌'
    };
    const statusLabels = {
      'pending': 'En attente',
      'approved': 'Approuvée',
      'delivered': 'Livrée',
      'cancelled': 'Annulée'
    };

    let text = `📊 <b>SUIVI DE VOS COMMANDES</b>\n\n`;
    text += `<b>Total :</b> ${orders.length} commande(s)\n\n`;

    // Afficher les 5 dernières commandes
    const recentOrders = orders.slice(0, 5);
    for (const order of recentOrders) {
      const emoji = statusEmojis[order.status] || '❓';
      const label = statusLabels[order.status] || order.status;
      const date = new Date(order.created_at).toLocaleDateString('fr-FR', {
        day: '2-digit', month: '2-digit', year: 'numeric'
      });
      const items = Array.isArray(order.items) ? order.items : [];
      const itemCount = items.reduce((sum, i) => sum + (i.quantity || 1), 0);

      text += `${emoji} <b>Commande #${order.id}</b>\n`;
      text += `   Statut : ${label}\n`;
      text += `   Date : ${date}\n`;
      text += `   Articles : ${itemCount} | Total : ${order.total}€\n`;
      if (order.discount > 0) {
        text += `   Remise : -${order.discount}€\n`;
      }
      text += '\n';
    }

    if (orders.length > 5) {
      text += `<i>... et ${orders.length - 5} autre(s) commande(s)</i>\n\n`;
    }

    text += `<i>Cliquez ci-dessous pour plus de détails.</i>`;
    return text;
  },

  tuto: `📖 <b>TUTORIEL : COMMENT COMMANDER</b>

Suivez ces 4 étapes simples pour passer votre première commande !

━━━━━━━━━━━━━━━━━━━━━━

<b>📌 ÉTAPE 1 : Ouvrir la Boutique</b>

1️⃣ Cliquez sur le bouton <b>"🛍️ Commander Maintenant"</b> ci-dessous
   <i>(ou tapez /shop ou appuyez sur "Boutique" au clavier)</i>

2️⃣ La boutique s'ouvre directement dans Telegram

3️⃣ Parcourez les catégories :
   • 🌿 Weed
   • 🟤 Résines
   • ⬜ Blanche
   • 💊 Keta
   • 🧊 Frozen
   • Et plus encore...

<i>➡️ Continuez avec les étapes suivantes en cliquant sur les boutons.</i>`,

  tutoStep2: `📖 <b>ÉTAPE 2 : Choisir vos Produits</b>

━━━━━━━━━━━━━━━━━━━━━━

4️⃣ <b>Sélectionnez un produit</b> qui vous intéresse
   Vous verrez sa photo, vidéo et description

5️⃣ <b>Choisissez la variante</b> (grammage/quantité)
   Exemple : 1g, 2g, 5g, 10g...

6️⃣ <b>Ajustez la quantité</b> avec les boutons + et -
   <i>(jusqu'à 99 unités par article)</i>

7️⃣ Appuyez sur <b>"Ajouter au panier"</b> 🛒

8️⃣ Continuez vos achats ou passez au panier

<b>💡 Astuce :</b> Ajoutez des produits en favoris avec le ❤️ pour les retrouver facilement !`,

  tutoStep3: `📖 <b>ÉTAPE 3 : Panier & Paiement</b>

━━━━━━━━━━━━━━━━━━━━━━

9️⃣ Ouvrez votre <b>panier</b> 🛒 en haut de la page

🔟 Vérifiez vos articles et quantités
   Vous pouvez modifier ou supprimer des articles

1️⃣1️⃣ Remplissez le <b>formulaire de commande</b> :
   • 📱 <b>Numéro de téléphone</b> (pour vous contacter)
   • 📍 <b>Adresse de livraison</b> (numéro + rue)
   • 🚚 <b>Zone de livraison</b> :
     - Millau = Livraison <b>GRATUITE</b>
     - Extérieur = +20€ de frais

1️⃣2️⃣ Si vous avez un <b>code de parrainage</b>, entrez-le pour une remise !

<b>💰 Mode de paiement :</b>
• Espèces à la livraison uniquement`,

  tutoStep4: `📖 <b>ÉTAPE 4 : Livraison & Suivi</b>

━━━━━━━━━━━━━━━━━━━━━━

1️⃣3️⃣ Validez votre commande ✅

1️⃣4️⃣ Vous recevrez une <b>confirmation</b> automatique

1️⃣5️⃣ Suivez votre commande avec /status :
   • ⏳ <b>En attente</b> - Commande reçue
   • ✅ <b>Approuvée</b> - En préparation
   • 🚀 <b>Livrée</b> - En route !

1️⃣6️⃣ Le livreur vous contactera par Telegram

<b>⏰ Horaires de livraison :</b>
${CONFIG.BUSINESS_HOURS}

<b>❌ Annulation :</b>
Vous pouvez annuler sous 30 minutes via /orders

━━━━━━━━━━━━━━━━━━━━━━

<b>🎁 Bonus :</b>
• Programme fidélité : remise tous les 10 achats (/fidelite)
• Parrainage : invitez vos amis et gagnez des crédits (/parrainage)

<b>Prêt à commander ? Cliquez ci-dessous !</b>`,

  unknownCommand: `❓ <b>Commande non reconnue</b>

Voici les commandes disponibles :

/start - Menu principal
/shop - Ouvrir la boutique
/tuto - Comment commander
/orders - Mes commandes
/status - Suivi de commandes
/catalogue - Voir les produits
/fidelite - Programme de fidélité
/parrainage - Programme de parrainage
/horaires - Horaires d'ouverture
/help - Aide et support

Ou utilisez les boutons du clavier ci-dessous.`
};

// ============================================================
// STATE MANAGEMENT (pour le clavier)
// ============================================================
// Stockage temporaire des utilisateurs qui ont le clavier activé
const keyboardState = new Set();

// ============================================================
// HANDLERS (GESTIONNAIRES)
// ============================================================
const MessageHandlers = {
  '/start': async (chatId, firstName) => {
    try {
      // Toujours activer le clavier au /start
      await TelegramAPI.sendMessage(
        chatId,
        Messages.welcome(firstName),
        Keyboards.welcome
      );
      
      // Si c'est la première fois, envoyer aussi le clavier persistant
      if (!keyboardState.has(chatId)) {
        await TelegramAPI.sendMessage(
          chatId,
          '⌨️ <i>Clavier de navigation activé ci-dessous</i>',
          Keyboards.replyKeyboard
        );
        keyboardState.add(chatId);
      }
      
      console.log(`✅ Welcome message sent to ${chatId}`);
    } catch (error) {
      console.error(`❌ Error in /start handler:`, error);
    }
  },

  '🏠 Menu Principal': async (chatId, firstName) => {
    await MessageHandlers['/start'](chatId, firstName);
  },

  '/shop': async (chatId) => {
    try {
      await TelegramAPI.sendMessage(chatId, Messages.shop, Keyboards.shop);
      console.log(`✅ Shop message sent to ${chatId}`);
    } catch (error) {
      console.error(`❌ Error in /shop handler:`, error);
    }
  },

  '/boutique': async (chatId) => {
    await MessageHandlers['/shop'](chatId);
  },

  '🛍️ Boutique': async (chatId) => {
    await MessageHandlers['/shop'](chatId);
  },

  '/tuto': async (chatId) => {
    try {
      await TelegramAPI.sendMessage(chatId, Messages.tuto, Keyboards.tuto);
      console.log(`✅ Tuto message sent to ${chatId}`);
    } catch (error) {
      console.error(`❌ Error in /tuto handler:`, error);
    }
  },

  '/tutoriel': async (chatId) => {
    await MessageHandlers['/tuto'](chatId);
  },

  '📖 Tuto': async (chatId) => {
    await MessageHandlers['/tuto'](chatId);
  },

  '/admin': async (chatId) => {
    try {
      await TelegramAPI.sendMessage(chatId, Messages.admin, Keyboards.admin);
      console.log(`✅ Admin message sent to ${chatId}`);
    } catch (error) {
      console.error(`❌ Error in /admin handler:`, error);
    }
  },

  '🔐 Admin': async (chatId) => {
    await MessageHandlers['/admin'](chatId);
  },

  '/help': async (chatId) => {
    try {
      await TelegramAPI.sendMessage(chatId, Messages.help, Keyboards.help);
      console.log(`✅ Help message sent to ${chatId}`);
    } catch (error) {
      console.error(`❌ Error in /help handler:`, error);
    }
  },

  '/aide': async (chatId) => {
    await MessageHandlers['/help'](chatId);
  },

  '❓ Aide': async (chatId) => {
    await MessageHandlers['/help'](chatId);
  },

  '💬 Support': async (chatId) => {
    try {
      await TelegramAPI.sendMessage(chatId, Messages.support, Keyboards.support);
      console.log(`✅ Support message sent to ${chatId}`);
    } catch (error) {
      console.error(`❌ Error in support handler:`, error);
    }
  },

  '/orders': async (chatId) => {
    try {
      await TelegramAPI.sendMessage(chatId, Messages.orders, Keyboards.orders);
      console.log(`✅ Orders message sent to ${chatId}`);
    } catch (error) {
      console.error(`❌ Error in /orders handler:`, error);
    }
  },

  '📦 Mes Commandes': async (chatId) => {
    await MessageHandlers['/orders'](chatId);
  },

  '/status': async (chatId, firstName, telegramId) => {
    try {
      const data = await ServerAPI.getCustomerOrders(telegramId);

      if (!data || !data.ok || !data.orders || data.orders.length === 0) {
        await TelegramAPI.sendMessage(chatId, Messages.statusNoOrders, Keyboards.status);
      } else {
        await TelegramAPI.sendMessage(
          chatId,
          Messages.statusOrders(data.orders),
          Keyboards.status
        );
      }
      console.log(`✅ Status message sent to ${chatId}`);
    } catch (error) {
      console.error(`❌ Error in /status handler:`, error);
      await TelegramAPI.sendMessage(chatId, Messages.statusNoOrders, Keyboards.status);
    }
  },

  '📊 Suivi Commande': async (chatId, firstName, telegramId) => {
    await MessageHandlers['/status'](chatId, firstName, telegramId);
  },

  '/parrainage': async (chatId, firstName, telegramId) => {
    try {
      const data = await ServerAPI.getReferralStats(telegramId);

      let text = Messages.parrainage;
      if (data && data.ok && data.exists) {
        text += `\n\n━━━━━━━━━━━━━━━━━━━━━━`;
        text += `\n\n<b>📊 Vos stats de parrainage :</b>`;
        text += `\n• Code : <code>${data.code}</code>`;
        text += `\n• Parrainages : ${data.totalReferrals || 0}`;
        text += `\n• Crédits gagnés : ${data.totalEarned || 0}€`;
        text += `\n• Solde actuel : ${data.creditBalance || 0}€`;

        const refs = data.totalReferrals || 0;
        const remaining = 5 - (refs % 5);
        const progressText = remaining === 5 && refs > 0
          ? 'Bonus débloqué !'
          : `${refs % 5}/5 pour le prochain bonus`;
        text += `\n• Progression : ${progressText}`;
      }

      await TelegramAPI.sendMessage(chatId, text, Keyboards.parrainage);
      console.log(`✅ Parrainage message sent to ${chatId}`);
    } catch (error) {
      console.error(`❌ Error in /parrainage handler:`, error);
      await TelegramAPI.sendMessage(chatId, Messages.parrainage, Keyboards.parrainage);
    }
  },

  '🤝 Parrainage': async (chatId, firstName, telegramId) => {
    await MessageHandlers['/parrainage'](chatId, firstName, telegramId);
  },

  '/fidelite': async (chatId) => {
    try {
      await TelegramAPI.sendMessage(chatId, Messages.fidelite, Keyboards.fidelite);
      console.log(`✅ Fidelite message sent to ${chatId}`);
    } catch (error) {
      console.error(`❌ Error in /fidelite handler:`, error);
    }
  },

  '🎁 Fidélité': async (chatId) => {
    await MessageHandlers['/fidelite'](chatId);
  },

  '/horaires': async (chatId) => {
    try {
      await TelegramAPI.sendMessage(chatId, Messages.horaires, Keyboards.horaires);
      console.log(`✅ Horaires message sent to ${chatId}`);
    } catch (error) {
      console.error(`❌ Error in /horaires handler:`, error);
    }
  },

  '🕐 Horaires': async (chatId) => {
    await MessageHandlers['/horaires'](chatId);
  },

  '/catalogue': async (chatId) => {
    try {
      const data = await ServerAPI.getProducts();
      const products = (data && data.ok) ? data.products : [];
      const text = Messages.catalogue(products);
      await TelegramAPI.sendMessage(chatId, text, Keyboards.catalogue);
      console.log(`✅ Catalogue message sent to ${chatId}`);
    } catch (error) {
      console.error(`❌ Error in /catalogue handler:`, error);
      await TelegramAPI.sendMessage(chatId, Messages.catalogue([]), Keyboards.catalogue);
    }
  },

  '📋 Catalogue': async (chatId) => {
    await MessageHandlers['/catalogue'](chatId);
  },

  '/keyboard': async (chatId) => {
    try {
      // Toggle du clavier
      if (keyboardState.has(chatId)) {
        // Désactiver le clavier
        const hideKeyboardText = `❌ <b>CLAVIER MASQUÉ</b>

Le clavier rapide a été masqué.

Pour le réactiver, utilisez la commande /keyboard`;

        await TelegramAPI.sendMessage(
          chatId, 
          hideKeyboardText,
          { remove_keyboard: true }
        );
        keyboardState.delete(chatId);
        console.log(`✅ Keyboard disabled for ${chatId}`);
      } else {
        // Activer le clavier
        const keyboardText = `⌨️ <b>CLAVIER ACTIVÉ</b>

Votre clavier personnalisé est maintenant activé !

Utilisez les boutons ci-dessous pour naviguer rapidement :

🏠 <b>Menu Principal</b> - Retour à l'accueil
🛍️ <b>Boutique</b> - Accéder au catalogue
📦 <b>Mes Commandes</b> - Historique et suivi
📊 <b>Suivi Commande</b> - Statut en temps réel
🎁 <b>Fidélité</b> - Vos récompenses
🤝 <b>Parrainage</b> - Inviter des amis
📋 <b>Catalogue</b> - Voir les produits
📖 <b>Tuto</b> - Comment commander
🕐 <b>Horaires</b> - Heures d'ouverture
❓ <b>Aide</b> - Support et informations
💬 <b>Support</b> - Contacter l'équipe

<i>Pour masquer le clavier : /keyboard</i>`;

        await TelegramAPI.sendMessage(chatId, keyboardText, Keyboards.replyKeyboard);
        keyboardState.add(chatId);
        console.log(`✅ Keyboard enabled for ${chatId}`);
      }
    } catch (error) {
      console.error(`❌ Error in /keyboard handler:`, error);
    }
  }
};

const CallbackHandlers = {
  'start': async (chatId, messageId, firstName = 'Client') => {
    try {
      await TelegramAPI.editMessageText(
        chatId,
        messageId,
        Messages.welcome(firstName),
        Keyboards.welcome
      );
    } catch (error) {
      // Si l'édition échoue, envoyer un nouveau message
      await MessageHandlers['/start'](chatId, firstName);
    }
  },

  'open_shop': async (chatId, messageId) => {
    try {
      await TelegramAPI.editMessageText(
        chatId,
        messageId,
        Messages.shop,
        Keyboards.shop
      );
    } catch (error) {
      await MessageHandlers['/shop'](chatId);
    }
  },

  'open_admin': async (chatId, messageId) => {
    try {
      await TelegramAPI.editMessageText(
        chatId,
        messageId,
        Messages.admin,
        Keyboards.admin
      );
    } catch (error) {
      await MessageHandlers['/admin'](chatId);
    }
  },

  'contact_support': async (chatId, messageId) => {
    try {
      await TelegramAPI.editMessageText(
        chatId,
        messageId,
        Messages.support,
        Keyboards.support
      );
    } catch (error) {
      await TelegramAPI.sendMessage(chatId, Messages.support, Keyboards.support);
    }
  },

  'show_help': async (chatId, messageId) => {
    try {
      await TelegramAPI.editMessageText(
        chatId,
        messageId,
        Messages.help,
        Keyboards.help
      );
    } catch (error) {
      await MessageHandlers['/help'](chatId);
    }
  },

  'show_orders': async (chatId, messageId) => {
    try {
      await TelegramAPI.editMessageText(
        chatId,
        messageId,
        Messages.orders,
        Keyboards.orders
      );
    } catch (error) {
      await MessageHandlers['/orders'](chatId);
    }
  },

  'show_info': async (chatId, messageId) => {
    try {
      await TelegramAPI.editMessageText(
        chatId,
        messageId,
        Messages.info,
        Keyboards.info
      );
    } catch (error) {
      await TelegramAPI.sendMessage(chatId, Messages.info, Keyboards.info);
    }
  },

  'show_parrainage': async (chatId, messageId) => {
    try {
      await TelegramAPI.editMessageText(
        chatId,
        messageId,
        Messages.parrainage,
        Keyboards.parrainage
      );
    } catch (error) {
      await TelegramAPI.sendMessage(chatId, Messages.parrainage, Keyboards.parrainage);
    }
  },

  'show_fidelite': async (chatId, messageId) => {
    try {
      await TelegramAPI.editMessageText(
        chatId,
        messageId,
        Messages.fidelite,
        Keyboards.fidelite
      );
    } catch (error) {
      await TelegramAPI.sendMessage(chatId, Messages.fidelite, Keyboards.fidelite);
    }
  },

  'show_horaires': async (chatId, messageId) => {
    try {
      await TelegramAPI.editMessageText(
        chatId,
        messageId,
        Messages.horaires,
        Keyboards.horaires
      );
    } catch (error) {
      await TelegramAPI.sendMessage(chatId, Messages.horaires, Keyboards.horaires);
    }
  },

  'show_catalogue': async (chatId, messageId) => {
    try {
      const data = await ServerAPI.getProducts();
      const products = (data && data.ok) ? data.products : [];
      const text = Messages.catalogue(products);
      await TelegramAPI.editMessageText(chatId, messageId, text, Keyboards.catalogue);
    } catch (error) {
      await MessageHandlers['/catalogue'](chatId);
    }
  },

  'tuto_step1': async (chatId, messageId) => {
    try {
      await TelegramAPI.editMessageText(chatId, messageId, Messages.tuto, Keyboards.tuto);
    } catch (error) {
      await TelegramAPI.sendMessage(chatId, Messages.tuto, Keyboards.tuto);
    }
  },

  'tuto_step2': async (chatId, messageId) => {
    try {
      await TelegramAPI.editMessageText(chatId, messageId, Messages.tutoStep2, Keyboards.tutoStep2);
    } catch (error) {
      await TelegramAPI.sendMessage(chatId, Messages.tutoStep2, Keyboards.tutoStep2);
    }
  },

  'tuto_step3': async (chatId, messageId) => {
    try {
      await TelegramAPI.editMessageText(chatId, messageId, Messages.tutoStep3, Keyboards.tutoStep3);
    } catch (error) {
      await TelegramAPI.sendMessage(chatId, Messages.tutoStep3, Keyboards.tutoStep3);
    }
  },

  'tuto_step4': async (chatId, messageId) => {
    try {
      await TelegramAPI.editMessageText(chatId, messageId, Messages.tutoStep4, Keyboards.tutoStep4);
    } catch (error) {
      await TelegramAPI.sendMessage(chatId, Messages.tutoStep4, Keyboards.tutoStep4);
    }
  },

  'show_leaderboard': async (chatId, messageId) => {
    try {
      const response = await axios.get(`${CONFIG.WEBAPP_URL}/api/referral-leaderboard`, {
        params: { limit: 5 },
        timeout: 5000
      });

      let text = `🏆 <b>CLASSEMENT DES PARRAINS</b>\n\n`;

      if (response.data?.ok && response.data.leaderboard?.length > 0) {
        for (const user of response.data.leaderboard) {
          const medal = user.rank === 1 ? '🥇' : user.rank === 2 ? '🥈' : user.rank === 3 ? '🥉' : '🏅';
          text += `${medal} <b>#${user.rank}</b> ${user.contact}\n`;
          text += `   Parrainages : ${user.totalReferrals}\n\n`;
        }
      } else {
        text += `Aucun parrain pour le moment.\nSoyez le premier !`;
      }

      const keyboard = {
        inline_keyboard: [
          [{ text: '🤝 Mon Parrainage', callback_data: 'show_parrainage' }],
          [{ text: '🏠 Menu Principal', callback_data: 'start' }]
        ]
      };

      await TelegramAPI.editMessageText(chatId, messageId, text, keyboard);
    } catch (error) {
      console.error('❌ Error in leaderboard handler:', error.message);
      await TelegramAPI.sendMessage(chatId, '❌ Impossible de charger le classement. Réessayez plus tard.', {
        inline_keyboard: [[{ text: '🏠 Menu', callback_data: 'start' }]]
      });
    }
  }
};

// ============================================================
// WEBHOOK ENDPOINT
// ============================================================
app.post(`/bot${CONFIG.BOT_TOKEN}`, async (req, res) => {
  try {
    const { message, callback_query } = req.body;
    
    // Gestion des messages texte
    if (message?.text) {
      const chatId = message.chat.id;
      const text = message.text;
      const firstName = message.from.first_name || 'Client';
      const telegramId = String(message.from.id);

      const handler = MessageHandlers[text];
      if (handler) {
        await handler(chatId, firstName, telegramId);
      } else {
        // Auto-réponse pour les messages non reconnus
        console.log(`⚠️ Unhandled message: ${text} from ${chatId}`);
        await TelegramAPI.sendMessage(chatId, Messages.unknownCommand, Keyboards.help);
      }
    }
    
    // Gestion des callback queries (boutons)
    if (callback_query) {
      const chatId = callback_query.message.chat.id;
      const messageId = callback_query.message.message_id;
      const data = callback_query.data;
      const firstName = callback_query.from.first_name || 'Client';
      
      // Répondre immédiatement à la callback query
      await TelegramAPI.answerCallbackQuery(callback_query.id);
      
      const handler = CallbackHandlers[data];
      if (handler) {
        await handler(chatId, messageId, firstName);
      } else {
        console.log(`⚠️ Unhandled callback: ${data}`);
      }
    }
    
    res.sendStatus(200);
  } catch (error) {
    console.error('❌ Webhook error:', error);
    res.sendStatus(500);
  }
});

// ============================================================
// ROUTES UTILITAIRES
// ============================================================
app.get('/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    bot: 'Running',
    timestamp: new Date().toISOString(),
    webhook: `${CONFIG.WEBHOOK_DOMAIN}/bot${CONFIG.BOT_TOKEN}`,
    webapp: CONFIG.WEBAPP_URL
  });
});

app.get('/webhook-info', async (req, res) => {
  try {
    const info = await TelegramAPI.getWebhookInfo();
    res.json(info);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Route pour forcer la reconfiguration du webhook
app.post('/setup-webhook', async (req, res) => {
  try {
    const webhookUrl = `${CONFIG.WEBHOOK_DOMAIN}/bot${CONFIG.BOT_TOKEN}`;
    await TelegramAPI.setWebhook(webhookUrl);
    await TelegramAPI.setBotCommands();
    await TelegramAPI.setMenuButton();
    res.json({ success: true, webhook: webhookUrl });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Route pour activer le clavier persistant pour un utilisateur
app.post('/enable-keyboard/:chatId', async (req, res) => {
  try {
    const { chatId } = req.params;
    await TelegramAPI.sendMessage(
      chatId,
      '✅ <b>Clavier activé!</b>\n\nUtilisez les boutons ci-dessous pour naviguer rapidement.',
      Keyboards.replyKeyboard
    );
    res.json({ success: true, message: 'Keyboard enabled' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Route pour désactiver le clavier persistant
app.post('/disable-keyboard/:chatId', async (req, res) => {
  try {
    const { chatId } = req.params;
    await TelegramAPI.sendMessage(
      chatId,
      '❌ <b>Clavier désactivé!</b>',
      { remove_keyboard: true }
    );
    res.json({ success: true, message: 'Keyboard disabled' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Route 404
app.use((req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

// ============================================================
// DÉMARRAGE DU SERVEUR
// ============================================================
async function startBot() {
  try {
    console.log('🤖 ================================');
    console.log('   DÉMARRAGE DU BOT TELEGRAM');
    console.log('🤖 ================================');
    
    // Configuration du bot
    const webhookUrl = `${CONFIG.WEBHOOK_DOMAIN}/bot${CONFIG.BOT_TOKEN}`;
    await TelegramAPI.setWebhook(webhookUrl);
    await TelegramAPI.setBotCommands();
    await TelegramAPI.setMenuButton();
    
    // Démarrage du serveur Express
    app.listen(CONFIG.PORT, () => {
      console.log('✅ Configuration terminée');
      console.log(`📱 Port: ${CONFIG.PORT}`);
      console.log(`🌐 WebApp: ${CONFIG.WEBAPP_URL}`);
      console.log(`🔗 Webhook: ${webhookUrl}`);
      console.log(`💚 Health: http://localhost:${CONFIG.PORT}/health`);
      console.log('🤖 ================================');
      console.log('✅ Bot prêt à recevoir des messages');
      console.log('🤖 ================================');
    });
    
  } catch (error) {
    console.error('❌ Erreur fatale au démarrage:', error);
    process.exit(1);
  }
}

// Gestion des erreurs non capturées
process.on('unhandledRejection', (error) => {
  console.error('❌ Unhandled rejection:', error);
});

process.on('uncaughtException', (error) => {
  console.error('❌ Uncaught exception:', error);
  process.exit(1);
});

// Démarrage
startBot();
