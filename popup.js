// ─── Platform Detection ───────────────────────────────────────────────────────
let currentPlatform = 'chatgpt';
let activeTabId = null;

async function detectPlatform() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;
  activeTabId = tab.id;
  
  const platformNameEl = document.getElementById('platform-name');
  const platformIconEl = document.getElementById('platform-icon');
  const noticeEl = document.querySelector('.notice');
  const tabs = document.querySelectorAll('.scope-tab');

  if (tab.url.includes('gemini.google.com')) {
    currentPlatform = 'gemini';
    document.body.dataset.platform = 'gemini';
    if (platformNameEl) platformNameEl.textContent = 'Gemini';
    if (noticeEl) noticeEl.textContent = '⚠️ Scrapes Gemini live chats & sidebar history';
    
    // Enable Gemini history discovery
    tabs[0].textContent = 'Current Chat';
    tabs[0].dataset.scope = 'gemini_current';
    tabs[1].textContent = 'Discovered History';
    tabs[1].dataset.scope = 'gemini_history';
    tabs[1].style.display = 'block';
    tabs[2].style.display = 'none'; 
    
    currentScope = 'gemini_current';
    updateExportButtonLabel();
    loadProjects('gemini'); 
  } else if (tab.url.includes('claude.ai')) {
    currentPlatform = 'claude';
    document.body.dataset.platform = 'claude';
    if (platformNameEl) platformNameEl.textContent = 'Claude';
    if (noticeEl) noticeEl.textContent = '⚠️ Scrapes Claude live chats & sidebar history';
    
    // Enable Claude history discovery
    tabs[0].textContent = 'Current Chat';
    tabs[0].dataset.scope = 'claude_current';
    tabs[1].textContent = 'Discovered History';
    tabs[1].dataset.scope = 'claude_history';
    tabs[1].style.display = 'block';
    tabs[2].style.display = 'none'; 
    
    currentScope = 'claude_current';
    updateExportButtonLabel();
    loadProjects('claude');
  } else {
    currentPlatform = 'chatgpt';
    document.body.dataset.platform = 'chatgpt';
    if (platformNameEl) platformNameEl.textContent = 'ChatGPT';
    if (noticeEl) noticeEl.innerHTML = '⚠️ Must be logged into <a href="https://chatgpt.com" target="_blank">chatgpt.com</a>';
  }
}

const CIRCUMFERENCE = 2 * Math.PI * 47;

// ─── DOM refs ─────────────────────────────────────────────────────────────────
const screens = {
  setup:    document.getElementById('screen-setup'),
  progress: document.getElementById('screen-progress'),
  done:     document.getElementById('screen-done'),
};

const badge        = document.getElementById('status-badge');
const phaseLabel   = document.getElementById('phase-label');
const ringFill     = document.getElementById('ring-fill');
const ringPct      = document.getElementById('ring-pct');
const statTotal    = document.getElementById('stat-total');
const statFetched  = document.getElementById('stat-fetched');
const statDl       = document.getElementById('stat-dl');
const logBox       = document.getElementById('log-box');
const doneMeta     = document.getElementById('done-meta');
const doneErrors   = document.getElementById('done-errors');
const btnExport    = document.getElementById('btn-export');
const btnRestart   = document.getElementById('btn-restart');
const projectPicker  = document.getElementById('project-picker');
const projectSelect  = document.getElementById('project-select');
const btnRefresh     = document.getElementById('btn-refresh-projects');

// ─── Scope state ──────────────────────────────────────────────────────────────
let currentScope = 'all';
let projectsCache = [];

detectPlatform();

// ─── Scope Tab Switching ──────────────────────────────────────────────────────
document.querySelectorAll('.scope-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.scope-tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    currentScope = tab.dataset.scope;

    updateExportButtonLabel();

    if (currentScope === 'project') {
      projectPicker.style.display = 'flex';
      if (projectsCache.length === 0) loadProjects();
    } else {
      projectPicker.style.display = 'none';
    }
  });
});

function updateExportButtonLabel() {
  const labels = {
    all: 'Export All Chats',
    projects_only: 'Export Projects Only',
    project: 'Export This Project',
    gemini_current: 'Export Current Gemini Chat',
    gemini_history: 'Export Discovered History',
    claude_current: 'Export Current Claude Chat',
    claude_history: 'Export Discovered History'
  };
  btnExport.innerHTML = `
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>
    </svg>
    ${labels[currentScope] || 'Export'}
  `;
}

// ─── Project Loading ──────────────────────────────────────────────────────────
async function loadProjects(platform = currentPlatform) {
  projectSelect.innerHTML = '<option value="">⏳ Loading projects…</option>';
  btnRefresh.classList.add('spinning');
  try {
    const resp = await chrome.runtime.sendMessage({ type: 'LOAD_PROJECTS', platform });
    projectsCache = resp?.projects || [];
    if (resp?.raw) log(`ℹ Project API: ${JSON.stringify(resp.raw).slice(0, 120)}`);
    renderProjectOptions();
  } catch (e) {
    projectSelect.innerHTML = '<option value="">Error loading projects</option>';
    log('⚠ ' + e.message);
  } finally {
    btnRefresh.classList.remove('spinning');
  }
}

function renderProjectOptions(projects = projectsCache) {
  if (projects.length === 0) {
    projectSelect.innerHTML = '<option value="">No projects found</option>';
    return;
  }
  projectSelect.innerHTML = projects.map(p =>
    `<option value="${p.id}">${p.title}</option>`
  ).join('');
}

btnRefresh.addEventListener('click', () => loadProjects(currentPlatform));

// ─── Screen switching ─────────────────────────────────────────────────────────
function showScreen(name) {
  Object.entries(screens).forEach(([k, el]) => {
    el.classList.toggle('active', k === name);
  });
}

// ─── Progress ring ────────────────────────────────────────────────────────────
function setRing(pct) {
  const offset = CIRCUMFERENCE * (1 - Math.min(pct, 100) / 100);
  ringFill.style.strokeDashoffset = offset;
  ringPct.textContent = Math.round(Math.min(pct, 100)) + '%';
}

// ─── Log ──────────────────────────────────────────────────────────────────────
const logLines = [];
function log(text) {
  logLines.push(text);
  if (logLines.length > 40) logLines.shift();
  logBox.textContent = logLines.join('\n');
  logBox.scrollTop = logBox.scrollHeight;
}

// ─── Phase labels ─────────────────────────────────────────────────────────────
const PHASE_LABELS = {
  idle:              'Ready',
  fetching_projects: 'Loading project list…',
  fetching_list:     'Fetching conversation list…',
  fetching_chats:    'Downloading chat messages…',
  saving:            'Building ZIP file…',
  done:              'Finished',
};

// ─── Apply status ─────────────────────────────────────────────────────────────
let lastPhase   = null;
let lastFetched = 0;
let lastSaved   = 0;
let lastErrors  = 0;

function applyStatus(state) {
  if (!state) return;
  const { running, total, fetched, downloaded, phase, errors, startedAt, finishedAt, projects } = state;

  // Update projects dropdown if we received them
  if (projects?.length > 0 && projectsCache.length === 0) {
    projectsCache = projects;
    renderProjectOptions(projects);
    btnRefresh.classList.remove('spinning');
    if (state.projectsRaw) log(`ℹ Project API: ${JSON.stringify(state.projectsRaw).slice(0, 120)}`);
  }

  // Badge
  if (running) {
    badge.textContent = 'Running';
    badge.className = 'badge running';
  } else if (phase === 'done' && startedAt) {
    badge.textContent = errors?.length > 0 ? 'Done ⚠' : 'Done';
    badge.className = 'badge done';
  } else {
    badge.textContent = 'Ready';
    badge.className = 'badge';
  }

  // Done screen
  if (!running && phase === 'done' && startedAt) {
    showScreen('done');
    const elapsed = ((finishedAt || Date.now()) - startedAt) / 1000;
    const errCount = errors?.length || 0;
    doneMeta.innerHTML = `
      <strong>${total}</strong> conversations &middot; <strong>${elapsed.toFixed(1)}s</strong>
      ${state.zipName ? `<br><code style="font-size:11px;color:#10a37f">${state.zipName}</code>` : ''}
      ${errCount > 0 ? `<br><span style="color:#e55353">⚠ ${errCount} warning${errCount>1?'s':''}</span>` : ''}
    `;
    if (errCount > 0) {
      doneErrors.style.display = 'block';
      doneErrors.textContent = errors.slice(0, 15).join('\n');
    }
    return;
  }

  // Progress screen
  if (running || (phase !== 'idle' && phase !== 'done')) {
    showScreen('progress');
  }

  phaseLabel.textContent = PHASE_LABELS[phase] || phase;

  const pct = total > 0 ? (fetched / total) * 100 : 0;
  setRing(pct);

  statTotal.textContent   = total > 0 ? total : '…';
  statFetched.textContent = fetched;
  statDl.textContent      = state.saved ?? 0;

  if (fetched > lastFetched) {
    log(`Fetched ${fetched}/${total || '?'} conversations`);
    lastFetched = fetched;
  }

  const saved = state.saved ?? 0;
  if (saved > lastSaved) {
    log(`Added ${saved} file${saved > 1 ? 's' : ''} to ZIP`);
    lastSaved = saved;
  }

  if (phase !== lastPhase) {
    log(`▶ ${PHASE_LABELS[phase] || phase}`);
    lastPhase = phase;
  }

  // Log new errors (don't spam)
  if (errors && errors.length > lastErrors) {
    const newErrs = errors.slice(lastErrors);
    newErrs.forEach(e => log('⚠ ' + e));
    lastErrors = errors.length;
  }
}

// ─── Polling ──────────────────────────────────────────────────────────────────
let pollInterval = null;

function startPolling() {
  if (pollInterval) return;
  pollInterval = setInterval(() => {
    chrome.runtime.sendMessage({ type: 'GET_STATUS' }, (state) => {
      if (chrome.runtime.lastError) return;
      applyStatus(state);
      if (state && !state.running && state.phase === 'done' && state.startedAt) {
        stopPolling();
      }
    });
  }, 700);
}

function stopPolling() {
  if (pollInterval) { clearInterval(pollInterval); pollInterval = null; }
}

// ─── Export button ────────────────────────────────────────────────────────────
btnExport.addEventListener('click', () => {
  const format       = document.querySelector('input[name="format"]:checked')?.value || 'json';
  const includeAssets = document.getElementById('opt-assets').checked;
  const projectId    = currentScope === 'project' ? projectSelect.value : null;

  if (currentScope === 'project' && !projectId) {
    log('⚠ Please select a project first.');
    return;
  }

  // Reset UI
  showScreen('progress');
  logLines.length = 0;
  lastPhase = null;
  lastFetched = 0;
  lastErrors = 0;
  setRing(0);
  statTotal.textContent   = '…';
  statFetched.textContent = '0';
  statDl.textContent      = '0';
  phaseLabel.textContent  = 'Initializing…';
  log('▶ Starting export…');
  log(`  Scope: ${currentScope}${projectId ? ' → ' + (projectSelect.options[projectSelect.selectedIndex]?.text || projectId) : ''}`);
  log(`  Format: ${format}, Assets: ${includeAssets}`);

  chrome.runtime.sendMessage({
    type: 'START_EXPORT',
    options: { format, includeAssets, scope: currentScope, projectId, tabId: activeTabId },
  }, () => {
    if (chrome.runtime.lastError) {
      log('Error: ' + chrome.runtime.lastError.message);
    }
    startPolling();
  });
});

// ─── Restart ──────────────────────────────────────────────────────────────────
btnRestart.addEventListener('click', () => {
  doneErrors.style.display = 'none';
  doneErrors.textContent = '';
  logLines.length = 0;
  badge.textContent = 'Ready';
  badge.className = 'badge';
  showScreen('setup');
});

// ─── Dashboard ────────────────────────────────────────────────────────────────
document.getElementById('btn-insights').addEventListener('click', () => {
   chrome.runtime.sendMessage({ type: 'OPEN_DASHBOARD' });
});

// ─── On popup open: check existing state ──────────────────────────────────────
chrome.runtime.sendMessage({ type: 'GET_STATUS' }, (state) => {
  if (chrome.runtime.lastError) return;
  if (state) {
    // Restore projects if cached
    if (state.projects?.length > 0) {
      projectsCache = state.projects;
      renderProjectOptions(state.projects);
    }
    // Restore running state
    if (state.running || (state.phase !== 'idle' && state.startedAt)) {
      applyStatus(state);
      if (state.running) startPolling();
    }
  }
});
