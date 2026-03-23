// content.js — runs on AI platforms to extract chat data
(function () {
  function getAccessToken() {
    try {
      // 1. Broad script scanning for any JWT-like token or accessToken key
      const scripts = document.querySelectorAll('script');
      for (const s of scripts) {
        const text = s.textContent;
        const match = text.match(/"accessToken":"([^"]+)"/) || text.match(/"token":"(eyJ[^"]+)"/);
        if (match) return match[1];
        if (text.includes('__NEXT_DATA__')) {
            try {
                const data = JSON.parse(text);
                const token = data?.props?.pageProps?.session?.accessToken || data?.props?.session?.accessToken;
                if (token) return token;
            } catch(e) {}
        }
      }
      // 2. Fallback to common bootstrap IDs
      const bootstrap = document.getElementById('client-bootstrap') || document.getElementById('__NEXT_DATA__');
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
    const links = Array.from(document.querySelectorAll('a[href*="/g/"], a[href*="/project/"]'));
    for (const a of links) {
      const href = a.getAttribute('href') || '';
      const match = href.match(/\/(g\/)?(g-p-[^/]+)/) || href.match(/\/project\/([^/]+)/);
      if (match) {
        const id = match[2] || match[1];
        if (!seen.has(id)) {
          seen.add(id);
          projects.push({ id, title: a.innerText.trim() || id, gizmoId: id.startsWith('g-p-') ? id : null });
        }
      }
    }
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
    console.log("🧬 [Pulse] Harvesting Claude Conversation...");
    const messages = [];
    const titleEl = document.querySelector('header h1, h1') || { innerText: document.title };
    const title = titleEl.innerText.replace(' - Claude', '').trim();
    
    // Structure: Look for the message units directly
    const msgContainers = document.querySelectorAll('[data-testid="message-container"], .grid.gap-4');
    msgContainers.forEach((el, idx) => {
        const text = el.innerText.trim();
        if (text.length < 2 || text === 'Copy' || text === 'Retry') return;
        
        // Identify role: Claude's user messages usually have a specific background or avatar
        // User messages are on the right or have a specific theme class
        const isUser = el.querySelector('.bg-bg-200, .bg-bg-300') || el.closest('.bg-bg-200, .bg-bg-300');
        const role = isUser ? 'user' : 'assistant';
        
        // Avoid duplicates in the same container (Claude sometimes repeats blocks)
        if (messages.length > 0 && messages[messages.length-1].text.includes(text.slice(0, 30))) return;
        
        messages.push({ role, text, created: (Date.now()/1000) + idx });
    });
    
    // Fallback if no specific containers found
    if (messages.length === 0) {
        const rawItems = document.querySelectorAll('.font-user, .font-claude, .prose');
        rawItems.forEach((el, idx) => {
            const role = el.matches('.font-user') || el.closest('.font-user') ? 'user' : 'assistant';
            messages.push({ role, text: el.innerText.trim() });
        });
    }

    return { title, messages: messages.filter(m => m.text.length > 0) };
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'GET_TOKEN') sendResponse({ token: getAccessToken() });
    if (msg.type === 'GET_PROJECTS_FROM_DOM') {
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
      if (location.hostname.includes('chatgpt.com')) getProjectsFromDOM().forEach(p => { map[p.id] = p; });
      else if (location.hostname.includes('gemini.google.com')) {
        deepQuerySelectorAll('a[href*="/app/"]').forEach(a => {
          const match = (a.getAttribute('href')||'').match(/\/app\/([a-z0-9]+)/);
          if (match) map[match[1]] = { id: match[1], title: a.innerText.trim(), source: 'gemini' };
        });
      } else if (location.hostname.includes('claude.ai')) {
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
    root.style = 'position:fixed;bottom:24px;right:24px;z-index:2147483647;';
    root.innerHTML = `
      <div class="hub-container" style="display:flex;align-items:center;gap:12px;background:rgba(26,26,26,0.95);backdrop-filter:blur(16px);padding:10px 18px;border-radius:18px;border:1px solid rgba(255,255,255,0.1);box-shadow:0 12px 48px rgba(0,0,0,0.6);color:#eee;font-family:Inter, sans-serif; opacity: 0.4; transition: opacity 0.3s;" onmouseenter="this.style.opacity='1'" onmouseleave="this.style.opacity='0.4'">
        <div class="hub-logo" style="width:32px;height:32px;background:#10a37f;border-radius:10px;display:flex;align-items:center;justify-content:center;box-shadow:0 0 20px rgba(16,163,127,0.5)">
           <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="3"><polyline points="18 20 18 10 12 20 12 4 6 20 6 14"></polyline></svg>
        </div>
        <div style="width:1px;height:24px;background:rgba(255,255,255,0.1)"></div>
        <button id="hub-export-btn" title="Quick Export (JSON)" style="background:transparent;border:none;color:#eee;cursor:pointer;padding:10px;border-radius:10px;transition:all 0.2s;display:flex;align-items:center;">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>
        </button>
        <button id="hub-dash-btn" title="Open Pulse Dashboard" style="background:transparent;border:none;color:#eee;cursor:pointer;padding:10px;border-radius:10px;transition:all 0.2s;display:flex;align-items:center;">
           <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><line x1="3" y1="9" x2="21" y2="9"></line><line x1="9" y1="21" x2="9" y2="9"></line></svg>
        </button>
      </div>
    `;
    document.body.appendChild(root);
    document.getElementById('hub-export-btn').onclick = () => {
       const type = location.hostname.includes('gemini') ? 'gemini' : (location.hostname.includes('claude') ? 'claude' : 'chatgpt');
       chrome.runtime.sendMessage({ type: 'START_EXPORT', options: { format: 'json', scope: `${type}_current`, tabId: 'current' } });
    };
    document.getElementById('hub-dash-btn').onclick = () => {
      chrome.runtime.sendMessage({ type: 'OPEN_DASHBOARD' });
    };
  }
  setInterval(injectHubPill, 4000);
  injectHubPill();
})();
