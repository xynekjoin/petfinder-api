const express = require('express');
const fetch = require('node-fetch');

const app = express();
const PORT = process.env.PORT || 3000;

// Solo este placeId
const PLACE_ID = 109983668079237;

const CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutos
const PER_PLACE_LIMIT = 500;
const PAGE_LIMIT = 100;
const PAGE_SLEEP_MS = 120;
const RETRY_SLEEP_MS = 400;
const MAX_PAGES = 80;
const REQUIRE_FREE_SLOTS = true;

let cache = { expiresAt: 0, servers: [] };

function sleep(ms) {
  return new Promise(res => setTimeout(res, ms));
}

async function fetchRobloxPage(placeId, cursor) {
  const url = new URL(`https://games.roblox.com/v1/games/${placeId}/servers/Public`);
  url.searchParams.set('sortOrder', 'Asc');
  url.searchParams.set('limit', PAGE_LIMIT.toString());
  if (cursor) url.searchParams.set('cursor', cursor);

  try {
    const resp = await fetch(url.toString(), {
      method: 'GET',
      headers: { 'accept': 'application/json' },
      timeout: 15000
    });
    if (!resp.ok) return { ok: false, status: resp.status };
    const data = await resp.json();
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function normalizeServers(list) {
  const out = [];
  for (const s of list || []) {
    if (!s || !s.id) continue;
    out.push({
      id: s.id,
      maxPlayers: s.maxPlayers || 0,
      playing: s.playing || 0
    });
  }
  return out;
}

function uniqueById(arr) {
  const m = new Map();
  for (const s of arr) {
    if (!m.has(s.id)) m.set(s.id, s);
  }
  return Array.from(m.values());
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

async function collectServers() {
  const collected = [];
  let cursor = undefined;
  let pages = 0;

  while (collected.length < PER_PLACE_LIMIT && pages < MAX_PAGES) {
    const r = await fetchRobloxPage(PLACE_ID, cursor);
    if (!r.ok || !r.data || !Array.isArray(r.data.data)) {
      await sleep(RETRY_SLEEP_MS);
      pages++;
      continue;
    }

    const batch = normalizeServers(r.data.data).filter(s => {
      return REQUIRE_FREE_SLOTS ? (s.playing < s.maxPlayers) : true;
    });

    for (const s of batch) {
      if (collected.length < PER_PLACE_LIMIT) collected.push(s);
      else break;
    }

    cursor = r.data.nextPageCursor || null;
    pages++;
    if (!cursor) break;

    await sleep(PAGE_SLEEP_MS);
  }

  return collected;
}

async function refreshCache() {
  let servers = await collectServers();
  servers = shuffle(servers);
  servers = uniqueById(servers);
  if (servers.length > 500) servers = servers.slice(0, 500);

  cache.servers = servers;
  cache.expiresAt = Date.now() + CACHE_TTL_MS;
  return servers;
}

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    status: 'up',
    cachedCount: cache.servers.length,
    expiresIn: Math.max(0, cache.expiresAt - Date.now())
  });
});

app.get('/servers', async (req, res) => {
  const now = Date.now();

  if (cache.expiresAt > now && cache.servers.length > 0) {
    res.json({ ok: true, success: true, totalFetched: cache.servers.length, servers: cache.servers });
    return;
  }

  try {
    const fresh = await refreshCache();
    res.json({ ok: true, success: true, totalFetched: fresh.length, servers: fresh });
  } catch (e) {
    res.status(500).json({ ok: false, success: false, error: e.message });
  }
});

app.listen(PORT, () => {
  console.log('listening on', PORT);
});
