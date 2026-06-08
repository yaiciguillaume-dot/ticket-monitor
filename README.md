# 🎟️ Ticket Monitor

Surveille les places disponibles sur des pages de billetterie et te **notifie sur
Telegram + Email** dès qu'une catégorie se libère.

Deux modes :
- **☁️ 24/7 gratuit via GitHub Actions** — aucun serveur à gérer, aucun hébergeur à payer. **← recommandé**
- **🖥️ Local** — un dashboard web pour tester une URL / trouver le bon mot-clé.

Le moteur de détection (navigateur headless Playwright) lit chaque **catégorie** :
elle est **« complète »** si son bloc contient le mot-clé (par défaut **« Épuisé »**),
**« disponible »** sinon. Dès qu'une catégorie passe de *complète → disponible*,
tu reçois une notif avec son nom et le lien direct.

---

## ☁️ Déploiement 24/7 gratuit (GitHub Actions)

Une vérification automatique **toutes les 5 min**, PC éteint, sans serveur ni coût.

### Étape 1 — Mettre le projet sur GitHub
Crée un dépôt **public** (les minutes Actions sont illimitées en public ; tes mots
de passe restent chiffrés dans les *Secrets*, jamais dans le code) et pousse ce dossier :

```bash
cd ticket-monitor
git init && git add -A && git commit -m "init"
gh repo create ticket-monitor --public --source=. --push   # ou via le site github.com
```

### Étape 2 — Ajouter tes identifiants dans les *Secrets*
Sur GitHub : **Settings → Secrets and variables → Actions → New repository secret**.
Ajoute (au minimum Telegram) :

| Secret | Exemple |
|---|---|
| `TELEGRAM_BOT_TOKEN` | `123456:ABC-...` |
| `TELEGRAM_CHAT_ID` | `123456789` |
| `SMTP_HOST` | `smtp.gmail.com` |
| `SMTP_PORT` | `587` |
| `SMTP_USER` | `toi@gmail.com` |
| `SMTP_PASS` | mot de passe d'application |
| `MAIL_FROM` | `toi@gmail.com` |
| `MAIL_TO` | `toi@gmail.com` |

> Comment obtenir le token/chat id Telegram et le mot de passe SMTP : voir
> [section « Notifications »](#notifications) plus bas.

### Étape 3 — Déclarer les billetteries à surveiller
Édite **`targets.json`** directement sur GitHub (bouton crayon ✏️) :

```json
[
  {
    "name": "Concert X — 12 juin",
    "url": "https://billetterie.com/mon-evenement",
    "keyword": "Épuisé",
    "wait_selector": null,
    "enabled": true
  }
]
```

Ajoute autant d'objets que tu veux dans le tableau. Mets `"enabled": false` pour
mettre une surveillance en pause.

### Étape 4 — Activer
Onglet **Actions** → autorise les workflows. Le cron tourne ensuite tout seul.
Pour un test immédiat : **Actions → Ticket Monitor → Run workflow**.

C'est tout. ✅ À chaque place qui se libère, tu reçois Telegram + email.

> **À savoir :** l'intervalle minimum imposé par GitHub est 5 min, et un run peut
> être retardé de quelques minutes en heure de pointe. Pas de « temps réel à la
> seconde » — mais c'est le meilleur compromis gratuit et sans serveur.

---

## 🖥️ Mode local (dashboard, pour tester)

Pratique pour **trouver le bon mot-clé** ou tester une URL avant de l'ajouter à `targets.json`.

```bash
npm install            # dépendances + Chromium
cp .env.example .env   # (optionnel) Telegram + Email
npm start              # → http://localhost:3000
```

Le dashboard permet d'ajouter des URLs, voir le statut en direct, et reçoit aussi
les alertes son + notification navigateur. (Ce mode nécessite ton PC allumé — pour
le 24/7, utilise GitHub Actions ci-dessus.)

Tester un check en ligne de commande, sans serveur :
```bash
npm run check          # lit targets.json, notifie, écrit state.json
```

---

## Notifications

### Telegram (recommandé — te suit partout)
1. Sur Telegram, parle à **@BotFather** → `/newbot` → récupère le **token**.
2. Envoie un message à ton nouveau bot.
3. Ouvre `https://api.telegram.org/bot<TON_TOKEN>/getUpdates` et repère
   `"chat":{"id":123456789}` → c'est ton **chat id**.

### Email (SMTP)
Exemple Gmail (crée un **mot de passe d'application** dans ton compte Google) :
```
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=ton.email@gmail.com
SMTP_PASS=xxxx xxxx xxxx xxxx
MAIL_FROM=ton.email@gmail.com
MAIL_TO=ton.email@gmail.com
```
En local, ces valeurs vont dans `.env`. Sur GitHub Actions, dans les *Secrets*.

---

## Réglages par billetterie

- **`keyword`** : le terme qui marque « complet ». Mets `Sold out`, `Complet`… selon le site.
- **`wait_selector`** : si la page est lente, un sélecteur CSS à attendre (ex `.ticket-list`).
- **`enabled`** : `false` pour mettre en pause sans supprimer.

> ⚠️ Reste raisonnable sur la fréquence pour ne pas te faire bloquer par le site.

---

## Et si le site me bloque ?

Si un site a une protection anti-robot agressive (captcha, détection) qui empêche
même Playwright de charger la page, il faudra passer par un navigateur cloud
« furtif » (ex. Browserbase) — mais c'est payant. À ne sortir qu'en dernier recours.

---

## Fichiers

| Fichier | Rôle |
|---|---|
| `targets.json` | la liste des billetteries à surveiller (tu l'édites) |
| `state.json` | l'état mémorisé entre deux checks (auto, ne pas toucher) |
| `.github/workflows/monitor.yml` | le cron GitHub Actions (5 min) |
| `src/check.js` | le check sans serveur (mode Actions / CLI) |
| `src/scraper.js` | moteur Playwright + détection des catégories |
| `src/notifier.js` | envoi Telegram + Email |
| `src/server.js` | le dashboard local (mode `npm start`) |
