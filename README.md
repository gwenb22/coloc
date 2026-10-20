# Coloc

Application privée pour deux colocataires : tâches ménagères réparties équitablement, calendrier partagé, budget commun et remboursements, courses, stocks et entretien.

- Interface : React + TypeScript + Vite, publiée sur **GitHub Pages**, installable (PWA), clair/sombre, mobile d'abord.
- Données et comptes : **Supabase** (Auth + PostgreSQL + Row Level Security + Realtime).
- **Mode démo** intégré : sans configuration, l'application fonctionne avec des données fictives dans le navigateur.

👉 Mise en ligne : voir **[GUIDE.md](GUIDE.md)**.

## Fonctionnalités

| Module | Contenu |
| --- | --- |
| Tableau de bord | Tâches du jour et en retard (case à cocher rapide + annuler), prochaines tâches, temps prévu, solde, prochaine échéance, répartition sur 4 semaines, budget du mois, dépenses récentes, courses, notifications, demandes d'échange, actions rapides |
| Tâches | Catalogue par zone (quotidienne / hebdo avec jours / mensuelle « 2e samedi du mois » / ponctuelle, durée, effort, préférence, attribution fixe, dates de début et de fin, plage de réalisation, consignes, suspension, archivage), planning filtrable, historique filtrable + export CSV |
| Répartition équitable | Regroupement : tâches d'une même pièce le même jour, et groupes nommés (« Sols », « Linge »), attribués en bloc à une seule personne ; charge = durée × coefficient d'effort (1,0 / 1,2 / 1,5 modifiables), fenêtre glissante de 4 semaines, indisponibilités, préférences, anti-répétition, attributions fixes et verrouillées respectées ; **proposition → ajustement → confirmation** ; indicateurs (charge pondérée, temps estimé et réel, écart, évolution hebdomadaire) |
| Occurrence | Terminer (temps réel), en cours (option), reporter, annuler, rouvrir, signaler un problème, commentaires, réattribution (verrouillée), demande d'échange (n'agit qu'après acceptation), historique |
| Calendrier | Mois / semaine / jour / échéances, tâches, prévisions non planifiées, entretien, remboursements prévus, dépenses (désactivées par défaut), filtres par personne, zone, statut |
| Budget | Dépenses récurrentes (loyer, abonnements : créées automatiquement chaque mois, mois manqués rattrapés, sans doublon), dépenses (parts égales, %, montants fixes, une personne ; montants en centimes sans perte), provisoires / validées / annulées, historique des modifications, soldes détaillés, remboursements prévus / effectués, budgets mensuels et annuels avec limites par catégorie, comparaisons, bilan annuel, exports CSV |
| Courses et stocks | Liste partagée par catégorie, priorité, acheteur·se, prix estimé, achat → mise à jour du stock, conversion en dépense (préremplie, jamais automatique) ; stocks avec seuils et suggestions d'achat |
| Entretien | Fiches (priorité, suivi, échéance, statut), commentaires, historique, dépenses liées |
| Notifications | Centre de notifications (lu / non lu / tout lire), préférences par catégorie, heures de silence, rappel local des tâches du jour, notifications du navigateur ; rappels quotidiens serveur optionnels (`pg_cron`) |
| Paramètres | Profil, thème, préférences de calendrier, colocation (nom, devise, début du suivi, invitation par lien/code, transfert du rôle, départ), zones, catégories, coefficients, export CSV et sauvegarde JSON, mot de passe, suppression du compte |

## Sécurité et cohérence (vérifiées côté base de données)

- RLS sur toutes les tables : un compte extérieur ne voit rien, même en connaissant les URL ; les visiteurs non connectés n'ont aucun droit.
- 2 membres maximum, une seule colocation par personne, invitation invalidée une fois la colocation complète.
- Toute personne désignée (attribution, payeur, part, remboursement…) doit être membre de la colocation.
- Dépenses et parts écrites uniquement via une fonction transactionnelle : la somme des parts doit égaler le montant au centime, les pourcentages totaliser 100 %.
- Anti-doublons : clés uniques pour les dépenses et remboursements (double clic / double envoi), une seule occurrence par tâche et par date, une seule demande d'échange en attente.
- Modifications concurrentes détectées (numéro de version) : l'autre personne est prévenue et les données rechargées.
- Historique : journal des actions (dépenses, attributions, reports, échanges, entretien) ; une dépense ou un remboursement s'annule au lieu d'être supprimé ; la suppression d'un compte anonymise le profil sans casser les comptes.
- Le service worker ne met en cache que l'interface, jamais les données.

`supabase/schema.sql` a été testé sur PostgreSQL (PGlite) avec trois comptes simulés : accès extérieur refusé, troisième membre refusé, parts incohérentes refusées, échanges, doublons, versions, départ et suppression de compte.

## Choix retenus (section 22 du cahier des charges)

- Apparence : clair et sombre (automatique ou forcé dans les paramètres).
- Répartition automatique : proposée puis validée.
- Modification des tâches : chacun·e peut modifier les tâches communes ; tout est historisé.
- Justificatifs : pas de photo au lancement.
- Hors ligne : l'application s'ouvre et affiche les données déjà chargées ; les modifications nécessitent une connexion.
- Historique : conservé sans limite de durée.

## Limites connues

- **Notifications push application fermée** : non incluses (elles nécessitent des clés VAPID et une fonction serveur). Les notifications fonctionnent dans l'application, via le navigateur quand l'application est ouverte ou en arrière-plan, et par les rappels quotidiens optionnels.
- L'envoi de l'invitation se fait par partage du lien ou du code (pas d'e-mail automatique).

## Développement

```bash
npm install
npm run dev     # mode démo sans .env.local
npm test        # tests unitaires (partage en centimes, soldes, répartition équitable)
npm run build
```

Structure : `src/lib` (calculs purs et testés), `src/backend` (Supabase et démo), `src/store.tsx` (données, synchro temps réel, erreurs), `src/components` (interface commune, détail des tâches, formulaires), `src/pages`.
