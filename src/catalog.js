import { ApiError } from './errors.js';

export const types = [
  { slug: 'phim-moi', name: 'Phim mới' }, { slug: 'phim-bo', name: 'Phim bộ' },
  { slug: 'phim-le', name: 'Phim lẻ' }, { slug: 'hoat-hinh', name: 'Hoạt hình' }, { slug: 'tv-shows', name: 'TV Show' }
];
export function plainText(html) {
  return String(html).replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '').replace(/<\/?(?:p|div|br|li)\b[^>]*>/gi, '\n').replace(/<[^>]*>/g, '').replace(/&(nbsp|amp|lt|gt|quot|apos);/g, (_, key) => ({ nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" })[key]).replace(/&#(x[0-9a-f]+|\d+);/gi, (_, value) => {
    const code = value[0].toLowerCase() === 'x' ? parseInt(value.slice(1), 16) : Number(value);
    return code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
  }).replace(/\n\s*\n+/g, '\n\n').trim();
}
const cache = new Map();
const pending = new Map();
async function upstream(path, params = {}) {
  // All callers use fixed routes, validated slugs, and an immutable origin.
  const url = new URL(path, 'https://phimapi.com');
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') url.searchParams.set(k, String(v));
  const key = url.href;
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return hit.data;
  if (pending.has(key)) return pending.get(key);
  const task = (async () => {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(12000), headers: { accept: 'application/json' } });
      if (!response.ok) throw new ApiError(response.status === 404 ? 404 : 502, 'UPSTREAM_ERROR', 'Nguồn phim chưa phản hồi. Vui lòng thử lại.');
      const data = await response.json();
      if (data.status === false || data.status === 'error' || data.success === false) throw new ApiError(404, 'MOVIE_NOT_FOUND', 'Không tìm thấy dữ liệu phim.');
      if (cache.size >= 200) cache.delete(cache.keys().next().value);
      cache.set(key, { data, expires: Date.now() + 60000 });
      return data;
    } catch (e) {
      if (e instanceof ApiError) throw e;
      throw new ApiError(502, 'UPSTREAM_UNAVAILABLE', 'Không kết nối được nguồn phim. Vui lòng thử lại.');
    }
  })();
  pending.set(key, task);
  try { return await task; } finally { pending.delete(key); }
}
export function imageUrl(value, base = 'https://phimimg.com') {
  if (!value || typeof value !== 'string') return '';
  try {
    if (/^https?:\/\//i.test(value)) return new URL(value).href;
    if (value.startsWith('//')) return `https:${value}`;
    const root = new URL(base.endsWith('/') ? base : `${base}/`);
    if (value.startsWith('/') || /^(?:uploads|upload)\//.test(value)) return new URL(value.replace(/^\//, ''), `${root.origin}/`).href;
    return new URL(root.pathname === '/' ? `uploads/movies/${value}` : value, root).href;
  } catch { return ''; }
}
export function normalizeMovie(m, base) {
  return {
    slug: m.slug || '', name: m.name || '', originName: m.origin_name || '',
    poster: imageUrl(m.poster_url || m.thumb_url, base), backdrop: imageUrl(m.thumb_url || m.poster_url, base),
    year: Number(m.year) || null, type: m.type || '', quality: m.quality || '', language: m.lang || '',
    time: m.time || '', episodeCurrent: m.episode_current || '',
    categories: (Array.isArray(m.category) ? m.category : []).filter(Boolean).map(x => ({ slug: x.slug || '', name: x.name || '' })),
    countries: (Array.isArray(m.country) ? m.country : []).filter(Boolean).map(x => ({ slug: x.slug || '', name: x.name || '' }))
  };
}
export function normalizePage(raw, requestedPage = 1) {
  const data = raw.data || raw;
  const p = data.params?.pagination || data.pagination || raw.pagination || {};
  const items = [...new Map((Array.isArray(data.items) ? data.items : []).filter(x => x?.slug).map(x => [x.slug, normalizeMovie(x, data.APP_DOMAIN_CDN_IMAGE || raw.pathImage)])).values()];
  const page = Number(p.currentPage) || requestedPage;
  const total = Number(p.totalItems) || 0;
  const pageSize = Number(p.totalItemsPerPage) || items.length || 1;
  const totalPages = Number(p.totalPages) || Math.ceil(total / pageSize);
  return { items, page, totalPages, total, hasMore: page < totalPages };
}
export async function listing(query) {
  const { type = 'phim-moi', keyword, category, country, year, page = 1 } = query;
  const params = { page, category, country, year };
  let path;
  if (keyword) { path = '/v1/api/tim-kiem'; params.keyword = keyword; params.limit = 24; }
  else if (type !== 'phim-moi') path = `/v1/api/danh-sach/${type}`;
  else if (category) path = `/v1/api/the-loai/${category}`;
  else if (country) path = `/v1/api/quoc-gia/${country}`;
  else if (year) path = `/v1/api/nam/${year}`;
  else path = '/danh-sach/phim-moi-cap-nhat';
  return normalizePage(await upstream(path, params), Number(page));
}
export async function home() {
  const results = await Promise.allSettled(types.map(async t => ({ ...t, ...await listing({ type: t.slug }) })));
  const sections = results.map((r, i) => r.status === 'fulfilled' ? r.value : { ...types[i], items: [], error: r.reason.message });
  if (sections.every(s => !s.items.length)) throw new ApiError(502, 'UPSTREAM_UNAVAILABLE', 'Nguồn phim chưa sẵn sàng. Vui lòng thử lại.');
  return { featured: sections.flatMap(s => s.items)[0], sections };
}
export async function filters() {
  const [categories, countries, years] = await Promise.all([upstream('/the-loai'), upstream('/quoc-gia'), upstream('/nam-phat-hanh')]);
  const values = x => Array.isArray(x) ? x : x.data?.items || x.items || x.data || [];
  return { types, categories: values(categories).map(x => ({ slug: x.slug, name: x.name })), countries: values(countries).map(x => ({ slug: x.slug, name: x.name })), years: values(years).map(x => Number(x.year || x.name || x)).filter(Number.isFinite) };
}
export async function detail(slug) {
  const raw = await upstream(`/phim/${slug}`);
  const m = raw.movie || raw.data?.item;
  if (!m) throw new ApiError(404, 'MOVIE_NOT_FOUND', 'Không tìm thấy phim.');
  const movie = normalizeMovie(m);
  let related = [];
  if (movie.categories[0]) {
    try { related = (await listing({ category: movie.categories[0].slug })).items.filter(x => x.slug !== slug).slice(0, 12); } catch { /* detail remains usable */ }
  }
  return {
    movie, description: plainText(m.content || ''), actors: Array.isArray(m.actor) ? m.actor.filter(x => typeof x === 'string' && x.trim()) : [],
    servers: (raw.episodes || raw.data?.episodes || []).map(s => ({
      name: s.server_name || 'Nguồn phim', episodes: (s.server_data || []).map(e => ({
        slug: e.slug || e.name, name: e.name || e.slug, url: /^https?:\/\//i.test(e.link_m3u8 || '') ? e.link_m3u8 : ''
      }))
    })), related
  };
}
