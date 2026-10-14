# Lisnard Studio

**Plateforme dédiée à la création de TikTok / Reels** à partir d'extraits des interviews YouTube de David Lisnard : on choisit un extrait
(proposé par l'IA ou libre), on ajoute des sous-titres, de la musique, des zooms et des images, puis on télécharge la vidéo verticale.
La page d'accueil (`/`) est le studio ; les anciennes adresses `/studio/`, `/videos/` et `/tendances/` y redirigent (301, la requête
`?v=…` est conservée). Il n'y a plus de page publique de recherche, de liste de vidéos ni de tendances.

**Ce qui reste en place derrière le studio** : l'indexation des transcriptions (synchronisation des chaînes, Supadata, Whisper,
traduction, résumés automatiques), l'admin et les statistiques. Les adresses techniques de la recherche, des résumés et des
tendances (`/api/search`, `/api/summary/…`, `/api/trends…`) existent toujours côté serveur et ne sont plus liées depuis le site ; leur
code est conservé, au cas où.

> Le dépôt s'appelle encore `A-t-il-dit-a` et le domaine `lisnardfacts.fr` : seuls le nom affiché et le logotype changent.

*Historique : le site est né comme « Lisnard Facts », un fact-checking qui retrouve si une phrase a été prononcée dans une interview.
Les sections ci-dessous sur la recherche décrivent ce moteur, toujours présent côté serveur.*

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

## Studio de clips TikTok / Reels

Objectif : créer des vidéos verticales à partir des meilleurs extraits d'une interview, avec sous-titres stylés et musique. Les
sous-titres n'ont besoin ni d'IA ni d'API : on dessine le texte de la transcription, déjà horodaté. Le LLM (OpenRouter) ne sert
qu'à choisir les extraits.

**Côté admin (éditeur d'une vidéo, panneau « Clips TikTok ») :**

- **Fichier vidéo par vidéo** : tu télécharges la vidéo toi-même (de préférence en 720p) et tu la déposes dans l'éditeur de la
  vidéo, panneau « Clips TikTok ». Le dépôt se fait **par morceaux de 8 Mo** (reprise automatique après une coupure, pas de limite de
  durée de requête). ffprobe vérifie que c'est bien une vidéo (mp4, mov, mkv, webm) et **compare sa durée à celle de la vidéo
  YouTube** : un écart de plus de 3 s signale une autre version, dont les horaires seraient décalés.
- **Stockage** : sur disque, dans `STORAGE_DIR` (sur Railway : volume monté sur `/data`, 5 Go sur ce plan). Le fichier n'est jamais
  servi au public (l'aperçu de l'éditeur exige la session admin) ; il disparaît avec la vidéo ou via « Supprimer le fichier ».
- **Interrupteur « Autoriser les clips pour le public »**, par vidéo : tu choisis ce qui sera exposé, et tu ne dois autoriser que
  des vidéos dont tu peux diffuser des extraits (droits des chaînes d'origine).
- **Extraits proposés par l'IA** : les moments les plus susceptibles de devenir **viraux sur TikTok**, de 15 à 60 s, jusqu'à 20 par
  vidéo (au moins un toutes les 2 à 3 minutes d'interview quand c'est possible), avec titre factuel, raison et potentiel viral noté de 1
  à 10 ; les 6 premiers sont affichés, le reste sur demande. La consigne du modèle décrit ce qui marche sur TikTok : accroche immédiate,
  moment fort (position tranchée, émotion, punchline, anecdote, chiffre qui surprend, sujet qui parle à beaucoup de monde), idée courte et
  complète, idéalement 20 à 45 s. Le modèle ne choisit que des **numéros de lignes** de la transcription : les horaires viennent de la
  transcription et il ne peut ni inventer ni modifier un mot. Garde-fou de fidélité conservé : un extrait commence et finit sur une
  phrase entière et ne coupe jamais avant un « mais », une nuance, une réserve ou une condition qui change le sens. Résultats stockés ;
  ils sont signalés comme périmés si la transcription change. Modèle : `CLIP_MODEL`, par défaut `openai/gpt-4.1-mini` (sans raisonnement,
  environ 0,01 $ par interview), indépendant du modèle des résumés. Réglages : `CLIP_MAX_SUGGESTIONS` (20), `CLIP_MIN_S` (15),
  `CLIP_MAX_S` (60) ; certains extraits sont écartés ensuite (durée hors limites, chevauchement avec un mieux noté).
- **Description TikTok prête à copier-coller** : le même appel au modèle écrit, pour chaque extrait, une accroche (1–2 phrases, fidèle à
  l'extrait) et **2 à 4 hashtags**. Elle est générée **une seule fois**, avec les extraits, et stockée avec eux (aucun appel de plus quand
  un visiteur ouvre le studio). Les hashtags sont nettoyés côté serveur (2 à 4, sans doublon, repli `#lisnard #politique`). Les
  extraits générés avant cette version n'ont pas de description : il faut les régénérer depuis l'admin.
  Dans l'onglet « Créer », le bloc « Description à copier-coller » reprend la description de l'extrait choisi, suivie de la source et des
  crédits d'images ; elle reste modifiable.
- **Bibliothèque de musiques** (admin → « Musique ») : l'admin dépose ses propres morceaux (MP3, M4A, WAV, OGG, FLAC ; 8 s à 10 min, 40 Mo),
  avec titre, catégorie (motivant, épique, cinématique, autres) et crédit facultatif, et confirme avoir le droit de les utiliser. Le
  serveur vérifie le fichier, le convertit en MP3 stéréo et **égalise le volume** (−16 LUFS, pour que tous sonnent pareil sous la voix ;
  5 minutes conservées), puis le range sur le volume (`<STORAGE_DIR>/music/`, catalogue dans les tables `studio_music` et
  `studio_music_hidden`). Les morceaux apparaissent aussitôt dans l'onglet « Musique » du studio ; on peut les masquer, les renommer, les
  recatégoriser ou les supprimer, et masquer les morceaux d'origine. Les musiques « tendance » de TikTok ne sont pas disponibles : elles
  sont réservées à l'application TikTok (on peut les ajouter à la vidéo dans TikTok, après le partage).
- **Bouton « Publier sur TikTok »** (une fois le clip prêt) : sur téléphone, la vidéo est **préchargée dès qu'elle est prête** (le
  navigateur n'autorise le partage que dans la seconde qui suit le clic : télécharger le fichier après le clic le faisait échouer) ; le
  clic copie la description et ouvre aussitôt la fiche de partage du téléphone, où TikTok apparaît avec la vidéo. Si la fiche ne peut pas
  s'ouvrir, la vidéo est enregistrée et l'appli TikTok est ouverte (lien `snssdk1233://`, avec repli sur le site sous Android). Sur
  ordinateur, le bouton ouvre `tiktok.com/upload`, télécharge la vidéo et copie la description. Le partage fait depuis le téléphone est
  compté par `POST /api/studio/render/:id/used`. La publication **automatique** n'est pas faite : l'API TikTok « Content Posting »
  exige une application TikTok validée (audit) et, sans elle, ne publie qu'en privé.
- **Studio public** (`/studio/`) : les visiteurs choisissent une interview dont l'admin a autorisé les clips, prennent un ou
  plusieurs extraits (jusqu'à 4, 90 s au total : les propositions de l'IA, ou un passage libre dans la transcription), ajustent le
  début et la fin **avec précision**, puis habillent le clip :
  - **réglage des bornes** : boutons − / + avec un pas au choix (0,1 s, 0,5 s par défaut, 1 s, 2 s, « Ligne » = jusqu'à la limite de ligne
    suivante, ou n'importe quelle durée de 0,01 à 30 s dans le champ libre) ; on peut aussi **taper l'instant exact** (`1:23,5`).
    Les bornes sont en millisecondes (arrondies au centième de seconde) ; une ligne coupée au milieu ne garde que les mots dits dans la
    partie conservée, à leur horaire d'origine ;
  - **5 styles TikTok** : mots en surbrillance, un mot à la fois, karaoké, classique, sur fond sombre ;
  - **réglages** : police (22 polices libres dans `public/fonts/studio/`), taille, couleur du texte et du mot actif, contour
    (épaisseur et couleur), ombre, fond sombre (couleur, opacité et **arrondi**, de l'angle droit aux bords entièrement ronds), majuscules, mots affichés à la fois, largeur, animation « pop » ;
  - **position** : on **glisse les sous-titres** directement sur l'aperçu (ou boutons Haut / Milieu / Bas / Centrer). Pendant le
    glissement, des **repères pointillés** montrent le centre de l'écran ; le bloc s'**aimante** au centre horizontal et vertical, et
    les repères s'allument en rose quand il est exactement centré (petite vibration au toucher) ;
  - **texte des sous-titres** (onglet Sous-titres › Texte) : on corrige les mots mal reconnus ligne par ligne, avec le clip qui se place
    sur la ligne (bouton ▶ avec son horodatage). **L'horodatage d'origine est toujours conservé** : la ligne garde son début et sa fin,
    et les mots corrigés (plus ou moins nombreux) sont répartis sur la même durée. Une ligne vidée n'affiche aucun sous-titre. Les
    corrections ne concernent que ce clip : la transcription du site n'est jamais modifiée (elles sont gardées dans le navigateur, par
    interview, tant que la transcription ne change pas). Un avertissement s'affiche si une ligne s'éloigne beaucoup de la transcription
    (`lineSimilarity` < 60 %, pluriels et accents ignorés) et l'engagement à ne pas déformer les propos couvre les sous-titres corrigés.
    Côté serveur : `edits` = `{ "<début de la ligne en ms>": "texte" }`, 300 lignes et 500 caractères par ligne au maximum ;
  - **musique** : la **bibliothèque de l'admin** (voir ci-dessous) et 10 morceaux originaux libres de droits (`tools/make_studio_music.py`),
    classés par catégorie (motivant, épique, cinématique, autres) avec écoute ▶, volumes de la musique et de la voix ; le crédit d'un
    morceau de la bibliothèque est ajouté à la description à copier ;
  - **cadrage 9:16** : vidéo entière sur fond flou, ou **plein écran** recadré : on **glisse la vidéo** vers la gauche ou la droite sur
    l'aperçu pour recentrer sur la personne (un curseur permet d'affiner). L'aperçu plein écran est la vidéo entière recadrée en direct
    par le navigateur avec la même formule que le rendu (`décalage = (largeur de la vidéo − largeur de l'écran) × position`), donc
    aucun calcul serveur pendant le glissement ;
  - **cadrage automatique sur le visage** (plein écran) : le cadre **suit la personne** au lieu de rester fixe. Les visages sont repérés
    **une fois par interview**, côté serveur (admin → fiche de la vidéo → « Cadrage automatique sur le visage » ; lancé tout seul au dépôt
    de la vidéo, à relancer pour les vidéos déjà déposées). Détecteur YuNet (OpenCV Zoo, licence MIT) : **une image toutes les 0,2 s**
    (une toutes les 0,4 s au-delà d'1 h 30) en 384 px, soit environ 0,2 s de calcul par seconde de vidéo (une heure d'interview : une
    douzaine de minutes en arrière-plan) ; un visage doit faire au moins ~5 % de la largeur de l'image (les plans très larges ne sont pas
    suivis). Les **changements de plan** sont repérés en même temps (ffmpeg, `scene`). Ensuite chaque clip n'a plus qu'à calculer la
    trajectoire (`public/js/framing.js`, module pur partagé avec le navigateur) : un visage suivi par plan (David Lisnard s'il est reconnu,
    sinon le plus gros, ou celui de gauche / de droite au choix), un cadre qui reste immobile tant que le visage reste près du centre puis
    se déplace en douceur (départ et arrivée progressifs, vitesse et accélération bornées), et qui saute directement sur le visage du
    nouveau plan à chaque coupe de montage. Le rendu applique la même courbe image par image (`crop` avec `exact=1`) ; l'aperçu la rejoue
    en direct. Sans visage trouvé ou sans analyse, le cadre manuel s'applique. Coupure : `STUDIO_FACES=off`. Table `video_faces` (résultat
    par vidéo, invalidé si le fichier est remplacé).
  - **reconnaissance de David Lisnard** : dans l'admin, onglet « Reconnaissance », on donne une vingtaine de photos de lui (une personne par
    photo, visage d'au moins 50 px). Chaque photo est réduite à une **empreinte de 128 nombres** (modèle SFace d'OpenCV Zoo, licence Apache
    2.0) et à une vignette redressée pour vérification ; les photos elles-mêmes ne sont pas conservées. Une photo qui ne ressemble à
    aucune autre est signalée « à vérifier » (mauvaise personne ?). À l'analyse d'une interview, les visages des **plans à plusieurs
    personnes** (journaliste, public) sont comparés aux photos (quelques images de chaque visage, prises dans la vidéo) ; le studio suit
    alors David Lisnard plutôt que le visage le plus gros. Seuil : similarité cosinus 0,363 (valeur recommandée pour SFace) ; la
    ressemblance d'un visage est la moyenne de ses trois meilleures similarités avec les photos. Quand les photos changent, les vidéos déjà
    analysées passent à « reconnaissance à mettre à jour » : le bouton de l'onglet relance seulement la reconnaissance, sans refaire la
    détection. Tables `face_references` et `video_faces.ident`. La détection et la reconnaissance tournent dans un thread séparé, avec un
    petit moteur de réseaux de neurones écrit pour l'occasion (`nn.js`, noyaux WebAssembly SIMD de `tools/kernels.wat` assemblés par
    `tools/build_kernels.mjs`) : aucune bibliothèque native à installer, 7 fois plus rapide que du JavaScript seul, mêmes résultats
    qu'ONNX Runtime (à 10⁻⁶ près, vérifié).
  - **miroir** : retourne l'image gauche-droite. Il est appliqué après le cadrage et avant l'incrustation : les sous-titres
    ne sont jamais retournés (en revanche les textes visibles dans l'image le sont). Il ne change pas les droits sur la
    vidéo d'origine ;
  - **b-roll** (onglet B-roll) :
    - **zooms** sur les mots importants : un zoom avant juste avant chaque mot repéré (chiffres, mots longs ou rares, absolus comme
      « jamais », mots repris), un zoom arrière un peu après ; au plus un zoom tous les 6 s, jamais deux collés. « Placer
      automatiquement » les propose, et l'utilisateur les **choisit lui-même** : ajouter un zoom avant / arrière à l'instant de l'aperçu,
      changer l'instant (champ à taper, `0:12,5`) ou le type, en supprimer, régler la force (léger 1,10 / moyen 1,20 / fort 1,32) et
      cliquer sur l'aperçu pour choisir le **point de zoom** (par défaut à hauteur de visage). Les sous-titres et les images ne zooment pas ;
    - **mouvement sans saccade** : le zoom est une courbe en S continue (vitesse nulle au départ et à l'arrivée) décrite par des événements
      qui s'enchaînent toujours à partir du niveau atteint. Le rendu n'utilise **pas** le filtre `zoompan` de ffmpeg (il déplace sa
      fenêtre par pas entiers de pixels : saccades connues) mais `perspective`, dont les coins de fenêtre sont des nombres décimaux
      (interpolation au sous-pixel, 4 coins évalués à chaque image à partir du compteur d'images, sans dérive). Mesuré sur de vraies
      images : écart avec la courbe idéale < 0,2 px, contre plusieurs pixels et une irrégularité 10 fois plus forte avec `zoompan`
      (test `studio.test.js`). Le filtre n'est actif (`enable`) que pendant les zooms : le reste du clip n'est pas retraité (le filtre
      coûte environ 0,4 s de calcul par seconde de vidéo 1080 × 1920) ;
    - **aperçu identique** : le navigateur calcule la même courbe (`zoomAt` dans `studio-core.js`, partagé avec le rendu) et l'applique
      en `transform` à la vidéo seule ; écart avec le MP4 final de 2 à 3 px mesuré ;
    - **images** libres de droits (**Pixabay** ou Pexels) : recherche (mots du clip proposés), un appui ajoute l'image à l'instant de
      l'aperçu (2,5 s par défaut, 1 à 8 s, début et durée modifiables, 8 images au plus, sans chevauchement). Image plein écran par-dessus la
      vidéo pendant que la voix continue, fondu de 0,18 s et très léger zoom lent (même technique). Les crédits des auteurs sont
      ajoutés au texte « Source à citer ». Il faut une clé gratuite : `PIXABAY_API_KEY` (https://pixabay.com/api/docs/, ouverte à tous
      après inscription) ou `PEXELS_API_KEY` (Pexels a suspendu l'ouverture de nouvelles clés) ; sans clé, la section images est
      désactivée. Pixabay est choisi s'il a une clé (`STOCK_PROVIDER=pexels` pour forcer l'autre). La clé reste sur le serveur, qui
      interroge le fournisseur ; le navigateur ne donne qu'un **numéro** de photo, jamais une adresse. Le serveur retrouve l'adresse
      auprès du fournisseur, vérifie qu'elle est en https sur ses serveurs d'images (`pixabay.com`, `cdn.pixabay.com`,
      `images.pexels.com` ; les redirections sont suivies une à une et vérifiées, jamais vers un autre site), contrôle type et taille
      (15 Mo), garde le fichier dans `STORAGE_DIR/stock` (supprimé après une heure). Les vignettes des résultats sont l'adresse
      temporaire fournie (valable 24 h, usage prévu par Pixabay) ; les images utilisées sont téléchargées par le serveur, jamais
      appelées en direct. Recherches et téléchargements sont limités par visiteur (`STOCK_SEARCHES_PER_HOUR`,
      `STOCK_DOWNLOADS_PER_HOUR`). Licences : gratuit, y compris en usage commercial, crédit non obligatoire ;
  - **téléphone** : l'aperçu reste collé en haut de l'écran pendant qu'on règle (44 % de la hauteur, avec la barre de lecture à côté), et un
    bouton « Agrandir » le montre presque plein écran pour vérifier le rendu. Le titre de l'interview est dans le bandeau bleu (jamais coupé,
    même sur plusieurs lignes) et le texte d'accueil est masqué dans l'éditeur pour ne pas repousser l'aperçu. La mise en page du
    navigateur d'ordinateur n'est pas modifiée (breakpoint 900 px) ;
  - **aperçu en direct** : la vidéo (cadrage seul, 360 × 640) vient du serveur, les sous-titres sont dessinés par le navigateur avec
    le **même code** que le rendu (`public/js/studio-core.js`) : horaires des mots, groupes, tailles, réduction des mots trop
    longs. Vérifié image par image contre le MP4 final.
- **Rendu** : ffmpeg sur le serveur, sous-titres incrustés (ASS/libass), musique mixée sous la voix, MP4 H.264 + AAC en 1080 × 1920
  (ou 720 × 1280). **File d'attente** (`STUDIO_CONCURRENCY` clips à la fois, 1 par défaut ; `STUDIO_MAX_QUEUE`), limites par visiteur
  (2 clips en cours, `STUDIO_RENDERS_PER_HOUR` par heure, `STUDIO_PREVIEWS_PER_HOUR` aperçus), progression, annulation. Les clips
  sont **supprimés une heure** après leur création. Le fichier vidéo d'origine n'est jamais servi : seuls ces extraits sortent.
- **Statistiques** (admin → « Studio ») : clips créés, **téléchargés** (clic sur « Télécharger »), partagés (partage depuis le téléphone) et
  personnes ayant récupéré leur clip, pour aujourd'hui, 7 jours, 30 jours et depuis le début, avec la courbe des 14 derniers jours et les
  interviews les plus utilisées (table `studio_events`). Un clip compte une fois par type, même téléchargé plusieurs fois ; la lecture du
  clip dans la page n'est pas un téléchargement (le lien porte `?use=download`, le partage `?use=share`). Les personnes sont comptées
  avec une empreinte irréversible de l'adresse IP (HMAC avec `SESSION_SECRET`) : l'adresse n'est jamais stockée, l'empreinte est effacée
  après 90 jours (les compteurs restent) ; c'est une approximation (même connexion = une personne). Les mentions légales le décrivent.
- **Garde-fous** : la vidéo n'affiche plus de bandeau « Source » (choix de l'éditeur : la source va dans la description de la publication) ;
  l'onglet Créer prépare ce texte (« Source : titre · date — lien de l'interview ») avec un bouton Copier. Les sous-titres sont ceux
  de la transcription (corrections éventuelles signalées si elles s'en éloignent), et il faut cocher un engagement à ne pas
  déformer les propos avant de créer.
- **Fond des sous-titres** : libass ne sait pas arrondir son fond rectangulaire, et il le double de teinte là où deux lignes se
  chevauchent. Le fond est donc **dessiné** (tracé vectoriel ASS, un seul tracé pour toutes les lignes, une seule teinte) d'après la
  position de chaque ligne, **mesurée par libass lui-même** : `src/studio/box-probe.js` fait rendre chaque groupe de mots sur un fond
  noir avec un fond blanc rectangulaire de 1 px de marge, puis lit les largeurs de ligne sur l'image (mêmes polices, même mise à la
  ligne, même crénage que le clip). Aucune largeur de police n'est estimée. La mesure se fait dans la file d'attente, juste avant le
  rendu (environ 0,2 s). L'aperçu dessine le même tracé (SVG) à partir des mots tels que le navigateur les a placés ; le rayon du coin
  est `arrondi × (moitié de la hauteur d'une ligne de fond)`.
- **Taille des sous-titres** : la « taille » d'un style est une taille d'em (comme une `font-size`). libass dessine un texte de taille
  ASS N avec une em de N × `unitsPerEm / (winAscent + winDescent)` (mesuré, écart < 1 %) : `buildAss` convertit par police grâce à
  `em_ratio` (dans `src/studio/fonts.json`, calculé par `tools/fetch_studio_fonts.py`).
- **Limites connues** : les horaires des mots sont estimés (la durée de chaque ligne est répartie selon la longueur des mots) car
  nos transcriptions n'ont pas d'horaires au mot ; le karaoké remplit mot par mot dans l'aperçu et progressivement dans le MP4 ;
  l'état des clips est en mémoire (un redémarrage du serveur annule les créations en cours).
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
  par partie, puis synthèse. Modèle : `SUMMARY_MODEL`, par défaut GPT (`openai/gpt-4.1-mini`, comme les extraits du studio) ; la traduction et la recherche gardent leurs propres modèles (`TRANSLATE_MODEL`, `SEARCH_MODEL`). Les résumés déjà faits ne sont jamais refaits.

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
*Studio* » (police Fraunces, fichiers dans `public/fonts/`, licence OFL ; « Lisnard » en bleu, « Studio » en rose italique).
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
  studio/            studio public : rendu ffmpeg (render.js), détection et reconnaissance des visages (faces.js, faces-worker.js, yunet.js, sface.js, identity.js, references.js, nn.js), mesure du fond des sous-titres (box-probe.js), images libres de droits Pixabay / Pexels (stock.js), polices (fonts.json), musiques d'origine et bibliothèque de l'admin (music.json, music.js)
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
