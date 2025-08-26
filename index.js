const express = require('express');
const axios   = require('axios');
const cors    = require('cors');

const app  = express();
app.use(cors());
app.use(express.json());

// ============ CONFIG ============
const UPSTREAMS = (process.env.UPSTREAMS || '').split(',').map(s => s.trim()).filter(Boolean);
const PAGES_PER_MICRO = parseInt(process.env.PAGES_PER_MICRO || '1', 10);
const TARGET_TOTAL    = parseInt(process.env.TARGET_TOTAL || '500', 10);
const MICROS_TIMEOUT_MS = parseInt(process.env.MICROS_TIMEOUT_MS || '15000', 10);
const PAGE_DELAY_MS     = parseInt(process.env.PAGE_DELAY_MS || '300', 10);

// memoria para reservas
const reservations = new Map(); // jobId -> clientId
const usedServers  = new Set(); // jobIds bloqueados

// ============ HELPERS ============
function shuffle(array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
}
function uniqById(list) {
  const map = new Map();
  for (const s of list) {
    if (s && s.id && !map.has(s.id)) map.set(s.id, s);
  }
  return [...map.values()];
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fetchPageFromMicro(baseUrl, cursor) {
  const url = `${baseUrl.replace(/\/+$/,'')}/servers`;
  const params = {};
  if (cursor) params.cursor = cursor;

  const { data } = await axios.get(url, { params, timeout: MICROS_TIMEOUT_MS });
  if (!data || !data.data || !Array.isArray(data.data.data)) {
    throw new Error(`Respuesta inesperada de micro ${baseUrl}`);
  }
  return {
    servers: data.data.data,
    nextCursor: data.data.nextPageCursor || null
  };
}

async function fetchFromOneMicro(baseUrl, pages) {
  let cursor = null;
  let list = [];
  for (let i = 0; i < pages; i++) {
    const { servers, nextCursor } = await fetchPageFromMicro(baseUrl, cursor);
    list = list.concat(servers);
    if (!nextCursor) break;
    cursor = nextCursor;
    await sleep(PAGE_DELAY_MS);
  }
  return list;
}

async function fetchFromAllMicros(pagesPerMicro) {
  if (!UPSTREAMS.length) throw new Error("No hay micro-APIs configuradas (UPSTREAMS)");

  const promises = UPSTREAMS.map(u => fetchFromOneMicro(u, pagesPerMicro));
  const settled  = await Promise.allSettled(promises);

  let all = [];
  const details = [];

  for (let i = 0; i < settled.length; i++) {
    const src = UPSTREAMS[i];
    const r   = settled[i];

    if (r.status === 'fulfilled') {
      all = all.concat(r.value);
      details.push({ source: src, ok: true, count: r.value.length });
    } else {
      details.push({ source: src, ok: false, error: r.reason?.message || String(r.reason) });
    }
  }

  all = uniqById(all);
  shuffle(all);
  if (all.length > TARGET_TOTAL) all = all.slice(0, TARGET_TOTAL);

  return { all, details };
}

// ============ ROUTES ============
app.get('/', (req, res) => {
  res.json({
    ok: true,
    name: 'petfinder-main',
    upstreams: UPSTREAMS,
    endpoints: ['/servers', '/next', '/release', '/health']
  });
});

app.get('/health', (req, res) => {
  res.json({
    status: "healthy",
    micros: UPSTREAMS.length,
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

// --- Devuelve lista normal de servers (pool combinado)
app.get('/servers', async (req, res) => {
  try {
    const pages = parseInt(req.query.pages || PAGES_PER_MICRO, 10);
    const { all, details } = await fetchFromAllMicros(pages);
    res.json({ ok: true, servers: all, sources: details });
  } catch (err) {
    res.status(500).json({ ok:false, error: err.message, servers: [] });
  }
});

// --- Reserva un server exclusivo para un cliente
app.post('/next', async (req, res) => {
  const clientId = req.body.clientId;
  if (!clientId) return res.status(400).json({ ok:false, error:"Missing clientId" });

  try {
    const { all } = await fetchFromAllMicros(1);
    for (const s of all) {
      if (!usedServers.has(s.id) && s.playing < s.maxPlayers) {
        reservations.set(s.id, clientId);
        usedServers.add(s.id);
        return res.json({ ok:true, server:s });
      }
    }
    res.json({ ok:false, error:"No available servers" });
  } catch (e) {
    res.status(500).json({ ok:false, error:e.message });
  }
});

// --- Libera un server reservado
app.post('/release', (req, res) => {
  const { clientId, jobId } = req.body;
  if (!clientId || !jobId) return res.status(400).json({ ok:false, error:"Missing clientId or jobId" });

  if (reservations.get(jobId) === clientId) {
    reservations.delete(jobId);
    usedServers.delete(jobId);
    return res.json({ ok:true, released:jobId });
  }
  res.json({ ok:false, error:"Reservation not found or not owned by this client" });
});

// --- 404
app.use('*', (_, res) => res.status(404).json({ ok:false, error:'Not found' }));

// --- Boot
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Main API listening on :${PORT}`));
