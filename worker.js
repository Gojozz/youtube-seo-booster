const API = 'https://www.googleapis.com/youtube/v3';

// ======================================================
// YouTube SEO Booster V3
// ======================================================
// Features:
// - YouTube search
// - KV caching
// - Stale cache
// - IP rate limiting
// - SEO Score
// - Relevance Score
// - Competition Score
// - Opportunity Score
// - Freshness Score
// - Engagement Score
// - Competitor analysis
// - Keyword analysis
//
// Required Worker bindings:
// - YOUTUBE_API_KEY : Worker Secret
// - CACHE           : KV Namespace
// - ASSETS          : Assets binding
// ======================================================


// ======================================================
// CONFIG
// ======================================================

const SEARCH_TTL = 1800;       // 30 menit
const VIDEO_TTL = 600;         // 10 menit
const STALE_TTL = 7200;        // 2 jam

const RATE_WINDOW = 60;        // 60 detik
const RATE_LIMIT = 20;         // 20 request / IP / menit

const MAX_RESULTS = 25;


// ======================================================
// MAIN WORKER
// ======================================================

export default {
  async fetch(request, env, ctx) {
    const u = new URL(request.url);

    // ==================================================
    // FRONTEND / ASSETS
    // ==================================================

    if (!u.pathname.startsWith('/api/')) {
      return env.ASSETS.fetch(request);
    }

    // ==================================================
    // CHECK API KEY
    // ==================================================

    if (!env.YOUTUBE_API_KEY) {
      return json(
        {
          error:
            'YOUTUBE_API_KEY belum dipasang sebagai Worker Secret.'
        },
        500
      );
    }

    // ==================================================
    // CHECK KV
    // ==================================================

    if (!env.CACHE) {
      return json(
        {
          error:
            'KV CACHE belum dikonfigurasi.'
        },
        500
      );
    }

    // ==================================================
    // RATE LIMIT
    // ==================================================

    const ip =
      request.headers.get('CF-Connecting-IP') ||
      'unknown';

    const rateKey =
      `rate:${ip}`;

    const rate =
      (await env.CACHE.get(
        rateKey,
        'json'
      )) || {
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
          'Retry-After':
            String(RATE_WINDOW)
        }
      );
    }

    await env.CACHE.put(
      rateKey,
      JSON.stringify({
        count: rate.count + 1
      }),
      {
        expirationTtl:
          RATE_WINDOW
      }
    );

    // ==================================================
    // ROUTES
    // ==================================================

    try {

      // =================================================
      // SEARCH
      // =================================================

      if (u.pathname === '/api/search') {

        const q =
          (u.searchParams.get('q') || '')
            .trim();

        const region =
          (
            u.searchParams.get('region') ||
            'ID'
          )
            .toUpperCase();

        if (!q) {
          return json(
            {
              error:
                'Keyword kosong.'
            },
            400
          );
        }

        if (q.length > 200) {
          return json(
            {
              error:
                'Keyword terlalu panjang.'
            },
            400
          );
        }

        const cacheKey =
          `v3:search:${region}:${await hashKey(q)}`;

        // ---------------------------------------------
        // ACTIVE CACHE
        // ---------------------------------------------

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

        // ---------------------------------------------
        // STALE CACHE
        // ---------------------------------------------

        const staleKey =
          `${cacheKey}:stale`;

        const stale =
          await env.CACHE.get(
            staleKey,
            'json'
          );

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

        // ---------------------------------------------
        // FETCH YOUTUBE
        // ---------------------------------------------

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


      // =================================================
      // SINGLE VIDEO
      // =================================================

      if (u.pathname === '/api/video') {

        const id =
          (
            u.searchParams.get('id') ||
            ''
          ).trim();

        if (
          !/^[A-Za-z0-9_-]{6,20}$/.test(id)
        ) {
          return json(
            {
              error:
                'Video ID tidak valid.'
            },
            400
          );
        }

        const cacheKey =
          `v3:video:${id}`;

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


      // =================================================
      // HEALTH CHECK
      // =================================================

      if (u.pathname === '/api/health') {

        return json({
          status: 'ok',
          version: '3.0',
          service:
            'YouTube SEO Booster',
          timestamp:
            new Date().toISOString()
        });
      }


      // =================================================
      // UNKNOWN ENDPOINT
      // =================================================

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
// REFRESH SEARCH
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
    // stale tetap digunakan
  }
}


// ======================================================
// REFRESH VIDEO
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
    // stale tetap digunakan
  }
}


// ======================================================
// CACHE
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

  await env.CACHE.put(
    key,
    body,
    {
      expirationTtl: ttl
    }
  );

  await env.CACHE.put(
    staleKey,
    body,
    {
      expirationTtl:
        STALE_TTL
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
      maxResults:
        String(MAX_RESULTS),
      regionCode:
        region,
      relevanceLanguage:
        'id',
      order:
        isLatest
          ? 'date'
          : 'relevance',
      key:
        env.YOUTUBE_API_KEY
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
    return emptyResult(
      q,
      region
    );
  }

  const details =
    await yt(
      '/videos',
      new URLSearchParams({
        part:
          'snippet,statistics,contentDetails',
        id: ids,
        key:
          env.YOUTUBE_API_KEY
      })
    );

  const items =
    details.items.map(
      normalize
    );

  // ==================================================
  // ANALYZE
  // ==================================================

  const scored =
    items.map(video => {

      const analysis =
        analyzeVideo(
          video,
          q,
          items
        );

      return {
        ...video,
        ...analysis
      };
    });

  // ==================================================
  // SORT
  // ==================================================

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

        if (
          dateB !== dateA
        ) {
          return dateB - dateA;
        }

        return (
          b.opportunityScore -
          a.opportunityScore
        );
      }
    );

  } else {

    scored.sort(
      (a, b) =>
        b.opportunityScore -
        a.opportunityScore
    );
  }

  // ==================================================
  // MARKET ANALYSIS
  // ==================================================

  const market =
    analyzeMarket(
      scored,
      q
    );

  return {
    version: '3.0',

    keyword: q,

    region,

    analyzedAt:
      new Date().toISOString(),

    totalResults:
      scored.length,

    market,

    items: scored
  };
}


// ======================================================
// SINGLE VIDEO
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
        key:
          env.YOUTUBE_API_KEY
      })
    );

  if (
    !details.items.length
  ) {
    throw new Error(
      'Video tidak ditemukan.'
    );
  }

  const video =
    normalize(
      details.items[0]
    );

  return {
    version: '3.0',

    item: {
      ...video,
      ...analyzeVideo(
        video,
        video.title,
        [video]
      )
    }
  };
}


// ======================================================
// YOUTUBE API
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
// NORMALIZE
// ======================================================

function normalize(v) {

  const snippet =
    v.snippet || {};

  const statistics =
    v.statistics || {};

  const thumbnails =
    snippet.thumbnails || {};

  const publishedAt =
    snippet.publishedAt || '';

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

    publishedAt,

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
      thumbnails.high?.url ||
      thumbnails.medium?.url ||
      thumbnails.default?.url ||
      ''
  };
}


// ======================================================
// ANALYZE VIDEO
// ======================================================

function analyzeVideo(
  video,
  keyword,
  competitors
) {

  const relevance =
    calculateRelevance(
      video,
      keyword
    );

  const engagement =
    calculateEngagement(
      video
    );

  const freshness =
    calculateFreshness(
      video.publishedAt
    );

  const competition =
    calculateCompetition(
      video,
      competitors
    );

  const seo =
    calculateSEOScore(
      video,
      keyword
    );

  // Opportunity:
  // relevansi tinggi
  // + engagement
  // + freshness
  // + kompetisi rendah

  const opportunity =
    Math.round(
      (
        relevance * 0.35
      ) +
      (
        engagement * 0.15
      ) +
      (
        freshness * 0.15
      ) +
      (
        (100 - competition) * 0.25
      ) +
      (
        seo * 0.10
      )
    );

  return {

    seoScore:
      seo,

    relevanceScore:
      relevance,

    engagementScore:
      engagement,

    freshnessScore:
      freshness,

    competitionScore:
      competition,

    opportunityScore:
      clamp(
        opportunity,
        0,
        100
      ),

    opportunityLabel:
      opportunityLabel(
        opportunity
      ),

    age:
      formatAge(
        video.publishedAt
      )
  };
}


// ======================================================
// RELEVANCE
// ======================================================

function calculateRelevance(
  video,
  keyword
) {

  const title =
    video.title.toLowerCase();

  const description =
    video.description.toLowerCase();

  const q =
    keyword.toLowerCase().trim();

  const words =
    q
      .split(/\s+/)
      .filter(
        word =>
          word.length > 1
      );

  if (!words.length) {
    return 0;
  }

  let score = 0;

  // Exact phrase title
  if (
    title.includes(q)
  ) {
    score += 60;
  }

  // Individual title words
  const titleMatches =
    words.filter(
      word =>
        title.includes(word)
    ).length;

  score +=
    (
      titleMatches /
      words.length
    ) * 25;

  // Description
  const descriptionMatches =
    words.filter(
      word =>
        description.includes(
          word
        )
    ).length;

  score +=
    (
      descriptionMatches /
      words.length
    ) * 15;

  return Math.round(
    clamp(
      score,
      0,
      100
    )
  );
}


// ======================================================
// ENGAGEMENT
// ======================================================

function calculateEngagement(
  video
) {

  const views =
    Math.max(
      1,
      Number(video.views || 0)
    );

  const likes =
    Number(video.likes || 0);

  const comments =
    Number(video.comments || 0);

  const likeRate =
    likes / views;

  const commentRate =
    comments / views;

  let score = 0;

  // Like rate
  if (
    likeRate >= 0.10
  ) {
    score += 50;
  } else if (
    likeRate >= 0.05
  ) {
    score += 40;
  } else if (
    likeRate >= 0.02
  ) {
    score += 30;
  } else if (
    likeRate >= 0.01
  ) {
    score += 20;
  } else if (
    likeRate > 0
  ) {
    score += 10;
  }

  // Comment rate
  if (
    commentRate >= 0.02
  ) {
    score += 50;
  } else if (
    commentRate >= 0.01
  ) {
    score += 40;
  } else if (
    commentRate >= 0.005
  ) {
    score += 30;
  } else if (
    commentRate >= 0.001
  ) {
    score += 20;
  } else if (
    commentRate > 0
  ) {
    score += 10;
  }

  return clamp(
    Math.round(score),
    0,
    100
  );
}


// ======================================================
// FRESHNESS
// ======================================================

function calculateFreshness(
  publishedAt
) {

  if (!publishedAt) {
    return 0;
  }

  const published =
    new Date(
      publishedAt
    ).getTime();

  const now =
    Date.now();

  const days =
    Math.max(
      0,
      (
        now - published
      ) /
      86400000
    );

  if (days < 1) {
    return 100;
  }

  if (days <= 3) {
    return 95;
  }

  if (days <= 7) {
    return 90;
  }

  if (days <= 14) {
    return 80;
  }

  if (days <= 30) {
    return 70;
  }

  if (days <= 90) {
    return 55;
  }

  if (days <= 180) {
    return 40;
  }

  if (days <= 365) {
    return 25;
  }

  return 15;
}


// ======================================================
// COMPETITION
// ======================================================

function calculateCompetition(
  video,
  competitors
) {

  if (
    !competitors ||
    competitors.length <= 1
  ) {
    return 50;
  }

  const views =
    Number(
      video.views || 0
    );

  const viewValues =
    competitors
      .map(
        item =>
          Number(
            item.views || 0
          )
      )
      .sort(
        (a, b) => a - b
      );

  const index =
    viewValues.findIndex(
      value =>
        value >= views
    );

  let percentile = 50;

  if (index >= 0) {

    percentile =
      (
        index /
        Math.max(
          1,
          viewValues.length - 1
        )
      ) * 100;

  }

  // Lebih banyak views
  // = kompetisi lebih kuat
  return clamp(
    Math.round(
      percentile
    ),
    0,
    100
  );
}


// ======================================================
// MARKET ANALYSIS
// ======================================================

function analyzeMarket(
  items,
  keyword
) {

  if (!items.length) {

    return {
      competitionScore: 0,
      opportunityScore: 0,
      averageViews: 0,
      medianViews: 0,
      averageSEO: 0,
      averageRelevance: 0,
      level: 'Tidak ada data'
    };
  }

  const views =
    items
      .map(
        item =>
          Number(
            item.views || 0
          )
      )
      .sort(
        (a, b) =>
          a - b
      );

  const averageViews =
    Math.round(
      views.reduce(
        (sum, value) =>
          sum + value,
        0
      ) /
      views.length
    );

  const medianViews =
    views[
      Math.floor(
        views.length / 2
      )
    ] || 0;

  const averageSEO =
    Math.round(
      average(
        items.map(
          item =>
            item.seoScore
        )
      )
    );

  const averageRelevance =
    Math.round(
      average(
        items.map(
          item =>
            item.relevanceScore
        )
      )
    );

  const averageCompetition =
    Math.round(
      average(
        items.map(
          item =>
            item.competitionScore
        )
      )
    );

  const averageOpportunity =
    Math.round(
      average(
        items.map(
          item =>
            item.opportunityScore
        )
      )
    );

  return {

    keyword,

    competitionScore:
      averageCompetition,

    opportunityScore:
      averageOpportunity,

    averageViews,

    medianViews,

    averageSEO,

    averageRelevance,

    level:
      competitionLabel(
        averageCompetition
      )
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

  // Title
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
        (
          matched /
          words.length
        ) * 30;

    }
  }

  // Description
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
        (
          matched /
          words.length
        ) * 10;

    }
  }

  // Views
  const views =
    Number(
      video.views || 0
    );

  if (
    views >= 1000000
  ) {
    score += 10;
  } else if (
    views >= 100000
  ) {
    score += 8;
  } else if (
    views >= 10000
  ) {
    score += 6;
  } else if (
    views >= 1000
  ) {
    score += 4;
  } else if (
    views > 0
  ) {
    score += 2;
  }

  // Engagement
  if (
    Number(video.likes || 0) > 0
  ) {
    score += 2;
  }

  if (
    Number(video.comments || 0) > 0
  ) {
    score += 2;
  }

  // Tags
  if (
    Number(video.tags || 0) > 0
  ) {
    score += 4;
  }

  return clamp(
    Math.round(score),
    0,
    100
  );
}


// ======================================================
// LABELS
// ======================================================

function opportunityLabel(
  score
) {

  if (score >= 85) {
    return 'Sangat Bagus';
  }

  if (score >= 70) {
    return 'Bagus';
  }

  if (score >= 50) {
    return 'Sedang';
  }

  if (score >= 30) {
    return 'Rendah';
  }

  return 'Sangat Rendah';
}


function competitionLabel(
  score
) {

  if (score >= 80) {
    return 'Sangat Tinggi';
  }

  if (score >= 60) {
    return 'Tinggi';
  }

  if (score >= 40) {
    return 'Sedang';
  }

  if (score >= 20) {
    return 'Rendah';
  }

  return 'Sangat Rendah';
}


// ======================================================
// AGE
// ======================================================

function formatAge(
  publishedAt
) {

  if (!publishedAt) {
    return '-';
  }

  const published =
    new Date(
      publishedAt
    ).getTime();

  const diff =
    Math.max(
      0,
      Date.now() - published
    );

  const minutes =
    Math.floor(
      diff / 60000
    );

  const hours =
    Math.floor(
      diff / 3600000
    );

  const days =
    Math.floor(
      diff / 86400000
    );

  if (minutes < 60) {

    if (minutes <= 1) {
      return 'Baru saja';
    }

    return `${minutes} menit`;
  }

  if (hours < 24) {

    return `${hours} jam`;
  }

  if (days === 0) {
    return 'Hari ini';
  }

  if (days === 1) {
    return '1 hari';
  }

  if (days < 30) {
    return `${days} hari`;
  }

  const months =
    Math.floor(
      days / 30
    );

  if (months < 12) {
    return `${months} bulan`;
  }

  const years =
    Math.floor(
      days / 365
    );

  return `${years} tahun`;
}


// ======================================================
// EMPTY RESULT
// ======================================================

function emptyResult(
  q,
  region
) {

  return {

    version: '3.0',

    keyword: q,

    region,

    analyzedAt:
      new Date().toISOString(),

    totalResults: 0,

    market: {
      competitionScore: 0,
      opportunityScore: 0,
      averageViews: 0,
      medianViews: 0,
      averageSEO: 0,
      averageRelevance: 0,
      level: 'Tidak ada data'
    },

    items: []
  };
}


// ======================================================
// HELPERS
// ======================================================

function average(
  values
) {

  if (
    !values.length
  ) {
    return 0;
  }

  return (
    values.reduce(
      (a, b) =>
        a + Number(b || 0),
      0
    ) /
    values.length
  );
}


function clamp(
  value,
  min,
  max
) {

  return Math.max(
    min,
    Math.min(
      max,
      value
    )
  );
}


// ======================================================
// SHA-256 CACHE KEY
// ======================================================

async function hashKey(
  s
) {

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
