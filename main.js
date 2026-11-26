const { app, BrowserWindow, ipcMain, dialog, nativeImage, shell } = require('electron');
const path = require('path');
const os = require('os');
const { pathToFileURL } = require('url');
const fs = require('fs').promises;
const checkDiskSpace = require('check-disk-space').default;
const { exec, spawn } = require('child_process');
const RPC = require('discord-rpc');

let rpcClient = null;
let mainWindow = null;
let settingsPath = null;
let sizeCachePath = null;
let currentSettings = null;
let aiKeyPath = null;

let rpcReady = false;
let rpcActive = false;
let lastActivity = Date.now();
let sessionStart = Date.now();

// In-memory high-speed caches
const sizeCache = new Map(); // normalized path -> { size, updatedAt }
const iconCache = new Map(); // normalized path -> dataUrl | null
let uninstallEntriesCache = null;
let uninstallEntriesPromise = null;
let activeScanId = 0;

const SIZE_CACHE_TTL_MS = 1000 * 60 * 60 * 6; // 6 hours fresh cache
const DEFAULT_GEMINI_MODEL = 'gemini-2.5-flash';
const DEFAULT_RPC_CLIENT_ID = '1488947382551838821';
const DEFAULT_SETTINGS = {
    images: {
        backgroundPath: '',
        accentPath: '',
        overlayPath: '',
        logoPath: ''
    },
    rpc: {
        enabled: true,
        clientId: DEFAULT_RPC_CLIENT_ID,
        details: 'Managing AniLite Storage',
        state: 'Tracking Drives & Apps',
        largeImageKey: 'img1',
        largeImageText: 'AniLite v2',
        smallImageKey: 'img2',
        smallImageText: 'Storage Ops'
    }
};

function assetPath(fileName) {
    return path.join(__dirname, 'assets', fileName);
}

function normalizePathKey(p) {
    return (p || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

function normalizeText(value) {
    return (value || '').toLowerCase();
}

function deepMergeSettings(base, override) {
    return {
        images: {
            ...base.images,
            ...(override && override.images ? override.images : {})
        },
        rpc: {
            ...base.rpc,
            ...(override && override.rpc ? override.rpc : {})
        }
    };
}

async function readSettings() {
    if (!settingsPath) return deepMergeSettings(DEFAULT_SETTINGS, {});
    try {
        const raw = await fs.readFile(settingsPath, 'utf-8');
        const parsed = JSON.parse(raw);
        return deepMergeSettings(DEFAULT_SETTINGS, parsed);
    } catch {
        return deepMergeSettings(DEFAULT_SETTINGS, {});
    }
}

async function writeSettings(value) {
    if (!settingsPath) return false;
    try {
        currentSettings = deepMergeSettings(DEFAULT_SETTINGS, value);
        await fs.writeFile(settingsPath, JSON.stringify(currentSettings, null, 2), 'utf-8');
        return true;
    } catch {
        return false;
    }
}

async function loadSizeCacheFromDisk() {
    if (!sizeCachePath) return;
    try {
        const raw = await fs.readFile(sizeCachePath, 'utf-8');
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
            for (const [k, v] of Object.entries(parsed)) {
                if (v && typeof v.size === 'number') {
                    sizeCache.set(k, v);
                }
            }
        }
    } catch {
        // Cache file does not exist yet
    }
}

let saveCacheTimer = null;
function scheduleSaveSizeCache() {
    if (!sizeCachePath) return;
    if (saveCacheTimer) clearTimeout(saveCacheTimer);
    saveCacheTimer = setTimeout(async () => {
        try {
            const obj = {};
            for (const [k, v] of sizeCache.entries()) {
                obj[k] = v;
            }
            await fs.writeFile(sizeCachePath, JSON.stringify(obj), 'utf-8');
        } catch {
            // Ignore write failures
        }
    }, 1000);
}

function resolveSettingsAsset(filePath, fallbackFile) {
    const candidate = filePath && filePath.trim() ? filePath.trim() : assetPath(fallbackFile);
    return pathToFileURL(candidate).href;
}

function getRendererSettings() {
    const settings = currentSettings || deepMergeSettings(DEFAULT_SETTINGS, {});
    return {
        images: {
            backgroundPath: settings.images.backgroundPath || '',
            accentPath: settings.images.accentPath || '',
            overlayPath: settings.images.overlayPath || '',
            logoPath: settings.images.logoPath || '',
            backgroundUrl: resolveSettingsAsset(settings.images.backgroundPath, 'img1.jpg'),
            accentUrl: resolveSettingsAsset(settings.images.accentPath, 'img2.jpg'),
            overlayUrl: resolveSettingsAsset(settings.images.overlayPath, 'img3.jpg'),
            logoUrl: resolveSettingsAsset(settings.images.logoPath, 'app-icon.png')
        },
        rpc: {
            ...settings.rpc,
            enabled: settings.rpc.enabled !== false,
            clientId: settings.rpc.clientId && settings.rpc.clientId !== DEFAULT_RPC_CLIENT_ID
                ? settings.rpc.clientId
                : ''
        }
    };
}

function getWindowIconPath() {
    const customIcon = currentSettings && currentSettings.images && currentSettings.images.logoPath;
    return customIcon && customIcon.trim() ? customIcon.trim() : assetPath('app-icon.png');
}

function applyWindowIcon(win) {
    if (!win) return;
    try {
        const icon = nativeImage.createFromPath(getWindowIconPath());
        if (!icon.isEmpty()) win.setIcon(icon);
    } catch {
        // Ignore
    }
}

function createWindow() {
    const iconPath = getWindowIconPath();
    const win = new BrowserWindow({
        width: 1280,
        height: 820,
        minWidth: 960,
        minHeight: 640,
        backgroundColor: '#090d16',
        title: 'AniLite Storage',
        icon: iconPath,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false
        }
    });

    win.loadFile('index.html');
    try { applyWindowIcon(win); } catch {}
    win.setMenuBarVisibility(false);
    mainWindow = win;
    win.on('closed', () => {
        if (mainWindow === win) mainWindow = null;
    });
}

/**
 * ULTRA-FAST NATIVE PARALLEL FOLDER SIZE CALCULATOR
 * Replaces spawning powershell.exe per folder (~100x faster, zero subprocess overhead).
 */
async function calculateDirectorySizeNative(rootDir) {
    if (!rootDir) return 0;
    let totalBytes = 0;
    const queue = [rootDir];
    let queueIndex = 0;

    async function worker() {
        while (queueIndex < queue.length) {
            const currentDir = queue[queueIndex++];
            let entries;
            try {
                entries = await fs.readdir(currentDir, { withFileTypes: true });
            } catch {
                continue;
            }
            const fileStats = [];
            for (let i = 0; i < entries.length; i++) {
                const entry = entries[i];
                if (entry.isSymbolicLink()) continue;
                const fullPath = path.join(currentDir, entry.name);
                if (entry.isDirectory()) {
                    queue.push(fullPath);
                } else if (entry.isFile()) {
                    fileStats.push(fullPath);
                }
            }
            if (fileStats.length > 0) {
                const results = await Promise.all(
                    fileStats.map(fp => fs.lstat(fp).then(st => st.size).catch(() => 0))
                );
                for (let i = 0; i < results.length; i++) {
                    totalBytes += results[i];
                }
            }
        }
    }

    const concurrency = 6;
    const workers = [];
    for (let i = 0; i < concurrency; i++) {
        workers.push(worker());
    }
    await Promise.all(workers);
    return totalBytes;
}

async function getFolderSizeFast(dirPath, forceRefresh = false) {
    if (!dirPath) return 0;
    const key = normalizePathKey(dirPath);
    if (!forceRefresh && sizeCache.has(key)) {
        const cached = sizeCache.get(key);
        if (Date.now() - cached.updatedAt < SIZE_CACHE_TTL_MS) {
            return cached.size;
        }
    }
    const size = await calculateDirectorySizeNative(dirPath);
    sizeCache.set(key, { size, updatedAt: Date.now() });
    scheduleSaveSizeCache();
    return size;
}

/**
 * Multi-drive detection on Windows (fast, no slow WMI hang)
 */
async function getAllDrivesData() {
    const letters = 'CDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
    const checks = await Promise.all(
        letters.map(async (letter) => {
            const mount = `${letter}:/`;
            try {
                await fs.access(mount);
                const info = await checkDiskSpace(mount);
                if (!info || !info.size || info.size <= 0) return null;
                return {
                    letter,
                    diskPath: `${letter}:\\`,
                    size: info.size,
                    free: info.free,
                    used: Math.max(0, info.size - info.free),
                    usedPercent: Number((((info.size - info.free) / info.size) * 100).toFixed(1))
                };
            } catch {
                return null;
            }
        })
    );
    return checks.filter(Boolean);
}

/**
 * Cached Windows Registry Uninstall entries (fetched once per session)
 */
function fetchUninstallEntriesOnce() {
    if (uninstallEntriesCache) return Promise.resolve(uninstallEntriesCache);
    if (uninstallEntriesPromise) return uninstallEntriesPromise;

    uninstallEntriesPromise = new Promise((resolve) => {
        const psCommand = [
            "$paths = 'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',",
            "'HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',",
            "'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*';",
            "Get-ItemProperty $paths -ErrorAction SilentlyContinue |",
            "Where-Object { $_.DisplayName } |",
            "Select-Object DisplayName, DisplayVersion, Publisher, EstimatedSize, UninstallString, QuietUninstallString, InstallLocation |",
            "ConvertTo-Json -Compress"
        ].join(' ');

        exec(`powershell.exe -NoProfile -Command "${psCommand}"`, { maxBuffer: 10 * 1024 * 1024 }, (error, stdout) => {
            if (error || !stdout || !stdout.trim()) {
                uninstallEntriesCache = [];
                resolve([]);
                return;
            }
            try {
                const parsed = JSON.parse(stdout);
                uninstallEntriesCache = Array.isArray(parsed) ? parsed : [parsed];
                resolve(uninstallEntriesCache);
            } catch {
                uninstallEntriesCache = [];
                resolve([]);
            }
        });
    });

    return uninstallEntriesPromise;
}

function findBestUninstallEntry(appName, appPath, entries) {
    const name = normalizeText(appName);
    const pathValue = normalizeText(appPath);
    const baseName = normalizeText(path.basename(appPath || ''));

    let best = null;
    let bestScore = 0;

    for (const entry of entries) {
        const entryName = normalizeText(entry.DisplayName);
        const installLocation = normalizeText(entry.InstallLocation);
        if (!entryName) continue;

        let score = 0;
        if (installLocation && pathValue && pathValue.startsWith(installLocation)) score += 5;
        if (entryName === name || entryName === baseName) score += 4;
        if (name && (entryName.includes(name) || name.includes(entryName))) score += 2;
        if (baseName && (entryName.includes(baseName) || baseName.includes(entryName))) score += 1;

        if (score > bestScore) {
            bestScore = score;
            best = entry;
        }
    }

    return bestScore > 0 ? best : null;
}

/**
 * Parse Steam libraryfolders.vdf to discover games across ALL drives!
 */
async function getSteamLibraryPaths() {
    const defaultSteam = 'C:/Program Files (x86)/Steam';
    const libraryDirs = new Set([path.join(defaultSteam, 'steamapps', 'common')]);
    const vdfPath = path.join(defaultSteam, 'steamapps', 'libraryfolders.vdf');
    try {
        const content = await fs.readFile(vdfPath, 'utf-8');
        const matches = content.matchAll(/"path"\s+"([^"]+)"/gi);
        for (const m of matches) {
            const libRoot = m[1].replace(/\\\\/g, '\\');
            libraryDirs.add(path.join(libRoot, 'steamapps', 'common'));
        }
    } catch {
        // Steam not installed or VDF unavailable
    }
    return Array.from(libraryDirs);
}

async function getGamesList() {
    const steamDirs = await getSteamLibraryPaths();
    const drives = await getAllDrivesData();
    const candidateDirs = [];

    for (const dir of steamDirs) {
        candidateDirs.push({ launcher: 'Steam', dir });
    }

    const knownRelative = [
        { launcher: 'Epic Games', rel: 'Program Files/Epic Games' },
        { launcher: 'HoYoPlay', rel: 'Program Files/HoYoPlay/games' },
        { launcher: 'Riot Games', rel: 'Riot Games' },
        { launcher: 'Ubisoft', rel: 'Program Files (x86)/Ubisoft/Ubisoft Game Launcher/games' },
        { launcher: 'EA Games', rel: 'Program Files/EA Games' },
        { launcher: 'Xbox Games', rel: 'XboxGames' },
        { launcher: 'GOG Galaxy', rel: 'Program Files (x86)/GOG Galaxy/Games' }
    ];

    for (const drive of drives) {
        for (const item of knownRelative) {
            candidateDirs.push({
                launcher: item.launcher,
                dir: path.join(`${drive.letter}:\\`, item.rel)
            });
        }
    }

    const games = [];
    const seenPaths = new Set();
    const ignoredFolders = new Set(['steamworks shared', 'directx', 'redist', '_commonredist', 'epic online services']);

    await Promise.all(
        candidateDirs.map(async (p) => {
            try {
                const items = await fs.readdir(p.dir, { withFileTypes: true });
                for (const item of items) {
                    if (!item.isDirectory()) continue;
                    if (ignoredFolders.has(item.name.toLowerCase())) continue;
                    const fullPath = path.join(p.dir, item.name);
                    const key = normalizePathKey(fullPath);
                    if (seenPaths.has(key)) continue;
                    seenPaths.add(key);
                    games.push({
                        name: item.name,
                        launcher: p.launcher,
                        path: fullPath,
                        cachedSize: sizeCache.has(key) ? sizeCache.get(key).size : null
                    });
                }
            } catch {
                // Directory doesn't exist
            }
        })
    );

    games.sort((a, b) => a.name.localeCompare(b.name));
    return games;
}

async function getAppsList() {
    const appRoots = [
        { source: 'Program Files', dir: 'C:\\Program Files' },
        { source: 'Program Files (x86)', dir: 'C:\\Program Files (x86)' }
    ];

    if (process.env.LOCALAPPDATA) {
        appRoots.push({
            source: 'LocalAppData',
            dir: path.join(process.env.LOCALAPPDATA, 'Programs')
        });
    }

    const apps = [];
    const seen = new Set();

    await Promise.all(
        appRoots.map(async (root) => {
            try {
                const items = await fs.readdir(root.dir, { withFileTypes: true });
                for (const item of items) {
                    if (!item.isDirectory()) continue;
                    const appPath = path.join(root.dir, item.name);
                    const key = normalizePathKey(appPath);
                    if (seen.has(key)) continue;
                    seen.add(key);
                    apps.push({
                        name: item.name,
                        source: root.source,
                        path: appPath,
                        cachedSize: sizeCache.has(key) ? sizeCache.get(key).size : null
                    });
                }
            } catch {
                // Ignore inaccessible roots
            }
        })
    );

    apps.sort((a, b) => a.name.localeCompare(b.name));
    return apps;
}

async function getLaunchersList() {
    const launchers = [
        { name: 'Steam', path: 'C:\\Program Files (x86)\\Steam' },
        { name: 'Epic Games', path: 'C:\\Program Files\\Epic Games' },
        { name: 'HoYoPlay', path: 'C:\\Program Files\\HoYoPlay' },
        { name: 'Riot Games', path: 'C:\\Riot Games' },
        { name: 'Ubisoft Connect', path: 'C:\\Program Files (x86)\\Ubisoft\\Ubisoft Game Launcher' },
        { name: 'EA App', path: 'C:\\Program Files\\Electronic Arts\\EA Desktop' }
    ];

    const results = [];
    await Promise.all(
        launchers.map(async (launcher) => {
            try {
                await fs.access(launcher.path);
                const key = normalizePathKey(launcher.path);
                results.push({
                    name: launcher.name,
                    source: 'Launcher',
                    path: launcher.path,
                    cachedSize: sizeCache.has(key) ? sizeCache.get(key).size : null
                });
            } catch {
                // Not installed
            }
        })
    );

    results.sort((a, b) => a.name.localeCompare(b.name));
    return results;
}

/**
 * Quick Cleanup Insights: User Temp, Downloads, Electron/App Caches
 */
async function getCleanupInfo() {
    const userTemp = os.tmpdir();
    const downloadsDir = path.join(os.homedir(), 'Downloads');
    const localTemp = process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Temp') : null;
    const targets = [
        {
            id: 'user-temp',
            name: 'User Temporary Files',
            description: 'Safe-to-clear temporary files created by Windows & apps',
            path: userTemp,
            canClean: true
        },
        {
            id: 'downloads',
            name: 'Downloads Folder',
            description: 'Installers, archives, and downloaded media',
            path: downloadsDir,
            canClean: false
        }
    ];
    if (localTemp && normalizePathKey(localTemp) !== normalizePathKey(userTemp)) {
        targets.push({
            id: 'local-temp',
            name: 'LocalAppData Temp',
            description: 'Additional local application temporary files',
            path: localTemp,
            canClean: false
        });
    }

    const results = await Promise.all(
        targets.map(async (t) => {
            const size = await calculateDirectorySizeNative(t.path).catch(() => 0);
            return { ...t, size };
        })
    );
    return results;
}

async function cleanUserTempFolder() {
    const tempDir = os.tmpdir();
    let deletedCount = 0;
    let freedBytes = 0;
    let skippedCount = 0;

    try {
        const entries = await fs.readdir(tempDir, { withFileTypes: true });
        await Promise.all(
            entries.map(async (entry) => {
                const fullPath = path.join(tempDir, entry.name);
                try {
                    const st = await fs.lstat(fullPath);
                    const sz = st.isDirectory() ? await calculateDirectorySizeNative(fullPath) : st.size;
                    await fs.rm(fullPath, { recursive: true, force: true });
                    deletedCount += 1;
                    freedBytes += sz;
                } catch {
                    skippedCount += 1;
                }
            })
        );
        return { success: true, deletedCount, freedBytes, skippedCount };
    } catch (error) {
        return { success: false, message: error.message || 'Failed to clean temp folder.' };
    }
}

async function readAiKey() {
    if (!aiKeyPath) return null;
    try {
        const data = await fs.readFile(aiKeyPath, 'utf-8');
        return data.trim() || null;
    } catch {
        return null;
    }
}

async function writeAiKey(value) {
    if (!aiKeyPath) return false;
    try {
        await fs.writeFile(aiKeyPath, value.trim(), 'utf-8');
        return true;
    } catch {
        return false;
    }
}

function parseAiPayload(text) {
    if (!text) return null;
    try {
        return JSON.parse(text);
    } catch {
        const match = text.match(/\{[\s\S]*\}/);
        if (!match) return null;
        try {
            return JSON.parse(match[0]);
        } catch {
            return null;
        }
    }
}

async function requestGemini(apiKey, prompt, modelName) {
    const safeModel = modelName || DEFAULT_GEMINI_MODEL;
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${safeModel}:generateContent?key=${apiKey}`;
    const payload = {
        systemInstruction: {
            parts: [{
                text: 'You are AniLite AI, a helpful, concise storage optimization assistant. Reply in the same language as the user. Provide clear, actionable storage insights. Output JSON only: {"reply":"...","actions":[]}.'
            }]
        },
        contents: [{ role: 'user', parts: [{ text: prompt }] }]
    };

    const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    });

    if (!response.ok) {
        const errorText = await response.text();
        const statusText = `${response.status} ${response.statusText}`.trim();
        throw new Error(`Gemini error ${statusText}${errorText ? ` - ${errorText}` : ''}`);
    }
    const data = await response.json();
    return data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
}

async function runUninstallAction(action) {
    const entries = await fetchUninstallEntriesOnce();
    const entry = findBestUninstallEntry(action.name || '', action.path || '', entries);
    if (!entry) return { success: false, message: 'No uninstall entry found.' };

    let uninstallCommand = entry.QuietUninstallString || entry.UninstallString;
    if (!uninstallCommand) return { success: false, message: 'No uninstall command available.' };

    uninstallCommand = uninstallCommand.replace(/\/I\s*({[^}]+})/i, '/X $1');
    uninstallCommand = uninstallCommand.replace(/\s\/I\s/i, ' /X ');

    return new Promise((resolve) => {
        exec(uninstallCommand, (error) => {
            if (error) resolve({ success: false, message: 'Uninstall command failed to start.' });
            else resolve({ success: true, displayName: entry.DisplayName });
        });
    });
}

async function resolveExecutablePath(targetPath, nameHint) {
    if (!targetPath) return null;
    try {
        const stat = await fs.stat(targetPath);
        if (stat.isFile() && targetPath.toLowerCase().endsWith('.exe')) return targetPath;
    } catch {
        return null;
    }

    const queue = [{ dir: targetPath, depth: 0 }];
    const maxDepth = 2;
    const hint = (nameHint || '').toLowerCase();

    while (queue.length) {
        const { dir, depth } = queue.shift();
        if (depth > maxDepth) continue;
        let entries = [];
        try {
            entries = await fs.readdir(dir, { withFileTypes: true });
        } catch {
            continue;
        }
        const exeCandidates = entries.filter(e => e.isFile() && e.name.toLowerCase().endsWith('.exe'));
        if (exeCandidates.length) {
            const preferred = exeCandidates.find(e => e.name.toLowerCase().includes(hint));
            return path.join(dir, (preferred || exeCandidates[0]).name);
        }
        if (depth < maxDepth) {
            for (const entry of entries) {
                if (entry.isDirectory()) {
                    queue.push({ dir: path.join(dir, entry.name), depth: depth + 1 });
                }
            }
        }
    }
    return null;
}

function scoreExecutableCandidate(fileName, nameHint) {
    const normalizedFile = normalizeText(fileName).replace('.exe', '');
    const normalizedHint = normalizeText(nameHint);
    const tokens = normalizedHint.split(/[^a-z0-9]+/).filter(t => t.length >= 3);

    let score = 0;
    if (normalizedHint && normalizedFile.includes(normalizedHint)) score += 10;
    tokens.forEach(token => {
        if (normalizedFile.includes(token)) score += 3;
    });

    const banned = ['unins', 'uninstall', 'setup', 'crash', 'report', 'launcher', 'redistributable', 'eac', 'anticheat', 'unitycrashhandler'];
    if (banned.some(token => normalizedFile.includes(token))) score -= 8;
    return score;
}

async function findLaunchableGameExecutable(targetPath, nameHint) {
    if (!targetPath) return null;
    try {
        const stat = await fs.stat(targetPath);
        if (stat.isFile() && targetPath.toLowerCase().endsWith('.exe')) return targetPath;
    } catch {
        return null;
    }

    const queue = [{ dir: targetPath, depth: 0 }];
    const maxDepth = 3;
    const candidates = [];

    while (queue.length) {
        const { dir, depth } = queue.shift();
        if (depth > maxDepth) continue;
        let entries = [];
        try {
            entries = await fs.readdir(dir, { withFileTypes: true });
        } catch {
            continue;
        }

        for (const entry of entries) {
            if (entry.isFile() && entry.name.toLowerCase().endsWith('.exe')) {
                candidates.push({
                    path: path.join(dir, entry.name),
                    score: scoreExecutableCandidate(entry.name, nameHint)
                });
            } else if (entry.isDirectory() && depth < maxDepth) {
                queue.push({ dir: path.join(dir, entry.name), depth: depth + 1 });
            }
        }
    }

    if (candidates.length === 0) return null;
    candidates.sort((a, b) => b.score - a.score);
    return candidates[0].path;
}

async function launchGame(targetPath, nameHint) {
    const exePath = await findLaunchableGameExecutable(targetPath, nameHint);
    if (!exePath) return { success: false, message: 'No launchable game executable found.' };

    try {
        const child = spawn(exePath, [], {
            cwd: path.dirname(exePath),
            detached: true,
            stdio: 'ignore'
        });
        child.unref();
        return { success: true, path: exePath };
    } catch (error) {
        return { success: false, message: error?.message || 'Failed to launch game.' };
    }
}

async function getIconDataUrl(targetPath, nameHint) {
    if (!targetPath) return null;
    const key = normalizePathKey(targetPath);
    if (iconCache.has(key)) return iconCache.get(key);

    const exePath = await resolveExecutablePath(targetPath, nameHint);
    if (!exePath) {
        iconCache.set(key, null);
        return null;
    }
    try {
        const icon = await app.getFileIcon(exePath, { size: 'normal' });
        const url = icon.toDataURL();
        iconCache.set(key, url);
        return url;
    } catch {
        iconCache.set(key, null);
        return null;
    }
}

async function selectUpdateInstaller(win) {
    const result = await dialog.showOpenDialog(win, {
        title: 'Select update installer',
        properties: ['openFile'],
        filters: [{ name: 'Executable', extensions: ['exe'] }]
    });
    if (result.canceled || !result.filePaths?.length) return { success: false, canceled: true };
    const installerPath = result.filePaths[0];
    return { success: true, path: installerPath, fileName: path.basename(installerPath) };
}

async function launchUpdateInstaller(installerPath) {
    if (!installerPath || !installerPath.toLowerCase().endsWith('.exe')) {
        return { success: false, message: 'Please select a valid .exe installer.' };
    }
    try {
        const stat = await fs.stat(installerPath);
        if (!stat.isFile()) return { success: false, message: 'Selected update file was not found.' };
    } catch {
        return { success: false, message: 'Selected update file was not found.' };
    }

    try {
        const child = spawn(installerPath, [], { detached: true, stdio: 'ignore' });
        child.unref();
        setTimeout(() => app.quit(), 300);
        return { success: true };
    } catch (error) {
        return { success: false, message: error?.message || 'Failed to launch installer.' };
    }
}

async function selectImageFile(win) {
    const result = await dialog.showOpenDialog(win, {
        title: 'Select image',
        properties: ['openFile'],
        filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'ico'] }]
    });
    if (result.canceled || !result.filePaths?.length) return { success: false, canceled: true };
    const selectedPath = result.filePaths[0];
    return { success: true, path: selectedPath, fileName: path.basename(selectedPath) };
}

function setRpcActivity() {
    if (!rpcReady || !rpcClient || !currentSettings?.rpc || currentSettings.rpc.enabled === false) return;
    const rpc = currentSettings.rpc;
    rpcClient.setActivity({
        details: rpc.details,
        state: rpc.state,
        startTimestamp: sessionStart,
        largeImageKey: rpc.largeImageKey,
        largeImageText: rpc.largeImageText,
        smallImageKey: rpc.smallImageKey,
        smallImageText: rpc.smallImageText
    }).then(() => { rpcActive = true; }).catch(() => {});
}

function clearRpcActivity() {
    if (!rpcReady || !rpcActive || !rpcClient) return;
    rpcClient.clearActivity().then(() => { rpcActive = false; }).catch(() => {});
}

async function restartRpcClient() {
    try {
        if (rpcClient) {
            try { await rpcClient.clearActivity(); } catch {}
            try { rpcClient.destroy(); } catch {}
        }
    } catch {}

    rpcClient = null;
    rpcReady = false;
    rpcActive = false;

    if (currentSettings?.rpc?.enabled === false) return;
    const rpcClientId = currentSettings?.rpc?.clientId ? currentSettings.rpc.clientId.trim() : '';
    if (!rpcClientId) return;

    rpcClient = new RPC.Client({ transport: 'ipc' });
    rpcClient.on('ready', () => {
        rpcReady = true;
        setRpcActivity();
    });
    rpcClient.login({ clientId: rpcClientId }).catch(() => {});
}

app.whenReady().then(async () => {
    app.setAppUserModelId('com.anilite.storage');
    const userData = app.getPath('userData');
    settingsPath = path.join(userData, 'settings.json');
    sizeCachePath = path.join(userData, 'size-cache.json');
    aiKeyPath = path.join(userData, 'gemini.key');

    await Promise.all([
        readSettings().then(s => { currentSettings = s; }),
        loadSizeCacheFromDisk()
    ]);

    createWindow();
    restartRpcClient();
    // Warm up uninstall registry cache in background without blocking UI!
    fetchUninstallEntriesOnce();

    setInterval(() => {
        if (Date.now() - lastActivity > 100000) clearRpcActivity();
    }, 5000);

    ipcMain.handle('get-storage-data', async () => {
        try { return await checkDiskSpace('C:/'); } catch { return null; }
    });

    ipcMain.handle('get-drives-data', async () => {
        return await getAllDrivesData();
    });

    ipcMain.handle('get-cleanup-info', async () => {
        return await getCleanupInfo();
    });

    ipcMain.handle('clean-temp-folder', async () => {
        return await cleanUserTempFolder();
    });

    ipcMain.handle('open-path', async (_event, targetPath) => {
        if (!targetPath) return { success: false };
        const err = await shell.openPath(targetPath);
        return { success: !err, message: err || '' };
    });

    ipcMain.on('rpc-activity', () => {
        lastActivity = Date.now();
        if (!rpcActive) {
            sessionStart = Date.now();
            setRpcActivity();
        }
    });

    ipcMain.handle('get-games-list', async () => await getGamesList());
    ipcMain.handle('get-game-size', async (_event, gamePath) => await getFolderSizeFast(gamePath));
    ipcMain.handle('get-apps-list', async () => await getAppsList());
    ipcMain.handle('get-launchers-list', async () => await getLaunchersList());
    ipcMain.handle('get-app-size', async (_event, appPath) => await getFolderSizeFast(appPath));
    ipcMain.handle('get-app-icon', async (_event, targetPath, nameHint) => await getIconDataUrl(targetPath, nameHint));

    /**
     * High-speed parallel streaming size scanner
     * Processes up to 6 folders concurrently and streams results back immediately!
     */
    ipcMain.handle('start-size-scan', async (event, paths, forceRefresh = false) => {
        const scanId = ++activeScanId;
        const uniquePaths = Array.from(new Set((paths || []).filter(Boolean)));
        const total = uniquePaths.length;
        let completed = 0;

        if (total === 0) {
            event.sender.send('scan-complete', { scanId, total: 0 });
            return { scanId, total: 0 };
        }

        let cursor = 0;
        const concurrency = 6;

        async function worker() {
            while (cursor < uniquePaths.length) {
                if (scanId !== activeScanId) return;
                const targetPath = uniquePaths[cursor++];
                const size = await getFolderSizeFast(targetPath, forceRefresh);
                if (scanId !== activeScanId) return;
                completed += 1;
                if (!event.sender.isDestroyed()) {
                    event.sender.send('scan-item-size', {
                        scanId,
                        path: targetPath,
                        size,
                        completed,
                        total
                    });
                }
            }
        }

        const workers = [];
        for (let i = 0; i < Math.min(concurrency, total); i++) {
            workers.push(worker());
        }

        // Run asynchronously so invoke returns immediately with scanId
        Promise.all(workers).then(() => {
            if (scanId === activeScanId && !event.sender.isDestroyed()) {
                event.sender.send('scan-complete', { scanId, total });
            }
        });

        return { scanId, total };
    });

    ipcMain.handle('get-settings', async () => {
        currentSettings = await readSettings();
        return getRendererSettings();
    });

    ipcMain.handle('select-settings-image', async () => {
        const win = BrowserWindow.getFocusedWindow() || mainWindow || null;
        return await selectImageFile(win);
    });

    ipcMain.handle('save-settings', async (_event, nextSettings) => {
        const sanitized = deepMergeSettings(DEFAULT_SETTINGS, nextSettings || {});
        if (!sanitized.rpc.clientId || !sanitized.rpc.clientId.trim()) {
            sanitized.rpc.clientId = DEFAULT_RPC_CLIENT_ID;
        }
        const ok = await writeSettings(sanitized);
        if (!ok) return { success: false, message: 'Failed to save settings.' };
        applyWindowIcon(mainWindow);
        await restartRpcClient();
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('settings-updated', getRendererSettings());
        }
        return { success: true, settings: getRendererSettings() };
    });

    ipcMain.handle('reset-visual-settings', async () => {
        const next = deepMergeSettings(currentSettings || DEFAULT_SETTINGS, {
            images: { backgroundPath: '', accentPath: '', overlayPath: '', logoPath: '' }
        });
        const ok = await writeSettings(next);
        if (!ok) return { success: false, message: 'Failed to reset images.' };
        applyWindowIcon(mainWindow);
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('settings-updated', getRendererSettings());
        }
        return { success: true, settings: getRendererSettings() };
    });

    ipcMain.handle('launch-game', async (_event, targetPath, nameHint) => await launchGame(targetPath, nameHint));
    ipcMain.handle('get-app-version', () => ({ version: app.getVersion() }));
    ipcMain.handle('select-update-installer', async () => {
        const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0] || null;
        return await selectUpdateInstaller(win);
    });
    ipcMain.handle('install-update-installer', async (_event, installerPath) => await launchUpdateInstaller(installerPath));

    ipcMain.handle('get-uninstall-info', async (_event, appName, appPath) => {
        const entries = await fetchUninstallEntriesOnce();
        const entry = findBestUninstallEntry(appName, appPath, entries);
        if (!entry) return { available: false };
        const uninstallString = entry.QuietUninstallString || entry.UninstallString;
        return {
            available: !!uninstallString,
            displayName: entry.DisplayName,
            version: entry.DisplayVersion || '',
            publisher: entry.Publisher || ''
        };
    });

    ipcMain.handle('uninstall-app', async (_event, appName, appPath) => {
        return await runUninstallAction({ name: appName, path: appPath });
    });

    ipcMain.handle('get-ai-key-status', async () => ({ hasKey: !!(await readAiKey()) }));
    ipcMain.handle('set-ai-key', async (_event, apiKey) => {
        if (!apiKey || !apiKey.trim()) return { success: false };
        return { success: await writeAiKey(apiKey) };
    });

    ipcMain.handle('ai-chat', async (_event, message, model) => {
        const apiKey = await readAiKey();
        if (!apiKey) return { reply: 'Gemini API key not set. Save a key first.', actions: [] };

        const [drives, games, apps, launchers] = await Promise.all([
            getAllDrivesData(),
            getGamesList(),
            getAppsList(),
            getLaunchersList()
        ]);

        // Use our instant sizeCache for top space hogs — zero waiting!
        const allWithSizes = [
            ...apps.map(a => ({ name: a.name, type: 'App', sizeBytes: sizeCache.get(normalizePathKey(a.path))?.size || 0 })),
            ...games.map(g => ({ name: g.name, type: `Game (${g.launcher})`, sizeBytes: sizeCache.get(normalizePathKey(g.path))?.size || 0 }))
        ]
            .filter(i => i.sizeBytes > 0)
            .sort((a, b) => b.sizeBytes - a.sizeBytes)
            .slice(0, 25)
            .map(i => ({ name: i.name, type: i.type, sizeGB: (i.sizeBytes / (1024 ** 3)).toFixed(2) }));

        const storageSummary = {
            drives: drives.map(d => ({
                drive: d.diskPath,
                totalGB: (d.size / (1024 ** 3)).toFixed(1),
                freeGB: (d.free / (1024 ** 3)).toFixed(1),
                usedPercent: d.usedPercent
            })),
            appsCount: apps.length,
            gamesCount: games.length,
            launchers: launchers.map(l => l.name),
            topSpaceConsumers: allWithSizes
        };

        const prompt = `User request: ${message}\nStorage summary: ${JSON.stringify(storageSummary)}`;

        try {
            const raw = await requestGemini(apiKey, prompt, model);
            const parsed = parseAiPayload(raw);
            if (parsed && parsed.reply) {
                parsed.actions = [];
                return parsed;
            }
            return { reply: raw || 'No response from model.', actions: [] };
        } catch (error) {
            return { reply: error?.message || 'AI request failed.', actions: [] };
        }
    });

    ipcMain.handle('ai-action', async (_event, action) => {
        if (!action || !action.type) return { success: false, message: 'Invalid action.' };
        if (action.type === 'uninstall') return await runUninstallAction(action);
        return { success: false, message: 'Action not supported.' };
    });

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
    try { if (rpcClient) rpcClient.clearActivity(); } catch {}
    try { if (rpcClient) rpcClient.destroy(); } catch {}
});
