/**
 * migrate-dms.js — run ONCE before deploying the per-user DM update.
 *
 *   node migrate-dms.js
 *
 * Upgrades every bot-DM record in store.json to the per-user format:
 *   { chatId } → { userAAccountId, userAChatId, userBAccountId, userBChatId }
 *
 * Safe to re-run — skips records that are already migrated.
 */

import 'dotenv/config';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync } from 'node:fs';
import { DeltaChatClient } from './dc-client.js';
import { Store } from './store.js';

const __dirname        = fileURLToPath(new URL('.', import.meta.url));
const DC_ACCOUNTS_PATH = process.env.DC_ACCOUNTS_PATH || join(__dirname, 'dc-data');
const CHATMAIL_DOMAIN  = process.env.CHATMAIL_DOMAIN  || 'nine.testrun.org';

mkdirSync(DC_ACCOUNTS_PATH, { recursive: true });

const dc    = new DeltaChatClient(DC_ACCOUNTS_PATH);
const store = new Store(join(DC_ACCOUNTS_PATH, 'store.json'));

const withTimeout = (p, ms) =>
  Promise.race([p, new Promise((_, r) => setTimeout(() => r(new Error(`timed out after ${ms}ms`)), ms))]);

async function provisionUser(username) {
  let info = store.getAccount(username);
  if (info?.accountId) {
    console.log(`  [skip provision] ${username} already has accountId=${info.accountId}`);
    return info;
  }

  console.log(`  [provision] ${username}...`);
  const accountId = await withTimeout(dc.addAccount(), 15_000);
  await withTimeout(dc.setConfigFromQr(accountId, `dcaccount:https://${CHATMAIL_DOMAIN}/new`), 20_000);
  await dc.setConfig(accountId, 'displayname', username);
  await withTimeout(dc.configure(accountId), 30_000);
  await dc.rpc.stopIo(accountId).catch(() => {});

  const addr     = await dc.getConfig(accountId, 'addr');
  const password = await dc.getConfig(accountId, 'mail_pw');
  const info2    = { accountId, addr, password };
  store.setAccount(username, info2);
  console.log(`  → ${username} = ${addr} (accountId=${accountId})`);
  return info2;
}

async function main() {
  dc.start();
  // Give the RPC subprocess a moment to initialise
  await new Promise((r) => setTimeout(r, 2000));

  const dms = Object.entries(store.data.directMessages);
  console.log(`\nFound ${dms.length} DM record(s) in store.\n`);

  let migrated = 0;
  let skipped  = 0;
  let failed   = 0;

  for (const [dmKey, dm] of dms) {
    if (dm.userAAccountId) {
      console.log(`[skip] ${dmKey} — already migrated`);
      skipped++;
      continue;
    }

    console.log(`[migrate] ${dmKey}`);
    try {
      const [infoA, infoB] = await Promise.all([
        provisionUser(dm.userA),
        provisionUser(dm.userB),
      ]);

      const contactInA = await dc.createContact(infoA.accountId, infoB.addr, dm.userB);
      const contactInB = await dc.createContact(infoB.accountId, infoA.addr, dm.userA);
      const chatIdA    = await dc.createChatByContactId(infoA.accountId, contactInA);
      const chatIdB    = await dc.createChatByContactId(infoB.accountId, contactInB);

      // Build updated record — remove old chatId, add per-user fields
      const updated = { ...dm };
      delete updated.chatId;
      updated.userAAccountId = infoA.accountId;
      updated.userAChatId    = chatIdA;
      updated.userBAccountId = infoB.accountId;
      updated.userBChatId    = chatIdB;

      store.data.directMessages[dmKey] = updated;
      store._save();

      // Bootstrap Autocrypt key exchange so mobile clients can encrypt immediately
      try {
        await dc.rpc.startIo(infoA.accountId).catch(() => {});
        await dc.rpc.startIo(infoB.accountId).catch(() => {});
        await new Promise((r) => setTimeout(r, 3_000));
        await Promise.all([
          dc.sendTextMsg(infoA.accountId, chatIdA, '​'),
          dc.sendTextMsg(infoB.accountId, chatIdB, '​'),
        ]);
        await new Promise((r) => setTimeout(r, 8_000));
        await dc.rpc.stopIo(infoA.accountId).catch(() => {});
        await dc.rpc.stopIo(infoB.accountId).catch(() => {});
        console.log(`  ↻ key exchange bootstrapped`);
      } catch (ke) {
        console.warn(`  ⚠ key exchange failed: ${ke.message}`);
      }

      console.log(`  ✓ ${dmKey} (A chatId:${chatIdA}, B chatId:${chatIdB})`);
      migrated++;
    } catch (e) {
      console.error(`  ✗ ${dmKey} FAILED:`, e.message);
      failed++;
    }
  }

  // Flush final state synchronously before exit
  store.flush();

  console.log(`\nDone. migrated=${migrated} skipped=${skipped} failed=${failed}`);
  dc.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
