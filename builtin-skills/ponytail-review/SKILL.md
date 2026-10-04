---
name: ponytail-review
description: Yalnizca asiri muhendislik avlayan inceleme — neyin SILINEBILECEGINI bulur. Yeniden yazilmis stdlib, gereksiz bagimlilik, tek uygulamasi olan soyutlama, kimsenin kullanmadigi esneklik. Bulgu basina tek satir (yer, ne kesilecek, yerine ne gelecek) ve sonunda net kazanc. Kullanici "asiri muhendislik mi", "neyi silebiliriz", "sadelestirme incelemesi", "bloat bul", "depoyu tara" derse ya da ponytail-review istenirse kullan. Dogruluk hatasi, guvenlik acigi ve performans bu incelemenin KAPSAMI DISIDIR — onlar normal incelemeye gider.
license: MIT
metadata:
  crewpane.origin: builtin
  crewpane.category: software-development
  crewpane.author: Dietrich Gebert (DietrichGebert/ponytail) — CrewPane uyarlamasi ironhide
  crewpane.copyright: Copyright (c) 2026 DietrichGebert (MIT) · Copyright (c) 2026 CrewPane (TR uyarlamasi, dokunulmaz kapilar listesi, depo-geneli bolumu)
  crewpane.upstream: https://github.com/DietrichGebert/ponytail @ e3ba2aa6f1e6f0bc4d69eb09c9f0d0a93af56156 (v4.10.0, MIT)
  crewpane.upstreamSha256: 40df33b58fc6ef889b93585733feb9566b76e9586efa7f376785c1e995197ac0
  crewpane.upstreamLicenseSha256: fb1bc6909ac3ef82d5c22106e32ef682b0cff66788fa915fb9b53b15c9d2f3ab
  crewpane.merged: ponytail-audit (upstream ayri skill, satirlarinin %38i birebir ayniydi — burada "Depo geneli" bolumu)
  crewpane.modified: yes
  crewpane.status: published
  crewpane.reviewedBy: ironhide
  crewpane.reviewedAt: 2026-09-15
  crewpane.sourceCatalog: ponytail-review@0.5.0
---

# Ponytail Review — yalnız fazlalık avı

Diff'i gereksiz karmaşıklık için incele. Bulgu başına tek satır: yer, ne kesilecek,
yerine ne gelecek. Diff'in en iyi sonucu **kısalmasıdır**.

## Biçim

`L<satır>: <etiket> <ne>. <yerine>.` — çok dosyalı diff'te `<dosya>:L<satır>: ...`

Etiketler:

- `delete:` ölü kod, kullanılmayan esneklik, varsayıma dayalı özellik. Yerine: hiçbir şey.
- `stdlib:` standart kütüphanenin zaten verdiği, elle yazılmış şey. Fonksiyonun adını ver.
- `native:` platformun zaten yaptığını yapan bağımlılık ya da kod. Özelliğin adını ver.
- `yagni:` tek uygulaması olan soyutlama, kimsenin ayarlamadığı config, tek çağıranı olan katman.
- `shrink:` aynı mantık, daha az satır. Kısa hâlini göster.

## Örnekler

❌ "Bu EmailValidator sınıfı gerekenden karmaşık olabilir, bu doğrulama kurallarının
hepsine bu aşamada ihtiyaç var mı diye düşündünüz mü?"

✅ `L12-38: stdlib: 27 satırlık validator sınıfı. e-postada "@" var mı, 1 satır; gerçek doğrulama onay postası.`

✅ `L4: native: tek format çağrısı için moment.js. Intl.DateTimeFormat, 0 bağımlılık.`

✅ `repo.py:L88: yagni: tek uygulaması olan AbstractRepository. İkincisi çıkana kadar içeri al.`

✅ `L52-71: delete: idempotent yerel çağrı etrafında retry sarmalayıcı. Yerine hiçbir şey.`

✅ `L30-44: shrink: elle döngüyle dict kuruluyor. dict(zip(keys, values)), 1 satır.`

## Puan

Tek önemli ölçüyle bitir: `net: -<N> satır mümkün.`
Kesilecek bir şey yoksa `Zaten yalın. Sevk et.` de ve dur.

## Depo geneli (üst kaynakta ayrı skill: `ponytail-audit`)

"Depoyu tara", "neyi silebiliriz", "bloat bul" denirse aynı etiketlerle **diff yerine
bütün ağacı** tara. Bulguları **en büyük kesim önce** sırala.

Av listesi: stdlib ya da platformun zaten verdiği bağımlılıklar, tek uygulaması olan
arayüzler, tek ürünü olan fabrikalar, yalnız devreden sarmalayıcılar, tek şey ihraç eden
dosyalar, ölü bayraklar ve config, elle yazılmış stdlib.

Çıktı: sıralı, bulgu başına tek satır → `<etiket> <ne kesilecek>. <yerine>. [yol]`
Sonunda: `net: -<N> satır, -<M> bağımlılık mümkün.`

⚠️ **Depo-geneli tarama pahalıdır.** Bu evin depoları büyük; ağacın tamamını okumak yerine
önce kapsamı daralt (bir dizin, bir modül, bir kulvar) ve neyi taradığını rapora yaz.
`node_modules`, `.git`, `.next`, `dist`, `dist-dev`, `out` ve `electron/dist*` **dışarıda**.

## DOKUNULMAZLAR — bunları bulgu olarak yazma

Bu yüzeyler tek-uygulamalı soyutlamaya benzer ama işleri odur; "yagni" diye önermek
sadeleştirme değil, koruma sökmektir:

- **Kapılar ve kontrol kolları.** `lint:catalog`, `gate:skills`, `guard:escapes:packaged`,
  sürüm/drift kapıları, öz-testler (`--self-test`), mutant koşuları. Bir kapının tek çağıranı
  olması normaldir. Kapı kaldırma **ayrı bir karardır**, inceleme bulgusu değil.
- **Güven sınırındaki doğrulama, yetki kontrolü, kaçış/escape mantığı, hata yolları.**
- **Tek kalan çalıştırılabilir kontrol** (smoke test, `assert` tabanlı öz-kontrol).
  Ponytail'in asgarisidir, bloat değil.
- **Kanıt üreten kod** (log, ölçüm çıktısı, rapor satırı) istenmiş açıklamadır.
- **Başkasının scope'undaki dosyalar.** Paylaşılan ağaçta kardeş pane'in yarım işi
  "ölü kod" gibi görünür. Kendi kartının dokunduğu yüzeyi incele; dışına çıkıyorsan
  bulguyu **öneri** diye işaretle, silme talimatı gibi yazma.

## Sınır

Kapsam: yalnız aşırı mühendislik ve karmaşıklık. Doğruluk hataları, güvenlik açıkları ve
performans **açıkça kapsam dışıdır** — onları normal inceleme turuna yönlendir
(`requesting-code-review`, `/code-review`), bu tura değil.
Düzeltmeleri **uygulamaz**, yalnız listeler. Tek atımlık.
"ponytail-review dur" / "normal mod": ayrıntılı inceleme biçemine dön.
