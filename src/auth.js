import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { Session, User } from './models.js';
import { ApiError, wrap } from './errors.js';
export const tokenHash = token => crypto.createHash('sha256').update(token).digest('hex');
export const profile = u => ({ id: String(u._id), name: u.name, email: u.email, avatarUrl: u.avatarUrl || '' });
export async function tokens(user, secret) {
  const refreshToken = crypto.randomBytes(48).toString('base64url');
  await Session.create({ user: user._id, hash: tokenHash(refreshToken), expiresAt: new Date(Date.now() + 30 * 86400000) });
  return { accessToken: jwt.sign({}, secret, { subject: String(user._id), expiresIn: '15m', issuer: 'cinaywave', audience: 'cinaywave-android', algorithm: 'HS256' }), refreshToken, user: profile(user) };
}
export const authenticate = secret => wrap(async (req, res, next) => {
  const token = /^Bearer (\S+)$/.exec(req.headers.authorization || '')?.[1];
  if (!token) throw new ApiError(401, 'UNAUTHORIZED', 'Vui lòng đăng nhập.');
  try {
    const payload = jwt.verify(token, secret, { algorithms: ['HS256'], issuer: 'cinaywave', audience: 'cinaywave-android' });
    req.user = await User.findById(payload.sub);
    if (!req.user?.emailVerified) throw new Error();
  } catch { throw new ApiError(401, 'UNAUTHORIZED', 'Phiên đăng nhập đã hết hạn.'); }
  next();
});
