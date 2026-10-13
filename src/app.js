import express from 'express';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import bcrypt from 'bcryptjs';
import mongoose from 'mongoose';
import { z } from 'zod';
import * as catalog from './catalog.js';
import { User, Session, Favorite, History } from './models.js';
import { authenticate, tokens, tokenHash, profile } from './auth.js';
import { ApiError, wrap } from './errors.js';
import { emailSender, sendOtp, verifyOtp, googleIdentity } from './identity.js';
import { authRequestLogger, authLog } from './logging.js';
import { AVATAR_MAX_BYTES, validateAvatar, avatarStorage } from './avatar.js';
import { reviewRoutes } from './reviews.js';
import { aiRoutes } from './ai.js';

const slug = z.string().regex(/^[a-z0-9][a-z0-9-]{0,199}$/);
const pagination = z.object({ page: z.coerce.number().int().min(1).max(10000).default(1), limit: z.coerce.number().int().min(1).max(64).default(24) });
const credentials = z.object({ email: z.string().email().max(254).transform(x => x.toLowerCase().trim()), password: z.string().min(8).max(72).refine(x => Buffer.byteLength(x) <= 72, 'Mật khẩu tối đa 72 byte') });
const refreshSchema = z.object({ refreshToken: z.string().min(32).max(200) });
const historyInput = z.object({ server: z.string().min(1).max(200), episode: z.string().min(1).max(200), episodeName: z.string().max(200), positionMs: z.number().int().min(0).max(604800000), durationMs: z.number().int().min(0).max(604800000), watchedAt: z.iso.datetime() }).refine(x => x.durationMs === 0 || x.positionMs <= x.durationMs + 5000);
const historyDto = h => ({ movie: h.movie, server: h.server, episode: h.episode, episodeName: h.episodeName, positionMs: h.positionMs, durationMs: h.durationMs, completed: h.completed, watchedAt: h.watchedAt });
export function createApp({ secret, trustProxyHops = 0, isDatabaseReady = () => mongoose.connection.readyState === 1, mailer = emailSender(), verifyGoogle = googleIdentity, avatars = avatarStorage(), ai }) {
  if (!secret || secret.length < 32) throw new Error('JWT_SECRET must contain at least 32 characters');
  if (!Number.isInteger(trustProxyHops) || trustProxyHops < 0 || trustProxyHops > 5) throw new Error('Invalid TRUST_PROXY_HOPS');
  const app = express();
  app.disable('x-powered-by');
  if (trustProxyHops) app.set('trust proxy', trustProxyHops);
  app.use(helmet()); app.use(authRequestLogger); app.use(express.json({ limit: '32kb' }));
  app.get('/api/health', (req, res) => res.status(isDatabaseReady() ? 200 : 503).json({ status: isDatabaseReady() ? 'ok' : 'starting', database: isDatabaseReady() }));
  app.use('/api', rateLimit({ windowMs: 60000, limit: 180, standardHeaders: 'draft-8', legacyHeaders: false, message: { error: { code: 'RATE_LIMIT', message: 'Quá nhiều yêu cầu. Vui lòng chờ một phút.' } } }));
  app.get('/api/catalog/home', wrap(async (req, res) => res.json(await catalog.home())));
  app.get('/api/catalog/filters', wrap(async (req, res) => res.json(await catalog.filters())));
  app.get('/api/catalog/movies', wrap(async (req, res) => {
    const query = z.object({ type: z.enum(catalog.types.map(x => x.slug)).default('phim-moi'), keyword: z.string().trim().max(120).optional(), category: slug.optional(), country: slug.optional(), year: z.coerce.number().int().min(1900).max(new Date().getFullYear() + 1).optional(), page: pagination.shape.page }).parse(req.query);
    res.json(await catalog.listing(query));
  }));
  app.get('/api/catalog/movies/:slug', wrap(async (req, res) => res.json(await catalog.detail(slug.parse(req.params.slug)))));
  aiRoutes(app, secret, isDatabaseReady, ai);
  // Catalog remains accessible while the database is reconnecting.
  app.use('/api', (req, res, next) => isDatabaseReady() ? next() : next(new ApiError(503, 'DATABASE_UNAVAILABLE', 'Máy chủ chưa kết nối được cơ sở dữ liệu. Vui lòng thử lại sau.')));
  const authLimit = rateLimit({ windowMs: 15 * 60000, limit: 15, standardHeaders: 'draft-8', legacyHeaders: false, message: { error: { code: 'AUTH_RATE_LIMIT', message: 'Thử đăng nhập quá nhiều lần. Vui lòng thử lại sau 15 phút.' } } });
  const otpLimit = rateLimit({ windowMs: 15 * 60000, limit: 20, standardHeaders: 'draft-8', legacyHeaders: false, message: { error: { code: 'OTP_RATE_LIMIT', message: 'Quá nhiều yêu cầu xác nhận. Vui lòng thử lại sau.' } } });
  app.post('/api/auth/register', authLimit, wrap(async (req, res) => {
    const data = credentials.extend({ name: z.string().trim().min(2).max(80) }).parse(req.body);
    if (!mailer.configured()) throw new ApiError(503, 'EMAIL_NOT_CONFIGURED', 'Dịch vụ email chưa được cấu hình. Vui lòng thử lại sau.');
    let user = await User.findOne({ email: data.email });
    if (user && (user.emailVerified || !user.passwordHash || !await bcrypt.compare(data.password, user.passwordHash))) throw new ApiError(409, 'EMAIL_EXISTS', 'Email đã được đăng ký. Hãy đăng nhập bằng tài khoản hiện có.');
    const existing = Boolean(user);
    if (!user) user = await User.create({ name: data.name, email: data.email, passwordHash: await bcrypt.hash(data.password, 12), emailVerified: false });
    res.locals.authUserId = String(user._id);
    authLog(existing ? 'register.pending_reused' : 'register.pending_created', { userId: String(user._id), accountState: 'pending_email_verification' });
    res.status(202).json(await sendOtp(user, secret, mailer));
  }));
  app.post('/api/auth/resend', otpLimit, wrap(async (req, res) => {
    const data = credentials.parse(req.body); const user = await User.findOne({ email: data.email });
    if (user) res.locals.authUserId = String(user._id);
    if (!user?.passwordHash || !await bcrypt.compare(data.password, user.passwordHash)) throw new ApiError(401, 'INVALID_CREDENTIALS', 'Email hoặc mật khẩu không đúng.');
    if (user.emailVerified) throw new ApiError(409, 'ALREADY_VERIFIED', 'Email đã được xác nhận. Hãy đăng nhập.');
    res.json(await sendOtp(user, secret, mailer));
  }));
  app.post('/api/auth/verify', otpLimit, wrap(async (req, res) => {
    const data = z.object({ email: credentials.shape.email, code: z.string().regex(/^\d{6}$/) }).parse(req.body);
    const user = await verifyOtp(data.email, data.code, secret);
    res.locals.authUserId = String(user._id);
    authLog('register.email_verified', { userId: String(user._id), accountState: 'verified' });
    res.json(await tokens(user, secret));
  }));
  app.post('/api/auth/google', authLimit, wrap(async (req, res) => {
    if (process.env.NODE_ENV === 'production' && !req.secure) throw new ApiError(426, 'HTTPS_REQUIRED', 'Đăng nhập Google cần kết nối HTTPS.');
    const { idToken } = z.object({ idToken: z.string().min(20).max(10000) }).parse(req.body);
    const identity = await verifyGoogle(idToken);
    let user = await User.findOne({ googleSubject: identity.subject });
    if (!user) {
      if (await User.exists({ email: identity.email })) throw new ApiError(409, 'ACCOUNT_LINK_REQUIRED', 'Email đã có tài khoản. Hãy đăng nhập bằng mật khẩu; tài khoản Google chưa được liên kết.');
      try { user = await User.create({ name: identity.name, email: identity.email, googleSubject: identity.subject, emailVerified: true }); }
      catch (e) { if (e.code !== 11000) throw e; user = await User.findOne({ googleSubject: identity.subject }); if (!user) throw new ApiError(409, 'ACCOUNT_LINK_REQUIRED', 'Email đã có tài khoản. Hãy đăng nhập bằng phương thức hiện có.'); }
    }
    res.locals.authUserId = String(user._id);
    res.json(await tokens(user, secret));
  }));
  app.post('/api/auth/login', authLimit, wrap(async (req, res) => {
    const data = credentials.parse(req.body); const user = await User.findOne({ email: data.email });
    if (user) res.locals.authUserId = String(user._id);
    if (!user?.passwordHash || !await bcrypt.compare(data.password, user.passwordHash)) throw new ApiError(401, 'INVALID_CREDENTIALS', 'Email hoặc mật khẩu không đúng.');
    if (!user.emailVerified) throw new ApiError(403, 'EMAIL_NOT_VERIFIED', 'Hãy xác nhận email trước khi đăng nhập.');
    res.json(await tokens(user, secret));
  }));
  app.post('/api/auth/refresh', authLimit, wrap(async (req, res) => {
    const { refreshToken } = refreshSchema.parse(req.body);
    // Atomic removal makes a refresh token single-use even for simultaneous requests.
    const session = await Session.findOneAndDelete({ hash: tokenHash(refreshToken), expiresAt: { $gt: new Date() } });
    if (!session) throw new ApiError(401, 'INVALID_REFRESH', 'Vui lòng đăng nhập lại.');
    const user = await User.findById(session.user);
    if (!user?.emailVerified) throw new ApiError(401, 'INVALID_REFRESH', 'Vui lòng đăng nhập và xác nhận email.');
    res.json(await tokens(user, secret));
  }));
  app.post('/api/auth/logout', wrap(async (req, res) => { const data = refreshSchema.parse(req.body); await Session.deleteOne({ hash: tokenHash(data.refreshToken) }); res.sendStatus(204); }));
  reviewRoutes(app, secret);
  app.use('/api', authenticate(secret));
  app.get('/api/me', (req, res) => res.json(profile(req.user)));
  app.patch('/api/me', wrap(async (req, res) => {
    const { name } = z.object({ name: z.string().trim().min(2).max(80) }).strict().parse(req.body);
    const updated = await User.findByIdAndUpdate(req.user._id, { $set: { name } }, { new: true, runValidators: true });
    if (!updated) throw new ApiError(401, 'UNAUTHORIZED', 'Vui lòng đăng nhập lại.');
    res.json(profile(updated));
  }));
  const avatarLimit = rateLimit({ windowMs: 60000, limit: 10, standardHeaders: 'draft-8', legacyHeaders: false, message: { error: { code: 'AVATAR_RATE_LIMIT', message: 'Bạn đổi ảnh quá nhiều lần. Vui lòng chờ một phút.' } } });
  app.put('/api/me/avatar', avatarLimit, express.raw({ type: () => true, limit: AVATAR_MAX_BYTES }), wrap(async (req, res) => {
    const mime = validateAvatar(req.body, req.headers['content-type']);
    let name;
    if (req.headers['x-profile-name'] !== undefined) {
      try { name = decodeURIComponent(req.headers['x-profile-name']); }
      catch { throw new ApiError(400, 'VALIDATION_ERROR', 'Tên hiển thị không hợp lệ.'); }
      name = z.string().trim().min(2).max(80).parse(name);
    }
    const uploaded = await avatars.upload(String(req.user._id), req.body, mime);
    let previous;
    try {
      previous = await User.findByIdAndUpdate(req.user._id, { $set: { avatarUrl: uploaded.url, avatarPublicId: uploaded.publicId, ...(name !== undefined ? { name } : {}) } }, { runValidators: true });
      if (!previous) throw new ApiError(401, 'UNAUTHORIZED', 'Vui lòng đăng nhập lại.');
    } catch (error) { await avatars.remove(uploaded.publicId).catch(() => {}); throw error; }
    if (previous.avatarPublicId) void avatars.remove(previous.avatarPublicId).catch(() => {});
    res.json(profile({ _id: previous._id, name: name ?? previous.name, email: previous.email, avatarUrl: uploaded.url }));
  }));
  app.get('/api/favorites', wrap(async (req, res) => {
    const { page, limit } = pagination.parse(req.query); const filter = { user: req.user._id };
    const [rows, total] = await Promise.all([Favorite.find(filter).sort({ updatedAt: -1, _id: -1 }).skip((page - 1) * limit).limit(limit).lean(), Favorite.countDocuments(filter)]);
    res.json({ items: rows.map(x => x.movie), page, total, totalPages: Math.ceil(total / limit), hasMore: page * limit < total });
  }));
  app.put('/api/favorites/:movieSlug', wrap(async (req, res) => {
    const movieSlug = slug.parse(req.params.movieSlug); const { movie } = await catalog.detail(movieSlug);
    await Favorite.updateOne({ user: req.user._id, movieSlug }, { $set: { movie } }, { upsert: true }); res.json(movie);
  }));
  app.delete('/api/favorites/:movieSlug', wrap(async (req, res) => { await Favorite.deleteOne({ user: req.user._id, movieSlug: slug.parse(req.params.movieSlug) }); res.sendStatus(204); }));
  app.get('/api/history', wrap(async (req, res) => {
    const { page, limit } = pagination.parse(req.query); const match = { user: req.user._id };
    const rows = await History.aggregate([{ $match: match }, { $sort: { watchedAt: -1, _id: -1 } }, { $group: { _id: '$movieSlug', row: { $first: '$$ROOT' } } }, { $replaceRoot: { newRoot: '$row' } }, { $sort: { watchedAt: -1 } }, { $facet: { items: [{ $skip: (page - 1) * limit }, { $limit: limit }], count: [{ $count: 'total' }] } }]);
    const total = rows[0]?.count[0]?.total || 0;
    res.json({ items: (rows[0]?.items || []).map(historyDto), page, total, totalPages: Math.ceil(total / limit), hasMore: page * limit < total });
  }));
  app.put('/api/history/:movieSlug', wrap(async (req, res) => {
    const movieSlug = slug.parse(req.params.movieSlug); const data = historyInput.parse(req.body);
    if (new Date(data.watchedAt).getTime() > Date.now() + 60000) throw new ApiError(400, 'INVALID_TIME', 'Thời điểm cập nhật không hợp lệ.');
    const info = await catalog.detail(movieSlug);
    const server = info.servers.find(x => x.name === data.server);
    if (!server?.episodes.some(x => x.slug === data.episode)) throw new ApiError(400, 'INVALID_EPISODE', 'Tập hoặc nguồn phim không tồn tại.');
    const key = { user: req.user._id, movieSlug, server: data.server, episode: data.episode };
    const incoming = { ...data, watchedAt: new Date(data.watchedAt), movie: info.movie, completed: data.durationMs > 0 && data.positionMs / data.durationMs > 0.95 };
    // Pipeline compares timestamps atomically: an offline retry cannot overwrite newer progress.
    const row = await History.findOneAndUpdate(key, [{ $set: Object.fromEntries(Object.entries(incoming).map(([field, value]) => [field, { $cond: [{ $or: [{ $eq: [{ $type: '$watchedAt' }, 'missing'] }, { $lte: ['$watchedAt', incoming.watchedAt] }] }, { $literal: value }, `$${field}`] }])) }, { $set: key }], { upsert: true, new: true });
    res.json(historyDto(row));
  }));
  app.delete('/api/history/:movieSlug', wrap(async (req, res) => { await History.deleteMany({ user: req.user._id, movieSlug: slug.parse(req.params.movieSlug) }); res.sendStatus(204); }));
  app.delete('/api/history', wrap(async (req, res) => { await History.deleteMany({ user: req.user._id }); res.sendStatus(204); }));
  app.use((req, res, next) => next(new ApiError(404, 'NOT_FOUND', 'Không tìm thấy đường dẫn.')));
  app.use((err, req, res, next) => {
    res.locals.authErrorCode = err.type === 'entity.too.large' ? 'PAYLOAD_TOO_LARGE'
      : err instanceof z.ZodError || err.type === 'entity.parse.failed' ? 'VALIDATION_ERROR'
      : err.code === 11000 ? 'CONFLICT' : err instanceof ApiError ? err.code : 'INTERNAL_ERROR';
    if (err.type === 'entity.too.large') return res.status(413).json({ error: { code: 'PAYLOAD_TOO_LARGE', message: req.path === '/api/me/avatar' ? 'Ảnh đại diện tối đa 5 MB.' : 'Nội dung yêu cầu quá lớn.' } });
    if (err instanceof z.ZodError || err.type === 'entity.parse.failed') return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Dữ liệu không hợp lệ. Kiểm tra các trường đã nhập.' } });
    if (err.code === 11000) return res.status(409).json({ error: { code: 'CONFLICT', message: 'Email hoặc bản ghi đã tồn tại. Vui lòng thử lại.' } });
    res.status(err.status || 500).json({ error: { code: err.code || 'INTERNAL_ERROR', message: err instanceof ApiError ? err.message : 'Dịch vụ gặp lỗi. Vui lòng thử lại.' } });
  });
  return app;
}
