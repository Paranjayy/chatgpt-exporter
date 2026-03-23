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
    domProjects.forEach(p => projectMap[p.id] = { ...p, source: 'chatgpt' });

    if (token) {
      const apiProjects = await fetchProjects(token);
      apiProjects.forEach(p => { if (!projectMap[p.id]) projectMap[p.id] = { ...p, source: 'chatgpt' }; });
    }

    const merged = Object.values(projectMap);
    exportState.projects = merged;
    exportState.projectsLoaded = true;
    return merged;
  } else {
    // Gemini or Claude
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
        if (r?.projects) return r.projects;
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
    exportFormat: options.format || 'json'
  };
  sendStatus();

  try {
    if (options.scope.includes('current')) {
      // ... same
      let tabId = options.tabId;
      if (tabId === 'active' || tabId === 'current') tabId = (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id;
      const type = options.scope.split('_')[0];
      const chat = type === 'gemini' ? await getGeminiChatFromTab(tabId) : await getClaudeChatFromTab(tabId);
      if (chat) exportState.fullConversations = [chat];
      exportState.total = exportState.fullConversations.length;
    } 
    else if (options.selectedIds) {
      // Selective Picking
      const ids = options.selectedIds;
      const targets = exportState.projects.filter(p => ids.includes(p.id));
      exportState.total = targets.length;
      exportState.phase = 'fetching_chats';
      for (const entry of targets) {
        if (cancelSignal) break;
        exportState.currentChatTitle = `Scraping Selected: ${entry.title}`; sendStatus();
        try {
          const type = entry.source || (entry.id.includes('g-p-') ? 'chatgpt' : 'claude');
          const url = type === 'gemini' ? `https://gemini.google.com/app/${entry.id}` : 
                      (type === 'claude' ? `https://claude.ai/chat/${entry.id}` : `https://chatgpt.com/c/${entry.id}`);
          
          let chat;
          if (type === 'chatgpt') {
            const token = exportState.token || await getTokenFromTab();
            chat = await chatgptFetch(`/conversation/${entry.id}`, token);
          } else {
            chat = type === 'gemini' ? await navigateAndScrapeGemini(url) : await navigateAndScrapeClaude(url);
          }
          if (chat) exportState.fullConversations.push(chat);
        } catch (e) { exportState.errors.push(`${entry.title}: ${e.message}`); }
        exportState.fetched++; sendStatus();
      }
    }
    else if (options.scope.includes('history')) {
      // ... same
      const type = options.scope.split('_')[0];
      const history = exportState.projects.filter(p => !p.source || p.source === type);
      exportState.total = history.length;
      exportState.phase = 'fetching_chats';
      sendStatus();

      for (const entry of history) {
        if (cancelSignal) break;
        exportState.currentChatTitle = `Scraping: ${entry.title}`;
        sendStatus();
        try {
          const url = type === 'gemini' ? `https://gemini.google.com/app/${entry.id}` : `https://claude.ai/chat/${entry.id}`;
          const chat = type === 'gemini' ? await navigateAndScrapeGemini(url) : await navigateAndScrapeClaude(url);
          if (chat) exportState.fullConversations.push(chat);
        } catch (e) {
          exportState.errors.push(`"${entry.title}": ${e.message}`);
        }
        exportState.fetched++;
        sendStatus();
        await sleep(type === 'claude' ? 8000 : 5000); 
      }
    } else {
      // ChatGPT Standard (API)
      const token = exportState.token || await getTokenFromTab();
      if (!token && options.scope !== 'project') throw new Error('No ChatGPT authentication token found. Please open/refresh ChatGPT tab.');
      
      let convs = [];
      if (options.scope === 'projects_only') {
        const projectIds = exportState.projects.filter(p => (p.id.startsWith('g-p-') || p.gizmoId) && !p.source).map(p => p.id);
        for (const pid of projectIds) {
          try {
            const items = await fetchConversationList(token, { scope: 'project', projectId: pid });
            items.forEach(item => item.origProjectId = pid);
            convs.push(...items);
          } catch(e) { exportState.errors.push(`Project ${pid}: ${e.message}`); }
        }
      } else {
        convs = await fetchConversationList(token, options);
        if (options.projectId) convs.forEach(item => item.origProjectId = options.projectId);
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
        } catch (e) { exportState.errors.push(`${conv.title}: ${e.message}`); }
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

  if (convs.length === 1 && !options.includeAssets) {
     const chat = convs[0];
     let content, ext;
     if (fmt === 'json') { content = JSON.stringify(chat, null, 2); ext = 'json'; }
     else if (fmt === 'md') { content = formatToMarkdown(chat); ext = 'md'; }
     else if (fmt === 'html') { content = formatToHTML(chat); ext = 'html'; }
     else if (fmt === 'csv') { content = formatToCSV(chat); ext = 'csv'; }
     
     const dataUrl = `data:text/${ext === 'json' ? 'json' : ext};base64,` + btoa(unescape(encodeURIComponent(content)));
     chrome.downloads.download({ url: dataUrl, filename: `${safeFilename(chat.title || 'chat')}.${ext}` });
  } else {
    const files = [];
    for (const chat of convs) {
      if (cancelSignal) break;
      const safeTitle = safeFilename(chat.title || 'chat');
      let content;
      if (fmt === 'json') content = JSON.stringify(chat, null, 2);
      else if (fmt === 'md') content = formatToMarkdown(chat);
      else if (fmt === 'html') content = formatToHTML(chat);
      else content = formatToCSV(chat);
      
      files.push({ name: `${safeTitle}.${fmt}`, content });

      // Categorized Asset Processing
      if (options.includeAssets && (chat.mapping || chat.messages)) {
        const msgs = chat.mapping ? Object.values(chat.mapping).filter(n => n.message).map(n => n.message) : chat.messages;
        for (const m of msgs) {
          if (m.metadata?.attachments) {
            for (const a of m.metadata.attachments) {
              if (a.url) {
                const ext = a.name?.split('.').pop() || 'png';
                const isImg = ['png','jpg','jpeg','gif','webp','svg'].includes(ext.toLowerCase());
                const folder = isImg ? 'images/' : (['pdf','txt','doc','docx'].includes(ext.toLowerCase()) ? 'docs/' : 'other/');
                files.push({ name: `assets/${folder}${a.name || `file_${Math.random().toString(36).slice(2,8)}.${ext}`}`, url: a.url });
              }
            }
          }
        }
      }
      exportState.saved++;
      sendStatus();
    }
    await createZipViaOffscreen(files, zipName);
    exportState.zipName = zipName;
  }
  
  exportState.running = false;
  exportState.phase = 'done';
  exportState.finishedAt = Date.now();
  sendStatus();
}

// ─── Formatting helpers ────────────────────────────────────────────────────────
function formatToMarkdown(chat) {
  let md = `---\ntitle: ${chat.title || 'Untitled'}\nexported: ${new Date().toISOString()}\n---\n\n# ${chat.title || 'Chat'}\n\n`;
  const msgs = chat.mapping ? 
    Object.values(chat.mapping).filter(n => n.message && n.message.author.role !== 'system').map(n => n.message) : 
    chat.messages;
  
  if (!msgs) return md;
  
  for (const m of msgs) {
    const role = (m.author?.role || m.role || 'user').toUpperCase();
    let text = m.content?.parts?.join('\n') || m.text || '';
    
    // Categorized Obsidian Interlinking
    if (m.metadata?.attachments) {
       m.metadata.attachments.forEach((a, i) => {
         const ext = a.name?.split('.').pop() || 'png';
         const isImg = ['png','jpg','jpeg','gif','webp','svg'].includes(ext.toLowerCase());
         const folder = isImg ? 'images/' : (['pdf','txt','doc','docx'].includes(ext.toLowerCase()) ? 'docs/' : 'other/');
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
  let html = `<html><head><title>${safeTitle}</title><style>body{font-family:sans-serif;max-width:800px;margin:2em auto;line-height:1.6;background:#111;color:#eee}.msg{margin:1em 0;padding:1.5em;border-radius:12px;border:1px solid #333}.user{background:#1a1a1a}.assistant{background:#222;border-color:#10a37f}</style></head><body><h1>${safeTitle}</h1>`;
  const msgs = chat.mapping ? Object.values(chat.mapping).filter(n => n.message).map(n => n.message) : chat.messages;
  if (msgs) {
    for (const m of msgs) {
      const role = m.author?.role || m.role || 'user';
      const text = m.content?.parts?.join('<br>') || m.text || '';
      html += `<div class="msg ${role}"><strong>${role.toUpperCase()}</strong><p>${escHtml(text).replace(/\n/g, '<br>')}</p></div>`;
    }
  }
  html += `</body></html>`;
  return html;
}

function formatToCSV(chat) {
  let csv = "Role,Content\n";
  const msgs = chat.mapping ? Object.values(chat.mapping).filter(n => n.message).map(n => n.message) : chat.messages;
  if (msgs) {
    for (const m of msgs) {
      const role = (m.author?.role || m.role || 'user').toUpperCase();
      const text = (m.content?.parts?.join('\n') || m.text || '').replace(/"/g, '""');
      csv += `"${role}","${text}"\n`;
    }
  }
  return csv;
}

// ─── Nav Scraper Helpers ──────────────────────────────────────────────────────
async function navigateAndScrapeClaude(url) {
  const tab = await chrome.tabs.create({ url, active: false });
  await sleep(10000); 
  try {
    const r = await chrome.tabs.sendMessage(tab.id, { type: 'SCRAPE_CLAUDE_CHAT' });
    if (tab.id) chrome.tabs.remove(tab.id);
    if (!r?.messages || r.messages.length === 0) throw new Error('Harvester returned 0 messages.');
    return { title: r.title, messages: r.messages };
  } catch (e) {
    if (tab.id) chrome.tabs.remove(tab.id);
    throw e;
  }
}

async function navigateAndScrapeGemini(url) {
  const tab = await chrome.tabs.create({ url, active: false });
  await sleep(8000);
  try {
    const r = await chrome.tabs.sendMessage(tab.id, { type: 'SCRAPE_GEMINI_CHAT' });
    if (tab.id) chrome.tabs.remove(tab.id);
    if (!r?.messages || r.messages.length === 0) throw new Error('Harvester returned 0 messages.');
    return { title: r.title, messages: r.messages };
  } catch (e) {
    if (tab.id) chrome.tabs.remove(tab.id);
    throw e;
  }
}

async function getClaudeChatFromTab(tabId) {
  const r = await chrome.tabs.sendMessage(tabId, { type: 'SCRAPE_CLAUDE_CHAT' });
  if (!r?.messages) throw new Error('Claude Harvester failed');
  return { title: r.title, messages: r.messages };
}

async function getGeminiChatFromTab(tabId) {
  const r = await chrome.tabs.sendMessage(tabId, { type: 'SCRAPE_GEMINI_CHAT' });
  if (!r?.messages) throw new Error('Gemini Harvester failed');
  return { title: r.title, messages: r.messages };
}

// ─── Offscreen & API Support ──────────────────────────────────────────────────
async function createZipViaOffscreen(fileList, zipFilename) {
  const offscreenUrl = chrome.runtime.getURL('offscreen.html');
  const existing = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'], documentUrls: [offscreenUrl] }).catch(() => []);
  if (!existing.length) await chrome.offscreen.createDocument({ url: 'offscreen.html', reasons: ['BLOBS', 'DOM_SCRAPING'], justification: 'ZIP building' });
  return chrome.runtime.sendMessage({ type: 'CREATE_ZIP_BLOB', files: fileList, filename: zipFilename });
}

async function getTokenFromTab() {
  const tabs = await chrome.tabs.query({ url: 'https://chatgpt.com/*' });
  for (const t of tabs) {
    try {
      const r = await chrome.tabs.sendMessage(t.id, { type: 'GET_TOKEN' });
      if (r?.token) return r.token;
    } catch(_) {}
  }
  return null;
}

async function fetchConversationList(token, options) {
   let path = '/conversations?offset=0&limit=100&order=updated';
   
   if (options.scope === 'project' && options.projectId) {
     const pid = options.projectId;
     if (pid.startsWith('g-p-')) {
       path = `/conversations?offset=0&limit=100&order=updated&category=gizmo&gizmo_id=${pid}`;
     } else {
       path += `&workspace_id=${pid}`;
     }
   }
   
   try {
     const res = await chatgptFetch(path, token);
     return res?.items || [];
   } catch(e) {
     console.error('Fetch Error:', e);
     return [];
   }
}

async function chatgptFetch(path, token) {
  const url = path.startsWith('http') ? path : `https://chatgpt.com/backend-api${path}`;
  const res = await fetch(url, { headers: { 'Authorization': `Bearer ${token}` } });
  if (!res.ok) throw new Error(`API Error: ${res.status}`);
  return res.json();
}

async function fetchProjects(token) { return []; } 

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function escHtml(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function safeFilename(s) { return String(s).replace(/[^a-zA-Z0-9\-_ ]/g,'_').replace(/\s+/g,'_').slice(0,80); }
