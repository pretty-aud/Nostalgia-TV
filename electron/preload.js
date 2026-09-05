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

  ingestStatus: (items) => ipcRenderer.invoke('ingest:status', items),
  ingestRun: (items) => ipcRenderer.invoke('ingest:run', items),
  onIngestProgress: (handler) => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on('ingest:progress', listener);
    return () => ipcRenderer.removeListener('ingest:progress', listener);
  },
  ingestEntries: () => ipcRenderer.invoke('ingest:entries'),
  artworkStats: (items) => ipcRenderer.invoke('artwork:stats', items),
  getArtwork: (kind, id) => ipcRenderer.invoke('artwork:get', kind, id),
  chooseArtwork: (kind, id) => ipcRenderer.invoke('artwork:choose', kind, id),
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


  /**
   * What is left of the ffmpeg surface.
   *
   * Ten verbs went with the switchover — capabilities, playbackVerdict,
   * savePlaybackVerdict, inspect, ensurePlayable, listTracks, subtitleText,
   * cancelPrepare, pinPrepared and onPrepareProgress. mpv decodes everything
   * and reports its own tracks, so none of them had a caller any more; they
   * were exposed with live handlers behind them for a whole branch, and
   * `ensurePlayable` would still have started a full conversion for anything
   * that asked. An exposed verb nothing calls is not free — it is reachable.
   *
   * These three have real callers: the auto-crop measurement, and the pair
   * that lets her see and clear what the OLD conversion cache still costs on
   * disk.
   */
  detectCrop: (absPath, options) => ipcRenderer.invoke('prepare:crop', absPath, options),
  cacheInfo: () => ipcRenderer.invoke('prepare:cacheInfo'),
  cleanupPrepared: () => ipcRenderer.invoke('prepare:cleanup'),

  // --- the mpv player (mpv-player branch) ----------------------------------
  // Typed verbs, not a raw command pipe: each one is validated in
  // electron/mpvHost.js the way every prepare:* handler validates its own.
  mpvOpen: (absPath, options) => ipcRenderer.invoke('mpv:open', absPath, options),
  mpvStop: () => ipcRenderer.invoke('mpv:stop'),
  mpvSetPause: (value) => ipcRenderer.invoke('mpv:setPause', value),
  mpvSeek: (seconds) => ipcRenderer.invoke('mpv:seek', seconds),
  mpvSetVolume: (level) => ipcRenderer.invoke('mpv:setVolume', level),
  mpvSetMute: (value) => ipcRenderer.invoke('mpv:setMute', value),
  mpvSetAudioTrack: (id) => ipcRenderer.invoke('mpv:setAudioTrack', id),
  mpvSetSubTrack: (id) => ipcRenderer.invoke('mpv:setSubTrack', id),
  mpvTrackList: () => ipcRenderer.invoke('mpv:trackList'),
  mpvSetSubStyle: (properties) => ipcRenderer.invoke('mpv:setSubStyle', properties),
  mpvSetSubVisibility: (visible) => ipcRenderer.invoke('mpv:setSubVisibility', visible),
  mpvSetVideoCrop: (spec) => ipcRenderer.invoke('mpv:setVideoCrop', spec),
  mpvSetVideoZoom: (zoom) => ipcRenderer.invoke('mpv:setVideoZoom', zoom),

  onMpvProp: (handler) => {
    const listener = (_event, name, value) => handler(name, value);
    ipcRenderer.on('mpv:prop', listener);
    return () => ipcRenderer.removeListener('mpv:prop', listener);
  },
  onMpvEvent: (handler) => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on('mpv:event', listener);
    return () => ipcRenderer.removeListener('mpv:event', listener);
  },
  onMpvDied: (handler) => {
    const listener = () => handler();
    ipcRenderer.on('mpv:died', listener);
    return () => ipcRenderer.removeListener('mpv:died', listener);
  },
  onMpvRestarted: (handler) => {
    const listener = () => handler();
    ipcRenderer.on('mpv:restarted', listener);
    return () => ipcRenderer.removeListener('mpv:restarted', listener);
  },
  onMpvDown: (handler) => {
    const listener = (_event, info) => handler(info);
    ipcRenderer.on('mpv:down', listener);
    return () => ipcRenderer.removeListener('mpv:down', listener);
  },
});
