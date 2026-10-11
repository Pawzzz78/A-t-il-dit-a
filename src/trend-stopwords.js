/**
 * Mots écartés du palmarès « Ses mots les plus prononcés » : tout ce qui est courant à l'oral sans dire de quoi on parle
 * (mots-outils, adverbes, verbes très courants, mots creux, noms et adjectifs génériques).
 * Écrits sans accents, comme le texte indexé. On garde les mots qui portent un sujet (« politique », « énergie », « école »…).
 * Le pluriel « s » / « x » est géré par le code : inutile de lister « grandes » si « grande » y est… sauf accord irrégulier.
 */
const LISTS = {
  // connecteurs, adverbes, prépositions
  liaisons:
    'alors aussi ainsi ailleurs aujourd bientot cependant certes desormais dedans dehors depuis devant derriere donc durant ' +
    'encore enfin ensuite entre environ exactement finalement forcement generalement habituellement hier jamais jusqu justement ' +
    'lorsqu lorsque maintenant malgre meme mieux moins notamment parfois parmi partout pendant plutot pourtant presque puisqu ' +
    'puisque quand quant quelquefois quoique rarement seulement simplement soudain souvent surtout tandis tellement toujours ' +
    'toutefois vraiment demain autant autrement bref certainement evidemment effectivement apres avant avec chez comme contre ' +
    'dessous dessus dans selon sinon sous vers voici voila deja ici peut-etre peutetre quasiment probablement uniquement ' +
    'tres trop assez beaucoup peu plus tant tout tous toute toutes rien jamais pourquoi comment combien parce',
  // pronoms, déterminants
  pronoms:
    'cela celle celles celui ceux cette chacun chacune chaque lequel laquelle lesquels lesquelles leurs leur quelque quelques ' +
    'quelqu quels quelle quelles plusieurs certains certaines autres autre memes notre votre nous vous elles eux ceci',
  // verbes très courants (formes de 5 lettres et plus)
  verbes:
    'avoir avons avez avait avais avaient aurait auront aurons ayant etais etait etaient serait seront serons soyons sommes etes ' +
    'etant ete etre faire fais fait faites faisons faisait font faudrait faudra faut falloir faisant dire dis dit dites disons ' +
    'disait disent dirait disant pouvoir peut peux peuvent pouvons pouvez pourrait pourrions pouvait pouvaient puisse puissent ' +
    'vouloir veut veux veulent voulons voulez voudrais voudrait voulait devoir doit doivent devons devez devrait devrions ' +
    'savoir sais sait savons savez saurait sachant aller vais vont allons allez allait irait voir vois voit voyons voyez verra ' +
    'venir vient viens viennent venons venez venait prendre prend prends prennent prenons prenez prenait donner donne donnes ' +
    'donnent donnons donnez donnait mettre mets mettent mettons mettez mettait parler parle parles parlent parlons parlez ' +
    'parlait penser pense penses pensent pensons pensez pensait passer passe passes passent passons passez passait compter compte ' +
    'comptes comptent trouver trouve trouvent trouvons croire crois croit croient semble semblent sembler rester reste restent ' +
    'devenir devient deviennent tenir tient tiennent rendre rend rendent suivre suit suivent regarder regarde regardez comprendre ' +
    'comprend comprends connaitre connait connais appeler appelle arrive arriver arrivent entendre entend demander demande ' +
    'demandent utiliser utilise commencer commence continuer continue permettre permet permettent apporter apporte existe ' +
    'exister montrer montre ouvrir ouvre garder garde laisser laisse laissent changer change oublier oublie rappeler rappelle ' +
    'essayer essaie essaye choisir choisit manque manquer porter porte tomber tombe ecouter ecoute attendre attend sentir ' +
    'chercher cherche vivre vit vivent savoir revenir revient retrouver retrouve tourner tourne rentrer rentre sortir sort ' +
    'creer cree crees reussir reussit proposer propose proposons expliquer explique ajouter ajoute',
  // mots creux et noms génériques
  generiques:
    'cetera etcetera caetera chose choses fois heure heures jour jours journee semaine semaines mois annee annees temps moment ' +
    'moments instant cas genre type sorte sortes facon facons maniere manieres exemple exemples question questions reponse ' +
    'reponses sujet sujets point points partie parties niveau niveaux place cote besoin besoins idee idees mots nom noms gens ' +
    'monde personne personnes certain certaine truc trucs ensemble ensembles raison raisons fond forme formes lieu lieux ' +
    'numero nombre nombres part parts chiffre chiffres moitie debut cours long longue longs courte court petit petite petits ' +
    'petites grand grande grands grandes gros grosse haut haute bas basse bonne beau belle beaux belles vrai vraie vrais ' +
    'vraies faux fausse premier premiere premiers premieres dernier derniere derniers dernieres seul seule seuls seules tel ' +
    'telle tels telles quel nouveau nouvelle nouveaux nouvelles probleme problemes difficile facile important importante ' +
    'importants importantes possible possibles meilleur meilleure meilleurs meilleures autant bref donc voila',
  // politesse, interjections, attribution
  oral: 'monsieur madame merci bonjour bonsoir lisnard david bonne quoi bref',
};

export const STOP = new Set(
  Object.values(LISTS)
    .join(' ')
    .split(/\s+/)
    .filter(Boolean),
);

/** Le mot (ou sa forme au singulier) est-il un mot creux ? */
export const isStopWord = (word) => STOP.has(word) || STOP.has(word.replace(/[sx]$/, ''));
