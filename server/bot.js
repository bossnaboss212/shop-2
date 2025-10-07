const express = require('express');
const axios = require('axios');

// ============================================================
// CONFIGURATION
// ============================================================
const CONFIG = {
  BOT_TOKEN: process.env.TELEGRAM_TOKEN,
  WEBAPP_URL: process.env.WEBAPP_URL || 'https://shop-2-production.up.railway.app',
  WEBHOOK_DOMAIN: process.env.RAILWAY_PUBLIC_DOMAIN || 'https://shop-2-production.up.railway.app',
  PORT: process.env.BOT_PORT || 3001,
  SUPPORT_USERNAME: '@assistancenter',
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
  static async sendMessage(chatId, text, keyboard = null) {
    const url = `https://api.telegram.org/bot${CONFIG.BOT_TOKEN}/sendMessage`;
    
    const data = {
      chat_id: chatId,
      text: text,
      parse_mode: 'HTML'
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
      { command: 'admin', description: '🔐 Panneau admin' },
      { command: 'help', description: '❓ Aide et support' }
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
          text: '◀️ Retour au Menu',
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
          text: '◀️ Retour au Menu',
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
          url: 'https://snapchat.com/t/l9gurvAj'
        }
      ],
      [
        {
          text: '◀️ Retour',
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
          text: '◀️ Retour',
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
/admin - Panneau admin
/help - Cette aide`,

  support: `💬 <b>SUPPORT CLIENT</b>

Pour toute question ou assistance :

<b>📱 Telegram :</b> ${CONFIG.SUPPORT_USERNAME}
<b>📸 Snapchat :</b> https://snapchat.com/t/l9gurvAj
<b>🆘 Snap Secours :</b> https://snapchat.com/t/jR2yW7xa

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

Merci de votre confiance ! 💚`
};

// ============================================================
// HANDLERS (GESTIONNAIRES)
// ============================================================
const MessageHandlers = {
  '/start': async (chatId, firstName) => {
    try {
      await TelegramAPI.sendMessage(
        chatId,
        Messages.welcome(firstName),
        Keyboards.welcome
      );
      console.log(`✅ Welcome message sent to ${chatId}`);
    } catch (error) {
      console.error(`❌ Error in /start handler:`, error);
    }
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

  '/admin': async (chatId) => {
    try {
      await TelegramAPI.sendMessage(chatId, Messages.admin, Keyboards.admin);
      console.log(`✅ Admin message sent to ${chatId}`);
    } catch (error) {
      console.error(`❌ Error in /admin handler:`, error);
    }
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
