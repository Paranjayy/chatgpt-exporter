// content.js — runs on ChatGPT / Gemini / Claude
(function () {
  if (!chrome.runtime?.id) return;

  // On chatgpt.com the floating compose bar is ~80px; push pill above it
  const CHATGPT_COMPOSE_OFFSET = '90px';

  // ─── Token Extraction (ChatGPT only) ───────────────────────────────────────
  function getAccessToken() {
    try {
      // Method 1: #client-bootstrap JSON blob
      const bootstrap = document.getElementById('client-bootstrap');
      if (bootstrap) {
        const data = JSON.parse(bootstrap.textContent);
        if (data?.session?.accessToken) return data.session.accessToken;
      }
    } catch (_) {}
    try {
      // Method 2: __NEXT_DATA__ script tag
      const nextData = document.getElementById('__NEXT_DATA__');
      if (nextData) {
        const data = JSON.parse(nextData.textContent);
        const t = data?.props?.pageProps?.session?.accessToken || data?.props?.session?.accessToken;
        if (t) return t;
      }
    } catch (_) {}
    try {
      // Method 3: scan all script tags for accessToken pattern
      for (const s of document.querySelectorAll('script')) {
        const match = s.textContent.match(/"accessToken"\s*:\s*"([^"]+)"/);
        if (match) return match[1];
      }
    } catch (_) {}
    return null;
  }

  // ─── Deep shadow-DOM query ─────────────────────────────────────────────────
  function deepQueryAll(selector, root = document) {
    const results = Array.from((root === document ? document : root).querySelectorAll(selector));
    const descend = (node) => {
      if (node.shadowRoot) results.push(...deepQueryAll(selector, node.shadowRoot));
      for (const child of Array.from(node.children || [])) descend(child);
    };
    descend(root === document ? (document.body || document.documentElement) : root);
    return results;
  }

  // ─── Project / Sidebar Discovery ──────────────────────────────────────────
  function getProjectsFromDOM() {
    const map = {};
    const host = location.hostname;

    if (host === 'chatgpt.com') {
      // Primary: nav links with /g/g-p-... or /project/...
      deepQueryAll('nav a[href*="/g/"], nav a[href*="/project/"]').forEach(a => {
        const href = a.getAttribute('href') || '';
        const match = href.match(/\/(g\/)?(g-p-[^/?#]+)/) || href.match(/\/project\/([^/?#]+)/);
        if (!match) return;
        const rawId = match[2] || match[1];
        // Strip slug suffix: g-p-HEXHEX-name → g-p-HEXHEX
        const parts = rawId.split('-');
        // ChatGPT project IDs are "g-p-<hex>-<slug>"; keep only the first 3 segments
        // e.g. "g-p-abc123-my-project-name" → "g-p-abc123"
        const id = rawId.startsWith('g-p-') ? parts.slice(0, 3).join('-') : rawId;
        if (!map[id]) {
          const title = a.querySelector('.truncate')?.innerText?.trim()
            || a.innerText?.trim()?.split('\n')[0]
            || id.replace(/^g-p-[a-f0-9]+-/, '').replace(/-/g, ' ');
          map[id] = { id, title, gizmoId: id.startsWith('g-p-') ? id : null, source: 'chatgpt' };
        }
      });
      // Also capture current project from URL
      const urlMatch = location.pathname.match(/\/g\/(g-p-[^/?#/]+)/);
      if (urlMatch) {
        const id = urlMatch[1];
        if (!map[id]) {
          map[id] = { id, title: id.replace(/^g-p-[a-f0-9]+-/, '').replace(/-/g, ' '), gizmoId: id, source: 'chatgpt' };
        }
      }

    } else if (host === 'gemini.google.com') {
      deepQueryAll('a[href*="/app/"]').forEach(a => {
        const match = (a.getAttribute('href') || '').match(/\/app\/([a-z0-9]+)/);
        if (!match) return;
        const id = match[1];
        const title = a.innerText.trim();
        // Skip nav items and "new chat" links
        if (!id || title.length < 2 || title.toLowerCase().includes('new chat') || title.toLowerCase().includes('gemini')) return;
        if (!map[id]) map[id] = { id, title, source: 'gemini' };
      });

    } else if (host === 'claude.ai') {
      deepQueryAll('a[href*="/chat/"]').forEach(a => {
        const match = (a.getAttribute('href') || '').match(/\/chat\/([a-z0-9-]+)/);
        if (!match) return;
        const id = match[1];
        const title = a.innerText.trim().split('\n')[0];
        if (!id || id.length < 5 || title.length < 2) return;
        if (!map[id]) map[id] = { id, title, source: 'claude' };
      });
    }

    return Object.values(map);
  }

  // ─── Gemini Scraper ────────────────────────────────────────────────────────
  function scrapeGemini() {
    const now = Date.now() / 1000;
    // Title
    const titleEl = document.querySelector(
      '[data-test-id="conversation-title"], .conversation-title, [aria-label="Rename conversation"], ' +
      'title-component h1, h1'
    );
    const title = (titleEl ? titleEl.innerText : document.title)
      .replace(/\s*[-–]\s*Gemini\s*$/i, '').trim();

    const messages = [];
    const seen = new Set();

    // Strategy 1: structured message pairs (most reliable)
    const userBlocks = document.querySelectorAll(
      '.query-text, .user-query-text, [data-test-id="user-query-text"], ' +
      '.user-message-content, .prompt-container .query-content'
    );
    const assistantBlocks = document.querySelectorAll(
      'model-response, .model-response, [data-test-id="model-response"], ' +
      '.response-container, .gemini-response'
    );

    // Walk in DOM order using a combined approach
    const allTurns = Array.from(document.querySelectorAll(
      '.conversation-container > *, ' +
      'chat-window > *, ' +
      '[data-test-id="conversation"] > *'
    ));

    if (allTurns.length > 0) {
      allTurns.forEach((el, idx) => {
        const text = el.innerText?.trim();
        if (!text || text.length < 3) return;
        const isUser = el.matches('[data-test-id*="user"], .user-query, .query-container, .prompt-container')
          || el.querySelector('[data-test-id*="user-query"], .query-text');
        const role = isUser ? 'user' : 'assistant';
        const key = role + text.slice(0, 80);
        if (!seen.has(key)) {
          seen.add(key);
          messages.push({ role, text, created: now + idx * 0.01 });
        }
      });
    }

    // Strategy 2: fallback — grab user queries and model responses separately
    if (messages.length === 0) {
      userBlocks.forEach((el, idx) => {
        const text = el.innerText?.trim();
        if (!text || text.length < 2) return;
        const key = 'user' + text.slice(0, 80);
        if (!seen.has(key)) { seen.add(key); messages.push({ role: 'user', text, created: now + idx * 0.01 }); }
      });
      assistantBlocks.forEach((el, idx) => {
        const text = el.innerText?.trim();
        if (!text || text.length < 2 || text.includes('Where should we start?')) return;
        const key = 'assistant' + text.slice(0, 80);
        if (!seen.has(key)) { seen.add(key); messages.push({ role: 'assistant', text, created: now + idx * 0.01 }); }
      });
    }

    // Strategy 3: broadest fallback
    if (messages.length === 0) {
      document.querySelectorAll(
        '.query-text, .user-query, [data-test-id="model-response"], .message-content, .inline-answer'
      ).forEach((el, idx) => {
        const text = el.innerText?.trim();
        if (!text || text.length < 3 || text.includes('Where should we start?')) return;
        const isUser = el.closest('.query-text, .user-query, .prompt-content')
          || el.matches('.query-text, .user-query');
        const role = isUser ? 'user' : 'assistant';
        const key = role + text.slice(0, 80);
        if (!seen.has(key)) {
          seen.add(key);
          messages.push({ role, text, created: now + idx * 0.01 });
        }
      });
    }

    return { title, messages };
  }

  // ─── Claude Scraper ────────────────────────────────────────────────────────
  function scrapeClaude() {
    const now = Date.now() / 1000;
    const titleEl = document.querySelector('header h1, h1, [data-testid="conversation-title"]');
    const title = (titleEl ? titleEl.innerText : document.title)
      .replace(/\s*[-–]\s*Claude\s*$/i, '').trim();

    const messages = [];
    const seen = new Set();

    const addMsg = (role, text, idx) => {
      if (!text || text.length < 2) return;
      if (/^(Copy|Retry|Good response|Bad response|Edit|Report)$/.test(text)) return;
      if (text.startsWith('View ') && text.endsWith(' artifacts')) return;
      const key = role + text.slice(0, 100);
      if (!seen.has(key)) { seen.add(key); messages.push({ role, text, created: now + idx * 0.01 }); }
    };

    // Strategy 1: data-testid="message-container" — most structured
    const containers = document.querySelectorAll('[data-testid*="message-container"]');
    if (containers.length > 0) {
      containers.forEach((el, idx) => {
        const isUser = (el.getAttribute('data-testid') || '').includes('user');
        const role = isUser ? 'user' : 'assistant';
        const contentEl = el.querySelector(
          '[data-testid*="message-content"], .grid-cols-1, .whitespace-pre-wrap'
        );
        const text = (contentEl || el).innerText?.trim();
        addMsg(role, text, idx);
      });
    }

    // Strategy 2: human-turn / assistant-turn class names
    if (messages.length === 0) {
      document.querySelectorAll('.human-turn, .assistant-turn, [data-testid="human-turn"], [data-testid="ai-turn"]').forEach((el, idx) => {
        const isUser = el.classList.contains('human-turn') || (el.getAttribute('data-testid') || '').includes('human');
        addMsg(isUser ? 'user' : 'assistant', el.innerText?.trim(), idx);
      });
    }

    // Strategy 3: bg colour bubble heuristic
    if (messages.length === 0) {
      document.querySelectorAll('.font-claude-message, [class*="MessageBlock"], .grid.gap-2, .grid.gap-4, .bg-bg-200, .bg-bg-300').forEach((el, idx) => {
        const text = el.innerText?.trim();
        if (!text || text.length < 2) return;
        const isUser = el.closest('.bg-bg-200, .bg-bg-300, [class*="human"]')
          || el.matches('.bg-bg-200, .bg-bg-300');
        addMsg(isUser ? 'user' : 'assistant', text, idx);
      });
    }

    // Strategy 4: max-w containers as last resort
    if (messages.length === 0) {
      document.querySelectorAll('.max-w-3xl, .max-w-4xl').forEach((el, idx) => {
        const text = el.innerText?.trim();
        if (!text || text.length < 10) return;
        // Heuristic: short text is usually user, long text is assistant
        addMsg(idx % 2 === 0 ? 'user' : 'assistant', text, idx);
      });
    }

    return { title, messages };
  }

  // ─── Message Listener ─────────────────────────────────────────────────────
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'GET_TOKEN') {
      sendResponse({ token: getAccessToken() });
      return true;
    }
    if (msg.type === 'GET_PROJECTS_FROM_DOM') {
      sendResponse({ projects: getProjectsFromDOM() });
      return true;
    }
    if (msg.type === 'SCRAPE_GEMINI_CHAT') {
      const data = scrapeGemini();
      console.log(`[Pulse] Gemini: "${data.title}" — ${data.messages.length} messages`);
      sendResponse({ messages: data.messages, title: data.title });
      return true;
    }
    if (msg.type === 'SCRAPE_CLAUDE_CHAT') {
      const data = scrapeClaude();
      console.log(`[Pulse] Claude: "${data.title}" — ${data.messages.length} messages`);
      sendResponse({ messages: data.messages, title: data.title });
      return true;
    }
    return true;
  });

  // ─── Snippet Selector Button ───────────────────────────────────────────────
  let snippetBtn = null;
  document.addEventListener('mouseup', () => {
    const sel = window.getSelection()?.toString()?.trim();
    if (!snippetBtn) {
      snippetBtn = document.createElement('button');
      snippetBtn.id = 'pulse-snippet-btn';
      Object.assign(snippetBtn.style, {
        position: 'absolute', background: '#10a37f', color: '#fff', border: 'none',
        padding: '5px 11px', borderRadius: '20px', fontSize: '11px', fontWeight: '700',
        cursor: 'pointer', zIndex: '2147483646', boxShadow: '0 4px 12px rgba(0,0,0,0.4)',
        display: 'none', fontFamily: 'Inter, sans-serif', letterSpacing: '0.02em',
        pointerEvents: 'all',
      });
      document.body.appendChild(snippetBtn);
    }
    if (sel && sel.length > 15) {
      const range = window.getSelection().getRangeAt(0);
      const rect = range.getBoundingClientRect();
      snippetBtn.style.left = `${rect.left + window.scrollX}px`;
      snippetBtn.style.top = `${rect.top + window.scrollY - 40}px`;
      snippetBtn.style.display = 'block';
      snippetBtn.textContent = '⚡ Save Snippet';
      snippetBtn.onclick = (e) => {
        e.stopPropagation();
        chrome.runtime.sendMessage({ type: 'SAVE_SNIPPET', snippet: sel, source: document.title });
        snippetBtn.textContent = '✓ Saved!';
        setTimeout(() => { snippetBtn.style.display = 'none'; snippetBtn.textContent = '⚡ Save Snippet'; }, 1500);
      };
    } else if (snippetBtn) {
      snippetBtn.style.display = 'none';
    }
  });

  // ─── Hub Pill ─────────────────────────────────────────────────────────────
  const PLATFORM = location.hostname === 'chatgpt.com' ? 'chatgpt'
    : location.hostname.includes('gemini') ? 'gemini'
    : location.hostname.includes('claude') ? 'claude' : null;

  if (!PLATFORM) return;

  let selectedScope = `${PLATFORM}_current`;
  let selectedFmt = 'md';

  function injectHubPill() {
    if (document.getElementById('hub-pill-root')) return;

    const root = document.createElement('div');
    root.id = 'hub-pill-root';
    // On ChatGPT the compose bar is ~80px tall; push pill up to avoid overlap
    const bottomPx = PLATFORM === 'chatgpt' ? CHATGPT_COMPOSE_OFFSET : '24px';
    root.style.cssText = `position:fixed;bottom:${bottomPx};right:24px;z-index:2147483647;display:flex;flex-direction:column-reverse;align-items:flex-end;gap:10px;font-family:Inter,system-ui,sans-serif;`;

    // Platform accent colours
    const ACCENT = PLATFORM === 'claude' ? '#c96442' : PLATFORM === 'gemini' ? '#4285f4' : '#10a37f';
    const LABEL = PLATFORM === 'chatgpt' ? 'ChatGPT' : PLATFORM === 'gemini' ? 'Gemini' : 'Claude';

    root.innerHTML = `
      <style>
        #hub-pill-root * { box-sizing: border-box; }
        #hub-menu { display:none; flex-direction:column; gap:10px; background:rgba(18,18,18,0.97); backdrop-filter:blur(24px); padding:14px; border-radius:20px; border:1px solid rgba(255,255,255,0.1); box-shadow:0 12px 64px rgba(0,0,0,0.85); width:272px; animation:hubSlideUp 0.25s cubic-bezier(0.19,1,0.22,1); }
        @keyframes hubSlideUp { from{opacity:0;transform:translateY(8px)} to{opacity:1;transform:translateY(0)} }
        .hub-section-label { font-size:9px; font-weight:800; color:rgba(255,255,255,0.3); text-transform:uppercase; letter-spacing:0.1em; margin-bottom:2px; }
        .hub-row { display:flex; flex-direction:column; gap:4px; }
        .hub-opt { background:rgba(255,255,255,0.03); border:1px solid rgba(255,255,255,0.07); color:#ccc; cursor:pointer; padding:9px 11px; border-radius:10px; font-size:11px; font-weight:600; text-align:left; transition:all 0.15s; display:flex; align-items:center; gap:7px; }
        .hub-opt:hover { background:rgba(255,255,255,0.07); color:#fff; }
        .hub-opt.active { border-color:${ACCENT}; background:${ACCENT}1a; color:#fff; }
        .hub-fmt-grid { display:grid; grid-template-columns:1fr 1fr; gap:5px; }
        .hub-fmt-grid .hub-opt { justify-content:center; padding:7px; }
        .hub-go { background:${ACCENT}; border:none; color:#fff; padding:11px; border-radius:12px; font-weight:800; font-size:12px; cursor:pointer; transition:all 0.2s; box-shadow:0 0 20px ${ACCENT}55; letter-spacing:0.03em; margin-top:2px; }
        .hub-go:hover { filter:brightness(1.1); transform:scale(1.01); }
        .hub-divider { height:1px; background:rgba(255,255,255,0.06); margin:2px 0; }
        .hub-dash-link { background:transparent; border:none; color:rgba(255,255,255,0.3); font-size:10px; font-weight:600; cursor:pointer; text-align:center; padding:4px; transition:color 0.15s; letter-spacing:0.02em; }
        .hub-dash-link:hover { color:rgba(255,255,255,0.7); }
      </style>
      <div id="hub-pill-bar" style="display:flex;align-items:center;gap:10px;background:rgba(18,18,18,0.95);backdrop-filter:blur(16px);padding:9px 14px;border-radius:20px;border:1px solid rgba(255,255,255,0.1);box-shadow:0 8px 40px rgba(0,0,0,0.7);cursor:pointer;transition:border-color 0.2s;" title="Pulse Exporter">
        <div style="width:28px;height:28px;background:${ACCENT};border-radius:8px;display:flex;align-items:center;justify-content:center;box-shadow:0 0 14px ${ACCENT}66;flex-shrink:0;">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2.8"><polyline points="18 20 18 10 12 20 12 4 6 20 6 14"/></svg>
        </div>
        <div style="width:1px;height:20px;background:rgba(255,255,255,0.1);flex-shrink:0;"></div>
        <span style="color:#ddd;font-size:12px;font-weight:700;letter-spacing:0.04em;">PULSE · ${LABEL}</span>
      </div>
      <div id="hub-menu">
        <div class="hub-row">
          <div class="hub-section-label">Export Scope</div>
          <button class="hub-opt active" data-scope="${PLATFORM}_current">✨ Current Chat</button>
          ${PLATFORM === 'chatgpt'
            ? `<button class="hub-opt" data-scope="all">📁 All History</button>
               <button class="hub-opt" data-scope="projects_only">💼 All Projects</button>`
            : `<button class="hub-opt" data-scope="${PLATFORM}_history">📁 All History</button>`
          }
        </div>
        <div class="hub-row">
          <div class="hub-section-label">Format</div>
          <div class="hub-fmt-grid">
            <button class="hub-opt active" data-fmt="md">Obsidian MD</button>
            <button class="hub-opt" data-fmt="html">HTML</button>
            <button class="hub-opt" data-fmt="json">JSON</button>
            <button class="hub-opt" data-fmt="csv">CSV</button>
          </div>
        </div>
        <button class="hub-go" id="hub-go-btn">⚡ Start Export</button>
        <div class="hub-divider"></div>
        <button class="hub-dash-link" id="hub-dash-btn">Open Dashboard →</button>
      </div>
    `;

    document.body.appendChild(root);

    const bar = root.querySelector('#hub-pill-bar');
    const menu = document.getElementById('hub-menu');

    bar.addEventListener('click', (e) => {
      e.stopPropagation();
      menu.style.display = menu.style.display === 'flex' ? 'none' : 'flex';
    });
    bar.addEventListener('mouseenter', () => { bar.style.borderColor = ACCENT + '88'; });
    bar.addEventListener('mouseleave', () => { bar.style.borderColor = 'rgba(255,255,255,0.1)'; });

    document.addEventListener('click', () => { menu.style.display = 'none'; });
    menu.addEventListener('click', (e) => e.stopPropagation());

    menu.querySelectorAll('[data-scope]').forEach(btn => {
      btn.addEventListener('click', () => {
        menu.querySelectorAll('[data-scope]').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        selectedScope = btn.dataset.scope;
      });
    });

    menu.querySelectorAll('[data-fmt]').forEach(btn => {
      btn.addEventListener('click', () => {
        menu.querySelectorAll('[data-fmt]').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        selectedFmt = btn.dataset.fmt;
      });
    });

    document.getElementById('hub-go-btn').addEventListener('click', () => {
      chrome.runtime.sendMessage({
        type: 'START_EXPORT',
        options: { format: selectedFmt, scope: selectedScope, tabId: 'current', includeAssets: true },
      });
      menu.style.display = 'none';
    });

    document.getElementById('hub-dash-btn').addEventListener('click', () => {
      chrome.runtime.sendMessage({ type: 'OPEN_DASHBOARD' });
      menu.style.display = 'none';
    });
  }

  // Poll to re-inject pill after SPA navigation
  setInterval(injectHubPill, 3000);
  injectHubPill();

})();
