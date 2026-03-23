// background.js — ChatGPT / Gemini / Claude Exporter

const DOMAINS = { CHATGPT: 'chatgpt.com', GEMINI: 'gemini.google.com', CLAUDE: 'claude.ai' };
const CHATGPT_BASE = 'https://chatgpt.com/backend-api';
const PAGE_SIZE = 100;
const MAX_SCRAPE_ATTEMPTS = 8;
const OFFSCREEN_TIMEOUT_MS = 120_000;
const STOP_WORDS = new Set([
  'the','a','an','is','in','it','of','to','and','or','for','on',
  'with','that','this','be','as','at','from','by','not','are','was',
]);

// ─── FilesCollector — chunked base64 safe for Service Worker ─────────────────
class FilesCollector {
  constructor() { this.files = []; }
  add(name, content) {
    const data = typeof content === 'string'
      ? new TextEncoder().encode(content)
      : (content instanceof Uint8Array ? content : new Uint8Array(content));
    this.files.push({ name, data });
    return this;
  }
  toFileList() {
    return this.files.map(f => ({ name: f.name, dataB64: uint8ToBase64(f.data) }));
  }
}

function uint8ToBase64(bytes) {
  let binary = '';
  const CHUNK = 8192;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

// ─── State ────────────────────────────────────────────────────────────────────
let exportState = {
  running: false, token: null,
  total: 0, fetched: 0, saved: 0,
  errors: [], phase: 'idle',
  fullConversations: [],
  exportFormat: 'json',
  startedAt: null, finishedAt: null,
  zipName: null, currentChatTitle: '',
  projects: [], projectsLoaded: false, projectsRaw: null,
};

let cancelSignal = false;
let currentOptions = null;

function sendStatus() {
  chrome.runtime.sendMessage({ type: 'STATUS_UPDATE', state: exportState }).catch(() => {});
}

// ─── Message Handler ──────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {

  if (msg.type === 'GET_STATUS') {
    sendResponse(exportState);
    return true;
  }

  if (msg.type === 'LOAD_PROJECTS') {
    loadProjects(msg.platform || 'chatgpt')
      .then(projects => sendResponse({ projects, raw: exportState.projectsRaw }))
      .catch(e => sendResponse({ projects: [], error: e.message }));
    return true;
  }

  if (msg.type === 'START_EXPORT') {
    if (!exportState.running) {
      cancelSignal = false;
      currentOptions = msg.options;
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

  if (msg.type === 'CANCEL_EXPORT') {
    cancelSignal = true;
    if (exportState.fullConversations.length > 0) {
      buildAndDownloadZip(currentOptions || {}).then(() => {
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

  if (msg.type === 'OPEN_DASHBOARD') {
    chrome.tabs.create({ url: chrome.runtime.getURL('dashboard.html') });
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === 'RESET_STATE') {
    exportState = {
      ...exportState, running: false, phase: 'idle',
      fullConversations: [], fetched: 0, total: 0,
      errors: [], zipName: '', currentChatTitle: '',
    };
    cancelSignal = false;
    sendStatus();
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === 'RUN_QUICK_EXPORT') {
    chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
      if (!tabs[0]) return;
      const url = tabs[0].url || '';
      let opts;
      if (url.includes(DOMAINS.CHATGPT)) {
        const idMatch = url.match(/\/c\/([a-f0-9-]+)/);
        opts = idMatch
          ? { scope: 'chatgpt_current', format: 'md', tabId: tabs[0].id, includeAssets: true }
          : { scope: 'all', format: 'md' };
      } else if (url.includes(DOMAINS.GEMINI)) {
        opts = { scope: 'gemini_current', format: 'md', tabId: tabs[0].id };
      } else if (url.includes(DOMAINS.CLAUDE)) {
        opts = { scope: 'claude_current', format: 'md', tabId: tabs[0].id };
      }
      if (opts) { cancelSignal = false; currentOptions = opts; runExport(opts).catch(() => {}); }
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
        project: 'Library', promptSnippet: msg.snippet, isSnippet: true,
      });
      chrome.storage.local.set({ history: history.slice(0, 2000) });
      chrome.notifications.create({
        type: 'basic', iconUrl: 'icons/icon128.png',
        title: 'Snippet Saved', message: 'Selection saved to your Insight Dashboard.',
      });
    });
    return true;
  }

  return true;
});

// ─── Project Loading ──────────────────────────────────────────────────────────
async function loadProjects(platform = 'chatgpt') {
  exportState.phase = 'fetching_projects';
  sendStatus();

  if (platform === 'chatgpt') {
    const token = await getTokenFromTab();
    if (token) exportState.token = token;

    const projectMap = {};

    // 1. DOM sidebar — most up-to-date titles
    const domProjects = await getProjectsFromContentScript('chatgpt');
    domProjects.forEach(p => { projectMap[p.id] = { ...p, source: 'chatgpt' }; });

    // 2. API — finds projects not visible in current viewport
    if (token) {
      const apiProjects = await fetchProjects(token);
      apiProjects.forEach(p => { if (!projectMap[p.id]) projectMap[p.id] = { ...p, source: 'chatgpt' }; });

      // 3. Fallback: mine gizmo_id from conversation metadata
      try {
        const data = await chatgptFetch('/conversations?offset=0&limit=100&order=updated', token);
        for (const c of (data?.items || [])) {
          const pid = c.gizmo_id || c.workspace_id || c.project_id;
          if (!pid || !pid.startsWith('g-p-')) continue;
          if (!projectMap[pid]) {
            const t = c.workspace_title || c.project_title
              || pid.replace(/^g-p-[a-f0-9]+-/, '').replace(/-/g, ' ');
            projectMap[pid] = { id: pid, title: t, gizmoId: pid, source: 'chatgpt' };
          }
        }
      } catch (_) {}
    }

    const merged = Object.values(projectMap);
    exportState.projects = merged;
    exportState.projectsLoaded = true;
    exportState.projectsRaw = { count: merged.length, dom: domProjects.length };
    sendStatus();
    return merged;
  } else {
    // Gemini / Claude — sidebar only
    const domProjects = await getProjectsFromContentScript(platform);
    exportState.projects = domProjects;
    exportState.projectsLoaded = true;
    sendStatus();
    return domProjects;
  }
}

async function getProjectsFromContentScript(platform = 'chatgpt') {
  const urlPattern = platform === 'gemini' ? 'https://gemini.google.com/*'
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

async function fetchProjects(token) {
  const seen = new Set();
  const results = [];

  const addItem = (id, title, extra = {}) => {
    if (id && !seen.has(id)) { seen.add(id); results.push({ id, title, ...extra }); }
  };

  // Multiple gizmo endpoints with pagination
  const gizmoEndpoints = [
    '/gizmos/snorlax/sidebar?conversations_per_gizmo=0',
    '/gizmos?limit=100&order=updated',
    '/my/gizmos?limit=100',
  ];
  for (const ep of gizmoEndpoints) {
    try {
      let cursor = null;
      for (let page = 0; page < 5; page++) {
        const url = cursor ? `${ep}${ep.includes('?') ? '&' : '?'}cursor=${cursor}` : ep;
        const data = await chatgptFetch(url, token);
        const items = data?.items || data?.gizmos || (Array.isArray(data) ? data : []);
        items.forEach(g => {
          const gid = g.id || g.gizmo?.id;
          const name = g.display?.name || g.name || g.title || g.gizmo?.display?.name || 'Untitled';
          if (gid?.startsWith('g-p-')) addItem(gid, name, { gizmoId: gid });
        });
        cursor = data?.cursor;
        if (!cursor) break;
      }
    } catch (_) {}
  }

  // Dedicated project/workspace endpoints
  for (const ep of ['/projects?limit=100', '/workspaces?limit=100', '/accounts']) {
    try {
      const data = await chatgptFetch(ep, token);
      const items = data?.items || data?.projects || data?.workspace_accounts || (Array.isArray(data) ? data : []);
      items.forEach(p => {
        const id = p.id || p.account_id;
        const title = p.name || p.title || p.email || id;
        if (id) addItem(id, title, { isProject: true });
      });
    } catch (_) {}
  }

  if (results.length > 0) exportState.projectsRaw = { api: results.length };
  return results;
}

// ─── Conversation Fetching ────────────────────────────────────────────────────
async function fetchConversationList(token, options) {
  if (options.scope === 'projects_only') {
    const convs = [];
    for (const project of exportState.projects.filter(p => p.source === 'chatgpt')) {
      if (cancelSignal) break;
      exportState.currentChatTitle = `Loading project: ${project.title}`;
      sendStatus();
      const items = await fetchProjectConversations(token, project);
      convs.push(...items);
      exportState.total = convs.length;
      sendStatus();
    }
    return convs;
  }

  if (options.scope === 'project' && options.projectId) {
    const project = exportState.projects.find(p => p.id === options.projectId)
      || { id: options.projectId, title: 'Project', gizmoId: options.projectId };
    return fetchProjectConversations(token, project);
  }

  // All conversations — paginated
  const convs = [];
  let offset = 0;
  while (true) {
    if (cancelSignal) break;
    try {
      const data = await chatgptFetch(`/conversations?offset=${offset}&limit=${PAGE_SIZE}&order=updated`, token);
      const items = data?.items || [];
      convs.push(...items);
      const serverTotal = data?.total ?? null;
      exportState.total = serverTotal ?? convs.length;
      sendStatus();
      if (items.length < PAGE_SIZE) break;
      if (serverTotal !== null && convs.length >= serverTotal) break;
      offset += items.length;
      await sleep(250);
    } catch (e) {
      exportState.errors.push(`List fetch error: ${e.message}`);
      break;
    }
  }
  return convs;
}

async function fetchProjectConversations(token, project) {
  const convs = [];
  const id = project.id;

  // Try GPT-style endpoint first, then project/workspace style
  const endpoints = [
    `/conversations?offset=0&limit=100&order=updated&category=gizmo&gizmo_id=${id}`,
    `/gizmos/${id}/conversations?cursor=0&limit=50`,
    `/conversations?offset=0&limit=100&order=updated&workspace_id=${id}`,
    `/projects/${id}/conversations?limit=50`,
  ];

  for (const ep of endpoints) {
    if (convs.length > 0) break;
    try {
      let cursor = 0;
      for (let page = 0; page < 20; page++) {
        const url = ep.includes('cursor=0')
          ? ep.replace('cursor=0', `cursor=${cursor}`)
          : (ep.includes('offset=0') ? ep.replace('offset=0', `offset=${cursor}`) : ep);
        const data = await chatgptFetch(url, token);
        const items = data?.items || [];
        if (items.length === 0 && cursor === 0) break;
        items.forEach(c => { c._projectTitle = project.title; c._projectId = id; });
        convs.push(...items);
        exportState.total = (exportState.total || 0) + items.length;
        sendStatus();
        const nextCursor = data?.cursor ?? data?.next_cursor;
        if (!nextCursor || nextCursor === cursor) break;
        cursor = nextCursor;
        await sleep(200);
      }
    } catch (_) {}
  }

  if (convs.length === 0) {
    exportState.errors.push(`Project "${project.title}": No conversations found (ID: ${id})`);
  }
  return convs;
}

// ─── Main Export ──────────────────────────────────────────────────────────────
async function runExport(options) {
  const isGemini = options.scope.startsWith('gemini');
  const isClaude = options.scope.startsWith('claude');
  const prefix = isGemini ? 'gemini' : (isClaude ? 'claude' : 'chatgpt');
  const scopeTag = options.scope.includes('current') ? 'current'
    : options.scope.includes('history') ? 'history'
    : options.scope === 'projects_only' ? 'projects'
    : options.scope === 'project' ? 'project' : 'all';
  const zipFilename = `${prefix}-export-${new Date().toISOString().slice(0,10)}-${scopeTag}.zip`;

  exportState = {
    ...exportState,
    running: true, total: 0, fetched: 0, saved: 0,
    errors: [], phase: 'fetching_list',
    fullConversations: [], exportFormat: options.format || 'json',
    startedAt: Date.now(), finishedAt: null,
    zipName: zipFilename, currentChatTitle: '',
  };
  sendStatus();

  // ── 1. Token for ChatGPT scopes ───────────────────────────────────────────
  const isChatGPT = !isGemini && !isClaude;
  if (isChatGPT) {
    if (!exportState.token) exportState.token = await getTokenFromTab();
    if (!exportState.token && !options.scope.includes('current')) {
      exportState.errors.push('Could not get auth token — are you logged into chatgpt.com?');
      exportState.running = false; exportState.phase = 'done'; sendStatus(); return;
    }
  }

  // ── 2. Fetch list / current chat ─────────────────────────────────────────
  try {
    if (options.scope === 'gemini_current' || options.scope === 'claude_current') {
      let tabId = options.tabId;
      if (!tabId || tabId === 'active' || tabId === 'current') {
        tabId = (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id;
      }
      const chat = isGemini
        ? await getGeminiChatFromTab(tabId)
        : await getClaudeChatFromTab(tabId);
      if (chat) exportState.fullConversations = [chat];
      exportState.total = 1; exportState.fetched = 1;
      exportState.phase = 'saving';
      sendStatus();

    } else if (options.scope === 'chatgpt_current') {
      let tabId = options.tabId;
      if (!tabId || tabId === 'active' || tabId === 'current') {
        tabId = (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id;
      }
      const token = exportState.token || await getTokenFromTab();
      if (!token) throw new Error('No auth token — open chatgpt.com and try again.');
      const tab = await chrome.tabs.get(tabId).catch(() => null);
      if (!tab) throw new Error('Could not find the active tab.');
      const chatIdMatch = (tab.url || '').match(/\/c\/([a-f0-9-]+)/);
      if (!chatIdMatch) throw new Error('Open a specific ChatGPT chat first (URL must contain /c/<id>).');
      const full = await chatgptFetch(`/conversation/${chatIdMatch[1]}`, token);
      if (full) exportState.fullConversations = [full];
      exportState.total = 1; exportState.fetched = 1;
      exportState.phase = 'saving';
      sendStatus();

    } else if (options.scope === 'gemini_history' || options.scope === 'claude_history') {
      const type = options.scope.split('_')[0];
      exportState.phase = 'fetching_list';
      if (!exportState.projectsLoaded || !exportState.projects.some(p => p.source === type)) {
        await loadProjects(type);
      }
      const history = exportState.projects.filter(p => p.source === type);
      exportState.total = history.length;
      exportState.phase = 'fetching_chats';
      sendStatus();

      if (history.length === 0) {
        exportState.errors.push(`No ${type} conversations found — open ${type}.${type === 'gemini' ? 'google.com' : 'ai'} with your chats visible.`);
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
        await sleep(type === 'claude' ? 2500 : 1500);
      }
      exportState.phase = 'saving';

    } else {
      // ChatGPT API path (all / project / projects_only)
      if (!exportState.projectsLoaded) await loadProjects('chatgpt');

      const convs = await fetchConversationList(exportState.token, options);
      if (convs.length === 0) {
        exportState.errors.push('No conversations found. Check scope/project selection.');
        exportState.running = false; exportState.phase = 'done'; sendStatus(); return;
      }
      exportState.total = convs.length;
      exportState.phase = 'fetching_chats';
      sendStatus();

      // 3 parallel workers
      const queue = [...convs];
      const worker = async () => {
        while (queue.length > 0 && !cancelSignal) {
          const conv = queue.shift();
          exportState.currentChatTitle = `Downloading: ${conv.title || conv.id}`;
          sendStatus();
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
      };
      await Promise.all([worker(), worker(), worker()]);
      exportState.phase = 'saving';
    }
  } catch (e) {
    exportState.errors.push('Export failed: ' + e.message);
    exportState.running = false; exportState.phase = 'done'; sendStatus(); return;
  }

  if (!cancelSignal) await buildAndDownloadZip(options);
}

// ─── ZIP Assembly ─────────────────────────────────────────────────────────────
async function buildAndDownloadZip(options) {
  exportState.phase = 'saving';
  sendStatus();

  const zip = new FilesCollector();
  const fmt = exportState.exportFormat;
  const convs = exportState.fullConversations;

  // README
  zip.add('README.txt', [
    'Chat Exporter — Pulse Engine',
    `Generated: ${new Date().toISOString()}`,
    `Scope: ${options.scope || 'unknown'}`,
    `Format: ${fmt}`,
    `Conversations: ${convs.length}`,
    `Errors: ${exportState.errors.length}`,
  ].join('\n'));

  if (fmt === 'json') {
    zip.add('conversations.json', JSON.stringify(convs, null, 2));
    exportState.saved++;
    sendStatus();

  } else if (fmt === 'md' || fmt === 'markdown') {
    const indexLines = [];
    for (const conv of convs) {
      if (cancelSignal) break;
      const sub = conv._projectTitle ? `projects/${safeFilename(conv._projectTitle)}` : 'chats';
      const fname = safeFilename(conv.title || conv.id || 'chat');
      zip.add(`${sub}/${fname}.md`, conversationToMarkdown(conv));
      indexLines.push(`- [${conv.title || conv.id}](${sub}/${fname}.md)`);
      exportState.saved++;
      sendStatus();
    }
    zip.add('index.md', `# Chat Export\n\n${indexLines.join('\n')}`);

  } else if (fmt === 'html') {
    zip.add('index.html', conversationsToHTML(convs));
    exportState.saved++;
    sendStatus();

  } else if (fmt === 'csv') {
    for (const conv of convs) {
      if (cancelSignal) break;
      const fname = safeFilename(conv.title || conv.id || 'chat');
      const sub = conv._projectTitle ? `projects/${safeFilename(conv._projectTitle)}` : 'chats';
      zip.add(`${sub}/${fname}.csv`, formatToCSV(conv));
      exportState.saved++;
      sendStatus();
    }
  }

  // Assets
  if (options.includeAssets && fmt !== 'csv') {
    const assetUrls = new Set();
    convs.forEach(c => extractAssetUrls(c).forEach(u => assetUrls.add(u)));
    let manifest = 'Asset Manifest\n\n';
    for (const url of assetUrls) {
      if (cancelSignal) break;
      const fname = assetFilename(url);
      try {
        if (!/^https?:\/\//i.test(url)) throw new Error('Unsupported protocol');
        const bytes = await fetchBytes(url, exportState.token);
        zip.add(`assets/${fname}`, bytes);
        manifest += `[OK]  ${fname}\n      ${url}\n\n`;
      } catch (e) {
        manifest += `[URL] ${fname}\n      ${url}\n      ${e.message}\n\n`;
        exportState.errors.push(`Asset skipped (${fname}): ${e.message}`);
      }
      exportState.saved++;
      sendStatus();
      await sleep(200);
    }
    zip.add('assets/_manifest.txt', manifest);
  }

  // Save history for dashboard
  await saveHistoryToStorage(convs, options.scope);

  // Download
  try {
    await createZipViaOffscreen(zip.toFileList(), exportState.zipName);
  } catch (e) {
    exportState.errors.push('ZIP download failed: ' + e.message);
  }

  exportState.finishedAt = Date.now();
  exportState.running = false;
  exportState.phase = 'done';
  sendStatus();

  chrome.notifications.create({
    type: 'basic', iconUrl: 'icons/icon128.png',
    title: 'Export Complete!',
    message: `${convs.length} conversations exported to ${exportState.zipName}`,
    priority: 2,
  });
}

// ─── Message Formatting ───────────────────────────────────────────────────────
function flattenMessages(conv) {
  const mapping = conv.mapping || {};
  const msgs = [];

  // Tree walk (ChatGPT-style with branching)
  const root = Object.keys(mapping).find(k => !mapping[k]?.parent);
  if (root && mapping[root]?.children?.length > 0) {
    const walk = (id) => {
      const node = mapping[id];
      if (!node) return;
      if (node.message?.content) {
        const { author, content, create_time } = node.message;
        const role = author?.role || 'unknown';
        const text = (content.parts || [])
          .map(p => typeof p === 'string' ? p : (p?.text || ''))
          .join('\n').trim();
        if (text && role !== 'system') msgs.push({ role, text, created: create_time, images: content.images || [] });
      }
      (node.children || []).forEach(walk);
    };
    walk(root);
    if (msgs.length > 0) return msgs;
  }

  // Flat fallback (Gemini/Claude/simple ChatGPT)
  const flat = Object.values(mapping)
    .filter(n => n?.message?.content)
    .map(n => {
      const { author, content, create_time } = n.message;
      const role = author?.role || n.message?.role || 'user';
      const text = (content.parts || [])
        .map(p => typeof p === 'string' ? p : (p?.text || ''))
        .join('\n').trim()
        || content.text || n.message.text || '';
      return { role, text, created: create_time, images: content.images || [] };
    })
    .filter(m => m.text && m.role !== 'system');

  // Also handle flat messages array (Gemini/Claude scraper output)
  if (flat.length === 0 && Array.isArray(conv.messages)) {
    return conv.messages
      .filter(m => m.text || m.content)
      .map(m => ({ role: m.role || 'user', text: m.text || m.content || '', created: m.created, images: m.images || [] }));
  }

  return flat.sort((a, b) => (a.created || 0) - (b.created || 0));
}

function conversationToMarkdown(conv) {
  const msgs = flattenMessages(conv);
  const title = conv.title || 'Untitled';
  const created = conv.create_time ? new Date(conv.create_time * 1000) : null;
  const updated = conv.update_time ? new Date(conv.update_time * 1000) : null;
  const userCount = msgs.filter(m => m.role === 'user').length;
  const aiCount = msgs.filter(m => m.role === 'assistant').length;

  const modelSlug = (() => {
    for (const node of Object.values(conv.mapping || {})) {
      const slug = node?.message?.metadata?.model_slug || node?.message?.metadata?.default_model_slug;
      if (slug) return slug;
    }
    return conv.default_model_slug || null;
  })();

  const platformName = (conv.id || '').startsWith('gemini') ? 'Gemini'
    : (conv.id || '').startsWith('claude') ? 'Claude' : 'ChatGPT';

  let md = '---\n';
  md += `title: "${title.replace(/"/g, "'")}"\n`;
  if (conv._projectTitle) md += `project: "${conv._projectTitle}"\n`;
  if (conv.id) md += `id: ${conv.id}\n`;
  if (created) md += `created: ${created.toISOString()}\n`;
  if (updated) md += `updated: ${updated.toISOString()}\n`;
  if (modelSlug) md += `model: ${modelSlug}\n`;
  md += `messages: ${msgs.length}  # ${userCount} from you, ${aiCount} from ${platformName}\n`;
  if (conv.gizmo_id) md += `gpt_id: ${conv.gizmo_id}\n`;
  md += '---\n\n';

  md += `# ${title}\n\n`;
  if (conv._projectTitle) md += `**Project:** ${conv._projectTitle}  \n`;
  if (created) md += `**Created:** ${created.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}  \n`;
  if (modelSlug) md += `**Model:** ${modelSlug}  \n`;
  md += '\n---\n\n';

  for (const m of msgs) {
    const lbl = m.role === 'user' ? '## You'
      : m.role === 'assistant' ? `## ${platformName}`
      : m.role === 'tool' ? '## Tool' : `## ${m.role}`;
    const ts = m.created ? `\n*${new Date(m.created * 1000).toLocaleTimeString()}*` : '';
    md += `${lbl}${ts}\n\n${m.text}\n\n---\n\n`;
  }
  return md;
}

function conversationsToHTML(convs) {
  const hasProjects = convs.some(c => c._projectTitle);
  const groups = {};
  convs.forEach(c => { const k = c._projectTitle || '__all__'; (groups[k] = groups[k] || []).push(c); });

  const body = Object.entries(groups).map(([gk, gconvs]) => {
    const heading = hasProjects && gk !== '__all__'
      ? `<h2 class="g-head">${escHtml(gk)}</h2>` : '';
    return heading + gconvs.map(conv => {
      const created = conv.create_time ? new Date(conv.create_time * 1000).toLocaleDateString() : '';
      const msgsHtml = flattenMessages(conv).map(m => {
        const cls = m.role === 'user' ? 'u' : 'a';
        const label = m.role === 'user' ? 'You' : 'AI';
        return `<div class="m ${cls}"><div class="lbl">${label}</div><div class="txt">${escHtml(m.text).replace(/\n/g,'<br>')}</div></div>`;
      }).join('');
      return `<details class="cv"><summary><b>${escHtml(conv.title||'Untitled')}</b><span class="dt">${created}</span></summary><div class="ms">${msgsHtml}</div></details>`;
    }).join('');
  }).join('');

  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>Chat Export</title>
<style>
body{background:#0f0f0f;color:#eee;font-family:-apple-system,sans-serif;padding:2rem;max-width:960px;margin:0 auto}
h1{color:#10a37f;font-size:1.8rem;margin-bottom:.3rem}.meta{color:#888;font-size:.85rem;margin-bottom:1.5rem}
input{width:100%;padding:.6rem 1rem;background:#1a1a1a;border:1px solid #2c2c2c;border-radius:8px;color:#eee;font-size:1rem;margin-bottom:1.2rem;outline:none}
input:focus{border-color:#10a37f}
.g-head{color:#10a37f;font-size:1rem;padding:.4rem 1rem;border-left:3px solid #10a37f;background:rgba(16,163,127,.07);border-radius:0 8px 8px 0;margin:1.2rem 0 .6rem}
.cv{border:1px solid #2c2c2c;border-radius:10px;margin-bottom:.5rem;background:#1a1a1a;overflow:hidden}
.cv>summary{cursor:pointer;padding:.8rem 1.2rem;display:flex;justify-content:space-between;align-items:center;list-style:none}
.cv>summary:hover{background:rgba(255,255,255,.04)}.dt{color:#666;font-size:.75rem}
.ms{padding:1rem 1.2rem;border-top:1px solid #2c2c2c;display:flex;flex-direction:column;gap:.6rem}
.m{padding:.8rem 1rem;border-radius:8px;line-height:1.65;font-size:.9rem}
.u{background:#1e3a2f;align-self:flex-end;max-width:82%}.a{background:#222;border:1px solid #2c2c2c}
.lbl{font-size:.65rem;font-weight:700;color:#10a37f;margin-bottom:.35rem;text-transform:uppercase;letter-spacing:.04em}
.txt{white-space:pre-wrap;word-break:break-word}.hidden{display:none}
</style></head>
<body>
<h1>Chat Export</h1>
<p class="meta">Exported ${new Date().toLocaleString()} &middot; ${convs.length} conversations</p>
<input type="search" id="s" placeholder="Search conversations...">
${body}
<script>document.getElementById('s').addEventListener('input',function(){document.querySelectorAll('.cv').forEach(e=>e.classList.toggle('hidden',this.value.length>0&&!e.textContent.toLowerCase().includes(this.value.toLowerCase())))})<\/script>
</body></html>`;
}

function formatToCSV(conv) {
  let csv = 'Role,Timestamp,Content\n';
  for (const m of flattenMessages(conv)) {
    const role = m.role.toUpperCase();
    const ts = m.created ? new Date(m.created * 1000).toISOString() : '';
    const text = m.text.replace(/"/g, '""');
    csv += `"${role}","${ts}","${text}"\n`;
  }
  return csv;
}

// ─── Asset Helpers ────────────────────────────────────────────────────────────
function extractAssetUrls(conv) {
  const urls = new Set();
  for (const node of Object.values(conv.mapping || {})) {
    const msg = node?.message;
    if (!msg?.content) continue;
    const { content, metadata } = msg;
    (content.images || []).forEach(u => urls.add(u));
    for (const att of (content.attachments || metadata?.attachments || [])) {
      if (att.url) urls.add(att.url);
      if (att.download_url) urls.add(att.download_url);
    }
    for (const part of (content.parts || [])) {
      if (typeof part === 'string') {
        (part.match(/https?:\/\/files\.oaiusercontent\.com\/[^\s"'<>)]+/gi) || []).forEach(u => urls.add(u));
        (part.match(/https?:\/\/[^\s"'<>)]+\.(png|jpg|jpeg|gif|webp|pdf|svg)/gi) || []).forEach(u => urls.add(u));
      } else if (part?.url && !part.url.startsWith('file-service://')) {
        urls.add(part.url);
      }
    }
  }
  return [...urls];
}

function assetFilename(url) {
  try {
    const parts = new URL(url).pathname.split('/');
    return (parts[parts.length - 1] || 'file').replace(/[^a-zA-Z0-9.\-_]/g, '_');
  } catch { return 'asset_' + Date.now(); }
}

async function fetchBytes(url, token) {
  const isOAI = /oaistatic\.com|oaiusercontent\.com|chatgpt\.com/.test(url);
  const headers = {};
  if (isOAI && token) headers['Authorization'] = `Bearer ${token}`;
  const resp = await fetch(url, { headers });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return new Uint8Array(await resp.arrayBuffer());
}

// ─── Tab Scraping (Gemini / Claude) ──────────────────────────────────────────
async function navigateAndScrape(url, msgType, label = '') {
  const tab = await chrome.tabs.create({ url, active: false });
  let lastErr = new Error('Content script never responded');

  for (let attempt = 0; attempt < MAX_SCRAPE_ATTEMPTS; attempt++) {
    await sleep(attempt === 0 ? 3000 : 2000);
    try {
      const r = await chrome.tabs.sendMessage(tab.id, { type: msgType });
      if (r?.messages?.length > 0) {
        chrome.tabs.remove(tab.id).catch(() => {});
        return normalizeScrapedChat(r, label);
      }
      lastErr = new Error(`Scraper got 0 messages on attempt ${attempt + 1}`);
    } catch (e) { lastErr = e; }
  }
  chrome.tabs.remove(tab.id).catch(() => {});
  throw lastErr;
}

async function getGeminiChatFromTab(tabId) {
  const r = await chrome.tabs.sendMessage(tabId, { type: 'SCRAPE_GEMINI_CHAT' });
  if (!r?.messages?.length) throw new Error('Gemini scraper returned no messages — refresh and try again.');
  return normalizeScrapedChat(r, 'Gemini');
}

async function getClaudeChatFromTab(tabId) {
  const r = await chrome.tabs.sendMessage(tabId, { type: 'SCRAPE_CLAUDE_CHAT' });
  if (!r?.messages?.length) throw new Error('Claude scraper returned no messages — refresh and try again.');
  return normalizeScrapedChat(r, 'Claude');
}

// Convert flat scraped messages into a mapping-style conv object formatters can use
function normalizeScrapedChat(r, fallbackTitle) {
  const id = (r.title || fallbackTitle).toLowerCase().replace(/\s+/g, '-') + '-' + Date.now();
  return {
    id,
    title: r.title || fallbackTitle,
    messages: r.messages,  // flattenMessages handles this via the flat fallback
    mapping: {},           // empty so flattenMessages uses messages array
    create_time: r.messages[0]?.created || Date.now() / 1000,
  };
}

// ─── Offscreen ZIP ────────────────────────────────────────────────────────────
async function createZipViaOffscreen(fileList, zipFilename) {
  const offscreenUrl = chrome.runtime.getURL('offscreen.html');
  const existing = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'], documentUrls: [offscreenUrl],
  }).catch(() => []);
  if (!existing.length) {
    await chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['BLOBS', 'DOM_SCRAPING'],
      justification: 'Build ZIP using Blob API',
    });
  }
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Offscreen ZIP timed out')), OFFSCREEN_TIMEOUT_MS);
    chrome.runtime.sendMessage({ type: 'CREATE_ZIP_BLOB', files: fileList, filename: zipFilename }, (resp) => {
      clearTimeout(timeout);
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      if (resp?.error) return reject(new Error(resp.error));
      resolve(resp?.success);
    });
  });
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

async function chatgptFetch(path, token) {
  const url = path.startsWith('http') ? path : `${CHATGPT_BASE}${path}`;
  const res = await fetch(url, { headers: { 'Authorization': `Bearer ${token}` }, credentials: 'include' });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${path}`);
  return res.json();
}

// ─── Storage ──────────────────────────────────────────────────────────────────
async function saveHistoryToStorage(convs, scope) {
  if (!convs.length) return;
  const records = convs.map(c => {
    const msgs = flattenMessages(c);
    const firstUser = msgs.find(m => m.role === 'user');
    const snippet = (firstUser?.text || '').slice(0, 300);
    const wordCount = msgs.reduce((acc, m) => acc + m.text.split(/\s+/).filter(Boolean).length, 0);
    const textContext = msgs.map(m => m.text).join(' ').toLowerCase();
    const keywords = [...new Set(
      (textContext.match(/[a-z]{4,}/g) || []).filter(w => !STOP_WORDS.has(w))
    )].slice(0, 10);
    return {
      id: c.id || 'c-' + Date.now() + Math.random(),
      title: c.title || 'Untitled',
      project: c._projectTitle || scope || 'General',
      createdAt: c.create_time || Date.now() / 1000,
      wordCount, promptSnippet: snippet, keywords,
    };
  });

  return new Promise(resolve => {
    chrome.storage.local.get(['history', 'totalChatsExported'], res => {
      const existing = res.history || [];
      const existingIds = new Set(existing.map(r => r.id));
      const fresh = records.filter(r => !existingIds.has(r.id));
      const merged = [...fresh, ...existing].slice(0, 2000);
      const total = (res.totalChatsExported || 0) + fresh.length;
      chrome.storage.local.set({ history: merged, totalChatsExported: total, lastExportAt: Date.now() }, resolve);
    });
  });
}

// ─── Utilities ────────────────────────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function escHtml(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function safeFilename(s) { return String(s).replace(/[^a-zA-Z0-9\-_ ]/g,'_').replace(/\s+/g,'_').slice(0,80); }
