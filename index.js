require('dotenv').config();
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

const DeltaChatClient = require('./dc-client');
const Store = require('./store');

// ── Config ──────────────────────────────────────────────────────────
const PORT = process.env.CHAT_SERVICE_PORT || 4040;
const DC_ACCOUNTS_PATH = process.env.DC_ACCOUNTS_PATH || path.join(__dirname, 'dc-data');
const CHATMAIL_DOMAIN = process.env.CHATMAIL_DOMAIN || 'nine.testrun.org';

fs.mkdirSync(DC_ACCOUNTS_PATH, { recursive: true });

const dc = new DeltaChatClient(DC_ACCOUNTS_PATH);
const store = new Store(path.join(DC_ACCOUNTS_PATH, 'store.json'));

// ── Bot account ─────────────────────────────────────────────────────
// One system bot manages all chats. Messages are attributed to users via text prefix.
let botAccountId = null;

async function ensureBotAccount() {
  if (botAccountId) return botAccountId;

  const cached = store.getAccount('__bot__');
  if (cached) {
    botAccountId = cached.accountId;
    return botAccountId;
  }

  const username = `sereybot${crypto.randomBytes(4).toString('hex')}`;
  const password = crypto.randomBytes(16).toString('hex');
  const addr = `${username}@${CHATMAIL_DOMAIN}`;

  console.log(`[bot] Provisioning system bot: ${addr}`);
  const accountId = await dc.addAccount();
  await dc.setConfig(accountId, 'addr', addr);
  await dc.setConfig(accountId, 'mail_pw', password);
  await dc.setConfig(accountId, 'displayname', 'Serey System');
  await dc.configure(accountId);

  store.setAccount('__bot__', { accountId, addr, password });
  botAccountId = accountId;
  console.log(`[bot] Bot ready — accountId=${accountId}, addr=${addr}`);
  return botAccountId;
}

// ── SSE client registry ─────────────────────────────────────────────
// chatKey format: "order:<order_id>" or "community:<community_id>"
const sseClients = new Map(); // chatKey → Set<res>

function sseRegister(chatKey, res) {
  if (!sseClients.has(chatKey)) sseClients.set(chatKey, new Set());
  sseClients.get(chatKey).add(res);
}

function sseUnregister(chatKey, res) {
  const s = sseClients.get(chatKey);
  if (!s) return;
  s.delete(res);
  if (s.size === 0) sseClients.delete(chatKey);
}

function sseBroadcast(chatKey, payload) {
  const clients = sseClients.get(chatKey);
  if (!clients || clients.size === 0) return;
  const data = `data: ${JSON.stringify(payload)}\n\n`;
  for (const res of clients) {
    try { res.write(data); } catch { /* client disconnected */ }
  }
}

// ── DC event listener ───────────────────────────────────────────────
dc.on('dc-event', async ({ contextId, event }) => {
  if (event.kind !== 'IncomingMsg') return;
  const { chatId, msgId } = event;

  const orderId = store.findOrderIdByChatId(chatId);
  const communityId = !orderId ? store.findCommunityIdByChatId(chatId) : null;
  if (!orderId && !communityId) return;

  const chatKey = orderId ? `order:${orderId}` : `community:${communityId}`;

  try {
    const msg = await dc.getMessage(contextId, msgId);
    sseBroadcast(chatKey, formatMessage(msg));
  } catch (e) {
    console.error('[dc-event] failed to fetch message:', e.message);
  }
});

// ── Message formatter ────────────────────────────────────────────────
function formatMessage(msg) {
  // Parse "🛒 Buyer (username): text" or "💬 username: text" prefix we write on send
  const raw = msg.text || '';
  const prefixMatch = raw.match(/^(?:🛒 Buyer|🏪 Seller|💬)\s+\(?([\w.-]+)\)?:\s*([\s\S]*)$/);
  return {
    id: msg.id,
    text: prefixMatch ? prefixMatch[2] : raw,
    senderUsername: prefixMatch ? prefixMatch[1] : null,
    isSystem: !prefixMatch,
    timestamp: msg.timestamp,
    chatId: msg.chat_id,
  };
}

function rand(bytes) { return crypto.randomBytes(bytes).toString('hex'); }

// ── Express app ──────────────────────────────────────────────────────
const app = express();
app.use(cors());
app.use(express.json());

// ── Health ────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => res.json({ status: 'ok', domain: CHATMAIL_DOMAIN }));

// ── POST /accounts ────────────────────────────────────────────────────
// Provision a DC account for a Serey user. Idempotent.
app.post('/accounts', async (req, res) => {
  const { username } = req.body;
  if (!username) return res.status(400).json({ error: 'username required' });

  try {
    let info = store.getAccount(username);
    if (!info) {
      const addr = `${rand(8)}@${CHATMAIL_DOMAIN}`;
      const password = rand(16);
      const accountId = await dc.addAccount();
      await dc.setConfig(accountId, 'addr', addr);
      await dc.setConfig(accountId, 'mail_pw', password);
      await dc.setConfig(accountId, 'displayname', username);
      await dc.configure(accountId);
      info = { accountId, addr, password };
      store.setAccount(username, info);
      console.log(`[accounts] provisioned ${username} → ${addr}`);
    }
    res.json({ username, addr: info.addr });
  } catch (e) {
    console.error('[/accounts] error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── POST /chats ───────────────────────────────────────────────────────
// Get or create an order chat room between buyer and seller. Idempotent.
app.post('/chats', async (req, res) => {
  const { order_id, buyer_username, seller_username } = req.body;
  if (!order_id || !buyer_username || !seller_username)
    return res.status(400).json({ error: 'order_id, buyer_username, seller_username required' });

  try {
    let chat = store.getOrderChat(order_id);
    if (!chat) {
      const botId = await ensureBotAccount();
      const chatId = await dc.createGroupChat(botId, `Order #${order_id}`);
      chat = {
        chatId,
        buyerUsername: buyer_username,
        sellerUsername: seller_username,
        createdAt: Date.now(),
      };
      store.setOrderChat(order_id, chat);
      console.log(`[chats] created order chat — orderId=${order_id} chatId=${chatId}`);
    }
    res.json({ order_id, chatId: chat.chatId, buyerUsername: chat.buyerUsername, sellerUsername: chat.sellerUsername });
  } catch (e) {
    console.error('[/chats] error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── POST /send ────────────────────────────────────────────────────────
// Send a user message in an order chat.
app.post('/send', async (req, res) => {
  const { order_id, sender_username, text } = req.body;
  if (!order_id || !sender_username || !text)
    return res.status(400).json({ error: 'order_id, sender_username, text required' });

  try {
    const chat = store.getOrderChat(order_id);
    if (!chat) return res.status(404).json({ error: 'Chat not found. Call POST /chats first.' });

    const botId = await ensureBotAccount();
    const role = chat.buyerUsername === sender_username ? '🛒 Buyer' : '🏪 Seller';
    const msgId = await dc.sendTextMsg(botId, chat.chatId, `${role} (${sender_username}): ${text}`);
    res.json({ msgId });
  } catch (e) {
    console.error('[/send] error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── POST /send-system ─────────────────────────────────────────────────
// Post an automated order status card into the order chat.
app.post('/send-system', async (req, res) => {
  const { order_id, old_status, new_status, order_total } = req.body;
  if (!order_id || !new_status)
    return res.status(400).json({ error: 'order_id and new_status required' });

  try {
    const chat = store.getOrderChat(order_id);
    if (!chat) return res.status(404).json({ error: 'Chat not found. Call POST /chats first.' });

    const botId = await ensureBotAccount();
    const statusLine = old_status ? `${old_status}  →  ${new_status}` : `Status: ${new_status}`;
    const lines = [
      '📦 Order Status Update',
      '━━━━━━━━━━━━━━━━━━━━━━━',
      statusLine,
      order_total ? `Total: $${order_total}` : null,
      '━━━━━━━━━━━━━━━━━━━━━━━',
    ].filter(Boolean);

    const msgId = await dc.sendTextMsg(botId, chat.chatId, lines.join('\n'));
    res.json({ msgId });
  } catch (e) {
    console.error('[/send-system] error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── GET /messages ─────────────────────────────────────────────────────
// Fetch full message history for an order chat.
app.get('/messages', async (req, res) => {
  const { order_id } = req.query;
  if (!order_id) return res.status(400).json({ error: 'order_id required' });

  try {
    const chat = store.getOrderChat(order_id);
    if (!chat) return res.json({ messages: [] });

    const botId = await ensureBotAccount();
    const msgIds = await dc.getMessageIds(botId, chat.chatId);
    const messages = (
      await Promise.all(msgIds.map((id) => dc.getMessage(botId, id).catch(() => null)))
    )
      .filter(Boolean)
      .map(formatMessage);

    res.json({ messages });
  } catch (e) {
    console.error('[/messages] error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── GET /events ───────────────────────────────────────────────────────
// SSE stream of new messages for an order chat or community group.
app.get('/events', (req, res) => {
  const { order_id, community_id } = req.query;
  if (!order_id && !community_id)
    return res.status(400).json({ error: 'order_id or community_id required' });

  const chatKey = order_id ? `order:${order_id}` : `community:${community_id}`;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  res.write('data: {"type":"connected"}\n\n');

  sseRegister(chatKey, res);
  req.on('close', () => sseUnregister(chatKey, res));
});

// ── POST /groups ──────────────────────────────────────────────────────
// Get or create a community group chat. Idempotent.
app.post('/groups', async (req, res) => {
  const { community_id, community_name } = req.body;
  if (!community_id) return res.status(400).json({ error: 'community_id required' });

  try {
    let group = store.getCommunityGroup(community_id);
    if (!group) {
      const botId = await ensureBotAccount();
      const name = community_name || community_id;
      const chatId = await dc.createGroupChat(botId, `${name} Community`);
      group = { chatId, name, memberUsernames: [], createdAt: Date.now() };
      store.setCommunityGroup(community_id, group);
      console.log(`[groups] created community group — communityId=${community_id} chatId=${chatId}`);
    }
    res.json({ community_id, chatId: group.chatId, name: group.name, memberCount: group.memberUsernames.length });
  } catch (e) {
    console.error('[/groups] error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── POST /groups/:community_id/send ───────────────────────────────────
// Send a message to a community group.
app.post('/groups/:community_id/send', async (req, res) => {
  const { community_id } = req.params;
  const { sender_username, text } = req.body;
  if (!sender_username || !text)
    return res.status(400).json({ error: 'sender_username and text required' });

  try {
    const group = store.getCommunityGroup(community_id);
    if (!group) return res.status(404).json({ error: 'Group not found. Call POST /groups first.' });

    const botId = await ensureBotAccount();
    const msgId = await dc.sendTextMsg(botId, group.chatId, `💬 (${sender_username}): ${text}`);
    res.json({ msgId });
  } catch (e) {
    console.error('[/groups/:id/send] error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── GET /groups/:community_id/messages ────────────────────────────────
// Fetch message history for a community group.
app.get('/groups/:community_id/messages', async (req, res) => {
  const { community_id } = req.params;
  const limit = Math.min(parseInt(req.query.limit) || 100, 500);

  try {
    const group = store.getCommunityGroup(community_id);
    if (!group) return res.json({ messages: [] });

    const botId = await ensureBotAccount();
    const msgIds = await dc.getMessageIds(botId, group.chatId);
    const recent = msgIds.slice(-limit);
    const messages = (
      await Promise.all(recent.map((id) => dc.getMessage(botId, id).catch(() => null)))
    )
      .filter(Boolean)
      .map(formatMessage);

    res.json({ messages });
  } catch (e) {
    console.error('[/groups/:id/messages] error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── GET /groups/:community_id/events ──────────────────────────────────
// SSE stream of new messages for a community group.
app.get('/groups/:community_id/events', (req, res) => {
  const { community_id } = req.params;
  const chatKey = `community:${community_id}`;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  res.write('data: {"type":"connected"}\n\n');

  sseRegister(chatKey, res);
  req.on('close', () => sseUnregister(chatKey, res));
});

// ── GET /groups ───────────────────────────────────────────────────────
// List all community groups (for debugging / admin).
app.get('/groups', (_req, res) => {
  const groups = Object.entries(store.data.communityGroups).map(([id, info]) => ({
    community_id: id,
    chatId: info.chatId,
    name: info.name,
    memberCount: info.memberUsernames.length,
    createdAt: info.createdAt,
  }));
  res.json({ groups });
});

// ── Startup ────────────────────────────────────────────────────────────
async function start() {
  dc.start();
  await ensureBotAccount();

  app.listen(PORT, () => {
    console.log(`\n[chat-service] listening on port ${PORT}`);
    console.log(`[chat-service] chatmail domain : ${CHATMAIL_DOMAIN}`);
    console.log(`[chat-service] dc accounts path: ${DC_ACCOUNTS_PATH}\n`);
  });
}

start().catch((err) => {
  console.error('[chat-service] fatal startup error:', err);
  process.exit(1);
});
