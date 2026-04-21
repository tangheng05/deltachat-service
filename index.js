import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DeltaChatClient } from './dc-client.js';
import { Store } from './store.js';
import { createRateLimiter } from './middleware/rateLimiter.js';
import { spamFilter } from './middleware/spamFilter.js';
import { blockCheck } from './middleware/blockCheck.js';
import { groupGuard } from './middleware/groupGuard.js';
import { requireRole } from './middleware/requireRole.js';

// ── Config ──────────────────────────────────────────────────────────
const __dirname = fileURLToPath(new URL('.', import.meta.url));
const PORT = process.env.CHAT_SERVICE_PORT || 4040;
const DC_ACCOUNTS_PATH = process.env.DC_ACCOUNTS_PATH || join(__dirname, 'dc-data');
const CHATMAIL_DOMAIN = process.env.CHATMAIL_DOMAIN || 'nine.testrun.org';

mkdirSync(DC_ACCOUNTS_PATH, { recursive: true });

const dc = new DeltaChatClient(DC_ACCOUNTS_PATH);
const store = new Store(join(DC_ACCOUNTS_PATH, 'store.json'));

// ── Middleware instances ─────────────────────────────────────────────
const rateLimitMap = new Map();
const rateLimiter = createRateLimiter(rateLimitMap);
const blockCheckMiddleware = blockCheck(store);

// ── Bot account ─────────────────────────────────────────────────────
let botAccountId = null;

async function ensureBotAccount() {
  if (botAccountId) return botAccountId;

  const cached = store.getAccount('__bot__');
  if (cached) {
    botAccountId = cached.accountId;
    await dc.rpc.startIo(botAccountId);
    return botAccountId;
  }

  console.log(`[bot] Provisioning system bot via ${CHATMAIL_DOMAIN}...`);
  const accountId = await dc.addAccount();
  await dc.setConfigFromQr(accountId, `dcaccount:https://${CHATMAIL_DOMAIN}/new`);
  await dc.setConfig(accountId, 'displayname', 'Serey System');
  await dc.configure(accountId);

  const addr = await dc.getConfig(accountId, 'addr');
  const password = await dc.getConfig(accountId, 'mail_pw');
  store.setAccount('__bot__', { accountId, addr, password });
  botAccountId = accountId;
  console.log(`[bot] Bot ready — accountId=${accountId}, addr=${addr}`);
  return botAccountId;
}

// ── SSE registry ────────────────────────────────────────────────────
// chatKey: "order:<id>" | "community:<id>" | "dm:<dmKey>" | "shopinbox:<id>"
const sseClients = new Map();

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
    try { res.write(data); } catch { /* disconnected */ }
  }
}

// ── DC event listener ────────────────────────────────────────────────
dc.on('IncomingMsg', async (contextId, event) => {
  const { chatId, msgId } = event;

  const orderId = store.findOrderIdByChatId(chatId);
  const communityId = orderId ? null : store.findCommunityIdByChatId(chatId);
  const dmKey = (!orderId && !communityId) ? store.findDmKeyByChatId(chatId) : null;

  if (!orderId && !communityId && !dmKey) return;

  let chatKey;
  if (orderId) chatKey = `order:${orderId}`;
  else if (communityId) chatKey = `community:${communityId}`;
  else chatKey = `dm:${dmKey}`;

  try {
    const msg = await dc.getMessage(contextId, msgId);
    const formatted = formatMessage(msg);
    sseBroadcast(chatKey, formatted);

    if (orderId) {
      const shopMatch = String(orderId).match(/^shop_(\d+)_/);
      if (shopMatch) {
        sseBroadcast(`shopinbox:${shopMatch[1]}`, { ...formatted, order_id: orderId });
      }
    }
  } catch (e) {
    console.error('[IncomingMsg] failed to fetch message:', e.message);
  }
});

// ── Helpers ──────────────────────────────────────────────────────────
function formatMessage(msg) {
  const raw = msg.text || '';
  const m = raw.match(/^(?:🛒 Buyer|🏪 Seller|💬 DM|💬)\s+\(([\w.-]+)\):\s*([\s\S]*)$/);
  return {
    id: msg.id,
    text: m ? m[2] : raw,
    senderUsername: m ? m[1] : null,
    isSystem: !m,
    timestamp: msg.timestamp,
    chatId: msg.chatId,
  };
}

const rand = (bytes) => randomBytes(bytes).toString('hex');

// ── Express ──────────────────────────────────────────────────────────
const app = express();
app.use(cors());
app.use(express.json());

// ── GET /health ───────────────────────────────────────────────────────
app.get('/health', (_req, res) => res.json({ status: 'ok', domain: CHATMAIL_DOMAIN }));

// ── POST /accounts ────────────────────────────────────────────────────
app.post('/accounts', async (req, res) => {
  const { username } = req.body;
  if (!username) return res.status(400).json({ error: 'username required' });

  try {
    let info = store.getAccount(username);
    if (!info) {
      const accountId = await dc.addAccount();
      await dc.setConfigFromQr(accountId, `dcaccount:https://${CHATMAIL_DOMAIN}/new`);
      await dc.setConfig(accountId, 'displayname', username);
      await dc.configure(accountId);
      const addr = await dc.getConfig(accountId, 'addr');
      const password = await dc.getConfig(accountId, 'mail_pw');
      info = { accountId, addr, password };
      store.setAccount(username, info);
      console.log(`[accounts] provisioned ${username} → ${addr}`);
    }
    res.json({ username, addr: info.addr });
  } catch (e) {
    console.error('[/accounts]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── POST /chats ───────────────────────────────────────────────────────
app.post('/chats', async (req, res) => {
  const { order_id, buyer_username, seller_username } = req.body;
  if (!order_id || !buyer_username || !seller_username)
    return res.status(400).json({ error: 'order_id, buyer_username, seller_username required' });

  try {
    let chat = store.getOrderChat(order_id);
    if (!chat) {
      const botId = await ensureBotAccount();
      const chatId = await dc.createGroupChat(botId, `Order #${order_id}`);
      chat = { chatId, buyerUsername: buyer_username, sellerUsername: seller_username, createdAt: Date.now() };
      store.setOrderChat(order_id, chat);
      console.log(`[chats] created order chat — orderId=${order_id} chatId=${chatId}`);
    }
    res.json({ order_id, chatId: chat.chatId, buyerUsername: chat.buyerUsername, sellerUsername: chat.sellerUsername });
  } catch (e) {
    console.error('[/chats]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── POST /send ────────────────────────────────────────────────────────
app.post('/send', (req, res, next) => {
  const chat = store.getOrderChat(req.body.order_id);
  if (chat) {
    req.blockCheckPairs = [
      [req.body.sender_username, chat.buyerUsername],
      [req.body.sender_username, chat.sellerUsername],
    ].filter(([a, b]) => a !== b);
  }
  req.chatContext = `order:${req.body.order_id}`;
  next();
}, blockCheckMiddleware, rateLimiter, spamFilter, async (req, res) => {
  const { order_id, sender_username, text } = req.body;
  if (!order_id || !sender_username || !text)
    return res.status(400).json({ error: 'order_id, sender_username, text required' });

  try {
    const chat = store.getOrderChat(order_id);
    if (!chat) return res.status(404).json({ error: 'Chat not found — call POST /chats first' });

    const botId = await ensureBotAccount();
    const role = chat.buyerUsername === sender_username ? '🛒 Buyer' : '🏪 Seller';
    const msgId = await dc.sendTextMsg(botId, chat.chatId, `${role} (${sender_username}): ${text}`);

    const payload = {
      id: msgId,
      text,
      senderUsername: sender_username,
      isSystem: false,
      timestamp: Math.floor(Date.now() / 1000),
    };
    sseBroadcast(`order:${order_id}`, payload);
    const shopMatch = String(order_id).match(/^shop_(\d+)_/);
    if (shopMatch) sseBroadcast(`shopinbox:${shopMatch[1]}`, { ...payload, order_id });

    res.json({ msgId });
  } catch (e) {
    console.error('[/send]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── POST /send-system ─────────────────────────────────────────────────
app.post('/send-system', async (req, res) => {
  const { order_id, old_status, new_status, order_total } = req.body;
  if (!order_id || !new_status)
    return res.status(400).json({ error: 'order_id and new_status required' });

  try {
    const chat = store.getOrderChat(order_id);
    if (!chat) return res.status(404).json({ error: 'Chat not found — call POST /chats first' });

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
    console.error('[/send-system]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── GET /messages ─────────────────────────────────────────────────────
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
    ).filter(Boolean).map(formatMessage);

    res.json({ messages });
  } catch (e) {
    console.error('[/messages]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── GET /events ───────────────────────────────────────────────────────
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
app.post('/groups', async (req, res) => {
  const { community_id, community_name, owner_username } = req.body;
  if (!community_id) return res.status(400).json({ error: 'community_id required' });

  try {
    let group = store.getCommunityGroup(community_id);
    if (!group) {
      const botId = await ensureBotAccount();
      const name = community_name || community_id;
      const chatId = await dc.createGroupChat(botId, `${name} Community`);
      group = {
        chatId,
        name,
        memberUsernames: owner_username ? [owner_username] : [],
        createdAt: Date.now(),
        ownerUsername: owner_username || null,
        announcementMode: false,
        joinMode: 'open',
        roles: owner_username ? { [owner_username]: 'owner' } : {},
        mutes: {},
        bans: {},
        pendingMembers: {},
      };
      store.setCommunityGroup(community_id, group);
      console.log(`[groups] created — communityId=${community_id} chatId=${chatId}`);
    }
    res.json({ community_id, chatId: group.chatId, name: group.name, memberCount: group.memberUsernames.length });
  } catch (e) {
    console.error('[/groups]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── GET /groups/:community_id ─────────────────────────────────────────
app.get('/groups/:community_id', (req, res) => {
  const { community_id } = req.params;
  const group = store.getCommunityGroup(community_id);
  if (!group) return res.status(404).json({ error: 'Group not found' });

  res.json({
    community_id,
    name: group.name,
    announcementMode: group.announcementMode ?? false,
    joinMode: group.joinMode ?? 'open',
    memberCount: group.memberUsernames.length,
    pendingCount: Object.keys(group.pendingMembers ?? {}).length,
  });
});

// ── POST /groups/:community_id/send ───────────────────────────────────
app.post('/groups/:community_id/send',
  (req, res, next) => {
    req.chatContext = `community:${req.params.community_id}`;
    next();
  },
  (req, res, next) => groupGuard(store, req, res, next),
  rateLimiter,
  spamFilter,
  async (req, res) => {
    const { community_id } = req.params;
    const { sender_username, text } = req.body;
    if (!sender_username || !text)
      return res.status(400).json({ error: 'sender_username and text required' });

    try {
      const group = store.getCommunityGroup(community_id);
      if (!group) return res.status(404).json({ error: 'Group not found — call POST /groups first' });

      const botId = await ensureBotAccount();
      const msgId = await dc.sendTextMsg(botId, group.chatId, `💬 (${sender_username}): ${text}`);

      sseBroadcast(`community:${community_id}`, {
        id: msgId,
        text,
        senderUsername: sender_username,
        isSystem: false,
        timestamp: Math.floor(Date.now() / 1000),
      });

      res.json({ msgId });
    } catch (e) {
      console.error('[/groups/:id/send]', e.message);
      res.status(500).json({ error: e.message });
    }
  }
);

// ── GET /groups/:community_id/messages ────────────────────────────────
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
    ).filter(Boolean).map(formatMessage);

    res.json({ messages });
  } catch (e) {
    console.error('[/groups/:id/messages]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── GET /groups/:community_id/events ──────────────────────────────────
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
app.get('/groups', (req, res) => {
  const { username } = req.query;
  const groups = Object.entries(store.data.communityGroups).map(([id, info]) => ({
    community_id: id,
    chatId: info.chatId,
    name: info.name,
    memberCount: info.memberUsernames.length,
    createdAt: info.createdAt,
    announcementMode: info.announcementMode ?? false,
    role: username ? ((info.roles ?? {})[username] ?? null) : undefined,
  }));
  res.json({ groups });
});

// ── POST /groups/:community_id/join ───────────────────────────────────
app.post('/groups/:community_id/join', (req, res) => {
  const { community_id } = req.params;
  const { username } = req.body;
  if (!username) return res.status(400).json({ error: 'username required' });

  const group = store.getCommunityGroup(community_id);
  if (!group) return res.status(404).json({ error: 'Group not found' });

  if ((group.bans ?? {})[username]) return res.status(403).json({ error: 'You are banned from this group' });

  // Already a member — idempotent
  if (group.memberUsernames.includes(username)) return res.json({ success: true, status: 'already_member' });

  if ((group.joinMode ?? 'open') === 'approval_required') {
    // Owner and admins can join directly even in approval mode
    const role = (group.roles ?? {})[username];
    if (role === 'owner' || role === 'admin') {
      store.setGroupMember(community_id, username, role);
      return res.json({ success: true, status: 'joined' });
    }
    store.addPendingMember(community_id, username);
    return res.status(202).json({ success: true, status: 'pending', message: 'Join request submitted. Awaiting approval.' });
  }

  store.setGroupMember(community_id, username, 'member');
  res.json({ success: true, status: 'joined' });
});

// ── POST /groups/:community_id/leave ──────────────────────────────────
app.post('/groups/:community_id/leave', (req, res) => {
  const { community_id } = req.params;
  const { username } = req.body;
  if (!username) return res.status(400).json({ error: 'username required' });

  const group = store.getCommunityGroup(community_id);
  if (!group) return res.status(404).json({ error: 'Group not found' });

  const roles = group.roles ?? {};
  if (roles[username] === 'owner') return res.status(400).json({ error: 'Owner must transfer ownership before leaving' });

  store.removeGroupMember(community_id, username);
  res.json({ success: true });
});

// ── POST /groups/:community_id/members ────────────────────────────────
app.post('/groups/:community_id/members', (req, res, next) => requireRole(store, 'admin', req, res, next), (req, res) => {
  const { community_id } = req.params;
  const { username } = req.body;
  if (!username) return res.status(400).json({ error: 'username required' });

  const group = store.getCommunityGroup(community_id);
  if (!group) return res.status(404).json({ error: 'Group not found' });

  if ((group.bans ?? {})[username]) return res.status(403).json({ error: 'User is banned' });

  store.setGroupMember(community_id, username, 'member');
  res.json({ success: true });
});

// ── GET /groups/:community_id/members ─────────────────────────────────
app.get('/groups/:community_id/members', (req, res) => {
  const { community_id } = req.params;
  const group = store.getCommunityGroup(community_id);
  if (!group) return res.status(404).json({ error: 'Group not found' });

  const roles = group.roles ?? {};
  const mutes = group.mutes ?? {};
  const bans = group.bans ?? {};
  const now = Date.now();

  const members = group.memberUsernames.map((username) => ({
    username,
    role: roles[username] ?? 'member',
    mutedUntil: mutes[username] != null ? (mutes[username] === 0 ? 'permanent' : mutes[username]) : null,
    isMuted: mutes[username] != null && (mutes[username] === 0 || mutes[username] > now),
  }));

  const bannedUsers = Object.entries(bans).map(([username, info]) => ({
    username,
    ...info,
    isBanned: true,
  }));

  res.json({ members, bannedUsers });
});

// ── DELETE /groups/:community_id/members/:username ────────────────────
app.delete('/groups/:community_id/members/:username', (req, res, next) => requireRole(store, 'moderator', req, res, next), (req, res) => {
  const { community_id, username } = req.params;
  const group = store.getCommunityGroup(community_id);
  if (!group) return res.status(404).json({ error: 'Group not found' });

  const roles = group.roles ?? {};
  if (roles[username] === 'owner') return res.status(403).json({ error: 'Cannot kick the owner' });

  store.removeGroupMember(community_id, username);
  res.json({ success: true });
});

// ── POST /groups/:community_id/members/:username/mute ─────────────────
app.post('/groups/:community_id/members/:username/mute', (req, res, next) => requireRole(store, 'moderator', req, res, next), (req, res) => {
  const { community_id, username } = req.params;
  const { duration_ms } = req.body;

  const group = store.getCommunityGroup(community_id);
  if (!group) return res.status(404).json({ error: 'Group not found' });

  const mutedUntil = duration_ms === 0 ? 0 : Date.now() + (duration_ms || 0);
  store.muteGroupMember(community_id, username, mutedUntil);
  res.json({ success: true, mutedUntil: mutedUntil === 0 ? 'permanent' : mutedUntil });
});

// ── DELETE /groups/:community_id/members/:username/mute ───────────────
app.delete('/groups/:community_id/members/:username/mute', (req, res, next) => requireRole(store, 'moderator', req, res, next), (req, res) => {
  const { community_id, username } = req.params;
  const group = store.getCommunityGroup(community_id);
  if (!group) return res.status(404).json({ error: 'Group not found' });

  store.unmuteGroupMember(community_id, username);
  res.json({ success: true });
});

// ── POST /groups/:community_id/members/:username/ban ──────────────────
app.post('/groups/:community_id/members/:username/ban', (req, res, next) => requireRole(store, 'moderator', req, res, next), (req, res) => {
  const { community_id, username } = req.params;
  const { actor_username, reason } = req.body;

  const group = store.getCommunityGroup(community_id);
  if (!group) return res.status(404).json({ error: 'Group not found' });

  const roles = group.roles ?? {};
  if (roles[username] === 'owner') return res.status(403).json({ error: 'Cannot ban the owner' });

  store.banGroupMember(community_id, username, actor_username, reason);
  res.json({ success: true });
});

// ── DELETE /groups/:community_id/members/:username/ban ────────────────
app.delete('/groups/:community_id/members/:username/ban', (req, res, next) => requireRole(store, 'moderator', req, res, next), (req, res) => {
  const { community_id, username } = req.params;
  const group = store.getCommunityGroup(community_id);
  if (!group) return res.status(404).json({ error: 'Group not found' });

  store.unbanGroupMember(community_id, username);
  res.json({ success: true });
});

// ── POST /groups/:community_id/members/:username/role ─────────────────
app.post('/groups/:community_id/members/:username/role', (req, res, next) => requireRole(store, 'admin', req, res, next), (req, res) => {
  const { community_id, username } = req.params;
  const { role, actor_username } = req.body;

  const validRoles = ['admin', 'moderator', 'member'];
  if (!validRoles.includes(role)) return res.status(400).json({ error: `role must be one of: ${validRoles.join(', ')}` });

  const group = store.getCommunityGroup(community_id);
  if (!group) return res.status(404).json({ error: 'Group not found' });

  const roles = group.roles ?? {};
  if (roles[username] === 'owner') return res.status(403).json({ error: 'Cannot change owner role — use transfer-ownership' });

  // Admins cannot promote others to admin (only owner can)
  const actorRole = roles[actor_username] ?? 'member';
  if (role === 'admin' && actorRole !== 'owner') return res.status(403).json({ error: 'Only the owner can promote to admin' });

  store.setGroupRole(community_id, username, role);
  res.json({ success: true });
});

// ── POST /groups/:community_id/transfer-ownership ─────────────────────
app.post('/groups/:community_id/transfer-ownership', (req, res) => {
  const { community_id } = req.params;
  const { actor_username, new_owner_username } = req.body;
  if (!actor_username || !new_owner_username) return res.status(400).json({ error: 'actor_username and new_owner_username required' });

  const group = store.getCommunityGroup(community_id);
  if (!group) return res.status(404).json({ error: 'Group not found' });

  const roles = group.roles ?? {};
  if (roles[actor_username] !== 'owner') return res.status(403).json({ error: 'Only the owner can transfer ownership' });

  store.setGroupRole(community_id, actor_username, 'admin');
  store.setGroupRole(community_id, new_owner_username, 'owner');
  res.json({ success: true });
});

// ── PUT /groups/:community_id/settings ────────────────────────────────
app.put('/groups/:community_id/settings', (req, res, next) => requireRole(store, 'admin', req, res, next), (req, res) => {
  const { community_id } = req.params;
  const { announcement_mode, join_mode } = req.body;

  const group = store.getCommunityGroup(community_id);
  if (!group) return res.status(404).json({ error: 'Group not found' });

  if (join_mode !== undefined && join_mode !== 'open' && join_mode !== 'approval_required') {
    return res.status(400).json({ error: 'join_mode must be "open" or "approval_required"' });
  }

  store.setGroupSettings(community_id, {
    announcementMode: announcement_mode,
    joinMode: join_mode,
  });
  res.json({ success: true, settings: { announcementMode: announcement_mode, joinMode: join_mode } });
});

// ── GET /groups/:community_id/join-requests ───────────────────────────
app.get('/groups/:community_id/join-requests', (req, res, next) => {
  // Inline admin check — requireRole reads actor_username from body, but this is GET
  const { community_id } = req.params;
  const { actor_username } = req.query;
  const group = store.getCommunityGroup(community_id);
  if (!group) return res.status(404).json({ error: 'Group not found' });

  const ROLE_RANK = { owner: 4, admin: 3, moderator: 2, member: 1 };
  const actorRole = (group.roles ?? {})[actor_username] ?? 'member';
  if ((ROLE_RANK[actorRole] ?? 1) < ROLE_RANK.admin) return res.status(403).json({ error: 'Admin or owner required' });

  res.json({ pendingMembers: store.getPendingMembers(community_id) });
});

// ── POST /groups/:community_id/join-requests/:username/approve ────────
app.post('/groups/:community_id/join-requests/:username/approve', (req, res, next) => requireRole(store, 'admin', req, res, next), (req, res) => {
  const { community_id, username } = req.params;
  const group = store.getCommunityGroup(community_id);
  if (!group) return res.status(404).json({ error: 'Group not found' });

  if (!(group.pendingMembers ?? {})[username]) {
    return res.status(404).json({ error: 'No pending request for this user' });
  }

  if ((group.bans ?? {})[username]) return res.status(403).json({ error: 'User is banned' });

  store.approvePendingMember(community_id, username);
  res.json({ success: true });
});

// ── DELETE /groups/:community_id/join-requests/:username ──────────────
app.delete('/groups/:community_id/join-requests/:username', (req, res, next) => requireRole(store, 'admin', req, res, next), (req, res) => {
  const { community_id, username } = req.params;
  const group = store.getCommunityGroup(community_id);
  if (!group) return res.status(404).json({ error: 'Group not found' });

  store.removePendingMember(community_id, username);
  res.json({ success: true });
});

// ── GET /shop-events/:shop_id ─────────────────────────────────────────
app.get('/shop-events/:shop_id', (req, res) => {
  const { shop_id } = req.params;
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  res.write('data: {"type":"connected"}\n\n');
  const chatKey = `shopinbox:${shop_id}`;
  sseRegister(chatKey, res);
  req.on('close', () => sseUnregister(chatKey, res));
});

// ── GET /shop-chats/:shop_id ───────────────────────────────────────────
app.get('/shop-chats/:shop_id', (req, res) => {
  const { shop_id } = req.params;
  const chats = store.getShopChats(shop_id);
  res.json({ chats });
});

// ── POST /moderation/block ────────────────────────────────────────────
app.post('/moderation/block', (req, res) => {
  const { blocker_username, target_username } = req.body;
  if (!blocker_username || !target_username) return res.status(400).json({ error: 'blocker_username and target_username required' });
  store.addBlock(blocker_username, target_username);
  res.json({ success: true });
});

// ── DELETE /moderation/block ──────────────────────────────────────────
app.delete('/moderation/block', (req, res) => {
  const { blocker_username, target_username } = req.body;
  if (!blocker_username || !target_username) return res.status(400).json({ error: 'blocker_username and target_username required' });
  store.removeBlock(blocker_username, target_username);
  res.json({ success: true });
});

// ── GET /moderation/blocks/:username ──────────────────────────────────
app.get('/moderation/blocks/:username', (req, res) => {
  const { username } = req.params;
  res.json({ blockedUsers: store.getBlocks(username) });
});

// ── POST /dm ──────────────────────────────────────────────────────────
app.post('/dm', async (req, res) => {
  const { user_a, user_b } = req.body;
  if (!user_a || !user_b) return res.status(400).json({ error: 'user_a and user_b required' });
  if (user_a === user_b) return res.status(400).json({ error: 'Cannot DM yourself' });

  const [u1, u2] = [user_a, user_b].sort();
  const dmKey = `${u1}:${u2}`;

  try {
    let dm = store.getDm(dmKey);
    if (!dm) {
      const botId = await ensureBotAccount();
      const chatId = await dc.createGroupChat(botId, `DM:${dmKey}`);
      dm = { chatId, userA: u1, userB: u2, createdAt: Date.now() };
      store.setDm(dmKey, dm);
      console.log(`[dm] created — dmKey=${dmKey} chatId=${chatId}`);
    }
    res.json({ dmKey, chatId: dm.chatId, userA: dm.userA, userB: dm.userB });
  } catch (e) {
    console.error('[/dm]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── POST /dm/:dm_key/send ─────────────────────────────────────────────
app.post('/dm/:dm_key/send', (req, res, next) => {
  const { dm_key } = req.params;
  const { sender_username } = req.body;
  const dm = store.getDm(dm_key);
  if (!dm) return res.status(404).json({ error: 'DM not found — call POST /dm first' });

  const other = dm.userA === sender_username ? dm.userB : dm.userA;
  req.blockCheckPairs = [[sender_username, other]];
  req.chatContext = `dm:${dm_key}`;
  next();
}, blockCheckMiddleware, rateLimiter, spamFilter, async (req, res) => {
  const { dm_key } = req.params;
  const { sender_username, text } = req.body;
  if (!sender_username || !text) return res.status(400).json({ error: 'sender_username and text required' });

  try {
    const dm = store.getDm(dm_key);
    if (dm.userA !== sender_username && dm.userB !== sender_username)
      return res.status(403).json({ error: 'Not a participant in this DM' });

    const botId = await ensureBotAccount();
    const msgId = await dc.sendTextMsg(botId, dm.chatId, `💬 DM (${sender_username}): ${text}`);

    sseBroadcast(`dm:${dm_key}`, {
      id: msgId,
      text,
      senderUsername: sender_username,
      isSystem: false,
      timestamp: Math.floor(Date.now() / 1000),
    });

    res.json({ msgId });
  } catch (e) {
    console.error('[/dm/:key/send]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── GET /dm/:dm_key/messages ──────────────────────────────────────────
app.get('/dm/:dm_key/messages', async (req, res) => {
  const { dm_key } = req.params;
  try {
    const dm = store.getDm(dm_key);
    if (!dm) return res.json({ messages: [] });

    const botId = await ensureBotAccount();
    const msgIds = await dc.getMessageIds(botId, dm.chatId);
    const messages = (
      await Promise.all(msgIds.map((id) => dc.getMessage(botId, id).catch(() => null)))
    ).filter(Boolean).map(formatMessage);

    res.json({ messages });
  } catch (e) {
    console.error('[/dm/:key/messages]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── GET /dm/:dm_key/events ────────────────────────────────────────────
app.get('/dm/:dm_key/events', (req, res) => {
  const { dm_key } = req.params;
  const chatKey = `dm:${dm_key}`;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  res.write('data: {"type":"connected"}\n\n');

  sseRegister(chatKey, res);
  req.on('close', () => sseUnregister(chatKey, res));
});

// ── GET /dm/user/:username ────────────────────────────────────────────
app.get('/dm/user/:username', (req, res) => {
  const { username } = req.params;
  res.json({ dms: store.getDmsForUser(username) });
});

// ── Graceful shutdown ──────────────────────────────────────────────────
function shutdown() { try { dc.close(); } catch {} }
process.on('exit', shutdown);
process.on('SIGINT', () => { shutdown(); process.exit(0); });
process.on('SIGTERM', () => { shutdown(); process.exit(0); });
process.on('uncaughtException', (err) => { console.error(err); shutdown(); process.exit(1); });

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
