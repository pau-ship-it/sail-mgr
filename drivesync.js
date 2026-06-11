/**
 * SAIL.MGR — Google Drive Sync Layer
 * Uses Google Identity Services + Drive API v3 (appdata scope)
 * The data file lives in the hidden appDataFolder — invisible to the user in Drive UI.
 */

const FILE_NAME = 'sail-mgr-data.json';
const SCOPE = 'https://www.googleapis.com/auth/drive.appdata';
const STORAGE_KEY_TOKEN = 'sail-drive-token';
const STORAGE_KEY_USER  = 'sail-drive-user';
const SAVE_DEBOUNCE_MS  = 1200;

let tokenClient = null;
let accessToken  = null;
let fileId       = null;
let saveTimer    = null;
let isSyncing    = false;
let isLoggedIn   = false;

// ── UI helpers ──────────────────────────────────────────────────────────────

function setSyncStatus(state) {
  const indicator = document.getElementById('sync-indicator');
  if (!indicator) return;
  const icon  = indicator.querySelector('.sync-icon');
  const label = indicator.querySelector('.sync-label');
  indicator.className = 'sync-indicator sync-' + state;
  const map = {
    idle:    { i: '◈', l: 'OFFLINE',  c: 'sync-idle'    },
    syncing: { i: '⟳', l: 'SYNCING…', c: 'sync-syncing' },
    synced:  { i: '✓', l: 'SYNCED',   c: 'sync-synced'  },
    error:   { i: '✗', l: 'ERROR',    c: 'sync-error'   },
  };
  const s = map[state] || map.idle;
  if (icon)  icon.textContent  = s.i;
  if (label) label.textContent = s.l;
}

function setUserBadge(profile) {
  const badge  = document.getElementById('user-badge');
  const avatar = document.getElementById('user-avatar');
  const name   = document.getElementById('user-name');
  if (!badge) return;
  if (profile) {
    badge.classList.remove('hidden');
    if (avatar) avatar.src = profile.picture || '';
    if (name)   name.textContent = (profile.given_name || profile.name || '').toUpperCase();
    // Also show logout button in profile tab
    const logoutBtn = document.getElementById('btn-logout');
    if (logoutBtn) logoutBtn.classList.remove('hidden');
  } else {
    badge.classList.add('hidden');
  }
}

// ── Token management ─────────────────────────────────────────────────────────

function saveToken(token) {
  accessToken = token;
  try { localStorage.setItem(STORAGE_KEY_TOKEN, token); } catch (_) {}
}

function loadToken() {
  try { return localStorage.getItem(STORAGE_KEY_TOKEN); } catch (_) { return null; }
}

function clearToken() {
  accessToken = null;
  fileId = null;
  try { localStorage.removeItem(STORAGE_KEY_TOKEN); } catch (_) {}
  try { localStorage.removeItem(STORAGE_KEY_USER);  } catch (_) {}
}

function saveUserProfile(profile) {
  try { localStorage.setItem(STORAGE_KEY_USER, JSON.stringify(profile)); } catch (_) {}
}

function loadUserProfile() {
  try {
    const s = localStorage.getItem(STORAGE_KEY_USER);
    return s ? JSON.parse(s) : null;
  } catch (_) { return null; }
}

// ── Drive API calls ───────────────────────────────────────────────────────────

async function driveRequest(method, url, body, isJson = true) {
  if (!accessToken) throw new Error('No access token');
  const headers = { Authorization: 'Bearer ' + accessToken };
  if (isJson && body) headers['Content-Type'] = 'application/json';
  const res = await fetch(url, { method, headers, body: body ? (isJson ? JSON.stringify(body) : body) : undefined });
  if (res.status === 401) { clearToken(); throw new Error('AUTH_EXPIRED'); }
  if (!res.ok) throw new Error('Drive error ' + res.status);
  return res.status === 204 ? null : res.json();
}

async function findFile() {
  const data = await driveRequest(
    'GET',
    `https://www.googleapis.com/drive/v3/files?spaces=appDataFolder&q=name='${FILE_NAME}'&fields=files(id,name,modifiedTime)&pageSize=5`
  );
  const files = (data && data.files) || [];
  return files.length ? files[0] : null;
}

async function readFile(id) {
  return driveRequest('GET', `https://www.googleapis.com/drive/v3/files/${id}?alt=media`);
}

async function createFile(content) {
  const meta = { name: FILE_NAME, parents: ['appDataFolder'] };
  const boundary = 'saildrive_boundary';
  const body =
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
    JSON.stringify(meta) +
    `\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n` +
    JSON.stringify(content) +
    `\r\n--${boundary}--`;
  const res = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + accessToken,
      'Content-Type': `multipart/related; boundary=${boundary}`,
    },
    body,
  });
  if (!res.ok) throw new Error('Create failed ' + res.status);
  return res.json();
}

async function updateFile(id, content) {
  const res = await fetch(`https://www.googleapis.com/upload/drive/v3/files/${id}?uploadType=media`, {
    method: 'PATCH',
    headers: {
      Authorization: 'Bearer ' + accessToken,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(content),
  });
  if (res.status === 401) { clearToken(); throw new Error('AUTH_EXPIRED'); }
  if (!res.ok) throw new Error('Update failed ' + res.status);
}

// ── Load data from Drive ───────────────────────────────────────────────────

async function loadFromDrive() {
  setSyncStatus('syncing');
  try {
    const file = await findFile();
    if (!file) {
      // First time — write current data to Drive
      const localData = buildPayload();
      const created = await createFile(localData);
      fileId = created.id;
      setSyncStatus('synced');
      return null; // keep local data
    }
    fileId = file.id;
    const data = await readFile(fileId);
    setSyncStatus('synced');
    return data;
  } catch (err) {
    console.error('[DriveSync] loadFromDrive error:', err);
    setSyncStatus('error');
    return null;
  }
}

// ── Save data to Drive (debounced) ─────────────────────────────────────────

function buildPayload() {
  // Pull current state from the app globals
  const p = window.projects || [];
  const t = window.todos || [];
  const h = window.hourEntries || [];
  const g = window.gdata || {};
  const prof = (() => {
    try { return JSON.parse(localStorage.getItem('sm-profile') || 'null'); } catch (_) { return null; }
  })();
  return {
    v: 2,
    date: new Date().toISOString(),
    projects: p,
    todos: t,
    hourEntries: h,
    gdata: g,
    profile: prof,
  };
}

async function doSave() {
  if (!isLoggedIn || !accessToken) return;
  if (isSyncing) { scheduleSave(); return; }
  isSyncing = true;
  setSyncStatus('syncing');
  try {
    const payload = buildPayload();
    if (!fileId) {
      const file = await findFile();
      if (file) { fileId = file.id; } else {
        const created = await createFile(payload);
        fileId = created.id;
        setSyncStatus('synced');
        return;
      }
    }
    await updateFile(fileId, payload);
    setSyncStatus('synced');
  } catch (err) {
    console.error('[DriveSync] save error:', err);
    setSyncStatus('error');
    if (err.message === 'AUTH_EXPIRED') refreshToken();
  } finally {
    isSyncing = false;
  }
}

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(doSave, SAVE_DEBOUNCE_MS);
}

// ── Token refresh ──────────────────────────────────────────────────────────

function refreshToken() {
  if (!tokenClient) return;
  tokenClient.requestAccessToken({ prompt: '' }); // silent refresh
}

// ── Fetch user info ────────────────────────────────────────────────────────

async function fetchUserInfo(token) {
  try {
    const res = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { Authorization: 'Bearer ' + token }
    });
    if (!res.ok) return null;
    return res.json();
  } catch (_) { return null; }
}

// ── Init Google Identity Services ─────────────────────────────────────────

function waitForGIS() {
  return new Promise(resolve => {
    if (window.google && window.google.accounts) { resolve(); return; }
    const interval = setInterval(() => {
      if (window.google && window.google.accounts) { clearInterval(interval); resolve(); }
    }, 100);
  });
}

async function initGIS() {
  const clientId = (window.SAIL_CONFIG || {}).GOOGLE_CLIENT_ID;
  if (!clientId || clientId.includes('YOUR_CLIENT_ID')) {
    console.warn('[DriveSync] No Google Client ID configured in config.js');
    return;
  }
  await waitForGIS();
  tokenClient = window.google.accounts.oauth2.initTokenClient({
    client_id: clientId,
    scope: SCOPE,
    callback: async (tokenResponse) => {
      if (tokenResponse.error) {
        console.error('[DriveSync] Token error:', tokenResponse.error);
        setSyncStatus('error');
        return;
      }
      saveToken(tokenResponse.access_token);
      isLoggedIn = true;
      // Fetch user profile
      const profile = await fetchUserInfo(tokenResponse.access_token);
      if (profile) { saveUserProfile(profile); setUserBadge(profile); }
      // Load Drive data
      const driveData = await loadFromDrive();
      if (driveData) applyDriveData(driveData);
      // Hide boot screen if it's still showing
      hideBoot();
    },
  });
  // Check for saved token & try silent sign-in
  const savedToken = loadToken();
  if (savedToken) {
    accessToken = savedToken;
    isLoggedIn = true;
    const savedProfile = loadUserProfile();
    if (savedProfile) setUserBadge(savedProfile);
    // Try to load from Drive with saved token
    setSyncStatus('syncing');
    try {
      const driveData = await loadFromDrive();
      if (driveData) applyDriveData(driveData);
    } catch (_) {
      // Token expired — clear and show boot
      clearToken();
      isLoggedIn = false;
      setSyncStatus('idle');
    }
  }
}

// ── Apply Drive data to app ────────────────────────────────────────────────

function applyDriveData(data) {
  if (!data) return;
  try {
    // applyData updates the LOCAL variables inside index.html (not just window.*)
    if (typeof window.applyData === 'function') {
      window.applyData(data);
    } else {
      if (Array.isArray(data.projects)) window.projects = data.projects.map(p => ({ ...p, history: p.history || [] }));
      if (Array.isArray(data.todos))    window.todos = data.todos;
      if (Array.isArray(data.hourEntries)) window.hourEntries = data.hourEntries;
      if (data.gdata) window.gdata = data.gdata;
    }
    if (data.profile) {
      try { localStorage.setItem('sm-profile', JSON.stringify(data.profile)); } catch (_) {}
      if (typeof window.applyProfile === 'function') window.applyProfile(data.profile);
    }
    // Re-persist to localStorage
    if (typeof window.persist === 'function') {
      window._skipDriveSync = true;
      window.persist();
      window._skipDriveSync = false;
    }
    // Re-render current view
    if (typeof window.renderDaily === 'function') window.renderDaily();
    if (typeof window.updateXPBar === 'function') window.updateXPBar();
    if (typeof window.checkAchievements === 'function') window.checkAchievements();
    console.log('[DriveSync] Data loaded from Drive ✓');
  } catch (err) {
    console.error('[DriveSync] applyDriveData error:', err);
  }
}

// ── Boot screen helpers ────────────────────────────────────────────────────

function hideBoot() {
  const boot = document.getElementById('boot-screen');
  if (!boot || boot.style.display === 'none') return;
  boot.style.transition = 'opacity .4s steps(4)';
  boot.style.opacity = '0';
  setTimeout(() => { boot.style.display = 'none'; }, 450);
}

// ── Public API ─────────────────────────────────────────────────────────────

window.driveSync = {
  /** Call this from the app's persist() */
  triggerSave() {
    if (isLoggedIn && !window._skipDriveSync) scheduleSave();
  },

  /** Called when user clicks LOGIN WITH GOOGLE */
  login() {
    if (!tokenClient) {
      alert('Google Client ID not configured.\n\nEdit config.js and set your GOOGLE_CLIENT_ID.');
      return;
    }
    tokenClient.requestAccessToken({ prompt: 'consent' });
  },

  /** Called when user clicks CONTINUE OFFLINE */
  continueOffline() {
    hideBoot();
    setSyncStatus('idle');
  },

  /** Called when user clicks LOGOUT */
  logout() {
    if (window.google && window.google.accounts && window.google.accounts.oauth2) {
      window.google.accounts.oauth2.revoke(accessToken, () => {});
    }
    clearToken();
    isLoggedIn = false;
    setUserBadge(null);
    setSyncStatus('idle');
    // Reload to boot screen
    location.reload();
  },

  get isLoggedIn() { return isLoggedIn; },
};

// ── Offline fallback: sync when connection returns ─────────────────────────

window.addEventListener('online', () => {
  if (isLoggedIn) {
    setSyncStatus('syncing');
    doSave();
  }
});

window.addEventListener('offline', () => {
  if (isLoggedIn) setSyncStatus('error');
});

// ── Bootstrap ─────────────────────────────────────────────────────────────
initGIS();
