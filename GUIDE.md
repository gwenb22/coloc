# Guide de mise en ligne — pas à pas

Compter environ 20 minutes. Tout est gratuit (offre gratuite Supabase + GitHub Pages).

Vous aurez besoin de :
- un compte **GitHub** (https://github.com) ;
- un compte **Supabase** (https://supabase.com, connexion possible avec GitHub) ;
- **Node.js 20 ou plus** pour tester sur votre ordinateur (facultatif).

---

## 1. Créer la base de données Supabase

1. Sur https://supabase.com/dashboard, cliquez **New project**.
   - Nom : `coloc` (au choix)
   - Mot de passe de la base : générez-le et gardez-le dans un gestionnaire de mots de passe (vous n'en aurez pas besoin dans l'application)
   - Région : **Europe (Paris ou Frankfurt)**
2. Attendez la fin de la création (1 à 2 minutes).
3. Menu de gauche **SQL Editor** → **New query**.
4. Ouvrez le fichier [`supabase/schema.sql`](supabase/schema.sql), copiez **tout** son contenu, collez-le, puis cliquez **Run**.
   Le message « Success. No rows returned » doit s'afficher.

### Mises à jour de la base (bases créées avant octobre 2026)
Si votre base a été créée avec une ancienne version de `schema.sql`, exécutez une fois, dans l'ordre :
1. [`supabase/correctif-1-code-invitation.sql`](supabase/correctif-1-code-invitation.sql) — création de la colocation ;
2. [`supabase/correctif-2-mensuel-et-recurrentes.sql`](supabase/correctif-2-mensuel-et-recurrentes.sql) — tâches mensuelles (vitres, four, micro-ondes, frigo) et dépenses récurrentes ;
3. [`supabase/correctif-3-regroupements.sql`](supabase/correctif-3-regroupements.sql) — groupes de tâches « Sols » et « Linge » pour la répartition.

### Optionnel : rappels quotidiens automatiques
Pour recevoir chaque matin dans l'application les tâches du jour, les retards, les échéances d'entretien et les remboursements prévus :
1. **Database → Extensions** → recherchez `pg_cron` → activez-la.
2. **SQL Editor → New query** → collez le contenu de [`supabase/rappels_quotidiens.sql`](supabase/rappels_quotidiens.sql) → **Run**.

## 2. Configurer l'authentification

1. **Authentication → URL Configuration** :
   - **Site URL** : `https://VOTRE-COMPTE.github.io/VOTRE-DEPOT/` (par ex. `https://maxens.github.io/coloc/`)
   - **Redirect URLs** : ajoutez la même adresse, plus `http://localhost:5173/` pour les tests locaux.
   Ces adresses servent aux liens de confirmation d'e-mail et de mot de passe oublié.
2. **Authentication → Sign In / Providers → Email** : laissez « Confirm email » activé.

## 3. Récupérer les clés publiques

- **Project URL** (Project Settings → Data API, ou bouton **Connect** en haut du projet) → c'est `VITE_SUPABASE_URL`.
  Copiez uniquement `https://xxxxxxxx.supabase.co`, **sans** `/rest/v1/` à la fin.
- **Project Settings → API Keys** → c'est `VITE_SUPABASE_ANON_KEY` :
  - de préférence l'onglet **Legacy API keys** → clé **`anon` `public`** (commence par `eyJ…`) ;
  - sinon la **Publishable key** (`sb_publishable_…`).

> ⚠️ Ne copiez **jamais** les **Secret keys** (`sb_secret_…`) ni la clé legacy `service_role` : elles donnent tous les droits et ne doivent pas se retrouver dans le site.
> La clé publique est faite pour être visible : la protection des données repose sur les règles RLS installées à l'étape 1.

## 4. Publier sur GitHub Pages

1. Créez un dépôt sur GitHub (par ex. `coloc`). Il peut être **public** : le code ne contient aucun secret, les données sont dans Supabase.
   (Avec un dépôt privé, GitHub Pages demande un abonnement payant.)
2. Envoyez le code, depuis le dossier du projet :
   ```bash
   git init
   git add .
   git commit -m "Première version de Coloc"
   git branch -M main
   git remote add origin https://github.com/VOTRE-COMPTE/coloc.git
   git push -u origin main
   ```
3. Sur GitHub, dans le dépôt : **Settings → Secrets and variables → Actions → New repository secret**, créez :
   - `VITE_SUPABASE_URL` = l'URL du projet
   - `VITE_SUPABASE_ANON_KEY` = la clé anon
4. **Settings → Pages → Build and deployment → Source : GitHub Actions**.
5. Onglet **Actions** : relancez le workflow « Déploiement GitHub Pages » (bouton **Run workflow**) s'il a échoué avant l'ajout des secrets.
   Au bout d'une minute ou deux, le site est en ligne à `https://VOTRE-COMPTE.github.io/coloc/`.

Chaque `git push` sur `main` relance les tests puis republie le site.

## 5. Première utilisation

1. Ouvrez le site → **Créer un compte** → confirmez votre e-mail → connectez-vous.
2. **Créer** la colocation : les six espaces et des tâches d'exemple sont créés (tout est modifiable).
3. **Paramètres → Colocation → Inviter votre colocataire** : partagez le lien ou le code à 8 caractères.
4. Votre colocataire crée son compte, ouvre le lien (ou saisit le code dans « Rejoindre »), puis **Accepte**.
5. **Tâches → Répartition équitable → Générer une proposition**, vérifiez, ajustez si besoin, puis **Confirmer**.

### Recommandé une fois vos deux comptes créés
**Authentication → Sign In / Providers** → désactivez **Allow new users to sign up**.
Personne d'autre ne pourra créer de compte (de toute façon, un compte extérieur ne voit aucune donnée de votre colocation).

## 6. Installer l'application sur le téléphone

- **iPhone (Safari)** : bouton Partager → **Sur l'écran d'accueil**.
- **Android (Chrome)** : menu ⋮ → **Installer l'application**.
- **Ordinateur (Chrome / Edge)** : icône d'installation dans la barre d'adresse.

Pour les notifications du navigateur : **Paramètres → Notifications et rappels → Notifications du navigateur** (sur iPhone, uniquement depuis l'application installée).

## 7. Tester sur votre ordinateur (facultatif)

```bash
npm install
cp .env.example .env.local   # puis collez l'URL et la clé anon dans .env.local
npm run dev                  # ouvre http://localhost:5173
npm test                     # tests des calculs (parts en centimes, soldes, répartition)
```

Sans fichier `.env.local`, l'application démarre en **mode démo** (données fictives dans le navigateur, deux personnes Alex et Sam).
Ajoutez `?demo` à l'adresse pour forcer le mode démo même quand Supabase est configuré.

## En cas de problème

| Symptôme | Solution |
| --- | --- |
| Le lien de confirmation renvoie vers `localhost` | Vérifiez **Site URL** et **Redirect URLs** (étape 2). |
| « Invitation introuvable » | Le code a été régénéré ou la colocation est complète : générez un nouveau code. |
| La page reste sur le mode démo en ligne | Les secrets GitHub (étape 4.3) manquent ou sont mal nommés ; relancez le workflow. |
| « Email rate limit exceeded » | Le service d'e-mail intégré de Supabase est limité à quelques e-mails par heure : patientez. |
| Rien ne se synchronise en direct | Réexécutez la fin de `schema.sql` (section « Synchronisation en temps réel ») ou activez Realtime sur les tables dans **Database → Publications**. |
