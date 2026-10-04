// CrewPane — B-01 Faz B: YEREL WORKTREE DEFTERİ (GIT-BACKBONE-SPEC §2.2b, K9).
//
//     ~/.crewpane/worktrees.json       (instance-scoped: dev → ~/.crewpane-dev)
//
// ─────────────────────────────────────────────────────────────────────────────
// NEDEN BULUTTA DEĞİL (K9)
// ─────────────────────────────────────────────────────────────────────────────
// Board bulutta ve ÇOK KİRACILI. Bir worktree'nin MUTLAK YOLU kullanıcı adını ve
// disk düzenini taşır (`/Users/<isim>/Downloads/…`) — bu, işi görmek için gereksiz
// bir PII'dir. Portatif olan şey (branch, merge durumu) `tasks` satırına yazılır
// (Faz C); makineye özel olan (repo yolu, worktree yolu, sahip pane) BURAYA. İki
// cihaz aynı board'u açtığında ikinci cihaz "bu cihazda izole ağaç yok" der (H-10),
// yanlış bir yol göstermez.
//
// ─────────────────────────────────────────────────────────────────────────────
// F-8 — SAHİPLİK (bu defterin ASIL işi)
// ─────────────────────────────────────────────────────────────────────────────
// `taskClaim` kapısı "AYNI AJANA aynı görev" bakıyor. İki FARKLI ajanın aynı göreve
// spawn edilmesi hiçbir kapıdan geçmiyordu — B-01k spike'ının kendisi böyle
// çift-spawn edildi ve iki ajan aynı dosyaları üst üste yazdı. Burada görev→worktree
// kaydı TEK SAHİPLİDİR (`owner` = agentId): ikinci ajanın spawn'ı ya sahiplik devriyle
// AYNI worktree'ye bağlanır ya reddedilir (`claimOwner`, H-4b).
//
// ─────────────────────────────────────────────────────────────────────────────
// DİSİPLİN — livePaneRegistry.cjs emsali (birebir)
// ─────────────────────────────────────────────────────────────────────────────
//   • bozuk / eksik / yanlış şekilli dosya → BOŞ defter (asla throw)
//   • yazım atomik (platform/atomicWrite boğazı: tmp+rename, win32 son çare)
//   • her fonksiyon `homedir` dikişi alır → `node --test` tmp dizinde koşar
//   • defter ASLA tek gerçek kaynak değildir: git'in kendisi öyle. Defter kaybolursa
//     iş kaybolmaz (branch ve worktree diskte durur), yalnız bağ kopar → `reap`
//     onları `orphaned` olarak geri toplar.

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { atomicWriteFileSync } = require('../../platform/atomicWrite.cjs');
const instancePaths = require('../config/instancePaths.cjs');
const worktreePath = require('../config/worktreePath.cjs');

const STORE_VERSION = 1;

/** Kayıt durumları (§2.4 yaşam döngüsü). */
const STATES = Object.freeze(['active', 'orphaned', 'merged', 'removed']);

function storePath(homedir) {
  return path.join(instancePaths.crewpaneHome(homedir), 'worktrees.json');
}

function emptyStore() {
  return { version: STORE_VERSION, projects: {}, worktrees: {} };
}

/** Defteri oku. Eksik/bozuk/yanlış şekil → boş defter. ASLA throw etmez. */
function loadStore(homedir) {
  try {
    const raw = fs.readFileSync(storePath(homedir), 'utf8');
    const s = JSON.parse(raw);
    if (!s || typeof s !== 'object') return emptyStore();
    const projects = s.projects && typeof s.projects === 'object' && !Array.isArray(s.projects) ? s.projects : {};
    const worktrees = s.worktrees && typeof s.worktrees === 'object' && !Array.isArray(s.worktrees) ? s.worktrees : {};
    return { version: STORE_VERSION, projects, worktrees };
  } catch {
    return emptyStore();
  }
}

/**
 * Defteri yaz (atomik). Başarısızlık `false` döner ve ÇAĞIRANI DURDURMAZ ama
 * SESSİZ de değildir — [[adp946-persist-claim-vs-proof]] dersi: "yazdım" kanıt
 * değildir, hüküm çağırana taşınmalı ki spawn kararı buna bakabilsin.
 */
function saveStore(store, homedir) {
  try {
    const s = store && typeof store === 'object' ? store : emptyStore();
    const body = JSON.stringify({ version: STORE_VERSION, projects: s.projects || {}, worktrees: s.worktrees || {} }, null, 2);
    atomicWriteFileSync(storePath(homedir), body, { encoding: 'utf8' });
    return true;
  } catch {
    return false;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// PROJE → REPO YOLU (Faz C açık soru A-1'in yerel yarısı)
// ═══════════════════════════════════════════════════════════════════════════

/** Bir projenin yerel kaydı: `{repoPath, defaultBranch}` ya da null. */
function getProject(slug, homedir) {
  const s = loadStore(homedir);
  const p = s.projects[String(slug || '').trim().toLowerCase()];
  if (!p || typeof p !== 'object') return null;
  const repoPath = typeof p.repoPath === 'string' && p.repoPath ? p.repoPath : null;
  if (!repoPath) return null;
  return {
    repoPath,
    defaultBranch: typeof p.defaultBranch === 'string' && p.defaultBranch ? p.defaultBranch : 'dev',
  };
}

/** Proje kaydını yaz/güncelle. `repoPath` MUTLAK olmalı (göreli yol iki farklı cwd'de iki şey demektir). */
function setProject(slug, { repoPath, defaultBranch } = {}, homedir) {
  const key = String(slug || '').trim().toLowerCase();
  if (!key) return false;
  if (typeof repoPath !== 'string' || !path.isAbsolute(repoPath)) return false;
  const s = loadStore(homedir);
  s.projects[key] = {
    repoPath: path.resolve(repoPath),
    defaultBranch: typeof defaultBranch === 'string' && defaultBranch ? defaultBranch : 'dev',
  };
  return saveStore(s, homedir);
}

function listProjects(homedir) {
  return loadStore(homedir).projects;
}

// ═══════════════════════════════════════════════════════════════════════════
// GÖREV → WORKTREE
// ═══════════════════════════════════════════════════════════════════════════

function normalizeRecord(taskId, rec) {
  const r = rec && typeof rec === 'object' ? rec : {};
  return {
    taskId: String(taskId),
    project: typeof r.project === 'string' ? r.project : '',
    code: typeof r.code === 'string' ? r.code : '',
    branch: typeof r.branch === 'string' ? r.branch : '',
    path: typeof r.path === 'string' ? r.path : '',
    baseCommit: typeof r.baseCommit === 'string' ? r.baseCommit : null,
    owner: typeof r.owner === 'string' && r.owner ? r.owner : null,
    lastPaneId: typeof r.lastPaneId === 'string' ? r.lastPaneId : null,
    state: STATES.includes(r.state) ? r.state : 'active',
    createdAt: Number.isFinite(r.createdAt) ? r.createdAt : null,
    updatedAt: Number.isFinite(r.updatedAt) ? r.updatedAt : null,
  };
}

/** Görevin defterdeki kaydı (yoksa null). */
function getWorktree(taskId, homedir) {
  const id = String(taskId || '').trim();
  if (!id) return null;
  const rec = loadStore(homedir).worktrees[id];
  return rec ? normalizeRecord(id, rec) : null;
}

/**
 * Kaydı yaz/güncelle (kısmi alanlar birleştirilir). `now` enjekte edilebilir
 * (Date.now testte belirsizlik üretir).
 */
function putWorktree(taskId, patch, homedir, now = Date.now()) {
  const id = String(taskId || '').trim();
  if (!id) return null;
  const s = loadStore(homedir);
  const prev = s.worktrees[id] ? normalizeRecord(id, s.worktrees[id]) : null;
  const next = normalizeRecord(id, { ...(prev || {}), ...(patch || {}) });
  next.createdAt = prev?.createdAt ?? now;
  next.updatedAt = now;
  s.worktrees[id] = next;
  return saveStore(s, homedir) ? next : null;
}

/** Kaydı defterden çıkar (worktree'nin DİSKTEN silinmesi ayrı iştir — service'in). */
function removeWorktree(taskId, homedir) {
  const id = String(taskId || '').trim();
  const s = loadStore(homedir);
  if (!s.worktrees[id]) return false;
  delete s.worktrees[id];
  return saveStore(s, homedir);
}

/** Tüm kayıtlar (dizi). */
function listWorktrees(homedir) {
  const s = loadStore(homedir);
  return Object.entries(s.worktrees).map(([id, rec]) => normalizeRecord(id, rec));
}

/** Belirli durumdaki kayıtlar. */
function listByState(state, homedir) {
  return listWorktrees(homedir).filter((r) => r.state === state);
}

/**
 * Bir branch adı defterde HANGİ göreve ait? (branchName.resolveBranchName'in
 * `ownerOf` dikişi — çakışma çözümü buna bakar, H-6.)
 */
function taskIdForBranch(branch, homedir) {
  const b = String(branch || '');
  if (!b) return null;
  for (const rec of listWorktrees(homedir)) {
    if (rec.branch === b && rec.state !== 'removed') return rec.taskId;
  }
  return null;
}

/**
 * Bir yol defterde kayıtlı mı? (reaper / kaçak temizlik kapısı)
 * Karşılaştırma `samePath` ile yapılır: `git worktree list` yolları symlink'lerden
 * arındırılmış basar (macOS `/var` → `/private/var`), dize eşitliği yalan söyler.
 */
function taskIdForPath(wtPath, homedir) {
  if (typeof wtPath !== 'string' || !wtPath) return null;
  for (const rec of listWorktrees(homedir)) {
    if (rec.path && worktreePath.samePath(rec.path, wtPath)) return rec.taskId;
  }
  return null;
}

// ═══════════════════════════════════════════════════════════════════════════
// F-8 / H-4b — SAHİPLİK KARARI (SAF; defter durumu girdi olarak verilir)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Bir ajan bu görevin worktree'sini kullanabilir mi?
 *
 * @param {{owner?:string|null, state?:string}|null} rec defterdeki mevcut kayıt
 * @param {{agentId?:string|null, allowTakeover?:boolean, ownerLive?:boolean}} req
 *   `ownerLive` — mevcut sahibin CANLI bir pane'i var mı (main ölçer). Sahibi ölmüş
 *   bir kayıt devralınabilir; canlı sahibi olan kayıt DEVRALINAMAZ (iki ajan aynı
 *   branch'e paralel yazamaz — H-4b'nin bütün amacı bu).
 * @returns {{action:'claim'|'reuse'|'takeover'|'deny', owner:string|null, why:string}}
 */
function decideOwnership(rec, req = {}) {
  const agentId = typeof req.agentId === 'string' && req.agentId.trim() ? req.agentId.trim() : null;
  if (!rec || !rec.owner) {
    return { action: 'claim', owner: agentId, why: 'kayıt sahipsiz — ilk sahiplik' };
  }
  if (agentId && rec.owner === agentId) {
    return { action: 'reuse', owner: agentId, why: `${agentId} zaten sahibi — aynı worktree` };
  }
  if (req.ownerLive === true && req.allowTakeover !== true) {
    return {
      action: 'deny',
      owner: rec.owner,
      why:
        `bu görevin worktree'si ${rec.owner} ajanına ait ve o ajan CANLI — ikinci ajan ` +
        'aynı branch\'e paralel yazamaz (F-8/H-4b). Devir için açık onay gerekir.',
    };
  }
  return {
    action: 'takeover',
    owner: agentId,
    why: `sahip ${rec.owner} canlı değil${req.allowTakeover ? ' (ya da devir onaylandı)' : ''} — sahiplik ${agentId} ajanına devrediliyor`,
  };
}

module.exports = {
  STORE_VERSION,
  STATES,
  storePath,
  emptyStore,
  loadStore,
  saveStore,
  getProject,
  setProject,
  listProjects,
  getWorktree,
  putWorktree,
  removeWorktree,
  listWorktrees,
  listByState,
  taskIdForBranch,
  taskIdForPath,
  decideOwnership,
};
