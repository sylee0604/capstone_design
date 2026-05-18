const GPU_SERVER_URL = 'https://anymore-marina-wherever-closing.trycloudflare.com';

chrome.action.onClicked.addListener(tab => {
  chrome.sidePanel.open({ windowId: tab.windowId });
});

// === 공통 유틸리티 ===

let cnyToKrwRate = null;
let rateLastFetched = 0;

async function getCnyToKrw() {
  if (cnyToKrwRate && Date.now() - rateLastFetched < 3600000) return cnyToKrwRate;
  try {
    const res = await fetch('https://open.er-api.com/v6/latest/CNY');
    const data = await res.json();
    cnyToKrwRate = data.rates.KRW;
    rateLastFetched = Date.now();
  } catch (e) {
    cnyToKrwRate = cnyToKrwRate || 190;
  }
  return cnyToKrwRate;
}

async function googleTranslate(text, from, to) {
  const res = await fetch(`https://translate.googleapis.com/translate_a/single?client=gtx&sl=${from}&tl=${to}&dt=t&q=${encodeURIComponent(text)}`);
  if (!res.ok) throw new Error(`번역 오류 ${res.status}`);
  const data = await res.json();
  return data[0].map(seg => seg[0]).join('');
}

async function translateToChineseKeywords(koreanQuery) {
  const result = await googleTranslate(koreanQuery, 'ko', 'zh-CN');
  return result.replace(/\s+/g, '');
}

function dedup(products) {
  const seen = new Set();
  return products.filter(p => {
    const key = p.id || p.title.replace(/\s+/g, '');
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function waitForTabLoad(tabId, maxWait = 15000) {
  const start = Date.now();
  // 네비게이션 시작 대기: 'loading' 상태가 될 때까지 기다림
  await new Promise(r => setTimeout(r, 300));
  for (let i = 0; i < 5; i++) {
    try {
      if ((await chrome.tabs.get(tabId)).status === 'loading') break;
    } catch (e) { return; }
    await new Promise(r => setTimeout(r, 200));
  }
  // 'complete' 될 때까지 대기
  while (Date.now() - start < maxWait) {
    try {
      if ((await chrome.tabs.get(tabId)).status === 'complete') return;
    } catch (e) { return; }
    await new Promise(r => setTimeout(r, 400));
  }
}

async function waitForElements(tabId, selectors, maxWait = 10000) {
  const start = Date.now();
  while (Date.now() - start < maxWait) {
    try {
      const res = await chrome.scripting.executeScript({
        target: { tabId },
        func: (sels) => Math.max(...sels.map(s => document.querySelectorAll(s).length)),
        args: [selectors],
      });
      if ((res[0]?.result || 0) >= 3) {
        await new Promise(r => setTimeout(r, 500));
        return;
      }
    } catch (e) {
      // 페이지 네비게이션 중 executeScript 실패 — 재시도
    }
    await new Promise(r => setTimeout(r, 400));
  }
}

async function scrollFullPage(tabId) {
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
}

async function getOrCreateTab(urlPattern, defaultUrl) {
  const tabs = await chrome.tabs.query({ url: urlPattern });
  if (tabs.length > 0) {
    await chrome.tabs.update(tabs[0].id, { active: true });
    return tabs[0].id;
  }
  const newTab = await chrome.tabs.create({ url: defaultUrl, active: true });
  await waitForTabLoad(newTab.id);
  await new Promise(r => setTimeout(r, 1000));
  return newTab.id;
}

async function translateAndConvert(ranked) {
  ranked.forEach(p => { p.titleZh = p.title; });
  const [rate] = await Promise.all([
    getCnyToKrw(),
    ...ranked.map(async (p, i) => {
      try { ranked[i].title = await googleTranslate(p.title, 'zh-CN', 'ko'); }
      catch (e) { console.log('[title translate error]', e.message); }
    })
  ]);
  ranked.forEach(p => {
    const won = p.price ? Math.round(parseFloat(p.price) * rate) : null;
    p.priceKrw = won ? won.toLocaleString('ko-KR') : '';
  });
}

// === 1688 스크래핑 (executeScript 주입용 — 외부 참조 불가) ===

async function scrapeProducts() {
  function parseCount(str) {
    if (!str) return 0;
    const s = String(str);
    if (s.includes('万') || s.includes('w')) return parseFloat(s) * 10000;
    return parseFloat(s.replace(/[^\d.]/g, '')) || 0;
  }

  function parsePrice(el) {
    if (!el) return '';
    const txt = el.innerText;
    const yuanMatch = txt.match(/[¥￥]\s*(\d+(?:\.\d{1,2})?)/);
    if (yuanMatch) return yuanMatch[1];
    const numMatch = txt.match(/(\d+(?:\.\d{1,2})?)/);
    return numMatch ? numMatch[1] : '';
  }

  function findProductImage(card) {
    const imgs = Array.from(card.querySelectorAll('img'));
    for (const el of imgs) {
      let src = el.src || el.getAttribute('data-src') || el.getAttribute('data-lazyload-src') || el.getAttribute('data-original') || '';
      if (!src || src.startsWith('data:') || src.length < 30) continue;
      if (el.width > 0 && el.width < 40) continue;
      if (el.height > 0 && el.height < 40) continue;
      if (src.startsWith('//')) src = 'https:' + src;
      return src;
    }
    return '';
  }

  function findCards() {
    const candidates = [
      '.search-offer-item', '.search-offer-wrapper',
      '[class*="search-offer"]', '[class*="offer-item"]',
      'div[data-offer-id]', '[class*="offerItem"]',
    ];
    for (const sel of candidates) {
      let els = Array.from(document.querySelectorAll(sel));
      els = els.filter(el => !els.some(other => other !== el && other.contains(el)));
      if (els.length >= 3) return els;
    }
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
    return cardSet.size >= 3 ? Array.from(cardSet) : [];
  }

  const products = [];
  for (const card of findCards()) {
    const titleEl = card.querySelector('[class*="title"],[class*="subject"],h2,h3');
    const priceEl = card.querySelector('[class*="price"],em');
    const linkEl = card.querySelector('a[href*="offerId"]') ||
      card.querySelector('a[href*="detail.1688"]') ||
      card.querySelector('a[href*="1688.com"]');
    const salesEl = card.querySelector('[class*="trade"],[class*="sale"],[class*="成交"],[class*="sold"]');
    const img = findProductImage(card);

    const salesText = salesEl ? salesEl.innerText.trim() : '';
    const salesNum = parseCount(salesText);
    if (salesText && salesNum < 10) continue;

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
      serviceScore = Math.round(svcScores.reduce((a, b) => a + b, 0) / svcScores.length * 100) / 100;
    }

    let pid = '';
    if (linkEl) {
      try {
        const params = new URLSearchParams(linkEl.href.split('?')[1] || '');
        pid = params.get('offerId') || params.get('offerIds') || '';
      } catch (e) {}
    }
    if (!pid) pid = (linkEl?.href.match(/\/offer\/(\d+)/) || [])[1] || '';
    if (!pid) pid = card.getAttribute('data-offer-id') || '';

    products.push({
      id: pid,
      title: titleEl ? titleEl.innerText.trim().slice(0, 150) : '',
      price: parsePrice(priceEl),
      image: img, sales: salesText, salesNum, serviceScore, qualityScore,
      url: pid ? `https://detail.1688.com/offer/${pid}.html` : (linkEl?.href || ''),
    });
  }

  const seenIds = new Set();
  return products.filter(p => {
    if (!p.title) return false;
    const key = p.id || p.title.replace(/\s+/g, '');
    if (seenIds.has(key)) return false;
    seenIds.add(key);
    return true;
  });
}

// === 타오바오 스크래핑 (executeScript 주입용 — 외부 참조 불가) ===

async function scrapeTaobaoProducts() {
  function parseCount(str) {
    if (!str) return 0;
    const s = String(str);
    if (s.includes('万') || s.includes('w')) return parseFloat(s) * 10000;
    return parseFloat(s.replace(/[^\d.]/g, '')) || 0;
  }

  function parsePrice(el) {
    if (!el) return '';
    const txt = el.innerText;
    const yuanMatch = txt.match(/[¥￥]\s*(\d+(?:\.\d{1,2})?)/);
    if (yuanMatch) return yuanMatch[1];
    const numMatch = txt.match(/(\d+(?:\.\d{1,2})?)/);
    return numMatch ? numMatch[1] : '';
  }

  function findProductImage(card) {
    const imgs = Array.from(card.querySelectorAll('img'));
    for (const el of imgs) {
      let src = el.src || el.getAttribute('data-src') || el.getAttribute('data-lazyload-src') || el.getAttribute('data-original') || '';
      if (!src || src.startsWith('data:') || src.length < 30) continue;
      if (el.width > 0 && el.width < 40) continue;
      if (el.height > 0 && el.height < 40) continue;
      if (src.startsWith('//')) src = 'https:' + src;
      return src;
    }
    return '';
  }

  function findCards() {
    const spmCards = Array.from(document.querySelectorAll('a[data-spm-act-id]'));
    if (spmCards.length >= 3) return spmCards;

    const candidates = [
      '[class*="Card--doubleCard"]', '[class*="doubleCard"]',
      '.Content--content .Card--card', '[class*="card"][class*="double"]',
      '[data-nid]', '.item.J_MouserOnverReq',
    ];
    for (const sel of candidates) {
      let els = Array.from(document.querySelectorAll(sel));
      els = els.filter(el => !els.some(other => other !== el && other.contains(el)));
      if (els.length >= 3) return els;
    }
    const itemLinks = Array.from(document.querySelectorAll('a[href*="item.taobao.com"], a[href*="detail.tmall.com"], a[href*="item.htm?id="]'));
    const cardSet = new Set();
    for (const link of itemLinks) {
      let el = link.parentElement;
      for (let depth = 0; el && depth < 5; depth++, el = el.parentElement) {
        if (el.querySelector('img') && (el.innerText || '').length > 10) {
          cardSet.add(el);
          break;
        }
      }
    }
    return cardSet.size >= 3 ? Array.from(cardSet) : [];
  }

  const products = [];
  for (const card of findCards()) {
    const titleEl = card.querySelector('[class*="title"], [class*="Title"], h3, h2');
    const priceEl = card.querySelector('[class*="price"], [class*="Price"], [class*="priceInt"]');
    const salesEl = card.querySelector('[class*="sale"], [class*="deal"], [class*="realSales"], [class*="Trade"]');
    const shopEl = card.querySelector('[class*="shop"], [class*="nick"], [class*="Store"]');
    const img = findProductImage(card);

    const salesText = salesEl ? salesEl.innerText.trim() : '';

    // ID 추출 (우선순위 체인)
    let pid = card.getAttribute('data-spm-act-id') || '';
    if (!pid) {
      const m = (card.getAttribute('id') || '').match(/item_id_(\d+)/);
      if (m) pid = m[1];
    }
    if (!pid) {
      const spmLink = card.querySelector('a[data-spm-act-id]');
      if (spmLink) pid = spmLink.getAttribute('data-spm-act-id');
    }
    if (!pid) {
      const linkEl = card.querySelector('a[href*="item.taobao.com"]') ||
        card.querySelector('a[href*="detail.tmall.com"]') ||
        card.querySelector('a[href*="item.htm?id="]');
      if (linkEl) {
        const m = (linkEl.href || '').match(/[?&]id=(\d+)/);
        if (m) pid = m[1];
      }
    }
    if (!pid) pid = card.getAttribute('data-nid') || card.getAttribute('data-id') || '';

    products.push({
      id: pid,
      title: titleEl ? titleEl.innerText.trim().slice(0, 150) : '',
      price: parsePrice(priceEl),
      image: img, sales: salesText, salesNum: parseCount(salesText),
      serviceScore: 0, qualityScore: 0,
      shop: shopEl ? shopEl.innerText.trim() : '',
      url: pid ? `https://item.taobao.com/item.htm?id=${pid}` : '',
    });
  }

  const seenIds = new Set();
  return products.filter(p => {
    if (!p.title) return false;
    const key = p.id || p.title.replace(/\s+/g, '');
    if (seenIds.has(key)) return false;
    seenIds.add(key);
    return true;
  });
}

// === 메시지 핸들러 ===

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'SEARCH') {
    const searchFn = message.platform === 'taobao' ? handleSearchTaobao : handleSearch;
    searchFn(message.query, message.chineseQuery)
      .then(result => sendResponse({ ok: true, ...result }))
      .catch(err => sendResponse({ ok: false, error: err.message }));
    return true;
  }
  if (message.type === 'EXTRACT_KEYWORDS') {
    extractKeywords(message.titleZh)
      .then(keywords => sendResponse({ ok: true, keywords }))
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

// === 1688 검색 ===

async function handleSearch(koreanQuery, preTranslated) {
  const chineseQuery = preTranslated || await translateToChineseKeywords(koreanQuery);
  console.log('[1688 chineseQuery]', chineseQuery);
  const tabId = await getOrCreateTab('*://*.1688.com/*', 'https://www.1688.com');

  // GBK form 제출
  await chrome.scripting.executeScript({
    target: { tabId },
    func: (query) => {
      const form = document.createElement('form');
      form.method = 'GET';
      form.action = 'https://s.1688.com/selloffer/offer_search.htm';
      form.acceptCharset = 'GBK';
      for (const [name, value] of Object.entries({ keywords: query, sortType: 'sa_trd30cnt_des', n: 'y', page: '1' })) {
        const inp = document.createElement('input');
        inp.type = 'hidden'; inp.name = name; inp.value = value;
        form.appendChild(inp);
      }
      document.body.appendChild(form);
      form.submit();
    },
    args: [chineseQuery],
  });

  await waitForTabLoad(tabId);
  await waitForElements(tabId, ['.search-offer-item', '[class*="search-offer"]', '[class*="offer-item"]', 'a[href*="offerId"]']);
  await scrollFullPage(tabId);

  const injected = await chrome.scripting.executeScript({ target: { tabId }, func: scrapeProducts });
  const products = injected[0]?.result || [];
  console.log('[1688 products]', products.length, products.slice(0, 2).map(p => p.title?.slice(0, 20)));

  if (products.length === 0) {
    return { chineseQuery, products: [], error: '1688 상품을 찾지 못했습니다. 1688에 로그인되어 있는지 확인하세요.' };
  }

  const unique = dedup(products);

  // 복합 점수: 판매량(0.2) + 품질(0.3) + 서비스(0.3) + 가격 적정성(0.2)
  const maxSales = Math.max(...unique.map(p => p.salesNum), 1);
  const maxQuality = Math.max(...unique.map(p => p.qualityScore), 1);
  const maxService = Math.max(...unique.map(p => p.serviceScore), 1);
  const prices = unique.map(p => parseFloat(p.price) || 0).filter(v => v > 0).sort((a, b) => b - a);
  const refPrice = prices.length >= 2 ? prices[1] : (prices[0] || 1);

  const ranked = [...unique]
    .sort((a, b) => {
      const score = p => {
        const price = parseFloat(p.price) || 0;
        return (p.salesNum / maxSales) * 0.2
          + (p.qualityScore / maxQuality) * 0.3
          + (p.serviceScore / maxService) * 0.3
          + (price > 0 ? Math.max(1 - price / refPrice, 0) : 0) * 0.2;
      };
      return score(b) - score(a);
    })
    .slice(0, 5)
    .map(p => ({
      ...p,
      rating: p.serviceScore ? `서비스 ${p.serviceScore}` : '',
      reviews: p.qualityScore ? `품질 ${p.qualityScore}` : '',
    }));

  await translateAndConvert(ranked);
  return { chineseQuery, products: ranked };
}

// === 타오바오 검색 ===

async function handleSearchTaobao(koreanQuery, preTranslated) {
  const chineseQuery = preTranslated || await translateToChineseKeywords(koreanQuery);
  console.log('[taobao chineseQuery]', chineseQuery);
  const tabId = await getOrCreateTab('*://*.taobao.com/*', 'https://www.taobao.com');

  await chrome.tabs.update(tabId, { url: `https://s.taobao.com/search?q=${encodeURIComponent(chineseQuery)}&sort=sale-desc` });
  await waitForTabLoad(tabId);
  await waitForElements(tabId, ['[class*="Card--doubleCard"]', '[class*="doubleCard"]', '[data-nid]', 'a[href*="item.taobao.com"]', 'a[href*="item.htm?id="]']);
  await scrollFullPage(tabId);

  const injected = await chrome.scripting.executeScript({ target: { tabId }, func: scrapeTaobaoProducts });
  const products = injected[0]?.result || [];
  console.log('[taobao products]', products.length, products.slice(0, 2).map(p => p.title?.slice(0, 20)));

  if (products.length === 0) {
    return { chineseQuery, products: [], error: '타오바오 상품을 찾지 못했습니다. 타오바오에 로그인되어 있는지 확인하세요.' };
  }

  const unique = dedup(products);

  // 복합 점수: 판매량(0.5) + 가격 적정성(0.5)
  const maxSales = Math.max(...unique.map(p => p.salesNum), 1);
  const prices = unique.map(p => parseFloat(p.price) || 0).filter(v => v > 0).sort((a, b) => b - a);
  const refPrice = prices.length >= 2 ? prices[1] : (prices[0] || 1);

  const ranked = [...unique]
    .sort((a, b) => {
      const score = p => {
        const price = parseFloat(p.price) || 0;
        return (p.salesNum / maxSales) * 0.5
          + (price > 0 ? Math.max(1 - price / refPrice, 0) : 0) * 0.5;
      };
      return score(b) - score(a);
    })
    .slice(0, 5)
    .map(p => ({
      ...p,
      rating: p.shop ? `🏪 ${p.shop}` : '',
      reviews: '',
    }));

  await translateAndConvert(ranked);
  return { chineseQuery, products: ranked };
}

// === 키워드 추출 ===

async function extractKeywords(titleZh) {
  if (!titleZh) return [];
  try {
    const res = await fetch(`${GPU_SERVER_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'Qwen/Qwen2.5-VL-7B-Instruct',
        messages: [{
          role: 'user',
          content: `从以下商品标题中提取3-5个最适合搜索同类商品的关键词组合。每行一个关键词，只输出关键词，不要编号不要解释。\n\n${titleZh}`
        }],
        max_tokens: 128,
        temperature: 0.1
      })
    });
    if (!res.ok) throw new Error('GPU error');
    const data = await res.json();
    const zhList = (data.choices?.[0]?.message?.content || '').trim()
      .split('\n')
      .map(s => s.replace(/^\d+[.、)]\s*/, '').trim())
      .filter(s => s.length >= 2 && s.length <= 20);

    return await Promise.all(
      zhList.slice(0, 5).map(async zh => {
        try { return { zh, ko: await googleTranslate(zh, 'zh-CN', 'ko') }; }
        catch { return { zh, ko: zh }; }
      })
    );
  } catch (e) {
    try { return [{ zh: titleZh, ko: await googleTranslate(titleZh, 'zh-CN', 'ko') }]; }
    catch { return []; }
  }
}

// === 이미지 텍스트 추출 (드래그 + OCR) ===

async function handleStartDrag() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) { notifyPopup({ type: 'OCR_RESULT', error: '활성 탭을 찾을 수 없습니다' }); return; }
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: injectDragOverlay });
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

    notifyPopup({ type: 'OCR_STATUS', text: 'AI가 텍스트 추출 중...' });
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
          const srcW = r.width * dpr, srcH = r.height * dpr;
          const MAX_DIM = 1500;
          const scale = Math.min(1, MAX_DIM / Math.max(srcW, srcH));
          const canvas = document.createElement('canvas');
          canvas.width = Math.round(srcW * scale);
          canvas.height = Math.round(srcH * scale);
          canvas.getContext('2d').drawImage(img,
            r.x * dpr, r.y * dpr, srcW, srcH,
            0, 0, canvas.width, canvas.height
          );
          resolve(canvas.toDataURL('image/jpeg', 0.75));
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
  const mimeType = imageDataUrl.match(/^data:(image\/\w+);/)?.[1] || 'image/jpeg';

  const ocrRes = await fetch(`${GPU_SERVER_URL}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'Qwen/Qwen2.5-VL-7B-Instruct',
      messages: [{
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: `data:${mimeType};base64,${base64}` } },
          { type: 'text', text: `이 이미지에서 텍스트를 그대로 추출하세요. 번역하지 마세요.\n\n규칙:\n- 표(테이블)가 있으면 마크다운 표 형식(| 열1 | 열2 |)으로 출력\n- 표가 아닌 텍스트는 그대로 출력\n- 숫자, 단위(cm, kg 등)는 그대로 유지` }
        ]
      }],
      max_tokens: 1024, temperature: 0.1
    })
  });

  if (!ocrRes.ok) {
    const errText = await ocrRes.text();
    throw new Error(`GPU 서버 오류: ${ocrRes.status} ${errText.slice(0, 100)}`);
  }

  const original = (await ocrRes.json()).choices?.[0]?.message?.content?.trim() || '';
  if (!original) return { original: '(텍스트를 추출하지 못했습니다)', translated: '' };

  notifyPopup({ type: 'OCR_STATUS', text: '번역 중...' });

  const transRes = await fetch(`${GPU_SERVER_URL}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'Qwen/Qwen2.5-VL-7B-Instruct',
      messages: [{
        role: 'user',
        content: `다음 중국어 텍스트를 한국어로 번역하세요.\n\n규칙:\n- 표(테이블)가 있으면 행 수, 열 수, 구조를 원문과 완전히 동일하게 유지\n- 중국어 텍스트만 한국어로 번역\n- 숫자, 단위(cm, kg 등), 사이즈(S, M, L, XL, 90, 100 등)는 절대 생략하지 말고 원문 그대로 유지\n- 번역문만 출력 (설명이나 부연 없이)\n\n${original}`
      }],
      max_tokens: 1024, temperature: 0.1
    })
  });

  if (!transRes.ok) return { original, translated: '(번역 실패)' };
  const translated = (await transRes.json()).choices?.[0]?.message?.content?.trim() || '(번역 실패)';
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
    startX = e.clientX; startY = e.clientY; dragging = true;
    box.style.left = startX + 'px'; box.style.top = startY + 'px';
    box.style.width = '0'; box.style.height = '0'; box.style.display = 'block';
  });

  overlay.addEventListener('mousemove', e => {
    if (!dragging) return;
    box.style.left = Math.min(e.clientX, startX) + 'px';
    box.style.top = Math.min(e.clientY, startY) + 'px';
    box.style.width = Math.abs(e.clientX - startX) + 'px';
    box.style.height = Math.abs(e.clientY - startY) + 'px';
  });

  function cleanup() { overlay.remove(); document.removeEventListener('keydown', onEsc); }
  function onEsc(e) { if (e.key === 'Escape') { cleanup(); chrome.runtime.sendMessage({ type: 'DRAG_DONE', rect: null }); } }

  overlay.addEventListener('mouseup', e => {
    if (!dragging) return;
    dragging = false;
    const rect = {
      x: Math.min(e.clientX, startX), y: Math.min(e.clientY, startY),
      width: Math.abs(e.clientX - startX), height: Math.abs(e.clientY - startY)
    };
    cleanup();
    chrome.runtime.sendMessage({ type: 'DRAG_DONE', rect });
  });

  document.addEventListener('keydown', onEsc);
  document.body.appendChild(overlay);
}
