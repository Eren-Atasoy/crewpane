---
name: video-arastir
description: YouTube videosunu DUSUK-TOKEN arastir — urun CLI tek Gemini cagrisi yapar, ajana yalniz ozet + zaman damgalari + maliyet satiri doner (~300 token). Kullan — "su videoyu arastir", "rakip videosunu ozetle", "YouTube videosundan ne ogrenebiliriz", "bu egitim videosunda hangi API/kod kullanilmis". KULLANMA — YouTube disi kaynak (Vimeo/Loom/mp4 dosyasi) v1 kapsami disinda; videoyu ELLE indirme, kare cikarma, transcript yapistirma.
license: LicenseRef-CrewPane-Proprietary
---

# video-arastir — videoyu ajan yerine ürün izlesin

Bir YouTube videosundan bilgi çıkarman gerektiğinde **videoyu sen izleme**. Ürünün
`crewpaneCli video` komutu videoyu Gemini'ye TEK çağrıda okutur ve sana yalnız
**özet + zaman damgaları + maliyet satırı** döner.

> **Değişmez kural: ham medya senin bağlamına ASLA girmez.** Transcript, kare, ses ya da
> izleme sayfası HTML'i okumak yasak. 10 kareyi kendin okumak ~11.000 token yakar; aynı iş
> bu komutla ~300 token'a iner (**37× az bağlam** — SKL-R2 ölçümü).

## Komut

```bash
CLI=""
for p in "/Applications/CrewPane.app/Contents/Resources/app.asar.unpacked/crewpaneCli.cjs" \
         "$PWD/crewpane/electron/crewpaneCli.cjs"; do
  [ -f "$p" ] && CLI="$p" && break
done

node "$CLI" video "<youtube-url>" --text \
  [--question "cevap aradığın soru"] [--depth auto|none|sparse|full] [--budget 60000]
```

Çıkış kodu: `0` koştu · `1` işlem başarısız · `2` ölçemedim/kullanım hatası.
Son satır her zaman `girdi X tok · çıktı Y tok · $Z` — **bu satırı raporuna aynen taşı.**

- `--question` ver: soru olmadan model genel özet üretir, seninkine cevap vermez.
- `--depth` **verme** (varsayılan `auto` doğru olanı seçer). Yalnız şu iki durumda müdahale et:
  `none` = görsel hiç gerekmiyor (yt-dlp ister) · `full` = kare kare doğruluk şart, maliyet umurunda değil.
- Anahtar yoksa komut tek cümleyle söyler (`GEMINI_API_KEY`). **Kendin anahtar üretme/arama**,
  kullanıcıya Ayarlar → Gemini anahtarını göster.

## Karar ağacı (komut bunu KENDİ uygular — sen yalnız bileceksin)

```
1) süre + başlık ölçülür.  Tahmini token > tavan (60k) ?
     ├─ yt-dlp VAR  → transcript yoluna DÜŞER (çıktı bunu işaretler)
     └─ yt-dlp YOK  → DURUR, çağrı YAPMAZ ("bu uzunlukta transcript yolu gerekir")
2) görsel bilgi gerekiyor mu (kod / slayt / UI / demo / grafik)?
     ├─ HAYIR → transcript (~640 tok, yt-dlp şart)
     └─ EVET  → H3: tek çağrı, fps=0.2 — KURULUM SIFIR   ← v1 varsayılanı
3) sana dönen: özet + zaman damgaları + maliyet satırı (~300 tok)
```

Tavan aşımında komut **para harcamadan** durur; `--budget 400000` ile bilerek yükseltebilirsin
ama önce kullanıcıya maliyeti söyle (1s56d'lik video ≈ $0,24).

## Üç uyarı (ölçülmüş tuzaklar — SKL-R2)

1. **Transcript-only çıktıda "ekranda görülmedi, çıkarımdır" işaretini ZORUNLU koy.** Transcript
   yolu sessizce uydurur: `useState` transcript'te hiç geçmiyordu, model tahmin etti ve o sefer
   tutturdu — bilinmeyen bir API'de yanlış tutturacaktı.
2. **Yalnız kareler ASLA tek başına kullanılmaz.** Sadece-kare yolu videoda hiç geçmeyen iddia
   üretti. Ses/transcript olmadan görsel çıkarım kanıt sayılmaz.
3. **Kare/örnekleme sayısını elle uydurma.** Aralık kuralı komutun içinde; sabit aralıklı örnekleme
   sahne-tespitinden güvenilirdir (kod slaytları arası sahne farkı düşüktür, sahne filtresi onları eler).

## Bitti sayılır

Raporunda: (a) komutun özeti, (b) `girdi X tok · çıktı Y tok · $Z` satırı aynen, (c) görsel yol
kullanılmadıysa "ekranda görülmedi, çıkarımdır" işareti. Ham transcript/kare **hiçbir yere**
yapıştırılmaz.
