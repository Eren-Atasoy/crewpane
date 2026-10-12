---
name: agentspace-rapor
description: Sonuc raporunu AgentSpace'in kendi rapor sistemine yaz — rapor_yaz araci (yoksa agentspace report yaz, o da yoksa dosya), zorunlu hukum, blok sozlugu, gorselli rapor = HTML rapor (bicim html + sayfa), karar kutusu. Kullan — "raporu yaz", "sonuc raporu", "gorselli rapor", "maket goster", "karar sor", "tasarimi raporla", "Claude sayfasi yerine". KULLANMA — sohbette tek satirlik cevap icin (agentspace-sohbet); Claude Artifact'e ya da baska bir yere yayinlamak icin (YASAK).
license: LicenseRef-Muratify-Proprietary
---

# agentspace-rapor — raporu kendi rapor sistemimize yaz

Patron raporlarını AgentSpace'in **Raporlar** sekmesinde okur. Rapor orada kalır: hesap
değişse, pane kapansa, motor değişse bile. Claude Artifact bağlantısı hesap değişince ölür;
tarayıcıda açılan her sayfa patronun Chrome'unda bir sekme daha demektir.

**Yasak:** raporu ya da parçasını Claude Artifact'e, bir paylaşım sitesine ya da başka bir
yere yayınlamak · harici tarayıcıda sekme açmak (`open x.html`, `xdg-open`, `start`) · görsel
sayfayı rapordan AYRI bir `.html` dosyası olarak bırakmak (`…-evidence/sayfa.html`).
Görsel ya da etkileşimli içerik varsa rapor bir **HTML rapordur**: `bicim: "html"` + `sayfa`.
Sayfa Raporlar sekmesinde raporun kendisi olarak açılır.

## Yazım yolu — üç kademe

1. **Araç:** `rapor_yaz` (İngilizce adı `report_write`). Doğrular, dosyayı projenin ana
   ağacına yazar (worktree'den çağırsan da), sürüm tutar. Aynı kod tekrar = yeni sürüm.
2. **Araç görünmüyorsa komut:** `node "<agentspaceCli.cjs>" report yaz --kod RPT4-10 --gorev TASK-… --hukum "Bitti: …" --tip ölçüm --platform "…" --govde-dosya govde.md [--ekler a.png,b.html] [--dosya <SONUÇ DOSYASI>]`.
   Uzun gövdeyi argv'ye yazma; `--govde-dosya` kullan. Yardım: `report yaz --help`.
3. **İkisi de yoksa dosya:** `docs/agent-results/<KOD>-<ajan>.md`, aşağıdaki ön-bilgiyle.

Görev metninde SONUÇ DOSYASI yolu varsa onu `dosya` alanına aynen yaz. Uzun işte önce
`durum: "yaziliyor"` ile taslak aç, bölümleri `rapor_ekle` ile ekle, sonunda `rapor_yaz`
(`durum: "bitti"`). RET gelirse ileti neyi düzelteceğini söyler; düzelt, **bir kez** tekrar çağır.

## Alanlar

| Alan | Kural |
|---|---|
| `hukum` | Zorunlu, tek cümle; `Bitti:` · `Kısmen bitti:` · `Başarısız:` ile açılır, ardından SONUÇ gelir ("Bitti: 378 raporun 0'ı kırıldı", "Bitti: çalışıyor" değil) |
| `tip` | `hata` · `araştırma` · `yayın` · `ölçüm` · `karar` · `rehber` · `diğer` (board tipi `feature/bug` değil) |
| `okur` | `ekip`: worker raporu (varsayılan). `kullanıcı`: lider sentezi ya da karar soran rapor (sade dil). Beyan etmezsen gövdede `karar` bloğu olan rapor `kullanıcı` olur. `team`/`worker` → `ekip`, `user`/`patron` → `kullanıcı` diye düzeltilir |
| `bicim` | `html`: tablo, grafik, maket, kare, karar kutusu, yani görsel ya da etkileşimli her rapor. `md` (varsayılan): yalnız metin |
| `platform` | Zorunlu: nerede doğruladın; koşamadığın platform "koşulamadı + neden" |
| `gorev` | Board kartından gelen işte kartın tam kimliği (`TASK-…`); kartsızsa `kartsiz: true` |
| `ekler` | `docs/agent-results/` klasörüne göreli (`RPT4-10-evidence/kare.png`); `..`, mutlak yol, `~`, `https://` RED |

Gövde başlıkları: Ne yapıldı · Kanıt (kopyalanmış çıktı, iddia değil) · Değişen dosyalar ·
Riskler · Açık sorular · Sonraki adım.

## Okura yaz (`okur: "kullanıcı"`)

Patrona giden rapor mühendise değil **okura** yazılır. Patron sayfayı baştan sona okumaz: ilk
ekrana bakar, ya karar verir ya geçer. Reddedilen MOB-ARCH-ADR raporu 2.797 kelime ve 0
görseldi; bir bölümü 488 kelime, bir tablo hücresi 53 kelimeydi ve görünür metinde 20 dosya
yolu vardı. Altyapıda bir eksik yoktu, rapor mühendise yazılmıştı.

**İlk ekran (kaydırmadan görünen kısım):**
1. **Hüküm:** tek cümle, sonuçla ("React Native'de kalalım; eksik olan dil değil, mağaza uygulaması").
2. **Senden beklenen:** tek satır. "K1'de A ya da B seç" ya da "Bir şey beklenmiyor, bilgi için".
3. En çok 4 sayı kartı. Ayrıntının hepsi aşağıda.

**Gövde: beş sınır.** Yoğunluk kapısı (RDB-02) aynı beş sınırı ölçer; ikisi aşılırsa uyarır.
Kapı yoksa sen say.

| Kod | Sınır | Aşılırsa |
|---|---|---|
| G1 | Görselsiz sayfa en çok 1.500 kelime | Her bölüm bir kart, tablo, şema, önce/sonra ya da kareyle açılır |
| G2 | Bölüm (`<h2>` arası) en çok 350 kelime | Böl ya da katla. Paragraf en çok 4 cümle |
| G3 | Tablo hücresi en çok 25 kelime | Hücreye etiket ve sayı yaz; açıklama tablonun altına |
| G4 | Görünür metinde en çok 5 dosya yolu | İç mekanizma "Ayrıntı"ya: dosya yolu, satır no, fonksiyon/sabit/kolon adı, port |
| G5 | ASCII şema yok (`→ │ └` dolu `<pre>`) | SVG ya da kutu-ok HTML çiz |

- **Teknik ayrıntı katlanır:** kanıt çıktısı, kod yolları, ölçüm dökümü sayfanın sonunda
  `<details><summary>Ayrıntı (mühendis için)</summary>…</details>` içinde. Katlı metin G2, G4
  ve G5'e sayılmaz. `govde`'deki Kanıt bölümü yine tam kalır.
- **Okurun kelimesi:** "SSE gateway" değil "canlı bağlantı". Terimi ilk geçtiği yerde yarım
  cümleyle açıkla. Bölüm başlığını okurun sorusu yap ("Telefonda bugün ne kırık?").
- Çizimdeki örnek metin uydurma kimlik taşımaz (görev kodu, dosya yolu, test sayısı). "Bugün"
  diye gösterilen her şey ölçülmüş olmalı; değilse çizimin üstüne "örnek" yaz.
- Yukarıdaki gövde başlıkları (`Ne yapıldı`, `Kanıt`…) `.md` içindir; sayfa okura göre kurulur.

**Örnek çifti: aynı içerik iki hâliyle.** Kötü, MOB-ARCH-ADR'nin "Bugünkü durum" tablosundan
tek satır (G3: 42 kelime, G4: iki dosya yolu):

```html
<tr><td>Terminal</td><td>Masaüstünde xterm.js 6 + WebGL kullanılıyor. Telefona ise sunucuda
@xterm/headless ile çizilen ekran gidiyor. Ekran satırlara bölünüyor, renk ve biçim atılıyor,
telefon bunu &lt;Text&gt; satırları olarak basıyor. Sarma kapalı, yatayda kaydırılıyor. Tuş
gönderen bir rota yok: yalnız prompt ve "dur" var.</td>
<td>paneScreen.cjs başlığı · WorkScreen.tsx:88-104</td></tr>
```

İyi, aynı bilgi Klip Motoru yol planının (Skool) diliyle: okurun gördüğü şey, neden, ayrıntı katlı.

```html
<tr><td>Terminal</td><td>Renksiz, ufacık düz yazı</td><td>Ekran telefona görüntü değil yazı olarak gidiyor</td></tr>
…
<details><summary>Ayrıntı (mühendis için)</summary>Telefon terminali sunucuda @xterm/headless
ile çiziliyor, renk atılıyor (paneScreen.cjs, WorkScreen.tsx:88-104).</details>
```

İki sayfanın tamamı (ADR'nin ilk iki bölümü, önce ve sonra) AgentSpace deposunda:
`docs/design/rapor-ornekleri/okura-yaz/`.

## Blok sözlüğü

Blok = çitli kod bloğu, bilgi dizesi blok adı. Bozuk blok yazımı reddetmez, düz kod çizilir
(istisna: bloktaki dosya yolu kurala uymazsa RET).

| Blok | Ne için | Gramer |
|---|---|---|
| `uyarı` | dikkat çekilecek tek not | `tür: bilgi\|dikkat\|tehlike` + metin |
| `adımlar` | sıralı adım, altında kare | `1. metin` + girintili `kare: yol` |
| `karşılaştır` | önce/sonra, seçenek tablosu | `A \| B \| C` satırları, ilki başlık |
| `kanıt` | ekran görüntüsü, çıktı dosyası | `dosya: yol` + `altyazı: metin` |
| `grafik` | sayı serisi | `tür: çubuk\|çizgi\|halka`, `başlık:`, `birim:`, `etiket: sayı` |
| `akış` | süreç, mimari | `A -> B : etiket`, `grup: Ad \| A, B` |
| `şekil` | küçük çizim | satır içi `<svg>…</svg>` (betik/dış bağlantı silinir) |
| `karar` | patrona seçim sorusu | `kimlik:`, `soru:`, `seçenek: A \| metin` (≥ 2), `öneri:`, `varsayılan:` |
| `yapılacak` | işaretlenecek liste | isteğe bağlı `kimlik:` + `- [ ] metin` |
| `sayfa` | etkileşimli ek sayfa | `dosya: ….html`, `özet:` (zorunlu), `yükseklik: 120–2000` |
| `kopyala` | birebir kopyalanacak metin | `başlık: …` + `---` + metin |

`karar` ve `yapılacak` kimliği küçük harf/rakam/`-`/`_` ve rapor içinde tekil olmalı:
patronun cevabı defterde bu kimliğe yazılır, sen `rapor_oku` ile okursun.

## Görselli rapor = HTML rapor (`bicim: "html"`)

Raporunda tablo, grafik, kart, kare, maket ya da karar kutusu varsa HTML rapor yaz. Yalnız
metinse `md` yeter.

- **Nasıl:** sayfayı önce `docs/agent-results/<KOD>-evidence/taslak.html` olarak yaz, **kontrol et**
  (aşağıda), sonra `rapor_yaz { bicim: "html", sayfa_dosyasi: "<KOD>-evidence/taslak.html" }`. Kısa
  sayfada `sayfa: "<!doctype html>…"` de olur. Köprüde `--bicim html --sayfa-dosyasi <yol>`. Araç
  sayfayı `<KOD>-<ajan>.html` adıyla `.md`'nin yanına koyar.
- **`.md`'de ne kalır:** künye + `ozet` (3-8 satır, sayfanın sonucu) + `govde`. **Kanıt bölümünü
  (kopyalanmış komut çıktısı, test sayısı, commit) ve `karar` bloklarını `govde`'ye yaz.** Rapor kapısı
  ve diğer ajanlar `.md`'yi okur. Komut çıktısını sayfada da göstereceksen `<pre>` içine koy.
- **Sayfa üç yerde açılır** ve üçünde de aynı görünmeli: AgentSpace okuyucusu (internete kapalı
  kutu), okuyucunun "Tarayıcıda aç" kopyası ve **Chrome'da dosyadan** (patron raporu çoğu zaman
  böyle açar). Dış betik, yazı tipi, CDN, `fetch` yüklenmez; CSS ve JS satır içinde. En çok **2 MB**.

### Kareler: üç yerde de açılan yazım

| Yazım | Okuyucu | Tarayıcıda aç | Chrome |
|---|---|---|---|
| `<img src="data:image/webp;base64,…">` **(varsayılan)** | ✓ | ✓ | ✓ |
| `<img data-kanit="01.png" src="<KOD>-evidence/01.png">` (çift yazım) | ✓ | ✓ | ✓ |
| `<img src="kanit:01.png">` tek başına | ✓ | ✓ | ✗ **YASAK** |

- **Gömülü:** kareyi gömmeden önce küçült (1200 px, webp): `sips -Z 1200 a.png --out k.png && cwebp -q 70 k.png -o k.webp`
  (Linux/Windows: `cwebp -resize 1200 0 -q 70 a.png -o k.webp`), sonra `base64`. Kare başına ~30–150 KB.
- **Çift yazım** yalnız sayfa 2 MB'a sığmıyorsa. **Sıra şart: `data-kanit` önce, `src` sonra**
  (ters sırada "Tarayıcıda aç" kopyasında kırılır). Kare `<KOD>-evidence/` altında olur, en çok 40 kare.
- `kanit:` tek başına yazılmaz: Chrome onu tanımaz. Ölçüm (RPT-VISUAL-01): son 60 raporda karelerin
  %89,8'i Chrome'da kırıktı, hepsi `kanit:`.
- `loading="lazy"` koyma (okuyucu kutusu uzadığı için tembel kare yüklenmeyebilir).
- **Video:** okuyucu video göstermez. `<video poster="data:…" data-src="<KOD>-evidence/klip.mp4">` + adresi
  yalnız dosyadan açılınca veren üç satırlık betik (`docs/design/rapor-ornekleri/parcalar.html` → video).

### Görünüm sayfanın kendisinde

- Sayfa **kendi `<style>`'ını** taşır: yazı tipi ailesi, zemin, metin, kart, tablo. Kit sınıfları
  (`.card`, `.pill`, `.grid3` …) ve kit token'ları (`var(--surface-1)` …) **yalnız okuyucuda** vardır;
  Chrome'da tanımsızdır, sayfa Times ile ve stilsiz açılır.
- Renkleri sen seçersin, **önekli kendi token'larınla**: `:root{--v-bg:…;--v-c1:…}` ve sınıflar `.v-*`
  (kitin `.dot`, `.dec`, `.card` adlarıyla çakışmasın). Zemin ve metin uygulamayla uyumlu olsun diye
  yedekli bağla: `--v-bg: var(--surface-0, #f6f5f0)` (okuyucuda uygulama rengi, Chrome'da yedek).
  Grafik ve durum renkleri (`--v-c1`…`--v-c5`, `--v-ok`, `--v-bad`) sayfanın kendisinin.
- Açık ve koyu tema: `:root{…açık…}` + `@media (prefers-color-scheme:dark){:root:not([data-theme=light]){…koyu…}}`
  + `:root[data-theme=dark]{…koyu…}`. Chrome sistem temasını, okuyucu `data-theme`'i izler.
- `<meta name="agentspace-kit" content="2">` kalsın: karar kutusu, sekme ve kontrol listesi
  davranışlarını o getirir. Görünüm ona dayanmasın.
- 390 px'te yatay taşma olmasın: ızgara `repeat(auto-fit,minmax(min(280px,100%),1fr))`, geniş tablo
  kaydırma kabında (`.v-tw{overflow:auto}` + `table{min-width:max(100%,560px)}`).
- Hazır parçalar ve token bloğu: **`docs/design/rapor-ornekleri/parcalar.html`** (kopyala, doldur).
  İyi ve kötü örnekler aynı klasörde (`README.md`).

### Görsel şölen (`okur: "kullanıcı"`)

Patron raporu okumaz, bakar. Artifact dönemindeki sayfalar çıtadır. Patrona giden sayfada:

- **En az 3 farklı görsel bileşen:** SVG grafik (çubuk, sütun, çizgi, halka), akış şeması, zaman
  çizelgesi, ısı haritası tablosu, önce/sonra, kare galerisi, maket. Düz tablo ve sayı kartı tek
  başına sayılmaz. CSS ile çizdiğin görsele `data-gorsel="akis"` gibi işaret koy.
- **Sayı varsa grafik:** 3 ya da daha çok sayıyı karşılaştırıyorsan çiz, tabloya gömme.
- **En az 3 renk tonu:** durum renkleri + vurgu. Tek renk gri sayfa reddedilir.
- **Açılış:** başlık + tek cümlelik hüküm kutusu + 3-4 sayı kartı; ayrıntı aşağıda.
- Ekip raporunda (`okur: "ekip"`) zorunlu değil; kanıt karesi ya da bir grafik yine önerilir.

### Teslimden önce: Chrome kontrolü (zorunlu)

**AgentSpace deposunda (`agentdesk`)** tek komut:
```bash
node docs/design/rapor-ornekleri/kontrol/kontrol.cjs docs/agent-results/<KOD>-evidence/taslak.html --okur kullanici
```
Sayfayı sekme açmadan (headless) Chrome'da 1440 ve 390 px × açık ve koyu temada, okuyucu kutusunda
ve "Tarayıcıda aç" kopyasında açar; kırık kare, Times, 390 px taşma, betik hatası ve (`--okur kullanici`
ile) görsel bileşen ve renk sayısını ölçer. **`SONUÇ: TEMİZ` demeden `rapor_yaz` çağırma.** Sonra
kareleri (`chrome-1440-light.jpg`, `chrome-390-light.jpg`, `okuyucu-dark.jpg`) kendin aç ve bak.
`rapor_yaz`'dan sonra son sayfa (`docs/agent-results/<KOD>-<ajan>.html`) için bir kez daha koş.
`rapor_yaz` da yazmadan önce sayfayı uygulamanın gizli penceresinde açar: kırık kare → **RET** (hangi kare
ve neden yazar, rapor yazılmaz); az görsel, stilsiz sayfa, 390 px taşma → uyarı. Kapı son kalkandır, kontrolün yerine geçmez.

**Başka projede** (araç yoksa) aynı kontrolün en azı:
1. `grep -c 'src="kanit:' sayfa.html` → 0 olmalı; sayfada `<style>` ve `--v-` olmalı.
2. Headless Chrome karesi, iki genişlikte (sekme açmaz):
   `"<chrome>" --headless=new --hide-scrollbars --window-size=1440,2400 --screenshot=k1440.png "file://<tam yol>"`
   ve `--window-size=390,2400 --screenshot=k390.png`. `<chrome>`: macOS
   `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`, Windows
   `C:\Program Files\Google\Chrome\Application\chrome.exe`, Linux `google-chrome`.
3. İki kareyi aç ve bak: kırık görsel simgesi, Times yazı, taşan içerik, tek renk gri sayfa yok.

### İskelet

Kopyala, doldur (tam token bloğu ve diğer parçalar `parcalar.html`'de). Kare yerine gerçek `data:` adresini koy:
```html
<!doctype html><html lang="tr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="agentspace-kit" content="2"><title>RPT5-03 — Raporlar listesi</title>
<style>
:root{color-scheme:light;--v-bg:var(--surface-0,#f6f5f0);--v-s1:var(--surface-1,#fff);--v-s2:var(--surface-2,#efede6);
 --v-b:var(--border-2,#dedad0);--v-t1:var(--text-1,#14161b);--v-t2:var(--text-2,#454b55);--v-t3:var(--text-3,#6d737d);
 --v-c1:#5150d0;--v-c2:#0f9f8f;--v-c3:#e2484d;--v-ok:#1d8f4e;--v-bad:#d23a3a}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){color-scheme:dark;--v-bg:var(--surface-0,#0c0f13);
 --v-s1:var(--surface-1,#141920);--v-s2:var(--surface-2,#1b222a);--v-b:var(--border-2,#2a3440);--v-t1:var(--text-1,#eef1f5);
 --v-t2:var(--text-2,#b4bdc8);--v-t3:var(--text-3,#8893a1);--v-c1:#8f91ff;--v-c2:#2fd2bd;--v-c3:#ff6b6e;--v-ok:#3ddc84;--v-bad:#ff6161}}
:root[data-theme=dark]{color-scheme:dark;--v-bg:var(--surface-0,#0c0f13);--v-s1:var(--surface-1,#141920);
 --v-s2:var(--surface-2,#1b222a);--v-b:var(--border-2,#2a3440);--v-t1:var(--text-1,#eef1f5);--v-t2:var(--text-2,#b4bdc8);
 --v-t3:var(--text-3,#8893a1);--v-c1:#8f91ff;--v-c2:#2fd2bd;--v-c3:#ff6b6e;--v-ok:#3ddc84;--v-bad:#ff6161}
*{box-sizing:border-box}html,body{margin:0;background:var(--v-bg);color:var(--v-t1)}
body{font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif;overflow-wrap:anywhere}
.v-wrap{max-width:1080px;margin:0 auto;padding:24px 20px}img,svg{max-width:100%}
.v-verdict{background:var(--v-s1);border:1px solid var(--v-b);border-left:5px solid var(--v-ok);border-radius:14px;padding:14px 18px}
.v-kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(220px,100%),1fr));gap:12px;margin:16px 0}
.v-kpi{background:var(--v-s1);border:1px solid var(--v-b);border-top:4px solid var(--c);border-radius:14px;padding:14px}
.v-kpi b{display:block;font-size:34px;line-height:1;color:var(--c)}
.v-ax{fill:var(--v-t3);font:12px sans-serif}.v-val{fill:var(--v-t1);font:700 12px sans-serif}
.v-fig{margin:0;border:1px solid var(--v-b);border-radius:14px;overflow:hidden;background:var(--v-s1)}
.v-fig img{display:block;width:100%}.v-fig figcaption{padding:8px 12px;font-size:13px;color:var(--v-t2)}
pre{background:var(--v-s2);border:1px solid var(--v-b);border-radius:10px;padding:12px;overflow-x:auto;font:12.5px ui-monospace,Menlo,monospace}
</style></head>
<body><div class="v-wrap">
<h1>RPT5-03 — Raporlar listesi</h1>
<div class="v-verdict"><b>Hüküm</b><br>Bitti: pane kapansa da liste masada kalıyor.</div>
<div class="v-kpis">
  <div class="v-kpi" style="--c:var(--v-ok)"><b>13/13</b>birim testi</div>
  <div class="v-kpi" style="--c:var(--v-c1)"><b>3</b>gerçek tıklama karesi</div>
</div>
<h2>Önce / sonra</h2>
<svg viewBox="0 0 420 90" style="max-width:460px;width:100%" role="img" aria-label="Önce 0, sonra 13 rapor kaldı">
  <text class="v-ax" x="0" y="26">önce</text><rect x="60" y="14" width="3" height="18" rx="3" fill="var(--v-c3)"/><text class="v-val" x="70" y="27">0</text>
  <text class="v-ax" x="0" y="66">sonra</text><rect x="60" y="54" width="300" height="18" rx="3" fill="var(--v-c2)"/><text class="v-val" x="366" y="67">13</text>
</svg>
<h2>Kanıt</h2>
<figure class="v-fig"><img src="data:image/webp;base64,UklGR…" alt="açılır liste"><figcaption>gerçek uygulamada</figcaption></figure>
<pre>$ node --test src/x.test.mts
ℹ pass 13</pre>
<h2>Karar</h2>
<div data-karar="k1"></div>
</div></body></html>
```

**Karar kutusu:** sayfadaki `<div data-karar="k1"></div>` kutunun yeridir; kit onu okuyucuda çizer
(Chrome'da boş kalır). Chrome'da da görünsün istersen kutuyu kendin çiz: `<div class="v-dec" data-karar="k1">`
içine `label > input[type=radio][name=karar-k1][value=A]`; kit hazır radyoya bağlanır (`parcalar.html` → karar).
Kararın kendisi `govde`'deki aynı kimlikli `karar` bloğudur; okuyucu kutuyu o bloğa bağlar. Görev kartının
Kararlar bölümünde de görünsün istiyorsan önce `karar_sor` ile aç, dönen kimliği bloğa `karar_kimligi:`
olarak yaz. Bloksuz kutu karar kaydına gitmez; araç bunu uyarır.

## `sayfa` bloğu (metin raporuna küçük ek)

Rapor metinse ve içine tek bir küçük etkileşimli parça gerekiyorsa `sayfa` bloğunu kullan:
tek `.html`, en çok **512 KB**, `<KOD>-evidence/` altında, `özet:` zorunlu. Görsel ağırlıklı
raporda bunun yerine HTML rapor yaz.

## Örnekler

**1 — Kısa rapor (blok yok)**
```
rapor_yaz {
  kod: "ADP-812", gorev: "TASK-MU…", tip: "hata", okur: "ekip",
  hukum: "Bitti: pane kapanınca rapor listesi boşalmıyor; 3 birim testi + kontrol kolu geçti.",
  platform: "macOS 14.6 (arm64) — Windows/Linux koşulamadı, kod yolu platforma bağlı değil",
  govde: "## Ne yapıldı\n…\n## Kanıt\n```\n$ node --test …\nℹ pass 3\n```\n## Değişen dosyalar\n…"
}
```

**2 — Görselli rapor (HTML rapor)**
Sayfa yukarıdaki iskelet; `kontrol.cjs` "TEMİZ" dedikten sonra yaz. Maket gerekiyorsa kendi küçük
betiğini yaz (kitin `data-adim` / `data-kit-bastan` davranışları yalnız okuyucuda çalışır, Chrome'da
düğmeler ölü kalır; örnek: `rapor-ornekleri/iyi/MOB-R2-vera.html`). Maketin ürünün kendisi değil,
davranışın taslağı olduğunu sayfada yaz.
````
rapor_yaz {
  kod: "RPT5-03", gorev: "TASK-MU…", tip: "diğer", okur: "ekip", bicim: "html",
  sayfa_dosyasi: "RPT5-03-evidence/taslak.html",
  hukum: "Bitti: pane başlığındaki Raporlar listesi çalışıyor; 13/13 test, 3 gerçek tıklama karesi.",
  platform: "macOS 14.6 — Windows/Linux koşulamadı (makinede yok)",
  ozet: "Pane kapansa da Raporlar listesi masada kalıyor.\nÜç kare ve test çıktısı sayfada.",
  govde: "## Kanıt\n```\n$ node --test src/x.test.mts\nℹ pass 13\n```\n## Değişen dosyalar\n…"
}
````

**3 — Karar soran rapor (`karar` bloğu)**
Soru tek cümle, seçenekler kısa, önerin açık. Karar soran rapor patrona yazılır (`okur:
"kullanıcı"`). Görsel gerekiyorsa HTML rapor yaz, bloğu `govde`'de bırak, sayfaya
`<div data-karar="k1">` koy. Cevabı `rapor_oku` ile (bloğa `karar_kimligi` yazdıysan
`karar_oku` ile) oku; cevap gelmeden kararı kendin verme.
````
```karar
kimlik: k1
soru: Rapor bağlantısı tarayıcıda nasıl açılsın?
seçenek: A | agentspace:// bağlantısı uygulamayı açar, sekme kalmaz
seçenek: B | Sabit yerel adres, tarayıcıda okunur
öneri: A
varsayılan: A
```
````

**4 — Tasarım raporu**
Tasarımı Tasarım sekmesine koy: `docs/design/<KOD>/v1.html`, sonraki sürüm `v2.html` (sekme
bu klasörü sürümleriyle gösterir). Rapora
tasarımın önizlemesini koy: HTML raporda `<div data-kit="tasarim" data-gorev="<KOD>">` (yalnız
okuyucuda görünür; Chrome için yanına tasarımın gömülü karesini koy), metin
raporunda kareyi `kanıt` ile ekle (kareyi `<KOD>-evidence/` altına kopyala) ve "Tasarım
sekmesi → <KOD>" yaz. Tasarımı tarayıcıda açma, Claude'a yükleme.

## Kontrol (yazmadan önce)

- [ ] Hüküm `Bitti:` / `Kısmen bitti:` / `Başarısız:` ile açılıyor ve bir sonuç söylüyor
- [ ] Platform beyanı var; koşulamayan platform gerekçesiyle
- [ ] Görsel ya da etkileşim varsa `bicim: "html"`; ayrı `.html` bırakmadım
- [ ] HTML raporda Kanıt bölümü ve `karar` blokları `govde`'de; sayfadaki her `data-karar` kutusunun bloğu var
- [ ] `okur`: worker `ekip`, lider sentezi ya da karar soran rapor `kullanıcı`
- [ ] Kareler gömülü (`data:`) ya da çift yazımlı (`data-kanit` önce); `kanit:` tek başına yok
- [ ] Sayfa kendi `<style>`'ını ve `--v-*` token'larını taşıyor; açık ve koyu tema var
- [ ] Patrona giden sayfada en az 3 görsel bileşen ve en az 3 renk tonu
- [ ] `kontrol.cjs` taslakta ve `rapor_yaz`'dan sonra son sayfada "TEMİZ"; kareleri açıp baktım
- [ ] Hiçbir yere yayın yok, harici tarayıcıda sekme yok (kontrol headless, sekme açmaz)
- [ ] Ek yolları rapor klasörüne göreli
- [ ] Patrona giden sayfada ilk ekran hüküm + "Senden beklenen"; G1–G5'ten en çok biri aşılıyor; teknik ayrıntı katlı
