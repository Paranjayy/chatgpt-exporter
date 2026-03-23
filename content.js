// content.js — runs on AI platforms to extract chat data
(function () {
  function getAccessToken() {
    try {
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
    const sidebarLinks = Array.from(document.querySelectorAll('nav a[href*="/g/"], nav a[href*="/project/"]'));
    sidebarLinks.forEach(a => {
      const href = a.getAttribute('href') || '';
      // Regex correction: isolate IDs (g-p-...) before any title slugs
      const match = href.match(/\/(g\/)?(g-p-[a-z0-9]+)/) || href.match(/\/project\/([a-z0-9-]+)/);
      if (match) {
        const id = match[2] || match[1];
        if (!seen.has(id)) {
          seen.add(id);
          const title = (a.querySelector('div')?.innerText || a.innerText || id).trim().split('\n')[0];
          projects.push({ id, title, gizmoId: id.startsWith('g-p-') ? id : null, source: 'chatgpt' });
        }
      }
    });
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
    const items = document.querySelectorAll('.query-text, .user-query, [data-test-id="model-response"], .message-content, .inline-answer');
    items.forEach((el, idx) => {
      const text = el.innerText.trim();
      if (text.length < 2 || text.includes('Where should we start?')) return;
      const isUser = el.closest('.query-text, .user-query, .prompt-content') || el.matches('.query-text, .user-query, .prompt-content');
      messages.push({ role: isUser ? 'user' : 'assistant', text, created: now + (idx * 0.01) });
    });
    return { title: document.title, messages };
  }

  function scrapeClaude() {
    const messages = [];
    const containers = document.querySelectorAll('[data-testid="message-container"], .grid.gap-4');
    containers.forEach((el, idx) => {
        const text = el.innerText.trim();
        if (text.length < 2 || text === 'Copy' || text === 'Retry') return;
        const isUser = el.querySelector('.bg-bg-200, .bg-bg-300') || el.closest('.bg-bg-200, .bg-bg-300') || el.matches('.bg-bg-200');
        const role = isUser ? 'user' : 'assistant';
        messages.push({ role, text, created: (Date.now()/1000) + idx });
    });
    return { title: document.title, messages: messages.filter(m => m.text.length > 0) };
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'GET_TOKEN') sendResponse({ token: getAccessToken() });
    if (msg.type === 'GET_PROJECTS_FROM_DOM') {
      const platform = location.hostname.includes('gemini') ? 'gemini' : (location.hostname.includes('claude') ? 'claude' : 'chatgpt');
      const map = {};
      if (platform === 'chatgpt') getProjectsFromDOM().forEach(p => { map[p.id] = p; });
      else if (platform === 'gemini') {
          document.querySelectorAll('a[href*="/app/"]').forEach(a => {
            const match = (a.getAttribute('href')||'').match(/\/app\/([a-z0-9]+)/);
            if (match) map[match[1]] = { id: match[1], title: a.innerText.trim(), source: 'gemini' };
          });
      } else if (platform === 'claude') {
          document.querySelectorAll('a[href*="/chat/"], [role="link"], [data-testid*="chat-link"]').forEach(a => {
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
    root.style = 'position:fixed;bottom:16px;left:16px;z-index:2147483647;';
    root.innerHTML = `
      <div class="hub-container" style="display:flex;align-items:center;padding:5px;border-radius:12px;background:rgba(26,26,26,0.9);backdrop-filter:blur(6px);border:1px solid rgba(255,255,255,0.05);box-shadow:0 4px 16px rgba(0,0,0,0.4);opacity:0.05;transition:all 0.3s;transform:scale(0.85);transform-origin:bottom left;">
        <div style="width:28px;height:28px;background:#10a37f;border-radius:8px;display:flex;align-items:center;justify-content:center;">
           <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="4"><polyline points="18 20 18 10 12 20 12 4 6 20 6 14"></polyline></svg>
        </div>
        <div style="width:1px;height:12px;background:rgba(255,255,255,0.1);margin:0 6px;"></div>
        <button id="hub-md-btn" title="Markdown" style="background:transparent;border:none;color:#eee;cursor:pointer;padding:4px;font-size:9px;font-weight:900;">MD</button>
        <button id="hub-html-btn" title="HTML" style="background:transparent;border:none;color:#eee;cursor:pointer;padding:4px;font-size:9px;font-weight:900;">HT</button>
        <button id="hub-json-btn" title="JSON" style="background:transparent;border:none;color:#eee;cursor:pointer;padding:4px;font-size:9px;font-weight:900;">JS</button>
      </div>
    `;
    const container = root.querySelector('.hub-container');
    container.onmouseenter = () => { container.style.opacity = '1'; container.style.transform = 'scale(1)'; container.style.background = 'rgba(26,26,26,0.98)'; };
    container.onmouseleave = () => { container.style.opacity = '0.05'; container.style.transform = 'scale(0.85)'; container.style.background = 'rgba(26,26,26,0.9)'; };
    document.body.appendChild(root);
    const trigger = (fmt) => {
      const type = location.hostname.includes('gemini') ? 'gemini' : (location.hostname.includes('claude') ? 'claude' : 'chatgpt');
      chrome.runtime.sendMessage({ type: 'START_EXPORT', options: { format: fmt, scope: `${type}_current`, tabId: 'current' } });
    };
    document.getElementById('hub-md-btn').onclick = () => trigger('md');
    document.getElementById('hub-html-btn').onclick = () => trigger('html');
    document.getElementById('hub-json-btn').onclick = () => trigger('json');
  }
  setInterval(injectHubPill, 4000); injectHubPill();
})();
