// CrewPane — Mobile Gateway HTTP Payload Parsers & Helpers (Phase 4.12)
'use strict';

const {
  MAX_BODY_BYTES,
  MAX_AUDIO_BYTES,
  AUDIO_KINDS,
} = require('./constants.js');

function send(res, status, obj) {
  const json = JSON.stringify(obj);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(json),
    'cache-control': 'no-store',
  });
  res.end(json);
}

function readRaw(req, maxBytes = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > maxBytes) {
        reject(new Error('payload too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function readBody(req, maxBytes) {
  return readRaw(req, maxBytes).then((buf) => buf.toString('utf8'));
}

/**
 * ADP-296 — MİNİMAL multipart/form-data ayrıştırıcı (yalnız mobil ses yolu için).
 * Tek dosya alanı (`audio`) + düz metin alanları yeter; genel bir multipart kütüphanesi
 * getirmeye değmez. Dosya parçası → { audioBase64, mimeType }, metin parçaları → alan.
 * Sınır (boundary) bulunamazsa null → çağıran 400 basar (sessiz yanlış-ayrıştırma YOK).
 */
function parseMultipart(buf, contentType) {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(String(contentType || ''));
  const boundary = m && (m[1] || m[2] || '').trim();
  if (!boundary) return null;
  const sep = Buffer.from(`--${boundary}`);
  const out = {};
  let pos = buf.indexOf(sep);
  if (pos < 0) return null;
  pos += sep.length;
  while (pos < buf.length) {
    if (buf.slice(pos, pos + 2).toString() === '--') break; // kapanış sınırı
    const headEnd = buf.indexOf('\r\n\r\n', pos);
    if (headEnd < 0) break;
    const head = buf.slice(pos, headEnd).toString('utf8');
    let next = buf.indexOf(sep, headEnd);
    if (next < 0) next = buf.length;
    const body = buf.slice(headEnd + 4, Math.max(headEnd + 4, next - 2)); // sondaki \r\n hariç
    const nameM = /name="([^"]+)"/i.exec(head);
    const name = nameM ? nameM[1] : null;
    const isFile = /filename="/i.test(head);
    if (name) {
      if (isFile) {
        const typeM = /content-type:\s*([^\r\n;]+)/i.exec(head);
        const fileM = /filename="([^"]*)"/i.exec(head);
        out[name] = {
          audioBase64: body.toString('base64'),
          mimeType: typeM ? typeM[1].trim() : 'audio/m4a',
          // ADP-312: uzantı Whisper'ın TEK format sinyali → dosya adını atma.
          fileName: fileM ? fileM[1].trim() : '',
        };
      } else {
        out[name] = body.toString('utf8');
      }
    }
    pos = next + sep.length;
  }
  return out;
}

/**
 * ADP-296/314 — yazma gövdesini oku: JSON (varsayılan) veya ses rotalarında multipart.
 * Ses tavanı ayrı (MAX_AUDIO_BYTES); diğer gövdeler minik kalır (MAX_BODY_BYTES).
 */
async function readCommandPayload(req, kind) {
  const ctype = String(req.headers['content-type'] || '');
  const audioKind = AUDIO_KINDS.has(kind);
  const limit = audioKind ? MAX_AUDIO_BYTES : MAX_BODY_BYTES;
  let raw;
  try {
    raw = await readRaw(req, limit);
  } catch (err) {
    return { ok: false, error: err.message === 'payload too large' ? 'gövde çok büyük' : String(err.message || err) };
  }
  if (/multipart\/form-data/i.test(ctype)) {
    if (!audioKind) return { ok: false, error: 'bu rota multipart kabul etmez (JSON gönder)' };
    const parts = parseMultipart(raw, ctype);
    if (!parts) return { ok: false, error: 'multipart sınırı (boundary) okunamadı' };
    const audio = parts.audio;
    const value = {};
    if (audio && audio.audioBase64) {
      value.audioBase64 = audio.audioBase64;
      value.mimeType = audio.mimeType;
      if (audio.fileName) value.fileName = audio.fileName;
    }
    if (typeof parts.text === 'string' && parts.text.trim()) value.text = parts.text.trim();
    // ADP-314 — sözlük ipucu (ajan isimleri) multipart yolunda da geçebilsin.
    if (typeof parts.hint === 'string' && parts.hint.trim()) value.hint = parts.hint.trim();
    if (kind === 'transcribe') {
      if (!value.audioBase64) return { ok: false, error: 'ses (audio) alanı gerekli' };
      return { ok: true, value };
    }
    if (!value.audioBase64 && !value.text) return { ok: false, error: 'ses (audio) veya metin (text) alanı gerekli' };
    return { ok: true, value };
  }
  try {
    const parsed = JSON.parse(raw.toString('utf8') || '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { ok: false, error: 'gövde bir JSON nesnesi olmalı' };
    return { ok: true, value: parsed };
  } catch {
    return { ok: false, error: 'geçersiz JSON' };
  }
}

function withTimeout(promise, ms) {
  return Promise.race([
    Promise.resolve(promise),
    new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms)),
  ]);
}

module.exports = {
  send,
  readRaw,
  readBody,
  parseMultipart,
  readCommandPayload,
  withTimeout,
};
