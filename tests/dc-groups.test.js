import test from 'node:test';
import assert from 'node:assert';
import { groupState, formatGroupMessage, isShownMessage } from '../dc-groups.js';

const ctx = {
  selfAddr: 'me@chat.serey.io',
  selfUsername: 'boss',
  usernameByAddr: (a) => ({ 'dara@chat.serey.io': 'dara' })[a] || null,
};
const msg = (over = {}) => ({
  id: 7, text: 'hello', timestamp: 100, state: 10, viewType: 'Text', file: null, isInfo: false,
  sender: { address: 'x@nine.testrun.org', displayName: 'Sok' }, quote: null, ...over,
});

test('groupState covers joining, active, removed', () => {
  assert.strictEqual(groupState({ canSend: false, joinPending: true }), 'joining');
  assert.strictEqual(groupState({ canSend: true, joinPending: false }), 'active');
  assert.strictEqual(groupState({ canSend: false, joinPending: false }), 'removed');
});

test('own message is mine with the Serey username', () => {
  const m = formatGroupMessage(msg({ sender: { address: 'me@chat.serey.io', displayName: 'Me' }, state: 26 }), ctx);
  assert.strictEqual(m.isMine, true);
  assert.strictEqual(m.senderUsername, 'boss');
  assert.strictEqual(m.failed, false);
});

test('other Serey member shows the Serey username', () => {
  const m = formatGroupMessage(msg({ sender: { address: 'dara@chat.serey.io', displayName: 'Dara D' } }), ctx);
  assert.strictEqual(m.senderUsername, 'dara');
  assert.strictEqual(m.senderName, 'dara');
  assert.strictEqual(m.isMine, false);
});

test('outside member shows the Delta Chat name', () => {
  const m = formatGroupMessage(msg(), ctx);
  assert.strictEqual(m.senderUsername, null);
  assert.strictEqual(m.senderName, 'Sok');
});

test('info message is a system line', () => {
  assert.strictEqual(formatGroupMessage(msg({ isInfo: true, text: 'Member Me added by Sok.' }), ctx).isSystem, true);
});

test('photo with empty text is shown as an image', () => {
  const raw = msg({ text: '', viewType: 'Image', file: '/x/p.png' });
  assert.strictEqual(isShownMessage(raw), true);
  assert.strictEqual(formatGroupMessage(raw, ctx).image, true);
});

test('empty non-image message is not shown', () => {
  assert.strictEqual(isShownMessage(msg({ text: '' })), false);
  assert.strictEqual(isShownMessage(null), false);
});

test('quote of own message is attributed to the user', () => {
  const m = formatGroupMessage(msg({ quote: { kind: 'WithMessage', text: 'hi', messageId: 3, authorDisplayName: 'Me' } }), ctx);
  assert.deepStrictEqual(m.replyTo, { id: 3, text: 'hi', senderUsername: 'boss' });
});

test('a failed own message is marked failed', () => {
  assert.strictEqual(formatGroupMessage(msg({ state: 24 }), ctx).failed, true);
});

test('dc group send queue survives a reload', async () => {
  const { Store } = await import('../store.js');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const file = join(tmpdir(), `dcg-queue-${process.pid}.json`);
  const a = new Store(file);
  a.setDcGroupSends('dcg:boss:13', [{ localId: 1, text: 'hi' }]);
  a.setDcGroupJoin('boss', 13, { pending: true, inviterContactId: 10, at: 5 });
  a.flush();
  const b = new Store(file);
  assert.deepStrictEqual(b.getDcGroupSends('dcg:boss:13'), [{ localId: 1, text: 'hi' }]);
  assert.deepStrictEqual(b.getDcGroupJoin('boss', 13), { pending: true, inviterContactId: 10, at: 5 });
  b.setDcGroupSends('dcg:boss:13', []);
  assert.deepStrictEqual(b.getDcGroupSends('dcg:boss:13'), []);
  assert.strictEqual(b.data.dcGroupSends['dcg:boss:13'], undefined);
  clearTimeout(a._saveTimer); clearTimeout(b._saveTimer);
});

test('a join counts as done once anyone else has written in the group', async () => {
  const { joinConfirmed } = await import('../dc-groups.js');
  // DC ids: 1 = me, 2 = engine info lines ("X invited you…"), 10+ = real contacts.
  assert.strictEqual(joinConfirmed([{ fromId: 2 }, { fromId: 1 }]), false);
  assert.strictEqual(joinConfirmed([{ fromId: 2 }, { fromId: 11, isInfo: true }]), true); // "Member Me added by X."
  assert.strictEqual(joinConfirmed([{ fromId: 12 }]), true);
  assert.strictEqual(joinConfirmed([]), false);
});

test('a left group is hidden until it is joined again', async () => {
  const { Store } = await import('../store.js');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const s = new Store(join(tmpdir(), `dcg-hide-${process.pid}.json`));
  assert.strictEqual(s.isDcGroupHidden('boss', 17), false);
  s.hideDcGroup('boss', 17);
  assert.strictEqual(s.isDcGroupHidden('boss', 17), true);
  assert.strictEqual(s.isDcGroupHidden('dara', 17), false);
  s.setDcGroupJoin('boss', 17, { pending: true, inviterContactId: 10, at: 1 });
  assert.strictEqual(s.isDcGroupHidden('boss', 17), false);
  clearTimeout(s._saveTimer);
});
