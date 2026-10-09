'use strict';

const path = require('node:path');
const fs = require('node:fs');
const instancePaths = require('../../config/instancePaths.cjs');
const agentMemory = require('../../memory/agentMemory.cjs');
const memorySpawnRetrieval = require('../../memory/memorySpawnRetrieval.cjs');
const memoryTaskBlock = require('../../memory/memoryTaskBlock.cjs');
const memoryTargeting = require('../../memory/memoryTargeting.cjs');
const memoryLedgerStore = require('../../memory/memoryUsageLedger.cjs');
const identityBudget = require('../identityBudget.cjs');
const integrationBriefing = require('../../mcp/integrationBriefing.cjs');
const { MAX_SYSTEM_PROMPT_LEN } = require('./commandWhitelist.cjs');
const { withPlainGuard } = require('./identityCarrier.cjs');
const { engineCapability } = require('./registryBridge.cjs');
const { applyArgs, repeatFlagArgs } = require('./spawnArgs.cjs');

const AGENTS_DIR = path.resolve(__dirname, '..');

let memoryLedgerSingleton;

function memoryLedger() {
  if (memoryLedgerSingleton !== undefined) return memoryLedgerSingleton;
  try {
    memoryLedgerSingleton = memoryLedgerStore.createLedger({
      file: path.join(instancePaths.crewpaneHome(), 'memory-usage-ledger.json'),
    });
  } catch {
    memoryLedgerSingleton = null;
  }
  return memoryLedgerSingleton;
}

let spawnMemoryWarm = null;

function setSpawnMemoryWarm(fn) {
  spawnMemoryWarm = typeof fn === 'function' ? fn : null;
}

function spawnRetrieverFor(workspaceRoot) {
  try {
    return memorySpawnRetrieval.createSpawnRetriever({
      workspaceRoot,
      warm: spawnMemoryWarm ? (q) => spawnMemoryWarm({ workspaceRoot, query: q }) : null,
    });
  } catch {
    return null;
  }
}

function memoryWriteDiscipline(dir, shared, isEmpty) {
  const bootstrap = isEmpty
    ? ' 🌱 HAFIZAN ŞU AN BOŞ (bu workspace\'te ilk kez çalışıyorsun): hafıza ancak İLK kayıtla ' +
      'başlar — bu işin sonunda EN AZ BİR kalıcı gerçek yaz (rolün/kimliğin, kullanıcının ' +
      'tercihleri, bu workspace\'in yapısı/komutları gibi bir sonraki oturumda seni hızlandıracak bir şey).'
    : '';
  return (
    `Çalışırken GELECEKTE faydalı + kalıcı olan şeyleri kendi hafıza dizinine ("${dir}") YAZ: ` +
    'tek-gerçek-tek-dosya + frontmatter (ZORUNLU alanlar: `name` (dosya adıyla aynı slug), ' +
    '`description` (tek satır özet), `metadata.type` (project|feedback|reference|user); ' +
    'istersen `updatedAt`) + [[link]]. İNDEKSE (MEMORY.md) ELLE SATIR EKLEME: ' +
    '`description` alanından otomatik türetiliyor. Disiplin: HER oturumu değil yalnız gelecekte-faydalıyı yaz; iş/oturum ' +
    'sonunda kısa reflection; bir işi "bitti" işaretle ancak uçtan-uca DOĞRULANDIYSA (kod ' +
    `yazıldığında değil); kod/git'te zaten olanı yazma; takım geneli bir bilgiyse "${shared}"'e yaz.` +
    ' İŞ SONU RİTÜELİ (ZORUNLU, her görevin son adımı): "bundan kalıcı olarak ne öğrendim?" ' +
    'diye sor ve varsa hafızana YAZ; yazacak kalıcı bir şey yoksa cevabında tek satırla ' +
    '"hafızaya yazılacak yeni bilgi yok" de — sessizce atlama.' +
    bootstrap
  );
}

function runnableCli(basename) {
  try {
    const local = path.join(AGENTS_DIR, basename);
    if (!local.includes(`app.asar${path.sep}`)) return fs.existsSync(local) ? local : null;
    const unpacked = local.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
    return fs.existsSync(unpacked) ? unpacked : null;
  } catch {
    return null;
  }
}

function runnableRecallCli() {
  return runnableCli('memoryRecallCli.cjs');
}

function runnableEngineMemorySearchCli() {
  return runnableCli('engineMemorySearchCli.cjs');
}

function focusedRecallCue({ dir, shared, global, agentId, opts, workspaceRoot }) {
  const paths =
    `"${path.join(dir, agentMemory.INDEX_FILE)}" (senin) · ` +
    `"${path.join(shared, agentMemory.INDEX_FILE)}" (takım) · ` +
    `"${path.join(global, agentMemory.INDEX_FILE)}" (global)`;
  const tail =
    'Geçmiş işini, kararları ve tercihleri hatırla; kaldığın yerden devam et; aynı şeyleri ' +
    'tekrar tekrar sorma/açıklatma. Bir dosya/flag/isim geçen hafıza ESKİMİŞ olabilir — ona ' +
    'göre davranmadan önce DOĞRULA. ';
  const fallback = `Göreve/sohbete başlamadan ÖNCE şu MEMORY.md index dosyalarını OKU (sonra ilgili konu dosyalarını): ${paths}. ${tail}`;
  try {
    const core = memoryTaskBlock.spawnCore({
      workspaceRoot,
      agentId,
      cliPath: runnableRecallCli(),
      ledger: memoryLedger(),
    });
    if (!core.text) return fallback;
    return `${core.text}\n${tail}`;
  } catch {
    return fallback;
  }
}

function memoryLog(log, line) {
  try {
    if (typeof log === 'function') log(`[memory] ${line}`);
  } catch {
    /* log hatası spawn'ı ASLA etkilemez */
  }
}

function memorySpawnBlock(opts, workspaceRoot, log) {
  try {
    const agentId = opts && typeof opts.agentId === 'string' ? opts.agentId.trim() : '';
    if (!agentId) {
      memoryLog(log, 'atlandı: bu pane bir AJAN kimliğine bağlı değil (agentId yok) → hafıza yazmaz');
      return '';
    }
    const dir = agentMemory.agentMemoryDir(workspaceRoot, agentId);
    if (!dir) {
      memoryLog(log, `atlandı: çalışma alanı (workspaceRoot) seçilmemiş → "${agentId}" hafıza yazamaz`);
      return '';
    }
    const health = agentMemory.checkMemoryWritable(workspaceRoot);
    if (!health.ok) memoryLog(log, `YAZILAMIYOR (${health.reason}): ${health.root} — ${health.detail || 'sebep yok'}`);
    const shared = agentMemory.sharedMemoryDir(workspaceRoot);
    const global = agentMemory.globalMemoryDir();

    try {
      const t0 = Date.now();
      const derived = agentMemory.deriveAllIndexes(
        { workspaceRoot, accountRoot: path.dirname(global) },
        { write: true },
      );
      const t = Date.now() - t0;
      if (derived.totals.wrote) {
        memoryLog(
          log,
          `indeks türetildi: ${derived.totals.wrote} kapsam yazıldı ` +
            `(+${derived.totals.added} pointer, -${derived.totals.removed} kırık, ${t} ms)`,
        );
      }
    } catch (err) {
      memoryLog(log, `indeks türetimi atlandı: ${(err && err.message) || err}`);
    }

    const hasMemory =
      agentMemory.readIndex(dir).trim() ||
      (shared && agentMemory.readIndex(shared).trim()) ||
      agentMemory.readIndex(global).trim();
    const recall = hasMemory ? focusedRecallCue({ dir, shared, global, agentId, opts, workspaceRoot }) : '';
    if (!hasMemory) memoryLog(log, `bootstrap: "${agentId}" hafızası BOŞ → ilk-kayıt talimatı enjekte edildi (${dir})`);

    return `📓 KALICI HAFIZAN VAR (kimlik: ${agentMemory.safeSlug(agentId)}). ${recall}${memoryWriteDiscipline(dir, shared, !hasMemory)}`;
  } catch {
    return '';
  }
}

const SPAWN_MEMORY_BUDGET_CHARS = identityBudget.SPAWN_MEMORY_BUDGET_CHARS;

function memoryBudgetChars(opts) {
  const v = Number(opts && opts.memoryBudgetChars);
  return Number.isFinite(v) && v > 0 ? v : SPAWN_MEMORY_BUDGET_CHARS;
}

function fitMemoryBlock(block, fixedLen, opts, log, cap = MAX_SYSTEM_PROMPT_LEN) {
  if (!block) return '';
  const allowance = memoryTargeting.memoryAllowance(cap, fixedLen, memoryBudgetChars(opts));
  const fitted = memoryTargeting.clampMemoryBlock(block, allowance);
  if (!fitted) {
    memoryLog(log, `blok DÜŞTÜ: kimlik+protokol ${fixedLen} ch, tavan ${cap} → hafızaya yer kalmadı`);
    return '';
  }
  if (fitted.length < block.length) {
    memoryLog(log, `blok kırpıldı: ${block.length} → ${fitted.length} ch (kimlik+protokol ${fixedLen} ch KORUNDU)`);
  }
  return fitted;
}

function withRecalledMemory(systemPrompt, opts, workspaceRoot, log) {
  try {
    const block = memorySpawnBlock(opts, workspaceRoot, log);
    if (!block) return systemPrompt;
    const base = typeof systemPrompt === 'string' ? systemPrompt.trim() : '';
    if (!base) return block;
    const fitted = fitMemoryBlock(block, base.length, opts, log);
    return fitted ? `${fitted}\n\n${base}` : base;
  } catch {
    return systemPrompt;
  }
}

function composeSpawnIdentity({
  systemPrompt,
  opts,
  workspaceRoot,
  log,
  engine,
  cap = MAX_SYSTEM_PROMPT_LEN,
  contextBlock = '',
  contextCap = null,
}) {
  const wrap = (core) =>
    withPlainGuard(integrationBriefing.withIntegrationProtocol(core, { engine }), opts, engine);
  const base = typeof systemPrompt === 'string' ? systemPrompt.trim() : '';
  const block = memorySpawnBlock(opts, workspaceRoot, log);
  const bare = wrap(base);
  const reserved = bare.length + (block ? memoryBudgetChars(opts) : 0);
  const ctxCap = Number.isFinite(contextCap) && contextCap > 0 ? contextCap : cap;
  const ctx =
    typeof contextBlock === 'function'
      ? `${contextBlock(ctxCap - reserved) || ''}`.trim()
      : `${contextBlock || ''}`.trim();
  const withCtx = (identityText) => (ctx ? `${ctx}\n\n${identityText}` : identityText);
  if (!block) return wrap(withCtx(base));
  if (!base) return wrap(withCtx(block));
  const fixed = wrap(withCtx(base));
  const fitted = fitMemoryBlock(block, fixed.length, opts, log, cap);
  return fitted ? wrap(`${fitted}\n\n${withCtx(base)}`) : fixed;
}

function resumeMemoryPrompt(opts, workspaceRoot) {
  try {
    const agentId = opts && typeof opts.agentId === 'string' ? opts.agentId.trim() : '';
    if (!agentId) return null;
    const dir = agentMemory.agentMemoryDir(workspaceRoot, agentId);
    if (!dir) return null;
    const shared = agentMemory.sharedMemoryDir(workspaceRoot);
    const isEmpty = !(
      agentMemory.readIndex(dir).trim() ||
      (shared && agentMemory.readIndex(shared).trim()) ||
      agentMemory.readIndex(agentMemory.globalMemoryDir()).trim()
    );
    return (
      `📓 KALICI HAFIZAN VAR (kimlik: ${agentMemory.safeSlug(agentId)}; bu bir DEVAM oturumu — ` +
      'kimliğin restore edilen konuşmada, kendini TEKRAR TANITMA). ' +
      memoryWriteDiscipline(dir, shared, isEmpty)
    );
  } catch {
    return null;
  }
}

function withMemoryDirs(argv, commandKey, opts, workspaceRoot) {
  const d = engineCapability(commandKey, 'extraRoots');
  if (!d || !d.flag) return argv;
  try {
    const agentId = opts && typeof opts.agentId === 'string' ? opts.agentId.trim() : '';
    if (!agentId) return argv;
    const candidates = [
      agentMemory.agentMemoryDir(workspaceRoot, agentId),
      agentMemory.sharedMemoryDir(workspaceRoot),
      agentMemory.globalMemoryDir(),
    ];
    const seen = new Set();
    const dirs = candidates.filter((d) => {
      if (!d || seen.has(d)) return false;
      seen.add(d);
      try {
        return fs.statSync(d).isDirectory();
      } catch {
        return false;
      }
    });
    return applyArgs(argv, repeatFlagArgs(d.flag, dirs, d.repeat), d.position);
  } catch {
    return argv;
  }
}

module.exports = {
  memoryLedger,
  setSpawnMemoryWarm,
  spawnRetrieverFor,
  memoryWriteDiscipline,
  runnableRecallCli,
  runnableEngineMemorySearchCli,
  runnableCli,
  focusedRecallCue,
  memoryLog,
  memorySpawnBlock,
  SPAWN_MEMORY_BUDGET_CHARS,
  memoryBudgetChars,
  fitMemoryBlock,
  withRecalledMemory,
  composeSpawnIdentity,
  resumeMemoryPrompt,
  withMemoryDirs,
};
