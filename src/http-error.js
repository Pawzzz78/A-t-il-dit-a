// Error carrying an HTTP status and a user-facing message
export class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

// Wraps an async handler so its rejection reaches the error handler (Express 4 does not)
export const ah = (fn) => (req, res, next) => fn(req, res, next).catch(next);

// Shared JSON error handler; map(err) -> [status, message] | null for router-specific errors, the rest is logged as a 500
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
