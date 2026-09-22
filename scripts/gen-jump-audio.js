#!/usr/bin/env node
/**
 * 预生成跳绳页的固定语音片段（Edge TTS，与作业页同一发音人）
 *
 *   node scripts/gen-jump-audio.js           # 只生成缺失的
 *   node scripts/gen-jump-audio.js --force   # 全量重新生成
 *
 * 产物：public/audio/jump/<key>.mp3
 * 前端把这些 mp3 预加载进 Web Audio 的 AudioBuffer 后按 key 播放，
 * 好处是与提示音/节拍器共用同一条音频管线（已被摄像头抢占音频会话的自愈逻辑覆盖）。
 *
 * 动态内容（如「时间到，你跳了 N 个」）不走这里，由服务端 /api/tts-say 实时合成。
 */
const fs = require('fs');
const path = require('path');
const { generateAudio } = require('../edge-tts');

const OUT_DIR = path.join(__dirname, '..', 'public', 'audio', 'jump');

const CLIPS = [
  // 倒计时：语速略快，1 秒一拍要跟得上
  { key: 'cd5', text: '五', rate: 1.2 },
  { key: 'cd4', text: '四', rate: 1.2 },
  { key: 'cd3', text: '三', rate: 1.2 },
  { key: 'cd2', text: '二', rate: 1.2 },
  { key: 'cd1', text: '一', rate: 1.2 },
  { key: 'go',  text: '开始', rate: 1.2 },

  // 剩余时间提醒
  { key: 'left120', text: '还剩两分钟', rate: 1.0 },
  { key: 'left60',  text: '还剩一分钟', rate: 1.0 },
  { key: 'left30',  text: '还剩三十秒', rate: 1.0 },
  { key: 'left10',  text: '还剩十秒', rate: 1.0 },

  // 固定提示语
  { key: 'timeUpManual', text: '时间到，请输入跳绳个数', rate: 1.0 },
  { key: 'needInput',    text: '请输入跳绳个数', rate: 1.0 },
  { key: 'recorded',     text: '记录成功', rate: 1.0 },
  { key: 'stopFirst',    text: '请先停止计时再切换', rate: 1.0 },
  { key: 'modelFail',    text: '识别模型加载失败，已切换为手动计数', rate: 1.0 },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const force = process.argv.includes('--force');
  fs.mkdirSync(OUT_DIR, { recursive: true });

  let made = 0, skipped = 0, failed = 0;

  for (const clip of CLIPS) {
    const file = path.join(OUT_DIR, `${clip.key}.mp3`);

    if (!force && fs.existsSync(file) && fs.statSync(file).size > 512) {
      skipped++;
      console.log(`  skip  ${clip.key}.mp3  (已存在)`);
      continue;
    }

    try {
      const buf = await generateAudio(clip.text, clip.rate);
      if (!buf || buf.length < 512) throw new Error(`音频过短 (${buf ? buf.length : 0} bytes)`);
      // MP3 帧同步校验：首字节 0xFF 且次字节高 3 位为 1
      if (buf[0] !== 0xff || (buf[1] & 0xe0) !== 0xe0) {
        throw new Error(`非法 MP3 头: ${buf.slice(0, 3).toString('hex')}`);
      }
      fs.writeFileSync(file, buf);
      made++;
      console.log(`  ok    ${clip.key}.mp3  ${buf.length} bytes  「${clip.text}」`);
    } catch (e) {
      failed++;
      console.error(`  FAIL  ${clip.key}.mp3  ${e.message}`);
    }

    await sleep(300); // 温和些，避免触发限流
  }

  console.log(`\n完成：新增 ${made}，跳过 ${skipped}，失败 ${failed}`);
  console.log(`输出目录：${OUT_DIR}`);
  if (failed) process.exitCode = 1;
}

main();
