const express = require('express');
const fetch = require('node-fetch');
const { Redis } = require('@upstash/redis');
const cron = require('node-cron');

// =============================================================================
// CONFIGURATION
// =============================================================================

const CONFIG = {
    TRAKT_API_KEY: '1ad94277c08d8bfccd4fca5ced267e3fa0961ad5ec5aa0a27239b3fc759e2372',
    MDBLIST_API_KEY: 'qplsb84vmulwetxrtghsp6u0q',
    DEFAULT_RPDB_KEY: 't0-free-rpdb',
    
    POSTER_CACHE_DAYS: 30,
    
    PORT: process.env.PORT || 3000,
    REQUEST_TIMEOUT: 8000,
};

// Initialize Redis
const redis = new Redis({
    url: process.env.UPSTASH_REDIS_REST_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

// =============================================================================
// CATALOG DEFINITIONS
// =============================================================================

const ALL_CATALOGS = {
    'trakt_prime_movies': { 
        type: "movie",
        name: "Prime Video Movies (Top 10 India)",
        fetcher: () => fetchTraktList('akashbahetra', 'top-india-amazon-prime-video-movies')
    },
    'trakt_prime_shows': { 
        type: "series",
        name: "Prime Video Shows (Top 10 India)",
        fetcher: () => fetchTraktList('akashbahetra', 'top-india-amazon-prime-video-shows')
    },
    'trakt_netflix_movies': { 
        type: "movie",
        name: "Netflix Movies (Top 10 India)",
        fetcher: () => fetchTraktList('akashbahetra05', 'top-india-netflix-movies')
    },
    'trakt_netflix_shows': { 
        type: "series",
        name: "Netflix Shows (Top 10 India)",
        fetcher: () => fetchTraktList('akashbahetra05', 'top-india-netflix-shows')
    },
    'trakt_zee5_overall': { 
        type: "series",
        name: "Zee5 Top Shows (India)",
        fetcher: () => fetchTraktList('semicolumn', 'top-india-zee5-overall')
    },
    'trakt_hotstar_overall': { 
        type: "series",
        name: "Hotstar Top Shows (India)",
        fetcher: () => fetchTraktList('semicolumn', 'top-india-hotstar-overall')
    },
    'mdblist_latest_movies': { 
        type: "movie",
        name: "Latest 100 Movies (India)",
        fetcher: () => fetchMDBList(120954, 'movie')
    },
    'mdblist_latest_series': { 
        type: "series",
        name: "Latest 100 Shows (India)",
        fetcher: () => fetchMDBList(120955, 'series')
    }
};

// =============================================================================
// UTILITY FUNCTIONS
// =============================================================================

function decodeConfig(configBase64) {
    try {
        const configStr = Buffer.from(configBase64, 'base64').toString('utf-8');
        return JSON.parse(configStr);
    } catch (err) {
        return null;
    }
}

function buildManifest(catalogs) {
    return {
        id: "com.semicolon.indian-ott-catalogs",
        version: "1.0.0",
        name: "Indian OTT Catalogs",
        description: "Curated catalogs from Indian streaming services",
        resources: ["catalog"],
        types: ["movie", "series"],
        catalogs: catalogs.map(id => ({
            type: ALL_CATALOGS[id].type,
            id: id,
            name: ALL_CATALOGS[id].name
        })),
        logo: "https://i.imgur.com/44ueTES.png"
    };
}

async function fetchWithTimeout(url, options = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), CONFIG.REQUEST_TIMEOUT);

    try {
        const response = await fetch(url, { ...options, signal: controller.signal });
        clearTimeout(timeout);
        return response;
    } catch (err) {
        clearTimeout(timeout);
        throw err;
    }
}

// =============================================================================
// ANALYTICS
// =============================================================================

async function trackInstall(configHash) {
    try {
        const key = `install:${configHash}`;
        const exists = await redis.exists(key);
        
        if (!exists) {
            await redis.set(key, Date.now());
            await redis.incr('stats:total_installs');
        }
        
        // Track last seen
        await redis.set(`last_seen:${configHash}`, Date.now());
    } catch (err) {
        console.error('[Analytics] Error:', err.message);
    }
}

async function getStats() {
    try {
        const totalInstalls = await redis.get('stats:total_installs') || 0;
        const lastSeenKeys = await redis.keys('last_seen:*');
        
        // Count active users (seen in last 7 days)
        const sevenDaysAgo = Date.now() - (7 * 24 * 60 * 60 * 1000);
        let activeUsers = 0;
        
        for (const key of lastSeenKeys) {
            const lastSeen = await redis.get(key);
            if (lastSeen && parseInt(lastSeen) > sevenDaysAgo) {
                activeUsers++;
            }
        }
        
        return {
            totalInstalls: parseInt(totalInstalls),
            activeUsers: activeUsers,
            totalUsers: lastSeenKeys.length
        };
    } catch (err) {
        return { error: err.message };
    }
}

// =============================================================================
// REDIS OPERATIONS
// =============================================================================

async function getCachedPoster(imdbId) {
    try {
        return await redis.get(`poster:${imdbId}`);
    } catch (err) {
        return null;
    }
}

async function setCachedPoster(imdbId, posterUrl) {
    try {
        const ttl = CONFIG.POSTER_CACHE_DAYS * 24 * 60 * 60;
        await redis.setex(`poster:${imdbId}`, ttl, posterUrl || 'null');
    } catch (err) {
        console.error('[Redis] Failed to cache poster:', err.message);
    }
}

async function getCachedList(catalogId) {
    try {
        const data = await redis.get(`list:${catalogId}`);
        return data ? JSON.parse(data) : null;
    } catch (err) {
        return null;
    }
}

async function setCachedList(catalogId, data) {
    try {
        await redis.set(`list:${catalogId}`, JSON.stringify(data));
    } catch (err) {
        console.error('[Redis] Failed to cache list:', err.message);
    }
}

// =============================================================================
// POSTER FETCHING
// =============================================================================

async function fetchRPDBPoster(imdbId, rpdbKey) {
    try {
        const url = `https://api.ratingposterdb.com/${rpdbKey}/imdb/poster-default/${imdbId}.jpg`;
        const response = await fetchWithTimeout(url, { method: 'HEAD' });
        return response.ok ? url : null;
    } catch (err) {
        return null;
    }
}

async function getPoster(imdbId, rpdbKey) {
    if (!imdbId) return null;

    // Check cache first
    const cached = await getCachedPoster(imdbId);
    if (cached !== null) {
        return cached === 'null' ? null : cached;
    }

    // Fetch from RPDB
    const poster = await fetchRPDBPoster(imdbId, rpdbKey);
    
    // Cache result
    await setCachedPoster(imdbId, poster);
    
    return poster;
}

// =============================================================================
// LIST FETCHERS
// =============================================================================

async function fetchTraktList(user, listSlug) {
    const url = `https://api.trakt.tv/users/${user}/lists/${listSlug}/items?extended=full`;
    
    const response = await fetchWithTimeout(url, {
        headers: {
            'Content-Type': 'application/json',
            'trakt-api-version': '2',
            'trakt-api-key': CONFIG.TRAKT_API_KEY
        }
    });

    if (!response.ok) {
        throw new Error(`Trakt API returned ${response.status}`);
    }

    const items = await response.json();
    
    return items.map(item => {
        const data = item.movie || item.show;
        if (!data?.ids?.imdb) return null;

        return {
            imdbId: data.ids.imdb,
            type: item.type === 'show' ? 'series' : 'movie',
            title: data.title,
            description: data.overview,
            rating: data.rating,
            year: data.year
        };
    }).filter(Boolean);
}

async function fetchMDBList(listId, mediaType) {
    const url = `https://api.mdblist.com/lists/${listId}/items?apikey=${CONFIG.MDBLIST_API_KEY}`;

    const response = await fetchWithTimeout(url, {
        headers: { 'Content-Type': 'application/json' }
    });

    if (!response.ok) {
        throw new Error(`MDBList API returned ${response.status}`);
    }

    const data = await response.json();
    const items = mediaType === 'movie' ? data.movies : data.shows;

    return (items || []).map(item => {
        if (!item.imdb_id) return null;

        return {
            imdbId: item.imdb_id,
            type: mediaType,
            title: item.title,
            description: item.description,
            rating: item.imdb_rating,
            year: item.release_year
        };
    }).filter(Boolean);
}

// =============================================================================
// CATALOG OPERATIONS
// =============================================================================

async function refreshCatalog(catalogId) {
    const catalog = ALL_CATALOGS[catalogId];
    if (!catalog) {
        throw new Error(`Unknown catalog: ${catalogId}`);
    }

    console.log(`[Refresh] Fetching ${catalogId}...`);
    
    try {
        const items = await catalog.fetcher();
        await setCachedList(catalogId, items);
        console.log(`[Refresh] ✓ ${catalogId}: ${items.length} items cached`);
        return items;
    } catch (err) {
        console.error(`[Refresh] ✗ ${catalogId}:`, err.message);
        throw err;
    }
}

async function getCatalogMetas(catalogId, rpdbKey) {
    // Get cached list
    let items = await getCachedList(catalogId);
    
    // If not cached, refresh
    if (!items) {
        items = await refreshCatalog(catalogId);
    }

    // Build metas with posters
    const metas = [];
    for (const item of items) {
        const poster = await getPoster(item.imdbId, rpdbKey);
        
        if (poster) {
            metas.push({
                id: item.imdbId,
                type: item.type,
                name: item.title,
                poster: poster,
                description: item.description || undefined,
                imdbRating: item.rating ? item.rating.toFixed(1) : undefined,
                releaseInfo: item.year ? String(item.year) : undefined
            });
        }
    }

    return metas;
}

// =============================================================================
// SCHEDULED REFRESH (00:00 and 12:00 IST)
// =============================================================================

async function refreshAllCatalogs() {
    console.log('[Cron] Starting scheduled refresh...');
    
    for (const catalogId of Object.keys(ALL_CATALOGS)) {
        try {
            await refreshCatalog(catalogId);
        } catch (err) {
            console.error(`[Cron] Failed to refresh ${catalogId}`);
        }
    }
    
    console.log('[Cron] ✓ Refresh complete');
}

// Schedule for 00:00 IST (18:30 UTC previous day)
cron.schedule('30 18 * * *', refreshAllCatalogs, {
    timezone: "Asia/Kolkata"
});

// Schedule for 12:00 IST (06:30 UTC)
cron.schedule('30 6 * * *', refreshAllCatalogs, {
    timezone: "Asia/Kolkata"
});

// =============================================================================
// EXPRESS SERVER
// =============================================================================

const app = express();

// CORS
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
    
    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }
    
    next();
});

// Serve configuration page
app.get('/', (req, res) => {
    const fs = require('fs');
    const path = require('path');
    
    try {
        const htmlPath = path.join(__dirname, 'configure.html');
        if (fs.existsSync(htmlPath)) {
            res.sendFile(htmlPath);
        } else {
            res.send('<h1>Indian OTT Catalogs</h1><p>Use manifest URL to install.</p>');
        }
    } catch (err) {
        res.status(500).send('<h1>Error</h1><p>Failed to load configuration page.</p>');
    }
});

// Manifest endpoint
app.get('/:config/manifest.json', async (req, res) => {
    const config = decodeConfig(req.params.config);
    if (!config || !config.catalogs) {
        return res.status(400).json({ error: 'Invalid configuration' });
    }
    
    // Track this installation
    await trackInstall(req.params.config);
    
    const selectedCatalogs = config.catalogs.split(',').filter(id => ALL_CATALOGS[id]);
    
    if (selectedCatalogs.length === 0) {
        return res.status(400).json({ error: 'No valid catalogs selected' });
    }
    
    const manifest = buildManifest(selectedCatalogs);
    
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.json(manifest);
});

// Catalog endpoint
app.get('/:config/catalog/:type/:id.json', async (req, res) => {
    const config = decodeConfig(req.params.config);
    if (!config) {
        return res.status(400).json({ metas: [] });
    }

    const { id } = req.params;
    const rpdbKey = config.rpdb || CONFIG.DEFAULT_RPDB_KEY;

    try {
        const metas = await getCatalogMetas(id, rpdbKey);
        
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Cache-Control', 'public, max-age=3600');
        res.json({ metas });
    } catch (err) {
        console.error(`[Catalog] Error for ${id}:`, err.message);
        res.json({ metas: [] });
    }
});

// Public stats endpoint
app.get('/stats', async (req, res) => {
    const stats = await getStats();
    
    res.json({
        ...stats,
        message: 'Thanks for using Indian OTT Catalogs! 🇮🇳',
        lastUpdated: new Date().toISOString()
    });
});

// Admin detailed analytics
app.get('/admin/analytics', async (req, res) => {
    try {
        const stats = await getStats();
        const lastSeenKeys = await redis.keys('last_seen:*');
        
        // Get activity breakdown
        const now = Date.now();
        const day = 24 * 60 * 60 * 1000;
        
        let last24h = 0, last7d = 0, last30d = 0;
        
        for (const key of lastSeenKeys) {
            const lastSeen = parseInt(await redis.get(key));
            const diff = now - lastSeen;
            
            if (diff < day) last24h++;
            if (diff < 7 * day) last7d++;
            if (diff < 30 * day) last30d++;
        }
        
        res.json({
            totalInstalls: stats.totalInstalls,
            totalUsers: stats.totalUsers,
            activeUsers: {
                last24h: last24h,
                last7d: last7d,
                last30d: last30d
            },
            timestamp: new Date().toISOString()
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Health check
app.get('/health', (req, res) => {
    res.json({ 
        status: 'ok',
        timestamp: new Date().toISOString(),
        catalogs: Object.keys(ALL_CATALOGS).length
    });
});

// Admin: Manual refresh
app.get('/admin/refresh/:catalogId?', async (req, res) => {
    const { catalogId } = req.params;
    
    try {
        if (catalogId) {
            await refreshCatalog(catalogId);
            res.json({ success: true, catalog: catalogId });
        } else {
            await refreshAllCatalogs();
            res.json({ success: true, message: 'All catalogs refreshed' });
        }
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Admin: Cache stats
app.get('/admin/cache-stats', async (req, res) => {
    try {
        const keys = await redis.keys('*');
        res.json({
            totalKeys: keys.length,
            posters: keys.filter(k => k.startsWith('poster:')).length,
            lists: keys.filter(k => k.startsWith('list:')).length,
            installs: keys.filter(k => k.startsWith('install:')).length,
            lastSeen: keys.filter(k => k.startsWith('last_seen:')).length
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Export for Vercel
module.exports = app;

// Local development
if (require.main === module) {
    app.listen(CONFIG.PORT, async () => {
        console.log(`✓ Server running on port ${CONFIG.PORT}`);
        console.log('✓ Cron jobs scheduled for 00:00 and 12:00 IST');
        
        // Initial refresh on startup
        console.log('[Startup] Checking cache...');
        const firstCatalog = Object.keys(ALL_CATALOGS)[0];
        const cached = await getCachedList(firstCatalog);
        
        if (!cached) {
            console.log('[Startup] No cache found, refreshing all catalogs...');
            await refreshAllCatalogs();
        } else {
            console.log('[Startup] Cache found, skipping initial refresh');
        }
    });
}