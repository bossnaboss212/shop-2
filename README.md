# Boutique – Full (Railway + Netlify)

## Variables d’environnement (Railway → Settings → Variables)
- TELEGRAM_TOKEN  : token bot Telegram
- ADMIN_CHAT_ID   : chat id admin (ex: -1003055353629)
- DRIVER_CHAT_ID  : (optionnel) chat id livreurs (reçu anonymisé)
- MAPBOX_KEY      : clé API Mapbox (autocomplete)
- ADMIN_PASS      : mot de passe admin (défaut: gangstaforlife12)

## Démarrer localement
npm install
npm start

## Netlify (frontend only)
Déployez `public/` et remplacez dans `public/app.js` la constante `API`
par l’URL de votre backend Railway (ex: https://monapp.up.railway.app/api).
