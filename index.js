const express = require('express');
const axios   = require('axios');
const cors    = require('cors');

const app  = express();
app.use(cors());
app.use(express.json());

const UPSTREAMS = (process.env.UPSTREAMS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

const PAGES_PER_MICRO   = parseInt(process.env.PAGES_PER_MICRO || '1', 10);
const TARGET_TOTAL      = parseInt(process.env.TARGET_TOTAL || '500', 10);
const MICROS_TIMEOUT_MS = parseInt(process.env.MICROS_TIMEOUT_MS || '15000', 10);
const PAGE_DELAY_MS     = parseInt(process.env.PAGE_DELAY_MS || '250', 10);

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
  const servers = (data.data.data || []).filter(s =>
    Number(s.playing || 0) <= 7 && Number(s.playing || 0) < Number(s.maxPlayers || 8)
  );

  return {
    servers,
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

  all = all.filter(s => Number(s.playing || 0) <= 7 && Number(s.playing || 0) < Number(s.maxPlayers || 8));
  all = uniqById(all);
  shuffle(all);
  if (all.length > TARGET_TOTAL) all = all.slice(0, TARGET_TOTAL);

  return { all, details };
}

app.get('/', (req, res) => {
  res.json({
    ok: true,
    name: 'petfinder-main',
    upstreams: UPSTREAMS,
    config: {
      PAGES_PER_MICRO,
      TARGET_TOTAL,
      MICROS_TIMEOUT_MS,
      PAGE_DELAY_MS
    },
    endpoints: ['/servers', '/health']
  });
});

app.get('/health', async (req, res) => {
  res.json({
    status: "healthy",
    micros: UPSTREAMS.length,
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

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

app.use('*', (_, res) => res.status(404).json({ ok:false, error:'Not found' }));

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Main API listening on :${PORT}`));
