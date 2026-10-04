// AD-WIN-02 — SİSTEM PROMPTU TAVANININ TEK KAYNAĞI (tavan artık YOLA GÖRE seçilir).
//
// NEDEN VAR. `MAX_SYSTEM_PROMPT_LEN = 8000` iki ayrı dosyada ELLE kopyalanmıştı
// (`agentRunner.js:123`, `livePaneRegistry.cjs:199`). İkisi de aynı sayıyı savunuyordu
// ama tek bir gerçekleri yoktu: biri düzeltilse öteki kesmeye devam ederdi.
//
// TAVANIN GEREKÇESİ NEYDİ. Kimlik `--append-system-prompt <metin>` ile KOMUT
// SATIRINDAN geçiyordu; Windows'ta motor `claude.cmd` ise argv cmd.exe sarmalayıcısına
// girer ve 8.191 karakterlik tavan devreye girer (AD-WIN-01 §1.2: ölçülen lider komut
// satırı 8.520 → 329 karakter taşıyor). 8.000, o duvarın ALTINDA kalmak için seçilmiş
// bir bütçeydi.
//
// GEREKÇE NEDEN KALKTI. AD-WIN-01 kimliği `--append-system-prompt-file <yol>` ile
// DOSYAYA taşıdı (spawnPromptFile.cjs). Dosya yolu kullanıldığında komut satırına
// yalnız YOL girer (ölçüldü: aynı spawn 8.520 → 617 karakter). Metnin uzunluğunun
// komut satırıyla artık hiçbir ilgisi yoktur — ama tavan yerinde kaldı.
//
// MÜŞTERİDE ÖLÇÜLEN BEDELİ (Cihan, Windows 11, 0.2.37 logu):
//     [memory] blok DÜŞTÜ: kimlik+protokol 9005 ch, tavan 8000 → hafızaya yer kalmadı
//   yani (a) 9.005 karakterlik kimlik+protokol 8.000'de KUYRUKTAN kesiliyor ve
//   (b) hafıza bloğuna HİÇ yer kalmıyor → ajan kalıcı hafızasını hiç görmüyor.
//   ("CrewPane'de böyle bir araç varsa görmüyorum" şikâyetinin muhtemel kaynağı.)
//
// ── KARAR: TAVAN TAŞIYICIYA GÖRE ───────────────────────────────────────────
//   • `cli`  (metin komut satırında)  → 8.000. DEĞİŞMEDİ. Bu dal hâlâ gerçek bir
//     işletim sistemi duvarına bakıyor (dosya bayrağını desteklemeyen eski motor,
//     codex, macOS'un bugünkü yolu). Tavanı kaldırmak orada bir REGRESYONDUR.
//   • `file` (metin dosyada, argv'de yalnız yol) → 64.000. Duvar yok; bu sayı bir
//     GÜVENLİK SINIRIDIR, bütçe değil: kaçak/kötücül bir kimlik diski ve motorun
//     bağlamını şişirmesin diye.
//
//     🪤 32.000'DEN 64.000'E ÇIKARILDI (MEM-SCOPE-01, 09.09) — ÖLÇÜLMÜŞ GEREKÇE.
//     Eski sayının dayanağı "bugünkü en büyük gerçek kompozisyon ~12 K"ydı. O
//     varsayım TOKEN-BUDGET-01'le GEÇERSİZ oldu: bağlam kapsamı, motorun kendi
//     enjekte edeceği belgeleri (proje talimatı zinciri + kalıcı hafıza indeksi)
//     ARTIK KİMLİK METNİNE koyuyor. Bu makinede ölçülen gerçek kompozisyon:
//         kimlik+protokol 9.538 · hafıza payı 2.600 · proje talimatları 4.773 ·
//         motor hafıza indeksi bloğu 22.010  =  ~38,9 K
//     32.000 tavanı bunu KUYRUKTAN kesecekti; kesilen yer de kimliğin MÜHRÜ
//     olurdu (metin `bağlam + kimlik` sırasıyla örülüyor). Uygulamada olan şuydu:
//     paneContextScope HEPSİ-YA-HİÇ kuralıyla İPTAL ediyor, hiçbir env set
//     etmiyor ve pane motorun tam-boy enjeksiyonuna dönüyordu — yani tavan,
//     kesimi SESSİZCE devre dışı bırakıyordu (mem-scope-proof ilk koşusunda
//     dört kontrol birden bu yüzden düştü).
//     64.000 = ölçülen en büyük gerçek kompozisyonun ~1,6 katı; sınır bir sınır
//     olarak kalır, bütçe olmaktan çıkar. Bu bir KOMUT SATIRI değildir: dosya
//     dalında hiçbir işletim sistemi duvarı yoktur (AD-WIN-01 ölçümü).
//
//   `STORAGE` (livePaneRegistry) = `file` tavanı. Kayıt defteri bir KOMUT SATIRI
//   değildir; oradaki sınır yalnız disk şişmesine karşıdır ve dosya yoluyla spawn
//   edilmiş bir pane'in promptunu restart'ta KESMEMELİDİR (kesseydi restore edilen
//   pane, ilk spawn'dan farklı bir kimlikle geri gelirdi — sessiz bir davranış farkı).

'use strict';

/** Metin KOMUT SATIRINDAN geçiyor: cmd.exe'nin 8.191 duvarının altında kalan bütçe. */
const CLI_MAX = 8000;

/** Metin DOSYADAN geçiyor (`--append-system-prompt-file`): duvar yok, yalnız sınır. */
const FILE_MAX = 64000;

/** livePaneRegistry'nin disk sınırı — dosya yolunu KESMEMELİ (bkz. başlık). */
const STORAGE_MAX = FILE_MAX;

/**
 * Taşıyıcıya göre tavan. `carrier`: 'file' | 'cli' (bilinmiyorsa GÜVENLİ olan 'cli').
 * @returns {number}
 */
function systemPromptCap(carrier) {
  return carrier === 'file' ? FILE_MAX : CLI_MAX;
}

/** Tavanı aşan metni KUYRUKTAN kırp (kırpma yoksa aynı dizeyi döndürür). */
function clampSystemPrompt(text, cap) {
  if (typeof text !== 'string') return text;
  const limit = Number.isFinite(cap) && cap > 0 ? cap : CLI_MAX;
  return text.length > limit ? text.slice(0, limit) : text;
}

module.exports = { CLI_MAX, FILE_MAX, STORAGE_MAX, systemPromptCap, clampSystemPrompt };
