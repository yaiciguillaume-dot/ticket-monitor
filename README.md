# 🎟️ Ticket Monitor

Surveille **en temps réel** les places disponibles sur des pages de billetterie et
te **notifie sur Telegram + Email** dès qu'une catégorie se libère.

- ✅ Ajoute autant d'URLs que tu veux depuis un dashboard unique
- ✅ Navigateur headless (Playwright) → fonctionne même sur les sites en JavaScript
- ✅ Détection par catégorie : « dispo » dès qu'une catégorie n'affiche plus le mot-clé *Épuisé*
- ✅ Notifications **Telegram + Email** + alerte sonore/navigateur dans le dashboard
- ✅ Prêt pour le **24/7** via Docker

---

## 1. Installation locale (pour tester)

```bash
cd ticket-monitor
npm install            # installe les dépendances + Chromium
cp .env.example .env   # puis remplis tes identifiants (voir plus bas)
npm start
```

Ouvre **http://localhost:3000**, colle une URL de billetterie, et c'est parti.

> Sans `.env` configuré, l'app marche quand même : tu auras les alertes **dans le
> navigateur** (son + notification). Telegram/Email s'activent une fois renseignés.

---

## 2. Configurer les notifications

### Telegram (recommandé — te suit partout)
1. Sur Telegram, parle à **@BotFather** → `/newbot` → suis les étapes → récupère le **token**.
2. Envoie un message quelconque à ton nouveau bot.
3. Ouvre `https://api.telegram.org/bot<TON_TOKEN>/getUpdates` dans ton navigateur
   et repère `"chat":{"id":123456789}` → c'est ton **chat id**.
4. Renseigne dans `.env` :
   ```
   TELEGRAM_BOT_TOKEN=123456:ABC-...
   TELEGRAM_CHAT_ID=123456789
   ```

### Email (SMTP)
Exemple avec Gmail (crée un **mot de passe d'application** dans ton compte Google) :
```
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=ton.email@gmail.com
SMTP_PASS=xxxx xxxx xxxx xxxx
MAIL_FROM=ton.email@gmail.com
MAIL_TO=ton.email@gmail.com
```

Clique sur **« Tester les notifs »** dans le dashboard pour vérifier.

---

## 3. Déploiement 24/7 (Docker)

Pour surveiller même PC éteint, déploie sur un petit serveur (VPS, Raspberry Pi,
Railway, Fly.io, etc.) :

```bash
cp .env.example .env   # configure Telegram/Email
docker compose up -d --build
```

L'app tourne sur le port `3000`, redémarre toute seule, et stocke ses données
dans `./data`. Mets un mot de passe / reverse-proxy devant si tu l'exposes sur Internet.

---

## 4. Comment ça marche

Pour chaque URL, l'app charge la page dans un vrai navigateur, attend le rendu JS,
puis lit chaque **catégorie** (nom + prix). Une catégorie est considérée :

- **Complète** si son bloc contient le mot-clé (par défaut **« Épuisé »**) ;
- **Disponible** sinon (ex : un sélecteur de quantité `0 / +` est présent).

Dès qu'une catégorie passe de *complète → disponible*, tu reçois une notif avec le
nom de la catégorie et le lien direct.

### Réglages par billetterie (options avancées)
- **Mot-clé** : change `Épuisé` si le site utilise un autre terme (`Sold out`, `Complet`…).
- **Intervalle** : fréquence de vérification (min 20 s).
- **Sélecteur à attendre** : si la page est lente, indique un sélecteur CSS à
  attendre avant de lire (ex `.ticket-list`).

> ⚠️ Reste raisonnable sur la fréquence : un intervalle trop court peut te faire
> bannir par le site. 30–60 s est un bon compromis.
