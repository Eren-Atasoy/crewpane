// HATA-12 — AJANIN GÜNCEL MOTORUNUN AYNASI + "MOTOR SÜRÜKLENDİ" HÜKMÜ.
//
// KUSUR (ödeme yapmış müşteri, Discord 02.09 — DISC-TRIAGE-02 §3.1): kullanıcı ekip
// liderinin motorunu claude→codex yaptı. `employees.engine` DEĞİŞTİ (kalıcılık doğru
// çalışıyor) ama uygulamayı yeniden başlatmak da kurtarmadı: `restoreLivePanes`
// defterdeki kaydı `entry.engine` (= pane SPAWN EDİLİRKEN yazılan motor) + `resume:true`
// + eski `sessionId` ile diriltiyordu. Defter, ajanın GÜNCEL motoruyla hiç
// karşılaştırılmıyordu → kullanıcı her açılışta yine claude alıyordu.
//
// NEDEN AYNA (ağ değil): geri yükleme `did-finish-load`'da koşar; renderer'ın Supabase
// sorgusu daha bitmemiştir ve main'in orada senkron bir "employees.engine" okuması yoktur.
// Ağ sorgusu eklemek geri yüklemeyi çevrimdışıyken KIRARDI. Bu yüzden renderer, motor
// haritası her değiştiğinde main'e iter; main onu deftere KOMŞU bir dosyaya yazar
// (`agent-engines.json`, hesap-kapsamlı aynı kök). Restore o dosyayı okur.
//
// AYNA BAYATLAYABİLİR (motor başka bir cihazdan/mobil ofisten değiştirildi): o durumda
// hüküm ÜRETİLMEZ (`engineDrifted(x, null) === false`) ve davranış bugünküyle bit-bit
// aynı kalır. Yani ayna yalnız BİLDİĞİNİ söyler, tahmin etmez.

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const livePaneRegistry = require('./livePaneRegistry.cjs');
const { isRegisteredEngine } = require('./engineRegistry.cjs');

const MIRROR_FILE = 'agent-engines.json';

/** Aynanın mutlak yolu — defterin (live-panes.json) YANINDA, aynı hesap kökünde. */
function mirrorPath(homedir) {
  return path.join(livePaneRegistry.crewpaneDir(homedir), MIRROR_FILE);
}

/** Motor değerini güvenle daralt: yalnız DEFTERDE KAYITLI bir motor kabul edilir. */
function normEngine(value) {
  if (typeof value !== 'string') return null;
  const v = value.trim().toLowerCase();
  if (!v) return null;
  return isRegisteredEngine(v) ? v : null;
}

/**
 * Ajan kimliği kabul edilebilir mi? Ayna bir DOSYA anahtarı değil bir JSON alanıdır,
 * ama yine de dar tutulur: uzunluk + yol ayracı/nokta-kaçışı yok (bir gün dosya adına
 * dönüşürse sürpriz olmasın — ADP-761'in defter anahtarı dersi).
 */
function normAgentId(key) {
  if (typeof key !== 'string') return null;
  const k = key.trim();
  if (!k || k.length > 200) return null;
  if (k.includes('/') || k.includes('\\') || k === '.' || k === '..') return null;
  return k;
}

/** Ham haritayı süz: yalnız {geçerli agentId → KAYITLI motor} çiftleri kalır. */
function sanitize(map) {
  const out = {};
  if (!map || typeof map !== 'object' || Array.isArray(map)) return out;
  for (const [rawKey, rawValue] of Object.entries(map)) {
    const agentId = normAgentId(rawKey);
    const engine = normEngine(rawValue);
    if (agentId && engine) out[agentId] = engine;
  }
  return out;
}

/**
 * Aynayı yaz (atomik: tmp + rename). İDEMPOTENT — aynı haritayla iki kez koşmak
 * diskte aynı sonucu bırakır. Hata çökertmez: ayna EN İYİ ÇABA bir ipucudur, geri
 * yüklemenin ön koşulu değil.
 */
function writeMirror(homedir, map) {
  const clean = sanitize(map);
  try {
    const file = mirrorPath(homedir);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, at: Date.now(), engines: clean }, null, 2), 'utf8');
    fs.renameSync(tmp, file);
    return { ok: true, count: Object.keys(clean).length };
  } catch (e) {
    return { ok: false, count: 0, error: String((e && e.message) || e) };
  }
}

/** Aynayı oku → { agentId: engine }. Dosya yok / bozuk / eski şekil → `{}`. */
function readMirror(homedir) {
  try {
    const raw = JSON.parse(fs.readFileSync(mirrorPath(homedir), 'utf8'));
    return sanitize(raw && raw.engines);
  } catch {
    return {};
  }
}

/**
 * MOTOR SÜRÜKLENDİ Mİ? Hüküm yalnız İKİ TARAF DA BİLİNİYORSA verilir:
 * defterin motoru ile ajanın güncel motoru, ikisi de KAYITLI birer motor ve FARKLI.
 * Biri bilinmiyorsa (ayna o ajanı hiç görmedi, ya da defterde motor yok) hüküm YOKTUR
 * → çağıran bugünkü davranışını sürdürür. Tahmine dayalı bir "düzeltme" yapılmaz.
 */
function engineDrifted(ledgerEngine, currentEngine) {
  const from = normEngine(ledgerEngine);
  const to = normEngine(currentEngine);
  return !!(from && to && from !== to);
}

/**
 * Sürüklenmede respawn opts'unu DÜZELT: pane GÜNCEL motorla ve TEMİZ doğar.
 *
 * 🔑 KRİTİK — düşen alanlar ESKİ MOTORUN OTURUMUNA aittir:
 *   • `sessionId`/`resume` → codex'e claude oturum kimliği geçmek anlamsızdır
 *     (ve `--resume <claude-id>` codex'te sessizce başka bir şeye çözülebilir).
 *   • `model`/`provider`   → ADP-565/595 alanları O MOTORUN bayraklarıdır; yeni
 *     motora geçirmek geçersiz argv üretir. (EmployeeForm motor değişince aynı
 *     hükmü form tarafında zaten veriyor — burada TEKRARLANIR, kopyalanmaz.)
 *   • `screenTail`         → ADP-386 tohumu ESKİ motorun ekranıdır; yeni pane'e
 *     basmak kullanıcıya "hâlâ claude koşuyor" yalanını söylerdi.
 * Kimliğe ait alanlar (agentId, cwd, restoreKey, department, label, role, systemPrompt…)
 * DOKUNULMADAN kalır: pane aynı ajanın pane'idir, yalnız motoru değişmiştir.
 */
function applyEngineDrift(opts, ledgerEngine, currentEngine) {
  if (!engineDrifted(ledgerEngine, currentEngine)) return opts;
  return {
    ...opts,
    command: normEngine(currentEngine),
    sessionId: undefined,
    resume: false,
    model: undefined,
    provider: undefined,
    screenTail: undefined,
  };
}

/**
 * ═══ HATA-12-B — ÜÇ RESTORE YOLU İÇİN **TEK** MOTOR KAYNAĞI ═══════════════════
 *
 * ÖLÇÜLEN KUSUR (DISC-TRIAGE-03 §4.6): HATA-12 sürüklenmeyi kapattı ama yalnız
 * çağıranı `currentEngine`'i ELDEN geçiren yolda (`restoreLivePanes`). Kalan iki
 * çağıran ikinci argümanı hiç vermiyordu:
 *   • `acceptRecoverablePanes` — "kurtarılabilir pane" teklifi kabul edildiğinde
 *   • pty resume daemon'ın `respawnPane`'i — motor çıkınca (LİMİT) pane'i diriltir
 * İkincisi müşterinin senaryosunun ta kendisiydi: "limit doldu → motoru değiştirdim".
 *
 * ÇÖZÜM ŞEKLİ: hükmü çağırana EMANET ETMEYİ bıraktık. Çözümleyici motoru KENDİ okur;
 * bir çağıranın "unutması" artık mümkün değil (yeni bir restore yolu eklense bile
 * `respawnOptsFromEntry`'den geçtiği sürece hüküm otomatik uygulanır).
 *
 * NEDEN ÖNBELLEK **mtime**'a BAĞLI: geri yükleme döngüsü bir açılışta 20+ kaydı gezer
 * (dosyayı 20 kez okumak gereksiz), ama daemon AYNI süreçte SAATLER SONRA diriltir —
 * o an dosya çoktan değişmiş olabilir. Süreye dayalı bir TTL bu iki ihtiyacın
 * birini mutlaka yanlış yapar; damga (mtime+boyut) ikisini de doğru yapar.
 *
 * KAÇIŞ KOLU / KONTROL KOLU: `disabled()` true dönerse çözümleyici hiçbir hüküm
 * üretmez (`currentEngine → null`) ⇒ davranış HATA-12 ÖNCESİ hâline döner. Testte
 * "düzeltmeyi söküp kusuru geri getirme" kolu budur.
 */
function createResolver(cfg = {}) {
  const homedirOf = typeof cfg.homedir === 'function' ? cfg.homedir : () => cfg.homedir;
  const log = typeof cfg.log === 'function' ? cfg.log : () => {};
  const disabled = typeof cfg.disabled === 'function' ? cfg.disabled : () => cfg.disabled === true;
  const fsImpl = cfg.fs || fs;
  let cache = { key: null, map: {} };

  /** Dosyanın DEĞİŞİKLİK DAMGASI — yoksa 'yok' (ayna henüz hiç yazılmamış olabilir). */
  function stampOf(file) {
    try {
      const st = fsImpl.statSync(file);
      return `${st.mtimeMs}:${st.size}`;
    } catch {
      return 'yok';
    }
  }

  function mapNow() {
    let file;
    try {
      file = mirrorPath(homedirOf());
    } catch {
      return {};
    }
    const key = `${file}|${stampOf(file)}`;
    if (key !== cache.key) cache = { key, map: readMirror(homedirOf()) };
    return cache.map;
  }

  /** Ajanın GÜNCEL motoru — bilinmiyorsa `null` (hüküm üretilmez, tahmin edilmez). */
  function currentEngine(agentId) {
    const id = normAgentId(agentId);
    if (!id || disabled()) return null;
    return mapNow()[id] || null;
  }

  /** Sürüklenme hükmü: `{ from, to }` ya da `null`. */
  function drift(entry) {
    const from = normEngine(entry && entry.engine);
    const to = currentEngine(entry && entry.agentId);
    return engineDrifted(from, to) ? { from, to } : null;
  }

  /**
   * Respawn opts'unu sürüklenmeye göre düzelt + TEK SATIR logla.
   * Sürüklenme yoksa `opts` BİT-BİT aynı döner (log da yazılmaz).
   */
  function applyTo(opts, entry, where) {
    const d = drift(entry);
    if (!d) return opts;
    log(
      `restore: motor sürüklendi agent=${(entry && entry.agentId) || '-'} defter=${d.from} güncel=${d.to} ` +
        `yol=${where || '-'} → güncel motorla TEMİZ spawn (eski oturum/model/sağlayıcı taşınmadı)`,
    );
    return applyEngineDrift(opts, d.from, d.to);
  }

  return { currentEngine, drift, applyTo, cacheKey: () => cache.key };
}

module.exports = {
  MIRROR_FILE,
  mirrorPath,
  writeMirror,
  readMirror,
  engineDrifted,
  applyEngineDrift,
  createResolver,
  // test/teşhis için
  sanitize,
};
