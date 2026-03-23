// content.js — runs on AI platforms to extract chat data
(function () {
  function getAccessToken() {
    try {
      // 1. Check all scripts for accessToken key
      const scripts = document.querySelectorAll('script');
      for (const s of scripts) {
        const text = s.textContent;
        const match = text.match(/"accessToken":"([^"]+)"/);
        if (match) return match[1];
        if (text.includes('__NEXT_DATA__')) {
            try {
                const data = JSON.parse(text);
                const token = data?.props?.pageProps?.session?.accessToken || data?.props?.session?.accessToken || data?.session?.accessToken;
                if (token) return token;
            } catch(e) {}
        }
      }
      // 2. Fallback to common bootstrap IDs or sessionStorage
      const bootstrap = document.getElementById('__NEXT_DATA__') || document.getElementById('client-bootstrap');
      if (bootstrap) {
        const data = JSON.parse(bootstrap.textContent);
        return data?.session?.accessToken || data?.props?.pageProps?.session?.accessToken;
      }
    } catch (_) {}
    return null;
  }

  function getProjectsFromDOM() {
    const projects = [];
    const seen = new Set();
    // Modern ChatGPT uses 'nav' with specific relative links
    const sidebarLinks = Array.from(document.querySelectorAll('nav a[href*="/g/"], nav a[href*="/project/"]'));
    sidebarLinks.forEach(a => {
      const href = a.getAttribute('href') || '';
      const match = href.match(/\/(g\/)?(g-p-[a-z0-9-]+)/) || href.match(/\/project\/([a-z0-9-]+)/);
      if (match) {
        const id = match[2] || match[1];
        if (!seen.has(id)) {
          seen.add(id);
          // Extract title: look for child text, or specific classes
          const title = (a.querySelector('div')?.innerText || a.innerText || id).trim().split('\n')[0];
          projects.push({ id, title, gizmoId: id.startsWith('g-p-') ? id : null, source: 'chatgpt' });
        }
      }
    });

    // Fallback if no specific links: Get from the "Recent" list too
    const recentLinks = Array.from(document.querySelectorAll('a[href^="/c/"]'));
    recentLinks.forEach(a => {
        const href = a.getAttribute('href');
        const id = href.split('/c/')[1];
        if (id && !seen.has(id)) {
            const title = (a.innerText || 'Chat').trim().split('\n')[0];
            if (title && title.length > 1) {
                seen.add(id);
                projects.push({ id, title, source: 'chatgpt' });
            }
        }
    });

    return projects;
  }

  function scrapeGemini() {
    const messages = [];
    const now = Date.now() / 1000;
    const titleEl = document.querySelector('[data-test-id="conversation-title"], [aria-label="Rename conversation"], h1');
    const title = (titleEl ? titleEl.innerText : document.title).replace(' - Gemini', '').trim();
    const items = document.querySelectorAll('.query-text, .user-query, [data-test-id="model-response"], .message-content, .inline-answer');
    items.forEach((el, idx) => {
      const text = el.innerText.trim();
      if (text.length < 2 || text.includes('Where should we start?')) return;
      const isUser = el.closest('.query-text, .user-query, .prompt-content') || el.matches('.query-text, .user-query, .prompt-content');
      messages.push({ role: isUser ? 'user' : 'assistant', text, created: now + (idx * 0.01) });
    });
    return { title, messages };
  }

  function scrapeClaude() {
    const messages = [];
    const titleEl = document.querySelector('header h1, h1') || { innerText: document.title };
    const title = titleEl.innerText.replace(' - Claude', '').trim();
    const containers = document.querySelectorAll('[data-testid="message-container"], .grid.gap-4');
    containers.forEach((el, idx) => {
        const text = el.innerText.trim();
        if (text.length < 2 || text === 'Copy' || text === 'Retry') return;
        const isUser = el.querySelector('.bg-bg-200, .bg-bg-300') || el.closest('.bg-bg-200, .bg-bg-300') || el.matches('.bg-bg-200');
        const role = isUser ? 'user' : 'assistant';
        if (messages.length > 0 && messages[messages.length-1].text.includes(text.slice(0, 30))) return;
        messages.push({ role, text, created: (Date.now()/1000) + idx });
    });
    return { title, messages: messages.filter(m => m.text.length > 0) };
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'GET_TOKEN') sendResponse({ token: getAccessToken() });
    if (msg.type === 'GET_PROJECTS_FROM_DOM') {
      const platform = location.hostname.includes('gemini') ? 'gemini' : (location.hostname.includes('claude') ? 'claude' : 'chatgpt');
      const map = {};
      const deepQuerySelectorAll = (selector, root = document) => {
        const results = Array.from(root.querySelectorAll(selector));
        const pushResults = (node) => {
          if (node.shadowRoot) results.push(...deepQuerySelectorAll(selector, node.shadowRoot));
          for (const child of Array.from(node.children)) pushResults(child);
        };
        pushResults(root === document ? document.body : root);
        return results;
      };
      
      if (platform === 'chatgpt') {
          getProjectsFromDOM().forEach(p => { map[p.id] = p; });
      } else if (platform === 'gemini') {
          deepQuerySelectorAll('a[href*="/app/"]').forEach(a => {
            const match = (a.getAttribute('href')||'').match(/\/app\/([a-z0-9]+)/);
            if (match) map[match[1]] = { id: match[1], title: a.innerText.trim(), source: 'gemini' };
          });
      } else if (platform === 'claude') {
          deepQuerySelectorAll('a[href*="/chat/"], [role="link"], [data-testid*="chat-link"]').forEach(a => {
            const href = a.getAttribute('href') || a.getAttribute('data-href') || '';
            const match = href.match(/\/chat\/([a-z0-9-]+)/);
            if (match) map[match[1]] = { id: match[1], title: a.innerText.trim() || match[1], source: 'claude' };
          });
      }
      sendResponse({ projects: Object.values(map) });
    }
    if (msg.type === 'SCRAPE_GEMINI_CHAT') sendResponse(scrapeGemini());
    if (msg.type === 'SCRAPE_CLAUDE_CHAT') sendResponse(scrapeClaude());
    return true;
  });

  function injectHubPill() {
    if (document.getElementById('hub-pill-root')) return;
    const root = document.createElement('div');
    root.id = 'hub-pill-root';
    root.style = 'position:fixed;bottom:28px;right:28px;z-index:2147483647;';
    root.innerHTML = `
      <div class="hub-container" style="display:flex;align-items:center;gap:10px;background:rgba(26,26,26,0.95);backdrop-filter:blur(18px);padding:10px 18px;border-radius:20px;border:1px solid rgba(255,255,255,0.1);box-shadow:0 12px 64px rgba(0,0,0,0.7);color:#eee;font-family:Inter, sans-serif; opacity: 0.45; transition: all 0.4s cubic-bezier(0.19, 1, 0.22, 1); transform: translateY(0);">
        <div class="hub-logo" style="width:34px;height:34px;background:#10a37f;border-radius:12px;display:flex;align-items:center;justify-content:center;box-shadow:0 0 25px rgba(16,163,127,0.5)">
           <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="3"><polyline points="18 20 18 10 12 20 12 4 6 20 6 14"></polyline></svg>
        </div>
        <div style="width:1px;height:24px;background:rgba(255,255,255,0.15);margin:0 4px;"></div>
        
        <button id="hub-md-btn" title="Quick Markdown Export" style="background:transparent;border:none;color:#eee;cursor:pointer;padding:10px;border-radius:12px;transition:all 0.2s;display:flex;flex-direction:column;align-items:center;gap:4px;">
           <span style="font-size:10px;font-weight:900;opacity:0.6;">MD</span>
           <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>
        </button>

        <button id="hub-html-btn" title="Quick HTML Export" style="background:transparent;border:none;color:#eee;cursor:pointer;padding:10px;border-radius:12px;transition:all 0.2s;display:flex;flex-direction:column;align-items:center;gap:4px;">
           <span style="font-size:10px;font-weight:900;opacity:0.6;">HTML</span>
           <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>
        </button>

        <button id="hub-json-btn" title="Quick JSON Export" style="background:transparent;border:none;color:#eee;cursor:pointer;padding:10px;border-radius:12px;transition:all 0.2s;display:flex;flex-direction:column;align-items:center;gap:4px;">
           <span style="font-size:10px;font-weight:900;opacity:0.6;">JSON</span>
           <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>
        </button>

        <div style="width:1px;height:24px;background:rgba(255,255,255,0.15);margin:0 4px;"></div>

        <button id="hub-dash-btn" title="Pulse Insights" style="background:transparent;border:none;color:#eee;cursor:pointer;padding:12px;border-radius:12px;transition:all 0.2s;display:flex;align-items:center;">
           <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><line x1="3" y1="9" x2="21" y2="9"></line><line x1="9" y1="21" x2="9" y2="9"></line></svg>
        </button>
      </div>
    `;
    const container = root.querySelector('.hub-container');
    container.onmouseenter = () => { container.style.opacity = '1'; container.style.transform = 'translateY(-6px)'; };
    container.onmouseleave = () => { container.style.opacity = '0.45'; container.style.transform = 'translateY(0)'; };
    
    document.body.appendChild(root);

    const trigger = (fmt) => {
      const type = location.hostname.includes('gemini') ? 'gemini' : (location.hostname.includes('claude') ? 'claude' : 'chatgpt');
      chrome.runtime.sendMessage({ 
        type: 'START_EXPORT', 
        options: { format: fmt, includeAssets: true, scope: `${type}_current`, tabId: 'current' }
      });
    };

    document.getElementById('hub-md-btn').onclick = () => trigger('md');
    document.getElementById('hub-html-btn').onclick = () => trigger('html');
    document.getElementById('hub-json-btn').onclick = () => trigger('json');
    document.getElementById('hub-dash-btn').onclick = () => {
      chrome.runtime.sendMessage({ type: 'OPEN_DASHBOARD' });
    };
  }
  setInterval(injectHubPill, 4000);
  injectHubPill();
})();
