const ROLE_RANK = { owner: 4, admin: 3, moderator: 2, member: 1 };

export function groupGuard(store, req, res, next) {
  const { community_id } = req.params;
  const { sender_username } = req.body;
  if (!sender_username) return res.status(400).json({ error: 'sender_username required' });

  const group = store.getCommunityGroup(community_id);
  if (!group) return res.status(404).json({ error: 'Group not found — call POST /groups first' });

  const bans = group.bans ?? {};
  const mutes = group.mutes ?? {};
  const roles = group.roles ?? {};

  if (bans[sender_username]) {
    return res.status(403).json({ error: 'You are banned from this group' });
  }

  if (mutes[sender_username] != null) {
    const mutedUntil = mutes[sender_username];
    if (mutedUntil === 0 || mutedUntil > Date.now()) {
      return res.status(403).json({ error: 'You are muted in this group' });
    }
    // Mute expired — lazy cleanup
    store.unmuteGroupMember(community_id, sender_username);
  }

  if (group.announcementMode) {
    const role = roles[sender_username] ?? 'member';
    if ((ROLE_RANK[role] ?? 1) < ROLE_RANK.admin) {
      return res.status(403).json({ error: 'Announcement mode: only admins can send' });
    }
  }

  next();
}
