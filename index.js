import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { randomBytes } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { DeltaChatClient } from './dc-client.js';
import { Store } from './store.js';
import { createRateLimiter } from './middleware/rateLimiter.js';
import { spamFilter } from './middleware/spamFilter.js';
import { blockCheck } from './middleware/blockCheck.js';
import { groupGuard } from './middleware/groupGuard.js';
import { requireRole } from './middleware/requireRole.js';
import { internalAuth } from './middleware/internalAuth.js';

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

// ── Timeout helper ───────────────────────────────────────────────────
function withTimeout(promise, ms, label = 'DC operation') {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    ),
  ]);
}

// Limit concurrency for bulk DC calls (getMessage × N)
async function mapConcurrent(items, fn, concurrency = 8) {
  const results = new Array(items.length);
  let idx = 0;
  async function worker() {
    while (idx < items.length) {
      const i = idx++;
      results[i] = await fn(items[i]).catch(() => null);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

// ── Multi-device account config ──────────────────────────────────────
// The chatmail provisioning default is delete_server_after=1, which deletes a
// message from the server ~1s after THIS service downloads it. When the same
// account is also logged into DC mobile, whichever side fetches first wins and
// the message vanishes for the other — so mobile intermittently misses messages
// the server grabbed first. Setting it to 0 leaves messages on the server
// (chatmail enforces its own delete_mails_after retention), so the web service
// and the phone can each fetch independently. bcc_self=1 makes messages sent
// from Serey web also appear on the user's phone.
async function applyMultiDeviceConfig(accountId) {
  await dc.setConfig(accountId, 'delete_server_after', '0');
  await dc.setConfig(accountId, 'bcc_self', '1');
}

// ── Bot account ─────────────────────────────────────────────────────
let botAccountId = null;
let _botProvisionPromise = null;

async function ensureBotAccount() {
  if (botAccountId) return botAccountId;
  if (_botProvisionPromise) return _botProvisionPromise;

  _botProvisionPromise = (async () => {
    try {
      const cached = store.getAccount('__bot__');
      if (cached) {
        botAccountId = cached.accountId;
        await withTimeout(dc.rpc.startIo(botAccountId), 15_000, 'startIo');
        ioStartedAt.set(botAccountId, Date.now());
        return botAccountId;
      }

      console.log(`[bot] Provisioning system bot via ${CHATMAIL_DOMAIN}...`);
      const accountId = await withTimeout(dc.addAccount(), 15_000, 'addAccount');
      await withTimeout(dc.setConfigFromQr(accountId, `dcaccount:https://${CHATMAIL_DOMAIN}/new`), 20_000, 'setConfigFromQr');
      await dc.setConfig(accountId, 'displayname', 'Serey System');
      await applyMultiDeviceConfig(accountId);
      await withTimeout(dc.configure(accountId), 30_000, 'configure');

      const addr = await dc.getConfig(accountId, 'addr');
      const password = await dc.getConfig(accountId, 'mail_pw');
      store.setAccount('__bot__', { accountId, addr, password });
      botAccountId = accountId;
      console.log(`[bot] Bot ready — accountId=${accountId}, addr=${addr}`);
      return botAccountId;
    } catch (e) {
      // Reset so the next request retries instead of re-awaiting the same failure
      _botProvisionPromise = null;
      botAccountId = null;
      throw e;
    }
  })();

  return _botProvisionPromise;
}

// ── Per-user account provisioning ───────────────────────────────────
const _userProvisionMap = new Map();

async function ensureUserAccount(username) {
  const cached = store.getAccount(username);
  if (cached?.accountId) return cached;

  if (_userProvisionMap.has(username)) return _userProvisionMap.get(username);

  const promise = (async () => {
    try {
      const accountId = await withTimeout(dc.addAccount(), 15_000, 'addAccount');
      await withTimeout(
        dc.setConfigFromQr(accountId, `dcaccount:https://${CHATMAIL_DOMAIN}/new`),
        20_000, 'setConfigFromQr'
      );
      await dc.setConfig(accountId, 'displayname', username);
      await applyMultiDeviceConfig(accountId);
      await withTimeout(dc.configure(accountId), 30_000, 'configure');

      const addr     = await dc.getConfig(accountId, 'addr');
      const password = await dc.getConfig(accountId, 'mail_pw');
      const info = { accountId, addr, password };
      store.setAccount(username, info);
      console.log(`[user-account] provisioned ${username} → ${addr}`);
      return info;
    } finally {
      _userProvisionMap.delete(username);
    }
  })();

  _userProvisionMap.set(username, promise);
  return promise;
}

// ── QR cache ─────────────────────────────────────────────────────────
// getChatSecurejoinQrCode can be slow (involves network token generation).
// Cache the result per account; invalidate after 30 minutes so tokens stay fresh.
const qrCache = new Map(); // accountId → { qr, expiresAt }
const QR_TTL_MS = 30 * 60 * 1_000;

const _qrInFlight = new Map(); // accountId → Promise

// Securejoin needs ~120s of continuous IO on the receiver's account to complete
// (two chatmail round-trips, each up to 60s). We linger IO for 3 minutes after
// every QR fetch — both cache hits and misses — so the handshake has room to
// finish. The 3-min window also covers the drain interval, so chatmail still
// gets push windows for mobile users between fetches.
const QR_IO_LINGER_MS = 3 * 60_000;

async function getQrCached(accountId) {
  const cached = qrCache.get(accountId);
  if (cached && cached.expiresAt > Date.now()) {
    // Cache hit: still start IO so securejoin can proceed if user is sharing QR
    dc.rpc.startIo(accountId).catch(() => {});
    ioSendLinger(accountId, QR_IO_LINGER_MS);
    return cached.qr;
  }
  if (_qrInFlight.has(accountId)) return _qrInFlight.get(accountId);
  const promise = (async () => {
    try {
      await dc.rpc.startIo(accountId).catch(() => {});
      const qr = await withTimeout(dc.rpc.getChatSecurejoinQrCode(accountId, null), 30_000, 'getChatSecurejoinQrCode');
      qrCache.set(accountId, { qr, expiresAt: Date.now() + QR_TTL_MS });
      ioSendLinger(accountId, QR_IO_LINGER_MS);
      return qr;
    } finally {
      _qrInFlight.delete(accountId);
    }
  })();
  _qrInFlight.set(accountId, promise);
  return promise;
}

function addDmChatId(dm, side, chatId) {
  if (!dm || !chatId) return dm;
  const primaryKey = side === 'A' ? 'userAChatId' : 'userBChatId';
  const listKey = side === 'A' ? 'userAChatIds' : 'userBChatIds';
  const list = Array.isArray(dm[listKey]) ? dm[listKey] : [];
  const merged = new Set(list);
  if (dm[primaryKey]) merged.add(dm[primaryKey]);
  merged.add(chatId);
  return { ...dm, [primaryKey]: chatId, [listKey]: [...merged] };
}

// Resolve the canonical chatId for a DM participant by looking up the contact
// address. DC may create a different chatId for the first incoming message
// (contact-request chat) vs the provisioned one. Updates the store in-place.
async function resolveCanonicalChatId(accountId, otherAddr, dmKey, isUserA) {
  const contactId = await withTimeout(
    dc.lookupContactIdByAddr(accountId, otherAddr), 8_000, 'lookupContactIdByAddr'
  ).catch(() => 0);
  if (!contactId) return 0;
  const resolved = await withTimeout(
    dc.createChatByContactId(accountId, contactId), 8_000, 'createChatByContactId'
  ).catch(() => 0);
  if (!resolved) return 0;
  const dm = store.getDm(dmKey);
  if (dm) {
    const updated = addDmChatId(dm, isUserA ? 'A' : 'B', resolved);
    if (updated !== dm) store.setDm(dmKey, updated);
  }
  return resolved;
}

// Uses DC securejoin to exchange Autocrypt keys between two per-user accounts.
// secureJoin is chatmail-compatible; plain messages fail until keys are exchanged.
// Deduplicated per dmKey — only one in-flight bootstrap at a time per DM pair.
// After failure, a 3-minute cooldown prevents hammering chatmail and keeps B's IO
// from running continuously (which would block mobile push notifications).
const _bootstrapInFlight = new Map(); // dmKey → Promise
const _bootstrapFailedAt = new Map(); // dmKey → timestamp of last failure
const BOOTSTRAP_COOLDOWN_MS = 3 * 60 * 1000; // 3 minutes (covers max attempt duration)

// Evict stale cooldown entries once per hour so the map doesn't grow unbounded
setInterval(() => {
  const cutoff = Date.now() - BOOTSTRAP_COOLDOWN_MS;
  for (const [key, ts] of _bootstrapFailedAt) {
    if (ts < cutoff) _bootstrapFailedAt.delete(key);
  }
}, 60 * 60 * 1000).unref();

function bootstrapDmKeys(dmKey, accountIdA, accountIdB) {
  if (_bootstrapInFlight.has(dmKey)) return _bootstrapInFlight.get(dmKey);
  const lastFail = _bootstrapFailedAt.get(dmKey);
  if (lastFail && Date.now() - lastFail < BOOTSTRAP_COOLDOWN_MS) {
    return Promise.resolve(); // still in cooldown — skip to let chatmail push to mobile
  }
  const promise = (async () => {
    try {
      // Both accounts need IO for the securejoin handshake.
      // Give IMAP a moment to connect before fetching the QR — startIo is
      // fire-and-forget; a securejoin started before IMAP is established stalls.
      await Promise.all([
        dc.rpc.startIo(accountIdA).catch(() => {}),
        dc.rpc.startIo(accountIdB).catch(() => {}),
      ]);
      await new Promise((r) => setTimeout(r, 3000));
      // Always fetch a fresh QR — cached tokens may have expired if a prior
      // attempt timed out.
      qrCache.delete(accountIdB);
      const qr = await withTimeout(
        dc.rpc.getChatSecurejoinQrCode(accountIdB, null), 30_000, 'bootstrap/getQr'
      );
      // Securejoin requires 2 chatmail round-trips (A→B→A via SMTP+IMAP).
      // chatmail IMAP polling can add up to ~60s per hop → full exchange up to ~120s.
      const chatIdInA = await withTimeout(
        dc.rpc.secureJoin(accountIdA, qr), 120_000, 'bootstrap/secureJoin'
      );
      _bootstrapFailedAt.delete(dmKey); // clear failure record on success
      const dm = store.getDm(dmKey);
      if (dm) {
        const isA = dm.userAAccountId === accountIdA;
        let update = { ...dm, securejoinDone: true };
        // Set A's chatId (returned by secureJoin).
        // secureJoin may return 0 when DC considers the contact already verified
        // but the chat was created under a different chatId — fall back to canonical
        // resolution so the sender always gets the correct post-securejoin chatId.
        if (chatIdInA) {
          update = addDmChatId(update, isA ? 'A' : 'B', chatIdInA);
        } else {
          const addrB = store.getAccount(isA ? dm.userB : dm.userA)?.addr;
          if (addrB) {
            const resolved = await resolveCanonicalChatId(accountIdA, addrB, dmKey, isA).catch(() => 0);
            if (resolved) update = addDmChatId(update, isA ? 'A' : 'B', resolved);
          }
        }
        // Also resolve B's chatId so B can read messages without waiting for IncomingMsg
        const addrA = store.getAccount(isA ? dm.userA : dm.userB)?.addr;
        if (addrA) {
          const chatIdInB = await resolveCanonicalChatId(accountIdB, addrA, dmKey, !isA).catch(() => 0);
          if (chatIdInB) update = addDmChatId(update, isA ? 'B' : 'A', chatIdInB);
        }
        store.setDm(dmKey, update);
        console.log(`[dm bootstrap] securejoin done for ${dmKey}`);
      }
      // Stop IO for any account not currently held open by an SSE client.
      // Keeping server IMAP alive blocks chatmail from pushing to mobile.
      // Web users (ioRefs > 0) are managed by ioAcquire/ioRelease — don't interfere.
      if ((ioRefs.get(accountIdA) || 0) === 0) dc.rpc.stopIo(accountIdA).catch(() => {});
      if ((ioRefs.get(accountIdB) || 0) === 0) dc.rpc.stopIo(accountIdB).catch(() => {});
    } catch (e) {
      console.error('[dm bootstrap] securejoin failed:', e.message);
      _bootstrapFailedAt.set(dmKey, Date.now()); // start cooldown
      if ((ioRefs.get(accountIdA) || 0) === 0) dc.rpc.stopIo(accountIdA).catch(() => {});
      if ((ioRefs.get(accountIdB) || 0) === 0) dc.rpc.stopIo(accountIdB).catch(() => {});
    } finally {
      _bootstrapInFlight.delete(dmKey);
    }
  })();
  _bootstrapInFlight.set(dmKey, promise);
  return promise;
}

// ── External-contact securejoin ──────────────────────────────────────
// For DMs with an external Delta Chat user we control only the Serey side, so
// we can't run the two-account bootstrap above. Instead we drive a securejoin
// from the stored OPENPGP4FPR QR the user scanned. chatmail refuses unencrypted
// mail, so a message sent before this handshake completes is silently dropped —
// the send path awaits this first. Deduplicated per dmKey.
const _extSecurejoinInFlight = new Map(); // dmKey → Promise

function ensureExtSecurejoin(dmKey, accountId, qr) {
  if (!qr || !accountId) return Promise.resolve();
  if (_extSecurejoinInFlight.has(dmKey)) return _extSecurejoinInFlight.get(dmKey);
  const promise = (async () => {
    try {
      await dc.rpc.startIo(accountId).catch(() => {});
      ioSendLinger(accountId, QR_IO_LINGER_MS);
      const newChatId = await withTimeout(dc.rpc.secureJoin(accountId, qr), 120_000, 'ext/secureJoin');
      const cur = store.getDm(dmKey);
      if (cur) {
        store.setDm(dmKey, {
          ...cur,
          securejoinDone: true,
          chatId: (newChatId && newChatId !== cur.chatId) ? newChatId : cur.chatId,
        });
      }
      console.log(`[ext securejoin] done for ${dmKey}`);
    } catch (e) {
      console.warn(`[ext securejoin] failed for ${dmKey}:`, e.message);
      throw e;
    } finally {
      _extSecurejoinInFlight.delete(dmKey);
    }
  })();
  _extSecurejoinInFlight.set(dmKey, promise);
  return promise;
}

// ── Per-user IO lifecycle ────────────────────────────────────────────
// Per-user DC accounts must NOT have IMAP running permanently.
// Chatmail only sends push notifications to mobile DC when no other IMAP
// client is actively polling the same inbox. If we keep IO alive for all
// accounts, the server consumes every new-message notification and mobile
// never gets a push — forcing the user to open DC to receive messages.
//
// Rule: IO is only alive when a web SSE client has that DM open.
// The send path starts IO transiently; it stops via the linger timer once
// no SSE client is watching.

const ioRefs = new Map();      // accountId → active SSE ref count
const ioLingers = new Map();   // accountId → setTimeout handle
const ioStartedAt = new Map(); // accountId → timestamp of last startIo
const IO_LINGER_MS = 45_000;  // keep IO alive 45s after last SSE client leaves
// Chatmail servers drop idle IMAP connections after ~1-2 hours. DC treats IO as
// still "running" (startIo is a no-op), so SMTP sends queue internally but never
// fire. Cycle IO every 50 minutes for SSE-held accounts to force reconnection.
const IO_REFRESH_MS = 50 * 60_000;

function ioAcquire(accountId) {
  if (!accountId) return;
  clearTimeout(ioLingers.get(accountId));
  ioLingers.delete(accountId);
  ioRefs.set(accountId, (ioRefs.get(accountId) || 0) + 1);
  dc.rpc.startIo(accountId).catch((e) =>
    console.warn(`[io] startIo failed for ${accountId}:`, e.message)
  );
  ioStartedAt.set(accountId, Date.now());
}

// Periodically cycle IO for SSE-held accounts whose connections may have gone
// stale. stopIo + startIo forces DC to re-authenticate and reconnect IMAP/SMTP.
setInterval(async () => {
  const now = Date.now();
  for (const [accountId, refs] of ioRefs) {
    if (refs <= 0) continue;
    const startedAt = ioStartedAt.get(accountId) || 0;
    if (now - startedAt < IO_REFRESH_MS) continue;
    try {
      await dc.rpc.stopIo(accountId).catch(() => {});
      await dc.rpc.startIo(accountId).catch(() => {});
      ioStartedAt.set(accountId, now);
      console.log(`[io] refreshed stale IO for account ${accountId}`);
    } catch (e) {
      console.warn(`[io] refresh failed for account ${accountId}:`, e.message);
    }
  }
  // Also refresh the bot account, which runs IO permanently.
  if (botAccountId) {
    const startedAt = ioStartedAt.get(botAccountId) || 0;
    if (now - startedAt >= IO_REFRESH_MS) {
      await dc.rpc.stopIo(botAccountId).catch(() => {});
      await dc.rpc.startIo(botAccountId).catch(() => {});
      ioStartedAt.set(botAccountId, now);
      console.log(`[io] refreshed stale IO for bot account ${botAccountId}`);
    }
  }
}, 10 * 60_000).unref(); // check every 10 min

function ioRelease(accountId) {
  if (!accountId) return;
  const refs = Math.max(0, (ioRefs.get(accountId) || 0) - 1);
  ioRefs.set(accountId, refs);
  if (refs > 0) return;
  // Linger so quick SSE reconnects and pending SMTP deliveries don't stall.
  const t = setTimeout(() => {
    ioLingers.delete(accountId);
    if ((ioRefs.get(accountId) || 0) === 0) {
      dc.rpc.stopIo(accountId).catch(() => {});
      console.log(`[io] stopped IO for account ${accountId} (no SSE refs)`);
    }
  }, IO_LINGER_MS);
  ioLingers.set(accountId, t);
}

// Bump the linger timer for a send or QR share — keeps IO alive long enough
// for SMTP delivery or securejoin handshake even when no SSE client is watching.
// Pass a custom `ms` to extend beyond the default IO_LINGER_MS (e.g. for QR).
function ioSendLinger(accountId, ms = IO_LINGER_MS) {
  if (!accountId) return;
  if ((ioRefs.get(accountId) || 0) > 0) return; // SSE already holds it
  clearTimeout(ioLingers.get(accountId));
  const t = setTimeout(() => {
    ioLingers.delete(accountId);
    if ((ioRefs.get(accountId) || 0) === 0) {
      dc.rpc.stopIo(accountId).catch(() => {});
    }
  }, ms);
  ioLingers.set(accountId, t);
}

function startAllUserIo() {
  // Only the bot account needs always-on IO (order/community chats).
  // Per-user accounts are managed by ioAcquire/ioRelease above.
  if (botAccountId) {
    dc.rpc.startIo(botAccountId).catch((e) =>
      console.warn('[startAllUserIo] bot startIo failed:', e.message)
    );
    ioStartedAt.set(botAccountId, Date.now());
  }
}

// ── SSE registry ────────────────────────────────────────────────────
// chatKey: "order:<id>" | "community:<id>" | "dm:<dmKey>" | "shopinbox:<id>"
const sseClients = new Map();

const recentOutgoingMsgIds = new Map();
const OUTGOING_TTL_MS = 60_000;

// Tracks message IDs edited via our API — overlays isEdited:true on GET responses
// regardless of whether DC has propagated isEdited to the sender's copy yet.
const editedMsgIds = new Set();

setInterval(() => {
  const now = Date.now();
  for (const [k, ts] of recentOutgoingMsgIds) {
    if (now - ts > OUTGOING_TTL_MS) recentOutgoingMsgIds.delete(k);
  }
}, 60_000).unref();

function markOutgoing(accountId, msgId) {
  if (!accountId || !msgId) return;
  recentOutgoingMsgIds.set(`${accountId}:${msgId}`, Date.now());
}

function isRecentOutgoing(accountId, msgId) {
  if (!accountId || !msgId) return false;
  const key = `${accountId}:${msgId}`;
  const now = Date.now();
  for (const [k, ts] of recentOutgoingMsgIds) {
    if (now - ts > OUTGOING_TTL_MS) recentOutgoingMsgIds.delete(k);
  }
  return recentOutgoingMsgIds.has(key);
}

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
  for (const res of [...clients]) {
    try { res.write(data); } catch { sseUnregister(chatKey, res); }
  }
}

// ── DC event listener ────────────────────────────────────────────────
dc.on('IncomingMsg', async (contextId, event) => {
  try {
  const { chatId, msgId } = event;

  // Order and community chats live exclusively in the bot account.
  // chatId numbers are local to each DC account — the same number in a user
  // account has no relation to the same number in the bot account, so we must
  // not look up order/community chatIds when the event comes from a user account.
  const isBot       = contextId === botAccountId;
  const orderId     = isBot ? store.findOrderIdByChatId(chatId) : null;
  const communityId = (isBot && !orderId) ? store.findCommunityIdByChatId(chatId) : null;
  // Pass contextId so chatId numbers from different accounts don't collide
  let   dmKey       = (!orderId && !communityId) ? store.findDmKeyByChatId(chatId, contextId) : null;

  // Handle inbound from DC mobile — chatId not yet in store, or landed in a
  // contact-request chat with a new chatId (different from the provisioned one).
  if (!orderId && !communityId && !dmKey) {
    try {
      const msg         = await dc.getMessage(contextId, msgId);
      const contact     = await dc.getContact(contextId, msg.fromId);
      const senderAddr  = contact.address;
      const senderUser  = store.findUsernameByAddr(senderAddr);
      const receiverUser = store.findUsernameByAccountId(contextId);

      if (senderUser && receiverUser) {
        const [u1, u2] = [senderUser, receiverUser].sort();
        dmKey = `${u1}:${u2}`;
        const existingDm = store.getDm(dmKey);

        if (!existingDm) {
          const receiverInfo = store.getAccount(receiverUser);
          const senderInfo   = store.getAccount(senderUser);
          const userAChatId = u1 === receiverUser ? chatId : null;
          const userBChatId = u2 === receiverUser ? chatId : null;
          store.setDm(dmKey, {
            userA: u1, userB: u2,
            userAAccountId: u1 === receiverUser ? receiverInfo.accountId : (senderInfo?.accountId || null),
            userAChatId,
            userBAccountId: u2 === receiverUser ? receiverInfo.accountId : (senderInfo?.accountId || null),
            userBChatId,
            userAChatIds: userAChatId ? [userAChatId] : [],
            userBChatIds: userBChatId ? [userBChatId] : [],
            createdAt: Date.now(),
          });
          // Accept so the receiver can reply immediately without waiting for bootstrap.
          dc.rpc.acceptChat(contextId, chatId).catch(() => {});
          console.log(`[IncomingMsg] auto-created DM for mobile sender ${senderAddr} → ${dmKey}`);
          // Notify receiver's web client so the new conversation appears immediately
          // without waiting for the 30-second poll.
          sseBroadcast(`user:${receiverUser}`, { type: 'new_dm', dmKey, otherUser: senderUser });
        } else {
          // Mobile message landed in a different chatId (e.g. contact-request chat).
          // Accept it and update the stored chatId so future reads find it.
          dc.rpc.acceptChat(contextId, chatId).catch(() => {});
          const isUserA = existingDm.userAAccountId === contextId;
          const storedChatId = isUserA ? existingDm.userAChatId : existingDm.userBChatId;
          if (storedChatId !== chatId) {
            const update = addDmChatId(existingDm, isUserA ? 'A' : 'B', chatId);
            store.setDm(dmKey, update);
            console.log(`[IncomingMsg] updated ${isUserA ? 'userA' : 'userB'} chatId ${storedChatId}→${chatId} for ${dmKey}`);
          }
        }
      } else if (receiverUser) {
        // External DC user — not provisioned in Serey, sender is from outside
        const extKey = `${receiverUser}:ext:${senderAddr}`;
        dmKey = extKey;
        dc.rpc.acceptChat(contextId, chatId).catch(() => {});
        const existingExtDm = store.getDm(extKey);
        if (!existingExtDm) {
          store.setDm(extKey, {
            dcExternal: true,
            sereUser: receiverUser,
            extAddr: senderAddr,
            extName: contact.displayName || senderAddr,
            sereAccountId: contextId,
            chatId,
            securejoinDone: true, // inbound mail proves keys are exchanged
            createdAt: Date.now(),
            lastMessage: null,
            lastMessageAt: 0,
            lastSeenBy: {},
          });
          console.log(`[IncomingMsg] created external DM ${extKey}`);
          sseBroadcast(`user:${receiverUser}`, { type: 'new_dm', dmKey: extKey, otherUser: senderAddr });
        } else if (existingExtDm.chatId !== chatId || !existingExtDm.securejoinDone) {
          // Securejoin created a new verified chat — update stored chatId so
          // dc.getMessageIds uses the correct chat when loading messages. Inbound
          // mail also confirms the key exchange completed.
          store.setDm(extKey, { ...existingExtDm, chatId, securejoinDone: true });
          console.log(`[IncomingMsg] updated dcExternal chatId for ${extKey}: ${existingExtDm.chatId} → ${chatId}`);
        }
      }
    } catch (e) {
      console.error('[IncomingMsg] mobile-sender lookup failed:', e.message);
    }
  }

  if (!orderId && !communityId && !dmKey) return;

  const chatKey = orderId     ? `order:${orderId}`
                : communityId ? `community:${communityId}`
                :               `dm:${dmKey}`;

  try {
    const msg = await dc.getMessage(contextId, msgId);
    if (!msg.text || msg.text === '​') return;
    if (msg.isInfo || DM_SYSTEM_NOISE.some((s) => (msg.text || '').toLowerCase().includes(s))) return;

    if (dmKey && isRecentOutgoing(contextId, msgId)) return;

    let formatted;
    if (dmKey) {
      const dm = store.getDm(dmKey);
      if (dm?.dcExternal) {
        formatted = formatDmMessage(msg, dm, dm.sereUser);
      } else if (dm?.userAAccountId) {
        // Per-user DM — identify sender by which account received the message
        const ownerUser = dm.userAAccountId === contextId ? dm.userA : dm.userB;
        formatted = formatDmMessage(msg, dm, ownerUser);
      } else if (dm) {
        // Legacy bot-DM — use bot-prefix parser
        formatted = formatMessage(msg);
      } else {
        formatted = formatMessage(msg);
      }
    } else {
      formatted = formatMessage(msg);
    }

    sseBroadcast(chatKey, formatted);

    if (dmKey && formatted && !formatted.isSystem) {
      store.addDmMessage(dmKey, formatted);
      const lastMsg = {
        text: formatted.text,
        senderUsername: formatted.senderUsername,
        timestamp: formatted.timestamp || Math.floor(Date.now() / 1000),
      };
      store.setDmLastMessage(dmKey, lastMsg);
      // Notify the receiving user's sidebar so it updates without requiring the
      // chat to be open. The dm:chatKey broadcast above only reaches clients
      // who already have that specific chat open.
      const dmRecord = store.getDm(dmKey);
      if (dmRecord) {
        let notifyUser = null;
        if (dmRecord.dcExternal) {
          notifyUser = dmRecord.sereUser;
        } else if (dmRecord.userAAccountId === contextId) {
          notifyUser = dmRecord.userA; // A's account received it → notify A
        } else if (dmRecord.userBAccountId === contextId) {
          notifyUser = dmRecord.userB; // B's account received it → notify B
        }
        if (notifyUser) {
          sseBroadcast(`user:${notifyUser}`, {
            type: 'dm_updated',
            dmKey,
            lastMessage: lastMsg,
          });
        }
      }
    }

    if (orderId) {
      const shopMatch = String(orderId).match(/^shop_(\d+)_/);
      if (shopMatch) {
        sseBroadcast(`shopinbox:${shopMatch[1]}`, { ...formatted, order_id: orderId });
      }
    }
  } catch (e) {
    console.error('[IncomingMsg] failed to fetch message:', e.message);
  }
  } catch (e) {
    console.error('[IncomingMsg] unhandled error:', e.message);
  }
});

// ── DC MsgDeleted event ───────────────────────────────────────────────
// Fired when DC processes a "Delete for Everyone" request from a remote DC
// client. DC has already removed the message locally; we broadcast to SSE
// so web clients remove it from their UI without needing a page reload.
dc.on('MsgDeleted', (contextId, event) => {
  try {
    const { chatId, msgId } = event;
    const isBot       = contextId === botAccountId;
    const orderId     = isBot ? store.findOrderIdByChatId(chatId) : null;
    const communityId = (isBot && !orderId) ? store.findCommunityIdByChatId(chatId) : null;
    const dmKey       = (!orderId && !communityId) ? store.findDmKeyByChatId(chatId, contextId) : null;

    const chatKey = orderId     ? `order:${orderId}`
                  : communityId ? `community:${communityId}`
                  :  dmKey      ? `dm:${dmKey}`
                  : null;

    if (!chatKey) return;

    if (dmKey) store.removeDmCachedMessage(dmKey, msgId);
    sseBroadcast(chatKey, { type: 'message_deleted', id: msgId });
  } catch (e) {
    console.error('[MsgDeleted]', e.message);
  }
});

// ── DC MsgsChanged event ──────────────────────────────────────────────
// Fired for any message state change. We only care about DM edits (isEdited).
// Community/order edits come only via REST and SSE is broadcast there directly.
dc.on('MsgsChanged', async (contextId, event) => {
  try {
    const { chatId, msgId } = event;
    if (!msgId) return;

    const dmKey = store.findDmKeyByChatId(chatId, contextId);
    if (!dmKey) return;

    const msg = await dc.getMessage(contextId, msgId).catch(() => null);
    if (!msg?.isEdited) return;

    const dm = store.getDm(dmKey);
    const ownerUser = dm?.userAAccountId === contextId ? dm.userA : dm?.userB;
    const formatted = formatDmMessage(msg, dm, ownerUser);
    if (!formatted || formatted.isSystem) return;

    store.updateDmCachedMessage(dmKey, msgId, { text: formatted.text });
    sseBroadcast(`dm:${dmKey}`, { type: 'message_edited', ...formatted });
  } catch (e) {
    console.error('[MsgsChanged]', e.message);
  }
});

// ── Helpers ──────────────────────────────────────────────────────────
const MSG_RE = /^(?:🛒 Buyer|🏪 Seller|💬 DM|💬)\s+\(([\w.-]+)\):\s*([\s\S]*)$/;

function formatMessage(msg) {
  const raw = msg.text || '';
  const m = raw.match(MSG_RE);

  let replyTo = null;
  if (msg.quote?.text) {
    const qt = msg.quote.text;
    const qm = qt.match(MSG_RE);
    replyTo = {
      id: msg.quote.msgId || null,
      text: (qm ? qm[2] : qt).substring(0, 200),
      senderUsername: qm ? qm[1] : (msg.quote.authorDisplayName || null),
    };
  }

  return {
    id: msg.id,
    text: m ? m[2] : raw,
    senderUsername: m ? m[1] : null,
    isSystem: !m,
    isEdited: msg.isEdited === true || editedMsgIds.has(msg.id),
    timestamp: msg.timestamp,
    chatId: msg.chatId,
    replyTo,
  };
}

const DM_SYSTEM_NOISE = [
  'requires end-to-end encryption',
  'messages are end-to-end encrypted',
  'end-to-end encrypted',
  'this message cannot be decrypted',
  'cannot be decrypted',
  'message corrupted',
  'establishing connection',
  'waiting for the device',
];

function formatDmMessage(msg, dm, viewerUsername) {
  // DC info messages (encryption warnings, group notices, etc.) — surface as system
  if (msg.isInfo || DM_SYSTEM_NOISE.some((s) => (msg.text || '').toLowerCase().includes(s))) {
    return { id: msg.id, text: msg.text || '', senderUsername: null, isSystem: true, isEdited: false, timestamp: msg.timestamp, chatId: msg.chatId, replyTo: null };
  }
  let replyTo = null;
  if (msg.quote?.text) {
    // DC leaves authorDisplayName empty for the account owner's own outgoing messages.
    // In a 1:1 DM there are only two participants, so empty = the viewer sent it.
    const quoteAuthor = msg.quote.authorDisplayName || viewerUsername;
    replyTo = {
      id: msg.quote.msgId || null,
      text: msg.quote.text.substring(0, 200),
      senderUsername: quoteAuthor,
    };
  }
  // DC message state > 16 = outgoing (18=preparing,19=draft,20=pending,24=failed,26=delivered,28=read)
  const senderUsername = (msg.state > 16)
    ? viewerUsername
    : dm.dcExternal
      ? (dm.extName || dm.extAddr)
      : (viewerUsername === dm.userA ? dm.userB : dm.userA);
  return {
    id: msg.id,
    text: msg.text || '',
    senderUsername,
    isSystem: false,
    isEdited: msg.isEdited === true || editedMsgIds.has(msg.id),
    timestamp: msg.timestamp,
    chatId: msg.chatId,
    replyTo,
  };
}

function dmMessageKey(msg) {
  const sender = msg?.senderUsername ?? '';
  const ts = msg?.timestamp ?? 0;
  const text = msg?.text ?? '';
  return `${sender}|${ts}|${text}`;
}

function mergeDmMessages(dcMessages, cachedMessages) {
  const byKey = new Map();
  for (const msg of cachedMessages || []) {
    byKey.set(dmMessageKey(msg), msg);
  }
  for (const msg of dcMessages || []) {
    const key = dmMessageKey(msg);
    if (!byKey.has(key)) {
      // Evict stale cache entries — covers two cases:
      // 1. Same ID, different key (timestamp drift)
      // 2. Same sender+timestamp, different text (message was edited)
      const senderTs = `${msg.senderUsername ?? ""}|${msg.timestamp ?? 0}|`;
      for (const [k, m] of byKey) {
        if ((msg.id != null && m.id === msg.id) || k.startsWith(senderTs)) {
          byKey.delete(k);
          break;
        }
      }
    }
    // DC entry always wins for ID/text — authoritative for viewer's account.
    // Preserve isEdited:true from cache: DC may not set it on the sender's copy immediately.
    const cachedIsEdited = byKey.get(key)?.isEdited === true;
    byKey.set(key, { ...msg, isEdited: msg.isEdited || cachedIsEdited || editedMsgIds.has(msg.id) });
  }
  return [...byKey.values()].sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0) || (a.id || 0) - (b.id || 0));
}

// ── Express ──────────────────────────────────────────────────────────
const app = express();
app.use(cors());
app.use(express.json());

// Timeout middleware — SSE endpoints are excluded (they stay open intentionally)
app.use((req, res, next) => {
  if (req.path.endsWith('/events') || req.path.includes('/shop-events/')) return next();
  const timer = setTimeout(() => {
    if (!res.headersSent) res.status(503).json({ error: 'Request timed out' });
  }, 20_000);
  res.on('finish', () => clearTimeout(timer));
  res.on('close', () => clearTimeout(timer));
  // Suppress "headers already sent" errors if the handler responds after timeout
  const origJson = res.json.bind(res);
  res.json = (...args) => { if (res.headersSent) return res; return origJson(...args); };
  next();
});

// ── GET /health ───────────────────────────────────────────────────────
app.get('/health', (_req, res) => res.json({ status: 'ok', domain: CHATMAIL_DOMAIN }));

const USERNAME_RE = /^[\w.-]{1,64}$/;

// ── POST /accounts ────────────────────────────────────────────────────
app.post('/accounts', async (req, res) => {
  const { username } = req.body;
  if (!username) return res.status(400).json({ error: 'username required' });
  if (!USERNAME_RE.test(username)) return res.status(400).json({ error: 'Invalid username' });
  try {
    const info = await ensureUserAccount(username);
    res.json({ username, addr: info.addr });
  } catch (e) {
    console.error('[/accounts]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── GET /accounts/:username ───────────────────────────────────────────
app.get('/accounts/:username', (req, res) => {
  const { username } = req.params;
  const info = store.getAccount(username);
  if (!info?.addr) return res.status(404).json({ error: 'Account not found — call POST /accounts first' });
  res.json({ username, addr: info.addr, password: info.password });
});

// ── GET /accounts/:username/qr ────────────────────────────────────────
app.get('/accounts/:username/qr', async (req, res) => {
  const { username } = req.params;
  const info = store.getAccount(username);
  if (!info?.accountId) return res.status(404).json({ error: 'Account not found' });
  try {
    const qr = await getQrCached(info.accountId);
    res.json({ qr });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /accounts/:username/key ───────────────────────────────────────
// Exports the account's PGP private key as an .asc file so the user can
// import it into DC mobile (Settings → Import Keys) to share the same
// encryption identity as the web account.
app.get('/accounts/:username/key', internalAuth, async (req, res) => {
  const { username } = req.params;
  const info = store.getAccount(username);
  if (!info?.accountId) return res.status(404).json({ error: 'Account not found' });
  const exportDir = join(tmpdir(), `dc-key-export-${info.accountId}-${Date.now()}`);
  try {
    mkdirSync(exportDir, { recursive: true });
    await dc.rpc.exportSelfKeys(info.accountId, exportDir, null);
    const files = readdirSync(exportDir);
    const keyFile = files.find((f) => f.endsWith('.asc'));
    if (!keyFile) return res.status(500).json({ error: 'Key export produced no file' });
    const keyData = readFileSync(join(exportDir, keyFile), 'utf8');
    res.setHeader('Content-Type', 'application/pgp-keys');
    res.setHeader('Content-Disposition', `attachment; filename="${username}-private-key.asc"`);
    res.send(keyData);
  } catch (e) {
    res.status(500).json({ error: e.message });
  } finally {
    try { rmSync(exportDir, { recursive: true, force: true }); } catch {}
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
  const { order_id, sender_username, text, reply_to } = req.body;
  if (!order_id || !sender_username || !text)
    return res.status(400).json({ error: 'order_id, sender_username, text required' });

  try {
    const chat = store.getOrderChat(order_id);
    if (!chat) return res.status(404).json({ error: 'Chat not found — call POST /chats first' });

    const botId = await ensureBotAccount();
    const role = chat.buyerUsername === sender_username ? '🛒 Buyer' : '🏪 Seller';
    const localId = Date.now();
    const shopMatch = String(order_id).match(/^shop_(\d+)_/);
    const replyTo = reply_to?.id ? { id: reply_to.id, text: reply_to.text || '', senderUsername: reply_to.senderUsername || null } : null;

    const payload = {
      id: localId,
      text,
      senderUsername: sender_username,
      isSystem: false,
      timestamp: Math.floor(localId / 1000),
      replyTo,
    };
    sseBroadcast(`order:${order_id}`, payload);
    if (shopMatch) sseBroadcast(`shopinbox:${shopMatch[1]}`, { ...payload, order_id });
    res.json({ msgId: localId });

    const replyToId = (reply_to?.id && typeof reply_to.id === 'number') ? reply_to.id : null;
    dc.sendTextMsg(botId, chat.chatId, `${role} (${sender_username}): ${text}`, replyToId)
      .then((realMsgId) => {
        sseBroadcast(`order:${order_id}`, { type: 'message_id_updated', localId, realId: realMsgId });
        if (shopMatch) sseBroadcast(`shopinbox:${shopMatch[1]}`, { type: 'message_id_updated', localId, realId: realMsgId, order_id });
      })
      .catch(e => console.error('[/send] DC error:', e.message));
  } catch (e) {
    console.error('[/send]', e.message);
    if (!res.headersSent) res.status(500).json({ error: e.message });
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
    let msgIds;
    try {
      msgIds = await withTimeout(dc.getMessageIds(botId, chat.chatId), 5_000, 'getMessageIds');
    } catch (_) {
      const newChatId = await dc.createGroupChat(botId, `Order #${order_id}`);
      store.setOrderChat(order_id, { ...chat, chatId: newChatId });
      console.log(`[orders] healed stale chatId for order ${order_id} → ${newChatId}`);
      msgIds = [];
    }
    const messages = (
      await mapConcurrent(msgIds, (id) => dc.getMessage(botId, id))
    ).filter(Boolean).map(formatMessage);

    res.json({ messages, lastSeenBy: chat.lastSeenBy || {} });
  } catch (e) {
    console.error('[/messages]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── POST /order-seen ─────────────────────────────────────────────────
app.post('/order-seen', (req, res) => {
  const { order_id, username } = req.body;
  if (!order_id || !username) return res.status(400).json({ error: 'order_id and username required' });
  const chat = store.getOrderChat(order_id);
  if (!chat) return res.status(404).json({ error: 'Chat not found' });
  if (chat.buyerUsername !== username && chat.sellerUsername !== username)
    return res.status(403).json({ error: 'Not a participant' });
  const nowSec = Math.floor(Date.now() / 1000);
  store.setOrderChatLastSeen(order_id, username, nowSec);
  sseBroadcast(`order:${order_id}`, { type: 'seen', username, seenAt: nowSec });
  res.json({ ok: true });
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
        enabled: false,
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

// ── POST /user-groups — create a personal group (max 3 per user) ─────
app.post('/user-groups', async (req, res) => {
  const { owner_username, name } = req.body;
  if (!owner_username || !name?.trim())
    return res.status(400).json({ error: 'owner_username and name required' });
  if (!USERNAME_RE.test(owner_username))
    return res.status(400).json({ error: 'Invalid owner_username' });

  if (store.countUserGroups(owner_username) >= 3)
    return res.status(403).json({ error: 'Maximum 3 groups per user' });

  try {
    const botId  = await ensureBotAccount();
    const chatId = await dc.createGroupChat(botId, name.trim());
    const group_id = `ug_${owner_username}_${Date.now()}`;
    const group = {
      type: 'user',
      chatId,
      name: name.trim(),
      ownerUsername: owner_username,
      memberUsernames: [owner_username],
      createdAt: Date.now(),
      announcementMode: false,
      joinMode: 'open',
      enabled: true,
      roles: { [owner_username]: 'owner' },
      mutes: {},
      bans: {},
      pendingMembers: {},
    };
    store.setCommunityGroup(group_id, group);
    console.log(`[user-groups] created — group_id=${group_id} owner=${owner_username} chatId=${chatId}`);
    res.status(201).json({ group_id, name: group.name, chatId, ownerUsername: owner_username });
  } catch (e) {
    console.error('[/user-groups POST]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── GET /user-groups/:username — list groups the user owns or is in ───
app.get('/user-groups/:username', (req, res) => {
  const { username } = req.params;
  res.json({ groups: store.getUserGroups(username) });
});

// ── PATCH /user-groups/:group_id — owner updates group settings ───────
app.patch('/user-groups/:group_id', (req, res) => {
  const { group_id } = req.params;
  const { owner_username, isPublic, name } = req.body;
  if (!owner_username) return res.status(400).json({ error: 'owner_username required' });

  const group = store.getCommunityGroup(group_id);
  if (!group) return res.status(404).json({ error: 'Group not found' });
  if (group.type !== 'user') return res.status(403).json({ error: 'Not a user group' });
  if (group.ownerUsername !== owner_username) return res.status(403).json({ error: 'Only the owner can update this group' });

  const updated = { ...group };
  if (typeof isPublic === 'boolean') updated.isPublic = isPublic;
  if (name?.trim()) updated.name = name.trim();
  store.setCommunityGroup(group_id, updated);
  res.json({ success: true, isPublic: updated.isPublic ?? false, name: updated.name });
});

// ── DELETE /user-groups/:group_id — owner deletes their group ─────────
app.delete('/user-groups/:group_id', async (req, res) => {
  const { group_id } = req.params;
  const { owner_username } = req.body;
  if (!owner_username) return res.status(400).json({ error: 'owner_username required' });

  const group = store.getCommunityGroup(group_id);
  if (!group) return res.status(404).json({ error: 'Group not found' });
  if (group.type !== 'user') return res.status(403).json({ error: 'Not a user group' });
  if (group.ownerUsername !== owner_username) return res.status(403).json({ error: 'Only the owner can delete this group' });

  try {
    const botId = await ensureBotAccount();
    await dc.deleteChat(botId, group.chatId).catch(() => {});
    store.setCommunityGroup(group_id, null);
    sseBroadcast(`community:${group_id}`, { type: 'group_deleted' });
    res.json({ success: true });
  } catch (e) {
    console.error('[/user-groups DELETE]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── POST /groups/:community_id/invite-links — create invite link ───────
// Any member can create an invite link.
app.post('/groups/:community_id/invite-links', (req, res) => {
  const { community_id } = req.params;
  const { actor_username } = req.body;
  if (!actor_username) return res.status(400).json({ error: 'actor_username required' });

  const group = store.getCommunityGroup(community_id);
  if (!group) return res.status(404).json({ error: 'Group not found' });

  if (!group.memberUsernames?.includes(actor_username))
    return res.status(403).json({ error: 'You are not a member of this group' });

  const token = randomBytes(8).toString('hex'); // 16-char hex
  store.createGroupInviteLink(community_id, token, actor_username);
  res.status(201).json({ token });
});

// ── GET /groups/:community_id/invite-links — list active links ──────────
// Members see only their own links; owner/admin see all.
app.get('/groups/:community_id/invite-links', (req, res) => {
  const { community_id } = req.params;
  const { actor_username } = req.query;
  if (!actor_username) return res.status(400).json({ error: 'actor_username required' });

  const group = store.getCommunityGroup(community_id);
  if (!group) return res.status(404).json({ error: 'Group not found' });

  if (!group.memberUsernames?.includes(actor_username))
    return res.status(403).json({ error: 'You are not a member of this group' });

  const role = (group.roles ?? {})[actor_username];
  const isPrivileged = role === 'owner' || role === 'admin';
  const allLinks = store.getGroupInviteLinks(community_id);
  const links = isPrivileged ? allLinks : allLinks.filter(l => l.createdBy === actor_username);
  res.json({ links });
});

// ── DELETE /groups/:community_id/invite-links/:token — revoke a link ───
// Owner/admin can revoke any link; members can only revoke their own.
app.delete('/groups/:community_id/invite-links/:token', (req, res) => {
  const { community_id, token } = req.params;
  const { actor_username } = req.body;
  if (!actor_username) return res.status(400).json({ error: 'actor_username required' });

  const group = store.getCommunityGroup(community_id);
  if (!group) return res.status(404).json({ error: 'Group not found' });

  if (!group.memberUsernames?.includes(actor_username))
    return res.status(403).json({ error: 'You are not a member of this group' });

  const role = (group.roles ?? {})[actor_username];
  const isPrivileged = role === 'owner' || role === 'admin';
  const link = store.getGroupInviteLinks(community_id).find(l => l.token === token);
  if (link && !isPrivileged && link.createdBy !== actor_username)
    return res.status(403).json({ error: 'You can only revoke your own invite links' });

  store.revokeGroupInviteLink(community_id, token);
  res.json({ success: true });
});

// ── GET /invite/:token — preview invite (group info, no join yet) ───────
app.get('/invite/:token', (req, res) => {
  const { token } = req.params;
  const result = store.getInviteLinkGroup(token);
  if (!result) return res.status(404).json({ error: 'Invite link not found or has been revoked' });

  const { groupId, group } = result;
  res.json({
    group_id: groupId,
    name: group.name,
    type: group.type ?? 'community',
    ownerUsername: group.ownerUsername ?? null,
    memberCount: group.memberUsernames?.length ?? 0,
  });
});

// ── POST /invite/:token/join — join group via invite link ───────────────
app.post('/invite/:token/join', (req, res) => {
  const { token } = req.params;
  const { username } = req.body;
  if (!username) return res.status(400).json({ error: 'username required' });

  const result = store.getInviteLinkGroup(token);
  if (!result) return res.status(404).json({ error: 'Invite link not found or has been revoked' });

  const { groupId, group } = result;

  if ((group.bans ?? {})[username])
    return res.status(403).json({ error: 'You are banned from this group', reason: 'banned' });

  if (group.memberUsernames?.includes(username))
    return res.json({ success: true, status: 'already_member', group_id: groupId, name: group.name });

  // Invite links bypass joinMode — the link itself is the invitation
  store.setGroupMember(groupId, username, 'member');
  sseBroadcast(`community:${groupId}`, { type: 'member_joined', username });
  res.json({ success: true, status: 'joined', group_id: groupId, name: group.name });
});

// ── POST /groups/:community_id/invite/send — DM an invite link to a Serey user ──
// Any group member can send an invite. Creates a token, opens/creates the DM,
// and sends a special __SEREY_GROUP_INVITE__ message the frontend renders as a card.
app.post('/groups/:community_id/invite/send', async (req, res) => {
  const { community_id } = req.params;
  const { actor_username, target_username } = req.body;
  if (!actor_username || !target_username)
    return res.status(400).json({ error: 'actor_username and target_username required' });
  if (actor_username === target_username)
    return res.status(400).json({ error: 'Cannot invite yourself' });

  const group = store.getCommunityGroup(community_id);
  if (!group) return res.status(404).json({ error: 'Group not found' });

  if (!group.memberUsernames?.includes(actor_username))
    return res.status(403).json({ error: 'You are not a member of this group' });

  if (group.memberUsernames?.includes(target_username))
    return res.status(409).json({ error: 'User is already a member' });

  if ((group.bans ?? {})[target_username])
    return res.status(403).json({ error: 'This user is banned from this group' });

  try {
    // Ensure DM exists between actor and target (same logic as POST /dm)
    const [u1, u2] = [actor_username, target_username].sort();
    const dmKey = `${u1}:${u2}`;
    let dm = store.getDm(dmKey);

    if (!dm) {
      const [infoA, infoB] = await Promise.all([ensureUserAccount(u1), ensureUserAccount(u2)]);
      const contactInA = await dc.createContact(infoA.accountId, infoB.addr, u2);
      const contactInB = await dc.createContact(infoB.accountId, infoA.addr, u1);
      const chatIdA = await dc.createChatByContactId(infoA.accountId, contactInA);
      const chatIdB = await dc.createChatByContactId(infoB.accountId, contactInB);
      dm = {
        userA: u1, userB: u2,
        userAAccountId: infoA.accountId, userAChatId: chatIdA,
        userBAccountId: infoB.accountId, userBChatId: chatIdB,
        userAChatIds: chatIdA ? [chatIdA] : [],
        userBChatIds: chatIdB ? [chatIdB] : [],
        createdAt: Date.now(),
      };
      store.setDm(dmKey, dm);
      bootstrapDmKeys(dmKey, infoA.accountId, infoB.accountId);
    }

    // Create a fresh token for this invite
    const token = randomBytes(8).toString('hex');
    store.createGroupInviteLink(community_id, token, actor_username);

    // Special marker the frontend detects and renders as an invite card
    const payload = JSON.stringify({ token, groupId: community_id, groupName: group.name, invitedBy: actor_username });
    const inviteText = `__SEREY_GROUP_INVITE__:${payload}`;

    // Send via actor's own DC account
    const senderInfo = store.getDmAccountAndChat(dmKey, actor_username);
    if (!senderInfo) return res.status(500).json({ error: 'DM account not provisioned' });

    await dc.rpc.startIo(senderInfo.accountId).catch(() => {});
    ioSendLinger(senderInfo.accountId);
    const realId = await dc.sendTextMsg(senderInfo.accountId, senderInfo.chatId, inviteText);
    markOutgoing(senderInfo.accountId, realId);

    const nowSec = Math.floor(Date.now() / 1000);
    const msgObj = { id: realId, text: inviteText, senderUsername: actor_username, isSystem: false, timestamp: nowSec };
    store.addDmMessage(dmKey, msgObj);
    store.setDmLastMessage(dmKey, { text: inviteText, senderUsername: actor_username, timestamp: nowSec });
    sseBroadcast(`dm:${dmKey}`, msgObj);

    res.json({ success: true, token, dmKey });
  } catch (e) {
    console.error('[/groups/invite/send]', e.message);
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
    type: group.type ?? 'community',
    ownerUsername: group.ownerUsername ?? null,
    announcementMode: group.announcementMode ?? false,
    joinMode: group.joinMode ?? 'open',
    enabled: group.enabled ?? true,
    memberCount: group.memberUsernames.length,
    pendingCount: Object.keys(group.pendingMembers ?? {}).length,
    lastSeenBy: group.lastSeenBy || {},
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
    const { sender_username, text, reply_to } = req.body;
    if (!sender_username || !text)
      return res.status(400).json({ error: 'sender_username and text required' });

    try {
      const group = store.getCommunityGroup(community_id);
      if (!group) return res.status(404).json({ error: 'Group not found — call POST /groups first' });

      const botId = await ensureBotAccount();
      const localId = Date.now();

      const nowSec = Math.floor(localId / 1000);
      const replyTo = reply_to?.id ? { id: reply_to.id, text: reply_to.text || '', senderUsername: reply_to.senderUsername || null } : null;
      sseBroadcast(`community:${community_id}`, {
        id: localId,
        text,
        senderUsername: sender_username,
        isSystem: false,
        timestamp: nowSec,
        replyTo,
      });
      store.setGroupLastMessage(community_id, { text, senderUsername: sender_username, timestamp: nowSec });
      res.json({ msgId: localId });

      const replyToId = (reply_to?.id && typeof reply_to.id === 'number') ? reply_to.id : null;
      dc.sendTextMsg(botId, group.chatId, `💬 (${sender_username}): ${text}`, replyToId)
        .then((realMsgId) => {
          sseBroadcast(`community:${community_id}`, { type: 'message_id_updated', localId, realId: realMsgId });
        })
        .catch(e => console.error('[/groups/:id/send] DC error:', e.message));
    } catch (e) {
      console.error('[/groups/:id/send]', e.message);
      if (!res.headersSent) res.status(500).json({ error: e.message });
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
    let msgIds;
    try {
      msgIds = await withTimeout(dc.getMessageIds(botId, group.chatId), 8_000, 'getMessageIds');
    } catch (_) {
      const newChatId = await dc.createGroupChat(botId, `${group.name || community_id} Community`);
      store.setCommunityGroup(community_id, { ...store.getCommunityGroup(community_id), chatId: newChatId });
      console.log(`[groups] healed stale chatId for community ${community_id} → ${newChatId}`);
      msgIds = [];
    }
    const recent = msgIds.slice(-limit);
    const messages = (
      await mapConcurrent(recent, (id) => dc.getMessage(botId, id))
    ).filter(Boolean).map(formatMessage);

    if (!group.lastMessage) {
      const last = [...messages].reverse().find((m) => m.text && !m.isSystem);
      if (last) store.setGroupLastMessage(community_id, { text: last.text, senderUsername: last.senderUsername, timestamp: last.timestamp || Math.floor(Date.now() / 1000) });
    }

    res.json({ messages });
  } catch (e) {
    console.error('[/groups/:id/messages]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── DELETE /groups/:community_id/messages/:msg_id ─────────────────────
// Own messages: any member. Others' messages: moderator+.
app.delete('/groups/:community_id/messages/:msg_id', async (req, res) => {
  const { community_id, msg_id } = req.params;
  const { actor_username } = req.body;
  if (!actor_username) return res.status(400).json({ error: 'actor_username required' });

  const group = store.getCommunityGroup(community_id);
  if (!group) return res.status(404).json({ error: 'Group not found' });

  const ROLE_RANK = { owner: 4, admin: 3, moderator: 2, member: 1 };
  const actorRank = ROLE_RANK[(group.roles ?? {})[actor_username]] ?? 1;

  try {
    const botId = await ensureBotAccount();
    const msg = await dc.getMessage(botId, Number(msg_id)).catch(() => null);
    if (!msg) return res.status(404).json({ error: 'Message not found' });

    // Extract sender from the formatted text "💬 (username): ..."
    const senderMatch = msg.text?.match(/^💬 \(([^)]+)\):/);
    const sender = senderMatch?.[1];

    const isOwn = sender === actor_username;
    const canModerate = actorRank >= ROLE_RANK.moderator;
    if (!isOwn && !canModerate) return res.status(403).json({ error: 'Not allowed' });

    await dc.deleteMessages(botId, [Number(msg_id)]);

    // Re-derive lastMessage — the deleted message may have been the most recent one
    try {
      const allIds = await dc.getMessageIds(botId, group.chatId);
      let newLast = null;
      for (const id of [...allIds].reverse().slice(0, 20)) {
        const m = await dc.getMessage(botId, id).catch(() => null);
        if (!m) continue;
        const fm = formatMessage(m);
        if (fm.text && !fm.isSystem) { newLast = fm; break; }
      }
      store.setGroupLastMessage(community_id, newLast
        ? { text: newLast.text, senderUsername: newLast.senderUsername, timestamp: newLast.timestamp || Math.floor(Date.now() / 1000) }
        : null);
    } catch {}

    sseBroadcast(`community:${community_id}`, { type: 'message_deleted', id: Number(msg_id) });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── PATCH /groups/:community_id/messages/:msg_id — edit own message ───
app.patch('/groups/:community_id/messages/:msg_id', async (req, res) => {
  const { community_id, msg_id } = req.params;
  const { actor_username, text } = req.body;
  if (!actor_username || !text?.trim()) return res.status(400).json({ error: 'actor_username and text required' });

  const group = store.getCommunityGroup(community_id);
  if (!group) return res.status(404).json({ error: 'Group not found' });

  try {
    const botId = await ensureBotAccount();
    const msg = await dc.getMessage(botId, Number(msg_id)).catch(() => null);
    if (!msg) return res.status(404).json({ error: 'Message not found' });

    const senderMatch = msg.text?.match(MSG_RE);
    if (senderMatch?.[1] !== actor_username) return res.status(403).json({ error: 'Can only edit your own messages' });

    const newRaw = `💬 (${actor_username}): ${text.trim()}`;
    await dc.editMessage(botId, Number(msg_id), newRaw);
    editedMsgIds.add(Number(msg_id));

    sseBroadcast(`community:${community_id}`, { type: 'message_edited', id: Number(msg_id), text: text.trim(), senderUsername: actor_username, isEdited: true });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── DELETE /groups/:community_id/messages — clear all (owner only) ────
app.delete('/groups/:community_id/messages', async (req, res) => {
  const { community_id } = req.params;
  const { actor_username } = req.body;
  if (!actor_username) return res.status(400).json({ error: 'actor_username required' });

  const group = store.getCommunityGroup(community_id);
  if (!group) return res.status(404).json({ error: 'Group not found' });

  if ((group.roles ?? {})[actor_username] !== 'owner')
    return res.status(403).json({ error: 'Only the owner can clear all messages' });

  try {
    const botId = await ensureBotAccount();
    const msgIds = await dc.getMessageIds(botId, group.chatId);
    if (msgIds.length) await dc.deleteMessages(botId, msgIds);
    store.setGroupLastMessage(community_id, null);
    sseBroadcast(`community:${community_id}`, { type: 'messages_cleared' });
    res.json({ success: true, deleted: msgIds.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /groups/:community_id/events ──────────────────────────────────
app.get('/groups/:community_id/events', (req, res) => {
  const { community_id } = req.params;
  const { username } = req.query;
  const broadcastKey = `community:${community_id}`;
  const userKey = username ? `community:${community_id}:${username}` : null;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  res.write('data: {"type":"connected"}\n\n');

  sseRegister(broadcastKey, res);
  if (userKey) sseRegister(userKey, res);

  req.on('close', () => {
    sseUnregister(broadcastKey, res);
    if (userKey) sseUnregister(userKey, res);
  });
});

// ── GET /groups ───────────────────────────────────────────────────────
// Returns community groups only. User groups are served via GET /user-groups/:username.
app.get('/groups', (req, res) => {
  const { username } = req.query;
  const groups = Object.entries(store.data.communityGroups)
    .filter(([, info]) => {
      if (info.enabled === false) return false;
      if ((info.type ?? 'community') === 'community') return true;
      if (info.type === 'user' && info.isPublic) return true;
      return false;
    })
    .map(([id, info]) => ({
      community_id: id,
      name: info.name,
      type: info.type ?? 'community',
      ownerUsername: info.ownerUsername ?? null,
      isPublic: info.isPublic ?? (info.type !== 'user'),
      memberCount: info.memberUsernames.length,
      createdAt: info.createdAt,
      announcementMode: info.announcementMode ?? false,
      joinMode: info.joinMode ?? 'open',
      enabled: info.enabled ?? true,
      role: username ? ((info.roles ?? {})[username] ?? null) : undefined,
      isMember: username ? info.memberUsernames.includes(username) : false,
      isPending: username ? !!(info.pendingMembers ?? {})[username] : false,
      lastMessage: info.lastMessage || null,
      lastSeenAt: username ? ((info.lastSeenBy ?? {})[username] ?? 0) : 0,
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

  if ((group.bans ?? {})[username]) return res.status(403).json({ error: 'You are banned from this group', reason: 'banned' });

  // Kicked users cannot auto-rejoin — they must use the explicit rejoin endpoint
  if ((group.kicks ?? {})[username]) return res.status(403).json({ error: 'You have been removed from this group', reason: 'kicked' });

  // Already a member — idempotent
  if (group.memberUsernames.includes(username)) return res.json({ success: true, status: 'already_member' });

  // Users who voluntarily left bypass approval — they were already trusted members
  if ((group.leftVoluntarily ?? {})[username]) {
    store.clearLeftVoluntarily(community_id, username);
    store.setGroupMember(community_id, username, 'member');
    return res.json({ success: true, status: 'joined' });
  }

  // Always preserve existing elevated role (owner/admin) regardless of join mode
  const existingRole = (group.roles ?? {})[username];
  if (existingRole === 'owner' || existingRole === 'admin') {
    store.setGroupMember(community_id, username, existingRole);
    return res.json({ success: true, status: 'joined' });
  }

  if ((group.joinMode ?? 'open') === 'approval_required') {
    store.addPendingMember(community_id, username);
    return res.status(202).json({ success: true, status: 'pending', message: 'Join request submitted. Awaiting approval.' });
  }

  store.setGroupMember(community_id, username, 'member');
  res.json({ success: true, status: 'joined' });
});

// ── POST /groups/:community_id/rejoin ─────────────────────────────────
// Explicitly re-request entry after being kicked. Clears the kick record,
// then goes through the normal join flow (open → instant; approval → pending).
app.post('/groups/:community_id/rejoin', (req, res) => {
  const { community_id } = req.params;
  const { username } = req.body;
  if (!username) return res.status(400).json({ error: 'username required' });

  const group = store.getCommunityGroup(community_id);
  if (!group) return res.status(404).json({ error: 'Group not found' });

  if ((group.bans ?? {})[username]) return res.status(403).json({ error: 'You are banned from this group', reason: 'banned' });

  // Clear the kick so the normal join can proceed
  store.clearKick(community_id, username);

  if ((group.joinMode ?? 'open') === 'approval_required') {
    const role = (group.roles ?? {})[username];
    if (role === 'owner' || role === 'admin') {
      store.setGroupMember(community_id, username, role);
      return res.json({ success: true, status: 'joined' });
    }
    store.addPendingMember(community_id, username);
    return res.status(202).json({ success: true, status: 'pending', message: 'Rejoin request submitted. Awaiting approval.' });
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
  sseBroadcast(`community:${community_id}:${username}`, { type: 'left' });
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

  const pendingUsernames = Object.keys(group.pendingMembers ?? {});
  res.json({ members, bannedUsers, pendingUsernames });
});

// ── DELETE /groups/:community_id/members/:username ────────────────────
app.delete('/groups/:community_id/members/:username', (req, res, next) => requireRole(store, 'moderator', req, res, next), (req, res) => {
  const { community_id, username } = req.params;
  const { actor_username } = req.body;
  const group = store.getCommunityGroup(community_id);
  if (!group) return res.status(404).json({ error: 'Group not found' });

  const roles = group.roles ?? {};
  if (roles[username] === 'owner') return res.status(403).json({ error: 'Cannot kick the owner' });

  store.kickGroupMember(community_id, username, actor_username || 'unknown');
  // Push real-time event to the kicked user's SSE stream
  sseBroadcast(`community:${community_id}:${username}`, { type: 'kicked' });
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
  // Push real-time event to the banned user's SSE stream
  sseBroadcast(`community:${community_id}:${username}`, { type: 'banned' });
  res.json({ success: true });
});

// ── DELETE /groups/:community_id/members/:username/ban ────────────────
app.delete('/groups/:community_id/members/:username/ban', (req, res, next) => requireRole(store, 'moderator', req, res, next), (req, res) => {
  const { community_id, username } = req.params;
  const group = store.getCommunityGroup(community_id);
  if (!group) return res.status(404).json({ error: 'Group not found' });

  store.unbanGroupMember(community_id, username);
  // Notify the unbanned user so their UI can update
  sseBroadcast(`community:${community_id}:${username}`, { type: 'unbanned' });
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
  // Notify the affected user so their UI updates in real-time
  sseBroadcast(`community:${community_id}:${username}`, { type: 'role_changed', role });
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
  const hasOwner = Object.values(roles).includes('owner');
  // Allow any admin to claim ownership if the group has no owner (recovery path)
  if (roles[actor_username] !== 'owner') {
    if (!hasOwner && (roles[actor_username] === 'admin' || roles[actor_username] === 'moderator')) {
      // Recovery: no owner exists, allow admin/moderator to assign one
    } else {
      return res.status(403).json({ error: 'Only the owner can transfer ownership' });
    }
  }

  if (roles[actor_username] === 'owner') store.setGroupRole(community_id, actor_username, 'admin');
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

// ── PATCH /groups/:community_id — rename (owner only) ────────────────
app.patch('/groups/:community_id', (req, res) => {
  const { community_id } = req.params;
  const { actor_username, name } = req.body;
  const group = store.getCommunityGroup(community_id);
  if (!group) return res.status(404).json({ error: 'Group not found' });
  if ((group.roles ?? {})[actor_username] !== 'owner')
    return res.status(403).json({ error: 'Only the owner can rename the group' });
  if (!name || typeof name !== 'string' || !name.trim())
    return res.status(400).json({ error: 'name is required' });
  store.renameGroup(community_id, name.trim());
  res.json({ success: true, name: name.trim() });
});

// ── PATCH /groups/:community_id/enabled — enable/disable (owner only) ────────
app.patch('/groups/:community_id/enabled', (req, res) => {
  const { community_id } = req.params;
  const { actor_username, enabled } = req.body;
  const group = store.getCommunityGroup(community_id);
  if (!group) return res.status(404).json({ error: 'Group not found' });
  if ((group.roles ?? {})[actor_username] !== 'owner')
    return res.status(403).json({ error: 'Only the owner can enable/disable the group chat' });
  if (typeof enabled !== 'boolean')
    return res.status(400).json({ error: 'enabled must be a boolean' });
  store.setGroupEnabled(community_id, enabled);
  res.json({ success: true, enabled });
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
  // Push real-time event to the approved user's SSE stream
  sseBroadcast(`community:${community_id}:${username}`, { type: 'approved' });
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

// ── DELETE /shop-chats/:order_id ──────────────────────────────────────
app.delete('/shop-chats/:order_id', async (req, res) => {
  const { order_id } = req.params;
  const { username } = req.body;
  if (!username) return res.status(400).json({ error: 'username required' });
  const chat = store.getOrderChat(order_id);
  if (!chat) return res.status(404).json({ error: 'Chat not found' });
  if (chat.buyerUsername !== username && chat.sellerUsername !== username)
    return res.status(403).json({ error: 'Not a participant' });
  try {
    const botId = await ensureBotAccount();
    await dc.deleteChat(botId, chat.chatId);
    store.deleteShopChat(order_id);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /shop-chats/buyer/:username ───────────────────────────────────
app.get('/shop-chats/buyer/:username', (req, res) => {
  const { username } = req.params;
  res.json({ chats: store.getShopChatsForBuyer(username) });
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
  if (!USERNAME_RE.test(user_a) || !USERNAME_RE.test(user_b)) return res.status(400).json({ error: 'Invalid username' });
  if (user_a === user_b) return res.status(400).json({ error: 'Cannot DM yourself' });

  const [u1, u2] = [user_a, user_b].sort();
  const dmKey = `${u1}:${u2}`;

  try {
    let dm = store.getDm(dmKey);

    if (dm && dm.chatId && !dm.userAAccountId && !dm.dcExternal) {
      // Legacy bot-DM — return as-is until migration runs
      return res.json({ dmKey, userA: dm.userA, userB: dm.userB, legacy: true });
    }

    if (!dm) {
      const [infoA, infoB] = await Promise.all([
        ensureUserAccount(u1),
        ensureUserAccount(u2),
      ]);
      const contactInA = await dc.createContact(infoA.accountId, infoB.addr, u2);
      const contactInB = await dc.createContact(infoB.accountId, infoA.addr, u1);
      const chatIdA    = await dc.createChatByContactId(infoA.accountId, contactInA);
      const chatIdB    = await dc.createChatByContactId(infoB.accountId, contactInB);
      dm = {
        userA: u1, userB: u2,
        userAAccountId: infoA.accountId, userAChatId: chatIdA,
        userBAccountId: infoB.accountId, userBChatId: chatIdB,
        userAChatIds: chatIdA ? [chatIdA] : [],
        userBChatIds: chatIdB ? [chatIdB] : [],
        createdAt: Date.now(),
      };
      store.setDm(dmKey, dm);
      console.log(`[dm] created per-user DM — dmKey=${dmKey}`);
      bootstrapDmKeys(dmKey, infoA.accountId, infoB.accountId);
    } else if (!dm.dcExternal && (!dm.userAAccountId || !dm.userBAccountId)) {
      // DM was auto-created by IncomingMsg (DC mobile sender) with only the
      // receiver's account filled in. Complete setup for the missing side now.
      const [infoA, infoB] = await Promise.all([
        ensureUserAccount(u1),
        ensureUserAccount(u2),
      ]);
      let update = { ...dm, userAAccountId: infoA.accountId, userBAccountId: infoB.accountId };
      if (!dm.userAChatId) {
        const contactInA = await dc.createContact(infoA.accountId, infoB.addr, u2).catch(() => 0);
        const chatIdA = contactInA ? await dc.createChatByContactId(infoA.accountId, contactInA).catch(() => 0) : 0;
        if (chatIdA) { update = addDmChatId(update, 'A', chatIdA); }
      }
      if (!dm.userBChatId) {
        const contactInB = await dc.createContact(infoB.accountId, infoA.addr, u1).catch(() => 0);
        const chatIdB = contactInB ? await dc.createChatByContactId(infoB.accountId, contactInB).catch(() => 0) : 0;
        if (chatIdB) { update = addDmChatId(update, 'B', chatIdB); }
      }
      store.setDm(dmKey, update);
      dm = update;
      console.log(`[dm] completed auto-DM setup — dmKey=${dmKey}`);
      if (!dm.securejoinDone) bootstrapDmKeys(dmKey, infoA.accountId, infoB.accountId);
    } else if (dm.userAAccountId && !dm.securejoinDone) {
      // Runs securejoin for any DM that hasn't completed it yet, including ones
      // that used the old ZWS bootstrap (which fails on chatmail).
      bootstrapDmKeys(dmKey, dm.userAAccountId, dm.userBAccountId);
    }

    res.json({ dmKey, userA: dm.userA, userB: dm.userB });
  } catch (e) {
    console.error('[/dm]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── POST /dm/external ────────────────────────────────────────────────
// Lets a Serey user initiate a DM to an external Delta Chat user.
// Body: { serey_username, ext_addr } OR { serey_username, qr_content }
// qr_content can be an OPENPGP4FPR: securejoin URI or a plain DC email address.
app.post('/dm/external', async (req, res) => {
  let { serey_username, ext_addr, qr_content } = req.body;

  // Parse ext_addr from QR/invite content. Both forms carry the address in a=:
  //   OPENPGP4FPR:FINGERPRINT#a=addr@host&...
  //   https://i.delta.chat/#FINGERPRINT&...&a=addr%40host&...   (URL-encoded)
  if (!ext_addr && qr_content) {
    const raw = String(qr_content).trim();
    const m = raw.match(/[?&#]a=([^&#\s]+)/i) || raw.match(/^OPENPGP4FPR:[^#]+#a=([^&#\s]+)/i);
    if (m) {
      try { ext_addr = decodeURIComponent(m[1]); } catch { ext_addr = m[1]; } // %40 → @
    } else if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(raw)) {
      ext_addr = raw; // plain email pasted
    }
  }

  if (!serey_username) return res.status(400).json({ error: 'serey_username required' });
  if (!ext_addr) return res.status(400).json({ error: 'ext_addr or valid qr_content required' });
  ext_addr = ext_addr.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(ext_addr))
    return res.status(400).json({ error: 'Invalid ext_addr — must be a valid email address' });

  const dmKey = `${serey_username}:ext:${ext_addr}`;

  // Idempotent — return existing DM straight away
  const existing = store.getDm(dmKey);
  if (existing?.dcExternal) return res.json({ dmKey, extAddr: ext_addr });

  try {
    const sereInfo = await ensureUserAccount(serey_username);
    const sereAccountId = sereInfo.accountId;

    await dc.rpc.startIo(sereAccountId).catch(() => {});
    ioSendLinger(sereAccountId, QR_IO_LINGER_MS);

    const contactId = await withTimeout(
      dc.createContact(sereAccountId, ext_addr, ext_addr), 8_000, 'createContact/external'
    );
    const chatId = await withTimeout(
      dc.createChatByContactId(sereAccountId, contactId), 8_000, 'createChatByContactId/external'
    );
    await dc.rpc.acceptChat(sereAccountId, chatId).catch(() => {});

    // A securejoin QR can arrive as an OPENPGP4FPR: URI or its https://i.delta.chat/
    // invite-link equivalent — both carry the i=/s= handshake tokens DC needs.
    const securejoinQr = (qr_content && /^(OPENPGP4FPR:|https:\/\/i\.delta\.chat\/)/i.test(String(qr_content)))
      ? String(qr_content)
      : null;

    store.setDm(dmKey, {
      dcExternal: true,
      sereUser: serey_username,
      extAddr: ext_addr,
      extName: ext_addr,
      sereAccountId,
      chatId,
      securejoinQr,        // kept so the send path can (re)run the handshake if needed
      securejoinDone: false,
      createdAt: Date.now(),
      lastMessage: null,
      lastMessageAt: 0,
      lastSeenBy: {},
    });

    // Kick off the securejoin handshake now. It only completes once the external
    // contact's device answers (so it may lag if they're offline), but starting
    // it here means the key is usually ready by the time the first message sends.
    if (securejoinQr) {
      ensureExtSecurejoin(dmKey, sereAccountId, securejoinQr).catch(() => {});
    }

    console.log(`[/dm/external] created — ${dmKey}`);
    res.json({ dmKey, extAddr: ext_addr });
  } catch (e) {
    console.error('[/dm/external]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── POST /dm/:dm_key/send ─────────────────────────────────────────────
app.post('/dm/:dm_key/send', (req, res, next) => {
  const { dm_key } = req.params;
  const { sender_username } = req.body;
  const dm = store.getDm(dm_key);
  if (!dm) return res.status(404).json({ error: 'DM not found — call POST /dm first' });
  req.chatContext = `dm:${dm_key}`;
  if (dm.dcExternal) {
    if (dm.sereUser !== sender_username)
      return res.status(403).json({ error: 'Not a participant' });
    return next();
  }
  const other = dm.userA === sender_username ? dm.userB : dm.userA;
  req.blockCheckPairs = [[sender_username, other], [other, sender_username]];
  next();
}, blockCheckMiddleware, rateLimiter, spamFilter, async (req, res) => {
  const { dm_key } = req.params;
  const { sender_username, text, reply_to } = req.body;
  if (!sender_username || !text) return res.status(400).json({ error: 'sender_username and text required' });

  try {
    const dm = store.getDm(dm_key);

    // External DC user DM — send directly via sereAccountId
    if (dm.dcExternal) {
      const localId = Date.now();
      const nowSec  = Math.floor(localId / 1000);
      const replyTo = reply_to?.id
        ? { id: reply_to.id, text: reply_to.text || '', senderUsername: reply_to.senderUsername || null }
        : null;
      const replyToId = (reply_to?.id && typeof reply_to.id === 'number') ? reply_to.id : null;
      sseBroadcast(`dm:${dm_key}`, { id: localId, text, senderUsername: sender_username, isSystem: false, timestamp: nowSec, replyTo });
      store.setDmLastMessage(dm_key, { text, senderUsername: sender_username, timestamp: nowSec });
      store.addDmMessage(dm_key, { id: localId, text, senderUsername: sender_username, isSystem: false, timestamp: nowSec, replyTo });
      res.json({ msgId: localId });
      (async () => {
        await dc.rpc.startIo(dm.sereAccountId).catch((e) => console.warn('[ext send] startIo:', e.message));
        ioSendLinger(dm.sereAccountId);
        // chatmail silently drops unencrypted mail, so a message sent before the
        // securejoin key exchange finishes just vanishes. Wait for the handshake
        // (or start one from the stored QR) before sending the first message.
        if (!dm.securejoinDone && dm.securejoinQr) {
          const inflight = _extSecurejoinInFlight.get(dm_key);
          await (inflight || ensureExtSecurejoin(dm_key, dm.sereAccountId, dm.securejoinQr)).catch(() => {});
        }
        // Re-read — securejoin may have stored a new verified chatId.
        const fresh = store.getDm(dm_key) || dm;
        const sendChatId = fresh.chatId;
        try {
          const realId = await dc.sendTextMsg(dm.sereAccountId, sendChatId, text, replyToId);
          store.replaceDmMessageId(dm_key, localId, realId);
          markOutgoing(dm.sereAccountId, realId);
          sseBroadcast(`dm:${dm_key}`, { type: 'message_id_updated', localId, realId });
        } catch (e) {
          // "key is missing" → handshake not done yet. Run it once and retry.
          const emsg = String(e.message || '').toLowerCase();
          if ((emsg.includes('key is missing') || emsg.includes('cannot send')) && fresh.securejoinQr) {
            try {
              await ensureExtSecurejoin(dm_key, dm.sereAccountId, fresh.securejoinQr);
              const retryChatId = (store.getDm(dm_key) || fresh).chatId;
              const realId = await dc.sendTextMsg(dm.sereAccountId, retryChatId, text, replyToId);
              store.replaceDmMessageId(dm_key, localId, realId);
              markOutgoing(dm.sereAccountId, realId);
              sseBroadcast(`dm:${dm_key}`, { type: 'message_id_updated', localId, realId });
              return;
            } catch (e2) {
              console.error('[/dm/:key/send ext] retry failed:', e2.message);
            }
          }
          console.error('[/dm/:key/send ext]', e.message);
          sseBroadcast(`dm:${dm_key}`, { type: 'message_send_failed', localId });
        }
      })();
      return;
    }

    if (dm.userA !== sender_username && dm.userB !== sender_username)
      return res.status(403).json({ error: 'Not a participant in this DM' });

    const localId = Date.now();
    const nowSec  = Math.floor(localId / 1000);
    const replyTo = reply_to?.id
      ? { id: reply_to.id, text: reply_to.text || '', senderUsername: reply_to.senderUsername || null }
      : null;

    // Legacy bot-DM fallback
    if (dm.chatId && !dm.userAAccountId) {
      const botId = await ensureBotAccount();
      sseBroadcast(`dm:${dm_key}`, { id: localId, text, senderUsername: sender_username, isSystem: false, timestamp: nowSec, replyTo });
      store.setDmLastMessage(dm_key, { text, senderUsername: sender_username, timestamp: nowSec });
      store.addDmMessage(dm_key, { id: localId, text, senderUsername: sender_username, isSystem: false, timestamp: nowSec, replyTo });
      res.json({ msgId: localId });
      const replyToId = (reply_to?.id && typeof reply_to.id === 'number') ? reply_to.id : null;
      dc.sendTextMsg(botId, dm.chatId, `💬 DM (${sender_username}): ${text}`, replyToId)
        .then((realId) => {
          store.replaceDmMessageId(dm_key, localId, realId);
          markOutgoing(botId, realId);
          sseBroadcast(`dm:${dm_key}`, { type: 'message_id_updated', localId, realId });
        })
        .catch((e) => console.error('[/dm/send legacy]', e.message));
      return;
    }

    // Per-user send — plain text, no prefix
    const senderInfo = store.getDmAccountAndChat(dm_key, sender_username);
    if (!senderInfo) return res.status(500).json({ error: 'Sender account not found' });

    sseBroadcast(`dm:${dm_key}`, { id: localId, text, senderUsername: sender_username, isSystem: false, timestamp: nowSec, replyTo });
    store.setDmLastMessage(dm_key, { text, senderUsername: sender_username, timestamp: nowSec });
    store.addDmMessage(dm_key, { id: localId, text, senderUsername: sender_username, isSystem: false, timestamp: nowSec, replyTo });
    res.json({ msgId: localId });

    const replyToId = (reply_to?.id && typeof reply_to.id === 'number') ? reply_to.id : null;
    const recipientUser = dm.userA === sender_username ? dm.userB : dm.userA;
    const recipientInfo = store.getAccount(recipientUser);
    (async () => {
      // Await startIo so IO is confirmed running before sendTextMsg queues the
      // message — otherwise a cold account leaves the message in the outbox for
      // up to startAllUserIo interval before SMTP delivery begins.
      await dc.rpc.startIo(senderInfo.accountId).catch((e) => {
        console.warn('[/dm/:key/send] startIo sender failed:', e.message);
      });
      // Await bootstrap before sending — chatmail silently drops unencrypted
      // messages with no error, so fire-and-forget causes the first message to
      // vanish. res.json is already sent, so this wait is invisible to the user.
      if (!dm.securejoinDone && recipientInfo?.accountId) {
        await bootstrapDmKeys(dm_key, dm.userAAccountId, dm.userBAccountId).catch(() => {});
      }
      const isUserA = dm.userA === sender_username;
      // Re-read from store after bootstrap — securejoin stores the verified chatId.
      // Do NOT call resolveCanonicalChatId when we have a stored chatId: DC's
      // createChatByContactId returns the OLD pre-securejoin chat (key missing),
      // not the verified securejoin chat.
      const freshChatId = store.getDmAccountAndChat(dm_key, sender_username)?.chatId;
      const canonical = freshChatId
        ? 0
        : (recipientInfo?.addr && senderInfo?.accountId)
          ? await resolveCanonicalChatId(senderInfo.accountId, recipientInfo.addr, dm_key, isUserA)
          : 0;
      const sendChatId = freshChatId || canonical || senderInfo.chatId;
      if (!sendChatId) {
        console.error('[/dm/:key/send] no valid chatId for', dm_key, sender_username);
        sseBroadcast(`dm:${dm_key}`, { type: 'message_send_failed', localId });
        return;
      }
      // Keep sender IO alive for the linger window so SMTP delivery
      // completes even if there is no SSE client holding a ref.
      ioSendLinger(senderInfo.accountId);
      try {
        const realId = await dc.sendTextMsg(senderInfo.accountId, sendChatId, text, replyToId);
        store.replaceDmMessageId(dm_key, localId, realId);
        markOutgoing(senderInfo.accountId, realId);
        sseBroadcast(`dm:${dm_key}`, { type: 'message_id_updated', localId, realId });
      } catch (e) {
        console.error('[/dm/:key/send]', e.message);
        // Common failure when securejoin/Autocrypt keys are missing. Attempt
        // one bootstrap + retry when the RPC reports a missing key for this chat.
        const emsg = String(e.message || '').toLowerCase();
        if (emsg.includes('key is missing') || emsg.includes('cannot send to chat#')) {
          try {
            console.log(`[/dm/:key/send] key missing; attempting securejoin for ${dm_key}`);
            await bootstrapDmKeys(dm_key, dm.userAAccountId, dm.userBAccountId);
            const refreshedSenderInfo = store.getDmAccountAndChat(dm_key, sender_username) || senderInfo;
            // After bootstrap, canonical chatId is resolved — use it directly.
            const retrySendChatId = refreshedSenderInfo.chatId
              || (recipientInfo?.addr
                ? await resolveCanonicalChatId(senderInfo.accountId, recipientInfo.addr, dm_key, isUserA).catch(() => 0)
                : 0);
            if (retrySendChatId) {
              const realId2 = await dc.sendTextMsg(senderInfo.accountId, retrySendChatId, text, replyToId);
              store.replaceDmMessageId(dm_key, localId, realId2);
              markOutgoing(senderInfo.accountId, realId2);
              sseBroadcast(`dm:${dm_key}`, { type: 'message_id_updated', localId, realId: realId2 });
              return;
            }
          } catch (e2) {
            console.error('[/dm/:key/send retry]', e2.message);
          }
        }
        sseBroadcast(`dm:${dm_key}`, { type: 'message_send_failed', localId });
      }
    })();
  } catch (e) {
    console.error('[/dm/:key/send]', e.message);
    if (!res.headersSent) res.status(500).json({ error: e.message });
  }
});

// ── GET /dm/:dm_key/messages ──────────────────────────────────────────
app.get('/dm/:dm_key/messages', async (req, res) => {
  const { dm_key } = req.params;
  const { username } = req.query;
  try {
    const dm = store.getDm(dm_key);
    if (!dm) return res.json({ messages: [], lastSeenBy: {} });

    // Legacy bot-DM fallback
    if (dm.chatId && !dm.userAAccountId && !dm.dcExternal) {
      const botId  = await ensureBotAccount();
      const msgIds = await dc.getMessageIds(botId, dm.chatId);
      const messages = (await mapConcurrent(msgIds, (id) => dc.getMessage(botId, id)))
        .filter(Boolean).map(formatMessage);
      if (!dm.lastMessage) {
        const last = [...messages].reverse().find((m) => m.text && !m.isSystem);
        if (last) store.setDmLastMessage(dm_key, { text: last.text, senderUsername: last.senderUsername, timestamp: last.timestamp || Math.floor(Date.now() / 1000) });
      }
      return res.json({ messages, lastSeenBy: dm.lastSeenBy || {} });
    }

    // External DC user DM — read from sereAccountId/chatId
    if (dm.dcExternal) {
      const { sereAccountId, chatId, sereUser, extAddr } = dm;
      if (sereAccountId) {
        dc.rpc.startIo(sereAccountId).catch(() => {});
        ioSendLinger(sereAccountId, QR_IO_LINGER_MS); // longer linger — IMAP sync is async
      }
      // Resolve canonical chatId via contact lookup, same as per-user DMs.
      // After securejoin DC may create a new verified chatId distinct from the
      // original contact-request chatId that was stored when the DM was created.
      let resolvedChatId = chatId;
      if (sereAccountId && extAddr) {
        const contactId = await withTimeout(
          dc.lookupContactIdByAddr(sereAccountId, extAddr), 6_000, 'ext/lookupContact'
        ).catch(() => 0);
        if (contactId) {
          const canonical = await withTimeout(
            dc.createChatByContactId(sereAccountId, contactId), 6_000, 'ext/createChatByContact'
          ).catch(() => 0);
          if (canonical && canonical !== chatId) {
            store.setDm(dm_key, { ...dm, chatId: canonical });
            resolvedChatId = canonical;
            console.log(`[messages] healed ext chatId ${dm_key}: ${chatId}→${canonical}`);
          }
        }
      }
      // Collect from both stored and resolved chatIds to cover the split-chat case
      const chatIds = [...new Set([chatId, resolvedChatId].filter(Boolean))];
      const idSets = await Promise.all(
        chatIds.map((cid) => dc.getMessageIds(sereAccountId, cid).catch(() => []))
      );
      const msgIds = [...new Map(idSets.flat().map((id) => [id, id])).values()];
      const messages = (await mapConcurrent(msgIds, (id) => dc.getMessage(sereAccountId, id)))
        .filter(Boolean).map((msg) => formatDmMessage(msg, dm, sereUser));
      const cachedMessages = store.getDmCachedMessages(dm_key);
      const mergedMessages = mergeDmMessages(messages, cachedMessages);
      if (!dm.lastMessage) {
        const last = [...mergedMessages].reverse().find((m) => m.text && !m.isSystem);
        if (last) store.setDmLastMessage(dm_key, { text: last.text, senderUsername: last.senderUsername, timestamp: last.timestamp });
      }
      return res.json({ messages: mergedMessages, lastSeenBy: dm.lastSeenBy || {} });
    }

    // Per-user: read from the requesting user's side
    const viewerUser = (username === dm.userA) ? dm.userA : dm.userB;
    const accountId  = (viewerUser === dm.userA) ? dm.userAAccountId : dm.userBAccountId;
    let   chatId     = (viewerUser === dm.userA) ? dm.userAChatId    : dm.userBChatId;

    // Wake IO for the viewer so IMAP syncs and messages appear.
    // ioSendLinger schedules the stop; startIo actually starts it if not running.
    if (accountId) {
      dc.rpc.startIo(accountId).catch(() => {});
      ioSendLinger(accountId);
    }

    const otherUser = viewerUser === dm.userA ? dm.userB : dm.userA;
    const otherInfo = store.getAccount(otherUser);
    const isViewerA = viewerUser === dm.userA;
    // Always resolve canonical chatId when possible so web stays in sync with
    // mobile devices (chatId is local to each client DB).
    const resolved = (otherInfo?.addr && accountId)
      ? await resolveCanonicalChatId(accountId, otherInfo.addr, dm_key, isViewerA)
      : 0;
    if (resolved && resolved !== chatId) {
      console.log(`[messages] chatId mismatch ${dm_key}/${viewerUser}: ${chatId}→${resolved} — healing`);
      chatId = resolved;
    }
    const canonicalChatId = resolved || chatId;
    const listKey = isViewerA ? 'userAChatIds' : 'userBChatIds';
    const storedList = Array.isArray(dm[listKey]) ? dm[listKey] : [];

    // Collect from all known chatIds to cover the split-chat case
    const chatIds = [...new Set([chatId, canonicalChatId, ...storedList].filter((cid) => cid))];
    const idSets = await Promise.all(
      chatIds.map((cid) => dc.getMessageIds(accountId, cid).catch(() => []))
    );
    const msgIds = [...new Map(idSets.flat().map((id) => [id, id])).values()];
    const messages = (await mapConcurrent(msgIds, (id) => dc.getMessage(accountId, id)))
      .filter(Boolean).map((msg) => formatDmMessage(msg, dm, viewerUser));

    const cachedMessages = store.getDmCachedMessages(dm_key);
    const mergedMessages = mergeDmMessages(messages, cachedMessages);

    if (!dm.lastMessage) {
      const last = [...mergedMessages].reverse().find((m) => m.text && !m.isSystem);
      if (last) store.setDmLastMessage(dm_key, { text: last.text, senderUsername: last.senderUsername, timestamp: last.timestamp });
    }

    res.json({ messages: mergedMessages, lastSeenBy: dm.lastSeenBy || {} });
  } catch (e) {
    console.error('[/dm/:key/messages]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── GET /dm/:dm_key/events ────────────────────────────────────────────
app.get('/dm/:dm_key/events', (req, res) => {
  const { dm_key } = req.params;
  const { username } = req.query;
  const chatKey = `dm:${dm_key}`;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  res.write('data: {"type":"connected"}\n\n');

  sseRegister(chatKey, res);

  // Acquire IO only for the web viewer's own account.
  // The OTHER participant is on mobile — their account must NOT have
  // server IO running or chatmail skips sending push to their device.
  const dm = store.getDm(dm_key);
  const viewerAccountId = dm
    ? (dm.dcExternal ? dm.sereAccountId : (username === dm.userA ? dm.userAAccountId : dm.userBAccountId))
    : null;
  ioAcquire(viewerAccountId);

  if (!dm?.dcExternal && dm?.userAAccountId && dm?.userBAccountId && !dm.securejoinDone) {
    bootstrapDmKeys(dm_key, dm.userAAccountId, dm.userBAccountId);
  }

  // Keepalive ping every 15s — prevents browsers and proxies from silently
  // dropping idle EventSource connections (the root cause of missed messages).
  const heartbeat = setInterval(() => {
    try { res.write(': ping\n\n'); } catch { clearInterval(heartbeat); }
  }, 15_000);

  req.on('close', () => {
    clearInterval(heartbeat);
    sseUnregister(chatKey, res);
    ioRelease(viewerAccountId);
  });
});

// ── POST /dm/:dm_key/mute ─────────────────────────────────────────────
app.post('/dm/:dm_key/mute', (req, res) => {
  const { dm_key } = req.params;
  const { username } = req.body;
  if (!username) return res.status(400).json({ error: 'username required' });
  const dm = store.getDm(dm_key);
  if (!dm) return res.status(404).json({ error: 'DM not found' });
  const isMuteParticipant = dm.dcExternal ? dm.sereUser === username : (dm.userA === username || dm.userB === username);
  if (!isMuteParticipant) return res.status(403).json({ error: 'Not a participant' });
  store.muteDm(username, dm_key);
  res.json({ success: true });
});

// ── DELETE /dm/:dm_key/mute ───────────────────────────────────────────
app.delete('/dm/:dm_key/mute', (req, res) => {
  const { dm_key } = req.params;
  const { username } = req.body;
  if (!username) return res.status(400).json({ error: 'username required' });
  const dm = store.getDm(dm_key);
  if (!dm) return res.status(404).json({ error: 'DM not found' });
  const isParticipant = dm.dcExternal ? dm.sereUser === username : (dm.userA === username || dm.userB === username);
  if (!isParticipant) return res.status(403).json({ error: 'Not a participant' });
  store.unmuteDm(username, dm_key);
  res.json({ success: true });
});

// ── POST /dm/:dm_key/seen ─────────────────────────────────────────────
app.post('/dm/:dm_key/seen', (req, res) => {
  const { dm_key } = req.params;
  const { username } = req.body;
  if (!username) return res.status(400).json({ error: 'username required' });
  const dm = store.getDm(dm_key);
  if (!dm) return res.status(404).json({ error: 'DM not found' });
  const isParticipant = dm.dcExternal ? dm.sereUser === username : (dm.userA === username || dm.userB === username);
  if (!isParticipant) return res.status(403).json({ error: 'Not a participant' });
  const nowSec = Math.floor(Date.now() / 1000);
  store.setDmLastSeen(dm_key, username, nowSec);
  sseBroadcast(`dm:${dm_key}`, { type: 'seen', username, seenAt: nowSec });
  res.json({ ok: true });
});

// ── POST /groups/:community_id/seen ──────────────────────────────────
app.post('/groups/:community_id/seen', (req, res) => {
  const { community_id } = req.params;
  const { username } = req.body;
  if (!username) return res.status(400).json({ error: 'username required' });
  const group = store.getCommunityGroup(community_id);
  if (!group) return res.status(404).json({ error: 'Group not found' });
  if (!group.memberUsernames.includes(username)) return res.status(403).json({ error: 'Not a member' });
  const nowSec = Math.floor(Date.now() / 1000);
  store.setGroupLastSeen(community_id, username, nowSec);
  sseBroadcast(`community:${community_id}`, { type: 'seen', username, seenAt: nowSec });
  res.json({ ok: true });
});

// ── DELETE /dm/:dm_key/messages/:message_id ───────────────────────────
app.delete('/dm/:dm_key/messages/:message_id', async (req, res) => {
  const { dm_key, message_id } = req.params;
  const { sender_username } = req.body;
  if (!sender_username) return res.status(400).json({ error: 'sender_username required' });

  const dm = store.getDm(dm_key);
  if (!dm) return res.status(404).json({ error: 'DM not found' });
  const isDelParticipant = dm.dcExternal ? dm.sereUser === sender_username : (dm.userA === sender_username || dm.userB === sender_username);
  if (!isDelParticipant) return res.status(403).json({ error: 'Not a participant' });

  try {
    const msgIdNum = parseInt(message_id, 10);
    if (isNaN(msgIdNum)) return res.status(400).json({ error: 'Invalid message_id' });

    let deleteAccountId;
    if (dm.dcExternal) {
      deleteAccountId = dm.sereAccountId;
    } else if (dm.chatId && !dm.userAAccountId) {
      deleteAccountId = await ensureBotAccount();
    } else {
      const info = store.getDmAccountAndChat(dm_key, sender_username);
      if (!info) return res.status(500).json({ error: 'Account not found' });
      deleteAccountId = info.accountId;
    }

    try {
      await dc.deleteMessages(deleteAccountId, [msgIdNum]);
    } catch (dcErr) {
      // DC may report "does not exist" when the message was already purged — this
      // happens for contact-request messages after acceptChat reassigns their IDs.
      // Treat it as a success: the message is already gone from DC's side.
      if (!/does not exist/i.test(dcErr.message)) throw dcErr;
      console.warn('[/dm/:key/messages/:id DELETE] DC already purged Msg#' + msgIdNum + ', cleaning cache');
    }
    store.removeDmCachedMessage(dm_key, msgIdNum);
    sseBroadcast(`dm:${dm_key}`, { type: 'message_deleted', id: msgIdNum });
    res.json({ success: true });
  } catch (e) {
    console.error('[/dm/:key/messages/:id DELETE]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── PATCH /dm/:dm_key/messages/:message_id — edit own DM message ──────
app.patch('/dm/:dm_key/messages/:message_id', async (req, res) => {
  const { dm_key, message_id } = req.params;
  const { sender_username, text } = req.body;
  if (!sender_username || !text?.trim()) return res.status(400).json({ error: 'sender_username and text required' });

  const dm = store.getDm(dm_key);
  if (!dm) return res.status(404).json({ error: 'DM not found' });

  const isParticipant = dm.dcExternal ? dm.sereUser === sender_username : (dm.userA === sender_username || dm.userB === sender_username);
  if (!isParticipant) return res.status(403).json({ error: 'Not a participant' });

  try {
    const msgIdNum = parseInt(message_id, 10);
    if (isNaN(msgIdNum)) return res.status(400).json({ error: 'Invalid message_id' });

    let accountId;
    if (dm.dcExternal) {
      accountId = dm.sereAccountId;
    } else if (dm.chatId && !dm.userAAccountId) {
      accountId = await ensureBotAccount();
    } else {
      const info = store.getDmAccountAndChat(dm_key, sender_username);
      if (!info) return res.status(500).json({ error: 'Account not found' });
      accountId = info.accountId;
    }

    const msg = await dc.getMessage(accountId, msgIdNum).catch(() => null);
    if (!msg) return res.status(404).json({ error: 'Message not found' });

    await dc.editMessage(accountId, msgIdNum, text.trim());
    editedMsgIds.add(msgIdNum);

    store.updateDmCachedMessage(dm_key, msgIdNum, { text: text.trim(), isEdited: true });
    sseBroadcast(`dm:${dm_key}`, { type: 'message_edited', id: msgIdNum, text: text.trim(), senderUsername: sender_username, isEdited: true });
    res.json({ success: true });
  } catch (e) {
    console.error('[/dm/:key/messages/:id PATCH]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── DELETE /messages/:order_id/:message_id ───────────────────────────
app.delete('/messages/:order_id/:message_id', async (req, res) => {
  const order_id    = decodeURIComponent(req.params.order_id);
  const message_id  = req.params.message_id;
  const { sender_username } = req.body;
  if (!sender_username) return res.status(400).json({ error: 'sender_username required' });

  const chat = store.getOrderChat(order_id);
  if (!chat) {
    console.error(`[msg delete] order not found: "${order_id}"`);
    return res.status(404).json({ error: 'Chat not found' });
  }
  // Allow if sender is buyer OR seller, case-insensitive
  const buyer  = (chat.buyerUsername  || '').toLowerCase();
  const seller = (chat.sellerUsername || '').toLowerCase();
  const sender = (sender_username     || '').toLowerCase();
  if (buyer !== sender && seller !== sender)
    return res.status(403).json({ error: 'Not a participant' });

  try {
    const botId    = await ensureBotAccount();
    const msgIdNum = parseInt(message_id, 10);
    if (isNaN(msgIdNum)) return res.status(400).json({ error: 'Invalid message_id' });
    await dc.deleteMessages(botId, [msgIdNum]);
    sseBroadcast(`order:${order_id}`, { type: 'message_deleted', id: msgIdNum });
    res.json({ success: true });
  } catch (e) {
    console.error('[/messages/:order_id/:id DELETE]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── PATCH /messages/:order_id/:message_id — edit own order message ───
app.patch('/messages/:order_id/:message_id', async (req, res) => {
  const order_id   = decodeURIComponent(req.params.order_id);
  const message_id = req.params.message_id;
  const { sender_username, text } = req.body;
  if (!sender_username || !text?.trim()) return res.status(400).json({ error: 'sender_username and text required' });

  const chat = store.getOrderChat(order_id);
  if (!chat) return res.status(404).json({ error: 'Chat not found' });

  const buyer  = (chat.buyerUsername  || '').toLowerCase();
  const seller = (chat.sellerUsername || '').toLowerCase();
  const sender = (sender_username     || '').toLowerCase();
  if (buyer !== sender && seller !== sender) return res.status(403).json({ error: 'Not a participant' });

  try {
    const botId    = await ensureBotAccount();
    const msgIdNum = parseInt(message_id, 10);
    if (isNaN(msgIdNum)) return res.status(400).json({ error: 'Invalid message_id' });

    const msg = await dc.getMessage(botId, msgIdNum).catch(() => null);
    if (!msg) return res.status(404).json({ error: 'Message not found' });

    const senderMatch = msg.text?.match(MSG_RE);
    if (senderMatch?.[1]?.toLowerCase() !== sender) return res.status(403).json({ error: 'Can only edit your own messages' });

    const prefix = msg.text.startsWith('🛒') ? `🛒 Buyer (${sender_username}): `
                 : msg.text.startsWith('🏪') ? `🏪 Seller (${sender_username}): `
                 : `💬 (${sender_username}): `;
    await dc.editMessage(botId, msgIdNum, prefix + text.trim());
    editedMsgIds.add(msgIdNum);

    sseBroadcast(`order:${order_id}`, { type: 'message_edited', id: msgIdNum, text: text.trim(), senderUsername: sender_username, isEdited: true });
    res.json({ success: true });
  } catch (e) {
    console.error('[/messages/:order_id/:id PATCH]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── DELETE /dm/:dm_key ────────────────────────────────────────────────
app.delete('/dm/:dm_key', async (req, res) => {
  const { dm_key } = req.params;
  const { username } = req.body;
  if (!username) return res.status(400).json({ error: 'username required' });

  const dm = store.getDm(dm_key);
  if (!dm) return res.status(404).json({ error: 'DM not found' });
  const isConvParticipant = dm.dcExternal ? dm.sereUser === username : (dm.userA === username || dm.userB === username);
  if (!isConvParticipant) return res.status(403).json({ error: 'Not a participant' });

  try {
    if (dm.dcExternal) {
      await dc.deleteChat(dm.sereAccountId, dm.chatId).catch(() => {});
    } else if (dm.chatId && !dm.userAAccountId) {
      // Legacy bot-DM
      const botId = await ensureBotAccount();
      await dc.deleteChat(botId, dm.chatId);
    } else {
      // Per-user DM — delete both sides
      await Promise.all([
        dm.userAAccountId ? dc.deleteChat(dm.userAAccountId, dm.userAChatId) : null,
        dm.userBAccountId ? dc.deleteChat(dm.userBAccountId, dm.userBChatId) : null,
      ].filter(Boolean));
    }
    store.deleteDm(dm_key);
    res.json({ success: true });
  } catch (e) {
    console.error('[/dm/:key DELETE]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── GET /events/user/:username ────────────────────────────────────────
// Per-user SSE channel — delivers new_dm events so the messages page discovers
// new conversations instantly instead of waiting for the 30s poll.
// Also keeps the user's account IO alive so external DC users can initiate
// securejoin (their handshake needs the server to be reading the inbox).
app.get('/events/user/:username', (req, res) => {
  const { username } = req.params;
  const chatKey = `user:${username}`;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  res.write('data: {"type":"connected"}\n\n');

  sseRegister(chatKey, res);

  // Track which accountId we acquired IO for so we release the right one on close.
  let acquiredAccountId = null;

  const info = store.getAccount(username);
  if (info?.accountId) {
    acquiredAccountId = info.accountId;
    ioAcquire(acquiredAccountId);
  } else {
    ensureUserAccount(username).then((newInfo) => {
      if (res.writableEnded) return;
      acquiredAccountId = newInfo.accountId;
      ioAcquire(acquiredAccountId);
    }).catch(() => {});
  }

  const heartbeat = setInterval(() => {
    try { res.write(': ping\n\n'); } catch { clearInterval(heartbeat); }
  }, 15_000);

  req.on('close', () => {
    clearInterval(heartbeat);
    sseUnregister(chatKey, res);
    ioRelease(acquiredAccountId);
  });
});

// ── GET /dm/user/:username ────────────────────────────────────────────
app.get('/dm/user/:username', (req, res) => {
  const { username } = req.params;
  // The messages page calls this every 30s. Use it as a presence heartbeat:
  // keep the user's account IO alive so IncomingMsg fires while they're online.
  // IO stops 45s after they leave (linger > polling interval = no gap).
  const info = store.getAccount(username);
  if (info?.accountId) {
    dc.rpc.startIo(info.accountId).catch(() => {});
    ioSendLinger(info.accountId);
  }
  res.json({ dms: store.getDmsForUser(username) });
});

// ── Graceful shutdown ──────────────────────────────────────────────────
function shutdown() { try { store.flush(); } catch {} try { dc.close(); } catch {} }
process.on('exit', shutdown);
process.on('SIGINT', () => { shutdown(); process.exit(0); });
process.on('SIGTERM', () => { shutdown(); process.exit(0); });
process.on('uncaughtException', (err) => { console.error(err); shutdown(); process.exit(1); });

// ── Startup ────────────────────────────────────────────────────────────
async function start() {
  dc.start();
  await ensureBotAccount();

  startAllUserIo(); // keeps bot IO alive; per-user IO managed by ioAcquire/ioRelease
  setInterval(() => { dc.rpc.maybeNetwork().catch(() => {}); }, 15_000).unref();
  setInterval(startAllUserIo, 30_000).unref(); // bot keepalive only

  // Briefly start IO for every provisioned user account so DC downloads any
  // pending IMAP mail and fires IncomingMsg. Runs every 3 minutes.
  // IMPORTANT: interval MUST be > IO_LINGER_MS (45s) so chatmail has an
  // off-window to push to DC mobile apps. Keeping IO on permanently prevents
  // chatmail from sending push notifications to mobile clients.
  // For active web users, IO is held by ioAcquire via SSE — this drain only
  // serves as a fallback for accounts with no active SSE connection.
  function drainUserAccounts() {
    for (const [username, info] of Object.entries(store.getAllAccounts())) {
      if (username === '__bot__' || !info?.accountId) continue;
      if ((ioRefs.get(info.accountId) || 0) > 0) continue; // SSE already holds IO open
      dc.rpc.startIo(info.accountId)
        .then(() => ioSendLinger(info.accountId))
        .catch((e) => console.warn(`[user-drain] startIo failed for ${username}:`, e.message));
    }
  }
  drainUserAccounts();
  setInterval(drainUserAccounts, 3 * 60_000).unref();

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
