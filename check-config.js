/**
 * check-config.js — read-only diagnostic.
 *
 *   node check-config.js
 *
 * Prints the message-retention / deletion config for every provisioned DC
 * account (bot + per-user). Run this on the box where the chat-service's
 * deltachat-rpc-server data lives (the DC_ACCOUNTS_PATH directory).
 *
 * Key field: delete_server_after
 *   "0"  → never delete from server   (multi-device safe — mobile + web both fetch)
 *   "1"  → delete ~immediately after download
 *   "<n>"→ delete n seconds after download
 *
 * If delete_server_after is non-zero, the chat-service strips messages off
 * chatmail right after it downloads them, so a second device (DC mobile on the
 * same account) can miss them. Set it to 0 to let both devices fetch.
 */

import 'dotenv/config';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DeltaChatClient } from './dc-client.js';
import { Store } from './store.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const DC_ACCOUNTS_PATH = process.env.DC_ACCOUNTS_PATH || join(__dirname, 'dc-data');

const dc = new DeltaChatClient(DC_ACCOUNTS_PATH);
const store = new Store(join(DC_ACCOUNTS_PATH, 'store.json'));

// Config keys that govern whether a message is removed from the server / device
// and how multi-device sync behaves.
const KEYS = [
  'addr',
  'delete_server_after', // ← the important one
  'delete_device_after',
  'bcc_self',            // 1 = self-sent copies (helps multi-device see your own sends)
  'mvbox_move',          // 1 = move chat msgs to a DeltaChat folder
  'e2ee_enabled',
];

async function main() {
  dc.start();
  await new Promise((r) => setTimeout(r, 1500));

  const accounts = Object.entries(store.getAllAccounts());
  console.log(`\nFound ${accounts.length} account(s) in store: ${DC_ACCOUNTS_PATH}\n`);

  for (const [username, info] of accounts) {
    if (!info?.accountId) {
      console.log(`${username}: (no accountId)`);
      continue;
    }
    const vals = {};
    for (const key of KEYS) {
      vals[key] = await dc.getConfig(info.accountId, key).catch(() => '<err>');
    }
    const flag = (vals.delete_server_after === '0' || vals.delete_server_after === '' || vals.delete_server_after == null)
      ? 'OK (keeps on server)'
      : `⚠ DELETES after ${vals.delete_server_after}s`;
    console.log(`── ${username}  (accountId=${info.accountId})`);
    console.log(`     delete_server_after = ${JSON.stringify(vals.delete_server_after)}  → ${flag}`);
    console.log(`     delete_device_after = ${JSON.stringify(vals.delete_device_after)}`);
    console.log(`     bcc_self            = ${JSON.stringify(vals.bcc_self)}`);
    console.log(`     mvbox_move          = ${JSON.stringify(vals.mvbox_move)}`);
    console.log(`     e2ee_enabled        = ${JSON.stringify(vals.e2ee_enabled)}`);
    console.log('');
  }

  dc.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
