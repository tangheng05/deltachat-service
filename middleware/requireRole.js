const ROLE_RANK = { owner: 4, admin: 3, moderator: 2, member: 1 };

export function requireRole(store, minRole, req, res, next) {
  const { community_id } = req.params;
  const { actor_username } = req.body;
  if (!actor_username) return res.status(400).json({ error: 'actor_username required' });

  const group = store.getCommunityGroup(community_id);
  if (!group) return res.status(404).json({ error: 'Group not found' });

  const roles = group.roles ?? {};
  const actorRole = roles[actor_username] ?? 'member';
  if ((ROLE_RANK[actorRole] ?? 1) < (ROLE_RANK[minRole] ?? 1)) {
    return res.status(403).json({ error: `Requires at least ${minRole} role` });
  }

  next();
}
