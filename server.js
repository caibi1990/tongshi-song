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

// --- Static files ---
app.use(express.static(path.join(__dirname, 'public')));

// --- Start ---
app.listen(PORT, () => {
  console.log(`Homework server running on port ${PORT}`);
});
