const ALLOWED_ORIGIN = 'https://lgy8687.github.io';
const AMAP_TRAFFIC_URL = 'https://restapi.amap.com/v3/traffic/status/rectangle';

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Vary': 'Origin',
  };
}

function json(body, status) {
  return new Response(JSON.stringify(body), {
    status: status,
    headers: { ...corsHeaders(), 'Content-Type': 'application/json; charset=utf-8' },
  });
}

function validRectangle(value) {
  const match = String(value || '').match(/^(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?);(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/);
  if (!match) return false;

  const [west, south, east, north] = match.slice(1).map(Number);
  // 仅代理福州及周边的小范围查询，避免这个小工具成为任意地图接口。
  return west >= 118.8 && east <= 119.7 && south >= 25.6 && north <= 26.6 && west < east && south < north;
}

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get('Origin');
    if (request.method === 'OPTIONS') {
      return origin === ALLOWED_ORIGIN ? new Response(null, { headers: corsHeaders() }) : new Response(null, { status: 403 });
    }
    if (request.method !== 'GET' || origin !== ALLOWED_ORIGIN) return json({ error: 'Not allowed' }, 403);

    const url = new URL(request.url);
    if (url.pathname !== '/traffic') return json({ error: 'Not found' }, 404);

    const rectangle = url.searchParams.get('rectangle');
    if (!validRectangle(rectangle)) return json({ error: 'Invalid Fuzhou area' }, 400);

    const cache = caches.default;
    const cached = await cache.match(request);
    if (cached) return cached;

    const amapUrl = new URL(AMAP_TRAFFIC_URL);
    amapUrl.searchParams.set('key', env.AMAP_TRAFFIC_KEY);
    amapUrl.searchParams.set('rectangle', rectangle);
    amapUrl.searchParams.set('level', '6');
    amapUrl.searchParams.set('extensions', 'all');

    const upstream = await fetch(amapUrl);
    const response = new Response(upstream.body, {
      status: upstream.status,
      headers: {
        ...corsHeaders(),
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'public, max-age=300',
      },
    });
    ctx.waitUntil(cache.put(request, response.clone()));
    return response;
  },
};
