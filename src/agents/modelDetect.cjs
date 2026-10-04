// ADP-526 — pane MODEL tespiti (engine ≠ model: engine claude/codex zaten biliniyor,
// burada o pane'de koşan MODELİN insan-okur etiketi çıkarılır: "Fable 5", "GPT-5.6 Sol").
//
// İki katman:
//   K1 resolveSpawnModel() — spawn-anı, ucuz: engine'in KENDİ config kaynağından aktif
//      model id'si okunur (claude: env ANTHROPIC_MODEL → cwd/.claude/settings(.local).json
//      → ~/.claude/settings.json — `claude config get model` ile aynı kaynak, ama süreç
//      spawn'lamadan; codex: $CODEX_HOME/config.toml top-level `model = "..."`).
//   K2 createModelSniffer() — canlı teyit: pty çıktısında model adı geçerse (banner /
//      "model:" satırı / model-değişim onayı) chip güncellenir — oturum ortası /model
//      değişimini yakalar. KONSERVATİF: serbest metin "opus iyidir" ASLA eşleşmez;
//      yalnız (a) bilinen-aile tam id'ler + insan-okur ad+versiyon çifti BANNER
//      PENCERESİNDE (ilk 32 KB — bir ajanın SOHBETTE yazdığı model id'leri chip'i
//      oynatmasın diye pencere sonrası kapanır), (b) her zaman: "model:"/"set model to"
//      gibi cümle-çapalı ve DEĞERİ bilinen-model-şekilli eşleşmeler.
//
// Hiçbir fonksiyon throw ETMEZ (push pty onData callback'inde koşar — ADP-335 disiplini:
// asenkron callback'te kaçan hata TÜM app'i öldürür). Bilinemeyen → null → chip yok.

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// ENG-09 — model kaynağı (K1) ve canlı-teyit izni (K2) motor adına göre değil
// DESCRIPTOR'a göre belirlenir: `model.detect` + `model.sniff`.
const engineRegistry = require('./engineRegistry.cjs');

// K2 banner penceresi: bare-id / ad+versiyon eşleşmesi yalnız toplam çıktının ilk bu
// kadar baytında kabul edilir (CLI açılış banner'ı burada biter; sonrası sohbettir).
const BANNER_WINDOW_BYTES = 32 * 1024;
// Chunk sınırı kelime sınırı değildir — eşleşme her push'ta bu kuyruk üstünde yapılır.
const TAIL_CHARS = 2048;

const CLAUDE_FAMILIES = ['fable', 'opus', 'sonnet', 'haiku'];

// ---------------------------------------------------------------------------
// id → insan-okur etiket
// ---------------------------------------------------------------------------

const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

/** "4-8" → "4.8"; "4-5-20251001" → "4.5" (6+ haneli tarih segmenti atılır). */
function formatVersion(rest) {
  const segs = String(rest)
    .split('-')
    .filter((s) => s !== '' && !/^\d{6,}$/.test(s));
  return segs.join('.');
}

/**
 * Model id'sini insan-okur chip etiketine çevirir; tanınmayan ama id-görünümlü
 * değer KISALTILMIŞ ham id olarak döner, anlamsız/boş değer null (chip yok).
 *   claude-fable-5[1m] → "Fable 5" · claude-opus-4-8 → "Opus 4.8"
 *   claude-haiku-4-5-20251001 → "Haiku 4.5" · claude-3-5-sonnet-20241022 → "Sonnet 3.5"
 *   gpt-5.6-sol → "GPT-5.6 Sol" · opus → "Opus" · default → null
 */
function labelForModelId(rawId) {
  if (typeof rawId !== 'string') return null;
  // `[1m]` gibi varyant soneki (1M context) etikete girmez.
  const id = rawId.trim().replace(/\[[^\]]*\]\s*$/, '').trim().toLowerCase();
  if (!id || /\s/.test(id)) return null;
  // "default" bir model DEĞİL (CLI'nin o günkü varsayılanı — bilinemez) → chip yok.
  if (id === 'default') return null;

  let m = id.match(/^claude-(fable|opus|sonnet|haiku)(?:-(.+))?$/);
  if (m) {
    const v = m[2] ? formatVersion(m[2]) : '';
    return v ? `${cap(m[1])} ${v}` : cap(m[1]);
  }
  // Eski nesil sıralama: claude-3-5-sonnet-20241022 → "Sonnet 3.5"
  m = id.match(/^claude-(\d+(?:-\d+)*)-(opus|sonnet|haiku)(?:-.*)?$/);
  if (m) return `${cap(m[2])} ${formatVersion(m[1])}`;
  // Çıplak alias'lar (settings.json'da "opus"/"sonnet" yazılabiliyor).
  if (CLAUDE_FAMILIES.includes(id)) return cap(id);
  if (id === 'opusplan') return 'Opus Plan';
  m = id.match(/^gpt-?(.+)$/);
  if (m) {
    const segs = m[1].split('-').filter(Boolean);
    // İlk segment sürümdür (5.6 / 4o) — olduğu gibi; kalanı kelime ("sol", "codex").
    return ['GPT-' + segs[0], ...segs.slice(1).map(cap)].join(' ');
  }
  // Tanınmayan ama id-görünümlü → kısaltılmış ham id (tarih soneki atılır).
  if (!/^[a-z0-9][a-z0-9._-]+$/.test(id)) return null;
  const short = id.replace(/-\d{6,}$/, '');
  return short.length > 24 ? short.slice(0, 24) : short;
}

// ---------------------------------------------------------------------------
// K1 — spawn-anı config çözümü
// ---------------------------------------------------------------------------

function readJsonModel(file, field) {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    // ENG-14 — İÇ İÇE ALAN: gemini modeli `{ model: { name: "…" } }` olarak yazıyor
    // (ikili: `loadedSettings.setValue("User", "model.name", model)`). Düz anahtar
    // okuyan eski hâl bu dosyada HER ZAMAN null döner ve kart sessizce "bilinmiyor"
    // derdi. Nokta yolu descriptor'ın `field` beyanından gelir; düz alan adları
    // (claude `model`) BİTİŞİK aynı yoldan geçer — davranış değişmez.
    let v = j;
    for (const part of String(field).split('.')) {
      v = v && typeof v === 'object' ? v[part] : null;
    }
    return typeof v === 'string' && v ? v : null;
  } catch {
    return null;
  }
}

/** codex config.toml: yalnız İLK [section] başlığından ÖNCEKİ top-level `model = "…"`. */
function readTomlModel(file, field) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    const top = text.split(/^\s*\[/m, 1)[0];
    // Alan adı descriptor'dan gelir; regex'e girmeden önce KAÇIRILIR (kaynak
    // veri olsa da desen enjeksiyonuna açık bırakılmaz).
    const safe = String(field).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const m = top.match(new RegExp(`^\\s*${safe}\\s*=\\s*"([^"]+)"`, 'm'));
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

/** ENG-13 — goose config.yaml: `ANAHTAR: değer` (düz skaler; iç içe yapı OKUNMAZ). */
function readYamlScalar(file, field) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    const safe = String(field).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const m = text.match(new RegExp(`^\\s*${safe}\\s*:\\s*["']?([^"'#\\n]+)`, 'm'));
    return m ? m[1].trim() || null : null;
  } catch {
    return null;
  }
}

/**
 * ENG-09 — MODEL KAYNAĞI OKUYUCULARI. Hangi motorun modelini NEREDEN okuduğumuz
 * artık motor adına bakan bir `if` değil, descriptor `model.detect.kind` ile
 * seçilen bir okuyucudur (engineRegistry). Beyanı OLMAYAN motorda okuma YAPILMAZ
 * ve chip basılmaz: bilinmeyen motorun config'i claude'unki sanılmaz (ENG-05'in
 * "bilinmeyen motor claude'a düşmez" kuralının model yüzeyindeki karşılığı).
 */
const MODEL_DETECTORS = Object.freeze({
  /** claude: env → proje .claude/settings*.json → ~/.claude/settings.json (sıra ÖNEMLİ). */
  'json-settings': ({ detect, env, cwd, home }) => {
    const field = detect.field || 'model';
    const fromEnv = detect.env && typeof env[detect.env] === 'string' ? env[detect.env] : null;
    if (fromEnv) return fromEnv;
    for (const f of detect.files || []) {
      // ENG-14 — ÜÇÜNCÜ KAPSAM: 'engine-home'. Eskiden yalnız 'cwd' ve ev dizini
      // vardı; `scope:'engine-home'` beyan eden kayıtlar (copilot $COPILOT_HOME,
      // gemini $GEMINI_CLI_HOME) SESSİZCE kullanıcı ev dizinine düşüyordu — yani
      // `~/settings.json` gibi VAR OLMAYAN bir yol okunuyordu ve tespit hep null
      // dönüyordu. Profil env'i yoksa davranış eskisi gibi (ev dizini) kalır.
      const root =
        f.scope === 'cwd'
          ? cwd
          : f.scope === 'engine-home' && f.homeEnv && typeof env[f.homeEnv] === 'string' && env[f.homeEnv].trim()
            ? env[f.homeEnv].trim()
            : home;
      if (!root) continue;
      const id = readJsonModel(path.join(root, ...f.segments), field);
      if (id) return id;
    }
    return null;
  },
  /**
   * ENG-13 — goose: env → $XDG_CONFIG_HOME/goose/config.yaml.
   * 🪤 `homeEnv` burada motorun EV DİZİNİ DEĞİL, ONUN ÜSTÜDÜR (XDG kökü) → alt
   * segmentler `homeSegments` ile beyan edilir; codex'te (CODEX_HOME) bu boştur.
   */
  'yaml-config': ({ detect, env, home }) => {
    const fromEnv = detect.env && typeof env[detect.env] === 'string' ? env[detect.env] : null;
    if (fromEnv) return fromEnv;
    const root =
      detect.homeEnv && typeof env[detect.homeEnv] === 'string' && env[detect.homeEnv]
        ? path.join(env[detect.homeEnv], ...(detect.homeSegments || []))
        : path.join(home, ...(detect.homeFallback || []));
    return readYamlScalar(path.join(root, detect.file), detect.field || 'model');
  },
  /** codex: $CODEX_HOME/config.toml (top-level alan). */
  'toml-config': ({ detect, env, home }) => {
    const fromEnv = detect.env && typeof env[detect.env] === 'string' ? env[detect.env] : null;
    if (fromEnv) return fromEnv;
    const engineHome =
      detect.homeEnv && typeof env[detect.homeEnv] === 'string' && env[detect.homeEnv]
        ? env[detect.homeEnv]
        : path.join(home, ...(detect.homeFallback || []));
    return readTomlModel(path.join(engineHome, detect.file), detect.field || 'model');
  },
});

/**
 * Spawn anında engine config'inden model etiketi çözer; bilinemiyorsa null.
 * Kaynak sırası motorun DESCRIPTOR'ında yazılıdır (claude: env ANTHROPIC_MODEL →
 * proje .claude/settings.local.json → proje .claude/settings.json →
 * ~/.claude/settings.json; codex: $CODEX_HOME/config.toml).
 */
function resolveSpawnModel({ engine, env, cwd, home, registry } = {}) {
  try {
    const e = env || {};
    const h = home || e.HOME || os.homedir();
    const reg = registry || engineRegistry;
    const desc = typeof engine === 'string' && engine ? reg.getEngine(engine) : null;
    const detect = desc && desc.model && desc.model.detect ? desc.model.detect : null;
    if (!detect) return null; // shell / kayıtsız motor / beyan yok → model kavramı yok
    const read = MODEL_DETECTORS[detect.kind];
    if (!read) return null; // tanınmayan tespit sınıfı → UYDURMA YOK
    const id = read({ detect, env: e, cwd, home: h });
    return id ? labelForModelId(id) : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// K2 — pty çıktısından canlı teyit
// ---------------------------------------------------------------------------

// CSI + OSC + tekil ESC dizileri (pty çıktısı ANSI'yle örülü; id'ler SGR'la bölünebilir).
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b[@-_]/g;
const stripAnsi = (s) => s.replace(ANSI_RE, '');

// ADP-562 — GERÇEK pty çıktısı kanıtladı: Claude Code'un `/model` onay cümlesi
// ("Set model to Opus 4.8 …") kelime kelime MUTLAK SÜTUNA atlayarak basılıyor —
// "Set"<ESC[10G>"model"<ESC[16G>"to"… — aralarda LİTERAL boşluk YOK. Bu yüzden
// eski cümle-çapalı regex (düz "set model to" arıyordu) gerçek çıktıda HİÇBİR
// ZAMAN eşleşmiyordu (Hipotez A doğrulandı — bkz. ADP-562 sonuç raporu). Cümle
// eşleşmesinden ÖNCE bu sütun-atlamalarını tek boşluğa çevir.
const CURSOR_COL_RE = /\x1b\[\d+G/g;
function toPhraseText(s) {
  return stripAnsi(s.replace(CURSOR_COL_RE, ' ')).replace(/[ \t]+/g, ' ');
}

// Bilinen-aile tam id (bare): claude-<aile|rakam>… veya gpt-<rakam>…
const BARE_ID_RE = /\b(claude-(?:fable|opus|sonnet|haiku|\d)[a-z0-9.-]*(?:\[[0-9a-z]+\])?|gpt-[0-9][a-z0-9.-]*)\b/gi;
// Cümle-çapalı: "model: X" / "set model to X" / "now using X" — değer bilinen-model-şekilli.
const PHRASE_RE = /(?:set model to|model set to|model switched to|switched to|now using|model\s*[:=])\s*[`'"]?(claude-[a-z0-9.[\]-]+|gpt-[0-9][a-z0-9.-]*|fable|opus|sonnet|haiku|opusplan)\b(\[[0-9a-z]+\])?/gi;
// Banner penceresi: insan-okur ad + versiyon çifti ("Fable 5 · Claude Code v2…").
const HUMAN_RE = /\b(Fable|Opus|Sonnet|Haiku)\s+(\d+(?:\.\d+)?)\b/g;
// ADP-562 — GERÇEK onay cümlesi (toPhraseText ile despaced metinde): "Set model
// to Opus 4.8 (1M context) (default) and saved as your default for new sessions"
// / "Set model to Sonnet 5 and saved as your default for new sessions" (kanıt:
// gerçek pty capture, ADP-562 sonuç raporu). Aile adı bilinen-4'le sınırlı —
// serbest metinde geçen "opus" ASLA eşleşmez (yalnız bu tam cümle kalıbı).
const HUMAN_CONFIRM_RE = /\bset model to\s+(fable|opus|sonnet|haiku)(?:\s+(\d+(?:\.\d+)?))?/gi;
// ADP-562 — Hipotez B doğrulandı: `/model` menüsü (liste + "Select model" başlığı)
// gerçek oturumda banner penceresi İÇİNDE açılabiliyor (kanıt: ~5.8 KB, 32 KB
// eşiğinin çok altında) — listedeki HER modelin insan-okur adı ekranda durur
// (en altta "Haiku 4.5" dahil) ve hiçbiri seçili olmayabilir. "Select model"
// başlığı ekranda olduğu sürece BARE_ID_RE/HUMAN_RE'yi bastır — yalnız açık
// onay cümlesi (HUMAN_CONFIRM_RE, yukarıda) chip'i değiştirebilir.
const MENU_OPEN_MARKER = 'Select model';

// Kuyruğun TAM UCUNDA biten eşleşme yarım kalmış olabilir (chunk sınırı kelime
// sınırı değildir: "claude-fab|le-5") → o tur atlanır; id tamamlanınca sonraki
// push aynı kuyrukta bütün halini görür. Yarım-id'li sahte etiket basılmaz.
function lastMatch(re, text) {
  re.lastIndex = 0;
  let m = null;
  for (let x = re.exec(text); x; x = re.exec(text)) {
    if (x.index + x[0].length >= text.length) break;
    m = x;
  }
  return m;
}

/**
 * Pane başına bir sniffer: her pty chunk'ı push edilir; yeni bir model tespitinde
 * etiketi döner, yoksa null. Asla throw etmez (onData callback'inde koşar).
 */
function createModelSniffer(engine, opts = {}) {
  let tail = '';
  let total = 0;
  // ENG-09 — hangi motorda koklama YAPILACAĞI descriptor'da beyan edilir
  // (`model.sniff`). Buradaki desenler claude/GPT ailesinin banner ve `/model`
  // cümlelerine göre ÖLÇÜLDÜ (ADP-562); beyan etmeyen bir motorun çıktısında
  // aynı desenleri aramak, o motorun modelini UYDURMAK olurdu.
  const desc = typeof engine === 'string' && engine ? (opts.registry || engineRegistry).getEngine(engine) : null;
  const isAgent = !!(desc && desc.model && desc.model.sniff === 'claude-gpt');
  return {
    push(chunk) {
      try {
        if (!isAgent) return null;
        const s = String(chunk);
        const inBanner = total <= BANNER_WINDOW_BYTES;
        total += s.length;
        tail = (tail + s).slice(-TAIL_CHARS);
        const clean = stripAnsi(tail);
        // ADP-562 (K2 fix) — gerçek /model onay cümlesi İKİ farklı biçimde basılabiliyor:
        // (a) kelime-başı sütun-atlamalı toast ("Set"<ESC[10G>"model"…), (b) düz
        // boşluklu transkript satırı ("⎿ Set model to Sonnet 5 and saved…"). toPhraseText
        // ikisini de normalize eder (düz-boşluklu girdide no-op). ÖNCE bunu dene — eski
        // PHRASE_RE (aşağıda) yalnız aileyi yakalar, versiyon numarasını KAYBEDER
        // ("Sonnet" olur, "Sonnet 5" değil) çünkü bare-id/alias içindir, insan-etiketi için
        // değil. Banner penceresinden BAĞIMSIZ: oturum ortası değişim her zaman yakalanmalı.
        const humanConfirm = lastMatch(HUMAN_CONFIRM_RE, toPhraseText(tail));
        if (humanConfirm) {
          const family = cap(humanConfirm[1].toLowerCase());
          return humanConfirm[2] ? `${family} ${humanConfirm[2]}` : family;
        }
        const phrase = lastMatch(PHRASE_RE, clean);
        if (phrase) return labelForModelId(phrase[1] + (phrase[2] || ''));
        // ADP-562 — /model menüsü açıkken (liste ekranda) bare-id/insan-ad çiftini
        // ASLA aktif model sanma: menüdeki HİÇBİR satır seçim onayı değildir.
        if (inBanner && !clean.includes(MENU_OPEN_MARKER)) {
          const bare = lastMatch(BARE_ID_RE, clean);
          if (bare) return labelForModelId(bare[1]);
          const human = lastMatch(HUMAN_RE, clean);
          if (human) return `${human[1]} ${human[2]}`;
        }
        return null;
      } catch {
        return null;
      }
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// HATA-07 — PANE ROZETİNİN KAYNAK KURALI (tek yerde, ölçülebilir).
//
// KÖK NEDEN (Discord/NZX 23.08): kullanıcı Sonnet seçtiği hâlde rozet bayat bir
// etiket ("Sonnet 4.6") gösteriyordu. Rozetin kendisi bozuk DEĞİLDİ — `--model`
// hiç geçilmediği için OTORİTER kaynak (launch modeli) yoktu ve rozet K1'e,
// yani motorun DİSKTEKİ config varsayılanına düşüyordu. Config ne kadar bayatsa
// rozet de o kadar bayat oluyordu.
//
// Kural bu yüzden şudur ve artık bir fonksiyondur (main.js'te satır-içi değil):
//   1) `--model` ile GERÇEKTEN başlattığımız model varsa rozet ONDAN türer
//      (sağlayıcılı codex'te sağlayıcı-farkında etiket, ADP-580).
//   2) Ancak o zaman K1 config-okuması (`resolveSpawnModel`) fallback'tir.
//   3) Ajan olmayan pane (shell) → rozet YOK.
// K2 (pty çıktısından tespit) bunun ÜSTÜNE gelir ve oturum-içi `/model`i yakalar.
//
// SAF + DI: sağlayıcı etiketleyici ve K1 çözücü ENJEKTE edilir, böylece kural
// Electron olmadan `node --test` ile sınanır.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * AGENT-MODEL-01 — ROZET ARTIK EFORU DA SÖYLER.
 *
 * ÖLÇÜLEN BOŞLUK: `buildSpawn` bu pane'e basılan eforu zaten DÖNDÜRÜYORDU
 * (agentRunner `effort: effectiveEffort`) ama main onu HİÇ OKUMUYORDU → değer yere
 * düşüyordu. Sonuç: kullanıcı "xhigh" seçiyor, argv'ye gerçekten `xhigh` gidiyor,
 * ama ekranda bunu doğrulayabileceği hiçbir yer yoktu — HATA-07'nin ("Sonnet
 * seçtim, Haiku açıldı") tam olarak kapattığı sınıf bir tutarsızlık.
 *
 * Efor rozete İDDİA olarak değil ÖLÇÜM olarak girer: `launchEffort` yalnız
 * descriptor'ın beyaz listesinden geçmiş (yani argv'ye GERÇEKTEN basılmış) değerdir.
 * Bayrak eklenmemişse (motorun kendi varsayılanı) rozet de efor YAZMAZ — "bilmiyoruz"
 * ile "low" arasındaki farkı uydurmayız.
 *
 * @param {{isAgent?:boolean, launchModel?:string|null, provider?:string|null,
 *          launchEffort?:string|null}} plan
 * @param {{providerModelLabel?:(p:string,m:string)=>string|null, resolveK1?:() => string|null}} deps
 * @returns {string|null} rozet etiketi (null → chip çizilmez)
 */
function paneModelLabel(plan = {}, deps = {}) {
  if (!plan.isAgent) return null; // shell → model kavramı yok
  const launch = typeof plan.launchModel === 'string' && plan.launchModel.trim()
    ? plan.launchModel.trim()
    : null;
  if (launch) {
    const provider = typeof plan.provider === 'string' && plan.provider.trim() ? plan.provider.trim() : null;
    if (provider && typeof deps.providerModelLabel === 'function') {
      // ADP-580 — sağlayıcı-farkında etiket ("Groq · Llama 3.3 70B"). Sağlayıcı
      // kaydı bu modeli tanımıyorsa ham id yerine model etiketine düşülür.
      return deps.providerModelLabel(provider, launch) || labelForModelId(launch);
    }
    return labelForModelId(launch);
  }
  // Model VERİLMEDİ → K1 (motorun config varsayılanı). Bayat olabilir; bu yüzden
  // ürünün asıl işi buraya hiç düşmemektir (kullanıcı seçimini spawn'a taşımak).
  return typeof deps.resolveK1 === 'function' ? deps.resolveK1() || null : null;
}

/**
 * AGENT-MODEL-01 — model etiketine efor sonekini ekle: "Opus · xhigh".
 *
 * AYRI BİR FONKSİYON çünkü rozet iki farklı yoldan tazelenir: spawn anı
 * (`paneModelLabel`) ve oturum-içi K2 sniffer'ı (`/model` ile model DEĞİŞİR ama
 * efor DEĞİŞMEZ — `--effort` bir launch bayrağıdır). İkisi de bu tek biçimlendiriciyi
 * çağırır, böylece model değişince efor soneki kaybolmaz.
 *
 * Etiket yoksa efor TEK BAŞINA gösterilmez (bağlamsız bir "xhigh" rozeti anlamsız).
 */
function withEffortSuffix(label, effort) {
  const l = typeof label === 'string' && label.trim() ? label.trim() : null;
  const e = typeof effort === 'string' && effort.trim() ? effort.trim() : null;
  if (!l) return null;
  return e ? `${l} · ${e}` : l;
}

module.exports = { labelForModelId, resolveSpawnModel, createModelSniffer, paneModelLabel, withEffortSuffix };
