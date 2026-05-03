const INTERNAL_TOKEN = process.env.INTERNAL_TOKEN;

export function internalAuth(req, res, next) {
  if (!INTERNAL_TOKEN) return next();
  const token = req.headers['x-internal-token'];
  if (token !== INTERNAL_TOKEN) return res.status(401).json({ error: 'Unauthorized' });
  next();
}
