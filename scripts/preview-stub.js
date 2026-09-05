/* Fake Electron bridge, for looking at the UI in a browser. Design only. */
(() => {
  window.__tvCalls = { saveState: 0, saveStatus: 0 };
  const shows = [
    { name: 'Scavengers Reign', count: 12 },
    { name: 'Men in Black', count: 26 },
    { name: 'SamuraiX', count: 24 },
    { name: 'Night Raid 1931', count: 13 },
    { name: 'The Office', count: 22 },
  ].map((s) => {
    const id = s.name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    return {
      id,
      name: s.name,
      episodeCount: s.count,
      needsReview: false,
      episodes: Array.from({ length: s.count }, (_, i) => ({
        relPath: `${s.name}/S01E${String(i + 1).padStart(2, '0')}.mkv`,
        fileName: `S01E${String(i + 1).padStart(2, '0')}.mkv`,
        absPath: `D:/TV/${s.name}/S01E${String(i + 1).padStart(2, '0')}.mkv`,
        mediaUrl: '',
        showName: s.name,
        season: 1,
        episode: i + 1,
        episodeEnd: i + 1,
        title: ['The Nest', 'Cracked Egg', 'Blossom', 'Low Tide'][i % 4],
        confidence: 'high',
        dated: false,
        index: i,
      })),
    };
  });

  window.tv = {
    pickFolder: async () => null,
    locateLibrary: async (p) => ({ ok: Boolean(p), rootPath: p, moved: false }),
    // The real library when the server was pointed at one — the fixture below
    // cannot reproduce anything that depends on the viewer's actual files.
    scan: async () => (window.__PREVIEW_LIBRARY__ || {
      ok: true,
      rootPath: 'D:/TVandFilms',
      shows,
      bumpers: [{ relPath: 'BUMPERS/a.mp4', fileName: 'a.mp4', name: 'a', absPath: 'D:/TV/BUMPERS/a.mp4', mediaUrl: '' }],
      promos: [
        { relPath: 'PROMOS/p1.mp4', fileName: 'p1.mp4', name: 'p1', absPath: 'D:/TV/PROMOS/p1.mp4', mediaUrl: '' },
        { relPath: 'PROMOS/p2.mp4', fileName: 'p2.mp4', name: 'p2', absPath: 'D:/TV/PROMOS/p2.mp4', mediaUrl: '' },
      ],
      movies: [
        { relPath: 'MOVIES/Blade Runner.mkv', fileName: 'Blade Runner.mkv', name: 'Blade Runner', year: 1982, absPath: 'D:/TV/MOVIES/Blade Runner.mkv', mediaUrl: '' },
        { relPath: 'MOVIES/Akira.mkv', fileName: 'Akira.mkv', name: 'Akira', year: 1988, absPath: 'D:/TV/MOVIES/Akira.mkv', mediaUrl: '' },
        { relPath: 'MOVIES/The Thing.mkv', fileName: 'The Thing.mkv', name: 'The Thing', year: 1982, absPath: 'D:/TV/MOVIES/The Thing.mkv', mediaUrl: '' },
      ],
      presentations: [
        { relPath: 'MOVIE PRESENTATION/feature.mp4', fileName: 'feature.mp4', name: 'feature', absPath: 'D:/TV/MOVIE PRESENTATION/feature.mp4', mediaUrl: '' },
      ],
      skipped: [],
      stats: { showCount: shows.length, episodeCount: 97, bumperCount: 1, promoCount: 2, movieCount: 3, presentationCount: 1, skippedCount: 0 },
    }),

    /**
     * The REAL saved state when the server was given one, otherwise a blank.
     *
     * A canned state has whatever shape I imagined, and boot() branches on the
     * shape of the file that actually exists — settings written by older
     * versions, cursors with no anchor, values no current control can produce.
     * Those branches only ever run against the real file.
     */
    loadState: async () => (window.__PREVIEW_STATE__
      || { version: 1, rootPath: 'D:/TVandFilms', cursors: {}, queue: [], deck: [], history: [] }),
    // Counted so a test can assert what the REAL boot path did, rather than
    // what it looks like it should have done from reading the source.
    saveState: async () => { window.__tvCalls.saveState += 1; return { ok: true }; },
    saveStatus: async () => { window.__tvCalls.saveStatus += 1; return { ok: true }; },

    // Kept in memory so the checkpoint round trip can be exercised here.
    manualSave: async (state) => {
      window.__manualSlot = { savedAt: Date.now(), state: JSON.parse(JSON.stringify(state)) };
      return { ok: true, savedAt: window.__manualSlot.savedAt };
    },
    manualLoad: async () => (window.__manualSlot
      ? { ok: true, savedAt: window.__manualSlot.savedAt, state: window.__manualSlot.state }
      : { ok: false, error: 'no checkpoint has been made yet' }),
    manualInfo: async () => (window.__manualSlot
      ? { exists: true, savedAt: window.__manualSlot.savedAt, shows: Object.keys(window.__manualSlot.state.cursors || {}).length }
      : { exists: false, savedAt: null, shows: 0 }),
    // Served from the app's real cache by preview-server, so a gallery can be
    // reviewed with the artwork it will actually have. Returns null for
    // anything not cached, which is what the renderer expects anyway.
    getThumb: async (absPath) => {
      try {
        const res = await fetch(`/preview-thumb?p=${encodeURIComponent(absPath)}`);
        if (!res.ok) return null;
        const blob = await res.blob();
        return await new Promise((resolve) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result);
          reader.onerror = () => resolve(null);
          reader.readAsDataURL(blob);
        });
      } catch { return null; }
    },
    putThumb: async () => ({ ok: true }),
    setFullscreen: async () => false,
    ingestStatus: async () => ({ newCount: 0, newShows: 0, newEpisodes: 0, newMovies: 0 }),
    ingestRun: async () => ({ ok: true, ingested: 0, captured: 0, needConversion: 0, shows: 0, episodes: 0, movies: 0 }),
    onIngestProgress: () => () => {},
    artworkStats: async (items) => (items || []).map(() => false),
    getArtwork: async () => null,
    chooseArtwork: async () => ({ ok: false, cancelled: true }),

    /**
     * The window verbs and the crop probe. A browser has no window to
     * minimise and no ffmpeg to ask, so these are inert — but the renderer
     * subscribes to onWindowState during boot and wires the buttons to the
     * rest, so their ABSENCE is what would break the page.
     */
    minimizeWindow: () => {},
    toggleMaximizeWindow: () => {},
    closeWindow: () => {},
    onWindowState: () => () => {},
    detectCrop: async () => null,

    /**
     * The mpv surface. Not optional, and not decoration.
     *
     * The renderer builds its player at MODULE SCOPE — `createMpvFacade(
     * window.tv)` — and that call immediately subscribes to all five onMpv*
     * feeds. Without them the very first line of the bundle throws, the whole
     * renderer never boots, and this page renders blank. Which is exactly
     * what it did: the switchover added the facade and nobody taught the
     * stub about it, so every design screenshot silently became a picture of
     * nothing, and shoot-all/shoot-state kept "succeeding".
     *
     * The subscribe verbs must return an unsubscribe function, because that
     * is what the real preload returns and what the facade stores.
     */
    onMpvProp: () => () => {},
    onMpvEvent: () => () => {},
    onMpvDied: () => () => {},
    onMpvRestarted: () => () => {},
    onMpvDown: () => () => {},

    // The command verbs. Design work never drives real playback, so these are
    // inert — but they must EXIST, for the same reason as above.
    mpvOpen: async () => ({ ok: true }),
    mpvSetPause: async () => ({ ok: true }),
    mpvStop: async () => ({ ok: true }),
    mpvSeek: async () => ({ ok: true }),
    mpvSetVolume: async () => ({ ok: true }),
    mpvSetMute: async () => ({ ok: true }),
    mpvSetAudioTrack: async () => ({ ok: true }),
    mpvSetSubTrack: async () => ({ ok: true }),
    mpvSetSubVisibility: async () => ({ ok: true }),
    mpvSetSubStyle: async () => ({ ok: true }),
    mpvSetVideoCrop: async () => ({ ok: true }),
    mpvSetVideoZoom: async () => ({ ok: true }),
    mpvTrackList: async () => ([]),
  };

  // Open whichever surface the query string asks for, once boot has settled.
  const want = new URL(location.href).searchParams.get('open');
  window.addEventListener('load', () => {
    setTimeout(() => {
      if (want === 'settings') document.getElementById('btnSettings').click();
      if (want === 'movies') {
        document.getElementById('btnSettings').click();
        setTimeout(() => document.getElementById('movieGroup').scrollIntoView({ block: 'start' }), 250);
      }
      if (want === 'player') {
        // Force the transport into view without needing real media, so the
        // player chrome can be looked at on its own.
        const app = document.getElementById('app');
        app.dataset.view = 'playing';
        app.dataset.chrome = 'on';
        document.getElementById('npShow').textContent = 'Cowboy Bebop';
        document.getElementById('npCode').textContent = 'S01E05';
        document.getElementById('npTitle').textContent = 'Ballad of Fallen Angels';
        document.getElementById('timeLabel').textContent = '12:04 / 24:31';
        document.getElementById('chromeUpNext').textContent = 'Next: Trigun S01E04';
        document.getElementById('scrubFill').style.width = '49%';
      }
    }, 400);
  });
})();
