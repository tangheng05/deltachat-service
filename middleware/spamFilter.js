const MAX_MSG_LENGTH = parseInt(process.env.MAX_MSG_LENGTH) || 2000;
const DUPLICATE_WINDOW_MS = 30_000;
const DUPLICATE_THRESHOLD = 3;

// Map<username → [{ text, ts }, ...]>
const recentMsgsMap = new Map();

setInterval(() => {
  const cutoff = Date.now() - DUPLICATE_WINDOW_MS;
  for (const [key, entries] of recentMsgsMap) {
    const pruned = entries.filter((e) => e.ts > cutoff);
    if (pruned.length === 0) recentMsgsMap.delete(key);
    else recentMsgsMap.set(key, pruned);
  }
}, 60_000).unref();

export function spamFilter(req, res, next) {
  const { sender_username, text } = req.body || {};
  if (!sender_username || !text) return next();

  if (text.length > MAX_MSG_LENGTH) {
    return res.status(400).json({ error: `Message exceeds ${MAX_MSG_LENGTH} character limit` });
  }

  const chatContext = req.params.dm_key || req.params.community_id || req.params.order_id || 'global';
  const dedupKey = `${sender_username}:${chatContext}`;

  const now = Date.now();
  const cutoff = now - DUPLICATE_WINDOW_MS;
  const recent = (recentMsgsMap.get(dedupKey) || []).filter((e) => e.ts > cutoff);

  if (recent.length >= DUPLICATE_THRESHOLD && recent.every((e) => e.text === text)) {
    return res.status(429).json({ error: 'Duplicate message' });
  }

  recent.push({ text, ts: now });
  recentMsgsMap.set(dedupKey, recent);
  next();
}
