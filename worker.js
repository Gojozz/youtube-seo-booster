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

    // ==============================
    // RATE LIMIT
    // ==============================

    const ip =
      request.headers.get('CF-Connecting-IP') || 'unknown';

    const rateKey = `rate:${ip}`;

    const rate =
      (await env.CACHE.get(rateKey, 'json')) || { count: 0 };

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

      // ==============================
      // SEARCH
      // ==============================

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


      // ==============================
      // VIDEO ANALYSIS
      // ==============================

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



      // =====================================================
      // AI SEO GENERATOR - GEMINI HYBRID
      // =====================================================
      if (u.pathname === '/api/generate') {

        if (request.method !== 'POST') {
          return json({
            error: 'Method harus POST.'
          }, 405, {
            Allow: 'POST'
          });
        }

        if (!env.GEMINI_API_KEY) {
          return json({
            error: 'GEMINI_API_KEY belum dipasang sebagai Worker Secret.'
          }, 500);
        }

        let body;

        try {
          body = await request.json();
        } catch {
          return json({
            error: 'JSON request tidak valid.'
          }, 400);
        }

        const keyword =
          String(body?.keyword || '').trim();

        const language =
          String(body?.language || 'Indonesia').trim();

        const style =
          String(body?.style || 'Tutorial').trim();

        const audience =
          String(body?.audience || 'Umum').trim();

        const count =
          Number(body?.count || 5) === 10 ? 10 : 5;

        if (!keyword) {
          return json({
            error: 'Keyword/topik wajib diisi.'
          }, 400);
        }

        if (keyword.length > 200) {
          return json({
            error: 'Keyword terlalu panjang.'
          }, 400);
        }

        try {

          // Ambil data kompetitor YouTube dari endpoint internal.
          const competitorData =
            await fetchSearch(env, keyword, 'ID');

          const competitors =
            (competitorData.items || [])
              .slice(0, 15)
              .map(video => ({
                title: video.title || '',
                channel: video.channelTitle || '',
                views: video.views || 0,
                likes: video.likes || 0,
                comments: video.comments || 0,
                publishedAt: video.publishedAt || '',
                seoScore: video.seoScore || 0,
                opportunityScore:
                  video.opportunityScore || 0
              }));

          const market =
            competitorData.market || {};

          const prompt = `
Kamu adalah YouTube SEO strategist.

Buat paket SEO YouTube berdasarkan data pencarian YouTube nyata.

KEYWORD UTAMA:
${keyword}

BAHASA:
${language}

GAYA KONTEN:
${style}

TARGET AUDIENS:
${audience}

DATA MARKET:
${JSON.stringify(market)}

DATA KOMPETITOR:
${JSON.stringify(competitors)}

TUGAS:

1. Buat TEPAT ${count} judul YouTube.
2. Judul harus menarik tetapi tetap relevan.
3. Jangan clickbait yang menipu.
4. Jangan keyword stuffing.
5. Variasikan struktur judul.
6. Buat satu deskripsi YouTube yang natural.
7. Buat 15-25 tag relevan.
8. Buat 8-12 hashtag relevan.
9. Gunakan bahasa yang diminta.
10. Jangan mengklaim sesuatu yang tidak diketahui.
11. Jangan menyalin judul kompetitor secara persis.

OUTPUT HARUS JSON VALID SAJA.

Format:

{
  "titles": [
    {
      "title": "...",
      "score": 0,
      "reason": "..."
    }
  ],
  "description": "...",
  "tags": ["..."],
  "hashtags": ["..."]
}

Score judul 0-100 berdasarkan relevansi,
daya tarik, kejelasan, potensi CTR, dan naturalness.

Jangan gunakan markdown.
Jangan gunakan code fence.
`;

          const aiResponse =
            await fetch(
              'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=' +
                encodeURIComponent(env.GEMINI_API_KEY),
              {
                method: 'POST',

                headers: {
                  'content-type': 'application/json'
                },

                body: JSON.stringify({
                  contents: [
                    {
                      parts: [
                        {
                          text: prompt
                        }
                      ]
                    }
                  ],

                  generationConfig: {
                    responseMimeType: 'application/json'
                  }
                })
              }
            );

          const aiData =
            await aiResponse.json();

          if (!aiResponse.ok) {
            throw new Error(
              aiData?.error?.message ||
              'Gemini API request gagal.'
            );
          }

          const text =
            aiData?.candidates?.[0]?.content?.parts?.[0]?.text ||
            '';

          if (!text) {
            throw new Error(
              'Gemini tidak menghasilkan respons.'
            );
          }

          let result;

          try {
            result = JSON.parse(text);
          } catch {
            const cleaned =
              text
                .replace(/^```json\s*/i, '')
                .replace(/^```\s*/i, '')
                .replace(/\s*```$/i, '')
                .trim();

            result = JSON.parse(cleaned);
          }

          if (Array.isArray(result.titles)) {
            result.titles = result.titles.slice(0, count);
          }

          return json({
            success: true,

            keyword,

            market: {
              opportunityScore:
                market.opportunityScore ?? 0,

              competitionScore:
                market.competitionScore ?? 0,

              medianViews:
                market.medianViews ?? 0,

              averageSEO:
                market.averageSEO ?? 0,

              averageRelevance:
                market.averageRelevance ?? 0
            },

            competitors,

            titles:
              Array.isArray(result.titles)
                ? result.titles.slice(0, 10)
                : [],

            description:
              result.description || '',

            tags:
              Array.isArray(result.tags)
                ? result.tags.slice(0, 25)
                : [],

            hashtags:
              Array.isArray(result.hashtags)
                ? result.hashtags.slice(0, 12)
                : []
          });

        } catch (error) {

          return json({
            error:
              error?.message ||
              'AI Generator gagal.'
          }, 500);
        }
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


// =====================================================
// SEARCH
// =====================================================

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
        item => item.id?.videoId
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


// =====================================================
// SINGLE VIDEO
// =====================================================

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

        key:
          env.YOUTUBE_API_KEY
      })
    );

  if (
    !details.items ||
    !details.items.length
  ) {
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
      ...analysis
    },

    analysis: {

      seoScore:
        analysis.seoScore,

      seoLabel:
        scoreLabel(
          analysis.seoScore
        ),

      relevance:
        analysis.relevance,

      title:
        analysis.titleScore,

      description:
        analysis.descriptionScore,

      tags:
        analysis.tagsScore,

      engagement:
        analysis.engagement,

      views:
        analysis.views,

      velocity:
        analysis.velocity,

      age:
        analysis.age
    },

    suggestions
  };
}


// =====================================================
// YOUTUBE API REQUEST
// =====================================================

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
      'YouTube API request gagal.'
    );
  }

  return data;
}


// =====================================================
// NORMALIZE
// =====================================================

function normalize(v) {

  const snippet =
    v.snippet || {};

  const statistics =
    v.statistics || {};

  const thumbnails =
    snippet.thumbnails || {};

  const views =
    Number(
      statistics.viewCount || 0
    );

  const likes =
    Number(
      statistics.likeCount || 0
    );

  const comments =
    Number(
      statistics.commentCount || 0
    );

  const publishedAt =
    snippet.publishedAt || '';

  const tags =
    Array.isArray(snippet.tags)
      ? snippet.tags.length
      : 0;

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

    views,

    likes,

    comments,

    tags,

    thumb:
      thumbnails.high?.url ||
      thumbnails.medium?.url ||
      thumbnails.default?.url ||
      '',

    age:
      calculateAge(
        publishedAt
      ),

    velocity:
      calculateVelocity(
        views,
        publishedAt
      )
  };
}


// =====================================================
// VIDEO SEO ANALYSIS
// =====================================================

function analyzeVideo(
  video,
  keyword
) {

  const title =
    String(
      video.title || ''
    ).toLowerCase();

  const description =
    String(
      video.description || ''
    ).toLowerCase();

  const q =
    String(
      keyword || ''
    )
      .trim()
      .toLowerCase();

  const words =
    q
      ? q.split(/\s+/).filter(Boolean)
      : [];

  // TITLE

  let titleScore = 0;

  if (q) {

    if (title.includes(q)) {

      titleScore = 40;

    } else if (words.length) {

      const matched =
        words.filter(
          word =>
            title.includes(word)
        ).length;

      titleScore =
        Math.round(
          matched /
          words.length *
          30
        );
    }

  } else {

    titleScore =
      title.length >= 20 &&
      title.length <= 70
        ? 30
        : 20;
  }


  // DESCRIPTION

  let descriptionScore = 0;

  if (q) {

    if (description.includes(q)) {

      descriptionScore = 20;

    } else if (words.length) {

      const matched =
        words.filter(
          word =>
            description.includes(word)
        ).length;

      descriptionScore =
        Math.round(
          matched /
          words.length *
          15
        );
    }

  } else {

    descriptionScore =
      description.length >= 200
        ? 20
        : description.length >= 80
          ? 14
          : description.length > 0
            ? 8
            : 0;
  }


  // TAGS

  const tagCount =
    Number(
      video.tags || 0
    );

  const tagsScore =
    tagCount > 0
      ? Math.min(
          15,
          5 + tagCount
        )
      : 0;


  // ENGAGEMENT

  const views =
    Number(
      video.views || 0
    );

  const likes =
    Number(
      video.likes || 0
    );

  const comments =
    Number(
      video.comments || 0
    );

  let engagement = 0;

  if (views > 0) {

    const likeRate =
      likes / views;

    const commentRate =
      comments / views;

    if (likeRate >= 0.08) {
      engagement += 5;
    } else if (likeRate >= 0.04) {
      engagement += 4;
    } else if (likeRate >= 0.02) {
      engagement += 3;
    } else if (likeRate > 0) {
      engagement += 1;
    }

    if (commentRate >= 0.01) {
      engagement += 5;
    } else if (commentRate >= 0.005) {
      engagement += 4;
    } else if (commentRate >= 0.001) {
      engagement += 2;
    } else if (comments > 0) {
      engagement += 1;
    }
  }

  engagement =
    Math.min(
      10,
      engagement
    );


  // RELEVANCE

  let relevance = 0;

  if (q) {

    if (title.includes(q)) {

      relevance += 70;

    } else if (words.length) {

      const matched =
        words.filter(
          word =>
            title.includes(word)
        ).length;

      relevance +=
        Math.round(
          matched /
          words.length *
          55
        );
    }

    if (description.includes(q)) {

      relevance += 30;

    } else if (words.length) {

      const matched =
        words.filter(
          word =>
            description.includes(word)
        ).length;

      relevance +=
        Math.round(
          matched /
          words.length *
          20
        );
    }

  } else {

    relevance = 50;
  }

  relevance =
    Math.min(
      100,
      relevance
    );


  // SEO SCORE

  let seoScore =
    titleScore +
    descriptionScore +
    tagsScore +
    engagement +
    Math.round(
      relevance * 0.15
    );

  seoScore =
    Math.min(
      100,
      Math.max(
        0,
        Math.round(
          seoScore
        )
      )
    );

  return {

    seoScore,

    relevance,

    titleScore,

    descriptionScore,

    tagsScore,

    engagement,

    views,

    velocity:
      calculateVelocity(
        views,
        video.publishedAt
      ),

    age:
      calculateAge(
        video.publishedAt
      )
  };
}


// =====================================================
// MARKET
// =====================================================

function analyzeMarket(
  items
) {

  if (!items.length) {
    return emptyMarket();
  }

  const views =
    items
      .map(
        x =>
          Number(
            x.views || 0
          )
      )
      .sort(
        (a, b) => a - b
      );

  const seo =
    items.map(
      x =>
        Number(
          x.seoScore || 0
        )
    );

  const relevance =
    items.map(
      x =>
        Number(
          x.relevance || 0
        )
    );

  const averageViews =
    average(views);

  const medianViews =
    median(views);

  const averageSEO =
    Math.round(
      average(seo)
    );

  const averageRelevance =
    Math.round(
      average(relevance)
    );

  const competitionScore =
    Math.min(
      100,
      Math.round(
        averageSEO * 0.35 +
        averageRelevance * 0.25 +
        normalizeViews(
          averageViews
        ) * 0.40
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
      Math.round(
        averageViews
      ),

    medianViews,

    averageSEO,

    averageRelevance,

    competitionScore,

    level
  };
}


// =====================================================
// KEYWORD OPPORTUNITY
// =====================================================

function calculateKeywordOpportunity(
  market
) {

  const competition =
    Number(
      market.competitionScore || 0
    );

  const relevance =
    Number(
      market.averageRelevance || 0
    );

  const seo =
    Number(
      market.averageSEO || 0
    );

  const score =
    Math.round(
      (100 - competition) * 0.45 +
      relevance * 0.30 +
      (100 - seo) * 0.25
    );

  let label =
    'Rendah';

  if (score >= 75) {
    label = 'Sangat tinggi';
  } else if (score >= 60) {
    label = 'Tinggi';
  } else if (score >= 45) {
    label = 'Sedang';
  }

  let recommendation =
    'Persaingan cukup berat. Cari keyword yang lebih spesifik.';

  if (score >= 75) {

    recommendation =
      'Peluang sangat bagus. Gunakan keyword utama secara natural di judul dan deskripsi.';

  } else if (score >= 60) {

    recommendation =
      'Peluang bagus. Gunakan keyword utama dan variasi keyword terkait.';

  } else if (score >= 45) {

    recommendation =
      'Masih layak dicoba. Gunakan long-tail keyword untuk mengurangi persaingan.';
  }

  return {
    score,
    label,
    recommendation
  };
}


// =====================================================
// VIDEO OPPORTUNITY
// =====================================================

function calculateOpportunity(
  video,
  market
) {

  const seo =
    Number(
      video.seoScore || 0
    );

  const relevance =
    Number(
      video.relevance || 0
    );

  const views =
    Number(
      video.views || 0
    );

  const medianViews =
    Number(
      market.medianViews || 0
    );

  let viewOpportunity = 50;

  if (medianViews > 0) {

    if (views < medianViews * 0.25) {
      viewOpportunity = 90;
    } else if (views < medianViews * 0.5) {
      viewOpportunity = 75;
    } else if (views < medianViews) {
      viewOpportunity = 60;
    } else if (views < medianViews * 2) {
      viewOpportunity = 40;
    } else {
      viewOpportunity = 20;
    }
  }

  const score =
    Math.round(
      seo * 0.35 +
      relevance * 0.25 +
      viewOpportunity * 0.40
    );

  let label =
    'Rendah';

  if (score >= 75) {
    label = 'Peluang tinggi';
  } else if (score >= 60) {
    label = 'Bagus';
  } else if (score >= 45) {
    label = 'Sedang';
  }

  let reason =
    'Perlu optimasi lebih lanjut.';

  if (score >= 75) {

    reason =
      'Relevansi bagus dan performa relatif rendah dibanding video lain di hasil pencarian.';

  } else if (score >= 60) {

    reason =
      'Video memiliki beberapa sinyal SEO yang cukup kuat.';

  } else if (score >= 45) {

    reason =
      'Masih ada ruang untuk meningkatkan optimasi.';
  }

  return {
    score,
    label,
    reason
  };
}


// =====================================================
// SUGGESTIONS
// =====================================================

function generateSuggestions(
  video,
  analysis,
  keyword
) {

  const suggestions = [];

  if (
    keyword &&
    analysis.titleScore < 30
  ) {

    suggestions.push({
      type: 'Judul',
      priority: 'Tinggi',
      text:
        `Masukkan keyword "${keyword}" secara natural di judul, idealnya dekat bagian awal.`
    });
  }

  if (
    video.title.length > 70
  ) {

    suggestions.push({
      type: 'Judul',
      priority: 'Sedang',
      text:
        'Judul cukup panjang. Pertimbangkan membuat judul lebih ringkas dan jelas.'
    });
  }

  if (
    analysis.descriptionScore < 12
  ) {

    suggestions.push({
      type: 'Deskripsi',
      priority: 'Tinggi',
      text:
        'Perkuat deskripsi dengan penjelasan isi video dan keyword yang relevan secara natural.'
    });
  }

  if (
    video.description.length < 200
  ) {

    suggestions.push({
      type: 'Deskripsi',
      priority: 'Sedang',
      text:
        'Deskripsi masih pendek. Tambahkan konteks, informasi penting, chapter atau link relevan.'
    });
  }

  if (
    analysis.tagsScore < 8
  ) {

    suggestions.push({
      type: 'Tags',
      priority: 'Sedang',
      text:
        'Tambahkan beberapa tag yang benar-benar relevan dengan topik video.'
    });
  }

  if (
    analysis.engagement < 5
  ) {

    suggestions.push({
      type: 'Engagement',
      priority: 'Tinggi',
      text:
        'Dorong interaksi penonton dengan pertanyaan atau call-to-action yang relevan.'
    });
  }

  if (
    analysis.relevance < 60
  ) {

    suggestions.push({
      type: 'Relevansi',
      priority: 'Tinggi',
      text:
        'Kesesuaian keyword dengan judul dan deskripsi masih rendah.'
    });
  }

  if (
    analysis.seoScore >= 75 &&
    suggestions.length === 0
  ) {

    suggestions.push({
      type: 'Pertahankan',
      priority: 'Bagus',
      text:
        'Struktur SEO sudah cukup kuat. Fokus berikutnya pada thumbnail, CTR, retensi dan kualitas konten.'
    });
  }

  return suggestions.slice(0, 8);
}


// =====================================================
// AGE
// =====================================================

function calculateAge(
  publishedAt
) {

  if (!publishedAt) {
    return '-';
  }

  const time =
    new Date(
      publishedAt
    ).getTime();

  if (Number.isNaN(time)) {
    return '-';
  }

  const diff =
    Math.max(
      0,
      Date.now() - time
    );

  const minutes =
    Math.floor(
      diff / 60000
    );

  const hours =
    Math.floor(
      minutes / 60
    );

  const days =
    Math.floor(
      hours / 24
    );

  if (days > 0) {
    return `${days} hari`;
  }

  if (hours > 0) {
    return `${hours} jam`;
  }

  if (minutes > 0) {
    return `${minutes} menit`;
  }

  return 'Baru saja';
}


// =====================================================
// VELOCITY
// =====================================================

function calculateVelocity(
  views,
  publishedAt
) {

  if (!publishedAt) {
    return 0;
  }

  const time =
    new Date(
      publishedAt
    ).getTime();

  if (Number.isNaN(time)) {
    return 0;
  }

  const ageDays =
    Math.max(
      1 / 24,
      (
        Date.now() - time
      ) / 86400000
    );

  return Math.round(
    Number(
      views || 0
    ) / ageDays
  );
}


// =====================================================
// HELPERS
// =====================================================

function average(
  values
) {

  if (!values.length) {
    return 0;
  }

  return (
    values.reduce(
      (sum, value) =>
        sum + Number(value || 0),
      0
    ) /
    values.length
  );
}


function median(
  values
) {

  if (!values.length) {
    return 0;
  }

  const arr =
    [...values].sort(
      (a, b) => a - b
    );

  const middle =
    Math.floor(
      arr.length / 2
    );

  if (arr.length % 2) {
    return arr[middle];
  }

  return Math.round(
    (
      arr[middle - 1] +
      arr[middle]
    ) / 2
  );
}


function normalizeViews(
  views
) {

  const n =
    Number(
      views || 0
    );

  if (n <= 0) {
    return 0;
  }

  return Math.min(
    100,
    Math.round(
      Math.log10(
        n + 1
      ) * 10
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


function scoreLabel(
  score
) {

  score =
    Number(
      score || 0
    );

  if (score >= 80) {
    return 'Sangat Bagus';
  }

  if (score >= 65) {
    return 'Bagus';
  }

  if (score >= 50) {
    return 'Sedang';
  }

  if (score >= 35) {
    return 'Perlu diperbaiki';
  }

  return 'Rendah';
}


// =====================================================
// HASH
// =====================================================

async function hashKey(
  value
) {

  const bytes =
    new TextEncoder().encode(
      String(value)
    );

  const digest =
    await crypto.subtle.digest(
      'SHA-256',
      bytes
    );

  return Array.from(
    new Uint8Array(
      digest
    )
  )
    .map(
      byte =>
        byte
          .toString(16)
          .padStart(2, '0')
    )
    .join('')
    .slice(0, 32);
}


// =====================================================
// CACHE REFRESH
// =====================================================

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


// =====================================================
// JSON
// =====================================================

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
