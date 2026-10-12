// AgentSpace — DLG-11: MAKİNE BÜTÇESİ (kabul kontrolü, saf çekirdek).
//
// Canlı vaka (22.09): aynı anda 5 worker + ses özelliği üretimi + ~20 arka plan
// servisi → makine kilitlendi, reset attı; uygulama yeniden başladı ve 7 iş pane'iyle
// öldü. Delegasyonun "bu işi ŞİMDİ BU makinede koşmak güvenli mi?" diye bir sorusu
// yoktu. Bu modül o soruyu cevaplar — delegasyonu yeniden yazmaz, tek dispatch
// kapısına (delegationRunner.startTeamDelegationEx) tek bir hüküm verir:
//
//   1. İŞ AĞIRLIĞI  — hafif (okuma/metin/plan) · orta (kod + birim test) ·
//                     agir (tam test takımı, build, paketleme, e2e). Alan yoksa
//                     metinden KURAL ile tahmin edilir ve kayda "tahmin" diye yazılır.
//   2. MAKİNE SINIFI — bu-makine · diger-makine (ses kaydı/klip üretimi, özellik
//                     çıkarma, model eğitimi/çıkarım kıyası, veri seti indirme).
//                     diger-makine işi BU makinede başlatılmaz.
//   3. BÜTÇE        — koşan işlerin toplam puanı tavanı aşamaz (puan = ağırlık × pane).
//   4. SAĞLIK       — ağır iş kabulünden önce TEK ATIM bellek baskısı + yük okuması.
//
// MACHINE-BUDGET-BLOCK-01 (0.3.1, Murat 01.10) — LİMİT SORAR, ENGELLEMEZ. 0.3.0'da
// bütçe (3) ve sağlık (4) işi SESSİZCE kuyruğa alıyordu: ağır iş 4 puan, tavan 8 →
// aynı anda en çok 2 ağır iş; müşteri "2'den fazla ajan çalışmıyor" dedi. Artık
// varsayılan `onExceed: 'warn'`: aşımda iş HEMEN başlar, hüküm `warn` alanıyla
// "bilgilendir" der. Eski kuyruk davranışı yalnız kullanıcı açıkça seçerse
// (`onExceed: 'queue'` — Ayarlar'daki "sıraya al" düğmesi) geri gelir. Diğer-makine
// (2) ayrı bir karardır (OTHER-MACHINE-QUEUE-01) ve bu değişiklikle değişmez.
//
// RG-MODE-01 (0.3.2, K41/K42) — TEK AYAR: `mode` = 'off' | 'auto' (varsayılan) | 'strict'.
// Murat 02.10: "36 GB'lık makinede 8 sınır çok kötü … 50, 100 terminal açabilmeliyim".
//   off    — hiçbir sayım yok.
//   auto   — pencere/hafif/orta iş HİÇ sayılmaz; yalnız ağır iş (tam test, build, paketleme,
//            e2e) sayılır ve tavan makineden çıkar (`heavySlotsFor`: 36 GB/10P → 5, 8 GB → 1).
//            Yuva doluysa (K42-A) ağır iş bekler, kuyruk satırında "Şimdi başlat" vardır.
//   strict — 0.3.0 puan bütçesi + sağlık uyarısında bekletme; tavan sabit 8 değil yuva × 4.
// Eski `enabled`/`onExceed` alanları OKUNUR (göç `normalizeConfig` içinde), yazılmaz.
//
// Kural tablosu bu dosyadadır ve TEK tablodur (RULES). Sözcük eklemek = satır eklemek.
//
// Leaf modül: renderer (delegationRunner.ts) ve main (main.js) aynı dosyayı yükler;
// `node:` modülleri yalnız `readMachineHealth` içinde, çağıranın verdiği bağımlılıkla
// kullanılır (renderer bu fonksiyonu ÇAĞIRMAZ — sağlık main'de okunur).

'use strict';

const WEIGHTS = Object.freeze({ hafif: 1, orta: 2, agir: 4 });
const WEIGHT_NAMES = Object.freeze(['hafif', 'orta', 'agir']);
const MACHINE_CLASSES = Object.freeze(['bu-makine', 'diger-makine']);
/** Tavan: 2 ağır iş YA DA 4 orta iş YA DA 8 hafif iş aynı anda (bkz. rapor §ölçüm). */
const DEFAULT_CAP = 8;
/** Yük eşiği: 1 dk yük ortalaması / çekirdek. 22.09 kilitlenmesinde 15 dk ort. 66/14 = 4,7 ölçüldü. */
const DEFAULT_LOAD_PER_CPU = 1.5;
/** Bellek eşiği (macOS dışı): kullanılabilir / toplam bu oranın altına inerse baskı var. */
const DEFAULT_MIN_AVAIL_RATIO = 0.1;
/** Kabul hükmünün kodları (UI cümleyi i18n'den kurar, kod tek dil). */
// QUEUE-NEVER-STUCK-01 — 'order': bütçe dolu değil, önde AYNI ajanı bekleyen daha eski iş var.
// 'aging': makinede uzun süredir yer bekleyen (açlık sınırını geçmiş) daha eski iş var.
const GATES = Object.freeze(['off', 'admit', 'budget', 'health', 'other-machine', 'order', 'aging']);
/** MACHINE-BUDGET-BLOCK-01 — aşımda ne olur: 'warn' (başlat + bilgilendir, VARSAYILAN) · 'queue' (eski: beklet). */
const ON_EXCEED = Object.freeze(['warn', 'queue']);
const DEFAULT_ON_EXCEED = 'warn';
/** RG-MODE-01 — kaynak korumasının tek ayarı (K41: varsayılan Otomatik, her makinede). */
const MODES = Object.freeze(['off', 'auto', 'strict']);
const DEFAULT_MODE = 'auto';
/** RG-MODE-01 — elle tavanın geçerli aralığı; dışındaki/bozuk değer otomatiğe düşer. */
const MANUAL_MIN = 1;
const MANUAL_MAX = 64;
/** RG-MODE-01 (K42) — Otomatik'te ağır iş yuvası dolunca: 'wait' (A, önerilen) · 'warn' (B: başlat + bildir). */
const HEAVY_FULL = Object.freeze(['wait', 'warn']);
const DEFAULT_HEAVY_FULL = 'wait';
/** Sıkı kipte puan tavanı = ağır iş yuvası × ağır iş puanı (36 GB → 20, 8 GB → 4). */
const STRICT_POINTS_PER_SLOT = 4;
const GIB = 1024 ** 3;

// ── TEK KURAL TABLOSU ──────────────────────────────────────────────────────
// Desenler `normalize()` edilmiş (küçük harf, Türkçe harfler ASCII'ye) metinde aranır.
// `sinif` kuralları makine sınıfını, `agirlik` kuralları ağırlığı belirler. Ağırlıkta
// eşleşen EN AĞIR kural kazanır; hiçbir kural eşleşmezse varsayılan `orta`dır
// (bilinmeyen işi "hafif" saymak bütçeyi delerdi — yanlış yön güvenli yöndür).
const RULES = Object.freeze([
  // makine sınıfı → diger-makine
  { alan: 'sinif', deger: 'diger-makine', ad: 'ses kaydı / klip / özellik üretimi', desen: /\bses (kayd|kayit|klib|klip|ornek|uret|ozellig|ozellik)|\b(?<!yanlis )(pozitif|negatif) (klip|ses|kume|ornek|ozellik|veri\b|verisi)|\bmikrofon(la|dan)? .{0,40}\bklip|\b(tts|stt) (uret|egit|veri)|\b(audio|voice) (record|clip|dataset|feature)/ },
  { alan: 'sinif', deger: 'diger-makine', ad: 'özellik çıkarma', desen: /\bozellik (cikar|cikarim|kumesi)|\bfeature extract|\bcompute_features/ },
  { alan: 'sinif', deger: 'diger-makine', ad: 'model eğitimi', desen: /\bmodel(i|in)? (egit|train)|\begitim (verisi|kosum|hatti)|\b(uyandirma|wake ?word) modeli? egit|\bfine-?tun|\btrain(ing)? (a |the )?model|\btrain\.py\b/ },
  { alan: 'sinif', deger: 'diger-makine', ad: 'çıkarım kıyaslama', desen: /\bcikarim (kiyas|bench|olc)|\binference bench|\bmodel (kiyas|benchmark)/ },
  { alan: 'sinif', deger: 'diger-makine', ad: 'veri seti indirme', desen: /\bveri ?set(i|ini)? (indir|cek)|\bdataset (download|indir)|\bdownload (the |a )?dataset/ },
  // ağırlık → agir
  { alan: 'agirlik', deger: 'agir', ad: 'build / paketleme', desen: /\bbuild\b|\bpaketle|\bpackag|\bdmg\b|\belectron-builder|\bnotari[sz]|\bdist:/ },
  { alan: 'agirlik', deger: 'agir', ad: 'e2e / tam test takımı', desen: /\be2e\b|\bplaywright\b|\btam test|\btum test|\bfull test|\btest suite|\btest:unit\b|\bgate:full|\btam kapi/ },
  // ağırlık → orta
  { alan: 'agirlik', deger: 'orta', ad: 'kod + birim test', desen: /\bkod\b|\bkodla|\bimplement|\bduzelt|\bfix\b|\brefactor|\bbirim test|\bunit test|\bmigration|\bfeature\b|\bpatch\b/ },
  // ağırlık → hafif
  { alan: 'agirlik', deger: 'hafif', ad: 'okuma / metin / plan', desen: /\boku\b|\bokuyup|\barastir|\bplan\b|\bplanla|\bozetle|\brapor yaz|\bdokuman|\breview\b|\bincele|\bread\b|\bsummar/ },
]);

// Olumsuz satır: işi ANAN ama YAPTIRMAYAN satır ("build başlatma", "e2e koşma").
// YALNIZ AĞIRLIK tahmininde elenir (yanlış negatifin bedeli: iş biraz erken başlar).
// Makine sınıfında ELENMEZ — 22.09 kartları işi ve yasağı aynı satırda veriyordu.
const NEGATION = /\b(yok|yapma|yapmayin|baslatma|kosma|kosmadan|icermez|degil|asla|yasak|dokunma|don't|do not|never|without|no)\b|⚠|⛔/;

// Meta satır: işi değil KURALIN KENDİSİNİ anlatan satır ("Makine sınıfı: bu-makine /
// diger-makine. Ses kaydı, …", "agir (tam test, build, e2e)"). Ölçüldü: DLG-11 kartının
// kendi metni bu satırlar yüzünden "diğer makine + ağır" sınıflanıyordu (rapor §4.3).
const META = /diger[- ]makine|bu[- ]makine|makine sinif|makine kural|agirlik|\bhafif\b.*\borta\b|\borta\b.*\bagir\b/;

// Makine sınıfı için DAR eleme: kapsam dışı bırakılan iş ve çökme ANLATISI. Genel
// olumsuzluk ("yasak", "yok") burada BİLEREK yoktur — bkz. classifyJob.
const MACHINE_SKIP = /kapsam disi|out of scope|kilitlen|reset at|\bcoktu\b|\bcokme/;

/** Türkçe harf-duyarsız küçük harf + ASCII katlama (İ/ı tuzağı dahil). */
function normalize(text) {
  return String(text == null ? '' : text)
    .replace(/İ/g, 'i')
    .replace(/I/g, 'ı')
    .toLowerCase()
    .replace(/ı/g, 'i')
    .replace(/ş/g, 's')
    .replace(/ğ/g, 'g')
    .replace(/ü/g, 'u')
    .replace(/ö/g, 'o')
    .replace(/ç/g, 'c');
}

function isWeight(v) {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(WEIGHTS, v);
}

function isMachineClass(v) {
  return v === 'bu-makine' || v === 'diger-makine';
}

/** "ağır"/"agir"/"heavy" gibi yazımları kanonik ada çevir; tanınmazsa null. */
function parseWeight(v) {
  const n = normalize(v).trim();
  if (isWeight(n)) return n;
  if (n === 'light') return 'hafif';
  if (n === 'medium') return 'orta';
  if (n === 'heavy') return 'agir';
  return null;
}

function parseMachineClass(v) {
  const n = normalize(v).trim().replace(/\s+/g, '-');
  if (isMachineClass(n)) return n;
  if (n === 'this' || n === 'local' || n === 'this-machine') return 'bu-makine';
  if (n === 'other' || n === 'remote' || n === 'other-machine') return 'diger-makine';
  return null;
}

/**
 * İşi sınıfla. Açık alan (`agirlik`, `makine`) her zaman kazanır ve kaynak `alan`
 * olarak yazılır; yoksa kural tablosu uygulanır ve kaynak `tahmin` olur.
 *
 * @param {{objective?: string, agirlik?: string, makine?: string}} input
 * @returns {{agirlik: string, agirlikKaynak: 'alan'|'tahmin', makine: string,
 *            makineKaynak: 'alan'|'tahmin', kurallar: string[]}}
 */
function classifyJob(input) {
  const i = input && typeof input === 'object' ? input : {};
  const all = normalize(i.objective).split('\n');
  const usable = (l) => !NEGATION.test(l) && !META.test(l);
  // Ağırlık: tüm kullanılabilir satırlar (yanlış pozitifin bedeli yalnız BEKLEMEK).
  const lines = all.filter(usable);
  // Makine sınıfı: TÜM metin, OLUMSUZ SATIR ELEMESİ YOK — yalnız kuralı tanımlayan meta
  // satırlar düşer. Ölçüldü (rapor §4.3): 22.09'u kilitleyen iki kart da "Mac'te ağır
  // koşum YASAK" satırını taşıyordu ve iş "küçük ölçekte dene" diye aynı satırda
  // verilmişti; olumsuz-satır elemesi tam o boşluktu. Bedel asimetrik: yanlış pozitif
  // = iş bekler ve lider `makine: bu-makine` kaçışını tek cümlede duyar; yanlış negatif
  // = makine çöker, uçuştaki her iş ölür.
  const machineLines = all.filter((l) => !META.test(l) && !MACHINE_SKIP.test(l));
  const hits = [];
  for (const rule of RULES) {
    const scope = rule.alan === 'sinif' ? machineLines : lines;
    if (scope.some((l) => rule.desen.test(l))) hits.push(rule);
  }
  const explicitWeight = parseWeight(i.agirlik);
  const explicitMachine = parseMachineClass(i.makine);

  let agirlik = explicitWeight;
  if (!agirlik) {
    const found = hits.filter((r) => r.alan === 'agirlik').map((r) => r.deger);
    agirlik = found.length ? found.reduce((a, b) => (WEIGHTS[b] > WEIGHTS[a] ? b : a)) : 'orta';
  }
  const machineHit = hits.find((r) => r.alan === 'sinif');
  const makine = explicitMachine || (machineHit ? machineHit.deger : 'bu-makine');

  return {
    agirlik,
    agirlikKaynak: explicitWeight ? 'alan' : 'tahmin',
    makine,
    makineKaynak: explicitMachine ? 'alan' : 'tahmin',
    // Hangi kuralların eşleştiği KAYDA girer ("neden ağır dedin?" sorusu cevaplanır).
    kurallar: hits.map((r) => r.ad),
  };
}

/** Puan = ağırlık × aynı anda açılacak pane sayısı (en az 1). */
function pointsFor(agirlik, panes) {
  const w = WEIGHTS[isWeight(agirlik) ? agirlik : 'orta'];
  const n = Number.isFinite(panes) && panes > 0 ? Math.floor(panes) : 1;
  return w * n;
}

/**
 * RG-MODE-01 — AYNI ANDA KAÇ AĞIR İŞ (saf). `clamp(floor((GB − 4) / 6), 1, max(1, floor(P / 2)))`.
 * GB `resourceGovernor.roundedTotalGB` ile aynı kuralla yuvarlanır (Windows "4 GB"ı 3,8 GiB bildirir;
 * kural burada yinelenir çünkü bu modül renderer'da da yüklenir — eşitlik birim testinde).
 * Bellek okunamazsa `null` = yuva sınırı YOK (fail-open). Çekirdek okunamazsa yalnız bellek terimi.
 *   4 GB → 1 · 8 GB → 1 · 16 GB/8P → 2 · 24 GB → 3 · 36 GB/10P → 5 · 64 GB/12P → 6
 * @param {{totalBytes?: number, perfCores?: number}} m
 * @returns {number|null}
 */
function heavySlotsFor(m) {
  const x = m && typeof m === 'object' ? m : {};
  const total = Number(x.totalBytes);
  if (!Number.isFinite(total) || total <= 0) return null;
  const gb = Math.round(total / GIB);
  const byMem = Math.max(1, Math.floor((gb - 4) / 6));
  const p = Number(x.perfCores);
  if (!Number.isFinite(p) || p <= 0) return byMem;
  return Math.min(byMem, Math.max(1, Math.floor(p / 2)));
}

/** Elle tavan: 1–64 tam sayı; boş/bozuk/aralık dışı = null (otomatik). */
function manualCount(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isInteger(n) && n >= MANUAL_MIN && n <= MANUAL_MAX ? n : null;
}

/**
 * Ayar şekli: tanınmayan/bozuk değer varsayılana düşer (asla fırlatmaz). İdempotent:
 * çıktısı yeniden verilirse aynı sonuç çıkar (renderer main'in sonucunu yeniden normalize eder).
 *
 * RG-MODE-01 — GÖÇ (ayrı göç kodu yok, dosya yeniden yazılmaz):
 *   `mode` geçerliyse o · yoksa `enabled:false` → off · `onExceed:'queue'` → strict · diğer → auto.
 *   Eski dosyadaki `cap` yalnız 8'den (0.3.0 sabiti) FARKLIYSA elle tavan sayılır: 8 Murat'ın
 *   "çok kötü" dediği varsayılandı, kullanıcı seçimi değil.
 * `machine` ({totalBytes, perfCores}) main'in donanım okumasıdır; dosyaya yazılmaz.
 * Türetilen alanlar: `enabled`/`onExceed` (eski okuyucular için), `slots` (etkin ağır iş yuvası,
 * null = sınırsız), `budgetCap` (sıkı kipin etkin puan tavanı).
 */
function normalizeConfig(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const lpc = Number(r.loadPerCpu);
  const mar = Number(r.minAvailRatio);
  const legacy = !MODES.includes(r.mode);
  const mode = !legacy ? r.mode : r.enabled === false ? 'off' : r.onExceed === 'queue' ? 'strict' : DEFAULT_MODE;
  const legacyCap = manualCount(r.cap);
  const cap = legacy && legacyCap === DEFAULT_CAP ? null : legacyCap;
  const heavySlots = manualCount(r.heavySlots);
  const mx = r.machine && typeof r.machine === 'object' ? r.machine : null;
  const machine = mx ? { totalBytes: Number(mx.totalBytes) || null, perfCores: Number(mx.perfCores) || null } : null;
  const autoSlots = heavySlotsFor(machine);
  const slots = heavySlots != null ? heavySlots : autoSlots;
  return {
    mode,
    enabled: mode !== 'off',
    onExceed: mode === 'strict' ? 'queue' : DEFAULT_ON_EXCEED,
    heavyFull: r.heavyFull === 'warn' ? 'warn' : DEFAULT_HEAVY_FULL,
    heavySlots,
    cap,
    machine,
    autoSlots,
    slots,
    budgetCap: cap != null ? cap : slots != null ? slots * STRICT_POINTS_PER_SLOT : DEFAULT_CAP,
    // K46 — ses/model/veri yönlendirmesi AYRI anahtar; `mode:'off'` onu kapatmaz.
    otherMachine: r.otherMachine !== false,
    loadPerCpu: Number.isFinite(lpc) && lpc > 0 ? lpc : DEFAULT_LOAD_PER_CPU,
    minAvailRatio: Number.isFinite(mar) && mar > 0 && mar < 1 ? mar : DEFAULT_MIN_AVAIL_RATIO,
  };
}

/** Ayar dosyasının adı (hesap veri kökünde: `instancePaths.agentdeskHome()`/machine-budget.json). */
const CONFIG_FILE = 'machine-budget.json';

/**
 * QUEUE-NEVER-STUCK-01 — ayar dosyasının TEK yolu + eski yollardan göç.
 *
 * Ölçüldü (02.10): kod yorumu `~/.agentdesk/` diyordu, main ise `path.join(os.homedir(), …)`
 * = `~/machine-budget.json` okuyordu. Murat'ın acil `{"enabled": false}` yazımı üç ayrı yola
 * yapılmak zorunda kaldı. Artık dosya diğer hesap defterleriyle (delegation-queue.json)
 * AYNI kökte: `home` (çağıran `instancePaths.agentdeskHome(...)` verir).
 *
 * Göç: yeni yolda dosya yoksa eski yollardan İLK bulunan KOPYALANIR (silinmez — eski sürüm
 * aynı makinede yeniden açılırsa kendi dosyasını bulsun). Asla fırlatmaz.
 *
 * @param {{home: string, legacy: string[], fs: object, path: object}} deps
 * @returns {{file: string, migratedFrom: string|null}}
 */
function resolveConfigFile(deps) {
  const d = deps || {};
  const file = d.path.join(d.home, CONFIG_FILE);
  let migratedFrom = null;
  try {
    if (!d.fs.existsSync(file)) {
      for (const dir of d.legacy || []) {
        const old = d.path.join(dir, CONFIG_FILE);
        if (old === file || !d.fs.existsSync(old)) continue;
        d.fs.mkdirSync(d.path.dirname(file), { recursive: true });
        d.fs.copyFileSync(old, file);
        migratedFrom = old;
        break;
      }
    }
  } catch {
    migratedFrom = null;
  }
  return { file, migratedFrom };
}

/** QUEUE-NEVER-STUCK-01 — izlenmeyen pencere bu kadar süre içinde çıktı ürettiyse "çalışıyor" sayılır. */
const FOREIGN_ACTIVE_MS = 60000;

/**
 * QUEUE-NEVER-STUCK-01 — İZLENMEYEN AJAN PENCERELERİ (saf). Delegasyon motorunun AÇMADIĞI
 * (elle/eski yolla açılmış) ajan pane'leri. Yalnız son `FOREIGN_ACTIVE_MS` içinde çıktı
 * üretenler `active` olur ve bütçeye sayılır; boştakiler sayılmaz (02.10: "boşta mı çalışıyor
 * mu bilemiyor" belirsizliği ölçümle kapanır). Lider pane'i ve çıkmış pane listeye girmez.
 *
 * @param {Array<{paneId: string, agentId?: string|null, label?: string|null, isLeader?: boolean,
 *          exited?: boolean, lastDataAt?: number, startedAt?: number}>} panes
 * `claimed`: süpervizör defterinin BİTMEMİŞ kayıtları. Bir kayıt pane'i yalnız AJAN ADI tutuyorsa
 * sahiplenir (QUEUE-NEVER-STUCK-01b): defter süreçler arası kalıcı, pane kimliği ise her süreçte
 * yeniden başlar — kimlik tek başına eski bir kaydı yeni bir pane'e bağlayabilir.
 *
 * @param {{now: number, own?: Iterable<string>, claimed?: Array<{paneId: string, agentId?: string|null}>, activeMs?: number}} opts
 */
function foreignPanes(panes, opts) {
  const o = opts || {};
  const own = new Set(o.own || []);
  const claimed = Array.isArray(o.claimed) ? o.claimed : [];
  const claimedBy = (p) => claimed.some((c) => c && c.paneId === p.paneId && (!c.agentId || c.agentId === p.agentId));
  const now = Number.isFinite(o.now) ? o.now : Date.now();
  const activeMs = Number.isFinite(o.activeMs) ? o.activeMs : FOREIGN_ACTIVE_MS;
  const out = [];
  for (const p of Array.isArray(panes) ? panes : []) {
    if (!p || !p.paneId || p.exited || p.isLeader || !p.agentId || own.has(p.paneId) || claimedBy(p)) continue;
    const last = Number(p.lastDataAt) || Number(p.startedAt) || 0;
    out.push({
      paneId: p.paneId,
      agentId: p.agentId || null,
      label: p.label || null,
      active: last > 0 && now - last < activeMs,
      lastOutputAt: last,
    });
  }
  return out;
}

/**
 * Ayarı oku: dosya (kalıcı, Murat elle düzenler) → ortam değişkeni (tek koşuşluk
 * kontrol kolu / test dikişi) sırasıyla üst üste biner. Dosya yok/bozuk → varsayılan.
 *
 *   AGENTSPACE_MACHINE_BUDGET=off            → Kapalı
 *   AGENTSPACE_MACHINE_BUDGET=auto|warn      → Otomatik (varsayılan)
 *   AGENTSPACE_MACHINE_BUDGET=on             → Kapalı ise Otomatik; dosyadaki Sıkı korunur
 *   AGENTSPACE_MACHINE_BUDGET=strict|queue   → Sıkı (0.3.0 davranışı; kontrol kolu)
 *   AGENTSPACE_MACHINE_BUDGET_CAP=<n>        → Sıkı kipin elle tavanı
 *   AGENTSPACE_MACHINE_HEAVY_SLOTS=<n>       → Otomatik kipin elle ağır iş yuvası
 * `machine`: main'in donanım okuması ({totalBytes, perfCores}); dosyadakini ezer.
 */
function loadConfig(deps) {
  const d = deps || {};
  let fromFile = {};
  try {
    if (d.file && typeof d.readFileSync === 'function') {
      const j = JSON.parse(String(d.readFileSync(d.file, 'utf8')));
      if (j && typeof j === 'object') fromFile = j;
    }
  } catch {
    fromFile = {};
  }
  const env = d.env || {};
  const merged = { ...fromFile };
  const sw = normalize(env.AGENTSPACE_MACHINE_BUDGET).trim();
  if (sw === 'off' || sw === '0' || sw === 'false') merged.mode = 'off';
  if (sw === 'auto' || sw === 'warn') merged.mode = 'auto';
  if (sw === 'strict' || sw === 'queue') merged.mode = 'strict';
  // 'on' eskiden yalnız "açık" demekti: dosyadaki Sıkı seçimini ezmez, yalnız Kapalı'yı açar.
  if ((sw === 'on' || sw === '1' || sw === 'true') && normalizeConfig(merged).mode === 'off') merged.mode = 'auto';
  if (env.AGENTSPACE_MACHINE_BUDGET_CAP != null && env.AGENTSPACE_MACHINE_BUDGET_CAP !== '') {
    merged.cap = Number(env.AGENTSPACE_MACHINE_BUDGET_CAP);
    if (!MODES.includes(merged.mode)) merged.mode = normalizeConfig(merged).mode; // env tavanı 8 olsa da elle sayılsın
  }
  if (env.AGENTSPACE_MACHINE_HEAVY_SLOTS != null && env.AGENTSPACE_MACHINE_HEAVY_SLOTS !== '') merged.heavySlots = Number(env.AGENTSPACE_MACHINE_HEAVY_SLOTS);
  if (d.machine && typeof d.machine === 'object') merged.machine = d.machine;
  return normalizeConfig(merged);
}

/**
 * KABUL HÜKMÜ (saf). Sıra bilinçlidir: kapı kapalı → bugünkü davranış; diğer-makine
 * işi bütçeye bakmadan reddedilir (bu makinede HİÇ koşmaz); sonra bütçe; en son,
 * yalnız ağır iş için sağlık.
 *
 * RG-MODE-01 — üç kip:
 *   off    → `{ok, gate:'off'}`; diğer-makine yönlendirmesi AYRI anahtardır (K46, `otherMachine`).
 *   auto   → hafif/orta iş HİÇ beklemez. Ağır iş: uçuştaki ağır pane sayısı (`heavyRunning`) +
 *            bu işin pane'i yuvayı (`slots`) aşarsa K42-A: `{ok:false, gate:'budget', heavy:true}`
 *            (kuyrukta "Şimdi başlat"); `heavyFull:'warn'` (K42-B) başlatıp bildirir. Sağlık yalnız
 *            gerçek KRİTİKte (K43, GOV-HYST-01) bekletir. Makine boşken (0 ağır iş) tek başına
 *            yuvayı aşan iş yine başlar. `slots` null (ölçülemedi) = sınır yok.
 *   strict → 0.3.0 puan bütçesi, tavan `budgetCap` (yuva × 4), sağlık uyarısında da bekletir.
 *
 * Bütçe istisnası (strict): makine BOŞKEN (used=0) tek başına tavanı aşan iş yine kabul edilir —
 * aksi hâlde 3 pane'lik ağır iş (12 puan > 8) sonsuza dek kuyrukta çürürdü.
 *
 * @param {{job: {agirlik: string, makine: string}, panes: number, usedPoints: number,
 *          heavyRunning?: number, config: object, health?: {over: boolean} | null}} input
 */
function decideAdmission(input) {
  const i = input && typeof input === 'object' ? input : {};
  const cfg = normalizeConfig(i.config);
  const job = i.job && typeof i.job === 'object' ? i.job : { agirlik: 'orta', makine: 'bu-makine' };
  const panes = Number.isFinite(i.panes) && i.panes > 0 ? Math.floor(i.panes) : 1;
  const heavy = job.agirlik === 'agir';
  if (job.makine === 'diger-makine' && cfg.otherMachine) {
    return { ok: false, gate: 'other-machine', mode: cfg.mode, need: pointsFor(job.agirlik, panes), used: 0, cap: cfg.budgetCap };
  }
  if (cfg.mode === 'auto') {
    const running = Number.isFinite(i.heavyRunning) && i.heavyRunning > 0 ? Math.floor(i.heavyRunning) : 0;
    const base = { mode: 'auto', need: heavy ? panes : 0, used: running, cap: cfg.slots };
    if (!heavy) return { ok: true, gate: 'admit', ...base };
    if (cfg.slots != null && running > 0 && running + panes > cfg.slots) {
      return cfg.heavyFull === 'warn'
        ? { ok: true, gate: 'admit', warn: 'budget', heavy: true, ...base }
        : { ok: false, gate: 'budget', heavy: true, ...base };
    }
    if (i.health && i.health.over === true) return { ok: false, gate: 'health', ...base, health: i.health };
    return { ok: true, gate: 'admit', ...base };
  }
  const need = pointsFor(job.agirlik, panes);
  const used = Number.isFinite(i.usedPoints) && i.usedPoints > 0 ? i.usedPoints : 0;
  const base = { mode: cfg.mode, need, used, cap: cfg.budgetCap };
  if (cfg.mode === 'off') return { ok: true, gate: 'off', ...base };
  if (used > 0 && used + need > cfg.budgetCap) return { ok: false, gate: 'budget', ...base };
  if (heavy && i.health && i.health.over === true) return { ok: false, gate: 'health', ...base, health: i.health };
  return { ok: true, gate: 'admit', ...base };
}

/**
 * Lidere/patrona gidecek TEK CÜMLE. İç terim (puan formülü, dosya adı) içermez;
 * sayılar kullanıcının göreceği bütçe satırıyla aynıdır.
 */
function admissionMessage(verdict, job) {
  const v = verdict || {};
  const j = job || {};
  // QUEUE-NEVER-STUCK-01 — patron ("Şimdi başlat") ya da lider (`simdi: true`) beklemeyi atladı.
  if (v.forced) return 'İş beklemeden başlatıldı (Şimdi başlat).';
  // MACHINE-BUDGET-BLOCK-01 — aşım BİLGİSİ: iş başladı, cümle bunu söyler (kuyruk yok).
  if (v.warn === 'budget' && v.heavy) {
    return `Aynı anda çalışabilecek ağır iş sınırı dolu (${v.used}/${v.cap}). İş beklemeden başlatıldı.`;
  }
  if (v.warn === 'budget') {
    return Number.isFinite(v.running) && v.running > 1
      ? `Makine yoğun: bu işle birlikte aynı anda ${v.running} iş çalışıyor. İş beklemeden başlatıldı.`
      : 'Makine yoğun: aynı anda çok iş çalışıyor. İş beklemeden başlatıldı.';
  }
  if (v.warn === 'health') return `Makine şu an yüklü (${healthPhrase(v.health)}). İş beklemeden başlatıldı.`;
  switch (v.gate) {
    case 'other-machine':
      // OTHER-MACHINE-QUEUE-01 — "diğer makine kuyruğu"nu işleyen kod YOK: iş hiçbir yerde
      // sırada değil, kendiliğinden başlamaz. Board satırı yalnız GERÇEKTEN backlog'a
      // indiyse anılır (`v.board === 'backlog'`); aksi hâlde iddia edilmez.
      return (
        'Bu iş ses/model/veri işi olduğu için bu makinede başlatılmadı. Başka bir makinede elle başlatman gerekiyor' +
        (v.board === 'backlog' ? "; iş kartı board'da backlog'a alındı." : '.')
      );
    case 'aging':
      // QUEUE-NEVER-STUCK-01 (EK) — açlık koruması: sığan iş normalde beklemez; ama makinede
      // uzun süredir yer bekleyen bir iş varsa yeni işler onun önüne geçmez.
      return 'Makinede uzun süredir yer bekleyen bir iş var; aç kalmasın diye bu iş onun arkasında, o başlayınca başlar.';
    case 'order':
      // QUEUE-NEVER-STUCK-01 — sıra AJAN BAŞINA: yalnız aynı ajanı bekleyen eski iş bu işi tutar.
      return 'Aynı ajan için önünde bekleyen bir iş var; o başlayınca bu da sırayla başlar.';
    case 'budget':
      // Bariyer: bütçe DOLU değil, önde yer bekleyen daha eski bir iş var — ayrı söylenir.
      if (v.behind) return 'Aynı ajan için önünde bekleyen bir iş var; o başlayınca bu da sırayla başlar.';
      // RG-MODE-01 (K42-A) — Otomatik: yalnız ağır iş, yalnız yuva doluyken bekler; "Şimdi başlat" var.
      if (v.heavy) return `Aynı anda çalışabilecek ağır iş sınırı dolu (${v.used}/${v.cap}); bu ağır iş sırada, biri bitince başlar. Patron kuyruktan "Şimdi başlat" diyebilir.`;
      return `Makine bütçesi yetmiyor (dolu: ${v.used}/${v.cap}, bu iş: ${v.need}); iş kuyrukta, yer açılınca sırası gelince başlar.`;
    case 'health':
      return `Makine şu an yüklü (${healthPhrase(v.health)}); ağır iş kuyrukta, yük düşünce başlar.`;
    default:
      return j.agirlik ? `İş kabul edildi (${j.agirlik}).` : 'İş kabul edildi.';
  }
}

/**
 * OTHER-MACHINE-QUEUE-01 — board kartının açıklamasına eklenen TEK satır (neden + tarih).
 * @param {number} at epoch ms
 */
function otherMachineBoardNote(at) {
  const day = new Date(Number.isFinite(at) ? at : Date.now()).toISOString().slice(0, 10);
  return `> ${day} — Bu iş ses/model/veri işi olduğu için bu makinede başlatılmadı; başka bir makinede elle başlatılmalı. Kart bu yüzden backlog'a alındı.`;
}

function healthPhrase(h) {
  const x = h || {};
  const parts = [];
  // GOV-HYST-01 — "baskı" yalnız GERÇEKTE (kritik). Uyarı bir eğilimdir: "azalıyor".
  if (x.memory === 'critical' && x.stallOnly) {
    parts.push(Number.isFinite(x.stallSec) ? `uygulama ${x.stallSec} sn yanıt vermedi` : 'uygulama yanıt vermedi');
  } else if (x.memory === 'critical') parts.push('bellek baskısı var');
  else if (x.memory === 'warn') {
    const pct = Number.isFinite(x.availRatio) ? Math.round(x.availRatio * 100) : null;
    parts.push(pct == null ? 'bellek azalıyor' : `bellek azalıyor, %${pct} boş`);
  }
  if (Number.isFinite(x.loadPerCpu) && x.loadOver) parts.push(`yük ${x.loadPerCpu.toFixed(1)}/çekirdek`);
  return parts.join(', ') || 'eşik aşıldı';
}

/**
 * TEK ATIM makine sağlığı okuması (main süreçte). Sürekli döngü YOK: yalnız ağır iş
 * kabulü sorulduğunda bir kez çağrılır.
 *
 *   macOS  : `kern.memorystatus_vm_pressure_level` (1 normal, 2 uyarı, 4 kritik) — kaynak
 *            bekçisinin SON ölçümünden okunur (PERF-GOV-ASYNC-01): bekçi bu değeri açık ya
 *            da kapalı her durumda 5 sn'de bir asenkron ölçer. Burada senkron alt süreç
 *            KOŞMAZ (kabul senkron IPC'de; bellek baskısında sysctl 1 sn'ye kadar sürerdi).
 *            Bekçinin ≤ 30 sn'lik ölçümü yoksa 'unknown' (fail-open, reddetmez).
 *            `os.freemem()` macOS'ta KULLANILMAZ — önbellek yüzünden baskı "normal"ken
 *            %2,6 ölçüldü (rapor §ölçüm); onunla her ağır iş reddedilirdi.
 *   Linux  : /proc/meminfo MemAvailable / MemTotal.
 *   Windows: os.freemem() / os.totalmem() (Windows'ta boş bellek önbelleği saymaz).
 *   Yük    : os.loadavg()[0] / çekirdek. Windows'ta loadavg hep [0,0,0] döner →
 *            "ölçülemedi" (null) yazılır, 0 DEĞİL; tek başına reddetmez.
 *
 * @param {{platform?: string, os: object, readFileSync?: Function, governor?: object|null,
 *          config?: object}} deps
 */
function readMachineHealth(deps) {
  const d = deps || {};
  const os = d.os;
  const cfg = normalizeConfig(d.config);
  const platform = d.platform || process.platform;
  const t0 = Date.now();
  let memory = 'unknown';
  let availRatio = null;
  let stallOnly = false;
  let stallSec = null;
  // ÖNCE YENİDEN KULLAN: main'in kaynak bekçisi (PANE-CAP-01 resourceGovernor) belleği
  // zaten 5 sn'de bir örnekliyor (OS baskısı + takas + ana süreç durması dahil). Son
  // örneği tazeyse (≤ 30 sn) ve bekçi açıksa O kullanılır: ek ölçüm SIFIR, iki kapı
  // aynı gerçeğe bakar. Bekçi ölçmemiş/kapalı/bayatsa aşağıdaki kendi tek atımına düşer.
  const g = d.governor;
  const fresh = g && g.measured === true && Number.isFinite(g.at) && t0 - g.at <= 30000 && !(g.settings && g.settings.enabled === false);
  let kaynak = 'kendi';
  if (fresh) {
    kaynak = 'bekci';
    const byLevel = g.level === 'critical' ? 'critical' : g.level === 'warn' ? 'warn' : 'normal';
    // OS hükmü bekçinin kendi bayrağından (osPressureGate) bağımsız okunur: bir ÖLÇÜMdür.
    const byOs = g.osPressure >= 4 ? 'critical' : g.osPressure >= 2 ? 'warn' : 'normal';
    const rank = { normal: 0, warn: 1, critical: 2 };
    memory = rank[byOs] > rank[byLevel] ? byOs : byLevel;
    if (Number.isFinite(g.freePct)) availRatio = g.freePct / 100;
    // GOV-HYST-01 — R15'teki 6 gerçek kritiğin HEPSİ ana süreç durmasıydı, bellek değil.
    // Kritik yalnız durmadan geliyorsa cümle "bellek baskısı" değil durmayı söyler.
    const codes = Array.isArray(g.reasonCodes) ? g.reasonCodes.map((r) => r && r.code) : [];
    if (memory === 'critical' && codes.includes('stall') && !codes.includes('free-critical') && !codes.includes('os-critical') && byOs !== 'critical') {
      stallSec = Number.isFinite(g.stallMs) ? +(g.stallMs / 1000).toFixed(1) : null;
      stallOnly = true;
    }
  }
  try {
    if (fresh) {
      /* bekçinin örneği kullanıldı — komut koşmaz */
    } else if (platform === 'darwin') {
      // Bekçi kapalı / seviyesi ölçülmemiş ama OS baskısı ölçülmüş: aynı sysctl değeri.
      const osFresh = g && Number.isFinite(g.osPressure) && Number.isFinite(g.at) && t0 - g.at <= 30000;
      const lvl = osFresh ? g.osPressure : NaN;
      if (osFresh) kaynak = 'bekci-os';
      memory = lvl >= 4 ? 'critical' : lvl >= 2 ? 'warn' : lvl === 1 ? 'normal' : 'unknown';
    } else if (platform === 'linux' && typeof d.readFileSync === 'function') {
      const txt = String(d.readFileSync('/proc/meminfo', 'utf8'));
      const kb = (k) => Number((txt.match(new RegExp(`^${k}:\\s+(\\d+)`, 'm')) || [])[1]);
      const total = kb('MemTotal');
      const avail = kb('MemAvailable');
      if (total > 0 && Number.isFinite(avail)) availRatio = avail / total;
    } else if (os && typeof os.freemem === 'function') {
      const total = os.totalmem();
      if (total > 0) availRatio = os.freemem() / total;
    }
  } catch {
    memory = 'unknown';
  }
  if (!fresh && availRatio !== null) memory = availRatio < cfg.minAvailRatio / 2 ? 'critical' : availRatio < cfg.minAvailRatio ? 'warn' : 'normal';

  let loadPerCpu = null;
  try {
    const cpus = os && typeof os.cpus === 'function' ? os.cpus().length : 0;
    const l1 = os && typeof os.loadavg === 'function' ? os.loadavg()[0] : NaN;
    // Windows: loadavg [0,0,0] — ölçüm değil. 0'ı "yük yok" diye okumak yalan olurdu.
    if (cpus > 0 && Number.isFinite(l1) && !(platform === 'win32' && l1 === 0)) loadPerCpu = l1 / cpus;
  } catch {
    loadPerCpu = null;
  }
  const loadOver = loadPerCpu !== null && loadPerCpu > cfg.loadPerCpu;
  // GOV-HYST-01 (K43 = R15 K3, seçenek A) — kabulü yalnız GERÇEK baskı etkiler: bellek
  // KRİTİK ya da yük eşiği. Ölçüldü (R15, 56,7 sa): 'warn' sürenin %29,6'sı, gerçek kritik
  // %0,1; 0.3.0'da iki yayın işi 'warn' yüzünden 4,1'er dk bekledi (yük 0,27–0,44/çekirdek).
  // `warn` bilgi olarak `memory` alanında kalır. Sıkı kip eski davranışı korur: bugün
  // `mode:'strict'` (eski `onExceed:'queue'` dosyası normalizeConfig'te strict'e göçer).
  const strict = cfg.mode === 'strict';
  const memOver = memory === 'critical' || (strict && memory === 'warn');
  return {
    at: t0,
    platform,
    kaynak,
    memory,
    availRatio,
    loadPerCpu,
    loadOver,
    strict,
    stallOnly,
    stallSec,
    over: memOver || loadOver,
    tookMs: Date.now() - t0,
  };
}

/**
 * Sağlık şeridi satırı (renderer kurar; metin i18n'dedir, burada yalnız SAYILAR).
 * @returns {{enabled: boolean, used: number, cap: number, otherMachine: number,
 *            waitingBudget: number}}
 */
function budgetSummary(input) {
  const i = input && typeof input === 'object' ? input : {};
  const cfg = normalizeConfig(i.config);
  // RG-MODE-01 — Otomatik'te satır ağır işi sayar (used = uçuştaki ağır pane, cap = yuva);
  // yuva ölçülemediyse tavan yok → satır "sınır yok" der (enabled:false), sahte bir sayı göstermez.
  const auto = cfg.mode === 'auto';
  return {
    mode: cfg.mode,
    enabled: cfg.enabled && !(auto && cfg.slots == null),
    onExceed: cfg.onExceed,
    used: auto ? (Number.isFinite(i.heavyRunning) ? i.heavyRunning : 0) : Number.isFinite(i.usedPoints) ? i.usedPoints : 0,
    cap: auto ? cfg.slots || 0 : cfg.budgetCap,
    otherMachine: Number.isFinite(i.otherMachine) ? i.otherMachine : 0,
    waitingBudget: Number.isFinite(i.waitingBudget) ? i.waitingBudget : 0,
  };
}

module.exports = {
  WEIGHTS,
  WEIGHT_NAMES,
  MACHINE_CLASSES,
  DEFAULT_CAP,
  DEFAULT_LOAD_PER_CPU,
  DEFAULT_MIN_AVAIL_RATIO,
  GATES,
  ON_EXCEED,
  DEFAULT_ON_EXCEED,
  MODES,
  DEFAULT_MODE,
  MANUAL_MIN,
  MANUAL_MAX,
  HEAVY_FULL,
  DEFAULT_HEAVY_FULL,
  STRICT_POINTS_PER_SLOT,
  heavySlotsFor,
  RULES,
  NEGATION,
  META,
  MACHINE_SKIP,
  normalize,
  parseWeight,
  parseMachineClass,
  classifyJob,
  pointsFor,
  normalizeConfig,
  CONFIG_FILE,
  resolveConfigFile,
  FOREIGN_ACTIVE_MS,
  foreignPanes,
  loadConfig,
  decideAdmission,
  admissionMessage,
  healthPhrase,
  otherMachineBoardNote,
  readMachineHealth,
  budgetSummary,
};
