const $ = id => document.getElementById(id);

// --- 검색 ---
$('search-btn').addEventListener('click', doSearch);
$('query-input').addEventListener('keydown', e => { if (e.key === 'Enter') doSearch(); });

function doSearch() {
  const query = $('query-input').value.trim();
  if (!query) return;

  setLoading('중국어 번역 중...');

  chrome.runtime.sendMessage(
    { type: 'SEARCH', query },
    response => {
      if (chrome.runtime.lastError) {
        showError('확장프로그램 오류: ' + chrome.runtime.lastError.message);
        return;
      }
      if (!response.ok) {
        showError(response.error || '알 수 없는 오류');
        return;
      }
      if (response.error) {
        showError(response.error);
        return;
      }
      renderResults(response.products, response.chineseQuery, query);
    }
  );
}

// loading 상태일 때 텍스트 순환
let loadingInterval = null;
function setLoading(initialText) {
  hideResults();
  hideError();
  $('status').style.display = 'flex';
  $('status-text').textContent = initialText;

  clearInterval(loadingInterval);
  const steps = [
    '중국어 번역 중...',
    '1688 검색 중...',
    '상품 수집 중...',
    'AI가 분석 중...',
  ];
  let i = 0;
  loadingInterval = setInterval(() => {
    i = (i + 1) % steps.length;
    $('status-text').textContent = steps[i];
  }, 1800);
}

function hideLoading() {
  clearInterval(loadingInterval);
  $('status').style.display = 'none';
}

function showError(msg) {
  hideLoading();
  hideResults();
  $('error').textContent = msg;
  $('error').style.display = 'block';
}

function hideError() {
  $('error').style.display = 'none';
}

function hideResults() {
  $('results').style.display = 'none';
  $('results-header').style.display = 'none';
}

function renderResults(products, chineseQuery, koreanQuery) {
  hideLoading();
  hideError();

  const header = $('results-header');
  header.textContent = `"${koreanQuery}" → 검색어: ${chineseQuery} | 베스트 ${products.length}개`;
  header.style.display = 'block';

  const container = $('results');
  container.innerHTML = '';

  const ranks = ['1위', '2위', '3위', '4위', '5위'];
  products.forEach((p, i) => {
    const card = document.createElement('div');
    card.className = 'card';

    const imgHtml = p.image
      ? `<img class="card-img" src="${escHtml(p.image)}" alt="" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'" /><div class="card-img-placeholder" style="display:none">&#128722;</div>`
      : `<div class="card-img-placeholder">&#128722;</div>`;

    const priceYuan = p.price ? parseFloat(p.price).toFixed(2) : '';
    const priceHtml = priceYuan
      ? `<div class="card-price">${p.priceKrw ? `${escHtml(p.priceKrw)}원` : ''}<span> (${escHtml(priceYuan)}위안)</span></div>`
      : '';
    const ratingHtml = p.rating ? `⭐ ${escHtml(p.rating)}` : '';
    const reviewsHtml = p.reviews ? `💬 ${escHtml(p.reviews)}` : '';
    const salesHtml = p.sales ? `🛒 ${escHtml(p.sales)}` : '';
    const metaHtml = [ratingHtml, reviewsHtml, salesHtml].filter(Boolean).join(' &nbsp;');
    const metaLine = metaHtml ? `<div class="card-meta">${metaHtml}</div>` : '';

    card.innerHTML = `
      <div class="card-inner">
        ${imgHtml}
        <div class="card-body">
          <div class="card-rank">${ranks[i] || (i + 1) + '위'}</div>
          <div class="card-title">${escHtml(p.title)}</div>
          ${priceHtml}
          ${metaLine}
        </div>
      </div>
      ${p.reason ? `<div class="card-reason">AI 추천 이유: ${escHtml(p.reason)}</div>` : ''}
      ${p.url ? `<a class="card-link" href="${escHtml(p.url)}" target="_blank">1688에서 보기</a>` : ''}
    `;
    container.appendChild(card);
  });

  container.style.display = 'flex';
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
