// Delta Chat groups live in the user's own DC account; these shape them for the web.
import { quoteToReply } from './dm-send.js';

const IMAGE_TYPES = new Set(['Image', 'Gif', 'Sticker']);
const isImage = (msg) => IMAGE_TYPES.has(msg?.viewType) && !!msg?.file;

export function groupState({ canSend, joinPending }) {
  if (joinPending) return 'joining';
  return canSend ? 'active' : 'removed';
}

export const isShownMessage = (msg) => !!msg && (!!msg.text || isImage(msg));

export function formatGroupMessage(msg, { selfAddr, selfUsername, usernameByAddr }) {
  const address = msg.sender?.address || '';
  const isMine = !!address && address === selfAddr;
  const senderUsername = isMine ? selfUsername : usernameByAddr(address) || null;
  return {
    id: msg.id,
    text: msg.text || '',
    senderUsername,
    senderName: senderUsername || msg.sender?.displayName || address || null,
    isSystem: !!msg.isInfo,
    isMine,
    image: isImage(msg),
    timestamp: msg.timestamp,
    replyTo: quoteToReply(msg.quote, selfUsername),
    failed: msg.state === 24,
  };
}
