const express = require('express');
const fetch = require('node-fetch');
const { Redis } = require('@upstash/redis');

// =============================================================================
// CONFIGURATION
// =============================================================================

const CONFIG = {
    TRAKT_API_KEY: '1ad94277c08d8bfccd4fca5ced267e3fa0961ad5ec5aa0a27239b3fc759e2372',
    MDBLIST_API_KEY: 'qplsb84vmulwetxrtghsp6u0q',
    DEFAULT_RPDB_KEY: 't0-free-rpdb',
    
    LIST_CACHE_SECONDS: 12 * 60 * 60, // 12 hours
    POSTER_CACHE_SECONDS: 30 * 24 * 60 * 60, // 30 days
    
    PORT: process.env.PORT || 3000,
    REQUEST_TIMEOUT: 8000,
    MAX_RETRIES: 1,
    RETRY_DELAY: 500,
    POSTER_FETCH_DELAY: 50
};

// Initialize Redis
const redis = new Redis({
    url: process.env.UPSTASH_REDIS_REST_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const ALL_CATALOGS = {
    'trakt_prime_movies': { 
        type: "movie", 
        id: "trakt_prime_movies", 
        name: "Prime Video Movies (Top 10 India)",
        fetcher: () => getTraktListFromAPI('akashbahetra', 'top-india-amazon-prime-video-movies')
    },
    'trakt_prime_shows': { 
        type: "series", 
        id: "trakt_prime_shows", 
        name: "Prime Video Shows (Top 10 India)",
        fetcher: () => getTraktListFromAPI('akashbahetra', 'top-india-amazon-prime-video-shows')
    },
    'trakt_netflix_movies': { 
        type: "movie", 
        id: "trakt_netflix_movies", 
        name: "Netflix Movies (Top 10 India)",
        fetcher: () => getTraktListFromAPI('akashbahetra05', 'top-india-netflix-movies')
    },
    'trakt_netflix_shows': { 
        type: "series", 
        id: "trakt_netflix_shows", 
        name: "Netflix Shows (Top 10 India)",
        fetcher: () => getTraktListFromAPI('akashbahetra05', 'top-india-netflix-shows')
    },
    'trakt_zee5_overall': { 
        type: "series", 
        id: "trakt_zee5_overall", 
        name: "Zee5 Top Shows (India)",
        fetcher: () => getTraktListFromAPI('semicolumn', 'top-india-zee5-overall')
    },
    'trakt_hotstar_overall': { 
        type: "series", 
        id: "trakt_hotstar_overall", 
        name: "Hotstar Top Shows (India)",
        fetcher: () => getTraktListFromAPI('semicolumn', 'top-india-hotstar-overall')
    },
    'mdblist_latest_movies': { 
        type: "movie", 
        id: "mdblist_latest_movies", 
        name: "Latest 100 Movies (India)",
        fetcher: () => getMDBListFromAPI(120954, 'movie')
    },
    'mdblist_latest_series': { 
        type: "series", 
        id: "mdblist_latest_series", 
        name: "Latest 100 Shows (India)",
        fetcher: () => getMDBListFromAPI(120955, 'series')
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

function buildManifest(selectedCatalogs) {
    const catalogs = selectedCatalogs
        .map(id => ({
            type: ALL_CATALOGS[id].type,
            id: ALL_CATALOGS[id].id,
            name: ALL_CATALOGS[id].name
        }))
        .filter(Boolean);

    return {
        id: "com.semicolon.indian-ott-catalogs",
        version: "1.0.0",
        name: "Indian OTT Catalogs",
        description: "Curated catalogs from Indian streaming services. Auto-updated every 12 hours.",
        resources: ["catalog"],
        types: ["movie", "series"],
        catalogs: catalogs,
        logo: "https://i.imgur.com/44ueTES.png"
    };
}

// =============================================================================
// REDIS CACHE HELPERS
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
        await redis.setex(`poster:${imdbId}`, CONFIG.POSTER_CACHE_SECONDS, posterUrl || 'null');
    } catch (err) {}
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
        await redis.setex(`list:${catalogId}`, CONFIG.LIST_CACHE_SECONDS, JSON.stringify(data));
    } catch (err) {}
}

// =============================================================================
// POSTER FETCHING
// =============================================================================

let lastPosterRequest = 0;

async function fetchWithRetry(url, options = {}, retries = CONFIG.MAX_RETRIES) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), CONFIG.REQUEST_TIMEOUT);

    try {
        const response = await fetch(url, {
            ...options,
            signal: controller.signal
        });
        clearTimeout(timeout);
        return response;
    } catch (err) {
        clearTimeout(timeout);
        
        if (retries > 0) {
            await new Promise(resolve => setTimeout(resolve, CONFIG.RETRY_DELAY));
            return fetchWithRetry(url, options, retries - 1);
        }
        
        throw err;
    }
}

async function tryRPDB(imdbId, rpdbKey) {
    try {
        const directUrl = `https://api.ratingposterdb.com/${rpdbKey}/imdb/poster-default/${imdbId}.jpg`;
        const response = await fetchWithRetry(directUrl, { method: 'HEAD' }, 0);
        if (response.ok) return directUrl;
    } catch (err) {}
    return null;
}

async function tryCinemeta(imdbId, type) {
    try {
        const url = `https://v3-cinemeta.strem.io/meta/${type}/${imdbId}.json`;
        const response = await fetchWithRetry(url, {}, 0);
        
        if (response.ok) {
            const data = await response.json();
            if (data.meta && data.meta.poster) {
                return data.meta.poster;
            }
        }
    } catch (err) {}
    return null;
}

async function getPoster(imdbId, type, traktPoster, rpdbKey) {
    if (!imdbId) return null;

    const cached = await getCachedPoster(imdbId);
    if (cached !== null) {
        return cached === 'null' ? null : cached;
    }

    const now = Date.now();
    const timeSinceLastRequest = now - lastPosterRequest;
    if (timeSinceLastRequest < CONFIG.POSTER_FETCH_DELAY) {
        await new Promise(resolve => 
            setTimeout(resolve, CONFIG.POSTER_FETCH_DELAY - timeSinceLastRequest)
        );
    }
    lastPosterRequest = Date.now();

    let poster = await tryRPDB(imdbId, rpdbKey);
    if (!poster) poster = await tryCinemeta(imdbId, type);
    if (!poster && traktPoster) poster = traktPoster;

    await setCachedPoster(imdbId, poster);
    return poster;
}

// =============================================================================
// API FETCHERS
// =============================================================================

async function getTraktListFromAPI(user, listSlug) {
    const url = `https://api.trakt.tv/users/${user}/lists/${listSlug}/items?extended=full`;
    
    const response = await fetchWithRetry(url, {
        headers: {
            'Content-Type': 'application/json',
            'trakt-api-version': '2',
            'trakt-api-key': CONFIG.TRAKT_API_KEY
        }
    });

    if (!response.ok) throw new Error(`Trakt API returned ${response.status}`);

    const items = await response.json();
    
    return items.map(item => {
        const itemData = item.movie || item.show;
        if (!itemData?.ids?.imdb) return null;

        return {
            imdbId: itemData.ids.imdb,
            type: item.type === 'show' ? 'series' : 'movie',
            title: itemData.title,
            overview: itemData.overview,
            rating: itemData.rating,
            year: itemData.year,
            traktPoster: itemData.images?.poster?.full || null
        };
    }).filter(Boolean);
}

async function getMDBListFromAPI(listIdentifier, mediaType) {
    const url = `https://api.mdblist.com/lists/${listIdentifier}/items?apikey=${CONFIG.MDBLIST_API_KEY}`;

    const response = await fetchWithRetry(url, {
        headers: { 'Content-Type': 'application/json' }
    });

    if (!response.ok) throw new Error(`MDBList API returned ${response.status}`);

    const responseData = await response.json();
    let items = [];

    if (mediaType === 'movie' && Array.isArray(responseData.movies)) {
        items = responseData.movies;
    } else if (mediaType === 'series' && Array.isArray(responseData.shows)) {
        items = responseData.shows;
    }

    return items.map(item => {
        if (!item.imdb_id) return null;

        return {
            imdbId: item.imdb_id,
            type: mediaType,
            title: item.title,
            overview: item.description,
            rating: item.imdb_rating,
            year: item.release_year,
            traktPoster: null
        };
    }).filter(Boolean);
}

// =============================================================================
// LIST MANAGEMENT
// =============================================================================

async function getCatalogMetas(catalogId, rpdbKey) {
    const cachedData = await getCachedList(catalogId);
    
    if (cachedData) {
        const metasPromises = cachedData.map(async (item) => {  // ✅ REMOVED LIMIT
            const poster = await getPoster(item.imdbId, item.type, item.traktPoster, rpdbKey);
            if (!poster) return null;

            return {
                id: item.imdbId,
                type: item.type,
                name: item.title,
                poster: poster,
                description: item.overview || null,
                imdbRating: item.rating ? item.rating.toFixed(1) : null,
                year: item.year
            };
        });

        const metas = await Promise.all(metasPromises);
        return metas.filter(Boolean);
    }

    return await refreshCatalog(catalogId, rpdbKey);
}

async function refreshCatalog(catalogId, rpdbKey) {
    const catalog = ALL_CATALOGS[catalogId];
    if (!catalog) return [];

    try {
        const rawData = await catalog.fetcher();
        await setCachedList(catalogId, rawData);

        const metas = [];
        const batchSize = 10; // Process 10 at a time
        
        for (let i = 0; i < rawData.length; i += batchSize) {  // ✅ Process ALL items
            const batch = rawData.slice(i, i + batchSize);
            const batchPromises = batch.map(async (item) => {
                const poster = await getPoster(item.imdbId, item.type, item.traktPoster, rpdbKey);
                if (!poster) return null;

                return {
                    id: item.imdbId,
                    type: item.type,
                    name: item.title,
                    poster: poster,
                    description: item.overview || null,
                    imdbRating: item.rating ? item.rating.toFixed(1) : null,
                    year: item.year
                };
            });

            const batchResults = await Promise.all(batchPromises);
            metas.push(...batchResults.filter(Boolean));
        }

        return metas;
    } catch (err) {
        console.error(`[Refresh] Error:`, err.message);
        return [];
    }
}

// =============================================================================
// EXPRESS SERVER WITH PROPER CORS
// =============================================================================

const app = express();

// Comprehensive CORS middleware
app.use((req, res, next) => {
    // Allow all origins
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, PATCH, DELETE');
    res.header('Access-Control-Allow-Headers', 'X-Requested-With, Content-Type, Accept, Origin');
    res.header('Access-Control-Allow-Credentials', 'true');
    
    // Handle preflight
    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }
    
    next();
});

// Serve HTML
const fs = require('fs');
const path = require('path');

app.get('/', (req, res) => {
    try {
        const htmlPath = path.join(__dirname, 'configure.html');
        if (fs.existsSync(htmlPath)) {
            res.sendFile(htmlPath);
        } else {
            res.send('<h1>Indian OTT Catalogs</h1><p>Configuration page not found. Use manifest URL directly.</p>');
        }
    } catch (err) {
        res.send('<h1>Indian OTT Catalogs</h1><p>Use manifest URL to install.</p>');
    }
});

// Manifest endpoint
app.get('/:config/manifest.json', (req, res) => {
    const config = decodeConfig(req.params.config);
    if (!config) {
        return res.status(400).json({ error: 'Invalid configuration' });
    }
    
    const selectedCatalogs = config.catalogs ? config.catalogs.split(',') : Object.keys(ALL_CATALOGS);
    const manifest = buildManifest(selectedCatalogs);
    
    // Ensure proper content type and CORS
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.json(manifest);
});

// Catalog endpoint
app.get('/:config/catalog/:type/:id.json', async (req, res) => {
    const config = decodeConfig(req.params.config);
    if (!config) {
        return res.status(400).json({ metas: [] });
    }

    const rpdbKey = config.rpdb || CONFIG.DEFAULT_RPDB_KEY;
    const { id } = req.params;

    // Add timeout protection
    const timeoutPromise = new Promise((resolve) => {
        setTimeout(() => resolve([]), 8000);
    });

    try {
        const metas = await Promise.race([
            getCatalogMetas(id, rpdbKey),
            timeoutPromise
        ]);
        
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Cache-Control', 'public, max-age=600');
        res.json({ metas });
    } catch (err) {
        console.error(`[Catalog] Error:`, err.message);
        res.json({ metas: [] });
    }
});

// Stats endpoint
app.get('/admin/stats', async (req, res) => {
    try {
        const keys = await redis.keys('*');
        res.json({
            totalKeys: keys.length,
            posters: keys.filter(k => k.startsWith('poster:')).length,
            lists: keys.filter(k => k.startsWith('list:')).length
        });
    } catch (err) {
        res.json({ error: err.message });
    }
});

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({ 
        status: 'ok', 
        timestamp: new Date().toISOString(),
        redis: process.env.UPSTASH_REDIS_REST_URL ? 'configured' : 'missing'
    });
});

// Test manifest endpoint (no config needed)
app.get('/test-manifest', (req, res) => {
    res.json({
        id: "com.semicolon.indian-ott-catalogs",
        version: "1.0.0",
        name: "Indian OTT Catalogs - Test",
        description: "Test manifest",
        resources: ["catalog"],
        types: ["movie"],
        catalogs: [
            { type: "movie", id: "test", name: "Test Catalog" }
        ]
    });
});

// Export for Vercel
module.exports = app;

// Local development
if (process.env.NODE_ENV !== 'production') {
    app.listen(CONFIG.PORT, () => {
        console.log(`✓ Server running on port ${CONFIG.PORT}`);
    });
}