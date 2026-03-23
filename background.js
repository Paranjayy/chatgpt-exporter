// background.js — the brain of the ChatGPT Exporter
let exportState = {
  running: false,
  total: 0,
  fetched: 0,
  saved: 0,
  phase: 'idle',
  errors: [],
  startedAt: null,
  finishedAt: null,
  fullConversations: [],
  currentChatTitle: '',
  zipName: '',
  token: null,
  projects: [],
  projectsRaw: null,
  projectsLoaded: false,
};

let cancelSignal = false;
let currentOptions = null;

function sendStatus() {
  chrome.runtime.sendMessage({ type: 'STATUS_UPDATE', state: exportState });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'GET_STATUS') {
    sendResponse(exportState);
    return true;
  }

  if (msg.type === 'CANCEL_EXPORT') {
    cancelSignal = true;
    if (exportState.fullConversations.length > 0) {
      finalizeZip(currentOptions || {}).then(() => {
        exportState.running = false;
        exportState.phase = 'done';
        sendStatus();
      });
    } else {
      exportState.running = false;
      exportState.phase = 'idle';
      sendStatus();
    }
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === 'LOAD_PROJECTS') {
    loadProjects(msg.platform || 'chatgpt')
      .then(projects => sendResponse({ projects, raw: exportState.projectsRaw }))
      .catch(e => sendResponse({ projects: [], error: e.message }));
    return true;
  }

  if (msg.type === 'START_EXPORT') {
    cancelSignal = false;
    currentOptions = msg.options;
    startExport(msg.options);
    sendResponse({ started: true });
    return true;
  }

  if (msg.type === 'OPEN_DASHBOARD') {
    chrome.tabs.create({ url: 'dashboard.html' });
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === 'RESET_STATE') {
    exportState = { ...exportState, running: false, phase: 'idle', fullConversations: [], fetched: 0, total: 0, errors: [], zipName: '' };
    sendStatus();
    sendResponse({ ok: true });
    return true;
  }
});

// ─── Platform Aware Discovery ──────────────────────────────────────────────────
async function loadProjects(platform = 'chatgpt') {
  exportState.phase = 'fetching_projects';
  sendStatus();

  if (platform === 'chatgpt') {
    const token = await getTokenFromTab();
    if (token) exportState.token = token;

    const projectMap = {};
    const domProjects = await getProjectsFromDOM(platform);
    domProjects.forEach(p => { projectMap[p.id] = { ...p, source: 'chatgpt' }; });

    if (token) {
      const apiProjects = await fetchProjects(token);
      apiProjects.forEach(p => { if (!projectMap[p.id]) projectMap[p.id] = { ...p, source: 'chatgpt' }; });
    }

    const merged = Object.values(projectMap);
    exportState.projects = merged;
    exportState.projectsLoaded = true;
    return merged;
  } else {
    // Gemini or Claude — scrape sidebar from open tab
    const domProjects = await getProjectsFromDOM(platform);
    exportState.projects = domProjects;
    exportState.projectsLoaded = true;
    return domProjects;
  }
}

async function getProjectsFromDOM(platform) {
  const urlPattern = platform === 'gemini'
    ? 'https://gemini.google.com/*'
    : (platform === 'claude' ? 'https://claude.ai/*' : 'https://chatgpt.com/*');

  try {
    const tabs = await chrome.tabs.query({ url: urlPattern });
    for (const tab of tabs) {
      try {
        const r = await chrome.tabs.sendMessage(tab.id, { type: 'GET_PROJECTS_FROM_DOM' });
        if (r?.projects?.length) return r.projects;
      } catch (_) {}
    }
  } catch (_) {}
  return [];
}

// ─── Export Logic ──────────────────────────────────────────────────────────────
async function startExport(options) {
  if (exportState.running) return;

  exportState = {
    ...exportState,
    running: true,
    phase: 'initializing',
    errors: [],
    startedAt: Date.now(),
    fetched: 0,
    saved: 0,
    fullConversations: [],
    currentChatTitle: '',
    exportFormat: options.format || 'json',
  };
  sendStatus();

  try {
    if (options.scope.includes('current')) {
      let tabId = options.tabId;
      if (tabId === 'active' || tabId === 'current') {
        tabId = (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id;
      }
      const type = options.scope.split('_')[0];
      let chat;
      if (type === 'gemini') {
        chat = await getGeminiChatFromTab(tabId);
      } else if (type === 'claude') {
        chat = await getClaudeChatFromTab(tabId);
      } else {
        // chatgpt: use API with conversation ID from tab URL
        const token = exportState.token || await getTokenFromTab();
        if (!token) console.warn('[ChatGPT Exporter] No cached token; falling back to tab discovery.');
        const tab = await chrome.tabs.get(tabId).catch(() => null);
        const chatIdMatch = (tab?.url || '').match(/\/c\/([a-z0-9-]+)/);
        if (chatIdMatch && token) {
          chat = await chatgptFetch(`/conversation/${chatIdMatch[1]}`, token);
        } else {
          throw new Error('Could not determine current ChatGPT conversation. Please open a specific chat first.');
        }
      }
      if (chat) exportState.fullConversations = [chat];
      exportState.total = exportState.fullConversations.length;

    } else if (options.selectedIds) {
      // Selective picking
      const ids = options.selectedIds;
      const targets = exportState.projects.filter(p => ids.includes(p.id));
      exportState.total = targets.length;
      exportState.phase = 'fetching_chats';
      for (const entry of targets) {
        if (cancelSignal) break;
        exportState.currentChatTitle = `Scraping: ${entry.title}`;
        sendStatus();
        try {
          const type = entry.source || (entry.id.includes('g-p-') ? 'chatgpt' : 'claude');
          const url = type === 'gemini'
            ? `https://gemini.google.com/app/${entry.id}`
            : (type === 'claude' ? `https://claude.ai/chat/${entry.id}` : `https://chatgpt.com/c/${entry.id}`);

          let chat;
          if (type === 'chatgpt') {
            const token = exportState.token || await getTokenFromTab();
            chat = await chatgptFetch(`/conversation/${entry.id}`, token);
          } else {
            chat = type === 'gemini'
              ? await navigateAndScrape(url, 'SCRAPE_GEMINI_CHAT', entry.title)
              : await navigateAndScrape(url, 'SCRAPE_CLAUDE_CHAT', entry.title);
          }
          if (chat) exportState.fullConversations.push(chat);
        } catch (e) {
          exportState.errors.push(`${entry.title}: ${e.message}`);
        }
        exportState.fetched++;
        sendStatus();
      }

    } else if (options.scope.includes('history')) {
      // Gemini or Claude full history scrape
      const type = options.scope.split('_')[0]; // 'gemini' | 'claude'

      // Auto-load projects if not yet done
      if (!exportState.projectsLoaded || exportState.projects.filter(p => p.source === type).length === 0) {
        await loadProjects(type);
      }

      const history = exportState.projects.filter(p => p.source === type);
      exportState.total = history.length;
      exportState.phase = 'fetching_chats';
      sendStatus();

      if (history.length === 0) {
        exportState.errors.push(`No ${type} conversations found in sidebar. Open a ${type} tab with conversations visible first.`);
      }

      for (const entry of history) {
        if (cancelSignal) break;
        exportState.currentChatTitle = `Scraping: ${entry.title}`;
        sendStatus();
        try {
          const url = type === 'gemini'
            ? `https://gemini.google.com/app/${entry.id}`
            : `https://claude.ai/chat/${entry.id}`;
          const msgType = type === 'gemini' ? 'SCRAPE_GEMINI_CHAT' : 'SCRAPE_CLAUDE_CHAT';
          const chat = await navigateAndScrape(url, msgType, entry.title);
          if (chat) exportState.fullConversations.push(chat);
        } catch (e) {
          exportState.errors.push(`"${entry.title}": ${e.message}`);
        }
        exportState.fetched++;
        sendStatus();
        await sleep(type === 'claude' ? 6000 : 4000);
      }

    } else {
      // ChatGPT standard (API-based)
      const token = exportState.token || await getTokenFromTab();
      if (!token) throw new Error('No ChatGPT authentication token found. Please open/refresh chatgpt.com.');

      // Auto-load projects if needed
      if (!exportState.projectsLoaded) {
        await loadProjects('chatgpt');
      }

      let convs = [];
      if (options.scope === 'projects_only') {
        exportState.phase = 'fetching_chats';
        sendStatus();
        const projectIds = exportState.projects
          .filter(p => p.source === 'chatgpt')
          .map(p => p.id);
        for (const pid of projectIds) {
          if (cancelSignal) break;
          try {
            const items = await fetchAllConversations(token, { scope: 'project', projectId: pid });
            items.forEach(item => { item.origProjectId = pid; });
            convs.push(...items);
          } catch (e) {
            exportState.errors.push(`Project ${pid}: ${e.message}`);
          }
        }
      } else {
        convs = await fetchAllConversations(token, options);
        if (options.projectId) convs.forEach(item => { item.origProjectId = options.projectId; });
      }

      exportState.total = convs.length;
      exportState.phase = 'fetching_chats';
      sendStatus();

      for (const conv of convs) {
        if (cancelSignal) break;
        exportState.currentChatTitle = `Downloading: ${conv.title}`;
        sendStatus();
        try {
          let detailPath = `/conversation/${conv.id}`;
          if (conv.origProjectId) detailPath += `?workspace_id=${conv.origProjectId}`;
          const full = await chatgptFetch(detailPath, token);
          exportState.fullConversations.push(full);
        } catch (e) {
          exportState.errors.push(`${conv.title}: ${e.message}`);
        }
        exportState.fetched++;
        sendStatus();
        await sleep(Math.random() * 200 + 100);
      }
    }

    if (!cancelSignal) await finalizeZip(options);
  } catch (e) {
    exportState.errors.push('Export Failed: ' + e.message);
    exportState.running = false;
    exportState.phase = 'done';
    sendStatus();
  }
}

async function finalizeZip(options) {
  exportState.phase = 'saving';
  sendStatus();

  const convs = exportState.fullConversations;
  const fmt = exportState.exportFormat;
  const zipName = `export-${new Date().toISOString().split('T')[0]}.${fmt}.zip`;

  const files = [];
  const historyRecords = [];

  for (const chat of convs) {
    if (cancelSignal) break;
    const safeTitle = safeFilename(chat.title || 'chat');
    let content;
    if (fmt === 'json') content = JSON.stringify(chat, null, 2);
    else if (fmt === 'md') content = formatToMarkdown(chat);
    else if (fmt === 'html') content = formatToHTML(chat);
    else content = formatToCSV(chat);

    files.push({ name: `${safeTitle}.${fmt}`, content });

    // Collect assets
    if (options.includeAssets && (chat.mapping || chat.messages)) {
      const msgs = chat.mapping
        ? Object.values(chat.mapping).filter(n => n.message).map(n => n.message)
        : (chat.messages || []);
      for (const m of msgs) {
        if (m.metadata?.attachments) {
          for (const a of m.metadata.attachments) {
            if (a.url) {
              const ext = (a.name?.split('.').pop() || 'png').toLowerCase();
              const isImg = ['png','jpg','jpeg','gif','webp','svg'].includes(ext);
              const folder = isImg ? 'images/' : (['pdf','txt','doc','docx'].includes(ext) ? 'docs/' : 'other/');
              files.push({
                name: `assets/${folder}${a.name || `file_${Math.random().toString(36).slice(2,8)}.${ext}`}`,
                url: a.url
              });
            }
          }
        }
      }
    }

    // Build history record for dashboard
    const allMsgs = chat.mapping
      ? Object.values(chat.mapping).filter(n => n.message).map(n => n.message)
      : (chat.messages || []);
    const firstUser = allMsgs.find(m => (m.author?.role || m.role) === 'user');
    const snippet = (firstUser?.content?.parts?.join(' ') || firstUser?.text || '').slice(0, 200);
    const wordCount = allMsgs.reduce((acc, m) => {
      const t = m.content?.parts?.join(' ') || m.text || '';
      return acc + t.split(/\s+/).filter(Boolean).length;
    }, 0);
    historyRecords.push({
      id: chat.id || chat.conversation_id || safeTitle,
      title: chat.title || 'Untitled',
      project: options.projectId || options.scope || 'General',
      createdAt: chat.create_time || (Date.now() / 1000),
      wordCount,
      promptSnippet: snippet,
      keywords: extractKeywords(snippet),
    });

    exportState.saved++;
    sendStatus();
  }

  await createZipViaOffscreen(files, zipName);
  exportState.zipName = zipName;

  // Persist history to storage for dashboard
  await saveHistoryToStorage(historyRecords);

  exportState.running = false;
  exportState.phase = 'done';
  exportState.finishedAt = Date.now();
  sendStatus();
}

// ─── Formatting helpers ────────────────────────────────────────────────────────
function formatToMarkdown(chat) {
  let md = `---\ntitle: ${chat.title || 'Untitled'}\nexported: ${new Date().toISOString()}\n---\n\n# ${chat.title || 'Chat'}\n\n`;
  const msgs = chat.mapping
    ? Object.values(chat.mapping)
        .filter(n => n.message && n.message.author?.role !== 'system')
        .sort((a, b) => (a.message.create_time || 0) - (b.message.create_time || 0))
        .map(n => n.message)
    : (chat.messages || []);

  if (!msgs.length) return md + '_No messages found._\n';

  for (const m of msgs) {
    const role = (m.author?.role || m.role || 'user').toUpperCase();
    let text = m.content?.parts?.filter(p => typeof p === 'string').join('\n') || m.text || '';

    if (m.metadata?.attachments) {
      m.metadata.attachments.forEach((a, i) => {
        const ext = (a.name?.split('.').pop() || 'png').toLowerCase();
        const isImg = ['png','jpg','jpeg','gif','webp','svg'].includes(ext);
        const folder = isImg ? 'images/' : (['pdf','txt','doc','docx'].includes(ext) ? 'docs/' : 'other/');
        const name = a.name || `attachment_${i}`;
        text += `\n\n![[assets/${folder}${name}]]\n*Source: ${a.url || 'Internal'}*`;
      });
    }

    md += `### ${role}\n${text}\n\n---\n\n`;
  }
  return md;
}

function formatToHTML(chat) {
  const safeTitle = escHtml(chat.title || 'Chat');
  let html = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>${safeTitle}</title><style>body{font-family:sans-serif;max-width:800px;margin:2em auto;line-height:1.6;background:#111;color:#eee}.msg{margin:1em 0;padding:1.5em;border-radius:12px;border:1px solid #333}.user{background:#1a1a1a}.assistant{background:#222;border-color:#10a37f}.tool,.system{background:#1c1c1c;border-color:#444;opacity:0.7}</style></head><body><h1>${safeTitle}</h1>`;
  const msgs = chat.mapping
    ? Object.values(chat.mapping)
        .filter(n => n.message)
        .sort((a, b) => (a.message.create_time || 0) - (b.message.create_time || 0))
        .map(n => n.message)
    : (chat.messages || []);
  for (const m of msgs) {
    const role = m.author?.role || m.role || 'user';
    const text = m.content?.parts?.filter(p => typeof p === 'string').join('<br>') || m.text || '';
    html += `<div class="msg ${role}"><strong>${role.toUpperCase()}</strong><p>${escHtml(text).replace(/\n/g, '<br>')}</p></div>`;
  }
  html += '</body></html>';
  return html;
}

function formatToCSV(chat) {
  let csv = 'Role,Content\n';
  const msgs = chat.mapping
    ? Object.values(chat.mapping)
        .filter(n => n.message)
        .sort((a, b) => (a.message.create_time || 0) - (b.message.create_time || 0))
        .map(n => n.message)
    : (chat.messages || []);
  for (const m of msgs) {
    const role = (m.author?.role || m.role || 'user').toUpperCase();
    const text = (m.content?.parts?.filter(p => typeof p === 'string').join('\n') || m.text || '').replace(/"/g, '""');
    csv += `"${role}","${text}"\n`;
  }
  return csv;
}

// ─── Robust tab scraping (retry loop) ────────────────────────────────────────
async function navigateAndScrape(url, msgType, label = '') {
  const tab = await chrome.tabs.create({ url, active: false });
  let lastErr = new Error('Content script never responded');

  for (let attempt = 0; attempt < 8; attempt++) {
    await sleep(attempt === 0 ? 3000 : 2000);
    try {
      const r = await chrome.tabs.sendMessage(tab.id, { type: msgType });
      if (r?.messages?.length > 0) {
        chrome.tabs.remove(tab.id).catch(() => {});
        return { title: r.title || label, messages: r.messages };
      }
      lastErr = new Error(`Scraper returned 0 messages on attempt ${attempt + 1}`);
    } catch (e) {
      lastErr = e;
    }
  }
  chrome.tabs.remove(tab.id).catch(() => {});
  throw lastErr;
}

// Keep backward-compat wrappers
async function navigateAndScrapeGemini(url) { return navigateAndScrape(url, 'SCRAPE_GEMINI_CHAT'); }
async function navigateAndScrapeClaude(url) { return navigateAndScrape(url, 'SCRAPE_CLAUDE_CHAT'); }

async function getClaudeChatFromTab(tabId) {
  const r = await chrome.tabs.sendMessage(tabId, { type: 'SCRAPE_CLAUDE_CHAT' });
  if (!r?.messages?.length) throw new Error('Claude scraper returned no messages');
  return { title: r.title, messages: r.messages };
}

async function getGeminiChatFromTab(tabId) {
  const r = await chrome.tabs.sendMessage(tabId, { type: 'SCRAPE_GEMINI_CHAT' });
  if (!r?.messages?.length) throw new Error('Gemini scraper returned no messages');
  return { title: r.title, messages: r.messages };
}

// ─── Offscreen & ZIP Support ──────────────────────────────────────────────────
async function createZipViaOffscreen(fileList, zipFilename) {
  const offscreenUrl = chrome.runtime.getURL('offscreen.html');
  const existing = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [offscreenUrl],
  }).catch(() => []);
  if (!existing.length) {
    await chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['BLOBS', 'DOM_SCRAPING'],
      justification: 'ZIP building',
    });
  }
  return chrome.runtime.sendMessage({ type: 'CREATE_ZIP_BLOB', files: fileList, filename: zipFilename });
}

async function getTokenFromTab() {
  const tabs = await chrome.tabs.query({ url: 'https://chatgpt.com/*' });
  for (const t of tabs) {
    try {
      const r = await chrome.tabs.sendMessage(t.id, { type: 'GET_TOKEN' });
      if (r?.token) return r.token;
    } catch (_) {}
  }
  return null;
}

// ─── Paginated conversation list ──────────────────────────────────────────────
async function fetchAllConversations(token, options) {
  const results = [];
  const pid = options.projectId;
  const limit = 100;
  let offset = 0;

  while (true) {
    let path;
    if (options.scope === 'project' && pid) {
      path = pid.startsWith('g-p-')
        ? `/conversations?offset=${offset}&limit=${limit}&order=updated&category=gizmo&gizmo_id=${pid}`
        : `/conversations?offset=${offset}&limit=${limit}&order=updated&workspace_id=${pid}`;
    } else {
      path = `/conversations?offset=${offset}&limit=${limit}&order=updated`;
    }

    let res;
    try {
      res = await chatgptFetch(path, token);
    } catch (e) {
      break;
    }

    const items = res?.items || [];
    if (items.length === 0) break;
    results.push(...items);

    // Check if there are more pages
    const total = res?.total ?? res?.offset ?? null;
    if (items.length < limit) break;
    if (total !== null && results.length >= total) break;
    offset += items.length;
  }

  return results;
}

// Keep backward-compat alias
async function fetchConversationList(token, options) {
  return fetchAllConversations(token, options);
}

// ─── ChatGPT API helpers ──────────────────────────────────────────────────────
async function chatgptFetch(path, token) {
  const url = path.startsWith('http') ? path : `https://chatgpt.com/backend-api${path}`;
  const res = await fetch(url, { headers: { 'Authorization': `Bearer ${token}` } });
  if (!res.ok) throw new Error(`API Error: ${res.status}`);
  return res.json();
}

async function fetchProjects(token) {
  const projects = [];
  const seen = new Set();

  const addItem = (id, title, extra = {}) => {
    if (id && !seen.has(id)) {
      seen.add(id);
      projects.push({ id, title, ...extra });
    }
  };

  // 1. Gizmos / GPTs
  try {
    const gizmos = await chatgptFetch('/gizmos/bootstrap', token);
    if (gizmos?.items) {
      gizmos.items.forEach(item => {
        const id = item.gizmo?.id || item.id;
        addItem(id, item.gizmo?.display?.name || item.name, { gizmoId: id });
      });
    }
  } catch (e) { console.warn('Gizmo fetch failed:', e.message); }

  // 2. Real ChatGPT Projects (Projects feature)
  try {
    const projectsResp = await chatgptFetch('/projects?limit=50', token);
    if (projectsResp?.items) {
      projectsResp.items.forEach(item => {
        addItem(item.id, item.name || item.title, { isProject: true });
      });
    }
  } catch (e) { /* endpoint may not exist for all accounts */ }

  // 3. Workspaces via accounts list
  try {
    const accounts = await chatgptFetch('/accounts', token);
    const workspaces = accounts?.workspace_accounts || accounts?.items || [];
    workspaces.forEach(ws => {
      addItem(ws.id || ws.account_id, ws.name || ws.email, { isWorkspace: true });
    });
  } catch (e) {}

  return projects;
}

// ─── Storage helpers ──────────────────────────────────────────────────────────
async function saveHistoryToStorage(newRecords) {
  if (!newRecords.length) return;
  return new Promise(resolve => {
    chrome.storage.local.get(['history', 'totalChatsExported'], res => {
      const existing = res.history || [];
      const existingIds = new Set(existing.map(r => r.id));
      const fresh = newRecords.filter(r => !existingIds.has(r.id));
      const merged = [...fresh, ...existing].slice(0, 2000); // cap at 2k entries
      const total = (res.totalChatsExported || 0) + fresh.length;
      chrome.storage.local.set({ history: merged, totalChatsExported: total }, resolve);
    });
  });
}

function extractKeywords(text) {
  if (!text) return [];
  const stopWords = new Set(['the','a','an','is','in','it','of','to','and','or','for','on','with','that','this','be','as','at','from','by']);
  return [...new Set(
    text.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/)
      .filter(w => w.length > 3 && !stopWords.has(w))
  )].slice(0, 8);
}

// ─── Utilities ────────────────────────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function escHtml(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function safeFilename(s) { return String(s).replace(/[^a-zA-Z0-9\-_ ]/g, '_').replace(/\s+/g, '_').slice(0, 80); }
