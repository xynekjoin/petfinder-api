const express = require("express");
const fetch = require("node-fetch");

const app = express();
const PORT = process.env.PORT || 8080;

const PLACE_ID = process.env.PLACE_ID || "109983668079237";
const MAX_TOTAL = 500;
const PAGE_LIMIT = 100;
const REFRESH_EVERY_MS = 15 * 60 * 1000;

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36";

let cache = {
  ok: true,
  success: true,
  totalFetched: 0,
  servers: [],
  updatedAt: 0,
};

function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchPage(placeId, cursor) {
  const url = `https://games.roblox.com/v1/games/${placeId}/servers/Public?sortOrder=Asc&limit=${PAGE_LIMIT}${
    cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""
  }`;

  // Ritmo: 1 request/1200ms
  await wait(1200);

  let tries = 0;
  while (tries < 5) {
    try {
      const res = await fetch(url, {
        headers: {
          "user-agent": UA,
          accept: "application/json",
        },
      });

      if (res.status === 429) {
        tries++;
        await wait(2000 * tries);
        continue;
      }

      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }

      const data = await res.json();
      return {
        data: Array.isArray(data.data) ? data.data : [],
        next: data.nextPageCursor || null,
      };
    } catch (e) {
      tries++;
      await wait(1500 * tries);
      if (tries >= 5) throw e;
    }
  }
}

async function collectServers(placeId) {
  let collected = [];
  const seen = new Set();
  let cursor = null;

  while (collected.length < MAX_TOTAL) {
    const page = await fetchPage(placeId, cursor);
    cursor = page.next;

    for (const s of page.data) {
      if (!s || !s.id || seen.has(s.id)) continue;
      // Solo servidores públicos no llenos
      if (s.playing < s.maxPlayers) {
        seen.add(s.id);
        collected.push({
          id: s.id,
          maxPlayers: s.maxPlayers,
          playing: s.playing,
        });
        if (collected.length >= MAX_TOTAL) break;
      }
    }

    if (!cursor) break;
  }

  return collected;
}

async function refresh() {
  try {
    const servers = await collectServers(PLACE_ID);
    cache = {
      ok: true,
      success: true,
      totalFetched: servers.length,
      servers,
      updatedAt: Date.now(),
    };
  } catch (e) {
    cache = {
      ok: false,
      success: false,
      error: String(e && e.message ? e.message : e),
      servers: [],
      totalFetched: 0,
      updatedAt: Date.now(),
    };
  }
}

app.get("/", (_req, res) => {
  res.json({
    ok: true,
    success: true,
    message: "petfinder-api",
    placeId: PLACE_ID,
    updatedAt: cache.updatedAt,
  });
});

app.get("/servers", async (_req, res) => {
  const stale = Date.now() - cache.updatedAt > REFRESH_EVERY_MS;
  if (stale || !cache.updatedAt) {
    await refresh();
  }
  res.json(cache);
});

app.listen(PORT, async () => {
  await refresh();
  setInterval(refresh, REFRESH_EVERY_MS);
});
