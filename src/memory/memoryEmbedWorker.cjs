// CrewPane — ADP-871 (Faz 3) SORGU GÖMME ÇOCUĞU.
//
// Tek iş: gelen metni vektöre çevirip geri yollamak. Model (543 MB ağırlık, ~1.6 GB
// tepe RSS) main sürecin yığınına GİRMEZ ve tokenizer/ONNX işi main'in olay döngüsünü
// BLOKLAMAZ — ADP-870 §4c bunu ölçtü: süreç-içi gömme 28 saniyede olay döngüsünü 24
// kez 100 ms'den uzun bloklamış, en uzunu 2.9 saniye ("uygulama dondu").
//
// 🪤 `process.exit` ÇAĞIRMIYORUZ (ADP-870 §7): onnxruntime'ın iş parçacığı havuzu
// ayaktayken statik yıkıcılar koşuyor ve süreç `exit 134` (SIGABRT) ile ölüyor —
// veri sağlam olsa bile çıkış kodu YALAN söylüyor. Doğal çıkışa bırakılır.

'use strict';

const embedder = require('./memoryEmbedder.cjs');
const childIpc = require('../core/childIpcSafe.cjs'); // ONNX-CRASH-02 — kapalı kanala send

const argOf = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : null;
};

// 🔴 ONNX-CRASH-02 — BURASI 20 ÇÖKMENİN KAYNAĞIYDI. Eski hâli `try { process.send(msg) }
// catch {}` idi ve bu HİÇBİR ŞEY tutmuyordu: kanal kapalıyken Node senkron hata
// fırlatmaz, `nextTick`te process üzerine dinleyicisiz bir 'error' olayı yayar
// (ERR_IPC_CHANNEL_CLOSED) → uncaughtException → exit → onnxruntime statik yıkıcıları
// → SIGABRT. Yeniden üretildi: ebeveyni 300 ms sonra kopar, çocuk model yüklemesi
// biter bitmez (0,97 sn) `signal=SIGABRT` ile ölür — diskteki 20 kaydın ömrüyle
// (0,88–2,0 sn) birebir aynı. Gerekçe ve doğru fren: childIpcSafe.cjs başlığı.
const send = (msg) => childIpc.safeSend(msg);

// İkinci kemer: gerçek istisna artık KAYBOLMAZ — ebeveyne {type:'error'} olarak gider
// ve stderr'e yığınıyla düşer. `process.exit` ÇAĞRILMAZ (ADP-870 §7).
childIpc.installChildGuards({ label: 'memoryEmbedWorker', send });

// MEMIDX-LEAK-01 — YETİM NÖBETÇİSİ (gerekçe: childIpcSafe.cjs · installOrphanGuard).
// Bu çocuk normalde IPC kanalıyla YAŞAR, yani kanal kapanınca kendiliğinden biterdi —
// ama kanal kapandığı anda uçuşta bir `embed()` varsa (543 MB model, saniyeler süren
// ONNX çıkarımı) sonucu kimse beklemiyor olmasına rağmen koşmaya devam eder. Nöbetçi
// bunu AÇIK bir kurala bağlar: cevabın alıcısı yoksa iş de bitirilir.
childIpc.installOrphanGuard({ label: 'memoryEmbedWorker' });

async function main() {
  const t0 = Date.now();
  // WIN-W6A — motor seçimi burada YAPILMAZ, SORULUR: yerel kuruluysa yerel, değilse
  // (kullanıcının anahtarı varsa) barındırılan. Bu çocuk hangi dalın koştuğunu
  // umursamaz; `embed()` sözleşmesi her dalda aynıdır.
  const eng = await embedder.createEmbedder({ repoRoot: argOf('repo') || null });
  if (!eng.ok) {
    // Sessiz ölüm yasak: ebeveyn `message`i kullanıcıya gösterebilsin (yerel neden
    // TEK BAŞINA yetmez — "model inmemiş" ile "anahtar da yok" farklı işlerdir).
    send({
      type: 'unavailable',
      reason: eng.hostedReason || eng.reason,
      localReason: eng.reason,
      message: eng.message || null,
      settingsTarget: eng.settingsTarget || null,
    });
    return; // exit YOK — kanal kapanınca süreç kendiliğinden biter
  }
  send({
    type: 'ready',
    kind: eng.kind || 'local',
    provider: eng.provider || null,
    model: eng.model,
    dtype: eng.dtype,
    dim: eng.dim,
    // ONNX-CRASH-01 — tavan artık BEYAN edilir: "sorgum neden kırpıldı" sorusunun
    // cevabı uydurulmaz. Barındırılan dalda tavan sağlayıcınındır → null.
    maxTokens: eng.maxTokens || null,
    loadMs: Date.now() - t0,
  });

  process.on('message', async (msg) => {
    if (!msg || msg.type !== 'embed') {
      if (msg?.type === 'bye') process.disconnect?.();
      return;
    }
    try {
      // 🔴 ONNX-CRASH-01 — SORGU YOLUNDA TAVAN YOKTU. Buraya gelen metin ajanın
      // GÖREV METNİdir (D-07: sorgu = işin kendisi) ve kilobaytlarca olabilir;
      // dikkat tensörü uzunluğun KARESİYLE büyüdüğü için bu yol tek başına 8+ GB
      // isteyebiliyordu (ölçüm: memoryEmbedLimits.cjs başlığı). Tavan artık
      // `eng.embed` içinde: uzun metin ÇÖKMEZ, parçalanır ve ortalanır.
      const [vec] = await eng.embed([String(msg.text || '')]);
      const plan = eng.lastEmbedPlan?.() || null;
      // Float32Array IPC'de yapılandırılmış klonla geçmez → düz diziye çevir.
      send({
        type: 'vector',
        id: msg.id,
        vec: Array.from(vec),
        ms: Date.now() - (msg.at || Date.now()),
        // Kırpma SESSİZ OLMAZ: çağıran "bu vektör metnin tamamını temsil etmiyor"u
        // bilsin (yalnız gerçekten bölündüyse dolar).
        ...(plan && plan.split ? { pieces: plan.pieces, truncated: Boolean(plan.truncated), maxTokens: plan.maxTokens } : {}),
      });
    } catch (err) {
      send({ type: 'error', id: msg.id, reason: err.message });
    }
  });
}

main().catch((err) => {
  send({ type: 'unavailable', reason: err.message });
  process.exitCode = 1;
});
