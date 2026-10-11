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

## Dernières vidéos et résumés

L'accueil affiche les **5 dernières vidéos par date de publication** : celles des chaînes suivies **et** celles ajoutées à la
main dans l'admin (seules celles qui ont une transcription apparaissent). Avec `YOUTUBE_API_KEY`, une vidéo ajoutée à la main
récupère sa date de publication toute seule ; sinon, renseigne la date dans l'éditeur (bouton « Mettre à jour depuis YouTube »
pour les vidéos existantes).

Le bouton **Résumer** demande à un modèle (OpenRouter) de résumer la transcription : un « En bref », puis des sections avec
repères de temps cliquables, des puces et les mots importants en gras.

- Le résumé est **généré une seule fois** par vidéo puis stocké ; il n'est régénéré que si la transcription change. Plusieurs
  clics simultanés ne déclenchent qu'un seul appel.
- Fidélité : le modèle ne doit utiliser que le texte ; les repères de temps inexistants sont supprimés, le HTML retiré, la
  taille bornée. Une mention rappelle que le résumé est généré par IA et peut contenir des erreurs.
- Vidéos très longues : notes par partie, puis synthèse.
- Coût plafonné : 10 générations/heure/visiteur et 100/jour au total (`SUMMARY_PER_IP_HOURLY`, `SUMMARY_DAILY_CAP`) ; les
  résumés déjà stockés restent toujours lisibles. Modèle : `SUMMARY_MODEL`, sinon `SEARCH_MODEL`, sinon `TRANSLATE_MODEL`.

## Recherche par question

On peut saisir une phrase qui circule (« on va tout casser… ») **ou une question** (« est-ce que Lisnard a déjà parlé
de réémigration ? »). Pour une question, le site ne cherche pas la phrase entière : un modèle (OpenRouter) en extrait les
mots à chercher (« réémigration » + variantes d'orthographe que les sous-titres peuvent produire : « remigration »,
« ré-émigration »), puis ces mots sont cherchés dans les transcriptions.

- Le modèle **ne fait que choisir des mots-clés** : extraits, nombres et verdict viennent des transcriptions réelles, il ne
  peut rien inventer. Sa sortie est validée (8 mots max, nom de l'orateur et mots vides écartés) et la saisie est traitée
  comme une donnée, jamais comme une consigne.
- Une citation mot pour mot est trouvée **sans aucun appel au modèle** (le cas le plus fréquent).
- Les mots réellement recherchés sont affichés sous le verdict. Le verdict est « Oui, il en a parlé » : il dit que le mot est
  prononcé, pas ce que Lisnard en pense.
- Coût plafonné : cache 24 h, 30 appels/heure/visiteur, 300 appels/jour au total (`SEARCH_LLM_PER_IP_HOURLY`,
  `SEARCH_LLM_DAILY_CAP`). Au-delà, ou si le modèle est indisponible, repli automatique sans modèle (on retire « est-ce que »,
  « a-t-il déjà parlé de », le nom de l'orateur… et on cherche le reste).
- Modèle : `SEARCH_MODEL`, sinon `TRANSLATE_MODEL`, sinon le modèle par défaut.

## Traduction automatique

Supadata renvoie la première langue disponible quand la langue demandée (champ « Langue », `fr` par défaut)
n'existe pas pour la vidéo. Si `OPENROUTER_API_KEY` est configurée, la transcription est alors **traduite par un modèle économique via OpenRouter**
(horodatages conservés, texte d'origine gardé sous chaque segment dans l'éditeur). Sans clé, le texte d'origine est
conservé et signalé (badge « langue : en »), et un bouton « Traduire en français » apparaît dans l'éditeur.

Une traduction n'est pas ce qui a été dit : sur le site, une phrase trouvée uniquement dans une transcription traduite
n'est jamais affichée comme « Oui, il l'a dit » mais comme **« Trouvé dans une traduction »**, avec un avertissement.

Modèle : `google/gemini-2.5-flash-lite` par défaut ; change-le avec `TRANSLATE_MODEL` (identifiant OpenRouter, cf. https://openrouter.ai/models). Un identifiant invalide suspend le traitement avec un message explicite au lieu de faire échouer chaque vidéo.

## Synchronisation automatique des chaînes

Page **/admin/#/sync**. On y ajoute une chaîne YouTube ; le site :

1. liste tout son historique (API YouTube Data) et met les vidéos en **file d'attente** ;
2. récupère leurs transcriptions petit à petit (25 par passe, une passe toutes les 5 minutes) ;
3. vérifie ensuite **chaque jour** si de nouvelles vidéos sont sorties et les ajoute.

**Shorts.** Seules les vidéos longues sont importées : une vidéo est un Short si elle dure 60 s ou moins, ou si elle figure
dans la liste des Shorts de YouTube pour la chaîne (nécessaire car un Short peut durer jusqu'à 3 min ; cette liste repose sur
une playlist interne de YouTube non documentée officiellement, avec repli sur la durée si elle est introuvable). Option
« Exclure les Shorts » par chaîne (activée par défaut). Le bouton **Retirer les Shorts…** supprime ceux déjà importés, après un
aperçu et une confirmation ; les Shorts supprimés sont mémorisés et ne reviennent jamais. Les vidéos ajoutées à la main et celles
corrigées à la main ne sont jamais supprimées.

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
   | `OPENROUTER_API_KEY` | clé OpenRouter (traduction automatique des transcriptions, optionnelle) |
   | `TRANSLATE_MODEL` | modèle de traduction OpenRouter (optionnel) |
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
  openrouter.js      client OpenRouter minimal (traduction, recherche par question, résumés)
  summarize.js       résumé d'une transcription (repères de temps, 2 étapes si très long, nettoyage)
  summaries.js       résumés stockés en base, plafonds, anti-doublons
  budget.js          plafonds d'appels par visiteur / par jour
  query-understanding.js  extrait les mots-clés d'une question, plafonds de coût, repli sans modèle
  translate.js       traduction des segments via OpenRouter
  localize.js        récupère la transcription dans la langue demandée (traduit si besoin)
  sync.js            synchronisation : découverte des vidéos, file d'attente, planificateur
  youtube.js         extraction d'ID, métadonnées oEmbed
  auth.js            session admin (cookie signé HMAC), limiteur de tentatives
  routes/            API publique (/api/search…) et admin (/api/admin/…)
public/              site (index.html) et admin (admin/)
test/                tests unitaires + test d'intégration (si DATABASE_URL défini)
```
