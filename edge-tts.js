const WebSocket = require('ws');
const crypto = require('crypto');

const VOICE = 'zh-CN-XiaoxiaoNeural';
const OUTPUT_FORMAT = 'audio-24khz-48kbitrate-mono-mp3';
const TRUSTED_CLIENT_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
const BASE_URL = 'speech.platform.bing.com/consumer/speech/synthesize/readaloud';
const WSS_URL = `wss://${BASE_URL}/edge/v1?TrustedClientToken=${TRUSTED_CLIENT_TOKEN}`;

const CHROMIUM_FULL_VERSION = '143.0.3650.75';
const CHROMIUM_MAJOR_VERSION = CHROMIUM_FULL_VERSION.split('.')[0];
const SEC_MS_GEC_VERSION = `1-${CHROMIUM_FULL_VERSION}`;

// Windows epoch offset: seconds between 1601-01-01 and 1970-01-01
const WIN_EPOCH = 11644473600;

function generateSecMsGec() {
  // Current Unix timestamp
  let ticks = Date.now() / 1000;
  // Switch to Windows file time epoch
  ticks += WIN_EPOCH;
  // Round down to nearest 5 minutes (300 seconds)
  ticks -= ticks % 300;
  // Convert to 100-nanosecond intervals
  ticks = ticks * 1e7;
  // Hash with trusted client token
  const strToHash = `${ticks.toFixed(0)}${TRUSTED_CLIENT_TOKEN}`;
  return crypto.createHash('sha256').update(strToHash, 'ascii').digest('hex').toUpperCase();
}

function generateMuid() {
  return crypto.randomBytes(16).toString('hex').toUpperCase();
}

function getHeadersAndDataFromResponse(response) {
  const headers = {};
  const parts = response.split('\r\n\r\n');
  const headerPart = parts[0];
  const dataPart = parts.slice(1).join('\r\n\r\n');
  for (const line of headerPart.split('\r\n')) {
    const idx = line.indexOf(':');
    if (idx > 0) {
      headers[line.substring(0, idx).trim()] = line.substring(idx + 1).trim();
    }
  }
  return { headers, data: dataPart };
}

function ssmlHeadersPlusPerRequest(id, timestamp, ssml) {
  return (
    `X-RequestId:${id}\r\n` +
    `Content-Type:application/ssml+xml\r\n` +
    `X-Timestamp:${timestamp}Z\r\n` +
    `Path:ssml\r\n\r\n` +
    ssml
  );
}

function makeSSML(text, voice, rate = '0%', pitch = '0Hz', volume = '100%') {
  const escapedText = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');

  return (
    `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xmlns:mstts="https://www.w3.org/2001/mstts" xml:lang="zh-CN">` +
    `<voice name="${voice}">` +
    `<prosody rate="${rate}" pitch="${pitch}" volume="${volume}">` +
    escapedText +
    `</prosody></voice></speak>`
  );
}

function dateToString() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return (
    `${now.getUTCFullYear()}-${pad(now.getUTCMonth() + 1)}-${pad(now.getUTCDate())}T` +
    `${pad(now.getUTCHours())}:${pad(now.getUTCMinutes())}:${pad(now.getUTCSeconds())}.${String(now.getUTCMilliseconds()).padStart(3, '0')}`
  );
}

function connectId() {
  return crypto.randomUUID().replace(/-/g, '');
}

function rateToPercent(rate) {
  // rate: 0.6 ~ 1.0 -> "-40%" ~ "+0%"
  // default 0.85 -> "-15%"
  const percent = Math.round((rate - 1) * 100);
  if (percent >= 0) return `+${percent}%`;
  return `${percent}%`;
}

/**
 * Generate MP3 audio buffer from text using Edge TTS WebSocket protocol.
 * @param {string} text - Text to synthesize
 * @param {number} [rate=0.85] - Speech rate (0.6 ~ 1.0)
 * @returns {Promise<Buffer>} MP3 audio buffer
 */
function generateAudio(text, rate = 0.85) {
  return new Promise((resolve, reject) => {
    const id = connectId();
    const secMsGec = generateSecMsGec();
    const muid = generateMuid();
    const url = `${WSS_URL}&ConnectionId=${id}&Sec-MS-GEC=${secMsGec}&Sec-MS-GEC-Version=${SEC_MS_GEC_VERSION}`;

    const ws = new WebSocket(url, {
      headers: {
        'Pragma': 'no-cache',
        'Cache-Control': 'no-cache',
        'Origin': 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold',
        'User-Agent': `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROMIUM_MAJOR_VERSION}.0.0.0 Safari/537.36 Edg/${CHROMIUM_MAJOR_VERSION}.0.0.0`,
        'Accept-Encoding': 'gzip, deflate, br, zstd',
        'Accept-Language': 'en-US,en;q=0.9',
        'Cookie': `muid=${muid};`,
      },
    });

    const audioChunks = [];
    let timeout;

    timeout = setTimeout(() => {
      ws.close();
      reject(new Error('TTS timeout'));
    }, 15000);

    ws.on('open', () => {
      // Send configuration
      const configMsg = (
        `X-Timestamp:${dateToString()}\r\n` +
        `Content-Type:application/json; charset=utf-8\r\n` +
        `Path:speech.config\r\n\r\n` +
        JSON.stringify({
          context: {
            synthesis: {
              audio: {
                metadataoptions: {
                  sentenceBoundaryEnabled: 'false',
                  wordBoundaryEnabled: 'false',
                },
                outputFormat: OUTPUT_FORMAT,
              },
            },
          },
        })
      );
      ws.send(configMsg);

      // Send SSML
      const ssml = makeSSML(text, VOICE, rateToPercent(rate));
      const ssmlMsg = ssmlHeadersPlusPerRequest(id, dateToString(), ssml);
      ws.send(ssmlMsg);
    });

    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        // Binary message: first 2 bytes are header length, then header, then audio
        const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
        const headerLen = buf.readUInt16BE(0);
        const audioData = buf.subarray(2 + headerLen);
        if (audioData.length > 0) {
          audioChunks.push(audioData);
        }
      } else {
        // Text message
        const text = data.toString();
        if (text.includes('Path:turn.end')) {
          clearTimeout(timeout);
          ws.close();
          resolve(Buffer.concat(audioChunks));
        }
      }
    });

    ws.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });

    ws.on('close', (code) => {
      clearTimeout(timeout);
      if (audioChunks.length === 0) {
        reject(new Error(`TTS connection closed with code ${code}, no audio received`));
      }
    });
  });
}

module.exports = { generateAudio };
