const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

const ROBLOX_API_BASE = 'https://games.roblox.com/v1/games';
const MAX_SERVERS = 100;
const PLACE_ID = 109983668079237
const PLACE_ID_2 = 96342491571673

async function getRobloxServers(placeId, cursor = '') {
    try {
        const url = `${ROBLOX_API_BASE}/${placeId}/servers/Public`;
        const params = {
            limit: MAX_SERVERS,
            sortOrder: 'Des',
            cursor: cursor || undefined,
            excludeFullGames: true
        };

        Object.keys(params).forEach(key => params[key] === undefined && delete params[key]);

        const response = await axios.get(url, {
            params,
            timeout: 10000,
            headers: {
                'User-Agent': 'Roblox-Servers-MicroAPI/1.0',
                'Accept': 'application/json'
            }
        });

        return response.data;
    } catch (error) {
        console.error('Error fetching Roblox servers:', error.message);
        throw new Error(`Failed to fetch servers: ${error.response?.data?.message || error.message}`);
    }
}

app.get('/', (req, res) => {
    res.json({
        message: 'Roblox Servers MicroAPI',
        endpoints: {
            getServers: 'GET /servers/:placeId',
            health: 'GET /health'
        },
        documentation: 'Use /servers/:placeId para obtener servidores de un place especÃ­fico'
    });
});

// Ruta de health check
app.get('/health', (req, res) => {
    res.json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        uptime: process.uptime()
    });
});

app.get('/servers', async (req, res) => {
    const { cursor } = req.query;

    try {
        console.log(`Fetching servers...`);
        const serversData = await getRobloxServers(PLACE_ID, cursor);
        res.json({
            success: true,
            data: serversData,
            timestamp: new Date().toISOString()
        });

    } catch (error) {
        console.error(`Error for place ${placeId}:`, error.message);

        res.status(500).json({
            success: false,
            error: error.message,
            placeId: parseInt(placeId),
            timestamp: new Date().toISOString()
        });
    }
});

app.use('*', (req, res) => {
    res.status(404).json({
        error: 'Endpoint not found',
        message: 'Check the documentation at the root endpoint'
    });
});

app.listen(PORT, () => {
    console.log(`ðŸš€ Roblox Servers MicroAPI running on port ${PORT}`);
    console.log(`ðŸ“š Documentation: http://localhost:${PORT}`);
});

module.exports = app;
