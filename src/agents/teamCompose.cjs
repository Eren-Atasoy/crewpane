// TC-01 — TAKIM KURUCU ÇEKİRDEĞİ (ADR-TEAM-COMPOSER §4-§5 + §9).
//
// Bu modül `crewpane_team_compose` aracının KARAR katmanıdır: rol süzgeci,
// tavanlar, onay jetonu ve geri-alma günlüğü. Yazma yapmaz, ağa çıkmaz, modele
// istek atmaz (§9.2 — "uygulama kendi başına LLM çağırmaz").
//
// ─────────────────────────────────────────────────────────────────────────────
// NEDEN BAĞIMLILIKSIZ (fs/os/path/electron YOK)
// ─────────────────────────────────────────────────────────────────────────────
// Aynı süzgecin İKİ tarafta da koşması gerekiyor: main (köprü kapısı) ve renderer
// (kartı çizen taraf, kullanıcının düzenlemesini geri gönderir). İki kopya =
// iki farklı "geçerli satır" tanımı; ilk kayan kopya katalog dışı bir rolü ya da
// bir PARA alanını ekrana taşır. `teamResolve.cjs` deseni: saf `.cjs` + `.d.cts`
// → hem `require` hem renderer `import` aynı dosyayı görür, `node --test` de
// doğrudan yükler.
//
// ─────────────────────────────────────────────────────────────────────────────
// ZAMAN VE RASTGELELİK ENJEKTE EDİLİR
// ─────────────────────────────────────────────────────────────────────────────
// `createComposeLedger({ now, randomId })` — TTL, tek-kullanımlık jeton ve 10 dk'lık
// geri alma penceresi ancak zaman dikişi dışarıdan verilirse DETERMİNİST test
// edilebilir. Üretimde varsayılanlar `Date.now` + `crypto.randomUUID`dir.

'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// SABİTLER
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ADR §4.1-3 + §5 — TAVANLAR. Gerekçe emsallerden ölçüldü (ADR §3): ajan sayısı
 * arttıkça koordinasyon maliyeti ve arıza oranı DOĞRUSAL OLMAYAN biçimde yükseliyor.
 * Sayılar burada VERİDİR; kullanıcıya çıkan cümle bunlardan türer (uydurulmaz).
 */
const CAPS = Object.freeze({
  /** Bir önerideki çalışan satırı. */
  maxEmployees: 6,
  /** Bir öneride açılabilecek takım. */
  maxTeams: 1,
  /** Bir UYGULAMA OTURUMUNDA uygulanabilecek kurulum. */
  maxInstallsPerSession: 3,
});

/** Öneri ve onay penceresi: teklif 10 dk sonra apply EDİLEMEZ. */
const PROPOSAL_TTL_MS = 10 * 60_000;
/** ADR §4.4 — geri alma penceresi. Uygulama kapanırsa pencere de kapanır. */
const UNDO_TTL_MS = 10 * 60_000;

/**
 * TC-05 — patronun cümlesinin kartta gösterilen üst sınırı. Kart bir ALINTI çizer:
 * lider aracın `objective` alanına bir sayfa metin koyarsa kartın kendisi okunmaz hâle
 * gelir. Kesme kartta DEĞİL burada yapılır — kart olayın yükünü olduğu gibi çizer.
 */
const OBJECTIVE_MAX = 280;

/** §9.7 — ayarın üç kademesi. Sıra ÖNEMLİ: soldan sağa artan özerklik. */
const AUTONOMY_LEVELS = Object.freeze(['ask', 'small-auto', 'auto']);
const DEFAULT_AUTONOMY = 'ask';

/** Aracın aksiyonları (ADR §4). */
const ACTIONS = Object.freeze(['propose', 'apply', 'undo']);

/**
 * Öneri modları (ADR §4): yeni takım mı, mevcut takıma tek koltuk mu — ve TC-07 ile
 * `engine`: MEVCUT çalışan(lar)ın motorunu değiştir (satır yazmaz, `employees.engine`
 * günceller; pane açıksa HATA-12 şeridi "Yeni motorla yeniden başlat"ı kendisi çizer).
 * Eren 20.09: "yeni çalışan eklemeye gerek yok, mevcut frontendçiyi Codex olarak
 * çalıştırabilmeli."
 */
const MODES = Object.freeze(['team', 'role', 'engine']);

/**
 * TC-07 — SERBEST METİN → KATALOG SLUG'I eşlemesi (`nearestRoleSlugs`). Liderin
 * "UX Designer"/"tester" gibi yazdığı bir rol katalogda yoksa red cevabı EN YAKIN
 * slug'ı da söyler — lider ikinci denemede doğru çağırsın. Küçük ve elle yazılmış:
 * ikinci bir katalog DEĞİL, yalnız takma-ad → slug köprüsü; slug'ın kendisi yine
 * çağıranın `allowedSlugs`ında olmak ZORUNDA (uydurma slug üretilmez).
 */
const ROLE_ALIASES = Object.freeze({
  design: ['ux', 'ui', 'designer', 'tasarim', 'tasarım', 'tasarimci', 'tasarımcı', 'grafik'],
  frontend: ['front', 'frontend', 'front-end', 'arayuz', 'arayüz', 'react', 'web', 'mobile', 'mobil', 'ios', 'android'],
  backend: ['back', 'backend', 'back-end', 'api', 'server', 'sunucu', 'veritabani', 'veritabanı', 'database'],
  qa: ['qa', 'test', 'tester', 'quality', 'kalite'],
  devops: ['devops', 'ops', 'deploy', 'infra', 'altyapi', 'altyapı', 'sre', 'cloud', 'bulut'],
  security: ['security', 'guvenlik', 'güvenlik', 'pentest'],
  pm: ['pm', 'product', 'urun', 'ürün', 'proje', 'project', 'manager', 'yonetici', 'yönetici'],
  marketing: ['marketing', 'pazarlama', 'growth', 'buyume', 'büyüme', 'reklam'],
  support: ['support', 'destek', 'musteri', 'müşteri', 'customer'],
  'data-engineer': ['data', 'veri', 'analyst', 'analist', 'etl'],
  'code-automation': ['automation', 'otomasyon', 'script', 'bot'],
  'n8n-automation': ['n8n', 'workflow', 'zapier', 'make'],
  'code-review': ['review', 'reviewer', 'inceleme'],
  explorer: ['explorer', 'research', 'arastirma', 'araştırma', 'kesif', 'keşif'],
  seo: ['seo', 'arama'],
  lead: ['lead', 'lider', 'leader', 'takim lideri', 'takım lideri'],
});

/**
 * 🔴 §9.6 — PARA KARTA GİREMEZ. Bu alanlar bir satırda görünürse SİLİNİR (satır
 * düşmez: kullanıcı kartı yine görsün, yalnız tutar görmesin).
 *
 * Gerekçe Eren'in kendi cümlesi: kullanıcı bizden ödeme alınacağını sanıyor.
 * ADR §4.1'in 5. adımındaki hesap main'de KALIR (tavan kontrolü için), kullanıcıya
 * GÖSTERİLMEZ.
 */
const MONEY_FIELDS = Object.freeze([
  'cost', 'costs', 'price', 'pricing', 'usd', 'usd_per_hour', 'hourly', 'rate',
  'budget', 'estimatedCost', 'estimate', 'currency', 'amount', 'monthly', 'credits',
]);

/**
 * §9.5 — YALIN AİLE ADI TEK BAŞINA ETİKET OLAMAZ ("Opus", "Sonnet"…). R3'te
 * kaldırılması istenen biçim tam olarak budur. Satır düşmez; etiket ürünün
 * sağlayıcı adıyla TAMAMLANIR (`composeModelLabel`).
 */
const BARE_MODEL_ALIASES = Object.freeze(['opus', 'sonnet', 'haiku', 'fable', 'opusplan']);

/**
 * §9.5 — "Standart / Hızlı / Güçlü" ekrandan kalkar. Bunlar bir etiketin TAMAMIYSA
 * o etiket kullanılamaz (model id'sine düşülür).
 */
const BANNED_TIER_WORDS = Object.freeze(['standart', 'hızlı', 'hizli', 'güçlü', 'guclu', 'standard', 'fast', 'powerful']);

/** Motor id → ürünün kullandığı SAĞLAYICI adı (etiketin ilk yarısı). */
const ENGINE_PRODUCT_NAMES = Object.freeze({
  claude: 'Claude',
  codex: 'GPT',
  antigravity: 'Gemini',
});

// ─────────────────────────────────────────────────────────────────────────────
// SAF YARDIMCILAR
// ─────────────────────────────────────────────────────────────────────────────

/** Boş-olmayan dize mi (yalnız boşluk YOK sayılır) → dize ya da ''. */
function str(v) {
  return typeof v === 'string' && v.trim() ? v.trim() : '';
}

/** §9.7 — ayar değeri; tanınmayan/çöp değer EN GÜVENLİ kademeye ('ask') düşer. */
function sanitizeAutonomy(raw) {
  const v = str(raw).toLowerCase();
  return AUTONOMY_LEVELS.includes(v) ? v : DEFAULT_AUTONOMY;
}

/** ADR §4 — mod; tanınmayan değer 'team' (öneri = yeni takım). */
function normalizeMode(raw) {
  const v = str(raw).toLowerCase();
  return MODES.includes(v) ? v : 'team';
}

/**
 * ADR §4.1-2 + §9.2 — ROL SÜZGECİ. Katalog dışı slug **SESSİZCE DÜŞER**: lider
 * uydurma bir rol adı yazarsa ürün onu bir `role_templates` satırı sanmaz ve
 * kullanıcıya olmayan bir meslek göstermez.
 *
 * `allowedSlugs` ÇAĞIRANDAN gelir (renderer `globalRoleCatalog.GLOBAL_ROLE_SLUGS`,
 * main aynı listeyi renderer'dan alır) — bu modül ikinci bir katalog TUTMAZ.
 *
 * @param {unknown} roles
 * @param {Iterable<string>} allowedSlugs
 * @param {Iterable<string>} [rejected] oturumda reddedilmiş roller (§4.1-3)
 * @returns {string[]} tekrarsız, sırası korunmuş slug listesi
 */
function sanitizeRoles(roles, allowedSlugs, rejected = []) {
  const allowed = new Set([...(allowedSlugs || [])].map((s) => str(s).toLowerCase()).filter(Boolean));
  const no = new Set([...(rejected || [])].map((s) => str(s).toLowerCase()).filter(Boolean));
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(roles) ? roles : []) {
    const slug = str(raw).toLowerCase();
    if (!slug || seen.has(slug)) continue;
    if (!allowed.has(slug)) continue; // katalog dışı → SESSİZCE düşer
    if (no.has(slug)) continue; // §4.1-3 — reddedilen rol o oturumda tekrar sorulmaz
    seen.add(slug);
    out.push(slug);
  }
  return out;
}

/**
 * §9.5 — MODEL ETİKETİ: "sağlayıcı adı + modelin kendi etiketi".
 *
 * İki kural:
 *   1. Etiket zaten SAĞLAYICI ADIYLA başlıyorsa (codex kataloğu "GPT-6 Astra",
 *      antigravity "Gemini 3.8 Flash") aynen geçer — ikinci kez önek eklenmez.
 *   2. Etiket YALIN AİLE ADIYSA ("Opus") ya da yasaklı katman kelimesiyse
 *      ("Standart") tek başına kullanılamaz: sağlayıcı adıyla tamamlanır.
 *
 * 🪤 ÖLÇÜLEN SINIR (ADR §9.5, bu kartın KAPSAMI DIŞI): `modelCatalog.cjs` claude
 * satırlarını SÜRÜMSÜZ alias'la etiketliyor ('opus') — bilerek, çünkü alias "en
 * yenisi"ne çözülür ve sabit id yazmak katalogu bayatlatır. Bu yüzden numara
 * ancak model id'si TAM geldiğinde (`claude-fable-5-1`) görünür; o hâlde çağıran
 * `modelDetect.labelForModelId` çıktısını `catalogLabel` olarak geçirir ve
 * buradan "Claude Fable 5.1" çıkar. UYDURMA SÜRÜM NUMARASI ÜRETİLMEZ.
 *
 * @param {string} engineId
 * @param {string} modelId
 * @param {string} [catalogLabel] katalog/`labelForModelId` etiketi
 * @returns {string} kullanıcıya gösterilecek etiket ('' → model seçilmemiş)
 */
function composeModelLabel(engineId, modelId, catalogLabel) {
  const product = ENGINE_PRODUCT_NAMES[str(engineId).toLowerCase()] || '';
  let label = str(catalogLabel);
  const lower = label.toLowerCase();
  // Yasaklı katman kelimesi etiketin TAMAMIYSA etiket kullanılamaz → model id'sine düş.
  if (label && BANNED_TIER_WORDS.includes(lower)) label = '';
  if (!label) label = str(modelId);
  // MODEL SEÇİLMEMİŞ (lider kaydında `employees.model` NULL = "motorun kendi
  // varsayılanı"). Kart yine de "hangi yapay zekâ" sorusunu YANITLAMALI; boş bir
  // etiket kullanıcıya hiçbir şey söylemez. Uydurma sürüm numarası ÜRETMEYİZ —
  // sağlayıcı adı tek başına DOĞRU ve yeterlidir ("Claude").
  if (!label) return product;
  // Sağlayıcı adı zaten öndeyse ikinci kez ekleme ("GPT-6 Astra", "Gemini 3.8 Flash").
  if (product && label.toLowerCase().startsWith(product.toLowerCase())) return label;
  // Yalın aile adı ya da sürümsüz bir etiket → sağlayıcı adıyla tamamla.
  if (product) return `${product} ${label}`;
  return label;
}

/** §9.5 kapısı — etiket YALIN aile adı olarak mı kalmış? (test + kart nöbeti) */
function isBareModelAlias(label) {
  return BARE_MODEL_ALIASES.includes(str(label).toLowerCase());
}

/**
 * ADR §4.1-2 + §9.6 — TEK SATIRIN SÜZGECİ.
 *
 * Katalog dışı rol → satır DÜŞER (null döner). Para alanı → alan SİLİNİR (satır
 * kalır: kullanıcının kartı bir tutar yüzünden kaybolmamalı).
 *
 * @returns {object|null} temizlenmiş satır ya da null
 */
function sanitizeRow(row, allowedSlugs) {
  if (!row || typeof row !== 'object') return null;
  const allowed = new Set([...(allowedSlugs || [])].map((s) => str(s).toLowerCase()).filter(Boolean));
  const roleSlug = str(row.roleSlug).toLowerCase();
  if (!roleSlug || !allowed.has(roleSlug)) return null; // uydurma rol SESSİZCE düşer

  const engine = str(row.engine);
  const model = str(row.model);
  const out = {
    roleSlug,
    roleTitle: str(row.roleTitle) || roleSlug,
    name: str(row.name),
    oneLiner: str(row.oneLiner),
    engine,
    model,
    modelLabel: composeModelLabel(engine, model, row.modelLabel),
    effort: str(row.effort) || null,
    leader: row.leader === true,
    sprite: str(row.sprite) || null,
    expertise: str(row.expertise) || '',
  };
  // TC-07 — mode:'engine' satırı MEVCUT bir çalışanı gösterir: kimliği (employeeId /
  // agentId) ve eski motoru (fromEngine) TAŞINMAK ZORUNDA — apply bu kimlikle
  // `employees.engine` yazar, undo eski motora döner. Süzgeç bunları düşürseydi
  // onay "kabul" edilir ama hiçbir şey değişmezdi (contract-fields-other-side-
  // silently-drops). Sıradan satırda bu alanlar YOKTUR (şekil değişmez).
  const employeeId = str(row.employeeId);
  if (employeeId) {
    out.employeeId = employeeId;
    out.agentId = str(row.agentId);
    out.fromEngine = str(row.fromEngine).toLowerCase();
  }
  // §9.6 — para alanı taşınmaz. Şemada zaten yok; bu satır KAPIDIR: çağıran
  // (kullanıcı düzenlemesi, Agent X, ileride başka bir yüzey) eklemiş olsa bile
  // alan buradan geçemez.
  for (const f of MONEY_FIELDS) delete out[f];
  return out;
}

/** Satır listesi süzgeci — düşen satır sayısını da bildirir (log/dürüstlük). */
function sanitizeRows(rows, allowedSlugs) {
  const list = Array.isArray(rows) ? rows : [];
  const kept = [];
  const dropped = [];
  for (const raw of list) {
    const clean = sanitizeRow(raw, allowedSlugs);
    if (clean) kept.push(clean);
    else dropped.push(str(raw && raw.roleSlug) || '?');
  }
  return { rows: kept, dropped };
}

/**
 * TC-07 — serbest metin bir rol adı için EN YAKIN katalog slug'ları (sıralı, tekrarsız).
 * Eşleme: tam slug → slug'ın kendisi; aksi hâlde metnin jetonları `ROLE_ALIASES`
 * takma adlarıyla (tam jeton ya da önek) karşılaştırılır. Yalnız `allowedSlugs`
 * içindeki slug önerilir (KONTROL KOLU: katalog boşsa öneri de boş).
 *
 * @param {string} text liderin yazdığı rol ("UX Designer", "tester")
 * @param {Iterable<string>} allowedSlugs katalog
 * @returns {string[]}
 */
function nearestRoleSlugs(text, allowedSlugs) {
  const allowed = new Set([...(allowedSlugs || [])].map((s) => str(s).toLowerCase()).filter(Boolean));
  const raw = str(text).toLowerCase();
  if (!raw || !allowed.size) return [];
  if (allowed.has(raw)) return [raw];
  const tokens = raw.split(/[^a-z0-9çğıöşü]+/i).filter(Boolean);
  const out = [];
  for (const [slug, aliases] of Object.entries(ROLE_ALIASES)) {
    if (!allowed.has(slug)) continue;
    const hit = tokens.some((t) => aliases.some((a) => a === t || (t.length >= 4 && (a.startsWith(t) || t.startsWith(a)))));
    if (hit && !out.includes(slug)) out.push(slug);
  }
  return out;
}

/**
 * TC-07 — "satır kalmadı" reddinin NEDENİ. Eskiden tek cümle vardı ("rol listesinde
 * karşılığı olan rol bulunamadı") ve YANLIŞ neden veriyordu: 20.09'da düşen üç rol
 * katalogdaydı, koltuklar ZATEN DOLUYDU. Lider "katalog eşleşmesi yok" diye anlattı.
 *
 * `dropped` renderer'ın saydığı düşme nedenleridir (pickRoleSlugs / buildEngineRows).
 * Öncelik: dolu koltuk > katalog dışı > reddedilmiş > bilinmeyen ajan > eşleşme yok.
 * Her nedenin `howTo`su LİDERE doğru çağrı şeklini söyler (araç metni aynen taşır).
 */
function emptyReason(mode, dropped, allowedSlugs) {
  const d = dropped && typeof dropped === 'object' ? dropped : {};
  const list = (k) => (Array.isArray(d[k]) ? d[k].map((x) => str(x)).filter(Boolean) : []);
  const existing = list('existing');
  const unmatched = list('unmatched');
  const rejected = list('rejected');
  const unknownAgents = list('unknownAgents');
  const alreadyOn = list('alreadyOn');
  const base = { existing, unmatched, rejected, unknownAgents, nearest: [] };
  if (normalizeMode(mode) === 'engine') {
    if (alreadyOn.length && !unknownAgents.length) {
      return {
        ...base,
        reason: 'already-on-engine',
        error: `Bu kişiler zaten o motorla çalışıyor: ${alreadyOn.join(', ')} — değiştirilecek bir şey yok.`,
        howTo: 'Başka bir motor iste (engine:"…") ya da başka kişileri seç (agents:[…]).',
      };
    }
    return {
      ...base,
      reason: 'no-such-agent',
      error: unknownAgents.length
        ? `Bu takımda böyle biri yok: ${unknownAgents.join(', ')}.`
        : 'Motoru değiştirilecek kimse bulunamadı (lider kendi motorunu bu yoldan değiştiremez).',
      howTo: 'agents:[…] alanına takımdaki çalışanların ajan kimliklerini yaz (crewpane_pane action:"list" ile gör) ya da boş bırak: liderin dışındaki herkes.',
    };
  }
  if (existing.length) {
    return {
      ...base,
      reason: 'already-on-team',
      error: `Bu roller ekipte zaten var: ${existing.join(', ')} — aynı koltuk ikinci kez açılmadı.`,
      howTo:
        'Mevcut kişinin MOTORUNU değiştirmek için: mode:"engine" engine:"<motor>" agents:["<ajan-id>"] (boş agents = liderin dışındaki herkes). ' +
        'Aynı rolden İKİNCİ bir kişi için: mode:"role" roles:["<slug>"] (kartı patron onaylar).',
    };
  }
  if (unmatched.length) {
    const nearest = [];
    for (const u of unmatched) for (const n of nearestRoleSlugs(u, allowedSlugs)) if (!nearest.includes(n)) nearest.push(n);
    return {
      ...base,
      nearest,
      reason: 'catalog-mismatch',
      error: `Katalogda karşılığı yok: ${unmatched.join(', ')}.`,
      howTo: nearest.length
        ? `En yakın katalog rolleri: ${nearest.map((n) => `"${n}"`).join(', ')} — roles:[${nearest.map((n) => `"${n}"`).join(',')}] ile yeniden dene.`
        : 'Yalnız katalog slug\'larını kullan (lead, backend, frontend, data-engineer, design, qa, devops, security, pm, marketing, support, code-automation, n8n-automation, code-review, explorer, seo).',
    };
  }
  if (rejected.length) {
    return {
      ...base,
      reason: 'rejected',
      error: `Patron bu oturumda şu rolleri reddetti (Vazgeç): ${rejected.join(', ')} — bir daha sorulmaz.`,
      howTo: 'Bu oturumda o rolü yeniden önerme; patron isterse uygulama yeniden başlatılınca sorulabilir.',
    };
  }
  return {
    ...base,
    reason: 'no-match',
    error: 'Bu iş için ürünün rol listesinde karşılığı olan bir rol bulunamadı — öneri üretilmedi.',
    howTo: 'roles:[…] ile katalog slug\'larını açıkça ver ya da cümleyi hazır ekip düzenlerine yakın yaz.',
  };
}

/**
 * ADR §5 — TAVAN KARARI. Reddin CÜMLESİ de burada (tek yer): main onu 429 gövdesine
 * koyar, araç lidere aynen geçirir.
 *
 * TC-07 — `dropped` (renderer'ın düşme sayımı) verilirse "satır kalmadı" reddi
 * YAPISALDIR: `reason` + `existing`/`unmatched`/`rejected`/`nearest` + `howTo`.
 * Verilmezse eski cümle bit-bit korunur (reason:'no-match').
 *
 * @returns {{ok:true} | {ok:false, code:'cap'|'empty', cap:string, reason:string, error?:string, howTo?:string}}
 */
function capDecision({ rows, mode, sessionInstalls = 0, caps = CAPS, dropped = null, allowedSlugs = [] }) {
  const n = Array.isArray(rows) ? rows.length : 0;
  if (sessionInstalls >= caps.maxInstallsPerSession) {
    return {
      ok: false,
      code: 'cap',
      cap: 'session',
      reason:
        `Bu oturumda ${caps.maxInstallsPerSession} kez ekip kuruldu — şimdilik bu kadar. ` +
        'Uygulamayı yeniden başlattığında yeniden önerebilirsin.',
    };
  }
  if (n > caps.maxEmployees) {
    return {
      ok: false,
      code: 'cap',
      cap: 'employees',
      reason:
        `Bir seferde en fazla ${caps.maxEmployees} kişi önerilebilir (${n} istendi). ` +
        'Önce en gerekli olanlarla başla; kalanları sonra ekleyebilirsin.',
    };
  }
  // ≤1 takım: `mode:'team'` zaten TEK takım açar. Kapı yine de burada durur ki
  // ileride çok-takımlı bir öneri şekli doğarsa sessizce geçmesin.
  if (normalizeMode(mode) === 'team' && caps.maxTeams < 1) {
    return { ok: false, code: 'cap', cap: 'teams', reason: 'Yeni takım kurulamıyor.' };
  }
  if (n === 0) {
    const why = emptyReason(mode, dropped, allowedSlugs);
    return {
      ok: false,
      code: 'empty',
      cap: 'roles',
      // ⚠️ `reason` artık KOD ('already-on-team' …), cümle `error`da. Eski çağıranlar
      // (`composeFail(…, cap.reason)`) main'de `cap.error || cap.reason` okur.
      reason: why.reason,
      error: why.error,
      howTo: why.howTo,
      existing: why.existing,
      unmatched: why.unmatched,
      rejected: why.rejected,
      unknownAgents: why.unknownAgents,
      nearest: why.nearest,
    };
  }
  return { ok: true };
}

/**
 * §9.7 — JETONU AYAR MI ÜRETİYOR?
 *
 * `ask`        → hayır (her seferinde kart).
 * `small-auto` → yalnız TEK KİŞİLİK ekleme (`mode:'role'` + tek satır).
 * `auto`       → her iki modda da evet.
 *
 * Kademe ne olursa olsun jetonu ÜRETEN main'dir; lider kendi jetonunu uyduramaz.
 */
function autonomyGrantsApproval(autonomy, mode, rowCount) {
  const level = sanitizeAutonomy(autonomy);
  if (level === 'auto') return true;
  // TC-07 — motor değişimi "küçük ekleme" DEĞİLDİR: açık pane'i yeniden başlatır,
  // sohbeti keser. `small-auto` yalnız tek kişilik KOLTUK eklemesini kapsar.
  if (level === 'small-auto') return normalizeMode(mode) === 'role' && rowCount === 1;
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// MAKBUZ — "kuruldu" cümlesinin TEK KAYNAĞI (TC-FIX-01, RESEARCH-TC-01 §6)
// ─────────────────────────────────────────────────────────────────────────────

/** Ofis sekmesinin ölçülen hâli. `pending` = henüz çizilmedi/ölçülemedi (yalan yok). */
const VISIBLE_TABS = Object.freeze(['seen', 'overflow', 'pending']);

/**
 * Renderer'ın ölçtüğü görünürlüğü DARALT. Şekli tutmayan/eksik yük `pending`e
 * düşer: makbuz "görünüyor" demek için ÖLÇÜM ister, iddia değil.
 *
 * @param {unknown} raw renderer'ın `applyResult.visible`ı
 * @param {string|null} wingSlug apply'ın yazdığı kanat (ölçüm boşsa da bilinir)
 */
function normalizeVisible(raw, wingSlug) {
  const o = raw && typeof raw === 'object' ? raw : {};
  const tab = VISIBLE_TABS.includes(o.tab) ? o.tab : 'pending';
  const seats = Number.isFinite(Number(o.seatsDrawn)) ? Math.max(0, Math.floor(Number(o.seatsDrawn))) : 0;
  return { wing: str(o.wing) || str(wingSlug) || null, tab, seatsDrawn: seats };
}

/**
 * §6 — makbuz. Araç metni (lider), pane notu (lider) ve şerit (patron) AYNI kaydı
 * okur; "ofiste, masalarında" cümlesi ancak `visible.tab === 'seen'` ise kurulur.
 */
function buildReceipt({ createdTeam, employees, names, wingSlug, visible, leaderCanDelegate, undoUntil }) {
  return {
    written: {
      team: createdTeam === true ? 1 : 0,
      employees: Number.isFinite(Number(employees)) ? Number(employees) : 0,
      names: (Array.isArray(names) ? names : []).map((x) => str(x)).filter(Boolean),
    },
    visible: normalizeVisible(visible, wingSlug),
    leaderCanDelegate: leaderCanDelegate === true,
    undoUntil: str(undoUntil) || null,
  };
}

/**
 * Liderin okuyacağı cümle — MCP aracı ve pane notu bunu yazar, ikisi de ayrı bir
 * cümle KURMAZ. Kural: `seen` → "ofiste görünüyor"; `overflow`/`pending` → eksikliği
 * ADIYLA söyler ve lidere "masalarında" DEMEMESİNİ tembihler.
 *
 * @param {{teamName?:string, receipt?:object, alreadyApplied?:boolean}} body apply cevabı
 */
function composeReceiptText(body) {
  const b = body && typeof body === 'object' ? body : {};
  // TC-07 — mode:'engine': satır YAZILMADI, motor DEĞİŞTİ. "Ekip kuruldu" cümlesi
  // burada yalan olurdu; kim/neyden/neye + açık pane şeridi + geri alma söylenir.
  if (str(b.mode) === 'engine') return composeEngineReceiptText(b);
  const r = b.receipt && typeof b.receipt === 'object' ? b.receipt : buildReceipt({});
  const team = str(b.teamName) || 'takım';
  const names = Array.isArray(r.written && r.written.names) ? r.written.names : [];
  const n = (r.written && r.written.employees) || names.length;
  const nameList = names.length ? ` (${names.join(', ')})` : '';
  const vis = r.visible || {};
  const parts = [];
  if (b.alreadyApplied === true) parts.push('Zaten kuruldu — patron onayladı, ürün kurdu; ikinci apply gerekmedi.');
  if (vis.tab === 'seen') {
    parts.push(
      `Ekip kuruldu ve ofiste '${team}' sekmesinde görünüyor (${vis.seatsDrawn || n} masa): ${n} kişi${nameList}.`,
    );
  } else if (vis.tab === 'overflow') {
    parts.push(
      `Ekip kuruldu: ${n} kişi yazıldı${nameList}. Ofiste '${team}' sekmesi şeride SIĞMADI, "+N" menüsünde — ` +
        `patrona sekmeyi menüden açmasını söyle; "ofiste, masalarında" DEME.`,
    );
  } else {
    parts.push(
      `Ekip kuruldu: ${n} kişi yazıldı${nameList}. Ofiste HENÜZ görünmüyor (sekme çizilmedi) — ` +
        `patrona "birazdan '${team}' sekmesinde belirir" de; "masalarında oturuyor" DEME.`,
    );
  }
  parts.push(
    r.leaderCanDelegate
      ? 'Bu kişiler GERÇEK çalışanlar: aynı oturumda crewpane_delegate ile onlara iş verebilirsin.'
      : 'Bu takıma iş vermek için patronun izni gerekir (ilk delegasyonda izin kartı çıkar).',
  );
  parts.push('Patron 10 dakika içinde geri alabilir. apply tekrar ÇAĞIRMA.');
  return parts.join(' ');
}

/**
 * TC-07 — motor değişikliği makbuzu. `engineChanges[i].paneOpen` renderer/main
 * ölçümüdür: pane AÇIKSA ürün HATA-12 şeridini çizer ("Yeni motorla yeniden başlat")
 * ve yeni motor ancak patron o düğmeye basınca koşar — lider "artık Codex koşuyor"
 * DEMEZ; kapalıysa bir sonraki açılış/delegasyon zaten yeni motorla başlar.
 */
function composeEngineReceiptText(b) {
  const label = str(b.engineLabel) || str(b.engine) || 'yeni motor';
  const changes = Array.isArray(b.engineChanges) ? b.engineChanges : [];
  const names = changes.map((c) => str(c && c.name)).filter(Boolean);
  const open = changes.filter((c) => c && c.paneOpen === true).map((c) => str(c.name)).filter(Boolean);
  const parts = [];
  if (b.alreadyApplied === true) parts.push('Zaten değiştirildi — patron onayladı, ürün yazdı; ikinci apply gerekmedi.');
  parts.push(
    `Motor değiştirildi: ${names.length ? names.join(', ') : `${changes.length} kişi`} artık ${label} ile çalışacak` +
      ' (yeni çalışan eklenmedi, kadro aynı).',
  );
  if (open.length) {
    parts.push(
      `${open.join(', ')} için pane AÇIK: üstünde "Yeni motorla yeniden başlat" şeridi belirdi — patron basınca pane ${label} ile yeniden açılır; ` +
        'o zamana kadar eski motor koşmaya devam eder, "artık yeni motorla koşuyor" DEME.',
    );
  } else {
    parts.push(`Açık pane yok: bir sonraki delegasyon/açılış doğrudan ${label} ile başlar.`);
  }
  parts.push('Patron 10 dakika içinde geri alabilir (eski motor/model geri gelir). apply tekrar ÇAĞIRMA.');
  return parts.join(' ');
}

// ─────────────────────────────────────────────────────────────────────────────
// DEFTER — öneri · onay jetonu · geri alma günlüğü
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ADR §4.2 + §4.4 — main'in belleğindeki defter.
 *
 * BELLEKTE, DİSKTE DEĞİL (kasıtlı): geri alma "o koşuda yazılanı geri almak"tır,
 * genel bir çöp kutusu değil. Uygulama kapanınca pencere kapanır — yarım bilgiyle
 * satır silmek risklidir (ADR §4.4).
 *
 * @param {{now?:()=>number, randomId?:()=>string, proposalTtlMs?:number, undoTtlMs?:number, caps?:object}} deps
 */
function createComposeLedger(deps = {}) {
  const now = typeof deps.now === 'function' ? deps.now : () => Date.now();
  const randomId =
    typeof deps.randomId === 'function'
      ? deps.randomId
      : () => {
          const c = globalThis.crypto;
          if (c && typeof c.randomUUID === 'function') return c.randomUUID().replace(/-/g, '');
          // Kripto yoksa bile ÇALIŞ: jetonun gizliliği süreç-içi bir defterde
          // tutulmasından gelir; yine de tahmin edilebilir bir dize üretmeyelim.
          return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
        };
  const proposalTtlMs = Number.isFinite(deps.proposalTtlMs) ? deps.proposalTtlMs : PROPOSAL_TTL_MS;
  const undoTtlMs = Number.isFinite(deps.undoTtlMs) ? deps.undoTtlMs : UNDO_TTL_MS;
  const caps = deps.caps || CAPS;

  /** proposalId → öneri kaydı. */
  const proposals = new Map();
  /** proposalId → geri alma kaydı (apply'ın YAZDIĞI kimlikler). */
  const undoLog = new Map();
  /** §4.1-3 — o oturumda reddedilen roller (bir daha sorulmaz). */
  const rejectedRoles = new Set();
  /** §5 — oturumda uygulanan kurulum sayısı. */
  let installs = 0;

  /** Süresi dolmuş kayıtları düşür (her okumada — ayrı bir zamanlayıcı gerekmez). */
  function sweep() {
    const t = now();
    for (const [id, p] of proposals) if (p.expiresAtMs <= t) proposals.delete(id);
    for (const [id, u] of undoLog) if (u.expiresAtMs <= t) undoLog.delete(id);
  }

  return {
    caps,
    /** §4.1-3 — süzgecin ihtiyacı olan "bunu zaten reddetti" kümesi. */
    rejectedRoles: () => [...rejectedRoles],
    /** §5 — oturum sayacı (tavan kararına girer). */
    sessionInstalls: () => installs,

    /**
     * Öneriyi deftere yaz. `approvalToken` YALNIZ ayar kademesi izin veriyorsa
     * (§9.7) burada doğar; `ask`ta null döner ve jeton kullanıcının tıklamasıyla
     * (`decide`) üretilir.
     */
    putProposal({ leaderId, department, mode, objective = '', teamName, rows, targetTeamId = null, planNote = null, source = 'leader', autonomy = DEFAULT_AUTONOMY, engine = '', engineLabel = '' }) {
      sweep();
      const t = now();
      const proposalId = `cmp-${randomId()}`;
      const level = sanitizeAutonomy(autonomy);
      const preApproved = autonomyGrantsApproval(level, mode, Array.isArray(rows) ? rows.length : 0);
      const record = {
        proposalId,
        leaderId: str(leaderId),
        department: str(department),
        mode: normalizeMode(mode),
        // TC-05 (TC-04 BULGU-1) — PATRONUN CÜMLESİ. Bu alan ESKİDEN defterde yoktu:
        // `callRenderer('team-compose:propose', {objective})`e gidiyor ama deftere ve
        // oradan `team-compose:proposal` olayına HİÇ girmiyordu → onay kartı patronun
        // ne istediğini yazamıyordu ("Hazır … düzeninden yola çıktım" tek bağlamdı).
        // Kart tarafı ZATEN hazırdı (TC-04 kontrol kolu: alan dolu gelince çiziyor).
        // Kesme: kart bir tırnak gösterir, roman değil; uzun metin kartı taşırmasın.
        objective: str(objective).slice(0, OBJECTIVE_MAX),
        teamName: str(teamName),
        rows: Array.isArray(rows) ? rows : [],
        targetTeamId: str(targetTeamId) || null,
        planNote: str(planNote) || null,
        // TC-07 — mode:'engine': hedef motor (id + kartın yazdığı etiket).
        engine: str(engine).toLowerCase() || null,
        engineLabel: str(engineLabel) || null,
        source: source === 'agentx' ? 'agentx' : 'leader',
        autonomy: level,
        createdAtMs: t,
        expiresAtMs: t + proposalTtlMs,
        // Onay: jeton + tek kullanım mandalı. null = henüz onaylanmadı.
        approval: preApproved ? { token: `tok-${randomId()}`, grantedAtMs: t, by: 'setting', used: false } : null,
      };
      proposals.set(proposalId, record);
      return record;
    },

    /** Öneriyi oku (süresi dolmuşsa null). */
    getProposal(proposalId) {
      sweep();
      return proposals.get(str(proposalId)) || null;
    },

    /**
     * §4.2 — KULLANICININ KARARI. `approve` jetonu ÜRETİR (tek kullanımlık, TTL).
     * `reject` öneriyi düşürür ve rollerini o oturum için kapatır (§4.1-3).
     *
     * `rows`/`teamName` verilirse kullanıcının DÜZENLEMESİ kaydedilir — ama süzgeç
     * çağıranın işidir (main `sanitizeRows` + `capDecision` ile yeniden ölçer).
     */
    decide(proposalId, { decision, teamName, rows } = {}) {
      sweep();
      const p = proposals.get(str(proposalId));
      if (!p) return { ok: false, code: 'unknown', reason: 'Bu öneri artık geçerli değil.' };
      if (decision === 'reject') {
        for (const r of p.rows) rejectedRoles.add(str(r.roleSlug).toLowerCase());
        proposals.delete(p.proposalId);
        return { ok: true, rejected: true };
      }
      if (decision !== 'approve') return { ok: false, code: 'bad-decision', reason: 'Bilinmeyen karar.' };
      if (Array.isArray(rows)) p.rows = rows;
      if (str(teamName)) p.teamName = str(teamName);
      // Zaten onaylıysa İKİNCİ jeton üretme (çift tıklama tek onaydır).
      if (!p.approval) {
        const t = now();
        p.approval = { token: `tok-${randomId()}`, grantedAtMs: t, by: 'user', used: false };
        // TC-FIX-01 (RESEARCH-TC-01 §4.3 d4) — PENCERE TIKLAMADAN SAYILIR. Sözleşme
        // §5 "onaydan itibaren 10 dk" derken kod propose anından sayıyordu: patron
        // 9:30'da onaylayıp lider 10:30'da uygularsa "süresi dolmuş" çıkıyordu.
        // Pencere hiç KISALMAZ (max), yalnız onayla yeniden açılır.
        p.expiresAtMs = Math.max(p.expiresAtMs, t + proposalTtlMs);
      }
      return { ok: true, approvalToken: p.approval.token, proposal: p };
    },

    /**
     * §4.2 / sözleşme §5 — JETONU TÜKET.
     *
     * `presentedToken` İSTEĞE BAĞLIDIR: verilmezse main kendi defterindeki onayı
     * kullanır. VERİLMİŞSE eşleşmek ZORUNDADIR — uydurma bir jeton sessizce yok
     * sayılmaz, reddedilir (ajanın metni izni yükseltemez, ADR-026).
     */
    takeApproval(proposalId, presentedToken) {
      sweep();
      const p = proposals.get(str(proposalId));
      if (!p) return { ok: false, code: 'unknown', reason: 'Bu öneri artık geçerli değil (süresi dolmuş olabilir).' };
      if (!p.approval) {
        return { ok: false, code: 'awaiting-approval', reason: 'Kullanıcı bu öneriyi henüz onaylamadı.', proposal: p };
      }
      const given = str(presentedToken);
      if (given && given !== p.approval.token) {
        return { ok: false, code: 'bad-token', reason: 'Onay jetonu geçersiz.' };
      }
      if (p.approval.used) {
        // TC-FIX-01 — jeton harcanmış ama öneri hâlâ defterde = kurulum UÇUŞTA
        // (ürün onay tıklamasında apply'ı kendisi koşturur; lider aynı anda apply
        // çağırırsa "zaten kullanıldı" demek onu "hata" okumaya iter). Kurulum
        // BİTİNCE öneri defterden düşer ve aynı çağrı `unknown`a (→ main'de
        // "zaten kuruldu") gider; DÜŞERSE `releaseApproval` jetonu geri açar.
        return { ok: false, code: 'in-progress', reason: 'Kurulum sürüyor — patron onayladı, ürün kuruyor.' };
      }
      p.approval.used = true; // TEK KULLANIM — ikinci apply 'in-progress'/'unknown' alır
      return { ok: true, proposal: p };
    },

    /**
     * TC-FIX-01 — apply DÜŞTÜYSE (renderer hatası/zaman aşımı) jetonu geri aç:
     * öneri defterde durur, patronun onayı geçerlidir, yeniden denenebilir.
     * Kurulum kısmen yazdıysa çağıran bunu ÇAĞIRMAZ (yarım kadro iki kez kurulmasın).
     */
    releaseApproval(proposalId) {
      const p = proposals.get(str(proposalId));
      if (!p || !p.approval) return false;
      p.approval.used = false;
      return true;
    },

    /**
     * §4.4 — apply'ın GERÇEKTEN yazdığı kimlikleri deftere geçir. Sayaç burada
     * artar (öneri açmak değil, KURMAK bir kurulumdur).
     */
    recordApplied(proposalId, { teamId, createdTeam, employeeIds, names, wingSlug, teamName, leaderId = '', scopeGrant = null, receipt = null, engineChanges = [], mode = null }) {
      sweep();
      const t = now();
      const id = str(proposalId);
      const prior = proposals.get(id);
      const entry = {
        // TC-07 — hangi modda uygulandı (undo yolu bundan ayrışır) + motor değişimleri:
        // `{employeeId, agentId, name, from:{engine,model,effort}, to:{engine}}` —
        // geri alma ESKİ değerleri ancak buradan bilir. Sıradan kurulumda boş liste.
        mode: normalizeMode(mode || (prior && prior.mode) || 'team'),
        engine: (prior && prior.engine) || null,
        engineLabel: (prior && prior.engineLabel) || null,
        engineChanges: Array.isArray(engineChanges) ? engineChanges.filter((c) => c && typeof c === 'object') : [],
        // TC-FIX-01 — idempotent apply: lider ürünün ZATEN kurduğu öneri için apply
        // çağırırsa main "süresi dolmuş" DEĞİL "zaten kuruldu" der; verilen jeton
        // yine de eşleşmek zorundadır (uydurma jeton bu yoldan da bilgi alamaz).
        approvalToken: prior && prior.approval ? prior.approval.token : null,
        // §6 makbuz — araç metni ve şerit AYNI kayıttan okur.
        receipt: receipt && typeof receipt === 'object' ? receipt : null,
        proposalId: id,
        // TC-05 — geri alma YALNIZ satır silmez, apply'ın YAZDIĞI izni de geri alır.
        // Bunun için "kimin adına" ve "hangi takım için" yazıldığı DEFTERDE durmalı:
        // undo çağrısı başka bir kimlikten de gelebilir (şeritteki düğme, temizlik),
        // o yüzden çağıranın `leaderId`'sine güvenilmez.
        leaderId: str(leaderId),
        scopeGrant: str(scopeGrant) || null,
        teamId: str(teamId) || null,
        createdTeam: createdTeam === true,
        employeeIds: (Array.isArray(employeeIds) ? employeeIds : []).map((x) => str(x)).filter(Boolean),
        names: (Array.isArray(names) ? names : []).map((x) => str(x)).filter(Boolean),
        wingSlug: str(wingSlug) || null,
        teamName: str(teamName) || null,
        appliedAtMs: t,
        expiresAtMs: t + undoTtlMs,
      };
      undoLog.set(id, entry);
      proposals.delete(id); // öneri tüketildi
      installs++;
      return entry;
    },

    /**
     * §4.4 — geri alma kaydını AL VE DÜŞÜR (tek kullanım: iki kez undo çağrısı
     * ikinci kez satır silmeye ÇALIŞMAZ).
     */
    takeUndo(proposalId) {
      sweep();
      const id = str(proposalId);
      const entry = undoLog.get(id);
      if (!entry) return null;
      undoLog.delete(id);
      return entry;
    },

    /** Kontrol kolu: günlük DURUYOR mu? (silmeden bakmak isteyen testler için) */
    peekUndo(proposalId) {
      sweep();
      return undoLog.get(str(proposalId)) || null;
    },
  };
}

module.exports = {
  CAPS,
  ACTIONS,
  MODES,
  AUTONOMY_LEVELS,
  DEFAULT_AUTONOMY,
  PROPOSAL_TTL_MS,
  UNDO_TTL_MS,
  MONEY_FIELDS,
  BARE_MODEL_ALIASES,
  ENGINE_PRODUCT_NAMES,
  sanitizeAutonomy,
  normalizeMode,
  sanitizeRoles,
  sanitizeRow,
  sanitizeRows,
  capDecision,
  emptyReason,
  nearestRoleSlugs,
  ROLE_ALIASES,
  autonomyGrantsApproval,
  composeModelLabel,
  isBareModelAlias,
  VISIBLE_TABS,
  normalizeVisible,
  buildReceipt,
  composeReceiptText,
  composeEngineReceiptText,
  createComposeLedger,
};
