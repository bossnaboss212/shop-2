const express = require('express');
const axios = require('axios');

// Configuration
const BOT_TOKEN = process.env.TELEGRAM_TOKEN || '7364804422:AAGsiuQhHUVUxb1BfXsb28lKWcot8gxHD30';
const WEBAPP_URL = 'https://shop-2-production.up.railway.app';
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
      
      // Commande /start
      if (text === '/start') {
        await sendWelcomeMessage(chatId);
      }
      // Commande /shop
      else if (text === '/shop') {
        await sendShopMessage(chatId);
      }
      // Commande /help
      else if (text === '/help') {
        await sendHelpMessage(chatId);
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
      } else if (data === 'contact_support') {
        await sendSupportMessage(chatId);
      }
    }
    
    res.sendStatus(200);
  } catch (error) {
    console.error('Error:', error);
    res.sendStatus(500);
  }
});

// Fonction pour envoyer le message de bienvenue
async function sendWelcomeMessage(chatId) {
  const welcomeText = `
🎯 <b>Bienvenue sur DROGUA CENTER !</b>

Votre boutique premium accessible directement depuis Telegram.

🛍️ <b>Comment commander :</b>
• Cliquez sur le bouton "🛒 Ouvrir la Boutique"
• Parcourez notre catalogue
• Ajoutez vos articles au panier
• Validez votre commande

📱 <b>Commandes disponibles :</b>
/shop - Ouvrir la boutique
/help - Aide et support

✨ <b>Profitez de notre programme de fidélité !</b>
Une remise automatique tous les 10 achats.
`;

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
        }
      ]
    ]
  };

  await sendMessage(chatId, welcomeText, keyboard);
}

// Fonction pour envoyer le message boutique
async function sendShopMessage(chatId) {
  const shopText = `
🛍️ <b>BOUTIQUE DROGUA CENTER</b>

Cliquez sur le bouton ci-dessous pour accéder à notre catalogue complet et passer commande.

💎 Livraison rapide et discrète
🔒 Paiement sécurisé
📦 Suivi de commande en temps réel
`;

  const keyboard = {
    inline_keyboard: [
      [
        {
          text: '🛒 Accéder à la Boutique',
          web_app: { url: WEBAPP_URL }
        }
      ]
    ]
  };

  await sendMessage(chatId, shopText, keyboard);
}

// Fonction pour envoyer le message d'aide
async function sendHelpMessage(chatId) {
  const helpText = `
❓ <b>AIDE & SUPPORT</b>

📍 <b>Livraison :</b>
• Gratuite sur Millau
• +20€ pour l'extérieur

💰 <b>Paiement :</b>
• Espèces à la livraison
• Virement
• Crypto

🎁 <b>Programme fidélité :</b>
• Remise automatique tous les 10 achats
• Jusqu'à 10% ou 20€ de réduction

📞 <b>Contact support :</b>
@assistancenter

⏰ <b>Horaires :</b>
7j/7 - Livraison rapide
`;

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
          text: '🛒 Ouvrir la Boutique',
          web_app: { url: WEBAPP_URL }
        }
      ]
    ]
  };

  await sendMessage(chatId, helpText, keyboard);
}

// Fonction pour envoyer le message de support
async function sendSupportMessage(chatId) {
  const supportText = `
💬 <b>SUPPORT CLIENT</b>

Pour toute question ou assistance :

📱 Telegram : @assistancenter
📸 Snapchat : https://snapchat.com/t/l9gurvAj
🆘 Snap Secours : https://snapchat.com/t/jR2yW7xa

Notre équipe est disponible 7j/7 pour vous aider !
`;

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
      ]
    ]
  };

  await sendMessage(chatId, supportText, keyboard);
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
  const webhookUrl = `${process.env.RAILWAY_PUBLIC_DOMAIN || 'https://shop-2-production.up.railway.app'}/bot${BOT_TOKEN}`;
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/setWebhook`;
  
  try {
    const response = await axios.post(url, {
      url: webhookUrl,
      allowed_updates: ['message', 'callback_query']
    });
    
    console.log('✅ Webhook set:', response.data);
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
  res.json({ status: 'OK', bot: 'Running' });
});

// Démarrage du serveur
app.listen(PORT, async () => {
  console.log(`🤖 Bot server running on port ${PORT}`);
  
  // Configurer le webhook et les commandes
  await setWebhook();
  await setBotCommands();
  await setMenuButton();
  
  console.log('✅ Bot configuration complete');
  console.log(`📱 WebApp URL: ${WEBAPP_URL}`);
});
