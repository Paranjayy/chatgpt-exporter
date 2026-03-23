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
    return projects;
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'GET_TOKEN') sendResponse({ token: getAccessToken() });
    if (msg.type === 'GET_PROJECTS_FROM_DOM') {
      const map = {};
      getProjectsFromDOM().forEach(p => { map[p.id] = p; });
      sendResponse({ projects: Object.values(map) });
    }
    return true;
  });

  function injectHubPill() {
    if (document.getElementById('hub-pill-root')) return;
    const root = document.createElement('div');
    root.id = 'hub-pill-root';
    root.style = 'position:fixed;bottom:24px;left:24px;z-index:2147483647;display:flex;flex-direction:column-reverse;align-items:center;gap:12px;';
    root.innerHTML = `
      <style>
        .hub-menu { display:none; flex-direction:column; gap:8px; background:rgba(26,26,26,0.95); backdrop-filter:blur(16px); padding:10px; border-radius:14px; border:1px solid rgba(255,255,255,0.1); box-shadow:0 12px 48px rgba(0,0,0,0.6); animation: slideUp 0.3s cubic-bezier(0.19, 1, 0.22, 1); }
        .hub-menu button { background:transparent; border:none; color:#eee; cursor:pointer; padding:8px 12px; border-radius:8px; font-size:11px; font-weight:700; text-align:left; transition:all 0.2s; white-space:nowrap; }
        .hub-menu button:hover { background:rgba(255,255,255,0.1); transform:translateX(4px); }
        @keyframes slideUp { from { opacity:0; transform:translateY(10px); } to { opacity:1; transform:translateY(0); } }
      </style>
      <div class="hub-container" style="display:flex;align-items:center;gap:12px;background:rgba(26,26,26,0.95);backdrop-filter:blur(16px);padding:10px 14px;border-radius:18px;border:1px solid rgba(255,255,255,0.1);box-shadow:0 12px 48px rgba(0,0,0,0.6);cursor:pointer;transition:all 0.3s;">
        <div class="hub-logo" style="width:32px;height:32px;background:#10a37f;border-radius:10px;display:flex;align-items:center;justify-content:center;box-shadow:0 0 20px rgba(16,163,127,0.5)">
           <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="3"><polyline points="18 20 18 10 12 20 12 4 6 20 6 14"></polyline></svg>
        </div>
        <div style="width:1px;height:24px;background:rgba(255,255,255,0.1)"></div>
        <div style="color:#eee;font-size:13px;font-weight:700;font-family:Inter,sans-serif;">PULSE</div>
      </div>
      <div class="hub-menu" id="hub-menu">
        <button data-fmt="md">📄 MARKDOWN (Obsidian)</button>
        <button data-fmt="html">🌐 HTML ARCHIVE</button>
        <button data-fmt="json">📦 RAW JSON</button>
        <button data-fmt="csv">📊 SPREADSHEET (CSV)</button>
        <div style="height:1px;background:rgba(255,255,255,0.1);margin:4px 0;"></div>
        <button id="hub-dash-btn">🚀 OPEN DASHBOARD</button>
      </div>
    `;
    const container = root.querySelector('.hub-container');
    const menu = root.querySelector('#hub-menu');
    container.onclick = (e) => {
      e.stopPropagation();
      menu.style.display = menu.style.display === 'flex' ? 'none' : 'flex';
    };
    document.addEventListener('click', () => { menu.style.display = 'none'; });
    
    menu.querySelectorAll('button[data-fmt]').forEach(btn => {
      btn.onclick = () => {
        const fmt = btn.dataset.fmt;
        const type = location.hostname.includes('gemini') ? 'gemini' : (location.hostname.includes('claude') ? 'claude' : 'chatgpt');
        chrome.runtime.sendMessage({ type: 'START_EXPORT', options: { format: fmt, scope: `${type}_current`, tabId: 'current' } });
        menu.style.display = 'none';
      };
    });
    
    root.querySelector('#hub-dash-btn').onclick = () => { chrome.runtime.sendMessage({ type: 'OPEN_DASHBOARD' }); menu.style.display = 'none'; };
    
    document.body.appendChild(root);
  }
  setInterval(injectHubPill, 4000); injectHubPill();
})();
