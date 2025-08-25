import express from "express";
import fetch from "node-fetch";

const app = express();

app.get("/servers", async (req, res) => {
  try {
    const url = "https://games.roblox.com/v1/games/109983668079237/servers/Public?sortOrder=Asc&limit=100";
    const response = await fetch(url);
    const data = await response.json();
    res.json({ ok: true, totalFetched: data.data.length, servers: data.data });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Worker API running on port ${PORT}`));
