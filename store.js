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

import { readFileSync, writeFileSync, existsSync } from 'node:fs';

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
      }
    } catch (e) {
      console.error('[store] Failed to load:', e.message);
    }
  }

  _save() {
    writeFileSync(this.filePath, JSON.stringify(this.data, null, 2));
  }

  // ── Accounts ──────────────────────────────────────────────────────

  getAccount(username) { return this.data.accounts[username] ?? null; }

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

  // ── Community Groups ──────────────────────────────────────────────

  getCommunityGroup(communityId) { return this.data.communityGroups[String(communityId)] ?? null; }

  setCommunityGroup(communityId, info) {
    this.data.communityGroups[String(communityId)] = info;
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
}
