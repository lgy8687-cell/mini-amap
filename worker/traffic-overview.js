const ALLOWED_ORIGIN = 'https://lgy8687.github.io';
const TILE_DEGREES = 0.045;
const MAX_TILES_PER_REQUEST = 24;
const CACHE_SECONDS = 120;

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Vary': 'Origin',
  };
}

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...corsHeaders(),
      ...extraHeaders,
    },
  });
}

function parseBounds(raw) {
  const parts = String(raw || '').split(',').map(Number);
  if (parts.length !== 4 || parts.some((value) => !Number.isFinite(value))) return null;

  const [west, south, east, north] = parts;
  if (west >= east || south >= north || west < 73 || east > 136 || south < 3 || north > 54) return null;
  return { west, south, east, north };
}

function splitBounds(bounds) {
  const tiles = [];
  for (let west = bounds.west; west < bounds.east; west += TILE_DEGREES) {
    for (let south = bounds.south; south < bounds.north; south += TILE_DEGREES) {
      tiles.push({
        west,
        south,
        east: Math.min(west + TILE_DEGREES, bounds.east),
        north: Math.min(south + TILE_DEGREES, bounds.north),
      });
    }
  }
  return tiles;
}

function normalizeRoad(road) {
  const points = String(road.polyline || '')
    .split(';')
    .map((point) => point.split(',').map(Number))
    .filter(([lng, lat]) => Number.isFinite(lng) && Number.isFinite(lat));

  if (points.length < 2) return null;
  return {
    name: road.name || '',
    status: road.status || '未知',
    direction: road.direction || '',
    speed: Number(road.speed) || null,
    points,
  };
}

async function loadTile(tile, apiKey) {
  const rectangle = `${tile.west},${tile.south};${tile.east},${tile.north}`;
  const url = new URL('https://restapi.amap.com/v3/traffic/status/rectangle');
  url.searchParams.set('key', apiKey);
  url.searchParams.set('rectangle', rectangle);
  url.searchParams.set('level', '6');
  url.searchParams.set('extensions', 'all');

  const response = await fetch(url);
  if (!response.ok) throw new Error(`Amap request failed: ${response.status}`);
  const payload = await response.json();
  if (payload.status !== '1') throw new Error(payload.info || 'Amap traffic request failed');
  return (payload.trafficinfo?.roads || []).map(normalizeRoad).filter(Boolean);
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: corsHeaders() });
    if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405);

    const origin = request.headers.get('Origin');
    if (origin && origin !== ALLOWED_ORIGIN) return json({ error: 'Origin not allowed' }, 403);

    const url = new URL(request.url);
    if (url.pathname !== '/traffic') return json({ error: 'Not found' }, 404);
    if (!env.AMAP_TRAFFIC_KEY) return json({ error: 'Traffic service is not configured' }, 503);

    const bounds = parseBounds(url.searchParams.get('bounds'));
    if (!bounds) return json({ error: 'Invalid bounds' }, 400);

    const tiles = splitBounds(bounds);
    if (tiles.length > MAX_TILES_PER_REQUEST) {
      return json({ error: 'Area too large. Please zoom in one level.' }, 400);
    }

    const cacheKey = new Request(url.toString());
    const cached = await caches.default.match(cacheKey);
    if (cached) return cached;

    try {
      const chunks = await Promise.all(tiles.map((tile) => loadTile(tile, env.AMAP_TRAFFIC_KEY)));
      const seen = new Set();
      const roads = chunks.flat().filter((road) => {
        const id = `${road.name}|${road.direction}|${road.points[0].join(',')}|${road.points.at(-1).join(',')}`;
        if (seen.has(id)) return false;
        seen.add(id);
        return true;
      });

      const response = json(
        { updatedAt: new Date().toISOString(), roads },
        200,
        { 'Cache-Control': `public, max-age=${CACHE_SECONDS}, s-maxage=${CACHE_SECONDS}` },
      );
      ctx.waitUntil(caches.default.put(cacheKey, response.clone()));
      return response;
    } catch (error) {
      return json({ error: 'Traffic data is temporarily unavailable', detail: error.message }, 502);
    }
  },
};
