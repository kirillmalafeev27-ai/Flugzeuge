'use strict';
/*
 * Zeppelin Defense — game backend.
 *
 * Why a backend at all? A browser game that renders with WebGL must ship its
 * code and 3D assets to the client, so it can never be made *impossible* to
 * inspect with devtools. What this server does is raise the bar:
 *
 *   - The game logic is served only as a minified IIFE bundle (no source maps).
 *   - The heavy GLB models + HDR sky are NOT statically reachable. They sit
 *     behind /asset/:name which requires a per-session token that is minted on
 *     page load, kept server-side, expires quickly, and is checked together
 *     with the Origin/Referer. Pasting an asset URL into a fresh tab, or curling
 *     it without the token, returns 403.
 *   - Round results are validated/recorded server-side via /api/score.
 *
 * This stops casual "save the .glb from the Network tab / open index.html
 * offline" copying. A determined user can still script the token flow — that is
 * an inherent limit of client-side rendering, not a bug.
 */
const express = require('express');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const { installQuizRoutes } = require('./quiz-generation.cjs');

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '8kb' }));
installQuizRoutes(app);

const PORT = process.env.PORT || 3000;
const ASSET_DIR = path.join(__dirname, 'assets');
const PUBLIC_DIR = path.join(__dirname, 'public');

// Map of allowed asset names -> file + mime. Anything not in here is unreachable.
const ASSETS = {
  'player_plane.glb': { file: 'player_plane.glb', mime: 'model/gltf-binary' },
  'enemy_ww1.glb':    { file: 'enemy_ww1.glb',    mime: 'model/gltf-binary' },
  'airship.glb':      { file: 'airship.glb',      mime: 'model/gltf-binary' },
  'machine_gun.glb':  { file: 'machine_gun.glb',  mime: 'model/gltf-binary' },
  'sky.hdr':          { file: 'sky.hdr',          mime: 'image/vnd.radiance' },
  // sound effects (clean URL names -> the real on-disk files)
  'gun_fire.mp3':     { file: 'ww_1_plane_machine_g_#1-1782748074091.mp3', mime: 'audio/mpeg' },
  'hit.mp3':          { file: 'machine_gun_fire_imp_#1-1782748284667.mp3', mime: 'audio/mpeg' },
  'engine.mp3':       { file: 'ww1_plane_sound_#4-1782747980234.mp3',      mime: 'audio/mpeg' },
  'wind.mp3':         { file: 'wind_sound_#4-1782748025121.mp3',           mime: 'audio/mpeg' },
};

// In-memory session token store: token -> { exp }
const TOKENS = new Map();
const TOKEN_TTL = 5 * 60 * 1000; // 5 minutes is plenty to load every asset.
function gcTokens() {
  const now = Date.now();
  for (const [t, v] of TOKENS) if (v.exp < now) TOKENS.delete(t);
}
setInterval(gcTokens, 60 * 1000).unref();

function mintToken() {
  const t = crypto.randomBytes(24).toString('hex');
  TOKENS.set(t, { exp: Date.now() + TOKEN_TTL });
  return t;
}

// Same-origin check: the request must come from our own page.
function sameOrigin(req) {
  const host = req.headers.host;
  const ref = req.headers.referer || req.headers.origin || '';
  if (!ref) return false;
  try { return new URL(ref).host === host; } catch { return false; }
}

// ---- page: inject a fresh token + cache-bust the bundle ----
let INDEX_HTML = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
app.get('/', (req, res) => {
  const token = mintToken();
  const html = INDEX_HTML.replace('__GAME_TOKEN__', token);
  res.set('Cache-Control', 'no-store');
  res.type('html').send(html);
});

// ---- minified game bundle (public, but unreadable-ish) ----
app.get('/bundle.js', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.type('application/javascript');
  res.sendFile(path.join(PUBLIC_DIR, 'bundle.js'));
});

app.use('/js', express.static(path.join(PUBLIC_DIR, 'js'), {
  etag: false,
  maxAge: 0,
  fallthrough: false,
  setHeaders(res) {
    res.set('Cache-Control', 'no-store');
  },
}));

// ---- token-gated assets ----
app.get('/asset/:name', (req, res) => {
  const token = req.get('x-game-token') || req.query.t;
  const entry = TOKENS.get(token);
  if (process.env.DEBUG_GATE) console.log('[asset]', req.params.name, 'tok?', !!entry, 'ref', req.headers.referer, 'origin', req.headers.origin, 'host', req.headers.host, 'so', sameOrigin(req));
  if (!entry || entry.exp < Date.now()) return res.status(403).send('forbidden');
  if (!sameOrigin(req)) return res.status(403).send('forbidden');
  const a = ASSETS[req.params.name];
  if (!a) return res.status(404).send('not found');
  res.set('Cache-Control', 'no-store');
  res.type(a.mime);
  res.sendFile(path.join(ASSET_DIR, a.file));
});

// ---- simple server-side score record (validated, in-memory) ----
const scores = [];
app.post('/api/score', (req, res) => {
  const { kills, won, survived } = req.body || {};
  if (typeof kills !== 'number' || kills < 0 || kills > 9999) {
    return res.status(400).json({ ok: false });
  }
  scores.push({ kills: kills | 0, won: !!won, survived: +survived || 0, at: Date.now() });
  if (scores.length > 500) scores.shift();
  const best = scores.reduce((m, s) => Math.max(m, s.kills), 0);
  res.json({ ok: true, best });
});

app.get('/api/health', (_req, res) => res.json({ ok: true }));

app.listen(PORT, () => console.log(`Zeppelin Defense running on :${PORT}`));
