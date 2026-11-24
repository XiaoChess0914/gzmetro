/* 广州地铁 · 运行图推演
   数据：首末班 / 发车间隔 / 区间运行时分 / 线路几何
   说明：不是实时定位，仅按计划运行图推演 */
'use strict';

const NS = 'http://www.w3.org/2000/svg';
const $ = (s) => document.querySelector(s);
const rad = (d) => d * Math.PI / 180;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const ORIGIN_DWELL_MIN = 1.6;
const CALIB_KEY = 'gzmetro.calib.v1';
const SYNC = (typeof window !== 'undefined' && window.GZSync) || null;
function syncEnabled() { return !!(SYNC && SYNC.enabled); }
function todayKeyShanghai(d = new Date()) {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(d);
    const o = {};
    for (const p of parts) if (p.type !== 'literal') o[p.type] = p.value;
    if (o.year && o.month && o.day) return o.year + '-' + o.month + '-' + o.day;
  } catch {}
  return todayKey(d);
}

const state = {
  data: null,
  line: null,
  station: -1,
  speed: 1,
  baseReal: 0,
  baseSim: 0,
  day: 'weekday',
  calib: null,
  remote: null,
  remoteSeq: 0,
  remoteError: '',
  view: { z: 1, x: 0, y: 0 },
  trains: [],
  tip: null,
  lastPanelSec: -1,
};

const depCache = new Map();
const colorByName = new Map();

/* ---------- 小工具 ---------- */
function fmtHM(min) {
  const t = ((Math.round(min) % 1440) + 1440) % 1440;
  const h = Math.floor(t / 60), m = t % 60;
  return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
}
function fmtClock(d) {
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map((x) => String(x).padStart(2, '0')).join(':');
}
function nowSim() {
  if (state.speed === 1) return new Date();
  return new Date(state.baseSim + (Date.now() - state.baseReal) * state.speed);
}
function simMinutes(d) { return d.getHours() * 60 + d.getMinutes() + d.getSeconds() / 60; }
function setSpeed(s) {
  const cur = nowSim();
  state.baseSim = cur.getTime();
  state.baseReal = Date.now();
  state.speed = s;
  const b = $('#speedBtn');
  b.textContent = s + '×';
  b.classList.toggle('active', s !== 1);
  tick(true);
}
function dayTypeOf(d) { const w = d.getDay(); return w === 0 || w === 6 ? 'weekend' : 'weekday'; }
function todayKey(d = new Date()) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function readCalib() {
  try {
    if (typeof localStorage === 'undefined') return null;
    const raw = localStorage.getItem(CALIB_KEY);
    if (!raw) return null;
    const o = JSON.parse(raw);
    if (!o || o.date !== todayKey() || !o.lines) {
      localStorage.removeItem(CALIB_KEY);
      return null;
    }
    return o;
  } catch { return null; }
}
function saveCalib() {
  try {
    if (typeof localStorage === 'undefined') return;
    if (!state.calib) localStorage.removeItem(CALIB_KEY);
    else localStorage.setItem(CALIB_KEY, JSON.stringify(state.calib));
  } catch {}
}
function dropCalibStorage() {
  try { if (typeof localStorage !== 'undefined') localStorage.removeItem(CALIB_KEY); } catch {}
}

/* ---------- 发车时刻 ---------- */
function headwayAt(segs, t) {
  let h = segs.length ? segs[0][1] : 5;
  for (const [st, v] of segs) { if (t + 1e-6 >= st) h = v; else break; }
  return Math.max(1.2, h);
}
function dirCalib(dir) {
  if (!dir || !state.line || !state.calib || state.calib.date !== todayKey(nowSim())) return null;
  const rec = state.calib.lines && state.calib.lines[String(state.line.id)];
  if (!rec || !rec.dirs) return null;
  const it = rec.dirs[dir.baseTo || dir.to];
  return it || null;
}
function ensureRemote() {
  const date = todayKeyShanghai();
  const lineId = state.line ? String(state.line.id) : '';
  if (!state.remote || state.remote.date !== date || state.remote.lineId !== lineId) {
    state.remote = { date, lineId, dirs: {} };
  }
  if (!state.remote.dirs) state.remote.dirs = {};
  return state.remote;
}
function remoteFor(dir) {
  if (!dir || !state.line || !state.remote) return null;
  if (state.remote.date !== todayKeyShanghai() || state.remote.lineId !== String(state.line.id)) return null;
  const it = state.remote.dirs && state.remote.dirs[dir.baseTo || dir.to];
  return it && Number(it.count) > 0 && Number.isFinite(Number(it.shift)) ? it : null;
}
function dirShift(dir) {
  const remote = remoteFor(dir);
  if (remote) return Number(remote.shift) || 0;
  const it = dirCalib(dir);
  return it && Number.isFinite(it.shift) ? it.shift : 0;
}
function dirAnchor(dir, stationIdx) {
  // 共享校正是整条方向的中位平移，不做单站锚定；本机校正才做锚定。
  if (remoteFor(dir)) return -Infinity;
  const it = dirCalib(dir);
  if (!it || !Number.isFinite(it.anchor)) return -Infinity;
  if (it.stationIdx != null && Number(it.stationIdx) !== Number(stationIdx)) return -Infinity;
  return it.anchor;
}

function depsFor(dir, opts = {}) {
  const base = !!(opts && opts.base);
  const shift = base ? 0 : dirShift(dir);
  const key = (dir.express ? 'E|' : 'L|') + state.line.id + '|' + dir.to + '|' + state.day + '|S' + shift.toFixed(3);
  if (depCache.has(key)) return depCache.get(key);
  if (dir.depsExplicit) {
    let out = (dir.depsExplicit[state.day] || dir.depsExplicit.weekday || []).slice();
    if (shift) out = out.map((v) => v + shift);
    depCache.set(key, out);
    return out;
  }
  const segs = dir.hw[state.day] || dir.hw.weekday || [[0, 5]];
  const out = [];
  let t = dir.first;
  while (t <= dir.last + 1e-6 && out.length < 900) {
    out.push(t + shift);
    t += headwayAt(segs, t);
  }
  depCache.set(key, out);
  return out;
}

function depFirst(dir) { return dir.first + dirShift(dir); }
function depLast(dir) { return dir.last + dirShift(dir); }

/* ---------- 实际校正 ---------- */
function calibRecord() {
  if (!state.calib || state.calib.date !== todayKey(nowSim())) state.calib = { date: todayKey(nowSim()), lines: {} };
  if (!state.calib.lines) state.calib.lines = {};
  const id = String(state.line.id);
  const rec = state.calib.lines[id] || (state.calib.lines[id] = { name: state.line.name, dirs: {} });
  rec.name = state.line.name;
  if (!rec.dirs) rec.dirs = {};
  return rec;
}

function nextArrivalsAt(dir, stationIdx, nowMin, limit = 3, opts = {}) {
  const line = state.line;
  if (!line || !dir) return [];
  const st = line.stations[stationIdx];
  if (!st) return [];
  const base = !!(opts && opts.base);
  const out = [];
  const variants = [dir].concat(dir.expDirs || []);
  for (const d of variants) {
    if (d.express && !d.stopSet.has(st.name)) continue;
    const j = d.order.indexOf(stationIdx);
    if (j < 0) continue;
    const anchor = base ? -Infinity : dirAnchor(d, stationIdx);
    let n = 0;
    for (const dep of depsFor(d, base ? { base: true } : {})) {
      const dw = dwellWith(d, dep, j, base);
      const offs = offsetsOf(d, dep, base);
      const at = dep + (offs[j] || 0) - dw;
      const leave = at + dw;
      if (leave >= nowMin - 0.05 && at >= anchor - 0.05) {
        out.push({ dep, at, leave, d, j, dw });
        if (++n >= limit) break;
      }
    }
  }
  out.sort((a, b) => a.at - b.at);
  return out.slice(0, limit);
}

function calibrationInput(dirIndex, actualMin, stationIdx) {
  const line = state.line;
  if (!line) return { ok: false, error: '没有选中线路' };
  const dir = line.dirs[Number(dirIndex)];
  if (!dir) return { ok: false, error: '方向无效' };
  const st = line.stations[stationIdx];
  if (!st) return { ok: false, error: '站点无效' };
  const actual = Math.round(Number(actualMin) * 10) / 10;
  if (!Number.isFinite(actual) || actual < 0 || actual > 30) return { ok: false, error: '请输入 0–30 分钟' };
  return { ok: true, line, dir, st, actual, stationIdx: Number(stationIdx), nowMin: simMinutes(nowSim()) };
}

function refreshAfterCalib() {
  depCache.clear();
  state.lastPanelSec = -1;
  updateTrains(nowSim());
  renderPanel(true);
  renderCalib();
}

function clearLocalDir(dir, line) {
  if (!state.calib || !state.calib.lines) return;
  const lid = String(line.id);
  const rec = state.calib.lines[lid];
  if (!rec || !rec.dirs) return;
  delete rec.dirs[dir.to];
  if (dir.baseTo) delete rec.dirs[dir.baseTo];
  if (!Object.keys(rec.dirs).length) delete state.calib.lines[lid];
  if (!Object.keys(state.calib.lines).length) { state.calib = null; dropCalibStorage(); }
  else saveCalib();
}

function commitLocalCalibration(p) {
  const next = nextArrivalsAt(p.dir, p.stationIdx, p.nowMin, 1)[0];
  if (!next) return { ok: false, error: '该方向暂无可校正的后续列车' };
  const modelEta = Math.max(0, Math.round((next.at - p.nowMin) * 10) / 10);
  const oldShift = dirShift(p.dir);
  let shift = Math.round((oldShift + p.actual - modelEta) * 10) / 10;
  shift = clamp(shift, -30, 30);
  if (Math.abs(shift) < 0.05) shift = 0;
  const rec = calibRecord();
  const anchor = Math.round((p.nowMin + p.actual) * 10) / 10;
  rec.dirs[p.dir.to] = { shift, anchor, stationIdx: p.stationIdx, station: p.st.name, at: Date.now(), actual: p.actual, model: modelEta };
  rec.updated = Date.now();
  saveCalib();
  refreshAfterCalib();
  return { ok: true, shared: false, shift, modelEta, actual: p.actual, dir: p.dir.to, station: p.st.name };
}

async function submitSharedCalibration(p) {
  const next = nextArrivalsAt(p.dir, p.stationIdx, p.nowMin, 1, { base: true })[0];
  if (!next) return { ok: false, error: '该方向暂无可校正的后续列车' };
  const baseEta = Math.max(0, Math.round((next.at - p.nowMin) * 10) / 10);
  try {
    const r = await SYNC.post({
      lineId: String(p.line.id),
      dirTo: p.dir.baseTo || p.dir.to,
      stationName: p.st.name,
      serviceDate: todayKeyShanghai(),
      stationIdx: p.stationIdx,
      baseEta: Math.min(180, baseEta),
      actualMin: p.actual,
    });
    const key = p.dir.baseTo || p.dir.to;
    const count = Number(r && r.count) || 0;
    const shift = Number(r && r.shift);
    if (!(count > 0) || !Number.isFinite(shift)) throw new Error('共享服务没有返回有效校正');
    // 让提交期间已经发出的轮询结果失效，避免旧聚合把刚写入的校正盖回去。
    state.remoteSeq = (state.remoteSeq || 0) + 1;
    const remote = ensureRemote();
    remote.dirs[key] = {
      shift,
      count,
      updatedAt: Number(r.updatedAt) || Date.now(),
      windowMin: Number(r.windowMin) || 45,
    };
    state.remoteError = '';
    clearLocalDir(p.dir, p.line);
    refreshAfterCalib();
    return {
      ok: true, shared: true, shift: remote.dirs[key].shift, count: remote.dirs[key].count,
      actual: p.actual, dir: p.dir.to, station: p.st.name,
    };
  } catch (e) {
    const msg = (e && e.message) ? e.message : '共享服务异常';
    state.remoteError = msg;
    if (remoteFor(p.dir)) {
      renderCalib();
      return { ok: false, error: '共享提交失败：' + msg + '（当前仍用已有共享校正）' };
    }
    const local = commitLocalCalibration(p);
    if (local.ok) local.warning = '共享提交失败（' + msg + '），已先按本机校正';
    else local.error = '共享提交失败：' + msg + '；' + local.error;
    return local;
  }
}

function applyCalibration(dirIndex, actualMin, stationIdx = state.station) {
  const p = calibrationInput(dirIndex, actualMin, stationIdx);
  if (!p.ok) return p;
  if (syncEnabled()) return submitSharedCalibration(p);
  return commitLocalCalibration(p);
}

function clearCalibration() {
  const line = state.line;
  if (!line) return;
  if (state.calib && state.calib.lines) {
    delete state.calib.lines[String(line.id)];
    if (!Object.keys(state.calib.lines).length) { state.calib = null; dropCalibStorage(); }
    else saveCalib();
  }
  depCache.clear();
  state.lastPanelSec = -1;
  updateTrains(nowSim());
  renderPanel(true);
  renderCalib();
}

async function refreshRemote() {
  if (!syncEnabled() || !state.line) return null;
  const line = state.line;
  const seq = (state.remoteSeq || 0) + 1;
  state.remoteSeq = seq;
  const date = todayKeyShanghai();
  const keys = [];
  for (const d of line.dirs) {
    const k = d.baseTo || d.to;
    if (!keys.includes(k)) keys.push(k);
  }
  const prev = (state.remote && state.remote.date === date && state.remote.lineId === String(line.id))
    ? state.remote : { date, lineId: String(line.id), dirs: {} };
  const next = { date, lineId: String(line.id), dirs: Object.assign({}, prev.dirs) };
  const results = await Promise.all(keys.map((k) =>
    SYNC.get(line.id, k, date).then((v) => ({ k, v })).catch((e) => ({ k, error: e }))));
  if (state.remoteSeq !== seq || state.line !== line) return null;
  let changed = false;
  const errs = [];
  for (const x of results) {
    if (x.error) { errs.push(x.error.message || String(x.error)); continue; }
    const v = x.v || {};
    if (Number(v.count) > 0) {
      const old = next.dirs[x.k];
      if (!old || old.shift !== Number(v.shift) || old.count !== Number(v.count)) changed = true;
      next.dirs[x.k] = {
        shift: Number(v.shift) || 0,
        count: Number(v.count) || 0,
        updatedAt: Number(v.updatedAt) || 0,
        windowMin: Number(v.windowMin) || 45,
      };
    } else if (next.dirs[x.k]) {
      delete next.dirs[x.k];
      changed = true;
    }
  }
  state.remote = next;
  state.remoteError = errs[0] || '';
  if (changed) {
    depCache.clear();
    state.lastPanelSec = -1;
    updateTrains(nowSim());
    renderPanel(true);
  }
  renderCalib();
  return next;
}

function renderCalib() {
  const line = state.line;
  if (!line) return;
  const sel = $('#calibDir');
  if (!sel) return;
  const prev = sel.value;
  sel.innerHTML = line.dirs.map((d, i) => '<option value="' + i + '">往 ' + d.to + '</option>').join('');
  if (prev !== '' && Number(prev) < line.dirs.length) sel.value = prev;

  const localParts = [];
  if (state.calib && state.calib.date === todayKey(nowSim())) {
    const rec = state.calib.lines && state.calib.lines[String(line.id)];
    if (rec && rec.dirs) {
      for (const d of line.dirs) {
        const it = rec.dirs[d.to];
        if (it) localParts.push('往' + d.to + ' ' + (it.shift >= 0 ? '+' : '') + it.shift.toFixed(1) + ' 分');
      }
    }
  }

  const remoteParts = [];
  if (syncEnabled()) {
    const rr = (state.remote && state.remote.date === todayKeyShanghai() && state.remote.lineId === String(line.id))
      ? state.remote : null;
    if (rr && rr.dirs) {
      const seen = new Set();
      for (const d of line.dirs) {
        const k = d.baseTo || d.to;
        if (seen.has(k)) continue;
        seen.add(k);
        const it = rr.dirs[k];
        if (it && Number(it.count) > 0) {
          remoteParts.push('往' + d.to + ' ' + (it.shift >= 0 ? '+' : '') + Number(it.shift).toFixed(1) + ' 分（' + it.count + ' 条）');
        }
      }
    }
  }

  const shown = remoteParts.length ? remoteParts : localParts;
  const badge = $('#calibBadge');
  if (badge) {
    badge.hidden = !shown.length;
    badge.textContent = remoteParts.length ? '共享校正' : (localParts.length ? '今日已校正' : '');
  }
  const note = $('#calibNote');
  if (note) {
    if (remoteParts.length) {
      note.textContent = remoteParts.join(' · ') + '（45 分钟内中位，自动同步）' +
        (localParts.length ? ' · 本机校正已被共享覆盖' : '');
    } else if (localParts.length) {
      note.textContent = localParts.join(' · ') + (syncEnabled() ? '（仅本机，共享服务暂无数据）' : '（仅本线今日）');
    } else if (syncEnabled() && state.remoteError) {
      note.textContent = '共享服务连接失败：' + state.remoteError + '；可先用本机校正';
    } else {
      note.textContent = '看站台屏：选方向，填下一班还有几分钟；0 = 已到站';
    }
  }
  const mini = document.querySelector('.calibMini');
  if (mini) mini.textContent = syncEnabled() ? (state.remoteError ? '共享连接失败 · 先用本机' : '共享 · 45 分钟') : '仅本机 · 今日';
  const reset = $('#calibReset');
  if (reset) reset.disabled = !localParts.length;
}

async function calibrationFromUI() {
  const eta = $('#calibEta');
  if (!eta) return;
  const raw = String(eta.value || '').trim();
  if (!raw) { const note = $('#calibNote'); if (note) note.textContent = '先填站台屏上的分钟数'; return; }
  let r;
  try {
    r = await applyCalibration(Number($('#calibDir').value), Number(raw), state.station);
  } catch (e) {
    const note = $('#calibNote');
    if (note) note.textContent = '校正失败：' + ((e && e.message) || e);
    return;
  }
  if (!r || !r.ok) {
    const note = $('#calibNote');
    if (note) note.textContent = (r && r.error) || '校正失败';
    return;
  }
  eta.value = '';
  const note = $('#calibNote');
  if (note) {
    const head = r.shared
      ? '已共享：往 ' + r.dir + ' ' + (r.shift >= 0 ? '+' : '') + r.shift.toFixed(1) + ' 分 · ' + r.count + ' 条中位'
      : '已重算：往 ' + r.dir + ' ' + (r.shift >= 0 ? '+' : '') + r.shift.toFixed(1) + ' 分 · 仅本机';
    note.textContent = r.warning ? r.warning + ' · ' + head : head;
  }
}

/* ---------- 快车 ---------- */
function parseHM(s) { const [h, m] = s.split(':').map(Number); return h * 60 + m; }

function buildExpressDir(line, baseDir, sd) {
  const travel = baseDir.order;
  const first = travel.findIndex((idx) => line.stations[idx].name === sd.stops[0]);
  const last = travel.findIndex((idx) => line.stations[idx].name === sd.stops[sd.stops.length - 1]);
  if (first < 0 || last <= first) return null;
  const order = travel.slice(first, last + 1);
  const names = order.map((idx) => line.stations[idx].name);
  const rel = names.map((n) => (sd.rel[n] != null ? sd.rel[n] : null));
  const known = rel.map((v, k) => (v != null ? k : -1)).filter((k) => k >= 0);
  if (!known.length) return null;
  const baseOff = (k) => baseDir.offsets[k] - baseDir.offsets[first];
  for (let k = 0; k < rel.length; k++) {
    if (rel[k] != null) continue;
    let prev = null, next = null;
    for (const q of known) { if (q < k) prev = q; else if (q > k && next == null) next = q; }
    if (prev != null && next != null) {
      const span = baseOff(next) - baseOff(prev) || 1;
      rel[k] = rel[prev] + (rel[next] - rel[prev]) * (baseOff(k) - baseOff(prev)) / span;
    } else if (prev != null) {
      rel[k] = rel[prev] + (baseOff(k) - baseOff(prev)) * 0.6;
    } else {
      rel[k] = rel[next] - (baseOff(next) - baseOff(k)) * 0.6;
    }
  }
  const offsets = rel.slice();
  for (let k = 1; k < offsets.length; k++) {
    if (!(offsets[k] > offsets[k - 1])) offsets[k] = offsets[k - 1] + 0.4;
  }
  const deps = {
    weekday: (sd.deps.weekday || []).map(parseHM),
    weekend: (sd.deps.weekend || sd.deps.weekday || []).map(parseHM),
  };
  if (!deps.weekday.length) return null;
  return {
    to: names[names.length - 1], order, offsets, total: offsets[offsets.length - 1],
    first: Math.min(...deps.weekday), last: Math.max(...deps.weekday),
    hw: baseDir.hw, express: true, baseTo: baseDir.to, baseDir,
    depsExplicit: deps, stopSet: new Set(sd.stops), stopNames: sd.stops.slice(),
  };
}

function attachExpress(data, doc) {
  for (const line of data.lines) {
    const spec = doc.lines[line.name];
    if (!spec) continue;
    line.expressNote = spec.note || '';
    for (const dir of line.dirs) {
      const sd = spec.dirs[dir.to];
      if (!sd) continue;
      const ed = buildExpressDir(line, dir, sd);
      if (ed) { dir.expDirs = dir.expDirs || []; dir.expDirs.push(ed); }
    }
  }
}

/* ---------- 几何 ---------- */
function prepGeometry(line) {
  const pts = line.route;
  const cum = [0];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const kx = Math.cos(rad((a[1] + b[1]) / 2));
    cum.push(cum[i - 1] + Math.hypot((b[0] - a[0]) * kx, b[1] - a[1]));
  }
  const total = cum[cum.length - 1] || 1;
  const ptAtS = (s) => {
    const target = clamp(s, 0, 0.99999) * total;
    let lo = 0, hi = cum.length - 1;
    while (lo + 1 < hi) { const mid = (lo + hi) >> 1; if (cum[mid] <= target) lo = mid; else hi = mid; }
    const f = (target - cum[lo]) / ((cum[lo + 1] - cum[lo]) || 1);
    const a = pts[lo], b = pts[lo + 1];
    return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
  };
  return { cum, total, ptAtS };
}

/* 每个停靠站停留约 20–25 秒；快车在跳停站不停 */
function dwellFor(dir, i) {
  if (!dir || i <= 0 || i >= dir.offsets.length) return 0;
  const gap = dir.offsets[i] - dir.offsets[i - 1];
  if (!(gap > 0.02)) return 0;
  if (dir.express && state.line) {
    const st = state.line.stations[dir.order[i]];
    if (st && !dir.stopSet.has(st.name)) return 0;
  }
  return Math.min(0.42, gap * 0.35);
}

function originDwellFor(dir) { return dir ? ORIGIN_DWELL_MIN : 0; }
function stationDwell(dir, j) { return j > 0 ? dwellFor(dir, j) : originDwellFor(dir); }

/* 快车与慢车同站同时停靠的修正（方案 B）：慢车占着站台时，快车这一站直接通过；
   起点站另作处理——慢车在起点停 1 分钟期间快车不该也停在同一个站台，于是把该班快车
   整体顺延到慢车出站之后再发车。快车不排队等慢车，所以不会级联拖慢整条线。按天缓存。 */
const PLATFORM_MARGIN = 0.05;
const ORIGIN_STAGGER = 0.3;   // 起点让位：慢车出站后至少再隔这么久快车才发车

function dwellBase(dir, i) {
  if (!dir || i < 0 || i >= dir.offsets.length) return 0;
  if (i === 0) return originDwellFor(dir);
  const gap = dir.offsets[i] - dir.offsets[i - 1];
  if (!(gap > 0.02)) return 0;
  return Math.min(0.42, gap * 0.35);
}

function offsKey(dir, dep, isBase) {
  return Math.round((isBase ? dep : dep - dirShift(dir)) * 1000) / 1000;
}

function ensureExp(dir) {
  const owner = dir && dir.baseDir ? dir.baseDir : dir;
  if (!owner || !owner.expDirs || !owner.expDirs.length) return;
  if (owner._ndDay === state.day) return;
  owner._ndDay = state.day;
  const wins = new Map();
  for (const dep of depsFor(owner, { base: true })) {
    for (let j = 0; j < owner.offsets.length; j++) {
      const dw = dwellBase(owner, j);
      let list = wins.get(owner.order[j]);
      if (!list) { list = []; wins.set(owner.order[j], list); }
      list.push([dep + owner.offsets[j] - dw, dep + owner.offsets[j]]);
    }
  }
  for (const ed of owner.expDirs) {
    const offsMap = new Map(), skipMap = new Map();
    for (const dep of depsFor(ed, { base: true })) {
      const offs = ed.offsets.slice();
      const skip = new Set();
      let delta = 0, originClash = false;
      for (const [aL, dL] of wins.get(ed.order[0]) || []) {
        const arr0 = dep + offs[0] - dwellBase(ed, 0), dep0 = dep + offs[0];
        if (arr0 < dL + PLATFORM_MARGIN && dep0 > aL - PLATFORM_MARGIN) {
          originClash = true;
          if (dep < dL + PLATFORM_MARGIN) delta = Math.max(delta, dL + ORIGIN_STAGGER - dep);
        }
      }
      if (originClash) {
        if (delta > 0) for (let k = 0; k < offs.length; k++) offs[k] += delta;
        skip.add(0); // 起点不再提前停靠：慢车走了快车才出现，到点直接发车
      }
      for (let j = 1; j < offs.length; j++) {
        const dw = dwellBase(ed, j);
        if (!(dw > 0)) continue;
        const st = state.line.stations[ed.order[j]];
        if (!st || !ed.stopSet.has(st.name)) continue;
        const arr = dep + offs[j] - dw, depT = dep + offs[j];
        for (const [aL, dL] of wins.get(ed.order[j]) || []) {
          if (arr < dL + PLATFORM_MARGIN && depT > aL - PLATFORM_MARGIN) { skip.add(j); break; }
        }
      }
      const key = Math.round(dep * 1000) / 1000;
      offsMap.set(key, offs);
      skipMap.set(key, skip);
    }
    ed._offs = offsMap;
    ed._noDwell = skipMap;
  }
}

/* 该班车的运行时分偏移（快车可能因起点让位整体顺延） */
function offsetsOf(dir, dep, isBase) {
  if (!dir) return [];
  if (!dir.express) return dir.offsets;
  ensureExp(dir);
  const map = dir._offs;
  return (map && map.get(offsKey(dir, dep, isBase))) || dir.offsets;
}

/* 停站时长：慢车看区间间隔；快车在跳停站为 0，慢车占着站台时也不停 */
function dwellWith(dir, dep, i, isBase) {
  const base = dwellBase(dir, i);
  if (!(base > 0) || !dir.express || !state.line) return base;
  if (i > 0) {
    const st = state.line.stations[dir.order[i]];
    if (st && !dir.stopSet.has(st.name)) return 0;
  }
  ensureExp(dir);
  const set = dir._noDwell && dir._noDwell.get(offsKey(dir, dep, isBase));
  if (set && set.has(i)) return 0;
  return base;
}

function routeKmOf(line) {
  if (line._routeKm) return line._routeKm;
  const geom = prepGeometry(line);
  line._routeKm = geom.total * 111.32;
  return line._routeKm;
}

function segDistanceKm(line, A, B) {
  if (!A || !B) return 0;
  let ds = B.s - A.s;
  if (Math.abs(ds) > 0.5) ds += ds > 0 ? -1 : 1;
  return Math.abs(ds) * routeKmOf(line);
}

/* 站间速度曲线：出站加速、匀速、进站减速；对时间的积分正好走完区间。
   峰值默认 1.5 倍区间平均速度，长区间按 160 km/h 封顶，避免快线出现离谱速度。 */
function speedCurve(u, avgKmh) {
  const avg = Number.isFinite(avgKmh) && avgKmh > 0 ? avgKmh : 0;
  const peak = avg > 0 ? Math.max(1.02, Math.min(1.5, 160 / avg)) : 1.5;
  const t = 1 - 1 / peak;
  const cruise = 1 - 2 * t;
  if (u <= 0) return { f: 0, v: 0, peak };
  if (u >= 1) return { f: 1, v: 0, peak };
  if (u < t) {
    const x = u / t;
    return { f: 0.5 * peak * t * x * x, v: peak * x, peak };
  }
  if (u < t + cruise) {
    return { f: 0.5 * peak * t + peak * (u - t), v: peak, peak };
  }
  const w = (1 - u) / t;
  return { f: 1 - 0.5 * peak * t * w * w, v: peak * w, peak };
}

function trainPos(line, dir, minutes, dep) {
  if (minutes < 0) {
    const A = line.stations[dir.order[0]];
    const B = line.stations[dir.order[1]] || A;
    return { s: A.s, i: 0, f: 0, u: 0, A, B, dwelling: true, dwellLeft: -minutes, pre: true, speedKmh: 0, distKm: 0 };
  }
  const off = offsetsOf(dir, dep);
  const p = clamp(minutes, off[0] || 0, off[off.length - 1] || dir.total);
  let i = 0;
  while (i < off.length - 2 && p >= off[i + 1]) i++;
  const dwell = dwellWith(dir, dep, i + 1);
  const arrive = off[i + 1] - dwell;
  const moveSpan = Math.max(0.01, arrive - off[i]);
  const u = clamp((p - off[i]) / moveSpan, 0, 1);
  const dwelling = p >= arrive;
  const A = line.stations[dir.order[i]], B = line.stations[dir.order[i + 1]];
  let ds = B.s - A.s;
  if (Math.abs(ds) > 0.5) ds += ds > 0 ? -1 : 1;
  const distKm = segDistanceKm(line, A, B);
  const avgKmh = distKm > 0 ? (distKm / moveSpan) * 60 : 0;
  const curve = speedCurve(dwelling ? 1 : u, avgKmh);
  let speedKmh = 0;
  if (!dwelling && avgKmh > 0) speedKmh = avgKmh * curve.v;
  let s = (A.s + ds * curve.f + 1) % 1;
  return { s, i, f: curve.f, u, A, B, dwelling, dwellLeft: Math.max(0, off[i + 1] - p), pre: false, speedKmh, distKm };
}

/* 当前区间 A→B 的屏幕方向（SVG 的 y 向下，atan2 后直接用于 rotate） */
function trainAngle(line, proj, pos) {
  const A = pos.A, B = pos.B;
  if (!A || !B || !A.c || !B.c) return 0;
  const a = proj(A.c[0], A.c[1]), b = proj(B.c[0], B.c[1]);
  const ang = Math.atan2(b[1] - a[1], b[0] - a[0]) * 180 / Math.PI;
  return Number.isFinite(ang) ? ang : 0;
}

/* ---------- 投影 ---------- */
function makeProjection(line) {
  const W = 1000, H = 680, PAD = 72;
  let latSum = 0;
  for (const p of line.route) latSum += p[1];
  const lat0 = latSum / line.route.length;
  const kx = Math.cos(rad(lat0));
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const p of line.route) {
    const x = p[0] * kx, y = p[1];
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  const dx = Math.max(1e-9, maxX - minX), dy = Math.max(1e-9, maxY - minY);
  const k = Math.min((W - 2 * PAD) / dx, (H - 2 * PAD) / dy);
  const ox = (W - dx * k) / 2 - minX * k;
  const oy = (H - dy * k) / 2 + maxY * k;
  return (lng, lat) => [lng * kx * k + ox, oy - lat * k];
}

function stationXY(line, proj, st) {
  if (st.c) return proj(st.c[0], st.c[1]);
  return null;
}

const svgEl = (tag, attrs) => {
  const el = document.createElementNS(NS, tag);
  if (attrs) for (const k in attrs) el.setAttribute(k, attrs[k]);
  return el;
};

/* ---------- 线路列表 ---------- */
function lineSort(a, b) {
  const ga = a.group === 'tram' ? 1 : 0, gb = b.group === 'tram' ? 1 : 0;
  if (ga !== gb) return ga - gb;
  const na = parseInt(a.code, 10), nb = parseInt(b.code, 10);
  const va = Number.isFinite(na) ? na : 900, vb = Number.isFinite(nb) ? nb : 900;
  if (va !== vb) return va - vb;
  return a.name.localeCompare(b.name, 'zh');
}
function buildLineBar() {
  const bar = $('#lineBar');
  bar.innerHTML = '';
  const lines = [...state.data.lines].sort(lineSort);
  for (const line of lines) {
    const b = document.createElement('button');
    b.className = 'chip';
    b.style.setProperty('--c', line.color);
    b.dataset.key = line.name;
    b.innerHTML = '<i></i><span>' + line.name.replace(/（.*?）/, (m) => m) + '</span>';
    b.addEventListener('click', () => {
      const keep = state.line ? state.line.stations[state.station]?.name : null;
      selectLine(line, keep);
    });
    bar.appendChild(b);
  }
}

function pickStation(line, preferName) {
  if (preferName) {
    const i = line.stations.findIndex((s) => s.name === preferName);
    if (i >= 0) return i;
  }
  const mid = Math.floor(line.stations.length / 2);
  let best = mid, bestD = Infinity;
  line.stations.forEach((s, i) => {
    if (!s.hc || !s.hc.length) return;
    const d = Math.abs(i - mid);
    if (d < bestD) { bestD = d; best = i; }
  });
  return best;
}

function selectLine(line, preferName) {
  state.line = line;
  state.station = pickStation(line, preferName);
  state.view = { z: 1, x: 0, y: 0 };
  state.tip = null;
  $('#trainTip').hidden = true;
  document.querySelectorAll('.chip').forEach((c) => c.classList.toggle('active', c.dataset.key === line.name));
  const sel = $('#stSelect');
  sel.innerHTML = line.stations.map((s, i) => '<option value="' + i + '">' + s.name + (s.hc && s.hc.length ? ' · 换乘' : '') + '</option>').join('');
  sel.value = String(state.station);
  renderMap();
  renderPanel(true);
  const eta = $('#calibEta'); if (eta) eta.value = '';
  const cdir = $('#calibDir'); if (cdir) cdir.value = '';
  state.remote = null;
  state.remoteError = '';
  renderCalib();
  if (syncEnabled()) refreshRemote();
  const hash = '#line=' + encodeURIComponent(line.name) + '&st=' + encodeURIComponent(line.stations[state.station].name);
  history.replaceState(null, '', hash);
}

/* ---------- 地图 ---------- */
function renderMap() {
  const line = state.line;
  const svg = $('#map');
  svg.innerHTML = '';
  const defs = svgEl('defs');
  const grid = svgEl('pattern', { id: 'grid', width: 44, height: 44, patternUnits: 'userSpaceOnUse' });
  grid.appendChild(svgEl('path', { d: 'M44 0H0V44', fill: 'none', stroke: 'rgba(120,160,220,.055)', 'stroke-width': 1 }));
  defs.appendChild(grid);
  const glow = svgEl('filter', { id: 'glow', x: '-40%', y: '-40%', width: '180%', height: '180%' });
  glow.appendChild(svgEl('feGaussianBlur', { stdDeviation: 3.2, result: 'b' }));
  const merge = svgEl('feMerge');
  merge.appendChild(svgEl('feMergeNode', { in: 'b' }));
  merge.appendChild(svgEl('feMergeNode', { in: 'SourceGraphic' }));
  glow.appendChild(merge);
  defs.appendChild(glow);
  svg.appendChild(defs);
  svg.appendChild(svgEl('rect', { x: 0, y: 0, width: 1000, height: 680, fill: 'url(#grid)' }));

  const world = svgEl('g', { id: 'world' });
  svg.appendChild(world);
  state.world = world;
  state.svg = svg;
  applyView();

  const proj = makeProjection(line);
  state.proj = proj;
  state.geom = prepGeometry(line);

  const d = line.route.map((p, i) => {
    const [x, y] = proj(p[0], p[1]);
    return (i ? 'L' : 'M') + x.toFixed(1) + ' ' + y.toFixed(1);
  }).join(' ');
  world.appendChild(svgEl('path', { d, fill: 'none', stroke: '#060c16', 'stroke-width': 13, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', opacity: 0.9 }));
  world.appendChild(svgEl('path', { d, fill: 'none', stroke: line.color, 'stroke-width': 5.2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', opacity: 0.92 }));
  world.appendChild(svgEl('path', { d, fill: 'none', stroke: line.color, 'stroke-width': 1.1, 'stroke-linecap': 'round', opacity: 0.35, filter: 'url(#glow)' }));

  const pts = line.stations.map((st) => stationXY(line, proj, st)).filter(Boolean);
  const placed = [];
  const labels = svgEl('g', { id: 'labels' });
  const dots = svgEl('g', { id: 'dots' });
  const order = line.stations.map((s, i) => i).sort((a, b) => {
    const pa = (a === state.station ? 3 : 0) + (line.stations[a].hc.length ? 2 : 0);
    const pb = (b === state.station ? 3 : 0) + (line.stations[b].hc.length ? 2 : 0);
    return pb - pa || a - b;
  });

  // 站点
  line.stations.forEach((st, i) => {
    const xy = stationXY(line, proj, st);
    if (!xy) return;
    const [x, y] = xy;
    const transfer = st.hc && st.hc.length > 0;
    const selected = i === state.station;
    const g = svgEl('g', { class: 'stationNode', 'data-i': i });
    if (selected) {
      g.appendChild(svgEl('circle', { cx: x, cy: y, r: 12, fill: 'none', stroke: '#7ff0c8', 'stroke-width': 1.2, opacity: 0.55, class: 'selRing' }));
    }
    g.appendChild(svgEl('circle', {
      cx: x, cy: y, r: transfer ? 5.6 : 3.6,
      fill: transfer ? '#0a1322' : '#dce8ff',
      stroke: transfer ? line.color : '#0a1322',
      'stroke-width': transfer ? 2.4 : 1.4,
    }));
    if (transfer) g.appendChild(svgEl('circle', { cx: x, cy: y, r: 1.7, fill: '#fff' }));
    g.appendChild(svgEl('circle', { cx: x, cy: y, r: 13, fill: 'transparent', style: 'cursor:pointer' }));
    const title = svgEl('title'); title.textContent = st.name; g.appendChild(title);
    g.addEventListener('click', (e) => { e.stopPropagation(); selectStation(i); });
    dots.appendChild(g);
  });

  // 站名：沿线法向优先，做简单碰撞避让
  const boxes = [];
  const hit = (r) => boxes.some((b) => !(r.x + r.w < b.x || r.x > b.x + b.w || r.y + r.h < b.y || r.y > b.y + b.h));
  for (const i of order) {
    const st = line.stations[i];
    const xy = stationXY(line, proj, st);
    if (!xy) continue;
    const [x, y] = xy;
    const selected = i === state.station;
    const transfer = st.hc && st.hc.length > 0;
    const name = st.name;
    const w = name.length * 11.5 + 8, h = 15;
    const pr = trainPos(line, line.dirs[0], 0);
    // 用站点在路线上的切向求法向
    const p1 = state.geom.ptAtS(clamp(st.s - 0.003, 0, 0.9999));
    const p2 = state.geom.ptAtS(clamp(st.s + 0.003, 0, 0.9999));
    const q1 = proj(p1[0], p1[1]), q2 = proj(p2[0], p2[1]);
    let nx = -(q2[1] - q1[1]), ny = q2[0] - q1[0];
    const nl = Math.hypot(nx, ny) || 1; nx /= nl; ny /= nl;
    if (ny > 0) { nx = -nx; ny = -ny; }
    const cands = [
      [nx * 21, ny * 21], [-nx * 21, -ny * 21],
      [nx * 13 + 10, ny * 13 - 10], [nx * 13 - 10, ny * 13 + 10],
      [0, -19], [0, 19],
    ];
    let rect = null;
    for (const [dx, dy] of cands) {
      const cx = x + dx, cy = y + dy;
      const r = { x: cx - w / 2, y: cy - h / 2, w, h };
      if (selected || !hit(r)) { rect = r; break; }
    }
    if (!rect) continue;
    boxes.push(rect);
    if (selected) {
      labels.appendChild(svgEl('rect', {
        x: rect.x - 3, y: rect.y - 1, width: rect.w + 6, height: rect.h + 2, rx: 6,
        fill: 'rgba(6,14,26,.92)', stroke: 'rgba(127,240,200,.55)', 'stroke-width': 1,
      }));
    }
    const t = svgEl('text', {
      x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 + 0.5,
      'text-anchor': 'middle', 'dominant-baseline': 'middle',
      'font-size': transfer ? 11.5 : 10.5,
      'font-weight': selected ? 700 : (transfer ? 600 : 400),
      fill: selected ? '#ffffff' : (transfer ? '#c3d4ef' : '#8fa4c4'),
      style: 'pointer-events:none;paint-order:stroke;stroke:rgba(7,13,24,.85);stroke-width:2.5px',
    });
    t.textContent = name;
    labels.appendChild(t);
  }
  world.appendChild(labels);
  world.appendChild(dots);
  const trains = svgEl('g', { id: 'trains' });
  world.appendChild(trains);
  state.trainLayer = trains;
  updateTrains(nowSim());
}

function applyView() {
  if (!state.world) return;
  const v = state.view;
  state.world.setAttribute('transform', 'translate(' + v.x.toFixed(2) + ' ' + v.y.toFixed(2) + ') scale(' + v.z.toFixed(3) + ')');
}

function svgPoint(evt) {
  const svg = state.svg;
  const p = svg.createSVGPoint();
  p.x = evt.clientX; p.y = evt.clientY;
  return p.matrixTransform(svg.getScreenCTM().inverse());
}

/* ---------- 列车 ---------- */
function activeTrains(line, dir, nowMin) {
  const out = [];
  const deps = depsFor(dir);
  let cutoff = -Infinity;
  const rec = dirCalib(dir);
  if (rec && Number.isFinite(rec.anchor) && rec.stationIdx != null) {
    const j = dir.order.indexOf(Number(rec.stationIdx));
    if (j >= 0) {
      const dw = stationDwell(dir, j);
      cutoff = rec.anchor - ((dir.offsets[j] || 0) - dw);
    }
  }
  for (const dep of deps) {
    if (dep < cutoff - 0.05) continue;
    const t = nowMin - dep;
    const pre = dwellWith(dir, dep, 0);
    const offs = offsetsOf(dir, dep);
    if (t >= -pre + (offs[0] || 0) && t <= (offs[offs.length - 1] || dir.total)) out.push({ dep, t, pre: t < 0 });
  }
  return out;
}

function updateTrains(now) {
  const line = state.line;
  if (!line || !state.trainLayer) return;
  const nowMin = simMinutes(now);
  const layer = state.trainLayer;
  layer.innerHTML = '';
  state.trains = [];
  const variants = [];
  for (const dir of line.dirs) {
    variants.push(dir);
    for (const e of (dir.expDirs || [])) variants.push(e);
  }
  for (const dir of variants) {
    for (const { dep, t } of activeTrains(line, dir, nowMin)) {
      const pos = trainPos(line, dir, t, dep);
      const p = state.geom.ptAtS(pos.s);
      const [x, y] = state.proj(p[0], p[1]);
      const g = svgEl('g', { class: 'trainDot' + (dir.express ? ' express' : '') + (pos.dwelling ? ' dwelling' : ''), style: 'cursor:pointer' });
      const angle = trainAngle(line, state.proj, pos);
      if (dir.express) {
        g.appendChild(svgEl('rect', { x: x - 5.2, y: y - 5.2, width: 10.4, height: 10.4, rx: 2.4, fill: '#ff9f43', stroke: '#fff', 'stroke-width': 1.4 }));
        const tx = svgEl('text', { x: x, y: y + 0.4, 'text-anchor': 'middle', 'dominant-baseline': 'middle', 'font-size': 7.2, 'font-weight': 800, fill: '#231303', style: 'pointer-events:none' });
        tx.textContent = '快';
        g.appendChild(tx);
      } else {
        g.appendChild(svgEl('circle', { cx: x, cy: y, r: 10, fill: 'none', stroke: line.color, 'stroke-width': 1.2, opacity: 0.35, class: 'pulse' }));
        g.appendChild(svgEl('circle', { cx: x, cy: y, r: 5.4, fill: '#ffffff', stroke: line.color, 'stroke-width': 2.2 }));
        g.appendChild(svgEl('circle', { cx: x, cy: y, r: 1.5, fill: line.color }));
      }
      const arrow = svgEl('g', { transform: 'translate(' + x.toFixed(2) + ' ' + y.toFixed(2) + ') rotate(' + angle.toFixed(1) + ')' });
      arrow.appendChild(svgEl('path', {
        d: 'M8.4 -3.2 L13.8 0 L8.4 3.2 Z',
        fill: dir.express ? '#ffd08a' : line.color,
        stroke: '#fff',
        'stroke-width': 1.1,
        'stroke-linejoin': 'round',
      }));
      g.appendChild(arrow);
      let nextName = pos.B.name;
      if (dir.express) {
        for (let k = pos.i + 1; k < dir.order.length; k++) {
          const n = line.stations[dir.order[k]].name;
          if (dir.stopSet.has(n)) { nextName = n; break; }
        }
      }
      const offsT = offsetsOf(dir, dep);
      const atTerminal = !pos.pre && pos.i + 1 >= offsT.length - 1;
      const dwellSec = pos.pre ? Math.max(0, Math.round(-t * 60)) : Math.max(0, Math.round((offsT[pos.i + 1] - t) * 60));
      const dwellTxt = pos.pre ? '起点站停站中 · 约 ' + dwellSec + ' 秒后发车' : (atTerminal ? '终到站停站中' : '停站中 · 约 ' + dwellSec + ' 秒后发车');
      const speedTxt = (!pos.pre && !pos.dwelling && Number.isFinite(pos.speedKmh)) ? ' · 约 ' + Math.round(pos.speedKmh) + ' km/h' : '';
      const depShow = dep + (offsT[0] || 0);
      const title = svgEl('title');
      title.textContent = (dir.express ? '快车 · ' : '') + '往 ' + dir.to + ' · ' + fmtHM(depShow) + ' 发车' + (pos.dwelling ? ' · ' + dwellTxt : speedTxt);
      g.appendChild(title);
      g.addEventListener('click', (e) => {
        e.stopPropagation();
        $('#trainTip').hidden = false;
        $('#trainTip').innerHTML = '<b>' + (dir.express ? '快车 · ' : '') + '往 ' + dir.to + '</b>' + fmtHM(depShow) + ' 发车 · ' + (pos.pre ? '起点站待发' : '已运行 ' + Math.floor(t) + ' 分' + speedTxt) + '<br>' + (pos.dwelling ? dwellTxt : '下一站 ' + nextName);
      });
      layer.appendChild(g);
      state.trains.push({ dir, dep, t, express: !!dir.express, angle, x, y, dwelling: pos.dwelling, dwellSec, pre: !!pos.pre, speedKmh: pos.speedKmh });
    }
  }
  const hud = $('#hud');
  const d0 = line.dirs[0];
  const expN = state.trains.filter((x) => x.express).length;
  hud.innerHTML = '<div class="hName">' + line.name + '</div>' +
    '<div class="hSub">' + line.stations.length + ' 站 · 全程 ' + Math.round(d0.total) + ' 分 · ' + state.trains.length + ' 列车运行中' +
    (expN ? '（快车 ' + expN + '）' : '') + '</div>';
  $('#footTrains').textContent = state.trains.length + ' 列（推演' + (expN ? '，快车 ' + expN : '') + '）';
}

/* ---------- 右侧面板 ---------- */
function selectStation(i) {
  state.station = i;
  $('#stSelect').value = String(i);
  renderMap();
  renderPanel(true);
  const hash = '#line=' + encodeURIComponent(state.line.name) + '&st=' + encodeURIComponent(state.line.stations[i].name);
  history.replaceState(null, '', hash);
}

function stopsAhead(line, dir, stationIdx, pos) {
  const j = dir.order.indexOf(stationIdx);
  if (j < 0) return 0;
  if (dir.express) {
    let c = 0;
    for (let k = pos.i + 1; k <= j; k++) {
      if (dir.stopSet.has(line.stations[dir.order[k]].name)) c++;
    }
    return c;
  }
  if (line.name === '十一号线') return (j - pos.i + dir.order.length) % dir.order.length;
  return j - pos.i;
}

function renderPanel(force) {
  const line = state.line;
  const st = line.stations[state.station];
  if (!st) return;
  $('#stName').textContent = st.name;
  const badges = [];
  badges.push('<span class="badge" style="border-color:' + line.color + '66;color:' + line.color + '">' + line.name + '</span>');
  for (const h of (st.hc || [])) {
    const c = colorByName.get(h) || '#8fa0bd';
    badges.push('<span class="badge" style="border-color:' + c + '55;color:' + c + '">' + h + '</span>');
  }
  $('#stBadges').innerHTML = badges.join('');
  $('#footData').textContent = state.data.serviceDate;

  const now = nowSim();
  const nowMin = simMinutes(now);
  const cards = [];
  for (const dir of line.dirs) {
    const exp = (dir.expDirs || [])[0] || null;
    const expServes = !!(exp && exp.stopSet.has(st.name));
    const jBase = dir.order.indexOf(state.station);
    const jExp = expServes ? exp.order.indexOf(state.station) : -1;
    const known = jBase >= 0 || jExp >= 0;
    const shownDir = jBase >= 0 ? dir : (exp || dir);
    const shownJ = jBase >= 0 ? jBase : jExp;
    const firstDwell = known && shownJ > 0 ? stationDwell(shownDir, shownJ) : 0;
    const a = known ? depFirst(shownDir) + (shownDir.offsets[shownJ] || 0) - firstDwell : 0;
    const b = known ? depLast(shownDir) + (shownDir.offsets[shownJ] || 0) - firstDwell : 0;
    const preService = known && nowMin < a && a - nowMin > 60;
    let rows = '';
    if (!known) {
      rows = '<div class="empty">该方向不经本站</div>';
    } else if (preService) {
      rows = '<div class="empty">现在非运营时间<br>今日首班约 ' + fmtHM(a) + '</div>';
    } else {
      const locals = [], exps = [];
      for (const d of [dir, exp]) {
        if (!d) continue;
        if (d.express && !expServes) continue;
        const j = d.order.indexOf(state.station);
        if (j < 0) continue;
        let n = 0;
        const anchor = dirAnchor(d, state.station);
        for (const dep of depsFor(d)) {
          const dw = dwellWith(d, dep, j);
          const offs = offsetsOf(d, dep);
          const at = dep + (offs[j] || 0) - dw;
          const leave = at + dw;
          if (leave >= nowMin - 0.05 && at >= anchor - 0.05) {
            (d.express ? exps : locals).push({ dep, at, leave, d });
            if (++n >= 3) break;
          }
        }
      }
      const arrivals = (expServes && exps.length)
        ? locals.slice(0, 2).concat(exps.slice(0, 1)).sort((x, y) => x.at - y.at)
        : locals.slice(0, 3);
      if (!arrivals.length) {
        if (state.trains.length) {
          rows = '<div class="empty">本站末班已过<br>线上还有 ' + state.trains.length + ' 列车在跑完区间</div>';
        } else if (nowMin < 4 * 60) {
          rows = '<div class="empty">今日首班约 ' + fmtHM(a) + '<br>现在还没开始运营</div>';
        } else {
          rows = '<div class="empty">今日运营已结束<br>明日首班约 ' + fmtHM(a) + '</div>';
        }
      } else {
        arrivals.forEach((x, k) => {
          const diff = Math.max(0, x.at - nowMin);
          const totalSec = Math.round(diff * 60);
          const mm = Math.floor(totalSec / 60), ss = totalSec % 60;
          const here = nowMin >= x.at - 0.05 && nowMin <= x.leave + 0.05;
          const soon = diff < 0.7;
          const pos = trainPos(line, x.d, nowMin - x.dep, x.dep);
          const stops = (pos.dwelling && pos.B === st) ? 0 : stopsAhead(line, x.d, state.station, pos);
          const stopTxt = stops > 0 ? '还有 ' + stops + ' 站 · ' : '';
          const right = (k === 0 ? stopTxt : '') + fmtHM(x.at) + ' 到站';
          rows += '<div class="arrRow' + (k === 0 ? ' first' : '') + '">' +
            '<div class="arrLeft">' +
              (x.d.express ? '<span class="expTag">快</span>' : '') +
              (here ? '<span class="count soon">已到站</span>' :
                soon ? '<span class="count soon">即将到站</span>' :
                '<span class="count">' + mm + '</span><span class="unit">分</span>' +
                '<span class="count sec">' + String(ss).padStart(2, '0') + '</span><span class="unit">秒</span>') +
            '</div>' +
            '<div class="clockAt">' + right + '</div>' +
          '</div>';
        });
      }
    }
    let expNote = '';
    if (exp) {
      expNote = jExp < 0
        ? '<div class="expNote">快车不停本站 · 停靠 ' + exp.stopNames.length + ' 站</div>'
        : '<div class="expNote">快车停靠本站 · 全程 ' + exp.stopNames.length + ' 站</div>';
    }
    cards.push('<div class="dirCard" style="--c:' + line.color + '">' +
      '<div class="dirHead"><div class="dirName"><i></i>往 ' + dir.to +
      (exp ? '<span class="expChip">快车</span>' : '') + '</div>' +
      '<div class="dirMeta">' + (known ? '首 ' + fmtHM(a) + ' · 末 ' + fmtHM(b) : '—') + '</div></div>' + rows + expNote + '</div>');
  }
  $('#dirCards').innerHTML = cards.join('');
}

/* ---------- 主循环 ---------- */
let rafAt = 0;
function tick(force) {
  if (!state.line) return;
  const now = nowSim();
  if (state.calib && state.calib.date !== todayKey(nowSim())) { state.calib = null; depCache.clear(); renderCalib(); }
  const day = dayTypeOf(now);
  if (day !== state.day) {
    state.day = day;
    depCache.clear();
    $('#dayType').textContent = (day === 'weekend' ? '周末图' : '工作日图') + ' · ' + ['周日','周一','周二','周三','周四','周五','周六'][now.getDay()];
  }
  $('#clock').textContent = fmtClock(now) + (state.speed !== 1 ? ' ×' + state.speed : '');
  updateTrains(now);
  const sec = Math.floor(now.getTime() / 1000);
  if (force || sec !== state.lastPanelSec) {
    state.lastPanelSec = sec;
    renderPanel(force);
  }
}

/* ---------- 缩放 / 拖动 ---------- */
function bindView() {
  const svg = $('#map');
  let drag = null;
  const pointers = new Map();
  let pinch = null;

  svg.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.trainDot') || e.target.closest('.stationNode')) return;
    pointers.set(e.pointerId, svgPoint(e));
    svg.setPointerCapture(e.pointerId);
    if (pointers.size === 1) drag = { p: svgPoint(e), x: state.view.x, y: state.view.y };
    if (pointers.size === 2) { const [a, b] = [...pointers.values()]; pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), z: state.view.z }; drag = null; }
  });
  svg.addEventListener('pointermove', (e) => {
    if (!pointers.has(e.pointerId)) return;
    const p = svgPoint(e);
    pointers.set(e.pointerId, p);
    if (pointers.size === 2 && pinch) {
      const [a, b] = [...pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      zoomAt((a.x + b.x) / 2, (a.y + b.y) / 2, pinch.z * d / (pinch.d || 1));
      return;
    }
    if (drag) {
      state.view.x = drag.x + p.x - drag.p.x;
      state.view.y = drag.y + p.y - drag.p.y;
      applyView();
    }
  });
  const up = (e) => {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinch = null;
    if (pointers.size === 0) drag = null;
  };
  svg.addEventListener('pointerup', up);
  svg.addEventListener('pointercancel', up);

  svg.addEventListener('wheel', (e) => {
    e.preventDefault();
    const p = svgPoint(e);
    zoomAt(p.x, p.y, state.view.z * Math.exp(-e.deltaY * 0.0012));
  }, { passive: false });

  svg.addEventListener('dblclick', () => {
    state.view = { z: 1, x: 0, y: 0 };
    applyView();
  });
}
function zoomAt(px, py, z) {
  z = clamp(z, 0.85, 4.5);
  const v = state.view;
  const ratio = z / v.z;
  v.x = px - (px - v.x) * ratio;
  v.y = py - (py - v.y) * ratio;
  v.z = z;
  applyView();
}

/* ---------- 事件 ---------- */
function bindUI() {
  $('#speedBtn').addEventListener('click', () => {
    const next = state.speed === 1 ? 60 : state.speed === 60 ? 300 : 1;
    setSpeed(next);
  });
  $('#aboutBtn').addEventListener('click', () => { $('#about').hidden = false; });
  $('#closeAbout').addEventListener('click', () => { $('#about').hidden = true; });
  $('#about').addEventListener('click', (e) => { if (e.target.id === 'about') $('#about').hidden = true; });
  $('#stSelect').addEventListener('change', (e) => selectStation(Number(e.target.value)));
  $('#prevSt').addEventListener('click', () => selectStation((state.station - 1 + state.line.stations.length) % state.line.stations.length));
  $('#nextSt').addEventListener('click', () => selectStation((state.station + 1) % state.line.stations.length));
  $('#map').addEventListener('click', () => { $('#trainTip').hidden = true; });
  const calibApply = $('#calibApply');
  if (calibApply) calibApply.addEventListener('click', calibrationFromUI);
  const calibEta = $('#calibEta');
  if (calibEta) calibEta.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); calibrationFromUI(); } });
  const calibReset = $('#calibReset');
  if (calibReset) calibReset.addEventListener('click', clearCalibration);
}

/* ---------- 启动 ---------- */
async function main() {
  const [res, expRes] = await Promise.all([
    fetch('data.json', { cache: 'no-store' }),
    fetch('express.json', { cache: 'no-store' }),
  ]);
  state.data = await res.json();
  if (expRes.ok) attachExpress(state.data, await expRes.json());
  for (const l of state.data.lines) colorByName.set(l.name, l.color);
  state.calib = readCalib();
  $('#dataVer').textContent = '时刻表 ' + state.data.serviceDate;
  buildLineBar();
  bindUI();
  bindView();
  const hash = new URLSearchParams(location.hash.slice(1));
  const wantLine = hash.get('line');
  const wantSt = hash.get('st');
  const line = state.data.lines.find((l) => l.name === wantLine) ||
    state.data.lines.find((l) => l.code === '1') || state.data.lines[0];
  selectLine(line, wantSt);
  state.day = dayTypeOf(nowSim());
  globalThis.__gz = { state, selectLine, selectStation, renderMap, renderPanel, nowSim, tick, trainPos, dwellFor, depsFor, activeTrains, stationDwell, originDwellFor, dirShift, dirAnchor, remoteFor, refreshRemote, nextArrivalsAt, applyCalibration, clearCalibration, renderCalib, todayKeyShanghai, dwellWith, ensureExp, offsetsOf, dwellBase };
  tick(true);
  setInterval(() => tick(false), 250);
  if (syncEnabled()) {
    const pollMs = Number(SYNC.pollMs) || 30000;
    setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      refreshRemote();
    }, pollMs);
    if (typeof document !== 'undefined' && document.addEventListener) {
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState !== 'hidden') refreshRemote();
      });
    }
  }
  // 手机上把地址栏 hash 同步为可分享状态
}

main().catch((e) => {
  document.body.innerHTML = '<pre style="color:#f88;padding:20px;white-space:pre-wrap">加载失败：' + (e && e.message) + '</pre>';
});
