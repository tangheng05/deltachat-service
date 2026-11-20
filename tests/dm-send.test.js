import test from 'node:test';
import assert from 'node:assert';
import { quoteToReply, pickEncryptedChat, resolveQuote } from '../dm-send.js';

test('reply keeps the id of the quoted message', () => {
  const r = quoteToReply({ kind: 'WithMessage', text: 'hello', messageId: 42, authorDisplayName: 'rex' }, 'nhazero');
  assert.deepStrictEqual(r, { id: 42, text: 'hello', senderUsername: 'rex' });
});

test("a quote of the viewer's own message is attributed to the viewer, not 'Me'", () => {
  const r = quoteToReply({ kind: 'WithMessage', text: 'hi', messageId: 7, authorDisplayName: 'Me' }, 'nhazero');
  assert.strictEqual(r.senderUsername, 'nhazero');
});

test('a text-only quote has no id and no guessed author', () => {
  const r = quoteToReply({ kind: 'JustText', text: 'old text' }, 'nhazero');
  assert.deepStrictEqual(r, { id: null, text: 'old text', senderUsername: null });
});

test('no quote text means no reply', () => {
  assert.strictEqual(quoteToReply(null, 'x'), null);
  assert.strictEqual(quoteToReply({ kind: 'JustText', text: '' }, 'x'), null);
});

test('long quotes are cut to 200 characters', () => {
  assert.strictEqual(quoteToReply({ text: 'a'.repeat(300), messageId: 1 }, 'x').text.length, 200);
});

test('picks the first encrypted chat, skipping unencrypted and unknown ones', async () => {
  const enc = { 12: false, 13: true, 14: true };
  const isEncrypted = async (id) => { if (!(id in enc)) throw new Error('gone'); return enc[id]; };
  assert.strictEqual(await pickEncryptedChat([12, 99, 13, 14], isEncrypted), 13);
  assert.strictEqual(await pickEncryptedChat([12, 0, null, 12], isEncrypted), 0);
});

const chat = { 5: { chatId: 21, text: 'My name is Panha' }, 6: { chatId: 21, text: 'other' }, 9: { chatId: 77, text: 'My name is Panha' } };
const deps = {
  chatIds: [21],
  getMessage: async (id) => { if (!chat[id]) throw new Error('no such message'); return chat[id]; },
  recentMessages: async () => [{ id: 6, ...chat[6] }, { id: 5, ...chat[5] }],
};

test('a valid reply id in this chat is quoted by id', async () => {
  assert.deepStrictEqual(await resolveQuote({ id: 5, text: 'My name is Panha' }, deps), { quotedMessageId: 5 });
});

test("an id from another chat is never quoted: the same text in this chat is used instead", async () => {
  assert.deepStrictEqual(await resolveQuote({ id: 9, text: 'My name is Panha' }, deps), { quotedMessageId: 5 });
});

test('an id whose text does not match falls back to matching by text', async () => {
  assert.deepStrictEqual(await resolveQuote({ id: 6, text: 'My name is Panha' }, deps), { quotedMessageId: 5 });
});

test('an unknown id with no matching text sends the quoted text itself', async () => {
  assert.deepStrictEqual(await resolveQuote({ id: 1763350000000, text: 'never seen here' }, deps), { quotedText: 'never seen here' });
});

test('no reply means no quote', async () => {
  assert.deepStrictEqual(await resolveQuote(null, deps), {});
  assert.deepStrictEqual(await resolveQuote({ id: null, text: '' }, deps), {});
});

test('a quote linked to a message with different text is shown as text only', async () => {
  const { unlinkMismatchedQuotes } = await import('../dm-send.js');
  const msgs = [
    { id: 23, text: 'reply B', senderUsername: 'bob' },
    { id: 24, text: 'reply C', replyTo: { id: 23, text: 'some text bob never had', senderUsername: 'bob' } },
    { id: 25, text: 'ok', replyTo: { id: 23, text: 'reply B', senderUsername: 'bob' } },
    { id: 26, text: 'long', replyTo: { id: 27, text: 'a'.repeat(200), senderUsername: 'bob' } },
    { id: 27, text: 'a'.repeat(900), senderUsername: 'bob' },
    { id: 28, text: 'older page', replyTo: { id: 5, text: 'not loaded', senderUsername: 'bob' } },
  ];
  const out = unlinkMismatchedQuotes(msgs);
  assert.deepStrictEqual(out[1].replyTo, { id: null, text: 'some text bob never had', senderUsername: null });
  assert.strictEqual(out[2].replyTo.id, 23);
  assert.strictEqual(out[3].replyTo.id, 27);
  assert.strictEqual(out[5].replyTo.id, 5);
});

test('a failed message is only shown to its sender', async () => {
  const { hideUndelivered } = await import('../dm-send.js');
  const msgs = [
    { id: 1, text: 'ok', senderUsername: 'jelly' },
    { id: 2, text: 'lost', senderUsername: 'jelly', failed: true },
    { id: 3, text: 'mine lost', senderUsername: 'heng', failed: true },
  ];
  assert.deepStrictEqual(hideUndelivered(msgs, 'heng').map((m) => m.id), [1, 3]);
  assert.deepStrictEqual(hideUndelivered(msgs, 'jelly').map((m) => m.id), [1, 2]);
});

test('quoteToReply shows a quoted photo as plain "Photo", keeping any caption', () => {
  const photo = quoteToReply({ kind: 'WithMessage', text: '📷 Image', messageId: 9, authorDisplayName: 'rex', viewType: 'Image' }, 'x');
  assert.strictEqual(photo.text, 'Photo');
  const captioned = quoteToReply({ kind: 'WithMessage', text: '📷 at the beach', messageId: 9, authorDisplayName: 'rex', viewType: 'Image' }, 'x');
  assert.strictEqual(captioned.text, 'at the beach');
  const plain = quoteToReply({ kind: 'WithMessage', text: '📷 not a photo', messageId: 9, authorDisplayName: 'rex', viewType: 'Text' }, 'x');
  assert.strictEqual(plain.text, '📷 not a photo');
});
