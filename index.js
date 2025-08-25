const express = require("express");
const cors = require("cors");
const axios = require("axios");

const app = express();
app.use(cors());

const PLACE_ID = +(process.env.PLACE_ID || "109983668079237");
const DEFAULT_TARGET = +(process.env.TARGET_COUNT || "500");
const PER_PAGE = 100;
const PAGE_DELAY_MS = +(process.env.PAGE_DELAY_MS || "120");
const CACHE_TTL_MS = +(process.env.CACHE_TTL_MS || "120000");

let lastCache = { when: 0, key: "", payload: null };

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = (Math.random() * (i + 1)) | 0;
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

async function fetchPage(placeId, cursor = null) {
  const url =
    `https://games.roblox.com/v1/games/${placeId}/servers/Public?sortOrder=Asc&limit=${PER_PAGE}` +
    (cursor ? `&cursor=${encodeURIComponent(cursor)}` : "");
  const { data } = await axios.get(url, {
    timeout: 15000,
    headers: {
      "user-agent":
        "Mozilla/5.0 (compatible; PetFinder/1.0; +https://railway.app/)",
      accept: "application/json",
    },
  });
  return data;
}

async function fetchServersFresh(placeId, targetCount) {
  const out = [];
  const seen = new Set();
  let cursor = null;

  while (out.length < targetCount) {
    const page = await fetchPage(placeId, cursor);
    const data = Array.isArray(page?.data) ? page.data : [];

    for (const s of data) {
      if (!s || !s.id) continue;
      if (seen.has(s.id)) continue;
      seen.add(s.id);
      if (typeof s.playing === "number" && typeof s.maxPlayers === "number") {
        out.push({
          id: s.id,
          maxPlayers: s.maxPlayers,
          playing: s.playing,
          players: [], // compat
        });
      }
      if (out.length >= targetCount) break;
    }

    if (!page.nextPageCursor) break;
    cursor = page.nextPageCursor;
    await sleep(PAGE_DELAY_MS);
  }
  return out;
}

app.get("/", (req, res) => {
  res.json({
    ok: true,
    service: "petfinder-api",
    endpoints: ["/servers", "/health"],
    placeId: PLACE_ID,
  });
});

app.get("/health", (req, res) => {
  res.json({ ok: true, status: "healthy", time: Date.now() });
});

app.get("/servers", async (req, res) => {
  try {
    const placeId = +(req.query.placeId || PLACE_ID);
    const wanted = Math.max(
      1,
      Math.min(+req.query.count || DEFAULT_TARGET, 500)
    );
    const onlyJoinable =
      String(req.query.onlyJoinable || "1") === "1" ? true : false;
    const doShuffle = String(req.query.shuffle || "1") === "1";
    const bypass = String(req.query.fresh || "0") === "1";

    const cacheKey = `${placeId}:${wanted}:${onlyJoinable}:${doShuffle}`;
    const now = Date.now();
    if (!bypass && lastCache.payload && lastCache.key === cacheKey && now - lastCache.when < CACHE_TTL_MS) {
      return res.json(lastCache.payload);
    }

    let list = await fetchServersFresh(placeId, wanted * 2);
    if (onlyJoinable) {
      list = list.filter((s) => s.playing < s.maxPlayers);
    }
    if (doShuffle) shuffle(list);
    list = list.slice(0, wanted);

    const payload = {
      ok: true,
      success: true,
      totalFetched: list.length,
      servers: list,
    };

    lastCache = { when: now, key: cacheKey, payload };
    res.json(payload);
  } catch (err) {
    res.status(500).json({
      ok: false,
      success: false,
      error: String(err && err.message ? err.message : err),
      servers: [],
      totalFetched: 0,
    });
  }
});

const PORT = process.env.PORT || process.env.RAILWAY_TCP_PORT || 8080;
app.listen(PORT, () => {
  console.log("petfinder-api listening on", PORT);
});
