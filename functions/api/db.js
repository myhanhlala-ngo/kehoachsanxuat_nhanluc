/**
 * API dữ liệu chung cho báo cáo "일일 생산 운영 계획 & 인력 소요 현황"
 * Cloudflare Pages Function  →  URL: /api/db
 * Lưu trữ: Cloudflare D1 (binding tên DB, xem wrangler.toml)
 *
 * Hợp đồng API (giữ nguyên như bản Netlify để index.html không phải sửa logic):
 *   GET  /api/db?action=all            → { ok, now, data: { key: { value, t, by } } }
 *   GET  /api/db?action=since&t=<ms>   → { ok, now, data: { ...chỉ các key đổi sau t } }
 *   POST /api/db  (text/plain JSON)    body { action:'set', by, items:[{ key, value }] } → { ok, now, n }
 *   GET  /api/db?action=history&key=<key>&limit=20  → { ok, rows:[...] }   (tra cứu lịch sử sửa)
 *
 * key hợp lệ: "day:YYYY-MM-DD" | "hcTO" | "writer".  value = null nghĩa là xoá (lưu dạng tombstone).
 */

const KEY_RE = /^(day:\d{4}-\d{2}-\d{2}|hcTO|writer)$/;
const MAX_VALUE_BYTES = 900_000; // D1 giới hạn ~1 MB/giá trị (2 MB/hàng) → chặn sớm cho an toàn
const HISTORY_KEEP = 50;        // giữ 50 bản gần nhất cho mỗi key

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': 'https://assy-portal.pages.dev',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Vary': 'Origin',
};

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: {
      ...CORS_HEADERS,
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });

function rowsToData(rows) {
  const data = {};
  for (const r of rows) {
    data[r.key] = { value: r.value === null ? null : JSON.parse(r.value), t: r.updated_at, by: r.updated_by };
  }
  return data;
}

export async function onRequestGet({ request, env }) {
  try {
    const url = new URL(request.url);
    const action = url.searchParams.get('action') || 'all';
    const now = Date.now();

    if (action === 'all') {
      const { results } = await env.DB.prepare(
        'SELECT key, value, updated_at, updated_by FROM kv'
      ).all();
      return json({ ok: true, now, data: rowsToData(results) });
    }

    if (action === 'since') {
      const t = Number(url.searchParams.get('t')) || 0;
      const { results } = await env.DB.prepare(
        'SELECT key, value, updated_at, updated_by FROM kv WHERE updated_at > ?1'
      ).bind(t).all();
      return json({ ok: true, now, data: rowsToData(results) });
    }

    if (action === 'history') {
      const key = url.searchParams.get('key') || '';
      const limit = Math.min(Number(url.searchParams.get('limit')) || 20, 100);
      const { results } = await env.DB.prepare(
        'SELECT id, key, updated_at, updated_by, length(value) AS bytes FROM history WHERE key = ?1 ORDER BY id DESC LIMIT ?2'
      ).bind(key, limit).all();
      return json({ ok: true, rows: results });
    }

    if (action === 'ping') return json({ ok: true, now });
    return json({ ok: false, error: 'action không hợp lệ' }, 400);
  } catch (e) {
    return json({ ok: false, error: String(e && e.message || e) }, 500);
  }
}

export async function onRequestPost({ request, env }) {
  try {
    const body = JSON.parse(await request.text()); // client gửi text/plain để tránh CORS preflight
    if (body.action !== 'set' || !Array.isArray(body.items)) {
      return json({ ok: false, error: 'body không hợp lệ' }, 400);
    }
    // Ưu tiên email từ Cloudflare Access (nếu bật) → lịch sử sửa đáng tin hơn tên tự khai
    const accessEmail = request.headers.get('cf-access-authenticated-user-email');
    const by = String(accessEmail || body.by || 'Ẩn danh').slice(0, 80);
    const now = Date.now();
    const stmts = [];

    for (const it of body.items) {
      if (!it || !KEY_RE.test(it.key)) return json({ ok: false, error: 'key không hợp lệ: ' + (it && it.key) }, 400);
      const v = it.value === null || it.value === undefined ? null : JSON.stringify(it.value);
      if (v && v.length > MAX_VALUE_BYTES) return json({ ok: false, error: 'Dữ liệu quá lớn: ' + it.key }, 413);

      stmts.push(
        env.DB.prepare(
          `INSERT INTO kv (key, value, updated_at, updated_by) VALUES (?1, ?2, ?3, ?4)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`
        ).bind(it.key, v, now, by),
        env.DB.prepare(
          'INSERT INTO history (key, value, updated_at, updated_by) VALUES (?1, ?2, ?3, ?4)'
        ).bind(it.key, v, now, by),
        env.DB.prepare(
          // chỉ đọc ~50 dòng qua chỉ mục (key,id) → tiết kiệm hạn mức "rows read" của gói miễn phí
          `DELETE FROM history WHERE key = ?1 AND id <=
             (SELECT id FROM history WHERE key = ?1 ORDER BY id DESC LIMIT 1 OFFSET ${HISTORY_KEEP})`
        ).bind(it.key)
      );
    }
    if (stmts.length) await env.DB.batch(stmts); // batch = 1 transaction
    return json({ ok: true, now, n: body.items.length });
  } catch (e) {
    return json({ ok: false, error: String(e && e.message || e) }, 500);
  }
}
