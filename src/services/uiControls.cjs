// ADP-921 (Bumblebee) — SESLE YÖNETİLEBİLİR KONTROL KAYDI (tek gerçek, iki süreç).
//
// ── SINIF TANIMI (tek tek eksik komut DEĞİL) ────────────────────────────────
// ADP-883 EKRANLARI veri yaptı (`uiSurfaces.cjs`): "ayarları aç", "ses ayarlarını
// aç" bir kayıttan çözülür ve yeni bir ayar SEKMESİ eklemek = kayda bir satır
// (drift kapısı unutursan kırmızı verir). Ama o kaydın kapsamı EKRAN düzeyinde
// bitiyor: bir ekranın İÇİNDEKİ kontrolü (tema seçici, dil seçici, workspace
// yolu) sesle sürmek hâlâ elle yazılmış dallara bağlıydı —
//   1) `electron/jarvisVoice.js`  → SETTINGS_OPS + normalize dalı + kural yolu regex
//   2) `electron/jarvisVoice.js`  → beynin sistem promptundaki elle yazılmış satır
//   3) `src/app/lib/jarvisVoice.ts` → JarvisSettingsOp birleşimi + karar ALANI
//   4) `src/app/lib/actionBusOrchestra.ts` → executeSettings'te `if (op === …)`
// DÖRT yer. ADP-899 dil seçiciyi ekledi, dördünü de beslemedi ve HİÇBİR ŞEY
// KIRILMADI — Agent X ekranda "Dil değiştirme için bir katalog eylemi yok" dedi.
// Sessiz ölüm, çünkü "eksik eylem" derleme hatası değildir.
//
// ÇÖZÜM (ADR-AGENTX-ACTION-REGISTRY): kontroller de VERİ olur. Bir satır = bir
// sesle-yönetilebilir kontrol (id + hangi ekranda + hangi ifadeler onu söyler +
// parametre şeması + hangi katalog eylemi + güvenlik sınıfı). Kural yolu (main),
// yürütücü (renderer), beynin prompt satırı ve "ne yapabilirim" cevabı AYNI
// kayıttan türer. Yeni kontrol = BURAYA BİR SATIR.
//
// ── NEDEN electron/ (src/ değil) ────────────────────────────────────────────
// `uiSurfaces.cjs` ile birebir aynı gerekçe: main süreç `src/`i okuyamaz
// (paketleme listesi yalnız `*.cjs`/`*.js`/`renderer/**` alır), renderer ise
// `electron/*.cjs`i statik import edebilir. Yön TERS DEĞİL.
//
// ── EŞLEŞTİRME ──────────────────────────────────────────────────────────────
// Alt-dize araması YOK (ADP-854 sınıfı). İfade = BİTİŞİK jeton dizisi; her jeton
// isim çekimine toleranslı eşleşir ("dil" ⊇ "dili"). Eşleştirme motoru YENİDEN
// YAZILMADI — `uiSurfaces.cjs::phraseHit/tokenMatches` ÇAĞRILIR (ADR-016 §2).
//
// ── KAPI ────────────────────────────────────────────────────────────────────
// `npm run check:voice-controls` (scripts/check-voice-controls.mjs): Ayarlar
// yüzeylerindeki HER etkileşimli kontrol ya bu kayda ya da GEREKÇELİ bir muafiyet
// satırına bağlanmak ZORUNDA. Kayıtsız/karara bağlanmamış kontrol = KIRMIZI.
// Kapı olmadan bu dosya da unutulur — vizyonun ("benim söylememe gerek kalmadan")
// çalışan parçası kayıt değil KAPIdır.
//
// ADP-885/st1 — i18n-exempt: intent-token. `phrases` KULLANICININ SÖYLEDİĞİ
// ifadelerdir → ÇEVRİLMEZ (`label` arayüzde de görünebilir; o ayrı alandadır).

'use strict';

const { phraseHit } = require('./uiSurfaces.cjs');
const morph = require('../voice/turkishMorph.cjs');

/**
 * Kontrolü DEĞİŞTİREN eylemin güvenlik sınıfı — `actionBusOrchestra.ts`'teki
 * APPROVAL_MATRIX ile AYNI sözlük ('serbest' | 'onay-gerekli'). Kayıt sınıfı
 * TAŞIR, matrisi yeniden yazmaz: matris hâlâ tek defter, kayıt ona uymak
 * zorundadır (drift kapısı: electron/uiControls.test.cjs).
 */

/**
 * @typedef {Object} ControlValue
 * @property {string} value      yürütücüye giden KİMLİK ('en'), çeviri değil
 * @property {string} say        asistanın SESLİ söylediği ad ("İngilizce") — bu bir
 *   ÇIKTIdır (dosyanın geri kalanı GİRDİ): ileride çevrilebilir, `phrases` asla
 * @property {string[][]} phrases bitişik jeton dizileri ("ingilizce", "english")
 *
 * @typedef {Object} UiControl
 * @property {string} id          kararlı kimlik ('settings.locale')
 * @property {string} surface     `uiSurfaces.cjs` id'si — kontrol HANGİ ekranda yaşıyor
 * @property {string} action      JarvisAction ('settings')
 * @property {string} op          JarvisSettingsOp ('locale')
 * @property {string} busAction   actionBus katalog id'si ('settings.setLocale')
 * @property {'serbest'|'onay-gerekli'} security
 * @property {string} label       sesli cümlede geçen ad ("Arayüz dili")
 * @property {string[][]} phrases kontrolü SÖYLEYEN ifadeler
 * @property {{name:string, kind:'enum'|'text', values?:ControlValue[]}} param
 */

/** @type {UiControl[]} */
const CONTROLS = [
  // ── Görünüm ve Dil ───────────────────────────────────────────────────────
  {
    id: 'settings.locale',
    surface: 'settings.appearance',
    action: 'settings',
    op: 'locale',
    busAction: 'settings.setLocale',
    // Dil ANINDA uygulanır ve ANINDA geri alınabilir ("dili Türkçe yap") — veri
    // dışarı çıkmaz, hiçbir iş kaybolmaz. nav.* / office.* emsali → serbest.
    // (Tema `onay-gerekli`: ADP-291'in kararı korunuyor, burada tartışılmıyor.)
    security: 'serbest',
    label: 'Arayüz dili',
    // Türkçede "Arayüz dili İngilizce yaptım" BOZUK (belirtme hâli eksik). Cümleyi
    // koddan birleştirmek yerine kayıt TAŞIR — yeni kontrol kendi doğru cümlesini
    // getirir, yürütücü dilbilgisi ÜRETMEZ.
    sayDone: 'Arayüz dilini {value} yaptım.',
    phrases: [['dil'], ['arayüz', 'dil'], ['uygulama', 'dil']],
    param: {
      name: 'value',
      kind: 'enum',
      values: [
        // 🪤 'İngilizce'.toLocaleLowerCase('tr') === 'ingilizce' (noktalı İ → i);
        // 'ıngilizce' YAZILMAZ ama STT bazen 'ingilizçe' üretir → ikisi de var.
        { value: 'en', say: 'İngilizce', phrases: [['ingilizce'], ['ingilizçe'], ['english']] },
        { value: 'tr', say: 'Türkçe', phrases: [['türkçe'], ['turkce'], ['turkish']] },
        // "sistem dili" — çıplak "sistem" DEĞİL (settings.status yüzeyiyle çakışır).
        { value: 'system', say: 'sistem dili', phrases: [['sistem', 'dil'], ['sistem', 'varsayılan']] },
      ],
    },
  },
  {
    id: 'settings.theme',
    surface: 'settings.appearance',
    action: 'settings',
    op: 'theme',
    busAction: 'settings.setTheme',
    security: 'onay-gerekli',
    label: 'Tema',
    // Tema DEĞERLERİ (preset adları) kural yolunda ADP-448'in kendi regex'iyle
    // çözülüyor ve orası hâlâ tek gerçek — kayıt burada yalnız KONTROLÜ tanıtır
    // (param.kind='text'), değer listesini İKİNCİ kez yazmaz.
    phrases: [['tema']],
    param: { name: 'theme', kind: 'text' },
  },

  // ── Genel ────────────────────────────────────────────────────────────────
  {
    id: 'settings.workspace',
    surface: 'settings.general',
    action: 'settings',
    op: 'workspace',
    busAction: 'settings.setWorkspace',
    security: 'onay-gerekli',
    label: 'Çalışma klasörü',
    phrases: [['workspace'], ['çalışma', 'klasör'], ['çalışma', 'dizin']],
    param: { name: 'path', kind: 'text' },
  },
];

const BY_ID = new Map(CONTROLS.map((c) => [c.id, c]));
const BY_OP = new Map(CONTROLS.map((c) => [`${c.action}.${c.op}`, c]));

/** Kayıttaki tüm kontroller (kopya — çağıran mutasyona uğratamaz). */
function listControls() {
  return CONTROLS.map((c) => ({ ...c }));
}

/** id ile kontrol (yoksa null). */
function controlById(id) {
  return BY_ID.get(String(id || '')) || null;
}

/** action+op ile kontrol — yürütücünün ve normalize'ın ortak sorusu. */
function controlByOp(action, op) {
  return BY_OP.get(`${String(action || '')}.${String(op || '')}`) || null;
}

/** Kayıttaki tüm op'lar, action'a göre (jarvisVoice.js'in SETTINGS_OPS'u bundan türer). */
function opsFor(action) {
  return CONTROLS.filter((c) => c.action === action).map((c) => c.op);
}

/**
 * Konuşulan metinde bir KONTROL adı geçiyor mu? EN UZUN ifade kazanır
 * ("arayüz dili" → settings.locale; çıplak "dil" de aynı kontrole düşer ama
 * daha uzun bir ifade varsa o kazanır — uiSurfaces ile aynı sözleşme).
 *
 * @returns {{ control: UiControl, phrase: string[] } | null}
 */
function resolveControl(text) {
  const toks = Array.isArray(text) ? text : morph.tokens(text);
  if (!toks.length) return null;
  let best = null;
  for (const control of CONTROLS) {
    for (const phrase of control.phrases) {
      if (!phraseHit(toks, phrase)) continue;
      if (!best || phrase.length > best.phrase.length) best = { control, phrase };
    }
  }
  return best;
}

/**
 * Bir enum kontrolünün DEĞERİNİ konuşulan metinden çöz ("dili İngilizce yap" → 'en').
 * `kind:'text'` kontrollerde null döner — onların değeri serbest metindir ve
 * çağıran kendi çıkarımını yapar (tema preset regex'i / dosya yolu).
 *
 * EN UZUN ifade kazanır: "sistem dili" ('system') çıplak "dil"e yenilmez.
 */
function resolveControlValue(control, text) {
  if (!control || control.param.kind !== 'enum') return null;
  const toks = Array.isArray(text) ? text : morph.tokens(text);
  if (!toks.length) return null;
  let best = null;
  for (const v of control.param.values || []) {
    for (const phrase of v.phrases) {
      if (!phraseHit(toks, phrase)) continue;
      if (!best || phrase.length > best.phrase.length) best = { value: v.value, phrase };
    }
  }
  return best ? best.value : null;
}

/** Bir enum kontrolünün kabul ettiği değerler (şema doğrulaması + prompt üretimi). */
function allowedValues(control) {
  if (!control || control.param.kind !== 'enum') return null;
  return (control.param.values || []).map((v) => v.value);
}

/** Değerin SESLİ söylenen adı ("en" → "İngilizce"); yoksa değerin kendisi. */
function valueLabel(control, value) {
  const row = (control && control.param.values ? control.param.values : []).find((v) => v.value === value);
  return (row && row.say) || String(value || '');
}

/**
 * BEYNİN PROMPT SATIRI kayıttan ÜRETİLİR — elle yazılmış ikinci bir liste
 * olmadığı için "kayda ekledim ama prompta yazmayı unuttum" sınıfı YAPISAL
 * olarak imkânsızdır (ADP-921'in kapattığı hatanın 2. yüzeyi).
 */
function promptOpsLine(action) {
  const rows = CONTROLS.filter((c) => c.action === action).map((c) => {
    const values = allowedValues(c);
    const param = values ? `${c.param.name}=${values.join('|')}` : `${c.param.name}=<değer>`;
    return `op="${c.op}" (${c.label}: ${param})`;
  });
  return rows.join(' · ');
}

/** Kayıttaki TÜM sesli ifadeler — leksikon kapısının ve korpusun tarayabileceği düz liste. */
function allPhrases() {
  const out = [];
  for (const c of CONTROLS) {
    for (const p of c.phrases) out.push(p.join(' '));
    for (const v of c.param.values || []) for (const p of v.phrases) out.push(p.join(' '));
  }
  return out;
}

module.exports = {
  CONTROLS,
  listControls,
  controlById,
  controlByOp,
  opsFor,
  resolveControl,
  resolveControlValue,
  allowedValues,
  valueLabel,
  promptOpsLine,
  allPhrases,
};
