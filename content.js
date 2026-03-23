// content.js — runs on AI platforms to extract chat data
(function () {
  let selectedScope = null;
  let selectedFmt = 'md';

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
    const type = location.hostname.includes('gemini') ? 'gemini' : (location.hostname.includes('claude') ? 'claude' : 'chatgpt');
    selectedScope = `${type}_current`;

    const root = document.createElement('div');
    root.id = 'hub-pill-root';
    root.style = 'position:fixed;bottom:24px;right:24px;z-index:2147483647;display:flex;flex-direction:column-reverse;align-items:flex-end;gap:12px;';
    root.innerHTML = `
      <style>
        .hub-menu { display:none; flex-direction:column; gap:12px; background:rgba(26,26,26,0.98); backdrop-filter:blur(24px); padding:16px; border-radius:24px; border:1px solid rgba(255,255,255,0.1); box-shadow:0 12px 64px rgba(0,0,0,0.8); animation: slideUp 0.3s cubic-bezier(0.19, 1, 0.22, 1); width:280px; }
        .hub-section { display:flex; flex-direction:column; gap:6px; }
        .hub-label { font-size:9px; font-weight:800; color:rgba(255,255,255,0.3); text-transform:uppercase; letter-spacing:0.1em; margin-bottom:4px; }
        .hub-opt { background:rgba(255,255,255,0.03); border:1px solid rgba(255,255,255,0.05); color:#eee; cursor:pointer; padding:10px 12px; border-radius:12px; font-size:11px; font-weight:700; text-align:left; transition:all 0.2s; display:flex; align-items:center; gap:8px; }
        .hub-opt:hover { background:rgba(255,255,255,0.08); transform:translateX(-4px); }
        .hub-opt.active { border-color:#10a37f; background:rgba(16,163,127,0.15); color:#fff; }
        .hub-btn-primary { background:#10a37f; border:none; color:white; padding:12px; border-radius:14px; font-weight:800; font-size:12px; cursor:pointer; margin-top:8px; transition:all 0.3s; box-shadow:0 0 20px rgba(16,163,127,0.3); }
        .hub-btn-primary:hover { background:#15b38d; transform:scale(1.02); box-shadow:0 0 30px rgba(16,163,127,0.5); }
        @keyframes slideUp { from { opacity:0; transform:translateY(10px); } to { opacity:1; transform:translateY(0); } }
      </style>
      <div class="hub-container" style="display:flex;align-items:center;gap:12px;background:rgba(26,26,26,0.95);backdrop-filter:blur(16px);padding:10px 14px;border-radius:24px;border:1px solid rgba(255,255,255,0.1);box-shadow:0 12px 48px rgba(0,0,0,0.6);cursor:pointer;transition:all 0.3s;">
        <div style="color:#eee;font-size:13px;font-weight:700;font-family:Inter,sans-serif;margin-left:4px;">PULSE ENGINE</div>
        <div style="width:1px;height:24px;background:rgba(255,255,255,0.1)"></div>
        <div class="hub-logo" style="width:32px;height:32px;background:#10a37f;border-radius:10px;display:flex;align-items:center;justify-content:center;box-shadow:0 0 20px rgba(16,163,127,0.5)">
           <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="3"><polyline points="18 20 18 10 12 20 12 4 6 20 6 14"></polyline></svg>
        </div>
      </div>
      <div class="hub-menu" id="hub-menu">
        <div class="hub-section">
           <div class="hub-label">Export Scope</div>
           <div class="hub-opt active" data-scope="${type}_current">✨ Current Active Chat</div>
           <div class="hub-opt" data-scope="all">📁 Entire History</div>
           <div class="hub-opt" data-scope="projects_only">💼 All Projects Only</div>
        </div>
        <div class="hub-section">
           <div class="hub-label">Output Format</div>
           <div style="display:grid; grid-template-columns:1fr 1fr; gap:8px;">
              <button class="hub-opt active" data-fmt="md" style="justify-content:center">Obsidian</button>
              <button class="hub-opt" data-fmt="html" style="justify-content:center">HTML</button>
              <button class="hub-opt" data-fmt="json" style="justify-content:center">JSON</button>
              <button class="hub-opt" data-fmt="csv" style="justify-content:center">CSV</button>
           </div>
        </div>
        <button class="hub-btn-primary" id="hub-trigger-export">Start Universal Export</button>
        <div style="height:1px;background:rgba(255,255,255,0.05);margin:4px 0;"></div>
        <button id="hub-dash-btn" style="background:transparent; border:none; color:rgba(255,255,255,0.4); font-size:10px; font-weight:700; cursor:pointer; text-align:center;">Open Advanced Dashboard</button>
      </div>
    `;
    const container = root.querySelector('.hub-container');
    const menu = root.querySelector('#hub-menu');
    container.onclick = (e) => {
      e.stopPropagation();
      menu.style.display = menu.style.display === 'flex' ? 'none' : 'flex';
    };
    document.addEventListener('click', () => { menu.style.display = 'none'; });
    menu.onclick = (e) => e.stopPropagation();

    menu.querySelectorAll('[data-scope]').forEach(opt => {
      opt.onclick = () => {
        menu.querySelectorAll('[data-scope]').forEach(o => o.classList.remove('active'));
        opt.classList.add('active');
        selectedScope = opt.dataset.scope;
      };
    });

    menu.querySelectorAll('[data-fmt]').forEach(opt => {
      opt.onclick = () => {
        menu.querySelectorAll('[data-fmt]').forEach(o => o.classList.remove('active'));
        opt.classList.add('active');
        selectedFmt = opt.dataset.fmt;
      };
    });

    root.querySelector('#hub-trigger-export').onclick = () => {
      chrome.runtime.sendMessage({ 
        type: 'START_EXPORT', 
        options: { format: selectedFmt, scope: selectedScope, tabId: 'current', includeAssets: true } 
      });
      menu.style.display = 'none';
    };
    
    root.querySelector('#hub-dash-btn').onclick = () => { chrome.runtime.sendMessage({ type: 'OPEN_DASHBOARD' }); menu.style.display = 'none'; };
    
    document.body.appendChild(root);
  }
  setInterval(injectHubPill, 4000); injectHubPill();
})();
