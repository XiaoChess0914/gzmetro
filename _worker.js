/* 广州地铁共享校正 API：Cloudflare Pages 高级模式 _worker.js
   同域路径：/api/health、/api/reports；其余请求交给静态资源。 */
const W = 45 * 60 * 1000;
const RATE_WINDOW = 60 * 1000;
const RATE_MAX = 3;

const cors = (env) => ({
  'Access-Control-Allow-Origin': (env && env.ALLOW_ORIGIN) || '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
  'Cache-Control': 'no-store',
});
const json = (data, status, env) => new Response(JSON.stringify(data), {
  status: status || 200,
  headers: Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, cors(env)),
});
const today = () => new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
const hash = async (s) => {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf)).slice(0, 12).map((x) => x.toString(16).padStart(2, '0')).join('');
};

async function aggregate(db, line, dir, date) {
  const r = await db.prepare(
    'SELECT shift,created_at FROM reports WHERE line_id=? AND dir_to=? AND service_date=? AND created_at>=? ORDER BY created_at DESC LIMIT 200'
  ).bind(line, dir, date, Date.now() - W).all();
  const rows = (r && r.results) || [];
  const a = rows.map((x) => Number(x.shift)).filter(Number.isFinite).sort((x, y) => x - y);
  let shift = 0;
  if (a.length) {
    const m = a.length >> 1;
    shift = a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
    shift = Math.round(shift * 10) / 10;
  }
  return {
    shift,
    count: a.length,
    updatedAt: Math.max(0, ...rows.map((x) => Number(x.created_at) || 0)),
    windowMin: 45,
  };
}

async function getReports(request, env) {
  const u = new URL(request.url);
  const line = String(u.searchParams.get('line') || '');
  const dir = String(u.searchParams.get('dir') || '');
  const date = String(u.searchParams.get('date') || '');
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(line) || !dir || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return json({ ok: false, error: '缺少或不合法的 line / dir / date' }, 400, env);
  }
  const a = await aggregate(env.DB, line, dir, date);
  return json(Object.assign({ ok: true, line, dir, date }, a), 200, env);
}

async function postReports(request, env) {
  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: '请求体不是合法 JSON' }, 400, env); }
  const line = String(body.lineId || '').trim();
  const dir = String(body.dirTo || '').trim();
  const name = String(body.stationName || '').trim();
  const date = String(body.serviceDate || '').trim();
  const idx = Number(body.stationIdx);
  const baseEta = Number(body.baseEta);
  const actual = Number(body.actualMin);
  const cid = String(body.clientId || '').slice(0, 64);
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(line) || !dir || dir.length > 40 || !name || name.length > 40 ||
      date !== today() || !Number.isInteger(idx) || idx < 0 || idx > 200 ||
      !Number.isFinite(baseEta) || baseEta < 0 || baseEta > 180 ||
      !Number.isFinite(actual) || actual < 0 || actual > 30) {
    return json({ ok: false, error: '参数不合法，或不是上海时区今天' }, 400, env);
  }
  const shift = Math.round(Math.max(-60, Math.min(60, actual - baseEta)) * 10) / 10;
  const ip = request.headers.get('CF-Connecting-IP') ||
    String(request.headers.get('X-Forwarded-For') || '').split(',')[0].trim() || 'local';
  const ipHash = await hash(ip + '|' + (env.IP_SALT || 'gzmetro-sync'));
  const c = await env.DB.prepare(
    'SELECT COUNT(*) AS n FROM reports WHERE ip_hash=? AND created_at>=?'
  ).bind(ipHash, Date.now() - RATE_WINDOW).first();
  if (Number((c && c.n) || 0) >= RATE_MAX) {
    return json({ ok: false, error: '提交太频繁，请一分钟后再试' }, 429, env);
  }
  await env.DB.prepare(
    'INSERT INTO reports (line_id,dir_to,station_idx,station_name,service_date,base_eta,actual_min,shift,client_id,ip_hash,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)'
  ).bind(line, dir, idx, name, date, baseEta, actual, shift, cid, ipHash, Date.now()).run();
  const a = await aggregate(env.DB, line, dir, date);
  return json(Object.assign({ ok: true, line, dir, date }, a), 200, env);
}

async function handleApi(request, env) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(env) });
  try {
    if (!env || !env.DB) return json({ ok: false, error: 'D1 未绑定，请检查 Pages 项目的 DB binding' }, 500, env);
    const path = new URL(request.url).pathname.replace(/^\/api/, '');
    if (path === '/health') {
      return json({ ok: true, service: 'gzmetro-sync', runtime: 'pages', date: today(), now: Date.now() }, 200, env);
    }
    if (path === '/reports') {
      if (request.method === 'GET') return getReports(request, env);
      if (request.method === 'POST') return postReports(request, env);
      return json({ ok: false, error: '只支持 GET / POST' }, 405, env);
    }
    return json({ ok: false, error: 'not found' }, 404, env);
  } catch (err) {
    console.error('sync error', err && err.stack || err);
    return json({ ok: false, error: '共享服务异常' }, 500, env);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
      return handleApi(request, env);
    }
    return env.ASSETS.fetch(request);
  },
};
