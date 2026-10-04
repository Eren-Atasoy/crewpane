// CrewPane — ADP-538 worker-completion notify emit.
//
// KÖK NEDEN: docs/.agent-notifications'a DONE/FAIL/TIMEOUT satırlarını YALNIZ eski
// tmux yolunun `watch-agent-result` watcher'ı yazıyordu (spawn-worker başlatır).
// Delegasyon in-app bridge'e taşınınca (ADP-050+) o watcher hiç koşmaz oldu →
// dosya 10 gün bayat kaldı → liderin Monitor tail'i hiç ateşlenmedi → "worker
// bitti ama lider haberi yok" (Eren, 3 takımda, 2026-07-22).
//
// Bu modül in-app delegasyon motorunun completion olaylarını AYNI log formatında
// (watch-agent-result uyumlu — liderlerin mevcut `grep DONE:|TIMEOUT:|FAIL`
// Monitor'ları değişmeden çalışsın) tek satıra çevirir ve ekler. Yazım best-effort:
// notify hatası delegasyonu asla kırmaz (resumeNotify sözleşmesiyle aynı).
//
// Leaf modül: yalnız resumeNotify.cjs'e (aynı dizin, CJS) bağımlı → node --test
// doğrudan koşar. Renderer'dan IPC ile (main.js 'notify:workerEvent') çağrılır;
// MCP child'a ASLA require edilmez (asarUnpack yükü yok — [[mcp-child-require-asarunpack]]).

'use strict';

const { stamp, append } = require('../terminal/resumeNotify.cjs');

/** İzinli olay türleri → log tag'i (watch-agent-result'ın grep sözleşmesi). */
const TAGS = Object.freeze({
  done: 'DONE',
  fail: 'FAIL',
  timeout: 'TIMEOUT',
  report: 'REPORT',
});

/** Tek satıra sığdır + log enjeksiyonunu kes (yeni satır → boşluk) + uzunluk tavanı. */
function clean(text, max) {
  return String(text == null ? '' : text)
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .slice(0, max);
}

/**
 * Bir worker-completion olayını legacy-uyumlu notify satırına çevir.
 *   done    → "[HH:MM:SS] DONE: ADP-531 → docs/agent-results/ADP-531-jazz.md"
 *   fail    → "[HH:MM:SS] FAIL: ADP-531 (sebep)"
 *   timeout → "[HH:MM:SS] TIMEOUT: ADP-531 (1800s geçti)"
 *   report  → "[HH:MM:SS] REPORT: dlg-123 (3/3 alt-görev ok)"
 * Geçersiz kind/boş task → null (çağıran sessizce atlar — asla throw yok).
 */
function buildWorkerLine(evt, now) {
  if (!evt || typeof evt !== 'object') return null;
  const tag = TAGS[evt.kind];
  const task = clean(evt.task, 120);
  if (!tag || !task) return null;
  const detail = clean(evt.detail, 300);
  const tail = detail ? (evt.kind === 'done' ? ` → ${detail}` : ` (${detail})`) : '';
  return `[${stamp(now)}] ${tag}: ${task}${tail}`;
}

/** Satırı üret + log'a ekle (best-effort; başarıda true). */
function appendWorkerEvent(logPath, evt, now) {
  if (!logPath) return false;
  const line = buildWorkerLine(evt, now);
  if (!line) return false;
  return append(logPath, line);
}

module.exports = { TAGS, buildWorkerLine, appendWorkerEvent };
