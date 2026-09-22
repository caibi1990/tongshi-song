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
const QQ_DOC = {
  fileId: 'DREFoVWxyTWRqanVZ',
  clientId: process.env.QQ_DOC_CLIENT_ID || '542a94f67e894e1cbc6c8eb2fcf5a5d8',
  accessToken: process.env.QQ_DOC_ACCESS_TOKEN || '',
  openId: process.env.QQ_DOC_OPEN_ID || 'a263363ce9d746738a5393d90a809644',
};

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
    // 可能是刚补建的工作表，缓存里还没有 —— 强制刷新一次
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

// ══════════════════════════════════════════════════════════
// 预先补齐未来几天的工作表
//   表格是按日期分工作表的（标题形如 9.20）。老师没建当天的表时，
//   跳绳成绩就没地方写。这里每天往后检查几天，缺哪天的就补一张。
//
//   「补一张空的」不是真的空白 —— 空白表里写第 20 行的个数毫无意义。
//   新建的表会带上标题、表头、序号与姓名，结果列留空，
//   结构与已有工作表完全一致，可以直接写入。
//
//   只新增缺失的工作表，绝不改动或删除老师已有的任何工作表。
// ══════════════════════════════════════════════════════════
function qqHeaders() {
  return {
    'Access-Token': QQ_DOC.accessToken,
    'Client-Id': QQ_DOC.clientId,
    'Open-Id': QQ_DOC.openId,
  };
}

// 不带缓存地读取工作表列表（新建之后必须能看到）
async function qqDocFetchSheetsFresh() {
  const res = await fetch(
    `https://docs.qq.com/openapi/spreadsheet/v3/files/${QQ_DOC.fileId}`,
    { headers: qqHeaders() }
  );
  const data = await res.json();
  return (data.properties || []).map((p) => ({ sheetId: p.sheetId, title: p.title }));
}

// 东八区日期串
function shanghaiDate(offsetDays = 0) {
  const t = Date.now() + 8 * 3600 * 1000 + offsetDays * 86400000;
  return new Date(t).toISOString().slice(0, 10);
}

// 与老师现有命名一致：9.20 / 10.5（不补前导零）
function sheetTitleOf(dateStr) {
  const [, m, d] = dateStr.split('-').map(Number);
  return `${m}.${d}`;
}

// 标题归一化：把 "9.05" / "9.5" 都归到 9-5，避免误判重复
function normalizeSheetTitle(title) {
  const m = String(title).trim().match(/^(\d{1,2})\.(\d{1,2})$/);
  return m ? `${Number(m[1])}-${Number(m[2])}` : null;
}

function gridToMatrix(grid) {
  const startRow = grid.startRow || 0;
  const startCol = grid.startColumn || 0;
  const mx = [];
  (grid.rows || []).forEach((row, ri) => {
    (row.values || []).forEach((cell, ci) => {
      const r = startRow + ri, c = startCol + ci;
      if (!mx[r]) mx[r] = [];
      const v = cell && cell.cellValue;
      if (v && typeof v.text === 'string') mx[r][c] = v.text;
      else if (v && typeof v.number === 'number') mx[r][c] = v.number;
      else mx[r][c] = '';
    });
  });
  return mx;
}

// 从一张已有工作表里提取「结构模板」
async function qqDocReadTemplate(sheetId) {
  const res = await fetch(
    `https://docs.qq.com/openapi/spreadsheet/v3/files/${QQ_DOC.fileId}/${sheetId}/A1:H80`,
    { headers: qqHeaders() }
  );
  const data = await res.json();
  const mx = gridToMatrix(data.gridData || {});

  // 表头行 = 某一行里出现「姓名」的那行
  let headerRow = -1;
  for (let r = 0; r < mx.length && headerRow < 0; r++) {
    if ((mx[r] || []).some((v) => String(v).trim() === '姓名')) headerRow = r;
  }
  if (headerRow < 0) return null;

  const width = Math.max(8, (mx[headerRow] || []).length);
  const headers = [];
  for (let c = 0; c < width; c++) headers.push(String(mx[headerRow][c] ?? ''));

  // 学生：表头之后，姓名列非空的行
  const students = [];
  for (let r = headerRow + 1; r < mx.length; r++) {
    const name = String(mx[r]?.[1] ?? '').trim();
    if (!name) continue;
    const no = mx[r][0];
    students.push([(no === '' || no == null) ? students.length + 1 : no, name]);
  }

  return { title: String(mx[0]?.[0] ?? '跳绳记录').trim(), headerRow, headers, students };
}

function rangeReq(sheetId, startRow, startColumn, rowsOfCells) {
  return {
    updateRangeRequest: {
      sheetId,
      gridData: {
        startRow,
        startColumn,
        rows: rowsOfCells.map((values) => ({ values: values.map((cellValue) => ({ cellValue })) })),
      },
    },
  };
}

async function qqDocBatchUpdate(requests) {
  const res = await fetch(
    `https://docs.qq.com/openapi/spreadsheet/v3/files/${QQ_DOC.fileId}/batchUpdate`,
    {
      method: 'POST',
      headers: { ...qqHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ requests }),
    }
  );
  const data = await res.json();
  if (data.code && data.code !== 0) {
    throw new Error(data.message || 'QQ Doc batchUpdate error');
  }
  return data;
}

// 把模板结构写进新建的工作表（结果列保持空）
async function qqDocFillTemplate(sheetId, tpl) {
  const requests = [
    rangeReq(sheetId, 0, 0, [[{ text: tpl.title }]]),
    rangeReq(sheetId, tpl.headerRow, 0, [tpl.headers.map((h) => ({ text: h }))]),
  ];
  if (tpl.students.length) {
    requests.push(rangeReq(
      sheetId,
      tpl.headerRow + 1,
      0,
      tpl.students.map(([no, name]) => [
        typeof no === 'number' ? { number: no } : { text: String(no) },
        { text: name },
      ])
    ));
  }
  await qqDocBatchUpdate(requests);
}

// GET /api/qq-doc/ensure-sheets?days=3&dryRun=1
app.get('/api/qq-doc/ensure-sheets', async (req, res) => {
  try {
    if (!QQ_DOC.accessToken) {
      return res.status(500).json({ error: 'QQ Doc access token not configured' });
    }
    const days = Math.min(14, Math.max(0, parseInt(req.query.days, 10) || 3));
    const dryRun = req.query.dryRun === '1' || req.query.dryRun === 'true';

    const sheets = await qqDocFetchSheetsFresh();
    const existing = new Set(
      sheets.map((s) => normalizeSheetTitle(s.title)).filter(Boolean)
    );

    // 从最新一张表取模板；没有可用的就用内置表头兜底
    const tpl = (await qqDocReadTemplate(sheets[sheets.length - 1]?.sheetId)) || {
      title: '跳绳记录',
      headerRow: 2,
      headers: ['序号', '姓名', '3分钟单摇', '1分钟单摇', '30秒单摇', '三分钟单摇', '一分钟', '30秒'],
      students: [],
    };

    const created = [], skipped = [], failed = [];

    for (let i = 0; i <= days; i++) {
      const date = shanghaiDate(i);
      const title = sheetTitleOf(date);
      const key = normalizeSheetTitle(title);

      if (existing.has(key)) { skipped.push(title); continue; }
      if (dryRun) { created.push(title + '(dryRun)'); continue; }

      try {
        // 1) 新建工作表
        await qqDocBatchUpdate([{
          addSheetRequest: { title, rowCount: 200, columnCount: 26 },
        }]);

        // 2) 取回新表的 sheetId（接口不回传，只能重新列一次）
        const after = await qqDocFetchSheetsFresh();
        const createdSheet = after.find((s) => s.title === title);
        if (!createdSheet) throw new Error('新建后未找到工作表: ' + title);

        // 3) 写入表头与序号姓名
        await qqDocFillTemplate(createdSheet.sheetId, tpl);

        existing.add(key);
        created.push(title);
        console.log(`QQ Doc 已补建工作表 ${title}（表头 ${tpl.headers.length} 列，学生 ${tpl.students.length} 人）`);
      } catch (e) {
        console.error('补建工作表失败:', title, e.message);
        failed.push({ title, error: e.message });
      }
    }

    // 新建过就要让写入路径的缓存失效
    if (created.length && !dryRun) qqSheetCache = {};

    res.json({
      ok: true,
      range: `${shanghaiDate(0)} ~ ${shanghaiDate(days)}`,
      template: { from: sheets[sheets.length - 1]?.title, students: tpl.students.length },
      created, skipped, failed,
    });
  } catch (err) {
    console.error('ensure-sheets error:', err);
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
