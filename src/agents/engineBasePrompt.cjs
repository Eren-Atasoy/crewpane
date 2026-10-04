// ENG-14 (SPRINT-ENGINE-03) — REPLACE TAŞIYICISININ KURTARMA REÇETESİ.
//
// ─────────────────────────────────────────────────────────────────────────────
// SORUN (ölçüldü, gemini 0.55.1)
//
// Bazı motorlarda pane-başına kimliğin TEK taşıyıcısı, motorun gömülü sistem
// prompt'unu EKLEMEYEN, YERİNE GEÇEN bir env'dir:
//
//   gemini: `GEMINI_SYSTEM_MD=<dosya>`  → promptProvider.getCoreSystemPrompt:
//           `basePrompt = fs.readFileSync(systemMdPath, 'utf8')`   ← REPLACE
//
// claude'daki `--append-system-prompt` DENGİ YOKTUR (yargs seçenek listesi
// ikiliden çıkarıldı: 38 seçenek, append/system-prompt yok). Yani "kimliği ekle"
// isteği, ölçülen hâliyle "motorun beynini sil" anlamına geliyor:
//
//   kimlik-yalnız dosya → efektif prompt 25.073 → 2.126 karakter (%91,6 KAYIP)
//   kaybolanlar: Core Mandates · Security and Safety Rules · Tool Usage ·
//                Primary Workflows · Available Sub-Agents · Available Agent Skills
//
// Bu, ENG-04'ün kapattığı "sessiz yetenek kaybı"nın en pahalı hâlidir: pane
// kimliğini alır, güvenlik kurallarını kaybeder ve HİÇBİR yerde uyarı çıkmaz.
//
// ─────────────────────────────────────────────────────────────────────────────
// ÇÖZÜM — SENTINEL ÇIKARMASI (metin sezgisi YOK, bayt aritmetiği)
//
// 1. Motoru KENDİ efektif prompt'unu yazdırmaya zorla (`basePrompt.dumpEnv`).
//    ÖLÇÜLDÜ: döküm prompt İNŞA edilince yazılır, model çağrısından ÖNCE →
//    kimlik doğrulaması bilerek düşürülünce (`neutralizeEnv`) istek modele HİÇ
//    ulaşmaz. JETON MALİYETİ SIFIR (exit 1, döküm YAZILDI, iki koşu bayt-bayt aynı).
//
// 2. 🪤 HAM DÖKÜMÜ GERİ BESLEME. Döküm NİHAİ prompt'tur: CLI'ın canlı eklediği
//    KUYRUĞU (GEMINI.md bağlamı + hook bölümleri) da içerir. Geri beslenirse o
//    kuyruk İKİ KEZ basılır ve donmuş kopya BAYATLAR (ölçüldü: "# Contextual
//    Instructions" 2 kez, 25.087 → 27.192 karakter).
//    Kuyruğu ÖLÇEREK çıkarırız: bilinen bir SENTINEL dosyayla ikinci bir döküm
//    alınır → çıktı = sentinel + KUYRUK. Kuyruk = çıktı − sentinel (bayt).
//    TABAN = tam döküm − kuyruk (suffix çıkarma). Hiçbir başlık/regex tahmini yok.
//
// 3. Kimlik TABANIN SONUNA eklenir → motor hem kim olduğunu bilir hem kurallarını
//    korur (canlı doğrulandı: kod kelimesi cevapta, "# Core Mandates" TEK kez,
//    ajan aynı turda dosyayı ARACIYLA okudu).
//
// ─────────────────────────────────────────────────────────────────────────────
// FAIL-CLOSED (`basePrompt.onFailure: 'skip-identity'`)
//
// Reçete düşerse kimlik YAZILMAZ. Kimliksiz ama TAM yetenekli bir pane, kimlikli
// ama güvenlik kurallarını kaybetmiş bir pane'den iyidir — ve hangi ihtimalde
// olduğumuz log'a düşer, sessiz kalmaz.
//
// ⚠️ MOTOR ADI GEÇMEZ. Bu dosyada tek bir `if (engine === 'gemini')` yoktur:
// davranışın tamamı descriptor'ın `identity.basePrompt` beyanından gelir
// (feedback_no_hardcoded_brand_cases). Aynı beyanı yazan her motor aynı yolu koşar.

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const instancePaths = require('../config/instancePaths.cjs');
const engineRegistry = require('./engineRegistry.cjs');

/** Sentinel: ölçülebilir, benzersiz, İKAME İÇERMEYEN metin (`${…}` yok — motor
 *  dosyayı `applySubstitutions`tan geçirir; ikame içeren bir sentinel çıkarmayı
 *  bozardı). Tek satır yeter: kuyruk onun ARKASINDA başlar. */
// 🪤 SONDA YENİ SATIR YOK — bilerek. ÖLÇÜLDÜ: gemini nihai prompt'u yazmadan önce
// boşlukları normalize ediyor (`sanitizedPrompt.replace(/\n{3,}/g, '\n\n')` + kırpma),
// yani sentinel'in sonuna koyduğumuz '\n' DÖKÜMDE YOK. Newline'lı bir sentinel
// `startsWith` kapısını HER ZAMAN düşürür ve reçete sessizce "geçersiz" derdi
// (bu kanıt scriptinde bir kez GERÇEKTEN düştü — bkz. ENG-14 raporu §hata).
const SENTINEL = 'CREWPANE-BASE-PROMPT-SENTINEL-8F3A2C';

/** Dökümlerin saklandığı kök (pane kimlik dizinlerinin KOMŞUSU, içi değil). */
function cacheRoot(homedir) {
  return path.join(instancePaths.crewpaneHome(homedir || os.homedir()), 'engine-base-prompt');
}

/** Reçetesi UYGULANMIŞ olan taban-prompt şekilleri. Beyanı olan ama burada olmayan
 *  bir `kind` (yeni motor) sessizce "gerek yok" sayılmaz: `composeIdentityWithBase`
 *  metni AYNEN döndürür ve çağıran (agentRunner) bunu LOG'a yazar. */
const SUPPORTED_KINDS = Object.freeze(['self-dump', 'ledger-dump']);

/** Bu motorun taşıyıcısı gömülü prompt'u SİLİYOR mu (ve reçetesi var mı)? */
function needsBasePrompt(engineId, registry) {
  const reg = registry || engineRegistry;
  const d = reg.capability ? reg.capability(engineId, 'identity') : null;
  return !!(d && d.replacesSystemPrompt === true && d.basePrompt && SUPPORTED_KINDS.includes(d.basePrompt.kind));
}

/** Motorun sürüm dizesi (cache anahtarının bir parçası). Ölçülemezse `'?'`. */
function engineVersion(file, opts) {
  const run = (opts && opts.exec) || spawnSync;
  try {
    const r = run(file, ['--version'], { encoding: 'utf8', timeout: 20000, env: (opts && opts.env) || process.env });
    const out = `${(r && r.stdout) || ''}`.trim();
    return out ? out.split('\n')[0].trim().slice(0, 40) : '?';
  } catch {
    return '?';
  }
}

/**
 * Tek bir döküm koşusu. Dönen: dosyanın İÇERİĞİ ya da `null`.
 * `extraEnv` ile sentinel enjekte edilir; `neutralizeEnv` her koşuda uygulanır
 * (kimlik doğrulaması BİLEREK düşürülür → model turu yok).
 */
function runDump(file, bp, cwd, env, outFile, opts) {
  const run = (opts && opts.exec) || spawnSync;
  try {
    fs.rmSync(outFile, { force: true });
  } catch {
    /* yoksa sorun değil */
  }
  const childEnv = { ...env };
  // Kullanıcının/pane'in kendi kimlik dosyası prob koşusuna SIZMAMALI: taban
  // ölçümü motorun GÖMÜLÜ prompt'unu ölçer, bir öncekini değil.
  delete childEnv[bp.readEnv];
  Object.assign(childEnv, bp.neutralizeEnv || {}, (opts && opts.extraEnv) || {});
  childEnv[bp.dumpEnv] = outFile;
  try {
    run(file, [...bp.probeArgv], {
      cwd,
      env: childEnv,
      encoding: 'utf8',
      timeout: bp.timeoutMs || 90000,
      input: '',
      // stdin'i kapalı tut: prob İNTERAKTİF bir kapıya takılırsa ASILMASIN.
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch {
    /* koşu hatası dökümü engellemeyebilir — dosyaya bakılır */
  }
  try {
    const text = fs.readFileSync(outFile, 'utf8');
    return text && text.length ? text : null;
  } catch {
    return null;
  }
}

/**
 * Motorun GÖMÜLÜ sistem prompt'unu (canlı kuyruk HARİÇ) çöz.
 *
 * @returns {{ text: string, source: 'cache'|'probe', bytes: number } | null}
 *   `null` = reçete koşamadı (çağıran FAIL-CLOSED davranır).
 */
/**
 * ENG-ENABLE-01 — İKİNCİ REÇETE: `ledger-dump` (kimi sınıfı).
 *
 * gemini'nin `self-dump`ından farkı, motorun efektif sistem prompt'unu bir ENV ile
 * DOSYAYA YAZDIRMAMASI; onu HER koşuda kendi OTURUM DEFTERİNE yazmasıdır
 * (`<home>/sessions/<wd>/<session>/agents/main/wire.jsonl` → `{"type":"profile.bind",
 * "systemPrompt":"…"}`). Kayıt MODEL ÇAĞRISINDAN ÖNCE yazılır ⇒ prob, sağlayıcı
 * duvarına ÇARPARAK biter ve JETON MALİYETİ SIFIRDIR.
 *
 * ÖLÇÜLDÜ (kimi 0.36.1, 2026-09-09 — ENG-ENABLE-01-evidence/kimi-baseprompt.txt):
 *   • ULAŞILAMAZ bir sağlayıcı yazan config ile prob → defter YAZILDI, 21.003
 *     karakterlik gömülü prompt tam olarak oradan çıktı. Ağ trafiği YOK
 *     (127.0.0.1'deki kapalı porta gider).
 *   • 🪤 `default_model` TOML'da TABLOLARDAN ÖNCE gelmeli: dosyanın SONUNA eklenen
 *     satır son `[models."…"]` tablosunun İÇİNE düşer ve motor "No model configured"
 *     der (ilk denemede tam olarak bu oldu) → şablon tek parça yazılır, eklenmez.
 *   • Kuyruk çıkarma (sentinel) GEREKMEZ: prob kimlik dosyası VERMEDİĞİ için defterdeki
 *     metin motorun TAM ve SAF gömülü prompt'udur (`self-dump`ta döküm CANLI kuyruğu
 *     da içeriyordu, orada çıkarma zorunluydu).
 *
 * Dönen: taban metin ya da `null` (çağıran FAIL-CLOSED davranır).
 */
function resolveLedgerBasePrompt(engineId, bp, file, cwd, env, opts) {
  const run = (opts && opts.exec) || spawnSync;
  const log = typeof opts.log === 'function' ? opts.log : null;
  const root = cacheRoot(opts.homedir);
  let probeHome;
  try {
    fs.mkdirSync(root, { recursive: true });
    probeHome = fs.mkdtempSync(path.join(root, '.ledger-'));
  } catch (err) {
    if (log) log(`taban prompt: prob evi açılamadı (${engineId}): ${err && err.message}`);
    return null;
  }
  try {
    const cfg = bp.probeConfig;
    if (cfg && cfg.file && typeof cfg.template === 'string') {
      fs.writeFileSync(path.join(probeHome, cfg.file), cfg.template, { mode: 0o600 });
    }
    const childEnv = { ...env, [bp.homeEnv]: probeHome };
    try {
      run(file, [...(bp.probeArgv || [])], {
        cwd,
        env: childEnv,
        encoding: 'utf8',
        timeout: bp.timeoutMs || 45000,
        input: '',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch {
      /* koşu hatası defteri engellemez — dosyaya bakılır (reçetenin TAMAMI budur) */
    }
    const ledgers = globUnder(probeHome, String(bp.ledgerGlob || '').split('/'));
    if (!ledgers.length) {
      if (log) log(`taban prompt ÖLÇÜLEMEDİ (${engineId}): oturum defteri YAZILMADI (${bp.ledgerGlob})`);
      return null;
    }
    let best = '';
    for (const ledger of ledgers) {
      let text = '';
      try {
        text = fs.readFileSync(ledger, 'utf8');
      } catch {
        continue;
      }
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        let rec = null;
        try {
          rec = JSON.parse(line);
        } catch {
          continue;
        }
        if (!rec || rec.type !== bp.recordType) continue;
        const val = rec[bp.field];
        if (typeof val === 'string' && val.length > best.length) best = val;
      }
    }
    if (!best) {
      if (log) log(`taban prompt ÖLÇÜLEMEDİ (${engineId}): defterde "${bp.recordType}.${bp.field}" kaydı yok`);
      return null;
    }
    return best.replace(/\s+$/, '');
  } finally {
    try {
      fs.rmSync(probeHome, { recursive: true, force: true });
    } catch {
      /* temizlik garanti değil */
    }
  }
}

/** `segments` (ör. ['sessions','*','session_*','agents','main','wire.jsonl']) altındaki
 *  eşleşen dosyaların TAM yollarını döner. Dış bağımlılık yok; `*` yalnız AD içinde. */
function globUnder(root, segments) {
  if (!segments.length) return [];
  let current = [root];
  for (let i = 0; i < segments.length; i += 1) {
    const seg = segments[i];
    const last = i === segments.length - 1;
    const next = [];
    const rx = new RegExp(`^${seg.split('*').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
    for (const dir of current) {
      let names = [];
      try {
        names = fs.readdirSync(dir);
      } catch {
        continue;
      }
      for (const name of names) {
        if (!rx.test(name)) continue;
        const full = path.join(dir, name);
        try {
          const st = fs.statSync(full);
          if (last ? st.isFile() : st.isDirectory()) next.push(full);
        } catch {
          /* yarış: dosya silinmiş olabilir */
        }
      }
    }
    current = next;
    if (!current.length) return [];
  }
  return current;
}

function resolveBasePrompt(engineId, opts = {}) {
  const registry = opts.registry || engineRegistry;
  if (!needsBasePrompt(engineId, registry)) return null;
  const d = registry.capability(engineId, 'identity');
  const bp = d.basePrompt;
  const descriptor = registry.getEngine(engineId);
  const file = opts.file || (descriptor && descriptor.bin) || engineId;
  const cwd = opts.cwd && fs.existsSync(opts.cwd) ? opts.cwd : os.homedir();
  const env = opts.env || process.env;
  const log = typeof opts.log === 'function' ? opts.log : null;

  // ── Önbellek anahtarı: beyan edilen boyutlar (`cacheBy`) ────────────────────
  const parts = [engineId];
  const by = Array.isArray(bp.cacheBy) ? bp.cacheBy : [];
  if (by.includes('version')) parts.push(engineVersion(file, { exec: opts.exec, env }));
  if (by.includes('cwd')) parts.push(cwd);
  const key = crypto.createHash('sha256').update(parts.join(' ')).digest('hex').slice(0, 16);
  const root = cacheRoot(opts.homedir);
  const cacheFile = path.join(root, `${engineId}-${key}.md`);

  if (!opts.noCache) {
    try {
      const cached = fs.readFileSync(cacheFile, 'utf8');
      if (cached && cached.length) return { text: cached, source: 'cache', bytes: cached.length };
    } catch {
      /* önbellek yok → ölç */
    }
  }

  // ── ledger-dump: defterden oku, kuyruk çıkarma YOK (yukarıdaki gerekçe) ─────
  if (bp.kind === 'ledger-dump') {
    const base = resolveLedgerBasePrompt(engineId, bp, file, cwd, env, opts);
    if (!base) return null;
    try {
      fs.mkdirSync(root, { recursive: true });
      const tmp = `${cacheFile}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
      fs.writeFileSync(tmp, base, { mode: 0o600 });
      fs.renameSync(tmp, cacheFile);
    } catch {
      /* önbellek yazılamazsa yalnız yavaşlarız — davranış değişmez */
    }
    if (log) log(`taban prompt ÖLÇÜLDÜ (${engineId}): ${base.length} karakter (oturum defterinden, jeton maliyeti yok)`);
    return { text: base, source: 'probe', bytes: base.length };
  }

  // ── 1) Tam döküm (taban + canlı kuyruk) ────────────────────────────────────
  let tmpDir;
  try {
    fs.mkdirSync(root, { recursive: true });
    tmpDir = fs.mkdtempSync(path.join(root, '.probe-'));
  } catch (err) {
    if (log) log(`taban prompt: geçici dizin açılamadı (${engineId}): ${err && err.message}`);
    return null;
  }
  try {
    const full = runDump(file, bp, cwd, env, path.join(tmpDir, 'full.md'), { exec: opts.exec });
    if (!full) {
      if (log) log(`taban prompt ÖLÇÜLEMEDİ (${engineId}): ${bp.dumpEnv} dökümü YAZILMADI`);
      return null;
    }

    // ── 2) Sentinel koşusu → canlı KUYRUK ────────────────────────────────────
    const sentinelFile = path.join(tmpDir, 'sentinel.md');
    fs.writeFileSync(sentinelFile, SENTINEL, { mode: 0o600 });
    const eff = runDump(file, bp, cwd, env, path.join(tmpDir, 'eff.md'), {
      exec: opts.exec,
      extraEnv: { [bp.readEnv]: sentinelFile },
    });
    if (!eff || !eff.startsWith(SENTINEL)) {
      // Motor sentinel'i beklediğimiz gibi TABANA koymadı → kuyruğu ölçemeyiz.
      // Tahmin etmek yerine dururuz (yanlış taban, sessiz prompt bozulmasıdır).
      if (log) log(`taban prompt ÖLÇÜLEMEDİ (${engineId}): sentinel dökümde ÖNEK değil (reçete bu sürümde geçersiz)`);
      return null;
    }
    const tail = eff.slice(SENTINEL.length);

    // ── 3) TABAN = tam döküm − kuyruk (suffix çıkarma) ───────────────────────
    let base = full;
    if (tail.length) {
      if (!full.endsWith(tail)) {
        if (log) log(`taban prompt ÖLÇÜLEMEDİ (${engineId}): canlı kuyruk dökümün SONU değil (iki koşu ayrıştı)`);
        return null;
      }
      base = full.slice(0, full.length - tail.length);
    }
    base = base.replace(/\s+$/, '');
    if (!base.length) {
      if (log) log(`taban prompt ÖLÇÜLEMEDİ (${engineId}): çıkarmadan sonra taban BOŞ`);
      return null;
    }

    try {
      const tmp = `${cacheFile}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
      fs.writeFileSync(tmp, base, { mode: 0o600 });
      fs.renameSync(tmp, cacheFile);
    } catch {
      /* önbellek yazılamazsa yalnız yavaşlarız — davranış değişmez */
    }
    if (log) log(`taban prompt ÖLÇÜLDÜ (${engineId}): ${base.length} karakter (kuyruk ${tail.length} çıkarıldı, jeton maliyeti yok)`);
    return { text: base, source: 'probe', bytes: base.length };
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* temizlik garanti değil */
    }
  }
}

/**
 * Kimlik dosyasına YAZILACAK nihai metin.
 *   • REPLACE taşıyıcısı DEĞİLSE → kimlik metni aynen (davranış değişmez).
 *   • REPLACE taşıyıcısıysa      → `<taban>\n\n<kimlik>` ya da `null` (fail-closed).
 */
function composeIdentityWithBase(engineId, identityText, opts = {}) {
  const registry = opts.registry || engineRegistry;
  if (!needsBasePrompt(engineId, registry)) return identityText;
  const base = resolveBasePrompt(engineId, opts);
  if (!base) return null; // onFailure: 'skip-identity' — çağıran kimliği YAZMAZ
  return `${base.text}\n\n${identityText}`;
}

module.exports = {
  SENTINEL,
  cacheRoot,
  needsBasePrompt,
  resolveBasePrompt,
  composeIdentityWithBase,
};
