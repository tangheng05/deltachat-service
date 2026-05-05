/**
 * Thin wrapper around @deltachat/stdio-rpc-server.
 * Exposes the methods we need and re-emits IncomingMsg events.
 */

import { startDeltaChat } from '@deltachat/stdio-rpc-server';
import { EventEmitter } from 'node:events';

export class DeltaChatClient extends EventEmitter {
  constructor(accountsPath) {
    super();
    this.accountsPath = accountsPath;
    this._dc = null;
  }

  start() {
    this._dc = startDeltaChat(this.accountsPath);

    this._dc.on('IncomingMsg', (contextId, event) => {
      this.emit('IncomingMsg', contextId, event);
    });

    this._dc.on('MsgDeleted', (contextId, event) => {
      this.emit('MsgDeleted', contextId, event);
    });

    console.log(`[dc-rpc] started (accounts path: ${this.accountsPath})`);
  }

  get rpc() { return this._dc.rpc; }

  close() { this._dc?.close(); }

  // ── Account management ──────────────────────────────────────────

  addAccount() { return this._dc.rpc.addAccount(); }
  isConfigured(accountId) { return this._dc.rpc.isConfigured(accountId); }

  // ── Config ──────────────────────────────────────────────────────

  setConfig(accountId, key, value) { return this._dc.rpc.setConfig(accountId, key, value); }
  getConfig(accountId, key) { return this._dc.rpc.getConfig(accountId, key); }

  // ── Configure + start IO ─────────────────────────────────────────
  // configure() is blocking — resolves when done, rejects on failure.
  // startIo() must be called after configure to enable message receiving.

  async configure(accountId) {
    await this._dc.rpc.configure(accountId);
    await this._dc.rpc.startIo(accountId);
  }

  // ── Chatmail QR provisioning ──────────────────────────────────────
  // For chatmail servers, use setConfigFromQr with the dcaccount: URI.
  // This fetches credentials from the chatmail HTTP API and stores them.

  setConfigFromQr(accountId, qrContent) { return this._dc.rpc.setConfigFromQr(accountId, qrContent); }
  checkQr(accountId, qrContent) { return this._dc.rpc.checkQr(accountId, qrContent); }

  // ── Contacts ────────────────────────────────────────────────────
  // Note: createContact param order is (accountId, email, name)

  createContact(accountId, email, name) { return this._dc.rpc.createContact(accountId, email, name); }
  lookupContactIdByAddr(accountId, addr) { return this._dc.rpc.lookupContactIdByAddr(accountId, addr); }

  // ── Chats ────────────────────────────────────────────────────────
  // Note: createGroupChat param order is (accountId, name, protect)

  createGroupChat(accountId, name, protect = false) {
    return this._dc.rpc.createGroupChat(accountId, name, protect);
  }

  createChatByContactId(accountId, contactId) {
    return this._dc.rpc.createChatByContactId(accountId, contactId);
  }

  stopIo(accountId) {
    return this._dc.rpc.stopIo(accountId);
  }

  getAllAccounts() {
    return this._dc.rpc.getAllAccounts();
  }

  getContact(accountId, contactId) {
    return this._dc.rpc.getContact(accountId, contactId);
  }

  addContactToChat(accountId, chatId, contactId) {
    return this._dc.rpc.addContactToChat(accountId, chatId, contactId);
  }

  removeContactFromChat(accountId, chatId, contactId) {
    return this._dc.rpc.removeContactFromChat(accountId, chatId, contactId);
  }

  // ── Messages ─────────────────────────────────────────────────────

  sendTextMsg(accountId, chatId, text, quotedMsgId = null) {
    const msg = { text };
    if (quotedMsgId && typeof quotedMsgId === 'number') msg.quotedMessageId = quotedMsgId;
    return this._dc.rpc.sendMsg(accountId, chatId, msg);
  }

  getMessage(accountId, msgId) { return this._dc.rpc.getMessage(accountId, msgId); }

  getMessageIds(accountId, chatId) {
    return this._dc.rpc.getMessageIds(accountId, chatId, false, false);
  }

  markSeenMsgs(accountId, msgIds) {
    return this._dc.rpc.markseenMsgs(accountId, msgIds);
  }

  deleteMessages(accountId, msgIds) {
    // Delta Chat RPC uses deleteMessages (plural)
    return this._dc.rpc.deleteMessages(accountId, msgIds);
  }

  deleteChat(accountId, chatId) {
    return this._dc.rpc.deleteChat(accountId, chatId);
  }
}
