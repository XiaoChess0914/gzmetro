-- 广州地铁 · 共享校正 D1 表结构
-- 在 Cloudflare D1 控制台执行本文件（或 wrangler d1 execute gzmetro-sync --file=schema.sql）
CREATE TABLE IF NOT EXISTS reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  line_id TEXT NOT NULL,
  dir_to TEXT NOT NULL,
  station_idx INTEGER NOT NULL,
  station_name TEXT NOT NULL,
  service_date TEXT NOT NULL,
  base_eta REAL NOT NULL,
  actual_min REAL NOT NULL,
  shift REAL NOT NULL,
  client_id TEXT NOT NULL DEFAULT '',
  ip_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_reports_lookup
  ON reports (line_id, dir_to, service_date, created_at);

CREATE INDEX IF NOT EXISTS idx_reports_ip
  ON reports (ip_hash, created_at);
