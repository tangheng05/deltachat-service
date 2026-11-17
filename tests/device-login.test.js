import test from 'node:test';
import assert from 'node:assert';
import { DeviceLogins } from '../device-login.js';

const make = (over = {}) => {
  const calls = { provide: 0, stop: 0, startIo: 0 };
  let finish, fail;
  const rpc = {
    provideBackup: () => { calls.provide++; return new Promise((res, rej) => { finish = res; fail = rej; }); },
    getBackupQr: async () => 'DCBACKUP4:secret',
    stopOngoingProcess: async () => { calls.stop++; fail(new Error('cancelled')); },
    startIo: async () => { calls.startIo++; },
    ...over,
  };
  const timers = [];
  const logins = new DeviceLogins(rpc, { ttlMs: 1000, setTimer: (fn) => { timers.push(fn); return timers.length; }, clearTimer: () => {} });
  return { logins, calls, timers, finish: () => finish(null), fail: (e) => fail(e) };
};
const tick = () => new Promise((r) => setImmediate(r));

test('start returns a code and reports waiting', async () => {
  const { logins, calls } = make();
  const r = await logins.start(7);
  assert.strictEqual(r.qr, 'DCBACKUP4:secret');
  assert.strictEqual(logins.status(7).state, 'waiting');
  assert.strictEqual(calls.provide, 1);
});

test('asking again while a code is live reuses it', async () => {
  const { logins, calls } = make();
  const a = await logins.start(7);
  const b = await logins.start(7);
  assert.strictEqual(a.qr, b.qr);
  assert.strictEqual(calls.provide, 1);
});

test('progress moves to transferring, then done, and mail checking resumes', async () => {
  const { logins, calls, finish } = make();
  await logins.start(7);
  logins.onProgress(7, 400);
  assert.deepStrictEqual(logins.status(7), { state: 'transferring', progress: 40 });
  finish();
  await tick();
  assert.strictEqual(logins.status(7).state, 'done');
  assert.strictEqual(calls.startIo, 1);
  assert.strictEqual(logins.status(7).qr, undefined);
});

test('an unused code expires and is cancelled', async () => {
  const { logins, calls, timers } = make();
  await logins.start(7);
  timers[0]();
  await tick();
  assert.strictEqual(calls.stop, 1);
  assert.strictEqual(logins.status(7).state, 'expired');
  assert.strictEqual(calls.startIo, 1);
});

test('a transfer in progress is not cut off by the expiry timer', async () => {
  const { logins, calls, timers } = make();
  await logins.start(7);
  logins.onProgress(7, 300);
  timers[0]();
  await tick();
  assert.strictEqual(calls.stop, 0);
});

test('cancel stops the code', async () => {
  const { logins, calls } = make();
  await logins.start(7);
  await logins.cancel(7);
  await tick();
  assert.strictEqual(calls.stop, 1);
  assert.strictEqual(logins.status(7).state, 'cancelled');
});

test('an account with nothing started is idle, and a new code can follow a finished one', async () => {
  const { logins, calls, finish } = make();
  assert.strictEqual(logins.status(9).state, 'idle');
  await logins.start(7);
  finish();
  await tick();
  await logins.start(7);
  assert.strictEqual(calls.provide, 2);
});

test('if the code cannot be made, the attempt is cleaned up', async () => {
  const { logins, calls } = make({ getBackupQr: async () => { throw new Error('no qr'); } });
  await assert.rejects(logins.start(7));
  await tick();
  assert.strictEqual(calls.stop, 1);
  assert.notStrictEqual(logins.status(7).state, 'waiting');
});
