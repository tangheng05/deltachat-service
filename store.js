/**
 * File-based JSON store for account and chat mappings.
 *
 * Schema:
 * {
 *   accounts: { "__bot__": { accountId, addr, password }, "<username>": {...} },
 *   orderChats: { "<order_id>": { chatId, buyerUsername, sellerUsername, createdAt } },
 *   communityGroups: {
 *     "<community_id>": {
 *       chatId, name, createdAt, ownerUsername, announcementMode,
 *       joinMode: "open"|"approval_required",
 *       memberUsernames: [],
 *       roles: { "<username>": "owner"|"admin"|"moderator"|"member" },
 *       mutes: { "<username>": <unix ms expiry, 0 = permanent> },
 *       bans:  { "<username>": { bannedAt, bannedBy, reason } },
 *       pendingMembers: { "<username>": { requestedAt } }
 *     }
 *   },
 *   directMessages: { "<userA>:<userB>": { chatId, userA, userB, createdAt } },
 *   moderation: {
 *     blocks: { "<username>": ["<blocked_username>", ...] },
 *     globalMutes: { "<username>": { mutedUntil: <unix ms> } }
 *   }
 * }
 */

import { readFileSync, existsSync, writeFileSync, renameSync, writeFile, rename } from 'node:fs';

export class Store {
  constructor(filePath) {
    this.filePath = filePath;
    this.data = { accounts: {}, orderChats: {}, communityGroups: {} };
    this._load();
  }

  _load() {
    try {
      if (existsSync(this.filePath)) {
        this.data = JSON.parse(readFileSync(this.filePath, 'utf8'));
        this.data.accounts ??= {};
        this.data.orderChats ??= {};
        this.data.communityGroups ??= {};
        this.data.directMessages ??= {};
        this.data.moderation ??= { blocks: {}, globalMutes: {}, mutedDms: {} };
        this.data.moderation.blocks ??= {};
        this.data.moderation.globalMutes ??= {};
        this.data.moderation.mutedDms ??= {};
        // Backfill new fields on existing groups
        for (const group of Object.values(this.data.communityGroups)) {
          group.joinMode ??= 'open';
          group.pendingMembers ??= {};
          group.enabled ??= true; // existing groups stay enabled
        }
      }
    } catch (e) {
      console.error('[store] Failed to load:', e.message);
    }
  }

  _save() {
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => {
      const tmp = this.filePath + '.tmp';
      const data = JSON.stringify(this.data, null, 2);
      writeFile(tmp, data, (err) => {
        if (!err) rename(tmp, this.filePath, () => {});
      });
    }, 100);
  }

  flush() {
    if (!this._saveTimer) return;
    clearTimeout(this._saveTimer);
    this._saveTimer = null;
    const tmp = this.filePath + '.tmp';
    writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    renameSync(tmp, this.filePath);
  }

  // ── Accounts ──────────────────────────────────────────────────────

  getAccount(username) { return this.data.accounts[username] ?? null; }
  getAllAccounts() { return this.data.accounts; }

  setAccount(username, info) {
    this.data.accounts[username] = info;
    this._save();
  }

  // ── Order Chats ───────────────────────────────────────────────────

  getOrderChat(orderId) { return this.data.orderChats[String(orderId)] ?? null; }

  setOrderChat(orderId, info) {
    this.data.orderChats[String(orderId)] = info;
    this._save();
  }

  setOrderChatLastSeen(orderId, username, unixSeconds) {
    const chat = this.data.orderChats[String(orderId)];
    if (!chat) return;
    chat.lastSeenBy ??= {};
    chat.lastSeenBy[username] = unixSeconds;
    this._save();
  }

  findOrderIdByChatId(chatId) {
    for (const [id, info] of Object.entries(this.data.orderChats)) {
      if (info.chatId === chatId) return id;
    }
    return null;
  }

  // Returns all shop inquiry chats for a given shop_id (synthetic order_ids: "shop_<id>_<buyer>")
  getShopChats(shopId) {
    const prefix = `shop_${shopId}_`;
    return Object.entries(this.data.orderChats)
      .filter(([id]) => id.startsWith(prefix))
      .map(([order_id, info]) => ({ order_id, ...info }));
  }

  deleteShopChat(orderId) {
    delete this.data.orderChats[orderId];
    this._save();
  }

  // Returns all shop chats where the given username is the buyer
  getShopChatsForBuyer(buyerUsername) {
    return Object.entries(this.data.orderChats)
      .filter(([id, info]) => id.startsWith('shop_') && info.buyerUsername === buyerUsername)
      .map(([order_id, info]) => {
        // Extract shopId from order_id: "shop_<shopId>_<buyer>"
        const shopId = order_id.replace(/^shop_/, '').replace(new RegExp(`_${buyerUsername}$`), '');
        return { order_id, shopId, ...info };
      });
  }

  // ── Community Groups ──────────────────────────────────────────────

  getCommunityGroup(communityId) { return this.data.communityGroups[String(communityId)] ?? null; }

  setCommunityGroup(communityId, info) {
    this.data.communityGroups[String(communityId)] = info;
    this._save();
  }

  setGroupLastMessage(communityId, msg) {
    const group = this.data.communityGroups[String(communityId)];
    if (!group) return;
    group.lastMessage = msg ? { text: msg.text, senderUsername: msg.senderUsername, timestamp: msg.timestamp } : null;
    this._save();
  }

  setGroupLastSeen(communityId, username, unixSeconds) {
    const group = this.data.communityGroups[String(communityId)];
    if (!group) return;
    group.lastSeenBy ??= {};
    group.lastSeenBy[username] = unixSeconds;
    this._save();
  }

  addCommunityMember(communityId, username) {
    const group = this.data.communityGroups[String(communityId)];
    if (!group || group.memberUsernames.includes(username)) return;
    group.memberUsernames.push(username);
    this._save();
  }

  removeCommunityMember(communityId, username) {
    const group = this.data.communityGroups[String(communityId)];
    if (!group) return;
    group.memberUsernames = group.memberUsernames.filter((u) => u !== username);
    this._save();
  }

  findCommunityIdByChatId(chatId) {
    for (const [id, info] of Object.entries(this.data.communityGroups)) {
      if (info.chatId === chatId) return id;
    }
    return null;
  }

  // ── Group moderation ──────────────────────────────────────────────

  setGroupMember(communityId, username, role) {
    const group = this.data.communityGroups[String(communityId)];
    if (!group) return;
    group.roles ??= {};
    group.roles[username] = role;
    if (!group.memberUsernames.includes(username)) group.memberUsernames.push(username);
    this._save();
  }

  removeGroupMember(communityId, username) {
    const group = this.data.communityGroups[String(communityId)];
    if (!group) return;
    group.memberUsernames = group.memberUsernames.filter((u) => u !== username);
    group.roles ??= {};
    delete group.roles[username];
    group.pendingMembers ??= {};
    delete group.pendingMembers[username];
    group.leftVoluntarily ??= {};
    group.leftVoluntarily[username] = true;
    this._save();
  }

  clearLeftVoluntarily(communityId, username) {
    const group = this.data.communityGroups[String(communityId)];
    if (!group?.leftVoluntarily) return;
    delete group.leftVoluntarily[username];
    this._save();
  }

  muteGroupMember(communityId, username, mutedUntil) {
    const group = this.data.communityGroups[String(communityId)];
    if (!group) return;
    group.mutes ??= {};
    group.mutes[username] = mutedUntil; // 0 = permanent, else unix ms
    this._save();
  }

  unmuteGroupMember(communityId, username) {
    const group = this.data.communityGroups[String(communityId)];
    if (!group) return;
    group.mutes ??= {};
    delete group.mutes[username];
    this._save();
  }

  kickGroupMember(communityId, username, kickedBy) {
    const group = this.data.communityGroups[String(communityId)];
    if (!group) return;
    group.kicks ??= {};
    group.kicks[username] = { kickedAt: Date.now(), kickedBy };
    group.memberUsernames = group.memberUsernames.filter((u) => u !== username);
    group.roles ??= {};
    delete group.roles[username];
    this._save();
  }

  clearKick(communityId, username) {
    const group = this.data.communityGroups[String(communityId)];
    if (!group) return;
    group.kicks ??= {};
    delete group.kicks[username];
    this._save();
  }

  banGroupMember(communityId, username, bannedBy, reason = '') {
    const group = this.data.communityGroups[String(communityId)];
    if (!group) return;
    group.bans ??= {};
    group.bans[username] = { bannedAt: Date.now(), bannedBy, reason };
    // Also clear any pending kick so ban takes full precedence
    group.kicks ??= {};
    delete group.kicks[username];
    group.memberUsernames = group.memberUsernames.filter((u) => u !== username);
    group.roles ??= {};
    delete group.roles[username];
    this._save();
  }

  unbanGroupMember(communityId, username) {
    const group = this.data.communityGroups[String(communityId)];
    if (!group) return;
    group.bans ??= {};
    delete group.bans[username];
    this._save();
  }

  setGroupRole(communityId, username, role) {
    const group = this.data.communityGroups[String(communityId)];
    if (!group) return;
    group.roles ??= {};
    group.roles[username] = role;
    this._save();
  }

  setGroupSettings(communityId, settings) {
    const group = this.data.communityGroups[String(communityId)];
    if (!group) return;
    if (typeof settings.announcementMode === 'boolean') group.announcementMode = settings.announcementMode;
    if (settings.joinMode === 'open' || settings.joinMode === 'approval_required') group.joinMode = settings.joinMode;
    this._save();
  }

  renameGroup(communityId, name) {
    const group = this.data.communityGroups[String(communityId)];
    if (!group || !name) return;
    group.name = name;
    this._save();
  }

  setGroupEnabled(communityId, enabled) {
    const group = this.data.communityGroups[String(communityId)];
    if (!group) return;
    group.enabled = Boolean(enabled);
    this._save();
  }

  // ── Join requests ─────────────────────────────────────────────────────

  addPendingMember(communityId, username) {
    const group = this.data.communityGroups[String(communityId)];
    if (!group) return;
    group.pendingMembers ??= {};
    if (!group.pendingMembers[username]) {
      group.pendingMembers[username] = { requestedAt: Date.now() };
      this._save();
    }
  }

  removePendingMember(communityId, username) {
    const group = this.data.communityGroups[String(communityId)];
    if (!group) return;
    group.pendingMembers ??= {};
    delete group.pendingMembers[username];
    this._save();
  }

  getPendingMembers(communityId) {
    const group = this.data.communityGroups[String(communityId)];
    if (!group) return [];
    return Object.entries(group.pendingMembers ?? {}).map(([username, info]) => ({ username, ...info }));
  }

  approvePendingMember(communityId, username) {
    const group = this.data.communityGroups[String(communityId)];
    if (!group) return;
    group.pendingMembers ??= {};
    delete group.pendingMembers[username];
    group.roles ??= {};
    group.roles[username] = 'member';
    if (!group.memberUsernames.includes(username)) group.memberUsernames.push(username);
    this._save();
  }

  // ── Direct Messages ───────────────────────────────────────────────

  getDm(dmKey) { return this.data.directMessages[dmKey] ?? null; }

  setDm(dmKey, info) {
    this.data.directMessages[dmKey] = info;
    this._save();
  }

  // accountId scopes the lookup so chatId numbers from different accounts don't collide.
  findDmKeyByChatId(chatId, accountId = null) {
    for (const [key, info] of Object.entries(this.data.directMessages)) {
      if (accountId !== null) {
        if (info.userAAccountId === accountId && info.userAChatId === chatId) return key;
        if (info.userBAccountId === accountId && info.userBChatId === chatId) return key;
      } else {
        if (info.userAChatId === chatId || info.userBChatId === chatId) return key;
      }
      if (info.chatId === chatId) return key; // legacy bot-DM fallback
    }
    return null;
  }

  getDmAccountAndChat(dmKey, senderUsername) {
    const dm = this.data.directMessages[dmKey];
    if (!dm) return null;
    if (dm.userA === senderUsername && dm.userAAccountId) return { accountId: dm.userAAccountId, chatId: dm.userAChatId };
    if (dm.userB === senderUsername && dm.userBAccountId) return { accountId: dm.userBAccountId, chatId: dm.userBChatId };
    return null;
  }

  findUsernameByAddr(addr) {
    for (const [username, info] of Object.entries(this.data.accounts)) {
      if (username === '__bot__') continue;
      if (info.addr === addr) return username;
    }
    return null;
  }

  findUsernameByAccountId(accountId) {
    for (const [username, info] of Object.entries(this.data.accounts)) {
      if (username === '__bot__') continue;
      if (info.accountId === accountId) return username;
    }
    return null;
  }

  deleteDm(dmKey) {
    delete this.data.directMessages[dmKey];
    // Remove from mute lists too
    for (const list of Object.values(this.data.moderation.mutedDms ?? {})) {
      const idx = list.indexOf(dmKey);
      if (idx !== -1) list.splice(idx, 1);
    }
    this._save();
  }

  getDmsForUser(username) {
    const mutedDms = this.data.moderation.mutedDms[username] ?? [];
    return Object.entries(this.data.directMessages)
      .filter(([, info]) => info.userA === username || info.userB === username)
      .map(([dmKey, info]) => ({
        dmKey, ...info, muted: mutedDms.includes(dmKey),
        unread: (info.lastMessageAt || 0) > (info.lastSeenBy?.[username] || 0),
        lastMessage: info.lastMessage || null,
      }));
  }

  setDmLastActivity(dmKey, unixSeconds) {
    const dm = this.data.directMessages[dmKey];
    if (!dm) return;
    dm.lastMessageAt = unixSeconds;
    this._save();
  }

  setDmLastMessage(dmKey, { text, senderUsername, timestamp }) {
    const dm = this.data.directMessages[dmKey];
    if (!dm) return;
    dm.lastMessage = { text, senderUsername, timestamp };
    dm.lastMessageAt = timestamp;
    this._save();
  }

  setDmLastSeen(dmKey, username, unixSeconds) {
    const dm = this.data.directMessages[dmKey];
    if (!dm) return;
    dm.lastSeenBy ??= {};
    dm.lastSeenBy[username] = unixSeconds;
    this._save();
  }

  // ── DM mute ───────────────────────────────────────────────────────

  muteDm(username, dmKey) {
    this.data.moderation.mutedDms[username] ??= [];
    if (!this.data.moderation.mutedDms[username].includes(dmKey)) {
      this.data.moderation.mutedDms[username].push(dmKey);
      this._save();
    }
  }

  unmuteDm(username, dmKey) {
    const list = this.data.moderation.mutedDms[username];
    if (!list) return;
    this.data.moderation.mutedDms[username] = list.filter((k) => k !== dmKey);
    this._save();
  }

  isDmMuted(username, dmKey) {
    return !!(this.data.moderation.mutedDms[username]?.includes(dmKey));
  }

  // ── Moderation (block/unblock) ────────────────────────────────────

  addBlock(blocker, target) {
    this.data.moderation.blocks[blocker] ??= [];
    if (!this.data.moderation.blocks[blocker].includes(target)) {
      this.data.moderation.blocks[blocker].push(target);
      this._save();
    }
  }

  removeBlock(blocker, target) {
    const list = this.data.moderation.blocks[blocker];
    if (!list) return;
    this.data.moderation.blocks[blocker] = list.filter((u) => u !== target);
    this._save();
  }

  isBlocked(sender, recipient) {
    return !!(this.data.moderation.blocks[recipient]?.includes(sender));
  }

  hasBlocked(blocker, target) {
    return !!(this.data.moderation.blocks[blocker]?.includes(target));
  }

  getBlocks(username) {
    return this.data.moderation.blocks[username] ?? [];
  }
}
