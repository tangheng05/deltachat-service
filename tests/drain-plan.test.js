import test from 'node:test';
import assert from 'node:assert';
import { planDrain, ACTIVE_WINDOW_MS, SLOW_CYCLE_MS, DRAIN_INTERVAL_MS } from '../drain-plan.js';

const NOW = 1_800_000_000_000;
const accounts = (n, extra = {}) =>
  Object.fromEntries(Array.from({ length: n }, (_, i) => [`u${i}`, { accountId: i + 1, ...extra }]));

test('recently active accounts are drained every run', () => {
  const all = { ...accounts(100), fresh: { accountId: 999, lastActiveAt: NOW - 1000 } };
  const { targets } = planDrain({ accounts: all, now: NOW, isHeld: () => false, cursor: 0 });
  assert.ok(targets.includes(999));
});

test('dormant accounts are only drained a slice at a time', () => {
  const all = accounts(2300);
  const { targets } = planDrain({ accounts: all, now: NOW, isHeld: () => false, cursor: 0 });
  const perRun = Math.ceil(2300 / (SLOW_CYCLE_MS / DRAIN_INTERVAL_MS));
  assert.strictEqual(targets.length, perRun);
  assert.ok(targets.length <= 115);
});

test('every dormant account is reached within one slow cycle', () => {
  const all = accounts(2300);
  const seen = new Set();
  let cursor = 0;
  for (let i = 0; i < SLOW_CYCLE_MS / DRAIN_INTERVAL_MS; i++) {
    const plan = planDrain({ accounts: all, now: NOW, isHeld: () => false, cursor });
    plan.targets.forEach((id) => seen.add(id));
    cursor = plan.cursor;
  }
  assert.strictEqual(seen.size, 2300);
});

test('skips the bot, accounts without an id, and accounts held open by a live connection', () => {
  const all = {
    __bot__: { accountId: 1, lastActiveAt: NOW },
    noId: { lastActiveAt: NOW },
    held: { accountId: 5, lastActiveAt: NOW },
    free: { accountId: 6, lastActiveAt: NOW },
  };
  const { targets } = planDrain({ accounts: all, now: NOW, isHeld: (id) => id === 5, cursor: 0 });
  assert.deepStrictEqual(targets, [6]);
});

test('an account stops counting as active after the window', () => {
  const all = { old: { accountId: 9007, lastActiveAt: NOW - ACTIVE_WINDOW_MS - 1 }, ...accounts(500) };
  const { targets } = planDrain({ accounts: all, now: NOW, isHeld: () => false, cursor: 100 });
  assert.ok(!targets.includes(9007));
});
