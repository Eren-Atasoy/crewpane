'use strict';

const { contextBridge } = require('electron');

// ADP-837 (P7, 793 B13) — RENDERER'IN PLATFORMU. Kısayol varsayılanları ve
// tuş etiketleri (⌘ mi Ctrl mi) platforma bağlı; bugüne kadar renderer'da
// platformu SÖYLEYEN hiçbir kanal yoktu (ölçüldü: src/app altında tek bir
// `navigator.platform`/`isMac` kullanımı bile yok) → tüm etiketler macOS'a
// sabitlenmişti. Bu SENKRON bir global: kısayol biçimlendirmesi ilk boyamada
// gerekir, `app:info` gibi async bir IPC'yi bekleyemez.
// Salt-okunur bilgi; yetki DEĞİL. Sandboxed preload'da `process.platform` var
// (aynı `process.argv` gibi — yukarıdaki Supabase hedefi de oradan okunuyor).
const platformStr = String(process.platform || '');
contextBridge.exposeInMainWorld('crewpanePlatform', platformStr);


// PERF-BG-01 — TERMİNAL BOYAMA BÜTÇESİ (kontrol kolu).
//
// ÖLÇÜLDÜ (docs/agent-results/PERF-BG-01-evidence): akan HER pane, pty baytlarını
// `requestAnimationFrame` başına bir kez xterm'e yazıyordu — yani EKRANIN TAZELEME
// HIZINDA. Bu makinede (ProMotion, 120 Hz) pane başına +117 rAF/sn ve +5,5 puan
// renderer CPU'su demek; 4 akan pane'de renderer %13 → %35'e çıkıyor ve aynı
// oranda pencere-sunucusu (WindowServer) kompozisyonu doğuyor. Kullanıcı saniyede
// 120 kez tazelenen bir günlüğü zaten OKUYAMAZ: kap görsel bir kayıp değil.
//
// `crewpanePlatform` ile AYNI gerekçe zinciri (senkron global): kap ilk boyamada
// gerekir ve `NEXT_PUBLIC_*` build-time gömülüdür → env ile kapatılamazdı.
//   CREWPANE_TERM_FLUSH_HZ=0        → kap KAPALI (eski davranış: her karede yaz)
//   CREWPANE_TERM_FLUSH_HZ=<sayı>   → görünür pane için üst sınır (varsayılan 30)
//   CREWPANE_TERM_HIDDEN_FLUSH_HZ=<sayı> → GÖRÜNMEYEN pane için (varsayılan 4)
const perfNum = (name, fallback) => {
  const raw = String(process.env[name] ?? '').trim();
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};
//
// TERM-LOCK-01 — YAZMA KUYRUĞU KİLİDİ KURTARMASI (kontrol kolu, aynı köprü).
// xterm 6.0.0'ın `WriteBuffer._innerWrite`'ı istisna-güvenli değildir: ayrıştırıcı
// senkron atarsa kuyruk bir daha ZAMANLANMAZ ve pane kalıcı olarak ölür (ekran
// donar, yazılan görünmez, kapat-aç gerekir). Nöbetçi bunu görüp yerinde açar.
//   CREWPANE_TERM_WRITE_RECOVERY=0 → kurtarma KAPALI (eski, kilitlenen davranış)
const perfFlag = (name, fallback) => {
  const raw = String(process.env[name] ?? '').trim();
  if (!raw) return fallback;
  return raw !== '0' && raw.toLowerCase() !== 'false';
};
const perfSettings = {
  termFlushHz: perfNum('CREWPANE_TERM_FLUSH_HZ', 30),
  termHiddenFlushHz: perfNum('CREWPANE_TERM_HIDDEN_FLUSH_HZ', 4),
  termWriteRecovery: perfFlag('CREWPANE_TERM_WRITE_RECOVERY', true),
  termBlankRecovery: perfFlag('CREWPANE_TERM_BLANK_RECOVERY', true),
};
contextBridge.exposeInMainWorld('crewpanePerf', perfSettings);


// ADP-888 (ADP-885 Faz A) — RENDERER'IN ARAYÜZ DİLİ. Aynı gerekçe zinciri:
// `NEXT_PUBLIC_*` build-time gömülüdür (env ile dil verilemez) ve dil İLK
// BOYAMADA gerekir — `settings:get` gibi async bir IPC beklenirse kullanıcı önce
// yanlış dilde bir kare görür. Bu yüzden main dili additionalArguments ile geçirir
// ve burada SENKRON açığa çıkarılır. Salt-okunur bilgi; yetki/IPC kanalı DEĞİL.
//
// ⚠️ Sandboxed preload relative `require` ATAR → electron/i18n/index.cjs'in
// decodeArgv'si burada INLINE ikizdir (supabaseTarget ile birebir aynı desen).
// Biçim kasten en yalın: "--crewpane-locale=<etkin>:<tercih>".
const LOCALE_FLAG = '--crewpane-locale=';
function decodeLocale(argv) {
  const hit = (argv || []).find((a) => typeof a === 'string' && a.startsWith(LOCALE_FLAG));
  if (!hit) return null;
  const parts = hit.slice(LOCALE_FLAG.length).split(':');
  const locale = parts[0];
  const preference = parts[1];
  if (locale !== 'tr' && locale !== 'en') return null;
  return {
    locale,
    preference: preference === 'tr' || preference === 'en' || preference === 'system' ? preference : 'system',
  };
}
const localeState = decodeLocale(process.argv);
if (localeState) {
  contextBridge.exposeInMainWorld('crewpaneLocale', localeState);
}
