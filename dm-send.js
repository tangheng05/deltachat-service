// Small decisions used by the DM send and read paths, kept free of DC so they can be tested.

// DC labels the account owner's own messages "Me" (or leaves the name empty).
const SELF_LABELS = new Set(['', 'Me']);

// A DC quote → the replyTo shape the web renders.
export function quoteToReply(quote, viewerUsername) {
  if (!quote?.text) return null;
  const id = quote.messageId ?? quote.msgId ?? null;
  const name = quote.authorDisplayName;
  const senderUsername = id == null && name == null
    ? null
    : SELF_LABELS.has(name ?? '') ? viewerUsername : name;
  return { id, text: quote.text.substring(0, 200), senderUsername };
}

// chatmail refuses cleartext, so a message may only go out on an encrypted chat.
export async function pickEncryptedChat(candidates, isEncrypted) {
  for (const chatId of [...new Set(candidates.filter(Boolean))]) {
    if (await isEncrypted(chatId).catch(() => false)) return chatId;
  }
  return 0;
}

// Message ids are per account: an id the web holds may belong to the other
// user's copy. Only quote by id when it is this chat's message with this text.
export async function resolveQuote(replyTo, { chatIds, getMessage, recentMessages }) {
  const text = replyTo?.text || '';
  if (!replyTo || (!text && typeof replyTo.id !== 'number')) return {};
  const fits = (m) => m && chatIds.includes(m.chatId) && (!text || (m.text || '').startsWith(text));
  if (typeof replyTo.id === 'number') {
    const byId = await getMessage(replyTo.id).catch(() => null);
    if (fits(byId)) return { quotedMessageId: replyTo.id };
  }
  if (!text) return {};
  const match = (await recentMessages().catch(() => [])).find((m) => (m.text || '').startsWith(text));
  return match ? { quotedMessageId: match.id } : { quotedText: text };
}

// A text-only quote is linked by DC to whatever message came before it. When the
// linked message plainly isn't the quoted one, keep the text and drop the link.
export function unlinkMismatchedQuotes(messages) {
  const byId = new Map(messages.map((m) => [m.id, m]));
  const norm = (t) => (t || '').replace(/\s+/g, ' ').replace(/[…. ]+$/, '').trim();
  return messages.map((m) => {
    const linked = m.replyTo?.id != null ? byId.get(m.replyTo.id) : null;
    if (!linked) return m;
    const q = norm(m.replyTo.text);
    const t = norm(linked.text);
    if (!q || t.startsWith(q) || q.startsWith(t)) return m;
    return { ...m, replyTo: { id: null, text: m.replyTo.text, senderUsername: null } };
  });
}
