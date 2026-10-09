'use strict';

const REPORT_STATUSES = Object.freeze(['done', 'failed', 'in_progress', 'review', 'blocked', 'todo', 'backlog']);
const MAX_REPORT_TOKEN_LEN = 80;

const REPORT_TOKEN_FOLD = Object.freeze({
  ç: 'c', Ç: 'c', ğ: 'g', Ğ: 'g', ı: 'i', İ: 'i',
  ö: 'o', Ö: 'o', ş: 's', Ş: 's', ü: 'u', Ü: 'u',
  á: 'a', à: 'a', â: 'a', ä: 'a', ã: 'a', å: 'a', Á: 'a', À: 'a', Â: 'a', Ä: 'a', Ã: 'a', Å: 'a',
  é: 'e', è: 'e', ê: 'e', ë: 'e', É: 'e', È: 'e', Ê: 'e', Ë: 'e',
  í: 'i', ì: 'i', î: 'i', ï: 'i', Í: 'i', Î: 'i', Ï: 'i',
  ó: 'o', ò: 'o', ô: 'o', õ: 'o', Ó: 'o', Ò: 'o', Ô: 'o', Õ: 'o',
  ú: 'u', ù: 'u', û: 'u', Ú: 'u', Ù: 'u', Û: 'u',
  ñ: 'n', Ñ: 'n', ý: 'y', Ý: 'y', ß: 'ss', æ: 'ae', Æ: 'ae', ø: 'o', Ø: 'o',
});

function foldAscii(raw) {
  let s = typeof raw === 'string' ? raw : '';
  try {
    s = s.normalize('NFC');
  } catch {
    /* normalize yoksa ham metinle devam */
  }
  let out = '';
  for (const ch of s) out += REPORT_TOKEN_FOLD[ch] ?? ch;
  try {
    out = out.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  } catch {
    /* tablo sonucu yeterli */
  }
  return out;
}

/**
 * Sanitize one filename segment (task id / role) to a bare token.
 */
function sanitizeReportToken(raw) {
  if (typeof raw !== 'string') return '';
  const t = foldAscii(raw)
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, '-') // collapse disallowed runs → single '-'
    .replace(/^[-.]+|[-.]+$/g, ''); // no leading/trailing separator or dot
  return t.slice(0, MAX_REPORT_TOKEN_LEN);
}

/**
 * REN-02 — AJAN JETONU (rapor dosya adının ikinci segmenti).
 */
function reportAgentToken(raw) {
  return sanitizeReportToken(raw).toLowerCase();
}

/**
 * Canonical report filename for a (taskId, role): `<task>-<role>.md`.
 */
function reportFileName(taskId, role) {
  const task = sanitizeReportToken(taskId);
  if (!task) return null;
  const r = reportAgentToken(role) || 'report';
  return `${task}-${r}.md`;
}

/**
 * Build the on-disk markdown for a completion report.
 */
function buildReportMarkdown(opts = {}) {
  const { taskId, role, agentName, status, summary } = opts;
  const task = sanitizeReportToken(taskId) || 'TASK';
  const agent =
    (typeof agentName === 'string' && agentName.trim()) || sanitizeReportToken(role) || 'agent';
  const rawStatus = typeof status === 'string' ? status.trim() : '';
  const normStatus = REPORT_STATUSES.includes(rawStatus.toLowerCase())
    ? rawStatus.toLowerCase()
    : rawStatus || 'done';
  const body =
    (typeof summary === 'string' && summary.trim()) ||
    '(özet yok — çalışma tamamlandı, ayrıntı eklenmedi.)';
  const agentId = reportAgentToken(role);
  const frontmatter = [
    '---',
    `task_id: ${task}`,
    `agent: ${agent}`,
    ...(agentId ? [`agent_id: ${agentId}`] : []),
    `status: ${normStatus}`,
    '---',
    '',
  ].join('\n');
  return `${frontmatter}# ${task} — ${agent}\n\n${body}\n`;
}

module.exports = {
  REPORT_STATUSES,
  MAX_REPORT_TOKEN_LEN,
  REPORT_TOKEN_FOLD,
  foldAscii,
  sanitizeReportToken,
  reportAgentToken,
  reportFileName,
  buildReportMarkdown,
};
