'use strict';

const SELECTORS = {
  titleLink:  'h3 a',
  authorSpan: 'p span',
  tagLabel:   '.MuiChip-label',
  abstract:   'section',
  paperCard:  '.MuiGrid2-root',
};

function extractPapersFromDOM() {
  const papers = [];
  const seen   = new Set();

  for (const link of document.querySelectorAll(SELECTORS.titleLink)) {
    const pdfUrl = link.href;
    if (!pdfUrl || seen.has(pdfUrl)) continue;
    seen.add(pdfUrl);

    const card = link.closest(SELECTORS.paperCard);
    if (!card) continue;

    const title    = link.textContent.trim();
    const paperUrl = pdfUrl.replace(/\/pdf\//i, '/abs/').replace(/\.pdf$/i, '');
    const arxivId  = (pdfUrl.match(/(?:arxiv\.org\/(?:pdf|abs)\/)([^?#/]+)/i) || [])[1] || '';

    const authorEl = card.querySelector(SELECTORS.authorSpan);
    const authors  = authorEl
      ? authorEl.textContent.split(',').map(a => a.trim()).filter(Boolean)
      : [];

    let venue = '';
    for (const div of card.querySelectorAll('div')) {
      const t = div.textContent.trim();
      if (t.length > 5 && t.length < 120 && /20\d{2}/.test(t) && div.children.length <= 2) {
        venue = t;
        break;
      }
    }

    const tags     = Array.from(card.querySelectorAll(SELECTORS.tagLabel))
      .map(el => el.textContent.trim()).filter(Boolean);
    const abstractEl = card.querySelector(SELECTORS.abstract);
    const abstract   = abstractEl ? abstractEl.textContent.trim() : '';

    if (title && pdfUrl) {
      papers.push({ title, pdfUrl, paperUrl, arxivId, authors, venue, tags, abstract });
    }
  }
  return papers;
}

function getCurrentDateEl() {
  const dateRe = /^\d{1,2}\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{4}$/;
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    if (dateRe.test(walker.currentNode.textContent.trim())) {
      return walker.currentNode.parentElement;
    }
  }
  return null;
}

function findPrevDayButton() {
  const byAria = document.querySelector(
    '[aria-label*="previous" i], [aria-label*="prev" i], [aria-label*="earlier" i]'
  );
  if (byAria) return byAria;

  const dateEl = getCurrentDateEl();
  if (dateEl) {
    const dateRect = dateEl.getBoundingClientRect();
    const clickables = document.querySelectorAll('a[tabindex="-1"], a[role="button"], button, [role="button"]');
    let best = null, bestDist = Infinity;
    for (const el of clickables) {
      const r = el.getBoundingClientRect();
      if (r.width < 5 || r.height < 5) continue;
      if (r.right > dateRect.left)     continue;
      if (Math.abs(r.top - dateRect.top) > 40) continue;
      const dist = dateRect.left - r.right;
      if (dist < bestDist) { best = el; bestDist = dist; }
    }
    if (best) return best;
  }

  for (const el of document.querySelectorAll('a, button')) {
    const path = el.querySelector('path');
    if (!path) continue;
    const d = path.getAttribute('d') || '';
    if (d.includes('16.725') || d.includes('18.725')) return el;
  }

  return null;
}

function waitForDOMSettle(ms = 4000) {
  return new Promise(resolve => {
    let timer = null;
    const observer = new MutationObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(() => { observer.disconnect(); resolve(); }, 700);
    });
    observer.observe(document.getElementById('root') || document.body,
      { childList: true, subtree: true });
    setTimeout(() => { observer.disconnect(); resolve(); }, ms);
  });
}

async function navigatePrevDay() {
  const btn = findPrevDayButton();
  if (!btn) throw new Error('Cannot find previous-day button. Try navigating manually first.');
  btn.click();
  await waitForDOMSettle();
}

async function collectPapersForDays(days) {
  const all  = [];
  const seen = new Set();

  function merge(batch) {
    for (const p of batch) {
      if (!seen.has(p.pdfUrl)) { seen.add(p.pdfUrl); all.push(p); }
    }
  }

  merge(extractPapersFromDOM());
  chrome.storage.local.set({ extractProgress: { current: 1, total: days, count: all.length } });

  for (let i = 1; i < days; i++) {
    try {
      await navigatePrevDay();
      merge(extractPapersFromDOM());
      chrome.storage.local.set({ extractProgress: { current: i + 1, total: days, count: all.length } });
    } catch (e) {
      console.warn('[ResearchAssistant] nav failed day', i, e.message);
      break;
    }
  }
  return all;
}

async function fetchPDFBase64(url) {
  const resp = await fetch(url, { redirect: 'follow' });
  if (!resp.ok) throw new Error(`PDF HTTP ${resp.status}: ${url}`);
  const buf    = await resp.arrayBuffer();
  const bytes  = new Uint8Array(buf);
  let binary = '';
  const chunk = 8192;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.action === 'PING') {
    sendResponse({ pong: true, url: location.href });
    return false;
  }

  if (msg.action === 'EXTRACT_PAPERS') {
    const days = Math.max(1, Math.min(parseInt(msg.days) || 1, 30));
    collectPapersForDays(days)
      .then(papers => sendResponse({ success: true, papers }))
      .catch(err   => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (msg.action === 'FETCH_PDF_BASE64') {
    fetchPDFBase64(msg.url)
      .then(base64 => sendResponse({ success: true, base64 }))
      .catch(err   => sendResponse({ success: false, error: err.message }));
    return true;
  }
});
