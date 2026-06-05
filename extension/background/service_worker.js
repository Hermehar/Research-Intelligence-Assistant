'use strict';

const DEFAULT_BACKEND = 'http://127.0.0.1:8080';

async function getBackendUrl() {
  const r = await chrome.storage.local.get('backendUrl');
  return (r.backendUrl || DEFAULT_BACKEND).replace(/\/$/, '');
}

async function api(endpoint, method = 'GET', body = null) {
  const base = await getBackendUrl();
  const url  = `${base}/api/v1${endpoint}`;
  const opts = { method };
  if (body instanceof FormData) {
    opts.body = body;
  } else if (body !== null) {
    opts.headers = { 'Content-Type': 'application/json' };
    opts.body    = JSON.stringify(body);
  }
  const resp = await fetch(url, opts);
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`Backend ${resp.status}: ${text.slice(0, 300)}`);
  }
  return resp.json();
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function getScholarsTabId() {
  const tabs = await chrome.tabs.query({ url: ['*://*.scholar-inbox.com/*', '*://scholar-inbox.com/*'] });
  if (!tabs.length) throw new Error('No Scholar Inbox tab found. Open scholar-inbox.com first.');
  return tabs[0].id;
}

async function fetchPDFBase64ViaContentScript(tabId, pdfUrl) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, { action: 'FETCH_PDF_BASE64', url: pdfUrl }, resp => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      if (!resp?.success) return reject(new Error(resp?.error || 'PDF fetch failed in content script'));
      resolve(resp.base64);
    });
  });
}

async function base64ToFormData(base64) {
  const binary = atob(base64);
  const buffer = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) buffer[i] = binary.charCodeAt(i);
  const blob     = new Blob([buffer], { type: 'application/pdf' });
  const file     = new File([blob], 'paper.pdf', { type: 'application/pdf' });
  const formData = new FormData();
  formData.append('file', file);
  return formData;
}

async function uploadPDF(paperId, pdfUrl, tabId) {
  let base64;
  try {
    base64 = await fetchPDFBase64ViaContentScript(tabId, pdfUrl);
  } catch (csErr) {
    console.warn('[ResearchAssistant] Content script PDF fetch failed, trying direct:', csErr.message);
    const resp = await fetch(pdfUrl, { redirect: 'follow' });
    if (!resp.ok) throw new Error(`Direct PDF fetch failed ${resp.status}: ${pdfUrl}`);
    const buf  = await resp.arrayBuffer();
    const u8   = new Uint8Array(buf);
    let bin = '';
    for (let i = 0; i < u8.length; i += 8192) bin += String.fromCharCode(...u8.subarray(i, i + 8192));
    base64 = btoa(bin);
  }
  const formData = await base64ToFormData(base64);
  return api(`/papers/${paperId}/pdf`, 'POST', formData);
}

async function registerPapers(papers) {
  return api('/papers', 'POST', papers.map(p => ({
    scholar_inbox_id: p.arxivId || null,
    title:            p.title,
    authors:          (p.authors || []).map(name => ({ name })),
    paper_url:        p.paperUrl  || null,
    pdf_url:          p.pdfUrl    || null,
    tags:             p.tags      || [],
    source_metadata:  { abstract: p.abstract || '', venue: p.venue || '', arxiv_id: p.arxivId || '' },
  })));
}

async function pollRun(runId) {
  for (let i = 0; i < 72; i++) {
    await sleep(5000);
    const run = await api(`/runs/${runId}`);
    await chrome.storage.local.set({ activeRun: { runId, status: run.status, run } });
    if (run.status === 'done' || run.status === 'failed') return run;
  }
  throw new Error('Analysis timed out after 6 minutes.');
}

async function comparePapers(paperIds) {
  const rows = [];
  for (const paperId of paperIds) {
    try {
      const summaries = await api(`/summaries/${paperId}`);
      const paper     = await api(`/papers/${paperId}`);
      if (summaries?.length) {
        rows.push({ paper, summary: summaries[0] });
      }
    } catch (e) {
      console.warn('[ResearchAssistant] compare: could not load', paperId, e.message);
    }
  }
  return rows;
}

async function handle(msg) {
  switch (msg.action) {

    case 'HEALTH_CHECK':
      return api('/health');

    case 'GET_SETTINGS': {
      const r = await chrome.storage.local.get('backendUrl');
      return { backendUrl: r.backendUrl || DEFAULT_BACKEND };
    }

    case 'SAVE_SETTINGS':
      await chrome.storage.local.set({ backendUrl: msg.backendUrl.replace(/\/$/, '') });
      return { saved: true };

    case 'GET_PAPERS': {
      const tabId = await getScholarsTabId();
      return new Promise((resolve, reject) => {
        chrome.tabs.sendMessage(tabId, { action: 'EXTRACT_PAPERS', days: msg.days || 1 }, resp => {
          if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
          if (!resp?.success)           return reject(new Error(resp?.error || 'Extraction failed'));
          resolve({ papers: resp.papers });
        });
      });
    }

    case 'START_ANALYSIS': {
      const papers = msg.papers;
      if (!papers?.length) throw new Error('No papers provided.');

      const tabId = await getScholarsTabId();

      await chrome.storage.local.set({ analysisPhase: 'registering' });
      const registrations = await registerPapers(papers);

      await chrome.storage.local.set({ analysisPhase: 'uploading' });
      const paperIds    = [];
      const uploadErrors = [];

      for (let i = 0; i < registrations.length; i++) {
        const reg   = registrations[i];
        const paper = papers[i];
        try {
          await uploadPDF(reg.paper_id, paper.pdfUrl, tabId);
          paperIds.push(reg.paper_id);
        } catch (e) {
          uploadErrors.push({ title: paper.title, error: e.message });
          console.warn('[ResearchAssistant] upload failed:', paper.title, '—', e.message);
        }
      }

      if (!paperIds.length) {
        const errDetail = uploadErrors.map(e => `• ${e.title}: ${e.error}`).join('\n');
        throw new Error(`All PDF uploads failed:\n${errDetail}`);
      }

      await chrome.storage.local.set({ analysisPhase: 'analyzing' });
      const runResp = await api('/analyze/summarize', 'POST', { paper_ids: paperIds });
      const runId   = runResp.run_id;

      await chrome.storage.local.set({ activeRun: { runId, status: 'running' }, lastRunId: runId, lastRunPaperIds: paperIds });

      pollRun(runId).catch(console.error);

      return { run_id: runId, paperIds, uploadErrors, started: true };
    }

    case 'POLL_RUN':
      return api(`/runs/${msg.runId}`);

    case 'GET_SUMMARIES':
      return api(`/summaries/${msg.paperId}`);

    case 'LIST_PAPERS':
      return api(`/papers?limit=${msg.limit || 100}&offset=${msg.offset || 0}`);

    case 'DELETE_PAPER':
      return api(`/papers/${msg.paperId}`, 'DELETE');

    case 'GET_ACTIVE_RUN': {
      const r = await chrome.storage.local.get('activeRun');
      return r.activeRun || null;
    }

    case 'GET_LAST_RUN_PAPER_IDS': {
      const r = await chrome.storage.local.get('lastRunPaperIds');
      return { paperIds: r.lastRunPaperIds || [] };
    }

    case 'CLEAR_ACTIVE_RUN':
      await chrome.storage.local.remove('activeRun');
      return { cleared: true };

    case 'COMPARE_PAPERS':
      return { rows: await comparePapers(msg.paperIds) };

    case 'KB_SEARCH': {
      const papersResp = await api('/papers?limit=200');
      const papers     = (papersResp.items || []).filter(p => p.status === 'summarized');
      const results    = [];
      for (const paper of papers) {
        const sResp = await api(`/summaries/${paper.id}`).catch(() => []);
        if (sResp?.length) results.push({ paper, summary: sResp[0] });
      }
      return { results };
    }

    default:
      throw new Error(`Unknown action: ${msg.action}`);
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  handle(msg)
    .then(sendResponse)
    .catch(err => sendResponse({ error: err.message }));
  return true;
});

chrome.action.onClicked.addListener(tab => {
  chrome.sidePanel.open({ windowId: tab.windowId });
});
