/**
 * File-based JSON store for account and chat mappings.
 *
 * Schema:
 * {
 *   accounts: {
 *     "__bot__": { accountId, addr, password },
 *     "username": { accountId, addr, password }
 *   },
 *   orderChats: {
 *     "order_id": { chatId, buyerUsername, sellerUsername, createdAt }
 *   },
 *   communityGroups: {
 *     "community_id": { chatId, name, memberUsernames: [], createdAt }
 *   }
 * }
 */

const fs = require('fs');

class Store {
  constructor(filePath) {
    this.filePath = filePath;
    this.data = { accounts: {}, orderChats: {}, communityGroups: {} };
    this._load();
  }

  _load() {
    try {
      if (fs.existsSync(this.filePath)) {
        this.data = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
        this.data.accounts ??= {};
        this.data.orderChats ??= {};
        this.data.communityGroups ??= {};
      }
    } catch (e) {
      console.error('[store] Failed to load store file:', e.message);
    }
  }

  _save() {
    fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2));
  }

  // ── Accounts ──────────────────────────────────────────────────────

  getAccount(username) {
    return this.data.accounts[username] ?? null;
  }

  setAccount(username, info) {
    this.data.accounts[username] = info;
    this._save();
  }

  // ── Order Chats ───────────────────────────────────────────────────

  getOrderChat(orderId) {
    return this.data.orderChats[String(orderId)] ?? null;
  }

  setOrderChat(orderId, info) {
    this.data.orderChats[String(orderId)] = info;
    this._save();
  }

  /** Find the order_id for a given DC chatId (for SSE routing) */
  findOrderIdByChatId(chatId) {
    for (const [orderId, info] of Object.entries(this.data.orderChats)) {
      if (info.chatId === chatId) return orderId;
    }
    return null;
  }

  // ── Community Groups ──────────────────────────────────────────────

  getCommunityGroup(communityId) {
    return this.data.communityGroups[String(communityId)] ?? null;
  }

  setCommunityGroup(communityId, info) {
    this.data.communityGroups[String(communityId)] = info;
    this._save();
  }

  addCommunityMember(communityId, username) {
    const group = this.data.communityGroups[String(communityId)];
    if (!group) return;
    if (!group.memberUsernames.includes(username)) {
      group.memberUsernames.push(username);
      this._save();
    }
  }

  removeCommunityMember(communityId, username) {
    const group = this.data.communityGroups[String(communityId)];
    if (!group) return;
    group.memberUsernames = group.memberUsernames.filter((u) => u !== username);
    this._save();
  }

  /** Find the community_id for a given DC chatId */
  findCommunityIdByChatId(chatId) {
    for (const [communityId, info] of Object.entries(this.data.communityGroups)) {
      if (info.chatId === chatId) return communityId;
    }
    return null;
  }
}

module.exports = Store;
