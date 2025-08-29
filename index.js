const express = require('express');
const axios   = require('axios');
const cors    = require('cors');

const app  = express();
app.use(cors());
app.use(express.json());

// ========= CONFIG =========
const UPSTREAMS = (process.env.UPSTREAMS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

const PAGES_PER_MICRO    = parseInt(process.env.PAGES_PER_MICRO || '1', 10);
const TARGET_TOTAL       = parseInt(process.env.TARGET_TOTAL || '500', 10);
const MICROS_TIMEOUT_MS  = parseInt(process.env.MICROS_TIMEOUT_MS || '15000', 10);
const PAGE_DELAY_MS      = parseInt(process.env.PAGE_DELAY_MS || '200', 10);

// Reservas / visitados
const RESERVE_TTL_SECONDS = parseInt(process.env.RESERVE_TTL_SECONDS || '40', 10);
const VISITED_TTL_SECONDS = parseInt(process.env.VISITED_TTL_SECONDS || '180', 10);

// seguro extra: no devolvemos nada por encima de 6 (por si alguna micro no está actualizada)
const MAX_PLAYING_ALLOWED = 6;

const PORT = process.env.PORT || 8080;
// ==========================

const sleep = ms => new Promise(r => setTimeout(r, ms));

function shuffle(list) {
  for (let i = list.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [list[i], list[j]] = [list[j], list[i]];
  }
  return list;
}

function uniqById(list) {
  const map = new Map();
  for (const s of list) {
    if (s && s.id && !map.has(s.id)) map.set(s.id, s);
  }
  return [...map.values()];
}

// ====== Reserva / Visitado en memoria ======
const reserved = new Map(); // jobId -> { clientId, expiresAt }
const visited  = new Map(); // jobId -> expiresAt

function gc() {
  const now = Date.now();
  for (const [jobId, r] of reserved) {
    if (r.expiresAt <= now) reserved.delete(jobId);
  }
  for (const [jobId, exp] of visited) {
    if (exp <= now) visited.delete(jobId);
  }
}

function reserve(jobId, clientId) {
  const expiresAt = Date.now() + RESERVE_TTL_SECONDS * 1000;
  reserved.set(jobId, { clientId, expiresAt });
}

function release(jobId, clientId) {
  const r = reserved.get(jobId);
  if (!r) return;
  // soltamos si el mismo cliente lo pide, o si expiró
  if (r.clientId === clientId || r.expiresAt <= Date.now()) {
    reserved.delete(jobId);
  }
}

function markVisited(jobId) {
  visited.set(jobId, Date.now() + VISITED_TTL_SECONDS * 1000);
}

function isReserved(jobId) {
  const r = reserved.get(jobId);
  if (!r) return false;
  if (r.expiresAt <= Date.now()) {
    reserved.delete(jobId);
    return false;
  }
  return true;
}

function wasVisited(jobId) {
  const exp = visited.get(jobId);
  if (!exp) return false;
  if (exp <= Date.now()) {
    visited.delete(jobId);
    return false;
  }
  return true;
}

// ======== Fetch a micros ========

async function fetchPageFromMicro(baseUrl, cursor) {
  const url = `${baseUrl.replace(/\/+$/, '')}/servers`;
  const params = {};
  if (cursor) params.cursor = cursor;

  const { data } = await axios.get(url, { params, timeout: MICROS_TIMEOUT_MS });
  if (!data || !data.data || !Array.isArray(data.data.data)) {
    throw new Error(`Respuesta inesperada de micro ${baseUrl}`);
  }
  // seguridad extra por si la micro no filtró
  const filtered = data.data.data.filter(s => s && s.id && typeof s.playing === 'number' && s.playing <= MAX_PLAYING_ALLOWED);
  return {
    servers: filtered,
    nextCursor: data.data.nextPageCursor || null
  };
}

async function fetchFromOneMicro(baseUrl, pages) {
  let cursor = null;
  let list   = [];
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

  let all     = [];
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
  all = all.filter(s => s && s.id && typeof s.playing === 'number' && s.playing <= MAX_PLAYING_ALLOWED);
  all = uniqById(all);
  shuffle(all);
  if (all.length > TARGET_TOTAL) all = all.slice(0, TARGET_TOTAL);

  return { all, details };
}

// ======= Elección con reservas =======
function pickServer(list, clientId) {
  gc();
  shuffle(list);
  for (const s of list) {
    if (!s || !s.id) continue;
    if (isReserved(s.id)) continue;
    if (wasVisited(s.id)) continue;
    if (typeof s.playing !== 'number' || s.playing > MAX_PLAYING_ALLOWED) continue;
    // Reservar y devolver
    reserve(s.id, clientId);
    return s;
  }
  return null;
}

// ======= Endpoints =======

app.get('/', (req, res) => {
  res.json({
    ok: true,
    name: 'petfinder-main',
    upstreams: UPSTREAMS,
    config: {
      PAGES_PER_MICRO,
      TARGET_TOTAL,
      MICROS_TIMEOUT_MS,
      PAGE_DELAY_MS,
      RESERVE_TTL_SECONDS,
      VISITED_TTL_SECONDS,
      MAX_PLAYING_ALLOWED
    },
    endpoints: ['/servers', '/next (POST)', '/release (POST)', '/confirm (POST)', '/health']
  });
});

app.get('/health', (req, res) => {
  gc();
  res.json({
    status: "healthy",
    micros: UPSTREAMS.length,
    reserved: reserved.size,
    visited: visited.size,
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

// Para inspección manual del pool
app.get('/servers', async (req, res) => {
  try {
    const pages = parseInt(req.query.pages || PAGES_PER_MICRO, 10);
    const { all, details } = await fetchFromAllMicros(pages);
    res.json({
      ok: true,
      success: true,
      totalFetched: all.length,
      servers: all,
      sources: details,
      requestedPagesPerMicro: pages,
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    res.status(500).json({ ok:false, success:false, error: err.message, servers: [], totalFetched: 0 });
  }
});

// Devuelve un server exclusivo (reserva) para el cliente
app.post('/next', async (req, res) => {
  try {
    const clientId = String(req.body?.clientId || '').trim();
    const pages    = parseInt(req.body?.pages || PAGES_PER_MICRO, 10);
    if (!clientId) {
      return res.status(400).json({ ok:false, error: 'clientId requerido' });
    }

    const { all } = await fetchFromAllMicros(pages);
    const server  = pickServer(all, clientId);
    if (!server) {
      return res.json({ ok:true, server:null, note:'No server available right now' });
    }

    res.json({ ok: true, server });
  } catch (err) {
    res.status(500).json({ ok:false, error: err.message });
  }
});

// Libera la reserva si el TP falló
app.post('/release', (req, res) => {
  try {
    const clientId = String(req.body?.clientId || '').trim();
    const jobId    = String(req.body?.jobId || '').trim();
    if (!clientId || !jobId) {
      return res.status(400).json({ ok:false, error: 'clientId y jobId requeridos' });
    }
    release(jobId, clientId);
    res.json({ ok:true });
  } catch (err) {
    res.status(500).json({ ok:false, error: err.message });
  }
});

// Marca como visitado (evita duplicados entre cuentas)
app.post('/confirm', (req, res) => {
  try {
    const clientId = String(req.body?.clientId || '').trim();
    const jobId    = String(req.body?.jobId || '').trim();
    if (!clientId || !jobId) {
      return res.status(400).json({ ok:false, error: 'clientId y jobId requeridos' });
    }
    // liberar si estaba reservado y marcar visitado
    reserved.delete(jobId);
    markVisited(jobId);
    res.json({ ok:true });
  } catch (err) {
    res.status(500).json({ ok:false, error: err.message });
  }
});

app.use('*', (_, res) => res.status(404).json({ ok:false, error:'Not found' }));

app.listen(PORT, () => {
  console.log(`Main API listening on :${PORT}`);
});
