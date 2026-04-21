const RATE_LIMIT_MAX = parseInt(process.env.RATE_LIMIT_MAX) || 5;
const RATE_LIMIT_WINDOW_MS = parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 10_000;

export function createRateLimiter(rateLimitMap) {
  // Prune stale entries every 60s to prevent unbounded memory growth
  setInterval(() => {
    const cutoff = Date.now() - RATE_LIMIT_WINDOW_MS;
    for (const [key, timestamps] of rateLimitMap) {
      const pruned = timestamps.filter((t) => t > cutoff);
      if (pruned.length === 0) rateLimitMap.delete(key);
      else rateLimitMap.set(key, pruned);
    }
  }, 60_000).unref();

  return function rateLimiter(req, res, next) {
    const username = req.body?.sender_username;
    const chatContext = req.chatContext;
    if (!username || !chatContext) return next();

    const key = `${username}:${chatContext}`;
    const now = Date.now();
    const cutoff = now - RATE_LIMIT_WINDOW_MS;

    const timestamps = (rateLimitMap.get(key) || []).filter((t) => t > cutoff);
    if (timestamps.length >= RATE_LIMIT_MAX) {
      return res.status(429).json({ error: 'Rate limit exceeded' });
    }

    timestamps.push(now);
    rateLimitMap.set(key, timestamps);
    next();
  };
}
