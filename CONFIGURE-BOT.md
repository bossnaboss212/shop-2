# 🤖 Configuration du Bot Telegram - DROGUA CENTER

## ⚠️ Important
Les appels API Telegram sont bloqués depuis cet environnement. Vous devez configurer le bot **APRÈS** avoir déployé sur Railway.

---

## 🚀 Étapes de configuration (APRÈS déploiement Railway)

### Option 1 : Configuration automatique via l'API (RECOMMANDÉ)

Une fois votre application déployée sur Railway, appelez simplement cette URL :

```bash
curl -X POST https://shop-2-production-6505.up.railway.app/setup-webhook
```

Ou ouvrez cette URL dans votre navigateur :
```
https://shop-2-production-6505.up.railway.app/setup-webhook
```

Cette route configure automatiquement :
- ✅ Le webhook Telegram
- ✅ Le bouton menu de la boutique
- ✅ Les commandes du bot

---

### Option 2 : Configuration manuelle

Si l'option 1 ne fonctionne pas, utilisez ces commandes depuis **VOTRE ORDINATEUR** (pas depuis cet environnement) :

#### 1. Supprimer l'ancien webhook
```bash
curl -X POST "https://api.telegram.org/bot7364804422:AAGsiuQhHUVUxb1BfXsb28lKWcot8gxHD30/deleteWebhook?drop_pending_updates=true"
```

#### 2. Configurer le nouveau webhook
```bash
curl -X POST "https://api.telegram.org/bot7364804422:AAGsiuQhHUVUxb1BfXsb28lKWcot8gxHD30/setWebhook" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://shop-2-production-6505.up.railway.app/bot7364804422:AAGsiuQhHUVUxb1BfXsb28lKWcot8gxHD30","allowed_updates":["message","callback_query"]}'
```

#### 3. Mettre à jour le bouton menu
```bash
curl -X POST "https://api.telegram.org/bot7364804422:AAGsiuQhHUVUxb1BfXsb28lKWcot8gxHD30/setChatMenuButton" \
  -H "Content-Type: application/json" \
  -d '{"menu_button":{"type":"web_app","text":"🛒 Boutique","web_app":{"url":"https://shop-2-production-6505.up.railway.app"}}}'
```

#### 4. Configurer les commandes
```bash
curl -X POST "https://api.telegram.org/bot7364804422:AAGsiuQhHUVUxb1BfXsb28lKWcot8gxHD30/setMyCommands" \
  -H "Content-Type: application/json" \
  -d '{"commands":[{"command":"start","description":"🏠 Menu principal"},{"command":"shop","description":"🛒 Ouvrir la boutique"},{"command":"orders","description":"📦 Mes commandes"},{"command":"admin","description":"🔐 Panneau admin"},{"command":"help","description":"❓ Aide et support"},{"command":"keyboard","description":"⌨️ Afficher/Masquer le clavier"}]}'
```

---

### Option 3 : Configuration depuis Railway Logs

Votre bot se configure automatiquement au démarrage. Vérifiez les logs Railway pour vous assurer que :
1. Le serveur démarre correctement
2. Le webhook est configuré
3. Aucune erreur n'apparaît

---

## 🔍 Vérifier la configuration

### Vérifier le webhook actuel
```bash
curl "https://api.telegram.org/bot7364804422:AAGsiuQhHUVUxb1BfXsb28lKWcot8gxHD30/getWebhookInfo"
```

Vous devriez voir :
```json
{
  "url": "https://shop-2-production-6505.up.railway.app/bot7364804422:AAGsiuQhHUVUxb1BfXsb28lKWcot8gxHD30",
  "has_custom_certificate": false,
  "pending_update_count": 0
}
```

---

## 📱 Tester le bot

1. Ouvrez Telegram
2. Cherchez votre bot
3. Envoyez `/start`
4. Vérifiez que les boutons s'affichent :
   - 🛍️ Accéder à la Boutique
   - 🔐 Panneau Admin
   - 📢 Canal Principal
   - etc.

5. Cliquez sur "🛍️ Accéder à la Boutique"
6. Vérifiez que l'URL affichée est : `https://shop-2-production-6505.up.railway.app`

---

## ⚡ Configuration rapide en une ligne (depuis votre ordinateur)

```bash
curl -X POST https://shop-2-production-6505.up.railway.app/setup-webhook && echo "✅ Bot configuré !"
```

---

## 🐛 Dépannage

### Le bot ne répond pas
1. Vérifiez que l'application Railway est démarrée
2. Consultez les logs Railway pour les erreurs
3. Vérifiez le webhook : `curl https://shop-2-production-6505.up.railway.app/webhook-info`

### Le bot affiche toujours l'ancien domaine
1. Videz le cache Telegram (Paramètres → Données et stockage → Vider le cache)
2. Reconfigurer le webhook avec l'Option 1
3. Redémarrez l'application Telegram

### Erreur "Access denied" en local
C'est normal ! Les appels API Telegram sont bloqués depuis cet environnement.
Utilisez la route `/setup-webhook` une fois déployé sur Railway.

---

## ✅ Configuration terminée

Une fois configuré, votre bot devrait :
- ✅ Répondre aux commandes `/start`, `/shop`, `/admin`, `/help`
- ✅ Afficher le bouton "🛒 Boutique" dans le menu
- ✅ Ouvrir le bon domaine Railway quand on clique sur les boutons
- ✅ Envoyer les notifications de commandes

**Bon business ! 🚀**
