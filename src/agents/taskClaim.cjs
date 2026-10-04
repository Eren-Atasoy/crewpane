// ADP-896 — GÖREV TALEBİ (task claim): "aynı ajana aynı GÖREV için ikinci pane" kapısı.
//
// VAKA (2026-08-04, ölçüldü): `pane-122` (bumblebee, ADP-894) uçuştayken `pane-128`
// AYNI ADP-894 etiketiyle açıldı; `pane-125` (wheeljack, ADP-893) uçuştayken `pane-127`
// aynı görevle açıldı — ve pane-127 kendi raporuna "aynı göreve ikinci wheeljack süreci
// koşuyordu (pid 85571)" yazdı. İki worker AYNI REPODA paralel çalışınca biri diğerinin
// index'ini/çalışmasını süpürüyor (paylaşımlı-ağaç dersi).
//
// KÖK: `dedupeSpawnForAgent` yalnız "bu AJANIN canlı pane'i var mı" sorar ve
// `forceFresh` bayrağı o kapıyı TAMAMEN atlar (ADP-289 karantina istisnası). Yani
// "aynı GÖREV zaten uçuşta mı" sorusu hiçbir yerde SORULMUYORDU.
//
// BU MODÜL saf karar mantığıdır (fs/electron yok → `node --test`lenebilir). Kapı
// ADP-761 §4'ün kuralına uyar: karar pane'i DOĞURAN tek noktada verilir, çağrı
// yollarına kopyalanmaz.
//
// ⚖️ İSTİSNA KORUNUR — ADP-289/ADP-705 kurtarması: takılı (stalled) bir pane'e ASLA
// yazılmaz, ajana TAZE pane açılır. O yol `forceFresh` ile gelir ve mevcut aynı-görev
// pane'i STALLED ise kapı GEÇİRİR (kurtarma ölmesin). Engellenen şey yalnızca
// SAĞLIKLI/canlı bir aynı-görev pane'inin ikizidir — yani gerçek paralel-worker riski.

'use strict';

// Görev kodu: etiketin BAŞINDAKİ pano kodu. Etiket "ADP-894 — Windows terminal…"
// biçiminde gelir (subtask başlığı). Kod bulunamazsa kapı KARAR VERMEZ (allow) —
// isimsiz işi engellemek yanlış-pozitif üretirdi.
//
// 🔴 B-01 (bulgu F-6) — KOD ÇIKARIMI ARTIK BURADA YAŞAMIYOR. Buradaki eski regex
// `ADP-\d+ | AD-\d+ | TASK-[A-Z0-9]{6,}` idi ve **`B-01`, `A-02`, `C-07`, `W-03`,
// `DF-01` biçimlerini HİÇ eşleştirmiyordu** → etiketi yalnız kısa kod taşıyan bir
// görevde bu kapı hiç ateşlenmedi (B-01k ölçümü; B-01k spike'ının kendisi bu yüzden
// iki ajana birden spawn edildi — F-8). Git omurgası AYNI kodu branch adı için
// kullanacağı için çıkarım tek modüle taşındı: `taskCode.cjs`. Bu dosya onu
// KOPYALAMAZ, ÇAĞIRIR — iki uygulama olsaydı "aynı görev" tanımı yine ayrışırdı.
const path = require('node:path');
const { taskCodeOf } = require('./taskCode.cjs');

/**
 * Aynı ajan + aynı görev kodu için CANLI bir pane var mı?
 *
 * @param {Array<{paneId:string, agentId?:string|null, label?:string|null, stalled?:boolean}>} livePanes
 * @param {{agentId?:string|null, label?:string|null}} req
 * @returns {{paneId:string, stalled:boolean}|null}
 */
function findClaim(livePanes, req) {
  const agentId = typeof req?.agentId === 'string' ? req.agentId.trim() : '';
  const code = taskCodeOf(req?.label);
  if (!agentId || !code) return null;
  for (const p of livePanes || []) {
    if (!p || p.agentId !== agentId) continue;
    if (taskCodeOf(p.label) !== code) continue;
    return { paneId: p.paneId, stalled: p.stalled === true };
  }
  return null;
}

/**
 * KAPI KARARI — bu spawn isteği yeni bir pane doğurmalı mı?
 *
 * @param {Array<object>} livePanes canlı pane defteri (agentId/label/stalled)
 * @param {{agentId?:string|null, label?:string|null, forceFresh?:boolean}} req
 * @returns {{action:'allow'|'reuse', paneId?:string, code?:string, why:string}}
 *   'reuse' → ikinci pane AÇILMAZ; çağıran mevcut pane'e yönlendirilir.
 */
function decideSpawn(livePanes, req) {
  const code = taskCodeOf(req?.label);
  if (!code) return { action: 'allow', why: 'etikette görev kodu yok — kapı karar vermez' };
  const claim = findClaim(livePanes, req);
  if (!claim) return { action: 'allow', code, why: `${code} için bu ajanda canlı pane yok` };
  if (claim.stalled) {
    // ADP-289 KURAL-1: takılı pane'e yazmak yasak → kurtarma taze pane açmalı.
    // (forceFresh olsun olmasın: takılı pane'e yönlendirmek prompt'u yutturmak olurdu.)
    return {
      action: 'allow',
      code,
      paneId: claim.paneId,
      why: `${code} pane'i ${claim.paneId} TAKILI (stalled) — ADP-289/705 kurtarması geçirilir`,
    };
  }
  return {
    action: 'reuse',
    code,
    paneId: claim.paneId,
    why:
      `${code} zaten UÇUŞTA (paneId=${claim.paneId}, aynı ajan, takılı değil) — ` +
      'ikinci pane açmak aynı repoda paralel worker demektir (ADP-896)',
  };
}

/**
 * ADP-953 — `forceFresh` İDDİASININ DOĞRULANMASI (saf karar).
 *
 * `forceFresh` ADP-289'un bilinçli karantina kaçışıdır, ama SADECE bir bayraktı:
 * çağıran "bu ajanın pane'i takılı" derse main sorgusuz ikinci pane veriyordu.
 * WINDOWS'ta bu iddia düzenli olarak YALAN çıktı — ConPTY ekranı yeniden çizerken
 * worker'ın `DONE:` satırını gizliyor (bkz. delegationSupervisor.markerCount ve
 * delegation.ts ANSI final aralığı), alt-görev 'done' olmuyor, pane SAHTE `stalled`
 * damgalanıyor ve sıradaki dispatch o sahte duruma dayanarak `forceFresh` gönderiyor
 * → aynı ajana İKİZ PANE. macOS'ta pty claude'un kendi çıktısını taşıdığı için
 * yeniden çizim yok, delik hiç görünmüyordu.
 *
 * Kural (ADP-487'nin dersi, bir kez daha): KAPI ÇAĞIRANIN İDDİASINA DEĞİL, KENDİ
 * DEFTERİNE BAKAR. Üç meşru sebep ayrı ayrı adlandırılır:
 *   • 'quarantine' (ADP-289) → DOĞRULANIR: defterde `stalled` değilse REDDEDİLİR.
 *   • 'replace'    (ADP-761) → çağıran eski pane'i az önce kapattı (kapanış asenkron);
 *     yalnız `retirePaneId` ile BİLDİRİLEN pane için geçer — açık çek değildir.
 *   • 'recovery'   (ADP-705) → teslimat doğrulaması başarısız; kanıt renderer'da,
 *     main ölçemez → geçirilir (bütçe: alt-görev başına TEK taze pane).
 * Sebep bildirilmemişse EN DAR yorum uygulanır: 'quarantine' (yani doğrulanır).
 *
 * @param {{paneId:string, stalled?:boolean}|null} twin ajanın main defterindeki canlı pane'i
 * @param {{freshReason?:string, retirePaneId?:string}} req spawn isteği
 * @returns {{honored:boolean, reason:string, why:string}}
 *   honored=false → ikinci pane AÇILMAZ, mevcut pane REUSE edilir.
 */
function decideForceFresh(twin, req) {
  const reason = typeof req?.freshReason === 'string' ? req.freshReason : 'quarantine';
  if (!twin) return { honored: true, reason, why: 'ajanın canlı pane\'i yok — ikizlenecek bir şey yok' };
  if (reason === 'replace') {
    const match = !!req?.retirePaneId && req.retirePaneId === twin.paneId;
    return match
      ? { honored: true, reason, why: `REPLACE: ${twin.paneId} kapatılıyor (kapanış asenkron) — taze pane meşru` }
      : {
          honored: false,
          reason,
          why:
            `REPLACE bildirildi ama retirePaneId=${req?.retirePaneId ?? '-'} canlı pane ` +
            `${twin.paneId} ile eşleşmiyor — açık çek değil, REUSE`,
        };
  }
  if (reason === 'recovery') {
    return { honored: true, reason, why: 'ADP-705 teslimat kurtarması — kanıt renderer\'da, bütçe alt-görev başına 1' };
  }
  // 'quarantine' (ve bilinmeyen/eksik sebep) → main'in KENDİ defteri karar verir.
  return twin.stalled === true
    ? { honored: true, reason, why: `KARANTİNA doğrulandı: ${twin.paneId} defterde stalled — ADP-289 KURAL-1` }
    : {
        honored: false,
        reason,
        why:
          `KARANTİNA iddiası DOĞRULANMADI: ${twin.paneId} defterde stalled DEĞİL — ` +
          'sahte stall (ör. Windows/ConPTY) ikiz pane açamaz (ADP-953)',
      };
}

/**
 * ENG-OPENCODE-DB-01 (C4, OC-DESIGN-0919 §5(d) karar D1) — İZOLASYON İKİZİ KAPISI.
 *
 * Ortak yerel deposu olan motorlarda (`descriptor.isolation`, bugün opencode)
 * `applyPaneIsolationEnv` depoyu AJAN anahtarıyla üretir: restart-resume için
 * deterministik olmak ZORUNDA (`--continue` = "o DB'deki son oturum"). Bedeli: aynı
 * ajanın İKİNCİ canlı pane'i (ADP-289 karantina, ADP-761 replace, ADP-705 recovery —
 * hepsi meşru; artı `ref_delegation_late_fire_duplicate`: ölü dispatch'in geç canlanan
 * ikizi) AYNI dosyayı alırdı. ÖLÇÜLDÜ (RESEARCH-OC-01 §2.4): taze ortak DB'yi iki
 * süreç aynı anda göç ettirince biri `Failed query: CREATE TABLE workspace` ile
 * exit 1 — ENG-16'nın `database is locked`ının kardeşi.
 *
 * KARAR (board kartı, Eren 19.09): ikinci pane REDDEDİLMEZ — ADP-289 KURAL-1'in
 * kurtarması (takılı pane'e yazma, taze pane aç) ölmesin. Onun yerine ikiz AYRI bir
 * dosya alır (`<anahtar>--2`, o da açıksa `--3` …) ve pane'e tek satır bilgi basılır.
 * Yol adı DETERMİNİSTİK (zaman damgası yok) → aynı durum aynı dosyayı verir, test
 * edilebilir; artık dizinler `engine-isolation/` altında kalır (bugünkü temizlik
 * kapsamı). Saf karar: fs yok, `path.join` dışında yan etki yok.
 *
 * @param {string[]|null|undefined} liveFiles canlı pane'lerin ÜRÜN-ÜRETİMİ izolasyon
 *   dosyaları (main'in pty defterinden; kullanıcı kendi env'ini ezmişse o pane listede
 *   YOKTUR — ürün onun deposunu bilmez ve ayıramaz)
 * @param {{root:string, paneKey:string, fileName:string}} want kanonik yolun parçaları
 *   (`<root>/<paneKey>/<fileName>`; root = `<home>/engine-isolation/<motor>`)
 * @returns {{action:'allow'|'separate', file:string, paneKey:string, twinOf:string|null, why:string}}
 *   `separate` → çağıran `file`i kullanır ve kullanıcıya "ayrı veritabanıyla açıldı" der.
 */
function decideIsolationTwin(liveFiles, want) {
  const root = String(want && want.root);
  const key = String(want && want.paneKey);
  const fileName = String(want && want.fileName);
  const canonical = path.join(root, key, fileName);
  const live = new Set((Array.isArray(liveFiles) ? liveFiles : []).filter((f) => typeof f === 'string' && f));
  if (!live.has(canonical)) {
    return { action: 'allow', file: canonical, paneKey: key, twinOf: null, why: 'dosya canlı bir pane\'de açık değil' };
  }
  // Küçük, sabit üst sınır: aynı ajanın 100 canlı pane'i ürün tarafından zaten
  // açılamaz (ajan tekilliği kapısı); sınır yalnız döngünün sonlu olduğunu garantiler.
  for (let n = 2; n < 100; n += 1) {
    const twinKey = `${key}--${n}`;
    const file = path.join(root, twinKey, fileName);
    if (!live.has(file)) {
      return {
        action: 'separate',
        file,
        paneKey: twinKey,
        twinOf: canonical,
        why: `${canonical} canlı bir pane'de açık — ikinci pane taze DB şema yarışına girmesin diye AYRI depo (${twinKey})`,
      };
    }
  }
  return { action: 'allow', file: canonical, paneKey: key, twinOf: null, why: 'ikiz anahtarı bulunamadı (99 canlı ikiz?) — kanonik yola düşüldü' };
}

module.exports = { taskCodeOf, findClaim, decideSpawn, decideForceFresh, decideIsolationTwin };
