-- Cloudflare D1 schema cho báo cáo sản xuất & nhân lực
-- Chạy: npx wrangler d1 execute kpi-db --remote --file=schema.sql

-- Dữ liệu hiện hành: mỗi ngày báo cáo = 1 dòng (key = 'day:YYYY-MM-DD'), cộng 'hcTO' và 'writer'
CREATE TABLE IF NOT EXISTS kv (
  key         TEXT PRIMARY KEY,
  value       TEXT,              -- JSON; NULL = đã xoá (tombstone, để máy khác nhận được lệnh xoá)
  updated_at  INTEGER NOT NULL,  -- epoch ms
  updated_by  TEXT
);
CREATE INDEX IF NOT EXISTS idx_kv_updated ON kv(updated_at);

-- Lịch sử sửa (giữ 50 bản gần nhất mỗi key) → khôi phục khi nhập nhầm
CREATE TABLE IF NOT EXISTS history (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  key         TEXT NOT NULL,
  value       TEXT,
  updated_at  INTEGER NOT NULL,
  updated_by  TEXT
);
CREATE INDEX IF NOT EXISTS idx_history_key ON history(key, id);
