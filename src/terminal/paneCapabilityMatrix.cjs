// ENG-10 (SPRINT-ENGINE-03, Faz C) — YETENEK MATRİSİ: descriptor'ın MÜHENDİS dili →
// kullanıcının OFİSTE gördüğü dil.
//
// NEDEN AYRI BİR KATMAN: `engineRegistry` bir motorun 18 TEKNİK yeteneğini beyan eder
// (`hooks`, `extraRoots`, `mcp.envInheritance`…). Kullanıcı bunları sormaz; şunu sorar:
// "bu ajana iş versem NE YAPAMAZ?". ENG-R3 §12'nin SINIR tablosu bu çeviriyi zaten
// yapmıştı ama yalnız bir dokümandaydı — "her satır bir `unsupported` değeri ve bir UI
// rozeti üretir" cümlesinin ÜRÜN karşılığı bu dosyadır.
//
// ⚠️ MOTOR ADI DALI YOK. Her satır descriptor'ın KENDİ alanından türer; yeni bir motor
// eklendiğinde burada değişecek bir şey yoktur (kayıtsız motor → her şey `missing`,
// ENG-R3 §14-R1: tanımadığımız motor sessizce yetenekli sayılmaz).
//
// ⚠️ İKİNCİ DEFTER DEĞİL. Gerekçe metinleri UYDURULMAZ: descriptor'ın
// `unsupported[key]` / `partial[key]` beyanından gelir (`unsupportedCapabilities()`
// çıktısı). Bu dosyanın kattığı tek şey EŞLEME (hangi teknik alan hangi kullanıcı
// yeteneğini taşır) ve kullanıcı-dili anahtarı (`labelKey`, i18n'de TR+EN).
//
// ÇIKTI (pane kaydına yazılır, `pty:list` ile renderer'a gider):
//   { briefing:{state,…}, subagentBlock:{…}, resume:{…}, usageMeasured:{…},
//     board:{…}, browser:{…}, integrations:{…}, memoryWrite:{…} }
// `state`: 'full' | 'partial' | 'missing'.
// `planned` (ENG-HONEST-CARD-01): bu satırı TAM'a çekecek board kart kodu | null —
//   yalnız TAM OLMAYAN satırda dolu olabilir; kaynağı `enginePlanned.cjs` haritası.

'use strict';

const engineRegistry = require('../agents/engineRegistry.cjs');
// ENG-HONEST-CARD-01 — "yolda" etiketinin tek kaynağı (board kart kodu haritası).
const enginePlanned = require('../agents/enginePlanned.cjs');

/**
 * Kullanıcı-yüzü yetenekler ve TAŞIYICI descriptor alanları.
 *
 * `key`      — descriptor yetenek alanı (gerekçenin geldiği yer)
 * `labelKey` — i18n anahtarı (renderer sözlüğü; TR+EN)
 * `refine`   — alanın DOLU olduğu hâlde bile kaybın olabildiği durumlar (ör. jeton
 *              ölçümü VAR ama 'approx'). Dönerse o hüküm kazanır.
 */
const USER_CAPABILITIES = Object.freeze([
  // §12 satır 1 — "Tur-başı brifing (hook)".
  Object.freeze({ id: 'briefing', key: 'hooks' }),
  // §12 satır 2 — "Sert alt-ajan bloğu".
  Object.freeze({ id: 'subagentBlock', key: 'subagentBlock' }),
  // §12 satır 3 — "Oturum id mint + resume".
  Object.freeze({ id: 'resume', key: 'session' }),
  // §12 satır 5 — "Jeton ölçümü".
  Object.freeze({ id: 'usageMeasured', key: 'usage', refine: refineUsage }),
  // §12 satır 6 — "MCP izolasyonu": board + browser araçları MCP kanalından gider.
  Object.freeze({ id: 'board', key: 'mcp', refine: refinePerPaneTools }),
  Object.freeze({ id: 'browser', key: 'mcp', refine: refinePerPaneTools }),
  // Entegrasyon anahtarı MCP'den DE fazlasını ister: çocuk süreç pane env'ini miras
  // almalı (yoksa sır argv'ye yazılırdı → `ps` çıktısında düz-metin PAT).
  Object.freeze({ id: 'integrations', key: 'mcp', refine: refineIntegrations }),
  // Hafıza/ek kök dizinleri motorun erişim köküne eklenebiliyor mu (`--add-dir`).
  Object.freeze({ id: 'memoryWrite', key: 'extraRoots' }),
]);

/** Matris alanlarının kanonik sırası (rozet dizilişi kararlı kalsın). */
const CAPABILITY_IDS = Object.freeze(USER_CAPABILITIES.map((c) => c.id));

/**
 * Rozet "bilgi" değil UYARI basmalı mı — descriptor'ın güvenlik sınıfını yansıtır.
 *
 * 🔴 CODEX-INT-01 — `integrations` BU LİSTEDEN ÇIKARILDI. Ölçüt "bu satırın sebebi
 * güvenlik mi" DEĞİL, "bu pane'de bir GÜVENLİK KATMANI EKSİK Mİ" olmalı; kırmızı
 * satırın altındaki cümle zaten bunu söylüyor ("kolaylık değil, bir güvenlik katmanı
 * eksik"). İki satır bu ölçütte taban tabana zıt:
 *   • `subagentBlock` yoksa katman GERÇEKTEN kayıptır — ajan denetimsiz alt-ajan
 *     doğurabilir (ADR-004'ün sert katmanı).
 *   • `integrations` yoksa katman KAYIP DEĞİL, TAM ÇALIŞMIŞTIR: anahtarı sızdırmayı
 *     reddettiğimiz için özellik kapalı. Pane güvenli olduğu için bu hâlde.
 * Kırmızı boyamak bu yüzden YANLIŞ BİLGİYDİ ve bedeli ölçülebilir: codex'te
 * `integrations` TEK güvenlik satırıydı (kanıt: `buildMatrix('codex')`), dolayısıyla
 * tamamı codex olan bir ekipte HER pane başlığı kalıcı KIRMIZI ⚠ ile açılıyordu —
 * müşteri şikâyeti tam olarak buydu (Discord "Codex Hatası", 8 pane × kırmızı).
 * Satır KAYBOLMUYOR: hâlâ `missing`, hâlâ listede, yalnız rengi hükmüne uyuyor
 * (BADGE-CLARITY-01'in "salt-bilgi sayaç hata işaretiyle çizilmez" kuralının
 * bir katman derini).
 */
const SECURITY_IDS = Object.freeze(['subagentBlock']);

/**
 * ENG-07 tek kuralın TEK EVİ: bu MCP kanalı SIR taşıyabilir mi? (`agentRunner`
 * `integrationsInjectable` bunu çağırır — iki kopya olsaydı rozet ile davranış
 * ayrışırdı ve tam da bu görevin yasakladığı "sessizce daha az yetenek" olurdu.)
 * @param {object|null} mcp - descriptor'ın `mcp` alanı
 */
function mcpCanCarrySecrets(mcp) {
  return !!(mcp && mcp.kind === 'config-file' && mcp.envInheritance === true);
}

/** `usage` DOLU olsa bile ölçüm KESİN olmayabilir (ENG-09 `level`). */
function refineUsage(value) {
  const level = value && typeof value.level === 'string' ? value.level : null;
  if (level === 'exact') return null; // tam yetenek — hüküm yok
  if (level === 'none' || !level) {
    return { state: 'missing', reason: 'motor jeton defteri beyan etmiyor → kullanım "bilinmiyor" (tahmin YOK)' };
  }
  return {
    state: 'partial',
    reason: `jeton eşlemesi ${value.kind === 'time-window' ? 'cwd + pane açılış zamanı sezgisiyle' : 'motorun kendi raporundan'} yapılır → seviye '${level}' (yaklaşık)`,
  };
}

/**
 * ENG-13 — `mcp` DOLU olsa bile araç PANE BAŞINA verilemeyebilir.
 *
 * Board/browser araçları pane'e AÇILIŞTA enjekte edilir; bunun için motorun
 * PER-LAUNCH bir kayıt yolu olmak zorunda: config dosyası bayrağı (claude/copilot),
 * oturum profili dosyası (codex, `-p <ad>` → `$CODEX_HOME/<ad>.config.toml`) ya da
 * komut dizesi (goose). Yalnız KALICI DOSYAYA yazan
 * motorda (`kind:'config-only'` — droid: `$FACTORY_HOME/.factory/mcp.json`) böyle bir
 * yol YOKTUR: server'ı kullanıcı düzeyine yazmak onu o motorun BÜTÜN oturumlarına
 * sızdırırdı (delegate server'ı yalnız LİDER yeteneğidir) → o pane araçlara ancak
 * ENG-06 köprüsüyle (crewpaneCli) erişir.
 *
 * Bu inceltme olmasaydı rozet "kısmi" derdi; oysa gerçek "bu pane'de HİÇ YOK".
 */
function refinePerPaneTools(value) {
  if (!value) return null; // alan zaten null → genel yol 'missing' der
  // CODEX-ARGV-01 — `config-profile` de PER-LAUNCH'tır: profil dosyası oturum başına
  // yazılır ve YALNIZ `-p <ad>` verilen koşuda okunur (kullanıcının kendi config'i
  // değişmez). Listeye eklenmeseydi codex'in board/browser yeteneği "bu pane'de HİÇ YOK"
  // diye raporlanırdı — motora iftira: araçlar çalışıyor, yalnız taşıyıcı değişti.
  // AGY-01 — 'workspace-plugin' de PER-LAUNCH'tır: demet pane BAŞINA üretilir ve
  // YALNIZ o pane'e `--add-dir <kök>` ile verilir (kullanıcının `~/.gemini/config/`
  // dosyaları DEĞİŞMEZ — sha256 kanıtı). Listeye eklenmeseydi antigravity'nin
  // board/browser yeteneği "bu pane'de HİÇ YOK" diye raporlanırdı — motora iftira.
  // ENG-OPENCODE-MCP-01 — 'env-config' (opencode) de PER-LAUNCH'tır: sunucular pane
  // env'indeki config BELGESİNE birleştirilir (`agentRunner.mcpRegisterArgs` env-config
  // dalı; RESEARCH-OC-01 §2.1 gerçek ikiliyle 3/3 connected + araç çağrısı). ENG-16'da
  // burada duran "zincir henüz yazılmadı → missing" dalı zincir yazılınca SİLİNDİ —
  // hüküm elle 'full' yazılmaz, dalın yokluğundan türer (kontrol kolu:
  // engineLeadership.test "dal geri konunca `never`").
  const perLaunch =
    value.kind === 'config-file' ||
    value.kind === 'config-profile' ||
    value.kind === 'cli-overrides' ||
    value.kind === 'cli-command' ||
    value.kind === 'workspace-plugin' ||
    value.kind === 'env-config';
  if (perLaunch) return null;
  // ENG-17 — 'env-config-dir' (kimi/crush): AYNI dürüstlük ayrımı. Yol VAR ve TAM
  // ölçüldü — pane başına ayrılan config DİZİNİNDEKİ belgeden gerçek bir MCP sunucusu
  // başlatıldı ve `tools/call`a kadar konuşuldu; sunucu pane env'ini de miras aldı.
  // Ama ürünün delegate/board/browser sunucularını o belgeye YAZAN zincir bu görevde
  // kurulmadı. "Araç var" demek kullanıcıya yalan, "motorda yol yok" demek motora
  // iftira olurdu → hüküm 'missing', gerekçe DOĞRU.
  if (value.kind === 'env-config-dir') {
    return {
      state: 'missing',
      reason:
        'motorun per-launch araç kaydı VAR ve ÖLÇÜLDÜ (pane başına config dizinindeki belgeden sunucu başlatıldı, initialize→tools/list→tools/call) ama ürünün delegate/board/browser sunucuları bu belgeye HENÜZ beslenmiyor → bugün bu pane araçsız açılır (ENG-17 takip kalemi)',
    };
  }
  return {
    state: 'missing',
    reason:
      'motorda PER-LAUNCH MCP kaydı yok (yalnız kalıcı config dosyası) → araç bu pane\'e açılışta enjekte EDİLEMEZ; kullanıcı düzeyine yazmak server\'ı o motorun bütün oturumlarına sızdırırdı. Araç erişimi ENG-06 köprüsünden (crewpaneCli) gider',
  };
}

/** `mcp` DOLU olsa bile entegrasyon anahtarı enjekte EDİLEMEyebilir. */
function refineIntegrations(value) {
  if (mcpCanCarrySecrets(value)) return null;
  if (!value) return null; // alan zaten null → genel yol 'missing' der
  // CODEX-INT-01 — 'config-profile' (codex): ENG-16/ENG-17 ile AYNI dürüstlük ayrımı,
  // bir adım daha ileri. Burada MOTORUN yolu var DEĞİL, ÖLÇÜLDÜ (codex-cli 0.147.0,
  // gerçek ikili, izole CODEX_HOME): per-launch profil dosyasının
  // `[mcp_servers.<ad>.env]` tablosu çocuğa BİREBİR teslim edilir ve
  // initialize→tools/list→tools/call turu tamamlanır. Yani "motor taşıyamıyor" demek
  // artık MOTORA İFTİRA olurdu; engel TAŞIYICI DEĞİL, TAŞINAN ŞEYİN NEREDE DURACAĞI:
  // codex `${VAR}` genişletmesi yapmaz (ölçüldü — değer harfiyen geçer) ve MCP çocuğu
  // pane env'ini miras almaz (ölçüldü — 11 anahtarlık temizlenmiş env), dolayısıyla
  // anahtar profil dosyasına DÜZ METİN yazılmak zorunda kalırdı. Bu, kasanın kurucu
  // kuralını çiğner (credentialVault.cjs: "düz-metin fallback ASLA") ve claude yolunun
  // bilerek seçtiği `${VAR}` REFERANSININ tersidir. Karar: taşıyıcı hazır, POLİTİKA
  // izin vermiyor → bugün 'missing'. Gerekçe bunu OLDUĞU GİBİ söyler; "motor yapamıyor"
  // demek ölçüme aykırı olurdu.
  if (value.kind === 'config-profile') {
    return {
      state: 'missing',
      reason:
        'motorun per-launch sır taşıyıcısı VAR ve ÖLÇÜLDÜ (profil dosyasının env tablosu MCP çocuğuna birebir gidiyor, tools/call turu tamam) — ama codex `${VAR}` referansını genişletmez ve MCP çocuğu pane env\'ini miras almaz, yani anahtarın kasadan çıkıp profil dosyasına DÜZ METİN yazılması gerekirdi; ürün kuralı bunu yasaklıyor (kasada düz-metin fallback YOK) → entegrasyon bu pane\'e kurulmaz (CODEX-INT-01 kararı)',
    };
  }
  // AGY-02 — 'workspace-plugin' (antigravity): ENG-16/ENG-17/CODEX-INT-01 ile AYNI
  // dürüstlük ayrımı. Buradaki engel TAŞIYICI DEĞİL: MCP çocuğu pane env'ini MİRAS
  // ALIYOR (ölçüldü, AGY-02-evidence/01) — yani sır claude'daki gibi ENV ile gidebilir,
  // argv'ye de diske de yazılmadan. Eksik olan ürünün KENDİ zinciri: `withIntegrationsMcp`
  // hazır bir config DOSYASI yolu üretiyor (http transport, lazy-proxy çoğullayıcı,
  // servis-başına `env` bloğu), bu taşıyıcı ise sunucu LİSTESİ bekliyor ve o belgeyi
  // ifade edemiyor → demete beslenen bir entegrasyon sunucusu YOK.
  // "Motor taşıyamıyor" demek ÖLÇÜME AYKIRI, "araç var" demek KULLANICIYA YALAN olurdu:
  // hüküm 'missing', gerekçe olanı olduğu gibi söyler.
  if (value.kind === 'workspace-plugin') {
    return {
      state: 'missing',
      reason:
        'motorun sır taşıyıcısı VAR ve ÖLÇÜLDÜ (MCP çocuğu pane env\'ini miras alıyor → anahtar claude\'daki gibi ENV ile gider, argv\'ye ya da diske yazılmadan) — ama ürünün entegrasyon sunucuları bu pane demetine HENÜZ beslenmiyor (entegrasyon yolu hazır bir config BELGESİ üretir; bu taşıyıcı sunucu LİSTESİ bekler) → bugün bu pane\'de entegrasyon aracı YOK (AGY-02 takip kalemi)',
    };
  }
  return {
    state: 'missing',
    reason:
      'MCP çocuğu pane ortamını miras ALMAZ → anahtar argv\'ye yazılmak zorunda kalırdı (`ps` çıktısında düz-metin sır) — entegrasyon bu pane\'de HİÇ kurulmaz',
  };
}

/**
 * Bir motorun kullanıcı-yüzü yetenek matrisi.
 *
 * @param {string|null} engineId - pane'in motoru (null/kabuk → null döner)
 * @param {object} [opts]
 * @param {object} [opts.registry] - test dikişi (engineRegistry API'si)
 * @param {object} [opts.planned] - test dikişi ("yolda" haritası; varsayılan enginePlanned.PLANNED)
 * @returns {null|Record<string,{state:string,capability:string,reason:string|null,severity:string,planned:string|null}>}
 */
function buildMatrix(engineId, opts = {}) {
  if (typeof engineId !== 'string' || !engineId.trim()) return null;
  const reg = opts.registry || engineRegistry;
  const plannedMap = opts.planned || enginePlanned.PLANNED;
  const id = engineId.trim();

  // Gerekçelerin TEK kaynağı: descriptor'ın kendi beyanı (kayıtsız motorda "kayıt yok").
  const declared = new Map();
  for (const item of reg.unsupportedCapabilities(id)) declared.set(item.capability, item);

  const out = {};
  for (const spec of USER_CAPABILITIES) {
    const value = reg.capability(id, spec.key);
    const decl = declared.get(spec.key) || null;
    let state;
    let reason;
    if (value === null || value === undefined) {
      state = 'missing';
      reason = decl ? decl.reason : 'yetenek beyan edilmemiş';
    } else if (decl && decl.state === 'partial') {
      state = 'partial';
      reason = decl.reason;
    } else {
      state = 'full';
      reason = null;
    }
    if (typeof spec.refine === 'function') {
      const verdict = spec.refine(value);
      // İnceltme yalnız DAHA KÖTÜ hüküm verebilir: 'full' bir alanı 'partial'/'missing'
      // yapar, tersini ASLA (descriptor'ın beyanını yumuşatmak = sessiz yetenek iddiası).
      if (verdict && rank(verdict.state) < rank(state)) {
        state = verdict.state;
        reason = verdict.reason;
      }
    }
    out[spec.id] = {
      state,
      capability: spec.key,
      reason: reason || null,
      severity: SECURITY_IDS.includes(spec.id) && state !== 'full' ? 'security' : 'info',
      // ENG-HONEST-CARD-01 — "yolda": yalnız TAM OLMAYAN satırda ve yalnız haritada
      // kart kodu varsa. TAM satırda harita ne derse desin null: kapanan kartın
      // silmeyi unuttuğu satır ekranda "yolda" diye yalan söyleyemez.
      planned: state === 'full' ? null : enginePlanned.plannedCardFor(id, spec.id, plannedMap),
    };
  }
  return out;
}

/** 'full' > 'partial' > 'missing' (küçük = daha kötü). */
function rank(state) {
  return state === 'full' ? 2 : state === 'partial' ? 1 : 0;
}

/** Tek satırlık özet (log). Tam yetenekliyse boş dize. */
function summarizeMatrix(matrix) {
  if (!matrix) return '';
  const missing = CAPABILITY_IDS.filter((id) => matrix[id] && matrix[id].state === 'missing');
  const partial = CAPABILITY_IDS.filter((id) => matrix[id] && matrix[id].state === 'partial');
  const parts = [];
  if (missing.length) parts.push(`yapamaz: ${missing.join(', ')}`);
  if (partial.length) parts.push(`kısmi: ${partial.join(', ')}`);
  return parts.join(' · ');
}

module.exports = {
  CAPABILITY_IDS,
  SECURITY_IDS,
  USER_CAPABILITIES,
  buildMatrix,
  summarizeMatrix,
  mcpCanCarrySecrets,
};
