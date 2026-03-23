// Dashboard Script - ChatGPT Exporter
let currentTab = 'home';
let historyData = [];

// ─── DOM Elements ──────────────────────────────────────────────────────────────
const navItems       = document.querySelectorAll('.nav-item');
const tabPanes       = document.querySelectorAll('.tab-pane');
const searchInput    = document.getElementById('main-search');
const statTotalVal   = document.getElementById('stat-total-val');
const cardConvCount  = document.getElementById('card-conv-count');
const cardPromptCount = document.getElementById('card-prompt-count');
const cardStorageVal = document.getElementById('card-storage-val');
const projectList    = document.getElementById('project-list');
const recentChatList = document.getElementById('recent-chat-list');
const promptHub      = document.getElementById('prompt-hub');
const searchResults  = document.getElementById('search-results');
const btnSync        = document.getElementById('btn-sync');

// ─── Initial Load ──────────────────────────────────────────────────────────────
async function init() {
    loadData();
    setupEventListeners();
    
    // Focus search on '/' key
    window.addEventListener('keydown', (e) => {
        if (e.key === '/' && document.activeElement !== searchInput) {
            e.preventDefault();
            searchInput.focus();
        }
    });
}

async function loadData() {
    chrome.storage.local.get(['history', 'totalChatsExported'], (res) => {
        historyData = res.history || [];
        const total = res.totalChatsExported || historyData.length || 0;
        
        statTotalVal.textContent = total;
        cardConvCount.textContent = total;
        
        renderHome();
        renderPrompts();
    });
}

function setupEventListeners() {
    navItems.forEach(item => {
        item.addEventListener('click', () => {
            const tab = item.dataset.tab;
            switchTab(tab);
        });
    });

    searchInput.addEventListener('input', (e) => {
        const query = e.target.value.toLowerCase();
        if (query.length > 0) {
            if (currentTab !== 'search') switchTab('search');
            performSearch(query);
        } else {
            switchTab('home');
        }
    });

    btnSync.addEventListener('click', () => {
        btnSync.textContent = 'Starting Global Export...';
        chrome.runtime.sendMessage({ 
            type: 'START_EXPORT', 
            options: { format: 'json', scope: 'all' } 
        }, () => {
            startPolling();
        });
    });
}

let pollInterval = null;
function startPolling() {
    if (pollInterval) return;
    pollInterval = setInterval(() => {
        chrome.runtime.sendMessage({ type: 'GET_STATUS' }, (state) => {
            if (!state) return;
            if (state.running) {
                btnSync.textContent = `Syncing: ${state.fetched}/${state.total || '?'}...`;
            } else if (state.phase === 'done') {
                btnSync.textContent = 'Sync Complete';
                stopPolling();
                loadData();
                setTimeout(() => btnSync.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M23 4v6h-6M1 20v-6h6M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg> Sync All`, 3000);
            }
        });
    }, 1000);
}

function stopPolling() {
    if (pollInterval) { clearInterval(pollInterval); pollInterval = null; }
}

// Check if an export is already running when we open the dashboard
chrome.runtime.sendMessage({ type: 'GET_STATUS' }, (state) => {
    if (state?.running) startPolling();
});

function switchTab(tabId) {
    currentTab = tabId;
    navItems.forEach(i => i.classList.toggle('active', i.dataset.tab === tabId));
    tabPanes.forEach(p => p.classList.toggle('active', p.id === `tab-${tabId}`));
}

// ─── Rendering ────────────────────────────────────────────────────────────────
function renderHome() {
    // Projects
    const projects = [...new Set(historyData.map(h => h.project))].filter(Boolean);
    projectList.innerHTML = projects.map(p => `
        <div class="project-item">
            <svg class="folder-icon" width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/></svg>
            <span class="name">${p}</span>
        </div>
    `).join('') || '<div style="padding:10px;color:#8b949e">No projects detected.</div>';

    // Recent Chats
    const recent = historyData.slice(0, 10);
    if (recent.length === 0) {
        recentChatList.innerHTML = '<div class="empty-state">No exports yet. Run an export from the popup.</div>';
    } else {
        recentChatList.innerHTML = recent.map(c => `
            <div class="chat-row">
                <div class="chat-info">
                    <div class="chat-title">${c.title}</div>
                    <div class="chat-meta">
                        <span class="tag">${c.project}</span>
                        <span>${new Date(c.createdAt * 1000).toLocaleDateString()}</span>
                    </div>
                </div>
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#8b949e" stroke-width="2"><path d="M9 18l6-6-6-6"/></svg>
            </div>
        `).join('');
    }
}

function renderPrompts() {
    const prompts = historyData.filter(h => h.promptSnippet && h.promptSnippet.length > 50).slice(0, 12);
    cardPromptCount.textContent = prompts.length;
    
    if (prompts.length === 0) {
        promptHub.innerHTML = '<div class="empty-state">No prompts extracted yet.</div>';
    } else {
        promptHub.innerHTML = prompts.map(p => `
            <div class="prompt-card">
                <div class="text">"${p.promptSnippet}..."</div>
                <div class="footer">
                    <span style="font-size:11px;color:#8b949e">${p.title}</span>
                    <button class="btn-copy" onclick="navigator.clipboard.writeText('${p.promptSnippet.replace(/'/g, "\\'")}')">Copy</button>
                </div>
            </div>
        `).join('');
    }
}

function performSearch(query) {
    const hits = historyData.filter(h => 
        h.title.toLowerCase().includes(query) || 
        h.promptSnippet.toLowerCase().includes(query) ||
        h.project.toLowerCase().includes(query)
    );
    
    if (hits.length === 0) {
        searchResults.innerHTML = '<div class="empty-state">No matches found for "' + query + '"</div>';
    } else {
        searchResults.innerHTML = hits.map(c => `
            <div class="chat-row">
                <div class="chat-info">
                    <div class="chat-title">${c.title}</div>
                    <div class="chat-meta">
                        <span class="tag">${c.project}</span>
                        <span style="color:#10a37f">${c.promptSnippet.slice(0, 60)}...</span>
                    </div>
                </div>
            </div>
        `).join('');
    }
}

document.addEventListener('DOMContentLoaded', init);
