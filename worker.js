const API = 'https://www.googleapis.com/youtube/v3';

// YouTube SEO Booster V2.2
// KV caching + IP rate limiting + stale cache
//
// Required Worker bindings:
// - YOUTUBE_API_KEY : Worker Secret
// - CACHE           : KV Namespace

const SEARCH_TTL = 1800;       // 30 menit
const VIDEO_TTL = 600;         // 10 menit
const STALE_TTL = 7200;        // 2 jam
const RATE_WINDOW = 60;        // 60 detik
const RATE_LIMIT = 20;         // maksimal 20 request API/IP/menit

export default {
  async fetch(request, env, ctx) {
    const u = new URL(request.url);

    // Semua request selain /api/* diteruskan ke Assets
    if (!u.pathname.startsWith('/api/')) {
      return env.ASSETS.fetch(request);
    }

    // Cek API Key
    if (!env.YOUTUBE_API_KEY) {
      return json(
        {
          error:
            'YOUTUBE_API_KEY belum dipasang sebagai Worker Secret.'
        },
        500
      );
    }

    // Cek KV
    if (!env.CACHE) {
      return json(
        {
          error: 'KV CACHE belum dikonfigurasi.'
        },
        500
      );
    }

    // =========================
    // RATE LIMIT
    // =========================

    const ip =
      request.headers.get('CF-Connecting-IP') || 'unknown';

    const rateKey = `rate:${ip}`;

    const rate =
      (await env.CACHE.get(rateKey, 'json')) || {
        count: 0
      };

    if (rate.count >= RATE_LIMIT) {
      return json(
        {
          error:
            'Terlalu banyak permintaan. Coba lagi sebentar.',
          retryAfter: RATE_WINDOW
        },
        429,
        {
          'Retry-After': String(RATE_WINDOW)
        }
      );
    }

    await env.CACHE.put(
      rateKey,
      JSON.stringify({
        count: rate.count + 1
      }),
      {
        expirationTtl: RATE_WINDOW
      }
    );

    // =========================
    // API ROUTES
    // =========================

    try {
      // =========================
      // SEARCH
      // =========================

      if (u.pathname === '/api/search') {
        // PENTING:
        // Jangan gunakan normalize() di sini.
        // normalize() khusus untuk data video.
        const q = (u.searchParams.get('q') || '').trim();

        const region = (
          u.searchParams.get('region') || 'ID'
        ).toUpperCase();

        if (!q) {
          return json(
            {
              error: 'Keyword kosong.'
            },
            400
          );
        }

        // Batasi panjang keyword
        if (q.length > 200) {
          return json(
            {
              error: 'Keyword terlalu panjang.'
            },
            400
          );
        }

        const cacheKey =
          `search:${region}:${await hashKey(q)}`;

        // Cache utama
        const cached =
          await env.CACHE.get(cacheKey, 'json');

        if (cached) {
          return json({
            ...cached,
            cache: 'HIT'
          });
        }

        // Stale cache
        const staleKey =
          `${cacheKey}:stale`;

        const stale =
          await env.CACHE.get(staleKey, 'json');

        // Kalau ada stale, tampilkan dulu
        // sambil refresh di background
        if (stale) {
          ctx.waitUntil(
            refreshSearch(
              env,
              cacheKey,
              staleKey,
              q,
              region
            )
          );

          return json({
            ...stale,
            cache: 'STALE'
          });
        }

        // Request baru ke YouTube
        const data =
          await fetchSearch(
            env,
            q,
            region
          );

        await putCache(
          env,
          cacheKey,
          staleKey,
          data,
          SEARCH_TTL
        );

        return json({
          ...data,
          cache: 'MISS'
        });
      }

      // =========================
      // VIDEO
      // =========================

      if (u.pathname === '/api/video') {
        const id = (
          u.searchParams.get('id') || ''
        ).trim();

        if (!/^[A-Za-z0-9_-]{6,20}$/.test(id)) {
          return json(
            {
              error: 'Video ID tidak valid.'
            },
            400
          );
        }

        const cacheKey =
          `video:${id}`;

        // Cache utama
        const cached =
          await env.CACHE.get(
            cacheKey,
            'json'
          );

        if (cached) {
          return json({
            ...cached,
            cache: 'HIT'
          });
        }

        // Stale cache
        const staleKey =
          `${cacheKey}:stale`;

        const stale =
          await env.CACHE.get(
            staleKey,
            'json'
          );

        if (stale) {
          ctx.waitUntil(
            refreshVideo(
              env,
              cacheKey,
              staleKey,
              id
            )
          );

          return json({
            ...stale,
            cache: 'STALE'
          });
        }

        // Request baru
        const data =
          await fetchVideo(
            env,
            id
          );

        await putCache(
          env,
          cacheKey,
          staleKey,
          data,
          VIDEO_TTL
        );

        return json({
          ...data,
          cache: 'MISS'
        });
      }

      // =========================
      // UNKNOWN ENDPOINT
      // =========================

      return json(
        {
          error:
            'Endpoint tidak ditemukan.'
        },
        404
      );

    } catch (e) {
      return json(
        {
          error:
            e?.message ||
            'YouTube API error'
        },
        500
      );
    }
  }
};


// ======================================================
// REFRESH SEARCH CACHE
// ======================================================

async function refreshSearch(
  env,
  cacheKey,
  staleKey,
  q,
  region
) {
  try {
    const data =
      await fetchSearch(
        env,
        q,
        region
      );

    await putCache(
      env,
      cacheKey,
      staleKey,
      data,
      SEARCH_TTL
    );
  } catch (e) {
    // Jangan menggagalkan response stale
  }
}


// ======================================================
// REFRESH VIDEO CACHE
// ======================================================

async function refreshVideo(
  env,
  cacheKey,
  staleKey,
  id
) {
  try {
    const data =
      await fetchVideo(
        env,
        id
      );

    await putCache(
      env,
      cacheKey,
      staleKey,
      data,
      VIDEO_TTL
    );
  } catch (e) {
    // Jangan menggagalkan response stale
  }
}


// ======================================================
// SAVE CACHE
// ======================================================

async function putCache(
  env,
  key,
  staleKey,
  data,
  ttl
) {
  const body =
    JSON.stringify(data);

  // Cache aktif
  await env.CACHE.put(
    key,
    body,
    {
      expirationTtl: ttl
    }
  );

  // Backup stale
  await env.CACHE.put(
    staleKey,
    body,
    {
      expirationTtl: STALE_TTL
    }
  );
}


// ======================================================
// YOUTUBE SEARCH
// ======================================================

async function fetchSearch(
  env,
  q,
  region
) {
  const lowerQ =
    q.toLowerCase();

  // Jika keyword mengandung kata ini,
  // gunakan urutan video terbaru.
  const isLatest =
    lowerQ.includes('terbaru') ||
    lowerQ.includes('terkini') ||
    lowerQ.includes('latest') ||
    lowerQ.includes('new') ||
    lowerQ.includes('2026');

  const params =
    new URLSearchParams({
      part: 'snippet',
      q,
      type: 'video',

      // 25 hasil supaya analisis SEO
      // punya lebih banyak data.
      maxResults: '25',

      regionCode: region,

      relevanceLanguage: 'id',

      // Keyword biasa = relevansi.
      // Keyword terbaru = tanggal.
      order: isLatest
        ? 'date'
        : 'relevance',

      key: env.YOUTUBE_API_KEY
    });

  const search =
    await yt(
      '/search',
      params
    );

  const ids =
    search.items
      .map(
        item =>
          item.id?.videoId
      )
      .filter(Boolean)
      .join(',');

  if (!ids) {
    return {
      items: []
    };
  }

  // Ambil statistik video
  const details =
    await yt(
      '/videos',
      new URLSearchParams({
        part:
          'snippet,statistics,contentDetails',
        id: ids,
        key: env.YOUTUBE_API_KEY
      })
    );

  const items =
    details.items.map(
      normalize
    );

  // Tambahkan skor SEO
  const scored =
    items.map(item => ({
      ...item,
      seoScore: calculateSEOScore(
        item,
        q
      )
    }));

  // Untuk keyword biasa,
  // urutkan berdasarkan SEO score.
  //
  // Untuk keyword terbaru,
  // tetap prioritaskan tanggal terbaru,
  // tetapi score menjadi faktor kedua.
  if (isLatest) {
    scored.sort(
      (a, b) => {
        const dateA =
          new Date(
            a.publishedAt
          ).getTime();

        const dateB =
          new Date(
            b.publishedAt
          ).getTime();

        if (dateB !== dateA) {
          return dateB - dateA;
        }

        return (
          b.seoScore -
          a.seoScore
        );
      }
    );
  } else {
    scored.sort(
      (a, b) =>
        b.seoScore -
        a.seoScore
    );
  }

  return {
    items: scored
  };
}


// ======================================================
// GET SINGLE VIDEO
// ======================================================

async function fetchVideo(
  env,
  id
) {
  const details =
    await yt(
      '/videos',
      new URLSearchParams({
        part:
          'snippet,statistics,contentDetails',
        id,
        key: env.YOUTUBE_API_KEY
      })
    );

  if (!details.items.length) {
    throw new Error(
      'Video tidak ditemukan.'
    );
  }

  return {
    item:
      normalize(
        details.items[0]
      )
  };
}


// ======================================================
// YOUTUBE API REQUEST
// ======================================================

async function yt(
  path,
  params
) {
  const response =
    await fetch(
      `${API}${path}?${params.toString()}`
    );

  const data =
    await response.json();

  if (!response.ok) {
    throw new Error(
      data?.error?.message ||
      'YouTube API request gagal'
    );
  }

  return data;
}


// ======================================================
// NORMALIZE VIDEO DATA
// ======================================================

function normalize(v) {
  const snippet =
    v.snippet || {};

  const statistics =
    v.statistics || {};

  const thumbnails =
    snippet.thumbnails || {};

  return {
    id:
      typeof v.id === 'string'
        ? v.id
        : v.id?.videoId || '',

    title:
      snippet.title || '',

    description:
      snippet.description || '',

    channelTitle:
      snippet.channelTitle || '',

    publishedAt:
      snippet.publishedAt || '',

    views:
      Number(
        statistics.viewCount || 0
      ),

    likes:
      Number(
        statistics.likeCount || 0
      ),

    comments:
      Number(
        statistics.commentCount || 0
      ),

    tags:
      Array.isArray(
        snippet.tags
      )
        ? snippet.tags.length
        : 0,

    thumb:
      thumbnails.medium?.url ||
      thumbnails.high?.url ||
      thumbnails.default?.url ||
      ''
  };
}


// ======================================================
// SEO SCORE
// ======================================================

function calculateSEOScore(
  video,
  keyword
) {
  const title =
    video.title.toLowerCase();

  const description =
    video.description.toLowerCase();

  const q =
    keyword.toLowerCase();

  const words =
    q
      .split(/\s+/)
      .filter(Boolean);

  let score = 0;

  // --------------------------
  // Keyword di judul
  // --------------------------

  if (
    title.includes(q)
  ) {
    score += 40;
  } else {
    const matched =
      words.filter(
        word =>
          title.includes(word)
      ).length;

    if (words.length) {
      score +=
        (matched / words.length) *
        30;
    }
  }

  // --------------------------
  // Keyword di deskripsi
  // --------------------------

  if (
    description.includes(q)
  ) {
    score += 20;
  } else {
    const matched =
      words.filter(
        word =>
          description.includes(
            word
          )
      ).length;

    if (words.length) {
      score +=
        (matched / words.length) *
        10;
    }
  }

  // --------------------------
  // Views
  // --------------------------

  const views =
    Number(video.views || 0);

  if (views >= 1000000) {
    score += 10;
  } else if (views >= 100000) {
    score += 8;
  } else if (views >= 10000) {
    score += 6;
  } else if (views >= 1000) {
    score += 4;
  } else if (views > 0) {
    score += 2;
  }

  // --------------------------
  // Engagement
  // --------------------------

  const likes =
    Number(video.likes || 0);

  const comments =
    Number(video.comments || 0);

  if (likes > 0) {
    score += 2;
  }

  if (comments > 0) {
    score += 2;
  }

  // --------------------------
  // Tags
  // --------------------------

  if (video.tags > 0) {
    score += 4;
  }

  // Maksimal 100
  return Math.min(
    100,
    Math.round(score)
  );
}


// ======================================================
// SHA-256 CACHE KEY
// ======================================================

async function hashKey(s) {
  const bytes =
    new TextEncoder().encode(
      s
    );

  const digest =
    await crypto.subtle.digest(
      'SHA-256',
      bytes
    );

  return [
    ...new Uint8Array(
      digest
    )
  ]
    .map(
      x =>
        x
          .toString(16)
          .padStart(2, '0')
    )
    .join('')
    .slice(0, 32);
}


// ======================================================
// JSON RESPONSE
// ======================================================

function json(
  data,
  status = 200,
  extra = {}
) {
  return new Response(
    JSON.stringify(data),
    {
      status,

      headers: {
        'content-type':
          'application/json;charset=UTF-8',

        'cache-control':
          'no-store',

        ...extra
      }
    }
  );
}
