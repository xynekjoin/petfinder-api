const express = require("express");
const fetch = require("node-fetch");

const app = express();
const PORT = process.env.PORT || 3000;

let cachedServers = [];
let lastFetch = 0;

// Función para traer servidores frescos desde Roblox
async function fetchServers() {
  console.log("🔄 Fetching 500 servers from Roblox...");

  let servers = [];
  let cursor = null;
  try {
    while (servers.length < 500) {
      const url = `https://games.roblox.com/v1/games/109983668079237/servers/Public?sortOrder=Asc&limit=100${
        cursor ? `&cursor=${cursor}` : ""
      }`;

      const res = await fetch(url);
      if (!res.ok) throw new Error("Failed to fetch Roblox API");
      const data = await res.json();

      if (data && data.data) {
        servers = servers.concat(data.data);
        cursor = data.nextPageCursor;
        if (!cursor) break; // no hay más páginas
      } else {
        break;
      }
    }

    // Limitar a 500
    cachedServers = servers.slice(0, 500);
    lastFetch = Date.now();
    console.log(`✅ Cached ${cachedServers.length} servers`);
  } catch (err) {
    console.error("❌ Error fetching servers:", err);
  }
}

// Endpoint público
app.get("/servers", (req, res) => {
  res.json({
    ok: true,
    success: true,
    totalFetched: cachedServers.length,
    servers: cachedServers,
    lastUpdate: new Date(lastFetch).toISOString(),
  });
});

// Arranque y refresco cada 15 min
app.listen(PORT, async () => {
  console.log(`🚀 API running on port ${PORT}`);
  await fetchServers(); // primer fetch al iniciar
  setInterval(fetchServers, 15 * 60 * 1000); // refresco cada 15 min
});
