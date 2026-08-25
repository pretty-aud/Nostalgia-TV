'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/**
 * The entire surface the renderer is allowed to touch. Everything is an
 * explicit named call — no generic `invoke(channel, ...)` escape hatch, so a
 * bug (or injected string) in the UI cannot reach an arbitrary main handler.
 */
contextBridge.exposeInMainWorld('tv', {
  pickFolder: () => ipcRenderer.invoke('library:pick'),
  scan: (rootPath) => ipcRenderer.invoke('library:scan', rootPath),
  // Finds the same folder again when its drive letter has changed.
  locateLibrary: (previousPath) => ipcRenderer.invoke('library:locate', previousPath),

  loadState: () => ipcRenderer.invoke('state:load'),
  saveState: (state) => ipcRenderer.invoke('state:save', state),
  // Reads the file back and compares it against the last write, so opening the
  // app can find out whether saving works before anything depends on it.
  saveStatus: () => ipcRenderer.invoke('state:status'),

  // A checkpoint made on purpose, kept apart from the rolling save so it
  // survives whatever the rolling save has since recorded.
  manualSave: (state) => ipcRenderer.invoke('state:manualSave', state),
  manualLoad: () => ipcRenderer.invoke('state:manualLoad'),
  manualInfo: () => ipcRenderer.invoke('state:manualInfo'),

  getThumb: (absPath) => ipcRenderer.invoke('thumb:get', absPath),
  putThumb: (absPath, dataUrl) => ipcRenderer.invoke('thumb:put', absPath, dataUrl),

  setFullscreen: (value) => ipcRenderer.invoke('window:setFullscreen', value),

  // The window has no system frame, so these are the only minimise and close
  // there are.
  minimizeWindow: () => ipcRenderer.invoke('window:minimize'),
  toggleMaximizeWindow: () => ipcRenderer.invoke('window:toggleMaximize'),
  closeWindow: () => ipcRenderer.invoke('window:close'),

  /** Maximised and fullscreen, pushed whenever they change — see main.js. */
  onWindowState: (handler) => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on('window:state', listener);
    return () => ipcRenderer.removeListener('window:state', listener);
  },

  revealFile: (absPath) => ipcRenderer.invoke('shell:revealFile', absPath),

  capabilities: () => ipcRenderer.invoke('prepare:capabilities'),
  inspect: (absPath) => ipcRenderer.invoke('prepare:inspect', absPath),
  ensurePlayable: (absPath, forceTier, audioIndex) => ipcRenderer.invoke('prepare:ensure', absPath, forceTier, audioIndex),
  detectCrop: (absPath) => ipcRenderer.invoke('prepare:crop', absPath),
  listTracks: (absPath) => ipcRenderer.invoke('prepare:tracks', absPath),
  subtitleText: (absPath, index) => ipcRenderer.invoke('prepare:subtitle', absPath, index),
  cancelPrepare: (absPath) => ipcRenderer.invoke('prepare:cancel', absPath),
  pinPrepared: (paths) => ipcRenderer.invoke('prepare:pin', paths),
  cacheInfo: () => ipcRenderer.invoke('prepare:cacheInfo'),
  clearPrepared: () => ipcRenderer.invoke('prepare:clearCache'),

  /**
   * Conversion progress. Returns its own unsubscribe rather than exposing
   * ipcRenderer.off, so the renderer cannot detach listeners it does not own.
   */
  onPrepareProgress: (handler) => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on('prepare:progress', listener);
    return () => ipcRenderer.removeListener('prepare:progress', listener);
  },
});
