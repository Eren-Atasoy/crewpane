// SYNC-F1-7 (Prowl) — TAŞINABİLİR TERCİH BEYAZ LİSTESİ: neyin ikinci cihaza
//                     gidebileceğinin TEK kaynağı.
//                     Tasarım: SYNC-F1-TASARIM.md §5.5.4 · §5.5.6
//                     Kapsam kararı: docs/design/SYNC-KAPSAM-KARARLARI.md (KİLİTLİ)
//
// ═══════════════════════════════════════════════════════════════════════════════
// NEDEN ANAHTAR YOLU, NEDEN DOSYA DEĞİL
// ═══════════════════════════════════════════════════════════════════════════════
// Kapsam kararı üç sınıf tanımlar (taşınabilir ✅ / cihaza özgü ⛔ / sır ⛔) ve bu
// üçü AYNI DOSYADA yan yana yaşar: `settings.json` içinde `theme.mode` (✅) ile
// `apiKeys.openai` (⛔) kardeştir; `crewpane-editor-state-v1` içinde
// `ui.explorerCollapsed` (✅) ile `recent` (mutlak yollar, ⛔) kardeştir. Dosya
// bazlı bir liste bu anahtarları ya tamamen kaybederdi ya da sırrı sızdırırdı.
// Bu yüzden liste ANAHTAR YOLU kabul eder ve varsayılanı REDDETtir: listede
// olmayan bir anahtar için projeksiyona giden yol YOKTUR (§5.5.3/1).
//
// ─────────────────────────────────────────────────────────────────────────────
// LİSTE BÜYÜRKEN NE OLMAZ
// ─────────────────────────────────────────────────────────────────────────────
// Joker (`jarvis.*`) YOKTUR. `jarvis` altında bugün 19 anahtar var, biri
// (`whisperModelPath`) YEREL YOL. Joker yazsaydık yarın oraya eklenecek bir
// `jarvis.apiToken` projeksiyona KENDİLİĞİNDEN girerdi. Her anahtar tek tek
// yazılır; listeyi büyütmek bilinçli bir eylemdir.
//
// SAF MODÜL — fs YOK, Electron YOK, durum YOK.

'use strict';

/**
 * KAYNAK TÜRLERİ
 *   'settings' — `~/.crewpane/<hesap>/settings.json` içinde NOKTALI yol (`path`)
 *   'renderer' — renderer `localStorage` anahtarı (`storageKey`), istenirse
 *                JSON gövdesinin İÇİNDEKİ noktalı alt yol (`subPath`, §5.5.6)
 */

/** `settings.json` kaynaklı taşınabilir anahtarlar (ölçüldü: gerçek dosya envanteri). */
const SETTINGS_KEYS = Object.freeze([
  // — görünüm —
  'theme.mode', 'theme.preset', 'theme.accent',
  'terminalFontScale',
  // — dil —
  'locale', 'voiceLocale',
  // — davranış anahtarları —
  'keepExitedPanes',
  // HATA-07 §5'in kapatamadığı madde: anahtar bugün settings.json'da yaşıyor ve
  // TAŞINABİLİR sınıfına ait (bir yol/sır değil, bir tercih).
  'autoModelByTaskClass',
  // LDR-F1 kapalı listesi ('off'|'warn'|'auto') — davranış toggle'ı.
  'leaderAutoRefresh',
  'updateAutoCheck', 'updateChannel',
  'telemetryEnabled', // kullanıcının RIZASI — kişiye ait, makineye değil
  'memorySearch.autoIndex', 'memorySearch.semanticEnabled', 'memorySearch.semanticConsent',
  // — kısayollar —
  'pushToTalkKey', 'paneZoomShortcut', 'paneMoveShortcut',
  // — bildirim —
  'notifications.toast.workerDone', 'notifications.toast.delegationDone',
  'notifications.toast.approval', 'notifications.toast.error', 'notifications.toast.limit',
  // — "bunu gördüm" olguları (kişiye ait; ikinci cihazda turu tekrar izletme) —
  'productTourDone', 'announcementsRead', 'foreignHookNoticeDismissed', 'telemetryNoticeShown',
  // TOUR-02-GUIDE-PERSIST — KARAR: Rehber bayrağı da TAŞINIR. Gerekçe: bu grubun
  // kendi şartı "ikinci cihazda turu tekrar izletme"dir ve Rehber, kullanıcı için
  // `productTourDone` ile aynı olgudur ("bunu gördüm"). Bir yol/sır/makine ayarı
  // değil, kişiye ait bir tercih → taşınabilir sınıfa girer. Taşımasaydık aynı
  // kullanıcı ikinci cihazda Rehber'i baştan izlerdi — kartın düzelttiği zararın
  // ta kendisi, sadece bir cihaz ötede.
  'onboardingGuideDone',
  // — ses/kişilik (jarvis) — `whisperModelPath` KASTEN YOK (yerel model yolu) —
  'jarvis.ttsEngine', 'jarvis.ttsVoice', 'jarvis.ttsModel', 'jarvis.sttEngine',
  'jarvis.voiceMode', 'jarvis.view',
  'jarvis.elevenModel', 'jarvis.elevenVoiceId', 'jarvis.elevenVoiceName',
  'jarvis.azureVoice', 'jarvis.azureRegion',
  'jarvis.grokModel', 'jarvis.grokVoice',
  'jarvis.silenceMs', 'jarvis.noSpeechMs', 'jarvis.endpointMaxMs', 'jarvis.sleepAfterMs',
  'jarvis.silenceGate.rmsThreshold', 'jarvis.silenceGate.minSpeechMs',
  'jarvis.silenceGate.loudFloor', 'jarvis.silenceGate.minDynamicDb',
  'jarvis.silenceGate.draftMinDynamicDb',
]);

/**
 * Renderer (`localStorage`) kaynaklı taşınabilir anahtarlar.
 * `key` = projeksiyondaki AD (kararlı), `storageKey` = diskteki gerçek anahtar.
 */
const RENDERER_KEYS = Object.freeze([
  // DÜZEN taşınır, İÇERİK taşınmaz (§5.5.5): dock ağırlık tabanlıdır, piksel değil.
  Object.freeze({ key: 'layout.dock', storageKey: 'crewpane-workspace-dock-v2' }),
  Object.freeze({ key: 'layout.terminalGrid', storageKey: 'crewpane-terminal-grid-v1' }),
  Object.freeze({ key: 'layout.activeTeam', storageKey: 'crewpane-workspace-active-team-v1' }),
  Object.freeze({ key: 'layout.singleMapGrid', storageKey: 'crewpane:single-map-grid' }),
  Object.freeze({ key: 'layout.unifiedRender', storageKey: 'crewpane:unified-render' }),
  Object.freeze({ key: 'layout.singleMapScrollSwitch', storageKey: 'crewpane:single-map-scroll-switch' }),
  // sekme tercihleri
  Object.freeze({ key: 'taskboard.tabState', storageKey: 'crewpane:taskboard:tabstate:v1' }),
  Object.freeze({ key: 'taskboard.seenSprints', storageKey: 'crewpane:taskboard:seensprints:v1' }),
  // jarvis widget kipi
  Object.freeze({ key: 'jarvis.widgetView', storageKey: 'jarvis-widget-view' }),
  Object.freeze({ key: 'jarvis.mode', storageKey: 'crewpane-jarvis-mode' }),
  // davranış toggle'ları
  Object.freeze({ key: 'voice.autoSend', storageKey: 'crewpane.voicePrompt.autoSend' }),
  Object.freeze({ key: 'voice.holdToTalk', storageKey: 'crewpane.voicePrompt.holdToTalk' }),
  Object.freeze({ key: 'notifications.v1', storageKey: 'crewpane.notifications.v1' }),
  // §5.5.6'nın ÖRNEĞİ: aynı dosyada `recent`/`session` MUTLAK YOL taşır (⛔),
  // yalnız `ui.explorerCollapsed` taşınır.
  Object.freeze({ key: 'editor.ui.explorerCollapsed', storageKey: 'crewpane-editor-state-v1', subPath: 'ui.explorerCollapsed' }),
]);

/**
 * BAŞKA MODÜLLERİN SAHİPLENDİĞİ taşınabilir anahtarlar.
 *
 * `onboarding.progress`/`onboarding.tips` projeksiyona TOUR-02-A/C tarafından
 * `onboardingStore.cjs` üzerinden yazılır. Projektör onları ÜRETMEZ ama SİLMEZ
 * de: liste burada olduğu için "bilinmeyen anahtar" süzgecine takılmazlar.
 */
const EXTERNAL_KEYS = Object.freeze(['onboarding.progress', 'onboarding.tips']);

/**
 * ⛔ CİHAZA ÖZGÜ — bu liste bir SÜZGEÇ DEĞİL, testin NÖBETİdir (syncClasses'ın
 * `SECRET_BEARING_ENTRIES` deseni). Süzgeç olsaydı "listeye eklemeyi unuttuk"
 * sınıfı hatayı geri davet ederdik; beyaz liste zaten hepsini dışarıda tutuyor.
 */
const DEVICE_LOCAL_ENTRIES = Object.freeze([
  'workspaceRoot', 'knownWorkspaces', 'departmentDirs', 'projectRepos', 'projectIsolation',
  'jarvis.whisperModelPath', 'wakeModelPath',
  'telemetryState', 'updateDismissedVersion',
  'cloudSyncEnabled', // senkronu bir cihazdan HERKESE açmak kullanıcının kararı değil
  'teamScope', 'resourceGovernor', 'handControl',
  'crewpane-editor-state-v1.recent', 'crewpane-editor-state-v1.session',
  'crewpane-pane-bindings-v1', 'crewpane-browser-session-v1',
  'crewpane_presence_client_id', 'jarvis-widget-pos', 'crewpane.replyFlow.heightPx',
  'crewpane-office-custom-assets-v1', // ÖLÇÜLMEDİ → varsayılan reddet
]);

/** ⛔ SIR — aynı şekilde nöbet listesi (beyaz liste zaten almıyor). */
const SECRET_ENTRIES = Object.freeze([
  'apiKeys', 'mcpServers', 'browserTrust', 'browserTrust.trustedOrigins', 'browserTrust.blockedOrigins',
]);

/**
 * ÇIKTI KAPISI (§5.5.3/2) — beyaz liste ZATEN engelliyor; bu ikinci kilit KOD
 * HATASINA karşıdır.
 *
 * ⚠️ Tasarım metni `/key|token|secret|password|credential/i` diyor. ÇIPLAK `key`
 * KULLANILAMAZ: beyaz listede ÖLÇÜLMÜŞ bir yanlış-pozitif var — `pushToTalkKey`
 * ("bas-konuş tuşu", kapsam kararının ✅ listesinde ADIYLA geçiyor). Kapı bu
 * yüzden `key`i yalnız SIR BİLEŞİMLERİNDE arar (`apiKey`, `api_key`, `secretKey`,
 * `privateKey`, `accessKey`). Gevşetme değil DARALTMA: `pushToTalkKey` geçerken
 * `openaiApiKey` geçemez.
 */
const SECRET_NAME_RE = /(api[-_]?key|access[-_]?key|secret|private[-_]?key|password|passwd|credential|token|bearer|_?jwt\b)/i;

function isSecretishName(keyPath) {
  return SECRET_NAME_RE.test(String(keyPath || ''));
}

const SETTINGS_SET = new Set(SETTINGS_KEYS);
const RENDERER_BY_KEY = new Map(RENDERER_KEYS.map((e) => [e.key, e]));
const EXTERNAL_SET = new Set(EXTERNAL_KEYS);

/** Projeksiyonda MEŞRU olan tüm anahtar adları (bilinmeyen → düşürülür). */
function allKeys() {
  return [...SETTINGS_KEYS, ...RENDERER_KEYS.map((e) => e.key), ...EXTERNAL_KEYS];
}

/** Bu anahtar taşınabilir mi? (VARSAYILAN: hayır) */
function isPortable(keyPath) {
  return SETTINGS_SET.has(keyPath) || RENDERER_BY_KEY.has(keyPath) || EXTERNAL_SET.has(keyPath);
}

/** Bu anahtarın kaynağı — 'settings' | 'renderer' | 'external' | null */
function sourceOf(keyPath) {
  if (SETTINGS_SET.has(keyPath)) return 'settings';
  if (RENDERER_BY_KEY.has(keyPath)) return 'renderer';
  if (EXTERNAL_SET.has(keyPath)) return 'external';
  return null;
}

function rendererEntry(keyPath) {
  return RENDERER_BY_KEY.get(keyPath) || null;
}

/** Noktalı yolla iç içe nesneden oku; yol yoksa `undefined`. */
function getPath(obj, dotted) {
  let cur = obj;
  for (const seg of String(dotted).split('.')) {
    if (!cur || typeof cur !== 'object' || Array.isArray(cur)) return undefined;
    if (!Object.prototype.hasOwnProperty.call(cur, seg)) return undefined;
    cur = cur[seg];
  }
  return cur;
}

/**
 * Noktalı yola yaz (ara nesneleri üretir). `__proto__`/`constructor`/`prototype`
 * segmentleri REDDEDİLİR — gelen doküman uzak bir cihazdan gelir ve prototip
 * kirletmesi bir senkron yükünün en ucuz saldırısıdır.
 */
const FORBIDDEN_SEGMENTS = new Set(['__proto__', 'constructor', 'prototype']);

function setPath(obj, dotted, value) {
  const segs = String(dotted).split('.');
  if (segs.some((s) => !s || FORBIDDEN_SEGMENTS.has(s))) return false;
  let cur = obj;
  for (let i = 0; i < segs.length - 1; i += 1) {
    const s = segs[i];
    if (!cur[s] || typeof cur[s] !== 'object' || Array.isArray(cur[s])) cur[s] = {};
    cur = cur[s];
  }
  cur[segs[segs.length - 1]] = value;
  return true;
}

/** Değer JSON-güvenli ve MAKUL boyutta mı? (fonksiyon/derin/dev nesne geçmez) */
const MAX_VALUE_BYTES = 64 * 1024;
const MAX_DEPTH = 8;

function isPlainValue(v, depth = 0) {
  if (v === null) return true;
  const t = typeof v;
  if (t === 'string' || t === 'boolean') return true;
  if (t === 'number') return Number.isFinite(v);
  if (depth >= MAX_DEPTH) return false;
  if (Array.isArray(v)) return v.every((x) => isPlainValue(x, depth + 1));
  if (t === 'object') {
    const proto = Object.getPrototypeOf(v);
    if (proto !== Object.prototype && proto !== null) return false;
    return Object.keys(v).every((k) => !FORBIDDEN_SEGMENTS.has(k) && isPlainValue(v[k], depth + 1));
  }
  return false;
}

/**
 * Bir `{key, value}` çifti projeksiyona GİREBİLİR mi?
 * @returns {{ok:true}|{ok:false, reason:string}}
 */
function admit(keyPath, value) {
  if (!isPortable(keyPath)) return { ok: false, reason: 'not-whitelisted' };
  if (isSecretishName(keyPath)) return { ok: false, reason: 'secretish-name' };
  if (value === undefined) return { ok: false, reason: 'undefined' };
  if (!isPlainValue(value)) return { ok: false, reason: 'unsupported-value' };
  let bytes = 0;
  try { bytes = Buffer.byteLength(JSON.stringify(value), 'utf8'); } catch { return { ok: false, reason: 'unserializable' }; }
  if (bytes > MAX_VALUE_BYTES) return { ok: false, reason: 'too-large' };
  return { ok: true };
}

module.exports = {
  SETTINGS_KEYS,
  RENDERER_KEYS,
  EXTERNAL_KEYS,
  DEVICE_LOCAL_ENTRIES,
  SECRET_ENTRIES,
  SECRET_NAME_RE,
  MAX_VALUE_BYTES,
  allKeys,
  isPortable,
  isSecretishName,
  sourceOf,
  rendererEntry,
  getPath,
  setPath,
  isPlainValue,
  admit,
};
