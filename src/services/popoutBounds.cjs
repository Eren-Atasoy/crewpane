// ADP-593 — pane POP-OUT pencerelerinin konum/boyut deposu.
//
// Bir terminal pane'i ayrı bir macOS penceresine çıkarıldığında (pop-out) o
// pencerenin nereye konduğu ve ne kadar büyütüldüğü hatırlanmalı: aynı ajanı
// ikinci kez dışarı çıkardığında pencere ekranın ortasına DEĞİL, bıraktığı yere
// gelir. Depo `delegationQueueStore.cjs` deseninin birebir uyarlaması:
// instance-scoped TEK dosya `~/.crewpane[-dev|-test]/popout-bounds.json`,
// Electron MAIN yazar, atomik tmp+rename, bozuk dosya ASLA fırlatmaz.
//
// Anahtar paneId DEĞİL: paneId her spawn'da değişir, kullanıcının aklındaki
// kimlik "Optimus'un penceresi"dir → agentId (yoksa etiket) anahtardır.
//
// Bu dosyada pencere yönetimi YOK (saf veri + saf karar) — BrowserWindow tarafı
// main.js'te; buradaki her şey birim-test edilebilir.

'use strict';

const fs = require('node:fs');
// ADP-835 (790 K1) — atomik yazımın rename adımı platform boğazından geçer:
// Windows'ta Defender/Search hedefi açık tutunca EPERM/EBUSY gelir ve bu çağrıların
// çoğu best-effort catch içinde OLDUĞU İÇİN kayıt SESSİZCE kaybolurdu.
const { renameWithRetrySync } = require('../../platform/atomicWrite.cjs');
const path = require('node:path');
const crypto = require('node:crypto');
const instancePaths = require('../config/instancePaths.cjs');

const STORE_VERSION = 1;
const FILE_NAME = 'popout-bounds.json';
/** Defter sınırsız büyümesin (her ajan bir satır; eski satırlar düşer). */
const MAX_ENTRIES = 64;

/** Pop-out penceresi varsayılan ölçüsü (ilk kez çıkarılan pane). */
const DEFAULT_SIZE = Object.freeze({ width: 820, height: 560 });
/** Pencere kullanılamaz derecede küçültülmesin. */
const MIN_SIZE = Object.freeze({ width: 360, height: 240 });

/** Per-instance dosya yolu: ~/.crewpane[-dev|-test]/popout-bounds.json. */
function boundsPath(homedir) {
  return path.join(instancePaths.crewpaneHome(homedir), FILE_NAME);
}

/**
 * Kalıcı anahtar: ajan pane'i → `agent:<id>`, ajansız (shell) pane → `label:<başlık>`.
 * paneId ASLA anahtar değildir (her oturumda değişir → hiç hatırlanmazdı).
 */
function boundsKey({ agentId, title } = {}) {
  const id = typeof agentId === 'string' ? agentId.trim() : '';
  if (id) return `agent:${id}`;
  const label = typeof title === 'string' ? title.trim() : '';
  return `label:${label || 'shell'}`;
}

/** Sayı mı + sonlu mu (NaN/Infinity/JSON'dan gelen string → hayır). */
function finiteNum(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * Kaydedilebilir bounds şekli. Geçersiz/eksik → null (çağıran varsayılana düşer;
 * yarım bir kayıt pencereyi ekran dışına atmasın diye ya HEPSİ ya HİÇBİRİ).
 */
function normalizeBounds(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const { x, y, width, height } = raw;
  if (![x, y, width, height].every(finiteNum)) return null;
  const w = Math.round(width);
  const h = Math.round(height);
  if (w < MIN_SIZE.width || h < MIN_SIZE.height) return null;
  return { x: Math.round(x), y: Math.round(y), width: w, height: h };
}

/** Şekil toleransı: her zaman düz {key: bounds} sözlüğü döndür. */
function normalizeStore(raw) {
  const src = raw && typeof raw === 'object' && raw.entries && typeof raw.entries === 'object'
    ? raw.entries
    : {};
  const out = {};
  for (const [key, value] of Object.entries(src)) {
    if (typeof key !== 'string' || !key) continue;
    const bounds = normalizeBounds(value);
    if (bounds) out[key] = bounds;
  }
  return out;
}

/** Defteri yükle. Yok / bozuk → boş defter (ASLA fırlatmaz). */
function loadBoundsStore(homedir) {
  try {
    return normalizeStore(JSON.parse(fs.readFileSync(boundsPath(homedir), 'utf8')));
  } catch {
    return {};
  }
}

/**
 * Tek satır güncelle + atomik yaz. Geçersiz bounds → yazma YOK (mevcut kayıt korunur).
 * Yazma hatası SESSİZ yutulur: pencere konumu hatırlanmaması bir konfor kaybıdır,
 * pop-out akışını (ve dolayısıyla koşan ajanı) asla bozmamalı.
 */
function rememberBounds(key, bounds, homedir) {
  const clean = normalizeBounds(bounds);
  if (!key || !clean) return null;
  const store = loadBoundsStore(homedir);
  // En son kullanılan sona gelsin (budama en eskiyi atsın).
  delete store[key];
  store[key] = clean;
  const keys = Object.keys(store);
  const entries = {};
  for (const k of keys.slice(Math.max(0, keys.length - MAX_ENTRIES))) entries[k] = store[k];
  const file = boundsPath(homedir);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${crypto.randomBytes(3).toString('hex')}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: STORE_VERSION, entries }, null, 2));
    renameWithRetrySync(tmp, file);
  } catch {
    return null; // best-effort (bkz. yukarıdaki not)
  }
  return file;
}

/**
 * Yeni pop-out penceresinin açılış bounds'u: hatırlanan kayıt varsa o, yoksa
 * varsayılan ölçü (konumsuz → Electron ortalar). `screenBounds` verilirse (ekran
 * çalışma alanı) hatırlanan pencere o alanın DIŞINDA kaldığında (monitör
 * söküldü) konum düşürülür — pencere görünmez bir koordinatta açılmasın.
 */
function openBounds(store, key, screenBounds) {
  const saved = store && typeof store === 'object' ? normalizeBounds(store[key]) : null;
  if (!saved) return { ...DEFAULT_SIZE };
  const width = Math.max(MIN_SIZE.width, saved.width);
  const height = Math.max(MIN_SIZE.height, saved.height);
  if (screenBounds && [screenBounds.x, screenBounds.y, screenBounds.width, screenBounds.height].every(finiteNum)) {
    // Pencerenin en az bir köşesi çalışma alanına düşmüyorsa konumu at.
    const visible =
      saved.x + width > screenBounds.x &&
      saved.x < screenBounds.x + screenBounds.width &&
      saved.y + height > screenBounds.y &&
      saved.y < screenBounds.y + screenBounds.height;
    if (!visible) return { width, height };
  }
  return { x: saved.x, y: saved.y, width, height };
}

module.exports = {
  DEFAULT_SIZE,
  MIN_SIZE,
  MAX_ENTRIES,
  boundsPath,
  boundsKey,
  normalizeBounds,
  normalizeStore,
  loadBoundsStore,
  rememberBounds,
  openBounds,
};
