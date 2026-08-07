const $ = id =>
  document.getElementById(id);


function show(el) {
  el.classList.remove('hidden');
}


function hide(el) {
  el.classList.add('hidden');
}


function formatNumber(value) {

  const n =
    Number(value || 0);

  if (n >= 1000000000) {
    return (
      (n / 1000000000)
        .toFixed(1)
        .replace('.0', '') +
      'B'
    );
  }

  if (n >= 1000000) {
    return (
      (n / 1000000)
        .toFixed(1)
        .replace('.0', '') +
      'M'
    );
  }

  if (n >= 1000) {
    return (
      (n / 1000)
        .toFixed(1)
        .replace('.0', '') +
      'K'
    );
  }

  return n.toLocaleString('id-ID');
}


function scoreText(score) {

  score =
    Number(score || 0);

  if (score >= 80) return 'Sangat Bagus';
  if (score >= 65) return 'Bagus';
  if (score >= 50) return 'Sedang';
  if (score >= 35) return 'Perlu diperbaiki';

  return 'Rendah';
}


function escapeHtml(value) {

  return String(value || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}


// ========================================================
// KEYWORD SEARCH
// ========================================================

$('searchBtn').addEventListener(
  'click',
  analyzeKeyword
);


$('keyword').addEventListener(
  'keydown',
  e => {

    if (e.key === 'Enter') {
      analyzeKeyword();
    }

  }
);


async function analyzeKeyword() {

  const keyword =
    $('keyword')
      .value
      .trim();

  const region =
    $('region').value;

  if (!keyword) {

    showError(
      $('searchError'),
      'Masukkan keyword terlebih dahulu.'
    );

    return;
  }

  hide($('searchError'));
  show($('searchLoading'));
  hide($('keywordResult'));

  $('searchBtn').disabled = true;

  try {

    const response =
      await fetch(
        `/api/search?q=${encodeURIComponent(
          keyword
        )}&region=${encodeURIComponent(
          region
        )}`
      );

    const data =
      await response.json();

    if (!response.ok) {
      throw new Error(
        data.error ||
        'Analisis gagal.'
      );
    }

    renderKeyword(
      data
    );

  } catch (error) {

    showError(
      $('searchError'),
      error.message
    );

  } finally {

    hide($('searchLoading'));
    $('searchBtn').disabled = false;
  }
}


function renderKeyword(data) {
  const market = data.market || {};

  const setText = (id, value) => {
    const el = $(id);
    if (el) el.textContent = value;
  };

  setText(
    'opportunityScore',
    `${market.opportunityScore ?? 0}/100`
  );

  setText(
    'opportunityLabel',
    market.opportunityLabel ||
      scoreText(market.opportunityScore)
  );

  setText(
    'competitionScore',
    `${market.competitionScore ?? 0}/100`
  );

  setText(
    'competitionLabel',
    market.level || '-'
  );

  setText(
    'relevanceScore',
    `${market.averageRelevance ?? 0}/100`
  );

  setText(
    'medianViews',
    formatNumber(market.medianViews)
  );

  setText(
    'marketMedian',
    formatNumber(market.medianViews)
  );

  setText(
    'marketSEO',
    `${market.averageSEO ?? 0}/100`
  );

  setText(
    'marketRelevance',
    `${market.averageRelevance ?? 0}/100`
  );

  setText(
    'videoCount',
    data.totalResults || 0
  );

  setText(
    'keywordRecommendation',
    market.recommendation ||
      'Belum ada rekomendasi.'
  );

  renderCompetitors(data.items || []);

  show($('keywordResult'));
}

function renderCompetitors(items) {

  const container =
    $('competitorList');

  if (!items.length) {

    container.innerHTML =
      '<div class="empty">Tidak ada video ditemukan.</div>';

    return;
  }

  container.innerHTML =
    items.map(
      (video, index) => {

        return `
          <div class="competitor">

            <div class="rank">
              #${index + 1}
            </div>

            <img
              src="${escapeHtml(video.thumb)}"
              alt=""
            >

            <div class="competitor-body">

              <h3>
                ${escapeHtml(video.title)}
              </h3>

              <p>
                ${escapeHtml(video.channelTitle)}
              </p>

              <div class="stats">

                <span>
                  👁 ${formatNumber(video.views)}
                </span>

                <span>
                  ❤️ ${formatNumber(video.likes)}
                </span>

                <span>
                  💬 ${formatNumber(video.comments)}
                </span>

                <span>
                  🕐 ${escapeHtml(video.age)}
                </span>

              </div>

            </div>

            <div class="competitor-score">

              <b>
                ${video.opportunityScore ?? 0}
              </b>

              <span>
                ${escapeHtml(
                  video.opportunityLabel || '-'
                )}
              </span>

            </div>

          </div>
        `;
      }
    )
    .join('');
}


// ========================================================
// VIDEO URL
// ========================================================

$('videoBtn').addEventListener(
  'click',
  analyzeVideo
);


$('videoUrl').addEventListener(
  'keydown',
  e => {

    if (e.key === 'Enter') {
      analyzeVideo();
    }

  }
);


function extractVideoId(url) {

  try {

    const value =
      url.trim();

    if (
      /^[A-Za-z0-9_-]{6,20}$/.test(
        value
      )
    ) {
      return value;
    }

    const parsed =
      new URL(value);

    if (
      parsed.hostname
        .replace('www.', '')
        === 'youtu.be'
    ) {

      return parsed.pathname
        .replace('/', '')
        .split('/')[0];

    }

    if (
      parsed.hostname
        .replace('www.', '')
        .endsWith('youtube.com')
    ) {

      const id =
        parsed.searchParams.get(
          'v'
        );

      if (id) {
        return id;
      }

      const parts =
        parsed.pathname
          .split('/')
          .filter(Boolean);

      const index =
        parts.indexOf('shorts');

      if (
        index >= 0 &&
        parts[index + 1]
      ) {
        return parts[index + 1];
      }

      const embed =
        parts.indexOf('embed');

      if (
        embed >= 0 &&
        parts[embed + 1]
      ) {
        return parts[embed + 1];
      }
    }

  } catch {}

  return null;
}


async function analyzeVideo() {

  const url =
    $('videoUrl')
      .value
      .trim();

  const keyword =
    $('videoKeyword')
      .value
      .trim();

  const id =
    extractVideoId(url);

  if (!id) {

    showError(
      $('videoError'),
      'Link YouTube tidak valid.'
    );

    return;
  }

  hide($('videoError'));
  show($('videoLoading'));
  hide($('videoResult'));

  $('videoBtn').disabled = true;

  try {

    const endpoint =
      `/api/video?id=${encodeURIComponent(
        id
      )}&keyword=${encodeURIComponent(
        keyword
      )}`;

    const response =
      await fetch(
        endpoint
      );

    const data =
      await response.json();

    if (!response.ok) {
      throw new Error(
        data.error ||
        'Analisis video gagal.'
      );
    }

    renderVideo(
      data
    );

  } catch (error) {

    showError(
      $('videoError'),
      error.message
    );

  } finally {

    hide($('videoLoading'));
    $('videoBtn').disabled = false;
  }
}


function renderVideo(data) {
  const item = data.item || {};
  const analysis = data.analysis || {};

  const setText = (id, value) => {
    const el = $(id);
    if (el) el.textContent = value;
  };

  const thumb = $('videoThumb');
  if (thumb) {
    thumb.src = item.thumb || '';
  }

  setText('videoTitle', item.title || '-');
  setText('videoChannel', item.channelTitle || '-');

  setText(
    'videoSeoScore',
    `${analysis.seoScore ?? 0}/100`
  );

  const seoLabel =
    analysis.seoLabel ||
    scoreText(analysis.seoScore);

  setText('videoSeoText', seoLabel);
  setText('videoSeoLabel', seoLabel);

  setText(
    'videoRelevance',
    `${analysis.relevance ?? 0}`
  );

  setText(
    'videoTitleScore',
    `${analysis.title ?? 0}`
  );

  setText(
    'videoDescriptionScore',
    `${analysis.description ?? 0}`
  );

  setText(
    'videoTagsScore',
    `${analysis.tags ?? 0}`
  );

  setText(
    'videoEngagement',
    `${analysis.engagement ?? 0}`
  );

  setText(
    'videoViews',
    formatNumber(analysis.views)
  );

  setText(
    'videoVelocity',
    formatNumber(analysis.velocity)
  );

  setText(
    'videoAge',
    analysis.age || item.age || '-'
  );

  setText(
    'videoPublished',
    item.publishedAt
      ? new Date(item.publishedAt).toLocaleString('id-ID')
      : '-'
  );

  setText(
    'videoLikes',
    formatNumber(item.likes)
  );

  setText(
    'videoComments',
    formatNumber(item.comments)
  );

  renderSuggestions(
    data.suggestions || []
  );

  show($('videoResult'));
}

function renderSuggestions(
  suggestions
) {

  const container =
    $('suggestionList');

  if (!suggestions.length) {

    container.innerHTML =
      '<div class="empty">Tidak ada saran.</div>';

    return;
  }

  container.innerHTML =
    suggestions.map(
      item => {

        return `
          <div class="suggestion ${escapeHtml(
            item.type
          )}">

            <div class="suggestion-icon">
              ${
                item.type === 'success'
                  ? '✓'
                  : item.type === 'error'
                    ? '!'
                    : '•'
              }
            </div>

            <div>

              <strong>
                ${escapeHtml(
                  item.title
                )}
              </strong>

              <p>
                ${escapeHtml(
                  item.text
                )}
              </p>

            </div>

          </div>
        `;
      }
    )
    .join('');
}


// ========================================================
// ERROR
// ========================================================

function showError(
  element,
  message
) {

  if (marketMedian) {
  }
}
