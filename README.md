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
  youtube.js         extraction d'ID, métadonnées oEmbed
  auth.js            session admin (cookie signé HMAC), limiteur de tentatives
  routes/            API publique (/api/search…) et admin (/api/admin/…)
public/              site (index.html) et admin (admin/)
test/                tests unitaires + test d'intégration (si DATABASE_URL défini)
```
