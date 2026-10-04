// CFG-01 — "BU KURULUM HANGİ BACKEND'İ KULLANIR?" SORUSUNUN TEK BOĞAZI.
//
// ÖLÇÜLEN MÜŞTERİ ARIZASI (Instagram DM, 2026-08-10 — ödeyen kullanıcı)
// ---------------------------------------------------------------------
// Satın almış bir kullanıcı görev oluşturamadı; ajan şu satırı bastı:
//     "Task board unavailable — Supabase is not configured
//      (NEXT_PUBLIC_CREWPANE_SUPABASE_*)"
// Kullanıcı bunu bir KURULUM EKSİĞİ sandı ve oturup kendi Supabase'ini
// yapılandırmaya çalıştı. Oysa paketlenmiş üründe gömülü bir backend ZATEN var
// (backendTarget.PROD_CLOUD) — kullanıcıdan altyapı istemek ürün hatasıydı.
//
// KÖK NEDEN (iki kat, ikisi de ÖLÇÜLDÜ — bkz. docs/agent-results/CFG-01-ratchet.md)
// ---------------------------------------------------------------------------
// 1) `crewpane-task-mcp.cjs` yapılandırmayı YALNIZ `process.env` ve bir
//    `.env.local` dosyasından arıyordu. Müşteri kopyasında ikisi de YOKTUR
//    (paketli app launchd'nin asgari env'iyle açılır, `.env.local` gitignore'lu
//    bir geliştirici dosyasıdır) → `resolveSupabase()` null → yukarıdaki mesaj.
//    KURULU 0.2.31 build'inde temiz env ile birebir yeniden üretildi.
// 2) MCP bir ELECTRON SÜRECİ DEĞİL: main.js'in çözümlemesini miras almaz.
//    `main.js` env'i pane'e enjekte ediyordu (ADP-201) ama:
//      • codex pane'lerinde MCP çocuğu pane env'ini MİRAS ALMAZ (ADP-227) —
//        her anahtar server'ın `env` haritasına AYRI yazılır, ve o harita
//        `buildSpawn` içinde (main.js:1200) ADP-201 enjeksiyonundan (main.js:1252)
//        ÖNCE dondurulur ⇒ `NEXT_PUBLIC_*` codex task MCP'sine HİÇ ulaşmaz.
//        Ölçüldü: üretilen argv'de `NEXT_PUBLIC` geçen 0 (SIFIR) anahtar var.
//      • pane dışından koşan her çağrı (kabuk, hook, script) da aynı boşluğa düşer.
//    Bu, delegate MCP'de yaşadığımız SINIFIN ta kendisi: "ayrı süreç, mirassız
//    çözümleme". Sınıfı kapatmanın yolu env'i daha çok yerden enjekte etmek
//    DEĞİL, çözümlemeyi sürecin KENDİSİNE koymaktır.
//
// BU MODÜLÜN SÖZLEŞMESİ
// ---------------------
// `main.js` ile MCP çocuğu AYNI kararı, AYNI kodla verir:
//     process.env → <repoRoot>/.env.local → ~/.crewpane/crewpane-public-env.json
//     ("live" çifti)  ... ve BUNUN ÜSTÜNDE ...  backendTarget.resolveBackendTarget()
//     (kanal kararı: prod → gömülü PROD_CLOUD · dev → baked/yerel · test → e2e)
// İkinci bir çözümleme YAZILMAZ: `live` yalnızca boğazın GİRDİSİDİR, kararı
// backendTarget verir. Müşteri kopyasında üç kademe de boş kalsa bile karar
// gömülü sabittir ⇒ board yapılandırma İSTEMEZ, ÇALIŞIR.
//
// Saf-ish: tüm I/O (fs, home, env) enjekte edilebilir → birim testi hermetik.
// Çalıştır: node --test electron/publicBackendEnv.test.cjs

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const backendTarget = require('./backendTarget.cjs');
const instancePaths = require('./instancePaths.cjs');

/** Renderer'ın da okuduğu PUBLIC anahtar adları (anon key sır DEĞİLDİR — RLS korur). */
const URL_KEY = 'NEXT_PUBLIC_CREWPANE_SUPABASE_URL';
const ANON_KEY = 'NEXT_PUBLIC_CREWPANE_SUPABASE_ANON_KEY';
const SCHEMA_KEY = 'NEXT_PUBLIC_CREWPANE_SUPABASE_SCHEMA';

/** Kurulum script'lerinin yazdığı MAKİNE dosyası (ADP-703). */
const MACHINE_ENV_FILE = 'crewpane-public-env.json';

/** dotenv gövdesi → { KEY: value }. Yorum satırı atlanır, tırnak soyulur. */
function parseEnvFile(text) {
  const out = {};
  for (const raw of String(text == null ? '' : text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    if (!key) continue;
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

function nonEmpty(v) {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

/**
 * `.env.local` adayları. `repoRoot` ÖNCE (main.js'in bugünkü tek kaynağı), sonra
 * cwd (task MCP'nin bugünkü ikinci kaynağı) — birleşim, iki çağıranın da bugünkü
 * davranışının ÜST KÜMESİ olsun diye. Paketli app'te ikisi de yoktur (zaten olay bu).
 */
function envFileCandidates(deps) {
  const repoRoot = deps.repoRoot || path.join(__dirname, '..');
  const cwd = deps.cwd === undefined ? safeCwd() : deps.cwd;
  const list = [path.join(repoRoot, '.env.local')];
  if (cwd) list.push(path.join(cwd, '.env.local'));
  return list;
}

function safeCwd() {
  try {
    return process.cwd();
  } catch {
    return null; // silinmiş cwd (paketli app'te olabilir) — çökme sebebi olmasın
  }
}

/**
 * ÜÇ KADEMELİ "live" çifti: process.env → .env.local → makine JSON'u.
 * Bu bir KARAR DEĞİL, `resolveBackendTarget`in girdisidir (kanal kararını o verir).
 *
 * @param {{env?: object, fs?: object, repoRoot?: string, cwd?: string|null,
 *          instanceHome?: string|null}} [deps]
 * @returns {{url: string|null, anonKey: string|null, schema: string|null, sources: string[]}}
 */
function readLivePair(deps = {}) {
  const env = deps.env || process.env;
  const fsMod = deps.fs || fs;
  const sources = [];
  let url = nonEmpty(env[URL_KEY]);
  let anonKey = nonEmpty(env[ANON_KEY]);
  let schema = nonEmpty(env[SCHEMA_KEY]);
  if (url && anonKey) sources.push('process-env');

  if (!url || !anonKey) {
    for (const p of envFileCandidates(deps)) {
      let parsed;
      try {
        parsed = parseEnvFile(fsMod.readFileSync(p, 'utf8'));
      } catch {
        continue; // yok / okunamıyor → sıradaki aday
      }
      if (!url) url = nonEmpty(parsed[URL_KEY]);
      if (!anonKey) anonKey = nonEmpty(parsed[ANON_KEY]);
      if (!schema) schema = nonEmpty(parsed[SCHEMA_KEY]);
      if (url && anonKey) {
        sources.push('env-file');
        break;
      }
    }
  }

  if (!url || !anonKey) {
    const home = deps.instanceHome === undefined ? safeInstanceHome() : deps.instanceHome;
    if (home) {
      try {
        const j = JSON.parse(fsMod.readFileSync(path.join(home, MACHINE_ENV_FILE), 'utf8'));
        if (!url) url = nonEmpty(j[URL_KEY]);
        if (!anonKey) anonKey = nonEmpty(j[ANON_KEY]);
        if (!schema) schema = nonEmpty(j[SCHEMA_KEY]);
        if (url && anonKey) sources.push('machine-file');
      } catch {
        /* yok / bozuk → live çifti eksik kalır; karar yine backendTarget'ın */
      }
    }
  }

  return { url, anonKey, schema, sources };
}

function safeInstanceHome() {
  try {
    return instancePaths.instanceHome();
  } catch {
    return null;
  }
}

/**
 * NİHAİ backend hedefi — main.js ve her ayrı-süreç aracı BUNU çağırır.
 *
 * @param {object} [deps] readLivePair deps + { instanceId?: string }
 * @returns {{url: string|null, anonKey: string|null, schema: string,
 *           target: object, live: object, configured: boolean}}
 */
function resolvePublicBackend(deps = {}) {
  const env = deps.env || process.env;
  const live = readLivePair(deps);
  const instanceId = deps.instanceId === undefined ? safeInstanceId() : deps.instanceId;
  const target = backendTarget.resolveBackendTarget(env, instanceId, {
    url: live.url,
    anonKey: live.anonKey,
  });
  // SCHEMA — `live` çifti SEÇİLDİĞİNDE onun şeması KORUNUR.
  // Neden: main.js pane env'ine hedefi ZATEN KARARLAŞTIRILMIŞ şemasıyla enjekte eder
  // (NEXT_PUBLIC_…_SCHEMA = target.schema). Çocuk süreç aynı çifti `live` olarak geri
  // okuduğunda şemayı URL'den YENİDEN TAHMİN ederse (bulut⇒'app', loopback⇒'public')
  // main'in kararından SAPABİLİR — ör. loopback OLMAYAN bir dev stack'inde tablolar
  // 'public'te ise istemci 'app'i sorgular ve HER istek 404 döner. Şema hedefin
  // parçasıdır, URL'den türetilen bir tahmin değildir (ADP-621/780-B aynı ders).
  // Yalnız `source === 'live'` iken geçerli: kanal kararı başka bir hedef seçtiyse
  // (cloud-default / dev-baked / e2e) o hedefin KENDİ şeması bağlayıcıdır.
  const schema = target.source === 'live' && live.schema ? live.schema : target.schema;
  return {
    url: target.url || null,
    anonKey: target.anonKey || null,
    schema,
    target,
    live,
    configured: !!(target.url && target.anonKey),
  };
}

function safeInstanceId() {
  try {
    return instancePaths.instanceId();
  } catch {
    return 'prod'; // instancePaths okunamıyorsa MÜŞTERİ varsayımı: gömülü bulut
  }
}

/**
 * Yapılandırma çözülemediğinde kullanıcı yüzeyine çıkacak TEŞHİS KODU.
 * İç değişken adı (NEXT_PUBLIC_*) taşımaz; destek ekibinin okuyabileceği kadar
 * bilgi taşır: hangi kanal, hangi kaynak, müşteri build'i mi.
 * Örn: `BOARD-CFG/prod/none/customer`
 */
function diagnosticCode(resolved) {
  const t = (resolved && resolved.target) || {};
  const parts = [
    'BOARD-CFG',
    t.instance || 'unknown',
    t.source || 'none',
    t.customerBuild ? 'customer' : 'dev',
  ];
  return parts.join('/');
}

module.exports = {
  URL_KEY,
  ANON_KEY,
  SCHEMA_KEY,
  MACHINE_ENV_FILE,
  parseEnvFile,
  readLivePair,
  resolvePublicBackend,
  diagnosticCode,
};
