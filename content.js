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

  // ─── UI Injection (In-Page Button) ──────────────────────────────────────────
  function injectUI() {
    if (document.getElementById('cgpt-exporter-btn')) return;

    // Search for the Sidebar container (OpenAI uses 'nav')
    const sidebar = document.querySelector('nav');
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

    btn.onclick = () => {
       chrome.runtime.sendMessage({ type: 'OPEN_DASHBOARD' });
    };

    // Insert at the bottom of the nav before the user profile
    const profile = sidebar.lastElementChild;
    if (profile) {
      sidebar.insertBefore(btn, profile);
    } else {
      sidebar.appendChild(btn);
    }
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
          position: 'absolute',
          background: '#10a37f',
          color: 'white',
          border: 'none',
          padding: '6px 12px',
          borderRadius: '20px',
          fontSize: '12px',
          fontWeight: '600',
          cursor: 'pointer',
          zIndex: '10000',
          boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
          display: 'none'
        });
        document.body.appendChild(btn);
      }
      
      const range = window.getSelection().getRangeAt(0);
      const rect = range.getBoundingClientRect();
      // Offset to the left to avoid ChatGPT's native "Ask ChatGPT" bubble which usually appears in the center/right
      btn.style.left = `${rect.left + window.scrollX - 40}px`; 
      btn.style.top = `${rect.top + window.scrollY - 45}px`;
      btn.style.display = 'block';
      
      btn.onclick = (ev) => {
        ev.stopPropagation();
        chrome.runtime.sendMessage({ 
            type: 'SAVE_SNIPPET', 
            snippet: selection, 
            source: document.title || 'ChatGPT'
        });
        btn.style.display = 'none';
        window.getSelection().removeAllRanges();
      };
    } else if (btn) {
      btn.style.display = 'none';
    }
  });

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'GET_TOKEN') {
      sendResponse({ token: getAccessToken() });
    }
    if (msg.type === 'GET_PROJECTS_FROM_DOM') {
      const dom = getProjectsFromDOM();
      const current = getCurrentProjectFromURL();
      // merge, dedupe
      const map = {};
      [...dom, ...(current ? [current] : [])].forEach(p => { map[p.id] = p; });
      sendResponse({ projects: Object.values(map) });
    }
    return true;
  });
})();
