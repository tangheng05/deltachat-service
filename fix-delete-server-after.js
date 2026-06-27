/**
 * fix-delete-server-after.js — one-time backfill.
 *
 *   node fix-delete-server-after.js
 *
 * Flips every provisioned DC account from the chatmail default
 * delete_server_after=1 (deletes mail ~1s after this service downloads it,
 * causing a DC-mobile login on the same account to miss messages) to 0, and
 * enables bcc_self=1 so messages sent from Serey web also reach the phone.
 *
 * Safe to re-run — already-correct accounts are skipped.
 *
 * IMPORTANT: stop the chat-service first — it holds a lock on the accounts dir.
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

async function main() {
  dc.start();
  await new Promise((r) => setTimeout(r, 1500));

  const accounts = Object.entries(store.getAllAccounts());
  console.log(`\nFound ${accounts.length} account(s) in ${DC_ACCOUNTS_PATH}\n`);

  let fixed = 0, ok = 0;
  for (const [username, info] of accounts) {
    if (!info?.accountId) { console.log(`${username}: (no accountId) — skip`); continue; }

    const cur = await dc.getConfig(info.accountId, 'delete_server_after').catch(() => '?');
    const bcc = await dc.getConfig(info.accountId, 'bcc_self').catch(() => '?');

    if (cur === '0' && bcc === '1') {
      console.log(`✓ ${username}: already correct`);
      ok++;
      continue;
    }

    await dc.setConfig(info.accountId, 'delete_server_after', '0');
    await dc.setConfig(info.accountId, 'bcc_self', '1');
    console.log(`→ ${username}: delete_server_after ${cur}→0, bcc_self ${bcc}→1`);
    fixed++;
  }

  console.log(`\nDone. fixed=${fixed} already_ok=${ok}\n`);
  dc.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
