// CrewPane — B-01 Faz D/E: MERGE YÜRÜTME (GIT-BACKBONE-SPEC §2.8) + SIR TARAMASI GATE'İ (G-4).
//
// ─────────────────────────────────────────────────────────────────────────────
// GİT KISITI KI TÜM MİMARİYİ BELİRLİYOR (K7)
// ─────────────────────────────────────────────────────────────────────────────
// Bir branch aynı anda TEK worktree'de checkout edilebilir. Hedef (`dev`) BİRİNCİL
// ağaçtadır ve ajanlar oraya ASLA girmez. Bu invaryant merge'ü güvenli kılar:
// merge her zaman birincil ağaçta, kilit altında, `--no-ff` ile koşar.
//
// Çakışma ise ajanın ağacında çözülür. **Patronun ağacında yarım-çakışık bir index
// bırakmak yasaktır** — bu yüzden çakışma tespiti `git merge-tree --write-tree` ile,
// hedef ağaca HİÇ DOKUNMADAN yapılır (K8; git ≥ 2.38, bu makinede 2.39.5 ölçüldü).
//
// ─────────────────────────────────────────────────────────────────────────────
// G-4 — SIR TARAMASI NEDEN MERGE ANINDA
// ─────────────────────────────────────────────────────────────────────────────
// Ajan `.env.local`/anahtar commit'lerse iş kendi dalında kalırken zarar sınırlıdır;
// MERGE onu `dev` geçmişine KALICI yazar (bir daha `revert` ile de silinmez, geçmişte
// durur). Bu yüzden kapı tam olarak buraya konur. Bulgu → merge BLOKE, kart DOSYA
// ADINI der, **DEĞERİ ASLA basmaz** (skillSecretScan disiplininin aynısı).

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const mask = require('../memory/memorySecretMask.cjs');
const policy = require('./mergePolicy.cjs');
const store = require('./worktreeStore.cjs');
const svc = require('./worktreeService.cjs');

const { git } = svc;

/** §2.8 adım 2 — proje başına tek yazar; bayat kilit bu süre sonra kırılır (H-11). */
const LOCK_STALE_MS = 10 * 60 * 1000;

// ═══════════════════════════════════════════════════════════════════════════
// merge-tree ÖN-UÇUŞU (K8, H-1)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * `git merge-tree --write-tree --messages` çıktısının SAF ayrıştırıcısı.
 *
 * Biçim (git 2.38+):
 *   temiz  → exit 0, stdout: "<tree-oid>\n"
 *   çakışık→ exit 1, stdout: "<tree-oid>\n<çakışan dosya listesi>\n\n<mesajlar>"
 * Çakışan dosya satırları `<mode> <oid> <stage>\t<yol>` biçimindedir; `--messages`
 * ile ayrıca insan-okur "CONFLICT (…): …" satırları gelir.
 *
 * @returns {{clean:boolean, tree:string|null, files:string[], messages:string[]}}
 */
function parseMergeTree(stdout, exitCode) {
  const text = String(stdout || '');
  const lines = text.split('\n');
  const tree = /^[0-9a-f]{7,64}$/.test((lines[0] || '').trim()) ? lines[0].trim() : null;
  const files = [];
  const messages = [];
  for (const line of lines.slice(1)) {
    if (!line) continue;
    const stage = /^\d{6} [0-9a-f]{7,64} [1-3]\t(.+)$/.exec(line);
    if (stage) {
      if (!files.includes(stage[1])) files.push(stage[1]);
      continue;
    }
    if (/^(CONFLICT|AUTO-MERGING|Auto-merging)/i.test(line.trim())) messages.push(line.trim());
  }
  return { clean: exitCode === 0 && files.length === 0, tree, files, messages };
}

/**
 * Ön-uçuş: hedef ağaca DOKUNMADAN çakışma var mı?
 * Exit ≥ 2 (128) gerçek hatadır — "temiz" SAYILMAZ (fail-closed).
 */
async function preflight(repo, target, branch) {
  const r = await git(repo, ['merge-tree', '--write-tree', '--messages', '--', target, branch]);
  if (!r.ok && r.code !== 1) {
    return { ok: false, why: `merge-tree hatası: ${r.stderr.trim().slice(0, 300)}` };
  }
  const parsed = parseMergeTree(r.stdout, r.ok ? 0 : r.code);
  return { ok: true, ...parsed };
}

// ═══════════════════════════════════════════════════════════════════════════
// G-4 — DİFF ÜZERİNDE SIR TARAMASI
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Merge edilecek diff'te sır var mı? Yalnız EKLENEN satırlar taranır (silinen bir
 * sır zaten sızmıştı; merge onu tekrar yazmıyor) ve bulgu DOSYA ADIYLA döner.
 *
 * ⚠️ DÖNEN NESNEDE DEĞER YOKTUR — ne eşleşen dize, ne satır içeriği. Yalnız
 * dosya + tür + adet. Bir sır bulgusunu raporlarken sırrı basmak, kapının kendisini
 * sızıntıya çevirirdi.
 */
function scanDiffForSecrets(diffText) {
  const findings = [];
  let file = null;
  let currentLine = 0;

  for (const rawLine of String(diffText || '').split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    const hdr = /^\+\+\+ b\/(.+)$/.exec(line);
    if (hdr) {
      file = hdr[1];
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      currentLine = parseInt(hunk[1], 10);
      continue;
    }
    if (line.startsWith('+++')) continue;
    if (line.startsWith('+')) {
      const addedText = line.slice(1);
      const r = mask.maskSecretsDetailed(addedText);
      if (r.masked) {
        findings.push({
          file: file || '(bilinmeyen dosya)',
          line: currentLine,
          location: `${file || '(bilinmeyen dosya)'}:${currentLine}`,
          kinds: [...r.kinds],
          count: r.masked,
          snippet: mask.maskSecrets(addedText).trim(),
        });
      }
      currentLine++;
    } else if (!line.startsWith('-')) {
      currentLine++;
    }
  }

  const warning = findings.length
    ? {
      code: 'secret-in-diff',
      message: `sır taraması ${findings.length} yerde bulgu verdi`,
      findings,
    }
    : null;

  return {
    ok: findings.length === 0,
    findings,
    warning,
    why: findings.length
      ? `sır taraması ${findings.length} yerde bulgu verdi: ${findings.map((f) => `${f.location} (${f.kinds.join(',')})`).join(', ')}`
      : 'sır taraması temiz',
  };
}

/** Dal ile hedef arasındaki diff'i çek ve tara. */
async function secretGate(repo, target, branch) {
  const d = await git(repo, ['diff', `${target}...${branch}`]);
  if (!d.ok) return { ok: false, findings: [], why: `diff alınamadı: ${d.stderr.trim().slice(0, 200)}` };
  return scanDiffForSecrets(d.stdout);
}

// ═══════════════════════════════════════════════════════════════════════════
// KİLİT (§2.8 adım 2, H-11)
// ═══════════════════════════════════════════════════════════════════════════

function lockPath(homedir, project) {
  const instancePaths = require('../config/instancePaths.cjs');
  const slug = String(project || 'default').replace(/[^a-z0-9._-]/gi, '_');
  return path.join(instancePaths.crewpaneHome(homedir), `merge-${slug}.lock`);
}

/**
 * Kilidi al. Bayat kilit (> LOCK_STALE_MS) kırılır ve bu LOGLANIR — sessizce
 * kırmak, çöken bir merge'ü görünmez yapardı.
 */
function acquireLock(homedir, project, { now = Date.now(), pid = process.pid } = {}) {
  const file = lockPath(homedir, project);
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const age = now - (Number(raw.ts) || 0);
    if (age < LOCK_STALE_MS) {
      return { ok: false, why: `merge kilidi tutuluyor (pid=${raw.pid}, ${Math.round(age / 1000)} sn)`, held: true };
    }
    // bayat → kır
  } catch {
    /* kilit yok ya da bozuk → alınabilir */
  }
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ pid, ts: now }), 'utf8');
    return { ok: true, file };
  } catch (err) {
    return { ok: false, why: `kilit yazılamadı: ${String((err && err.code) || err)}` };
  }
}

function releaseLock(homedir, project) {
  try { fs.unlinkSync(lockPath(homedir, project)); return true; } catch { return false; }
}

// ═══════════════════════════════════════════════════════════════════════════
// İNCELEME → MERGE
// ═══════════════════════════════════════════════════════════════════════════

/**
 * İNCELEME KARTI verisi (§2.7 "patron ne görecek"). Hiçbir şeyi DEĞİŞTİRMEZ —
 * saf ölçüm + saf karar. Kartı çizen UI (B-03) bunu okur.
 */
async function review(taskId, { homedir, repoPath, target, setting, autopilot, gate, now } = {}) {
  const rec = store.getWorktree(taskId, homedir);
  if (!rec || !rec.branch) return { ok: false, why: 'defterde worktree kaydı yok' };
  const repo = repoPath;
  const tgt = target || 'dev';

  const st = await svc.status(taskId, homedir);
  if (!st.ok) return { ok: false, why: st.why };

  const pre = await preflight(repo, tgt, rec.branch);
  if (!pre.ok) return { ok: false, why: pre.why };

  const secrets = await secretGate(repo, tgt, rec.branch);
  const decision = policy.decideApproval({
    target: tgt, setting, autopilot, gate, secretScan: secrets, conflict: !pre.clean,
  });

  const dirtyTarget = await git(repo, ['status', '--porcelain']);
  const pcs = policy.checkPreconditions({
    targetDirty: dirtyTarget.stdout.trim().length > 0,
    commitCount: st.commitCount,
  });

  return {
    ok: true,
    taskId, branch: rec.branch, target: tgt, baseCommit: rec.baseCommit,
    commitCount: st.commitCount,
    commits: st.commits.slice(0, 20),
    files: st.files.slice(0, 20),
    fileCount: st.files.length,
    diffStat: st.diffStat,
    dirty: st.dirty,
    conflict: !pre.clean,
    conflictFiles: pre.files,
    secretScan: { ok: secrets.ok, findings: secrets.findings, warning: secrets.warning, why: secrets.why },
    warning: secrets.warning || null,
    gate: gate || null,
    approval: decision,
    preconditions: pcs,
    nextState: pre.clean ? 'review' : 'conflict',
    now: now ?? null,
  };
}

/**
 * MERGE'Ü YÜRÜT (§2.8 adım 4). Kapıların HEPSİ burada TEKRAR koşar — `review`
 * çağrısıyla merge arasında dünya değişmiş olabilir (ajan yeni commit atmış, patron
 * hedefi kirletmiş olabilir). "Kart yeşildi" bir yetki belgesi DEĞİLDİR.
 *
 * `--no-verify` ve `--force` bu fonksiyonda HİÇ üretilmez (K10/G-6).
 */
async function merge(taskId, { homedir, repoPath, target, title, setting, autopilot, gate, approvedBy, now = Date.now() } = {}) {
  const rec = store.getWorktree(taskId, homedir);
  if (!rec || !rec.branch) return { ok: false, why: 'defterde worktree kaydı yok' };
  const repo = repoPath;
  const tgt = target || 'dev';

  const card = await review(taskId, { homedir, repoPath: repo, target: tgt, setting, autopilot, gate, now });
  if (!card.ok) return { ok: false, why: card.why };
  if (card.secretScan && !card.secretScan.ok) {
    return { ok: false, why: `merge BLOKE: ${card.secretScan.why}`, warning: card.secretScan.warning, card, state: 'review' };
  }
  if (card.approval.blocked) {
    return { ok: false, why: `merge BLOKE: ${card.approval.why}`, warning: card.warning, card, state: card.conflict ? 'conflict' : 'review' };
  }
  if (!card.preconditions.ok) return { ok: false, why: card.preconditions.why, card };
  if (!card.approval.auto && !approvedBy) {
    return { ok: false, why: `onay gerekli (${card.approval.approver}) — ${card.approval.why}`, card, needsApproval: card.approval.approver };
  }

  const lock = acquireLock(homedir, rec.project, { now });
  if (!lock.ok) return { ok: false, why: lock.why, card };
  try {
    const head = await svc.revParse(repo, tgt);
    const co = await git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']);
    if (co.stdout.trim() !== tgt) {
      return { ok: false, why: `birincil ağaç '${tgt}' üzerinde değil (HEAD=${co.stdout.trim()}) — merge yapılmadı`, card };
    }
    const msg = `${String(rec.code || taskId).toUpperCase()}: ${title || 'görev'} (${rec.branch})`;
    const m = await git(repo, ['merge', '--no-ff', '-m', msg, '--', rec.branch]);
    if (!m.ok) {
      // Yarım-çakışık index bırakma (patronun ağacı temiz kalmalı, H-1/H-8).
      await git(repo, ['merge', '--abort']);
      return { ok: false, why: `git merge: ${m.stderr.trim().slice(0, 300)} (merge --abort koşuldu)`, card, state: 'conflict' };
    }
    const mergedCommit = await svc.revParse(repo, tgt);
    store.putWorktree(taskId, { state: 'merged' }, homedir, now);
    return {
      ok: true, mergedCommit, previousHead: head, branch: rec.branch, target: tgt,
      message: msg, approvedBy: approvedBy || card.approval.approver, card,
    };
  } finally {
    releaseLock(homedir, rec.project);
  }
}

/**
 * GERİ ALMA (§2.8 adım 6) — `revert -m 1`. `reset` YASAK: patronun ağacında geçmiş
 * silinmez ve başka birinin çektiği commit ortadan kaybolmaz.
 */
async function revertMerge(repoPath, mergeCommit) {
  if (!/^[0-9a-f]{7,40}$/.test(String(mergeCommit || ''))) return { ok: false, why: 'geçersiz commit hash' };
  const r = await git(repoPath, ['revert', '-m', '1', '--no-edit', '--', mergeCommit]);
  if (!r.ok) return { ok: false, why: `git revert: ${r.stderr.trim().slice(0, 300)}` };
  const head = await svc.revParse(repoPath, 'HEAD');
  return { ok: true, revertCommit: head };
}

module.exports = {
  LOCK_STALE_MS,
  parseMergeTree,
  preflight,
  scanDiffForSecrets,
  secretGate,
  lockPath,
  acquireLock,
  releaseLock,
  review,
  merge,
  revertMerge,
};
