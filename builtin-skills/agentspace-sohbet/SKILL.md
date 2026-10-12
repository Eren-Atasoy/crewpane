---
name: agentspace-sohbet
description: Takim sohbetine ZENGIN mesaj yaz — kod blogu, tablo, kopyala-yapistir notu, gorsel/dosya, rapor ve gorev baglantisi. Kullan — "kopyala yapistir seklinde paylas", "kodu sohbete at", "ekran goruntusunu gonder", "tabloyu sohbette goster", "raporu sohbete bagla". KULLANMA — tek cumlelik cevap icin ([ODA] satiri yeter); uzun cikti icin (rapora yaz, sohbette bagla).
license: LicenseRef-Muratify-Proprietary
---

# agentspace-sohbet — takım sohbetine zengin mesaj

Patron seninle **takım sohbetinden** konuşur. Tek cümlelik cevap için son satırın
`[ODA] cevap: …` olur; bu yeter. **Kod, tablo, görsel, kopyalanacak metin ya da
rapor/görev bağlantısı** paylaşacaksan `sohbete_yaz` aracını çağır. Araçla gelen mesaj
balonda doğru blok olarak çizilir ve aynı turdaki `[ODA]` satırınla **tek balon** olur.

## Araç

```
sohbete_yaz {
  metin:    markdown (≤ 8 KB)                ← zorunlu
  tur:      cevap | is | soru | sonuc        ← varsayılan cevap
  ekler:    ["/mutlak/yol/ekran.png"]        ← ≤ 10; çalışma klasörün ya da geçici klasör
  rapor:    "CHAT-RICH-03-wheeljack.md"      ← rapor çipi (dosya ADI, yol değil)
  gorevler: ["OCV3-04"]                      ← görev çipi
  kime:     ["bumblebee"]                    ← yalnız görünür hitap; boşsa patron
}
```

Aracı göremeyen motorda aynı fiil komutla: `node "<agentspaceCli.cjs>" sohbet yaz --dosya mesaj.md [--tur sonuc] [--ek /yol/a.png] [--rapor X.md] [--gorev OCV3-04]`.

## Blok sözlüğü

| Paylaşılan | metin içinde nasıl yazılır | Balonda |
|---|---|---|
| Kod | ```` ```bash ```` … ```` ``` ```` (dil adı yaz) | renkli kod + Kopyala; asla çalışmaz |
| Kopyala-yapıştır notu | ```` ```kopyala ```` + isteğe bağlı `başlık: …` satırı + `---` + metin | başlıklı not + Kopyala, metin BİREBİR |
| Tablo | GitHub tablosu (`| a | b |` + `|---|---|`) | kendi içinde kayan tablo |
| Link | çıplak `https://…` ya da `[ad](https://…)` | gerçek alan adı görünür; önizleme yok |
| Görsel / dosya | `ekler` alanı (metne yol YAZMA) | küçük resim ızgarası / dosya kartı |
| Rapor, görev | `rapor`, `gorevler` alanları | tıklanınca o rapor / o görev açılır |

**"Kopyala-yapıştır şekilde paylaş" denirse:** metni ```` ```kopyala ```` bloğuna koy. Bloğun
içine açıklama, markdown işareti ya da tırnak ekleme — patron olduğu gibi yapıştıracak.

## Kurallar

- Ham terminal çıktısını yapıştırma; özetle, uzun çıktıyı rapora yaz ve `rapor` ile bağla.
- Ev dizinin (`/Users/<ad>/…`) sohbette `~/…` görünür; yine de yol yazmak yerine ek kullan.
- Sır, anahtar, kişisel veri (e-posta/telefon) yazma — araç uyarır, patron görür.
- Başkası adına yazamazsın; kimlik pencerenden gelir. Dakikada en çok 6 mesaj.
- RET gelirse ileti ne düzelteceğini söyler; düzelt ve **bir kez** tekrar çağır.

## Örnekler

**1 — "deploy komutunu kopyala-yapıştır şekilde paylaş"**
```
sohbete_yaz { tur: "cevap", metin: "Deploy komutu:\n\n```kopyala\nbaşlık: Dev'e deploy\n---\nnpm run electron:build:dev\n```" }
```

**2 — "ekran görüntüsünü gönder"**
```
sohbete_yaz { tur: "sonuc", metin: "Yeni yazı kutusu böyle görünüyor.", ekler: ["/proje/docs/agent-results/X-evidence/kutu.png"], rapor: "X-ajan.md" }
```

**3 — ölçüm tablosu + görev bağlantısı**
```
sohbete_yaz { tur: "sonuc", gorevler: ["OCV3-04"], metin: "Öneri listesi ölçüldü:\n\n| durum | süre |\n|---|---|\n| ilk açılış | 42 ms |\n| harf başına | 3 ms |" }
```
