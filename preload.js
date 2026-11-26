const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
    // Storage & Drives
    getStorageData: () => ipcRenderer.invoke('get-storage-data'),
    getDrivesData: () => ipcRenderer.invoke('get-drives-data'),
    getCleanupInfo: () => ipcRenderer.invoke('get-cleanup-info'),
    cleanTempFolder: () => ipcRenderer.invoke('clean-temp-folder'),
    openPathInExplorer: (targetPath) => ipcRenderer.invoke('open-path', targetPath),

    // Games, Apps, Launchers
    getGamesList: () => ipcRenderer.invoke('get-games-list'),
    getGameSize: (gamePath) => ipcRenderer.invoke('get-game-size', gamePath),
    getAppsList: () => ipcRenderer.invoke('get-apps-list'),
    getLaunchersList: () => ipcRenderer.invoke('get-launchers-list'),
    getAppSize: (appPath) => ipcRenderer.invoke('get-app-size', appPath),

    // Fast Batched Streaming Size Scan
    startSizeScan: (paths, forceRefresh = false) => ipcRenderer.invoke('start-size-scan', paths, forceRefresh),
    onScanItemSize: (callback) => {
        const handler = (_event, payload) => callback(payload);
        ipcRenderer.on('scan-item-size', handler);
        return () => ipcRenderer.removeListener('scan-item-size', handler);
    },
    onScanComplete: (callback) => {
        const handler = (_event, payload) => callback(payload);
        ipcRenderer.on('scan-complete', handler);
        return () => ipcRenderer.removeListener('scan-complete', handler);
    },

    // Uninstall & Launch
    getUninstallInfo: (appName, appPath) => ipcRenderer.invoke('get-uninstall-info', appName, appPath),
    uninstallApp: (appName, appPath) => ipcRenderer.invoke('uninstall-app', appName, appPath),
    launchGame: (targetPath, nameHint) => ipcRenderer.invoke('launch-game', targetPath, nameHint),

    // Icons
    getAppIcon: (targetPath, nameHint) => ipcRenderer.invoke('get-app-icon', targetPath, nameHint),

    // Discord RPC Activity
    reportActivity: () => ipcRenderer.send('rpc-activity'),

    // AI
    getAiKeyStatus: () => ipcRenderer.invoke('get-ai-key-status'),
    saveAiKey: (apiKey) => ipcRenderer.invoke('set-ai-key', apiKey),
    aiChat: (message, model) => ipcRenderer.invoke('ai-chat', message, model),
    runAiAction: (action) => ipcRenderer.invoke('ai-action', action),

    // Settings
    getSettings: () => ipcRenderer.invoke('get-settings'),
    saveSettings: (settings) => ipcRenderer.invoke('save-settings', settings),
    resetVisualSettings: () => ipcRenderer.invoke('reset-visual-settings'),
    selectSettingsImage: () => ipcRenderer.invoke('select-settings-image'),
    onSettingsUpdated: (callback) => ipcRenderer.on('settings-updated', (_event, settings) => callback(settings)),

    // Updates
    getAppVersion: () => ipcRenderer.invoke('get-app-version'),
    selectUpdateInstaller: () => ipcRenderer.invoke('select-update-installer'),
    installUpdateInstaller: (installerPath) => ipcRenderer.invoke('install-update-installer', installerPath)
});
