'use strict';

// WIN-IMG-01 — AJANA GİDEN GEÇİCİ GÖRSELLERİN ÖMRÜ (tek kaynak).
//
// ÖLÇÜLEN kök neden (müşteri, Windows v0.2.31): sohbete eklenen 4 görselin YOLU
// ajana ulaşıyor ama DOSYA diskte yok — ajan "bu tarafta fiziksel olarak yok"
// diyor. Eski tasarım (`main.js` içinde `IMG_TTL_MS = 5*60*1000`) her dosya için
// YAZMA ANINDA bir `setTimeout(unlink)` kuruyordu ve yorumu şuydu:
// "agent reads it < this". Bu bir VARSAYIMDI ve turun hızına bağlıydı:
//
//   • sohbet akışında sayaç EKLEME anında başlar — kullanıcı 4 görsel ekleyip
//     mesajını yazarken 5 dk geçebilir; dosya GÖNDERİLMEDEN ölür,
//   • ajan meşgulse (uzun düşünme, kuyruk, limit sonrası devam) okuma 5 dk'yı
//     rahat aşar,
//   • ve ölüm SESSİZDİR — kimse kullanıcıya "dosya silindi" demez.
//
// YENİ TASARIM — yarış YAPISAL olarak kapatıldı: SÜRE YOK. Görseller uygulamanın
// O ÇALIŞMASINA ait bir OTURUM KLASÖRÜNE yazılır (`<tmp>/crewpane-images/run-<pid>-<t>`)
// ve yalnız iki anda temizlenir:
//   1. uygulama kapanırken kendi klasörü (`dispose`),
//   2. açılışta ÖNCEKİ çalışmalardan kalmış YETİM klasörler (`sweepOrphans`,
//      yaş kapısı — çöken oturumlar diskte iz bırakmasın).
// Yani uygulama açık olduğu SÜRECE dosya YAŞAR: "ajan geç okudu" artık bir hata
// senaryosu değildir. Bu modülde hiçbir zamanlayıcı YOKTUR (test bunu ölçer).
//
// Ayrıca YOL TESLİMİ Windows-güvenli hale getirildi (TOK-01 dersi): üretilen yol
// NFC'ye normalize edilir ve `\\?\` uzun-yol öneki SOYULUR — o önek kabuk/TUI
// tarafında "böyle bir dosya yok" demenin sessiz yoludur.
//
// Saf + DI: `fs`/`os`/`path`/`now`/`pid` enjekte edilebilir → `node --test` ile
// üç platformun yol biçimleri gerçek disk olmadan da sınanır.

const nodeFs = require('fs');
const nodeOs = require('os');
const nodePath = require('path');

/** Kabul edilen MIME → uzantı (ADP-035'ten devralındı, davranış aynı). */
const IMG_EXT_BY_TYPE = Object.freeze({
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/bmp': 'bmp',
});

/** Tek görsel için üst sınır (ADP-013 disiplini — RCE/abuse kapısı). */
const IMG_MAX_BYTES = 25 * 1024 * 1024;

/** Oturum klasörlerinin ortak kökü (tmp altında TEK dizin — kolay denetlenir). */
const ROOT_NAME = 'crewpane-images';

/** Açılışta silinecek YETİM oturum klasörü yaşı (önceki çalışmalardan kalanlar). */
const ORPHAN_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** Yol ayırıcıları / tuhaf karakterleri at; sınırlı taban ad (uzantısız). */
function sanitizeImgBaseName(name) {
  const base = String(name || 'image')
    .replace(/\.[a-z0-9]+$/i, '') // çağıranın uzantısını at (kendimizinkini ekleriz)
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return base || 'image';
}

/** IPC ile gelen yükü (ArrayBuffer / typed array / number[]) Buffer'a çevir. */
function toBuffer(data) {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  if (Array.isArray(data)) return Buffer.from(data);
  return null;
}

/**
 * TOK-01 dersi — AJANA/KABUĞA verilecek yolu güvenli biçime getir.
 *
 *   • NFC birleştirme: aynı dosyanın NFD yazımı Windows/Linux tarafında BAŞKA bir
 *     ada karşılık gelir (TOK-01 §1.1: claude'un kendisi de `xp()` ile NFC yapar).
 *   • `\\?\` uzun-yol öneki SOYULUR (`\\?\C:\x` → `C:\x`, `\\?\UNC\srv\p` → `\\srv\p`):
 *     Win32 API'si anlar ama kabuk/CLI argümanı olarak "yok" görünür (TOK-01 §2.1'de
 *     defter çözümünü kıran tam olarak buydu).
 *
 * POSIX yollarına DOKUNMAZ (NFC dışında) — macOS/Linux regresyonsuz.
 */
function normalizeAgentPath(p) {
  let s = typeof p === 'string' ? p : '';
  if (!s) return '';
  try {
    s = s.normalize('NFC');
  } catch {
    /* normalize yoksa ham hâliyle devam */
  }
  if (s.startsWith('\\\\?\\UNC\\')) return `\\\\${s.slice(8)}`;
  if (s.startsWith('\\\\?\\')) return s.slice(4);
  return s;
}

/**
 * Oturum-kapsamlı geçici görsel deposu.
 *
 * @param {object} deps `fs`,`os`,`path`,`now`,`pid`,`log`,`maxBytes` (hepsi opsiyonel).
 */
function createTempImageStore(deps = {}) {
  const fs = deps.fs || nodeFs;
  const os = deps.os || nodeOs;
  const path = deps.path || nodePath;
  const now = deps.now || Date.now;
  const pid = deps.pid != null ? deps.pid : process.pid;
  const log = typeof deps.log === 'function' ? deps.log : () => {};
  // SMOKE-ISO-01 — süreç canlılığı (test için enjekte edilir). EPERM = süreç VAR
  // ama bizim değil → "yaşıyor" say (ölçemedim → dokunma).
  const alive = deps.alive || ((pid) => {
    try { process.kill(pid, 0); return true; } catch (e) { return !!(e && e.code === 'EPERM'); }
  });
  const maxBytes = deps.maxBytes || IMG_MAX_BYTES;

  const root = path.join(os.tmpdir(), ROOT_NAME);
  const dirName = `run-${pid}-${now()}`;
  const dir = path.join(root, dirName);
  let seq = 0;
  let ensured = false;
  let disposed = false;

  function ensureDir() {
    if (!ensured) {
      fs.mkdirSync(dir, { recursive: true });
      ensured = true;
    }
    return dir;
  }

  /** Bu yol BİZİM kökümüzün altında mı? (renderer'a genel bir "var mı" oracle'ı açmayız.) */
  function isOurs(p) {
    if (typeof p !== 'string' || !p) return false;
    let abs;
    try {
      abs = path.resolve(normalizeAgentPath(p));
    } catch {
      return false;
    }
    const base = path.resolve(root);
    return abs === base || abs.startsWith(base + path.sep);
  }

  /**
   * Bir görsel yükünü oturum klasörüne yaz.
   * @returns {{ok:true,path:string,bytes:number}|{ok:false,reason:string,detail?:string}}
   */
  function save(payload) {
    try {
      if (disposed) return { ok: false, reason: 'store-disposed' };
      if (!payload || typeof payload !== 'object') return { ok: false, reason: 'bad-request' };
      const { data, type, name, prefix } = payload;
      if (typeof type !== 'string' || !type.startsWith('image/')) return { ok: false, reason: 'not-an-image' };
      const ext = IMG_EXT_BY_TYPE[type.toLowerCase()] || 'png';
      const buf = toBuffer(data);
      if (!buf) return { ok: false, reason: 'bad-data' };
      if (buf.length === 0) return { ok: false, reason: 'empty' };
      if (buf.length > maxBytes) return { ok: false, reason: 'too-large' };

      const tag = sanitizeImgBaseName(prefix || 'crewpane-img');
      const file = path.join(ensureDir(), `${tag}-${now()}-${++seq}-${sanitizeImgBaseName(name)}.${ext}`);
      fs.writeFileSync(file, buf);
      const out = normalizeAgentPath(file);
      log(`image saved: ${out} (${buf.length} bytes, ${type})`);
      // ⛔ BURADA setTimeout YOK — dosya oturum boyunca YAŞAR (yarış kapalı).
      return { ok: true, path: out, bytes: buf.length };
    } catch (err) {
      log(`image save error: ${err && err.message}`);
      return { ok: false, reason: 'write-failed', detail: err && err.message };
    }
  }

  /**
   * SESSİZ BAŞARISIZLIK YASAĞI — teslimden ÖNCE "bu dosyalar hâlâ var mı?".
   * Yalnız bizim kökümüzdeki yollara bakar; yabancı yol `foreign` sayılır ve
   * eksik gibi RAPORLANMAZ (renderer'a fs varlık-oracle'ı açmayız).
   * @returns {{ok:boolean, missing:string[], foreign:string[], present:string[]}}
   */
  function verify(paths) {
    const list = Array.isArray(paths) ? paths : [];
    const missing = [];
    const foreign = [];
    const present = [];
    for (const raw of list) {
      const p = normalizeAgentPath(typeof raw === 'string' ? raw : '');
      if (!p) continue;
      if (!isOurs(p)) {
        foreign.push(p);
        continue;
      }
      let exists = false;
      try {
        exists = fs.existsSync(p);
      } catch {
        exists = false;
      }
      (exists ? present : missing).push(p);
    }
    return { ok: missing.length === 0, missing, foreign, present };
  }

  /**
   * ÖNCEKİ çalışmalardan kalan yetim oturum klasörlerini sil. KENDİ klasörümüze
   * ASLA dokunmaz.
   *
   * İKİ KAPI (biri yetmez):
   *  1. SAHİP SÜREÇ YAŞIYOR MU — klasör adı `run-<pid>-<t>`; o pid hâlâ ayakta ise
   *     klasör YETİM DEĞİLDİR, dokunulmaz.
   *  2. YAŞ — sahibi ölmüş klasörler 24 saat sonra silinir.
   *
   * SMOKE-ISO-01 — 1. kapı EKLENDİ. Eskiden yalnız yaş bakılıyordu ve yorum
   * "ikinci bir instance'ın klasörünü silmeyelim" diyordu; ama uzun süre açık
   * duran bir uygulamanın klasörü (son görsel 24 saatten eskiyse) TAM DA bu
   * kapıya takılmıyordu → aynı makinede açılan ikinci bir kopya (duman testi,
   * e2e, dogfood) CANLI uygulamanın yapıştırılmış görsellerini siliyordu.
   * `<tmp>/crewpane-images` kökü CREWPANE_HOME'a bağlı DEĞİLDİR (TMPDIR miras
   * alınır), yani yalıtım işareti bu yolu kapsamaz — kimlik pid'den kurulur.
   * @returns {number} silinen klasör sayısı
   */
  function sweepOrphans(opts = {}) {
    const maxAgeMs = opts.maxAgeMs != null ? opts.maxAgeMs : ORPHAN_MAX_AGE_MS;
    let removed = 0;
    let entries;
    try {
      entries = fs.readdirSync(root);
    } catch {
      return 0; // kök hiç yok — temizlenecek bir şey de yok
    }
    for (const entry of entries) {
      if (entry === dirName) continue; // bizimki
      if (!entry.startsWith('run-')) continue; // yabancı içerik — dokunma
      // 1. kapı: sahibi hâlâ yaşıyorsa yetim değildir. `run-<pid>-<t>`.
      const ownerPid = Number(entry.split('-')[1]);
      if (Number.isFinite(ownerPid) && ownerPid > 1 && alive(ownerPid)) continue;
      const target = path.join(root, entry);
      try {
        const st = fs.statSync(target);
        if (now() - st.mtimeMs < maxAgeMs) continue;
        fs.rmSync(target, { recursive: true, force: true });
        removed += 1;
      } catch {
        /* best-effort — bir klasör silinemezse diğerlerine devam */
      }
    }
    if (removed) log(`image store: ${removed} yetim oturum klasörü temizlendi`);
    return removed;
  }

  /** Uygulama kapanıyor: bu çalışmanın TÜM geçici görsellerini sil. */
  function dispose() {
    disposed = true;
    if (!ensured) return 0;
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      log(`image store: oturum klasörü silindi (${dir})`);
      return 1;
    } catch (err) {
      log(`image store dispose error: ${err && err.message}`);
      return 0;
    }
  }

  return { save, verify, sweepOrphans, dispose, isOurs, dir: () => dir, root: () => root };
}

module.exports = {
  createTempImageStore,
  normalizeAgentPath,
  sanitizeImgBaseName,
  toBuffer,
  IMG_EXT_BY_TYPE,
  IMG_MAX_BYTES,
  ORPHAN_MAX_AGE_MS,
  ROOT_NAME,
};
