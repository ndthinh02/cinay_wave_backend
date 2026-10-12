import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import mongoose from 'mongoose';
import { createApp } from '../src/app.js';
import { User, Session, Favorite, History, Review } from '../src/models.js';
import { normalizePage, imageUrl, plainText } from '../src/catalog.js';
import { googleIdentity, emailSender } from '../src/identity.js';
import { ApiError } from '../src/errors.js';
import jwt from 'jsonwebtoken';
import { smtpFailure } from '../src/logging.js';
import { avatarStorage, AVATAR_MAX_BYTES } from '../src/avatar.js';

// An isolated database is required. No fixtures are ever shipped to the app catalog.
const uri = process.env.SMOKE_MONGODB_URI;
if (!uri || !new URL(uri).pathname.includes('smoke')) throw new Error('Set SMOKE_MONGODB_URI to a dedicated database containing smoke in its name');
await mongoose.connect(uri, { serverSelectionTimeoutMS: 5000 });
await Promise.all([User.init(), Session.init(), Favorite.init(), History.init(), Review.init()]);
const codes = new Map();
let failMail = false;
let failAvatar = false;
const removedAvatars = [];
const avatars = {
  upload: async (owner, bytes, mime) => {
    if (failAvatar) throw new ApiError(502, 'AVATAR_STORAGE_FAILED', 'Chưa lưu được ảnh.');
    assert.equal(mime, 'image/png'); assert(bytes.length > 0);
    const publicId = `cinaywave/avatars/${owner}/${crypto.randomUUID()}`;
    return { url: `https://res.cloudinary.com/smoke/image/upload/${publicId}.jpg`, publicId };
  },
  remove: async id => { removedAvatars.push(id); }
};
const app = createApp({ secret: crypto.randomBytes(32).toString('hex'), mailer: { configured: () => true, send: async (email, code) => { if (failMail) throw new ApiError(503, 'EMAIL_SEND_FAILED', 'Chưa gửi được email.'); codes.set(email, code); } }, verifyGoogle: async token => {
  if (token === 'valid-google-account-token') return { subject: `google-${runId}`, email: `${runId}-google@example.invalid`, name: 'Google smoke' };
  if (token === 'existing-email-google-token') return { subject: `other-${runId}`, email: `${runId}-a@example.invalid`, name: 'Other' };
  throw new ApiError(401, 'GOOGLE_INVALID', 'Token không hợp lệ.');
}, avatars });
const server = app.listen(0, '127.0.0.1');
await new Promise(resolve => server.once('listening', resolve));
const base = `http://127.0.0.1:${server.address().port}/api`;
const realFetch = globalThis.fetch;
const runId = crypto.randomBytes(6).toString('hex');
const testSlug = `smoke-${runId}`;
const fixture = { status: true, movie: { slug: testSlug, name: 'Smoke fixture', year: 2024, content: '<p>Text</p>', category: [] }, episodes: [{ server_name: 'Server A', server_data: [{ slug: '1', name: '1', link_m3u8: 'https://example.invalid/test.m3u8' }, { slug: '2', name: '2', link_m3u8: 'https://example.invalid/2.m3u8' }] }] };
// Stub only the unreachable upstream; all HTTP, authentication and MongoDB operations are real.
globalThis.fetch = async (url, options) => String(url).startsWith('https://phimapi.com/phim/smoke-') ? new Response(JSON.stringify(fixture), { status: 200 }) : realFetch(url, options);
async function call(path, method = 'GET', body, token) {
  const res = await realFetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: res.status === 204 ? null : await res.json() };
}
const accounts = [];
const logRecords = [];
const consoleMethods = Object.fromEntries(['log', 'warn', 'error'].map(level => [level, console[level]]));
for (const level of Object.keys(consoleMethods)) console[level] = (...args) => {
  if (args.length === 1 && typeof args[0] === 'string' && args[0].startsWith('{')) {
    const record = JSON.parse(args[0]);
    if (record.event) { logRecords.push(record); return; }
  }
  consoleMethods[level](...args);
};
try {
  assert.equal((await call('/health')).status, 200);
  assert.equal((await call('/me')).status, 401);
  assert.equal((await call('/auth/register', 'POST', { email: 'bad', name: 'x', password: 'short' })).status, 400);
  for (const suffix of ['a', 'b']) {
    const account = { name: 'Smoke user', email: `${runId}-${suffix}@example.invalid`, password: 'abcdefgh' };
    const result = await call('/auth/register', 'POST', account); assert.equal(result.status, 202); assert.equal(result.body.accessToken, undefined);
    assert.equal((await call('/auth/login', 'POST', account)).status, 403);
    assert.equal((await call('/auth/resend', 'POST', account)).status, 429);
    const pending = await User.findOne({ email: account.email });
    assert.notEqual(pending.otpHash, codes.get(account.email)); assert.equal(pending.emailVerified, false);
    const verified = await Promise.all([call('/auth/verify', 'POST', { email: account.email, code: codes.get(account.email) }), call('/auth/verify', 'POST', { email: account.email, code: codes.get(account.email) })]);
    assert.equal(verified.filter(x => x.status === 200).length, 1);
    accounts.push({ ...verified.find(x => x.status === 200).body, credentials: account });
    assert.equal((await call('/auth/verify', 'POST', { email: account.email, code: codes.get(account.email) })).status, 400);
  }
  const a = accounts[0]; const b = accounts[1];
  const pendingCredentials = { name: 'Pending smoke', email: `${runId}-pending@example.invalid`, password: 'abcdefgh' };
  await call('/auth/register', 'POST', pendingCredentials);
  const oldCode = codes.get(pendingCredentials.email);
  const wrongCode = oldCode === '000000' ? '111111' : '000000';
  const attempts = await Promise.all(Array.from({ length: 6 }, () => call('/auth/verify', 'POST', { email: pendingCredentials.email, code: wrongCode })));
  assert(attempts.every(x => x.status === 400));
  assert.equal((await User.findOne({ email: pendingCredentials.email })).otpAttempts, 5);
  assert.equal((await call('/auth/verify', 'POST', { email: pendingCredentials.email, code: oldCode })).status, 400);
  await User.updateOne({ email: pendingCredentials.email }, { $set: { otpSentAt: new Date(Date.now() - 61000) } });
  failMail = true;
  assert.equal((await call('/auth/resend', 'POST', pendingCredentials)).status, 503);
  assert.equal((await User.findOne({ email: pendingCredentials.email })).otpHash, undefined);
  failMail = false;
  assert.equal((await call('/auth/resend', 'POST', pendingCredentials)).status, 200);
  await User.updateOne({ email: pendingCredentials.email }, { $set: { otpExpiresAt: new Date(Date.now() - 1) } });
  assert.equal((await call('/auth/verify', 'POST', { email: pendingCredentials.email, code: codes.get(pendingCredentials.email) })).status, 400);
  assert.equal(emailSender({}).configured(), false);
  await assert.rejects(emailSender({}).send('a@example.invalid', '000000'), e => e.code === 'EMAIL_NOT_CONFIGURED');
  assert.equal((await call('/auth/google', 'POST', { idToken: 'invalid-google-account-token' })).status, 401);
  assert.equal((await call('/auth/google', 'POST', { idToken: 'existing-email-google-token' })).status, 409);
  const google = await call('/auth/google', 'POST', { idToken: 'valid-google-account-token' }); assert.equal(google.status, 200);
  assert.equal((await call('/auth/google', 'POST', { idToken: 'valid-google-account-token' })).body.user.id, google.body.user.id);
  assert.equal((await call('/auth/login', 'POST', { ...a.credentials, password: 'wrong-password' })).status, 401);
  assert.equal((await call('/auth/login', 'POST', a.credentials)).status, 200);
  assert.equal((await call('/reviews/' + testSlug)).body.total, 0);
  assert.equal((await call('/reviews/' + testSlug + '/mine', 'PUT', { rating: 5, content: 'first' })).status, 401);
  assert.equal((await call('/reviews/' + testSlug + '/mine', 'PUT', { rating: 6, content: '' }, a.accessToken)).status, 400);
  assert.equal((await call('/reviews/' + testSlug + '/mine', 'PUT', { rating: 2.5, content: '' }, a.accessToken)).status, 400);
  assert.equal((await call('/reviews/' + testSlug + '/mine', 'PUT', { rating: 5, content: 'x'.repeat(2001) }, a.accessToken)).status, 400);
  await Promise.all([1, 2].map(() => call('/reviews/' + testSlug + '/mine', 'PUT', { rating: 5, content: '  first  ' }, a.accessToken).then(r => assert.equal(r.status, 200))));
  assert.equal(await Review.countDocuments({ movieSlug: testSlug, user: a.user.id }), 1);
  assert.equal((await call('/reviews/' + testSlug + '/mine', 'GET', undefined, a.accessToken)).body.review.content, 'first');
  let ratingPage = (await call('/reviews/' + testSlug)).body;
  assert.equal(ratingPage.total, 1); assert.equal(ratingPage.average, 5);
  assert.equal(ratingPage.items[0].author.email, undefined);
  assert.equal((await call('/reviews/' + testSlug + '/mine', 'GET', undefined, b.accessToken)).body.review, null);
  await call('/reviews/' + testSlug + '/mine', 'DELETE', undefined, b.accessToken);
  assert.equal((await call('/reviews/' + testSlug)).body.total, 1);
  assert.equal((await call('/reviews/' + testSlug + '/mine', 'PUT', { rating: 3, content: '   ' }, a.accessToken)).status, 200);
  ratingPage = (await call('/reviews/' + testSlug)).body;
  assert.equal(ratingPage.total, 1); assert.equal(ratingPage.average, 3); assert.equal(ratingPage.items.length, 0);
  // Seed only the isolated smoke database to exercise stable cursor pages.
  for (let i = 0; i < 12; i++) await Review.create({ user: b.user.id, movieSlug: testSlug + '-page-' + i, rating: 4, content: 'page ' + i });
  const pageSlug = testSlug + '-paging';
  const pageUsers = Array.from({ length: 12 }, () => new mongoose.Types.ObjectId());
  await Review.insertMany(pageUsers.map((user, i) => ({ user, movieSlug: pageSlug, rating: 4, content: 'page ' + i })));
  const firstPage = (await call('/reviews/' + pageSlug)).body;
  assert.equal(firstPage.items.length, 10); assert(firstPage.nextCursor);
  const secondPage = (await call('/reviews/' + pageSlug + '?cursor=' + firstPage.nextCursor)).body;
  assert.equal(secondPage.items.length, 2); assert.equal(secondPage.nextCursor, null);
  assert.equal(new Set([...firstPage.items, ...secondPage.items].map(r => r.id)).size, 12);
  await Review.deleteMany({ movieSlug: pageSlug });
  assert.equal((await call('/reviews/' + testSlug + '/mine', 'DELETE', undefined, a.accessToken)).status, 204);
  assert.equal((await call('/reviews/' + testSlug)).body.total, 0);
  console.log('PASS: real rating upsert, concurrent writes, trim, validation, privacy, ownership, summary, cursor pagination and delete.');

  assert.equal((await call('/me', 'PATCH', { name: 'Updated' }, a.accessToken)).body.name, 'Updated');
  assert.equal((await call('/me', 'PATCH', { email: 'other@example.invalid' }, a.accessToken)).status, 400);
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1ZkAAAAASUVORK5CYII=', 'base64');
  async function upload(bytes = png, mime = 'image/png', name = 'Tên mới', token = a.accessToken) {
    const response = await realFetch(`${base}/me/avatar`, { method: 'PUT', headers: { 'content-type': mime, 'x-profile-name': encodeURIComponent(name), ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: bytes });
    return { status: response.status, body: await response.json() };
  }
  assert.equal((await upload(png, 'image/png', 'Tên mới', '')).status, 401);
  assert.equal((await upload(png, 'image/jpeg')).status, 415);
  assert.equal((await upload(Buffer.alloc(AVATAR_MAX_BYTES + 1))).status, 413);
  const avatarSaved = await upload(); assert.equal(avatarSaved.status, 200); assert.equal(avatarSaved.body.name, 'Tên mới');
  assert(avatarSaved.body.avatarUrl.startsWith('https://res.cloudinary.com/'));
  assert.equal((await call('/me', 'GET', null, a.accessToken)).body.avatarUrl, avatarSaved.body.avatarUrl);
  assert.equal((await call('/me', 'GET', null, b.accessToken)).body.avatarUrl, '');
  failAvatar = true; assert.equal((await upload(png, 'image/png', 'Không được lưu')).status, 502); failAvatar = false;
  assert.equal((await call('/me', 'GET', null, a.accessToken)).body.name, 'Tên mới');
  assert.equal((await call('/me', 'GET', null, a.accessToken)).body.avatarUrl, avatarSaved.body.avatarUrl);
  assert.equal((await upload()).status, 200); assert.equal(removedAvatars.length, 1);
  await assert.rejects(avatarStorage({}).upload(a.user.id, png, 'image/png'), e => e.code === 'AVATAR_STORAGE_UNAVAILABLE');
  assert.equal((await call(`/favorites/${testSlug}`, 'PUT', {}, a.accessToken)).status, 200);
  assert.equal((await call(`/favorites/${testSlug}`, 'PUT', {}, a.accessToken)).status, 200);
  assert.equal((await call('/favorites', 'GET', null, a.accessToken)).body.items.length, 1);
  assert.equal((await call('/favorites', 'GET', null, b.accessToken)).body.items.length, 0);
  const watchedAt = new Date().toISOString();
  const progress = { server: 'Server A', episode: '1', episodeName: '1', positionMs: 42000, durationMs: 100000, watchedAt };
  assert.equal((await call(`/history/${testSlug}`, 'PUT', { ...progress, userId: b.user.id }, a.accessToken)).status, 200);
  const resumed = (await call('/history', 'GET', null, a.accessToken)).body.items[0];
  assert.equal(resumed.episode, '1'); assert.equal(resumed.positionMs, 42000);
  assert.equal((await call('/history', 'GET', null, b.accessToken)).body.items.length, 0);
  await call(`/history/${testSlug}`, 'PUT', { ...progress, positionMs: 1000, watchedAt: new Date(Date.now() - 60000).toISOString() }, a.accessToken);
  assert.equal((await call('/history', 'GET', null, a.accessToken)).body.items[0].positionMs, 42000);
  await call(`/history/${testSlug}`, 'PUT', { ...progress, episode: '2', episodeName: '2', positionMs: 96000, watchedAt: new Date().toISOString() }, a.accessToken);
  assert.equal(await History.countDocuments({ user: a.user.id, movieSlug: testSlug }), 2);
  assert.equal((await call('/history', 'GET', null, a.accessToken)).body.items[0].completed, true);
  assert.equal((await call(`/history/${testSlug}`, 'PUT', { ...progress, episode: 'missing' }, a.accessToken)).status, 400);
  const refreshed = await call('/auth/refresh', 'POST', { refreshToken: a.refreshToken }); assert.equal(refreshed.status, 200);
  assert.equal((await call('/auth/refresh', 'POST', { refreshToken: a.refreshToken })).status, 401);
  assert.equal((await call('/auth/logout', 'POST', { refreshToken: refreshed.body.refreshToken })).status, 204);
  assert.equal((await call('/auth/refresh', 'POST', { refreshToken: refreshed.body.refreshToken })).status, 401);
  assert.equal((await call(`/favorites/${testSlug}`, 'DELETE', null, a.accessToken)).status, 204);
  assert.equal((await call(`/history/${testSlug}`, 'DELETE', null, a.accessToken)).status, 204);
  assert.equal((await call('/history', 'DELETE', null, a.accessToken)).status, 204);
  assert.equal((await call('/catalog/movies?category=https://evil.invalid')).status, 400);
  assert.equal(imageUrl('a.jpg', 'https://images.example'), 'https://images.example/uploads/movies/a.jpg');
  assert.equal(imageUrl('https://images.example/a.jpg'), 'https://images.example/a.jpg');
  assert.equal(imageUrl('a.jpg', 'https://images.example/uploads/movies/'), 'https://images.example/uploads/movies/a.jpg');
  assert.equal(plainText('<script>bad()</script><p>A &amp; B</p>'), 'A & B');
  assert.equal(normalizePage({ data: { items: [{ slug: 'a' }, { slug: 'a' }], params: { pagination: { totalItems: 50, totalItemsPerPage: 24, currentPage: 1 } } } }).totalPages, 3);
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const { OAuth2Client } = await import('google-auth-library');
  const verifier = new OAuth2Client();
  verifier.transporter = { request: async () => ({ data: { 'smoke-key': publicKey.export({ type: 'spki', format: 'pem' }) }, headers: new Headers({ 'cache-control': 'max-age=300' }) }) };
  const signGoogle = changes => jwt.sign({ iat: Math.floor(Date.now() / 1000) - 10, sub: 'google-sub', email: 'test@example.invalid', email_verified: true, aud: 'test-client', iss: 'https://accounts.google.com', exp: Math.floor(Date.now() / 1000) + 300, ...changes }, privateKey, { algorithm: 'RS256', keyid: 'smoke-key' });
  assert.equal((await googleIdentity(signGoogle({}), 'test-client', verifier)).subject, 'google-sub');
  for (const changes of [{ aud: 'wrong' }, { iss: 'https://evil.invalid' }, { exp: 1 }, { email_verified: false }]) await assert.rejects(googleIdentity(signGoogle(changes), 'test-client', verifier), e => e.code === 'GOOGLE_INVALID');
  await assert.rejects(googleIdentity(jwt.sign({ sub: 'google-sub' }, 'wrong', { algorithm: 'HS256' }), 'test-client', verifier), e => e.code === 'GOOGLE_INVALID');
  const otherKey = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
  await assert.rejects(googleIdentity(jwt.sign({ iat: Math.floor(Date.now() / 1000) - 10, sub: 'google-sub', email: 'test@example.invalid', email_verified: true, aud: 'test-client', iss: 'https://accounts.google.com', exp: Math.floor(Date.now() / 1000) + 300 }, otherKey, { algorithm: 'RS256', keyid: 'smoke-key' }), 'test-client', verifier), e => e.code === 'GOOGLE_INVALID');
  assert(logRecords.some(x => x.event === 'auth.result' && x.action === 'register' && x.status === 202 && x.requestId));
  assert(logRecords.some(x => x.event === 'auth.result' && x.action === 'login' && x.status === 200));
  assert(logRecords.some(x => x.event === 'auth.result' && x.action === 'login' && x.errorCode === 'INVALID_CREDENTIALS'));
  assert(logRecords.some(x => x.event === 'register.pending_created' && x.accountState === 'pending_email_verification'));
  assert(logRecords.some(x => x.event === 'register.email_verified' && x.userId));
  const sendFailure = logRecords.find(x => x.event === 'otp.send_failed');
  assert.equal(sendFailure.errorCode, 'EMAIL_SEND_FAILED');
  assert(logRecords.some(x => x.event === 'auth.result' && x.requestId === sendFailure.requestId && x.status === 503));
  const logs = JSON.stringify(logRecords);
  assert(!logs.includes('abcdefgh') && !logs.includes(a.accessToken) && !logs.includes(a.refreshToken) && !logs.includes(a.credentials.email));
  for (const code of codes.values()) assert(!logs.includes(`"${code}"`));
  const safeSmtp = smtpFailure({ code: 'EAUTH', responseCode: 535, command: 'AUTH PLAIN secret-value', message: 'password secret-value', response: '535 secret-value' });
  assert.equal(safeSmtp.smtpCode, 'EAUTH'); assert.equal(safeSmtp.smtpResponseCode, 535); assert.equal(safeSmtp.smtpCommand, 'AUTH');
  assert(!JSON.stringify(safeSmtp).includes('secret-value'));
  console.log('PASS: auth result logs, pending/verified state, request correlation, SMTP error metadata and secret redaction.');
  console.log('PASS: profile name/email validation, avatar type/size/authentication, remote URL, account isolation, atomic failure preservation and old image cleanup (storage stubbed).');
  console.log('PASS: OTP activation, single-use concurrency, attempt cap, cooldown, expiry, delivery failure; Google signature/audience/issuer/expiry/verified email, collision and subject identity; existing session/library/history checks.');
  console.log('SMTP, Google account picker and playback on a device remain unverified; external services are stubbed.');
} finally {
  for (const level of Object.keys(consoleMethods)) console[level] = consoleMethods[level];
  globalThis.fetch = realFetch;
  const ids = (await User.find({ email: { $regex: `^${runId}-` } }).select('_id')).map(x => x._id);
  await Promise.all([User.deleteMany({ _id: { $in: ids } }), Session.deleteMany({ user: { $in: ids } }), Favorite.deleteMany({ user: { $in: ids } }), History.deleteMany({ user: { $in: ids } }), Review.deleteMany({ $or: [{ user: { $in: ids } }, { movieSlug: { $regex: `^smoke-${runId}` } }] })]);
  await new Promise(resolve => server.close(resolve));
  await mongoose.disconnect();
}
