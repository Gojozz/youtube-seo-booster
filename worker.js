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
      await env.CACHE.get(rateKey, 'json') || { count: 0 };

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

      // =====================================================
      // SEARCH
      // =====================================================

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


      // =====================================================
      // VIDEO ANALYSIS
      // =====================================================

      if (u.pathname === '/api/video') {

        const id =
          (u.searchParams.get('id') || '').trim();

        const keyword =
          (u.searchParams.get('keyword') || '').trim();

        if (!/^[A-Za-z0-9_-]{6,20}$/.test(id)) {
          return json({
            error: 'Video ID tidak valid.'
          }, 400);
        }

        const cacheKey =
          `video:${id}:${await hashKey(keyword || '-')}`;

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
              id,
              keyword
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
            id,
            keyword
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


// =========================================================
// SEARCH
// =========================================================

async function fetchSearch(
  env,
  q,
  region
) {

  const lower =
    q.toLowerCase();

  const isLatest =
    lower.includes('terbaru') ||
    lower.includes('terkini') ||
    lower.includes('latest') ||
    lower.includes('new') ||
    lower.includes('2026');

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

  const market =
    analyzeMarket(items);

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

  items.sort(
    (a, b) =>
      b.opportunityScore -
      a.opportunityScore
  );

  const keywordOpportunity =
    calculateKeywordOpportunity(
      market
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


// =========================================================
// VIDEO
// =========================================================

async function fetchVideo(
  env,
  id,
  keyword
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
      'Video tidak ditemukan atau video tidak tersedia.'
    );
  }

  const video =
    normalize(
      details.items[0]
    );

  const analysis =
    analyzeVideo(
      video,
      keyword
    );

  const suggestions =
    generateSuggestions(
      video,
      analysis,
      keyword
    );

  return {

    item: {
      ...video,
      ...analysis,
      suggestions
    },

    analysis: {
      seoScore:
        analysis.seoScore,

      seoLabel:
        scoreLabel(
          analysis.seoScore
        ),

      relevance:
        analysis.relevanceScore,

      title:
        analysis.titleScore,

      description:
        analysis.descriptionScore,

      tags:
        analysis.tagsScore,

      views:
        video.views,

      velocity:
        analysis.viewVelocity,

      engagement:
        analysis.engagementScore,

      freshness:
        analysis.freshnessScore,

      age:
        video.age
    },

    suggestions,

    analyzedAt:
      new Date().toISOString()
  };
}


// =========================================================
// NORMALIZE
// =========================================================

function normalize(v) {

  const s =
    v.snippet || {};

  const st =
    v.statistics || {};

  const thumbnails =
    s.thumbnails || {};

  const publishedAt =
    s.publishedAt || '';

  const ageHours =
    calculateAgeHours(
      publishedAt
    );

  return {

    id:
      typeof v.id === 'string'
        ? v.id
        : v.id?.videoId || '',

    title:
      s.title || '',

    description:
      s.description || '',

    channelTitle:
      s.channelTitle || '',

    channelId:
      s.channelId || '',

    publishedAt,

    views:
      Number(
        st.viewCount || 0
      ),

    likes:
      Number(
        st.likeCount || 0
      ),

    comments:
      Number(
        st.commentCount || 0
      ),

    tags:
      Array.isArray(s.tags)
        ? s.tags.length
        : 0,

    thumb:
      thumbnails.maxres?.url ||
      thumbnails.high?.url ||
      thumbnails.medium?.url ||
      thumbnails.default?.url ||
      '',

    duration:
      v.contentDetails?.duration || '',

    ageHours,

    age:
      formatAge(ageHours)
  };
}


// =========================================================
// ANALYSIS
// =========================================================

function analyzeVideo(
  video,
  keyword
) {

  const title =
    video.title.toLowerCase();

  const description =
    video.description.toLowerCase();

  const q =
    (keyword || '').toLowerCase().trim();

  const words =
    q
      ? q.split(/\s+/).filter(
          x => x.length > 1
        )
      : [];

  let relevance = 50;

  if (q) {

    relevance =
      calculateRelevance(
        title,
        description,
        q,
        words
      );
  }

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
          40 +
          video.tags * 4
        )
      : 0;

  const viewScore =
    calculateViewScore(
      video.views
    );

  const seoScore =
    clamp(
      Math.round(
        relevance * 0.28 +
        titleScore * 0.22 +
        descriptionScore * 0.15 +
        tagsScore * 0.10 +
        engagement * 0.10 +
        freshness * 0.05 +
        velocity * 0.10
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


// =========================================================
// RELEVANCE
// =========================================================

function calculateRelevance(
  title,
  description,
  q,
  words
) {

  if (!words.length) {
    return 50;
  }

  let score = 0;

  if (title.includes(q)) {
    score += 65;
  }

  const titleMatches =
    words.filter(
      w => title.includes(w)
    ).length;

  score +=
    (
      titleMatches /
      words.length
    ) * 25;

  if (description.includes(q)) {
    score += 10;
  }

  return clamp(
    Math.round(score)
  );
}


// =========================================================
// TITLE
// =========================================================

function calculateTitleScore(
  title,
  q,
  words
) {

  let score = 0;

  if (q && title.includes(q)) {
    score += 70;
  } else if (q) {

    const matched =
      words.filter(
        w => title.includes(w)
      ).length;

    if (words.length) {
      score +=
        (
          matched /
          words.length
        ) * 50;
    }
  } else {
    score = 55;
  }

  if (
    title.length >= 30 &&
    title.length <= 70
  ) {
    score += 30;
  } else if (
    title.length >= 20 &&
    title.length <= 80
  ) {
    score += 20;
  }

  return clamp(
    Math.round(score)
  );
}


// =========================================================
// DESCRIPTION
// =========================================================

function calculateDescriptionScore(
  description,
  q,
  words
) {

  if (!description) {
    return 0;
  }

  let score = 30;

  if (
    q &&
    description.includes(q)
  ) {
    score += 45;
  }

  const matches =
    words.filter(
      w =>
        description.includes(w)
    ).length;

  if (words.length) {
    score +=
      (
        matches /
        words.length
      ) * 15;
  }

  if (description.length >= 150) {
    score += 10;
  }

  return clamp(
    Math.round(score)
  );
}


// =========================================================
// VELOCITY
// =========================================================

function calculateViewVelocity(
  views,
  ageHours
) {

  return clamp(
    Math.round(
      normalizeLog(
        velocityValue(
          views,
          ageHours
        ),
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
      0.1,
      Number(ageHours || 0.1)
    );

  return (
    Number(views || 0) /
    hours
  );
}


// =========================================================
// ENGAGEMENT
// =========================================================

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

  return clamp(
    Math.round(
      (
        likeRate * 100 * 0.7 +
        commentRate * 100 * 3 * 0.3
      ) * 100
    )
  );
}


// =========================================================
// FRESHNESS
// =========================================================

function calculateFreshness(
  ageHours
) {

  if (ageHours < 1) return 100;
  if (ageHours < 24) return 95;
  if (ageHours < 72) return 90;
  if (ageHours < 168) return 80;
  if (ageHours < 720) return 65;
  if (ageHours < 2160) return 45;
  if (ageHours < 4320) return 30;

  return 15;
}


// =========================================================
// VIEWS
// =========================================================

function calculateViewScore(
  views
) {

  if (!views) {
    return 0;
  }

  return normalizeLog(
    views,
    10,
    10000000
  );
}


// =========================================================
// MARKET
// =========================================================

function analyzeMarket(items) {

  if (!items.length) {
    return emptyMarket();
  }

  const views =
    items.map(x => x.views || 0);

  const seo =
    items.map(x => x.seoScore || 0);

  const relevance =
    items.map(
      x => x.relevanceScore || 0
    );

  const medianViews =
    median(views);

  const averageViews =
    average(views);

  const averageSEO =
    average(seo);

  const averageRelevance =
    average(relevance);

  const competitionScore =
    clamp(
      Math.round(
        normalizeLog(
          medianViews,
          10,
          1000000
        ) * 0.45 +
        averageSEO * 0.35 +
        averageRelevance * 0.20
      )
    );

  let level =
    'Rendah';

  if (competitionScore >= 70) {
    level = 'Tinggi';
  } else if (competitionScore >= 45) {
    level = 'Sedang';
  }

  return {

    averageViews:
      Math.round(averageViews),

    medianViews:
      Math.round(medianViews),

    averageSEO:
      Math.round(averageSEO),

    averageRelevance:
      Math.round(averageRelevance),

    competitionScore,

    level
  };
}


// =========================================================
// OPPORTUNITY
// =========================================================

function calculateOpportunity(
  video,
  market
) {

  const score =
    clamp(
      Math.round(
        video.relevanceScore * 0.25 +
        (
          100 -
          market.competitionScore
        ) * 0.35 +
        (
          100 -
          video.seoScore
        ) * 0.25 +
        video.freshnessScore * 0.15
      )
    );

  let label =
    'Sulit';

  if (score >= 80) {
    label = 'Peluang Tinggi';
  } else if (score >= 65) {
    label = 'Bagus';
  } else if (score >= 50) {
    label = 'Sedang';
  } else if (score >= 35) {
    label = 'Rendah';
  }

  return {
    score,
    label,
    reason:
      score >= 65
        ? 'Masih terdapat celah untuk bersaing.'
        : 'Kompetisi relatif kuat.'
  };
}


// =========================================================
// KEYWORD OPPORTUNITY
// =========================================================

function calculateKeywordOpportunity(
  market
) {

  const score =
    clamp(
      Math.round(
        market.averageRelevance * 0.35 +
        (
          100 -
          market.competitionScore
        ) * 0.40 +
        (
          100 -
          market.averageSEO
        ) * 0.25
      )
    );

  let label =
    'Rendah';

  let recommendation =
    'Cari keyword yang lebih spesifik.';

  if (score >= 80) {
    label = 'Sangat Bagus';
    recommendation =
      'Peluang menarik. Fokus pada judul, thumbnail dan retention.';
  } else if (score >= 65) {
    label = 'Bagus';
    recommendation =
      'Layak dicoba dengan optimasi yang lebih kuat.';
  } else if (score >= 50) {
    label = 'Sedang';
    recommendation =
      'Masih bisa dicoba dengan diferensiasi.';
  }

  return {
    score,
    label,
    recommendation
  };
}


// =========================================================
// SUGGESTIONS
// =========================================================

function generateSuggestions(
  video,
  a,
  keyword
) {

  const suggestions = [];

  if (a.titleScore < 60) {
    suggestions.push({
      type: 'error',
      title: 'Perbaiki judul',
      text:
        keyword
          ? `Masukkan keyword "${keyword}" secara natural di judul dan buat judul sekitar 30–70 karakter.`
          : 'Buat judul lebih spesifik, jelas dan sekitar 30–70 karakter.'
    });
  } else {
    suggestions.push({
      type: 'success',
      title: 'Judul sudah cukup baik',
      text:
        'Struktur dan panjang judul relatif bagus.'
    });
  }

  if (a.descriptionScore < 60) {
    suggestions.push({
      type: 'warning',
      title: 'Perkuat deskripsi',
      text:
        'Tambahkan penjelasan video dan keyword utama secara natural pada bagian awal deskripsi.'
    });
  } else {
    suggestions.push({
      type: 'success',
      title: 'Deskripsi cukup baik',
      text:
        'Deskripsi sudah memiliki sinyal relevansi yang cukup.'
    });
  }

  if (a.tagsScore < 50) {
    suggestions.push({
      type: 'warning',
      title: 'Periksa tags',
      text:
        'Tambahkan variasi keyword yang benar-benar relevan dengan isi video.'
    });
  }

  if (a.engagementScore < 40) {
    suggestions.push({
      type: 'warning',
      title: 'Tingkatkan engagement',
      text:
        'Dorong penonton untuk berkomentar dan berinteraksi secara natural.'
    });
  }

  if (a.velocityScore < 35) {
    suggestions.push({
      type: 'warning',
      title: 'Momentum masih rendah',
      text:
        'Perhatikan thumbnail, judul dan kemampuan video mempertahankan penonton.'
    });
  } else {
    suggestions.push({
      type: 'success',
      title: 'Momentum cukup bagus',
      text:
        'Kecepatan pertumbuhan views relatif menarik dibanding umur video.'
    });
  }

  if (video.description.length < 100) {
    suggestions.push({
      type: 'error',
      title: 'Deskripsi terlalu pendek',
      text:
        'Tambahkan konteks video, topik utama dan informasi yang membantu penonton.'
    });
  }

  if (a.seoScore >= 80) {
    suggestions.unshift({
      type: 'success',
      title: 'SEO sudah kuat',
      text:
        'Metadata video sudah cukup optimal. Fokus berikutnya pada thumbnail dan retention.'
    });
  }

  return suggestions;
}


// =========================================================
// AGE
// =========================================================

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

    const minutes =
      Math.max(
        1,
        Math.floor(
          hours * 60
        )
      );

    return `${minutes} menit`;
  }

  if (hours < 24) {
    return `${Math.floor(hours)} jam`;
  }

  const days =
    Math.floor(
      hours / 24
    );

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

  return `${Math.floor(months / 12)} tahun`;
}


// =========================================================
// SCORE LABEL
// =========================================================

function scoreLabel(score) {

  if (score >= 80) return 'Sangat Bagus';
  if (score >= 65) return 'Bagus';
  if (score >= 50) return 'Sedang';
  if (score >= 35) return 'Perlu Diperbaiki';

  return 'Rendah';
}


// =========================================================
// HELPERS
// =========================================================

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

  const mid =
    Math.floor(
      sorted.length / 2
    );

  return sorted.length % 2
    ? sorted[mid]
    : (
        sorted[mid - 1] +
        sorted[mid]
      ) / 2;
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

    competitionScore: 0,

    level: 'Tidak ada data'
  };
}


// =========================================================
// CACHE
// =========================================================

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
  id,
  keyword
) {

  try {

    const data =
      await fetchVideo(
        env,
        id,
        keyword
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


// =========================================================
// HASH
// =========================================================

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


// =========================================================
// JSON
// =========================================================

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
