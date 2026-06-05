'use strict';

let allPapers      = [];
let selectedIds    = new Set();
let activeRunId    = null;
let pollTimer      = null;
let summaryData    = [];
let compareSelIds  = new Set();
let showLastRunOnly = false;

const sw  = msg => new Promise(r => chrome.runtime.sendMessage(msg, r));
const $   = id  => document.getElementById(id);
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls)  e.className   = cls;
  if (text) e.textContent = text;
  return e;
}
function confClass(s) { return s >= 0.75 ? 'conf-high' : s >= 0.5 ? 'conf-mid' : 'conf-low'; }
function shortenAuthors(a) {
  if (!a?.length) return '';
  return a.length <= 3 ? a.join(', ') : `${a[0]}, ${a[1]} +${a.length - 2} more`;
}
function renderError(id, msg) {
  $(id).innerHTML = `<div class="empty-state"><span class="empty-icon">⚠</span><p style="color:var(--danger)">${msg}</p></div>`;
}

document.querySelectorAll('.tab').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    btn.classList.add('active');
    $(`tab-${btn.dataset.tab}`).classList.add('active');
    if (btn.dataset.tab === 'summaries') loadSummaries();
    if (btn.dataset.tab === 'compare')   renderCompareSelect();
    if (btn.dataset.tab === 'kb')        loadKBStats();
  });
});

$('timeRange').addEventListener('change', () => {
  const custom = $('timeRange').value === 'custom';
  $('customRangeRow').classList.toggle('hidden', !custom);
  if (custom) {
    $('customEnd').value   = new Date().toISOString().slice(0, 10);
    $('customStart').value = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
  }
});

function getDays() {
  const v = $('timeRange').value;
  if (v !== 'custom') return parseInt(v);
  const s = new Date($('customStart').value), e = new Date($('customEnd').value);
  return isNaN(s) || isNaN(e) ? 7 : Math.max(1, Math.min(30, Math.ceil((e - s) / 86400000) + 1));
}

$('fetchBtn').addEventListener('click', fetchPapers);

async function fetchPapers() {
  const days = getDays();
  $('fetchBtn').disabled    = true;
  $('fetchBtn').textContent = 'Fetching…';
  $('fetchProgress').classList.remove('hidden');
  $('fetchBar').style.width = '5%';

  const poller = setInterval(async () => {
    const r = await chrome.storage.local.get('extractProgress');
    const p = r.extractProgress;
    if (p) {
      $('fetchBar').style.width         = Math.round(p.current / p.total * 100) + '%';
      $('fetchProgressText').textContent = `Day ${p.current}/${p.total} — ${p.count} papers`;
    }
  }, 500);

  try {
    const resp = await sw({ action: 'GET_PAPERS', days });
    if (resp?.error) throw new Error(resp.error);
    allPapers   = resp.papers || [];
    selectedIds = new Set();
    $('fetchBar').style.width = '100%';
    $('fetchProgressText').textContent = `${allPapers.length} papers collected`;
    setTimeout(() => $('fetchProgress').classList.add('hidden'), 1500);
    renderPaperList();
  } catch (e) {
    $('fetchProgress').classList.add('hidden');
    renderError('papers-list', e.message);
  } finally {
    clearInterval(poller);
    await chrome.storage.local.remove('extractProgress');
    $('fetchBtn').disabled    = false;
    $('fetchBtn').textContent = 'Fetch';
  }
}

function renderPaperList() {
  const list = $('papers-list');
  list.innerHTML = '';
  if (!allPapers.length) {
    list.innerHTML = '<div class="empty-state"><span class="empty-icon">🔎</span><p>No papers found.</p></div>';
    $('action-bar').classList.add('hidden');
    return;
  }
  allPapers.forEach((paper, idx) => {
    const card    = el('div', 'paper-card');
    const cb      = document.createElement('input');
    cb.type       = 'checkbox';
    cb.className  = 'paper-checkbox';
    cb.checked    = selectedIds.has(idx);
    cb.addEventListener('change', () => toggleSelect(idx, cb.checked, card));

    const meta    = el('div', 'paper-meta');
    const tags    = el('div', 'paper-tags');
    (paper.tags || []).slice(0, 4).forEach(t => tags.appendChild(el('span', 'paper-tag', t)));
    meta.append(
      el('div', 'paper-title',   paper.title),
      el('div', 'paper-authors', shortenAuthors(paper.authors)),
      el('div', 'paper-venue',   paper.venue || ''),
      tags
    );
    meta.addEventListener('click', () => { cb.checked = !cb.checked; toggleSelect(idx, cb.checked, card); });
    card.append(cb, meta);
    list.appendChild(card);
  });
  updateActionBar();
}

function toggleSelect(idx, checked, card) {
  if (checked) selectedIds.add(idx); else selectedIds.delete(idx);
  card.classList.toggle('selected', checked);
  updateActionBar();
}
function updateActionBar() {
  const n = selectedIds.size;
  $('action-bar').classList.toggle('hidden', allPapers.length === 0);
  $('selCount').textContent = `${n} selected`;
  $('analyzeBtn').disabled  = n === 0;
}
$('selectAllBtn').addEventListener('click', () => {
  allPapers.forEach((_, i) => selectedIds.add(i));
  document.querySelectorAll('.paper-checkbox').forEach((cb, i) => { cb.checked = true; cb.closest('.paper-card')?.classList.add('selected'); });
  updateActionBar();
});
$('deselectAllBtn').addEventListener('click', () => {
  selectedIds.clear();
  document.querySelectorAll('.paper-checkbox').forEach(cb => { cb.checked = false; cb.closest('.paper-card')?.classList.remove('selected'); });
  updateActionBar();
});

$('analyzeBtn').addEventListener('click', startAnalysis);

async function startAnalysis() {
  const papers = [...selectedIds].map(i => allPapers[i]);
  if (!papers.length) return;
  $('analyzeBtn').disabled = true;
  showAnalysisProgress('Registering papers…');

  const resp = await sw({ action: 'START_ANALYSIS', papers });
  if (resp?.error) {
    hideAnalysisProgress();
    $('analyzeBtn').disabled = false;
    renderError('papers-list', resp.error);
    return;
  }
  activeRunId = resp.run_id;
  $('analysisRunId').textContent = `run: ${activeRunId.slice(0, 8)}…`;
  if (resp.uploadErrors?.length) {
    const warn = resp.uploadErrors.map(e => `${e.title}: ${e.error}`).join('\n');
    console.warn('[ResearchAssistant] Upload warnings:', warn);
  }
  pollTimer = setInterval(pollAnalysis, 5000);
}

async function pollAnalysis() {
  if (!activeRunId) return;
  const run = await sw({ action: 'POLL_RUN', runId: activeRunId });
  if (run?.error) return;
  const labels = { queued:'Queued…', running:'Generating summaries…', done:'Done ✓', failed:'Failed.' };
  $('analysisPhaseText').textContent = labels[run.status] || run.status;
  if (run.status === 'done' || run.status === 'failed') {
    clearInterval(pollTimer);
    activeRunId = null;
    hideAnalysisProgress();
    $('analyzeBtn').disabled = false;
    await sw({ action: 'CLEAR_ACTIVE_RUN' });
    if (run.status === 'done') document.querySelector('[data-tab="summaries"]').click();
  }
}

function showAnalysisProgress(t) { $('analysisPhaseText').textContent = t; $('analysisProgress').classList.remove('hidden'); }
function hideAnalysisProgress()  { $('analysisProgress').classList.add('hidden'); }
$('cancelPollBtn').addEventListener('click', () => { clearInterval(pollTimer); hideAnalysisProgress(); $('analyzeBtn').disabled = false; });

$('refreshSummariesBtn').addEventListener('click', loadSummaries);
$('summarySearch').addEventListener('input', filterSummaries);
$('showLastRunBtn').addEventListener('click',  async () => { showLastRunOnly = true;  await loadSummaries(); });
$('showAllSummariesBtn').addEventListener('click', async () => { showLastRunOnly = false; await loadSummaries(); });
$('deleteAllBtn').addEventListener('click', deleteAll);

async function loadSummaries() {
  const list = $('summaries-list');
  list.innerHTML = '<div class="empty-state"><span class="empty-icon">⏳</span><p>Loading…</p></div>';

  const resp = await sw({ action: 'LIST_PAPERS', limit: 200 });
  if (resp?.error) { renderError('summaries-list', resp.error); return; }

  let papers = (resp.items || []).filter(p => p.status === 'summarized');

  if (showLastRunOnly) {
    const r = await sw({ action: 'GET_LAST_RUN_PAPER_IDS' });
    const lastIds = new Set(r.paperIds || []);
    papers = papers.filter(p => lastIds.has(p.id));
  }

  summaryData = [];
  for (const paper of papers) {
    const s = await sw({ action: 'GET_SUMMARIES', paperId: paper.id });
    if (!s?.error && s?.length) summaryData.push({ paper, summary: s[0] });
  }

  renderSummaryList(summaryData);
  renderCompareSelect();
}

function filterSummaries() {
  const q = $('summarySearch').value.toLowerCase().trim();
  renderSummaryList(q ? summaryData.filter(d => d.paper.title.toLowerCase().includes(q)) : summaryData);
}

const FIELDS = [
  ['research_problem','Research Problem'],['motivation','Motivation'],
  ['methodology','Methodology'],['dataset','Dataset'],
  ['evaluation_metrics','Evaluation'],['key_results','Key Results'],
  ['novel_contributions','Contributions'],['limitations','Limitations'],['future_work','Future Work'],
];

function renderSummaryList(data) {
  const list = $('summaries-list');
  list.innerHTML = '';
  if (!data.length) {
    list.innerHTML = '<div class="empty-state"><span class="empty-icon">🧾</span><p>No summaries yet.</p></div>';
    return;
  }
  data.forEach(({ paper, summary }) => {
    const card   = el('div', 'summary-card');
    const score  = summary.confidence_score ?? 0;
    const header = el('div', 'summary-header');
    const badge  = el('span', `confidence-badge ${confClass(score)}`, (score * 100).toFixed(0) + '%');
    const title  = el('div', 'summary-title', paper.title);
    const chev   = el('span', 'summary-chevron', '›');
    const delBtn = el('button', 'btn-icon-del', '🗑');
    delBtn.title = 'Delete this paper and its summary';
    delBtn.addEventListener('click', async e => {
      e.stopPropagation();
      if (!confirm(`Delete "${paper.title}"?`)) return;
      const r = await sw({ action: 'DELETE_PAPER', paperId: paper.id });
      if (!r?.error) card.remove();
    });
    header.append(badge, title, delBtn, chev);
    header.addEventListener('click', e => { if (e.target !== delBtn) card.classList.toggle('open'); });

    const body = el('div', 'summary-body');
    FIELDS.forEach(([key, label]) => {
      const val   = summary[key] || '';
      const group = el('div', 'summary-field');
      group.appendChild(el('span', 'field-key', label));
      group.appendChild(el('p', 'field-val' + (val ? '' : ' field-empty'), val || 'Not mentioned in text.'));
      body.appendChild(group);
    });

    const meta = el('div', 'summary-meta');
    if (paper.paper_url) { const c = el('span','meta-chip'); const a=document.createElement('a'); a.href=paper.paper_url; a.target='_blank'; a.textContent='↗ Paper'; c.appendChild(a); meta.appendChild(c); }
    if (paper.pdf_url)   { const c = el('span','meta-chip'); const a=document.createElement('a'); a.href=paper.pdf_url;   a.target='_blank'; a.textContent='⬇ PDF';  c.appendChild(a); meta.appendChild(c); }
    meta.appendChild(el('span','meta-chip',`model: ${(summary.model||'').split('/').pop()}`));
    meta.appendChild(el('span','meta-chip',`conf: ${score.toFixed(2)}`));
    body.appendChild(meta);

    card.append(header, body);
    list.appendChild(card);
  });
}

async function deleteAll() {
  if (!confirm('Delete ALL papers and summaries from the knowledge base?')) return;
  const resp = await sw({ action: 'LIST_PAPERS', limit: 200 });
  const papers = resp.items || [];
  for (const p of papers) await sw({ action: 'DELETE_PAPER', paperId: p.id });
  summaryData = [];
  renderSummaryList([]);
  renderCompareSelect();
}

function renderCompareSelect() {
  const list = $('compare-select-list');
  list.innerHTML = '';
  compareSelIds.clear();
  $('compareBtn').disabled = true;

  if (!summaryData.length) {
    list.innerHTML = '<div class="empty-state"><span class="empty-icon">📊</span><p>Go to Summaries tab and load papers first</p></div>';
    return;
  }

  summaryData.forEach(({ paper }) => {
    const row  = el('div', 'compare-row');
    const cb   = document.createElement('input');
    cb.type    = 'checkbox';
    cb.className = 'paper-checkbox';
    cb.addEventListener('change', () => {
      if (cb.checked) compareSelIds.add(paper.id);
      else            compareSelIds.delete(paper.id);
      row.classList.toggle('selected', cb.checked);
      $('compareBtn').disabled = compareSelIds.size < 2;
    });
    const t = el('span', 'compare-row-title', paper.title);
    row.append(cb, t);
    list.appendChild(row);
  });
}

$('compareBtn').addEventListener('click', runCompare);

async function runCompare() {
  if (compareSelIds.size < 2) return;
  $('compareBtn').textContent = 'Comparing…';
  $('compareBtn').disabled    = true;
  $('compare-result').classList.add('hidden');

  const resp = await sw({ action: 'COMPARE_PAPERS', paperIds: [...compareSelIds] });
  $('compareBtn').textContent = 'Compare';
  $('compareBtn').disabled    = compareSelIds.size < 2;

  if (resp?.error || !resp?.rows?.length) {
    $('compare-result').innerHTML = `<p style="color:var(--danger);padding:12px">${resp?.error || 'No data'}</p>`;
    $('compare-result').classList.remove('hidden');
    return;
  }

  renderCompareTable(resp.rows);
}

function renderCompareTable(rows) {
  const result = $('compare-result');
  result.innerHTML = '';

  const compareFields = [
    ['research_problem','Problem'],['methodology','Method'],['dataset','Dataset'],
    ['evaluation_metrics','Metrics'],['key_results','Results'],
    ['novel_contributions','Contributions'],['limitations','Limitations'],['future_work','Future Work'],
  ];

  const table = document.createElement('table');
  table.className = 'compare-table';

  const thead = document.createElement('thead');
  const hr    = document.createElement('tr');
  hr.appendChild(el('th', 'compare-th', 'Field'));
  rows.forEach(({ paper }) => {
    const th = el('th', 'compare-th compare-paper-th');
    th.textContent = paper.title.length > 40 ? paper.title.slice(0, 37) + '…' : paper.title;
    hr.appendChild(th);
  });
  thead.appendChild(hr);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  compareFields.forEach(([key, label]) => {
    const tr = document.createElement('tr');
    tr.appendChild(el('td', 'compare-td compare-label', label));
    rows.forEach(({ summary }) => {
      const val = summary[key] || '—';
      tr.appendChild(el('td', 'compare-td', val));
    });
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  result.appendChild(table);
  result.classList.remove('hidden');
}

async function loadKBStats() {
  const resp = await sw({ action: 'LIST_PAPERS', limit: 200 });
  if (resp?.error) return;
  const total     = (resp.items || []).length;
  const summarized = (resp.items || []).filter(p => p.status === 'summarized').length;
  $('kb-stats').textContent = `${summarized} summarized papers · ${total} total in KB`;
  $('kb-stats').classList.remove('hidden');
}

$('kbSearchBtn').addEventListener('click', runKBSearch);
$('kbSearch').addEventListener('keydown', e => { if (e.key === 'Enter') runKBSearch(); });

async function runKBSearch() {
  const q = $('kbSearch').value.trim().toLowerCase();
  if (!q) return;

  $('kbSearchBtn').textContent = 'Searching…';
  $('kbSearchBtn').disabled    = true;
  $('kb-results').innerHTML    = '<div class="empty-state"><span class="empty-icon">⏳</span><p>Searching…</p></div>';

  const resp = await sw({ action: 'KB_SEARCH' });
  $('kbSearchBtn').textContent = 'Search';
  $('kbSearchBtn').disabled    = false;

  if (resp?.error) { renderError('kb-results', resp.error); return; }

  const allResults = resp.results || [];
  const hits = allResults.filter(({ paper, summary }) => {
    const haystack = [
      paper.title, ...(paper.authors?.map(a => a.name || a) || []),
      summary.research_problem, summary.methodology, summary.dataset,
      summary.key_results, summary.novel_contributions,
      ...(paper.tags || []),
    ].join(' ').toLowerCase();
    return q.split(' ').every(word => haystack.includes(word));
  });

  const list = $('kb-results');
  list.innerHTML = '';

  if (!hits.length) {
    list.innerHTML = `<div class="empty-state"><span class="empty-icon">🔎</span><p>No results for "<em>${q}</em>"</p></div>`;
    return;
  }

  hits.forEach(({ paper, summary }) => {
    const card   = el('div', 'kb-card');
    const score  = summary.confidence_score ?? 0;
    const header = el('div', 'kb-card-header');
    header.appendChild(el('span', `confidence-badge ${confClass(score)}`, (score * 100).toFixed(0) + '%'));
    header.appendChild(el('div', 'summary-title', paper.title));
    header.addEventListener('click', () => card.classList.toggle('open'));

    const body = el('div', 'kb-card-body');
    FIELDS.forEach(([key, label]) => {
      const val = summary[key] || '';
      if (!val) return;
      const matches = q.split(' ').some(w => val.toLowerCase().includes(w));
      if (!matches) return;
      const g = el('div', 'summary-field');
      g.appendChild(el('span', 'field-key', label));
      g.appendChild(el('p', 'field-val', val));
      body.appendChild(g);
    });
    if (!body.children.length) {
      body.appendChild(el('p', 'field-val', paper.title));
    }

    const meta = el('div', 'summary-meta');
    if (paper.paper_url) { const c=el('span','meta-chip'); const a=document.createElement('a'); a.href=paper.paper_url; a.target='_blank'; a.textContent='↗ Paper'; c.appendChild(a); meta.appendChild(c); }
    body.appendChild(meta);
    card.append(header, body);
    list.appendChild(card);
  });
}

$('saveSettingsBtn').addEventListener('click', async () => {
  const url  = $('backendUrlInput').value.trim();
  await sw({ action: 'SAVE_SETTINGS', backendUrl: url });
  $('saveSettingsBtn').textContent = 'Saved ✓';
  setTimeout(() => $('saveSettingsBtn').textContent = 'Save', 2000);
  checkHealth();
});

$('testConnectionBtn').addEventListener('click', async () => {
  $('testConnectionBtn').textContent = 'Testing…';
  const result = $('connectionResult');
  result.classList.remove('hidden', 'ok', 'err');
  try {
    await sw({ action: 'SAVE_SETTINGS', backendUrl: $('backendUrlInput').value.trim() });
    const h = await sw({ action: 'HEALTH_CHECK' });
    if (h?.error) throw new Error(h.error);
    result.className   = 'connection-result ok';
    result.textContent = `✓ Connected\nModel: ${h.model}\nLLM reachable: ${h.llm_reachable}`;
    updateHeaderBadge(h);
  } catch (e) {
    result.className   = 'connection-result err';
    result.textContent = `✗ ${e.message}`;
    updateHeaderBadge(null);
  } finally {
    result.classList.remove('hidden');
    $('testConnectionBtn').textContent = 'Test connection';
  }
});

async function checkHealth() {
  const h = await sw({ action: 'HEALTH_CHECK' });
  updateHeaderBadge(h?.error ? null : h);
}
function updateHeaderBadge(h) {
  const b = $('llm-badge');
  if (!h)              { b.className='badge badge-err';     b.textContent='offline'; return; }
  if (h.llm_reachable) { b.className='badge badge-ok';      b.textContent='online'; }
  else                 { b.className='badge badge-unknown'; b.textContent='no LLM'; }
  $('header-status').textContent = (h.model||'').split('/').pop().slice(0,12);
}

async function init() {
  const s = await sw({ action: 'GET_SETTINGS' });
  if (s?.backendUrl) $('backendUrlInput').value = s.backendUrl;
  checkHealth();

  const active = await sw({ action: 'GET_ACTIVE_RUN' });
  if (active?.runId && active?.status === 'running') {
    activeRunId = active.runId;
    showAnalysisProgress('Analysis in progress…');
    $('analysisRunId').textContent = `run: ${activeRunId.slice(0,8)}…`;
    pollTimer = setInterval(pollAnalysis, 5000);
  }
}

init();
