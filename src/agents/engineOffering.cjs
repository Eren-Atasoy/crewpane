// ENG-21 (SPRINT-ENGINE-03) — MOTOR SUNULABİLİRLİĞİ: "bu motor kullanıcıya SUNULSUN mu?"
//
// ENG-05 `public.engines` referans tablosunu kurdu ve `enabled` kolonunu şöyle
// tanımladı: "Picker/formda SUNULSUN mu. Yeni motor önce enabled=false ile eklenip
// ölçüldükten sonra açılabilir — şema göçü gerekmeden." ENG-15 ölçtü: o kolonun
// ÜRÜNDE HİÇBİR TÜKETİCİSİ YOKTU. Kapalı işaretlenen dört motor (droid/amp/cursor/
// kimi) seçme ekranında açık motorlarla AYNI görünüyordu ve ikisi seçilirse pane
// AÇILIŞTA ölüyordu.
//
// ⚠️ ADI `engineCatalog` DEĞİL: o ad ADP-915'in "Motorlar & Maliyet" modülünündür
//    (beyin/STT/TTS + fatura kaynağı). İki ayrı soru, iki ayrı dosya.
//
// ─────────────────────────────────────────────────────────────────────────────
// NEDEN BU DOSYA VAR (ve neden yalnız DB okumak YETMEZ)
// ─────────────────────────────────────────────────────────────────────────────
// Tablo bugün YALNIZ yerel/dev migration'larında var; bulut (`app` şeması) ikizi
// henüz uygulanmadı (ENG-15 §7-7, ADP-650 ikiz-dosya sözleşmesi, Eren onayı
// bekliyor). Picker'ı SADECE tabloya bağlasaydık iki kötü seçenek kalırdı:
//   • okuma başarısızsa "hepsi açık" → bulutta kapalı motor yine seçilebilir
//     (yani bu görevin düzeltmesi bulutta HİÇ ÇALIŞMAZ), ya da
//   • okuma başarısızsa "hepsi kapalı" → picker BOŞALIR (felaket).
// Üçüncü yol: hüküm ÜRÜNLE BİRLİKTE GELİR (bu dosya), tablo okunabiliyorsa
// OPERATÖR ÜSTÜNE YAZAR. Uygulama çevrimdışı da doğrudur, bulutta da doğrudur.
//
// 🔴 BU DOSYA BİR BEYAN DEĞİL, BİR AYNADIR. Motor açma/kapama kararı
// `supabase/migrations/*engine*.sql` seed satırlarında yaşar; buradaki tablo onun
// kopyasıdır ve `engineOffering.test.cjs` her koşuda migration'ları AYRIŞTIRIP
// birebir eşitliği doğrular. Ayrışırsa test KIRILIR — sessiz kopya yoktur.
// Yeni motor / durum değişikliği: ÖNCE migration, sonra buraya aynası.

'use strict';

/**
 * Migration seed'lerinin aynası: `(id, label, command, enabled, sort_order)`.
 * Sıra `sortOrder` ile taşınır (picker'ın diziliş kaynağı da budur).
 */
const SEED = Object.freeze([
  Object.freeze({ id: 'claude', label: 'Claude Code', command: 'claude', enabled: true, sortOrder: 10 }),
  Object.freeze({ id: 'codex', label: 'Codex', command: 'codex', enabled: true, sortOrder: 20 }),
  Object.freeze({ id: 'copilot', label: 'GitHub Copilot CLI', command: 'copilot', enabled: true, sortOrder: 30 }),
  Object.freeze({ id: 'goose', label: 'Goose', command: 'goose', enabled: true, sortOrder: 40 }),
  Object.freeze({ id: 'droid', label: 'Droid (Factory)', command: 'droid', enabled: false, sortOrder: 50 }),
  Object.freeze({ id: 'gemini', label: 'Gemini CLI', command: 'gemini', enabled: true, sortOrder: 60 }),
  Object.freeze({ id: 'qwen', label: 'Qwen Code', command: 'qwen', enabled: true, sortOrder: 70 }),
  Object.freeze({ id: 'opencode', label: 'OpenCode', command: 'opencode', enabled: true, sortOrder: 80 }),
  Object.freeze({ id: 'amp', label: 'Amp', command: 'amp', enabled: false, sortOrder: 90 }),
  Object.freeze({ id: 'cursor', label: 'Cursor CLI', command: 'cursor-agent', enabled: true, sortOrder: 100 }),
  Object.freeze({ id: 'kimi', label: 'Kimi Code (motor)', command: 'kimi', enabled: true, sortOrder: 110 }),
  Object.freeze({ id: 'crush', label: 'Crush', command: 'crush', enabled: true, sortOrder: 120 }),
  // ENG-ENABLE-01 — antigravity AÇIK: ENG-22'nin kimlik engeli ürün gramerine
  // eklendi (`identity.kind:'flag-dir'` + `cwdFirst`) ve gerçek pane'de kimlikli bir
  // worker iş bitirdi; giriş ABONELİKLE koştu (anahtar YOK). Kalan sınır (ev dizinini
  // taşıyan env YOK → pane başına hesap/araç ayrımı yok) bir EKSİKtir, rozet ve
  // `partial` onu söyler — pane'i öldürmez. Gerekçenin tamamı migration başlığında.
  Object.freeze({ id: 'antigravity', label: 'Antigravity CLI', command: 'agy', enabled: true, sortOrder: 130 }),
  // ENGINE-MUSE-02 — muse KAPALI: kimlik taşıyıcısının semantiği (ADDITIVE mi
  // REPLACE mi) ve alt-ajan SERT bloğu ölçülemedi — ikisi de hesap duvarının
  // arkasında. Gerekçenin tamamı migration başlığında + engineRegistry.unsupported.
  Object.freeze({ id: 'muse', label: 'Muse Code', command: 'muse', enabled: false, sortOrder: 140 }),
]);

/**
 * ENG-ENABLE-01 — KONTROL KOLU (motor başına geri alma).
 *
 * `CREWPANE_ENGINE_OFFERING_OFF=kimi,cursor` verilen motorları ürünle gelen
 * hükümden BAĞIMSIZ olarak "hazır değil"e çeker. Amacı iki yönlüdür:
 *   ① bir açılış arıza yaparsa Eren uygulamayı yeniden kurmadan geri alabilir,
 *   ② bir düzeltmenin GERÇEKTEN o düzeltme olduğu kanıtlanabilir — kolu çekince
 *      ESKİ davranış (formda "hazır değil" + seçilemez) bit-bit geri gelmeli.
 * Kol yalnız KAPATIR: burada olmayan bir motoru AÇAMAZ (kapalı raf, açılamayan
 * bir motoru env ile açılabilir yapmak ENG-15'in kapattığı sınıf hatadır).
 */
function offeringOffSet(env) {
  const raw = (env || process.env || {}).CREWPANE_ENGINE_OFFERING_OFF;
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const ids = raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return ids.length ? new Set(ids) : null;
}

/** `{ <id>: boolean }` — ürünle gelen "sunulsun mu" hükmü (kontrol kolu uygulanmış). */
function seedEnabledMap(env) {
  const off = offeringOffSet(env);
  const out = {};
  for (const row of SEED) out[row.id] = row.enabled && !(off && off.has(row.id));
  return out;
}

/**
 * Bir motor SUNULABİLİR mi? Kayıtsız kimlik `false` döner: tanımadığımız bir motoru
 * sessizce açık saymak, tam olarak ENG-15'in bulduğu sınıf hatadır.
 */
function isOffered(engineId, env) {
  const row = SEED.find((r) => r.id === engineId);
  if (!(row && row.enabled)) return false;
  const off = offeringOffSet(env);
  return !(off && off.has(row.id));
}

module.exports = { SEED, seedEnabledMap, isOffered, offeringOffSet };
