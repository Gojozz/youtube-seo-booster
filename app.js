const $ = s => document.querySelector(s);

const keyword = $('#keyword');
const region = $('#region');
const searchBtn = $('#search');
const clearBtn = $('#clear');
const errorBox = $('#error');
const empty = $('#empty');
const results = $('#results');
const videos = $('#videos');

searchBtn.addEventListener('click', search);

keyword.addEventListener('keydown', e => {
  if (e.key === 'Enter') search();
});

clearBtn.addEventListener('click', () => {
  keyword.value = '';
  keyword.focus();
  hideError();
});

async function search(){

  const q = keyword.value.trim();

  if(!q){
    showError('Masukkan keyword terlebih dahulu.');
    keyword.focus();
    return;
  }

  if(q.length > 200){
    showError('Keyword terlalu panjang.');
    return;
  }

  loading(true);
  hideError();

  try{

    const url =
      `/api/search?q=${encodeURIComponent(q)}&region=${encodeURIComponent(region.value)}`;

    const response = await fetch(url);

    const data = await response.json();

    if(!response.ok){
      throw new Error(
        data?.error ||
        'Gagal melakukan analisis.'
      );
    }

    render(data);

  }catch(e){

    showError(
      e?.message ||
      'Terjadi kesalahan.'
    );

  }finally{

    loading(false);
  }
}

function render(data){

  empty.classList.add('hidden');
  results.classList.remove('hidden');

  const market = data.market || {};

  $('#resultKeyword').textContent =
    data.keyword || '-';

  $('#resultMeta').textContent =
    `${data.totalResults || 0} video dianalisis • ${formatDate(data.analyzedAt)}`;

  $('#cache').textContent =
    data.cache === 'HIT'
      ? 'CACHE'
      : data.cache === 'STALE'
        ? 'STALE'
        : 'LIVE';

  $('#opportunity').textContent =
    market.opportunityScore || 0;

  $('#opportunityLabel').textContent =
    opportunityLabel(
      market.opportunityScore
    );

  $('#competition').textContent =
    market.competitionScore || 0;

  $('#competitionLabel').textContent =
    market.level || '-';

  $('#relevance').textContent =
    market.averageRelevance || 0;

  $('#averageViews').textContent =
    formatNumber(
      market.averageViews || 0
    );

  $('#marketLevel').textContent =
    market.level || '-';

  $('#medianViews').textContent =
    formatNumber(
      market.medianViews || 0
    );

  $('#averageSEO').textContent =
    `${market.averageSEO || 0}/100`;

  $('#averageRelevance').textContent =
    `${market.averageRelevance || 0}/100`;

  $('#totalResults').textContent =
    data.totalResults || 0;

  $('#videoCount').textContent =
    `${data.items?.length || 0} video`;

  renderVideos(
    data.items || []
  );

  results.scrollIntoView({
    behavior:'smooth',
    block:'start'
  });
}

function renderVideos(items){

  videos.innerHTML = '';

  if(!items.length){

    videos.innerHTML = `
      <div class="empty">
        <div class="emptyicon">!</div>
        <h3>Tidak ada video ditemukan</h3>
        <p>Coba keyword lain.</p>
      </div>
    `;

    return;
  }

  items.forEach((video,index) => {

    const el =
      document.createElement('article');

    el.className = 'video';

    const title =
      escape(video.title || 'Tanpa judul');

    const channel =
      escape(
        video.channelTitle ||
        'Channel tidak diketahui'
      );

    const thumb =
      escapeAttr(video.thumb || '');

    const id =
      encodeURIComponent(
        video.id || ''
      );

    const score =
      Number(
        video.opportunityScore || 0
      );

    el.innerHTML = `

      <div class="thumb">

        <img
          src="${thumb}"
          alt="${escapeAttr(title)}"
          loading="lazy"
          onerror="this.style.display='none'"
        >

        <div class="rank">
          #${index + 1}
        </div>

      </div>

      <div>

        <div class="vtitle">
          ${title}
        </div>

        <div class="channel">
          ${channel}
        </div>

        <div class="meta">

          <span class="pill">
            👁 ${formatNumber(video.views)}
          </span>

          <span class="pill">
            👍 ${formatNumber(video.likes)}
          </span>

          <span class="pill">
            💬 ${formatNumber(video.comments)}
          </span>

          <span class="pill">
            🕒 ${escape(video.age || '-')}
          </span>

        </div>

      </div>

      <div class="analysis">

        <div>

          <div class="oscore">
            ${score}<small>/100</small>
          </div>

          <div class="badge">
            ${escape(
              video.opportunityLabel ||
              opportunityLabel(score)
            )}
          </div>

        </div>

        <div class="metrics">

          <div class="metric">
            <span>SEO</span>
            <b>${video.seoScore || 0}</b>
          </div>

          <div class="metric">
            <span>RELEVANSI</span>
            <b>${video.relevanceScore || 0}</b>
          </div>

          <div class="metric">
            <span>ENGAGE</span>
            <b>${video.engagementScore || 0}</b>
          </div>

          <div class="metric">
            <span>FRESH</span>
            <b>${video.freshnessScore || 0}</b>
          </div>

          <div class="metric">
            <span>COMPETISI</span>
            <b>${video.competitionScore || 0}</b>
          </div>

        </div>

        <a
          class="yt"
          href="https://www.youtube.com/watch?v=${id}"
          target="_blank"
          rel="noopener noreferrer"
        >
          Buka YouTube ↗
        </a>

      </div>
    `;

    videos.appendChild(el);
  });
}

function loading(state){

  searchBtn.disabled = state;

  if(state){

    searchBtn.classList.add('loading');

    $('#searchText').textContent =
      'Menganalisis...';

  }else{

    searchBtn.classList.remove('loading');

    $('#searchText').textContent =
      'Analisis Keyword';
  }
}

function showError(message){

  errorBox.textContent = message;

  errorBox.classList.remove('hidden');
}

function hideError(){

  errorBox.classList.add('hidden');

  errorBox.textContent = '';
}

function formatNumber(value){

  const n = Number(value || 0);

  if(n >= 1000000000)
    return (n/1000000000)
      .toFixed(1)
      .replace('.0','') + 'B';

  if(n >= 1000000)
    return (n/1000000)
      .toFixed(1)
      .replace('.0','') + 'M';

  if(n >= 1000)
    return (n/1000)
      .toFixed(1)
      .replace('.0','') + 'K';

  return n.toLocaleString('id-ID');
}

function formatDate(date){

  if(!date) return '-';

  try{

    return new Date(date)
      .toLocaleString(
        'id-ID',
        {
          dateStyle:'short',
          timeStyle:'short'
        }
      );

  }catch{

    return '-';
  }
}

function opportunityLabel(score){

  score = Number(score || 0);

  if(score >= 85) return 'Sangat Bagus';
  if(score >= 70) return 'Bagus';
  if(score >= 50) return 'Sedang';
  if(score >= 30) return 'Rendah';

  return 'Sangat Rendah';
}

function escape(value){

  return String(value)
    .replace(/&/g,'&amp;')
    .replace(/</g,'&lt;')
    .replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;')
    .replace(/'/g,'&#039;');
}

function escapeAttr(value){

  return escape(value);
}
