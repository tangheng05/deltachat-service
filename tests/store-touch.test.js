import test from 'node:test';
import assert from 'node:assert';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../store.js';

const T = 1_800_000_000_000;

test('touchAccount stamps a known account at most once an hour', () => {
  const store = new Store(join(tmpdir(), `store-touch-${process.pid}.json`));
  store.data.accounts.alice = { accountId: 3 };
  store.touchAccount('alice', T);
  store.touchAccount('alice', T + 60_000);
  assert.strictEqual(store.data.accounts.alice.lastActiveAt, T);
  store.touchAccount('alice', T + 3_600_000);
  assert.strictEqual(store.data.accounts.alice.lastActiveAt, T + 3_600_000);
  store.touchAccount('nobody', 5);
  assert.strictEqual(store.data.accounts.nobody, undefined);
  clearTimeout(store._saveTimer);
});
