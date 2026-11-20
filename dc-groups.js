// Delta Chat groups live in the user's own DC account; these shape them for the web.
import { quoteToReply } from './dm-send.js';
import { isImage } from './chat-image.js';

export function groupState({ canSend, joinPending }) {
  if (joinPending) return 'joining';
  return canSend ? 'active' : 'removed';
}

// DC's own lines (English core strings): drop the handshake chatter, say the rest plainly.
const HIDDEN_INFO = [/end-to-end encrypted/i, /invited you to join this group/i, /replied, waiting for being added/i];
const INFO_RULES = [
  [/^Member Me added by (.+)\.$/i, (_, by) => `${by} added you`],
  [/^Member (.+) added by me\.$/i, (_, who) => `You added ${who}`],
  [/^Member (.+) added by (.+)\.$/i, (_, who, by) => `${by} added ${who}`],
  [/^Member Me removed by (.+)\.$/i, (_, by) => `${by} removed you`],
  [/^Member (.+) removed by me\.$/i, (_, who) => `You removed ${who}`],
  [/^Member (.+) removed by (.+)\.$/i, (_, who, by) => `${by} removed ${who}`],
  [/^Group left by (.+)\.$/i, (_, who) => `${who} left the group`],
  [/^You left the group\.$/i, () => 'You left the group'],
];

export function plainInfo(text) {
  const t = String(text || '').trim();
  if (!t || HIDDEN_INFO.some((re) => re.test(t))) return null;
  for (const [re, say] of INFO_RULES) {
    const m = t.match(re);
    if (m) return say(...m);
  }
  return t;
}

export const isShownMessage = (msg) =>
  !!msg && (msg.isInfo ? plainInfo(msg.text) !== null : !!msg.text || isImage(msg));

export function formatGroupMessage(msg, { selfAddr, selfUsername, usernameByAddr }) {
  const address = msg.sender?.address || '';
  const isMine = !!address && address === selfAddr;
  const senderUsername = isMine ? selfUsername : usernameByAddr(address) || null;
  return {
    id: msg.id,
    text: msg.isInfo ? plainInfo(msg.text) || '' : msg.text || '',
    senderUsername,
    senderName: senderUsername || msg.sender?.displayName || address || null,
    isSystem: !!msg.isInfo,
    isMine,
    image: isImage(msg),
    timestamp: msg.timestamp,
    replyTo: quoteToReply(msg.quote, selfUsername),
    failed: msg.state === 24,
    senderContactId: msg.fromId ?? null,
    senderHasPicture: !isMine && !!msg.sender?.profileImage,
  };
}

// DC contact ids up to 9 are special (1 = self, 2 = info). A message from any
// real contact means the owner has let us in, even if the join event was missed.
export const joinConfirmed = (messages) => messages.some((m) => (m?.fromId || 0) > 9);

// DC contact id 1 is always the account itself.
export function formatMembers(contactsById, { selfUsername, usernameByAddr }) {
  const members = Object.values(contactsById).map((c) => {
    if (c.id === 1) return { contactId: 1, name: selfUsername, username: selfUsername, isMe: true, hasPicture: false };
    const username = usernameByAddr(c.address) || null;
    return { contactId: c.id, name: username || c.displayName || c.address, username, isMe: false, hasPicture: !!c.profileImage };
  });
  return members.sort((a, b) => (b.isMe - a.isMe) || a.name.localeCompare(b.name));
}
