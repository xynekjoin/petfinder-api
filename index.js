// Adaptado para: 500 servidores frescos cada 15 minutos
// Basado en la estructura original 

const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app  = express();
const PORT = process.env.PORT || 8080;

app.use(cors());
app.use(express.json());

const PLACE_ID        = 109983668079237;          // único place
const PER_PAGE        = 100;                      // Roblox máx 100
const TARGET_TOTAL    = 500;                      // 500 por ciclo
const REFRESH_MS      = 15 * 60 * 1000;           // 15 minutos
const ROBLOX_ENDPOINT = `https://games.roblox.com/v1/games/${PLACE_ID}/servers/Public`;

let cache = { servers: [], updatedAt: 0 };
let isRefreshing = false;
let waiters = [];

// util: dormir ms
const delay = (ms) => new Promise(r => setTimeout(r, ms));

// request de una página con reintentos/backoff (maneja 429/5xx)
async function getPage(cursor, tryNo = 1) {
  const params = {
    limit: PER_PAGE,
    sortOrder: 'Asc',
    cursor: cursor || undefined,
    excludeFullGames: true
  };

  try {
    const { data } = await axios.get(ROBLOX_ENDPOINT, {
      params,
      timeout: 12000,
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'petfinder-api/1.0 (+railway)'
      }
    });
    return data;
  } catch (e) {
    const status = e.response && e.response.status;
    if ((status === 429 || status >= 500) && tryNo < 6) {
      const wait = Math.min(2000 * tryNo, 8000);
      await delay(wait);
      return getPage(cursor, tryNo + 1);
    }
    throw e;
  }
}

// recolector: junta hasta 500 o finaliza si no hay más
async function collectServers() {
  const list = [];
  const seen = new Set();
  let cursor = undefined;

  while (list.length < TARGET_TOTAL) {
    const page = await getPage(cursor);
    if (!page || !Array.isArray(page.data)) break;

    for (const s of page.data) {
      if (!s || !s.id) continue;
      if (seen.has(s.id)) continue;
      // evitar llenos, y preferir jugables
      if (typeof s.playing === 'number' && typeof s.maxPlayers === 'number') {
        if (s.playing >= s.maxPlayers) continue;
      }
      seen.add(s.id);
      list.push({
        id: s.id,
        maxPlayers: s.maxPlayers,
        playing: s.playing,
        ping: s.ping,
        fps: s.fps
      });
      if (list.length >= TARGET_TOTAL) break;
    }

    cursor = page.nextPageCursor;
    if (!cursor) break;
    await delay(200); // pequeña pausa para no spamear
  }

  return list;
}

// refresco (con lock + espera para peticiones concurrentes)
async function refreshNow() {
  if (isRefreshing) {
    return new Promise(resolve => waiters.push(resolve));
  }
  isRefreshing = true;
  try {
    const servers = await collectServers();
    cache = { servers, updatedAt: Date.now() };
  } finally {
    isRefreshing = false;
    while (waiters.length) waiters.shift()();
  }
}

// cron: cada 15 minutos
setInterval(() => refreshNow().catch(()=>{}), REFRESH_MS);
// primer warm-up en arranque
refreshNow().catch(()=>{});

// endpoints
app.get('/', (req, res) => {
  res.json({
    ok: true,
    name: 'petfinder-api',
    placeId: PLACE_ID,
    refreshEachMs: REFRESH_MS,
    target: TARGET_TOTAL,
    endpoints: ['/servers', '/health']
  });
});

app.get('/health', (_req, res) => {
  res.json({
    status: 'healthy',
    updatedAt: cache.updatedAt,
    totalCached: cache.servers.length,
    uptime: process.uptime()
  });
});

app.get('/servers', async (req, res) => {
  const wantRefresh = String(req.query.refresh || '').trim() === '1';

  try {
    if (wantRefresh) {
      await refreshNow();
    } else if (Date.now() - cache.updatedAt > REFRESH_MS * 1.5 || cache.servers.length === 0) {
      // caché viejo o vacío → refresco no-bloqueante
      refreshNow().catch(()=>{});
    }

    res.json({
      ok: true,
      success: true,
      totalFetched: cache.servers.length,
      servers: cache.servers,
      updatedAt: cache.updatedAt
    });
  } catch (e) {
    res.status(500).json({
      ok: false,
      success: false,
      error: e.message || String(e),
      servers: [],
      totalFetched: 0,
      updatedAt: cache.updatedAt || 0
    });
  }
});

app.use('*', (_req, res) => {
  res.status(404).json({ ok:false, error:'not_found' });
});

app.listen(PORT, () => {
  console.log(`petfinder-api listening on ${PORT}`);
});

module.exports = app;
