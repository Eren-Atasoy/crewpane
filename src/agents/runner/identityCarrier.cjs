'use strict';

const path = require('node:path');
const fs = require('node:fs');
const systemPromptCap = require('../../../platform/systemPromptCap.cjs');
const instancePaths = require('../../config/instancePaths.cjs');
const spawnPromptFile = require('../spawnPromptFile.cjs');
const engineBasePrompt = require('../engineBasePrompt.cjs');
const taskClaim = require('../taskClaim.cjs');
const identityBudget = require('../identityBudget.cjs');
const { winSafeAtomicWrite } = require('./atomicFs.cjs');
const { engineCapability, getEngineRegistry } = require('./registryBridge.cjs');
const { sanitizeSystemPrompt, MAX_SYSTEM_PROMPT_LEN } = require('./commandWhitelist.cjs');
const { applyArgs } = require('./spawnArgs.cjs');
const { isLeaderSpawn } = require('./leaderDetector.cjs');

function warnIdentityClamp(text, commandKey, promptSink, log) {
  if (typeof log !== 'function' || typeof text !== 'string') return;
  const carrier = identityCarrier(commandKey, promptSink);
  const cap = systemPromptCap.systemPromptCap(carrier);
  if (text.length <= cap) return;
  log(
    `spawn kimliği KIRPILDI (${commandKey}): ${text.length} ch > ${carrier} tavanı ${cap} → ` +
      `kuyruktan ${text.length - cap} ch kesiliyor (kimlik mührü/son bölümler risk altında)`,
  );
}

function withIdentity(argv, commandKey, systemPrompt, promptSink, platform = process.platform, cwd = null) {
  const d = engineCapability(commandKey, 'identity');
  if (!d) return argv;
  const hasSink = identityUsesFileCarrier(commandKey, promptSink);
  const sys = sanitizeSystemPrompt(systemPrompt, systemPromptCap.systemPromptCap(hasSink ? 'file' : 'cli'));
  if (!sys) return argv;
  const useFile =
    hasSink &&
    (!identityFileCarrierIsOverflowOnly(platform) || !(d.cap && d.cap.cli) || sys.length > systemPromptCap.CLI_MAX);
  if (d.kind === 'flag' && d.flag) {
    if (useFile) {
      let filePath = null;
      try {
        filePath = promptSink(sys);
      } catch {
        filePath = null;
      }
      if (typeof filePath === 'string' && filePath) {
        return applyArgs(argv, [identityFileFlagName(d), filePath], d.position);
      }
      if (d.cap && d.cap.cli) {
        return applyArgs(argv, [d.flag, systemPromptCap.clampSystemPrompt(sys, MAX_SYSTEM_PROMPT_LEN)], d.position);
      }
      return argv;
    }
    if (!(d.cap && d.cap.cli)) return argv;
    return applyArgs(argv, [d.flag, sys], d.position);
  }
  if (d.kind === 'flag-dir' && d.flag) {
    let dirPath = null;
    try {
      dirPath = typeof promptSink === 'function' ? promptSink(sys) : null;
    } catch {
      dirPath = null;
    }
    if (typeof dirPath !== 'string' || !dirPath) return argv;
    const extra = [];
    if (d.cwdFirst && typeof cwd === 'string' && cwd) extra.push(d.flag, cwd);
    extra.push(d.flag, dirPath);
    return applyArgs(argv, extra, d.position);
  }
  if (d.kind === 'positional') return [...argv, sys];
  return argv;
}

function identityFileCarrierIsOverflowOnly(platform = process.platform) {
  return platform !== 'win32';
}

function identityUsesFileCarrier(commandKey, promptSink) {
  if (typeof promptSink !== 'function') return false;
  const d = engineCapability(commandKey, 'identity');
  if (d && d.kind === 'flag-dir' && d.flag) return true;
  if (!(d && d.kind === 'flag' && d.flag && d.cap && d.cap.file)) return false;
  return !!d.fileFlag || !d.cap.cli;
}

function identityFlagIsFileOnly(commandKey) {
  const d = engineCapability(commandKey, 'identity');
  if (d && d.kind === 'flag-dir' && d.flag) return true;
  return !!(d && d.kind === 'flag' && d.flag && d.cap && d.cap.file && !d.cap.cli);
}

function identityFileFlagName(d) {
  if (d && d.fileFlag) return d.fileFlag;
  if (d && d.flag && d.cap && !d.cap.cli) return d.flag;
  return spawnPromptFile.PROMPT_FILE_FLAG;
}

function identityCarrier(commandKey, promptSink) {
  if (identityUsesEnvFile(commandKey)) return 'file';
  return identityUsesFileCarrier(commandKey, promptSink) ? 'file' : 'cli';
}

function identityUsesEnvFile(commandKey) {
  const d = engineCapability(commandKey, 'identity');
  return !!(d && d.kind === 'env-file' && d.env && d.fileSuffix);
}

function identityEnvDirRoot(homedir) {
  return path.join(instancePaths.crewpaneHome(homedir), 'engine-identity');
}

function identityPaneKey(opts) {
  return String((opts && (opts.agentId || opts.paneId)) || 'pane').replace(/[^A-Za-z0-9_.-]/g, '_') || 'pane';
}

function withIdentityFrontmatter(commandKey, d, text, opts) {
  const fields = Array.isArray(d.frontmatterFields) ? d.frontmatterFields : null;
  if (!fields || !fields.length) return text;
  const scalar = (v) => JSON.stringify(String(v).replace(/[\r\n]+/g, ' ').trim());
  const lines = ['---'];
  const paneKey = identityPaneKey(opts);
  if (fields.includes('name')) lines.push(`name: ${scalar(`crewpane-${paneKey}`)}`);
  if (fields.includes('description')) lines.push(`description: ${scalar('CrewPane pane identity')}`);
  const block = engineCapability(commandKey, 'subagentBlock');
  const wantsBlock = !!(opts && opts.disallowSubagent === true) || isLeaderSpawn(opts);
  if (
    wantsBlock &&
    block &&
    block.via === 'identity-frontmatter' &&
    typeof block.configPath === 'string' &&
    fields.includes(block.configPath) &&
    Array.isArray(block.value) &&
    block.value.length
  ) {
    lines.push(`${block.configPath}:`);
    for (const tool of block.value) lines.push(`  - ${scalar(tool)}`);
  }
  lines.push('---', '');
  return `${lines.join('\n')}\n${text}`;
}

function writeIdentityFile(commandKey, d, text, opts, homedir, log) {
  const paneKey = identityPaneKey(opts);
  const suffix = d.fileSuffix || '.md';
  try {
    const dir = path.join(identityEnvDirRoot(homedir), paneKey);
    fs.mkdirSync(dir, { recursive: true });
    try {
      for (const name of fs.readdirSync(dir)) {
        if (name.endsWith(suffix)) fs.unlinkSync(path.join(dir, name));
      }
    } catch {
      /* temizlik garanti değil */
    }
    const file = path.join(dir, d.fileName || `crewpane${suffix}`);
    winSafeAtomicWrite(file, text, { log: typeof log === 'function' ? log : null });
    if (typeof log === 'function') log(`spawn kimliği DOSYA-BAYRAĞINDAN: ${file} (${text.length} karakter, ${commandKey})`);
    return file;
  } catch (err) {
    if (typeof log === 'function') {
      log(`spawn kimliği YAZILAMADI (${commandKey}/${d.flag}): ${err && err.message} → pane KİMLİKSİZ koşuyor`);
    }
    return null;
  }
}

function identityFileFlagSink(commandKey, opts, homedir, log) {
  if (!identityFlagIsFileOnly(commandKey)) return null;
  const d = engineCapability(commandKey, 'identity');
  return (text) => {
    let finalText = text;
    if (d.replacesSystemPrompt === true) {
      const composed = engineBasePrompt.composeIdentityWithBase(commandKey, text, { homedir, log });
      if (!composed) return null;
      if (composed === text && typeof log === 'function') {
        log(
          `spawn kimliği UYARISI (${commandKey}): taşıyıcı motorun gömülü sistem prompt'unu SİLİYOR ` +
            `(identity.replacesSystemPrompt) ve taban geri kazanma reçetesi ` +
            `('${(d.basePrompt && d.basePrompt.kind) || 'YOK'}') henüz UYGULANMADI → pane kimlikli ama motorun kendi kuralları OLMADAN koşar`,
        );
      }
      finalText = composed;
    }
    const written = writeIdentityFile(commandKey, d, withIdentityFrontmatter(commandKey, d, finalText, opts), opts, homedir, log);
    if (written && d.kind === 'flag-dir') return path.dirname(written);
    return written;
  };
}

function parseEnvConfigDoc(existingJson, envName, who, log) {
  let doc = {};
  if (existingJson) {
    try {
      const parsed = JSON.parse(existingJson);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) doc = parsed;
      else if (typeof log === 'function') log(`${who}: ${envName} JSON NESNE değil → kullanıcı değeri yok sayıldı`);
    } catch {
      if (typeof log === 'function') log(`${who}: ${envName} ayrıştırılamadı (bozuk JSON) → kullanıcı değeri yok sayıldı`);
    }
  }
  return doc;
}

function mergeIdentityConfigDoc(existingJson, d, identityFile, log) {
  const doc = parseEnvConfigDoc(existingJson, d.env, 'spawn kimliği', log);
  const base = d.configBase && typeof d.configBase === 'object' ? d.configBase : {};
  for (const [k, v] of Object.entries(base)) {
    doc[k] = v && typeof v === 'object' && !Array.isArray(v) && doc[k] && typeof doc[k] === 'object' && !Array.isArray(doc[k])
      ? { ...doc[k], ...v }
      : v;
  }
  const spec = typeof d.configPath === 'string' ? d.configPath : '';
  if (spec.endsWith('[]')) {
    const key = spec.slice(0, -2);
    const arr = Array.isArray(doc[key]) ? doc[key].filter((x) => typeof x === 'string' && x !== identityFile) : [];
    arr.push(identityFile);
    doc[key] = arr;
  } else if (spec) {
    const segs = spec.split('.');
    let cur = doc;
    for (const seg of segs.slice(0, -1)) {
      if (!cur[seg] || typeof cur[seg] !== 'object' || Array.isArray(cur[seg])) cur[seg] = {};
      cur = cur[seg];
    }
    cur[segs[segs.length - 1]] = identityFile;
  } else if (typeof log === 'function') {
    log(`spawn kimliği: ${d.env} için configPath BEYAN EDİLMEMİŞ → belge KİMLİKSİZ kuruldu`);
  }
  return doc;
}

function applyPaneIsolationEnv(childEnv, commandKey, opts, homedir, log, liveFiles) {
  const reg = getEngineRegistry();
  const d = reg && reg.getEngine ? reg.getEngine(commandKey) : null;
  const iso = d && d.isolation ? d.isolation : null;
  if (!iso || !iso.env || !iso.fileName) return null;
  if (typeof childEnv[iso.env] === 'string' && childEnv[iso.env].trim()) return null;
  const verdict = isolationTwinVerdict(iso, commandKey, opts, homedir, liveFiles);
  try {
    fs.mkdirSync(path.dirname(verdict.file), { recursive: true });
    const target = verdict.file;
    childEnv[iso.env] = target;
    if (typeof log === 'function') {
      log(`pane izolasyonu (${commandKey}): ${iso.env}=${target}`);
      if (verdict.action === 'separate') {
        log(`pane izolasyonu İKİZ (${commandKey}/${verdict.paneKey}): ${verdict.why} — spawn engellenmedi, kullanıcıya satır basılır`);
      }
    }
    return target;
  } catch (err) {
    if (typeof log === 'function') {
      log(`pane izolasyonu KURULAMADI (${commandKey}/${iso.env}): ${err && err.message} → ortak depo kullanılacak (eşzamanlı pane çakışabilir)`);
    }
    return null;
  }
}

function isolationTwinVerdict(iso, commandKey, opts, homedir, liveFiles) {
  const paneKey = String((opts && (opts.agentId || opts.paneId)) || 'pane').replace(/[^A-Za-z0-9_.-]/g, '_') || 'pane';
  const root = path.join(instancePaths.crewpaneHome(homedir), 'engine-isolation', commandKey);
  return taskClaim.decideIsolationTwin(liveFiles, { root, paneKey, fileName: iso.fileName });
}

function paneIsolationPlan(childEnv, commandKey, opts, homedir, liveFiles) {
  const reg = getEngineRegistry();
  const d = reg && reg.getEngine ? reg.getEngine(commandKey) : null;
  const iso = d && d.isolation ? d.isolation : null;
  if (!iso || !iso.env || !iso.fileName) return null;
  const verdict = isolationTwinVerdict(iso, commandKey, opts, homedir, liveFiles);
  if (!childEnv || childEnv[iso.env] !== verdict.file) return null;
  return { env: iso.env, file: verdict.file, separated: verdict.action === 'separate', twinOf: verdict.twinOf };
}

function applyIdentityEnvFile(childEnv, commandKey, identityText, opts, homedir, log) {
  const d = engineCapability(commandKey, 'identity');
  if (!identityUsesEnvFile(commandKey)) return null;
  const capped = sanitizeSystemPrompt(identityText, systemPromptCap.systemPromptCap('file'));
  if (!capped) return null;
  const text = engineBasePrompt.composeIdentityWithBase(commandKey, capped, {
    cwd: opts && opts.cwd,
    env: childEnv,
    homedir,
    log,
  });
  if (!text) {
    if (typeof log === 'function') {
      log(`spawn kimliği YAZILMADI (${commandKey}/${d.env}): taban prompt geri kazanılamadı → pane KİMLİKSİZ ama motorun kendi prompt'u BOZULMADAN koşuyor`);
    }
    return null;
  }
  const paneKey = String((opts && (opts.agentId || opts.paneId)) || 'pane').replace(/[^A-Za-z0-9_.-]/g, '_') || 'pane';
  try {
    const dir = path.join(identityEnvDirRoot(homedir), paneKey);
    fs.mkdirSync(dir, { recursive: true });
    try {
      for (const name of fs.readdirSync(dir)) {
        if (name.endsWith(d.fileSuffix)) fs.unlinkSync(path.join(dir, name));
      }
    } catch {
      /* temizlik garanti değil */
    }
    const file = path.join(dir, d.fileName || `crewpane${d.fileSuffix}`);
    winSafeAtomicWrite(file, text, { log: typeof log === 'function' ? log : null });
    const existing = typeof childEnv[d.env] === 'string' ? childEnv[d.env].trim() : '';
    if (d.envTarget === 'json-config') {
      const doc = mergeIdentityConfigDoc(existing, d, file, log);
      childEnv[d.env] = JSON.stringify(doc);
      if (typeof log === 'function') log(`spawn kimliği ENV-CONFIG'ten: ${file} (${text.length} karakter, ${d.env}.${d.configPath})`);
      return file;
    }
    if (d.envTarget === 'file') {
      if (existing && existing !== file && typeof log === 'function') {
        log(`spawn kimliği: ${d.env} kullanıcı değeri EZİLDİ (tek-dosya taşıyıcısı, birleştirilemez): ${existing}`);
      }
      childEnv[d.env] = file;
    } else {
      const sep = d.envSeparator || ',';
      childEnv[d.env] = existing ? `${existing}${sep}${dir}` : dir;
    }
    if (typeof log === 'function') log(`spawn kimliği ENV-DOSYADAN: ${file} (${text.length} karakter, ${d.env})`);
    return file;
  } catch (err) {
    if (typeof log === 'function') {
      log(`spawn kimliği YAZILAMADI (${commandKey}/${d.env}): ${err && err.message} → pane KİMLİKSİZ koşuyor`);
    }
    return null;
  }
}

function supportsResumeReinject(commandKey) {
  const d = engineCapability(commandKey, 'identity');
  return !!(d && d.resumeReinject === true);
}

const PLAIN_OFFICE_GUARD = identityBudget.PLAIN_OFFICE_GUARD;
const CLEAN_PANE_GUARD = identityBudget.CLEAN_PANE_GUARD;

function withPlainGuard(systemPrompt, opts, engine) {
  const base = typeof systemPrompt === 'string' ? systemPrompt.trim() : '';
  if (opts && opts.plain === true) {
    return base ? `${PLAIN_OFFICE_GUARD}\n\n${base}` : PLAIN_OFFICE_GUARD;
  }
  if (!isIdentitylessSpawn(opts) || !identityCarrierIsSilent(engine)) return systemPrompt;
  return base ? `${CLEAN_PANE_GUARD}\n\n${base}` : CLEAN_PANE_GUARD;
}

function isIdentitylessSpawn(opts) {
  if (!opts) return true;
  if (typeof opts.systemPrompt === 'string' && opts.systemPrompt.trim() !== '') return false;
  return !opts.agentId && !opts.role;
}

function identityCarrierIsSilent(commandKey) {
  const d = engineCapability(commandKey, 'identity');
  return !!(d && d.kind && d.kind !== 'positional');
}

module.exports = {
  warnIdentityClamp,
  withIdentity,
  identityFileCarrierIsOverflowOnly,
  identityUsesFileCarrier,
  identityFlagIsFileOnly,
  identityFileFlagName,
  identityCarrier,
  identityUsesEnvFile,
  identityEnvDirRoot,
  identityPaneKey,
  withIdentityFrontmatter,
  writeIdentityFile,
  identityFileFlagSink,
  parseEnvConfigDoc,
  mergeIdentityConfigDoc,
  applyPaneIsolationEnv,
  isolationTwinVerdict,
  paneIsolationPlan,
  applyIdentityEnvFile,
  supportsResumeReinject,
  PLAIN_OFFICE_GUARD,
  CLEAN_PANE_GUARD,
  withPlainGuard,
  isIdentitylessSpawn,
  identityCarrierIsSilent,
};
