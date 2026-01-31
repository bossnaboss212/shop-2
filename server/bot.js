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
      { command: 'orders', description: '📦 Mes commandes' },
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
        { text: '🔐 Admin' }
      ],
      [
        { text: '❓ Aide' },
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
          text: '🔐 Panneau Admin',
          web_app: { url: `${CONFIG.WEBAPP_URL}/admin.html` }
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
• <b>Admin</b> - Gérer votre boutique
• <b>Support</b> - Aide et assistance

✨ <i>Programme de fidélité actif !</i>
Bénéficiez d'une remise tous les 10 achats.`,

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
• Espèces à la livraison
• Virement bancaire
• Crypto-monnaies

<b>🎁 Programme fidélité :</b>
• Remise automatique tous les 10 achats
• Jusqu'à 10% ou 20€ de réduction

<b>📞 Contact support :</b>
${CONFIG.SUPPORT_USERNAME}

<b>⏰ Horaires d'ouverture :</b>
${CONFIG.BUSINESS_HOURS}
Livraison rapide pendant les heures d'ouverture

<b>📱 Commandes disponibles :</b>
/start - Menu principal
/shop - Ouvrir la boutique
/orders - Mes commandes
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

Cliquez sur le bouton ci-dessous pour accéder à vos commandes.`
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
🔐 <b>Admin</b> - Panneau administrateur
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
      
      const handler = MessageHandlers[text];
      if (handler) {
        await handler(chatId, firstName);
      } else {
        // Message non reconnu - on pourrait envoyer un message d'aide
        console.log(`⚠️ Unhandled message: ${text} from ${chatId}`);
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
