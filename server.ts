import express, { Request, Response } from 'express';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;
const NASA_FIRMS_KEY = process.env.NASA_FIRMS_MAP_KEY || '4b86539a7d8c07d750add8f3937f66de';

app.use(express.json());

// In-memory cache for NASA FIRMS responses (5 minute TTL)
interface CacheEntry {
  timestamp: number;
  data: unknown;
}
const cache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 mins

export interface NasaHotspot {
  latitude: number;
  longitude: number;
  brightnessKelvin: number;
  scan: number;
  track: number;
  acqDate: string;
  acqTime: string;
  satellite: string;
  instrument: string;
  confidence: string;
  frpMw: number;
  dayNight: string;
}

function parseFirmsCsv(csvText: string): NasaHotspot[] {
  const lines = csvText.trim().split('\n');
  if (lines.length <= 1) return [];

  const headers = lines[0].split(',').map(h => h.trim().toLowerCase());
  const latIdx = headers.indexOf('latitude');
  const lonIdx = headers.indexOf('longitude');
  const brightIdx = headers.findIndex(h => h.startsWith('bright_') || h === 'brightness');
  const scanIdx = headers.indexOf('scan');
  const trackIdx = headers.indexOf('track');
  const dateIdx = headers.indexOf('acq_date');
  const timeIdx = headers.indexOf('acq_time');
  const satIdx = headers.indexOf('satellite');
  const instIdx = headers.indexOf('instrument');
  const confIdx = headers.indexOf('confidence');
  const frpIdx = headers.indexOf('frp');
  const dnIdx = headers.indexOf('daynight');

  const hotspots: NasaHotspot[] = [];

  for (let i = 1; i < lines.length; i++) {
    const row = lines[i].split(',').map(c => c.trim());
    if (row.length < 5) continue;

    const lat = parseFloat(row[latIdx]);
    const lon = parseFloat(row[lonIdx]);
    const bright = parseFloat(row[brightIdx]);
    const frp = parseFloat(row[frpIdx]);

    if (isNaN(lat) || isNaN(lon)) continue;

    hotspots.push({
      latitude: lat,
      longitude: lon,
      brightnessKelvin: isNaN(bright) ? 310.0 : bright,
      scan: parseFloat(row[scanIdx]) || 0.4,
      track: parseFloat(row[trackIdx]) || 0.4,
      acqDate: row[dateIdx] || new Date().toISOString().split('T')[0],
      acqTime: row[timeIdx] || '0800',
      satellite: row[satIdx] || 'VIIRS',
      instrument: row[instIdx] || 'VIIRS',
      confidence: row[confIdx] || 'nominal',
      frpMw: isNaN(frp) ? 0 : frp,
      dayNight: row[dnIdx] || 'D',
    });
  }

  return hotspots;
}

// 1. API: Get Live Active Fire Hotspots from NASA FIRMS
app.get('/api/nasa-firms/hotspots', async (req: Request, res: Response) => {
  try {
    const source = (req.query.source as string) || 'VIIRS_SNPP_NRT';
    // Default to South India / Karnataka forest perimeter: minLon,minLat,maxLon,maxLat
    const extent = (req.query.extent as string) || '74,11,79,16';
    const dayRange = (req.query.days as string) || '1';

    const cacheKey = `hotspots_${source}_${extent}_${dayRange}`;
    const cached = cache.get(cacheKey);

    if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
      return res.json(cached.data);
    }

    const firmsUrl = `https://firms.modaps.eosdis.nasa.gov/api/area/csv/${NASA_FIRMS_KEY}/${source}/${extent}/${dayRange}`;
    const response = await fetch(firmsUrl);

    if (!response.ok) {
      throw new Error(`NASA FIRMS API error: ${response.status} ${response.statusText}`);
    }

    const csvData = await response.text();
    const hotspots = parseFirmsCsv(csvData);

    const result = {
      status: 'success',
      source,
      count: hotspots.length,
      timestamp: new Date().toISOString(),
      extent,
      hotspots,
      hasActiveAnomalies: hotspots.length > 0,
      maxKelvin: hotspots.length > 0 ? Math.max(...hotspots.map(h => h.brightnessKelvin)) : 298.2,
      maxFrp: hotspots.length > 0 ? Math.max(...hotspots.map(h => h.frpMw)) : 0,
    };

    cache.set(cacheKey, { timestamp: Date.now(), data: result });
    return res.json(result);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error('NASA FIRMS Proxy Error:', message);
    return res.status(500).json({
      status: 'error',
      message,
      fallbackUsed: true,
    });
  }
});

// 2. API: Get NASA FIRMS Connection & Availability Status
app.get('/api/nasa-firms/status', async (_req: Request, res: Response) => {
  try {
    const checkUrl = `https://firms.modaps.eosdis.nasa.gov/api/data_availability/csv/${NASA_FIRMS_KEY}/VIIRS_SNPP_NRT`;
    const response = await fetch(checkUrl);
    const text = await response.text();

    res.json({
      connected: response.ok,
      keyMasked: `${NASA_FIRMS_KEY.slice(0, 4)}...${NASA_FIRMS_KEY.slice(-4)}`,
      availability: text.trim(),
      wmsUrl: `https://firms.modaps.eosdis.nasa.gov/mapserver/wms/fires/${NASA_FIRMS_KEY}/`,
    });
  } catch (error: unknown) {
    res.json({
      connected: false,
      error: error instanceof Error ? error.message : 'Failed to reach NASA FIRMS',
    });
  }
});

// 3. Mount Vite or static server
async function startServer() {
  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.resolve(__dirname, 'dist')));
    app.get('*', (_req, res) => {
      res.sendFile(path.resolve(__dirname, 'dist', 'index.html'));
    });
  }

  app.listen(PORT, () => {
    console.log(`HELIOS Command Server running on http://localhost:${PORT}`);
    console.log(`NASA FIRMS API integration active with key: ${NASA_FIRMS_KEY.slice(0, 6)}...`);
  });
}

startServer();
