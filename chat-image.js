// Photos in DMs and Delta Chat groups: what counts as one, and checking uploads from the web.
const IMAGE_TYPES = new Set(['Image', 'Gif', 'Sticker']);

export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

export const isImage = (msg) => IMAGE_TYPES.has(msg?.viewType) && !!msg?.file;

const SIGNATURES = [
  { ext: 'jpg', mime: 'image/jpeg', test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { ext: 'png', mime: 'image/png', test: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { ext: 'gif', mime: 'image/gif', test: (b) => b.subarray(0, 4).toString('latin1') === 'GIF8' },
  { ext: 'webp', mime: 'image/webp', test: (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP' },
];

export function decodeImage(data) {
  if (typeof data !== 'string' || !data) return { error: 'No photo.' };
  const buf = Buffer.from(data.replace(/^data:[^,]*,/, ''), 'base64');
  if (!buf.length) return { error: 'No photo.' };
  if (buf.length > MAX_IMAGE_BYTES) return { error: 'Photo is too large.' };
  const type = SIGNATURES.find((s) => s.test(buf));
  if (!type) return { error: 'Only JPEG, PNG, GIF or WebP photos.' };
  return { buf, ext: type.ext, mime: type.mime };
}

export const photoPreview = (text, image) => text || (image ? 'Photo' : '');
