# Crewpane — Çok Ajanlı Masaüstü Ofis: Özellik Spesifikasyonu

> **Ürün:** Crewpane (Eren Atasoy). Sürüm: v0.4.1.
> Bu doküman Crewpane özelliklerinin kapsamlı teknik ve mimari spesifikasyonudur.



---

## 1. Ürün özeti

Kullanıcının bilgisayarında çalışan bir masaüstü uygulaması. Kullanıcı birden fazla AI kodlama ajanını (kendi CLI aboneliği/anahtarıyla) bir "ekip" gibi yönetir. Ekipte bir **lider** ajan ve **çalışan** ajanlar vardır. Kullanıcı hedefi yazar veya söyler; lider işi alt görevlere böler, çalışanlar kendi terminallerinde çalışır, iş kanıtla birlikte bir raporla kapanır.

Temel akış: **Hedefi söyle → ekip çalışır (canlı izlenir) → iş kanıtla kapanır** (ör. "typecheck + build geçti").

Platformlar: macOS (Apple Silicon ve Intel), Windows 10/11 64-bit, Linux x86_64 (AppImage). Ayrıca bir mobil eşlik uygulaması var.

---

## 2. Ajanlar ve ekip

### 2.1 Kalıcı kimlik
- Her ajanın adı, rolü (ör. Backend, Frontend, QA) ve atanmış bir motoru (CLI) vardır.
- Ajanlar oturumlar arasında kararları ve tercihleri hatırlar, kaldıkları yerden devam eder.

### 2.2 Lider ajan
- Kullanıcıyla konuşan ana ajan. Görevleri alt görevlere böler ve çalışanlara dağıtır (delegasyon).
- Kararlar ve notlar liderde tutulur; kullanıcı ayrı not tutmak zorunda kalmaz.
- Lider, ekibe yeni bir çalışan eklenmesini önerebilir; kullanıcı öneriyi tek adımda kabul eder.
- Kullanıcı bir kararı onayladığında lider bunu hemen görür ve delegasyonu başlatır.
- Liderle yazılı ve sesli konuşulabilir.

### 2.3 Ekip yapısı
- Ekipler "kanat" veya departman olarak gruplanabilir.
- Her ajana ayrı motor atanabilir; ör. lider Claude Code, çalışanlar Codex veya daha ucuz bir CLI. Böylece maliyet ajan bazında ayarlanır.

---

## 3. Görsel ofis (piksel-art)

- Ajanlar piksel-art bir ofiste masalarında sprite olarak görünür.
- Kim çalışıyor, kim boşta, bir bakışta anlaşılır. Durum değişince canlı konuşma balonları çıkar.
- Bir ajanın sprite'ına tıklayınca o ajanın adını taşıyan terminali açılır ve komut kutusu o ajanı hedefler.
- Amaç, "kuru dashboard" yerine oyunlaştırılmış bir yönetim deneyimi.

---

## 4. Terminal

- Her ajan kendi **gerçek terminal oturumunda** (gerçek shell, gerçek CLI çıktısı) çalışır; oturumlar birbirine karışmaz.
- Panel başlığı ajanın adıdır ("shell 3" değil).
- **Bölme:** Her panel sağa, sola, yukarı ve aşağı bölünebilir; döşeme ağacında sınır yok.
- **Boyutlandırma:** Ayırıcı sürüklenince komşu paneller canlı yeniden yerleşir.
- **Sekme gruplama:** Bir sekme başka bir grubun üzerine bırakılınca o gruba katılır; grup daraltılınca terminaller tam genişliğe yayılır (ofis grubu dahil).
- Birden fazla ajan paralel çalışır.

---

## 5. Görev panosu ve otomasyon

- Kanban tarzı pano: kartlar sürüklenir, sütunlar canlı güncellenir.
- Kart alanları: başlık, açıklama, durum, atanan ajan. Kartların kısa kodları vardır (ör. `TASK-XXXX`).
- Görev panoya yazılarak veya sesle eklenebilir. Ekran görüntüsü/görsel eklenebilir; ajan görselin ilgili bölümlerinden görev oluşturabilir.
- Delegasyon ilerlemesi görünür (ör. "2/4 alt görev").
- **Eller serbest mod (otopilot):** Bir görev bitince sıradaki otomatik başlar; kullanıcı yokken de çalışmaya devam eder.
- Toplu ajan başlatma kullanıcı onayı ister.
- Plan bazında eşzamanlı başlatılabilen görev sayısı sınırı vardır (ör. 3 / 12).

---

## 6. Raporlar, kararlar ve kanıt

- Her iş bir **sonuç raporu** ve kanıtla kapanır (testlerin veya build'in geçtiği gibi).
- Raporlar detaylı okunabilir; kararlar ayrı listelenir ve onaylanabilir.
- Kullanıcı teslim alırken diff'i inceler; sürüm kontrolü güvenlik ağıdır.
- Onay bekleyen işlemler (ör. bir ajanın tarayıcıda bir siteye tıklama izni) bir "onay bekliyor" kutusunda toplanır; tek dokunuşla onaylanır veya reddedilir.

---

## 7. Canlı izleme ve diff

- Bir ajanın düzenlediği dosya editörde canlı akar; değişiklik anında diff olarak görünür.

---

## 8. Dahili tarayıcı

- Uygulama içinde adres yazılıp sayfa açılabilen bir tarayıcı.
- Ajanlar tarayıcıyı kullanabilir; tıklama gibi eylemler site bazında kullanıcı onayına bağlıdır.

---

## 9. Kalıcı bellek

- Ajanların kendi yazdığı bellek dosyaları diskte durur.
- Bellek bir **grafik** olarak görselleştirilir (düğümler ve bağlantılar, yakınlaştırılabilir).
- Kullanıcı bazı bellek kurallarını elle "terfi ettirir"; yalnız bunlar buluta senkronize edilir.

---

## 10. Motorlar (BYO: kendi motorunu getir)

- Ürün token satmaz. Kullanıcı zaten ödediği AI CLI'ını bağlar; anahtar kullanıcının diskinde kalır, model trafiği doğrudan sağlayıcıya gider.
- Bugün çalışan motorlar (11): Claude Code, Codex, GitHub Copilot CLI, Goose, Gemini CLI, Qwen Code, OpenCode, Cursor CLI, Kimi Code, Crush, Antigravity CLI.
- Codex üzerinden kullanıcının anahtarıyla model sağlayıcıları: Groq, DeepSeek, Kimi K2/K3.
- Yol haritasında (henüz çalışmayan): Kiro, Grok CLI, Droid, Amp, Cline, Continue, Charm, Muse Code, oh-my-pi, Hermes Agent ve "herhangi bir CLI ajanı".
- **İlke:** Ekranda görünen motor listesi uygulamanın kendi motor kataloğundan üretilir. Katalog ile gösterim arasında fark oluşursa build kırmızıya döner; yol haritasındaki bir motor "çalışıyor" diye gösterilemez.
- Kurulum sırasında adım adım bir anahtar sihirbazı var.

---

## 11. Hesaplar, kullanım ve limit devri

- **Çoklu abonelik:** Aynı motor için birden fazla kendi hesabını ekleyebilirsin (ilk giriş motorun kendi giriş akışıyla yapılır, sonrası tek tık).
- Aktif hesap başlık çubuğunda yazılıdır.
- **Limit devri (varsayılan kapalı):** Aktif hesap limitine ulaşınca iş beklemez, boştaki hesapla aynı konuşmadan devam eder. Akış: Çalışıyor → Limit → Geçiş → Devam.
- Geçiş yalnızca sonradan açılan veya devam ettirilen panellere uygulanır; çalışan süreç başladığı hesapta kalır.
- Hesap paylaşımı yok: token dışa/içe aktaran bir buton bulunmaz.
- Giriş durumu motorun kendi `status` komutundan okunur, tahmin edilmez.
- **Kullanım kartı (panel üstünde):** Bu oturumda harcanan token, API'de ne tutacağı ve aboneliğin kapsadığı; tüm oturumların toplamı; model bazında dağılım (ör. güçlü model %72, hızlı model %28).
- Sayılar motorun kendi oturum dosyalarından okunur; fiyatlanamayan bir değer sahte "$0" yerine "fiyatlanmamış" yazar.
- Kalan kota yüzdesi çubuğu **yoktur**, çünkü motorlar bunu yayınlamaz.

---

## 12. Entegrasyon merkezi

- Ayarlar → Entegrasyonlar'dan bir servis anahtarı yapıştırılır ve test edilir. Yeni açılan ajan panellerinde o servisin araçları hazır gelir.
- Bugünkü katalog: Supabase, GitHub, Sentry, Stripe, PostHog, Hostinger, Coolify, Vercel.
- Ajan bir servisi kullanmadan önce köprüye sorar: ne bağlı, hangi yetki kapsamıyla, hangi ortam için. Tahmin etmez.
- Ajan üç durumda net davranır:
  - **Bağlı:** İşi kendisi yapar (ör. Sentry hatalarını tarayıp kritik olan için görev kartı açar).
  - **Bağlı ama yetki eksik:** Eksik izni adıyla söyler.
  - **Bağlı değil:** Nereden bağlanacağını ve bağlanınca ne yapabileceğini söyler.
- "Bağlanırsa şunu yaparım" listesi, servisin gerçek araç listesinden türetilen yetenek kartlarından gelir.
- Anahtarlar şifreli bir kasada durur; ajanın durum sorgusu hiçbir sır taşımaz (maskelenmiş hali bile).
- Bağlantılar ortama göre ayrılır (dev / prod); prod anahtarı açık bir bayrak ister.

---

## 13. Mobil eşlik uygulaması

Telefon ikinci bir ürün değil, ofisin ikinci ekranıdır: aynı ekip, aynı pano, aynı kayıt.

- Sekmeler: Ofis, İş, Görevler, Raporlar, Asistan, Cihaz.
- Sesle iş verme: ses masaüstünde yazıya çevrilir; motor anahtarı telefona hiç kopyalanmaz.
- Telefondan görev açıp boştaki bir ajana devretme; iş gerçek bir terminalde başlar.
- Kameradan foto veya ekran görüntüsünü komuta ekleme.
- Bekleyen onayları onaylama/reddetme, ters giden bir çalışmayı durdurma.
- "Okuma modu": ajan transkriptini telefondan canlı izleme.
- Masaüstü penceresi kapalıyken de yanıt verir (ofis ana süreçte kurulu).
- Telefonda bilerek **olmayanlar:** fare/klavye kontrolü, dosya silme, ayar değiştirme.
- **Ağ güvenliği:**
  - Mobil geçit yalnızca kullanıcının Tailscale adresine (100.x) bağlanır; `0.0.0.0`'a bağlanma kodda reddedilir.
  - Trafik WireGuard tüneli içinden geçer.
  - Cihaz başına token: tokensız istek 401 alır. Bir cihaz masaüstünden tek tıkla iptal edilir; bir "kill switch" tüm mobil rotaları birden keser.

---

## 14. Ses ve Türkçe

- Arayüz Türkçe ve İngilizce.
- Sesli komutlar Türkçe için özel olarak geliştirilmiş: Türkçe morfoloji katmanı ve cümle sonu algılama içeriyor.
- Liderle sesli konuşma.
- (Kullanıcı yorumlarına göre) el hareketiyle kontrol özelliği var.

---

## 15. Veri ve gizlilik

| Diskte kalır | Hesaba senkronize edilir |
| --- | --- |
| Kod ve dosyalar | Hesap ve lisans |
| Terminal çıktısı, oturum logları | Ekip listesi (ajanlar ve rolleri) |
| Ajan raporları | Pano kartları (başlık, açıklama, durum, atanan) |
| Telefondan yüklenen görseller | Kullanıcının elle terfi ettirdiği bellek kuralları |
| Ajanın yazdığı bellek dosyaları | Serbest metin alanı olmayan ürün analitiği (kapatılabilir) |
| Motor anahtarları | |

- Analitik şemasında serbest metin alanı yoktur; prompt, dosya yolu veya anahtar şemadan geçemez.

---

## 16. Hesap, lisans ve plan kapıları

- Tek bir hesap (SSO) tüm ürünlerin lisansını açar.
- Plan bazında kapatılan özellikler (uygulamanın lisansa göre etkinleştirmesi gerekir):

| Özellik | Basic | Pro | Ultra |
| --- | --- | --- | --- |
| AI çalışan (ajan) | 3 | Sınırsız | Sınırsız |
| Çalışma alanı | 1 | Sınırsız | Sınırsız |
| Eşzamanlı başlatılan görev | 3 | 12 | 12 |
| Bağlı entegrasyon | 2 | Tümü | Tümü |
| Eşzamanlı cihaz | 1 | 2 | 4 |
| Kayıtlı cihaz | 2 | 4 | 10 |
| Eller serbest mod | Yok | Var | Var |
| Telefondan uzaktan kontrol | Yok | Var | Var |
| Bulut senkronizasyonu | Yok | Var | Var |
| Tasarım turu (onboarding) | Yok | Var | Var |
| Uygulama içinden özellik önerisi | Yok | Yok | Var |

- Ömür boyu lisans seçeneği: masaüstü, ajanlar, bellek, skill'ler ve güncellemeler kalıcı; bulut senkronizasyonu ve mobil abonelikte kalır.

---

## 17. Uygulama sırası önerisi (sıfırdan yazarken)

1. Ajan çalışma zamanı: motor kataloğu, ajan başına PTY, kimlik, durum makinesi (boşta / çalışıyor / bitti).
2. Terminal döşeme (bölme, boyutlandırma, sekme grupları).
3. Görev panosu + lider delegasyonu + rapor/kanıtla kapanış.
4. Kullanım kartı (oturum dosyalarından token ve maliyet).
5. Görsel ofis ve sprite → terminal köprüsü.
6. Eller serbest mod ve onay kuyruğu.
7. Entegrasyon merkezi (şifreli kasa, ortam ayrımı, yetenek kartları).
8. Çoklu hesap ve limit devri.
9. Bellek grafiği.
10. Mobil geçit (Tailscale'e bağlı, cihaz tokenları) ve mobil uygulama.
11. Ses (Türkçe) ve lisans/plan kapıları.
