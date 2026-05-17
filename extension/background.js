const GPU_SERVER_URL = 'https://anymore-marina-wherever-closing.trycloudflare.com';

// 아이콘 클릭 시 사이드패널 열기
chrome.action.onClicked.addListener(tab => {
  chrome.sidePanel.open({ windowId: tab.windowId });
});

let cnyToKrwRate = null;
let rateLastFetched = 0;

async function getCnyToKrw() {
  const now = Date.now();
  if (cnyToKrwRate && now - rateLastFetched < 3600000) return cnyToKrwRate;
  try {
    const res = await fetch('https://open.er-api.com/v6/latest/CNY');
    const data = await res.json();
    cnyToKrwRate = data.rates.KRW;
    rateLastFetched = now;
  } catch(e) {
    cnyToKrwRate = cnyToKrwRate || 190; // 실패 시 고정값 fallback
  }
  return cnyToKrwRate;
}

async function googleTranslate(text, from, to) {
  const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${from}&tl=${to}&dt=t&q=${encodeURIComponent(text)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`번역 오류 ${res.status}`);
  const data = await res.json();
  return data[0].map(seg => seg[0]).join('');
}

async function translateToChineseKeywords(koreanQuery) {
  const result = await googleTranslate(koreanQuery, 'ko', 'zh-CN');
  return result.replace(/\s+/g, '');
}

// executeScript에 주입되는 async 함수 — 외부 변수 참조 불가
async function scrapeProducts() {
  function parseCount(str) {
    if (!str) return 0;
    const s = String(str);
    if (s.includes('万') || s.includes('w')) return parseFloat(s) * 10000;
    return parseFloat(s.replace(/[^\d.]/g, '')) || 0;
  }

  // 카드 요소 탐색
  function findCards() {
    const candidates = [
      '.search-offer-item',
      '.search-offer-wrapper',
      '[class*="search-offer"]',
      '[class*="offer-item"]',
      'div[data-offer-id]',
      '[class*="offerItem"]',
    ];
    for (const sel of candidates) {
      const els = Array.from(document.querySelectorAll(sel));
      if (els.length >= 3) return els;
    }
    // fallback: offerId 링크를 기준으로 가장 가까운 카드 컨테이너 탐색
    const offerLinks = Array.from(document.querySelectorAll('a[href*="offerId"]'));
    const cardSet = new Set();
    for (const link of offerLinks) {
      let el = link.parentElement;
      for (let depth = 0; el && depth < 5; depth++, el = el.parentElement) {
        if (el.querySelector('img') && (el.innerText || '').length > 10) {
          cardSet.add(el);
          break;
        }
      }
    }
    if (cardSet.size >= 3) return Array.from(cardSet);
    return [];
  }

  const cards = findCards();

  const products = [];
  for (const card of cards) {
    const titleEl = card.querySelector('[class*="title"],[class*="subject"],h2,h3');
    const priceEl = card.querySelector('[class*="price"],em');
    const imgEl = card.querySelector('img');
    const linkEl = card.querySelector('a[href*="offerId"]') ||
      card.querySelector('a[href*="detail.1688"]') ||
      card.querySelector('a[href*="1688.com"]');
    const salesEl = card.querySelector('[class*="trade"],[class*="sale"],[class*="成交"],[class*="sold"]');

    let img = imgEl ? (imgEl.src || imgEl.getAttribute('data-src') || '') : '';
    if (img.startsWith('//')) img = 'https:' + img;

    const salesText = salesEl ? salesEl.innerText.trim() : '';
    const salesNum = parseCount(salesText);

    // 구매횟수가 표시되어 있는데 10 미만이면 제외
    if (salesText && salesNum < 10) continue;

    // stat-label/stat-value 쌍에서 점수 읽기
    let serviceScore = 0, qualityScore = 0;
    const statLabels = Array.from(card.querySelectorAll('.stat-label'));
    const svcScores = [];
    const seen = new Set();
    for (const label of statLabels) {
      const text = (label.innerText || label.textContent || '').trim();
      const valueEl = label.parentElement?.querySelector('.stat-value') || label.nextElementSibling;
      const val = parseFloat(valueEl?.innerText || valueEl?.textContent || '') || 0;
      const key = text + val;
      if (seen.has(key)) continue;
      seen.add(key);
      if (text.includes('品质体验')) qualityScore = val;
      else if (val > 0) svcScores.push(val);
    }
    if (svcScores.length > 0) {
      serviceScore = svcScores.reduce((a, b) => a + b, 0) / svcScores.length;
      serviceScore = Math.round(serviceScore * 100) / 100;
    }

    // ID 추출: offerId 쿼리 파라미터 우선
    let pid = '';
    if (linkEl) {
      try {
        const params = new URLSearchParams(linkEl.href.split('?')[1] || '');
        pid = params.get('offerId') || params.get('offerIds') || '';
      } catch(e) {}
    }
    if (!pid) pid = (linkEl?.href.match(/\/offer\/(\d+)/) || [])[1] || '';
    if (!pid) pid = card.getAttribute('data-offer-id') || '';

    products.push({
      id: pid,
      title: titleEl ? titleEl.innerText.trim().slice(0, 150) : '',
      price: priceEl ? (() => {
        const txt = priceEl.innerText;
        // ¥ 뒤의 숫자 우선
        const yuanMatch = txt.match(/[¥￥]\s*(\d+(?:\.\d{1,2})?)/);
        if (yuanMatch) return yuanMatch[1];
        // 없으면 첫 번째 가격형 숫자 (소수점 이하 최대 2자리)
        const numMatch = txt.match(/(\d+(?:\.\d{1,2})?)/);
        return numMatch ? numMatch[1] : '';
      })() : '',
      image: img,
      sales: salesText,
      salesNum,
      serviceScore,
      qualityScore,
      url: pid ? `https://detail.1688.com/offer/${pid}.html` : (linkEl?.href || ''),
    });
  }

  return products.filter(p => p.title);
}

async function waitForTabLoad(tabId, maxWait = 15000) {
  const start = Date.now();
  await new Promise(r => setTimeout(r, 300));
  while (Date.now() - start < maxWait) {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab.status === 'complete') return;
    } catch (e) { return; }
    await new Promise(r => setTimeout(r, 400));
  }
}

async function waitForCards(tabId, maxWait = 10000) {
  const start = Date.now();
  while (Date.now() - start < maxWait) {
    const res = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const selectors = ['.search-offer-item', '[class*="search-offer"]', '[class*="offer-item"]', 'a[href*="offerId"]'];
        return Math.max(...selectors.map(s => document.querySelectorAll(s).length));
      },
    });
    if ((res[0]?.result || 0) >= 3) {
      await new Promise(r => setTimeout(r, 500));
      return;
    }
    await new Promise(r => setTimeout(r, 400));
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'SEARCH') {
    handleSearch(message.query)
      .then(result => sendResponse({ ok: true, ...result }))
      .catch(err => sendResponse({ ok: false, error: err.message }));
    return true;
  }
  if (message.type === 'START_DRAG') {
    handleStartDrag();
    sendResponse({ ok: true });
    return false;
  }
  if (message.type === 'DRAG_DONE') {
    handleDragDone(message.rect);
    return false;
  }
});

async function handleSearch(koreanQuery) {
  // 1. 한국어 → 중국어 번역
  const chineseQuery = await translateToChineseKeywords(koreanQuery);
  console.log('[chineseQuery]', chineseQuery);

  // 2. 1688 탭 확보
  const tabs1688 = await chrome.tabs.query({ url: '*://*.1688.com/*' });
  let tabId;
  if (tabs1688.length > 0) {
    tabId = tabs1688[0].id;
    await chrome.tabs.update(tabId, { active: true });
  } else {
    const newTab = await chrome.tabs.create({ url: 'https://www.1688.com', active: true });
    await waitForTabLoad(newTab.id);
    await new Promise(r => setTimeout(r, 1000));
    tabId = newTab.id;
  }

  // 3. GBK form 제출 — 브라우저가 GBK로 인코딩해서 1688에 전달
  await chrome.scripting.executeScript({
    target: { tabId },
    func: (query) => {
      const form = document.createElement('form');
      form.method = 'GET';
      form.action = 'https://s.1688.com/selloffer/offer_search.htm';
      form.acceptCharset = 'GBK';
      const params = { keywords: query, sortType: 'sa_trd30cnt_des', n: 'y', page: '1' };
      for (const [name, value] of Object.entries(params)) {
        const inp = document.createElement('input');
        inp.type = 'hidden';
        inp.name = name;
        inp.value = value;
        form.appendChild(inp);
      }
      document.body.appendChild(form);
      form.submit();
    },
    args: [chineseQuery],
  });

  // 4. 검색 결과 로드 + 카드 렌더링 대기 + 스크롤로 전체 로드
  await waitForTabLoad(tabId);
  await waitForCards(tabId);

  // 페이지 끝까지 스크롤하여 lazy-load 상품 모두 로드
  await chrome.scripting.executeScript({
    target: { tabId },
    func: async () => {
      const delay = ms => new Promise(r => setTimeout(r, ms));
      let prev = -1;
      for (let i = 0; i < 20; i++) {
        window.scrollBy(0, 800);
        await delay(300);
        if (document.documentElement.scrollHeight === prev) break;
        prev = document.documentElement.scrollHeight;
      }
      window.scrollTo(0, 0);
    },
  });
  await new Promise(r => setTimeout(r, 500));

  const pageInfo = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => ({ url: location.href, title: document.title, bodyLen: document.body?.innerHTML?.length }),
  });
  console.log('[page after search]', pageInfo[0]?.result);

  // 5. 검색 결과 스크래핑
  const injected = await chrome.scripting.executeScript({
    target: { tabId },
    func: scrapeProducts,
  });

  const products = injected[0]?.result || [];
  console.log('[products count]', products.length);
  console.log('[products sample]', products.slice(0, 3).map(p => ({ title: p.title?.slice(0, 20), price: p.price, sales: p.sales, salesNum: p.salesNum })));

  if (products.length === 0) {
    return { chineseQuery, products: [], error: '1688 상품을 찾지 못했습니다. 1688에 로그인되어 있는지 확인하세요.' };
  }

  // 6. 점수 합산 후 정렬 → 상위 5개
  console.log('[products with scores]', products.slice(0, 5).map(p => ({ title: p.title?.slice(0, 20), svc: p.serviceScore, qty: p.qualityScore, sales: p.salesNum })));
  function parseNum(str) {
    if (!str) return 0;
    const s = String(str).replace(/,/g, '');
    if (s.includes('万') || s.includes('w') || s.includes('W')) return parseFloat(s) * 10000;
    return parseFloat(s.replace(/[^\d.]/g, '')) || 0;
  }

  // 복합 점수: 판매량(0.2) + 품질(0.3) + 서비스(0.3) + 가격 적정성(0.2)
  const maxSales = Math.max(...products.map(p => p.salesNum), 1);
  const maxQuality = Math.max(...products.map(p => p.qualityScore), 1);
  const maxService = Math.max(...products.map(p => p.serviceScore), 1);
  const prices = products.map(p => parseFloat(p.price) || 0).filter(v => v > 0).sort((a, b) => b - a);
  // 최대가 아닌 2번째 높은 가격 기준 (최대가 이상치일 수 있으므로)
  const refPrice = prices.length >= 2 ? prices[1] : (prices[0] || 1);

  function compositeScore(p) {
    const salesNorm = p.salesNum / maxSales;
    const qualityNorm = p.qualityScore / maxQuality;
    const serviceNorm = p.serviceScore / maxService;
    // 가격이 낮을수록 높은 점수 (2번째 높은 가격 기준 정규화)
    const price = parseFloat(p.price) || 0;
    const priceNorm = price > 0 ? Math.max(1 - price / refPrice, 0) : 0;
    return salesNorm * 0.2 + qualityNorm * 0.3 + serviceNorm * 0.3 + priceNorm * 0.2;
  }

  const ranked = [...products]
    .sort((a, b) => compositeScore(b) - compositeScore(a))
    .slice(0, 5)
    .map(p => ({
      ...p,
      rating: p.serviceScore ? `서비스 ${p.serviceScore}` : '',
      reviews: p.qualityScore ? `품질 ${p.qualityScore}` : '',
    }));

  // 7. 환율 조회 + 상품명 번역 (병렬)
  const [rate] = await Promise.all([
    getCnyToKrw(),
    ...ranked.map(async (p, i) => {
      try {
        ranked[i].title = await googleTranslate(p.title, 'zh-CN', 'ko');
      } catch(e) {
        console.log('[title translation error]', String(e));
      }
    })
  ]);

  ranked.forEach(p => {
    const won = p.price ? Math.round(parseFloat(p.price) * rate) : null;
    p.priceKrw = won ? won.toLocaleString('ko-KR') : '';
  });

  return { chineseQuery, products: ranked };
}

// === 이미지 텍스트 추출 (드래그 + OCR) ===

async function handleStartDrag() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) {
      notifyPopup({ type: 'OCR_RESULT', error: '활성 탭을 찾을 수 없습니다' });
      return;
    }
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: injectDragOverlay,
    });
  } catch (e) {
    notifyPopup({ type: 'OCR_RESULT', error: e.message });
  }
}

async function handleDragDone(rect) {
  try {
    if (!rect || rect.width < 10 || rect.height < 10) {
      notifyPopup({ type: 'OCR_RESULT', error: '선택이 취소되었거나 영역이 너무 작습니다' });
      return;
    }

    notifyPopup({ type: 'OCR_STATUS', text: '화면 캡처 중...' });

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
    const croppedData = await cropImage(dataUrl, rect, tab.id);

    notifyPopup({ type: 'OCR_STATUS', text: 'AI가 텍스트 추출 + 번역 중...' });

    const result = await handleOCRTranslate(croppedData);
    notifyPopup({ type: 'OCR_RESULT', ...result });
  } catch (e) {
    notifyPopup({ type: 'OCR_RESULT', error: e.message });
  }
}

function notifyPopup(msg) {
  chrome.runtime.sendMessage(msg).catch(() => {});
}

async function cropImage(dataUrl, rect, tabId) {
  const result = await chrome.scripting.executeScript({
    target: { tabId },
    func: (imgDataUrl, r) => {
      return new Promise(resolve => {
        const img = new Image();
        img.onload = () => {
          const dpr = window.devicePixelRatio || 1;
          const canvas = document.createElement('canvas');
          canvas.width = r.width * dpr;
          canvas.height = r.height * dpr;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img,
            r.x * dpr, r.y * dpr, r.width * dpr, r.height * dpr,
            0, 0, r.width * dpr, r.height * dpr
          );
          resolve(canvas.toDataURL('image/png'));
        };
        img.src = imgDataUrl;
      });
    },
    args: [dataUrl, rect],
  });
  return result[0]?.result;
}

async function handleOCRTranslate(imageDataUrl) {
  const base64 = imageDataUrl.replace(/^data:image\/\w+;base64,/, '');

  const response = await fetch(`${GPU_SERVER_URL}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'Qwen/Qwen2.5-VL-7B-Instruct',
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image_url',
              image_url: { url: `data:image/png;base64,${base64}` }
            },
            {
              type: 'text',
              text: `이 이미지에서 텍스트를 추출하고 한국어로 번역해주세요.

규칙:
- 이미지에 표(테이블)가 있으면 반드시 마크다운 표 형식(| 열1 | 열2 | 로 구분)으로 출력하세요.
- 표가 아닌 일반 텍스트는 그냥 텍스트로 출력하세요.
- 숫자, 단위(cm, kg 등)는 번역하지 말고 그대로 유지하세요.

다음 형식으로 응답:
[원문]
(추출한 중국어 텍스트 또는 마크다운 표)

[번역]
(한국어 번역 텍스트 또는 마크다운 표)`
            }
          ]
        }
      ],
      max_tokens: 1024,
      temperature: 0.1
    })
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`GPU 서버 오류: ${response.status} ${errText.slice(0, 100)}`);
  }

  const data = await response.json();
  const content = data.choices?.[0]?.message?.content || '';

  let original = '', translated = '';
  const origMatch = content.match(/\[원문\]\s*([\s\S]*?)\s*\[번역\]/);
  const transMatch = content.match(/\[번역\]\s*([\s\S]*)/);

  if (origMatch) original = origMatch[1].trim();
  if (transMatch) translated = transMatch[1].trim();

  if (!original && !translated) {
    original = content;
    translated = '(파싱 실패 - 위 원문 참조)';
  }

  return { original, translated };
}

function injectDragOverlay() {
  const existing = document.getElementById('__ocr_overlay__');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.id = '__ocr_overlay__';
  overlay.style.cssText = 'position:fixed;top:0;left:0;width:100vw;height:100vh;z-index:2147483647;cursor:crosshair;background:rgba(0,0,0,0.1);';

  const box = document.createElement('div');
  box.style.cssText = 'position:absolute;border:2px dashed #e8392a;background:rgba(232,57,42,0.1);display:none;';
  overlay.appendChild(box);

  const label = document.createElement('div');
  label.style.cssText = 'position:fixed;top:10px;left:50%;transform:translateX(-50%);background:#e8392a;color:white;padding:8px 16px;border-radius:20px;font:600 14px sans-serif;z-index:2147483647;';
  label.textContent = '번역할 영역을 드래그하세요 (ESC 취소)';
  overlay.appendChild(label);

  let startX, startY, dragging = false;

  overlay.addEventListener('mousedown', e => {
    startX = e.clientX;
    startY = e.clientY;
    dragging = true;
    box.style.left = startX + 'px';
    box.style.top = startY + 'px';
    box.style.width = '0';
    box.style.height = '0';
    box.style.display = 'block';
  });

  overlay.addEventListener('mousemove', e => {
    if (!dragging) return;
    const x = Math.min(e.clientX, startX);
    const y = Math.min(e.clientY, startY);
    const w = Math.abs(e.clientX - startX);
    const h = Math.abs(e.clientY - startY);
    box.style.left = x + 'px';
    box.style.top = y + 'px';
    box.style.width = w + 'px';
    box.style.height = h + 'px';
  });

  function cleanup() {
    overlay.remove();
    document.removeEventListener('keydown', onEsc);
  }

  function onEsc(e) {
    if (e.key === 'Escape') {
      cleanup();
      chrome.runtime.sendMessage({ type: 'DRAG_DONE', rect: null });
    }
  }

  overlay.addEventListener('mouseup', e => {
    if (!dragging) return;
    dragging = false;
    const rect = {
      x: Math.min(e.clientX, startX),
      y: Math.min(e.clientY, startY),
      width: Math.abs(e.clientX - startX),
      height: Math.abs(e.clientY - startY)
    };
    cleanup();
    chrome.runtime.sendMessage({ type: 'DRAG_DONE', rect });
  });

  document.addEventListener('keydown', onEsc);

  document.body.appendChild(overlay);
}
