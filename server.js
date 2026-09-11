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

    // Build filter: date field equals the requested date
    const filter = {
      conjunction: 'and',
      conditions: [
        {
          field_name: '日期',
          operator: 'is',
          value: [date],
        },
      ],
    };

    const body = {
      filter,
      sort: [{ field_name: '学科', desc: false }],
      page_size: 20,
    };

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

    // Transform records into a simple array
    const items = (data.data?.items || []).map((r) => {
      const f = r.fields;
      return {
        date: f['日期'],
        subject: Array.isArray(f['学科']) ? f['学科'][0] : f['学科'],
        teacher: f['发布人'],
        deadline: f['截止时间'],
        content: f['作业内容'],
        submitMethod: f['提交方式'],
      };
    });

    res.json({ date, items, total: items.length });
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
