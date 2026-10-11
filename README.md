# A-t-il dit ça ?

Site de fact-checking : on saisit une phrase ou une expression, et le site indique si
David Lisnard l'a prononcée dans l'une de ses interviews YouTube, avec l'extrait
surligné et un lien vers la vidéo au bon timestamp.

## Fonctionnement

- Les transcriptions sont **stockées en base** (Postgres) puis interrogées en recherche plein texte :
  la recherche est instantanée et ne consomme aucun appel d'API.
- Recherche en deux temps : *mot pour mot* (insensible aux accents, à la casse et à la
  ponctuation, même si la phrase chevauche deux sous-titres), puis *formulation proche*
  (tous les mots présents à proximité, pluriels tolérés).
- Interface **/admin** (protégée par mot de passe) pour :
  - ajouter une vidéo à partir de son URL (transcription récupérée via Supadata, ou collée à la main en SRT / VTT / `[00:12] texte` / texte brut) ;
  - corriger la transcription segment par segment (lecteur YouTube intégré, couper / fusionner / insérer / supprimer, chercher-remplacer, Ctrl+S) ;
  - modifier titre, chaîne, date ; supprimer une vidéo.

## Synchronisation automatique des chaînes

Page **/admin/#/sync**. On y ajoute une chaîne YouTube ; le site :

1. liste tout son historique (API YouTube Data) et met les vidéos en **file d'attente** ;
2. récupère leurs transcriptions petit à petit (25 par passe, une passe toutes les 5 minutes) ;
3. vérifie ensuite **chaque jour** si de nouvelles vidéos sont sorties et les ajoute.

Garde-fous :
- le traitement démarre **en pause** : rien n'est facturé tant qu'on n'a pas cliqué sur « Démarrer » ;
- seuls les sous-titres existants sont demandés (`mode=native`, 1 crédit Supadata par vidéo), jamais de transcription générée par IA ;
- **les vidéos déjà présentes ne sont jamais modifiées** : une transcription n'est posée que sur une vidéo créée par la synchro, encore en attente, sans aucun segment et jamais éditée (sous verrou de ligne). Les corrections manuelles sont donc toujours préservées ;
- une vidéo supprimée à la main est mémorisée et n'est jamais ré-ajoutée ;
- sous-titres absents : nouvel essai (6 h, 12 h, 24 h, 48 h) pour une vidéo récente, abandon immédiat pour une ancienne ; les vidéos en échec se relancent ou se saisissent à la main ;
- crédits ou clé refusés : le traitement se suspend (1 h / 6 h) au lieu de boucler.

Variables : `YOUTUBE_API_KEY` (liste des vidéos) et `SUPADATA_API_KEY` (transcriptions).

## Lancer en local

```bash
cp .env.example .env     # puis adapter (ou exporter les variables)
npm install
npm start                # http://localhost:3000  — admin : /admin/
npm test
```

Il faut un Postgres accessible via `DATABASE_URL` (les tables sont créées au démarrage).

## Déployer sur Railway

1. Créer un projet Railway, y ajouter un **service Postgres** et un service depuis ce dépôt GitHub.
2. Dans les **Variables** du service web :

   | Variable | Valeur |
   |---|---|
   | `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` (référence au plugin) |
   | `ADMIN_PASSWORD` | mot de passe de `/admin` |
   | `SESSION_SECRET` | chaîne aléatoire de 32+ caractères (`openssl rand -hex 32`) |
   | `SUPADATA_API_KEY` | clé Supadata (optionnelle tant que tu colles les transcriptions à la main) |
   | `YOUTUBE_API_KEY` | clé YouTube Data API v3 (pour la synchronisation automatique des chaînes) |

3. Générer un domaine public (Settings → Networking). Le healthcheck est `/api/health`.

## Charte graphique

Reprise de https://www.unenouvelleenergie.fr/ : bleu `#1d257a`, chamois `#b0ad85`, rose `#d0165f`,
police Montserrat (fichiers dans `public/fonts/`). Le logo officiel n'est volontairement pas utilisé.
Tout est dans [`public/css/theme.css`](public/css/theme.css) ; `app.css` et `admin.css` n'utilisent que ces variables.

## Structure

```
src/
  server.js          app Express
  db.js, schema.sql  Postgres : vidéos + segments (index de recherche recalculé à chaque sauvegarde)
  normalize.js       normalisation du texte (indexation et requêtes)
  search.js          recherche exacte / approchée, extraits et surlignage
  transcripts.js     Supadata + parseurs SRT/VTT/texte
  sync.js            synchronisation : découverte des vidéos, file d'attente, planificateur
  youtube.js         extraction d'ID, métadonnées oEmbed
  auth.js            session admin (cookie signé HMAC), limiteur de tentatives
  routes/            API publique (/api/search…) et admin (/api/admin/…)
public/              site (index.html) et admin (admin/)
test/                tests unitaires + test d'intégration (si DATABASE_URL défini)
```
