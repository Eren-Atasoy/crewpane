# Duyuru feed'i — ŞEMA v2 (ADP-716)

> Bu şema **üç ürünün ortak sözleşmesidir**: CrewPane, AgentShot, AgentVoice
> aynı dosyayı okur. Şemanın *çalıştırılabilir* tanımı `conformance/cases.json`
> dosyasıdır; JS ve Python çekirdekleri o vakaları koşar, biri diğerinden saparsa
> test kırılır.

**Yayın adresi**

```
https://raw.githubusercontent.com/crewpane-dev/crewpane-releases/main/announcements.json
```

---

## 1. Dosya

```jsonc
{
  "version": 2,                 // İSTEMCİ BUNA GÖRE DALLANMAZ (yalnız okunabilirlik)
  "announcements": [ /* … */ ]  // çıplak dizi de kabul edilir
}
```

## 2. Tek duyuru

```jsonc
{
  "id": "bakim-260729",         // ZORUNLU · okundu defterinin anahtarı · [a-z0-9._-] · ≤80
  "level": "critical",          // critical | warning | info   (bilinmeyen → info)
  "title": "Planlı bakım 20:00-21:00",   // ZORUNLU · ≤140 · TABAN DİL (TR)
  "body": "Bu akşam kısa bir kesinti olacak.",  // ≤4000 · TABAN DİL (TR)

  // ── ÇOK DİLLİLİK (v2'de eklendi) ──────────────────────────────────────────
  // `title`/`body` DÜZ STRING kalır ve TABAN dildedir. `i18n` yalnız ÜSTÜNE yazar.
  // Alan bazlı geri düşme: yalnız başlık çevrilmişse gövde taban dilde kalır.
  "i18n": {
    "en": { "title": "…", "body": "…", "actionLabel": "…" }
  },

  // ── ZAMAN ─────────────────────────────────────────────────────────────────
  "publishedAt": "2026-07-29T09:00:00Z",  // sıralama (yeni → eski)
  "startsAt": null,             // bu andan ÖNCE görünmez (zamanlanmış yayın)
  "expiresAt": null,            // bu andan İTİBAREN görünmez (bitiş anı DAHİL DEĞİL)

  // ── HEDEFLEME (null alan = "sınır yok") ───────────────────────────────────
  "target": {
    "apps": ["crewpane", "agentshot", "agentvoice"],
    "minVersion": null,         // DAHİL alt sınır
    "maxVersion": "0.2.20",     // DAHİL üst sınır ← "0.2.20'den eskiler görsün"
    "channels": null,           // null = hepsi. DİKKAT: kanal adı ÜRÜN BAŞINA FARKLI
                                //   CrewPane: "stable" | "beta"   (updateChannel.cjs)
                                //   AgentShot : "stable" | "dev"    (main.js:1951)
                                //   AgentVoice: "stable" | "dev"    (announcements.py:198)
                                // → "önce yalnız ben görüyim" = ["beta","dev"]  (ADP-766)
    "plans": null               // Faz 2 (istemci bugün yok sayar)
  },

  "action": { "label": "Detay", "url": "https://…" },  // YALNIZ https
  "dismissible": true           // false → şeritte ✕ yok ("Okudum" HER ZAMAN var)
}
```

`level` karşılıkları: `info` = bilgi · `warning` = uyarı · `critical` = kritik.

---

## 3. Geriye + ileriye uyumluluk (sözleşmenin kalbi)

| Durum | Sonuç |
|---|---|
| **v1 (ADP-675) duyurusu, v2 istemcide** | Aynen çalışır — v2'nin eklediği her alan İSTEĞE BAĞLI. |
| **v2 duyurusu, v1 (0.2.19-0.2.21) istemcide** | Çalışır: `i18n` bilinmeyen bir alandır, v1 onu yok sayar ve TABAN (TR) metni gösterir. |
| **`version` alanı 99 olsa** | İstemci sürüme göre dallanmaz → kırılmaz. |
| **Bilinmeyen yeni alan (`priority`, `audience`, …)** | Sessizce yok sayılır; duyuru DÜŞMEZ. |

> ⚠️ **Bu yüzden `title`/`body` nesneye çevrilmedi.** `{"tr":…,"en":…}` biçimi eski
> istemcide `cleanText(nesne) → null` verirdi ve duyuru TAMAMEN düşerdi. Çok
> dillilik bu yüzden AYRI bir `i18n` bloğu olarak eklendi.

---

## 4. Bozuk girdi = sessiz atlama

| Girdi | Davranış |
|---|---|
| `id` veya `title` yok | O öğe DÜŞER; feed'in geri kalanı yaşar |
| Öğe `null` / sayı / string | DÜŞER |
| Aynı `id` iki kez | İlki kazanır |
| Feed JSON değil / HTML dönüyor | 0 duyuru, ÇÖKME YOK |
| Feed'e ulaşılamıyor | Sessiz geç; diskteki son kopya gösterilir; uygulama NORMAL çalışır |
| 50'den fazla duyuru | İlk 50 |

Alan tavanları: `id` 80 · `title` 140 · `body` 4000 · `action.label` 40 karakter.

---

## 5. Güvenlik

| Risk | Önlem |
|---|---|
| XSS / HTML enjeksiyonu | Metin hiçbir istemcide ham HTML olarak render EDİLMEZ: CrewPane react-markdown `skipHtml` + etiket beyaz listesi · AgentShot `textContent` (innerHTML YOK) · AgentVoice Qt `PlainText` |
| `javascript:` / `data:` / `file:` adres | Aksiyon URL'i YALNIZ `https` — reddedilen adres **duyuruyu düşürmez, yalnız düğmeyi düşürür** |
| XSS → RCE (`shell.openExternal`) | Pencere adres GÖNDERMEZ; yalnız duyuru id'si gider, adresi main kendi normalize kopyasından çözer ve https'i tekrar doğrular |
| Terminal/ekran kaçış dizisi | C0/C1 kontrol karakterleri silinir (`\t \n \r` kalır) |
| Bellek/UI şişirme | Alan + öğe tavanları (yukarıda) |
| Yol/anahtar enjeksiyonu | `id` yalnız `[a-z0-9._-]` |
| Uzak izleme pikseli | Gömülü görsel YOK (AgentShot penceresinde ayrıca `default-src 'none'` CSP) |

**İmza YOK (bilinçli, Faz 1).** Taşıma HTTPS + GitHub. Feed tamamen ele geçse bile
saldırganın kazanabileceği azami şey **metin + harici bir https link**tir.

---

## 6. Duyuru yazmak

**Önerilen: arayüz** (ADP-766) — form + üç ürünün önizlemesi + "kim görecek"
simülatörü + yayın sonrası canlı doğrulama. Karar gerekçesi:
`docs/announcements/ADMIN-UI.md`.

```bash
cd crewpane
npm run announce:ui              # ARAYÜZ (tarayıcıda açılır)
```

Arayüzsüz (script/otomasyon) yol — aynı kapılardan geçer:

```bash
npm run announce                 # SORULU mod: başlık/metin/tür/hedef sorar, doğrular
npm run announce -- --list       # yayına hazır içerik + hedefler
npm run announce -- --publish    # GitHub'a yaz (gh api; klon gerekmez)
npm run announce -- --remove <id> && npm run announce -- --publish   # kaldır
```

Araç duyuruyu **istemcinin mantığıyla** doğrular (`packages/announce-core`):
şemadan geçmeyen duyuru dosyaya YAZILMAZ, dolayısıyla müşteriye GİDEMEZ.

---

## 7. İstemci yüzeyleri (ürün başına)

| | CrewPane | AgentShot | AgentVoice |
|---|---|---|---|
| Rozet | header'da zil + okunmamış sayısı | menü-çubuğu satırı (`Duyurular (N yeni)`, kritikte 🔴) | tray menü satırı (aynı biçim) |
| Kart yüzeyi | duyuru merkezi paneli | ayrı pencere (`announce.html`) | `QDialog` (modal DEĞİL) |
| `critical` ek yüzey | header altı şerit | oturumda bir kez sistem bildirimi | oturumda bir kez sistem bildirimi |
| Okundu defteri | `settings.json → announcementsRead` | `~/.agentshot/config.json → announcementsRead` | `…/AgentVoice/announcements-read.json` |
| Çevrimdışı kopya | `announcements-cache.json` | `announcements-cache.json` | `announcements-cache.json` |
| Dil | OS dili (`app.getLocale()`) | Ayarlar'daki dil (`config.language` → OS) | TR (uygulama dili) |

Ortak kural: **duyuru yoksa yüzey ÇİZİLMEZ** (ölü menü/rozet yasak) ve **modal yok**
— duyuru kullanıcının işini bölmez.
