const express = require('express');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const { generateAudio } = require('./edge-tts');

const app = express();
app.use(express.json());
const PORT = process.env.PORT || 3000;

// --- Scheduler ---
const SCHEDULER_DIR = path.resolve(__dirname, '../scripts');
const TASKS_FILE = path.join(SCHEDULER_DIR, 'tasks.json');
const LOG_FILE = path.join(SCHEDULER_DIR, 'homework.log');

function readTasks() {
  try {
    return JSON.parse(fs.readFileSync(TASKS_FILE, 'utf8'));
  } catch {
    // Default task config
    return {
      tasks: [{
        id: 'homework-fetch',
        name: '作业拉取',
        hour: 17, minute: 30,
        retryHour: 18, retryMinute: 30,
        enabled: true,
        script: 'fetch_homework.sh',
        lastRun: null,
        lastResult: null,
      }]
    };
  }
}

function writeTasks(data) {
  fs.writeFileSync(TASKS_FILE, JSON.stringify(data, null, 2));
}

// Scheduler API routes
app.get('/api/scheduler/tasks', (req, res) => {
  const data = readTasks();
  // Check if launchd service is loaded
  let serviceRunning = false;
  try {
    const { execSync } = require('child_process');
    const out = execSync('launchctl list 2>/dev/null | grep com.enze.homework || true', { encoding: 'utf8' });
    serviceRunning = out.trim().length > 0;
  } catch {}
  res.json({ tasks: data.tasks, serviceRunning, lastRun: data.tasks[0]?.lastRun });
});

app.patch('/api/scheduler/tasks/:id', (req, res) => {
  const data = readTasks();
  const task = data.tasks.find(t => t.id === req.params.id);
  if (!task) return res.status(404).json({ error: 'Task not found' });

  const updates = req.body;
  if (updates.hour != null) task.hour = updates.hour;
  if (updates.minute != null) task.minute = updates.minute;
  if (updates.retryHour != null) task.retryHour = updates.retryHour;
  if (updates.retryMinute != null) task.retryMinute = updates.retryMinute;
  if (updates.enabled != null) task.enabled = updates.enabled;

  writeTasks(data);

  // Update launchd plist if schedule changed
  if (updates.hour != null || updates.minute != null) {
    updatePlist(task);
  }

  res.json({ ok: true, task });
});

app.post('/api/scheduler/tasks/:id/trigger', (req, res) => {
  const data = readTasks();
  const task = data.tasks.find(t => t.id === req.params.id);
  if (!task) return res.status(404).json({ error: 'Task not found' });

  const scriptPath = path.join(SCHEDULER_DIR, task.script);
  if (!fs.existsSync(scriptPath)) {
    return res.status(500).json({ error: 'Script not found: ' + scriptPath });
  }

  // Run in background
  const child = execFile('/bin/bash', [scriptPath], { cwd: SCHEDULER_DIR, timeout: 120000 }, (err) => {
    task.lastRun = new Date().toISOString();
    task.lastResult = err ? 'error' : 'ok';
    writeTasks(data);
  });

  task.lastRun = new Date().toISOString();
  task.lastResult = 'running';
  writeTasks(data);

  res.json({ ok: true, message: '任务已触发，请查看日志' });
});

app.get('/api/scheduler/logs', (req, res) => {
  const lines = parseInt(req.query.lines) || 100;
  try {
    if (!fs.existsSync(LOG_FILE)) {
      return res.json({ lines: [] });
    }
    const content = fs.readFileSync(LOG_FILE, 'utf8');
    const allLines = content.trim().split('\n');
    res.json({ lines: allLines.slice(-lines) });
  } catch (e) {
    res.json({ lines: ['读取日志失败: ' + e.message] });
  }
});

function updatePlist(task) {
  const plistPath = path.join(SCHEDULER_DIR, 'com.enze.homework.plist');
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.enze.homework</string>
    <key>ProgramArguments</key>
    <array>
        <string>/bin/bash</string>
        <string>${path.join(SCHEDULER_DIR, task.script)}</string>
    </array>
    <key>StartCalendarInterval</key>
    <dict>
        <key>Hour</key>
        <integer>${task.hour}</integer>
        <key>Minute</key>
        <integer>${task.minute}</integer>
    </dict>
    <key>StandardOutPath</key>
    <string>${path.join(SCHEDULER_DIR, 'launchd.log')}</string>
    <key>StandardErrorPath</key>
    <string>${path.join(SCHEDULER_DIR, 'launchd.error.log')}</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin</string>
    </dict>
</dict>
</plist>`;
  try {
    fs.writeFileSync(plistPath, plist);
  } catch (e) {
    console.error('Failed to update plist:', e.message);
  }
}

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

// Extract media URLs from bitable fields (handles rich text with links, markdown links, comma-separated)
function extractMediaUrls(val) {
  if (Array.isArray(val)) {
    const urls = [];
    for (const seg of val) {
      if (seg.link) urls.push(seg.link);
      else if (seg.text) {
        const m = seg.text.match(/\[([^\]]+)\]\(([^)]+)\)/);
        if (m) urls.push(m[2]);
        else urls.push(...seg.text.split(',').map(s => s.trim()).filter(Boolean));
      }
    }
    return urls.filter(Boolean);
  }
  if (typeof val === 'string') {
    if (!val) return [];
    const m = val.match(/\[([^\]]+)\]\(([^)]+)\)/g);
    if (m) return m.map(x => x.replace(/\[([^\]]+)\]\(([^)]+)\)/, '$2'));
    return val.split(',').map(s => s.trim()).filter(Boolean);
  }
  return [];
}

// Strip HTML tags for clean TTS text
function stripHtml(s) {
  return s.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]*>/g, '');
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

// --- Shared homework fetcher ---
async function fetchHomeworkItems(date) {
  const token = await getTenantToken();
  const [y, m, d] = date.split('-').map(Number);
  const dayStart = Date.UTC(y, m - 1, d, -8, 0, 0);
  const dayEnd = Date.UTC(y, m - 1, d, -8 + 24, 0, 0);

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
    if (data.code !== 0) throw new Error(`Bitable error: ${data.msg}`);

    const items = (data.data?.items || []).map((r) => {
      const f = r.fields;
      return {
        date: f['日期'],
        subject: Array.isArray(f['学科']) ? f['学科'][0] : f['学科'],
        teacher: richText(f['发布人']),
        deadline: richText(f['截止时间']),
        content: richText(f['作业内容']),
        submitMethod: richText(f['提交方式']),
        photos: extractMediaUrls(f['图片附件']),
        videos: extractMediaUrls(f['视频附件']),
        audios: extractMediaUrls(f['音频附件']),
      };
    });
    allItems = allItems.concat(items);
    pageToken = data.data?.has_more ? data.data.page_token : '';
  } while (pageToken);

  const filtered = allItems.filter((item) => {
    const ts = typeof item.date === 'number' ? item.date : 0;
    return ts >= dayStart && ts < dayEnd;
  });

  const subjectOrder = { '语文': 0, '数学': 1, '英语': 2 };
  filtered.sort((a, b) => (subjectOrder[a.subject] ?? 9) - (subjectOrder[b.subject] ?? 9));
  return filtered;
}

// --- API: GET /api/homework?date=YYYY-MM-DD ---
app.get('/api/homework', async (req, res) => {
  try {
    const date = req.query.date || new Date().toISOString().slice(0, 10);
    const filtered = await fetchHomeworkItems(date);
    res.json({ date, items: filtered, total: filtered.length });
  } catch (err) {
    console.error('API error:', err);
    res.status(500).json({ error: err.message });
  }
});

// --- TTS cache (in-memory, keyed by date+subject) ---
const ttsCache = new Map();

// --- API: GET /api/tts?date=YYYY-MM-DD&subject=语文&rate=0.85 ---
app.get('/api/tts', async (req, res) => {
  try {
    const date = req.query.date || new Date().toISOString().slice(0, 10);
    const subject = req.query.subject || '';
    const rate = parseFloat(req.query.rate) || 0.85;

    if (!subject) {
      return res.status(400).json({ error: 'subject parameter is required' });
    }

    const cacheKey = `${date}|${subject}`;
    if (ttsCache.has(cacheKey)) {
      const cached = ttsCache.get(cacheKey);
      res.setHeader('Content-Type', 'audio/mpeg');
      res.setHeader('Content-Length', cached.length);
      res.setHeader('Cache-Control', 'public, max-age=86400');
      return res.send(cached);
    }

    // Fetch homework and find matching subject
    const items = await fetchHomeworkItems(date);
    const matched = items.filter((item) => item.subject === subject);

    if (matched.length === 0) {
      return res.status(404).json({ error: `No homework found for ${subject} on ${date}` });
    }

    // Build TTS text: combine all content for this subject
    const ttsText = matched.map((item) => {
      let text = `${item.subject}作业。`;
      if (item.teacher) text += `发布人，${item.teacher}。`;
      text += stripHtml(item.content);
      if (item.submitMethod) text += `。提交方式，${item.submitMethod}。`;
      return text;
    }).join('。');

    if (!ttsText.trim()) {
      return res.status(404).json({ error: 'Empty homework content' });
    }

    // Generate audio
    const audioBuffer = await generateAudio(ttsText, rate);

    // Cache (limit cache size to 50 entries)
    if (ttsCache.size >= 50) {
      const firstKey = ttsCache.keys().next().value;
      ttsCache.delete(firstKey);
    }
    ttsCache.set(cacheKey, audioBuffer);

    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Content-Length', audioBuffer.length);
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.send(audioBuffer);
  } catch (err) {
    console.error('TTS error:', err);
    res.status(500).json({ error: err.message });
  }
});

// --- API: GET /api/tts-say?text=...&rate=1.0 ---
// 跳绳页的「动态语音」按需合成（如「时间到，你跳了 128 个」）。
// 固定语句在构建期已预生成为 public/audio/jump/*.mp3，不走这里。
const sayCache = new Map();
const SAY_CACHE_MAX = 300;

app.get('/api/tts-say', async (req, res) => {
  try {
    const text = String(req.query.text || '').trim().slice(0, 120);
    const rate = Math.min(1.6, Math.max(0.6, parseFloat(req.query.rate) || 1.0));
    if (!text) return res.status(400).json({ error: 'text is required' });

    const key = `${rate}|${text}`;
    if (sayCache.has(key)) {
      const hit = sayCache.get(key);
      res.setHeader('Content-Type', 'audio/mpeg');
      res.setHeader('Content-Length', hit.length);
      res.setHeader('Cache-Control', 'public, max-age=604800');
      return res.send(hit);
    }

    const audio = await generateAudio(text, rate);

    // LRU：超限时淘汰最早写入的一条
    if (sayCache.size >= SAY_CACHE_MAX) {
      sayCache.delete(sayCache.keys().next().value);
    }
    sayCache.set(key, audio);

    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Content-Length', audio.length);
    res.setHeader('Cache-Control', 'public, max-age=604800');
    res.send(audio);
  } catch (err) {
    console.error('tts-say error:', err);
    res.status(500).json({ error: err.message });
  }
});

// --- QQ Docs (腾讯文档) Integration ---
// 配置来源优先级：持久化配置文件 > 环境变量 > 硬编码默认值。
// 体育老师经常换文档链接，后台 admin.html 可直接改并写入配置文件，改完即时生效、无需重部署。
// 配置目录用 CONFIG_DIR 环境变量指定（指向 Sealos 挂载的持久卷），不设则落在应用目录下。
const CONFIG_DIR = process.env.CONFIG_DIR || path.join(__dirname, 'data');
const QQ_CONFIG_FILE = path.join(CONFIG_DIR, 'qq-doc-config.json');

// 默认值（首次部署、配置文件还不存在时用）
const QQ_DOC_DEFAULTS = {
  fileId: 'DREFsWWdDTGpneWNO',
  clientId: process.env.QQ_DOC_CLIENT_ID || '542a94f67e894e1cbc6c8eb2fcf5a5d8',
  accessToken: process.env.QQ_DOC_ACCESS_TOKEN || '',
  openId: process.env.QQ_DOC_OPEN_ID || 'a263363ce9d746738a5393d90a809644',
};

// 可变配置对象（运行时可被后台修改）
let QQ_DOC = Object.assign({}, QQ_DOC_DEFAULTS);

// 从 URL 里提取腾讯文档 fileId：https://docs.qq.com/sheet/XXXX -> XXXX
function extractFileId(input) {
  if (!input) return '';
  const s = String(input).trim();
  const m = s.match(/docs\.qq\.com\/(?:sheet|doc|slide|form)\/([A-Za-z0-9]+)/);
  if (m) return m[1];
  // 没匹配到就当作已经是纯 fileId（只保留合法字符）
  return s.replace(/[^A-Za-z0-9]/g, '');
}

// 加载持久化配置（启动时调用）
function loadQQConfig() {
  try {
    if (fs.existsSync(QQ_CONFIG_FILE)) {
      const saved = JSON.parse(fs.readFileSync(QQ_CONFIG_FILE, 'utf8'));
      // 只接受已知字段，缺的用默认补齐
      QQ_DOC = {
        fileId: saved.fileId || QQ_DOC_DEFAULTS.fileId,
        clientId: saved.clientId || QQ_DOC_DEFAULTS.clientId,
        accessToken: saved.accessToken || QQ_DOC_DEFAULTS.accessToken,
        openId: saved.openId || QQ_DOC_DEFAULTS.openId,
      };
      console.log('QQ Doc config loaded from file:', QQ_CONFIG_FILE, '| fileId=', QQ_DOC.fileId);
    } else {
      console.log('QQ Doc config file not found, using defaults | fileId=', QQ_DOC.fileId);
    }
  } catch (e) {
    console.error('加载腾讯文档配置失败，回退默认值:', e.message);
    QQ_DOC = Object.assign({}, QQ_DOC_DEFAULTS);
  }
}

// 保存配置到持久化文件
function saveQQConfig() {
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(QQ_CONFIG_FILE, JSON.stringify(QQ_DOC, null, 2));
    console.log('QQ Doc config saved:', QQ_CONFIG_FILE);
    return true;
  } catch (e) {
    console.error('保存腾讯文档配置失败:', e.message);
    return false;
  }
}

loadQQConfig();

// Caches
let qqSheetCache = {};
let qqNamesCache = null; // [{row, name}]

async function qqDocGetSheets() {
  if (Object.keys(qqSheetCache).length > 0) return qqSheetCache;
  const res = await fetch(
    `https://docs.qq.com/openapi/spreadsheet/v3/files/${QQ_DOC.fileId}`,
    {
      headers: {
        'Access-Token': QQ_DOC.accessToken,
        'Client-Id': QQ_DOC.clientId,
        'Open-Id': QQ_DOC.openId,
      },
    }
  );
  const data = await res.json();
  const props = data.properties || [];
  for (const p of props) {
    qqSheetCache[p.title] = p.sheetId;
  }
  console.log('QQ Doc sheets cached:', Object.keys(qqSheetCache));
  return qqSheetCache;
}

// Find or create sheet for a given date (format: "M.D" e.g. "9.20")
async function qqDocFindSheet(dateStr) {
  // dateStr is YYYY-MM-DD, convert to M.D format
  const [, m, d] = dateStr.split('-').map(Number);
  const sheetTitle = `${m}.${d}`;
  let sheets = await qqDocGetSheets();
  if (!sheets[sheetTitle]) {
    // 可能是老师刚建好工作表而缓存还旧 —— 强制刷新一次再判定，
    // 免得把「老师已经建了」误判成缺表而白白报错
    qqSheetCache = {};
    sheets = await qqDocGetSheets();
  }
  return { sheetId: sheets[sheetTitle], sheetTitle };
}

// Get student names from first available sheet (cached)
async function qqDocGetNames() {
  if (qqNamesCache) return qqNamesCache;
  if (!QQ_DOC.accessToken) return [];

  // Use first sheet to read names (names are same across all sheets)
  const sheets = await qqDocGetSheets();
  const firstSheetId = Object.values(sheets)[0];
  if (!firstSheetId) return [];

  const res = await fetch(
    `https://docs.qq.com/openapi/spreadsheet/v3/files/${QQ_DOC.fileId}/${firstSheetId}/B3:B50`,
    {
      headers: {
        'Access-Token': QQ_DOC.accessToken,
        'Client-Id': QQ_DOC.clientId,
        'Open-Id': QQ_DOC.openId,
      },
    }
  );
  const data = await res.json();
  const rows = data.gridData?.rows || [];
  const startRow = data.gridData?.startRow || 0;

  qqNamesCache = [];
  for (let i = 0; i < rows.length; i++) {
    const vals = rows[i]?.values || [];
    const name = vals[0]?.cellValue?.text?.trim();
    if (name) {
      qqNamesCache.push({ row: startRow + i, name });
    }
  }
  console.log('QQ Doc names cached:', qqNamesCache.length, 'students');
  return qqNamesCache;
}

// API: GET /api/qq-doc/names — return student name list
app.get('/api/qq-doc/names', async (req, res) => {
  try {
    const names = await qqDocGetNames();
    res.json({ names });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===== 后台管理：腾讯文档配置 =====
// 简单口令保护：请求头 X-Admin-Key 需匹配 ADMIN_KEY 环境变量（默认 admin888）。
// 仅家长自用，口令用于防止误触/外部乱改，不是强安全边界。
const ADMIN_KEY = process.env.ADMIN_KEY || 'admin888';
function requireAdmin(req, res) {
  const key = req.headers['x-admin-key'] || '';
  if (key !== ADMIN_KEY) { res.status(401).json({ error: '口令错误' }); return false; }
  return true;
}
// token 脱敏：只显示首尾，中间打码
function maskToken(t) {
  if (!t) return '';
  if (t.length <= 12) return '****';
  return t.slice(0, 6) + '****' + t.slice(-6);
}

// 用一组配置试连腾讯文档，成功则返回工作表标题列表
async function qqTryConnect(cfg) {
  const res = await fetch(
    `https://docs.qq.com/openapi/spreadsheet/v3/files/${cfg.fileId}`,
    { headers: { 'Access-Token': cfg.accessToken, 'Client-Id': cfg.clientId, 'Open-Id': cfg.openId } }
  );
  const status = res.status;
  let data = null;
  try { data = await res.json(); } catch (e) {}
  // 注意：腾讯文档 OpenAPI 即使鉴权失败也返回 HTTP 200，真正的错误码在 body.code 里
  // （成功时没有 code 或 code===0，并带 properties 数组）。所以不能只看 HTTP 状态。
  if (status !== 200) {
    const msg = (data && (data.msg || data.message)) || `HTTP ${status}`;
    throw new Error(msg);
  }
  if (data && data.code && data.code !== 0) {
    throw new Error(`${data.message || '鉴权/请求失败'}（错误码 ${data.code}）`);
  }
  if (!data || !Array.isArray(data.properties)) {
    throw new Error((data && data.message) || '返回数据异常，可能是文档ID或权限问题');
  }
  const titles = data.properties.map(p => p.title);
  return titles;
}

// GET 读当前配置（token 脱敏），顺带校验空字段
app.get('/api/qq-doc/config', (req, res) => {
  if (!requireAdmin(req, res)) return;
  res.json({
    fileId: QQ_DOC.fileId,
    clientId: QQ_DOC.clientId,
    openId: QQ_DOC.openId,
    accessTokenMasked: maskToken(QQ_DOC.accessToken),
    hasToken: !!QQ_DOC.accessToken,
    docUrl: QQ_DOC.fileId ? `https://docs.qq.com/sheet/${QQ_DOC.fileId}` : '',
    source: fs.existsSync(QQ_CONFIG_FILE) ? 'file' : 'default',
  });
});

// POST 试连：用提交的配置（可只提交部分字段，缺的沿用当前）测试能否连通
app.post('/api/qq-doc/test', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const b = req.body || {};
    const cfg = {
      fileId: b.docUrl != null || b.fileId != null ? extractFileId(b.docUrl || b.fileId) : QQ_DOC.fileId,
      clientId: b.clientId || QQ_DOC.clientId,
      // accessToken 为空字符串表示"不改"，沿用当前；非空才覆盖
      accessToken: (b.accessToken && b.accessToken.trim()) ? b.accessToken.trim() : QQ_DOC.accessToken,
      openId: b.openId || QQ_DOC.openId,
    };
    if (!cfg.fileId) return res.status(400).json({ ok: false, error: '文档链接/fileId 不能为空' });
    if (!cfg.accessToken) return res.status(400).json({ ok: false, error: 'Access-Token 未配置' });
    const titles = await qqTryConnect(cfg);
    res.json({ ok: true, fileId: cfg.fileId, sheetTitles: titles, sheetCount: titles.length });
  } catch (err) {
    res.status(200).json({ ok: false, error: err.message });
  }
});

// POST 保存：先试连验证，通过才写入配置文件并即时生效
app.post('/api/qq-doc/config', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const b = req.body || {};
    const next = {
      fileId: (b.docUrl != null || b.fileId != null) ? extractFileId(b.docUrl || b.fileId) : QQ_DOC.fileId,
      clientId: b.clientId || QQ_DOC.clientId,
      accessToken: (b.accessToken && b.accessToken.trim()) ? b.accessToken.trim() : QQ_DOC.accessToken,
      openId: b.openId || QQ_DOC.openId,
    };
    if (!next.fileId) return res.status(400).json({ ok: false, error: '文档链接/fileId 不能为空' });
    if (!next.accessToken) return res.status(400).json({ ok: false, error: 'Access-Token 未配置' });

    // 保存前强制试连，避免把一个连不通的配置写进去导致线上同步全挂
    let titles;
    try { titles = await qqTryConnect(next); }
    catch (e) { return res.status(200).json({ ok: false, error: '配置无法连通，未保存：' + e.message }); }

    QQ_DOC = next;
    const saved = saveQQConfig();
    // 配置变了，清掉旧文档的缓存，让新文档立即生效
    qqSheetCache = {};
    qqNamesCache = null;
    res.json({ ok: true, persisted: saved, fileId: QQ_DOC.fileId, sheetTitles: titles, sheetCount: titles.length,
      note: saved ? '已保存并生效' : '已生效，但写入配置文件失败（重启后可能丢失，检查 CONFIG_DIR 持久化）' });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// 公开只读：前端 jump-rope 页拿当前文档链接用（不含任何密钥）
app.get('/api/qq-doc/public-url', (req, res) => {
  res.json({ docUrl: QQ_DOC.fileId ? `https://docs.qq.com/sheet/${QQ_DOC.fileId}` : '' });
});


// Write jump rope record to QQ Doc
// taskSec: 180/60/30, count: number, dateStr: YYYY-MM-DD, targetRow: number (0-based)
app.post('/api/qq-doc/write-jump', async (req, res) => {
  try {
    const { taskSec, count, dateStr, targetRow } = req.body;
    if (!taskSec || !count || !dateStr || targetRow == null) {
      return res.status(400).json({ error: 'Missing taskSec, count, dateStr, or targetRow' });
    }
    if (!QQ_DOC.accessToken) {
      return res.status(500).json({ error: 'QQ Doc access token not configured' });
    }

    // 缺表就报错，由前端弹窗提醒手动处理。
    // 刻意不自动建表：API 拿不到背景色/边框/列宽，自动建出来的表
    // 和老师原有工作表格式不一致，反而添乱。家长在腾讯文档里
    // 复制一张工作表改名，再点弹窗里的「重试同步」即可。
    const { sheetId, sheetTitle } = await qqDocFindSheet(dateStr);
    if (!sheetId) {
      return res.status(404).json({ error: `Sheet "${sheetTitle}" not found in spreadsheet` });
    }

    // Map taskSec to column index (0-based): 180->col2, 60->col3, 30->col4
    const colMap = { 180: 2, 60: 3, 30: 4 };
    const col = colMap[taskSec];
    if (col === undefined) {
      return res.status(400).json({ error: `Invalid taskSec: ${taskSec}` });
    }

    // For 3min (col2), write ✓ mark; for others write the count number
    const cellValue = taskSec === 180
      ? { text: '✓' }
      : { number: count };

    const body = {
      requests: [{
        updateRangeRequest: {
          sheetId,
          gridData: {
            startRow: targetRow,
            startColumn: col,
            rows: [{
              values: [{ cellValue }],
            }],
          },
        },
      }],
    };

    const apiRes = await fetch(
      `https://docs.qq.com/openapi/spreadsheet/v3/files/${QQ_DOC.fileId}/batchUpdate`,
      {
        method: 'POST',
        headers: {
          'Access-Token': QQ_DOC.accessToken,
          'Client-Id': QQ_DOC.clientId,
          'Open-Id': QQ_DOC.openId,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      }
    );
    const result = await apiRes.json();

    if (result.code && result.code !== 0) {
      console.error('QQ Doc write error:', result);
      return res.status(500).json({ error: result.message || 'QQ Doc API error' });
    }

    res.json({ ok: true, sheetTitle, row: targetRow, col, value: cellValue });
  } catch (err) {
    console.error('QQ Doc write error:', err);
    res.status(500).json({ error: err.message });
  }
});

// --- Static files ---
// --- 大体积静态资源给长缓存 ---
// express.static 默认 Cache-Control: max-age=0，意味着每次进页面都要回源校验。
// MediaPipe 运行时(9.4MB) + 模型(5.5MB) + 语音片段一旦被网关代理丢掉 ETag，
// 就会退化成整包重下。这里按目录给 30 天缓存，浏览器直接命中本地缓存。
// 换了模型文件的话，改这里的 maxAge 或给引用加版本号即可清缓存。
app.use('/vendor', express.static(path.join(__dirname, 'public', 'vendor'), { maxAge: '30d' }));
app.use('/models', express.static(path.join(__dirname, 'public', 'models'), { maxAge: '30d' }));
app.use('/audio', express.static(path.join(__dirname, 'public', 'audio'), { maxAge: '30d' }));

app.use(express.static(path.join(__dirname, 'public')));

// --- Start ---
app.listen(PORT, () => {
  console.log(`Homework server running on port ${PORT}`);
});
