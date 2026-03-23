// content.js — runs on chatgpt.com, extracts auth token + project data from DOM

(function () {
  function getAccessToken() {
    try {
      const bootstrap = document.getElementById('client-bootstrap');
      if (bootstrap) {
        const data = JSON.parse(bootstrap.textContent);
        if (data?.session?.accessToken) return data.session.accessToken;
      }
    } catch (_) {}
    try {
      const scripts = document.querySelectorAll('script[type="application/json"]');
      for (const s of scripts) {
        const match = s.textContent.match(/"accessToken":"([^"]+)"/);
        if (match) return match[1];
      }
    } catch (_) {}
    return null;
  }

  // Scrape projects from the ChatGPT sidebar.
  // Project links look like: /g/g-p-<hash>-<name>/project
  function getProjectsFromDOM() {
    const projects = [];
    const seen = new Set();
    
    // Look for links that point to GPTs or Projects
    const links = Array.from(document.querySelectorAll('a[href*="/g/"], a[href*="/project/"]'));
    
    for (const a of links) {
      const href = a.getAttribute('href') || '';
      // Matches both /g/g-p-... and /project/... style URLs
      const match = href.match(/\/(g\/)?(g-p-[^/]+)/) || href.match(/\/project\/([^/]+)/);
      if (!match) continue;
      
      const rawId = match[2] || match[1];
      // Strip slug: OpenAI often appends -name to the ID in the URL. 
      // Gizmo IDs are g-p-HEX (3 parts). Projects are often just the ID.
      const parts = rawId.split('-');
      const id = rawId.startsWith('g-p-') ? parts.slice(0, 3).join('-') : parts[0];
      
      if (seen.has(id)) continue;
      seen.add(id);
      
      const title = a.querySelector('.truncate')?.innerText?.trim()
        || a.innerText?.trim()
        || id.replace(/^g-p-[a-f0-9]+-/, '').replace(/-/g, ' ');
        
      projects.push({ id, title, gizmoId: id.startsWith('g-p-') ? id : null });
    }
    return projects;
  }

  // Also detect current project from the URL
  function getCurrentProjectFromURL() {
    const match = location.pathname.match(/\/g\/(g-p-[^/]+)/);
    if (!match) return null;
    const gizmoId = match[1];
    const slug = gizmoId.replace(/^g-p-[a-f0-9]+-/, '').replace(/-/g, ' ');
    return { id: gizmoId, title: slug, gizmoId };
  }

  // ─── UI Injection (Global Quick-Hub & Sidebar) ─────────────────────────────
  function injectGlobalHub() {
    if (document.getElementById('cgpt-global-hub')) return;
    
    const hub = document.createElement('div');
    hub.id = 'cgpt-global-hub';
    hub.innerHTML = `
      <div class="hub-container" style="position:fixed;bottom:24px;right:24px;z-index:99999;display:flex;align-items:center;gap:12px;background:rgba(26,26,26,0.85);backdrop-filter:blur(12px);padding:8px 16px;border-radius:14px;border:1px solid rgba(255,255,255,0.1);box-shadow:0 8px 32px rgba(0,0,0,0.4);transition:all 0.3s cubic-bezier(0.19, 1, 0.22, 1);transform:translateY(0);color:#eee;font-family:sans-serif;">
        <div class="hub-logo" style="width:28px;height:28px;background:#10a37f;border-radius:8px;display:flex;align-items:center;justify-content:center;box-shadow:0 0 15px rgba(16,163,127,0.4)">
           <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="3"><polyline points="18 20 18 10 12 20 12 4 6 20 6 14"/></svg>
        </div>
        <div style="width:1px;height:20px;background:rgba(255,255,255,0.1)"></div>
        <button class="hub-btn" id="hub-export-btn" title="Export Current Chat" style="background:transparent;border:none;color:#eee;cursor:pointer;padding:8px;border-radius:8px;transition:all 0.2s;display:flex;align-items:center;">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
        </button>
        <button class="hub-btn" id="hub-dash-btn" title="Open Insights" style="background:transparent;border:none;color:#eee;cursor:pointer;padding:8px;border-radius:8px;transition:all 0.2s;display:flex;align-items:center;">
           <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="9" y1="21" x2="9" y2="9"/></svg>
        </button>
      </div>
    `;

    document.body.appendChild(hub);

    const style = document.createElement('style');
    style.textContent = `
      #cgpt-global-hub:hover .hub-container { border-color: rgba(16,163,127,0.5); transform: translateY(-4px); }
      .hub-btn:hover { background: rgba(255,255,255,0.1); color: #10a37f !important; }
    `;
    document.head.appendChild(style);

    document.getElementById('hub-dash-btn').onclick = () => chrome.runtime.sendMessage({ type: 'OPEN_DASHBOARD' });
    document.getElementById('hub-export-btn').onclick = () => {
        const btn = document.getElementById('hub-export-btn');
        btn.style.color = '#10a37f';
        chrome.runtime.sendMessage({ type: 'RUN_QUICK_EXPORT' });
        setTimeout(() => btn.style.color = '#eee', 2000);
    };
  }

  function injectSidebarUI() {
    if (document.getElementById('cgpt-exporter-btn')) return;

    // ChatGPT uses nav, Gemini uses chat-app or specific sidebars
    const sidebar = document.querySelector('nav') || document.querySelector('side-navigation-v2');
    if (!sidebar) return;

    const btn = document.createElement('div');
    btn.id = 'cgpt-exporter-btn';
    btn.innerHTML = `
      <div class="cgpt-exporter-inner" style="display:flex;align-items:center;gap:12px;cursor:pointer;padding:10px 12px;border-radius:10px;margin:8px;transition:background 0.2s;color:#c5c5d2;">
        <div style="width:24px;height:24px;background:#10a37f;border-radius:6px;display:flex;align-items:center;justify-content:center;box-shadow:0 0 10px rgba(16,163,127,0.3)">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="3"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>
        </div>
        <span style="font-weight:500;font-size:14px">Explorer Insights</span>
      </div>
    `;

    const inner = btn.querySelector('.cgpt-exporter-inner');
    inner.onmouseover = () => { inner.style.background = 'rgba(255,255,255,0.1)'; };
    inner.onmouseout = () => { inner.style.background = 'none'; };
    btn.onclick = () => chrome.runtime.sendMessage({ type: 'OPEN_DASHBOARD' });

    // Insert at the bottom of the nav
    const profile = sidebar.lastElementChild;
    if (profile) sidebar.insertBefore(btn, profile);
    else sidebar.appendChild(btn);
  }

  // ─── Selection Export (Floating Snippet Button) ──────────────────────────────
  document.addEventListener('mouseup', (e) => {
    const selection = window.getSelection().toString().trim();
    let btn = document.getElementById('cgpt-snippet-btn');
    
    if (selection.length > 10) {
      if (!btn) {
        btn = document.createElement('button');
        btn.id = 'cgpt-snippet-btn';
        btn.innerHTML = 'Export Snippet';
        Object.assign(btn.style, {
          position: 'absolute', background: '#10a37f', color: 'white', border: 'none',
          padding: '6px 12px', borderRadius: '20px', fontSize: '12px', fontWeight: '600',
          cursor: 'pointer', zIndex: '10000', boxShadow: '0 4px 12px rgba(0,0,0,0.3)', display: 'none'
        });
        document.body.appendChild(btn);
      }
      
      const range = window.getSelection().getRangeAt(0);
      const rect = range.getBoundingClientRect();
      btn.style.left = `${rect.left + window.scrollX - 40}px`; 
      btn.style.top = `${rect.top + window.scrollY - 45}px`;
      btn.style.display = 'block';
      
      btn.onclick = (ev) => {
        ev.stopPropagation();
        chrome.runtime.sendMessage({ 
            type: 'SAVE_SNIPPET', 
            snippet: selection, 
            source: document.title || 'AI Chat'
        });
        btn.innerHTML = '✓ Saved!';
        btn.style.background = '#0d8a6a';
        setTimeout(() => {
            btn.style.display = 'none';
            btn.innerHTML = 'Export Snippet';
            btn.style.background = '#10a37f';
        }, 1500);
      };
    } else if (btn) {
      btn.style.display = 'none';
    }
  });

  // Auto-init for supported domains
  if (location.hostname.includes('chatgpt.com') || location.hostname.includes('gemini.google.com')) {
    setInterval(() => {
      injectGlobalHub();
      injectSidebarUI();
    }, 2000);
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'GET_TOKEN') {
      sendResponse({ token: getAccessToken() });
    }
    if (msg.type === 'GET_PROJECTS_FROM_DOM') {
      const dom = getProjectsFromDOM();
      const current = getCurrentProjectFromURL();
      const map = {};
      [...dom, ...(current ? [current] : [])].forEach(p => { map[p.id] = p; });
      sendResponse({ projects: Object.values(map) });
    }
    if (msg.type === 'SCRAPE_GEMINI_CHAT') {
      const messages = [];
      // Gemini DOM structure (current best-guess based on standard layout)
      // Usually messages are divs containing the text parts
      const userItems = document.querySelectorAll('.query-text');
      const responseItems = document.querySelectorAll('.message-content');
      
      const containers = document.querySelectorAll('.chat-content-container, mat-sidenav-content');
      // If we can't find specific containers, we'll try a generic approach
      const entries = document.querySelectorAll('div[class*="message"], div[class*="query"]');
      
      // Let's try to find all pairs
      // Gemini often puts user queries in .query-text and responses in .message-content
      const allText = document.querySelectorAll('.query-text, .message-content, .model-response-text, .conversation-container, ms-chat-breakpoint, .user-query');
      
      allText.forEach(el => {
        const isUser = el.classList.contains('query-text') || el.classList.contains('user-query') || el.tagName === 'USER-QUERY';
        const text = el.innerText.trim();
        if (text && text.length > 0) {
            messages.push({
              role: isUser ? 'user' : 'assistant',
              text: text,
              created: Date.now() / 1000
            });
        }
      });

      if (messages.length === 0) {
        // Broad search for chat-like elements
        const chatBlocks = document.querySelectorAll('div[role="article"], .msg-content');
        chatBlocks.forEach(b => {
             const role = b.querySelector('.user-query, [aria-label*="user"]') ? 'user' : 'assistant';
             messages.push({ role, text: b.innerText.trim() });
        });
      }

      sendResponse({ 
        chat: {
          id: 'gemini-' + Date.now(),
          title: document.title.replace(' - Gemini', '') || 'Gemini Chat',
          mapping: messages.map((m, i) => ({
            id: i,
            message: {
                author: { role: m.role },
                content: { parts: [m.text] },
                create_time: m.created
            }
          })),
          create_time: Date.now() / 1000
        }
      });
    }
    return true;
  });
})();
