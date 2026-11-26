// AniLite Storage v2.0 Renderer
let allItems = []; // Unified catalog: apps + launchers + games
let gamesCatalog = [];
let drivesData = [];
let cleanupItems = [];
let appTypeFilter = 'all';
let gameLauncherFilter = 'all';
let selectedItem = null;
let selectedUpdateInstaller = null;
let selectedAiModel = 'gemini-2.5-flash';
let currentSettings = null;
let lastActivityPing = 0;
let activeScanId = null;

const sizeByPath = new Map(); // normalized path -> bytes
const iconByPath = new Map(); // normalized path -> dataUrl | null

function normPath(p) {
    return (p || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

function escapeHtml(str) {
    return String(str || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function formatBytes(bytes) {
    if (bytes === null || bytes === undefined) return 'Scanning...';
    if (bytes <= 0) return '0 MB';
    const gb = bytes / (1024 ** 3);
    if (gb >= 1000) return (gb / 1024).toFixed(2) + ' TB';
    if (gb >= 1) return gb.toFixed(2) + ' GB';
    const mb = bytes / (1024 ** 2);
    if (mb >= 1) return mb.toFixed(1) + ' MB';
    return Math.max(1, Math.round(bytes / 1024)) + ' KB';
}

let toastTimer = null;
function showToast(message) {
    const el = document.getElementById('toast');
    if (!el) return;
    el.innerText = message;
    el.classList.remove('hidden');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.add('hidden'), 3000);
}

// TAB SWITCHING
function switchTab(tabName) {
    const tabs = ['home', 'games', 'apps', 'cleanup', 'ai', 'settings'];
    tabs.forEach(tab => {
        const btn = document.getElementById('btn-' + tab);
        const view = document.getElementById('tab-' + tab);
        if (btn) btn.classList.toggle('active', tab === tabName);
        if (view) view.classList.toggle('active', tab === tabName);
    });
    reportUserActivity();
}

// ACTIVITY PING FOR DISCORD RPC
function reportUserActivity() {
    if (!window.api?.reportActivity) return;
    const now = Date.now();
    if (now - lastActivityPing < 5000) return;
    lastActivityPing = now;
    window.api.reportActivity();
}

function bindActivityListeners() {
    ['mousemove', 'keydown', 'click', 'scroll', 'wheel'].forEach(ev => {
        document.addEventListener(ev, reportUserActivity, { passive: true });
    });
    reportUserActivity();
}

// VISUAL SETTINGS
function applyVisualSettings(settings) {
    if (!settings?.images) return;
    currentSettings = settings;
    const root = document.documentElement;
    root.style.setProperty('--bg-image', `url("${settings.images.backgroundUrl}")`);
    root.style.setProperty('--accent-image', `url("${settings.images.accentUrl}")`);
    root.style.setProperty('--overlay-image', `url("${settings.images.overlayUrl}")`);

    const logoImage = document.getElementById('app-logo-image');
    if (logoImage) logoImage.src = settings.images.logoUrl;

    const setPreview = (id, url) => {
        const el = document.getElementById(id);
        if (el) el.style.backgroundImage = `url("${url}")`;
    };
    setPreview('preview-background', settings.images.backgroundUrl);
    setPreview('preview-accent', settings.images.accentUrl);
    setPreview('preview-overlay', settings.images.overlayUrl);
    setPreview('preview-logo', settings.images.logoUrl);
}

function fillSettingsForm(settings) {
    if (!settings) return;
    const images = settings.images || {};
    const rpc = settings.rpc || {};
    const assign = (id, val) => {
        const node = document.getElementById(id);
        if (node) node.value = val || '';
    };
    assign('settings-background-path', images.backgroundPath);
    assign('settings-accent-path', images.accentPath);
    assign('settings-overlay-path', images.overlayPath);
    assign('settings-logo-path', images.logoPath);

    const rpcToggle = document.getElementById('rpc-enabled');
    if (rpcToggle) rpcToggle.checked = rpc.enabled !== false;
    assign('rpc-client-id', rpc.clientId);
    assign('rpc-details', rpc.details);
    assign('rpc-state', rpc.state);
    assign('rpc-large-image-key', rpc.largeImageKey);
    assign('rpc-large-image-text', rpc.largeImageText);
    assign('rpc-small-image-key', rpc.smallImageKey);
    assign('rpc-small-image-text', rpc.smallImageText);
}

function collectSettingsForm() {
    const val = (id) => document.getElementById(id)?.value.trim() || '';
    return {
        images: {
            backgroundPath: val('settings-background-path'),
            accentPath: val('settings-accent-path'),
            overlayPath: val('settings-overlay-path'),
            logoPath: val('settings-logo-path')
        },
        rpc: {
            enabled: document.getElementById('rpc-enabled')?.checked !== false,
            clientId: val('rpc-client-id'),
            details: val('rpc-details'),
            state: val('rpc-state'),
            largeImageKey: val('rpc-large-image-key'),
            largeImageText: val('rpc-large-image-text'),
            smallImageKey: val('rpc-small-image-key'),
            smallImageText: val('rpc-small-image-text')
        }
    };
}

async function loadSettings() {
    if (!window.api?.getSettings) return;
    const settings = await window.api.getSettings();
    applyVisualSettings(settings);
    fillSettingsForm(settings);
}

async function chooseSettingsImage(_key, inputId) {
    const result = await window.api.selectSettingsImage();
    if (!result || result.canceled || !result.success) return;
    const input = document.getElementById(inputId);
    if (input) input.value = result.path;
    document.getElementById('settings-status').innerText = `Selected ${result.fileName}. Click "Save Settings" to apply.`;
}

async function saveSettings() {
    const status = document.getElementById('settings-status');
    status.innerText = 'Saving settings...';
    const result = await window.api.saveSettings(collectSettingsForm());
    if (result?.success) {
        applyVisualSettings(result.settings);
        fillSettingsForm(result.settings);
        status.innerText = 'Settings saved.';
        showToast('Settings saved');
    } else {
        status.innerText = result?.message || 'Failed to save settings.';
    }
}

async function resetVisualSettings() {
    const result = await window.api.resetVisualSettings();
    if (result?.success) {
        applyVisualSettings(result.settings);
        fillSettingsForm(result.settings);
        showToast('Restored default Sunburst artwork');
    }
}

// UPDATE MODAL
function toggleUpdate() {
    document.getElementById('update-screen').classList.toggle('hidden');
}

async function loadAppVersion() {
    const info = await window.api?.getAppVersion?.();
    if (info?.version) {
        document.getElementById('update-version-title').innerText = `AniLite v${info.version}`;
        document.getElementById('sidebar-version').innerText = `v${info.version}`;
    }
}

async function chooseUpdateInstaller() {
    const result = await window.api.selectUpdateInstaller();
    if (!result || result.canceled || !result.success) return;
    selectedUpdateInstaller = result.path;
    document.getElementById('update-file-name').innerText = result.fileName || result.path;
    document.getElementById('update-status-text').innerText = 'Installer ready. Click "Install Update" to launch.';
    document.getElementById('apply-update-btn').disabled = false;
}

async function installSelectedUpdate() {
    if (!selectedUpdateInstaller) return;
    if (!window.confirm('Launch the selected update installer? AniLite will close during the update.')) return;
    const result = await window.api.installUpdateInstaller(selectedUpdateInstaller);
    if (!result?.success) {
        document.getElementById('update-status-text').innerText = result?.message || 'Failed to launch installer.';
    }
}

// ICONS (LAZY CACHED)
async function hydrateIcon(targetPath, nameHint, element) {
    if (!element || !targetPath) return;
    const key = normPath(targetPath);
    if (iconByPath.has(key)) {
        const cached = iconByPath.get(key);
        if (cached) {
            element.style.backgroundImage = `url('${cached}')`;
            element.innerText = '';
        }
        return;
    }
    const dataUrl = await window.api.getAppIcon(targetPath, nameHint);
    iconByPath.set(key, dataUrl || null);
    if (dataUrl && element.isConnected) {
        element.style.backgroundImage = `url('${dataUrl}')`;
        element.innerText = '';
    }
}

// RENDER DRIVES
function renderDrives() {
    const grid = document.getElementById('drives-grid');
    if (!drivesData.length) {
        grid.innerHTML = '<div class="surface-card muted-text">No local drives detected.</div>';
        return;
    }

    grid.innerHTML = drivesData.map(d => {
        const levelClass = d.usedPercent >= 90 ? 'danger' : (d.usedPercent >= 75 ? 'warn' : '');
        return `
            <div class="drive-card">
                <div class="drive-top">
                    <div class="drive-identity">
                        <div class="drive-badge">${escapeHtml(d.letter)}:</div>
                        <div>
                            <div class="drive-title">Local Disk (${escapeHtml(d.letter)}:)</div>
                            <div class="drive-sub">${formatBytes(d.free)} free of ${formatBytes(d.size)}</div>
                        </div>
                    </div>
                    <div class="drive-percent">${d.usedPercent}%</div>
                </div>
                <div class="progress-track">
                    <div class="progress-fill ${levelClass}" style="width: ${d.usedPercent}%"></div>
                </div>
                <div class="drive-stats-row">
                    <span>Used: <strong>${formatBytes(d.used)}</strong></span>
                    <button class="btn-ghost" onclick="openFolder('${escapeHtml(d.diskPath.replace(/\\/g, '\\\\'))}')">Open Drive →</button>
                </div>
            </div>
        `;
    }).join('');
}

// RENDER OVERVIEW KPIs + TOP CONSUMERS + QUICK GAMES
function updateOverviewStats() {
    const appsAndLaunchers = allItems.filter(i => i.type !== 'Game');
    document.getElementById('kpi-apps-count').innerText = appsAndLaunchers.length;
    document.getElementById('kpi-games-count').innerText = gamesCatalog.length;
    document.getElementById('nav-apps-count').innerText = allItems.length;
    document.getElementById('nav-games-count').innerText = gamesCatalog.length;

    let trackedBytes = 0;
    const counted = new Set();
    for (const item of allItems) {
        const key = normPath(item.path);
        if (!key || counted.has(key)) continue;
        counted.add(key);
        const sz = sizeByPath.get(key);
        if (typeof sz === 'number' && sz > 0) trackedBytes += sz;
    }
    document.getElementById('kpi-tracked-size').innerText = formatBytes(trackedBytes);

    renderTopConsumers('top-consumers-list', 6);
    renderTopConsumers('cleanup-top-list', 15);
}

function renderTopConsumers(containerId, limit) {
    const container = document.getElementById(containerId);
    if (!container) return;

    const ranked = allItems
        .map(item => ({ item, size: sizeByPath.get(normPath(item.path)) || 0 }))
        .filter(x => x.size > 0)
        .sort((a, b) => b.size - a.size)
        .slice(0, limit);

    if (!ranked.length) {
        container.innerHTML = '<p class="muted-text">Scanning sizes in parallel...</p>';
        return;
    }

    const maxSize = ranked[0].size || 1;
    container.innerHTML = '';

    ranked.forEach(({ item, size }) => {
        const pct = Math.max(4, Math.round((size / maxSize) * 100));
        const row = document.createElement('div');
        row.className = 'consumer-row';
        row.onclick = () => openItemModal(item);
        row.innerHTML = `
            <div class="app-icon">${escapeHtml((item.name || '?')[0].toUpperCase())}</div>
            <div class="consumer-info">
                <div class="consumer-top">
                    <span class="consumer-name">${escapeHtml(item.name)}</span>
                    <span class="consumer-size mono">${formatBytes(size)}</span>
                </div>
                <div class="consumer-bar-track">
                    <div class="consumer-bar-fill" style="width: ${pct}%"></div>
                </div>
            </div>
        `;
        hydrateIcon(item.path, item.name, row.querySelector('.app-icon'));
        container.appendChild(row);
    });
}

function renderOverviewGames() {
    const grid = document.getElementById('overview-games-grid');
    if (!gamesCatalog.length) {
        grid.innerHTML = '<p class="muted-text">No games detected yet.</p>';
        return;
    }

    const topGames = [...gamesCatalog]
        .sort((a, b) => (sizeByPath.get(normPath(b.path)) || 0) - (sizeByPath.get(normPath(a.path)) || 0))
        .slice(0, 4);

    grid.innerHTML = '';
    topGames.forEach(game => grid.appendChild(createGameCard(game)));
}

// GAMES TAB
function renderLauncherPills() {
    const container = document.getElementById('games-launcher-pills');
    const launchers = ['all', ...Array.from(new Set(gamesCatalog.map(g => g.launcher))).sort()];
    container.innerHTML = launchers.map(l => `
        <button class="pill ${gameLauncherFilter === l ? 'active' : ''}" onclick="setGameLauncherFilter('${escapeHtml(l)}')">
            ${l === 'all' ? 'All' : escapeHtml(l)}
        </button>
    `).join('');
}

function setGameLauncherFilter(launcher) {
    gameLauncherFilter = launcher;
    renderLauncherPills();
    renderGamesGrid();
}

function createGameCard(game) {
    const size = sizeByPath.get(normPath(game.path));
    const card = document.createElement('div');
    card.className = 'game-card';
    card.onclick = () => openItemModal(game);

    card.innerHTML = `
        <div class="game-banner">
            <div class="game-icon-box">${escapeHtml((game.name || '?')[0].toUpperCase())}</div>
            <span class="game-size-tag">${size !== undefined ? formatBytes(size) : '...'}</span>
        </div>
        <div class="game-body">
            <div class="game-title" title="${escapeHtml(game.name)}">${escapeHtml(game.name)}</div>
            <div class="game-footer">
                <span class="launcher-tag">${escapeHtml(game.launcher)}</span>
                <button class="quick-launch-btn">Play</button>
            </div>
        </div>
    `;

    card.querySelector('.quick-launch-btn').onclick = async (e) => {
        e.stopPropagation();
        showToast(`Launching ${game.name}...`);
        const res = await window.api.launchGame(game.path, game.name);
        if (!res?.success) showToast(res?.message || 'Could not launch game');
    };

    hydrateIcon(game.path, game.name, card.querySelector('.game-icon-box'));
    return card;
}

function renderGamesGrid() {
    const grid = document.getElementById('games-grid');
    const query = (document.getElementById('games-search')?.value || '').trim().toLowerCase();
    const sortMode = document.getElementById('games-sort')?.value || 'size-desc';

    const filtered = gamesCatalog.filter(g => {
        if (gameLauncherFilter !== 'all' && g.launcher !== gameLauncherFilter) return false;
        if (query && !g.name.toLowerCase().includes(query) && !g.launcher.toLowerCase().includes(query)) return false;
        return true;
    });

    filtered.sort((a, b) => {
        const sa = sizeByPath.get(normPath(a.path)) || 0;
        const sb = sizeByPath.get(normPath(b.path)) || 0;
        if (sortMode === 'name-asc') return a.name.localeCompare(b.name);
        if (sortMode === 'name-desc') return b.name.localeCompare(a.name);
        if (sortMode === 'size-asc') return sa - sb;
        return sb - sa;
    });

    grid.innerHTML = '';
    if (!filtered.length) {
        grid.innerHTML = '<p class="muted-text">No matching games found.</p>';
        return;
    }

    filtered.forEach(game => grid.appendChild(createGameCard(game)));
}

// APPS TAB
function setAppTypeFilter(type, btn) {
    appTypeFilter = type;
    document.querySelectorAll('#apps-type-pills .pill').forEach(p => p.classList.remove('active'));
    if (btn) btn.classList.add('active');
    renderAppsList();
}

function renderAppsList() {
    const list = document.getElementById('apps-list');
    const query = (document.getElementById('apps-search')?.value || '').trim().toLowerCase();
    const sortMode = document.getElementById('apps-sort')?.value || 'size-desc';

    const filtered = allItems.filter(item => {
        if (appTypeFilter !== 'all' && item.type !== appTypeFilter) return false;
        if (query) {
            const hay = `${item.name} ${item.path} ${item.source}`.toLowerCase();
            if (!hay.includes(query)) return false;
        }
        return true;
    });

    filtered.sort((a, b) => {
        const sa = sizeByPath.get(normPath(a.path)) || 0;
        const sb = sizeByPath.get(normPath(b.path)) || 0;
        if (sortMode === 'name-asc') return a.name.localeCompare(b.name);
        if (sortMode === 'name-desc') return b.name.localeCompare(a.name);
        if (sortMode === 'size-asc') return sa - sb;
        return sb - sa;
    });

    list.innerHTML = '';
    if (!filtered.length) {
        list.innerHTML = '<p class="muted-text">No matching apps found.</p>';
        return;
    }

    const maxSize = Math.max(1, ...filtered.map(i => sizeByPath.get(normPath(i.path)) || 0));
    const fragment = document.createDocumentFragment();

    filtered.forEach(item => {
        const size = sizeByPath.get(normPath(item.path));
        const pct = size ? Math.max(3, Math.round((size / maxSize) * 100)) : 0;

        const row = document.createElement('div');
        row.className = 'app-row';
        row.onclick = () => openItemModal(item);
        row.innerHTML = `
            <div class="app-icon">${escapeHtml((item.name || '?')[0].toUpperCase())}</div>
            <div class="app-main-info">
                <div class="app-name-line">
                    <span class="app-name">${escapeHtml(item.name)}</span>
                    <span class="badge badge-type">${escapeHtml(item.type)}</span>
                    <span class="badge badge-source">${escapeHtml(item.source || '')}</span>
                </div>
                <div class="app-path">${escapeHtml(item.path || '')}</div>
            </div>
            <div class="size-bar-cell">
                <div class="consumer-bar-track">
                    <div class="consumer-bar-fill" style="width: ${pct}%"></div>
                </div>
            </div>
            <div class="size-value-cell">${size !== undefined ? formatBytes(size) : '...'}</div>
            <button class="row-action-btn" title="Open in Explorer">Folder</button>
        `;

        row.querySelector('.row-action-btn').onclick = (e) => {
            e.stopPropagation();
            openFolder(item.path);
        };

        hydrateIcon(item.path, item.name, row.querySelector('.app-icon'));
        fragment.appendChild(row);
    });

    list.appendChild(fragment);
}

// CLEANUP TAB
async function loadCleanupInfo() {
    cleanupItems = await window.api.getCleanupInfo();
    const tempEntry = cleanupItems.find(c => c.id === 'user-temp');
    document.getElementById('kpi-temp-size').innerText = tempEntry ? formatBytes(tempEntry.size) : '0 MB';

    const grid = document.getElementById('cleanup-cards');
    grid.innerHTML = cleanupItems.map(item => `
        <div class="cleanup-card">
            <div>
                <h3 style="font-size: 15px; margin-bottom: 4px;">${escapeHtml(item.name)}</h3>
                <p class="section-sub">${escapeHtml(item.description)}</p>
            </div>
            <div class="cleanup-size">${formatBytes(item.size)}</div>
            <div class="cleanup-actions">
                <button class="btn-secondary" onclick="openFolder('${escapeHtml(item.path.replace(/\\/g, '\\\\'))}')">Open Folder</button>
                ${item.canClean ? `<button class="btn-primary" id="clean-temp-btn" onclick="cleanTempNow()">Clean Temp</button>` : ''}
            </div>
        </div>
    `).join('');
}

async function cleanTempNow() {
    const btn = document.getElementById('clean-temp-btn');
    if (btn) {
        btn.disabled = true;
        btn.innerText = 'Cleaning...';
    }
    const res = await window.api.cleanTempFolder();
    if (res?.success) {
        showToast(`Freed ${formatBytes(res.freedBytes)} (${res.deletedCount} items removed)`);
    } else {
        showToast(res?.message || 'Cleanup finished with warnings');
    }
    await loadCleanupInfo();
    drivesData = await window.api.getDrivesData();
    renderDrives();
}

async function openFolder(targetPath) {
    if (!targetPath) return;
    await window.api.openPathInExplorer(targetPath);
}

// UNIFIED ITEM DETAIL MODAL
async function openItemModal(item) {
    selectedItem = item;
    const modal = document.getElementById('app-modal');
    const launchBtn = document.getElementById('app-launch-btn');
    const uninstallBtn = document.getElementById('app-uninstall-btn');
    const iconEl = document.getElementById('modal-app-icon');
    const verBadge = document.getElementById('modal-app-version');
    const pubWrap = document.getElementById('modal-app-publisher-wrap');

    document.getElementById('modal-app-name').innerText = item.name;
    document.getElementById('modal-app-type').innerText = item.type;
    document.getElementById('modal-app-source').innerText = item.source || item.launcher || 'System';
    document.getElementById('modal-app-path').innerText = item.path || 'Unknown path';

    const knownSize = sizeByPath.get(normPath(item.path));
    document.getElementById('modal-app-size').innerText = knownSize !== undefined ? formatBytes(knownSize) : 'Calculating...';
    document.getElementById('modal-app-status').innerText = 'Checking uninstall info...';

    iconEl.style.backgroundImage = '';
    iconEl.innerText = (item.name || '?')[0].toUpperCase();
    hydrateIcon(item.path, item.name, iconEl);

    launchBtn.classList.toggle('hidden', item.type !== 'Game');
    uninstallBtn.disabled = true;
    verBadge.classList.add('hidden');
    pubWrap.classList.add('hidden');

    modal.classList.remove('hidden');
    reportUserActivity();

    if (knownSize === undefined && item.path) {
        window.api.getAppSize(item.path).then(sz => {
            sizeByPath.set(normPath(item.path), sz);
            if (selectedItem === item) {
                document.getElementById('modal-app-size').innerText = formatBytes(sz);
            }
        });
    }

    const info = await window.api.getUninstallInfo(item.name, item.path);
    if (selectedItem !== item) return;

    if (info?.version) {
        verBadge.innerText = `v${info.version}`;
        verBadge.classList.remove('hidden');
    }
    if (info?.publisher) {
        document.getElementById('modal-app-publisher').innerText = info.publisher;
        pubWrap.classList.remove('hidden');
    }

    if (info?.available) {
        document.getElementById('modal-app-status').innerText = 'Uninstall available via Windows registry.';
        uninstallBtn.disabled = false;
    } else {
        document.getElementById('modal-app-status').innerText = item.type === 'Game'
            ? 'Ready to launch or open install directory.'
            : 'No registered Windows uninstaller found.';
    }
}

function closeAppModal() {
    document.getElementById('app-modal').classList.add('hidden');
    selectedItem = null;
}

function openSelectedItemFolder() {
    if (selectedItem?.path) openFolder(selectedItem.path);
}

async function launchSelectedAppGame() {
    if (!selectedItem || selectedItem.type !== 'Game') return;
    const status = document.getElementById('modal-app-status');
    status.innerText = 'Launching game...';
    const res = await window.api.launchGame(selectedItem.path, selectedItem.name);
    status.innerText = res?.success ? 'Game launched!' : (res?.message || 'Failed to launch game.');
}

async function uninstallSelectedApp() {
    if (!selectedItem) return;
    if (!window.confirm(`Uninstall ${selectedItem.name}?`)) return;
    const status = document.getElementById('modal-app-status');
    status.innerText = 'Starting uninstaller...';
    const res = await window.api.uninstallApp(selectedItem.name, selectedItem.path);
    status.innerText = res?.success ? 'Uninstaller launched.' : (res?.message || 'Failed to start uninstaller.');
}

// AI CHAT
async function loadAiState() {
    const status = await window.api.getAiKeyStatus();
    document.getElementById('ai-key-status').innerText = status?.hasKey ? 'API Key Active' : 'Key not set';
    const storedModel = localStorage.getItem('anilite-ai-model');
    if (storedModel) selectedAiModel = storedModel;
    const sel = document.getElementById('ai-model-select');
    if (sel) sel.value = selectedAiModel;
}

function saveAiModel() {
    selectedAiModel = document.getElementById('ai-model-select').value;
    localStorage.setItem('anilite-ai-model', selectedAiModel);
    showToast(`AI model set to ${selectedAiModel}`);
}

async function saveAiKey() {
    const input = document.getElementById('ai-key-input');
    const key = input.value.trim();
    if (!key) return;
    const res = await window.api.saveAiKey(key);
    if (res?.success) {
        input.value = '';
        document.getElementById('ai-key-status').innerText = 'API Key Active';
        showToast('Gemini API key saved');
    }
}

function useAiPrompt(text) {
    document.getElementById('ai-input').value = text;
    sendAiMessage();
}

function appendAiMessage(role, text) {
    const chat = document.getElementById('ai-chat');
    const empty = chat.querySelector('.ai-empty-state');
    if (empty) empty.remove();

    const div = document.createElement('div');
    div.className = `ai-msg ${role === 'You' ? 'user' : 'assistant'}`;
    div.innerHTML = `<span class="ai-msg-role">${escapeHtml(role)}</span><div>${escapeHtml(text)}</div>`;
    chat.appendChild(div);
    chat.scrollTop = chat.scrollHeight;
}

async function sendAiMessage() {
    const input = document.getElementById('ai-input');
    const btn = document.getElementById('ai-send-btn');
    const text = input.value.trim();
    if (!text) return;

    input.value = '';
    appendAiMessage('You', text);
    btn.disabled = true;
    btn.innerText = 'Thinking...';

    const res = await window.api.aiChat(text, selectedAiModel);
    appendAiMessage('AniLite AI', res?.reply || 'No response. Check API key.');
    btn.disabled = false;
    btn.innerText = 'Send';
}

// HIGH-SPEED STREAMING SCAN ORCHESTRATOR
let uiRefreshTimer = null;
function scheduleUiRefresh() {
    if (uiRefreshTimer) return;
    uiRefreshTimer = setTimeout(() => {
        uiRefreshTimer = null;
        updateOverviewStats();
        renderOverviewGames();
        renderGamesGrid();
        renderAppsList();
    }, 220);
}

function setScanProgress(completed, total, done = false) {
    const pct = total > 0 ? Math.round((completed / total) * 100) : 100;
    const dot = document.getElementById('scan-dot');
    const label = document.getElementById('sidebar-scan-label');
    const bar = document.getElementById('sidebar-scan-bar');
    const pill = document.getElementById('apps-loading-status');

    if (bar) bar.style.width = `${pct}%`;
    if (done) {
        if (dot) dot.classList.remove('scanning');
        if (label) label.innerText = `Synced (${total} items)`;
        if (pill) pill.innerText = `${total} items tracked`;
    } else {
        if (dot) dot.classList.add('scanning');
        if (label) label.innerText = `Scanning ${pct}%`;
        if (pill) pill.innerText = `Scanning ${completed}/${total} (${pct}%)`;
    }
}

async function triggerFullRescan(forceRefresh = true) {
    if (forceRefresh) showToast('Rescanning drives & installed apps...');
    await loadAllData(forceRefresh);
}

async function loadAllData(forceRefresh = false) {
    const [drives, games, apps, launchers] = await Promise.all([
        window.api.getDrivesData(),
        window.api.getGamesList(),
        window.api.getAppsList(),
        window.api.getLaunchersList()
    ]);

    drivesData = drives || [];
    renderDrives();

    const launcherPaths = new Set(launchers.map(l => normPath(l.path)));
    const launcherNames = new Set(launchers.map(l => (l.name || '').toLowerCase()));

    gamesCatalog = (games || []).map(g => ({
        ...g,
        type: 'Game',
        source: g.launcher
    }));

    const filteredApps = (apps || [])
        .filter(a => !launcherPaths.has(normPath(a.path)) && !launcherNames.has((a.name || '').toLowerCase()))
        .map(a => ({ ...a, type: 'App' }));

    const launcherItems = (launchers || []).map(l => ({ ...l, type: 'Launcher', source: 'Launcher' }));

    allItems = [...gamesCatalog, ...launcherItems, ...filteredApps];

    // Hydrate any cached sizes immediately (0ms display!)
    allItems.forEach(item => {
        if (typeof item.cachedSize === 'number') {
            sizeByPath.set(normPath(item.path), item.cachedSize);
        }
    });

    renderLauncherPills();
    updateOverviewStats();
    renderOverviewGames();
    renderGamesGrid();
    renderAppsList();

    // Start fast parallel native size scan
    const pathsToScan = allItems.map(i => i.path).filter(Boolean);
    setScanProgress(0, pathsToScan.length, false);
    const scanInfo = await window.api.startSizeScan(pathsToScan, forceRefresh);
    activeScanId = scanInfo.scanId;

    // Load cleanup folder sizes in parallel
    loadCleanupInfo();
}

// BOOTSTRAP
async function init() {
    bindActivityListeners();
    await loadSettings();
    loadAppVersion();
    loadAiState();

    window.api.onSettingsUpdated((settings) => {
        applyVisualSettings(settings);
        fillSettingsForm(settings);
    });

    window.api.onScanItemSize((payload) => {
        if (payload.scanId !== activeScanId) return;
        sizeByPath.set(normPath(payload.path), payload.size);
        setScanProgress(payload.completed, payload.total, false);
        if (selectedItem && normPath(selectedItem.path) === normPath(payload.path)) {
            document.getElementById('modal-app-size').innerText = formatBytes(payload.size);
        }
        scheduleUiRefresh();
    });

    window.api.onScanComplete((payload) => {
        if (payload.scanId !== activeScanId) return;
        setScanProgress(payload.total, payload.total, true);
        updateOverviewStats();
        renderOverviewGames();
        renderGamesGrid();
        renderAppsList();
    });

    const aiInput = document.getElementById('ai-input');
    if (aiInput) {
        aiInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') sendAiMessage();
        });
    }

    await loadAllData(false);
}

init();
