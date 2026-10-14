/**
 * 跳绳页 / 站位检查页的静态资源缓存
 *
 * 为什么不用 HTTP 缓存就够了：
 *   MediaPipe 运行时(9.4MB) + 姿态模型(5.5MB) 体积大，iOS 等系统在
 *   存储紧张或长期不访问时会淘汰磁盘缓存，表现就是「过一阵又要重新下载」。
 *   Cache Storage 由我们显式管理，生命周期可控得多。
 *
 * 策略：只接管重资源目录，cache-first；其余请求一律透传给网络，
 *       所以页面 HTML 的更新不受影响。
 *
 * 换了模型或运行时，把 CACHE 的版本号 +1 即可让旧缓存失效。
 */
const CACHE = 'jump-assets-v2';

// 只接管这些目录，其它请求原样走网络
// - vendor/mediapipe、models：跳绳摄像头用的大体积运行时/模型
// - audio/jump：跳绳语音片段
// - audio/english：英语听力教材（托管音频，缓存后可离线复听）
const ASSET_RE = /^\/(?:vendor\/mediapipe\/|models\/|audio\/jump\/|audio\/english\/)/;

self.addEventListener('install', () => {
  // 不预缓存：模型只有开了摄像头才需要，替没相机需求的用户下 15MB 不合适
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    // 清掉旧版本的同族缓存
    const keys = await caches.keys();
    await Promise.all(
      keys.filter((k) => k.startsWith('jump-assets-') && k !== CACHE)
          .map((k) => caches.delete(k))
    );
    await self.clients.claim();
  })());
});

const AUDIO_RE = /^\/audio\/(?:jump|english)\//;

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  let url;
  try { url = new URL(req.url); } catch (e) { return; }
  if (url.origin !== self.location.origin) return;
  if (!ASSET_RE.test(url.pathname)) return;   // 非重资源：不干预

  // 音频：可能带 Range(206) —— 单独处理，保证能离线缓存并支持拖动进度
  if (AUDIO_RE.test(url.pathname)) {
    event.respondWith(handleAudio(req, url));
    return;
  }

  // 其余大资源（MediaPipe 运行时 / 模型 / 跳绳整文件 fetch）：cache-first，只存 200 basic
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(req, { ignoreVary: true });
    if (hit) return hit;
    const res = await fetch(req);
    if (res && res.status === 200 && res.type === 'basic') {
      cache.put(req, res.clone()).catch(() => {});
    }
    return res;
  })());
});

/**
 * 音频缓存：音频元素常发 Range 请求（返回 206），标准 cache-first 存不住。
 * 这里始终以「完整文件」为缓存键（忽略 Range），缓存整段音频；
 * 若请求带 Range，则从完整缓存里切片、以 206 返回，满足拖动进度 / seek。
 */
async function handleAudio(req, url) {
  const cache = await caches.open(CACHE);
  // 缓存键用不带 Range 的纯 URL，保证整段只存一份
  const fullKey = new Request(url.pathname);
  let full = await cache.match(fullKey, { ignoreVary: true });

  if (!full) {
    try {
      // 主动拉完整文件（不透传 Range），存一份完整副本
      const fetched = await fetch(url.pathname);
      if (fetched && fetched.status === 200) {
        cache.put(fullKey, fetched.clone()).catch(() => {});
        full = fetched;
      } else {
        // 拉不到完整文件就直接透传原始请求
        return fetch(req);
      }
    } catch (e) {
      return fetch(req);  // 离线且没缓存：只能失败，交给页面友好提示
    }
  }

  const range = req.headers.get('range');
  if (!range) return full.clone();

  // 解析 "bytes=start-end"，从完整内容切片
  const buf = await full.clone().arrayBuffer();
  const total = buf.byteLength;
  const m = /bytes=(\d*)-(\d*)/.exec(range);
  let start = m && m[1] ? parseInt(m[1], 10) : 0;
  let end = m && m[2] ? parseInt(m[2], 10) : total - 1;
  if (isNaN(start)) start = 0;
  if (isNaN(end) || end >= total) end = total - 1;
  if (start > end || start >= total) {
    return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${total}` } });
  }
  const chunk = buf.slice(start, end + 1);
  return new Response(chunk, {
    status: 206,
    headers: {
      'Content-Type': full.headers.get('Content-Type') || 'audio/mpeg',
      'Content-Range': `bytes ${start}-${end}/${total}`,
      'Content-Length': String(chunk.byteLength),
      'Accept-Ranges': 'bytes',
    },
  });
}
