/** Erreur avec un statut HTTP et un message destiné à l'utilisateur. */
export class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

/** Enveloppe un handler async : ses erreurs vont au gestionnaire d'erreurs (Express 4 ne les rattrape pas seul). */
export const ah = (fn) => (req, res, next) => fn(req, res, next).catch(next);

/**
 * Gestionnaire d'erreurs JSON commun aux routeurs. `map(err)` renvoie [statut, message] pour les erreurs propres à un routeur,
 * sinon null ; le reste est journalisé et répond « Erreur interne. » sans détail.
 */
export function jsonErrors({ map = () => null, tooLarge = 'Demande trop volumineuse.' } = {}) {
  // Express needs the 4-argument signature to treat this as an error handler
  return (err, _req, res, _next) => {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, ...err.extra });
    if (err.type === 'entity.too.large') return res.status(413).json({ error: tooLarge });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Demande illisible.' });
    const mapped = map(err);
    if (mapped) return res.status(mapped[0]).json({ error: mapped[1] });
    console.error(err);
    res.status(500).json({ error: 'Erreur interne.' });
  };
}
