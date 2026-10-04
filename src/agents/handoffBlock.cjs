'use strict';

// LDR-F1 — DEVİR BLOĞUNUN SINIR METİNLERİ (tek kaynak, saf leaf).
//
// Bu iki dize bir UI etiketi değil, bir SÖZLEŞMEDİR: tazelenmiş bir oturumun ilk
// mesajında görünür ve "bu bağlam nereden geldi" sorusunun tek cevabıdır. İki
// tüketicisi var ve ikisi FARKLI dünyada koşuyor:
//   • renderer  → src/app/lib/dispatchGate.ts (dağıtım yolları; worker prompt'u)
//   • main      → electron/main.js leaderRefreshTick (lider oturumunun geri yüklemesi)
// Metin iki yerde ayrı yazılsaydı e2e "başlık göründü mü" kanıtı bir yüzeyde yeşil,
// diğerinde sessizce kırmızı olurdu. Bu yüzden CJS leaf: main `require` eder,
// dispatchGate uzantılı import ile alır (node --test TS-strip'i çözer).
//
// 🔴 METİN DEĞİŞTİRİLİRSE: e2e kanıt aramaları (`[ÖNCEKİ OTURUMDAN DEVİR ÖZETİ`)
// ve dispatchGate testleri birlikte güncellenmelidir — başlık ARANAN bir imzadır.

/** Devir bloğunun BAŞI — pane'de GÖRÜNÜR sınır (sessiz ek yok). */
const HANDOFF_HEADER = "[ÖNCEKİ OTURUMDAN DEVİR ÖZETİ — bu pane'in bağlamı tazelendi]";
/** Devir bloğunun SONU — bundan sonrası asıl iştir. */
const HANDOFF_FOOTER = '[DEVİR SONU — asıl iş aşağıda]';

module.exports = { HANDOFF_HEADER, HANDOFF_FOOTER };
