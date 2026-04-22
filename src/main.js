// main.js. Electron main process.
// Creates the control panel and overlay windows, wires IPC, tracks the target window position.

const { app, BrowserWindow, ipcMain, desktopCapturer, screen, globalShortcut } = require('electron');
const path = require('path');

let controlWin = null;
let overlayWin = null;
let targetBounds = null;
let trackingInterval = null;
let windowManager = null;
// Manual offset for tracking. Applied on top of raw window bounds.
// Defaults calibrated to account for Windows invisible border / drop shadow pixels
// on DWM-composited windows. Verified on varied scaling monitors.
const manualOffset = { x: 7, y: 0, w: -12, h: -7 };

// Try to load node-window-manager. It's optional. Without it we fall back to manual positioning.
try {
  windowManager = require('node-window-manager').windowManager;
} catch (e) {
  console.warn('node-window-manager not available. Manual overlay positioning only.');
}

function createControlWindow() {
  controlWin = new BrowserWindow({
    width: 420,
    height: 820,
    title: 'RS Vision Assist. Control Panel',
    backgroundColor: '#0d0f14',
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
    resizable: true,
    minimizable: true,
  });
  controlWin.loadFile(path.join(__dirname, 'control.html'));
  controlWin.on('closed', () => {
    app.quit();
  });
}

function createOverlayWindow(bounds) {
  // Start the overlay at a placeholder size. User will lock it to the game window later.
  overlayWin = new BrowserWindow({
    width: bounds?.width || 1280,
    height: bounds?.height || 720,
    x: bounds?.x || 100,
    y: bounds?.y || 100,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: true,
    hasShadow: false,
    focusable: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      backgroundThrottling: false,
    },
  });
  // Use 'floating' level. Keeps overlay above normal windows without fighting with other OnTop
  // windows (like the control panel when dragged). 'screen-saver' level was causing drag jitter.
  overlayWin.setAlwaysOnTop(true, 'floating');
  overlayWin.setIgnoreMouseEvents(true, { forward: true });
  overlayWin.loadFile(path.join(__dirname, 'overlay.html'));
  overlayWin.on('closed', () => {
    overlayWin = null;
  });
}

// ============================================================================
// IPC
// ============================================================================

// Control panel asks for list of capturable windows.
ipcMain.handle('get-sources', async () => {
  const sources = await desktopCapturer.getSources({
    types: ['window', 'screen'],
    thumbnailSize: { width: 320, height: 180 },
  });
  return sources.map(s => ({
    id: s.id,
    name: s.name,
    thumbnail: s.thumbnail.toDataURL(),
  }));
});

// Control panel tells us which source to capture. We forward it to overlay.
ipcMain.handle('set-source', (event, sourceId) => {
  if (overlayWin) {
    overlayWin.webContents.send('set-source', sourceId);
  }
  return true;
});

// Control panel sends updated filter settings. Forward to overlay.
ipcMain.handle('set-settings', (event, settings) => {
  if (overlayWin) {
    overlayWin.webContents.send('set-settings', settings);
  }
  return true;
});

// Control panel sends updated filter stack. Forward to overlay.
ipcMain.handle('set-stack', (event, stack) => {
  if (overlayWin) {
    overlayWin.webContents.send('set-stack', stack);
  }
  return true;
});

// Control panel asks us to open the overlay.
ipcMain.handle('open-overlay', (event, bounds) => {
  if (overlayWin) {
    overlayWin.close();
    overlayWin = null;
  }
  createOverlayWindow(bounds);
  return true;
});

ipcMain.handle('close-overlay', () => {
  if (overlayWin) {
    overlayWin.close();
    overlayWin = null;
  }
  stopTracking();
  return true;
});

ipcMain.handle('force-overlay-refresh', () => {
  if (overlayWin && overlayWin.webContents) {
    overlayWin.webContents.send('force-refresh');
  }
  return true;
});

// Control panel asks for list of windows matching a title pattern for tracking.
ipcMain.handle('list-windows', () => {
  if (!windowManager) return [];
  try {
    return windowManager.getWindows().map(w => ({
      id: w.id,
      title: w.getTitle(),
      bounds: w.getBounds(),
      processId: w.processId,
    })).filter(w => w.title && w.title.length > 0);
  } catch (e) {
    return [];
  }
});

// Start tracking a specific window by id. Overlay follows its bounds.
ipcMain.handle('start-tracking', (event, windowId) => {
  stopTracking();
  if (!windowManager || !windowId) return false;

  const trackedId = windowId;
  let cachedTarget = windowManager.getWindows().find(w => w.id === trackedId);
  let failureCount = 0;
  let lastChangeMs = 0;
  let frozenDuringMove = false;
  let lastBounds = null;

  trackingInterval = setInterval(() => {
    try {
      if (!overlayWin) {
        stopTracking();
        return;
      }

      if (!cachedTarget) {
        cachedTarget = windowManager.getWindows().find(w => w.id === trackedId);
        if (!cachedTarget) {
          failureCount++;
          if (failureCount > 30) stopTracking();
          return;
        }
        failureCount = 0;
      }

      // Check if target window or control panel has focus
      let shouldShowOverlay = false;
      try {
        const activeWindow = windowManager.getActiveWindow();
        if (activeWindow) {
          const isTargetFocused = activeWindow.id === trackedId;
          const isControlFocused = controlWin && controlWin.isFocused();
          shouldShowOverlay = isTargetFocused || isControlFocused;
        } else {
          // No active window detected, keep overlay visible
          shouldShowOverlay = true;
        }
      } catch (e) {
        // Fallback: assume focused if we can't determine
        shouldShowOverlay = true;
      }

      // Hide overlay when neither target nor control panel has focus
      if (!shouldShowOverlay) {
        if (overlayWin.isVisible()) {
          overlayWin.hide();
        }
        return;
      } else {
        if (!overlayWin.isVisible()) {
          overlayWin.show();
        }
      }

      let rawBounds;
      try {
        rawBounds = cachedTarget.getBounds();
      } catch (e) {
        cachedTarget = null;
        return;
      }
      if (!rawBounds || rawBounds.width < 10 || rawBounds.height < 10) return;

      const bounds = {
        x: rawBounds.x + manualOffset.x,
        y: rawBounds.y + manualOffset.y,
        width: rawBounds.width + manualOffset.w,
        height: rawBounds.height + manualOffset.h,
      };

      const now = Date.now();
      const changed = !targetBounds ||
        targetBounds.x !== bounds.x ||
        targetBounds.y !== bounds.y ||
        targetBounds.width !== bounds.width ||
        targetBounds.height !== bounds.height;

      if (changed) {
        const sizeChanged = !targetBounds ||
          targetBounds.width !== bounds.width ||
          targetBounds.height !== bounds.height;
        const posChanged = !targetBounds ||
          targetBounds.x !== bounds.x ||
          targetBounds.y !== bounds.y;

        // Detect rapid movement (dragging)
        const timeSinceLastChange = now - lastChangeMs;
        const moveFast = timeSinceLastChange < 50;

        // If moving fast, freeze rendering and batch position updates
        if (moveFast && !frozenDuringMove) {
          overlayWin.webContents.send('set-frozen', true);
          frozenDuringMove = true;
          lastBounds = bounds;
        }

        // During fast movement, batch updates less frequently
        if (frozenDuringMove) {
          lastBounds = bounds;
          // Only update position every 50ms during drag
          if (timeSinceLastChange >= 50) {
            try {
              if (posChanged) overlayWin.setPosition(lastBounds.x, lastBounds.y, false);
              if (sizeChanged) overlayWin.setSize(lastBounds.width, lastBounds.height, false);
            } catch (e) {
              try { overlayWin.setBounds(lastBounds, false); } catch (_) {}
            }
            targetBounds = { ...lastBounds };
            lastChangeMs = now;
          }
        } else {
          // Normal movement - update immediately
          try {
            if (posChanged) overlayWin.setPosition(bounds.x, bounds.y, false);
            if (sizeChanged) overlayWin.setSize(bounds.width, bounds.height, false);
          } catch (e) {
            try { overlayWin.setBounds(bounds, false); } catch (_) {}
          }
          targetBounds = { ...bounds };
          lastChangeMs = now;
        }
      } else if (frozenDuringMove && (now - lastChangeMs) > 150) {
        // Movement stopped. Apply final position and resume live rendering.
        if (lastBounds) {
          try {
            overlayWin.setPosition(lastBounds.x, lastBounds.y, false);
            overlayWin.setSize(lastBounds.width, lastBounds.height, false);
          } catch (e) {
            try { overlayWin.setBounds(lastBounds, false); } catch (_) {}
          }
          targetBounds = { ...lastBounds };
          lastBounds = null;
        }
        overlayWin.webContents.send('set-frozen', false);
        frozenDuringMove = false;
      }
    } catch (e) {
      cachedTarget = null;
    }
  }, 16);

  return true;
});

ipcMain.handle('stop-tracking', () => {
  stopTracking();
  return true;
});

function stopTracking() {
  if (trackingInterval) {
    clearInterval(trackingInterval);
    trackingInterval = null;
  }
  targetBounds = null;
}

// Control panel asks to manually set overlay bounds.
ipcMain.handle('set-overlay-bounds', (event, bounds) => {
  if (overlayWin) {
    overlayWin.setBounds(bounds);
  }
  return true;
});

// Overlay reports its actual bounds (after OS adjustments).
ipcMain.handle('get-overlay-bounds', () => {
  if (overlayWin) return overlayWin.getBounds();
  return null;
});

// Panic button. Instantly hide overlay.
ipcMain.handle('toggle-overlay-visible', (event, visible) => {
  if (overlayWin) {
    if (visible) overlayWin.show();
    else overlayWin.hide();
  }
  return true;
});

// Manual offset for tracking bounds. Persisted when changed.
ipcMain.handle('set-manual-offset', (event, offset) => {
  manualOffset.x = parseFloat(offset.x) || 0;
  manualOffset.y = parseFloat(offset.y) || 0;
  manualOffset.w = parseFloat(offset.w) || 0;
  manualOffset.h = parseFloat(offset.h) || 0;
  targetBounds = null;
  return true;
});

ipcMain.handle('get-manual-offset', () => manualOffset);

// Overlay reports FPS. Forward to control panel.
ipcMain.handle('overlay-fps', (event, fps) => {
  if (controlWin) controlWin.webContents.send('overlay-fps-report', fps);
  return true;
});

// -----------------------------------------------------------------------------
// Custom preset storage. Saved to userData/presets.json so they survive restarts
// and can be bundled with the app by shipping a default presets.json with the build.
// -----------------------------------------------------------------------------
const fs = require('fs');
function presetFilePath() {
  return path.join(app.getPath('userData'), 'presets.json');
}
function bundledPresetPath() {
  // Allow shipping default presets with the app. Checked on first run.
  return path.join(__dirname, 'default-presets.json');
}

function loadPresets() {
  const userPath = presetFilePath();
  try {
    if (fs.existsSync(userPath)) {
      return JSON.parse(fs.readFileSync(userPath, 'utf8'));
    }
    const bundled = bundledPresetPath();
    if (fs.existsSync(bundled)) {
      const data = JSON.parse(fs.readFileSync(bundled, 'utf8'));
      fs.writeFileSync(userPath, JSON.stringify(data, null, 2));
      return data;
    }
  } catch (e) {
    console.error('loadPresets failed', e);
  }
  return { presets: {}, defaultPreset: null };
}

function savePresets(data) {
  try {
    fs.writeFileSync(presetFilePath(), JSON.stringify(data, null, 2));
    return true;
  } catch (e) {
    console.error('savePresets failed', e);
    return false;
  }
}

ipcMain.handle('presets-list', () => loadPresets());

ipcMain.handle('presets-save', (event, name, config) => {
  const data = loadPresets();
  data.presets[name] = config;
  return savePresets(data);
});

ipcMain.handle('presets-delete', (event, name) => {
  const data = loadPresets();
  delete data.presets[name];
  if (data.defaultPreset === name) data.defaultPreset = null;
  return savePresets(data);
});

ipcMain.handle('presets-set-default', (event, name) => {
  const data = loadPresets();
  data.defaultPreset = name;
  return savePresets(data);
});

// ============================================================================
// APP LIFECYCLE
// ============================================================================

app.whenReady().then(() => {
  createControlWindow();

  // Global hotkey: Ctrl+Shift+F1 toggles overlay visibility. Safety net if something goes wrong.
  globalShortcut.register('Control+Shift+F1', () => {
    if (overlayWin) {
      if (overlayWin.isVisible()) overlayWin.hide();
      else overlayWin.show();
    }
  });
});

app.on('window-all-closed', () => {
  stopTracking();
  globalShortcut.unregisterAll();
  app.quit();
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});
