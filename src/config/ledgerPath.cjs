// TOK-01 — claude OTURUM DEFTERİNİN YOLU: platform-nötr çözümleme.
//
// 🔴 NEDEN AYRI MODÜL: "jeton/maliyet kutusu yanlış ya da SABİT" şikâyetinin
// kökü hesap değil ADRES. Defter bulunamazsa kart ya 0 yazar ya da eski değerde
// donar; yani YOL HATASI kendini FİYAT HATASI gibi gösterir. Adresi tek bir yerde,
// ölçülebilir ve saf tutuyoruz.
//
// ── KURALIN KAYNAĞI: TAHMİN DEĞİL, CLAUDE CODE İKİLİSİNDEN OKUNDU ────────────
// `~/.local/share/claude/versions/2.1.226` (Mach-O, gömülü JS) içinden birebir:
//
//   function xdt(e){let t=0;for(let r=0;r<e.length;r++)t=(t<<5)-t+e.charCodeAt(r)|0;return t}
//   function T$g(e){return Math.abs(xdt(e)).toString(36)}
//   function bes(e){return e.replace(/[^a-zA-Z0-9]/g,"-")}
//   function gw(e){let t=bes(e);if(t.length<=sQ)return t;return `${t.slice(0,sQ)}-${T$g(e)}`}   // sQ = 200
//   function SB(){return Xj.join(Hn(),"projects")}
//   function iG(e){return Xj.join(SB(),gw(e))}
//   function xp(e){return e.normalize("NFC")}
//   async function LI(e){try{return xp(await Qj.realpath(e))}catch{return xp(e)}}
//
// Yani gerçek kural ÜÇ parçalıdır ve CrewPane bunun yalnız BİRİNCİSİNİ biliyordu:
//   1. alfanumerik-dışı → '-'                       ✅ biliniyordu
//   2. NFC birleştirme (`xp`)                        ❌ EKSİKTİ
//   3. 200 karakter TAVANI + base36 hash soneki      ❌ EKSİKTİ
// Ayrıca girdi ham cwd değil `realpath(cwd)`tir (ADP-306 bunu macOS için
// yakalamıştı; kural aslında platform-genelidir).
//
// ÖLÇÜLDÜ (bu makine, ~/.claude/projects, 272 dizin): dizin adlarının 264'ü
// transkriptin KENDİ `cwd` alanından yeniden üretilebildi (kalan 8: `--add-dir`
// / devralınmış oturum, kural ihlali değil). Yani 1. kural doğru — ama 2 ve 3
// bu makinede TETİKLENMİYOR (en uzun dizin adı 131 < 200, ASCII-dışı 0), o yüzden
// bugüne kadar görünmediler. Windows'ta ikisi de RUTİN olarak tetiklenir:
// `C:\Users\<ad>\OneDrive - <Şirket>\Documents\…` munge'ı 200'ü kolayca aşar.
//
// ── SON ÇARE: OTURUM KİMLİĞİYLE TARAMA ──────────────────────────────────────
// Claude Code'un kendisi de yolu hesaplamakla YETİNMEZ: hesaplanan aday tutmazsa
// `~/.claude/projects/*/<sessionId>.jsonl` taranır ve TEK eşleşme varsa o kabul
// edilir (ikilideki `tao`). Bu, munge/kasa/UNC/NFC/uzunluk sınıfının TAMAMINI tek
// hamlede bağışık kılar — çünkü oturum kimliği bizim mint ettiğimiz uuid'dir
// (agentRunner `--session-id`), yani küresel olarak tektir. Aynı çareyi buraya
// alıyoruz; hesaplanan aday tutarsa tarama HİÇ çalışmaz (maliyet yok).

'use strict';

const fs = require('node:fs');
const path = require('node:path');

/** Claude Code'un proje-dizin adı tavanı (ikilideki `sQ`/`npc`). */
const PROJECT_DIR_MAX = 200;

/**
 * Claude Code'un dizin-adı hash'i (ikilideki `xdt`): Java `String.hashCode`.
 * 32-bit taşma davranışı ŞART — `|0` olmadan uzun yollarda başka sayı çıkar.
 */
function cwdHash(text) {
  let h = 0;
  const s = String(text ?? '');
  for (let i = 0; i < s.length; i += 1) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return h;
}

/** Alfanumerik-dışı her karakter '-' (ikilideki `bes`). Tavan UYGULANMAZ. */
function mungeRaw(cwd) {
  return String(cwd ?? '').replace(/[^A-Za-z0-9]/g, '-');
}

/**
 * cwd → claude proje-dizini ADI (ikilideki `gw(xp(cwd))` ile birebir).
 * NFC + munge + 200 tavanı + base36 hash soneki.
 */
function projectDirName(cwd) {
  const nfc = String(cwd ?? '').normalize('NFC');
  const munged = mungeRaw(nfc);
  if (munged.length <= PROJECT_DIR_MAX) return munged;
  return `${munged.slice(0, PROJECT_DIR_MAX)}-${Math.abs(cwdHash(nfc)).toString(36)}`;
}

// ---------------------------------------------------------------------------
// cwd ADAYLARI — aynı dizini gösteren farklı yazımlar
// ---------------------------------------------------------------------------

/** `\\?\C:\x` → `C:\x` · `\\?\UNC\srv\pay` → `\\srv\pay` (Windows uzun-yol öneki). */
function stripExtendedPrefix(p) {
  const s = String(p ?? '');
  const unc = /^[\\/]{2}[?.][\\/]UNC[\\/](.+)$/i.exec(s);
  if (unc) return `\\\\${unc[1]}`;
  const drive = /^[\\/]{2}[?.][\\/](.+)$/.exec(s);
  return drive ? drive[1] : s;
}

/** Sondaki ayraçları at — ama kökü ('/' · 'C:\') YUTMA. */
function stripTrailingSep(p) {
  const s = String(p ?? '');
  if (/^[A-Za-z]:[\\/]?$/.test(s) || /^[\\/]$/.test(s)) return s;
  return s.replace(/[\\/]+$/, '');
}

/**
 * `C:\x` ↔ `c:\x` — sürücü harfinin iki kasası (munge ikisini AYIRIR).
 * VERİLEN kasa ÖNCE döner: birincil aday hep "bize söylenen yol"dur, böylece
 * `via:'computed'` hükmü anlamını korur (naif hesap tuttu mu?).
 */
function driveCaseVariants(p) {
  const s = String(p ?? '');
  const m = /^([A-Za-z])(:.*)$/s.exec(s);
  if (!m) return [s];
  const upper = `${m[1].toUpperCase()}${m[2]}`;
  const lower = `${m[1].toLowerCase()}${m[2]}`;
  return s === upper ? [upper, lower] : [lower, upper];
}

/**
 * Bir cwd'nin, DİSKTE aynı yeri gösteren tüm makul yazımları.
 *
 * Sıra ÖNEMLİ: en güvenilir (gerçek yol) önce gelir — çağıran ilk VAR OLANI seçer.
 * `realpathSync.native` ayrı bir adaydır: Windows'ta 8.3 kısa adları ve dizin
 * KASASINI diskteki hâline çeviren tek çağrı odur (JS `realpathSync` çevirmez);
 * macOS/Linux'ta ikisi aynı sonucu verir ve Set tekilleştirir.
 */
function cwdCandidates(cwd) {
  const raw = String(cwd ?? '');
  if (!raw) return [];
  const seeds = [raw];
  for (const fn of [fs.realpathSync.native, fs.realpathSync]) {
    try {
      const real = fn(raw);
      if (real) seeds.push(String(real));
    } catch {
      /* cwd artık yok / erişilemez → ham yazımlarla devam */
    }
  }
  const out = new Set();
  for (const seed of seeds) {
    for (const base of [seed, stripExtendedPrefix(seed)]) {
      for (const trimmed of [base, stripTrailingSep(base)]) {
        for (const cased of driveCaseVariants(trimmed)) {
          if (cased) {
            out.add(cased);
            out.add(cased.normalize('NFC'));
          }
        }
      }
    }
  }
  return [...out];
}

/** Aday cwd yazımlarının her biri için proje-dizini (tekilleştirilmiş). */
function projectDirCandidates(cwd, projectsRoot) {
  const dirs = new Set();
  for (const c of cwdCandidates(cwd)) dirs.add(path.join(projectsRoot, projectDirName(c)));
  return [...dirs];
}

// ---------------------------------------------------------------------------
// Çözümleme
// ---------------------------------------------------------------------------

function exists(file) {
  try {
    return fs.existsSync(file);
  } catch {
    return false;
  }
}

/**
 * Son çare (Claude Code'un `tao`'su): TÜM proje dizinlerinde `<sessionId>.jsonl` ara.
 *
 * 🔴 Yalnız TEK eşleşme kabul edilir. İki dizinde aynı kimlik varsa hangisinin
 * bu pane'e ait olduğu BİLİNMEZ → null döner ve çağıran "bulunamadı" der.
 * Uydurmaktansa bilmemek (bu deponun dürüstlük sözleşmesi).
 */
function scanProjectsForSession(projectsRoot, sessionId) {
  let names;
  try {
    names = fs.readdirSync(projectsRoot);
  } catch {
    return null;
  }
  const leaf = `${sessionId}.jsonl`;
  let hit = null;
  for (const name of names) {
    const file = path.join(projectsRoot, name, leaf);
    if (!exists(file)) continue;
    if (hit) return null; // belirsiz → hüküm YOK
    hit = file;
  }
  return hit;
}

/**
 * Pane'in oturum defteri NEREDE?
 *
 * @param {string} cwd
 * @param {string} sessionId
 * @param {string} claudeHomeDir `~/.claude` (çağıran enjekte eder — test seam'i)
 * @returns {{ file:string|null, found:boolean, via:'computed'|'candidate'|'projects-scan'|'none', candidates:number }}
 *   `found=false` iken `file` yine de BİRİNCİL adaydır (eski davranışla uyum:
 *   çağıran onu "olması gereken yol" diye raporlayabilir) ama VAR DEĞİLDİR.
 */
function resolveSessionFile(cwd, sessionId, claudeHomeDir) {
  if (!cwd || !sessionId) return { file: null, found: false, via: 'none', candidates: 0 };
  const root = path.join(claudeHomeDir, 'projects');
  const dirs = projectDirCandidates(cwd, root);
  const primary = dirs.length ? path.join(dirs[0], `${sessionId}.jsonl`) : null;
  for (let i = 0; i < dirs.length; i += 1) {
    const file = path.join(dirs[i], `${sessionId}.jsonl`);
    if (exists(file)) return { file, found: true, via: i === 0 ? 'computed' : 'candidate', candidates: dirs.length };
  }
  // Hesaplanan adayların hiçbiri tutmadı → kimlikten tara (munge/kasa/UNC/NFC/
  // uzunluk sınıfının tamamına bağışık). Maliyet yalnız BU dalda ödenir.
  const scanned = scanProjectsForSession(root, sessionId);
  if (scanned) return { file: scanned, found: true, via: 'projects-scan', candidates: dirs.length };
  return { file: primary, found: false, via: 'none', candidates: dirs.length };
}

/** Bu cwd'nin DİSKTE VAR OLAN proje dizinleri (yoksa boş — "toplam" taraması için). */
function existingProjectDirs(cwd, claudeHomeDir) {
  const root = path.join(claudeHomeDir, 'projects');
  return projectDirCandidates(cwd, root).filter((dir) => {
    try {
      return fs.statSync(dir).isDirectory();
    } catch {
      return false;
    }
  });
}

module.exports = {
  PROJECT_DIR_MAX,
  cwdHash,
  mungeRaw,
  projectDirName,
  stripExtendedPrefix,
  stripTrailingSep,
  driveCaseVariants,
  cwdCandidates,
  projectDirCandidates,
  scanProjectsForSession,
  resolveSessionFile,
  existingProjectDirs,
};
