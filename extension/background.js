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
  const sleep = ms => new Promise(r => setTimeout(r, ms));

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
    // fallback: offerId 링크가 있는 div
    const allDivs = Array.from(document.querySelectorAll('div'));
    const withImgLink = allDivs.filter(el =>
      el.querySelector('img') &&
      el.querySelector('a[href*="offerId"]') &&
      (el.innerText || '').length > 10
    );
    if (withImgLink.length >= 3) return withImgLink;
    return [];
  }

  const cards = findCards().slice(0, 20);

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

    // 구매 10개 미만 제외
    if (salesNum > 0 && salesNum < 10) continue;

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
      price: priceEl ? priceEl.innerText.replace(/[^\d.]/g, '') : '',
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
      func: () => document.querySelectorAll('.search-offer-item').length,
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
    const currentTab = await chrome.tabs.get(tabId);
    // 이미 검색 결과 페이지면 홈으로 초기화해야 form 주입 가능
    if (!currentTab.url.includes('www.1688.com')) {
      await chrome.tabs.update(tabId, { url: 'https://www.1688.com', active: true });
      await waitForTabLoad(tabId);
      await new Promise(r => setTimeout(r, 1000));
    } else {
      await chrome.tabs.update(tabId, { active: true });
    }
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

  // 4. 검색 결과 로드 + 카드 렌더링 대기
  await waitForTabLoad(tabId);
  await waitForCards(tabId);

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

  if (products.length === 0) {
    return { chineseQuery, products: [], error: '1688 상품을 찾지 못했습니다. 1688에 로그인되어 있는지 확인하세요.' };
  }

  // 6. 점수 기준 정렬 (점수는 scrapeProducts에서 이미 수집)
  console.log('[products with scores]', products.slice(0, 5).map(p => ({ title: p.title?.slice(0, 20), svc: p.serviceScore, qty: p.qualityScore })));
  const scoreMap = {}; // unused but kept for structure

  // 7. 점수 합산 후 정렬 → 상위 5개
  function parseNum(str) {
    if (!str) return 0;
    const s = String(str).replace(/,/g, '');
    if (s.includes('万') || s.includes('w') || s.includes('W')) return parseFloat(s) * 10000;
    return parseFloat(s.replace(/[^\d.]/g, '')) || 0;
  }

  const ranked = [...products]
    .sort((a, b) => {
      const avgA = (a.serviceScore + a.qualityScore) / ((a.serviceScore > 0 ? 1 : 0) + (a.qualityScore > 0 ? 1 : 0) || 1);
      const avgB = (b.serviceScore + b.qualityScore) / ((b.serviceScore > 0 ? 1 : 0) + (b.qualityScore > 0 ? 1 : 0) || 1);
      if (avgB !== avgA) return avgB - avgA;
      return parseNum(b.sales) - parseNum(a.sales); // 점수 같으면 판매량 순
    })
    .slice(0, 5)
    .map(p => ({
      ...p,
      rating: p.serviceScore ? `서비스 ${p.serviceScore}` : '',
      reviews: p.qualityScore ? `품질 ${p.qualityScore}` : '',
    }));

  // 8. 환율 적용
  const rate = await getCnyToKrw();
  ranked.forEach(p => {
    const won = p.price ? Math.round(parseFloat(p.price) * rate) : null;
    p.priceKrw = won ? won.toLocaleString('ko-KR') : '';
  });

  // 9. 상품명 한국어 번역 (병렬)
  await Promise.all(ranked.map(async (p, i) => {
    try {
      ranked[i].title = await googleTranslate(p.title, 'zh-CN', 'ko');
    } catch(e) {
      console.log('[title translation error]', String(e));
    }
  }));

  return { chineseQuery, products: ranked };
}
