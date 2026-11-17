// Shop and order chats live in one bot-only DC group each, so DC adds notices
// that mean nothing to a buyer or seller.
const ENGINE_NOTICES = ['others will only see this group', 'messages are end-to-end encrypted'];

export function isRealMessage(msg) {
  if (!msg || msg.isInfo || !msg.text) return false;
  const text = msg.text.toLowerCase();
  return !ENGINE_NOTICES.some((n) => text.includes(n));
}

export function lastRealMessage(messages) {
  const last = messages.filter((m) => m?.text).sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))[0];
  if (!last) return null;
  // Previews are one line: drop divider rows and collapse spacing.
  const text = last.text.split('\n').filter((l) => l.trim() && !/^━+$/.test(l.trim())).join(' ').replace(/\s+/g, ' ');
  return { text, senderUsername: last.senderUsername ?? null, timestamp: last.timestamp };
}

// A chat only exists for the seller once someone has written in it.
export const sellerInbox = (chats) =>
  chats.filter((c) => c.lastMessage).sort((a, b) => (b.lastMessageAt || 0) - (a.lastMessageAt || 0));
