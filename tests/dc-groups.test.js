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
