# Lisnard Facts

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

## Vidéos sans sous-titres : transcription locale gratuite (Whisper)

Quand YouTube n'a aucun sous-titre pour une vidéo (« Pas de sous-titres disponibles »), Supadata ne peut rien renvoyer. Pour une
vidéo **récente**, la synchro réessaie toute seule (les sous-titres automatiques arrivent parfois après quelques heures). Pour une
vidéo plus ancienne, `tools/transcribe.py` la transcrit **gratuitement sur ton ordinateur** : `yt-dlp` télécharge l'audio,
**Whisper** (via `faster-whisper`, libre) le transcrit en local, et le résultat est envoyé à l'admin du site. Aucun crédit
n'est dépensé, et ça fonctionne même sur des vidéos sans aucun sous-titre.

```bash
pip install -r tools/requirements.txt          # Python 3.10+ ; aucun ffmpeg à installer

# toutes les vidéos « en échec » de la page Synchronisation
python tools/transcribe.py --site https://TON-SITE.up.railway.app --all-failed

# une vidéo précise (ajoutée au site si elle n'y est pas)
python tools/transcribe.py --site https://TON-SITE.up.railway.app https://www.youtube.com/watch?v=XXXXXXXXXXX
```

Le mot de passe de l'admin est lu dans `ADMIN_PASSWORD`, sinon demandé (ne l'écris dans aucun fichier du dépôt).
Options utiles : `--model` (`tiny`, `base`, **`small`** par défaut, `medium`, `large-v3`, `large-v3-turbo` : plus le modèle est gros,
plus c'est précis, mais lent sans carte graphique), `--srt-dir dossier --no-upload` (écrit des fichiers `.srt` sans rien envoyer, à coller
dans l'éditeur si tu préfères), `--cookies-from-browser chrome` (si YouTube refuse le téléchargement), `--prompt` (noms propres à bien
orthographier : « David Lisnard, Cannes, Nouvelle Énergie… » par défaut).

**Si le modèle ne se télécharge pas** (erreurs « connexion fermée » vers `huggingface.co`) : le modèle Whisper est hébergé sur
Hugging Face, que certains réseaux, VPN, antivirus ou pare-feu bloquent. Le script le dit avant de télécharger la moindre vidéo.
Réessaie plus tard ou depuis un autre réseau ; sinon télécharge les fichiers du modèle avec ton navigateur
(<https://huggingface.co/Systran/faster-whisper-small/tree/main> : `config.json`, `preprocessor_config.json`, `model.bin`,
`tokenizer.json`, `vocabulary.txt`) dans un dossier, puis ajoute `--model C:\whisper-small` (le chemin de ce dossier) à la commande.

Garde-fous : une vidéo qui a déjà une transcription n'est **jamais** retouchée (sauf `--overwrite`, à éviter : il écraserait tes
corrections) ; une transcription Whisper n'est pas marquée « corrigée » ; une vidéo en échec passe à « transcrite » ; une vidéo en échec
n'empêche pas les suivantes. À lancer sur **ton ordinateur** et pas sur Railway (calcul lourd, et YouTube bloque les téléchargements depuis
les serveurs). Comme les sous-titres automatiques, la transcription peut contenir des erreurs (noms propres) : corrige-les dans l'éditeur.
Note : télécharger des vidéos YouTube sort du cadre des conditions d'utilisation de la plateforme ; c'est ici un usage personnel pour
vérifier des propos publics, à ta charge.

## Toutes les vidéos

Sous les dernières vidéos, le bouton **Voir toutes les vidéos (N)** ouvre `/videos/` : le catalogue complet des vidéos
**indexées** (celles qui ont une transcription, hors Shorts), de la plus récente à la plus ancienne, avec filtre par titre ou
chaîne (sans accents ni casse), tri, pagination « Voir plus » et le même bouton **Afficher le résumé**. « Indexée » veut dire « transcrite » :
c'est le même critère pour le compteur de l'accueil, « Dernières vidéos » et ce catalogue, donc les nombres concordent. Une vidéo en
attente de transcription (ou en échec) n'apparaît pas tant qu'elle n'est pas transcrite.

## Tendances

La page **/tendances/** est le « Google Trends » de David Lisnard : on tape un mot ou une expression (ou jusqu'à 4, séparés par des
virgules, pour les comparer) et le site trace combien de fois il l'a prononcé, **mois par mois** (par année au-delà de 5 ans
d'historique).

- **Base de calcul** : les vidéos indexées (transcrites, hors Shorts) **datées** et **non traduites automatiquement** (une
  traduction ne contient pas les mots réellement prononcés). Les vidéos écartées (traduites, sans date) sont comptées et signalées
  sous le graphique.
- **Comptage** : mots entiers, sans accents ni casse, avec le pluriel en « s » ou « x » (« migrant » compte aussi « migrants »,
  mais pas « migrantes » ni « immigration »). Une expression (« dette publique ») est comptée telle quelle, mots dans l'ordre.
- **Deux mesures** : *Mentions* (nombre brut ; c'est la vue par défaut à chaque nouvelle recherche, courbe continue) et *Fréquence* (mentions pour 10 000 mots
  prononcés ce mois-là, comparable d'un mois à l'autre même si le nombre de vidéos varie ; une période sans vidéo n'a pas de point
  plutôt qu'un faux zéro, donc la courbe peut être coupée). L'adresse garde le choix (`?m=rate` pour la fréquence).
- **Détail par mot** : total, nombre de vidéos, première et dernière apparition, mois record, les 8 vidéos où il revient le plus
  (liens YouTube) et un lien « Voir les extraits » vers la recherche.
- **Classement « Ses mots les plus prononcés »**, comme point de départ : podium des 3 premiers, barres pour les 12 suivants, puis
  les autres en pastilles ; un clic ouvre la courbe du mot. Les mots creux (adverbes, verbes courants, « et cetera »,
  « ailleurs », « aujourd'hui »…) sont écartés grâce à la liste `src/trend-stopwords.js` : si un mot inutile apparaît, il suffit de
  l'y ajouter. Les mots s'affichent avec leurs accents d'origine.
- Le graphique (SVG sans bibliothèque) a un curseur avec infobulle (souris, doigt ou flèches du clavier), un tableau des chiffres
  et des couleurs vérifiées pour le daltonisme (`--chart-1` à `--chart-4` dans `theme.css`).
- L'API (`GET /api/trends?q=…`, `GET /api/trends/words`) met ses résultats en cache 5 minutes (invalidés dès qu'une vidéo change) et
  limite le calcul à 120 requêtes par heure et par visiteur.

## Studio de clips TikTok / Reels (en construction)

Objectif : créer des vidéos verticales à partir des meilleurs extraits d'une interview, avec sous-titres stylés et musique. Les
sous-titres n'ont besoin ni d'IA ni d'API : on dessine le texte de la transcription, déjà horodaté. Le LLM (OpenRouter) ne sert
qu'à choisir les extraits. **Étape actuelle (admin) :**

- **Fichier vidéo par vidéo** : tu télécharges la vidéo toi-même (de préférence en 720p) et tu la déposes dans l'éditeur de la
  vidéo, panneau « Clips TikTok ». Le dépôt se fait **par morceaux de 8 Mo** (reprise automatique après une coupure, pas de limite de
  durée de requête). ffprobe vérifie que c'est bien une vidéo (mp4, mov, mkv, webm) et **compare sa durée à celle de la vidéo
  YouTube** : un écart de plus de 3 s signale une autre version, dont les horaires seraient décalés.
- **Stockage** : sur disque, dans `STORAGE_DIR` (sur Railway : volume monté sur `/data`, 5 Go sur ce plan). Le fichier n'est jamais
  servi au public (l'aperçu de l'éditeur exige la session admin) ; il disparaît avec la vidéo ou via « Supprimer le fichier ».
- **Interrupteur « Autoriser les clips pour le public »**, par vidéo : tu choisis ce qui sera exposé, et tu ne dois autoriser que
  des vidéos dont tu peux diffuser des extraits (droits des chaînes d'origine).
- **Extraits proposés par l'IA** : 20 à 60 s, jusqu'à 8 par vidéo, avec titre factuel, raison et note. Le modèle ne choisit que des
  **numéros de lignes** de la transcription : les horaires viennent de la transcription et il ne peut pas inventer ni modifier un
  mot. Consignes éditoriales : extraits compréhensibles seuls, qui commencent et finissent sur une phrase entière sans couper avant
  une nuance, choisis pour la clarté et non pour le côté polémique. Résultats stockés ; ils sont signalés comme périmés si la
  transcription change. Modèle : `CLIP_MODEL`, sinon celui des résumés.
- **Prochaines étapes** : éditeur public (sous-titres : style, position, taille ; musique libre de droits) et rendu du MP4 avec
  ffmpeg sur le serveur (file d'attente, limite de clips simultanés, suppression rapide des fichiers produits).
- **Sur Railway** : le volume est monté sur `/data` (`STORAGE_DIR=/data/storage`) et ffmpeg est installé dans l'image grâce à la
  variable `NIXPACKS_APT_PKGS=ffmpeg` (le constructeur réellement utilisé est Nixpacks, comme l'indique `railway.json`).

## Dernières vidéos et résumés

L'accueil affiche, en grille, les **5 dernières vidéos par date de publication** : celles des chaînes suivies **et** celles ajoutées à la
main dans l'admin (seules celles qui ont une transcription apparaissent). Avec `YOUTUBE_API_KEY`, une vidéo ajoutée à la main
récupère sa date de publication toute seule ; sinon, renseigne la date dans l'éditeur (bouton « Mettre à jour depuis YouTube »
pour les vidéos existantes).

Chaque vidéo indexée a son **résumé, rédigé automatiquement** par un modèle (OpenRouter) à partir de la transcription : un
« En bref », puis des sections avec repères de temps cliquables, des puces et les mots importants en gras. Sous chaque vidéo,
le bouton **Afficher le résumé** ouvre une fenêtre (fond flouté ; on la ferme avec la croix, en cliquant à côté ou avec Échap) qui ne fait que lire ce résumé déjà stocké en base ; tant qu'il n'est pas prêt, le bouton est grisé
(**Résumé en préparation…**).

- **Génération en arrière-plan** : toutes les 2 minutes, le serveur résume les vidéos indexées qui n'ont pas encore de résumé
  (les plus récentes d'abord, 5 par passe), quelle que soit l'origine de la transcription (synchro de la chaîne, ajout manuel,
  import, Whisper, correction à la main). Un délai de grâce de 3 minutes après la dernière modification évite de résumer pendant
  que tu corriges la transcription. `SUMMARY_AUTO=false` désactive ce travail.
- **Le public ne déclenche rien** : la route publique est en lecture seule, donc le trafic du site ne coûte aucun appel au modèle.
- **Une seule fois par vidéo** : seules les vidéos qui n'ont **pas encore** de résumé sont traitées. Un résumé existant n'est
  jamais refait automatiquement, ni si la transcription est corrigée ensuite, ni si les consignes de rédaction évoluent. Dans
  l'admin, l'éditeur signale simplement « la transcription a été modifiée depuis » ; pour refaire un résumé, il faut cliquer sur
  « Régénérer avec l'IA » (avec confirmation).
- **Échecs** : nouvelle tentative après 30 min, 1 h, 2 h, 4 h, puis abandon au bout de 5 essais (visible dans l'admin, bouton
  « Réessayer »). Clé refusée ou crédits épuisés : tout est suspendu 3 h (clé) ou 1 h (crédits) au lieu d'insister ; trois échecs
  d'affilée arrêtent aussi la passe.
- **Coût borné** : plafond de `SUMMARY_DAILY_CAP` résumés par jour (500 par défaut) et `SUMMARY_PER_CYCLE` par passe (5). Le
  premier déploiement résume tout le catalogue existant, vidéo après vidéo : compte quelques centimes par vidéo selon le modèle.
  Mise en pause possible à tout moment depuis **Admin → Synchronisation → Résumés automatiques**.
- **Admin** : compteurs (prêts / en attente / en échec), pause et reprise, « Lancer maintenant », liste des échecs.
- **Corriger un résumé à la main** : dans l'éditeur d'une vidéo, le panneau « Résumé IA » contient le texte du résumé (même format :
  `## En bref`, `## [12:34] Titre` pour un repère de temps cliquable, `- puce`, `**gras**`). Après « Enregistrer le résumé », il
  s'affiche tel quel sur le site avec la mention « généré par IA puis corrigé à la main » et reste tel quel (comme tout résumé
  existant, il n'est jamais refait automatiquement). Tu peux aussi l'écrire entièrement toi-même. Seul « Régénérer avec l'IA » le
  remplace, après confirmation. Le texte est nettoyé comme celui de l'IA (HTML et liens retirés).
- Fidélité : le modèle ne doit utiliser que le texte ; les repères de temps inexistants sont supprimés, le HTML retiré, la
  taille bornée. Une mention rappelle que le résumé est généré par IA et peut contenir des erreurs. Vidéos très longues : notes
  par partie, puis synthèse. Modèle : `SUMMARY_MODEL`, sinon `SEARCH_MODEL`, sinon `TRANSLATE_MODEL`.

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
aperçu et une confirmation ; les Shorts supprimés sont mémorisés et ne reviennent jamais. Le bouton **Durée minimale…** écarte aussi les vidéos plus courtes qu'un seuil (181 s retire tous les Shorts, même de
1 à 3 min) ; « Retirer les Shorts… » applique ce seuil aux vidéos déjà importées. La durée est affichée sur l'accueil et
dans l'admin, et l'accueil masque toute vidéo de 60 s ou moins. Les vidéos ajoutées à la main et celles
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

Le site public ne contient aucun lien vers l'admin : accède-y directement par `/admin/` (mets l'adresse en favori).
La page **/mentions-legales/** (lien dans le pied de page) est un fichier statique, `public/mentions-legales/index.html` : éditeur
anonyme (particulier, identité communiquée à l'hébergeur, LCEN art. 6 III 2°), hébergeur, contact par e-mail, fonctionnement du
site, sources et données personnelles. Elle est rédigée d'après le fonctionnement réel du site ; à faire relire et à mettre à jour
si celui-ci change (cookies, statistiques, publicité…).

## Charte graphique

Reprise de https://www.unenouvelleenergie.fr/ : bleu `#1d257a`, chamois `#b0ad85`, rose `#d0165f`,
police Montserrat (fichiers dans `public/fonts/`). Le logo officiel n'est volontairement pas utilisé : le site a son propre logotype « Lisnard
*Facts* » (police Fraunces, fichiers dans `public/fonts/`, licence OFL ; « Lisnard » en bleu, « Facts » en rose italique).
Tout est dans [`public/css/theme.css`](public/css/theme.css) ; `app.css` et `admin.css` n'utilisent que ces variables.

## Structure

```
src/
  server.js          app Express
  db.js, schema.sql  Postgres : vidéos + segments (index de recherche recalculé à chaque sauvegarde)
  normalize.js       normalisation du texte (indexation et requêtes)
  search.js          recherche exacte / approchée, extraits et surlignage
  transcripts.js     Supadata + parseurs SRT/VTT/texte
tools/transcribe.py  transcription locale gratuite (yt-dlp + Whisper) des vidéos sans sous-titres, envoyée au site
  openrouter.js      client OpenRouter minimal (traduction, recherche par question, résumés)
  summarize.js       résumé d'une transcription (repères de temps, 2 étapes si très long, nettoyage)
  media.js           fichiers vidéo du studio : dépôt par morceaux, ffprobe, stockage
  clip-suggestions.js  extraits proposés par le LLM (numéros de lignes, horaires issus de la transcription)
  trends.js          tendances : comptage des mots par mois, mots les plus prononcés, cache et limites
  summaries.js       résumés stockés en base : lecture publique, génération, anti-doublons
  auto-summaries.js  génération automatique en arrière-plan (file, délai de grâce, reprises, plafonds, pause)
  budget.js          plafonds d'appels par visiteur / par jour
  query-understanding.js  extrait les mots-clés d'une question, plafonds de coût, repli sans modèle
  translate.js       traduction des segments via OpenRouter
  localize.js        récupère la transcription dans la langue demandée (traduit si besoin)
  sync.js            synchronisation : découverte des vidéos, file d'attente, planificateur
  youtube.js         extraction d'ID, métadonnées oEmbed
  auth.js            session admin (cookie signé HMAC), limiteur de tentatives
  routes/            API publique (/api/search…) et admin (/api/admin/…)
public/              site (index.html, videos/, tendances/, mentions-legales/) et admin (admin/)
test/                tests unitaires + test d'intégration (si DATABASE_URL défini)
```
