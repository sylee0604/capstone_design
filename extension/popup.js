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
      if (!response.ok || response.error) {
        showError(response.error || '알 수 없는 오류');
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

// --- 이미지 텍스트 추출 ---
$('ocr-btn').addEventListener('click', startOCR);

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'OCR_STATUS') {
    setOCRStatus(msg.text);
  }
  if (msg.type === 'OCR_RESULT') {
    $('ocr-btn').textContent = '드래그로 영역 선택';
    $('ocr-btn').classList.remove('active');
    $('ocr-status').style.display = 'none';
    if (msg.error) {
      setOCRStatus(msg.error);
    } else {
      showOCRResult(msg.original, msg.translated);
    }
  }
});

function startOCR() {
  $('ocr-result').style.display = 'none';
  $('ocr-status').style.display = 'none';
  $('ocr-btn').textContent = '페이지에서 영역을 드래그하세요...';
  $('ocr-btn').classList.add('active');

  chrome.runtime.sendMessage({ type: 'START_DRAG' }, response => {
    if (chrome.runtime.lastError) {
      setOCRStatus('오류: ' + chrome.runtime.lastError.message);
      $('ocr-btn').textContent = '드래그로 영역 선택';
      $('ocr-btn').classList.remove('active');
    }
  });
}

function setOCRStatus(msg) {
  $('ocr-status').style.display = 'flex';
  $('ocr-status-text').textContent = msg;
}

function showOCRResult(original, translated) {
  $('ocr-original-text').innerHTML = mdTableToHtml(escHtml(original));
  $('ocr-translated-text').innerHTML = mdTableToHtml(escHtml(translated));
  $('ocr-result').style.display = 'block';
}

function mdTableToHtml(text) {
  const lines = text.split('\n');
  let html = '';
  let inTable = false;
  let tableRows = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.startsWith('|') && line.endsWith('|')) {
      if (/^\|[\s\-:|]+\|$/.test(line)) continue;
      const cells = line.slice(1, -1).split('|').map(c => c.trim());
      tableRows.push(cells);
      inTable = true;
    } else {
      if (inTable) {
        html += renderTable(tableRows);
        tableRows = [];
        inTable = false;
      }
      if (line) html += line + '<br>';
    }
  }
  if (tableRows.length) html += renderTable(tableRows);
  return html || text;
}

function renderTable(rows) {
  if (rows.length === 0) return '';
  let h = '<table>';
  h += '<tr>' + rows[0].map(c => `<th>${c}</th>`).join('') + '</tr>';
  for (let i = 1; i < rows.length; i++) {
    h += '<tr>' + rows[i].map(c => `<td>${c}</td>`).join('') + '</tr>';
  }
  h += '</table>';
  return h;
}
