'use strict';
// ADP-708 — Telifli (Marvel/DC) içerik NÖBET KAPISI + paket-strip.
//
// NEDEN: İndirilen 0.2.20 müşteri paketinin içinde 72 Marvel/DC karakter sprite'ı
// + kaynağını yazan README ("MCU Netflix", "Avengers: Age of Ultron") + AI üretimi
// Batman/Superman/Spider-Man vardı; giriş/lisans avatarı Nick Fury'ydi. Bu hem TELİF
// riski hem Eren'in iç-kullanım verisinin müşteriye sızması. Lansman videosunun İLK
// KARESİNDE görünür. Bu modül müşteri paketinden telifli sprite'ları SİLER ve pakete
// telifli bir şey KALIRSA build'i KIRAR (afterPack throw → electron-builder abort).
//
// KAYNAKLAR:
//   • brandSafe[]  → src/app/lib/brandSafeSprites.json (whitelist; renderer bundle'ına da girer)
//   • DENY_TOKENS  → BU DOSYADA (build-only). Telifli isim parçaları renderer bundle'ına
//     GİRMEMELİ; o yüzden brandSafeSprites.json'dan ÇIKARILDI ve burada yaşar.
//
// KAPSAM KARARI (false-positive'siz olsun diye kasıtlı dar): 'thor'/'loki'/'fury'/
// 'vision' gibi token'lar KOD içinde (ajan adları, yorumlar, tip adları) meşru geçer;
// bu yüzden .js/.ts/.map/.css ve node_modules TARANMAZ. Gate şu KESİN yüzeyleri denetler:
//   1) sprite karakter dizini → SADECE brandSafe girdileri olabilir (README/legacy = ihlal)
//   2) paketlenmiş public/ altındaki insan-okunur manifest/asset'ler (.md/.json/.txt/.html)
//   3) Info.plist (mic izin metni "Jarvis" gibi telifli ad taşımasın)
// Bu üç yüzey, videoda görünen ve telif riski taşıyan içeriğin TAMAMINI kapsar.
const fs = require('node:fs');
const path = require('node:path');

// Build-only telifli isim parçaları. RENDERER BUNDLE'INA ASLA GİRMEZ (bu .cjs yalnız
// electron/build sürecinde çalışır). Bir paket-yüzeyi dosya adı/insan-okunur metni
// bunlardan birini taşırsa gate kırılır.
const DENY_TOKENS = [
  'marvel', 'dc-', 'avengers', 'ageofultron', 'mcu',
  'batman', 'superman', 'spiderman', 'spider-man', 'wolverine', 'flash-',
  'nickfury', 'ironman', 'ironlegionnaire', 'hulk', 'hulkbuster',
  'scarletwitch', 'quicksilver', 'visionavengers', 'ultron', 'daredevil',
  'punisher', 'kingpin', 'jessicajones', 'lukecage', 'ironfist',
  'captamerica', 'captcarter', 'capww2', 'bucky', 'wintersoldie', 'wintersoldier',
  'redskull', 'crossbones', 'chitauri', 'hydratrooper', 'peggycarter',
  'howardstark', 'steverogers', 'vonstrucker', 'mariahill', 'agentcoulson',
  'blackwidow', 'jarvis',
  // NOT: 'fury'/'thor'/'loki'/'falcon'/'hawkeye' gibi ambiguous token'lar KASITLI
  // dışarıda — kodda meşru (ajan adları/yorumlar) geçer, .js taranmadığı için sprite
  // dizini whitelist'i (aşağıda) bu karakterleri zaten adıyla yakalar (loki, thor,
  // falcon, hawkeye dizinleri whitelist'te olmadığı için strip'lenir + gate kırar).
];

function loadPolicy() {
  const p = path.join(__dirname, '..', 'src', 'app', 'lib', 'brandSafeSprites.json');
  const j = JSON.parse(fs.readFileSync(p, 'utf8'));
  const brandSafe = new Set(j.brandSafe || []);
  if (!brandSafe.size) throw new Error('copyrightGate: brandSafeSprites.json brandSafe boş — politika okunamadı');
  return { brandSafe, denyTokens: DENY_TOKENS.map((t) => t.toLowerCase()) };
}

// ADP-725 — MÜŞTERİ YÜZEYİ OLAN sprite kütüphaneleri. `public/sprites/` altında
// bundan başka ne varsa Eren'in İÇ kütüphanesidir (agents/, marvel/, education/ —
// Marvel/DC karakterleri + "joker/arrow" gibi token taramasının GÖRMEDİĞİ adlar) ve
// müşteri paketinde hiç işi yoktur: renderer bu yolların hiçbirine referans vermez
// (`grep -rn "sprites/agents\|sprites/marvel\|sprites/education" src electron` = 0).
// Karar isimden değil KAPSAMDAN türer: ne müşteriye lazımsa o kalır.
// ONB-D1 — `characters-v3` BU LİSTEYE GİRDİ. Ölçülen risk: açılış/giriş ekranı
// (CrewPaneLoginGate → WelcomeScene) ofis şeridindeki yürüyen ajanları
// `public/sprites/characters-v3/<key>/48x48.png` ile çiziyor. Bu lib listede
// olmasaydı strip onu KOMPLE silecek ve müşteri paketinin İLK KARESİNDE dört
// kırık sprite görünecekti (yerel geliştirmede fark edilmezdi — orada dosya var).
// Karar yine KAPSAMDAN türüyor: v3 seti artık müşteri yüzeyidir. Telif tarafı
// temiz — v3 varlıkları prosedürel üretim (scripts/gen-sprites/quality-build-v3.mjs),
// hiçbir üçüncü-parti karakterden türemiyor.
const CUSTOMER_SPRITE_LIBS = new Set(['characters', 'characters-v3', 'office']);

/** Müşteri paketindeki sprite yüzeyini temizler:
 *   • `sprites/characters` → yalnız whitelist (legacy sprite + README manifest gider)
 *   • `sprites/<başka kütüphane>` → tamamı gider (iç kullanım, müşteri yüzeyi değil)
 *  standaloneRoot = <Resources>/standalone. */
function stripCopyrightedSprites(standaloneRoot, policy = loadPolicy()) {
  const spritesDir = path.join(standaloneRoot, 'public', 'sprites');
  const charsDir = path.join(spritesDir, 'characters');
  const removed = [];
  const kept = [];

  if (fs.existsSync(charsDir)) {
    for (const entry of fs.readdirSync(charsDir)) {
      if (policy.brandSafe.has(entry)) { kept.push(entry); continue; }
      fs.rmSync(path.join(charsDir, entry), { recursive: true, force: true });
      removed.push(entry);
    }
  }

  if (fs.existsSync(spritesDir)) {
    for (const lib of fs.readdirSync(spritesDir)) {
      if (CUSTOMER_SPRITE_LIBS.has(lib)) continue;
      fs.rmSync(path.join(spritesDir, lib), { recursive: true, force: true });
      removed.push(`sprites/${lib}`);
    }
  }

  return { removed, kept, charsDir };
}

const TEXT_EXT = new Set(['.md', '.json', '.txt', '.html', '.htm', '.plist', '.csv']);
const SKIP_DIR = new Set(['node_modules', '.git', '.next']); // .next cache: derlenmiş, taranmaz

function walk(dir, onFile) {
  for (const name of fs.readdirSync(dir, { withFileTypes: true })) {
    if (name.isDirectory()) {
      if (SKIP_DIR.has(name.name)) continue;
      walk(path.join(dir, name.name), onFile);
    } else {
      onFile(path.join(dir, name.name), name.name);
    }
  }
}

/** Telifli içerik kaldı mı? KALDIYSA fırlatır (build kırılır). appRoot = <...>.app kökü
 *  ya da bir prova dizini. standaloneRoot verilirse sprite dizini de whitelist denetlenir. */
function assertBrandSafe(appRoot, opts = {}) {
  const policy = opts.policy || loadPolicy();
  const violations = [];
  const scanRoots = [];

  // 1) Sprite dizini: SADECE brandSafe girdileri
  const standaloneRoot = opts.standaloneRoot || findStandalone(appRoot);
  if (standaloneRoot) {
    const charsDir = path.join(standaloneRoot, 'public', 'sprites', 'characters');
    if (fs.existsSync(charsDir)) {
      for (const entry of fs.readdirSync(charsDir)) {
        if (!policy.brandSafe.has(entry)) {
          violations.push(`sprite dizininde whitelist-dışı girdi: public/sprites/characters/${entry}`);
        }
      }
    }
    scanRoots.push(path.join(standaloneRoot, 'public'));
  }

  // 3) Info.plist (varsa)
  const plist = path.join(appRoot, 'Contents', 'Info.plist');
  if (fs.existsSync(plist)) scanRoots.push(plist);

  // 2) public/ (+ verilen ekstra kökler) altındaki insan-okunur dosyalar → denyToken
  for (const root of scanRoots) {
    const stat = fs.existsSync(root) ? fs.statSync(root) : null;
    if (!stat) continue;
    const files = [];
    if (stat.isDirectory()) walk(root, (fp, nm) => files.push([fp, nm]));
    else files.push([root, path.basename(root)]);
    for (const [fp, nm] of files) {
      // dosya ADI telifli mi?
      const lowName = nm.toLowerCase();
      for (const tok of policy.denyTokens) {
        if (lowName.includes(tok)) violations.push(`telifli dosya adı: ${path.relative(appRoot, fp)} ("${tok}")`);
      }
      // insan-okunur içerik telifli mi?
      if (!TEXT_EXT.has(path.extname(nm).toLowerCase())) continue;
      let text;
      try { text = fs.readFileSync(fp, 'utf8').toLowerCase(); } catch { continue; }
      for (const tok of policy.denyTokens) {
        if (text.includes(tok)) violations.push(`telifli metin: ${path.relative(appRoot, fp)} ("${tok}")`);
      }
    }
  }

  if (violations.length) {
    throw new Error(
      `copyrightGate: müşteri paketinde telifli içerik bulundu (ADP-708) — ${violations.length} ihlal:\n  - ` +
        violations.slice(0, 40).join('\n  - '),
    );
  }
  return { ok: true, scanned: scanRoots.length };
}

// ── ADP-744 — KATALOG ⇔ PAKET TUTARLILIK NÖBETİ ─────────────────────────────
// `assertBrandSafe` "pakette FAZLA bir şey var mı" diye sorar. Bu kapı TERSİNİ
// sorar: "katalogda olup pakette OLMAYAN var mı". İkisi birden olmadan tutarlılık
// yok — ADP-736 §3'te tam olarak bu yarım kapı yüzünden katalogda 82 giriş varken
// pakete 10 PNG girdi ve müşteri seçicide 72 KIRIK KARE gördü.
//
// Neden BUILD'i kırıyor (uyarı değil): yüklenemeyen tek bir sprite ofis sahnesini
// kendini besleyen rebuild döngüsüne sokuyor — ADP-731 ölçtü: 108 rebuild/sn,
// 970 ensureCharTexture/sn, +65,96 MB/dk ≈ 3,9 GB/saat. Wheeljack'in sonlanma
// koşulu (MAX_TEXTURE_ATTEMPTS) hasarı sınırlar; asıl çözüm dosyanın EKSİK
// OLMAMASI. Bu yüzden eksik dosya = kırmızı build, her kanalda.
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

/** Paketteki bir sprite dosyası gerçekten kullanılabilir mi? (var + PNG + boş değil) */
function spriteAssetProblem(file) {
  let st;
  try { st = fs.statSync(file); } catch { return 'dosya yok'; }
  if (!st.isFile()) return 'dosya değil';
  if (st.size < 200) return `çok küçük (${st.size} B)`;
  let head;
  try {
    const fd = fs.openSync(file, 'r');
    head = Buffer.alloc(4);
    fs.readSync(fd, head, 0, 4, 0);
    fs.closeSync(fd);
  } catch { return 'okunamadı'; }
  if (!head.equals(PNG_MAGIC)) return 'PNG imzası yok';
  return null;
}

/**
 * Katalogdaki (= brandSafe whitelist) HER anahtarın önizleme + sheet dosyası
 * pakete girmiş mi? Girmemişse FIRLATIR (afterPack → build abort).
 * standaloneRoot = <Resources>/standalone.
 */
function assertCatalogAssetsShipped(standaloneRoot, opts = {}) {
  const policy = opts.policy || loadPolicy();
  const charsDir = path.join(standaloneRoot, 'public', 'sprites', 'characters');
  const required = opts.requiredFiles || ['48x48.png', '16x16.png'];
  const problems = [];

  for (const key of policy.brandSafe) {
    for (const file of required) {
      const p = path.join(charsDir, key, file);
      const why = spriteAssetProblem(p);
      if (why) problems.push(`katalog anahtarı pakete girmedi: ${key}/${file} — ${why}`);
    }
  }

  if (problems.length) {
    throw new Error(
      'copyrightGate: katalog ile paket TUTARSIZ (ADP-744) — seçicide kırık kare + ' +
        `ofiste sonsuz texture rebuild riski (ADP-731). ${problems.length} eksik:\n  - ` +
        problems.slice(0, 40).join('\n  - '),
    );
  }
  return { ok: true, checked: policy.brandSafe.size, charsDir };
}

function findStandalone(appRoot) {
  const cands = [
    path.join(appRoot, 'Contents', 'Resources', 'standalone'),
    path.join(appRoot, 'standalone'),
  ];
  return cands.find((c) => fs.existsSync(c)) || null;
}

module.exports = {
  loadPolicy,
  stripCopyrightedSprites,
  assertBrandSafe,
  assertCatalogAssetsShipped,
  findStandalone,
};
