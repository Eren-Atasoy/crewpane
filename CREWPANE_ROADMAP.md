# CrewPane Roadmap — Jev Akıllı Yönlendirme + Goal Gate

> Bu dosya bir kodlama ajanına (Gemini) verilmek üzere yazıldı. Fazları **sırayla** uygula.
> Her faz kendi başına birleştirilebilir (merge edilebilir) olmalı ve bir sonrakine geçmeden önce
> o fazın **Kabul kriterleri** sağlanmalı.

---

## 0. Ajan için çalışma kuralları (her fazda geçerli)

1. **Doğru kaynak kodda çalış.** Referans depo: `github.com/Eren-Atasoy/crewpane`. Yerel bir kopyada
   (ör. `AgentSpace-source-FULL`) GitHub'da olmayan dosyalar olabilir (ör. `src/agents/engines/descriptors/jev.cjs`).
   Başlamadan önce yerel kopya ile depoyu karşılaştır, farkı raporla, hangisinin esas olduğunu sor.
2. **Mevcut mimariye uy.** `ARCHITECTURE.md`'yi oku. Karar mantığı **saf leaf modül** olarak yazılır:
   `fs`/`electron` require'ı yok, tüm IO enjekte edilir, `Date.now()` yerine `now` parametresi alınır.
   Böylece `node --test` ile doğrudan test edilir (bkz. `delegationSupervisor.cjs`, `queueBoard.cjs`).
3. **Main süreçte metin yok.** Main tarafı **kod** döner (`reason.code`, `warning.code`); Türkçe/İngilizce cümleyi
   renderer `i18n/dictionaries/{tr,en}.cjs` üzerinden kurar.
4. **Model adı veya fiyat koda gömülmez.** Model listesi `src/agents/modelCatalog.cjs`, fiyatlar
   `src/agents/modelPricing.json` tek kaynaktır. Router bunları okur.
5. **Dürüstlük kuralı.** Ölçülmemiş bir rakam (ör. "%85 tasarruf") UI'da gösterilmez. Bilinmeyen değer `unknown` döner.
6. **Testler yeşil kalmalı:** `npm test` ve `npm run lint`. Her yeni modül için `tests/units.test.cjs`'e
   (veya modülün yanına `*.test.cjs`) test ekle.
7. **Güvenlik kapıları korunur.** `mergePolicy.cjs` kararlarına dokunma: `main` hedefi her zaman insan onayı ister.
8. Her faz sonunda kısa bir **değişiklik özeti** yaz: eklenen/değişen dosyalar, yeni IPC kanalları, yeni ayarlar, test sonuçları.

---

## Mevcut durum (doğrulanmış)

| Bileşen | Durum |
| --- | --- |
| `src/agents/jevRouter.cjs` | Regex ile `routine/standard/expert` sınıflıyor. `routeTaskWithJev` **yalnız testten çağrılıyor** (ölü kod). |
| Router'daki model adları | Eski ve koda gömülü: `claude-3-5-haiku-latest`, `claude-3-7-sonnet-latest`, `gpt-4o`, `o1`, `gemini-2.0-flash`. |
| `modelPricing.json` | v5, 2026-08-08 tarihli. Opus 5, Sonnet 5, Haiku 4.5, Fable 5 var; **Opus 5.5 / Sonnet 5.5 / Haiku 5.5 / Fable 5.1 yok**. |
| Motor keşfi | `engineAuth.cjs` → `authEngines()` ve `engineOffering.cjs` mevcut, router bunları kullanmıyor. |
| Tamamlanma tespiti | `delegationSupervisor.cjs`: `DONE:<id>` marker, kanıt dosyası, pane çıkışı, sessizlik. İşin *doğru* bittiğini kontrol eden bir kapı yok. |
| Maliyet verisi | `src/services/tokenCost.cjs`, `tokenUsage.cjs` var; delegasyon kaydıyla birleştirilmiyor. |

---

## Faz 0 — Model kataloğu ve fiyatları güncelle (küçük, ön koşul)

**Amaç:** Router'ın seçeceği modeller gerçek ve güncel olsun.

- [ ] `modelPricing.json`'a güncel modelleri ekle: Claude Opus 5.5, Sonnet 5.5, Haiku 5.5, Fable 5.1
      (ve kullanılan diğer motorların güncel modelleri). **Fiyatları resmi sayfadan al**
      (`https://platform.claude.com/docs/en/pricing`), `source.measuredAt`'i güncelle, `version`'ı +1 yap.
- [ ] `modelCatalog.cjs`'te claude statik alias listesini güncel modellere göre gözden geçir.
- [ ] `jevRouter.cjs`'teki tüm koda gömülü model adlarını kaldır (Faz 2'de katalogdan okunacak).

**Kabul kriterleri:** `node --test` geçiyor; `tokenCost` yeni modelleri fiyatlayabiliyor (fiyatlanamayan model = 0 jeton).

---

## Faz 1 — Görev başına maliyet ölçümü (baseline)

**Amaç:** Router'ın işe yarayıp yaramadığını ölçebilmek. Ölçüm olmadan Jev'in kararları doğrulanamaz.

- [ ] Yeni saf modül `src/agents/taskOutcomeLedger.cjs`: her delegasyon/alt görev için
      `{ delegationId, subtaskId, engine, model, effort, tokensIn, tokensOut, cacheRead, costUsd, turns, retries, startedAt, settledAt, settledBy, outcome }`.
      `outcome` ∈ `passed | failed | aborted | unknown`.
- [ ] `delegationSupervisor` settle ettiğinde kaydı kapatır; maliyet `tokenUsage` + `tokenCost`'tan hesaplanır.
- [ ] `queueBoard.cjs` satırlarına görev başına **toplam maliyet, tur, tekrar** alanlarını ekle (kod döndür, metin değil).
- [ ] Ayarlar/diagnostics'te basit bir özet: motor+model başına ortalama görev maliyeti ve başarı oranı.

**Kabul kriterleri:** Biten her görevin defterde maliyeti var veya açıkça `unknown`; birim testleri ledger'ın şeklini ve toplama mantığını doğruluyor.

---

## Faz 2 — Jev v2 çekirdeği (saf karar modülü)

**Amaç:** Kullanıcının **gerçekten kurulu ve giriş yapılmış** motorları arasından, görevin zorluğuna ve kullanıcının
maliyet tercihine göre motor + model + efor seçen, test edilebilir bir karar fonksiyonu.

Yeni dosya: `src/agents/jev/decide.cjs` (saf). Mevcut `jevRouter.cjs` bunun ince bir sarmalayıcısına dönüşür
(geriye uyumluluk için `routeTaskWithJev` aynı imzayla kalır).

```js
decide({
  task: { title, description, filesTouched?, promptChars?, kind? },
  engines: [{ id, installed, loggedIn, authKind }],   // engineAuth.authEngines()'ten
  catalog,                                            // modelCatalog + modelPricing
  policy: 'frugal' | 'balanced' | 'quality',          // kullanıcı ayarı
  history?,                                           // Faz 1 ledger özetleri
  classifier?,                                        // opsiyonel, enjekte edilen sınıflandırıcı
  now
}) → {
  skip?: { code },                  // sıfır-model ön kontrol tetiklendiyse
  tier: 'routine' | 'standard' | 'expert',
  confidence: 0..1,
  engine, model, effort,
  reason: { code, signals: [...] }, // i18n kodu + hangi sinyaller etkiledi
  alternatives: [{ engine, model, effort, estCostUsd? }]
}
```

1. [ ] **Sıfır-model ön kontroller:** kuyruk boş, girdi hash'i son çalıştırmayla aynı, aynı iş zaten kayıtlı → `skip` döner, hiçbir model çağrılmaz.
2. [ ] **Motor keşfi:** yalnız `installed && loggedIn` motorlar aday. Hiçbiri yoksa `reason.code = 'no-engine'`.
3. [ ] **Yetenek matrisi:** katalogdan türet: her model için `tier` uygunluğu, bağlam boyutu, girdi/çıktı fiyatı. Matris veri dosyasıdır (`src/agents/jev/capabilities.json`), kod değil.
4. [ ] **Sınıflandırma iki katmanlı:**
      - Katman A (varsayılan): mevcut regex + yapısal sinyaller (dosya sayısı, prompt boyutu, "güvenlik/migration" gibi riskli kelimeler **her zaman** `expert`'e yükseltir; "basit" kelimesi riskli bir işi aşağı çekemez).
      - Katman B (opsiyonel, ayar ile açılır): enjekte edilen ucuz bir sınıflandırıcı (Haiku sınıfı model veya yerel küçük model) `{tier, confidence}` döner. `confidence < 0.7` ise Katman A'nın sonucu kullanılır.
5. [ ] **Politika:** `frugal` → önce ücretsiz/abonelik kotası olan veya en ucuz uygun model; `quality` → en güçlü uygun model; `balanced` → Faz 1 geçmişinde başarı oranı ≥ %80 olan en ucuz model, geçmiş yoksa tier'in varsayılanı.
6. [ ] **Testler:** her politika × her tier × "motor yok / tek motor / çok motor" kombinasyonu; riskli kelimenin aşağı çekilemediği test; sınıflandırıcı düşük güven verince fallback testi.

**Kabul kriterleri:** `decide()` saf, deterministik ve tamamen testli; hiçbir model adı kodda yazılı değil.

---

## Faz 3 — Kablolama, "öneri" modunda

**Amaç:** Jev gerçek akışa bağlansın ama **önce sadece önersin**, kullanıcı onaylasın.

- [ ] Yeni ayar `jev.mode`: `off | suggest | auto` (varsayılan `suggest`). `jev.policy`: `frugal | balanced | quality`.
- [ ] `ptySpawnService.js`: ajan `model: 'auto'` ile başlatılırsa `decide()` çağrılır. `suggest` modunda karar UI'a gönderilir; `auto` modunda doğrudan uygulanır.
- [ ] `teamCompose.cjs` ve delegasyon yolu (`delegationBridge`/`delegationSupervisor.record`) aynı kararı kullanır; karar **tek yerde** verilir, alt katmanlar yeniden türetmez.
- [ ] IPC kanalı `jev:route-task` (preload'da güvenli şekilde açılır) ve `jev:decision-log`.
- [ ] Görev kartında rozet: seçilen motor/model, `reason.code`'un çevirisi ve **Faz 1 verisi varsa** tahmini maliyet. Veri yoksa tahmin gösterilmez.
- [ ] Kullanıcı öneriyi değiştirirse bu bir sinyal olarak ledger'a yazılır (`overriddenBy: 'user'`).
- [ ] **Oturum ortasında model değiştirilmez.** Karar yalnız spawn/delegasyon anında verilir (bağlam ve prompt cache korunur).

**Kabul kriterleri:** `jev.mode = off` iken davranış bugünküyle birebir aynı (characterization testleri geçer); `suggest` modunda hiçbir şey kullanıcı onayı olmadan değişmez.

---

## Faz 4 — Goal Gate: kanıtlanmış "bitti"

**Amaç:** Bir alt görev `DONE` dediğinde, işin doğru bittiğini makinenin kontrol edebildiği koşullarla doğrulamak.

Delegasyona opsiyonel `goal` alanı:

```json
{
  "checks": ["npm test", "npm run lint"],
  "maxRounds": 5,
  "abortIfNoProgress": 2,
  "checker": "reviewer",
  "timeoutSec": 600
}
```

- [ ] Yeni saf modül `src/agents/goalGate.cjs`: tur durumu, ilerleme ölçümü (geçen kontrol sayısı), durma kararları. Komut çalıştırma enjekte edilir.
- [ ] `delegationSupervisor`: worker `DONE:` bastığında **settle etmeden önce** `checks` koşulur (worktree içinde, `commandWhitelist` kurallarına uygun).
- [ ] Başarısızlıkta: çıktının kısa, LLM-okunur özeti (ilk hata, dosya:satır, beklenen/gerçek) aynı worker pane'ine gönderilir; tur +1.
- [ ] `abortIfNoProgress` tur boyunca geçen kontrol sayısı artmazsa veya `maxRounds` dolarsa: `outcome = aborted`, lider "takıldı" koduyla uyandırılır (mevcut uyandırma kanalı + ack mekanizması).
- [ ] Tüm kontroller geçince `checker` rolündeki **ayrı** ajan diff'i inceler (`builtin-skills/requesting-code-review`). İşi yapan ajan kendi işini onaylayamaz.
- [ ] Her tur supervisor defterine ve Faz 1 ledger'ına yazılır; `queueBoard` "2/5 tur · lint geçti · test kırık" gösterir (kodlarla).
- [ ] Restart onarımı: uygulama yeniden açılınca yarım kalan goal turları defterden geri yüklenir.

**Kabul kriterleri:** `goal` tanımı olmayan delegasyonlar bugünkü gibi çalışır; goalGate'in tüm durma koşulları birim testli; bir uçtan uca smoke testi (bilerek kırık test → düzeltme turu → geçiş) var.

---

## Faz 5 — Jev × Goal Gate: eskalasyon ve öğrenen yönlendirme

**Amaç:** Ucuz modelle başla, kontrol geçmezse güçlüye çık. Sonuçlar bir sonraki kararı iyileştirsin.

- [ ] Goal Gate bir görevi `aborted` veya art arda 2 tur başarısız işaretlerse, Jev bir üst tier'den yeni bir öneri üretir (`reason.code = 'escalated-after-failed-checks'`). `suggest` modunda kullanıcıya sorulur.
- [ ] Kullanıcı bütçe tavanı ayarı (`jev.maxCostPerTaskUsd`): eskalasyon bu tavanı aşamaz; aşacaksa durur ve sorar.
- [ ] `balanced` politika Faz 1 ledger'ından görev türü × model başarı oranını okur ve ucuz modelin başarısız olduğu görev türlerinde doğrudan üst tier'i seçer.
- [ ] Haftalık rapor (diagnostics): "Jev ile toplam maliyet" ve "her görevi varsayılan modelle çalıştırsaydın tahmini maliyet". Tahmin, **gerçekleşen token sayıları × varsayılan model fiyatı** ile hesaplanır ve tahmin olduğu etiketlenir.
- [ ] `auto` mod ancak bu rapor en az 2 hafta veriyle olumlu çıkarsa varsayılan önerilir (kod değil, ürün kararı — bunu ayar açıklamasında belirt).

**Kabul kriterleri:** Eskalasyon bütçe tavanını hiçbir testte aşmıyor; rapor sayıları ledger'dan yeniden hesaplanabiliyor.

---

## Faz 6 — Küçük ama değerli işler (bağımsız, herhangi bir sırada)

### 6a. Merge öncesi sır taraması (yüksek değer, düşük efor)
- [ ] `skillSecretScan` mantığını `mergeService` içinde worktree → `dev` birleşmesinden önce diff'e uygula.
- [ ] Bulgu varsa merge durur, `warning.code = 'secret-in-diff'` ve dosya:satır gösterilir (değer maskelenir, `engineAuth.maskSecrets` deseniyle).

### 6b. Bellekte geçerlilik
- [ ] `src/memory` kayıtlarına opsiyonel `supersededBy` ve `validUntil` alanları.
- [ ] Recall sırasında süresi geçmiş veya yerini başkasına bırakmış kayıtlar varsayılan olarak döndürülmez (açıkça istenirse döner).

### 6c. `motion-studio` builtin skill
- [ ] `builtin-skills/motion-studio/SKILL.md` + `catalog.json` girdisi (sha256, sizeBytes).
- [ ] Kurallar: her kare yalnız kare numarasının fonksiyonu (timer/rastgelelik yok), gömülü fontlar, sabit sahne boyutu, ffmpeg ile H.264 ve açık pixel aspect ratio.
- [ ] Kontroller: headless smoke test sayaçları (runtime error, taşan metin, çakışan metin vb. hepsi 0) ve seam check (kare 0 = döngü sonu karesi, piksel piksel). Bu kontroller Goal Gate'in `checks` alanına doğrudan bağlanabilir.

---

## Fazların bağımlılığı

```
Faz 0 ──► Faz 1 ──► Faz 2 ──► Faz 3 ──┐
                 │                    ├──► Faz 5
                 └──────► Faz 4 ──────┘
Faz 6a / 6b / 6c: bağımsız
```

Faz 4 (Goal Gate), Faz 2–3'ten bağımsız başlatılabilir; Faz 5 ikisini de gerektirir.
