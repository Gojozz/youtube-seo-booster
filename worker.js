const API = 'https://www.googleapis.com/youtube/v3';

const SEARCH_TTL = 1800;
const VIDEO_TTL = 600;
const STALE_TTL = 7200;

const RATE_WINDOW = 60;
const RATE_LIMIT = 20;

export default {
  async fetch(request, env, ctx) {
    const u = new URL(request.url);

    if (!u.pathname.startsWith('/api/')) {
      return env.ASSETS.fetch(request);
    }

    if (!env.YOUTUBE_API_KEY) {
      return json({
        error: 'YOUTUBE_API_KEY belum dipasang sebagai Worker Secret.'
      }, 500);
    }

    if (!env.CACHE) {
      return json({
        error: 'KV CACHE belum dikonfigurasi.'
      }, 500);
    }

    const ip =
      request.headers.get('CF-Connecting-IP') || 'unknown';

    const rateKey = `rate:${ip}`;

    const rate =
      await env.CACHE.get(rateKey, 'json') || {
        count: 0
      };

    if (rate.count >= RATE_LIMIT) {
      return json({
        error: 'Terlalu banyak permintaan. Coba lagi sebentar.',
        retryAfter: RATE_WINDOW
      }, 429, {
        'Retry-After': String(RATE_WINDOW)
      });
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

    try {

      // =========================
      // SEARCH
      // =========================

      if (u.pathname === '/api/search') {

        const q =
          (u.searchParams.get('q') || '').trim();

        const region =
          (u.searchParams.get('region') || 'ID')
            .toUpperCase();

        if (!q) {
          return json({
            error: 'Keyword kosong.'
          }, 400);
        }

        if (q.length > 200) {
          return json({
            error: 'Keyword terlalu panjang.'
          }, 400);
        }

        const cacheKey =
          `search:${region}:${await hashKey(q)}`;

        const cached =
          await env.CACHE.get(cacheKey, 'json');

        if (cached) {
          return json({
            ...cached,
            cache: 'HIT'
          });
        }

        const staleKey =
          `${cacheKey}:stale`;

        const stale =
          await env.CACHE.get(staleKey, 'json');

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
      // SINGLE VIDEO
      // =========================

      if (u.pathname === '/api/video') {

        const id =
          (u.searchParams.get('id') || '').trim();

        if (!/^[A-Za-z0-9_-]{6,20}$/.test(id)) {
          return json({
            error: 'Video ID tidak valid.'
          }, 400);
        }

        const cacheKey =
          `video:${id}`;

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

      return json({
        error: 'Endpoint tidak ditemukan.'
      }, 404);

    } catch (e) {

      return json({
        error:
          e?.message ||
          'YouTube API error'
      }, 500);
    }
  }
};


// ======================================================
// CACHE REFRESH
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

  } catch {}
}


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

  } catch {}
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
      maxResults: '25',
      regionCode: region,
      relevanceLanguage: 'id',
      order: isLatest ? 'date' : 'relevance',
      key: env.YOUTUBE_API_KEY
    });

  const search =
    await yt('/search', params);

  const ids =
    search.items
      .map(
        item =>
          item.id?.videoId
      )
      .filter(Boolean);

  if (!ids.length) {
    return {
      keyword: q,
      region,
      totalResults: 0,
      analyzedAt: new Date().toISOString(),
      market: emptyMarket(),
      items: []
    };
  }

  const details =
    await yt(
      '/videos',
      new URLSearchParams({
        part:
          'snippet,statistics,contentDetails',
        id: ids.join(','),
        key: env.YOUTUBE_API_KEY
      })
    );

  let items =
    details.items.map(normalize);

  // Analisis setiap video
  items =
    items.map(video => {

      const analysis =
        analyzeVideo(
          video,
          q
        );

      return {
        ...video,
        ...analysis
      };
    });

  // Market
  const market =
    analyzeMarket(
      items,
      q
    );

  // Opportunity
  items =
    items.map(video => {

      const opportunity =
        calculateOpportunity(
          video,
          market
        );

      return {
        ...video,
        opportunityScore:
          opportunity.score,
        opportunityLabel:
          opportunity.label,
        opportunityReason:
          opportunity.reason
      };
    });

  // Sorting
  items.sort(
    (a, b) => {

      if (isLatest) {

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
      }

      return (
        b.opportunityScore -
        a.opportunityScore
      );
    }
  );

  const keywordOpportunity =
    calculateKeywordOpportunity(
      market,
      q
    );

  return {

    keyword: q,

    region,

    totalResults:
      items.length,

    analyzedAt:
      new Date().toISOString(),

    market: {

      ...market,

      opportunityScore:
        keywordOpportunity.score,

      opportunityLabel:
        keywordOpportunity.label,

      recommendation:
        keywordOpportunity.recommendation
    },

    items
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

    channelId:
      snippet.channelId || '',

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
      '',

    duration:
      v.contentDetails?.duration || '',

    ageHours:
      calculateAgeHours(
        publishedAt
      )
  };
}


// ======================================================
// VIDEO ANALYSIS
// ======================================================

function analyzeVideo(
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

  const relevance =
    calculateRelevance(
      title,
      description,
      q,
      words
    );

  const titleScore =
    calculateTitleScore(
      title,
      q,
      words
    );

  const descriptionScore =
    calculateDescriptionScore(
      description,
      q,
      words
    );

  const velocity =
    calculateViewVelocity(
      video.views,
      video.ageHours
    );

  const engagement =
    calculateEngagement(
      video.views,
      video.likes,
      video.comments
    );

  const freshness =
    calculateFreshness(
      video.ageHours
    );

  const tagsScore =
    video.tags > 0
      ? Math.min(
          100,
          35 +
          Math.min(
            65,
            video.tags * 4
          )
        )
      : 0;

  const viewScore =
    calculateViewScore(
      video.views
    );

  const seoScore =
    clamp(
      Math.round(
        relevance * 0.30 +
        titleScore * 0.20 +
        descriptionScore * 0.12 +
        tagsScore * 0.08 +
        engagement * 0.10 +
        freshness * 0.05 +
        velocity * 0.15
      )
    );

  return {

    relevanceScore:
      relevance,

    titleScore,

    descriptionScore,

    velocityScore:
      velocity,

    engagementScore:
      engagement,

    freshnessScore:
      freshness,

    tagsScore,

    viewScore,

    seoScore,

    viewVelocity:
      Math.round(
        velocityValue(
          video.views,
          video.ageHours
        )
      ),

    age:
      formatAge(
        video.ageHours
      )
  };
}


// ======================================================
// RELEVANCE
// ======================================================

function calculateRelevance(
  title,
  description,
  q,
  words
) {

  if (!words.length) {
    return 0;
  }

  let score = 0;

  if (title.includes(q)) {
    score += 60;
  }

  const titleMatches =
    words.filter(
      word =>
        title.includes(word)
    ).length;

  score +=
    (titleMatches / words.length) *
    25;

  if (description.includes(q)) {
    score += 10;
  } else {

    const descMatches =
      words.filter(
        word =>
          description.includes(word)
      ).length;

    score +=
      (descMatches / words.length) *
      5;
  }

  return clamp(
    Math.round(score)
  );
}


// ======================================================
// TITLE SCORE
// ======================================================

function calculateTitleScore(
  title,
  q,
  words
) {

  let score = 0;

  if (title.includes(q)) {
    score += 65;
  }

  const matches =
    words.filter(
      word =>
        title.includes(word)
    ).length;

  if (words.length) {

    score +=
      (
        matches /
        words.length
      ) * 25;
  }

  if (
    title.length >= 25 &&
    title.length <= 75
  ) {
    score += 10;
  }

  return clamp(
    Math.round(score)
  );
}


// ======================================================
// DESCRIPTION SCORE
// ======================================================

function calculateDescriptionScore(
  description,
  q,
  words
) {

  if (!description) {
    return 0;
  }

  let score = 0;

  if (description.includes(q)) {
    score += 60;
  }

  const matches =
    words.filter(
      word =>
        description.includes(word)
    ).length;

  if (words.length) {

    score +=
      (
        matches /
        words.length
      ) * 30;
  }

  if (description.length >= 150) {
    score += 10;
  }

  return clamp(
    Math.round(score)
  );
}


// ======================================================
// VIEW VELOCITY
// ======================================================

function calculateViewVelocity(
  views,
  ageHours
) {

  const velocity =
    velocityValue(
      views,
      ageHours
    );

  return clamp(
    Math.round(
      normalizeLog(
        velocity,
        0.1,
        100000
      )
    )
  );
}


function velocityValue(
  views,
  ageHours
) {

  const hours =
    Math.max(
      1,
      Math.min(
        ageHours || 1,
        24 * 365
      )
    );

  return (
    Number(views || 0) /
    hours
  );
}


// ======================================================
// ENGAGEMENT
// ======================================================

function calculateEngagement(
  views,
  likes,
  comments
) {

  if (!views) {
    return 0;
  }

  const likeRate =
    likes / views;

  const commentRate =
    comments / views;

  const score =
    (
      likeRate * 100 * 0.7 +
      commentRate * 100 * 3 * 0.3
    ) * 100;

  return clamp(
    Math.round(score)
  );
}


// ======================================================
// FRESHNESS
// ======================================================

function calculateFreshness(
  ageHours
) {

  const hours =
    Math.max(
      0,
      ageHours || 0
    );

  if (hours <= 24) return 100;
  if (hours <= 72) return 90;
  if (hours <= 168) return 80;
  if (hours <= 720) return 65;
  if (hours <= 2160) return 45;
  if (hours <= 4320) return 30;

  return 15;
}


// ======================================================
// VIEW SCORE
// ======================================================

function calculateViewScore(
  views
) {

  if (!views) {
    return 0;
  }

  return clamp(
    Math.round(
      normalizeLog(
        views,
        10,
        10000000
      )
    )
  );
}


// ======================================================
// MARKET ANALYSIS
// ======================================================

function analyzeMarket(
  items
) {

  if (!items.length) {
    return emptyMarket();
  }

  const views =
    items.map(
      x => x.views || 0
    );

  const seo =
    items.map(
      x => x.seoScore || 0
    );

  const relevance =
    items.map(
      x => x.relevanceScore || 0
    );

  const velocity =
    items.map(
      x => x.velocityScore || 0
    );

  const engagement =
    items.map(
      x => x.engagementScore || 0
    );

  const avgViews =
    average(views);

  const medianViews =
    median(views);

  const averageSEO =
    average(seo);

  const averageRelevance =
    average(relevance);

  const averageVelocity =
    average(velocity);

  const averageEngagement =
    average(engagement);

  const viewStrength =
    normalizeLog(
      medianViews,
      10,
      1000000
    );

  const competitionScore =
    clamp(
      Math.round(
        viewStrength * 0.40 +
        averageSEO * 0.25 +
        averageVelocity * 0.20 +
        averageEngagement * 0.15
      )
    );

  let level = 'Rendah';

  if (competitionScore >= 70) {
    level = 'Tinggi';
  } else if (competitionScore >= 45) {
    level = 'Sedang';
  }

  return {

    averageViews:
      Math.round(avgViews),

    medianViews:
      Math.round(medianViews),

    averageSEO:
      Math.round(averageSEO),

    averageRelevance:
      Math.round(averageRelevance),

    averageVelocity:
      Math.round(averageVelocity),

    averageEngagement:
      Math.round(averageEngagement),

    competitionScore,

    level
  };
}


// ======================================================
// VIDEO OPPORTUNITY
// ======================================================

function calculateOpportunity(
  video,
  market
) {

  const competitorWeakness =
    100 -
    market.competitionScore;

  const videoStrength =
    video.seoScore * 0.35 +
    video.velocityScore * 0.30 +
    video.engagementScore * 0.20 +
    video.viewScore * 0.15;

  const videoWeakness =
    100 -
    videoStrength;

  const score =
    clamp(
      Math.round(
        video.relevanceScore * 0.30 +
        competitorWeakness * 0.35 +
        videoWeakness * 0.25 +
        video.freshnessScore * 0.10
      )
    );

  let label = 'Sangat Sulit';

  if (score >= 80) {
    label = 'Peluang Tinggi';
  } else if (score >= 65) {
    label = 'Layak Dicoba';
  } else if (score >= 50) {
    label = 'Sedang';
  } else if (score >= 35) {
    label = 'Rendah';
  }

  let reason =
    'Kompetisi relatif kuat.';

  if (score >= 80) {
    reason =
      'Kompetitor relatif lemah dan keyword cukup relevan.';
 } else if (score >= 65) {
    reason =
      'Masih ada celah untuk membuat video yang lebih optimal.';
  } else if (score >= 50) {
    reason =
      'Peluang ada, tetapi perlu optimasi judul dan konten.';
  }

  return {
    score,
    label,
    reason
  };
}


// ======================================================
// KEYWORD OPPORTUNITY
// ======================================================

function calculateKeywordOpportunity(
  market
) {

  const competition =
    market.competitionScore;

  const relevance =
    market.averageRelevance;

  const seo =
    market.averageSEO;

  const velocity =
    market.averageVelocity;

  const competitionOpportunity =
    100 - competition;

  const seoGap =
    100 - seo;

  const velocityGap =
    100 - velocity;

  const score =
    clamp(
      Math.round(
        relevance * 0.35 +
        competitionOpportunity * 0.35 +
        seoGap * 0.20 +
        velocityGap * 0.10
      )
    );

  let label = 'Rendah';

  let recommendation =
    'Keyword ini cukup kompetitif.';

  if (score >= 80) {

    label = 'Sangat Bagus';

    recommendation =
      'Gas. Keyword menunjukkan peluang yang menarik.';

  } else if (score >= 65) {

    label = 'Bagus';

    recommendation =
      'Layak dibuat. Fokus pada judul, thumbnail dan retention.';

  } else if (score >= 50) {

    label = 'Sedang';

    recommendation =
      'Masih layak, tetapi perlu diferensiasi dari kompetitor.';

  } else if (score >= 35) {

    label = 'Rendah';

    recommendation =
      'Kompetisi cukup berat. Pertimbangkan keyword turunan.';

  } else {

    label = 'Sangat Rendah';

    recommendation =
      'Cari keyword yang lebih spesifik atau long-tail.';
  }

  return {
    score,
    label,
    recommendation
  };
}


// ======================================================
// AGE
// ======================================================

function calculateAgeHours(
  publishedAt
) {

  if (!publishedAt) {
    return 0;
  }

  const time =
    new Date(
      publishedAt
    ).getTime();

  if (!Number.isFinite(time)) {
    return 0;
  }

  return Math.max(
    0,
    (
      Date.now() -
      time
    ) / 3600000
  );
}


function formatAge(
  hours
) {

  if (!Number.isFinite(hours)) {
    return '-';
  }

  if (hours < 1) {
    return 'baru saja';
  }

  if (hours < 24) {
    return (
      Math.floor(hours) +
      ' jam'
    );
  }

  const days =
    Math.floor(
      hours / 24
    );

  if (days < 30) {
    return (
      days +
      ' hari'
    );
  }

  const months =
    Math.floor(
      days / 30
    );

  if (months < 12) {
    return (
      months +
      ' bulan'
    );
  }

  return (
    Math.floor(
      months / 12
    ) +
    ' tahun'
  );
}


// ======================================================
// HELPERS
// ======================================================

function average(arr) {

  if (!arr.length) {
    return 0;
  }

  return (
    arr.reduce(
      (a, b) => a + b,
      0
    ) / arr.length
  );
}


function median(arr) {

  if (!arr.length) {
    return 0;
  }

  const sorted =
    [...arr].sort(
      (a, b) => a - b
    );

  const middle =
    Math.floor(
      sorted.length / 2
    );

  if (sorted.length % 2) {
    return sorted[middle];
  }

  return (
    (
      sorted[middle - 1] +
      sorted[middle]
    ) / 2
  );
}


function normalizeLog(
  value,
  min,
  max
) {

  value =
    Math.max(
      min,
      Math.min(
        max,
        Number(value || 0)
      )
    );

  const result =
    (
      Math.log10(value) -
      Math.log10(min)
    ) /
    (
      Math.log10(max) -
      Math.log10(min)
    );

  return clamp(
    Math.round(
      result * 100
    )
  );
}


function clamp(
  value,
  min = 0,
  max = 100
) {

  return Math.max(
    min,
    Math.min(
      max,
      Number(value) || 0
    )
  );
}


function emptyMarket() {

  return {

    averageViews: 0,

    medianViews: 0,

    averageSEO: 0,

    averageRelevance: 0,

    averageVelocity: 0,

    averageEngagement: 0,

    competitionScore: 0,

    level: 'Tidak ada data'
  };
}


// ======================================================
// SHA256
// ======================================================

async function hashKey(s) {

  const bytes =
    new TextEncoder()
      .encode(s);

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
