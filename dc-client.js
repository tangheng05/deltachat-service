/**
 * JSON-RPC client for deltachat-rpc-server.
 * Spawns the binary via @deltachat/stdio-rpc-server and communicates over stdio.
 * All method params are positional arrays per the DC JSON-RPC spec.
 */

const { spawn } = require('child_process');
const readline = require('readline');
const EventEmitter = require('events');

class DeltaChatClient extends EventEmitter {
  constructor(accountsPath) {
    super();
    this.accountsPath = accountsPath;
    this.proc = null;
    this.pending = new Map();
    this._id = 1;
  }

  start() {
    let binaryPath;
    try {
      binaryPath = require('@deltachat/stdio-rpc-server');
    } catch {
      throw new Error(
        'deltachat-rpc-server binary not found.\nRun: npm install inside chat-service/'
      );
    }

    this.proc = spawn(binaryPath, [], {
      env: { ...process.env, DC_ACCOUNTS_PATH: this.accountsPath },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const rl = readline.createInterface({ input: this.proc.stdout });

    rl.on('line', (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let msg;
      try { msg = JSON.parse(trimmed); } catch { return; }

      if (msg.id != null) {
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
        else p.resolve(msg.result);
      } else if (msg.method === 'event') {
        this.emit('dc-event', msg.params);
      }
    });

    this.proc.stderr.on('data', (d) => process.stderr.write(`[dc-rpc] ${d}`));

    this.proc.on('exit', (code) => {
      console.error(`[dc-rpc] process exited with code ${code}`);
      for (const p of this.pending.values())
        p.reject(new Error('deltachat-rpc-server process exited'));
      this.pending.clear();
    });

    console.log(`[dc-rpc] started (accounts path: ${this.accountsPath})`);
  }

  /** Low-level JSON-RPC call — params are positional */
  call(method, ...params) {
    return new Promise((resolve, reject) => {
      if (!this.proc || this.proc.exitCode !== null)
        return reject(new Error('deltachat-rpc-server is not running'));

      const id = this._id++;
      this.pending.set(id, { resolve, reject });
      const msg = JSON.stringify({ jsonrpc: '2.0', id, method, params });
      this.proc.stdin.write(msg + '\n');
    });
  }

  // ── Account management ──────────────────────────────────────────

  addAccount() { return this.call('add_account'); }
  removeAccount(accountId) { return this.call('remove_account', accountId); }
  getAllAccountIds() { return this.call('get_all_account_ids'); }
  isConfigured(accountId) { return this.call('is_configured', accountId); }

  // ── Config ──────────────────────────────────────────────────────

  setConfig(accountId, key, value) { return this.call('set_config', accountId, key, value); }
  getConfig(accountId, key) { return this.call('get_config', accountId, key); }

  // ── Configure (connect to chatmail server) ──────────────────────
  // configure() is blocking in the RPC layer — it resolves when done or rejects on failure.

  configure(accountId) { return this.call('configure', accountId); }

  // ── Contacts ────────────────────────────────────────────────────

  createContact(accountId, name, addr) { return this.call('create_contact', accountId, name, addr); }
  lookupContactByAddr(accountId, addr) { return this.call('lookup_contact_id_by_addr', accountId, addr); }
  getContact(accountId, contactId) { return this.call('get_contact', accountId, contactId); }

  // ── Chats ────────────────────────────────────────────────────────

  /** protect=false for normal group, true for verified/protected group */
  createGroupChat(accountId, name, protect = false) {
    return this.call('create_group_chat', accountId, protect, name);
  }

  addContactToChat(accountId, chatId, contactId) {
    return this.call('add_contact_to_chat', accountId, chatId, contactId);
  }

  removeContactFromChat(accountId, chatId, contactId) {
    return this.call('remove_contact_from_chat', accountId, chatId, contactId);
  }

  getChatContacts(accountId, chatId) {
    return this.call('get_chat_contacts', accountId, chatId);
  }

  // ── Messages ─────────────────────────────────────────────────────

  /** msg = { text: string } */
  sendMsg(accountId, chatId, msg) {
    return this.call('send_msg', accountId, chatId, msg);
  }

  sendTextMsg(accountId, chatId, text) {
    return this.call('send_msg', accountId, chatId, { text });
  }

  getMessage(accountId, msgId) { return this.call('get_message', accountId, msgId); }

  /** Returns array of msgIds for the chat, oldest first */
  getMessageIds(accountId, chatId) {
    return this.call('get_message_ids', accountId, chatId, 0, 0);
  }

  markSeenMsgs(accountId, msgIds) {
    return this.call('markseen_msgs', accountId, msgIds);
  }
}

module.exports = DeltaChatClient;
