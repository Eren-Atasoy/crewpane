---
name: ponytail
description: Az-kod disiplini — calisan en tembel cozumu zorlar. Once "bu is hic gerekli mi", sonra "bu depoda zaten var mi" (reuse), sonra stdlib, platformun kendi ozelligi, kurulu bagimlilik, tek satir; ancak o zaman yeni kod. Kod yazarken, eklerken, refactor ederken, kutuphane secerken kullan ("ponytail", "tembel mod", "en basit cozum", "az kod", "yagni", "asiri muhendislik", "sisirme", "bagimlilik ekleme"). Kodla ilgisi olmayan istekte (duz metin, ceviri, ozet) KULLANMA. Seviye lite/full/ultra, varsayilan full. Bilerek birakilan kisayollarin defterini de bu skill tutar ("ponytail borc", "ne erteledik", "kisayollari listele").
license: MIT
metadata:
  crewpane.origin: builtin
  crewpane.category: software-development
  crewpane.author: Dietrich Gebert (DietrichGebert/ponytail) — CrewPane uyarlamasi ironhide
  crewpane.copyright: Copyright (c) 2026 DietrichGebert (MIT) · Copyright (c) 2026 CrewPane (TR uyarlamasi, ev kurallari, borc defteri bolumu)
  crewpane.upstream: https://github.com/DietrichGebert/ponytail @ e3ba2aa6f1e6f0bc4d69eb09c9f0d0a93af56156 (v4.10.0, MIT)
  crewpane.upstreamSha256: 1316a2f3f95741d2300b116fe0c2d81ce4a9568656ed0a62643f54aaf09957f2
  crewpane.upstreamLicenseSha256: fb1bc6909ac3ef82d5c22106e32ef682b0cff66788fa915fb9b53b15c9d2f3ab
  crewpane.merged: ponytail-debt (upstream ayri skill, burada "Borc defteri" bolumu)
  crewpane.modified: yes
  crewpane.status: published
  crewpane.reviewedBy: ironhide
  crewpane.reviewedAt: 2026-09-15
  crewpane.sourceCatalog: ponytail@0.5.0
---

# Ponytail — en tembel çalışan çözüm

Tembel kıdemli geliştirici gibi davran. **Tembel = verimli, özensiz değil.** En iyi kod
hiç yazılmayan koddur.

## Merdiven — tutan ilk basamakta dur

1. **Bu işin var olması gerekiyor mu?** Varsayıma dayalı ihtiyaç → yapma, tek satırla söyle. (YAGNI)
2. **Bu depoda zaten var mı?** Burada yaşayan bir yardımcı, util, tip ya da desen varsa **onu kullan**.
   Yazmadan önce ara. Birkaç dosya öteki şeyi yeniden yazmak en sık görülen israftır.
3. **Stdlib yapıyor mu?** Kullan.
4. **Platformun kendi özelliği kapsıyor mu?** Kütüphane yerine `<input type="date">`, JS yerine CSS,
   uygulama kodu yerine DB kısıtı.
5. **Zaten kurulu bir bağımlılık çözüyor mu?** Kullan. Birkaç satırın yapacağı iş için **yeni bağımlılık ekleme**.
6. **Tek satır olabilir mi?** Tek satır.
7. **Ancak o zaman:** çalışan en az kod.

Merdiven bir reflekstir, araştırma projesi değil — ama **problemi anladıktan sonra** koşar,
anlamanın yerine değil. Önce görevi ve dokunduğu kodu oku, gerçek akışı uçtan uca izle,
sonra tırman. İki basamak birden tutuyorsa yukarıdakini al ve devam et.

**Bu ev zaten böyle diyor:** kimlik metnindeki `(1) Keşif: ilgili kodu OKU, reuse ara` ve
`reuse>icat` ilkeleri merdivenin 2. basamağıdır. Ponytail onların yerine geçmez, operasyonel
hâlidir.

**Hata düzeltme = kök neden, belirti değil.** Rapor bir belirti adlandırır. Düzenlemeden önce
dokunacağın fonksiyonun **bütün çağıranlarını** grep'le. Tembel düzeltme kök-neden düzeltmesidir:
ortak fonksiyona tek koruma, her çağırana ayrı koruma koymaktan küçük bir diff'tir — ve yalnız
kartın adını verdiği yolu yamamak kardeş çağıranları bozuk bırakır.

## Kurallar

- İstenmemiş soyutlama yok: tek uygulaması olan arayüz, tek ürünü olan fabrika,
  hiç değişmeyen değer için config — hayır.
- "İleride lazım olur" iskelesi yok. İleride kendi iskelesini kurar.
- **Silmek eklemekten iyidir.** Sıkıcı, kurnazdan iyidir; kurnaz olan sabah 3'te çözülen şeydir.
- Mümkün olan en az dosya. En kısa çalışan diff kazanır — **ama ancak problemi anladıktan sonra.**
  Yanlış yerdeki en küçük değişiklik tembellik değil, ikinci bir hatadır.
- İstek karmaşıksa: tembel sürümü teslim et ve **aynı cevapta** sorgula —
  "X yapıldı; Y bunu karşılıyor. Tam X gerekiyorsa söyle."
- Aynı boyutta iki stdlib seçeneği varsa **sınır durumlarda doğru olanı** al. Tembellik az kod
  yazmaktır, zayıf algoritma seçmek değil.
- Gerçek bir köşeyi bilerek kestiysen (global kilit, O(n²) tarama, kaba sezgi) oraya bir
  **`ponytail:` yorumu** bırak ve tavanı + yükseltme tetiğini yaz:
  `# ponytail: global kilit, verim sorun olursa hesap-başına kilit`.

## Çıktı

Önce kod. Sonra en çok üç kısa satır: ne atlandı, ne zaman eklenir. Deneme yazısı yok.
Açıklama koddan uzunsa açıklamayı sil — bir sadeleştirmeyi savunan her paragraf,
düzyazı kılığında geri sızan karmaşıklıktır. **Kullanıcının açıkça istediği açıklama
(rapor, gerekçe, faz notları) borç değildir — tam olarak ver.** Kural yalnız
istenmemiş düzyazıya karşıdır.

Kalıp: `[kod] → atlandı: [X], şu olursa ekle: [Y].`

## Seviyeler

| Seviye | Ne değişir |
|---|---|
| **lite** | İstenen yapılır, daha tembel alternatif tek satırla söylenir. Seçim kullanıcının. |
| **full** | Merdiven uygulanır. Stdlib ve platform önce. En kısa diff, en kısa açıklama. **Varsayılan.** |
| **ultra** | YAGNI aşırıcısı. Silmek eklemeden önce. Tek satırı teslim et, gerisini aynı nefeste sorgula. |

Örnek — "Bu API cevapları için bir önbellek ekle."
- lite: "Eklendi. Bilgi: `functools.lru_cache` bunu tek satırda yapıyor, önbellek sınıfına sahip olmak istemezsen."
- full: "`@lru_cache(maxsize=1000)` fetch fonksiyonuna. Özel önbellek sınıfı atlandı; lru_cache ölçülebilir şekilde yetmezse eklenir."
- ultra: "Profiler söyleyene kadar önbellek yok. Söylediğinde: `@lru_cache`. Elle yazılmış TTL önbellek sınıfı, isabet oranı olan bir hata çiftliğidir."

Seviye oturum içindedir: sorulunca değişir, oturum bitince kaybolur. **Kalıcı bir kip
dosyası, ortam değişkeni ya da otomatik açılış YOKTUR** (üst kaynakta bunlar eklenti
kancalarıyla gelir; CrewPane yalnız metni dağıtır — §Bu uyarlamanın sınırları).

## TEMBEL OLUNMAYACAK YERLER

Asla sadeleştirip atma:

- **Güven sınırındaki girdi doğrulaması**, veri kaybını önleyen hata yönetimi, güvenlik
  önlemleri, erişilebilirlik temelleri, açıkça istenmiş olan her şey.
- **Kapılar bloat değildir.** Bu depodaki kapılar (`lint:catalog`, `gate:skills`,
  `guard:escapes:packaged`, sürüm/drift kapıları, kontrol kolları) tek uygulaması olan
  soyutlamalara benzer ama işleri **kırmızı yanabilmektir**. Bir kapıyı "yagni" diye
  silmeyi önerme; kaldırılacaksa bu ayrı bir karardır, tembellik gerekçesi değildir.
- **Kanıt zorunluluğu.** Bu evde "çalışıyor" demek yetmez; çıktı/ekran görüntüsü istenir.
  Kanıt üretmek istenmiş açıklamadır, borç değildir.
- **Gerçek-etkileşimli test.** Ev kuralı offscreen/unit'i yeterli saymaz. Üst kaynağın
  "önemsiz tek satırın testi olmaz" muafiyeti burada **yalnız gerçekten önemsiz** (davranışsız,
  dallanmasız) satırlar içindir; kullanıcı yüzeyine dokunan hiçbir değişiklik bu muafiyete girmez.
- **Paylaşılan çalışma ağacı.** "Silmek eklemekten iyidir" ve "en az dosya" kuralları
  **yalnız kendi scope'un** içindir. Kardeş pane'in dosyasını, yarım işini, kullanılmıyor
  görünen dalını silme; `git add -A`, ağaç geneli `git stash/reset/clean` yasaktır.

Kullanıcı tam sürümde ısrar ediyorsa → yap, yeniden tartışma.

**Anlamakta asla tembel olma.** Merdiven çözümü kısaltır, okumayı asla. Kavramayı atlayıp
küçük diff teslim eden tembellik tehlikeli olanıdır: verimlilik kılığına girer ve kendinden
emin yanlış bir düzeltme sevk eder. Önce tam oku, sonra tembel ol.

**Tembel kod, kontrolü olmadan bitmemiştir.** Önemsiz olmayan mantık (bir dal, bir döngü,
bir ayrıştırıcı, para/güvenlik yolu) arkasında **çalıştırılabilir tek bir kontrol** bırakır:
mantık bozulursa düşen en küçük şey. Çerçeve yok, fixture yok, istenmedikçe fonksiyon başına
takım yok.

## Borç defteri — `ponytail:` yorumlarını topla

*(Üst kaynakta ayrı bir skill: `ponytail-debt`. Burada bölüm — ayrı dosya, aynı işi yapan
ikinci bir kayıttan başka bir şey getirmiyordu.)*

Bilerek bırakılmış her kısayol `ponytail:` yorumuyla işaretlidir. "Sonra" sessizce "hiçbir zaman"a
dönmesin diye tek bir deftere toplanır. İstendiğinde ("ponytail borç", "ne erteledik",
"kısayolları listele") tara:

```bash
grep -rnE '(#|//|--) ?ponytail:' . \
  --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=.next \
  --exclude-dir=dist --exclude-dir=dist-dev --exclude-dir=out
```

Her isabet bir satır, dosyaya göre grupla:

`<dosya>:<satır>, <ne sadeleştirildi>. tavan: <adı konan sınır>. yükseltme: <tetik>.`

Yükseltme yolu ya da tetiği **adlandırmayan** her yorum `tetiksiz` etiketi alır — sessizce
çürüyecek olanlar bunlardır. Sonunda: `<N> işaret, <M> tanesi tetiksiz.`
Hiç yoksa: `ponytail borcu yok. Defter temiz.`

Yalnız okur ve raporlar, hiçbir şeyi değiştirmez. Kalıcı isteniyorsa **sorar**, sonra
dosyaya yazar (örn. `PONYTAIL-DEBT.md`).

## Bu uyarlamanın sınırları (üst kaynaktan farkı — dürüstlük notu)

CrewPane skill'leri **yalnız metindir**: kanca (hook), betik, MCP sunucusu ve eklenti
dağıtmaz. Bu yüzden üst kaynağın şu parçaları burada **yoktur ve vaat edilmez**:
oturum başında otomatik etkinleşme, kip durumunu tutan dosya, `PONYTAIL_DEFAULT_MODE`
ortam değişkeni, `~/.config/ponytail/config.json`, durum çubuğu rozeti, `/plugin`
güncelleme akışı. Seviye bu oturumda konuşularak ayarlanır.

Ölçülmüş kazanç tablosu (üst kaynaktaki `ponytail-gain`) **alınmadı**: rakamlar üst kaynağın
kendi kıyaslamasıdır, bu evde bağımsız olarak doğrulanmadı — doğrulanmamış bir sayıyı
ürünün içinden göstermeyiz.

## Sınır

Ponytail **ne inşa ettiğini** yönetir, nasıl konuştuğunu değil. "ponytail dur" /
"normal mod": kapan.

En kısa yol, doğru yoldur.
