# SAIL.MGR

Nautical project management app with Google Drive sync.

## Setup

### 1. Google Cloud Console

1. Go to https://console.cloud.google.com
2. Create new project → **SAIL.MGR**
3. APIs & Services → Enable **Google Drive API**
4. APIs & Services → Credentials → Create **OAuth 2.0 Client ID**
   - Application type: **Web application**
   - Authorized JavaScript origins:
     - `http://localhost:8080`
     - `https://YOUR-SITE.netlify.app`
5. Copy the **Client ID**

### 2. Configure the app

Edit `config.js`:

```js
window.SAIL_CONFIG = {
  GOOGLE_CLIENT_ID: 'PASTE_YOUR_CLIENT_ID_HERE.apps.googleusercontent.com'
};
```

### 3. Run locally

```bash
npx serve .
# open http://localhost:3000
```

Or just open `index.html` directly in Chrome (OAuth won't work from `file://` — use a local server).

### 4. Deploy to Netlify

1. Drag the project folder onto https://app.netlify.com/drop
2. Copy the Netlify URL (e.g. `https://sail-mgr-abc123.netlify.app`)
3. Add it to **Authorized JavaScript origins** in Google Cloud Console
4. Re-deploy

## How sync works

- Login with Google → OAuth token stored in localStorage
- Every save → debounced write to `sail-mgr-data.json` in Drive appDataFolder (hidden from user)
- On open → reads Drive data and merges with local
- Offline → saves locally, syncs when back online
- Sync indicator in topbar: ✓ SYNCED / ⟳ SYNCING / ✗ ERROR
