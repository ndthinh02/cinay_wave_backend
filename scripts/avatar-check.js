import assert from 'node:assert/strict';
import { validateAvatar } from '../src/avatar.js';

// Minimal signature fixtures exercise validation, not image decoding by storage.
const jpeg = Buffer.from([255, 216, 255, 224, 0, 2, 255, 217]);
for (const mime of ['image/jpeg', 'image/jpg', 'IMAGE/JPG; charset=binary']) {
  assert.equal(validateAvatar(jpeg, mime), 'image/jpeg');
  assert.equal(validateAvatar(Buffer.concat([jpeg, Buffer.from('trailing metadata')]), mime), 'image/jpeg');
}
assert.throws(() => validateAvatar(jpeg.subarray(0, 6), 'image/jpeg'), e => e.code === 'AVATAR_TYPE');
assert.throws(() => validateAvatar(jpeg, 'image/png'), e => e.code === 'AVATAR_TYPE');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1ZkAAAAASUVORK5CYII=', 'base64');
assert.equal(validateAvatar(png, 'image/png'), 'image/png');
assert.throws(() => validateAvatar(png, 'image/jpg'), e => e.code === 'AVATAR_TYPE');
console.log('PASS: JPEG/JPG aliases, trailing JPEG data, PNG and invalid images.');
