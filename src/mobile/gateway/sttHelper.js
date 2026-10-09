// CrewPane — Mobile Gateway Speech-To-Text Proxy (Phase 4.12)
'use strict';

const jarvisVoice = require('../../voice/jarvisVoice.js');
const { sttErrorMessage } = jarvisVoice;

/**
 * ADP-312/314 — TEK STT YÜZEYİ (jarvis + transcribe ikisi de buradan geçer).
 * Ses Mac'te çözülür; hata YUTULMAZ (OpenAI'ın gövdesi Mac log'una düşer, telefona
 * dürüst Türkçe sebep gider). Ham ses ne renderer'a ne log'a taşınır.
 *
 * Sözlük ipucu (`prompt`): istemcinin verdiği isimler + CANLI pane etiketleri.
 * Yalnız yazım kalitesi içindir — Whisper'a komut değildir, transkriptin kendisi
 * her zaman kullanıcının söylediği metindir.
 */
async function runStt(value, opts, log = () => {}) {
  if (!opts.transcribe) {
    return { ok: false, reason: 'no-transcriber', error: 'ses transkripti bu sürümde bağlı değil' };
  }
  const names = [];
  for (const p of (opts.listPanes ? opts.listPanes() : []) || []) {
    if (p && p.label) names.push(p.label);
    if (p && p.agentId) names.push(p.agentId);
  }
  const hint = jarvisVoice.buildVocabPrompt([
    ...String(value.hint || '')
      .split(/[,\n]/)
      .map((s) => s.trim())
      .filter(Boolean),
    ...names,
  ]);
  const t = await opts.transcribe({
    audioBase64: value.audioBase64,
    mimeType: value.mimeType,
    fileName: value.fileName, // ADP-312: uzantı = Whisper'ın format sinyali
    prompt: hint || undefined,
  });
  const text = t && t.ok ? String(t.text || '').trim() : '';
  if (!t || !t.ok || !text) {
    const reason = t && t.ok ? 'empty-transcript' : (t && t.reason) || 'bilinmiyor';
    const detail = (t && t.detail) || '';
    const bytes = Math.floor((String(value.audioBase64 || '').length * 3) / 4);
    log(
      `mobile stt: STT başarısız — reason=${reason} bytes=${bytes} mime=${value.mimeType || '?'} ` +
        `file=${value.fileName || '-'}${detail ? ` detail=${String(detail).slice(0, 300)}` : ''}`,
    );
    return { ok: false, reason, error: `ses çözümlenemedi: ${sttErrorMessage(reason, detail)}` };
  }
  return { ok: true, text };
}

module.exports = {
  runStt,
};
