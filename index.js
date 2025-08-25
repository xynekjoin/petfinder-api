// index.js
const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app  = express();
const PORT = process.env.PORT || 8080;

app.use(cors());
app.use(express.json());

// --------- CONFIG ----------
const PLACE_ID     = 109983668079237;  // único place
const TARGET_COUNT = 500;              // servidores por ciclo
const PER_PAGE     = 100;              // roblox máximo
const REFRESH_MS   = 15 * 60 * 1000;   // 15 minutos
const BASE         = 'https://games.roblox.com/v1/games';
// ---------------------------

let cache = { servers: [], updatedAt: 0 };
let fetching = false;
let waiters  = [];

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function getRobloxPage(cursor, attempt = 1) {
  const url = `${BASE}/${PLACE_ID}/servers/Public`;
  try {
    const { data } = await axios.get(url, {
      timeout: 12000,
      params: {
        limit: PER_PAGE,
        sortOrder: 'Asc',       // 'Desc' también sirve; Asc suele ser más estable
        cursor: cursor || undefined,
        excludeFullGames: true
      },
      headers: {
        'Accept': 'application/json, text/plain, */*',
        'Origin': 'https://www.roblox.com',
        'Referer': `https://www.roblox.com/games/${PLACE_ID}`,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36'
      }
    });
    return data;
  } catch (err) {
    const status = err.response?.status;
    // reintentos con backoff para 429/5xx
    if ((status === 429 || status >= 500) && attempt < 8) {
      const wait = Math.min(2000 * attempt + Math.random() * 800, 8000);
      await sleep(wait);
      return getRobloxPage(cursor, attempt + 1);
    }
    throw err;
  }
}

async function collectServers() {
  const out  = [];
  const seen = new Set();
  let cursor = undefined;

  while (out.length < TARGET_COUNT) {
    const page = await getRobloxPage(cursor);
    const list = Array.isArray(page?.data) ? page.data : [];
    for (const s of list) {
      if (!s?.id || seen.has(s.id)) continue;
      if (typeof s.playing === 'number' && typeof s.maxPlayers === 'number') {
        if (s.playing >= s.maxPlayers) continue;
      }
      seen.add(s.id);
      out.push({
        id: s.id,
        maxPlayers: s.maxPlayers,
        playing: s.playing,
        ping: s.ping,
        fps: s.fps
      });
      if (out.length >= TARGET_COUNT) break;
    }
    cursor = page?.nextPageCursor || null;
    if (!cursor) break;
    await sleep(220); // throttle suave
  }
  return out;
}

async function refresh() {
  if (fetching) return new Promise(r => waiters.push(r));
  fetching = true;
  try {
    const servers = await collectServers();
    cache = { servers, updatedAt: Date.now() };
    console.log(`[refresh] fetched: ${servers.length}`);
  } finally {
    fetching = false;
    while (waiters.length) waiters.shift()();
  }
}

// cron
setInterval(() => refresh().catch(()=>{}), REFRESH_MS);
// primer warm up
refresh().catch(e => console.log('warm-up error:', e?.message || e));

// ---------- ROUTES ----------
app.get('/', (_req, res) => {
  res.json({
    ok: true,
    name: 'petfinder-api',
    placeId: PLACE_ID,
    refreshEachMs: REFRESH_MS,
    target: TARGET_COUNT,
    endpoints: ['/servers', '/health']
  });
});

app.get('/health', (_req, res) => {
  res.json({
    status: 'healthy',
    totalCached: cache.servers.length,
    updatedAt: cache.updatedAt,
    uptime: process.uptime()
  });
});

app.get('/servers', async (req, res) => {
  const force = String(req.query.refresh || '') === '1';
  try {
    if (force) {
      await refresh();
    } else if (Date.now() - cache.updatedAt > REFRESH_MS * 1.5 || cache.servers.length === 0) {
      refresh().catch(()=>{});
    }
    res.json({
      ok: true,
      success: true,
      totalFetched: cache.servers.length,
      servers: cache.servers,
      updatedAt: cache.updatedAt
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      success: false,
      error: err?.message || String(err),
      servers: [],
      totalFetched: 0,
      updatedAt: cache.updatedAt || 0
    });
  }
});

app.use('*', (_req, res) => res.status(404).json({ ok:false, error:'not_found' }));

app.listen(PORT, () => console.log(`petfinder-api listening on ${PORT}`));
module.exports = app;
