# CrewPane — Sistem Mimarisi ve Dosya Yapısı

## 1. Genel Bakış ve Dönüşüm Özeti

Bu doküman, CrewPane masaüstü uygulamasının mimari yapısını, dizin hiyerarşisini, modül etki alanlarını (domains) ve sistem bileşenlerinin çalışma prensiplerini açıklamaktadır.

Önceden proje kökünde düzensiz bir şekilde bulunan 300'ü aşkın `.cjs` ve `.js` dosyası, sorumluluk alanlarına (Separation of Concerns) göre **12 ana mimari etki alanına (domain)** ayrıştırılmış ve `src/` dizini altında modern, modüler ve temiz bir mimari yapıya kavuşturulmuştur.

---

## 2. Dizin ve Dosya Yapısı

```
CrewPane-source-FULL/
├── ARCHITECTURE.md            # Bu mimari ve sistem dokümantasyonu
├── devChannelTarget.json      # Dev kanalı yerel backend/auth hedef yapılandırması
├── bakedBuild.json            # Gömülü derleme meta verileri ve yerel hedef tanımı
├── package.json               # Bağımlılıklar, scriptler ve Electron giriş noktası
├── main.js                    # Electron ana süreç giriş noktası (Resolver hook yüklü)
├── preload.js                 # Electron sandboxed preload köprüsü
├── start.bat                  # Yerel geliştirme başlatıcı scripti
├── .env.local                 # Yerel ortam değişkenleri
│
├── src/                       # Modüler mimari kaynak kodları
│   ├── index.js               # Tüm etki alanlarını dışa aktaran ana mimari giriş noktası
│   ├── resolver.cjs           # Evrensel modül çözümleme motoru (Zero-regression loader)
│   │
│   ├── core/                  # Uygulama yaşam döngüsü, süreç ve çökme yöneticileri
│   ├── config/                # Ortam değişkenleri, backend/auth hedefleri, kanal ve yol yönetimi
│   ├── agents/                # AI Agent runner, delegasyon, supervisor, roller ve skill sistemi
│   ├── voice/                 # Jarvis ses motoru, Whisper STT, Grok, TTS sağlayıcıları ve filtreler
│   ├── memory/                # Vektör gömmeleri (embeddings), hibrit arama, bellek grafiği ve indeksleme
│   ├── terminal/              # node-pty terminal çalışma zamanı, paneler, tmux ve oturum kurtarma
│   ├── mcp/                   # Model Context Protocol (MCP) sunucuları, vekilleri ve araç takma adları
│   ├── security/              # Lisans ve seat kapısı, safeStorage, kimlik bilgileri ve bütünlük denetimleri
│   ├── hand/                  # Bilgisayarlı görü el takibi, jest FSM'i, kamera politikası ve imleç
│   ├── mobile/                # Mobil ağ geçidi, cihaz eşleme ve uzak transkript senkronizasyonu
│   ├── services/              # Kod zekası (code intel), pano geçmişi, güncelleyici ve sistem servisleri
│   └── ui/                    # Preload scriptleri ve UI arayüz sözleşmeleri
│
├── renderer/                  # Arayüz HTML ve fallback render dosyaları
├── standalone/                # Gömülü Next.js standalone prodüksiyon sunucusu
├── packages/                  # Alt paketler (@crewpane/auth, announce-core)
├── platform/                  # Platforma özel adaptörler (Windows/macOS/Linux)
├── builtin-skills/            # Dahili ajan yetenekleri (skills)
├── i18n/                      # Çoklu dil lokalizasyon sözlükleri
└── supabase/                  # Yerel veritabanı ve migrasyon şemaları
```

---

## 3. Mimari Etki Alanları (Domains)

### 3.1. `src/core/` (Çekirdek & Yaşam Döngüsü)
Uygulamanın Electron üzerindeki ana süreç yaşam döngüsünü, tekil örnek (single-instance) kilitlerini, kilitlenme ve donma izleyicilerini yönetir:
- **`singleInstanceLock.cjs`**: Sistem genelinde tek örnek çalışmasını garanti eder.
- **`crashWatchdog.cjs` & `crashJournal.cjs`**: Uygulama çökmelerini yakalar, günlüğe kaydeder ve raporlar.
- **`mainStallMonitor.cjs`**: Ana sürecin olay döngüsünü (event loop) izleyerek donmaları tespit eder.
- **`helperReaper.cjs` & `helperWatchdog.cjs`**: Next.js ve alt süreçlerin yetim kalmasını engeller.

### 3.2. `src/config/` (Yapılandırma & Hedefler)
Uygulamanın bağlandığı backend hedeflerini, Supabase URL'lerini, kimlik sunucularını ve ortam parametrelerini yönetir:
- **`devChannelTarget.json`**: Dev ortamında canlı bulut yerine yerel `127.0.0.1:54321` hedefini zorunlu kılar.
- **`crewpaneId.cjs`**: Kimlik doğrulama uç noktalarını ve istemci kurallarını yönetir.
- **`backendTarget.cjs` & `supabaseTarget.cjs`**: Veritabanı ve API hedeflerini çözer.
- **`mixedTargetGuard.cjs`**: Bulut ile yerel hedeflerin yanlışlıkla birbirine karışmasını engeller.

### 3.3. `src/agents/` (Yapay Zeka Ajanları & Yürütme)
Ajanların çalıştırılması, görev dağıtımı ve takım orkestrasyonu:
- **`agentRunner.js`**: CLI ve terminal ortamında Claude/LLM ajanlarını çalıştıran ana motor.
- **`delegationBridge.js` & `delegationSupervisor.cjs`**: Lider ajanın alt ajanlara (workers) iş delege etmesini sağlar.
- **`leaderRole.cjs` & `leaderComposer.cjs`**: Lider rollerini ve ekip promptlarını tanımlar.
- **`engineRegistry.cjs`**: Farklı model motorlarının (Claude, OpenAI, Groq vb.) entegrasyon havuzu.
- **`builtinSkills.cjs`**: Ajanların kullanabileceği araç ve yetenek katalogları.

### 3.4. `src/voice/` (Jarvis Ses & Dil İşleme)
Gerçek zamanlı sesli asistan, konuşma-metin ve metin-konuşma sistemleri:
- **`jarvisVoice.js`**: Jarvis ses beyni; niyeti çözümler, eyleme karar verir ve sesli yanıt üretir.
- **`whisperLocal.cjs`**: Yerel/uzak OpenAI Whisper konuşma tanıma (STT).
- **`ttsProviders.cjs` & `ttsStream.cjs`**: Çoklu TTS sağlayıcıları (macOS say, ElevenLabs, OpenAI vb.).
- **`sttSilenceGate.cjs` & `sttHallucinationGuard.cjs`**: Ses halüsinasyonlarını ve sessizlik durumlarını filtreler.
- **`turkishMorph.cjs`**: Türkçe dilbilgisel ve morfolojik niyet çözümlemesi.

### 3.5. `src/memory/` (Vektörel Bellek & Arama)
Ajanların geçmiş oturumları ve bağlamı hatırlamasını sağlayan arama altyapısı:
- **`memoryEmbedder.cjs` & `memoryEmbedWorker.cjs`**: Metinleri anlamsal vektörlere dönüştürür.
- **`memoryHybrid.cjs`**: Sözcüksel (lexical) ve anlamsal (semantic) aramayı birleştiren hibrit motor.
- **`memoryIndexService.cjs` & `memoryIndexWorker.cjs`**: Kod ve hafıza indekslerini arka planda günceller.
- **`memoryGraph.cjs`**: Bilgi düğümleri arasındaki ilişkileri modeller.

### 3.6. `src/terminal/` (Terminal & PTY Yönetimi)
Terminal çalışma zamanı ve pane izolasyonu:
- **`node-pty` Entegrasyonu**: Sanal terminal süreçlerini yönetir.
- **`paneControl.cjs` & `paneScreen.cjs`**: Çoklu terminal pencerelerini koordine eder.
- **`resumeDaemonCore.cjs`**: Uygulama yeniden başladığında açık terminal durumlarını geri yükler.
- **`paneBudget.cjs` & `paneTokenBudget.cjs`**: Token ve kaynak kullanımını sınırlar.

### 3.7. `src/mcp/` (Model Context Protocol)
Anthropic Model Context Protocol (MCP) standart sunucu ve araç uygulamaları:
- **`crewpane-browser-mcp.cjs`**: Ajanların web tarayıcısını yönetmesini sağlayan araçlar.
- **`crewpane-delegate-mcp.cjs`**: Görev delegasyonu için MCP arayüzü.
- **`crewpane-task-mcp.cjs`**: Görev durumu ve işlem takip MCP aracı.
- **`crewpane-integrations-mcp.cjs`**: Harici servis entegrasyonları.

### 3.8. `src/security/` (Güvenlik, Lisans & SafeStorage)
Veri güvenliği, yerel şifreleme ve yetkilendirme kapıları:
- **`seatGate.cjs`**: Kullanıcı yetkilendirmesi ve lisans kapısı.
- **`safeStorageIdentity.cjs` & `credentialVault.cjs`**: API anahtarlarını işletim sistemi anahtarlığında (OS Keychain/DPAPI) şifreli saklar.
- **`integrityCheck.cjs`**: Kod bütünlüğünü denetler.
- **`killGuard.cjs`**: Kritik süreçlerin kazara kapatılmasını önler.

### 3.9. `src/hand/` (El & Jest Takibi)
Web kamerası üzerinden bilgisayarlı görü ile temassız kontrol:
- **`handControlCore.cjs`**: El hareketlerini yakalayan ve analiz eden çekirdek.
- **`handClickFsm.cjs`**: Tıklama ve tutma hareketlerini sonlu durum makinesi (FSM) ile yönetir.
- **`handCursor.cjs`**: Ekran üzerinde imleci kontrol eder.
- **`handOverlayContract.cjs`**: Kullanıcıya gösterilen görsel geri bildirim arayüzü.

### 3.10. `src/mobile/` (Mobil Ağ Geçidi)
Mobil cihazlardan masaüstü ajanlarını izleme ve yönetme:
- **`mobileGateway.js`**: Mobil istemciler için güvenli yerel ağ geçidi sunucusu.
- **`mobileAuth.cjs`**: QR kod ve yerel anahtarla cihaz eşleme.
- **`mobileTranscript.cjs`**: Ajan transkriptlerini mobille anlık senkronize eder.

### 3.11. `src/services/` (Sistem Servisleri & İntel)
- **`codeIntel.cjs` & `codeIndex.cjs`**: Proje kod indeksleme ve zeka servisleri.
- **`clipboardHistory.cjs`**: Pano geçmişi yönetimi.
- **`updateCheck.cjs`**: Otomatik güncelleme denetleyicisi.
- **`worktreeService.cjs`**: Git worktree yönetimi ve izole çalışma alanları.

---

## 4. Evrensel Çözümleme Motoru (`src/resolver.cjs`)

Modülerleştirmede en kritik mühendislik çözümü `src/resolver.cjs` motorudur:
1. **Sıfır Regresyon (Zero Regression)**: Kod tabanındaki binlerce `require('./dosya.cjs')` çağrısı kırılmadan çalışmaya devam eder. Aranan dosya bulunamazsa, resolver `O(1)` zaman karmaşıklığıyla `src/<domain>/<dosya>` eşlemesini yapar.
2. **Modern Modüler İçe Aktarım**:
   ```javascript
   // 1. Ana modül üzerinden:
   const { voice, agents, memory, security } = require('./src');
   
   // 2. Doğrudan etki alanı üzerinden:
   const { jarvisVoice } = require('./src/voice');
   const { agentRunner } = require('./src/agents');
   
   // 3. Takma ad (Alias) üzerinden:
   const voice = require('@crewpane/voice');
   ```

---

## 5. Geliştirme ve Başlatma Kılavuzu

Uygulamayı yerel geliştirme modunda çalıştırmak için:

```bash
# start.bat çalıştırın veya terminalden:
set CREWPANE_MODE=prod
set CREWPANE_INSTANCE=dev
set CREWPANE_ALLOW_LOCAL_APP_DB=1
set CREWPANE_ALLOW_MIXED_TARGETS=1
npx electron .
```

- **Uygulama Veritabanı**: `http://127.0.0.1:54321` (Yerel Supabase)
- **Kimlik (Auth)**: `http://127.0.0.1:54321` (Yerel Supabase Auth)
- **Next.js Sunucusu**: Otomatik atanan dinamik yerel port
- **Bulut Kaçağı / Veri Sızıntısı**: `devChannelTarget.json` sayesinde tamamen engellenmiştir.
