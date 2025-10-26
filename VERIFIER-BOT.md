# 🔍 Comment Vérifier l'URL du Bot Telegram

## Méthode 1 : Vérifier le webhook via API ⭐ (RECOMMANDÉ)

### Depuis votre ordinateur ou téléphone, ouvrez cette URL dans le navigateur :

```
https://api.telegram.org/bot7364804422:AAGsiuQhHUVUxb1BfXsb28lKWcot8gxHD30/getWebhookInfo
```

### Ou avec curl (depuis un terminal) :

```bash
curl "https://api.telegram.org/bot7364804422:AAGsiuQhHUVUxb1BfXsb28lKWcot8gxHD30/getWebhookInfo"
```

### ✅ Résultat attendu (BON) :

```json
{
  "ok": true,
  "result": {
    "url": "https://shop-2-production-6505.up.railway.app/bot7364804422:AAGsiuQhHUVUxb1BfXsb28lKWcot8gxHD30",
    "has_custom_certificate": false,
    "pending_update_count": 0,
    "last_error_date": 0,
    "max_connections": 40
  }
}
```

### ❌ Résultat problématique (MAUVAIS) :

```json
{
  "ok": true,
  "result": {
    "url": "https://shop-2-production.up.railway.app/bot7364804422:...",
    ...
  }
}
```
☝️ Si vous voyez encore **shop-2-production.up.railway.app** (sans le 6505), le webhook n'est PAS à jour.

---

## Méthode 2 : Tester directement dans Telegram

### Étape 1 : Ouvrir votre bot
1. Ouvrez Telegram
2. Cherchez votre bot
3. Envoyez `/start`

### Étape 2 : Inspecter le bouton "Boutique"

**Sur ordinateur (Desktop Telegram) :**
1. Cliquez avec le **bouton droit** sur "🛍️ Accéder à la Boutique"
2. Sélectionnez **"Copier le lien"** ou **"Inspecter"**
3. Collez le lien dans un éditeur de texte
4. Vérifiez qu'il contient : `shop-2-production-6505.up.railway.app`

**Sur téléphone (Mobile Telegram) :**
1. **Appuyez et maintenez** le doigt sur le bouton "🛍️ Accéder à la Boutique"
2. Si un menu s'affiche, cherchez l'option **"Copier le lien"**
3. **OU** cliquez simplement sur le bouton et regardez l'URL qui s'affiche en haut du navigateur intégré

### Étape 3 : Vérifier le bouton menu

1. En bas à gauche du chat (sur mobile) ou à droite du champ de texte (sur desktop), vous verrez un bouton **≡ Menu** ou **🛒 Boutique**
2. Cliquez dessus
3. L'URL affichée devrait être : `https://shop-2-production-6505.up.railway.app`

---

## Méthode 3 : Vérifier via votre serveur Railway

### Via l'interface Railway :

```
https://shop-2-production-6505.up.railway.app/webhook-info
```

Ouvrez cette URL dans votre navigateur. Elle devrait afficher les informations du webhook actuel.

---

## Méthode 4 : Tester les commandes du bot

### Envoyez ces commandes dans Telegram :

1. `/start` - Devrait afficher le menu avec les boutons
2. `/shop` - Devrait afficher le bouton "🛒 Ouvrir la Boutique"
3. Cliquez sur **"🛒 Ouvrir la Boutique"**
4. Le WebApp qui s'ouvre devrait afficher en haut :
   - `https://shop-2-production-6505.up.railway.app`

---

## 🔧 Si l'URL n'est PAS à jour

### Solution rapide :

```bash
curl -X POST https://shop-2-production-6505.up.railway.app/setup-webhook
```

### Ou manuellement :

```bash
# 1. Supprimer l'ancien webhook
curl -X POST "https://api.telegram.org/bot7364804422:AAGsiuQhHUVUxb1BfXsb28lKWcot8gxHD30/deleteWebhook?drop_pending_updates=true"

# 2. Attendre 2 secondes
sleep 2

# 3. Configurer le nouveau
curl -X POST "https://api.telegram.org/bot7364804422:AAGsiuQhHUVUxb1BfXsb28lKWcot8gxHD30/setWebhook" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://shop-2-production-6505.up.railway.app/bot7364804422:AAGsiuQhHUVUxb1BfXsb28lKWcot8gxHD30","allowed_updates":["message","callback_query"]}'

# 4. Mettre à jour le bouton menu
curl -X POST "https://api.telegram.org/bot7364804422:AAGsiuQhHUVUxb1BfXsb28lKWcot8gxHD30/setChatMenuButton" \
  -H "Content-Type: application/json" \
  -d '{"menu_button":{"type":"web_app","text":"🛒 Boutique","web_app":{"url":"https://shop-2-production-6505.up.railway.app"}}}'

# 5. Vérifier
curl "https://api.telegram.org/bot7364804422:AAGsiuQhHUVUxb1BfXsb28lKWcot8gxHD30/getWebhookInfo"
```

---

## 🧹 Vider le cache Telegram (si besoin)

### Sur mobile :
1. Ouvrez Telegram
2. Allez dans **Paramètres** → **Données et stockage**
3. Cliquez sur **Vider le cache**
4. Redémarrez Telegram

### Sur desktop :
1. Ouvrez Telegram
2. Allez dans **Settings** → **Advanced** → **Manage local storage**
3. Cliquez sur **Clear all**
4. Redémarrez Telegram

---

## ✅ Checklist de vérification complète

- [ ] Le webhook API retourne le nouveau domaine (`shop-2-production-6505`)
- [ ] Le bouton "🛍️ Accéder à la Boutique" ouvre le bon domaine
- [ ] Le bouton menu (≡) affiche le bon domaine
- [ ] La commande `/shop` fonctionne correctement
- [ ] Le bot répond aux messages
- [ ] Les commandes (`/start`, `/admin`, `/help`) fonctionnent

---

## 📱 Capture d'écran pour vérifier

Quand vous ouvrez la boutique depuis Telegram, vous devriez voir :

```
┌─────────────────────────────────────────┐
│ ← https://shop-2-production-6505... ⋮  │  👈 L'URL en haut
├─────────────────────────────────────────┤
│                                         │
│         🌟 DROGUA CENTER 🌟            │
│                                         │
│         Votre boutique...               │
│                                         │
└─────────────────────────────────────────┘
```

Le domaine en haut **DOIT** contenir `6505` !

---

## 🆘 Besoin d'aide ?

Si après toutes ces étapes l'URL n'est toujours pas à jour :

1. Vérifiez que Railway est bien déployé sur `shop-2-production-6505.up.railway.app`
2. Vérifiez les logs Railway pour des erreurs
3. Essayez de redémarrer le service bot sur Railway
4. Contactez le support si le problème persiste

**Bon test ! 🚀**
