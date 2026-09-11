const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// --- Config ---
const APP_ID = process.env.FEISHU_APP_ID || '';
const APP_SECRET = process.env.FEISHU_APP_SECRET || '';
const BASE_TOKEN = process.env.BASE_TOKEN || 'TRb8b2HHqaYms8sOoMncuPWInmg';
const TABLE_ID = process.env.TABLE_ID || 'tblBJk7g3LneCfBV';
const FEISHU_API = 'https://open.feishu.cn/open-apis';

// --- Helpers ---
// Bitable text fields return as [{text: "...", type: "text"}, ...] arrays
function richText(val) {
  if (Array.isArray(val)) return val.map((seg) => seg.text || '').join('');
  if (typeof val === 'string') return val;
  return '';
}

// --- Token cache ---
let tokenCache = { token: '', expiresAt: 0 };

async function getTenantToken() {
  const now = Date.now();
  if (tokenCache.token && tokenCache.expiresAt > now) {
    return tokenCache.token;
  }
  const res = await fetch(`${FEISHU_API}/auth/v3/tenant_access_token/internal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: APP_ID, app_secret: APP_SECRET }),
  });
  const data = await res.json();
  if (data.code !== 0) throw new Error(`Token error: ${data.msg}`);
  tokenCache = {
    token: data.tenant_access_token,
    expiresAt: now + (data.expire - 300) * 1000, // 5min buffer
  };
  return tokenCache.token;
}

// --- API: GET /api/homework?date=YYYY-MM-DD ---
app.get('/api/homework', async (req, res) => {
  try {
    const date = req.query.date || new Date().toISOString().slice(0, 10);
    const token = await getTenantToken();

    // Compute day boundaries in CST (UTC+8)
    const [y, m, d] = date.split('-').map(Number);
    const dayStart = Date.UTC(y, m - 1, d, -8, 0, 0); // midnight CST
    const dayEnd = Date.UTC(y, m - 1, d, -8 + 24, 0, 0); // next midnight CST

    // Bitable search endpoint doesn't support isGreater/isLess on datetime fields,
    // so we fetch all records and filter by timestamp in JS.
    // With ~3 records per school day, this is perfectly fine.
    let allItems = [];
    let pageToken = '';
    do {
      const body = { page_size: 100 };
      if (pageToken) body.page_token = pageToken;

      const apiRes = await fetch(
        `${FEISHU_API}/bitable/v1/apps/${BASE_TOKEN}/tables/${TABLE_ID}/records/search`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body),
        }
      );
      const data = await apiRes.json();

      if (data.code !== 0) {
        return res.status(500).json({ error: data.msg, code: data.code });
      }

      const items = (data.data?.items || []).map((r) => {
        const f = r.fields;
        return {
          date: f['日期'],
          subject: Array.isArray(f['学科']) ? f['学科'][0] : f['学科'],
          teacher: richText(f['发布人']),
          deadline: richText(f['截止时间']),
          content: richText(f['作业内容']),
          submitMethod: richText(f['提交方式']),
          photos: richText(f['图片附件']).split(',').filter(Boolean),
          videos: richText(f['视频附件']).split(',').filter(Boolean),
        };
      });
      allItems = allItems.concat(items);
      pageToken = data.data?.has_more ? data.data.page_token : '';
    } while (pageToken);

    // Filter by date: 日期 field is a millisecond timestamp
    const filtered = allItems.filter((item) => {
      const ts = typeof item.date === 'number' ? item.date : 0;
      return ts >= dayStart && ts < dayEnd;
    });

    // Sort by subject: 语文 → 数学 → 英语 → others
    const subjectOrder = { '语文': 0, '数学': 1, '英语': 2 };
    filtered.sort((a, b) => (subjectOrder[a.subject] ?? 9) - (subjectOrder[b.subject] ?? 9));

    res.json({ date, items: filtered, total: filtered.length });
  } catch (err) {
    console.error('API error:', err);
    res.status(500).json({ error: err.message });
  }
});

// --- Static files ---
app.use(express.static(path.join(__dirname, 'public')));

// --- Start ---
app.listen(PORT, () => {
  console.log(`Homework server running on port ${PORT}`);
});
