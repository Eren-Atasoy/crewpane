'use strict';
// MOB-UX-M1 (M1-b) — "Telefonunu bağla" sihirbazının ÖLÇÜM ucu.
//
// NEDEN AYRI BİR UÇ (MOB-UX-R1 §6.1): `mobile:status` yalnız gateway ÇALIŞIRKEN
// bilgi verir; sihirbazın 2. adımı gateway KAPALIYKEN "Tailscale bağlı mı?" diye
// sormak zorunda. `resolveBindHost()` bugün yalnız `start()` içinde, tek sefer
// çağrılıyor — buradan gateway'i ayağa kaldırmadan da ölçülür.
//
// KAPATILAN KUSUR (MOB-UX-R1 §2.2/K5): "Tailscale KURULU DEĞİL" ile "kurulu ama
// BAĞLI değil" ayırt edilemiyordu; ikisi de aynı cümleye düşüyor ve kullanıcıya
// Tailscale'i hiç kurmamışken "açıp kapat-aç" deniyordu. Üç hâl artık ayrı:
//   'connected'         → tailnet adresi var (tek gerçek kanıt)
//   'installed-offline' → kurulu görünüyor ama adres yok  → "menü çubuğundan Connect"
//   'missing'           → kurulum izi YOK                 → "önce kur" + brew satırı
//   'unknown'           → kurulum KONTROL EDİLEMEDİ (macOS dışı, sideload…)
// `unknown` şart: yoksa yakalayamadığımız bir kuruluma "kurulu değil" YALANI söyleriz
// (MOB-UX-R1 §10/2). Sihirbaz `unknown`'ı "kurulu değil" gibi göstermez.
//
// GÜVENLİK SINIRI (MOB-UX-R1 §10/1) — `tailscale status --json` bir KABUK ÇAĞRISIDIR:
//   • SABİT MUTLAK yollar (PATH'ten ikili aranmaz, kullanıcı girdisi yol olamaz)
//   • `execFile` (shell YOK, argüman enjeksiyonu yüzeyi YOK)
//   • zaman aşımı + çıktı tavanı
//   • çıktı PARSE edilir, LOG'a BASILMAZ (tailnet cihaz adları kişisel veridir)
//   • başarısızlık SESSİZ DEĞİL ama KİLİTLEYİCİ de değil: `{ available:false }`
// Bu yüzden zenginleştirme (dnsName + telefon peer'leri) kararı ASLA vermez;
// kararı yalnız `resolveBindHost()` verir.

const fs = require('node:fs');
const os = require('node:os');
const { execFile } = require('node:child_process');
const { resolveBindHost } = require('./mobileDeviceStore.cjs');

/** Tailscale CLI'ın SABİT aday yolları (platforma göre). PATH taranmaz. */
const CLI_CANDIDATES = Object.freeze({
  darwin: [
    '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
    '/opt/homebrew/bin/tailscale',
    '/usr/local/bin/tailscale',
  ],
  linux: ['/usr/bin/tailscale', '/usr/local/bin/tailscale', '/snap/bin/tailscale'],
  win32: ['C:\\Program Files\\Tailscale\\tailscale.exe', 'C:\\Program Files (x86)\\Tailscale\\tailscale.exe'],
});

/** macOS'ta CLI olmadan da kurulumu gösteren iz (App Store sürümünde CLI gömülüdür). */
const APP_MARKERS = Object.freeze({
  darwin: ['/Applications/Tailscale.app'],
  linux: ['/usr/sbin/tailscaled', '/usr/bin/tailscaled'],
  win32: ['C:\\Program Files\\Tailscale\\tailscaled.exe'],
});

const PROBE_TIMEOUT_MS = 1500;
const PROBE_MAX_BYTES = 512 * 1024; // tailnet listesi büyüse de bellek sabit kalsın

function firstExisting(paths, exists) {
  for (const p of paths || []) {
    try {
      if (exists(p)) return p;
    } catch {
      /* erişilemeyen yol = yok say */
    }
  }
  return null;
}

/**
 * Tailscale CLI'ı bul. Bulunamazsa null (çağıran bunu "kurulu değil" SANMAZ —
 * karar `probeTailnet` içinde APP_MARKERS ile birlikte verilir).
 */
function findCli({ platform = process.platform, exists = fs.existsSync } = {}) {
  return firstExisting(CLI_CANDIDATES[platform], exists);
}

/**
 * ÜÇ HÂL. Tek KARAR kaynağı `resolveBindHost()` (100.64/10 adresi var mı) —
 * kabuk çağrısı burada YOKTUR, yani ölçüm her zaman anlık ve ucuzdur.
 * @returns {{state:'connected'|'installed-offline'|'missing'|'unknown', address?:string, bindKind?:string, reason?:string}}
 */
function probeTailnet({
  env = process.env,
  interfaces = os.networkInterfaces(),
  platform = process.platform,
  exists = fs.existsSync,
} = {}) {
  const bind = resolveBindHost({ env, interfaces });
  if (bind.kind === 'tailnet') {
    return { state: 'connected', address: bind.host, bindKind: bind.kind };
  }
  // `env` ile elle bind edilmişse (CREWPANE_MOBILE_BIND) tailnet adresi olmayabilir
  // ama gateway yine erişilebilir olur; bunu "bağlı" SAYMAYIZ (adres tailnet değil),
  // yalnız sebebi taşırız — sihirbaz kullanıcıyı yanlış yönlendirmesin.
  const installed = !!findCli({ platform, exists }) || !!firstExisting(APP_MARKERS[platform], exists);
  if (installed) return { state: 'installed-offline', bindKind: bind.kind, reason: bind.reason ?? null };
  // Kurulum izini SADECE tanıdığımız platformlarda "yok" diye okuyabiliriz.
  const known = Object.prototype.hasOwnProperty.call(CLI_CANDIDATES, platform);
  return { state: known ? 'missing' : 'unknown', bindKind: bind.kind, reason: bind.reason ?? null };
}

/** `tailscale status --json` çıktısını GÜVENLİ çalıştır (shell yok, timeout var). */
function runStatusJson({ cli, execFileImpl = execFile, timeout = PROBE_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    if (!cli) {
      resolve(null);
      return;
    }
    execFileImpl(
      cli,
      ['status', '--json'],
      { timeout, maxBuffer: PROBE_MAX_BYTES, windowsHide: true },
      (err, stdout) => {
        if (err) {
          resolve(null); // hata GÖVDESİ taşınmaz: kişisel veri + gürültü (R1 §10/1)
          return;
        }
        try {
          resolve(JSON.parse(String(stdout || '')));
        } catch {
          resolve(null);
        }
      },
    );
  });
}

/** `Peer` kaydından telefon mu diye bak: OS alanı Tailscale'de 'iOS'/'android'. */
function phoneFromPeer(peer) {
  const osName = String(peer?.OS || '').toLowerCase();
  if (osName !== 'ios' && osName !== 'android') return null;
  const dns = String(peer?.DNSName || '');
  const name = String(peer?.HostName || dns.split('.')[0] || '').slice(0, 60);
  return { name: name || osName, os: osName, online: !!peer?.Online };
}

/**
 * İSTEĞE BAĞLI ZENGİNLEŞTİRME: ağdaki telefonlar + bu Mac'in tailnet DNS adı.
 * CLI yoksa / çalışmazsa `{ available:false }` → sihirbaz ipucu adımını
 * "kontrol edilemedi" moduna alır. ASLA kilit üretmez (MOB-UX-R1 §5.2).
 * @returns {Promise<{available:boolean, dnsName?:string|null, phones?:Array<{name:string,os:string,online:boolean}>}>}
 */
async function probePeers({ platform = process.platform, exists = fs.existsSync, execFileImpl = execFile } = {}) {
  const cli = findCli({ platform, exists });
  if (!cli) return { available: false };
  const data = await runStatusJson({ cli, execFileImpl });
  if (!data || typeof data !== 'object') return { available: false };
  const phones = [];
  for (const peer of Object.values(data.Peer || {})) {
    const phone = phoneFromPeer(peer);
    if (phone) phones.push(phone);
  }
  const dnsName = String(data?.Self?.DNSName || '').replace(/\.$/, '') || null;
  return { available: true, dnsName, phones };
}

module.exports = {
  probeTailnet,
  probePeers,
  findCli,
  phoneFromPeer,
  CLI_CANDIDATES,
  APP_MARKERS,
  PROBE_TIMEOUT_MS,
};
