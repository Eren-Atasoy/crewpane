// MCP-COST-01 — "BAGLI KALSIN AMA PANE'LERDE OTOMATIK ACILMASIN" isareti.
//
// ARIZA: bagli her entegrasyonun MCP'si HER pane'de doguyor — worker o servise hic
// dokunmasa bile. Olculdu (09.09, 14 pane): 4 entegrasyon = 97 surec / 3.187 MB.
// Bugun kullanicinin tek kapatma yolu BAGLANTIYI KESMEKTIR (anahtari silmek) —
// yani "bu pane'de Vercel'e ihtiyacim yok" demenin bedeli, Vercel'i tumden
// kaybetmektir. Bu dosya o ikilemi kaldirir.
//
// KAPSAM SINIRI (kartin acik kurali): burasi "otomatik ACILMASIN" der,
// "baglanti SILINSIN" DEMEZ. Kasa kaydina, `integ:list`e, `integ:test`e,
// dogrulama damgasina HIC DOKUNMAZ:
//   • Ayarlar servisi BAGLI gostermeye devam eder (rozet degismez),
//   • "Baglantiyi dene" HALA calisir (isaret kapali olsa bile),
//   • isaret geri acilinca ertesi pane acilisinda MCP yine doger — kayip yok.
//
// VARSAYILAN ACIK: dosya yoksa / okunamazsa / servis yazili degilse cevap `true`
// olur, yani bugunku davranis bit-bit korunur. Bu bir performans anahtaridir;
// sessizce bir seyi KAPATMASI, sessizce ACIK BIRAKMASINDAN daha kotudur.
//
// ─────────────────────────────────────────────────────────────────────────────
// MCP-LAZY-01 (KATMAN 1 — PROFIL KAPISI). Isaret artik UC KAPSAMDA yasiyor:
//
//   roles.<agentId>.<servis>     ← en dar: "prowl pane'inde vercel yok"
//   projects.<proje>.<servis>    ← orta:   "crewpane projesinde coolify yok"
//   services.<servis>            ← genel:  bugunku (v1) isaret, AYNEN korunur
//
// Cozum sirasi DARDAN GENISE: rol → proje → genel → VARSAYILAN ACIK. Bir kapsamda
// `true` yazmak ust kapsamin `false`unu EZER (istisna yazilabilsin diye: "vercel her
// yerde kapali AMA blaster'da acik"). Yazilmamis olmak (undefined) ust kapsaga
// DEVREDER — "acik" ile "yazilmamis" ayri sey, yoksa istisna kurulamazdi.
//
// NEDEN ROL/PROJE: 100 entegrasyonlu bir kurulumda her pane'e hepsini vermek
// olculdu — arac SEMALARI ertelense bile arac ADLARI her istekte tasiniyor
// (MCP-LAZY-01 olcumu: ~16 jeton/arac; 4 servis = 3.194 jeton/pane). Bir pane'in
// gormeyecegi servisi HIC YAZMAMAK, o maliyeti sifira indiren tek yoldur.
//
// GERIYE UYUM: v1 dosyasi (duz `{servis: bool}`) AYNEN okunur → `services` sayilir.
// `read()` hala DUZ genel haritayi dondurur (Ayarlar ekrani ve testler ona bakiyor);
// tam yapiyi isteyen `readProfile()` cagirir.
//
// Calistir: node --test electron/integrationAutostart.test.cjs

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const FILE_NAME = 'integration-autostart.json';

/** Servis adi dar tutulur: dosya JSON anahtari, disaridan gelen ad serbest olamaz. */
const SERVICE_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

function filePath(accountHome) {
  return path.join(String(accountHome || ''), FILE_NAME);
}

/** MCP-LAZY-01 — kapsam anahtari (rol adi / proje slug'i) da dar tutulur. */
const SCOPE_RE = /^[A-Za-z0-9][A-Za-z0-9._ -]{0,63}$/;

/** Yalniz `{servis: boolean}` ciftlerini gecir; gerisi SESSIZCE dusier. */
function boolMap(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [k, v] of Object.entries(raw)) {
    if (SERVICE_RE.test(k) && typeof v === 'boolean') out[k] = v;
  }
  return out;
}

/** `{<kapsam>: {servis: bool}}` blogu (roles/projects). */
function scopeBlock(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [k, v] of Object.entries(raw)) {
    if (!SCOPE_RE.test(k)) continue;
    const map = boolMap(v);
    if (Object.keys(map).length) out[k] = map;
  }
  return out;
}

/**
 * MCP-LAZY-01 — TAM tercih yapisi (v2). Okunamayan/bozuk dosya = BOS yapi
 * (= her sey acik). v1 duz haritasi `services` olarak okunur (geriye uyum).
 * @returns {{services:Object<string,boolean>, roles:Object, projects:Object}}
 */
function readProfile(accountHome, deps = {}) {
  const io = deps.fs || fs;
  let raw;
  try {
    raw = JSON.parse(io.readFileSync(filePath(accountHome), 'utf8'));
  } catch {
    return { services: {}, roles: {}, projects: {} };
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { services: {}, roles: {}, projects: {} };
  // v1: duz `{servis: bool}` — `services`/`roles`/`projects` anahtarlari YOKSA.
  const looksV2 = ('services' in raw) || ('roles' in raw) || ('projects' in raw) || ('version' in raw);
  if (!looksV2) return { services: boolMap(raw), roles: {}, projects: {} };
  return {
    services: boolMap(raw.services),
    roles: scopeBlock(raw.roles),
    projects: scopeBlock(raw.projects),
  };
}

/**
 * Ham GENEL tercih haritasi (v1 sozlesmesi — Ayarlar ekrani ve testler buna bakar).
 * Okunamayan/bozuk dosya = BOS HARITA (= her sey acik).
 * @returns {Object<string, boolean>}
 */
function read(accountHome, deps = {}) {
  return readProfile(accountHome, deps).services;
}

/**
 * MCP-LAZY-01 — bir pane'in kapsam kunyesi. `agentId` ROL, `projectId||department`
 * PROJEDIR (`withCodeIndex` ile AYNI okuma sirasi: `projectId` bugun renderer'in
 * hicbir spawn cagrisinda yok, urunun tasidigi kimlik DEPARTMANDIR — tek kaynak
 * olsun diye ayni sira burada da tekrarlanir).
 */
function scopeOf(opts) {
  const o = opts || {};
  const pick = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  return {
    role: pick(o.agentId) || pick(o.leaderId),
    project: pick(o.projectId) || pick(o.department),
  };
}

/**
 * KAPSAM COZUMU — dardan genise: rol → proje → genel → varsayilan ACIK.
 * @returns {{enabled:boolean, source:'role'|'project'|'global'|'default'}}
 */
function resolve(accountHome, service, scope = {}, deps = {}) {
  const prof = deps.profile || readProfile(accountHome, deps);
  const name = String(service || '');
  const role = scope && typeof scope.role === 'string' ? scope.role : null;
  const project = scope && typeof scope.project === 'string' ? scope.project : null;
  const fromRole = role && prof.roles[role] ? prof.roles[role][name] : undefined;
  if (typeof fromRole === 'boolean') return { enabled: fromRole, source: 'role' };
  const fromProject = project && prof.projects[project] ? prof.projects[project][name] : undefined;
  if (typeof fromProject === 'boolean') return { enabled: fromProject, source: 'project' };
  const fromGlobal = prof.services[name];
  if (typeof fromGlobal === 'boolean') return { enabled: fromGlobal, source: 'global' };
  return { enabled: true, source: 'default' };
}

/**
 * Bu servis pane acilisinda OTOMATIK baslatilsin mi?
 * Yazili degilse `true` (varsayilan acik — bugunku davranis).
 * `deps.scope` verilirse rol/proje kapisi da uygulanir (MCP-LAZY-01 katman 1).
 */
function isEnabled(accountHome, service, deps = {}) {
  if (deps.scope) return resolve(accountHome, service, deps.scope, deps).enabled;
  const map = deps.map || read(accountHome, deps);
  const v = map[String(service || '')];
  return v === undefined ? true : v === true;
}

/**
 * MCP-LAZY-01 — yapiyi diske yaz. BOS bloklar yazilmaz (dosyada tek temsil).
 * v1 bicimi KORUNUR: yalniz genel isaretler varsa duz harita yazilir → eski
 * surumler (ve `read`in v1 dali) ayni dosyayi okumaya devam eder.
 */
function writeProfile(accountHome, profile, deps = {}) {
  const io = deps.fs || fs;
  const services = boolMap(profile && profile.services);
  const roles = scopeBlock(profile && profile.roles);
  const projects = scopeBlock(profile && profile.projects);
  const scoped = Object.keys(roles).length || Object.keys(projects).length;
  const body = scoped
    ? { version: 2, services, roles, projects }
    : services;
  try {
    io.mkdirSync(accountHome, { recursive: true });
    io.writeFileSync(filePath(accountHome), `${JSON.stringify(body, null, 2)}\n`, 'utf8');
    return true;
  } catch {
    return false;
  }
}

/**
 * Isareti yaz (GENEL kapsam). `enabled:true` kaydi SILER (dosyayi varsayilana
 * dondurur) — "acik" durumunun diskte iki temsili olmaz.
 * @returns {boolean} yazim basarili mi
 */
function setEnabled(accountHome, service, enabled, deps = {}) {
  if (!SERVICE_RE.test(String(service || ''))) return false;
  const prof = readProfile(accountHome, deps);
  if (enabled === false) prof.services[service] = false;
  else delete prof.services[service];
  return writeProfile(accountHome, prof, deps);
}

/**
 * MCP-LAZY-01 — ROL/PROJE kapsaminda isaret. UC DEGER:
 *   `false` → bu kapsamda KAPALI · `true` → bu kapsamda ACIK (ust kapsami ezer)
 *   `null`  → kaydi SIL (ust kapsaga DEVRET)
 * "acik" ile "yazilmamis"i ayirmak sart: yoksa "her yerde kapali ama burada acik"
 * kurulamaz, kullanici da genel kapatmayi hic kullanamazdi.
 * @param {'role'|'project'} kind
 */
function setScoped(accountHome, kind, id, service, value, deps = {}) {
  const bucket = kind === 'role' ? 'roles' : kind === 'project' ? 'projects' : null;
  if (!bucket) return false;
  if (!SCOPE_RE.test(String(id || '')) || !SERVICE_RE.test(String(service || ''))) return false;
  const prof = readProfile(accountHome, deps);
  const map = prof[bucket][id] || {};
  if (value === true || value === false) map[service] = value;
  else delete map[service];
  if (Object.keys(map).length) prof[bucket][id] = map;
  else delete prof[bucket][id];
  return writeProfile(accountHome, prof, deps);
}

/**
 * Cozulmus entegrasyon listesini SUZ — spawn yolunun tek dokundugu yer.
 * Girdi `integrationResolver.resolve()` ciktisidir ({service, secret, entry, ...}).
 * Suzulen kayit ne env'e ne MCP config'ine girer; kasada AYNEN durur.
 *
 * MCP-LAZY-01 — `deps.scope` ({role, project}) verilirse KAPSAM kapisi uygulanir.
 * `skipped` geriye uyum icin servis ADLARI dizisidir; hangi kapsamin kestigi
 * `reasons` haritasindan okunur (log/Ayarlar satiri "neden yok"u soyleyebilsin).
 * @returns {{kept:Array, skipped:string[], reasons:Object<string,string>}}
 */
function filterResolved(list, accountHome, deps = {}) {
  const items = Array.isArray(list) ? list.filter(Boolean) : [];
  const profile = deps.profile || readProfile(accountHome, deps);
  const scope = deps.scope || null;
  const kept = [];
  const skipped = [];
  const reasons = {};
  for (const item of items) {
    const r = resolve(accountHome, item.service, scope || {}, { ...deps, profile });
    if (r.enabled) kept.push(item);
    else {
      skipped.push(item.service);
      reasons[item.service] = r.source; // 'role' | 'project' | 'global'
    }
  }
  return { kept, skipped, reasons };
}

module.exports = {
  FILE_NAME,
  filePath,
  read,
  readProfile,
  writeProfile,
  scopeOf,
  resolve,
  isEnabled,
  setEnabled,
  setScoped,
  filterResolved,
};
