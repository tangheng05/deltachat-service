import test from 'node:test';
import assert from 'node:assert';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isRealMessage, lastRealMessage, sellerInbox } from '../shop-chat.js';
import { Store } from '../store.js';

test("the engine's own notices are not real messages", () => {
  assert.strictEqual(isRealMessage({ isInfo: true, text: 'Messages are end-to-end encrypted.' }), false);
  assert.strictEqual(isRealMessage({ isInfo: false, text: 'Others will only see this group after you sent a first message.' }), false);
  assert.strictEqual(isRealMessage({ text: '' }), false);
  assert.strictEqual(isRealMessage(null), false);
  assert.strictEqual(isRealMessage({ text: '🛒 Buyer (dara): is this in stock?' }), true);
  assert.strictEqual(isRealMessage({ text: '📦 Order Status Update\nPaid → Shipped' }), true);
});

test('last real message skips notices and picks the newest', () => {
  const msgs = [
    { text: 'hello', senderUsername: 'dara', timestamp: 10 },
    { text: 'yes', senderUsername: 'shop', timestamp: 30 },
    { text: 'old', senderUsername: 'dara', timestamp: 5 },
  ];
  assert.deepStrictEqual(lastRealMessage(msgs), { text: 'yes', senderUsername: 'shop', timestamp: 30 });
  assert.strictEqual(lastRealMessage([]), null);
});

test('the seller inbox hides chats nobody has written in, newest first', () => {
  const chats = [
    { order_id: 'shop_1_a', buyerUsername: 'a', createdAt: 5 },
    { order_id: 'shop_1_b', buyerUsername: 'b', lastMessage: { text: 'hi', timestamp: 100 }, lastMessageAt: 100 },
    { order_id: 'shop_1_c', buyerUsername: 'c', lastMessage: { text: 'yo', timestamp: 300 }, lastMessageAt: 300 },
  ];
  assert.deepStrictEqual(sellerInbox(chats).map((c) => c.buyerUsername), ['c', 'b']);
});

test('recording a message stores the preview and marks it seen by its sender', () => {
  const store = new Store(join(tmpdir(), `shop-chat-${process.pid}.json`));
  store.data.orderChats.shop_1_a = { chatId: 9, buyerUsername: 'a', sellerUsername: 's' };
  store.setOrderChatLastMessage('shop_1_a', { text: 'hi', senderUsername: 'a', timestamp: 100 });
  const chat = store.getOrderChat('shop_1_a');
  assert.deepStrictEqual(chat.lastMessage, { text: 'hi', senderUsername: 'a', timestamp: 100 });
  assert.strictEqual(chat.lastMessageAt, 100);
  assert.strictEqual(chat.lastSeenBy.a, 100);
  assert.strictEqual(chat.lastSeenBy.s, undefined);
  // An older message never replaces a newer preview.
  store.setOrderChatLastMessage('shop_1_a', { text: 'older', senderUsername: 's', timestamp: 50 });
  assert.strictEqual(store.getOrderChat('shop_1_a').lastMessage.text, 'hi');
  store.setOrderChatLastMessage('nope', { text: 'x', senderUsername: 'a', timestamp: 1 });
  clearTimeout(store._saveTimer);
});

test('a status update previews as one clean line', () => {
  const text = '📦 Order Status Update\n━━━━━━━━━━━\nPaid  →  Shipped\n━━━━━━━━━━━';
  assert.strictEqual(lastRealMessage([{ text, senderUsername: null, timestamp: 9 }]).text, '📦 Order Status Update Paid → Shipped');
});
