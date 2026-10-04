// BR-02 / INT-BRIDGE-03 (ADR-INT-BRIDGE §3) — ÜÇ-DURUM KONUŞMA PROTOKOLÜ.
//
// ─────────────────────────────────────────────────────────────────────────────
// NEDEN BU DOSYA VAR
// ─────────────────────────────────────────────────────────────────────────────
// BR-01 ajana bir SORU açtı (`crewpane_integrations`): "ne bağlı, izin beyanı ne,
// en son ne zaman doğrulandı". Ama soruyu sorabilmek DAVRANIŞ demek değildir:
//   • ajan hiç sormadan "Sentry yok herhalde" deyip pes edebilir,
//   • bağlıyken bile kullanıcıdan "sen bağlar mısın" isteyebilir,
//   • 403 gövdesini olduğu gibi kullanıcının yüzüne basabilir,
//   • bağlı değilken sessizce bloke olup işin YAPILABİLİR kısmını da bırakabilir.
// Ürün kuralı (Eren): "entegrasyonun kullanıcısı ayar ekranı değil, AJANDIR." Bu
// dosya o cümlenin DAVRANIŞ karşılığıdır: her ajan pane'ine giren TEK kalıp metni.
//
// ─────────────────────────────────────────────────────────────────────────────
// İKİ TAŞIYICI, TEK KAYNAK
// ─────────────────────────────────────────────────────────────────────────────
//   1) SİSTEM PROMPTU — agentRunner `withIdentity` zinciri (claude:
//      `--append-system-prompt`, codex: pozisyonel prompt). Ajan aracı ÇAĞIRMADAN
//      ÖNCE de doğru davranmalı ("önce sor"u söyleyen şey budur — [[prompt-is-filter-not-trigger]]:
//      araç açıklamasına yaslanmak BOOTSTRAP AÇIĞI bırakır, ajan aracı hiç açmazsa
//      protokol hiç başlamaz).
//   2) ARAÇ CEVABININ SONU — `crewpane-integrations-mcp.cjs` her cevabın altına
//      `TOOL_FOOTER`i basar. Aynı kurallar, ikinci bir yerde YENİDEN YAZILMADAN
//      (metin çatallanırsa iki farklı ajan davranışı doğar).
//
// 🪤 UZUNLUK TUZAĞI (ÖLÇÜLDÜ, 2026-08-12): sistem promptu `sanitizeSystemPrompt`
// ile 8000 karakterde KUYRUKTAN kırpılır ve canlı bir pane'de kompozisyon 8423
// karakterdi — yani SONA eklenen bir metin O PANE'DE SESSİZCE YOK OLURDU. Protokol
// bu yüzden BAŞA eklenir (PLAIN_OFFICE_GUARD emsali) ve bilerek KISA tutulur.
//
// SAF + IO'SUZ (fs/net yok) → `node --test` doğrudan koşar ([[leaf-module-node-test]]).

'use strict';

/**
 * Üç-durum protokolünün ÇEKİRDEĞİ (ADR §3 metni).
 *
 * Kurallardaki hükümler uydurma değil, ÖLÇÜLMÜŞ vakaların dersidir:
 *   • "plan/limit ≠ izin" — INT-OBS-02 canlı vakası: PostHog ücretsiz planı proje
 *     tavanına çarptı, ürün bunu "project:write izni eksik" diye çevirip kullanıcıyı
 *     boş yere anahtar yenilemeye gönderdi (izin SEÇİLİYDİ). Yanlış teşhis sessizlikten beterdir.
 *   • "izin adını sunucudan al" — 403 gövdesi kapsam ADINI söylüyorsa tahmin etmenin
 *     hiçbir mazereti yok.
 *   • "beyan ≠ hüküm" — `scopeHint` kullanıcının BEYANIDIR; kesin hüküm gerçek çağrının cevabı.
 *   • "bağlı ≠ bu pane'de canlı" — ADR §2.3: kullanıcı pane açıkken bağlarsa araç o
 *     pane'de YOKTUR; ayırmazsak ajan "bağlı ama tool bulamıyorum" diye çıldırır.
 */
const INTEGRATION_PROTOCOL = [
  '🔌 ENTEGRASYON PROTOKOLÜ — bir dış servise (Sentry, GitHub, PostHog, Supabase, Stripe…) ihtiyacın olduğunda',
  'ÖNCE `crewpane_integrations` aracıyla durumu SOR. Tahmin etme: ne "yoktur herhalde" deyip pes et, ne de',
  '"vardır" deyip körlemesine dene. Sonra duruma göre KONUŞ:',
  '• BAĞLI + araç bu pane\'de → işi KENDİN yap, sonucu raporla ("…yaptım: <sonuç>"). Kullanıcıdan bağlamasını İSTEME.',
  '• BAĞLI ama araç bu pane\'de yok → "az önce bağlanmış; yeni bir pane\'de (ya da beni yeniden başlatınca) yaparım".',
  '• BAĞLI ama YETKİSİZ (çağrı 401/403 verdi ya da beyan edilen izin bu işi taşımıyor) → eksik izni ADIYLA söyle ve',
  '  nereden ekleneceğini tarif et (araç cevabındaki yol tarifi). İzin adını SUNUCUNUN cevabından al, uydurma;',
  '  sunucu "plan/limit" diyorsa bu bir İZİN sorunu DEĞİLDİR, öyle sunma; izin beyanı BEYANDIR, kesin hüküm sunucunun cevabıdır.',
  '• BAĞLI DEĞİL → "Ayarlar → Entegrasyonlar\'dan bağlarsan senin için şunu yaparım: <somut iş>" de, bağlama yolunu göster,',
  '  o işi BEKLET; bloke OLMAYAN kısmı sürdür. Entegrasyonu kendin kurmaya/anahtar üretmeye KALKMA.',
  'ASLA: çıplak HTTP kodu / stack trace / ham hata gövdesini kullanıcıya çözümmüş gibi gösterme (sade cümleye çevir,',
  'ayrıntıyı ancak istenirse ver) · kullanıcıyı o servisin kendi panelinde CrewPane kurulumu yapmaya yönlendirme ·',
  'olmayan bir entegrasyonu varmış gibi anlatma.',
].join('\n');

/**
 * codex pane'i için EK cümle. ADP-227 kararı: entegrasyon SIRLARI codex'e
 * enjekte edilmez (argv'ye düşerdi) → servis araçları o pane'de YOKTUR; keşif
 * aracı vardır. Ajan bunu dürüstçe söylemeli, "yaptım" diye uydurmamalı.
 *
 * 🪤 CDX-BROWSER-03 — KAPSAM CÜMLESİ ŞART (ölçüldü, Eren QA 0.2.43-dev.1).
 * Notun eski hâli "entegrasyon ARAÇLARI burada yüklü DEĞİLDİR" diyordu. Bu, KAPSAMSIZ
 * bir yokluk hükmüydü ve prompt'un EN BAŞINDA duruyordu; ayrıca modele hazır bir RET
 * CÜMLESİ ("bu iş için claude pane'i gerekir") veriyordu. Codex lider pane'i bunu KENDİ
 * MCP araçlarına da uyguladı: kimlikte `## Tarayıcı` bölümü (BROWSER_TOOL_BASELINE,
 * offset 6325) TESLİM EDİLMİŞ ve `/mcp` listesinde `crewpane_browser` GÖRÜNÜYORKEN
 * "Bu pane'de crewpane_browser aracı yüklü değil. Bu iş için Claude pane'i gerekir."
 * dedi — yani notun iki cümlesini birleştirip tekrarladı.
 * Nedensellik KONTROL KOLUYLA ölçüldü (gerçek codex 0.147.0 + gerçek crewpane-browser
 * MCP, tek değişken): teslim edilen metin birebir → 0 çağrı; SADECE bu not sökülünce →
 * navigate + screenshot + gerçek PNG. Bu yüzden yokluk hükmü DIŞ SERVİSLERE bağlıdır ve
 * pane'in KENDİ araçları ADIYLA "var" sayılır. Kapsamı kaldırmak kusuru geri getirir
 * (kilit: integrationBriefing.test.cjs "CDX-BROWSER-03").
 *
 * 🪤 IDN-BUDGET-01 — UZUNLUK KAPISI: `cdxF1Effort.test.cjs` H5 bu notun tam protokolün
 * ÜÇTE BİRİNDEN kısa kalmasını şart koşar (codex bütçesi 8.000'lik komut satırı duvarına
 * bakar; not büyüdükçe kimliğin payı küçülür). CDX-BROWSER-03'ün kapsam cümlesi notu
 * 273 → 454'e çıkarmış ve o kapıyı 9 karakterle aşmıştı; anlam korunarak geri sığdırıldı.
 * Yeni cümle eklemeden ÖNCE var olanı sıkıştır.
 */
const CODEX_ENGINE_NOTE =
  '🔌 ENTEGRASYON: bu pane codex motorunda koşuyor — DIŞ SERVİSLERİN (Sentry/GitHub/PostHog/'
  + 'Supabase/Stripe…) entegrasyon araçları burada yüklü DEĞİLDİR (sorabilirsin, yapamazsın); '
  + 'ÖYLE bir iş gelirse uydurma, "bu iş için claude pane\'i gerekir" de ve bloke '
  + 'OLMAYAN kısmı sürdür. Bu hüküm YALNIZ o dış servisler içindir: bu pane\'in KENDİ MCP '
  + 'araçları (crewpane_browser, crewpane_task, crewpane_delegate…) YÜKLÜDÜR — onları '
  + '"yok" sayma, ÇAĞIR.';

/**
 * Araç cevabının altına basılan KISA hatırlatma. Sistem promptu 8000 karakter
 * kapağına takılıp kırpılsa bile ajan kalıbı burada TEKRAR görür (iki taşıyıcı).
 */
const TOOL_FOOTER =
  'NASIL KONUŞ: bağlı + araç bu pane\'de ise işi KENDİN yap ve sonucu raporla · araç 401/403 verirse ya da beyan '
  + 'edilen izin işi taşımıyorsa eksik izni ADIYLA söyle ve nereden ekleneceğini tarif et (beyan BEYANDIR, kesin '
  + 'hüküm sunucunun cevabıdır; sunucu "plan/limit" diyorsa bu izin sorunu DEĞİLDİR) · bağlı değilse ne '
  + 'yapabileceğini somut söyle, bağlama yolunu göster ve bloke olmayan kısmı sürdür · çıplak hata gövdesini/HTTP '
  + 'kodunu kullanıcıya basma · kullanıcıyı ASLA o servisin panelinde CrewPane kurulumu yapmaya yönlendirme.';

/**
 * Bu pane'e girecek protokol metni.
 *
 * 🪤 CDX-F1 (CDX-R1 H5) — codex'te TAM PROTOKOL DÜŞER, yalnız motor notu kalır.
 * GEREKÇE (ölçüldü): CODEX-INT-01 kararı gereği entegrasyon SIRLARI codex'e enjekte
 * EDİLMEZ (argv'ye düşerdi) → o pane'de servis ARAÇLARI YOKTUR. Yani üç-durum
 * protokolünün ("bağlı + araç bu pane'de → işi KENDİN yap", "401/403 alırsan izni
 * adıyla söyle"…) codex'te UYGULANABİLİR TEK DALI YOK: pane her hâlükârda
 * `CODEX_ENGINE_NOTE`in söylediği yere düşüyor. Buna rağmen ≈1.100 karakterlik
 * protokol her codex pane'inin kimlik bütçesini yiyordu — ve o bütçe 8.000
 * karakterde KUYRUKTAN kırpıldığı için bedeli HAFIZA bloğu ödüyordu.
 * ⚠️ claude'da metin BİT-BİT AYNI kalır (tam protokol) — orada araçlar GERÇEKTEN var.
 *
 * @param {{engine?: string}} [opts] engine: 'claude' | 'codex' | …
 */
function protocolText(opts) {
  const engine = opts && typeof opts.engine === 'string' ? opts.engine.trim() : '';
  return engine === 'codex' ? CODEX_ENGINE_NOTE : INTEGRATION_PROTOCOL;
}

/**
 * Protokolü kimlik/hafıza metninin BAŞINA ekle (kuyruk kırpılır — dosya başlığı).
 * Boş/eksik sistem promptunda TEK BAŞINA protokol döner: bir pane'in kimliği
 * olmaması, entegrasyon davranışının olmaması demek değildir.
 *
 * `enabled:false` → hiç dokunma (motor/pane entegrasyon kapsamı dışındaysa çağıran karar verir;
 * bugün shell pane'leri bu yoldan hiç geçmez, karar noktası yine de burada açık dursun).
 *
 * @param {string|null} systemPrompt
 * @param {{engine?: string, enabled?: boolean}} [opts]
 * @returns {string|null}
 */
function withIntegrationProtocol(systemPrompt, opts) {
  if (opts && opts.enabled === false) return systemPrompt;
  const base = typeof systemPrompt === 'string' ? systemPrompt.trim() : '';
  const engine = opts && typeof opts.engine === 'string' ? opts.engine.trim() : '';
  // 🪤 codex'te "sistem promptu" diye bir bayrak YOK: metin POZİSYONEL PROMPT olarak,
  // yani İLK KULLANICI MESAJI olarak gider. Kimliği olmayan bir codex pane'ine tek
  // başına protokol yazmak, kullanıcı daha hiçbir şey yazmadan oturumu BAŞLATIRDI
  // (bugün o pane sessizce bekliyor). Bu yüzden codex'te protokol yalnız VAR OLAN
  // prompt'un başına eklenir — claude'da böyle bir risk yok (`--append-system-prompt`
  // bir tur başlatmaz).
  if (!base && engine === 'codex') return systemPrompt;
  const proto = protocolText(opts);
  return base ? `${proto}\n\n${base}` : proto;
}

module.exports = {
  INTEGRATION_PROTOCOL,
  CODEX_ENGINE_NOTE,
  TOOL_FOOTER,
  protocolText,
  withIntegrationProtocol,
};
