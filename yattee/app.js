'use strict';

(() => {
  const STORAGE_KEY = 'yattee-tesla.connection.v1';
  const BOOKMARK_KEY = 'yattee-tesla.bookmarks.v1';
  const BOOKMARK_CACHE_PREFIX = 'yattee-tesla.bookmarks.v2:';
  const STANDARD_PLAYER_KEY = 'yattee-tesla.standard-player.v1';
  const BOOKMARK_LIMIT = 100;
  const DEFAULT_SERVER = 'https://yattee.vpmbd45g3cfj.opentunnel.xyz';

  // The standard player is a per-browser preference only: it is never sent
  // to the server. Absent means off.
  function useStandardPlayer() {
    try {
      return localStorage.getItem(STANDARD_PLAYER_KEY) === '1';
    } catch (err) {
      return false;
    }
  }

  function setStandardPlayerEnabled(on) {
    try {
      localStorage.setItem(STANDARD_PLAYER_KEY, on ? '1' : '0');
    } catch (err) {}
  }

  const els = {
    homeBtn: document.getElementById('homeBtn'),
    bookmarksBtn: document.getElementById('bookmarksBtn'),
    bookmarksShelf: document.getElementById('bookmarksShelf'),
    bookmarksShelfCount: document.getElementById('bookmarksShelfCount'),
    bookmarksShelfRow: document.getElementById('bookmarksShelfRow'),
    settingsBtn: document.getElementById('settingsBtn'),
    searchForm: document.getElementById('searchForm'),
    searchInput: document.getElementById('searchInput'),
    searchClear: document.getElementById('searchClear'),
    browseView: document.getElementById('browseView'),
    browseKicker: document.getElementById('browseKicker'),
    browseTitle: document.getElementById('browseTitle'),
    browseCount: document.getElementById('browseCount'),
    browseStatus: document.getElementById('browseStatus'),
    resultsGrid: document.getElementById('resultsGrid'),
    moreBtn: document.getElementById('moreBtn'),
    emptyState: document.getElementById('emptyState'),
    emptyConnectBtn: document.getElementById('emptyConnectBtn'),
    watchView: document.getElementById('watchView'),
    backBtn: document.getElementById('backBtn'),
    bookmarkBtn: document.getElementById('bookmarkBtn'),
    refreshBtn: document.getElementById('refreshBtn'),
    muteBtn: document.getElementById('muteBtn'),
    repeatBtn: document.getElementById('repeatBtn'),
    speedBtn: document.getElementById('speedBtn'),
    speedLabel: document.getElementById('speedLabel'),
    playerStage: document.getElementById('playerStage'),
    playerCanvas: document.getElementById('playerCanvas'),
    standardVideo: document.getElementById('standardVideo'),
    standardAudio: document.getElementById('standardAudio'),
    standardPlayerInput: document.getElementById('standardPlayerInput'),
    playerOverlay: document.getElementById('playerOverlay'),
    overlayText: document.getElementById('overlayText'),
    engineBadge: document.getElementById('engineBadge'),
    timeline: document.getElementById('timeline'),
    timelineTrack: document.getElementById('timelineTrack'),
    timelinePlayed: document.getElementById('timelinePlayed'),
    timelineThumb: document.getElementById('timelineThumb'),
    timelineLive: document.getElementById('timelineLive'),
    timelineCurrent: document.getElementById('timelineCurrent'),
    timelinePlayBtn: document.getElementById('timelinePlayBtn'),
    skipBackBtn: document.getElementById('skipBackBtn'),
    skipFwdBtn: document.getElementById('skipFwdBtn'),
    timelineDuration: document.getElementById('timelineDuration'),
    watchTitle: document.getElementById('watchTitle'),
    watchMeta: document.getElementById('watchMeta'),
    watchDescription: document.getElementById('watchDescription'),
    descMoreBtn: document.getElementById('descMoreBtn'),
    settingsModal: document.getElementById('settingsModal'),
    settingsForm: document.getElementById('settingsForm'),
    serverInput: document.getElementById('serverInput'),
    usernameInput: document.getElementById('usernameInput'),
    passwordInput: document.getElementById('passwordInput'),
    rememberInput: document.getElementById('rememberInput'),
    settingsError: document.getElementById('settingsError'),
    engineSupport: document.getElementById('engineSupport'),
    connectBtn: document.getElementById('connectBtn'),
    clearBtn: document.getElementById('clearBtn'),
    closeSettingsBtn: document.getElementById('closeSettingsBtn'),
    bookmarkConfirm: document.getElementById('bookmarkConfirm'),
    bookmarkConfirmText: document.getElementById('bookmarkConfirmText'),
    confirmRemoveBookmarkBtn: document.getElementById('confirmRemoveBookmarkBtn'),
    cancelRemoveBookmarkBtn: document.getElementById('cancelRemoveBookmarkBtn'),
    closeBookmarkConfirmBtn: document.getElementById('closeBookmarkConfirmBtn'),
    toast: document.getElementById('toast')
  };

  const state = {
    creds: null,
    mode: null,
    browseMode: 'trending',
    query: '',
    page: 0,
    results: [],
    searchToken: 0,
    searchAbort: null,
    playToken: 0,
    playAbort: null,
    current: null,
    currentId: '',
    currentUrl: '',
    streamUrl: null,
    engine: null,
    engineReady: false,
    engineFailed: false,
    muted: false,
    speed: 1,
    repeat: false,
    loadingMore: false,
    engineSource: null,
    timelineHideTimer: 0,
    timelineLastTap: 0,
    timelineDragging: false,
    timelinePreview: null,
    timelinePreviewAt: 0,
    timelineDuration: 0,
    timelinePosition: 0,
    timelineSeekable: false,
    timelinePaused: false,
    stallDrawn: -1,
    stallDrawnAt: 0,
    stallStartAt: 0,
    restartCount: 0,
    restartAt: 0,
    restartTimer: 0,
    restartDrawn: -1,
    restartPosition: 0,
    bookmarkRevision: 0,
    toastTimer: 0,
    settingsReturnFocus: null
  };

  const compactNumber = (() => {
    try {
      return new Intl.NumberFormat(undefined, {
        notation: 'compact',
        maximumFractionDigits: 1
      });
    } catch (err) {
      return null;
    }
  })();

  class RequestError extends Error {
    constructor(message, code) {
      super(message);
      this.name = 'RequestError';
      this.code = code || 'request';
    }
  }

  class AuthError extends RequestError {
    constructor(message) {
      super(message || 'The server rejected these credentials.', 'auth');
      this.name = 'AuthError';
    }
  }

  function base64Utf8(value) {
    const bytes = new TextEncoder().encode(value);
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
  }

  function authHeader() {
    if (!state.creds) return '';
    if (!state.creds.username && !state.creds.password) return '';
    return 'Basic ' + base64Utf8(state.creds.username + ':' + state.creds.password);
  }

  function networkHelp() {
    const origin = location.origin === 'null' ? 'this page origin' : location.origin;
    return 'Could not reach the Yattee server. Check the URL, HTTPS, and that the server CORS_ORIGINS includes ' + origin + '.';
  }

  async function api(path, options = {}) {
    if (!state.creds) {
      throw new RequestError('Connect your Yattee server first.', 'config');
    }

    const headers = { Accept: 'application/json' };
    const authorization = authHeader();
    if (authorization) headers.Authorization = authorization;

    const request = {
      method: options.method || 'GET',
      headers,
      cache: 'no-store',
      mode: 'cors',
      signal: options.signal
    };
    if (options.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      request.body = options.body;
    }

    let response;
    try {
      response = await fetch(state.creds.base + path, request);
    } catch (err) {
      if (err && err.name === 'AbortError') throw err;
      throw new RequestError(networkHelp(), 'network');
    }

    if (response.status === 401) {
      throw new AuthError('The Yattee server rejected those credentials.');
    }

    if (response.status === 429) {
      throw new RequestError('The server is rate-limiting right now (HTTP 429). Wait a moment and try again.', 'rate');
    }

    let text = '';
    try {
      text = await response.text();
    } catch (err) {
      if (err && err.name === 'AbortError') throw err;
      throw new RequestError(networkHelp(), 'network');
    }

    if (!response.ok) {
      let detail = '';
      try {
        const parsed = JSON.parse(text);
        detail = parsed.detail || parsed.error || parsed.message || '';
      } catch (err) {
        detail = text.slice(0, 300);
      }
      if (detail && typeof detail !== 'string') detail = JSON.stringify(detail);
      throw new RequestError(detail || 'Server returned HTTP ' + response.status, 'http');
    }

    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch (err) {
      throw new RequestError('The server returned an unexpected response. Is this a Yattee server?', 'parse');
    }
  }

  function normalizeServer(value) {
    let text = String(value || '').trim();
    if (!text) throw new Error('Enter your Yattee server URL.');

    if (!/^[a-z][a-z0-9+.-]*:/i.test(text)) {
      text = (location.protocol === 'https:' ? 'https://' : 'http://') + text;
    }

    let url;
    try {
      url = new URL(text);
    } catch (err) {
      throw new Error('That server URL is not valid.');
    }

    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error('The server URL must start with http:// or https://.');
    }
    if (!url.hostname) throw new Error('The server URL needs a host name.');
    if (url.username || url.password) {
      throw new Error('Put the username and password in their own fields, not in the URL.');
    }

    url.hash = '';
    url.search = '';
    const base = url.href.replace(/\/+$/, '');

    if (
      location.protocol === 'https:' &&
      url.protocol === 'http:' &&
      !['localhost', '127.0.0.1', '::1'].includes(url.hostname)
    ) {
      throw new Error('This page is HTTPS. Use an HTTPS Yattee server URL to avoid mixed-content blocking.');
    }

    return base;
  }

  function validateStoredBase(base) {
    try {
      const url = new URL(base);
      if (
        location.protocol === 'https:' &&
        url.protocol === 'http:' &&
        !['localhost', '127.0.0.1', '::1'].includes(url.hostname)
      ) {
        return 'The saved server uses HTTP on an HTTPS page. Use an HTTPS server URL.';
      }
    } catch (err) {
      return 'The saved server URL is invalid. Enter it again.';
    }
    return '';
  }

  function readSavedCredentials() {
    let raw = null;
    let remember = true;
    try {
      raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) {
        raw = sessionStorage.getItem(STORAGE_KEY);
        remember = false;
      }
    } catch (err) {
      return null;
    }
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed.base !== 'string' || !parsed.base) return null;
      return {
        base: parsed.base,
        username: typeof parsed.username === 'string' ? parsed.username : '',
        password: typeof parsed.password === 'string' ? parsed.password : '',
        remember
      };
    } catch (err) {
      return null;
    }
  }

  function saveCredentials(creds, remember) {
    const payload = JSON.stringify({
      base: creds.base,
      username: creds.username,
      password: creds.password
    });
    try {
      localStorage.removeItem(STORAGE_KEY);
      sessionStorage.removeItem(STORAGE_KEY);
      (remember ? localStorage : sessionStorage).setItem(STORAGE_KEY, payload);
      return true;
    } catch (err) {
      return false;
    }
  }

  function forgetCredentials() {
    try {
      localStorage.removeItem(STORAGE_KEY);
      sessionStorage.removeItem(STORAGE_KEY);
    } catch (err) {}
  }

  function hasSavedCredentials() {
    try {
      return !!(localStorage.getItem(STORAGE_KEY) || sessionStorage.getItem(STORAGE_KEY));
    } catch (err) {
      return false;
    }
  }

  // Bookmarks are stored on the connected Yattee server, one list per user.
  // localStorage is only a cache scoped to that server + username, so
  // switching servers never shows another server's saved videos.
  function bookmarkCacheKey() {
    const creds = state.creds;
    if (!creds || !creds.base) return '';
    return BOOKMARK_CACHE_PREFIX + creds.base + ':' + (creds.username || '');
  }

  function bookmarkDirtyKey() {
    const key = bookmarkCacheKey();
    return key ? key + ':dirty' : '';
  }

  function readBookmarks() {
    const key = bookmarkCacheKey();
    if (!key) return [];
    let raw = null;
    try {
      raw = localStorage.getItem(key);
      if (raw == null) {
        // A list from the local-only build follows the first server this
        // profile connects to; the dirty flag uploads it on the next sync.
        const legacy = localStorage.getItem(BOOKMARK_KEY);
        if (legacy != null) {
          localStorage.setItem(key, legacy);
          localStorage.removeItem(BOOKMARK_KEY);
          localStorage.setItem(key + ':dirty', '1');
          raw = legacy;
        }
      }
    } catch (err) {
      return [];
    }
    if (!raw) return [];
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      return [];
    }
    if (!Array.isArray(parsed)) return [];
    const seen = new Set();
    const items = [];
    for (const entry of parsed) {
      if (!entry || typeof entry.videoId !== 'string' || !entry.videoId) continue;
      if (seen.has(entry.videoId)) continue;
      seen.add(entry.videoId);
      items.push(entry);
    }
    return items;
  }

  function writeBookmarks(items) {
    const key = bookmarkCacheKey();
    if (!key) return false;
    try {
      localStorage.setItem(key, JSON.stringify(items.slice(0, BOOKMARK_LIMIT)));
      return true;
    } catch (err) {
      return false;
    }
  }

  function bookmarksAreDirty() {
    const key = bookmarkDirtyKey();
    if (!key) return false;
    try {
      return localStorage.getItem(key) === '1';
    } catch (err) {
      return false;
    }
  }

  function markBookmarksDirty(dirty) {
    const key = bookmarkDirtyKey();
    if (!key) return;
    try {
      if (dirty) localStorage.setItem(key, '1');
      else localStorage.removeItem(key);
    } catch (err) {}
  }

  function currentVideoId() {
    const data = state.current;
    if (data) {
      if (typeof data.videoId === 'string' && data.videoId) return data.videoId;
      if (typeof data.video_id === 'string' && data.video_id) return data.video_id;
    }
    return state.currentId || '';
  }

  function bookmarkedItem(id) {
    if (!id) return null;
    return readBookmarks().find((entry) => entry.videoId === id) || null;
  }
  function engineIsReady() {
    if (!window.TeslaEngine || !window.TeslaPlayer) return false;
    if (!window.isSecureContext) return false;
    try {
      return window.TeslaEngine.missingLibs(true).length === 0;
    } catch (err) {
      return false;
    }
  }

  function updateEngineSupport() {
    state.engineReady = engineIsReady();
    els.engineSupport.replaceChildren();

    if (useStandardPlayer()) {
      // The standard player does not need the engine at all.
      els.engineSupport.hidden = true;
      els.engineSupport.classList.remove('ok', 'warn');
      return;
    }

    if (state.engineReady) {
      els.engineSupport.hidden = true;
      els.engineSupport.classList.remove('ok', 'warn');
      return;
    }

    const strong = document.createElement('strong');
    strong.textContent = 'Tesla Engine unavailable.';
    const missing = [];
    if (window.TeslaEngine && window.TeslaPlayer) {
      try {
        missing.push(...window.TeslaEngine.missingLibs(true));
      } catch (err) {}
    } else {
      missing.push('tesla-engine.js');
    }
    if (!window.isSecureContext) missing.push('HTTPS / secure context');
    const detail = missing.length ? ' Missing: ' + missing.join(', ') + '.' : '';
    els.engineSupport.append(
      strong,
      document.createTextNode(
        ' Playback is unavailable without it.' + detail + ' Tesla Engine needs HTTPS and WebCodecs.'
      )
    );
    els.engineSupport.hidden = false;
    els.engineSupport.classList.add('warn');
  }

  function getEngine() {
    if (state.engine) return state.engine;
    if (!engineIsReady()) return null;
    try {
      state.engine = new window.TeslaPlayer({
        canvas: els.playerCanvas,
        maxWidth: 1920,
        gain: 1.35,
        muted: state.muted
      });
    } catch (err) {
      state.engineReady = false;
      updateEngineSupport();
      return null;
    }

    state.engine.on('state', (snapshot) => {
      if (state.mode !== 'engine') return;
      updateEngineBadge(snapshot);
      updateTimeline(snapshot);
      watchForStall(snapshot);
    });
    state.engine.on('firstframe', () => {
      if (state.mode !== 'engine') return;
      hideOverlay();
      showTimeline();
    });
    state.engine.on('fail', (message) => {
      if (state.mode !== 'engine') return;
      if (state.restartCount < MAX_AUTO_RESTARTS) {
        autoRestart('Still loading...');
      } else {
        engineFailed(message);
      }
    });
    return state.engine;
  }

  function unlockEngine() {
    const player = getEngine();
    if (!player) return;
    try {
      const result = player.unlock();
      if (result && result.catch) result.catch(() => {});
    } catch (err) {}
  }

  function updateEngineBadge(snapshot) {
    if (!snapshot) return;
    const bits = [];
    if (snapshot.stage === 'live' || snapshot.stage === 'vod') {
      if (snapshot.height) bits.push(snapshot.height + 'p');
      if (snapshot.fps) bits.push(Math.round(snapshot.fps) + ' fps');
    } else if (snapshot.stage === 'error') {
      bits.push('error');
    }
    if (snapshot.drops > 10) bits.push(snapshot.drops + ' dropped');
    if (!bits.length) {
      els.engineBadge.textContent = '';
      els.engineBadge.hidden = true;
      return;
    }
    els.engineBadge.textContent = bits.join(' · ');
    els.engineBadge.hidden = false;
  }

  // A live stream can stop delivering frames without ever reporting an error:
  // the decoder runs dry, the picture freezes and nothing else happens. Reopen
  // the stream when drawing stops for long enough to be sure it is stuck, or
  // when a load never reaches its first frame. A small budget stops a stream
  // that is simply broken from restarting forever.
  const STALL_MS = 7000;
  const START_STALL_MS = 25000;
  const MAX_AUTO_RESTARTS = 5;
  const RESTART_BUDGET_RESET_MS = 120000;

  function watchForStall(snapshot) {
    const now = Date.now();
    if (!snapshot || !snapshot.stage || snapshot.stage === 'idle' || snapshot.stage === 'error') return;
    if (snapshot.ended) return;
    if (snapshot.paused) return;
    if (snapshot.stage === 'starting') {
      if (!state.stallStartAt) state.stallStartAt = now;
      else if (now - state.stallStartAt > START_STALL_MS) autoRestart('Stream took too long, reconnecting...');
      return;
    }
    state.stallStartAt = 0;
    if (snapshot.stage === 'vod') {
      const duration = snapshot.duration || 0;
      if (duration > 0 && (snapshot.position || 0) >= duration - 1) return;
    }
    const drawn = snapshot.drawn || 0;
    if (drawn !== state.stallDrawn) {
      state.stallDrawn = drawn;
      state.stallDrawnAt = now;
      if (state.restartCount && now - state.restartAt > RESTART_BUDGET_RESET_MS) state.restartCount = 0;
      return;
    }
    if (!state.stallDrawnAt) { state.stallDrawnAt = now; return; }
    if (now - state.stallDrawnAt < STALL_MS) return;
    autoRestart('Stream stalled, reconnecting...');
  }

  function cancelReconnect() {
    if (state.restartTimer) {
      clearTimeout(state.restartTimer);
      state.restartTimer = 0;
    }
  }

  function autoRestart(message) {
    if (state.mode !== 'engine' || state.engineFailed || !state.engine || !state.engineSource || !state.streamUrl) return;
    if (state.restartTimer) return;
    if (state.restartCount >= MAX_AUTO_RESTARTS) {
      engineFailed('The stream keeps stalling. Try another video.');
      return;
    }
    state.restartCount += 1;
    state.restartAt = Date.now();
    let drawn = -1;
    try {
      const snapshot = state.engine.state();
      if (snapshot) drawn = snapshot.drawn || 0;
    } catch (err) {}
    state.restartDrawn = drawn;
    state.restartPosition = state.timelinePosition || 0;
    state.stallDrawn = -1;
    state.stallDrawnAt = Date.now();
    state.stallStartAt = 0;
    showLoading(message || 'Still loading...');
    // Give the edge a moment to cool down instead of immediately hammering it
    // with the same signed URL. The delay grows but stays short enough that a
    // transient outage still feels like a hiccup.
    const delay = Math.min(1500 * Math.pow(2, state.restartCount - 1), 8000);
    state.restartTimer = setTimeout(() => {
      state.restartTimer = 0;
      restartStream();
    }, delay);
  }

  async function restartStream() {
    if (state.mode !== 'engine' || state.engineFailed || !state.engine || !state.engineSource) return;
    const token = state.playToken;

    // If the picture came back while we were waiting, don't reopen at all.
    try {
      const snapshot = state.engine.state();
      if (snapshot && snapshot.stage && snapshot.stage !== 'starting' && snapshot.stage !== 'error' &&
          (snapshot.drawn || 0) > state.restartDrawn && (snapshot.drawn || 0) > 0) {
        hideOverlay();
        return;
      }
    } catch (err) {}

    let source = state.engineSource;
    let url = state.streamUrl;
    const id = (state.current && state.current.videoId) || state.currentId || '';
    if (id) {
      const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
      const timer = ctl ? setTimeout(() => { try { ctl.abort(); } catch (err) {} }, 20000) : 0;
      try {
        const data = await api(
          '/api/v1/videos/' + encodeURIComponent(id) + '?proxy=true&proxy_mode=relay',
          ctl ? { signal: ctl.signal } : {}
        );
        if (token !== state.playToken) return;
        const fresh = chooseEngineSource(data);
        if (fresh) {
          source = fresh;
          url = fresh.url;
          state.current = data;
          state.engineSource = fresh;
          state.streamUrl = url;
          state.timelineDuration = fresh.vod ? (Number(data.lengthSeconds) || 0) : 0;
          els.watchTitle.textContent = data.title || els.watchTitle.textContent;
          renderWatchMeta(data.author || '', authorAvatarUrl(data), itemMetaBits(data));
          document.title = (data.title || 'Video') + ' - YouTube';
        }
      } catch (err) {
        if (token !== state.playToken) return;
        if (err instanceof AuthError) {
          engineFailed(err.message);
          return;
        }
        // Fall back to the URL we had; a fresh one is preferable but not
        // required if the API itself is briefly unavailable.
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
    if (token !== state.playToken || state.mode !== 'engine' || state.engineFailed || !state.engine) return;

    const wasPaused = !!state.timelinePaused;
    let startSec = 0;
    if (source.vod && source.kind === 'mp4') {
      const duration = state.timelineDuration || 0;
      startSec = Math.max(0, (state.restartPosition || 0) - 0.5);
      if (duration > 4) startSec = Math.min(startSec, duration - 3);
      if (startSec < 1) startSec = 0;
    }
    try {
      state.engine.setMuted(state.muted);
      state.engine.setRepeat(state.repeat);
      state.engine.open(url, {
        name: (state.current && state.current.title) || '',
        type: source.kind,
        vod: source.vod,
        maxHeight: source.maxHeight || 1080,
        pickedHeight: source.height || 0,
        audioUrl: source.audioUrl || '',
        durationHint: source.vod && state.current
          ? (Number(state.current.lengthSeconds) || 0)
          : 0,
        startSec
      });
      if (wasPaused) {
        try { state.engine.setPaused(true); } catch (err) {}
        updatePlayButton(true);
      }
    } catch (err) {
      engineFailed(err.message || 'Tesla Engine could not play this stream.');
    }
  }

  function resolveUrl(value) {
    if (!value) return '';
    try {
      const root = state.creds ? state.creds.base + '/' : location.href;
      return new URL(value, root).href;
    } catch (err) {
      return value;
    }
  }

  function thumbnailUrl(item) {
    const thumbs = Array.isArray(item && item.videoThumbnails) ? item.videoThumbnails : [];
    const chosen =
      thumbs.find((thumb) => thumb && thumb.quality === 'medium') ||
      thumbs.find((thumb) => thumb && thumb.quality === 'high') ||
      thumbs.find((thumb) => thumb && thumb.quality === 'default') ||
      thumbs.find((thumb) => thumb && thumb.url) ||
      null;
    return chosen && chosen.url ? resolveUrl(chosen.url) : '';
  }

  function formatDuration(seconds) {
    const total = Math.max(0, Math.floor(Number(seconds) || 0));
    if (!total) return '';
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const secs = total % 60;
    if (hours) return hours + ':' + String(minutes).padStart(2, '0') + ':' + String(secs).padStart(2, '0');
    return minutes + ':' + String(secs).padStart(2, '0');
  }

  // Watch-page length reads "11m" / "11m45s", not the clock format used on
  // the thumbnail badges - "11:00" there reads like a start time.
  function formatLength(seconds) {
    const total = Math.max(0, Math.floor(Number(seconds) || 0));
    if (!total) return '';
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const secs = total % 60;
    let out = '';
    if (hours) out += hours + 'h';
    if (minutes) out += minutes + 'm';
    if (secs) out += secs + 's';
    return out;
  }

  function formatCount(value) {
    const number = Number(value);
    if (!Number.isFinite(number) || number <= 0) return '';
    if (compactNumber) return compactNumber.format(number);
    return String(number);
  }

  // "3 years ago" style age. publishedText is preferred when the server sends
  // it; otherwise the unix `published` stamp is rendered here.
  function formatAge(published) {
    const secs = Math.floor(Date.now() / 1000) - Number(published);
    if (!Number.isFinite(secs) || secs < 0) return '';
    const units = [
      [31536000, 'year'],
      [2592000, 'month'],
      [604800, 'week'],
      [86400, 'day'],
      [3600, 'hour'],
      [60, 'minute']
    ];
    for (const [span, name] of units) {
      const n = Math.floor(secs / span);
      if (n >= 1) return n + ' ' + name + (n === 1 ? '' : 's') + ' ago';
    }
    return 'just now';
  }

  function itemMetaBits(item) {
    const bits = [];
    if (item && item.viewCount) bits.push(formatCount(item.viewCount) + ' views');
    const itemAge = item ? (item.publishedText || (item.published ? formatAge(item.published) : '')) : '';
    if (itemAge) bits.push(itemAge);
    return bits;
  }

  function itemMeta(item) {
    const bits = [];
    if (item && item.author) bits.push(item.author);
    return bits.concat(itemMetaBits(item)).join(' · ');
  }

  function authorAvatarUrl(item) {
    const thumbs = Array.isArray(item && item.authorThumbnails) ? item.authorThumbnails : [];
    const usable = thumbs.filter((thumb) => thumb && thumb.url);
    if (!usable.length) return '';
    const sorted = usable.slice().sort((a, b) => (Number(a.width) || 0) - (Number(b.width) || 0));
    const chosen = sorted.find((thumb) => (Number(thumb.width) || 0) >= 24) || sorted[0];
    return chosen && chosen.url ? resolveUrl(chosen.url) : '';
  }

  // The channel name is a button: tapping it on the watch page searches for
  // that channel, the way the name behaves on YouTube's own watch pages.
  // The avatar rides inside the button so it is tappable with the name.
  function renderWatchMeta(author, avatar, bits) {
    els.watchMeta.replaceChildren();
    if (author) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'watch-author';
      if (avatar) {
        const img = document.createElement('img');
        img.className = 'watch-avatar';
        img.src = avatar;
        img.alt = '';
        img.loading = 'lazy';
        img.decoding = 'async';
        img.referrerPolicy = 'no-referrer';
        img.addEventListener('error', () => img.remove(), { once: true });
        btn.append(img);
      }
      btn.append(document.createTextNode(author));
      btn.addEventListener('click', () => {
        leaveWatch();
        runSearch(author);
      });
      els.watchMeta.append(btn);
      if (bits.length) els.watchMeta.append(document.createTextNode(' · '));
    }
    els.watchMeta.append(document.createTextNode(bits.join(' · ')));
  }

  function normalizeItems(payload) {
    const source = Array.isArray(payload)
      ? payload
      : Array.isArray(payload && payload.items)
        ? payload.items
        : [];
    const seen = new Set();
    const items = [];
    for (const entry of source) {
      if (!entry) continue;
      const id = entry.videoId || entry.video_id;
      if (!id || typeof id !== 'string' || seen.has(id)) continue;
      if (entry.type && entry.type !== 'video' && entry.type !== 'videoRenderer') continue;
      seen.add(id);
      items.push(entry);
    }
    return items;
  }

  function setNotice(text, isError) {
    if (!text) {
      els.browseStatus.hidden = true;
      els.browseStatus.textContent = '';
      return;
    }
    els.browseStatus.hidden = false;
    els.browseStatus.textContent = text;
    els.browseStatus.classList.toggle('error', !!isError);
  }

  function updateBrowseCount() {
    const count = state.results.length;
    els.browseCount.textContent = count ? count + (count === 1 ? ' video' : ' videos') : '';
  }

  function renderSkeletons() {
    const fragment = document.createDocumentFragment();
    for (let i = 0; i < 8; i += 1) {
      const card = document.createElement('div');
      card.className = 'skeleton-card';
      const thumb = document.createElement('div');
      thumb.className = 'thumb skeleton-block';
      const line = document.createElement('div');
      line.className = 'skeleton-line skeleton-block';
      const shortLine = document.createElement('div');
      shortLine.className = 'skeleton-line short skeleton-block';
      card.append(thumb, line, shortLine);
      fragment.append(card);
    }
    els.resultsGrid.replaceChildren(fragment);
    els.browseCount.textContent = '';
  }

  function savedVideoIds() {
    const ids = new Set();
    for (const entry of readBookmarks()) ids.add(entry.videoId);
    return ids;
  }

  function buildVideoCard(item, savedIds) {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'video-card';
    card.dataset.videoId = item.videoId;
    if (savedIds && savedIds.has(item.videoId)) card.classList.add('saved');

    const thumb = document.createElement('div');
    thumb.className = 'thumb';
    const thumbUrl = thumbnailUrl(item);
    if (thumbUrl) {
      const img = document.createElement('img');
      img.src = thumbUrl;
      img.alt = '';
      img.loading = 'lazy';
      img.decoding = 'async';
      img.draggable = false;
      img.referrerPolicy = 'no-referrer';
      img.addEventListener('error', () => img.classList.add('is-broken'), { once: true });
      thumb.append(img);
    }

    if (item.liveNow) {
      const live = document.createElement('span');
      live.className = 'live-pill';
      live.textContent = 'Live';
      thumb.append(live);
    } else {
      const duration = formatDuration(item.lengthSeconds);
      if (duration) {
        const badge = document.createElement('span');
        badge.className = 'duration';
        badge.textContent = duration;
        thumb.append(badge);
      }
    }

    const holdBar = document.createElement('span');
    holdBar.className = 'hold-bar';
    thumb.append(holdBar);

    const savedBadge = document.createElement('span');
    savedBadge.className = 'saved-badge';
    savedBadge.setAttribute('aria-hidden', 'true');
    const savedSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    savedSvg.setAttribute('viewBox', '0 0 24 24');
    savedSvg.setAttribute('focusable', 'false');
    const savedPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    savedPath.setAttribute('d', 'M6.5 3.8h11c.6 0 1 .4 1 1v15.6l-6.5-3.9-6.5 3.9V4.8c0-.6.4-1 1-1Z');
    savedPath.setAttribute('fill', 'currentColor');
    savedSvg.append(savedPath);
    savedBadge.append(savedSvg);
    thumb.append(savedBadge);

    const title = document.createElement('span');
    title.className = 'card-title';
    title.textContent = item.title || item.videoId;

    const meta = document.createElement('span');
    meta.className = 'card-meta';
    meta.textContent = itemMeta(item);

    card.append(thumb, title, meta);
    return card;
  }

  function renderResults() {
    const fragment = document.createDocumentFragment();
    const savedIds = savedVideoIds();
    for (const item of state.results) fragment.append(buildVideoCard(item, savedIds));
    els.resultsGrid.replaceChildren(fragment);
    updateBrowseCount();
    syncShelfWidth();
  }

  // The grid columns stretch to fill the row, so the shelf tiles follow the
  // column width that is actually rendered instead of a guessed size.
  function syncShelfWidth() {
    const tracks = getComputedStyle(els.resultsGrid).gridTemplateColumns;
    const first = parseFloat(tracks);
    if (!first || !isFinite(first)) return;
    document.documentElement.style.setProperty('--shelf-width', first + 'px');
  }

  function renderBookmarksShelf() {
    if (state.browseMode !== 'trending') {
      els.bookmarksShelf.hidden = true;
      return;
    }
    const items = readBookmarks();
    if (!items.length) {
      els.bookmarksShelf.hidden = true;
      els.bookmarksShelfRow.replaceChildren();
      els.bookmarksShelfCount.textContent = '';
      return;
    }
    const fragment = document.createDocumentFragment();
    const savedIds = savedVideoIds();
    for (const item of items) fragment.append(buildVideoCard(item, savedIds));
    els.bookmarksShelfRow.replaceChildren(fragment);
    els.bookmarksShelfCount.textContent =
      items.length + (items.length === 1 ? ' saved video' : ' saved videos');
    els.bookmarksShelf.hidden = false;
    syncShelfWidth();
  }

  function setBrowseHeader(kicker, title) {
    els.browseKicker.textContent = kicker;
    els.browseKicker.hidden = !kicker;
    els.browseTitle.textContent = title;
  }

  function showEmptyState() {
    els.bookmarksShelf.hidden = true;
    els.emptyState.hidden = false;
    els.resultsGrid.replaceChildren();
    els.browseCount.textContent = '';
    els.moreBtn.hidden = true;
    setNotice('');
    setBrowseHeader('YouTube', 'Watch');
  }

  async function loadTrending() {
    if (!state.creds) {
      showEmptyState();
      openSettings();
      return;
    }

    const token = ++state.searchToken;
    if (state.searchAbort) state.searchAbort.abort();
    const controller = new AbortController();
    state.searchAbort = controller;

    state.browseMode = 'trending';
    renderBookmarksShelf();
    state.query = '';
    state.page = 0;
    state.results = [];
    state.loadingMore = false;
    els.moreBtn.hidden = true;
    els.emptyState.hidden = true;
    els.searchInput.value = '';
    updateSearchClear();
    setBrowseHeader('YouTube', 'Trending');
    setNotice('');
    renderSkeletons();

    try {
      let payload;
      try {
        payload = await api('/api/v1/trending?region=US', { signal: controller.signal });
      } catch (err) {
        if (
          !err ||
          err.name === 'AbortError' ||
          err instanceof AuthError ||
          err.code === 'network' ||
          err.code === 'config'
        ) {
          throw err;
        }
        payload = await api('/api/v1/popular', { signal: controller.signal });
      }

      if (token !== state.searchToken) return;
      state.results = normalizeItems(payload);
      renderResults();
      if (!state.results.length) {
        setNotice('This server did not return any trending videos. Try searching instead.');
      }
    } catch (err) {
      if (token !== state.searchToken || !err || err.name === 'AbortError') return;
      state.results = [];
      renderResults();
      setNotice(err.message || 'Could not load trending videos.', true);
      if (err instanceof AuthError) openSettings(err.message);
    }
  }

  async function runSearch(query) {
    if (!state.creds) {
      openSettings('Connect your Yattee server first.');
      return;
    }

    const token = ++state.searchToken;
    if (state.searchAbort) state.searchAbort.abort();
    const controller = new AbortController();
    state.searchAbort = controller;

    state.browseMode = 'search';
    renderBookmarksShelf();
    state.query = query;
    state.page = 1;
    state.results = [];
    state.loadingMore = false;
    els.searchInput.value = query;
    updateSearchClear();
    els.emptyState.hidden = true;
    els.moreBtn.hidden = true;
    setBrowseHeader('Search', 'Results');
    setNotice('');
    renderSkeletons();

    try {
      const payload = await api(
        '/api/v1/search?q=' + encodeURIComponent(query) + '&type=video&page=1',
        { signal: controller.signal }
      );
      if (token !== state.searchToken) return;
      state.results = normalizeItems(payload);
      renderResults();
      els.moreBtn.hidden = state.results.length === 0;
      if (!state.results.length) {
        setNotice('No videos found for “' + query + '”.');
      }
    } catch (err) {
      if (token !== state.searchToken || !err || err.name === 'AbortError') return;
      state.results = [];
      renderResults();
      els.moreBtn.hidden = true;
      setNotice(err.message || 'Search failed.', true);
      if (err instanceof AuthError) openSettings(err.message);
    }
  }

  async function loadMoreResults() {
    if (state.browseMode !== 'search' || !state.query || state.loadingMore || !state.creds) return;
    if (!state.searchAbort) return;

    state.loadingMore = true;
    els.moreBtn.disabled = true;
    els.moreBtn.textContent = 'Loading...';
    const nextPage = state.page + 1;
    const token = state.searchToken;
    let exhausted = false;

    try {
      const payload = await api(
        '/api/v1/search?q=' +
          encodeURIComponent(state.query) +
          '&type=video&page=' +
          nextPage,
        { signal: state.searchAbort.signal }
      );
      if (token !== state.searchToken) return;
      const items = normalizeItems(payload);
      if (!items.length) {
        exhausted = true;
        showToast('No more results.');
        return;
      }
      const seen = new Set(state.results.map((item) => item.videoId));
      for (const item of items) {
        if (seen.has(item.videoId)) continue;
        seen.add(item.videoId);
        state.results.push(item);
      }
      state.page = nextPage;
      renderResults();
    } catch (err) {
      if (token !== state.searchToken || !err || err.name === 'AbortError') return;
      showToast(err.message || 'Could not load more results.');
      if (err instanceof AuthError) openSettings(err.message);
    } finally {
      state.loadingMore = false;
      els.moreBtn.disabled = false;
      els.moreBtn.textContent = 'Load more';
      els.moreBtn.hidden = exhausted || state.results.length === 0;
    }
  }

  function startPlaybackSession() {
    const session = ++state.playToken;
    if (state.playAbort) state.playAbort.abort();
    state.playAbort = new AbortController();
    stopPlayer();
    state.mode = 'loading';
    state.current = null;
    state.streamUrl = null;
    state.engineFailed = false;
    state.stallDrawn = -1;
    state.stallDrawnAt = 0;
    state.stallStartAt = 0;
    state.restartCount = 0;
    state.restartAt = 0;
    state.restartDrawn = -1;
    state.restartPosition = 0;
    cancelReconnect();
    if (state.engine) {
      try { state.engine.setPaused(false); } catch (err) {}
    }
    updatePlayButton(false);
    els.playerCanvas.hidden = false;
    els.engineBadge.hidden = true;
    els.muteBtn.hidden = true;
    els.repeatBtn.hidden = true;
    hideTimeline();
    showLoading('Loading video...');
    return { session, signal: state.playAbort.signal };
  }

  function openWatchShell(item, videoId) {
    els.browseView.hidden = true;
    els.watchView.hidden = false;
    els.refreshBtn.hidden = false;
    window.scrollTo(0, 0);
    els.watchTitle.textContent = (item && item.title) || 'Loading...';
    renderWatchMeta((item && item.author) || '', authorAvatarUrl(item), itemMetaBits(item));
    els.engineBadge.textContent = '';
    els.engineBadge.hidden = true;
    els.watchDescription.hidden = true;
    els.watchDescription.textContent = '';
    els.watchDescription.classList.remove('expanded');
    els.descMoreBtn.hidden = true;
    els.descMoreBtn.textContent = 'Show more';
    document.title = ((item && item.title) || 'Video') + ' - YouTube';
    // The bookmark state is known from the id alone, so the button shows up
    // right away instead of waiting for the stream to start.
    syncBookmarkButton(videoId);
    // Mute is always available and repeat only makes sense off a live
    // stream, so both render as soon as the watch view opens.
    els.muteBtn.hidden = false;
    els.repeatBtn.hidden = !!(item && item.liveNow);
    updateMuteButton();
    updateRepeatButton();
  }

  async function openVideoById(id, fallback) {
    if (!state.creds) {
      openSettings('Connect your Yattee server first.');
      return;
    }

    state.currentId = id;
    state.currentUrl = '';
    unlockEngine();
    const { session, signal } = startPlaybackSession();
    openWatchShell(fallback, id);

    try {
      const data = await api(
        '/api/v1/videos/' + encodeURIComponent(id) + '?proxy=true&proxy_mode=relay',
        { signal }
      );
      if (session !== state.playToken) return;
      if (!data || typeof data !== 'object') {
        throw new RequestError('The server did not return video details.');
      }
      state.current = data;
      renderWatchInfo(data, fallback);
      syncBookmarkButton();
      playVideoData(data, session);
    } catch (err) {
      if (session !== state.playToken || !err || err.name === 'AbortError') return;
      if (!(err instanceof AuthError)) {
        // The details endpoint can fail on its own (yt-dlp bot checks on a
        // live broadcast) while /extract still resolves the same watch URL,
        // so retry through the URL path before giving up.
        const retryUrl = 'https://www.youtube.com/watch?v=' + encodeURIComponent(id);
        await openVideoByUrl(retryUrl, { direct: true });
        return;
      }
      showPlaybackError(err.message || 'Could not load this video.');
      openSettings(err.message);
    }
  }

  async function openVideoByUrl(url, options) {
    if (!state.creds) {
      openSettings('Connect your Yattee server first.');
      return;
    }

    // YouTube URLs go through the by-id endpoint first: it can proxy with
    // proxy_mode=relay, which supports Range, so VODs are seekable. The
    // /extract path below stays as the fallback (it re-runs yt-dlp per
    // request and its /proxy/fast/ streams ignore Range).
    const ytId = youtubeVideoId(url);
    if (ytId && !(options && options.direct)) {
      await openVideoById(ytId);
      return;
    }

    state.currentUrl = url;
    state.currentId = '';
    unlockEngine();
    const { session, signal } = startPlaybackSession();
    openWatchShell(null, ytId || '');

    try {
      const data = await api('/api/v1/extract?url=' + encodeURIComponent(url), { signal });
      if (session !== state.playToken) return;
      if (!data || typeof data !== 'object') {
        throw new RequestError('The server did not return video details.');
      }
      state.current = data;
      renderWatchInfo(data, null);
      syncBookmarkButton();
      playVideoData(data, session);
    } catch (err) {
      if (session !== state.playToken || !err || err.name === 'AbortError') return;
      showPlaybackError(err.message || 'Could not load this video.');
      if (err instanceof AuthError) openSettings(err.message);
    }
  }

  function renderWatchInfo(data, fallback) {
    const title = data.title || (fallback && fallback.title) || 'Video';
    const author = data.author || (fallback && fallback.author) || '';
    const bits = [];
    if (data.viewCount) bits.push(formatCount(data.viewCount) + ' views');
    const age = data.publishedText || (data.published ? formatAge(data.published) : '');
    if (age) bits.push(age);
    if (data.liveNow) bits.push('Live');
    if (data.lengthSeconds && !data.liveNow) bits.push(formatLength(data.lengthSeconds));

    els.watchTitle.textContent = title;
    renderWatchMeta(author, authorAvatarUrl(data) || authorAvatarUrl(fallback), bits);

    const description = typeof data.description === 'string' ? data.description.trim() : '';
    if (description) {
      els.watchDescription.textContent = description;
      els.watchDescription.hidden = false;
      els.watchDescription.classList.remove('expanded');
      els.descMoreBtn.textContent = 'Show more';
      // The clamp is CSS; measure after layout to know whether the rest is
      // actually hidden before offering the toggle.
      window.requestAnimationFrame(function () {
        const overflows = els.watchDescription.scrollHeight > els.watchDescription.clientHeight + 4;
        els.descMoreBtn.hidden = !overflows;
      });
    } else {
      els.watchDescription.textContent = '';
      els.watchDescription.hidden = true;
      els.descMoreBtn.hidden = true;
    }

    document.title = title + ' - YouTube';
  }

  function formatHeight(format) {
    let height = Number(format && format.height) || 0;
    if (!height && format && format.resolution) {
      const text = String(format.resolution);
      const match = /(\d+)p/i.exec(text) || /x(\d+)/i.exec(text);
      if (match) height = Number(match[1]);
    }
    if (!height && format && format.quality) {
      const match = /(\d+)p/i.exec(String(format.quality));
      if (match) height = Number(match[1]);
    }
    return height;
  }

  function formatKind(format) {
    if (!format || !format.url) return '';
    const type = String(format.type || '').toLowerCase();
    const container = String(format.container || '').toLowerCase();
    const path = String(format.url).split('?')[0].toLowerCase();
    if (container === 'hls' || type.includes('mpegurl') || path.endsWith('.m3u8')) return 'hls';
    if (container === 'mp4' || type.includes('mp4') || path.endsWith('.mp4')) return 'mp4';
    return '';
  }

  function pickEngineFormat(list, maxHeight) {
    const cap = maxHeight || 1080;
    const usable = list.filter((entry) => entry && entry.format);
    const underCap = usable
      .filter((entry) => entry.height > 0 && entry.height <= cap)
      .sort((a, b) => b.height - a.height);
    if (underCap.length) return underCap[0];
    const known = usable.filter((entry) => entry.height > 0).sort((a, b) => a.height - b.height);
    return known[0] || usable[0] || null;
  }

  // adaptiveFormats entries are video-only or audio-only; the muxed list in
  // formatStreams tops out at 360p on YouTube, so the ladder above it only
  // exists here. Prefer H.264 at the highest rendition (the Tesla browser
  // decodes avc1 everywhere) and pair it with the best MP4 audio file.
  function pickAdaptiveVideo(list, maxHeight) {
    const cap = maxHeight || 1080;
    const usable = (Array.isArray(list) ? list : []).filter((format) => {
      if (!format || !format.url) return false;
      const type = String(format.type || format.mimeType || '').toLowerCase();
      const height = formatHeight(format);
      return type.startsWith('video/') && height > 0 && height <= cap;
    });
    if (!usable.length) return null;
    const score = (format) => {
      const type = String(format.type || format.mimeType || '').toLowerCase();
      const h264 = type.includes('avc1') || type.includes('avc3') ? 1 : 0;
      return { height: formatHeight(format), h264: h264, bitrate: Number(format.bitrate) || 0 };
    };
    const sorted = usable.slice().sort((a, b) => {
      const sa = score(a);
      const sb = score(b);
      return sb.height - sa.height || sb.h264 - sa.h264 || sb.bitrate - sa.bitrate;
    });
    return sorted[0];
  }

  // Dubbed videos carry one adaptive audio format per language. The original
  // track is flagged by the server on audioTrack (isDefault), with "original"
  // baked into displayName for clients that only look at text. Always take an
  // original track when the server marked one; bitrate only ranks inside the
  // chosen pool, so a high-bitrate dub can never outvote the original.
  function isOriginalAudio(format) {
    const track = format && format.audioTrack;
    if (!track) return false;
    if (track.isDefault) return true;
    return /original/i.test(String(track.displayName || ''));
  }

  function pickAdaptiveAudio(list) {
    const usable = (Array.isArray(list) ? list : []).filter((format) => {
      if (!format || !format.url) return false;
      const type = String(format.type || format.mimeType || '').toLowerCase();
      return type.startsWith('audio/') && type.includes('mp4');
    });
    if (!usable.length) return null;
    const originals = usable.filter(isOriginalAudio);
    const pool = originals.length ? originals : usable;
    pool.sort((a, b) => (Number(b.bitrate) || 0) - (Number(a.bitrate) || 0));
    return pool[0];
  }

  // /proxy/fast/ ignores Range, so seeking cannot work through it. The
  // /videos endpoint already hands us /proxy/relay URLs; when a fast URL
  // embeds a direct media target (not a page URL), swap it to relay so the
  // engine's ranged seek path can run.
  function relayMediaUrl(url) {
    if (!url || typeof url !== 'string') return url;
    const marker = '/proxy/fast/';
    const at = url.indexOf(marker);
    if (at === -1) return url;
    try {
      const parsed = new URL(url);
      const target = parsed.searchParams.get('url');
      if (!target || target.indexOf('googlevideo.com') === -1) return url;
      const relay = new URL(url.slice(0, at) + '/proxy/relay');
      relay.searchParams.set('url', target);
      return relay.toString();
    } catch (err) {
      return url;
    }
  }

  function youtubeVideoId(value) {
    if (!value || typeof value !== 'string') return '';
    let parsed;
    try {
      parsed = new URL(value);
    } catch (err) {
      return '';
    }
    const host = parsed.hostname.toLowerCase().replace(/^www\./, '').replace(/^m\./, '');
    if (host === 'youtu.be') return parsed.pathname.split('/').filter(Boolean)[0] || '';
    if (host !== 'youtube.com' && host !== 'music.youtube.com' && host !== 'youtube-nocookie.com') return '';
    if (parsed.pathname === '/watch') return parsed.searchParams.get('v') || '';
    const live = parsed.pathname.match(/^\/(?:live|shorts|embed)\/([A-Za-z0-9_-]{6,})/);
    return live ? live[1] : '';
  }

  function chooseEngineSource(data) {
    if (!data) return null;
    const live = !!data.liveNow;
    const hlsUrl = data.hlsUrl ? resolveUrl(data.hlsUrl) : '';
    const formats = (Array.isArray(data.formatStreams) ? data.formatStreams : [])
      .filter((format) => format && format.url)
      .map((format) => ({ format, height: formatHeight(format), kind: formatKind(format) }))
      .filter((entry) => entry.kind);

    const hlsFormats = formats.filter((entry) => entry.kind === 'hls');
    const mp4Formats = formats.filter((entry) => entry.kind === 'mp4');

    if (live) {
      if (hlsUrl) return { url: hlsUrl, kind: 'hls', vod: false, maxHeight: 1080 };
      const hls = pickEngineFormat(hlsFormats, 1080);
      return hls ? { url: resolveUrl(hls.format.url), kind: 'hls', vod: false, maxHeight: 1080 } : null;
    }

    if (hlsUrl) return { url: hlsUrl, kind: 'hls', vod: true, maxHeight: 1080 };
    // Dual-source VOD: when the adaptive ladder has a rendition above what the
    // muxed list can offer, play the video-only file and feed the audio-only
    // file on the engine's separate audio path.
    const muxed = pickEngineFormat(mp4Formats, 1080);
    const adaptiveVideo = pickAdaptiveVideo(data.adaptiveFormats, 1080);
    const adaptiveAudio = pickAdaptiveAudio(data.adaptiveFormats);
    if (adaptiveVideo && adaptiveAudio) {
      const adaptiveHeight = formatHeight(adaptiveVideo);
      if (!muxed || adaptiveHeight > (muxed.height || 0)) {
        return {
          url: relayMediaUrl(resolveUrl(adaptiveVideo.url)),
          audioUrl: relayMediaUrl(resolveUrl(adaptiveAudio.url)),
          kind: 'mp4',
          vod: true,
          maxHeight: 1080,
          height: adaptiveHeight
        };
      }
    }
    if (muxed) return { url: relayMediaUrl(resolveUrl(muxed.format.url)), kind: 'mp4', vod: true, maxHeight: 1080 };
    const hls = pickEngineFormat(hlsFormats, 1080);
    if (hls) return { url: resolveUrl(hls.format.url), kind: 'hls', vod: true, maxHeight: 1080 };
    return null;
  }

  // A progressive MP4 through the relay opens in any browser; live streams
  // only have HLS, which a standard player can use when the browser supports
  // it natively.
  function chooseStandardSource(data) {
    if (!data) return null;
    const live = !!data.liveNow;
    const formats = (Array.isArray(data.formatStreams) ? data.formatStreams : [])
      .filter((format) => format && format.url)
      .map((format) => ({ format, height: formatHeight(format), kind: formatKind(format) }))
      .filter((entry) => entry.kind);
    if (!live) {
      // YouTube only publishes 1080p as a video-only stream, so a single
      // element would cap out at the muxed 360p/720p file. Take the high
      // quality picture and play the audio from a second element instead.
      const muxed = pickEngineFormat(formats.filter((entry) => entry.kind === 'mp4'), 1080);
      const adaptiveVideo = pickAdaptiveVideo(data.adaptiveFormats, 1080);
      const adaptiveAudio = pickAdaptiveAudio(data.adaptiveFormats);
      if (adaptiveVideo && adaptiveAudio && (!muxed || adaptiveVideo.height > muxed.height)) {
        return {
          url: relayMediaUrl(resolveUrl(adaptiveVideo.url)),
          audioUrl: relayMediaUrl(resolveUrl(adaptiveAudio.url)),
          vod: true,
          height: adaptiveVideo.height
        };
      }
      if (muxed) return { url: relayMediaUrl(resolveUrl(muxed.format.url)), vod: true };
    }
    const hlsUrl = data.hlsUrl ? resolveUrl(data.hlsUrl) : '';
    if (hlsUrl) return { url: hlsUrl, vod: false };
    const hls = pickEngineFormat(formats.filter((entry) => entry.kind === 'hls'), 1080);
    if (hls) return { url: resolveUrl(hls.format.url), vod: false };
    return null;
  }

  function startStandardPlayer(data, session) {
    if (session !== state.playToken) return;
    const source = chooseStandardSource(data);
    if (!source) {
      showPlaybackError('The server returned no stream this player can open.');
      return;
    }

    state.mode = 'standard';
    state.streamUrl = source.url;
    state.engineSource = null;
    state.engineFailed = false;
    state.timelineDuration = source.vod ? (Number(data.lengthSeconds) || 0) : 0;
    state.timelinePosition = 0;
    state.timelinePreview = null;
    state.timelineSeekable = false;
    state.timelinePaused = false;
    hideTimeline();
    els.timelinePlayBtn.classList.remove('paused');
    els.playerCanvas.hidden = true;
    els.standardVideo.hidden = false;
    els.standardVideo.controls = true;
    els.standardVideo.muted = !!state.muted;
    els.standardVideo.volume = 1;
    els.standardVideo.src = source.url;
    // A second element carries the audio when the picture comes from a
    // video-only stream, so the sound still matches the picture.
    if (source.audioUrl) {
      els.standardAudio.hidden = false;
      els.standardAudio.src = source.audioUrl;
      els.standardAudio.muted = !!state.muted;
      els.standardAudio.volume = els.standardVideo.volume;
      try {
        const played = els.standardAudio.play();
        if (played && played.catch) played.catch(() => {});
      } catch (err) {}
    } else {
      els.standardAudio.hidden = true;
    }
    try {
      const played = els.standardVideo.play();
      if (played && played.catch) played.catch(() => {});
    } catch (err) {}
    els.engineBadge.textContent = '';
    els.engineBadge.hidden = true;
    els.muteBtn.hidden = false;
    // A native video loops on its own, so repeat works here as well.
    els.repeatBtn.hidden = !source.vod;
    els.standardVideo.loop = !!state.repeat;
    els.speedBtn.hidden = !source.vod;
    els.standardVideo.playbackRate = state.speed;
    if (els.standardAudio) els.standardAudio.playbackRate = state.speed;
    updateMuteButton();
    updateRepeatButton();
    updateSpeedButton();
  }

  function stopStandardPlayer() {
    const video = els.standardVideo;
    if (!video) return;
    try {
      video.pause();
    } catch (err) {}
    try {
      video.removeAttribute('src');
      video.load();
    } catch (err) {}
    video.hidden = true;
    const audio = els.standardAudio;
    if (audio) {
      try {
        audio.pause();
        audio.removeAttribute('src');
        audio.load();
      } catch (err) {}
      audio.hidden = true;
    }
  }

  function playVideoData(data, session) {
    if (session !== state.playToken) return;
    if (useStandardPlayer()) {
      startStandardPlayer(data, session);
      return;
    }
    if (!state.engineReady) {
      showPlaybackError('Tesla Engine is unavailable. This build needs HTTPS and WebCodecs for all playback.');
      return;
    }

    const source = chooseEngineSource(data);
    if (!source) {
      showPlaybackError('The server returned no Tesla Engine compatible stream.');
      return;
    }
    startEngine(source.url, data, source, session);
  }

  function startEngine(url, data, source, session) {
    if (session !== state.playToken) return;
    const player = getEngine();
    if (!player) {
      showPlaybackError('Tesla Engine is unavailable. This build needs HTTPS and WebCodecs for all playback.');
      return;
    }

    state.mode = 'engine';
    state.streamUrl = url;
    state.engineSource = source;
    if (state.speed !== 1) {
      // If the browser cannot take the sound (a live stream has no separate
      // audio track to hand it), the engine keeps its own.
      if (!startEngineAudio(data) && state.engine) {
        try {
          state.engine.setMuted(!!state.muted);
        } catch (err) {}
      }
    } else {
      stopEngineAudio();
    }
    state.engineFailed = false;
    els.playerCanvas.hidden = false;
    els.engineBadge.textContent = '';
    els.engineBadge.hidden = true;
    els.muteBtn.hidden = false;
    els.repeatBtn.hidden = !source.vod;
    els.speedBtn.hidden = !source.vod;
    updateMuteButton();
    updateRepeatButton();
    updateSpeedButton();
    state.timelineDuration = source.vod ? (Number(data.lengthSeconds) || 0) : 0;
    state.timelinePosition = 0;
    state.timelinePreview = null;
    state.timelinePreviewAt = 0;
    state.timelineSeekable = !!source.vod;
    hideTimeline();

    try {
      player.setMuted(state.muted);
      player.setRepeat(state.repeat);
      player.open(url, {
        name: data.title || '',
        type: source.kind,
        vod: source.vod,
        rate: state.speed,
        maxHeight: source.maxHeight || 1080,
        pickedHeight: source.height || 0,
        audioUrl: source.audioUrl || '',
        durationHint: source.vod ? (Number(data.lengthSeconds) || 0) : 0
      });
    } catch (err) {
      engineFailed(err.message || 'Tesla Engine could not start.');
    }
  }

  function engineFailed(message) {
    if (state.mode !== 'engine' || state.engineFailed) return;
    cancelReconnect();
    state.engineFailed = true;
    state.mode = 'error';
    if (state.engine) {
      try {
        state.engine.close();
      } catch (err) {}
    }
    showPlaybackError('Tesla Engine could not play this stream.\n' + (message || 'Unknown playback error.'));
  }

  function stopPlayer() {
    cancelReconnect();
    stopEngineAudio();
    state.mode = null;
    state.engineFailed = false;
    state.engineSource = null;
    state.stallStartAt = 0;
    if (state.engine) {
      try {
        state.engine.close();
      } catch (err) {}
    }

    stopStandardPlayer();
    els.playerCanvas.hidden = false;
    els.engineBadge.hidden = true;
    els.muteBtn.hidden = true;
    els.repeatBtn.hidden = true;
    els.speedBtn.hidden = true;
    hideTimeline();
    hideOverlay();
  }

  // Re-resolve and restart the current video in place. A live broadcast keeps
  // playing through expiring media URLs; reloading the watch page is the
  // natural fix, and this button is that reload without leaving the video.
  function refreshCurrent() {
    if (!state.creds) {
      openSettings('Connect your Yattee server first.');
      return;
    }
    if (state.currentId) {
      openVideoById(state.currentId, state.current);
      return;
    }
    if (state.currentUrl) {
      openVideoByUrl(state.currentUrl, { direct: true });
    }
  }

  function leaveWatch() {
    if (els.watchView.hidden) return;
    state.playToken += 1;
    if (state.playAbort) {
      state.playAbort.abort();
      state.playAbort = null;
    }
    stopPlayer();
    state.current = null;
    state.currentId = '';
    state.currentUrl = '';
    state.streamUrl = null;
    syncBookmarkButton();
    els.watchView.hidden = true;
    els.refreshBtn.hidden = true;
    els.browseView.hidden = false;
    document.title = 'YouTube';
    // Returning from a bookmarked video can land on a list that no longer
    // matches the cache when the bookmark was removed while watching.
    if (state.browseMode === 'bookmarks') {
      state.results = readBookmarks();
      setNotice(state.results.length ? '' : 'No bookmarks yet. Open a video and tap the bookmark button.');
      renderResults();
    }
  }

  // ---- timeline -----------------------------------------------------------
  // The bar follows YouTube's behaviour: a red VOD scrubber with time labels,
  // a LIVE badge instead of a scrubber on live streams, and controls that fade
  // out when the pointer has been still for a couple of seconds.
  const TIMELINE_IDLE_MS = 3200;

  function formatClock(sec) {
    const total = Math.max(0, Math.floor(Number(sec) || 0));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    const two = (n) => (n < 10 ? '0' + n : String(n));
    return h ? h + ':' + two(m) + ':' + two(s) : m + ':' + two(s);
  }

  function setTimelineLive(isLive) {
    els.timeline.classList.toggle('live', isLive);
    els.timelineLive.hidden = !isLive;
    if (isLive) {
      els.timelinePlayed.style.width = '100%';
      els.timelineTrack.tabIndex = -1;
      els.timelineTrack.setAttribute('aria-valuemin', '0');
      els.timelineTrack.setAttribute('aria-valuemax', '0');
      els.timelineTrack.setAttribute('aria-valuenow', '0');
      els.timelineTrack.removeAttribute('aria-valuetext');
    } else {
      els.timelineTrack.tabIndex = state.timelineSeekable ? 0 : -1;
    }
  }

  function setTimelineFill(sec, duration) {
    const total = duration > 0 ? duration : 0;
    const clamped = total > 0 ? Math.min(Math.max(0, Number(sec) || 0), total) : 0;
    const fraction = total > 0 ? clamped / total : 0;
    const percent = (fraction * 100).toFixed(3) + '%';
    els.timelinePlayed.style.width = percent;
    els.timelineThumb.style.left = percent;
    els.timelineCurrent.textContent = formatClock(clamped);
    if (total > 0) els.timelineDuration.textContent = '-' + formatClock(total - clamped);
    els.timelineTrack.setAttribute('aria-valuemin', '0');
    els.timelineTrack.setAttribute('aria-valuemax', String(Math.round(total)));
    els.timelineTrack.setAttribute('aria-valuenow', String(Math.round(clamped)));
    els.timelineTrack.setAttribute('aria-valuetext', formatClock(clamped) + ' of ' + formatClock(total));
  }

  function updatePlayButton(paused) {
    const isPaused = !!paused;
    state.timelinePaused = isPaused;
    els.timelinePlayBtn.classList.toggle('paused', isPaused);
    els.timelinePlayBtn.setAttribute('aria-pressed', isPaused ? 'true' : 'false');
    const label = isPaused ? 'Play' : 'Pause';
    els.timelinePlayBtn.setAttribute('aria-label', label);
    els.timelinePlayBtn.title = label;
  }

  function toggleTimelinePause(event) {
    if (event) event.stopPropagation();
    if (!state.engine || !state.engineReady) return;
    const next = !state.timelinePaused;
    state.engine.setPaused(next);
    updatePlayButton(next);
    revealTimeline();
    armTimelineHide();
  }

  function updateTimeline(snapshot) {
    if (!snapshot) return;
    if (snapshot.stage === 'idle') return;
    updatePlayButton(snapshot.paused);
    // Track the position even while the bar is auto-hidden: reconnect uses
    // it to resume VOD at the point where the stream died, and the bar is
    // invisible for most of playback.
    const vod = !!snapshot.vod;
    if (vod) {
      state.timelineSeekable = snapshot.seekable !== false;
      state.timelinePosition = snapshot.position || 0;
      const duration = snapshot.duration || state.timelineDuration || 0;
      if (duration > 0) state.timelineDuration = duration;
    } else {
      state.timelineSeekable = false;
    }
    if (els.timeline.hidden) return;
    if (!vod) {
      setTimelineLive(true);
      return;
    }
    setTimelineLive(false);
    if (state.timelineDragging) {
      setTimelineFill(state.timelinePreview || 0, state.timelineDuration);
      return;
    }
    if (state.timelinePreview != null) {
      // Keep the requested time on the bar until the restarted pipeline
      // reports a position near it (the keyframe can sit just before it).
      const settled = snapshot.stage === 'vod' &&
        Math.abs((snapshot.position || 0) - state.timelinePreview) < 4;
      const expired = state.timelinePreviewAt && Date.now() - state.timelinePreviewAt > 6000;
      if (settled || expired) {
        state.timelinePreview = null;
      } else {
        setTimelineFill(state.timelinePreview, state.timelineDuration);
        return;
      }
    }
    setTimelineFill(state.timelinePosition, state.timelineDuration);
  }

  function showTimeline() {
    if (!state.engineSource) {
      hideTimeline();
      return;
    }
    els.timeline.hidden = false;
    els.timeline.classList.remove('idle');
    // Skipping only makes sense on a recorded video.
    els.skipBackBtn.hidden = !state.engineSource.vod;
    els.skipFwdBtn.hidden = !state.engineSource.vod;
    if (state.engineSource.vod) {
      state.timelineSeekable = true;
      setTimelineLive(false);
      setTimelineFill(state.timelinePosition || 0, state.timelineDuration || 0);
    } else {
      state.timelineSeekable = false;
      setTimelineLive(true);
    }
    armTimelineHide();
  }

  function hideTimeline() {
    if (state.timelineHideTimer) {
      window.clearTimeout(state.timelineHideTimer);
      state.timelineHideTimer = 0;
    }
    if (!els.timeline) return;
    els.timeline.hidden = true;
    els.timeline.classList.add('idle');
    els.timeline.classList.remove('dragging');
    state.timelineDragging = false;
    state.timelinePreview = null;
  }

  function armTimelineHide(delay) {
    if (state.timelineHideTimer) window.clearTimeout(state.timelineHideTimer);
    state.timelineHideTimer = window.setTimeout(() => {
      state.timelineHideTimer = 0;
      if (!state.timelineDragging) els.timeline.classList.add('idle');
    }, delay || TIMELINE_IDLE_MS);
  }

  function revealTimeline() {
    if (els.timeline.hidden) return;
    els.timeline.classList.remove('idle');
    if (!state.timelineDragging) armTimelineHide();
  }

  function timelineFraction(event) {
    const rect = els.timelineTrack.getBoundingClientRect();
    if (!rect.width) return 0;
    return Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
  }

  function beginTimelineSeek(event) {
    if (els.timeline.classList.contains('live') || !state.timelineSeekable) return;
    if (!state.engineSource || !state.engineSource.vod || !state.timelineDuration) return;
    event.preventDefault();
    state.timelineDragging = true;
    els.timeline.classList.add('dragging');
    if (state.timelineHideTimer) {
      window.clearTimeout(state.timelineHideTimer);
      state.timelineHideTimer = 0;
    }
    try { els.timelineTrack.setPointerCapture(event.pointerId); } catch (err) {}
    previewTimelineSeek(event);
  }

  function previewTimelineSeek(event) {
    if (!state.timelineDragging) return;
    state.timelinePreview = timelineFraction(event) * state.timelineDuration;
    state.timelinePreviewAt = Date.now();
    setTimelineFill(state.timelinePreview, state.timelineDuration);
  }

  function finishTimelineSeek(event) {
    if (!state.timelineDragging) return;
    state.timelineDragging = false;
    els.timeline.classList.remove('dragging');
    try { els.timelineTrack.releasePointerCapture(event.pointerId); } catch (err) {}
    const target = state.timelinePreview != null ? state.timelinePreview : state.timelinePosition;
    state.timelinePreviewAt = Date.now();
    let ok = false;
    try { ok = !!(state.engine && state.engine.seek(target)); } catch (err) { ok = false; }
    if (!ok) state.timelinePreview = null;
    setTimelineFill(ok ? target : state.timelinePosition, state.timelineDuration);
    revealTimeline();
  }

  function seekTimelineTo(target) {
    if (!state.engine || !state.timelineSeekable) return;
    const duration = state.timelineDuration;
    const max = duration > 0 ? Math.max(0, duration - 0.5) : target;
    const sec = Math.min(Math.max(0, target), max);
    state.timelinePreview = sec;
    state.timelinePreviewAt = Date.now();
    setTimelineFill(sec, duration);
    let ok = false;
    try { ok = !!state.engine.seek(sec); } catch (err) { ok = false; }
    if (!ok) state.timelinePreview = null;
    revealTimeline();
  }

  function skipBy(delta) {
    if (!state.engine || !state.timelineSeekable) return;
    // Stack on the position we last asked for: the engine reports 0 while it
    // re-opens the stream after a seek, so the played position is not a
    // reliable base for the next skip.
    const base = state.timelinePreview != null ? state.timelinePreview : state.timelinePosition;
    seekTimelineTo(base + delta);
  }

  function timelineKeyDown(event) {
    if (els.timeline.classList.contains('live') || !state.timelineSeekable) return;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault();
      seekTimelineTo(state.timelinePosition + (event.key === 'ArrowLeft' ? -5 : 5));
    } else if (event.key === 'Home') {
      event.preventDefault();
      seekTimelineTo(0);
    } else if (event.key === 'End') {
      event.preventDefault();
      seekTimelineTo(state.timelineDuration);
    }
  }

  function updateRepeatButton() {
    els.repeatBtn.classList.toggle('active', state.repeat);
    els.repeatBtn.setAttribute('aria-pressed', state.repeat ? 'true' : 'false');
  }

  const SPEED_STEPS = [1, 1.5];
  const SPEED_KEY = 'yattee-tesla.speed.v1';

  function storedSpeed() {
    try {
      return Number(localStorage.getItem(SPEED_KEY)) === 1.5 ? 1.5 : 1;
    } catch (err) {
      return 1;
    }
  }

  function storeSpeed(rate) {
    try {
      localStorage.setItem(SPEED_KEY, rate === 1.5 ? '1.5' : '1');
    } catch (err) {}
  }

  function updateSpeedButton() {
    const rate = state.speed === 1.5 ? 1.5 : 1;
    const label = rate === 1 ? '1x' : '1.5x';
    els.speedLabel.textContent = label;
    els.speedBtn.classList.toggle('active', rate !== 1);
    els.speedBtn.setAttribute('aria-pressed', rate !== 1 ? 'true' : 'false');
    els.speedBtn.setAttribute('aria-label', 'Playback speed ' + label);
    els.speedBtn.title = 'Playback speed ' + label;
  }

  function applySpeed() {
    if (state.engine) {
      try {
        state.engine.setRate(state.speed);
      } catch (err) {}
      if (state.speed !== 1) startEngineAudio(state.current);
      else stopEngineAudio();
    }
    if (els.standardVideo) els.standardVideo.playbackRate = state.speed;
    // The separate audio element has to run at the same rate as the picture.
    if (els.standardAudio && state.mode !== 'engine') els.standardAudio.playbackRate = state.speed;
    updateSpeedButton();
  }

  // At a rate other than 1x the engine's own stretcher is not clean enough,
  // so the sound is taken from the browser instead: the same audio-only
  // stream the standard player uses, played by a media element that
  // time-stretches it properly. The engine keeps painting the picture and
  // its own audio is muted, so the two never fight.
  let engineAudio = null;

  function startEngineAudio(data) {
    const format = pickAdaptiveAudio(data && data.adaptiveFormats);
    if (!format) return false;
    const src = relayMediaUrl(resolveUrl(format.url));
    const el = els.standardAudio;
    el.hidden = false;
    if (engineAudio && el.src !== src) {
      // A different video: the sound has to follow it.
      try {
        el.pause();
        el.src = src;
        el.load();
      } catch (err) {}
    } else if (!engineAudio) {
      el.src = src;
    }
    el.playbackRate = state.speed;
    el.muted = !!state.muted;
    try {
      const played = el.play();
      if (played && played.catch) played.catch(() => {});
    } catch (err) {}
    if (state.engine) {
      try {
        state.engine.setMuted(true);
      } catch (err) {}
    }
    if (!engineAudio) engineAudio = { timer: window.setInterval(syncEngineAudio, 50) };
    return true;
  }

  function stopEngineAudio() {
    if (!engineAudio) return;
    window.clearInterval(engineAudio.timer);
    engineAudio = null;
    try {
      els.standardAudio.pause();
      els.standardAudio.removeAttribute('src');
      els.standardAudio.load();
    } catch (err) {}
    els.standardAudio.hidden = true;
    if (state.engine) {
      try {
        state.engine.setMuted(!!state.muted);
      } catch (err) {}
    }
  }

  // Keep the browser's audio locked to the engine's picture.
  function syncEngineAudio() {
    if (!engineAudio || !state.engine) return;
    let snapshot = null;
    try {
      snapshot = state.engine.state();
    } catch (err) {
      return;
    }
    if (!snapshot) return;
    const audio = els.standardAudio;
    if (!audio) return;
    const pos = snapshot.position || 0;

    // The transport follows the engine: pausing the video pauses the sound.
    if (snapshot.paused && !audio.paused) {
      try {
        audio.pause();
      } catch (err) {}
      return;
    }
    if (!snapshot.paused && audio.paused) {
      try {
        const played = audio.play();
        if (played && played.catch) played.catch(() => {});
      } catch (err) {}
      return;
    }
    if (audio.paused) return;
    const dur = audio.duration || 0;
    if (!dur) return;

    // Two stages. A small offset is taken out with a gentle rate trim, which
    // slides the sound onto the picture without the click a seek would make.
    // Anything larger is corrected by a small seek, but only one at a time:
    // seeking every tick restarts the element's pipeline and it falls over.
    const drift = pos - audio.currentTime;
    const now = Date.now();
    if (Math.abs(drift) > 0.15 && now - (engineAudio.lastFix || 0) > 400) {
      engineAudio.lastFix = now;
      try {
        audio.currentTime = Math.max(0, Math.min(pos, dur - 0.5));
      } catch (err) {}
      try {
        audio.playbackRate = state.speed;
      } catch (err) {}
      return;
    }
    const trim = Math.max(-0.02, Math.min(0.02, drift * 0.8));
    const want = state.speed * (1 + trim);
    if (Math.abs(audio.playbackRate - want) > 0.001) {
      try {
        audio.playbackRate = want;
      } catch (err) {}
    }
  }

  function toggleSpeed() {
    const index = SPEED_STEPS.indexOf(state.speed);
    state.speed = SPEED_STEPS[(index + 1) % SPEED_STEPS.length] || 1;
    storeSpeed(state.speed);
    applySpeed();
  }

  function toggleRepeat() {
    state.repeat = !state.repeat;
    updateRepeatButton();
    if (state.engine) {
      try { state.engine.setRepeat(state.repeat); } catch (err) {}
    }
    if (els.standardVideo) els.standardVideo.loop = !!state.repeat;
  }

  function showLoading(text) {
    els.playerOverlay.hidden = false;
    els.playerOverlay.classList.remove('failed');
    els.overlayText.textContent = text;
    hideTimeline();
    const spinner = els.playerOverlay.querySelector('.spinner');
    if (spinner) spinner.hidden = false;
  }

  function hideOverlay() {
    els.playerOverlay.hidden = true;
    els.playerOverlay.classList.remove('failed');
  }

  function showPlaybackError(message) {
    state.mode = 'error';
    if (state.engine) {
      try {
        state.engine.close();
      } catch (err) {}
    }
    els.playerOverlay.hidden = false;
    els.playerOverlay.classList.add('failed');
    els.overlayText.textContent = message || 'Playback failed.';
    const spinner = els.playerOverlay.querySelector('.spinner');
    if (spinner) spinner.hidden = true;
    els.engineBadge.hidden = true;
    els.muteBtn.hidden = true;
    els.repeatBtn.hidden = true;
    els.speedBtn.hidden = true;
    hideTimeline();
  }

  function updateMuteButton() {
    const muted = !!state.muted;
    els.muteBtn.classList.toggle('muted', muted);
    els.muteBtn.setAttribute('aria-pressed', muted ? 'true' : 'false');
    const label = muted ? 'Unmute sound' : 'Mute sound';
    els.muteBtn.setAttribute('aria-label', label);
    els.muteBtn.title = label;
  }

  function toggleMute() {
    state.muted = !state.muted;
    if (state.engine) {
      try {
        // While the browser is playing the sound, the engine stays muted.
        state.engine.setMuted(engineAudio ? true : state.muted);
      } catch (err) {}
    }
    if (els.standardVideo) els.standardVideo.muted = !!state.muted;
    if (els.standardAudio) els.standardAudio.muted = !!state.muted;
    updateMuteButton();
  }

  function showSettingsMessage(message, isError = true) {
    if (!message) {
      els.settingsError.hidden = true;
      els.settingsError.textContent = '';
      return;
    }
    els.settingsError.hidden = false;
    els.settingsError.textContent = message;
    els.settingsError.classList.toggle('form-error', isError);
  }

  function fillSettingsForm(creds) {
    els.serverInput.value = (creds && creds.base) || DEFAULT_SERVER;
    els.usernameInput.value = (creds && creds.username) || '';
    els.passwordInput.value = (creds && creds.password) || '';
    els.rememberInput.checked = creds ? creds.remember !== false : true;
    els.clearBtn.disabled = !creds && !hasSavedCredentials();
  }

  function openSettings(message) {
    const wasHidden = els.settingsModal.hidden;
    if (wasHidden) {
      state.settingsReturnFocus = document.activeElement;
      fillSettingsForm(state.creds);
      showSettingsMessage('');
    }
    els.standardPlayerInput.checked = useStandardPlayer();
    els.settingsModal.hidden = false;
    document.body.classList.add('modal-open');
    if (message) showSettingsMessage(message);
    if (wasHidden) {
      setTimeout(() => {
        if (els.settingsModal.hidden) return;
        if (!els.serverInput.value) els.serverInput.focus();
        else els.closeSettingsBtn.focus();
      }, 0);
    }
  }

  function closeSettings() {
    els.settingsModal.hidden = true;
    document.body.classList.remove('modal-open');
    showSettingsMessage('');
    if (state.settingsReturnFocus && typeof state.settingsReturnFocus.focus === 'function') {
      try {
        state.settingsReturnFocus.focus();
      } catch (err) {}
    }
    state.settingsReturnFocus = null;
  }

  async function submitSettings(event) {
    event.preventDefault();
    showSettingsMessage('');

    let base;
    try {
      base = normalizeServer(els.serverInput.value);
    } catch (err) {
      showSettingsMessage(err.message);
      return;
    }

    const draft = {
      base,
      username: els.usernameInput.value,
      password: els.passwordInput.value
    };
    const previous = state.creds;
    const previousMode = state.mode;
    const previousStream = state.streamUrl;

    state.creds = draft;
    els.connectBtn.disabled = true;
    els.connectBtn.textContent = 'Connecting...';

    try {
      await api('/info');
    } catch (err) {
      state.creds = previous;
      state.mode = previousMode;
      state.streamUrl = previousStream;
      showSettingsMessage(err.message || 'Could not connect to the server.');
      els.connectBtn.disabled = false;
      els.connectBtn.textContent = 'Save & connect';
      return;
    }

    state.creds = draft;
    const remember = els.rememberInput.checked;
    const stored = saveCredentials(draft, remember);
    if (!stored) {
      showToast('Connected, but the browser could not save the credentials.');
    }

    els.connectBtn.disabled = false;
    els.connectBtn.textContent = 'Save & connect';
    closeSettings();
    leaveWatch();
    updateBookmarksButton();
    syncBookmarks();
    showToast('Connected to ' + draft.base.replace(/^https?:\/\//, ''));
    loadTrending();
    window.scrollTo(0, 0);
  }

  function clearCredentials() {
    if (!window.confirm('Forget the saved Yattee server and credentials?')) return;
    forgetCredentials();
    state.creds = null;
    updateBookmarksButton();
    state.playToken += 1;
    if (state.playAbort) {
      state.playAbort.abort();
      state.playAbort = null;
    }
    stopPlayer();
    if (state.engine) {
      try {
        state.engine.destroy();
      } catch (err) {}
      state.engine = null;
    }
    state.results = [];
    state.query = '';
    state.page = 0;
    els.serverInput.value = DEFAULT_SERVER;
    els.usernameInput.value = '';
    els.passwordInput.value = '';
    els.rememberInput.checked = true;
    els.clearBtn.disabled = true;
    showSettingsMessage('');
    leaveWatch();
    showEmptyState();
    showToast('Saved credentials removed.');
  }

  function showToast(message) {
    if (!message) return;
    els.toast.textContent = message;
    els.toast.hidden = false;
    if (state.toastTimer) window.clearTimeout(state.toastTimer);
    state.toastTimer = window.setTimeout(() => {
      els.toast.hidden = true;
      state.toastTimer = 0;
    }, 3800);
  }

  // ---- bookmarks ----------------------------------------------------------

  // All server bookmark reads/writes go through one queue so a slow request
  // cannot reorder a toggle that happened while it was in flight.
  let bookmarkQueue = Promise.resolve();

  function queueBookmarkTask(task) {
    const run = bookmarkQueue.then(task, task);
    bookmarkQueue = run.catch(() => {});
    return run;
  }

  function syncSavedBadges() {
    const ids = savedVideoIds();
    const cards = document.querySelectorAll('.video-card[data-video-id]');
    for (const card of cards) card.classList.toggle('saved', ids.has(card.dataset.videoId));
  }

  function updateBookmarksButton() {
    const count = readBookmarks().length;
    const label = count ? 'Bookmarks (' + count + ')' : 'Bookmarks';
    els.bookmarksBtn.setAttribute('aria-label', label);
    els.bookmarksBtn.title = label;
    renderBookmarksShelf();
    syncSavedBadges();
  }

  function syncBookmarkButton(id) {
    const target = id || currentVideoId();
    const saved = !!bookmarkedItem(target);
    els.bookmarkBtn.hidden = !target;
    els.bookmarkBtn.classList.toggle('active', saved);
    els.bookmarkBtn.setAttribute('aria-pressed', saved ? 'true' : 'false');
    const label = saved ? 'Remove from bookmarks' : 'Save to bookmarks';
    els.bookmarkBtn.setAttribute('aria-label', label);
    els.bookmarkBtn.title = label;
  }

  async function pushBookmarksToServer() {
    if (!state.creds) return false;
    const cacheKey = bookmarkCacheKey();
    const revision = state.bookmarkRevision;
    const items = readBookmarks();
    try {
      const payload = await api('/api/v1/bookmarks', {
        method: 'PUT',
        body: JSON.stringify({ items })
      });
      if (bookmarkCacheKey() !== cacheKey) return false;
      const saved = payload && Array.isArray(payload.items) ? payload.items : null;
      if (state.bookmarkRevision === revision) {
        if (saved) writeBookmarks(saved);
        markBookmarksDirty(false);
      } else {
        markBookmarksDirty(true);
      }
      updateBookmarksButton();
      syncBookmarkButton();
      return true;
    } catch (err) {
      if (bookmarkCacheKey() === cacheKey) markBookmarksDirty(true);
      return false;
    }
  }

  async function fetchBookmarksFromServer() {
    if (!state.creds) return false;
    const cacheKey = bookmarkCacheKey();
    const revision = state.bookmarkRevision;
    try {
      const payload = await api('/api/v1/bookmarks');
      if (bookmarkCacheKey() !== cacheKey) return false;
      const items = Array.isArray(payload)
        ? payload
        : payload && Array.isArray(payload.items)
          ? payload.items
          : null;
      if (!items) return false;
      // A toggle made while the request was in flight wins over this copy.
      if (state.bookmarkRevision !== revision) return false;
      writeBookmarks(items);
      markBookmarksDirty(false);
      updateBookmarksButton();
      syncBookmarkButton();
      return true;
    } catch (err) {
      return false;
    }
  }

  function syncBookmarks() {
    if (!state.creds) return Promise.resolve(false);
    return queueBookmarkTask(async () => {
      if (bookmarksAreDirty()) {
        const pushed = await pushBookmarksToServer();
        if (!pushed) return false;
        // A toggle during the upload queued its own push; do not fetch over it.
        if (bookmarksAreDirty()) return false;
      }
      return fetchBookmarksFromServer();
    });
  }

  const LONG_PRESS_MS = 600;
  const LONG_PRESS_SLOP = 12;
  let thumbnailPress = null;
  let suppressThumbnailClickUntil = 0;
  let pendingBookmarkRemoval = null;

  function cancelThumbnailPress() {
    if (!thumbnailPress) return;
    if (thumbnailPress.timer) window.clearTimeout(thumbnailPress.timer);
    if (thumbnailPress.card) thumbnailPress.card.classList.remove('pressing');
    thumbnailPress = null;
  }

  function startThumbnailPress(target, pointerId, x, y) {
    const thumb = target && target.closest ? target.closest('.thumb') : null;
    const card = thumb && thumb.closest('.video-card');
    if (!card) return;
    // The same press can arrive as pointerdown, mousedown and touchstart.
    // Keep the first one so the timer is not restarted forever.
    if (
      thumbnailPress &&
      thumbnailPress.card === card &&
      Math.abs(thumbnailPress.startX - x) < 24 &&
      Math.abs(thumbnailPress.startY - y) < 24
    ) {
      return;
    }
    suppressThumbnailClickUntil = 0;
    cancelThumbnailPress();
    card.classList.add('pressing');
    thumbnailPress = {
      pointerId,
      card,
      startX: x,
      startY: y,
      fired: false,
      timer: window.setTimeout(() => {
        if (!thumbnailPress) return;
        thumbnailPress.timer = 0;
        thumbnailPress.fired = true;
        suppressThumbnailClickUntil = Date.now() + 1000;
        handleThumbnailLongPress(card);
      }, LONG_PRESS_MS)
    };
  }

  function handleThumbnailPointerDown(event) {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    if (event.isPrimary === false) return;
    startThumbnailPress(event.target, event.pointerId, event.clientX, event.clientY);
  }

  function handleThumbnailMouseDown(event) {
    if (event.button !== 0) return;
    startThumbnailPress(event.target, 'mouse-' + event.button, event.clientX, event.clientY);
  }

  function handleThumbnailTouchStart(event) {
    const touch = event.touches && event.touches[0];
    if (!touch) return;
    startThumbnailPress(event.target, 'touch-' + touch.identifier, touch.clientX, touch.clientY);
  }

  function handleThumbnailPointerMove(event) {
    if (!thumbnailPress || event.pointerId !== thumbnailPress.pointerId) return;
    if (thumbnailPress.fired) return;
    const dx = event.clientX - thumbnailPress.startX;
    const dy = event.clientY - thumbnailPress.startY;
    if (Math.sqrt(dx * dx + dy * dy) > LONG_PRESS_SLOP) cancelThumbnailPress();
  }

  function handleThumbnailPointerUp(event) {
    if (!thumbnailPress || event.pointerId !== thumbnailPress.pointerId) return;
    cancelThumbnailPress();
  }

  function suppressThumbnailClick(event) {
    if (Date.now() > suppressThumbnailClickUntil) return;
    if (!event.target.closest('.thumb')) return;
    suppressThumbnailClickUntil = 0;
    event.preventDefault();
    event.stopPropagation();
  }

  function preventThumbnailContextMenu(event) {
    if (event.target.closest('.thumb')) event.preventDefault();
  }

  function handleThumbnailLongPress(card) {
    const id = card.dataset.videoId;
    if (!id) return;
    const item = findVideoItem(id);
    if (bookmarkedItem(id)) {
      requestBookmarkRemoval(id, item ? item.title : '');
      return;
    }
    if (!item) {
      showToast('Could not save this video.');
      return;
    }
    applyBookmarkChange(id, item, false);
  }

  function requestBookmarkRemoval(id, title) {
    pendingBookmarkRemoval = { id, title: title || id };
    els.bookmarkConfirmText.textContent =
      '\u201c' + pendingBookmarkRemoval.title + '\u201d will be removed from your bookmarks.';
    els.bookmarkConfirm.hidden = false;
    document.body.classList.add('modal-open');
    try {
      els.cancelRemoveBookmarkBtn.focus({ preventScroll: true });
    } catch (err) {}
  }

  function closeBookmarkConfirm() {
    if (els.bookmarkConfirm.hidden) return;
    els.bookmarkConfirm.hidden = true;
    if (els.settingsModal.hidden) document.body.classList.remove('modal-open');
    pendingBookmarkRemoval = null;
  }

  function confirmBookmarkRemoval() {
    const pending = pendingBookmarkRemoval;
    closeBookmarkConfirm();
    if (!pending) return;
    applyBookmarkChange(pending.id, null, true);
  }

  function bookmarkEntry(id, source) {
    const data = source || state.current || {};
    return {
      videoId: id,
      title: data.title || els.watchTitle.textContent || id,
      author: data.author || '',
      authorThumbnails: Array.isArray(data.authorThumbnails) ? data.authorThumbnails : [],
      videoThumbnails: Array.isArray(data.videoThumbnails) ? data.videoThumbnails : [],
      viewCount: Number(data.viewCount) || 0,
      published: data.published || '',
      publishedText: data.publishedText || '',
      lengthSeconds: Number(data.lengthSeconds) || 0,
      liveNow: !!data.liveNow,
      savedAt: Date.now()
    };
  }

  function findVideoItem(id) {
    if (!id) return null;
    return (
      state.results.find((entry) => entry.videoId === id) ||
      readBookmarks().find((entry) => entry.videoId === id) ||
      null
    );
  }

  function applyBookmarkChange(id, data, remove) {
    const items = readBookmarks();
    const index = items.findIndex((entry) => entry.videoId === id);
    if (remove) {
      if (index === -1) return false;
      items.splice(index, 1);
    } else {
      if (index !== -1) return false;
      items.unshift(bookmarkEntry(id, data));
    }
    if (!writeBookmarks(items)) {
      showToast('Could not update bookmarks in this browser.');
      return false;
    }
    state.bookmarkRevision += 1;
    showToast(remove ? 'Removed from bookmarks.' : 'Saved to bookmarks.');
    syncBookmarkButton();
    updateBookmarksButton();
    if (state.browseMode === 'bookmarks') {
      state.results = readBookmarks();
      setNotice(state.results.length ? '' : 'No bookmarks yet. Open a video and tap the bookmark button.');
      renderResults();
    }
    queueBookmarkTask(pushBookmarksToServer).then((ok) => {
      if (!ok) showToast('Bookmark change saved on this device; it will sync when the server is reachable.');
    });
    return true;
  }

  function toggleBookmark() {
    const id = currentVideoId();
    if (!id) return;
    if (bookmarkedItem(id)) {
      // Removing asks for confirmation, the same as a long press on a
      // thumbnail.
      const title = (state.current && state.current.title) || els.watchTitle.textContent || id;
      requestBookmarkRemoval(id, title);
      return;
    }
    applyBookmarkChange(id, state.current, false);
  }

  function openBookmarks() {
    leaveWatch();
    if (state.searchAbort) {
      state.searchAbort.abort();
      state.searchAbort = null;
    }
    state.searchToken += 1;
    state.browseMode = 'bookmarks';
    renderBookmarksShelf();
    state.query = '';
    state.page = 0;
    state.loadingMore = false;
    state.results = readBookmarks();
    els.emptyState.hidden = true;
    els.moreBtn.hidden = true;
    els.searchInput.value = '';
    updateSearchClear();
    setBrowseHeader('Saved', 'Bookmarks');
    setNotice(state.results.length ? '' : 'No bookmarks yet. Open a video and tap the bookmark button.');
    renderResults();
    window.scrollTo(0, 0);
    syncBookmarks().then(() => {
      if (state.browseMode !== 'bookmarks' || els.browseView.hidden) return;
      state.results = readBookmarks();
      setNotice(state.results.length ? '' : 'No bookmarks yet. Open a video and tap the bookmark button.');
      renderResults();
    });
  }

  function handleHome() {
    leaveWatch();
    if (!state.creds) {
      showEmptyState();
      openSettings();
      return;
    }
    loadTrending();
  }

  function handleSearchSubmit(event) {
    event.preventDefault();
    const value = els.searchInput.value.trim();
    if (!value) {
      handleHome();
      return;
    }
    if (!state.creds) {
      openSettings('Connect your Yattee server first.');
      return;
    }
    if (/^https?:\/\//i.test(value)) {
      openVideoByUrl(value);
      return;
    }
    leaveWatch();
    runSearch(value);
  }

  function handleResultsClick(event) {
    const card = event.target.closest('.video-card');
    if (!card) return;
    const id = card.dataset.videoId;
    if (!id) return;
    const item = state.results.find((entry) => entry.videoId === id) || null;
    openVideoById(id, item);
  }

  function handleShelfClick(event) {
    const card = event.target.closest('.video-card');
    if (!card) return;
    const id = card.dataset.videoId;
    if (!id) return;
    const item = readBookmarks().find((entry) => entry.videoId === id) || null;
    openVideoById(id, item);
  }

  function handleKeyDown(event) {
    if (event.key === 'Escape') {
      if (!els.bookmarkConfirm.hidden) {
        closeBookmarkConfirm();
        return;
      }
      if (!els.settingsModal.hidden) {
        closeSettings();
        return;
      }
      if (!els.watchView.hidden) leaveWatch();
    }
  }

  function updateSearchClear() {
    els.searchClear.hidden = !els.searchInput.value;
  }

  function bindEvents() {
    els.homeBtn.addEventListener('click', handleHome);
    els.bookmarksBtn.addEventListener('click', openBookmarks);
    els.settingsBtn.addEventListener('click', () => openSettings());
    els.emptyConnectBtn.addEventListener('click', () => openSettings());
    els.closeSettingsBtn.addEventListener('click', closeSettings);
    els.settingsForm.addEventListener('submit', submitSettings);
    els.clearBtn.addEventListener('click', clearCredentials);
    els.standardPlayerInput.addEventListener('change', () => {
      setStandardPlayerEnabled(els.standardPlayerInput.checked);
      updateEngineSupport();
      // Restart whatever is playing so the change takes effect right away.
      if (state.mode === 'engine' || state.mode === 'standard') refreshCurrent();
    });
    els.standardVideo.addEventListener('playing', () => {
      if (state.mode !== 'standard') return;
      hideOverlay();
    });
    // The picture and the separate audio track are two elements, so the
    // audio follows the video: same transport, same position.
    els.standardVideo.addEventListener('play', () => {
      const audio = els.standardAudio;
      if (!audio || !audio.src) return;
      try {
        const played = audio.play();
        if (played && played.catch) played.catch(() => {});
      } catch (err) {}
    });
    els.standardVideo.addEventListener('pause', () => {
      const audio = els.standardAudio;
      if (!audio || !audio.src) return;
      try {
        audio.pause();
      } catch (err) {}
    });
    els.standardVideo.addEventListener('seeked', () => {
      const audio = els.standardAudio;
      if (!audio || !audio.src) return;
      if (Math.abs(audio.currentTime - els.standardVideo.currentTime) > 0.2) {
        try {
          audio.currentTime = els.standardVideo.currentTime;
        } catch (err) {}
      }
    });
    els.standardVideo.addEventListener('timeupdate', () => {
      const audio = els.standardAudio;
      if (!audio || !audio.src || audio.paused) return;
      const drift = els.standardVideo.currentTime - audio.currentTime;
      if (Math.abs(drift) > 0.12) {
        try {
          audio.currentTime = els.standardVideo.currentTime;
        } catch (err) {}
      }
    });
    els.standardVideo.addEventListener('volumechange', () => {
      const audio = els.standardAudio;
      if (!audio || !audio.src) return;
      audio.volume = els.standardVideo.volume;
      audio.muted = els.standardVideo.muted;
    });
    els.standardVideo.addEventListener('error', () => {
      if (state.mode !== 'standard') return;
      showPlaybackError('The standard video player could not open this stream.');
    });
    els.searchForm.addEventListener('submit', handleSearchSubmit);
    els.searchClear.addEventListener('click', () => {
      els.searchInput.value = '';
      updateSearchClear();
      els.searchInput.dispatchEvent(new Event('input', { bubbles: true }));
      els.searchInput.focus();
    });
    els.searchInput.addEventListener('input', updateSearchClear);
    els.resultsGrid.addEventListener('click', handleResultsClick);
    els.bookmarksShelfRow.addEventListener('click', handleShelfClick);
    els.resultsGrid.addEventListener('pointerdown', handleThumbnailPointerDown);
    els.bookmarksShelfRow.addEventListener('pointerdown', handleThumbnailPointerDown);
    els.resultsGrid.addEventListener('mousedown', handleThumbnailMouseDown);
    els.bookmarksShelfRow.addEventListener('mousedown', handleThumbnailMouseDown);
    els.resultsGrid.addEventListener('touchstart', handleThumbnailTouchStart, { passive: true });
    els.bookmarksShelfRow.addEventListener('touchstart', handleThumbnailTouchStart, { passive: true });
    els.resultsGrid.addEventListener('click', suppressThumbnailClick, true);
    els.bookmarksShelfRow.addEventListener('click', suppressThumbnailClick, true);
    els.resultsGrid.addEventListener('contextmenu', preventThumbnailContextMenu);
    els.bookmarksShelfRow.addEventListener('contextmenu', preventThumbnailContextMenu);
    window.addEventListener('pointermove', handleThumbnailPointerMove, { passive: true });
    window.addEventListener('pointerup', handleThumbnailPointerUp);
    window.addEventListener('pointercancel', cancelThumbnailPress);
    window.addEventListener('mouseup', cancelThumbnailPress);
    window.addEventListener('touchend', cancelThumbnailPress);
    window.addEventListener('touchcancel', cancelThumbnailPress);
    window.addEventListener('blur', cancelThumbnailPress);
    els.confirmRemoveBookmarkBtn.addEventListener('click', confirmBookmarkRemoval);
    els.cancelRemoveBookmarkBtn.addEventListener('click', closeBookmarkConfirm);
    els.closeBookmarkConfirmBtn.addEventListener('click', closeBookmarkConfirm);
    els.moreBtn.addEventListener('click', loadMoreResults);
    els.backBtn.addEventListener('click', leaveWatch);
    els.bookmarkBtn.addEventListener('click', toggleBookmark);
    els.refreshBtn.addEventListener('click', refreshCurrent);
    els.muteBtn.addEventListener('click', toggleMute);
    els.repeatBtn.addEventListener('click', toggleRepeat);
    els.speedBtn.addEventListener('click', toggleSpeed);
    els.timelinePlayBtn.addEventListener('click', toggleTimelinePause);
    els.skipBackBtn.addEventListener('click', () => skipBy(-10));
    els.skipFwdBtn.addEventListener('click', () => skipBy(10));
    els.descMoreBtn.addEventListener('click', function () {
      const expanded = els.watchDescription.classList.toggle('expanded');
      els.descMoreBtn.textContent = expanded ? 'Show less' : 'Show more';
    });
    els.timelineTrack.addEventListener('pointerdown', beginTimelineSeek);
    els.timelineTrack.addEventListener('pointermove', previewTimelineSeek);
    els.timelineTrack.addEventListener('pointerup', finishTimelineSeek);
    els.timelineTrack.addEventListener('pointercancel', finishTimelineSeek);
    els.timelineTrack.addEventListener('keydown', timelineKeyDown);
    els.playerStage.addEventListener('pointermove', revealTimeline);
    els.playerStage.addEventListener('pointerdown', () => {
      // Remember the tap so the leave that follows it cannot shorten the
      // idle time: an explicit tap always gets the full dwell.
      state.timelineLastTap = Date.now();
      revealTimeline();
    });
    els.playerStage.addEventListener('pointerleave', () => {
      if (state.timelineDragging) return;
      if (Date.now() - state.timelineLastTap < 1500) return;
      armTimelineHide(900);
    });
    document.addEventListener('keydown', handleKeyDown);
  }

  function boot() {
    bindEvents();
    state.speed = storedSpeed();
    updateSpeedButton();
    els.standardPlayerInput.checked = useStandardPlayer();
    updateEngineSupport();
    updateBookmarksButton();

    const saved = readSavedCredentials();
    if (!saved) {
      showEmptyState();
      openSettings();
      return;
    }

    state.creds = saved;
    fillSettingsForm(saved);
    els.emptyState.hidden = true;

    const problem = validateStoredBase(saved.base);
    if (problem) {
      showEmptyState();
      openSettings(problem);
      return;
    }

    updateBookmarksButton();
    syncBookmarks();
    loadTrending();
  }

  boot();
})();
