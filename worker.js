const API = 'https://www.googleapis.com/youtube/v3';

// V2.1: KV caching + simple IP rate limiting + stale cache.
// Bind a KV namespace as CACHE in wrangler.toml.
const SEARCH_TTL = 1800;       // 30 minutes
const VIDEO_TTL = 600;         // 10 minutes
const STALE_TTL = 7200;        // keep stale copy for up to 2 hours
const RATE_WINDOW = 60;        // seconds
const RATE_LIMIT = 20;         // API-backed requests per IP/minute

export default {
  async fetch(request, env, ctx) {
    const u = new URL(request.url);

    if (!u.pathname.startsWith('/api/')) {
      return env.ASSETS.fetch(request);
    }

    if (!env.YOUTUBE_API_KEY) {
      return json({ error: 'YOUTUBE_API_KEY belum dipasang sebagai Worker Secret.' }, 500);
    }
    if (!env.CACHE) {
      return json({ error: 'KV CACHE belum dikonfigurasi.' }, 500);
    }

    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    const rateKey = `rate:${ip}`;
    const rate = await env.CACHE.get(rateKey, 'json') || { count: 0 };
    if (rate.count >= RATE_LIMIT) {
      return json({
        error: 'Terlalu banyak permintaan. Coba lagi sebentar.',
        retryAfter: RATE_WINDOW
      }, 429, { 'Retry-After': String(RATE_WINDOW) });
    }
    await env.CACHE.put(rateKey, JSON.stringify({ count: rate.count + 1 }), {
      expirationTtl: RATE_WINDOW
    });

    try {
      if (u.pathname === '/api/search') {
        const q = normalize(u.searchParams.get('q') || '');
        const region = (u.searchParams.get('region') || 'ID').toUpperCase();
        if (!q) return json({ error: 'Keyword kosong.' }, 400);

        const cacheKey = `search:${region}:${await hashKey(q)}`;
        const cached = await env.CACHE.get(cacheKey, 'json');
        if (cached) return json({ ...cached, cache: 'HIT' });

        const staleKey = `${cacheKey}:stale`;
        const stale = await env.CACHE.get(staleKey, 'json');

        // If stale exists, return it immediately and refresh in the background.
        if (stale) {
          ctx.waitUntil(refreshSearch(env, cacheKey, staleKey, q, region));
          return json({ ...stale, cache: 'STALE' });
        }

        const data = await fetchSearch(env, q, region);
        await putCache(env, cacheKey, staleKey, data, SEARCH_TTL);
        return json({ ...data, cache: 'MISS' });
      }

      if (u.pathname === '/api/video') {
        const id = (u.searchParams.get('id') || '').trim();
        if (!/^[A-Za-z0-9_-]{6,20}$/.test(id)) {
          return json({ error: 'Video ID tidak valid.' }, 400);
        }

        const cacheKey = `video:${id}`;
        const cached = await env.CACHE.get(cacheKey, 'json');
        if (cached) return json({ ...cached, cache: 'HIT' });

        const staleKey = `${cacheKey}:stale`;
        const stale = await env.CACHE.get(staleKey, 'json');
        if (stale) {
          ctx.waitUntil(refreshVideo(env, cacheKey, staleKey, id));
          return json({ ...stale, cache: 'STALE' });
        }

        const data = await fetchVideo(env, id);
        await putCache(env, cacheKey, staleKey, data, VIDEO_TTL);
        return json({ ...data, cache: 'MISS' });
      }

      return json({ error: 'Endpoint tidak ditemukan.' }, 404);
    } catch (e) {
      return json({ error: e.message || 'YouTube API error' }, 500);
    }
  }
};

async function refreshSearch(env, cacheKey, staleKey, q, region) {
  try {
    const data = await fetchSearch(env, q, region);
    await putCache(env, cacheKey, staleKey, data, SEARCH_TTL);
  } catch {}
}

async function refreshVideo(env, cacheKey, staleKey, id) {
  try {
    const data = await fetchVideo(env, id);
    await putCache(env, cacheKey, staleKey, data, VIDEO_TTL);
  } catch {}
}

async function putCache(env, key, staleKey, data, ttl) {
  const body = JSON.stringify(data);
  await env.CACHE.put(key, body, { expirationTtl: ttl });
  await env.CACHE.put(staleKey, body, { expirationTtl: STALE_TTL });
}

async function fetchSearch(env, q, region) {
  const p = new URLSearchParams({
    part: 'snippet',
    q,
    type: 'video',
    maxResults: '10',
    regionCode: region,
    relevanceLanguage: 'id',
    key: env.YOUTUBE_API_KEY
  });
  const s = await yt('/search', p);
  const ids = s.items.map(x => x.id.videoId).filter(Boolean).join(',');
  if (!ids) return { items: [] };

  const d = await yt('/videos', new URLSearchParams({
    part: 'snippet,statistics,contentDetails',
    id: ids,
    key: env.YOUTUBE_API_KEY
  }));
  return { items: d.items.map(normalize) };
}

async function fetchVideo(env, id) {
  const d = await yt('/videos', new URLSearchParams({
    part: 'snippet,statistics,contentDetails',
    id,
    key: env.YOUTUBE_API_KEY
  }));
  if (!d.items.length) throw new Error('Video tidak ditemukan.');
  return { item: normalize(d.items[0]) };
}

async function yt(path, params) {
  const r = await fetch(`${API}${path}?${params}`);
  const j = await r.json();
  if (!r.ok) throw new Error(j.error?.message || 'YouTube API request gagal');
  return j;
}

function normalize(v) {
  return {
    id: v.id,
    title: v.snippet?.title || '',
    description: v.snippet?.description || '',
    channelTitle: v.snippet?.channelTitle || '',
    publishedAt: v.snippet?.publishedAt || '',
    views: Number(v.statistics?.viewCount || 0),
    likes: Number(v.statistics?.likeCount || 0),
    comments: Number(v.statistics?.commentCount || 0),
    tags: (v.snippet?.tags || []).length,
    thumb: v.snippet?.thumbnails?.medium?.url ||
           v.snippet?.thumbnails?.default?.url || ''
  };
}



async function hashKey(s) {
  const bytes = new TextEncoder().encode(s);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map(x => x.toString(16).padStart(2,'0')).join('').slice(0,32);
}

function json(data, status=200, extra={}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json;charset=UTF-8',
      'cache-control': 'no-store',
      ...extra
    }
  });
}
