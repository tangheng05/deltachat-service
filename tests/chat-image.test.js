import test from 'node:test';
import assert from 'node:assert';
import { isImage, decodeImage, photoPreview, MAX_IMAGE_BYTES } from '../chat-image.js';

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]);
const GIF = Buffer.from('GIF89a......');
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0, 0, 0, 0]), Buffer.from('WEBPVP8 ')]);

test('isImage needs an image view type and a file', () => {
  assert.equal(isImage({ viewType: 'Image', file: '/b/x.jpg' }), true);
  assert.equal(isImage({ viewType: 'Gif', file: '/b/x.gif' }), true);
  assert.equal(isImage({ viewType: 'Image', file: null }), false);
  assert.equal(isImage({ viewType: 'File', file: '/b/x.pdf' }), false);
  assert.equal(isImage(null), false);
});

test('decodeImage reads the type from the bytes, not from what the client says', () => {
  assert.deepEqual(
    pickType(decodeImage(JPEG.toString('base64'))),
    { ext: 'jpg', mime: 'image/jpeg' },
  );
  assert.deepEqual(pickType(decodeImage(`data:image/jpeg;base64,${PNG.toString('base64')}`)), { ext: 'png', mime: 'image/png' });
  assert.deepEqual(pickType(decodeImage(GIF.toString('base64'))), { ext: 'gif', mime: 'image/gif' });
  assert.deepEqual(pickType(decodeImage(WEBP.toString('base64'))), { ext: 'webp', mime: 'image/webp' });
  assert.ok(decodeImage(JPEG.toString('base64')).buf.equals(JPEG));
});

test('decodeImage refuses non-images, empty input and oversized files', () => {
  assert.equal(decodeImage(Buffer.from('<svg onload=x>').toString('base64')).error, 'Only JPEG, PNG, GIF or WebP photos.');
  assert.equal(decodeImage('').error, 'No photo.');
  assert.equal(decodeImage(undefined).error, 'No photo.');
  assert.equal(decodeImage(123).error, 'No photo.');
  const big = Buffer.concat([JPEG, Buffer.alloc(MAX_IMAGE_BYTES)]);
  assert.equal(decodeImage(big.toString('base64')).error, 'Photo is too large.');
});

test('photoPreview gives photo-only messages a sidebar line', () => {
  assert.equal(photoPreview('nice', true), 'nice');
  assert.equal(photoPreview('', true), 'Photo');
  assert.equal(photoPreview('', false), '');
});

function pickType(r) {
  return r && { ext: r.ext, mime: r.mime };
}
