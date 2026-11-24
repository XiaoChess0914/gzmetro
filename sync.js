/* 共享校正客户端：只负责和 Cloudflare Worker 通信。
   页面在没配置 GZ_SYNC.url 时完全走本机逻辑。 */
(function () {
  'use strict';
  const cfg = Object.assign({ url: '', pollMs: 30000 }, (typeof window !== 'undefined' && window.GZ_SYNC) || {});
  const base = String(cfg.url || '').trim().replace(/\/+$/, '');
  const enabled = /^https?:\/\//i.test(base);
  const CLIENT_KEY = 'gzmetro.client.v1';

  function readClientId() {
    try {
      if (typeof localStorage === 'undefined') return '';
      let v = localStorage.getItem(CLIENT_KEY);
      if (v) return v;
      v = (typeof crypto !== 'undefined' && crypto.randomUUID)
        ? crypto.randomUUID()
        : 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
      localStorage.setItem(CLIENT_KEY, v);
      return v;
    } catch { return ''; }
  }

  const clientId = readClientId();

  async function request(path, init) {
    if (!enabled) throw new Error('未配置共享服务');
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    const opts = Object.assign({ cache: 'no-store', signal: ctrl.signal }, init || {});
    opts.headers = Object.assign({ Accept: 'application/json' }, (init && init.headers) || {});
    try {
      const res = await fetch(base + path, opts);
      const text = await res.text();
      let data = null;
      try { data = JSON.parse(text); } catch {}
      if (!res.ok || !data || data.ok === false) {
        throw new Error((data && data.error) || ('共享服务 HTTP ' + res.status));
      }
      return data;
    } catch (e) {
      if (e && e.name === 'AbortError') throw new Error('共享服务连接超时');
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  function get(lineId, dirTo, date) {
    const q = new URLSearchParams({ line: String(lineId), dir: String(dirTo), date: String(date) });
    return request('/reports?' + q.toString());
  }

  function post(payload) {
    return request('/reports', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.assign({ clientId }, payload || {})),
    });
  }

  function health() { return request('/health'); }

  window.GZSync = { enabled, base, clientId, get, post, health, pollMs: Number(cfg.pollMs) || 30000 };
})();
