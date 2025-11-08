const express = require('express');
const fetch = require('node-fetch');
const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const cron = require('node-cron');

// =============================================================================
// CONFIGURATION
// =============================================================================

const CONFIG = {
    TRAKT_API_KEY: '1ad94277c08d8bfccd4fca5ced267e3fa0961ad5ec5aa0a27239b3fc759e2372',
    MDBLIST_API_KEY: 'qplsb84vmulwetxrtghsp6u0q',
    DEFAULT_RPDB_KEY: 't0-free-rpdb',
    
    // Cache files
    POSTER_CACHE_FILE: path.join(__dirname, 'cache', 'posters.json'),
    LIST_CACHE_FILE: path.join(__dirname, 'cache', 'lists.json'),
    
    // Cache durations
    LIST_CACHE_HOURS: 12, // Refresh lists every 12 hours
    POSTER_CACHE_NEVER_EXPIRE: true, // Keep posters forever unless removed
    
    PORT: process.env.PORT || 7000,
    REQUEST_TIMEOUT: 10000,
    MAX_RETRIES: 2,
    RETRY_DELAY: 1000,
    POSTER_FETCH_DELAY: 50
};

// Create cache directory if it doesn't exist
const cacheDir = path.join(__dirname, 'cache');
if (!fsSync.existsSync(cacheDir)) {
    fsSync.mkdirSync(cacheDir, { recursive: true });
}

// All available catalogs
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
        console.error('[Config] Failed to decode:', err.message);
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
        description: "Curated catalogs from Indian streaming services. Lists updated every 12 hours.",
        resources: ["catalog"],
        types: ["movie", "series"],
        catalogs: catalogs,
        logo: "https://i.imgur.com/44ueTES.png"
    };
}

// =============================================================================
// CACHE MANAGERS
// =============================================================================

class PosterCache {
    constructor() {
        this.cache = {};
        this.loaded = false;
    }

    async load() {
        try {
            if (fsSync.existsSync(CONFIG.POSTER_CACHE_FILE)) {
                const data = await fs.readFile(CONFIG.POSTER_CACHE_FILE, 'utf8');
                this.cache = JSON.parse(data);
                console.log(`[PosterCache] Loaded ${Object.keys(this.cache).length} posters`);
            }
            this.loaded = true;
        } catch (err) {
            console.error('[PosterCache] Load error:', err.message);
            this.cache = {};
            this.loaded = true;
        }
    }

    async save() {
        try {
            await fs.writeFile(CONFIG.POSTER_CACHE_FILE, JSON.stringify(this.cache, null, 2), 'utf8');
            console.log(`[PosterCache] Saved ${Object.keys(this.cache).length} posters`);
        } catch (err) {
            console.error('[PosterCache] Save error:', err.message);
        }
    }

    get(imdbId) {
        return this.cache[imdbId] || null;
    }

    has(imdbId) {
        return imdbId in this.cache;
    }

    set(imdbId, posterUrl) {
        this.cache[imdbId] = posterUrl;
    }

    getStats() {
        const total = Object.keys(this.cache).length;
        const withPosters = Object.values(this.cache).filter(p => p !== null).length;
        return { total, withPosters, nullPosters: total - withPosters };
    }
}

class ListCache {
    constructor() {
        this.cache = {};
        this.loaded = false;
    }

    async load() {
        try {
            if (fsSync.existsSync(CONFIG.LIST_CACHE_FILE)) {
                const data = await fs.readFile(CONFIG.LIST_CACHE_FILE, 'utf8');
                this.cache = JSON.parse(data);
                console.log(`[ListCache] Loaded ${Object.keys(this.cache).length} lists`);
            }
            this.loaded = true;
        } catch (err) {
            console.error('[ListCache] Load error:', err.message);
            this.cache = {};
            this.loaded = true;
        }
    }

    async save() {
        try {
            await fs.writeFile(CONFIG.LIST_CACHE_FILE, JSON.stringify(this.cache, null, 2), 'utf8');
            console.log(`[ListCache] Saved ${Object.keys(this.cache).length} lists`);
        } catch (err) {
            console.error('[ListCache] Save error:', err.message);
        }
    }

    get(catalogId) {
        const entry = this.cache[catalogId];
        if (!entry) return null;

        // Check if cache is expired
        const age = Date.now() - entry.timestamp;
        const maxAge = CONFIG.LIST_CACHE_HOURS * 60 * 60 * 1000;

        if (age > maxAge) {
            console.log(`[ListCache] Cache expired for ${catalogId} (${(age / 3600000).toFixed(1)}h old)`);
            return null;
        }

        return entry.data;
    }

    set(catalogId, data) {
        this.cache[catalogId] = {
            data: data,
            timestamp: Date.now()
        };
    }

    isExpired(catalogId) {
        const entry = this.cache[catalogId];
        if (!entry) return true;

        const age = Date.now() - entry.timestamp;
        const maxAge = CONFIG.LIST_CACHE_HOURS * 60 * 60 * 1000;
        return age > maxAge;
    }

    getAge(catalogId) {
        const entry = this.cache[catalogId];
        if (!entry) return null;
        return Math.floor((Date.now() - entry.timestamp) / 1000 / 60); // minutes
    }
}

const posterCache = new PosterCache();
const listCache = new ListCache();

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
        
        if (retries > 0 && (err.name === 'AbortError' || err.code === 'ECONNRESET')) {
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
        
        if (response.ok) {
            return directUrl;
        }
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
    // Check cache first
    if (posterCache.has(imdbId)) {
        return posterCache.get(imdbId);
    }

    // Rate limiting
    const now = Date.now();
    const timeSinceLastRequest = now - lastPosterRequest;
    if (timeSinceLastRequest < CONFIG.POSTER_FETCH_DELAY) {
        await new Promise(resolve => 
            setTimeout(resolve, CONFIG.POSTER_FETCH_DELAY - timeSinceLastRequest)
        );
    }
    lastPosterRequest = Date.now();

    // Try multiple sources
    let poster = null;
    let source = 'none';

    poster = await tryRPDB(imdbId, rpdbKey);
    if (poster) source = 'RPDB';

    if (!poster) {
        poster = await tryCinemeta(imdbId, type);
        if (poster) source = 'Cinemeta';
    }

    if (!poster && traktPoster) {
        poster = traktPoster;
        source = 'Trakt';
    }

    // Cache the result
    posterCache.set(imdbId, poster);
    
    if (poster) {
        console.log(`[Poster] ✓ ${imdbId} from ${source}`);
    } else {
        console.log(`[Poster] ✗ ${imdbId} not found`);
    }

    return poster;
}

// =============================================================================
// API FETCHERS (Direct from APIs)
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

    if (!response.ok) {
        throw new Error(`Trakt API returned ${response.status}`);
    }

    const items = await response.json();
    
    // Return raw data with IMDB IDs
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

    if (!response.ok) {
        throw new Error(`MDBList API returned ${response.status}`);
    }

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
    // Check if we have cached list data
    const cachedData = listCache.get(catalogId);
    
    if (cachedData) {
        const age = listCache.getAge(catalogId);
        console.log(`[List] Using cached ${catalogId} (${age} minutes old)`);
        
        // Build metas with posters from cache
        const metas = cachedData.map(item => {
            const poster = posterCache.get(item.imdbId);
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
        }).filter(Boolean);

        return metas;
    }

    // Cache miss - fetch fresh data
    console.log(`[List] Cache miss for ${catalogId}, fetching fresh data...`);
    return await refreshCatalog(catalogId, rpdbKey);
}

async function refreshCatalog(catalogId, rpdbKey) {
    const catalog = ALL_CATALOGS[catalogId];
    if (!catalog) {
        console.error(`[Refresh] Unknown catalog: ${catalogId}`);
        return [];
    }

    console.log(`[Refresh] Fetching ${catalogId} from API...`);

    try {
        // Fetch raw data from API
        const rawData = await catalog.fetcher();
        console.log(`[Refresh] Got ${rawData.length} items from API`);

        // Cache the raw list data
        listCache.set(catalogId, rawData);

        // Fetch posters for new items only
        const metas = [];
        for (const item of rawData) {
            let poster = posterCache.get(item.imdbId);
            
            // Only fetch if not in cache
            if (!poster) {
                poster = await getPoster(item.imdbId, item.type, item.traktPoster, rpdbKey);
            }

            if (poster) {
                metas.push({
                    id: item.imdbId,
                    type: item.type,
                    name: item.title,
                    poster: poster,
                    description: item.overview || null,
                    imdbRating: item.rating ? item.rating.toFixed(1) : null,
                    year: item.year
                });
            }
        }

        console.log(`[Refresh] ✓ ${catalogId}: ${metas.length}/${rawData.length} items with posters`);
        return metas;

    } catch (err) {
        console.error(`[Refresh] ✗ Failed to refresh ${catalogId}:`, err.message);
        return [];
    }
}

// =============================================================================
// SCHEDULED REFRESH (Every 12 hours)
// =============================================================================

async function scheduledRefresh() {
    console.log('\n' + '='.repeat(70));
    console.log(`[Cron] Starting scheduled refresh at ${new Date().toISOString()}`);
    console.log('='.repeat(70));

    for (const catalogId of Object.keys(ALL_CATALOGS)) {
        try {
            await refreshCatalog(catalogId, CONFIG.DEFAULT_RPDB_KEY);
            // Small delay between catalogs
            await new Promise(resolve => setTimeout(resolve, 2000));
        } catch (err) {
            console.error(`[Cron] Failed to refresh ${catalogId}:`, err.message);
        }
    }

    // Save all caches
    await listCache.save();
    await posterCache.save();

    const stats = posterCache.getStats();
    console.log(`[Cron] ✓ Refresh complete. Poster cache: ${stats.withPosters}/${stats.total}`);
    console.log('='.repeat(70) + '\n');
}

// Schedule: Every 12 hours at :00 minutes
cron.schedule('0 */12 * * *', scheduledRefresh, {
    timezone: "Asia/Kolkata"
});

// Also run manual refresh on startup after 30 seconds
let startupRefreshDone = false;
setTimeout(async () => {
    if (!startupRefreshDone) {
        console.log('[Startup] Running initial refresh...');
        await scheduledRefresh();
        startupRefreshDone = true;
    }
}, 30000);

// =============================================================================
// EXPRESS SERVER
// =============================================================================

const app = express();

// Add CORS headers for Stremio
app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    
    // Handle preflight
    if (req.method === 'OPTIONS') {
        return res.sendStatus(200);
    }
    
    next();
});

// Serve configuration page
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'configure.html'));
});

// Manifest endpoint
app.get('/:config/manifest.json', (req, res) => {
    const config = decodeConfig(req.params.config);
    if (!config) return res.status(400).json({ error: 'Invalid configuration' });
    
    const selectedCatalogs = config.catalogs ? config.catalogs.split(',') : Object.keys(ALL_CATALOGS);
    const manifest = buildManifest(selectedCatalogs);
    
    res.json(manifest);
});

// Catalog endpoint
app.get('/:config/catalog/:type/:id.json', async (req, res) => {
    const config = decodeConfig(req.params.config);
    if (!config) return res.status(400).json({ error: 'Invalid configuration' });

    const rpdbKey = config.rpdb || CONFIG.DEFAULT_RPDB_KEY;
    const { id } = req.params;

    console.log(`\n[Request] ${id} - Cache age: ${listCache.getAge(id) || 'none'} min`);

    try {
        const metas = await getCatalogMetas(id, rpdbKey);
        res.json({ metas });
    } catch (err) {
        console.error(`[Request] Error:`, err.message);
        res.json({ metas: [] });
    }
});

// Manual refresh endpoint (for testing)
app.get('/admin/refresh', async (req, res) => {
    res.send('Refresh started in background...');
    scheduledRefresh(); // Don't await
});

// Stats endpoint
app.get('/admin/stats', async (req, res) => {
    const posterStats = posterCache.getStats();
    const listStats = {};
    
    for (const catalogId of Object.keys(ALL_CATALOGS)) {
        listStats[catalogId] = {
            age: listCache.getAge(catalogId),
            expired: listCache.isExpired(catalogId)
        };
    }

    res.json({
        posters: posterStats,
        lists: listStats,
        nextRefresh: 'Every 12 hours at :00 (IST)'
    });
});

// =============================================================================
// STARTUP
// =============================================================================

async function startup() {
    console.log('\n' + '='.repeat(70));
    console.log('🇮🇳  Indian OTT Catalogs v1.0.0');
    console.log('='.repeat(70));
    console.log('⏰  List refresh: Every 12 hours');
    console.log('💾  Poster cache: Persistent (never expires)');
    console.log('='.repeat(70) + '\n');

    // Load caches
    await posterCache.load();
    await listCache.load();

    // Start server
    app.listen(CONFIG.PORT, () => {
        console.log(`\n✓ Server running on port ${CONFIG.PORT}`);
        console.log(`✓ Configure at: http://localhost:${CONFIG.PORT}`);
        console.log(`✓ Stats: http://localhost:${CONFIG.PORT}/admin/stats`);
        console.log('='.repeat(70) + '\n');
    });
}

async function shutdown() {
    console.log('\n[Shutdown] Saving caches...');
    await posterCache.save();
    await listCache.save();
    console.log('[Shutdown] Complete');
    process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

startup().catch(err => {
    console.error('[Fatal]', err);
    process.exit(1);
});