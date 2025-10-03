const express = require('express');
const axios = require('axios');

// Configuration
const BOT_TOKEN = process.env.TELEGRAM_TOKEN || '7364804422:AAGsiuQhHUVUxb1BfXsb28lKWcot8gxHD30';
const WEBAPP_URL = process.env.WEBAPP_URL || 'https://shop-2-production.up.railway.app';
const WEBHOOK_DOMAIN = process.env.RAILWAY_PUBLIC_DOMAIN || 'https://shop-2-production.up.railway.app';
const PORT = process.env.BOT_PORT || 3001;

const app = express();
app.use(express.json());

// Webhook endpoint pour recevoir les updates Telegram
app.post(`/bot${BOT_TOKEN}`, async (req, res) => {
  try {
    const { message, callback_query } = req.body;
    
    // Gestion des messages
    if (message) {
      const chatId = message.chat.id;
      const text = message.text;
      const firstName = message.from.first_name || 'Client';
      
      // Commande /start
      if (text === '/start') {
        await sendWelcomeMessage(chatId, firstName);
      }
      // Commande /shop
      else if (text === '/shop' || text === '/boutique') {
        await sendShopMessage(chatId);
      }
      // Commande /help
      else if (text === '/help' || text === '/aide') {
        await sendHelpMessage(chatId);
      }
      // Commande /admin
      else if (text === '/admin') {
        await sendAdminMessage(chatId);
      }
    }
    
    // Gestion des callback queries (boutons)
    if (callback_query) {
      const chatId = callback_query.message.chat.id;
      const data = callback_query.data;
      
      // Répondre à la callback query
      await answerCallbackQuery(callback_query.id);
      
      if (data === 'open_shop') {
        await sendShopMessage(chatId);
      } else if (data === 'open_admin') {
        await sendAdminMessage(chatId);
      } else if (data === 'contact_support') {
        await sendSupportMessage(chatId);
      } else if (data === 'show_info') {
        await sendInfoMessage(chatId);
      }
    }
    
    res.sendStatus(200);
  } catch (error) {
    console.error('Error:', error);
    res.sendStatus(500);
  }
});

// Fonction pour envoyer le message de bienvenue avec bannière
async function sendWelcomeMessage(chatId, firstName) {
  const welcomeText = `🌟 <b>Bienvenue ${firstName} chez DROGUA CENTER !</b> 🌟

Votre boutique premium accessible directement depuis Telegram.

<b>🛍️ Que souhaitez-vous faire ?</b>

• <b>Boutique</b> - Parcourir et commander
• <b>Admin</b> - Gérer votre boutique
• <b>Support</b> - Aide et assistance

✨ <i>Programme de fidélité actif !</i>
Bénéficiez d'une remise tous les 10 achats.`;

  const keyboard = {
    inline_keyboard: [
      [
        {
          text: '🛍️ Accéder à la Boutique',
          web_app: { url: WEBAPP_URL }
        }
      ],
      [
        {
          text: '🔐 Panneau Admin',
          web_app: { url: `${WEBAPP_URL}/admin.html` }
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
  };

  // Essayer d'envoyer avec une photo (bannière)
  try {
    // Si vous avez une URL d'image de bannière, décommentez cette ligne :
    // await sendPhoto(chatId, 'https://votre-url-image.com/banner.jpg', welcomeText, keyboard);
    
    // Sinon, envoyer juste le texte avec les boutons
    await sendMessage(chatId, welcomeText, keyboard);
  } catch (error) {
    // Fallback : envoyer sans image
    await sendMessage(chatId, welcomeText, keyboard);
  }
}

// Fonction pour envoyer le message boutique
async function sendShopMessage(chatId) {
  const shopText = `🛍️ <b>BOUTIQUE DROGUA CENTER</b>

Cliquez sur le bouton ci-dessous pour accéder à notre catalogue complet et passer commande.

💎 Livraison rapide et discrète
🔒 Paiement sécurisé
📦 Suivi de commande en temps réel
🎁 Programme de fidélité actif`;

  const keyboard = {
    inline_keyboard: [
      [
        {
          text: '🛒 Ouvrir la Boutique',
          web_app: { url: WEBAPP_URL }
        }
      ],
      [
        {
          text: '◀️ Retour au Menu',
          callback_data: 'start'
        }
      ]
    ]
  };

  await sendMessage(chatId, shopText, keyboard);
}

// Fonction pour envoyer le message admin
async function sendAdminMessage(chatId) {
  const adminText = `🔐 <b>PANNEAU ADMINISTRATEUR</b>

Accédez au tableau de bord pour gérer :

📊 Statistiques et ventes
📦 Commandes en cours
📋 Gestion du stock
💰 Finances et transactions
⚙️ Paramètres de la boutique

<i>⚠️ Authentification requise</i>`;

  const keyboard = {
    inline_keyboard: [
      [
        {
          text: '🔐 Ouvrir le Panneau Admin',
          web_app: { url: `${WEBAPP_URL}/admin.html` }
        }
      ],
      [
        {
          text: '◀️ Retour au Menu',
          callback_data: 'start'
        }
      ]
    ]
  };

  await sendMessage(chatId, adminText, keyboard);
}

// Fonction pour envoyer le message d'aide
async function sendHelpMessage(chatId) {
  const helpText = `❓ <b>AIDE & SUPPORT</b>

<b>📍 Livraison :</b>
• Gratuite sur Millau
• +20€ pour l'extérieur

<b>💰 Paiement :</b>
• Espèces à la livraison
• Virement bancaire
• Crypto-monnaies

<b>🎁 Programme fidélité :</b>
• Remise automatique tous les 10 achats
• Jusqu'à 10% ou 20€ de réduction

<b>📞 Contact support :</b>
@assistancenter

<b>⏰ Horaires d'ouverture :</b>
7j/7 de 12H à 00H (minuit)
Livraison rapide pendant les heures d'ouverture

<b>📱 Commandes disponibles :</b>
/start - Menu principal
/shop - Ouvrir la boutique
/admin - Panneau admin
/help - Cette aide`;

  const keyboard = {
    inline_keyboard: [
      [
        {
          text: '💬 Contacter le Support',
          url: 'https://t.me/assistancenter'
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
  };

  await sendMessage(chatId, helpText, keyboard);
}

// Fonction pour envoyer le message de support
async function sendSupportMessage(chatId) {
  const supportText = `💬 <b>SUPPORT CLIENT</b>

Pour toute question ou assistance :

<b>📱 Telegram :</b> @assistancenter
<b>📸 Snapchat :</b> https://snapchat.com/t/l9gurvAj
<b>🆘 Snap Secours :</b> https://snapchat.com/t/jR2yW7xa

Notre équipe est disponible <b>7j/7</b> pour vous aider !

<i>Réponse sous 24h maximum</i>`;

  const keyboard = {
    inline_keyboard: [
      [
        {
          text: '💬 Support Telegram',
          url: 'https://t.me/assistancenter'
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
  };

  await sendMessage(chatId, supportText, keyboard);
}

// Fonction pour envoyer les informations de la boutique
async function sendInfoMessage(chatId) {
  const infoText = `ℹ️ <b>À PROPOS DE DROGUA CENTER</b>

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
7j/7 de 12H à 00H (minuit)

Merci de votre confiance ! 💚`;

  const keyboard = {
    inline_keyboard: [
      [
        {
          text: '🛒 Commander Maintenant',
          web_app: { url: WEBAPP_URL }
        }
      ],
      [
        {
          text: '◀️ Retour',
          callback_data: 'start'
        }
      ]
    ]
  };

  await sendMessage(chatId, infoText, keyboard);
}

// Fonction générique pour envoyer un message
async function sendMessage(chatId, text, keyboard = null) {
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
  
  const data = {
    chat_id: chatId,
    text: text,
    parse_mode: 'HTML'
  };
  
  if (keyboard) {
    data.reply_markup = keyboard;
  }
  
  try {
    await axios.post(url, data);
  } catch (error) {
    console.error('Error sending message:', error.response?.data || error.message);
  }
}

// Fonction pour envoyer une photo avec texte
async function sendPhoto(chatId, photoUrl, caption, keyboard = null) {
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendPhoto`;
  
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
    await axios.post(url, data);
  } catch (error) {
    console.error('Error sending photo:', error.response?.data || error.message);
    throw error;
  }
}

// Fonction pour répondre aux callback queries
async function answerCallbackQuery(callbackQueryId) {
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/answerCallbackQuery`;
  
  try {
    await axios.post(url, {
      callback_query_id: callbackQueryId
    });
  } catch (error) {
    console.error('Error answering callback:', error.message);
  }
}

// Fonction pour définir le webhook
async function setWebhook() {
  const webhookUrl = `${WEBHOOK_DOMAIN}/bot${BOT_TOKEN}`;
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/setWebhook`;
  
  try {
    const response = await axios.post(url, {
      url: webhookUrl,
      allowed_updates: ['message', 'callback_query']
    });
    
    console.log('✅ Webhook set:', webhookUrl);
    console.log('   Response:', response.data);
  } catch (error) {
    console.error('❌ Error setting webhook:', error.response?.data || error.message);
  }
}

// Fonction pour définir le menu du bot
async function setBotCommands() {
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/setMyCommands`;
  
  const commands = [
    { command: 'start', description: '🏠 Menu principal' },
    { command: 'shop', description: '🛒 Ouvrir la boutique' },
    { command: 'admin', description: '🔐 Panneau admin' },
    { command: 'help', description: '❓ Aide et support' }
  ];
  
  try {
    await axios.post(url, { commands });
    console.log('✅ Bot commands set');
  } catch (error) {
    console.error('❌ Error setting commands:', error.message);
  }
}

// Fonction pour configurer le bouton Menu (WebApp)
async function setMenuButton() {
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/setChatMenuButton`;
  
  try {
    await axios.post(url, {
      menu_button: {
        type: 'web_app',
        text: '🛒 Boutique',
        web_app: {
          url: WEBAPP_URL
        }
      }
    });
    console.log('✅ Menu button set');
  } catch (error) {
    console.error('❌ Error setting menu button:', error.message);
  }
}

// Route de santé
app.get('/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    bot: 'Running',
    webhook: `${WEBHOOK_DOMAIN}/bot${BOT_TOKEN}`,
    webapp: WEBAPP_URL
  });
});

// Route pour obtenir les infos du webhook
app.get('/webhook-info', async (req, res) => {
  try {
    const url = `https://api.telegram.org/bot${BOT_TOKEN}/getWebhookInfo`;
    const response = await axios.get(url);
    res.json(response.data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Démarrage du serveur
app.listen(PORT, async () => {
  console.log('🤖 ================================');
  console.log(`   Bot server running on port ${PORT}`);
  console.log('🤖 ================================');
  
  // Configurer le webhook et les commandes
  await setWebhook();
  await setBotCommands();
  await setMenuButton();
  
  console.log('✅ Bot configuration complete');
  console.log(`📱 WebApp URL: ${WEBAPP_URL}`);
  console.log(`🔗 Webhook: ${WEBHOOK_DOMAIN}/bot${BOT_TOKEN}`);
  console.log(`🌐 Health check: http://localhost:${PORT}/health`);
  console.log('🤖 ================================');
});
