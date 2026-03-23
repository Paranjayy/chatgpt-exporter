// Background service worker  ChatGPT Exporter
// No external deps; no Blob/URL.createObjectURL (not available in SW)

/** Platform specific domains */
const DOMAINS = {
  CHATGPT: 'chatgpt.com',
  GEMINI: 'gemini.google.com',
  CLAUDE: 'claude.ai'
};

const CHATGPT_BASE_URL = 'https://chatgpt.com/backend-api';
const PAGE_SIZE = 100;

// ─── Files Collector (prepares files for offscreen JSZip) ─────────────────────
class FilesCollector {
  constructor() { this.files = []; }
  add(name, content) {
    const data = typeof content === 'string' ? new TextEncoder().encode(content) : content;
    this.files.push({ name, data });
    return this;
  }
  toFileList() {
    return this.files.map(f => ({ 
        name: f.name, 
        dataB64: uint8ToBase64(new Uint8Array(f.data))
    }));
  }
}

/** Helper for compact Base64 encoding in SW */
function uint8ToBase64(bytes) {
  let binary = '';
  const CHUNK = 8192;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

// 
//  State 
// 

let exportState = {
  running: false,
  token: null,
  total: 0,
  fetched: 0,
  saved: 0,          // files added to zip
  errors: [],
  phase: 'idle',     // idle|fetching_list|fetching_chats|saving|done
  conversations: [],
  fullConversations: [],
  exportFormat: 'json',
  startedAt: null,
  finishedAt: null,
  zipName: null,
  // Projects
  projects: [],
  projectsLoaded: false,
  projectsRaw: null,  // raw API response for debugging
};

function sendStatus(extra = {}) {
  chrome.runtime.sendMessage({
    type: 'STATUS_UPDATE',
    state: {
      running:        exportState.running,
      total:          exportState.total,
      fetched:        exportState.fetched,
      saved:          exportState.saved,
      phase:          exportState.phase,
      errors:         exportState.errors,
      startedAt:      exportState.startedAt,
      finishedAt:     exportState.finishedAt,
      zipName:        exportState.zipName,
      projects:       exportState.projects,
      projectsLoaded: exportState.projectsLoaded,
      projectsRaw:    exportState.projectsRaw,
      ...extra,
    }
  }).catch(() => {});
}

// 
//  Network helpers 
// 

async function chatgptFetch(path, token, raw = false) {
  const res = await fetch(`${CHATGPT_BASE_URL}${path}`, {
    headers: { 'Authorization': `Bearer ${token}` },
    credentials: 'include',
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${path}`);
  return raw ? res : res.json();
}

async function fetchBytes(url, token) {
  const isOAI = url.includes('oaistatic.com') || url.includes('oaiusercontent.com') || url.includes('chatgpt.com');
  const headers = {};
  if (isOAI && token) headers['Authorization'] = `Bearer ${token}`;
  
  const resp = await fetch(url, { headers });
  if (!resp.ok) {
    if (resp.status === 401) throw new Error('HTTP 401 (Auth required)');
    if (resp.status === 403) throw new Error('HTTP 403 (Access denied)');
    throw new Error(`HTTP ${resp.status}`);
  }
  return new Uint8Array(await resp.arrayBuffer());
}

async function getTokenFromTab() {
  const tabs = await chrome.tabs.query({ url: 'https://chatgpt.com/*' });
  for (const tab of tabs) {
    try {
      const r = await chrome.tabs.sendMessage(tab.id, { type: 'GET_TOKEN' });
      if (r?.token) return r.token;
    } catch (_) {}
  }
  return null;
}

// ─── Gemini Support (Scraping Based) ─────────────────────────────────────────

async function navigateAndScrapeGemini(url) {
  return new Promise((resolve, reject) => {
    chrome.tabs.create({ url, active: false }, (tab) => {
      const fn = (tabId, info) => {
        if (tabId === tab.id && info.status === 'complete') {
          chrome.tabs.onUpdated.removeListener(fn);
          // Wait for the JS to render messages
          setTimeout(async () => {
            try {
              const r = await chrome.tabs.sendMessage(tab.id, { type: 'SCRAPE_GEMINI_CHAT' });
              chrome.tabs.remove(tab.id);
              resolve(r?.chat || null);
            } catch (e) {
                chrome.tabs.remove(tab.id);
                reject(e);
            }
          }, 3500); 
        }
      };
      chrome.tabs.onUpdated.addListener(fn);
    });
  });
}

async function getGeminiChatFromTab(tabId) {
  return new Promise(async (resolve, reject) => {
    try {
      chrome.tabs.sendMessage(tabId, { type: 'SCRAPE_GEMINI_CHAT' }, (resp) => {
        if (!chrome.runtime.lastError && resp?.messages) {
          const chat = { 
              id: 'gemini-'+Date.now(), 
              title: 'Google Gemini', 
              mapping: resp.messages.map((m,i)=>({ id:i, message:{ author:{ role:m.role }, content:{ parts:[m.text], images:m.images||[] }, create_time:m.created }})) 
          };
          return resolve(chat);
        }
        reject(new Error('Gemini Harvester failed to respond. Refresh and try again?'));
      });
    } catch (e) { reject(e); }
  });
}

async function getClaudeChatFromTab(tabId) {
    return new Promise(async (resolve, reject) => {
      try {
        chrome.tabs.sendMessage(tabId, { type: 'SCRAPE_CLAUDE_CHAT' }, (resp) => {
          if (!chrome.runtime.lastError && resp?.messages) {
            const chat = { 
                id: 'claude-'+Date.now(), 
                title: 'Claude AI', 
                mapping: resp.messages.map((m,i)=>({ id:i, message:{ author:{ role:m.role }, content:{ parts:[m.text], images:m.images||[] }, create_time:m.created }})) 
            };
            return resolve(chat);
          }
          reject(new Error('Claude Harvester failed to respond. Refresh and try again?'));
        });
      } catch (e) { reject(e); }
    });
}

async function navigateAndScrapeGemini(url) {
    const tab = await chrome.tabs.create({ url, active: false });
    await sleep(2500); // Wait for Gemini's heavy React/MD3 load
    try {
        const chat = await getGeminiChatFromTab(tab.id);
        chrome.tabs.remove(tab.id);
        return chat;
    } catch (e) {
        chrome.tabs.remove(tab.id);
        throw e;
    }
}

async function navigateAndScrapeClaude(url) {
    const tab = await chrome.tabs.create({ url, active: false });
    await sleep(3000); // Claude is React-heavy
    try {
        const chat = await getClaudeChatFromTab(tab.id);
        chrome.tabs.remove(tab.id);
        return chat;
    } catch (e) {
        chrome.tabs.remove(tab.id);
        throw e;
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// ─── Projects ───────────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════

async function fetchProjects(token) {
  // ChatGPT projects are stored as gizmos with the prefix 'g-p-'
  // Primary: fetch gizmos the user has created/used that are projects
  const gizmoEndpoints = [
    '/gizmos/snorlax/sidebar?conversations_per_gizmo=0',
    '/gizmos?limit=100&order=updated',
    '/my/gizmos?limit=100',
  ];

  const allProjectsMap = {};

  for (const ep of gizmoEndpoints) {
    try {
      let cursor = null;
      let hasMore = true;
      let limit = 0;
      while (hasMore && limit < 5) { // Limit pagination to avoid infinite loops
        const url = cursor ? `${ep}${ep.includes('?') ? '&' : '?'}cursor=${cursor}` : ep;
        const data = await chatgptFetch(url, token);
        const items = data?.items || data?.gizmos || (Array.isArray(data) ? data : []);
        
        items.forEach(g => {
          const gid = g.id || g.gizmo?.id;
          if (gid && gid.startsWith('g-p-')) {
            allProjectsMap[gid] = {
              id: gid,
              title: g.display?.name || g.name || g.title || g.gizmo?.display?.name || 'Untitled Project',
              gizmoId: gid
            };
          }
        });

        cursor = data?.cursor;
        hasMore = !!cursor;
        limit++;
      }
    } catch (_) {}
  }

  const projects = Object.values(allProjectsMap);
  if (projects.length > 0) {
    exportState.projectsRaw = { count: projects.length, note: 'Found via gizmo pagination' };
    return projects;
  }

  // Fallback: try dedicated project/workspace endpoints
  for (const ep of ['/projects?limit=100', '/workspaces?limit=100']) {
    try {
      const data = await chatgptFetch(ep, token);
      const items = data?.items || data?.projects || (Array.isArray(data) ? data : []);
      if (items.length > 0) {
        exportState.projectsRaw = { endpoint: ep, count: items.length };
        return items.map(p => ({
          id: p.id,
          title: p.title || p.name || 'Untitled Project',
          gizmoId: p.id,
        })).filter(p => p.id);
      }
    } catch (_) {}
  }

  exportState.projectsRaw = { note: 'All endpoints failed  will detect from conversation metadata' };
  return [];
}

// ─── DOM-first project scraping ─────────────────────────────────────────────
async function getProjectsFromContentScript() {
  const tabs = await chrome.tabs.query({ url: 'https://chatgpt.com/*' });
  for (const tab of tabs) {
    try {
      const r = await chrome.tabs.sendMessage(tab.id, { type: 'GET_PROJECTS_FROM_DOM' });
      if (r?.projects?.length) {
        exportState.projectsRaw = { source: 'dom', count: r.projects.length, note: 'Scraped from ChatGPT sidebar' };
        return r.projects;
      }
    } catch (_) {}
  }
  return [];
}

async function loadProjects(type = 'chatgpt') {
  if (type === 'chatgpt') {
    const token = exportState.token || await getTokenFromTab();
    if (token) exportState.token = token;

    const projectMap = {};

    // 1. Scrape directly from open ChatGPT tab sidebar — most reliable for UI state
    const domProjects = await getProjectsFromContentScript();
    domProjects.forEach(p => projectMap[p.id] = p);

    // 2. Try API endpoints including paged gizmos
    if (token) {
      const apiProjects = await fetchProjects(token);
      apiProjects.forEach(p => {
        // Don't overwrite DOM projects (titles are cleaner there)
        if (!projectMap[p.id]) projectMap[p.id] = p;
      });

      // 3. Fallback: Detect from conversation gizmo_id metadata
      try {
        const data = await chatgptFetch('/conversations?offset=0&limit=100&order=updated', token);
        const items = data?.items || [];
        for (const c of items) {
          const pid = c.gizmo_id || c.workspace_id || c.project_id;
          if (!pid || !pid.startsWith('g-p-')) continue;
          if (!projectMap[pid]) {
            const t = c.workspace_title || c.project_title || pid.replace(/^g-p-[a-f0-9]+-/, '').replace(/-/g, ' ');
            projectMap[pid] = { id: pid, title: t, gizmoId: pid };
          }
        }
      } catch (_) {}
    }

    const merged = Object.values(projectMap);
    exportState.projects = merged;
    exportState.projectsLoaded = true;
    exportState.projectsRaw = { 
      count: merged.length, 
      dom: domProjects.length,
      source: merged.length > 0 ? 'merged' : 'none' 
    };
    sendStatus();
    return merged;
  } else {
    // GEMINI / CLAUDE Sidebar Scraping
    const domProjects = await getProjectsFromContentScript();
    const sorted = domProjects.filter(p => !p.id.startsWith('g-p-')); 
    exportState.projects = sorted;
    exportState.projectsLoaded = true;
    sendStatus();
    return sorted;
  }
}


// ─── Conversation Fetching ──────────────────────────────────────────────────

async function fetchConversationList(token, options) {
  const conversations = [];

  if (options.scope === 'projects_only') {
    // Fetch each project's conversations
    for (const project of exportState.projects) {
      const fetched = await fetchProjectConversations(token, project);
      conversations.push(...fetched);
      exportState.total = conversations.length;
      sendStatus();
    }
    return conversations;
  }

  if (options.scope === 'project' && options.projectId) {
    const project = exportState.projects.find(p => p.id === options.projectId) || { id: options.projectId, title: 'Project', gizmoId: options.projectId };
    return await fetchProjectConversations(token, project);
  }

  // All chats — simple paginated fetch
  let offset = 0;
  let hasMore = true;
  while (hasMore) {
    try {
      const data = await chatgptFetch(`/conversations?offset=${offset}&limit=${PAGE_SIZE}&order=updated`, token);
      const items = data?.items || [];
      conversations.push(...items);
      exportState.total = data.total || conversations.length;
      offset += items.length;
      hasMore = items.length === PAGE_SIZE && offset < exportState.total;
      sendStatus();
      await sleep(250);
    } catch (e) {
      exportState.errors.push(`List fetch error: ${e.message}`);
      hasMore = false;
    }
  }
  return conversations;
}

/** Fetch all conversations belonging to a specific project (gizmo/workspace). */
async function fetchProjectConversations(token, project) {
  const conversations = [];
  const id = project.id;

  // Try different endpoints for GPTs, Projects, and Workspaces
  const endpoints = [
    `/gizmos/${id}/conversations`,
    `/projects/${id}/conversations`,
    `/workspaces/${id}/conversations`
  ];

  for (const baseUrl of endpoints) {
    let cursor = 0;
    let hasMore = true;
    let gotItems = false;

    while (hasMore) {
      try {
        const data = await chatgptFetch(`${baseUrl}?cursor=${cursor}&limit=50`, token);
        const items = data?.items || [];
        if (items.length === 0 && cursor === 0) break;
        
        items.forEach(c => {
          c._projectTitle = project.title;
          c._projectId = id;
        });
        
        conversations.push(...items);
        exportState.total = (exportState.total || 0) + items.length;
        sendStatus();
        
        if (data.cursor && data.cursor !== cursor) {
          cursor = data.cursor; 
          await sleep(200);
          gotItems = true;
        } else {
          hasMore = false;
        }
      } catch (e) {
        hasMore = false;
      }
    }
    if (conversations.length > 0) return conversations;
  }

  if (conversations.length === 0) {
    exportState.errors.push(`Project "${project.title}": 0 messages or access denied (ID: ${id})`);
  }
  return conversations;
}

// 
//  Main Export 
// 

async function runExport(options) {
  const scopeTag = options.scope === 'project' ? 'project' :
                   options.scope === 'projects_only' ? 'projects' : 'all';
  const datestamp = new Date().toISOString().slice(0, 10);
  const isGemini = options.scope.startsWith('gemini');
  const isClaude = options.scope.startsWith('claude');
  const prefix = isGemini ? 'gemini' : (isClaude ? 'claude' : 'chatgpt');
  const zipFilename = `${prefix}-export-${datestamp}-${scopeTag}.zip`;

  exportState = {
    ...exportState,
    running: true,
    total: 0,
    fetched: 0,
    saved: 0,
    errors: [],
    phase: 'fetching_list',
    conversations: [],
    fullConversations: [],
    exportFormat: options.format || 'json',
    startedAt: Date.now(),
    finishedAt: null,
    zipName: zipFilename,
  };
  sendStatus();

  // 1) Token (Only for ChatGPT scopes)
  const isChatGPT = ['all', 'projects_only', 'project'].includes(options.scope);
  try {
    if (isChatGPT) {
      if (!exportState.token) exportState.token = await getTokenFromTab();
      if (!exportState.token) throw new Error('Could not get auth token  are you logged into chatgpt.com?');
    }
  } catch (e) {
    exportState.errors.push(e.message);
    exportState.running = false;
    exportState.phase = 'done';
    sendStatus();
    return;
  }

  // 2) Fetch conversation list / Chat data
  try {
    if (options.scope === 'gemini_current' || options.scope === 'claude_current') {
        const type = options.scope.split('_')[0]; // gemini or claude
        const chat = type === 'gemini' ? await getGeminiChatFromTab(options.tabId) : await getClaudeChatFromTab(options.tabId);
        
        exportState.conversations = [chat];
        exportState.fullConversations = [chat];
        exportState.fetched = 1; exportState.total = 1;
        exportState.phase = 'saving';
        sendStatus();
    } 
    else if (options.scope === 'gemini_history' || options.scope === 'claude_history') {
        const type = options.scope.split('_')[0];
        exportState.phase = 'fetching_list';
        const projects = await loadProjects(type); 
        const history = projects.filter(p => p.source === type);
        
        exportState.total = history.length;
        exportState.phase = 'fetching_chats';
        sendStatus();

        for (const entry of history) {
            try {
                const url = type === 'gemini' 
                  ? `https://gemini.google.com/app/${entry.id}`
                  : `https://claude.ai/chat/${entry.id}`;
                
                const chat = type === 'gemini' ? await navigateAndScrapeGemini(url) : await navigateAndScrapeClaude(url);
                if (chat) exportState.fullConversations.push(chat);
            } catch (e) {
                exportState.errors.push(`"${entry.title}": ${e.message}`);
            }
            exportState.fetched++;
            sendStatus();
            await sleep(type === 'gemini' ? 1500 : 2000); 
        }
        exportState.phase = 'saving';
    }
    else if (options.scope === 'project' && options.projectId) {
      exportState.conversations = await fetchProjectConversations(exportState.token, { 
        id: options.projectId, 
        title: exportState.projects?.find(p => p.id === options.projectId)?.title || 'Project'
      });
      if (exportState.conversations.length > 0) exportState.phase = 'fetching_chats';
    } else if (options.scope === 'project' && options.singleId) {
       // Single ChatGPT chat from Quick Hub
       const full = await chatgptFetch(`/conversation/${options.singleId}`, exportState.token);
       exportState.conversations = [full];
       exportState.fullConversations = [full];
       exportState.fetched = 1;
       exportState.total = 1;
       exportState.phase = 'saving';
    } else {
      exportState.conversations = await fetchConversationList(exportState.token, options);
      if (exportState.conversations.length > 0) exportState.phase = 'fetching_chats';
    }
  } catch (e) {
    exportState.errors.push('Conversation fetch failed: ' + e.message);
  }

  if (exportState.conversations.length === 0) {
    exportState.errors.push('No conversations found. Check scope / project selection.');
    exportState.running = false;
    exportState.phase = 'done';
    sendStatus();
    return;
  }

  exportState.total = exportState.conversations.length;
  sendStatus();

  // 3) Fetch full conversation content (3 parallel workers)
  if (exportState.phase === 'fetching_chats') {
    sendStatus();
    const queue = [...exportState.conversations];
    async function worker() {
      while (queue.length > 0) {
        const conv = queue.shift();
        try {
          const full = await chatgptFetch(`/conversation/${conv.id}`, exportState.token);
          if (conv._projectTitle) full._projectTitle = conv._projectTitle;
          if (conv._projectId)    full._projectId    = conv._projectId;
          exportState.fullConversations.push(full);
        } catch (e) {
          exportState.errors.push(`"${conv.title || conv.id}": ${e.message}`);
        }
        exportState.fetched++;
        sendStatus();
        await sleep(150);
      }
    }
    await Promise.all([worker(), worker(), worker()]);
  }

  // 4) Build ZIP & Data Sync
  exportState.phase = 'saving';
  sendStatus();

  const zip = new FilesCollector();
  const fmt = exportState.exportFormat;
  const convs = exportState.fullConversations;

  // Extract metadata for the Dashboard Analytics
  const insights = convs.map(c => {
    const messages = Object.values(c.mapping || {}).filter(m => m.message);
    const userMessages = messages.filter(m => m.message?.author?.role === 'user');
    
    // Simple word extractor for "Top Topics"
    const textContext = messages.map(m => m.message?.content?.parts?.[0] || '').join(' ').toLowerCase();
    const words = textContext.match(/[a-z]{4,}/g) || [];
    
    const firstMsg = userMessages[0];
    const part = firstMsg?.message?.content?.parts?.[0];
    const promptSnippet = (typeof part === 'string' ? part : (part?.text || '')).slice(0, 500);

    return {
        id: c.id,
        title: c.title || 'Untitled',
        createdAt: c.create_time,
        project: c._projectTitle || 'General',
        promptSnippet,
        wordCount: textContext.split(/\s+/).length,
        messageCount: messages.length,
        keywords: words.slice(0, 20) // pass some words for dashboard to aggregate
    };
  });
  
  chrome.storage.local.get(['history'], (res) => {
    const history = res.history || [];
    const merged = [...insights, ...history].slice(0, 1000); // 1000 items max
    chrome.storage.local.set({ 
        history: merged, 
        lastExportAt: Date.now(),
        totalChatsExported: (res.totalChatsExported || 0) + convs.length
    });
  });

  // Add a README
  zip.add('README.txt', [
    `ChatGPT Export`,
    `Generated: ${new Date().toISOString()}`,
    `Scope: ${options.scope}`,
    `Format: ${fmt}`,
    `Conversations: ${convs.length}`,
    `Errors: ${exportState.errors.length}`,
    '',
    'Files included:',
    fmt === 'json'     ? '  conversations.json  all conversations as JSON' :
    fmt === 'markdown' ? '  chats/*.md  one Markdown file per conversation' :
                         '  index.html  searchable single-page HTML archive',
    options.includeAssets ? '  assets/*  downloaded attachments & images' : '',
  ].join('\n'));

  if (fmt === 'json') {
    zip.add('conversations.json', JSON.stringify(convs, null, 2));
    exportState.saved++;
    sendStatus();

  } else if (fmt === 'markdown') {
    for (const conv of convs) {
      const md = conversationToMarkdown(conv);
      const sub = conv._projectTitle ? `projects/${safeFilename(conv._projectTitle)}` : 'chats';
      zip.add(`${sub}/${safeFilename(conv.title || conv.id)}.md`, md);
      exportState.saved++;
      sendStatus();
    }
    // Index
    const index = convs.map(c => {
      const sub = c._projectTitle ? `projects/${safeFilename(c._projectTitle)}` : 'chats';
      return `- [${c.title || c.id}](${sub}/${safeFilename(c.title || c.id)}.md)`;
    }).join('\n');
    zip.add('index.md', `# ChatGPT Export\n\n${index}`);

  } else if (fmt === 'html') {
    zip.add('index.html', conversationsToHTML(convs));
    exportState.saved++;
    sendStatus();
  }

  // 5) Assets
  if (options.includeAssets) {
    const assetUrls = new Set();
    for (const conv of convs) extractAssetUrls(conv).forEach(u => assetUrls.add(u));

    let assetManifest = 'Asset URLs (some may require login to access):\n\n';
    for (const url of assetUrls) {
      const fname = assetFilename(url);
      try {
        const bytes = await fetchBytes(url, exportState.token);
        zip.add(`assets/${fname}`, bytes);
        assetManifest += `[OK] ${fname}\n     ${url}\n\n`;
      } catch (e) {
        // If fetch fails (CORS, expired, etc.)  just list the URL
        assetManifest += `[URL] ${fname}\n     ${url}\n     Error: ${e.message}\n\n`;
        exportState.errors.push(`Asset skipped (${fname}): ${e.message}`);
      }
      exportState.saved++;
      sendStatus();
      await sleep(200);
    }
    zip.add('assets/_manifest.txt', assetManifest);
  }

  // 6) Download the ZIP via offscreen document
  try {
    await createZipViaOffscreen(zip.toFileList(), zipFilename);
  } catch (e) {
    exportState.errors.push('ZIP download failed: ' + e.message);
  }

  exportState.finishedAt = Date.now();
  exportState.running = false;
  exportState.phase = 'done';
  sendStatus();

  // Show system notification
  chrome.notifications.create({
    type: 'basic',
    iconUrl: 'icons/icon128.png',
    title: 'Export Complete!',
    message: `Successfully exported ${convs.length} conversations to ${zipFilename}. Check the dashboard for analytics.`,
    priority: 2
  });
}

// 
//  Offscreen ZIP creation 
// 

async function createZipViaOffscreen(fileList, zipFilename) {
  // Create offscreen document if one doesn't already exist
  const offscreenUrl = chrome.runtime.getURL('offscreen.html');
  const existingContexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [offscreenUrl],
  }).catch(() => []);

  if (!existingContexts.length) {
    await chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['BLOBS', 'DOM_SCRAPING'], // Note: 'DOWNLOADS' is not a valid reason, but Blobs + DOM usually work.
      justification: 'Build ZIP file using Blob API and trigger download via chrome.downloads',
    });
  }

  // Ask offscreen doc to build the ZIP and trigger the download
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Offscreen ZIP timed out')), 60000);
    chrome.runtime.sendMessage(
      { type: 'CREATE_ZIP_BLOB', files: fileList, filename: zipFilename },
      (resp) => {
        clearTimeout(timeout);
        if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
        if (resp?.error) return reject(new Error(resp.error));
        resolve(resp.success);
      }
    );
  });
}

// 
//  Asset Extraction 
// 

function extractAssetUrls(conv) {
  const urls = new Set();
  for (const node of Object.values(conv.mapping || {})) {
    const msg = node?.message;
    if (!msg?.content) continue;
    const { content, metadata } = msg;

    for (const att of (content.attachments || [])) {
      if (att.url) urls.add(att.url);
      if (att.download_url) urls.add(att.download_url);
    }
    for (const part of (content.parts || [])) {
      if (typeof part === 'string') {
        (part.match(/https?:\/\/files\.oaiusercontent\.com\/[^\s"'<>)]+/gi) || []).forEach(u => urls.add(u));
        (part.match(/https?:\/\/[^\s"'<>)]+\.(png|jpg|jpeg|gif|webp|pdf|svg)/gi) || []).forEach(u => urls.add(u));
      } else if (part && typeof part === 'object') {
        if (part.url && !part.url.startsWith('file-service://')) urls.add(part.url);
        if (part.image_url) urls.add(part.image_url);
      }
    }
    for (const att of (metadata?.attachments || [])) {
      if (att.url) urls.add(att.url);
      if (att.download_url) urls.add(att.download_url);
    }
  }
  return [...urls];
}

// 
//  Formatting 
// 

function flattenMessages(conv) {
  const mapping = conv.mapping || {};
  const msgs = [];
  
  // 1) Try Tree Walk (ChatGPT style)
  const root = Object.keys(mapping).find(k => k && !mapping[k].parent);
  if (root && mapping[root].children?.length > 0) {
    function walk(id) {
        const node = mapping[id];
        if (!node) return;
        if (node.message?.content) {
          const { author, content, create_time } = node.message;
          const role = author?.role || 'unknown';
          const text = (content.parts || [])
            .map(p => typeof p === 'string' ? p : (p?.text || ''))
            .join('\n').trim();
          if (text) msgs.push({ role, text, created: create_time });
        }
        for (const c of (node.children || [])) walk(c);
    }
    walk(root);
    if (msgs.length > 0) return msgs;
  }

  // 2) Fallback: Flatten all items (Gemini / Flat style)
  for (const node of Object.values(mapping)) {
    if (node?.message) {
      const { author, content, create_time } = node.message;
      const role = author?.role || 'user';
      const text = (content.parts || [])
        .map(p => typeof p === 'string' ? p : (p?.text || ''))
        .join('\n').trim();
      if (text) {
        msgs.push({
          role,
          text,
          created: create_time,
          images: content.images || []
        });
      }
    }
  }
  return msgs.sort((a, b) => (a.created || 0) - (b.created || 0));
}

function conversationToMarkdown(conv) {
  const msgs = flattenMessages(conv);
  const title = conv.title || 'Untitled Conversation';
  const created  = conv.create_time ? new Date(conv.create_time * 1000) : null;
  const updated  = conv.update_time ? new Date(conv.update_time * 1000) : null;
  const userMsgs = msgs.filter(m => m.role === 'user').length;
  const aiMsgs   = msgs.filter(m => m.role === 'assistant').length;

  // Detect model from mapping nodes
  const modelSlug = (() => {
    for (const node of Object.values(conv.mapping || {})) {
      const slug = node?.message?.metadata?.model_slug ||
                   node?.message?.metadata?.default_model_slug;
      if (slug) return slug;
    }
    return conv.default_model_slug || null;
  })();

  const aiName = (conv.id || '').includes('gemini') ? 'Gemini' : 'ChatGPT';

  // YAML-style front matter for interop with Obsidian, etc.
  let md = `---\n`;
  md += `title: "${title.replace(/"/g, "'")}"\n`;
  if (conv._projectTitle) md += `project: "${conv._projectTitle}"\n`;
  md += `id: ${conv.id}\n`;
  if (created)   md += `created: ${created.toISOString()}\n`;
  if (updated)   md += `updated: ${updated.toISOString()}\n`;
  if (modelSlug) md += `model: ${modelSlug}\n`;
  md += `messages: ${msgs.length}  # ${userMsgs} from you, ${aiMsgs} from ${aiName}\n`;
  if (conv.gizmo_id) md += `gpt_id: ${conv.gizmo_id}\n`;
  if (conv.plugin_ids?.length) md += `plugins: [${conv.plugin_ids.join(', ')}]\n`;
  md += `---\n\n`;

  // Human-readable header
  md += `# ${title}\n\n`;
  if (conv._projectTitle) md += `**Project:** ${conv._projectTitle}  \n`;
  if (created) md += `**Created:** ${created.toLocaleDateString('en-US', {year:'numeric',month:'long',day:'numeric'})}  \n`;
  if (modelSlug) md += `**Model:** ${modelSlug}  \n`;
  md += `\n---\n\n`;

  for (const m of msgs) {
    const lbl = m.role === 'user' ? '##  You' :
                m.role === 'assistant' ? `##  ${aiName}` :
                m.role === 'tool' ? '##  Tool' : `## ${m.role}`;
    const ts = m.created ? `\n*${new Date(m.created * 1000).toLocaleTimeString()}*` : '';
    md += `${lbl}${ts}\n\n${m.text}\n\n---\n\n`;
  }
  return md;
}

function conversationsToHTML(convs) {
  const hasProjects = convs.some(c => c._projectTitle);
  const groups = {};
  for (const c of convs) {
    const k = c._projectTitle || '__all__';
    (groups[k] = groups[k] || []).push(c);
  }

  const body = Object.entries(groups).map(([gk, gconvs]) => {
    const heading = hasProjects && gk !== '__all__'
      ? `<h2 class="g-head">${escHtml(gk)}</h2>` : '';
    return heading + gconvs.map(conv => {
      const created = conv.create_time ? new Date(conv.create_time * 1000).toLocaleDateString() : '';
      const msgsHtml = flattenMessages(conv).map(m => {
        const cls   = m.role === 'user' ? 'u' : 'a';
        const label = m.role === 'user' ? 'You' : 'ChatGPT';
        return `<div class="m ${cls}"><div class="lbl">${label}</div><div class="txt">${escHtml(m.text).replace(/\n/g,'<br>')}</div></div>`;
      }).join('');
      return `<details class="cv"><summary><b>${escHtml(conv.title||'Untitled')}</b><span class="dt">${created}</span></summary><div class="ms">${msgsHtml}</div></details>`;
    }).join('');
  }).join('');

  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>ChatGPT Export</title>
<style>
body{background:#0f0f0f;color:#eee;font-family:-apple-system,sans-serif;padding:2rem;max-width:960px;margin:0 auto}
h1{color:#10a37f;font-size:1.8rem;margin-bottom:.3rem}
.meta{color:#888;font-size:.85rem;margin-bottom:1.5rem}
input{width:100%;padding:.6rem 1rem;background:#1a1a1a;border:1px solid #2c2c2c;border-radius:8px;color:#eee;font-size:1rem;margin-bottom:1.2rem;outline:none}
input:focus{border-color:#10a37f}
.g-head{color:#10a37f;font-size:1rem;padding:.4rem 1rem;border-left:3px solid #10a37f;background:rgba(16,163,127,.07);border-radius:0 8px 8px 0;margin:1.2rem 0 .6rem}
.cv{border:1px solid #2c2c2c;border-radius:10px;margin-bottom:.5rem;background:#1a1a1a;overflow:hidden}
.cv>summary{cursor:pointer;padding:.8rem 1.2rem;display:flex;justify-content:space-between;align-items:center;list-style:none}
.cv>summary:hover{background:rgba(255,255,255,.04)}
.dt{color:#666;font-size:.75rem}
.ms{padding:1rem 1.2rem;border-top:1px solid #2c2c2c;display:flex;flex-direction:column;gap:.6rem}
.m{padding:.8rem 1rem;border-radius:8px;line-height:1.65;font-size:.9rem}
.u{background:#1e3a2f;align-self:flex-end;max-width:82%}
.a{background:#222;border:1px solid #2c2c2c}
.lbl{font-size:.65rem;font-weight:700;color:#10a37f;margin-bottom:.35rem;text-transform:uppercase;letter-spacing:.04em}
.txt{white-space:pre-wrap;word-break:break-word}
.hidden{display:none}
</style></head>
<body>
<h1>ChatGPT Export</h1>
<p class="meta">Exported ${new Date().toLocaleString()} &middot; ${convs.length} conversations</p>
<input type="search" placeholder="Search" oninput="document.querySelectorAll('.cv').forEach(e=>e.classList.toggle('hidden',this.value.length>0&&!e.textContent.toLowerCase().includes(this.value.toLowerCase())))">
${body}
</body></html>`;
}

// 
//  Utils 
// 

function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}
function safeFilename(s) {
  return String(s).replace(/[^a-zA-Z0-9\-_ ]/g,'_').replace(/\s+/g,'_').slice(0,80);
}
function assetFilename(url) {
  try {
    const parts = new URL(url).pathname.split('/');
    return (parts[parts.length-1]||'file').replace(/[^a-zA-Z0-9.\-_]/g,'_');
  } catch { return 'asset_'+Date.now(); }
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// 
//  Message Handler 
// 

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {

  if (msg.type === 'LOAD_PROJECTS') {
    loadProjects(msg.platform || 'chatgpt')
      .then(projects => sendResponse({ projects, raw: exportState.projectsRaw }))
      .catch(e => sendResponse({ projects: [], error: e.message }));
    return true;
  }

  if (msg.type === 'START_EXPORT') {
    if (!exportState.running) {
      runExport(msg.options).catch(e => {
        exportState.errors.push('Fatal: ' + e.message);
        exportState.running = false;
        exportState.phase = 'done';
        sendStatus();
      });
    }
    sendResponse({ started: true });
    return true;
  }

  if (msg.type === 'GET_STATUS') {
    sendResponse({
      running:        exportState.running,
      total:          exportState.total,
      fetched:        exportState.fetched,
      saved:          exportState.saved,
      phase:          exportState.phase,
      errors:         exportState.errors,
      startedAt:      exportState.startedAt,
      finishedAt:     exportState.finishedAt,
      zipName:        exportState.zipName,
      projects:       exportState.projects,
      projectsLoaded: exportState.projectsLoaded,
      projectsRaw:    exportState.projectsRaw,
    });
    return true;
  }

  if (msg.type === 'OPEN_DASHBOARD') {
    chrome.tabs.create({ url: chrome.runtime.getURL('dashboard.html') });
    sendResponse({ success: true });
    return true;
  }

  if (msg.type === 'RUN_QUICK_EXPORT') {
    chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
      if (!tabs[0]) return;
      const url = tabs[0].url;
      if (url.includes(DOMAINS.CHATGPT)) {
        // Run ChatGPT single chat export
        const idMatch = url.match(/\/c\/([a-f0-9-]+)/);
        if (idMatch) {
            runExport({ scope: 'project', format: 'json', projectId: null, singleId: idMatch[1] });
        } else {
            runExport({ scope: 'all', format: 'json' }); 
        }
      } else if (url.includes(DOMAINS.GEMINI)) {
        // Run Gemini single chat export
        runExport({ scope: 'gemini_current', format: 'json', tabId: tabs[0].id });
      } else if (url.includes(DOMAINS.CLAUDE)) {
        // Run Claude single chat export
        runExport({ scope: 'claude_current', format: 'json', tabId: tabs[0].id });
      }
    });
    return true;
  }

  if (msg.type === 'SAVE_SNIPPET') {
    chrome.storage.local.get(['history'], (res) => {
      const history = res.history || [];
      history.unshift({
        id: 'snippet-' + Date.now(),
        title: `Snippet from ${msg.source}`,
        createdAt: Math.floor(Date.now() / 1000),
        project: 'Library',
        promptSnippet: msg.snippet,
        isSnippet: true
      });
      chrome.storage.local.set({ history: history.slice(0, 1000) });
      
      chrome.notifications.create({
        type: 'basic',
        iconUrl: 'icons/icon128.png',
        title: 'Snippet Saved',
        message: 'Saved selection to your Insight Dashboard Library.',
        priority: 1
      });
    });
    return true;
  }

  return true;
});
