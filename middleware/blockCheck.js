// Route must set req.blockCheckPairs = [[senderUsername, recipientUsername], ...]
export function blockCheck(store) {
  return function blockCheckMiddleware(req, res, next) {
    const pairs = req.blockCheckPairs;
    if (!pairs || pairs.length === 0) return next();

    for (const [sender, recipient] of pairs) {
      if (store.isBlocked(sender, recipient)) {
        return res.status(403).json({ error: 'Blocked' });
      }
    }
    next();
  };
}
