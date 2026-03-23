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
function renderHome(filterProject = null) {
    // 1. Projects
    const projects = [...new Set(historyData.map(h => h.project))].filter(Boolean);
    projectList.innerHTML = `
        <div class="project-item ${!filterProject ? 'active' : ''}" data-project="all">
            <svg class="folder-icon" width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M13 13v8h8v-8h-8zM3 21h8v-8H3v8zM3 3v8h8V3H3zm13.66 2L13 8.66 15.34 11l3.66-3.66L21.34 11 23.66 8.66 20.34 5.34 23.66 2 21.34-0.34 17.66 3.32 14-0.34 11.66 2 13.66 4z"/></svg>
            <span class="name">Show All</span>
        </div>
        ${projects.map(p => `
            <div class="project-item ${filterProject === p ? 'active' : ''}" data-project="${p}">
                <svg class="folder-icon" width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/></svg>
                <span class="name">${p}</span>
            </div>
        `).join('')}`;

    // Add listeners via delegation (removing inline onclick)
    projectList.querySelectorAll('.project-item').forEach(el => {
        el.onclick = () => renderHome(el.dataset.project === 'all' ? null : el.dataset.project);
    });

    // 2. Filtered History
    const filtered = filterProject 
        ? historyData.filter(h => h.project === filterProject)
        : historyData;

    const recent = filtered.slice(0, 50);
    if (recent.length === 0) {
        recentChatList.innerHTML = '<div class="empty-state">No exports found for this project.</div>';
    } else {
        recentChatList.innerHTML = recent.map(c => `
            <div class="chat-row" data-id="${c.id}">
                <div class="chat-info">
                    <div class="chat-title">${c.title}</div>
                    <div class="chat-meta">
                        <span class="tag" style="padding:2px 8px">${c.project}</span>
                        <span>${new Date(c.createdAt * 1000).toLocaleDateString()}</span>
                        <span>${c.wordCount || '?'} words</span>
                    </div>
                </div>
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#8b949e" stroke-width="2"><path d="M9 18l6-6-6-6"/></svg>
            </div>
        `).join('');

        recentChatList.querySelectorAll('.chat-row').forEach(el => {
            el.onclick = () => window.open('https://chatgpt.com/c/' + el.dataset.id);
        });
    }

    // 3. Analytics (Filtered Activity Chart & Keywords)
    const statsPanel = document.querySelector('.charts-placeholder');
    if (statsPanel) {
        // SVG Activity Bars
        const dates = filtered.slice(0, 30).map(h => new Date(h.createdAt * 1000).toLocaleDateString());
        // ... (rest of logic remains same but using 'filtered' data)
        const dayMap = {};
        dates.forEach(d => dayMap[d] = (dayMap[d] || 0) + 1);
        const dayList = Object.entries(dayMap).sort((a,b) => new Date(a[0]) - new Date(b[0])).slice(-7);
        const max = Math.max(...dayList.map(d => d[1]), 1);

        const bars = dayList.map(([date, count], i) => {
            const h = (count / max) * 100;
            return `
                <div style="flex:1; display:flex; flex-direction:column; align-items:center; gap:8px">
                    <div style="width:20px; height:${h}px; background:#10a37f; border-radius:4px; box-shadow:0 0 8px rgba(16,163,127,0.3)"></div>
                    <div style="font-size:10px; color:#8b949e; transform:rotate(-45deg); height:30px; margin-top:5px">${date.split('/')[1] + '/' + date.split('/')[0]}</div>
                </div>
            `;
        }).join('');

        const kwMap = {};
        filtered.forEach(h => { (h.keywords || []).forEach(k => kwMap[k] = (kwMap[k] || 0) + 1); });
        const sortedKws = Object.entries(kwMap).sort((a,b) => b[1] - a[1]).slice(0, 10);

        // Weekly Heatmap logic
        const weekDays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
        const weekMap = {0:0,1:0,2:0,3:0,4:0,5:0,6:0};
        filtered.forEach(h => {
            const d = new Date(h.createdAt * 1000).getDay();
            weekMap[d]++;
        });
        const weekMax = Math.max(...Object.values(weekMap), 1);
        const heatmap = weekDays.map((name, i) => {
            const opacity = 0.1 + (weekMap[i] / weekMax) * 0.9;
            return `<div style="flex:1; background:rgba(16,163,127,${opacity}); height:40px; border-radius:4px; display:flex; align-items:center; justify-content:center; font-size:10px; font-weight:bold; color:${opacity > 0.5 ? 'white' : '#8b949e'}">${name}</div>`;
        }).join('');

        statsPanel.innerHTML = `
            <div style="display:flex; height:150px; align-items:flex-end; gap:16px; margin-bottom:50px; border-bottom:1px solid #30363d; padding-bottom:10px">
                ${bars}
            </div>
            <p style="margin-bottom:15px">Weekly Distribution:</p>
            <div style="display:flex; gap:4px; margin-bottom:40px">
                ${heatmap}
            </div>
            <p style="margin-bottom:15px">Most Frequent Keywords:</p>
            <div style="display:flex; flex-wrap:wrap; gap:8px">
                ${sortedKws.map(([k, count]) => `<span class="tag" style="border-color:#10a37f; color:#10a37f; padding:4px 12px">${k} (${count})</span>`).join('')}
            </div>
        `;
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
                    <button class="btn-copy" data-snippet="${p.promptSnippet.replace(/"/g, '&quot;')}">Copy</button>
                </div>
            </div>
        `).join('');

        promptHub.querySelectorAll('.btn-copy').forEach(btn => {
            btn.onclick = () => {
                navigator.clipboard.writeText(btn.dataset.snippet);
                btn.textContent = 'Copied!';
                setTimeout(() => btn.textContent = 'Copy', 1500);
            };
        });
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
        searchResults.innerHTML = hits.map(c => {
            const regex = new RegExp(`(${query})`, 'gi');
            const highlightedTitle = c.title.replace(regex, '<b style="color:#10a37f">$1</b>');
            const highlightedSnippet = c.promptSnippet.slice(0, 150).replace(regex, '<b style="color:#10a37f">$1</b>');

            return `
            <div class="chat-row" data-id="${c.id}">
                <div class="chat-info">
                    <div class="chat-title">${highlightedTitle}</div>
                    <div class="chat-meta">
                        <span class="tag">${c.project}</span>
                        <span style="color:#eee">${highlightedSnippet}...</span>
                    </div>
                </div>
            </div>`;
        }).join('');

        searchResults.querySelectorAll('.chat-row').forEach(el => {
            el.onclick = () => window.open('https://chatgpt.com/c/' + el.dataset.id);
        });
    }
}

document.addEventListener('DOMContentLoaded', init);
