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
const CACHE = 'jump-assets-v1';

// 只接管这些目录，其它请求原样走网络
const ASSET_RE = /^\/(?:vendor\/mediapipe\/|models\/|audio\/jump\/)/;

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

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  let url;
  try { url = new URL(req.url); } catch (e) { return; }
  if (url.origin !== self.location.origin) return;
  if (!ASSET_RE.test(url.pathname)) return;   // 非重资源：不干预

  event.respondWith((async () => {
    const cache = await caches.open(CACHE);

    // ignoreVary：网关可能加 Vary: Accept-Encoding，避免因此匹配不上
    const hit = await cache.match(req, { ignoreVary: true });
    if (hit) return hit;

    const res = await fetch(req);

    // 只存完整成功的同源响应；206 / opaque 一律不存，
    // 否则 WebAssembly.instantiateStreaming 会因为 MIME 或分片而失败
    if (res && res.status === 200 && res.type === 'basic') {
      cache.put(req, res.clone()).catch(() => {});
    }
    return res;
  })());
});
