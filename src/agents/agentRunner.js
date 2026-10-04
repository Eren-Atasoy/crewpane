// CrewPane — ADP-013 agent runner core (pure, no Electron deps).
//
// ADR-002 (ADP-011) decided the app-owned pane runner is an ADDITIVE extension
// of the proven ADP-003 paneId-keyed pty bridge: `pty:spawn` gains an optional
// agent-aware shape (`{ command, args, cwd, env, agentId, department, label }`)
// while a bare spawn still launches today's login shell (fully backward
// compatible — the ADP-001 regression keeps spawning `$SHELL`).
//
// This module isolates the SECURITY-CRITICAL bits so they can be unit-tested
// without booting Electron:
//   • ALLOWED_COMMANDS — the renderer may only ask for a command from this
//     whitelist. An arbitrary `command` string is REJECTED — this is the RCE
//     guard ADR-002 made MANDATORY for ADP-013 (emsal: focus-pane's window
//     whitelist, src/app/api/focus-pane/route.ts).
//   • buildSpawn() — turns a validated request into the concrete
//     `(file, argv, cwd, env)` handed to node-pty. No shell string is ever
//     constructed, so args cannot be interpolated into a command line.
//
// main.js requires this and calls buildSpawn(); agentRunner.test.cjs exercises
// it directly (node --test).

'use strict';

const os = require('node:os');
const fs = require('node:fs');
// ADP-835 (790 K1) — atomik yazımın rename adımı platform boğazından geçer:
// Windows'ta Defender/Search hedefi açık tutunca EPERM/EBUSY gelir ve bu çağrıların
// çoğu best-effort catch içinde OLDUĞU İÇİN kayıt SESSİZCE kaybolurdu.
const { atomicWriteFileSync } = require('../../platform/atomicWrite.cjs');
// ADP-835 (790 I3) — MCP config `{mode:0o600}` Windows'ta SESSİZCE etkisiz; boğaz
// ne yaptığını (chmod / miras-ACL) söyler.
const { restrictFile } = require('../../platform/restrictPath.cjs');
const { mkdirpSync } = require('../../platform/mkdirp.cjs'); // PIPE-10 — asılmayan `mkdir -p`
const path = require('node:path');
const crypto = require('node:crypto');
const { dirForDepartment } = require('./departmentDirs.cjs'); // ADP-154 — department → project dir
const { normalizeDepartment } = require('./teamResolve.cjs'); // TEAM-CASE-01 — department kanonikleştirme (trim+lowercase)
const instancePaths = require('../config/instancePaths.cjs'); // ADP-206 — instance-scoped config dir (~/.crewpane[-dev])
const taskClaim = require('./taskClaim.cjs'); // C4 — izolasyon ikizi kararı (saf; main'in ADP-896 kapısıyla aynı modül)
const crewpaneEnv = require('../config/crewpaneEnv.cjs'); // ADP-244 Faz 3 — CREWPANE_* ⇄ CREWPANE_* ikizleri (dual-write/read + scrub)
const agentMemory = require('../memory/agentMemory.cjs'); // ADP-235/237 — per-agent persistent memory (restart-recall)
const modelCatalog = require('./modelCatalog.cjs'); // AGENT-MODEL-01/AGY-05 — motor başına model kataloğu (model-kapsamlı efor kümesinin tek kaynağı)
const memorySpawnRetrieval = require('../memory/memorySpawnRetrieval.cjs'); // ADP-872 — spawn'da hibrit RAG (BM25+vektör, RRF)
const memoryTaskBlock = require('../memory/memoryTaskBlock.cjs'); // D-07 — iki aşamalı enjeksiyon (spawn çekirdeği / göreve-göre seçki)
const memoryTargeting = require('../memory/memoryTargeting.cjs'); // D-07 — kimlik-önce bütçe + eşik/ceza çekirdeği
const memoryLedgerStore = require('../memory/memoryUsageLedger.cjs'); // D-07 (K4) — enjeksiyon/kullanım defteri
const identitySurfaceTrim = require('./identitySurfaceTrim.cjs'); // TOKEN-BUDGET-01 — yüzeyi olmayan kimlik bölümlerini düşür
const paneContextScope = require('../terminal/paneContextScope.cjs'); // TOKEN-BUDGET-01 — motorun kendi enjeksiyonunu çalışma alanıyla sınırla
const spawnPromptFile = require('./spawnPromptFile.cjs'); // AD-WIN-01 — kimliği komut satırından çıkar (Windows cmd.exe 8191)
const identityBudget = require('./identityBudget.cjs'); // IDN-BUDGET-01 — kimlik bütçesinin TEK boğazı (renderer ile ortak)
const engineRegistryModule = require('./engineRegistry.cjs'); // ENG-04/07 — motor descriptor defteri (argv dallarının TEK kaynağı)
const paneCapabilityMatrix = require('../terminal/paneCapabilityMatrix.cjs'); // ENG-10 — "MCP sır taşıyabilir mi" kuralının TEK evi
const engineBasePrompt = require('./engineBasePrompt.cjs'); // ENG-14 — REPLACE taşıyıcısında gömülü prompt'u geri kazanma reçetesi
const codexMcpProfile = require('../mcp/codexMcpProfile.cjs'); // CODEX-ARGV-01 — codex MCP kaydı argv'den DOSYAYA (`-p <ad>`)
const agyWorkspacePlugin = require('./agyWorkspacePlugin.cjs'); // AGY-01 — antigravity pane-başına çalışma-alanı plugin demeti
const agyHooks = require('./agyHooks.cjs'); // AGY-03 — antigravity hooks.json içeriği (tur brifingi + alt-ajan bloğu)

// ───────────────────────────────────────────────────────────────────────────────
// ENG-07 (ENG-R3 §2.3) — ARGV HUNİSİ ARTIK MOTOR ADINA DEĞİL DESCRIPTOR'A BAKAR.
//
// ÖNCESİ: her yetenek kendi `if (commandKey === 'claude') … if (commandKey === 'codex') …`
// dalını taşıyordu (30 dal, ölçüm ENG-R3 §1.2). Üçüncü bir motor eklendiği gün bu
// dalların HİÇBİRİ onu tanımaz ve — asıl arıza — SESSİZCE `return argv` derdi:
// kimlik enjekte edilmez, ADR-004'ün SERT alt-ajan bloğu kaybolur, kimse fark etmez.
//
// SONRASI: her uygulayıcı `engineRegistry`den yeteneği OKUR. Yetenek `null` ise
// davranış aynıdır (uygulanmaz) ama artık BEYANLIDIR: `buildSpawn` sonucunda
// `capabilities.unsupported[]` döner, main pane kaydına yazar ve log'a düşer.
// "Sessizce daha az yetenek" yasağının makine-denetimli hâli budur.
//
// Defter ENJEKTE EDİLEBİLİR (`setEngineRegistry`) — kayıtsız/eksik-yetenekli bir
// motorun gerçekten ne yaptığını ölçebilmek için (emsal: tokenUsage/modelDetect).
let engineRegistry = engineRegistryModule;

/** Test/entegrasyon dikişi: defteri değiştir (argüman yok/`null` → varsayılan). */
function setEngineRegistry(next) {
  engineRegistry = next && typeof next.capability === 'function' ? next : engineRegistryModule;
  return engineRegistry;
}

/** Bir motorun yeteneği (kayıtsız motor / kayıtsız alan → `null`, uydurma YOK). */
function engineCapability(commandKey, key) {
  return engineRegistry.capability(commandKey, key);
}

/**
 * Bu motorun OTONOMİ beyanı (ENG-20). `engineCapability` ile AYNI enjekte edilebilir
 * defterden okunur — ikinci bir kaynak ikinci bir gerçek doğururdu.
 * AGY-03: dolaylı MCP kapısı bu beyana bakar (`level === 'full'` → `allow` basılabilir).
 */
function engineAutonomy(commandKey) {
  return typeof engineRegistry.engineAutonomy === 'function'
    ? engineRegistry.engineAutonomy(commandKey)
    : null;
}

/**
 * Bu pane'in YAPAMAYACAKLARI: `[{capability,state,reason,severity}]` (ENG-10 rozet
 * girdisi). Kaynak descriptor'ın kendisi olduğu için uygulayıcılarla SAPMASI imkânsız.
 */
function unsupportedCapabilities(commandKey) {
  return engineRegistry.unsupportedCapabilities(commandKey);
}

/**
 * Bir yeteneğin argümanlarını argv'ye BASAN tek genel uygulayıcı.
 * `position`: 'prepend' → argv'nin BAŞINA (codex'in pozisyonel kimliği SON kalsın),
 * her şey → SONUNA. Boş liste no-op (bugünkü davranış).
 */
function applyArgs(argv, args, position) {
  if (!Array.isArray(args) || !args.length) return argv;
  return position === 'prepend' ? [...args, ...argv] : [...argv, ...args];
}

/**
 * Bayrak + değer listesini descriptor'ın `repeat` beyanına göre kurar:
 *   • 'per-item' → `-i a -i b`   (her değer kendi bayrağıyla — codex görselleri)
 *   • 'variadic' → `--add-dir a b`  (tek bayrak, çok değer — claude ek kökleri)
 */
function repeatFlagArgs(flag, values, repeat) {
  const list = (Array.isArray(values) ? values : []).filter((v) => typeof v === 'string' && v.trim());
  if (!flag || !list.length) return [];
  if (repeat === 'variadic') return [flag, ...list];
  const out = [];
  for (const v of list) out.push(flag, v);
  return out;
}

/**
 * D-07 — KULLANIM DEFTERİ (tek örnek, instance-kapsamlı). Enjekte edilen kayıtları
 * ve (oturum bitince ölçülen) kullanımlarını tutar; seçki skorunu bu sayaçlar
 * düşürür. Defter AÇILAMAZSA `null` döner ve seçki cezasız çalışır — ölçüm aracı,
 * ölçtüğü şeyi düşüremez.
 */
let memoryLedgerSingleton;
function memoryLedger() {
  if (memoryLedgerSingleton !== undefined) return memoryLedgerSingleton;
  try {
    memoryLedgerSingleton = memoryLedgerStore.createLedger({
      file: path.join(instancePaths.crewpaneHome(), 'memory-usage-ledger.json'),
    });
  } catch {
    memoryLedgerSingleton = null;
  }
  return memoryLedgerSingleton;
}

/**
 * ADP-872 — sıcak gömme sürecine açılan DİKİŞ. main.js kendi arama servisini buraya
 * enjekte eder; enjekte EDİLMEZSE retrieval yine koşar (yalnız kelime katmanıyla) —
 * yani bu bağlantı bir gereklilik değil, YÜKSELTMEdir.
 */
let spawnMemoryWarm = null;
function setSpawnMemoryWarm(fn) {
  spawnMemoryWarm = typeof fn === 'function' ? fn : null;
}

/**
 * D-07 — ADP-872'nin hibrit retrieval'ı SPAWN'DAN GÖREV ANINA taşındı: sorgusu
 * artık ajanın kimliği değil İŞİN KENDİSİ (D-04 §1.5'in kök nedeni). Bu yardımcı,
 * ısıtma dikişini (yukarıdaki setter) taşıyan bir retriever üretir; Aşama B
 * (memoryTaskBlock.taskBlock) onu görev metniyle çağırır.
 */
function spawnRetrieverFor(workspaceRoot) {
  try {
    return memorySpawnRetrieval.createSpawnRetriever({
      workspaceRoot,
      warm: spawnMemoryWarm ? (q) => spawnMemoryWarm({ workspaceRoot, query: q }) : null,
    });
  } catch {
    return null;
  }
}
const providers = require('./providers.cjs'); // ADP-580 — codex custom AI providers (Groq/DeepSeek/Kimi)
const envPath = require('../../platform/envPath.cjs'); // ADP-833 (ADR-W10 K2) — PATH zenginleştirme (macOS + win32 listeleri)
const holderShell = require('../../platform/holderShell.cjs'); // ADP-833 — platforma göre kabuk/tutucu (M4/M6)
const mcpNode = require('../../platform/mcpNode.cjs'); // ADP-891 — MCP server'larını koşturan yorumlayıcının tek boğazı
const codeIndexStore = require('../services/codeIndex.cjs'); // CIDX-1 — kod indeksi ayarı (şema + ikili keşfi)
const systemPromptCap = require('../../platform/systemPromptCap.cjs'); // AD-WIN-02 — kimlik tavanı TAŞIYICIYA göre (tek kaynak)
const integrationBriefing = require('../mcp/integrationBriefing.cjs'); // BR-02 — üç-durum entegrasyon protokolü (tek kaynak)
// MCP-COST-01 — `npx -y <paket>` sarmalayicisini kaldiran cozumleyici (fail-open:
// onbellekte yoksa null doner ve komut AYNEN npx kalir).
const npxDirect = require('../mcp/npxDirect.cjs');
// MCP-COST-01 — "bagli kalsin ama pane'lerde otomatik acilmasin" isareti.
const integrationAutostart = require('../mcp/integrationAutostart.cjs');
const killGuardShim = require('../security/killGuardShim.cjs'); // KILL-GUARD-01 — motor-bağımsız killall/pkill sarmalayıcıları
// BR-04 — VENDOR telemetri anahtarlarının env adları (pane süpürgesi için). Saf modül:
// yalnız buildChannel + instancePaths'e bağlı, `node --test` altında da yüklenir.
const { VENDOR_TELEMETRY_ENV_KEYS } = require('../../telemetry/channel.cjs');

// ---------------------------------------------------------------------------
// Command whitelist (RCE guard — ADR-002 DoD)
// ---------------------------------------------------------------------------
// Keys are the ONLY values the renderer may send as `command`. The value is the
// real binary node-pty will exec (resolved via PATH), or null for "the login
// shell" (today's behavior). Anything not a key here is rejected.
// ENG-12 — bu liste BİLEREK elle yazılır (defterden TÜRETİLMEZ). Sebep güvenlik:
// burası RCE beyaz listesidir; deftere eklenen bir satırın kendiliğinden
// "çalıştırılabilir" olması, geçerlilik defteriyle YÜRÜTME yetkisini tek noktada
// birleştirirdi (ENG-05 migration başlığı da aynı çizgiyi çeker: "bu tablo bir
// GEÇERLİLİK defteridir, bir yürütme yetkisi değil"). Drift testi R2 iki listeyi
// karşılaştırır — sapma sessiz kalmaz, ama izin İNSAN eliyle verilir.
const ALLOWED_COMMANDS = Object.freeze({
  shell: null, // → $SHELL, today's ADP-003 behavior (backward compatible)
  claude: 'claude',
  codex: 'codex',
  copilot: 'copilot', // ENG-12 — GitHub Copilot CLI (@github/copilot, ölçüldü: 1.0.80)
  goose: 'goose', // ENG-13 — Goose (block/goose, ölçüldü: 1.46.0)
  droid: 'droid', // ENG-13 — Droid / Factory CLI (ölçüldü: 0.197.0)
  gemini: 'gemini', // ENG-14 — Gemini CLI (@google/gemini-cli, ölçüldü: 0.55.1)
  qwen: 'qwen', // ENG-14 — Qwen Code (@qwen-code/qwen-code, ölçüldü: 0.21.13)
  opencode: 'opencode', // ENG-16 — OpenCode (opencode-ai, ölçüldü: 1.18.18)
  amp: 'amp', // ENG-16 — Amp (@ampcode/cli, ölçüldü: 0.0.1786968161-gdd03ae)
  // ENG-17 — 🪤 İLK KEZ MOTOR ADI ≠ KOMUT ADI. Kurulum ~/.local/bin'e İKİ bağ atıyor:
  // `agent` (satıcının primary'si) ve `cursor-agent`. JENERİK `agent` adı BİLEREK
  // seçilmedi: kullanıcının PATH'inde başka bir `agent` olabilir ve beyaz listeye
  // jenerik bir ad koymak, o adı taşıyan HERHANGİ bir programı çalıştırılabilir yapardı.
  cursor: 'cursor-agent', // ENG-17 — Cursor CLI (ölçüldü: 2026.08.11-e8db854)
  kimi: 'kimi', // ENG-17 — Kimi Code (@moonshot-ai/kimi-code, ölçüldü: 0.36.1)
  crush: 'crush', // ENG-17 — Crush (@charmland/crush, ölçüldü: v0.89.0)
  // ENG-22 — 🪤 İKİNCİ KEZ MOTOR ADI ≠ KOMUT ADI: kurucu ikiliyi `agy` adıyla
  // koyuyor (arşivdeki dosya adı `antigravity`). Beyaz liste İKİLİNİN adını
  // taşımak zorunda; site kimliğini yazmak spawn'ı "disallowed command" ile öldürürdü.
  antigravity: 'agy', // ENG-22 — Antigravity CLI (antigravity.google, ölçüldü: 1.1.14)
  // ENGINE-MUSE-02 — Meta Muse Code. Site kimliği ile ikili adı AYNI (kurucu
  // script: `command_name="muse"`) → cursor/antigravity tuzağı burada YOK.
  // Motor `public.engines`te KAPALI: bu satır spawn'a İZİN verir, motoru AÇMAZ.
  muse: 'muse', // ENGINE-MUSE-02 — Muse Code (dev.meta.ai, ölçüldü: 1.0.3-R2198.1)
});

// Default argv per agent CLI. Mirrors how spawn-worker launches workers
// (`--dangerously-skip-permissions` so the in-app pane runs unattended, the
// same contract the bootstrap tmux runner uses). Used only when the caller does
// not supply its own (validated) args.
//
// ENG-07 — ARTIK ELLE LİSTE DEĞİL, DEFTERDEN TÜRETİLİR (`descriptor.defaultArgs`).
// Eskiden bu sabit R3 defteriydi ve descriptor'la SENKRON TUTULMASI gerekiyordu
// (drift testi köprü nöbetçisiydi); tek kaynak olunca sapma yapısal olarak imkânsız.
// Değerler bit-bit aynı: claude ['--dangerously-skip-permissions'], codex [].
const DEFAULT_AGENT_ARGS = Object.freeze(
  Object.fromEntries(
    engineRegistryModule
      .engineIds()
      .map((id) => [id, Object.freeze([...(engineRegistryModule.getEngine(id).defaultArgs || [])])]),
  ),
);

/**
 * Bu motorun varsayılan argv'si (çağıran kendi args'ını vermediyse). Defter ENJEKTE
 * edilebildiği için sabit değil FONKSİYON: sahte/eksik motorlu koşuda da doğru cevap.
 */
function defaultArgsFor(commandKey) {
  const d = engineRegistry.getEngine ? engineRegistry.getEngine(commandKey) : null;
  return d && Array.isArray(d.defaultArgs) ? [...d.defaultArgs] : [];
}

// ADP-037 — agent identity (system prompt) bound. Passed as ONE argv element
// (execvp, no shell → injection-safe); capped so a runaway/crafted identity can't
// bloat the command line.
//
// AD-WIN-02 — TAVAN ARTIK TAŞIYICIYA GÖRE. Bu sabit KOMUT SATIRI dalının tavanıdır
// (değişmedi: 8.000). Kimlik `--append-system-prompt-file` ile DOSYADAN gidiyorsa
// komut satırı duvarı devre dışıdır ve `systemPromptCap.FILE_MAX` kullanılır — aksi
// hâlde 9.005 karakterlik bir kimlik 8.000'de kesilir ve hafızaya hiç yer kalmaz
// (müşteride ÖLÇÜLDÜ; gerekçenin tamamı platform/systemPromptCap.cjs başlığında).
// Tek kaynak: livePaneRegistry de aynı modülden okur.
const MAX_SYSTEM_PROMPT_LEN = systemPromptCap.CLI_MAX;

// Bounds — args never reach a shell (node-pty exec is execvp-style, no
// interpolation), but we still cap count/length to keep the surface tiny.
const MAX_ARGS = 64;
const MAX_ARG_LEN = 8192;
const MAX_ENV_KEYS = 64;

// Pane activity → binding status threshold (ADP-014 bridge). A pane that has
// emitted bytes within this window reads as "working", otherwise "idle". Kept in
// sync with terminalActivity.ts IDLE_AFTER_MS so the office sprite and the
// binding agree.
const IDLE_AFTER_MS = 4000;

/** True for a command the renderer is allowed to ask for. */
function isAllowedCommand(command) {
  return Object.prototype.hasOwnProperty.call(ALLOWED_COMMANDS, command);
}

// ---------------------------------------------------------------------------
// ADP-048 — skip claude's interactive "workspace trust" dialog for agent panes.
// ---------------------------------------------------------------------------
// claude shows a one-time "Do you trust the files in this folder? 1.Yes 2.No"
// dialog on the FIRST interactive run in a directory; its Enter swallows the
// first message a user types. `--dangerously-skip-permissions` bypasses TOOL
// permission prompts but NOT this folder-trust dialog (claude --help: the trust
// dialog is only auto-skipped in non-interactive -p mode). The supported way to
// pre-accept it for an interactive session is the per-project flag claude itself
// persists: `~/.claude.json` → projects[<cwd>].hasTrustDialogAccepted = true.
// Eren approved auto-trust for these autonomous agent panes. Pure merge below is
// unit-tested; the fs wrapper is best-effort (failure → claude just shows the
// dialog, no crash).

// ADP-283 — a trust key must be the CANONICAL path. macOS `/var`, `/tmp` are symlinks
// into `/private/…`, and both CLIs canonicalize their cwd before looking the project up.
// Writing the un-resolved `/var/folders/…` key therefore trusts a path the CLI never
// asks about → the dialog still appears (probe-proven: every real `~/.claude.json` tmp
// key is `/private/var/…`). Resolve first; an unresolvable path degrades to itself.
function canonicalCwd(cwd) {
  try {
    return fs.realpathSync(cwd);
  } catch {
    return cwd;
  }
}

/** Pure: return a NEW config object with `cwd` marked trusted (merge, no clobber). */
function claudeTrustPatch(config, cwd) {
  const base = config && typeof config === 'object' ? config : {};
  const projects = base.projects && typeof base.projects === 'object' ? base.projects : {};
  const existing = projects[cwd] && typeof projects[cwd] === 'object' ? projects[cwd] : {};
  return {
    ...base,
    projects: {
      ...projects,
      [cwd]: { ...existing, hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true },
    },
  };
}

/** True if `cwd` is already marked trusted (lets callers skip a redundant write). */
function isClaudeTrusted(config, cwd) {
  return !!(
    config &&
    config.projects &&
    config.projects[cwd] &&
    config.projects[cwd].hasTrustDialogAccepted === true
  );
}

/**
 * Best-effort: ensure `~/.claude.json` marks `cwd` as trusted so an interactive
 * claude pane opens straight at the prompt (no trust dialog eating the first
 * message). Never throws — returns true if (now) trusted, false on any IO error.
 */
function ensureClaudeTrusted(cwd, homedir) {
  try {
    const home = homedir || os.homedir();
    const key = canonicalCwd(cwd); // ADP-283 — /var/… → /private/var/…
    const cfgPath = path.join(home, '.claude.json');
    let config = {};
    try {
      config = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    } catch {
      config = {}; // missing/corrupt → start fresh (claude will recreate the rest)
    }
    if (isClaudeTrusted(config, key)) return true;
    const next = claudeTrustPatch(config, key);
    fs.writeFileSync(cfgPath, JSON.stringify(next, null, 2));
    return true;
  } catch {
    return false; // degrade: claude shows the dialog, but the pane still works
  }
}

// ---------------------------------------------------------------------------
// ADP-283 — codex directory-trust pre-accept (the ADP-048 analogue).
// ---------------------------------------------------------------------------
// A codex pane in an untrusted cwd stops at "Do you trust the contents of this
// directory?" until a human presses Enter — the pane reads as dead, and the first
// dispatched prompt is swallowed (ADP-228 finding 1, screenshot 99-failure-state).
// `--dangerously-bypass-approvals-and-sandbox` does NOT skip it.
//
// PROBE RESULTS (codex-cli 0.144, real pty, fresh mkdtemp cwds):
//   • per-launch `-c projects."<cwd>".trust_level="trusted"` → dialog STILL shown.
//     The trust gate is evaluated BEFORE `-c` overrides are layered in, so the
//     ADP-227 "never persist, always -c" trick cannot work here.
//   • `[projects."<cwd>"] trust_level = "trusted"` in CODEX_HOME/config.toml →
//     NO dialog, composer ready. (Verified on an isolated CODEX_HOME copy.)
// So we persist, exactly like claude's `~/.claude.json` — the same Eren-approved
// auto-trust for autonomous agent panes. APPEND-ONLY: never rewrites or reorders the
// user's config; a re-spawn on a known cwd is a no-op (idempotent).
const CODEX_TRUST_ENTRY = (cwd) => `\n[projects.${JSON.stringify(cwd)}]\ntrust_level = "trusted"\n`;

/** Pure: is `cwd` already a trusted project in this config.toml text? */
function codexIsTrusted(toml, cwd) {
  if (typeof toml !== 'string') return false;
  const header = `[projects.${JSON.stringify(cwd)}]`;
  const at = toml.indexOf(header);
  if (at === -1) return false;
  // Only the section body (up to the next `[` at line start) may carry the level.
  const rest = toml.slice(at + header.length);
  const end = rest.search(/\n\[/);
  const body = end === -1 ? rest : rest.slice(0, end);
  return /trust_level\s*=\s*"trusted"/.test(body);
}

/** Pure: config.toml text with `cwd` appended as a trusted project (no-op if present). */
function codexTrustPatch(toml, cwd) {
  const base = typeof toml === 'string' ? toml : '';
  if (codexIsTrusted(base, cwd)) return base;
  return `${base.replace(/\s*$/, '')}\n${CODEX_TRUST_ENTRY(cwd)}`;
}

/** Where codex reads its config: $CODEX_HOME, else ~/.codex. */
function codexHomeDir(env, homedir) {
  const fromEnv = env && typeof env.CODEX_HOME === 'string' && env.CODEX_HOME.trim();
  return fromEnv ? env.CODEX_HOME : path.join(homedir || os.homedir(), '.codex');
}

/**
 * Best-effort: mark `cwd` trusted in codex's config.toml so an interactive codex pane
 * opens straight at the composer. Never throws — false on any IO error (the pane still
 * works, the operator just sees the dialog).
 */
function ensureCodexTrusted(cwd, env, homedir) {
  try {
    const key = canonicalCwd(cwd);
    const dir = codexHomeDir(env, homedir);
    const cfgPath = path.join(dir, 'config.toml');
    let toml = '';
    try {
      toml = fs.readFileSync(cfgPath, 'utf8');
    } catch {
      toml = ''; // missing → codex recreates the rest; our section is valid on its own
    }
    if (codexIsTrusted(toml, key)) return true;
    // PIPE-10 — `fs.mkdirSync(recursive:true)` DEĞİL. `dir` operatörün
    // CODEX_HOME'undan gelir; Linux'ta procfs benzeri bir hedefte node'un
    // özyineli mkdir'i SONSUZ DÖNGÜYE girer ve aşağıdaki `catch` onu
    // YAKALAYAMAZ ("hiç patlamaz" sessizce "hiç DÖNMEZ"e dönüşür — CI birim
    // adımı bu yüzden 60 sn timeout yiyordu). Bkz. platform/mkdirp.cjs.
    mkdirpSync(dir);
    fs.writeFileSync(cfgPath, codexTrustPatch(toml, key));
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// ENG-07 L2 — GÜVEN ÖN-KABULÜ TEK BOĞAZDAN (descriptor `trust`).
// ---------------------------------------------------------------------------
// Öncesi: iki motorun güven yazımı iki ayrı çağrı noktasıyla, motor ADINA göre
// tetikleniyordu (`if (plan.key === 'claude')` main.js'te, `if (resolved.key ===
// 'codex')` buildSpawn'da). Üçüncü bir motorda hiçbiri tetiklenmez ve pane TUI
// diyaloğunda ilk prompt'u yutar — SESSİZCE (ENG-R3 §2.1/§14-R1).
//
// Sonrası: yazıcılar FORMAT'a göre seçilir (`trust.kind`), motor adına göre değil.
// Yazıcının kendi dosya yolunu bilmesi (claude `~/.claude.json`, codex
// `$CODEX_HOME/config.toml`) korunuyor; descriptor `trust.file` alanı o yolun
// BEYANIdır ve drift testi ikisinin aynı şeyi söylediğini ölçer.
/**
 * ENG-13 — İLK KOŞU KAPISI: motorun ölçülmüş varsayılanlarını pane env'ine koyar.
 *
 * ÜÇ KURAL (hepsi ölçümden):
 *   1. KULLANICI KAZANIR — env'de değer VARSA dokunulmaz.
 *   2. KULLANICININ DOSYASI DA KAZANIR (`preferUser`) — motorun kendi config
 *      dosyasında anahtar geçiyorsa env'e YAZMAYIZ (goose'ta config anahtar adları
 *      env adlarıyla AYNI; kullanıcı "telemetriye evet" demişse ürün onu ezmez).
 *   3. DOSYA HİÇ YAZILMAZ — kullanıcının config'i salt-okunur kullanılır.
 * Dönen: en az bir değer uygulandıysa `true`. Asla throw etmez (okuma hatası =
 * "kullanıcı ayarı yok" ile aynı güvenli tarafa düşer → varsayılan uygulanır).
 */
function applyEngineEnvConsent(env, d, homedir) {
  if (!env || !d || !Array.isArray(d.entries) || !d.entries.length) return false;
  const home = homedir || os.homedir();
  const fromEnv = d.homeEnv && typeof env[d.homeEnv] === 'string' && env[d.homeEnv].trim()
    ? path.join(env[d.homeEnv].trim(), ...(d.homeSegments || []))
    : null;
  const root = fromEnv || path.join(home, ...(d.homeFallback || []));
  let cfgText = '';
  if (d.preferUser && d.configFile) {
    try { cfgText = fs.readFileSync(path.join(root, d.configFile), 'utf8'); } catch { cfgText = ''; }
  }
  let applied = 0;
  for (const entry of d.entries) {
    if (!entry || typeof entry.env !== 'string' || !entry.env) continue;
    if (typeof env[entry.env] === 'string' && env[entry.env].trim()) continue; // kural 1
    if (cfgText) {
      const safe = entry.env.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (new RegExp(`^\\s*${safe}\\s*:`, 'm').test(cfgText)) continue; // kural 2
    }
    env[entry.env] = String(entry.value);
    applied += 1;
  }
  return applied > 0;
}

/**
 * ENG-ENABLE-01 — DÖRDÜNCÜ GÜVEN ŞEKLİ: MOTORUN EV DİZİNİNDE BİR DURUM DOSYASI.
 *
 * ÖLÇÜLDÜ (gerçek pty, kimi 0.36.1 — `docs/agent-results/ENG-ENABLE-01-evidence/
 * kimi-pane.txt`): taze bir cwd'de interaktif pane "Trust this folder?" diyaloğu
 * açıyor ve İMLEÇ VARSAYILAN OLARAK "Don't trust — Exit Kimi Code" seçeneğinde
 * duruyor. Ürünün pane'e yazdığı ilk metin diyaloğa gidiyor, Enter ÇIKIŞI seçiyor
 * ve pane 21 saniyede "Bye!" deyip ölüyor — ENG-15'in "kimi açılışta ölüyor"
 * hükmünün BUGÜNKÜ sebebi budur (eski sebep — kimlik metninin dosya-yolu bayrağına
 * verilmesi — ENG-21 G5'te kapanmıştı, argv artık doğru).
 *
 * Motorun `--trust` dengi bir BAYRAĞI YOK (tam `--help` seçenek listesi ölçüldü),
 * yani bu kapı yalnız dosya yazarak geçilir. Kararın yaşadığı yer ikiliden okundu:
 *   `<home>/workspace-trust/wd_<slug(basename)>_<sha256(mutlak yol).slice(0,12)>`
 *   gövde: `{"root":"<mutlak yol>","trustedAt":<ms>}`
 * (`slug`: küçük harf, `[^a-z0-9._-]+` → `-`, baş/son `-` atılır, 40 karakter;
 * boş/`.`/`..` → `workspace`.)
 *
 * 🔒 KULLANICININ DAMGASI EZİLMEZ: dosya zaten varsa DOKUNULMAZ (kendi `trustedAt`i
 * korunur). Karar ENG-20 tam-onay paritesinin bu motordaki tek gramerdeki karşılığı:
 * cursor'da `--trust`, claude'da `.claude.json`, kimi'de bu dosya.
 */
function ensureStateFileTrusted(cwd, env, homedir, d) {
  if (!cwd || !d || !d.dir) return false;
  const home = homedir || os.homedir();
  const root =
    d.homeEnv && env && typeof env[d.homeEnv] === 'string' && env[d.homeEnv].trim()
      ? env[d.homeEnv].trim()
      : path.join(home, ...(d.homeFallback || []));
  try {
    const abs = path.resolve(cwd);
    const slug =
      path
        .basename(abs)
        .toLowerCase()
        .replace(/[^a-z0-9._-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 40)
        .replace(/^-+|-+$/g, '') || 'workspace';
    const safeSlug = slug === '.' || slug === '..' ? 'workspace' : slug;
    const hash = crypto.createHash('sha256').update(abs).digest('hex').slice(0, 12);
    const dir = path.join(root, d.dir);
    const file = path.join(dir, `${d.keyPrefix || 'wd_'}${safeSlug}_${hash}`);
    if (fs.existsSync(file)) return true; // kullanıcı zaten güvenmiş — damgasını ezme
    fs.mkdirSync(dir, { recursive: true });
    winSafeAtomicWrite(file, JSON.stringify({ root: abs, trustedAt: Date.now() }));
    return true;
  } catch {
    // Yazamazsak pane yine açılır ve diyalog görünür — sessiz değil, GÖRÜNÜR bir arıza.
    return false;
  }
}

const TRUST_WRITERS = Object.freeze({
  json: (cwd, env, homedir) => ensureClaudeTrusted(cwd, homedir), // merge (kullanıcı alanları korunur)
  'toml-append': (cwd, env, homedir) => ensureCodexTrusted(cwd, env, homedir), // append-only
  // ENG-ENABLE-01 — motorun ev dizinindeki DURUM DOSYASI (kimi). `homeScope:'engine-home'`
  // olduğu için yazım buildSpawn içinde olur: dizini hesap profili (ADP-936) belirler.
  'state-file': (cwd, env, homedir, d) => ensureStateFileTrusted(cwd, env, homedir, d),
  // ENG-13 — DOSYA DEĞİL ENV yazan kapı (goose): motorun İLK KOŞU diyaloğu
  // (telemetri onayı) pane'in İLK PROMPT'UNU yutuyor (gerçek pty'de ölçüldü) —
  // ADP-283'ün claude/codex'te kapattığı arızanın aynısı. Kapatma yolu kullanıcının
  // config dosyasını YAZMAK değil, pane env'ine ölçülmüş varsayılanı koymaktır.
  'env-consent': (cwd, env, homedir, d) => applyEngineEnvConsent(env, d, homedir),
});

/**
 * `cwd`u bu motorun güven defterinde ONAYLI yap. Yeteneği/yazıcısı olmayan motorda
 * `false` (kayıp `unsupported.trust`ta GÜVENLİK seviyesinde beyanlı — sessiz değil).
 * Asla throw etmez: yazıcılar best-effort (yazamazsa pane açılır, diyalog görünür).
 */
function ensureEngineTrusted(engineId, cwd, env, homedir) {
  const d = engineCapability(engineId, 'trust');
  if (!d) return false;
  const writer = TRUST_WRITERS[d.kind];
  if (!writer) return false;
  return writer(cwd, env, homedir, d); // ENG-13 — env yazan kapılar BEYANI da okur
}

/**
 * Güven yazımı SPAWN KURULUMU sırasında mı yapılmalı? Yalnız dosya MOTORUN ev
 * dizinindeyse (`trust.homeScope === 'engine-home'`): o dizini hesap profili
 * (ADP-936) belirler ve profil env'i buildSpawn içinde çözülür. Kullanıcı ev
 * dizinindeki defterler (claude) çağırana bırakılır — pty'yi doğurmadan hemen
 * önceki an — ki `buildSpawn` saf-yakın kalsın (birim testleri gerçek `~/.claude.json`a
 * yazmaz; ölçüldü: codex yolu bu yüzden gerçek ~/.codex'e satır ekliyor).
 */
function trustWritesAtSpawn(engineId) {
  const d = engineCapability(engineId, 'trust');
  return !!(d && d.homeScope === 'engine-home');
}

/**
 * ENG-07 L2 — bu spawn için güven durumu: hangi FORMAT, burada mı yazıldı, çağıranın
 * yazması gerekiyor mu? `pending:true` gören çağıran `ensureEngineTrusted`ı çağırır.
 * Motorun güven yeteneği yoksa `null` (beyan `capabilities.unsupported`ta).
 */
function planEngineTrust(engineId, cwd, env, homedir) {
  const d = engineCapability(engineId, 'trust');
  if (!d) return null;
  if (trustWritesAtSpawn(engineId)) {
    return { kind: d.kind, homeScope: d.homeScope, applied: true, ok: ensureEngineTrusted(engineId, cwd, env, homedir), pending: false };
  }
  return { kind: d.kind, homeScope: d.homeScope || 'user-home', applied: false, ok: null, pending: true };
}

/**
 * Resolve a requested command to a spawn target.
 * - undefined/null/'shell' → the login shell (agent=false).
 * - a whitelisted agent key → that binary (agent=true).
 * - anything else → THROW (RCE guard).
 */
function resolveCommand(command, deps = {}) {
  if (command === undefined || command === null || command === 'shell') {
    const platform = deps.platform || process.platform;
    const env = deps.env || process.env;
    // ADP-833 (790 M6) — KONTROL SIRASI: win32 dalı `SHELL`'DEN ÖNCE gelir.
    // Eskiden `SHELL` önce okunuyordu; Windows'ta Git-Bash/WSL kurulumları bu
    // değişkeni POSIX bir yola set eder (`/usr/bin/bash`) → o yol `pty.spawn`a
    // gider ve pane HİÇ AÇILMAZ. Windows'ta kabuğu env değil platform belirler.
    // macOS'ta sıra AYNEN korunur: kullanıcının `SHELL` tercihi (fish/bash) kazanır.
    if (platform === 'win32') {
      return { key: 'shell', file: holderShell.powershellPath(env), isAgent: false };
    }
    return { key: 'shell', file: env.SHELL || 'zsh', isAgent: false };
  }
  if (typeof command !== 'string' || !isAllowedCommand(command)) {
    throw new Error(`pty:spawn rejected disallowed command: ${JSON.stringify(command)}`);
  }
  return { key: command, file: ALLOWED_COMMANDS[command], isAgent: true };
}

/**
 * Sanitize an agent identity / system-prompt string: must be a non-empty string,
 * trimmed and length-capped. Returns null for anything unusable (→ no injection).
 * Content is never shell-interpolated (it's one execvp argv element), so no escaping
 * is needed — only the bound matters.
 *
 * AD-WIN-02 — `cap` opsiyoneldir ve VARSAYILANI DEĞİŞMEDİ (komut satırı tavanı, 8.000).
 * Metin dosyadan gidiyorsa çağıran `systemPromptCap.FILE_MAX` geçer.
 */
function sanitizeSystemPrompt(text, cap = MAX_SYSTEM_PROMPT_LEN) {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;
  return systemPromptCap.clampSystemPrompt(trimmed, cap);
}

// ---------------------------------------------------------------------------
// ADP-565 (564 tasarımı) — GÖREV-BAŞINA MODEL kontrolü: spawn'da `--model`.
// ---------------------------------------------------------------------------
// KÖK NEDEN (ADP-564): `--model` HİÇ geçilmiyordu → yeni pane motorun config
// VARSAYILAN modelini koşuyordu; reuse edilen canlı pane ise başlangıç argv'sini
// (dolayısıyla modelini) taşıyordu (delegation.ts:734). İki motor da başlatırken
// model seçimini `--model` ile destekliyor (KANITLI, ADP-564 §1):
//   • claude `--model <alias|id>`  (alias: fable/opus/sonnet/haiku; tam id: claude-*)
//   • codex  `-m, --model <MODEL>` (gpt-5.6-sol vb.)
// Değer bizim politikamız/roster'ımızdan gelir (renderer'ın ham girdisi değil), ama
// yine de BİÇİM doğrulanır: tek token, boşluk/shell-meta YOK — execvp tek argv
// olduğundan enjeksiyon riski zaten yok, bu sadece kusurlu değeri sessizce düşürmek
// için (garip değer → `--model` EKLENMEZ → bugünkü davranış, geriye uyumlu).
const MAX_MODEL_LEN = 64;

/**
 * Bir model adını/id'sini normalize + biçim-whitelist et. Kabul: alias (opus) veya
 * tam id (claude-opus-4-8, gpt-5.6-sol), opsiyonel `[1m]` gibi varyant soneki.
 * Boşluk/geçersiz karakter/aşırı uzunluk → null (→ withModel no-op → `--model` yok).
 * Değer VERBATIM döner (büyük/küçük harfe dokunulmaz — CLI'lar ikisini de kabul eder).
 */
function sanitizeModel(value, commandKey) {
  if (typeof value !== 'string') return null;
  const t = value.trim();
  if (!t || t.length > MAX_MODEL_LEN) return null;
  // ENG-OPENCODE-PROVIDER-01 — BİÇİM DESCRIPTOR'DAN. Varsayılan kural tek token'dır
  // (claude/codex); `provider/model` isteyen motor (opencode: `gx10/qwen3-coder:30b`)
  // bunu `model.valuePattern` ile BEYAN eder. Beyan olmayan motorda / motor
  // verilmediğinde eski kural bit-bit sürer. Neden şart: beyansız bir `/` düşüşü
  // `--model`i SESSİZCE siler ve motor varsayılan sağlayıcıya koşar (§6-B sınıfı).
  const d = commandKey ? engineCapability(commandKey, 'model') : null;
  const pattern = d && typeof d.valuePattern === 'string' && d.valuePattern.trim() ? d.valuePattern : null;
  if (pattern) {
    let re;
    try {
      re = new RegExp(pattern);
    } catch {
      return null; // bozuk beyan = kapalı kapı (şema testi zaten kırmızı olur)
    }
    // Ne olursa olsun: boşluk/kontrol karakteri yok, `..` yok, `-` ile başlayan parça yok
    // (bayrak sanılır), tek eğik çizgi (yol gibi görünen değer argv'ye girmez).
    if (/[\s\u0000-\u001f]/.test(t) || /(^|\/)\.\.(\/|$)/.test(t) || /(^|\/)-/.test(t)) return null;
    return re.test(t) ? t : null;
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*(?:\[[A-Za-z0-9]+\])?$/.test(t)) return null;
  return t;
}

/**
 * Resolved agent argv'sine model bayrağını ekle. ENG-07 — bayrağın kendisi de konumu
 * da DESCRIPTOR'dan gelir (`model: {kind:'flag', flag, position}`); iki kayıtlı motorda
 * bu `--model <val>` (append) demektir, yani davranış birebir korunur. Yeteneği
 * OLMAYAN motor (`model:null`) / shell / kullanılamaz model → no-op; kayıp sessiz
 * değil, `unsupported.model` gerekçesiyle beyanlıdır.
 */
function withModel(argv, commandKey, model) {
  const m = sanitizeModel(model, commandKey);
  if (!m) return argv;
  const d = engineCapability(commandKey, 'model');
  if (!d || d.kind !== 'flag' || !d.flag) return argv;
  return applyArgs(argv, [d.flag, m], d.position);
}

// ---------------------------------------------------------------------------
// CDX-F1 (CDX-R1 H1) — GÖREV-BAŞINA EFOR (akıl-yürütme seviyesi).
// ---------------------------------------------------------------------------
// KÖK NEDEN (ölçüldü): ürün codex'in KALİTE KOLUNU hiç çekmiyordu → her codex pane'i
// kullanıcının `~/.codex/config.toml` varsayılanıyla (bu makinede "low") koşuyordu.
// `withModel` ile AYNI BOĞAZ: bayrak da gramer de konum da DESCRIPTOR'dan gelir
// (`effort: {kind, flag, key?, values, position}`), motor adına göre dal YOK.
//
// 🪤 BEYAZ LİSTE ŞART (ölçüldü, codex-cli 0.147.0): motor değeri DOĞRULAMAZ — başlığa
// aynen basar ve isteği yollar; `minimal`/`bogus` gibi bir değer turu API ERROR'u ile
// ÖLDÜRÜR. Değer renderer'dan gelebildiği için (`opts.effort`) descriptor'ın
// `values` kümesi dışındaki her şey SESSİZCE DÜŞER → bayrak eklenmez → bugünkü davranış.

/**
 * Bir efor değerini motorun descriptor'ındaki beyaz listeye göre normalize et.
 * Eşleşme büyük/küçük harf duyarsız ama dönen değer LİSTEDEKİ yazımdır (motora
 * uydurma bir yazım gitmez). Descriptor yok / değer listede yok → `null`.
 */
function sanitizeEffort(value, descriptor) {
  if (typeof value !== 'string') return null;
  const t = value.trim().toLowerCase();
  if (!t) return null;
  const values = descriptor && Array.isArray(descriptor.values) ? descriptor.values : [];
  return values.find((v) => typeof v === 'string' && v.toLowerCase() === t) || null;
}

/**
 * Bu spawn'da GERÇEKTEN uygulanacak efor değeri (yoksa `null`). Tek boğaz: hem argv'yi
 * kuran `withEffort` hem `buildSpawn`ın dönüş kaydı bunu kullanır ki rozet İDDİA değil
 * ÖLÇÜM göstersin (bir yer bayrağı eklerken diğeri başka bir değer raporlayamaz).
 */
function resolveEffort(commandKey, effort, model) {
  const d = engineCapability(commandKey, 'effort');
  const v = sanitizeEffort(effort, d);
  if (!v) return null;
  // AGY-05 — MODEL-KAPSAMLI İKİNCİ SÜZGEÇ. Taşıyıcının `values`ı motorun kabul
  // ettiği DEĞER KÜMESİDİR; bazı motorlarda o kümenin geçerliliği SEÇİLİ MODELE
  // bağlıdır ve motor bunu KENDİ doğrular:
  //   agy 1.2.2 → `--model gemini-3.1-pro --effort medium`
  //               "invalid model selection … has no \"medium\" effort" + exit 1
  // Yani codex'te "sessizce düşen" bir değer burada PANE'İ ÖLDÜRÜR. Kısıt descriptor'ın
  // `catalog` adresinden (liste modülü) okunur — motor adına göre `if` YOK; `catalog`
  // beyan etmeyen motorda bu blok HİÇ koşmaz ⇒ bugünkü davranış bit-bit korunur.
  if (!d.catalog) return v;
  const allowed = modelCatalog.effortValuesFor(commandKey, sanitizeModel(model, commandKey), d.values);
  return allowed.some((a) => a.toLowerCase() === v.toLowerCase()) ? v : null;
}

/**
 * Resolved agent argv'sine efor bayrağını ekle. İki gramer, tek uygulayıcı:
 *   • `kind:'flag'`         → `[flag, value]`            (claude `--effort high`)
 *   • `kind:'cli-override'` → `[flag, key="value"]`      (codex `-c model_reasoning_effort="high"`)
 * Yeteneği OLMAYAN motor (`effort:null`) / shell / listede olmayan değer → NO-OP;
 * kayıp sessiz değil, `unsupported.effort` gerekçesiyle beyanlıdır.
 */
function withEffort(argv, commandKey, effort, model) {
  const d = engineCapability(commandKey, 'effort');
  if (!d || !d.flag) return argv;
  // AGY-05 — TEK BOĞAZ: beyaz liste + model-kapsamlı kısıt AYNI fonksiyondan geçer
  // (`resolveEffort`). İki ayrı süzgeç yazmak, buildSpawn'ın RAPORLADIĞI değerle
  // argv'ye BASILAN değerin ıraksaması demekti — rozet iddia olurdu, ölçüm değil.
  const v = resolveEffort(commandKey, effort, model);
  if (!v) return argv;
  if (d.kind === 'cli-override') {
    if (!d.key) return argv;
    return applyArgs(argv, [d.flag, `${d.key}=${tomlBasicString(v)}`], d.position);
  }
  if (d.kind === 'flag') return applyArgs(argv, [d.flag, v], d.position);
  return argv;
}

/**
 * ADP-580 — register + SELECT a custom AI provider (Groq/DeepSeek/Kimi) for a CODEX
 * launch via per-launch `-c model_provider=…` overrides (providers.cjs is the single
 * source of the base_url/env_key/wire_api grammar). PREPENDED (like the ADP-227 MCP
 * overrides) so codex's positional identity PROMPT stays the LAST argv element.
 * No-op for claude/shell, an unknown/blank provider, or when the effective model is
 * absent (a provider without a model would just run its own default — nothing to
 * point at). Codex-only: claude has no equivalent seam here.
 *
 * The provider config is emitted even when the key env is missing — codex then fails
 * with a clear auth error rather than us silently swallowing the request; the key is
 * bound separately (main-side, from settings) so the secret never rides in `opts`.
 */
function withProvider(argv, commandKey, providerId, model, custom) {
  // ENG-07 — "codex mü?" DEĞİL, "bu motor sağlayıcı seçimini destekliyor mu?".
  // Gramer descriptor'da beyanlı (`provider.grammar = electron/providers.cjs`);
  // yeteneği olmayan motorda (claude: `unsupported.provider`) no-op.
  //
  // ENG-OPENAI-COMPAT-01 — `custom`: kullanıcının KENDİ OpenAI-uyumlu ucu
  // (main-only, `trusted` üzerinden gelir). Verilmezse davranış BİREBİR bugünkü.
  const d = engineCapability(commandKey, 'provider');
  if (!d || d.kind !== 'cli-overrides') return argv;
  if (!providers.isProvider(providerId, custom)) return argv;
  if (!sanitizeModel(model, commandKey)) return argv; // provider without a model → no-op (config default)
  return applyArgs(argv, providers.codexProviderArgs(providerId, custom), d.position);
}

/**
 * ENG-IMG-01 — attach image files to codex CLI via `-i <path> -i <path>…` flags.
 * Each image is a separate `-i` flag followed by the file path. No-op for claude
 * (images are appended to the prompt text by the caller via composePromptWithImages)
 * or shell panes. Prepended so the positional identity prompt stays last.
 *
 * 🔴 ENG-03 — ÖLÇÜLEN ARIZA: codex'te `-i` VARIADIC'tir (`-i, --image <FILE>...`), yani
 * kendisinden sonra gelen TÜM konumsal sözcükleri yutar. Bu fonksiyon argv'yi kimlikten
 * ÖNCE kurduğu için üretilen dizi `… -i /tmp/a.png <KİMLİK PROMPT'U>` oluyordu → codex
 * kimliği İKİNCİ BİR GÖRSEL YOLU sanıyor, prompt hiç ulaşmıyordu. Gerçek CLI ile ölçüm
 * (codex-cli 0.147.0):
 *     codex exec -i red.png "rengi ne?"     → "Reading prompt from stdin… No prompt provided"
 *     codex exec -i red.png -- "rengi ne?"  → "Kırmızı"  ✅
 * Bu yüzden görsel listesi `--` ile KAPATILIR (bkz. `terminateImageList`), böylece
 * ardından gelen konumsal prompt konumsal kalır.
 */
function withImages(argv, commandKey, imagePaths) {
  // ENG-07 — bayrak/konum/tekrar şekli descriptor'dan (`images: {flag,repeat,position}`).
  // claude'da `images: null` (görseller prompt METNİNE gömülür) → no-op, ama beyanlı.
  const d = engineCapability(commandKey, 'images');
  if (!d || d.kind !== 'flag' || !d.flag) return argv;
  const flags = repeatFlagArgs(d.flag, imagePaths, d.repeat);
  return flags.length ? applyArgs(argv, flags, d.position) : argv;
}

/**
 * ENG-03 — codex görsel listesini (`-i <yol> …`) `--` ile KAPAT, ama YALNIZ listenin
 * hemen ardından bir KONUMSAL sözcük (prompt) geliyorsa. Saf + argv'nin son hâli üstünde
 * çalışır; `--` zaten varsa ya da listeden sonra bir bayrak geliyorsa (bayrak variadic
 * listeyi kendisi sonlandırır) DOKUNMAZ → bugünkü görselsiz argv birebir korunur.
 */
function terminateImageList(argv, commandKey) {
  // ENG-07 — "variadic mi, kapatıcısı ne?" descriptor'da beyanlı
  // (`images.variadic`/`images.terminator`/`images.aliases`); ölçüm codex 0.147.
  const d = engineCapability(commandKey, 'images');
  if (!d || !d.variadic || !d.terminator || !Array.isArray(argv)) return argv;
  if (argv.includes(d.terminator)) return argv; // zaten kapalı
  const tokens = [d.flag, ...(Array.isArray(d.aliases) ? d.aliases : [])];
  let last = -1;
  for (let i = 0; i < argv.length; i += 1) {
    if (tokens.includes(argv[i])) last = i;
  }
  if (last < 0) return argv;
  const after = last + 2; // -i <yol> → ilk sonraki sözcük
  if (after >= argv.length) return argv; // liste zaten argv'nin sonunda, yutacak bir şey yok
  const next = argv[after];
  if (typeof next === 'string' && next.startsWith('-')) return argv; // bayrak listeyi sonlandırır
  return [...argv.slice(0, after), d.terminator, ...argv.slice(after)];
}

/**
 * Append the identity to a resolved agent argv per engine:
 *   • claude → `--append-system-prompt <identity>` (proven flag; ADDS to the
 *     default Claude Code system prompt, keeping its tools/coding behavior).
 *   • codex  → identity as the initial positional PROMPT (codex has no
 *     system-prompt flag — graceful fallback: it states its identity first).
 * No-op when there is no usable identity.
 *
 * AD-WIN-01 — `promptSink` (opsiyonel, YALNIZ claude): kimliği KOMUT SATIRINDAN
 * çıkarır. Verilirse metin bir dosyaya yazılır ve `--append-system-prompt-file <yol>`
 * kullanılır. Sink `null` döndürürse (ya da hiç verilmezse) bugünkü satır-içi bayrak
 * BİREBİR korunur → macOS davranışı değişmez. Neden gerekli: Windows'ta motor
 * `claude.cmd` ise argv cmd.exe sarmalayıcısına girer ve 8.191 karakterlik tavan
 * 8.520'de aşılır (ölçüm: scripts/win/adWin01CmdLineProof.cjs) → süreç HİÇ doğmaz.
 * Semantik AYNI: ikisi de PER-LAUNCH append'tir, `--resume` hiçbirini geri getirmez
 * (ADP-276) — yani bu değişiklik resume yolunu ETKİLEMEZ.
 */
/**
 * IDN-BUDGET-01 — kimlik metni GERÇEK taşıyıcının tavanını aşıyorsa log'a düş.
 * `sanitizeSystemPrompt` kuyruktan kör keser ve kesilen yer kimliğin MÜHRÜ olur;
 * bu yol normalde ulaşılmaz (metin taşıyıcı tavanına örülür) ama ulaşıldığında
 * SESSİZ kalmamalı. Yalnız gözlem — davranışı değiştirmez.
 */
function warnIdentityClamp(text, commandKey, promptSink, log) {
  if (typeof log !== 'function' || typeof text !== 'string') return;
  const carrier = identityCarrier(commandKey, promptSink);
  const cap = systemPromptCap.systemPromptCap(carrier);
  if (text.length <= cap) return;
  log(
    `spawn kimliği KIRPILDI (${commandKey}): ${text.length} ch > ${carrier} tavanı ${cap} → ` +
      `kuyruktan ${text.length - cap} ch kesiliyor (kimlik mührü/son bölümler risk altında)`,
  );
}

function withIdentity(argv, commandKey, systemPrompt, promptSink, platform = process.platform, cwd = null) {
  const d = engineCapability(commandKey, 'identity');
  // ENG-07 — kimliğin TAŞIYICI ÇEŞİTLERİ descriptor'da: 'flag' (claude, opsiyonel
  // `fileFlag` dosya taşıyıcısı) · 'positional' (codex, argv'nin SONU) · 'env-file'
  // /'project-file' (gelecek motorlar için ŞEMADA hazır, bugün kayıt YOK) · 'none'.
  // Yeteneği olmayan/bilinmeyen motor → no-op, ama `unsupported.identity` GÜVENLİK
  // seviyesinde beyanlıdır (kimliksiz ajan protokolünü uygulamaz — ENG-R3 §2.2-1).
  if (!d) return argv;
  // AD-WIN-02 — TAVAN TAŞIYICIYA GÖRE: sink VARSA metin dosyaya gidecek, yani komut
  // satırı duvarı devre dışıdır → geniş tavanla temizle. Sink `null`/`throw` dönerse
  // satır-içi bayrağa düşülür ve metin O ANDA komut satırı tavanına GERİ kırpılır
  // (yoksa 8.191'lik cmd.exe duvarına 32 K'lık bir argv gönderirdik — AD-WIN-01'in
  // kapattığı arızanın ta kendisi). Dosya taşıyıcısı OLMAYAN motorda (codex) sink
  // yok sayılır — descriptor `fileFlag: null` + `cap.file: null` diyor.
  const hasSink = identityUsesFileCarrier(commandKey, promptSink);
  const sys = sanitizeSystemPrompt(systemPrompt, systemPromptCap.systemPromptCap(hasSink ? 'file' : 'cli'));
  if (!sys) return argv;
  // LEAD-BEHAV-01 — POSIX'te dosya taşıyıcısı YALNIZ TAŞMADA. Sığan metin bugünkü
  // satır-içi bayrakla gider (ps'e dayanan e2e'ler + bit-bit davranış korunur);
  // yalnız CLI tavanını aşan pane dosyadan gider ve KIRPILMAZ.
  const useFile =
    hasSink &&
    (!identityFileCarrierIsOverflowOnly(platform) || !(d.cap && d.cap.cli) || sys.length > systemPromptCap.CLI_MAX);
  if (d.kind === 'flag' && d.flag) {
    if (useFile) {
      let filePath = null;
      try {
        filePath = promptSink(sys);
      } catch {
        filePath = null; // kimlik dosyası yazılamadı → satır-içi bayrağa düş
      }
      if (typeof filePath === 'string' && filePath) {
        // ENG-21 (G5) — DOSYA BAYRAĞININ ADI DESCRIPTOR'DAN. İki şekil var:
        //   • `fileFlag` ayrı bir bayraktır (claude: `--append-system-prompt-file`),
        //   • `fileFlag` YOKSA ve `cap.cli === null` ise BAYRAĞIN KENDİSİ yol alır
        //     (kimi: `--agent-file <yol>` — satır-içi metni KABUL ETMEZ).
        // Eskiden burada claude'un bayrağı sabit yedekti; kimi o yedeği hiç görmedi
        // çünkü `identityUsesFileCarrier` `fileFlag` yoksa false diyordu ve metin
        // satır-içi gidiyordu → motor metni bir YOL sanıp açılışta ölüyordu.
        return applyArgs(argv, [identityFileFlagName(d), filePath], d.position);
      }
      // Sink düştü → aşağıdaki ortak satır-içi yola. Bayrak metin ALMIYORSA
      // (`cap.cli: null`) o yol da kapalıdır; hemen aşağıda tek yerde kontrol edilir.
      if (d.cap && d.cap.cli) {
        return applyArgs(argv, [d.flag, systemPromptCap.clampSystemPrompt(sys, MAX_SYSTEM_PROMPT_LEN)], d.position);
      }
      return argv;
    }
    // ENG-21 (G5) — SATIR-İÇİ TAŞIMA HER MOTORDA MEŞRU DEĞİL. Descriptor
    // `cap.cli: null` diyorsa bayrak METİN KABUL ETMEZ; oraya metin yazmak motoru
    // ÖLDÜRÜR (ölçüldü: kimi → `failed to run prompt: Failed to read agent file
    // "<KİMLİK METNİNİN TAMAMI>"`). Doğru davranış KİMLİKSİZ ama ÇALIŞAN pane'dir:
    // kimliği yanlış biçimde vermek, hiç vermemekten kötüdür (fail-closed).
    if (!(d.cap && d.cap.cli)) return argv;
    return applyArgs(argv, [d.flag, sys], d.position);
  }
  // ─────────────────────────────────────────────────────────────────────────
  // ENG-ENABLE-01 — DÖRDÜNCÜ TAŞIYICI: BAYRAK → DİZİN → MOTORUN DAYATTIĞI DOSYA ADI
  //
  // ENG-22 bu şekli ÖLÇMÜŞ ama "ürün gramerinde yok" diyerek antigravity'yi KAPALI
  // bırakmıştı. Şekil şudur: motorun kimlik bayrağı bir DOSYA değil bir DİZİN alır
  // (`--add-dir <dizin>`) ve kimliği o dizindeki SABİT ADLI dosyadan (`AGENTS.md`)
  // okur. `kind:'flag'` yazmak metni/yolu bayrağa gönderirdi; ikisi de yanlış.
  //
  // CANLI ÖLÇÜM (2026-09-09, ENG-ENABLE-01-evidence/):
  //   • cursor-agent 2026.09.02 — AYNI cwd'de iki koşu, iki AYRI `--add-dir` dizini
  //     → "ALFA7" ve "BETA9" (ENG-17'nin "aynı dizinde iki pane iki AYRI kimlik
  //     ALAMAZ" hükmü ÇÜRÜDÜ) ve cwd'deki proje `AGENTS.md`i KORUNDU (ajan ikisini
  //     birden saydı: "GAMMA3, BETA9") ⇒ taşıyıcı ADDITIVE, REPLACE tuzağı YOK.
  //   • agy 1.1.28 — kimlik okundu (DELTA5) ve 🪤 ARAÇLARIN ÇALIŞMA DİZİNİ İLK
  //     `--add-dir`E KAYDI (`pwd` = kimlik dizini!). Düzeltme ÖLÇÜLDÜ: iş dizini
  //     ÖNCE verilince `pwd` = iş dizini VE kimlik yine okundu. Bu yüzden
  //     `identity.cwdFirst` bir BEYANDIR — sırayı motor dayatır, ürün uydurmaz.
  //
  // Sink düşerse (IO hatası) kimlik VERİLMEZ: kimliksiz ama çalışan pane, yanlış
  // dizinde koşan bir pane'den iyidir (fail-closed — ENG-21 G5 dersi).
  if (d.kind === 'flag-dir' && d.flag) {
    let dirPath = null;
    try {
      dirPath = typeof promptSink === 'function' ? promptSink(sys) : null;
    } catch {
      dirPath = null;
    }
    if (typeof dirPath !== 'string' || !dirPath) return argv;
    const extra = [];
    if (d.cwdFirst && typeof cwd === 'string' && cwd) extra.push(d.flag, cwd);
    extra.push(d.flag, dirPath);
    return applyArgs(argv, extra, d.position);
  }
  // Pozisyonel taşıyıcı: kimlik argv'nin SON elemanı olmak zorunda (`position:'last'`)
  // — bu yüzden `-c`/`-i` katkıları hep PREPEND edilir (ENG-R3 §2.1).
  if (d.kind === 'positional') return [...argv, sys];
  return argv;
}

/**
 * LEAD-BEHAV-01 — DOSYA TAŞIYICISININ "YALNIZ TAŞMADA" KİPİ (POSIX).
 *
 * AD-WIN-01'in sink'i win32'de HER claude pane'inde kullanılır; amacı cmd.exe'nin
 * 8.191 karakterlik komut satırı duvarını aşmaktır. POSIX'te ARG_MAX 1 MB, yani
 * duvar yok — ama ÖLÇÜLDÜ (LEAD-BEHAV-01, `m4-prompt-truncation.txt`): ofis
 * tıklamasıyla açılan bir LİDER pane'inin sistem promptu 9.732 karakter ve
 * `CLI_MAX = 8.000` tavanı onu CÜMLE ORTASINDAN kesiyordu:
 *   "…her worker'ı bu uygulamada KENDİ pan"   ← delegasyon talimatı yarım kaldı
 * Kesilen 1.732 karakterin içinde `LEADER_STATUS_DISCIPLINE`, `LEADER_SUMMARY_
 * INSTRUCTION`, rapor kültürü ve kimlik mührü vardı. `buildAgentIdentity` kendi
 * 8.000'lik bütçesine uyuyor; kaybı yapan şey ONUN ÜSTÜNE eklenen sarmalayıcılar
 * (ofis guard'ı + entegrasyon protokolü, +1.775 karakter) ve taşıma tavanıydı.
 *
 * Bu yüzden POSIX'te dosya taşıyıcısı yalnız metin tavanı AŞTIĞINDA devreye girer:
 * sığan her pane bugünkü satır-içi `--append-system-prompt` bayrağını BİT-BİT korur
 * (ps çıktısına dayanan e2e'ler dahil), taşan pane ise kırpılmadan dosyadan gider.
 * win32 davranışı DEĞİŞMEZ (orada her zaman dosya).
 */
function identityFileCarrierIsOverflowOnly(platform = process.platform) {
  return platform !== 'win32';
}

/**
 * ENG-07 — kimlik DOSYA taşıyıcısıyla mı gidiyor? İki koşul: motorun `fileFlag`i VAR
 * (descriptor) ve çağıran bir sink verdi (AD-WIN-01, `trusted.promptFile`). Tek boğaz:
 * `withIdentity` ile `composeSpawnIdentity`in bütçesi AYNI cevabı kullanmak zorunda,
 * yoksa metin bir tavana göre kırpılıp başka bir taşıyıcıyla gönderilirdi.
 */
function identityUsesFileCarrier(commandKey, promptSink) {
  if (typeof promptSink !== 'function') return false;
  const d = engineCapability(commandKey, 'identity');
  // ENG-ENABLE-01 — `flag-dir` her zaman DOSYA taşıyıcısıdır (satır-içi yolu YOK).
  if (d && d.kind === 'flag-dir' && d.flag) return true;
  if (!(d && d.kind === 'flag' && d.flag && d.cap && d.cap.file)) return false;
  // `fileFlag` VARSA dosya bir SEÇENEKtir (claude). YOKSA ve satır-içi kapasite
  // beyan edilmemişse (`cap.cli: null`) dosya tek yoldur (kimi) — ENG-21 G5.
  return !!d.fileFlag || !d.cap.cli;
}

/**
 * ENG-21 (G5) — kimliği YALNIZ DOSYADAN alan bayrak taşıyıcısı mı?
 * (`identity.kind:'flag'` + `cap.cli:null` + `cap.file` dolu → kimi `--agent-file`.)
 * Bu motorda sink OPSİYONEL DEĞİLDİR: yoksa kimlik hiç verilemez.
 */
function identityFlagIsFileOnly(commandKey) {
  const d = engineCapability(commandKey, 'identity');
  // ENG-ENABLE-01 — `flag-dir` (cursor/antigravity) da sink ZORUNLUSUDUR: bayrak bir
  // DİZİN alır ve kimlik o dizindeki sabit adlı dosyadan okunur; sink yoksa kimlik
  // hiç verilemez. Fark yalnız sink'in NE DÖNDÜĞÜdür (dosya değil, dizin).
  if (d && d.kind === 'flag-dir' && d.flag) return true;
  return !!(d && d.kind === 'flag' && d.flag && d.cap && d.cap.file && !d.cap.cli);
}

/** Dosya taşıyıcısının BAYRAK ADI — ayrı `fileFlag` ya da bayrağın kendisi. */
function identityFileFlagName(d) {
  if (d && d.fileFlag) return d.fileFlag;
  if (d && d.flag && d.cap && !d.cap.cli) return d.flag;
  return spawnPromptFile.PROMPT_FILE_FLAG;
}

/** Kimlik metninin bütçe TAŞIYICISI ('file' | 'cli') — systemPromptCap'in girdisi. */
function identityCarrier(commandKey, promptSink) {
  if (identityUsesEnvFile(commandKey)) return 'file'; // ENG-12 — env-dosya da DOSYA taşıyıcısıdır
  return identityUsesFileCarrier(commandKey, promptSink) ? 'file' : 'cli';
}

/**
 * ENG-12 — kimlik bir DİZİN + ENV ile mi taşınıyor? (`identity.kind === 'env-file'`)
 * Bu üçüncü taşıyıcı şemada ENG-04'ten beri VARDI ama hiçbir kayıt kullanmıyordu;
 * copilot onu ilk kullanan motor. Argv'ye HİÇBİR ŞEY eklemez → `withIdentity` no-op
 * kalır ve kimlik `applyIdentityEnvFile` ile pane env'ine girer.
 */
function identityUsesEnvFile(commandKey) {
  const d = engineCapability(commandKey, 'identity');
  return !!(d && d.kind === 'env-file' && d.env && d.fileSuffix);
}

/** Kimlik dizinlerinin kökü (pane başına bir alt dizin). */
function identityEnvDirRoot(homedir) {
  return path.join(instancePaths.crewpaneHome(homedir), 'engine-identity');
}

/** Pane başına kimlik dizini anahtarı (dosya adı olarak güvenli). */
function identityPaneKey(opts) {
  return String((opts && (opts.agentId || opts.paneId)) || 'pane').replace(/[^A-Za-z0-9_.-]/g, '_') || 'pane';
}

/**
 * ENG-21 (G5) — YAML FRONTMATTER: bazı motorlar kimlik dosyasını BAŞLIKSIZ kabul etmez.
 *
 * ÖLÇÜLDÜ (kimi 0.36.1, ENG-21 canlı turu): dosyayı doğru bayrakla vermek YETMEDİ —
 * `error: failed to run prompt: Invalid agent file "…": Missing frontmatter`. Descriptor
 * bu alanları ENG-17'den beri BEYAN EDİYORDU (`identity.frontmatterFields`) ama ürün
 * hiç yazmıyordu. İkinci ölçülmüş gerçek: motorun SERT alt-ajan bloğu da argv'de değil
 * bu başlıkta yaşıyor (`subagentBlock.via === 'identity-frontmatter'`).
 *
 * Blok, claude'un kuralının AYNISIYLA yazılır: yalnız delegasyon yürütme pane'i ve
 * lider pane'i alır; insanın elle açtığı pane almaz (parite).
 * Beyanı olmayan motorda TAM NO-OP — metin aynen döner.
 */
function withIdentityFrontmatter(commandKey, d, text, opts) {
  const fields = Array.isArray(d.frontmatterFields) ? d.frontmatterFields : null;
  if (!fields || !fields.length) return text;
  const scalar = (v) => JSON.stringify(String(v).replace(/[\r\n]+/g, ' ').trim());
  const lines = ['---'];
  const paneKey = identityPaneKey(opts);
  if (fields.includes('name')) lines.push(`name: ${scalar(`crewpane-${paneKey}`)}`);
  if (fields.includes('description')) lines.push(`description: ${scalar('CrewPane pane identity')}`);
  const block = engineCapability(commandKey, 'subagentBlock');
  const wantsBlock = !!(opts && opts.disallowSubagent === true) || isLeaderSpawn(opts);
  if (
    wantsBlock &&
    block &&
    block.via === 'identity-frontmatter' &&
    typeof block.configPath === 'string' &&
    fields.includes(block.configPath) &&
    Array.isArray(block.value) &&
    block.value.length
  ) {
    lines.push(`${block.configPath}:`);
    for (const tool of block.value) lines.push(`  - ${scalar(tool)}`);
  }
  lines.push('---', '');
  return `${lines.join('\n')}\n${text}`;
}

/**
 * Kimlik metnini pane'in KENDİ dizinine atomik yazar → yolu döner (`null` = IO hatası).
 * `applyIdentityEnvFile` ile AYNI dizin/temizlik/izin disiplinini paylaşır; tek fark
 * sonucun nereye BAĞLANDIĞI (env değil, argv bayrağı).
 */
function writeIdentityFile(commandKey, d, text, opts, homedir, log) {
  const paneKey = identityPaneKey(opts);
  const suffix = d.fileSuffix || '.md';
  try {
    const dir = path.join(identityEnvDirRoot(homedir), paneKey);
    fs.mkdirSync(dir, { recursive: true });
    // Bayat kimlik dosyası = YANLIŞ AJAN. Aynı kural env-dosya yolunda da geçerli.
    try {
      for (const name of fs.readdirSync(dir)) {
        if (name.endsWith(suffix)) fs.unlinkSync(path.join(dir, name));
      }
    } catch {
      /* temizlik garanti değil; yazım yine de doğru dosyayı üretir */
    }
    const file = path.join(dir, d.fileName || `crewpane${suffix}`);
    // WIN-FIX-01 (W1) — win32'de kalıcı rename düşüşü kimlik dosyasını YUTUYORDU
    // ("pane KİMLİKSİZ koşuyor" dalı). Tek boğaz + yerinde-yazım son çaresi.
    winSafeAtomicWrite(file, text, { log: typeof log === 'function' ? log : null });
    if (typeof log === 'function') log(`spawn kimliği DOSYA-BAYRAĞINDAN: ${file} (${text.length} karakter, ${commandKey})`);
    return file;
  } catch (err) {
    if (typeof log === 'function') {
      log(`spawn kimliği YAZILAMADI (${commandKey}/${d.flag}): ${err && err.message} → pane KİMLİKSİZ koşuyor`);
    }
    return null;
  }
}

/**
 * ENG-21 (G5) — DOSYA-ZORUNLU bayrak taşıyıcısı için sink üretir; başka motorda `null`
 * (davranış bit-bit aynı kalır). AD-WIN-01'in `trusted.promptFile` sink'inden farkı:
 * o WINDOWS'ta bir ARG_MAX kaçışıdır ve OPSİYONELDİR; bu ise motorun SÖZLEŞMESİDİR —
 * yoksa kimlik hiç verilemez.
 *
 * ⚠️ `replacesSystemPrompt` beyanı VARSA taban prompt tek boğazdan (engineBasePrompt)
 * geçirilir. Reçetesi henüz yazılmamış bir taban (kimi `ledger-dump`) SESSİZ KALMAZ:
 * log'a düşer — kimlik alan ama motorun kendi kurallarını kaybeden bir pane, ürünün
 * bildiği ve söylediği bir eksiktir (ENG-15 §6 kimi maddesi).
 */
function identityFileFlagSink(commandKey, opts, homedir, log) {
  if (!identityFlagIsFileOnly(commandKey)) return null;
  const d = engineCapability(commandKey, 'identity');
  return (text) => {
    let finalText = text;
    if (d.replacesSystemPrompt === true) {
      const composed = engineBasePrompt.composeIdentityWithBase(commandKey, text, { homedir, log });
      if (!composed) return null; // fail-closed — çağıran kimliksiz devam eder
      if (composed === text && typeof log === 'function') {
        log(
          `spawn kimliği UYARISI (${commandKey}): taşıyıcı motorun gömülü sistem prompt'unu SİLİYOR ` +
            `(identity.replacesSystemPrompt) ve taban geri kazanma reçetesi ` +
            `('${(d.basePrompt && d.basePrompt.kind) || 'YOK'}') henüz UYGULANMADI → pane kimlikli ama motorun kendi kuralları OLMADAN koşar`,
        );
      }
      finalText = composed;
    }
    const written = writeIdentityFile(commandKey, d, withIdentityFrontmatter(commandKey, d, finalText, opts), opts, homedir, log);
    // ENG-ENABLE-01 — `flag-dir` taşıyıcısında bayrağa giden şey DOSYA değil onun
    // DİZİNİdir (motor dosya adını kendisi dayatır: `identity.fileName`).
    if (written && d.kind === 'flag-dir') return path.dirname(written);
    return written;
  };
}

/**
 * ENG-12 — KİMLİĞİ ENV-DOSYA TAŞIYICISIYLA VER (copilot sınıfı motorlar).
 *
 * Ne yapar: metni `<crewpaneHome>/engine-identity/<pane>/crewpane<suffix>` dosyasına
 * ATOMİK yazar ve descriptor'ın beyan ettiği env değişkenini (copilot:
 * `COPILOT_CUSTOM_INSTRUCTIONS_DIRS`) o dizine ayarlar.
 *
 * ÜÇ SERT KURAL (hepsi ölçümden çıktı — ENG-12 §2.3):
 *   1. DİZİN PANE BAŞINA. Aynı dizindeki TÜM `*.instructions.md` dosyaları okunuyor →
 *      iki ajan aynı dizini paylaşsa iki kişilik ÜST ÜSTE binerdi. Dizin ajan
 *      kimliğinden türer ve her spawn'da İÇİ TEMİZLENİR (bayat kimlik = yanlış ajan).
 *   2. UZANTI ŞART. `AGENTS.md` adıyla aynı dizinde GÖRÜLMEDİ; ad serbest, uzantı
 *      `descriptor.identity.fileSuffix` (ölçülen değer).
 *   3. KULLANICININ KENDİ DİZİNLERİ KORUNUR. Env zaten doluysa değer EZİLMEZ,
 *      `envSeparator` ile birleştirilir (kayıt ADDITIVE — motorun kendi sözleşmesi).
 *
 * Dönen: yazılan dosyanın yolu ya da `null` (yeteneği olmayan motor / IO hatası).
 * Hata SESSİZ DEĞİL: `log` verilmişse yazılır — kimliksiz koşan bir pane protokolü
 * uygulamaz ve bugüne kadarki en pahalı sessiz arıza sınıfı budur (ENG-R3 §14-R1).
 */
/**
 * ENG-16 — `json-config` kimlik belgesini kur (saf-yakın; yalnız `log` yan etkisi).
 *
 * `configPath` iki şekli destekler ve ikisi de descriptor'da BEYANLIDIR:
 *   • `'alan[]'`  → DİZİdir, kimlik dosyasının YOLU sonuna eklenir (opencode `instructions[]`)
 *   • `'a.b.c'`   → tek DEĞERdir, yol oraya yazılır
 * Bilinmeyen bir şekil sessizce yutulmaz: belge kimliksiz döner ve log'a yazılır
 * (kimliksiz pane GÖRÜNÜR bir arızadır, sessiz olan kabul edilemez).
 */
/**
 * ENV içindeki JSON config belgesini NESNE olarak oku. Bozuk/nesne-olmayan değer
 * `{}` tabanına düşer ve LOG'a yazılır (sessiz yutma yasağı). Kimlik yazıcısı
 * (`mergeIdentityConfigDoc`) ve MCP yazıcısı (`mcpRegisterArgs` env-config dalı)
 * AYNI belgeyi AYNI kuralla okur — iki ayrıştırıcı iki farklı "bozuk" tanımı
 * doğururdu (OC-DESIGN-0919 §4-5 "mevcut yardımcılar yeniden kullanılır").
 */
function parseEnvConfigDoc(existingJson, envName, who, log) {
  let doc = {};
  if (existingJson) {
    try {
      const parsed = JSON.parse(existingJson);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) doc = parsed;
      else if (typeof log === 'function') log(`${who}: ${envName} JSON NESNE değil → kullanıcı değeri yok sayıldı`);
    } catch {
      if (typeof log === 'function') log(`${who}: ${envName} ayrıştırılamadı (bozuk JSON) → kullanıcı değeri yok sayıldı`);
    }
  }
  return doc;
}

function mergeIdentityConfigDoc(existingJson, d, identityFile, log) {
  const doc = parseEnvConfigDoc(existingJson, d.env, 'spawn kimliği', log);
  // Taban (şema + alt-ajan bloğu gibi ÜRÜNÜN kararları) kullanıcı belgesinin ÜSTÜNE.
  const base = d.configBase && typeof d.configBase === 'object' ? d.configBase : {};
  for (const [k, v] of Object.entries(base)) {
    doc[k] = v && typeof v === 'object' && !Array.isArray(v) && doc[k] && typeof doc[k] === 'object' && !Array.isArray(doc[k])
      ? { ...doc[k], ...v }
      : v;
  }
  const spec = typeof d.configPath === 'string' ? d.configPath : '';
  if (spec.endsWith('[]')) {
    const key = spec.slice(0, -2);
    const arr = Array.isArray(doc[key]) ? doc[key].filter((x) => typeof x === 'string' && x !== identityFile) : [];
    arr.push(identityFile);
    doc[key] = arr;
  } else if (spec) {
    const segs = spec.split('.');
    let cur = doc;
    for (const seg of segs.slice(0, -1)) {
      if (!cur[seg] || typeof cur[seg] !== 'object' || Array.isArray(cur[seg])) cur[seg] = {};
      cur = cur[seg];
    }
    cur[segs[segs.length - 1]] = identityFile;
  } else if (typeof log === 'function') {
    log(`spawn kimliği: ${d.env} için configPath BEYAN EDİLMEMİŞ → belge KİMLİKSİZ kuruldu`);
  }
  return doc;
}

/**
 * ENG-16 — PANE İZOLASYONU: motorun ORTAK yerel deposunu pane başına ayır.
 *
 * ÖLÇÜLDÜ (opencode 1.18.18): aynı anda koşan iki pane ortak sqlite defterinde
 * çarpıştı ve biri `Error: Unexpected error / database is locked` ile ÖLDÜ —
 * yani "iki ajan aynı anda çalışsın" ürün vaadi o motorda YAPISAL olarak kırıktı.
 * Pane başına `OPENCODE_DB` verildiğinde ikisi de geçti (her biri KENDİ kimliğiyle).
 *
 * Descriptor `isolation` beyan etmeyen motorda TAM NO-OP (env bit-bit aynı).
 * Kullanıcı kendi değerini vermişse EZİLMEZ (kendi deposunu seçmiş olabilir).
 *
 * ENG-OPENCODE-DB-01 (C4, OC-DESIGN-0919 §5(d) D1) — İKİZ KAPISI. Depo anahtarı
 * AJAN'dır (restart-resume `--continue` için deterministik olmak zorunda) → aynı
 * ajanın İKİNCİ canlı pane'i (ADP-289/761/705 meşru ikizleri, ölü dispatch'in geç
 * canlanan kopyası) AYNI dosyayı alırdı. ÖLÇÜLDÜ (RESEARCH-OC-01 §2.4): taze ortak
 * DB'yi iki süreç aynı anda göç ettirince biri `Failed query: CREATE TABLE workspace`
 * ile exit 1. Çağıran (main) canlı pane'lerin ürün-üretimi dosyalarını `liveFiles`
 * ile verir; kanonik dosya o listedeyse ikiz AYRI dosya alır (`<anahtar>--2`), spawn
 * ENGELLENMEZ (kurtarma ölmesin) ve log ikizi adıyla söyler. Karar saf ve testli:
 * `taskClaim.decideIsolationTwin`. `liveFiles` verilmezse davranış bugünküyle bit-bit.
 */
function applyPaneIsolationEnv(childEnv, commandKey, opts, homedir, log, liveFiles) {
  const d = engineRegistry.getEngine ? engineRegistry.getEngine(commandKey) : null;
  const iso = d && d.isolation ? d.isolation : null;
  if (!iso || !iso.env || !iso.fileName) return null;
  if (typeof childEnv[iso.env] === 'string' && childEnv[iso.env].trim()) return null; // kullanıcı seçmiş
  const verdict = isolationTwinVerdict(iso, commandKey, opts, homedir, liveFiles);
  try {
    fs.mkdirSync(path.dirname(verdict.file), { recursive: true });
    const target = verdict.file;
    childEnv[iso.env] = target;
    if (typeof log === 'function') {
      log(`pane izolasyonu (${commandKey}): ${iso.env}=${target}`);
      if (verdict.action === 'separate') {
        log(`pane izolasyonu İKİZ (${commandKey}/${verdict.paneKey}): ${verdict.why} — spawn engellenmedi, kullanıcıya satır basılır`);
      }
    }
    return target;
  } catch (err) {
    // İzolasyon kurulamazsa pane yine açılır — ama SESSİZ DEĞİL: ortak depoya
    // düşmek "database is locked" riskini geri getirir ve bunu log söylemeli.
    if (typeof log === 'function') {
      log(`pane izolasyonu KURULAMADI (${commandKey}/${iso.env}): ${err && err.message} → ortak depo kullanılacak (eşzamanlı pane çakışabilir)`);
    }
    return null;
  }
}

/** C4 — kanonik yol parçaları + saf ikiz kararı (fs yok). Anahtar = agentId || paneId. */
function isolationTwinVerdict(iso, commandKey, opts, homedir, liveFiles) {
  const paneKey = String((opts && (opts.agentId || opts.paneId)) || 'pane').replace(/[^A-Za-z0-9_.-]/g, '_') || 'pane';
  const root = path.join(instancePaths.crewpaneHome(homedir), 'engine-isolation', commandKey);
  return taskClaim.decideIsolationTwin(liveFiles, { root, paneKey, fileName: iso.fileName });
}

/**
 * C4 — İZOLASYON FACT'İ, ENV'DEN ÖLÇÜLÜR (iddia değil). `applyPaneIsolationEnv`
 * çağrıldıktan SONRA sorulur: env'deki değer ürünün bu spawn için hesapladığı yolsa
 * `{ env, file, separated, twinOf }` döner; kullanıcı kendi deposunu ezmişse ya da
 * izolasyon kurulamadıysa (env boş/başka) `null` — main o pane'i "ürün deposu" diye
 * defterine YAZMAZ ve C3 resume kapısı da onu ürün yolu sanmaz. İzolasyon beyan
 * etmeyen motorda null.
 */
function paneIsolationPlan(childEnv, commandKey, opts, homedir, liveFiles) {
  const d = engineRegistry.getEngine ? engineRegistry.getEngine(commandKey) : null;
  const iso = d && d.isolation ? d.isolation : null;
  if (!iso || !iso.env || !iso.fileName) return null;
  const verdict = isolationTwinVerdict(iso, commandKey, opts, homedir, liveFiles);
  if (!childEnv || childEnv[iso.env] !== verdict.file) return null;
  return { env: iso.env, file: verdict.file, separated: verdict.action === 'separate', twinOf: verdict.twinOf };
}

function applyIdentityEnvFile(childEnv, commandKey, identityText, opts, homedir, log) {
  const d = engineCapability(commandKey, 'identity');
  if (!identityUsesEnvFile(commandKey)) return null;
  const capped = sanitizeSystemPrompt(identityText, systemPromptCap.systemPromptCap('file'));
  if (!capped) return null;
  // ENG-14 — 🔴 TAŞIYICI GÖMÜLÜ PROMPTU SİLİYOR MU? Descriptor öyle BEYAN ediyorsa
  // (`identity.replacesSystemPrompt`) kimlik TEK BAŞINA yazılamaz: motorun kendi
  // sistem prompt'u önce GERİ KAZANILIR (engineBasePrompt, jeton maliyeti sıfır) ve
  // kimlik onun SONUNA eklenir. Bütçe SIRASI önemli: kimlik ÖNCE kırpılır (D-07
  // "kimlik önce bütçelenir"), taban ondan SONRA eklenir — taban BİZİM metnimiz
  // değildir, kırpılması motorun kurallarını sakatlardı.
  // APPEND taşıyıcılarında (copilot/goose) bu çağrı NO-OP: metin aynen döner.
  const text = engineBasePrompt.composeIdentityWithBase(commandKey, capped, {
    cwd: opts && opts.cwd,
    env: childEnv,
    homedir,
    log,
  });
  if (!text) {
    // FAIL-CLOSED (`basePrompt.onFailure: 'skip-identity'`): kimliksiz ama TAM
    // yetenekli pane > kimlikli ama güvenlik kurallarını kaybetmiş pane.
    if (typeof log === 'function') {
      log(`spawn kimliği YAZILMADI (${commandKey}/${d.env}): taban prompt geri kazanılamadı → pane KİMLİKSİZ ama motorun kendi prompt'u BOZULMADAN koşuyor`);
    }
    return null;
  }
  const paneKey = String((opts && (opts.agentId || opts.paneId)) || 'pane').replace(/[^A-Za-z0-9_.-]/g, '_') || 'pane';
  try {
    const dir = path.join(identityEnvDirRoot(homedir), paneKey);
    fs.mkdirSync(dir, { recursive: true });
    // Kural 1 — bayat kimlik dosyalarını temizle (ad değişse bile eskisi okunurdu).
    try {
      for (const name of fs.readdirSync(dir)) {
        if (name.endsWith(d.fileSuffix)) fs.unlinkSync(path.join(dir, name));
      }
    } catch {
      /* temizlik garanti değil; yazım yine de doğru dosyayı üretir */
    }
    // ENG-13 — dosya ADI descriptor'dan gelebilir: goose env'e TEK BİR DOSYA yolu
    // ister (`GOOSE_SYSTEM_PROMPT_FILE_PATH`), copilot ise bir DİZİN tarar.
    const file = path.join(dir, d.fileName || `crewpane${d.fileSuffix}`);
    // Atomik: pane açılır açılmaz okunan bir dosya YARIM okunursa yarım kimlik olur
    // (delegate-mcp.json'da ölçülen sınıfın aynısı — bkz. writeJsonAtomic).
    // WIN-FIX-01 (W1) — win32 son-çaresi de aynı boğazdan (yerinde yazım, log'lu).
    winSafeAtomicWrite(file, text, { log: typeof log === 'function' ? log : null });
    // Kural 3 — kullanıcının kendi dizinleri korunur (ADDITIVE birleştirme).
    // ENG-13 — env NEYİ gösteriyor? `envTarget:'dir'` (varsayılan, copilot: dizin
    // taranır → ADDITIVE birleştirilebilir) ya da `'file'` (goose: TEK dosya yolu →
    // birleştirme İMKÂNSIZ, ikinci yol eklemek dosyayı bulunamaz yapar). Kullanıcının
    // kendi değeri EZİLİYORSA bu SESSİZ kalmaz: log'a düşer.
    const existing = typeof childEnv[d.env] === 'string' ? childEnv[d.env].trim() : '';
    // ENG-16 — ÜÇÜNCÜ HEDEF: env bir YOL değil, motorun TÜM CONFIG BELGESİ (JSON).
    // opencode'da kimlik `instructions[]` alanına yazılır (ÖLÇÜLDÜ: ADDITIVE, gömülü
    // prompt korunur) ve AYNI belge alt-ajan bloğunu da taşır (`tools:{task:false}`,
    // ölçüldü). Belge diske YAZILMAZ → iki pane aynı dizinde çalışsa bile config
    // yarışı YAPISAL OLARAK imkânsızdır (ENG-R2 §6.2-5'in sorusu).
    // 🔒 Kullanıcının kendi belgesi EZİLMEZ: env doluysa üstüne BİRLEŞTİRİLİR
    // (bizim alanlarımız kazanır, ötekiler korunur) ve durum log'a düşer.
    if (d.envTarget === 'json-config') {
      const doc = mergeIdentityConfigDoc(existing, d, file, log);
      childEnv[d.env] = JSON.stringify(doc);
      if (typeof log === 'function') log(`spawn kimliği ENV-CONFIG'ten: ${file} (${text.length} karakter, ${d.env}.${d.configPath})`);
      return file;
    }
    if (d.envTarget === 'file') {
      if (existing && existing !== file && typeof log === 'function') {
        log(`spawn kimliği: ${d.env} kullanıcı değeri EZİLDİ (tek-dosya taşıyıcısı, birleştirilemez): ${existing}`);
      }
      childEnv[d.env] = file;
    } else {
      const sep = d.envSeparator || ',';
      childEnv[d.env] = existing ? `${existing}${sep}${dir}` : dir;
    }
    if (typeof log === 'function') log(`spawn kimliği ENV-DOSYADAN: ${file} (${text.length} karakter, ${d.env})`);
    return file;
  } catch (err) {
    if (typeof log === 'function') {
      log(`spawn kimliği YAZILAMADI (${commandKey}/${d.env}): ${err && err.message} → pane KİMLİKSİZ koşuyor`);
    }
    return null;
  }
}

/**
 * ENG-07 (ENG-R3 §6.2) — RESUME'da davranış kuralları (ADP-276 yazma disiplini +
 * BR-02 protokolü) YENİDEN verilebilir mi? Yalnız kimlik taşıyıcısı konuşmaya
 * GÖRÜNMEYEN motorlarda: descriptor `identity.resumeReinject`. Pozisyonel taşıyıcıda
 * aynı metin kullanıcıya mesaj olarak düşerdi → beyanlı olarak YAPILMAZ.
 */
function supportsResumeReinject(commandKey) {
  const d = engineCapability(commandKey, 'identity');
  return !!(d && d.resumeReinject === true);
}

// ADP-177 — guard PREPENDED to a `plain` (office-click) pane's identity. The bug:
// clicking a leader in the office opened a fresh claude that, reading its lead/
// orchestrator identity + CLAUDE.md startup protocol, AUTO-raised the whole team
// (spawn-worker / new tmux panes) — a second orchestrator colliding with the real
// lead → chaos + process explosion + freeze. This guard (read FIRST, so it frames the
// rest) tells the pane it was opened for a DIRECT conversation, not to orchestrate.
// ADP-200 (REVISES ADP-177) — the wiring NO LONGER withholds the delegate MCP from a plain
// leader: a clicked leader IS delegation-capable so it can act the moment the boss asks. This
// guard is now the SOLE mechanism keeping it from auto-orchestrating on a mere click —
// capability (tool present) decoupled from behavior (this guard: don't auto-raise the team).
// LEAD-BEHAV-01 (Eren P0 — Discord müşteri şikâyeti: "lider görev DAĞITMIYOR, kendi
// terminalinde alt-ajanla yapıyor") — ESKİ METNİN KUSURU ÖLÇÜLDÜ. Guard, liderin
// okuduğu İLK metindi ve şunu diyordu: "başka ajanları başlatma … yeni terminal/pane
// açma … delegasyon AYRI ve KASITLI bir aksiyondur (ofis delege akışı), tıklama değil".
// Model bunu "delegasyon BU pane'de olmaz, başka bir yerde olur" diye okur — yani
// TETİK olması gereken kimlik direktifini bir SÜZGEÇ örtüyordu ([[prompt-is-filter-not-trigger]]).
// Sonuç: patron bu pane'e "şunu yap" yazdığında lider işi KENDİ yapıyor / kendi
// alt-ajanına veriyordu; müşterinin tarifi birebir buydu.
//
// YENİ METİN AYNI KORUMAYI SÜRDÜRÜR ama tetiği doğru yere koyar: yasaklanan şey
// TIKLAMANIN KENDİSİYLE kendiliğinden takım ayağa kaldırmaktır — patronun BU pane'e
// yazdığı bir direktif geldiğinde delege etmek YANLIŞ DEĞİL, BEKLENEN davranıştır ve
// tam da bu pane'deki `crewpane_delegate` aracıyla yapılır. ADP-177/ADP-200'ün
// capability-vs-behavior ayrımı korunur (araç var; kendiliğinden orkestrasyon yok).
// IDN-BUDGET-01 — METİN ARTIK `electron/identityBudget.cjs`TE. Neden taşındı:
// kimliğin bütçesini hesaplayan taraf (renderer) ile bu öneki EKLEYEN taraf (main)
// AYNI dizeyi okumak zorunda; iki kopya olsaydı "rezerv" bir tahmine dönerdi ve
// tahminin yanıldığı kadarı kimliğin KUYRUĞUNDAN kesilirdi (ölçülen kusurun ta kendisi).
const PLAIN_OFFICE_GUARD = identityBudget.PLAIN_OFFICE_GUARD;
// PDF2-2 — kimliksiz temiz pane'in koruması. AYNI EV KURALI (IDN-BUDGET-01): metin
// `identityBudget.cjs`te yaşar; iki kopya olsaydı bütçe bir tahmine dönerdi.
const CLEAN_PANE_GUARD = identityBudget.CLEAN_PANE_GUARD;

/**
 * ADP-177 — for a `plain` spawn, prepend the conversational guard to the identity so
 * the pane does not auto-orchestrate. No-op when not plain. Prepended (not appended)
 * so it survives the sanitizeSystemPrompt length cap (which trims the TAIL) and is the
 * first thing the model reads. Returns the (possibly augmented) systemPrompt string.
 */
function withPlainGuard(systemPrompt, opts, engine) {
  const base = typeof systemPrompt === 'string' ? systemPrompt.trim() : '';
  if (opts && opts.plain === true) {
    return base ? `${PLAIN_OFFICE_GUARD}\n\n${base}` : PLAIN_OFFICE_GUARD;
  }
  // PDF2-2 — İKİNCİ TETİK: kimliği HİÇ OLMAYAN spawn. Üstteki `plain` dalı bit-bit
  // korunur (o dal önce döner), bu dal yalnız onun DIŞINDA çalışır.
  if (!isIdentitylessSpawn(opts) || !identityCarrierIsSilent(engine)) return systemPrompt;
  return base ? `${CLEAN_PANE_GUARD}\n\n${base}` : CLEAN_PANE_GUARD;
}

/**
 * PDF2-2 — bu spawn hiçbir kimlik taşımıyor mu? ("+ → motor" temiz oturumu.)
 *
 * Ölçüt spec'in VERMEDİĞİ alanlardır (`newPaneSpec.ts` §PANE-D1 4.1): `agentId` ·
 * `role` · `systemPrompt`. Üçünden biri bile varsa bu bir OFİS spawn'ıdır (delegasyon
 * worker'ı, ajan pane'i) ve dokunulmaz — koruma yalnız BOŞLUĞU doldurur, kimliğin
 * yerine geçmez. `plain` dalı çağıran tarafta zaten ayrılmıştır.
 */
function isIdentitylessSpawn(opts) {
  if (!opts) return true;
  if (typeof opts.systemPrompt === 'string' && opts.systemPrompt.trim() !== '') return false;
  return !opts.agentId && !opts.role;
}

/**
 * PDF2-2 — bu motorda KİMLİK METNİ KONUŞMAYA GÖRÜNMEZ Mİ (yani tek başına verilince bir
 * tur BAŞLATMAZ mı)? Kimliksiz bir pane'e yazılacak tek metin bu guard'dır; pozisyonel
 * taşıyıcıda (codex, `identity.kind === 'positional'`) o metin İLK KULLANICI MESAJI
 * olurdu ve kullanıcı daha hiçbir şey yazmadan oturumu başlatırdı — bugün o pane
 * sessizce bekliyor (aynı gerekçe: `integrationBriefing.withIntegrationProtocol`).
 *
 * Motor ADINA bakan bir dal DEĞİL, defterin BEYAN ettiği alan. Beyan yoksa (shell,
 * bilinmeyen motor) FAIL-CLOSED: metin eklenmez — taşıyıcısı bilinmeyen bir yere
 * körlemesine yazmak, sessizce kullanıcı mesajı üretme riskini geri getirirdi.
 */
function identityCarrierIsSilent(commandKey) {
  const d = engineCapability(commandKey, 'identity');
  return !!(d && d.kind && d.kind !== 'positional');
}

/**
 * ADP-237/238 (ADR-014 Karar 2) — memory PROTOCOL for a FRESH agent spawn. Prepends a
 * compact memory block to the identity so a relaunched agent (same agentId) both RECALLS
 * and MAINTAINS its persistent memory. Two parts:
 *   • READ / restart-recall (ADP-237) — added ONLY when memory already exists: point the
 *     agent at its own/team/global MEMORY.md and tell it to READ them first, so it resumes
 *     past work without re-explaining. (Budget is 8000 chars, mostly identity, so we point
 *     to files rather than inline; both claude+codex have file tools, claude also --add-dir.)
 *   • WRITE discipline (ADP-238) — added ALWAYS (even with no memory yet) so memory
 *     BOOTSTRAPS from the first agent: write only future-useful facts, end-of-task
 *     reflection, mark done only after end-to-end verification, don't store what's in
 *     code/git, one-fact-per-file + frontmatter + index pointer, team facts → shared.
 * Backend-agnostic. Prepended (like the plain guard) so it survives the tail-trim.
 * Best-effort: any error yields the base prompt (a memory failure must never block a
 * spawn). `workspaceRoot` = the memory root (main.js's AGENT_WORKSPACE_ROOT); memory
 * lives at <workspaceRoot>/.crewpane/memory/.
 */
// ADP-238 — WRITE discipline text. Injected ALWAYS on a fresh spawn (even with no memory
// yet) so memory BOOTSTRAPS from the first agent; without it a first-ever agent would never
// write a first fact and recall could never begin. Research-backed rules (ADR-014 Karar 2).
// Shared by the fresh path (withRecalledMemory) and the resume path (resumeMemoryPrompt,
// ADP-276) so the rule can't drift between the two.
// MEM-01 — 🔑 KÖK NEDEN BURADAYDI: bu metin bir SÜZGEÇTİ, TETİK değildi.
// A/B ölçüldü (sevk edilen 0.2.31, temiz workspace, birebir aynı görev):
//   • yalnız bu ortam metniyle → ajan işi bitirdi ve AÇIKÇA "hafızaya not yazmadım;
//     gelecekte faydalı kalıcı bilgi içermiyor" dedi → 0 dosya. Hafıza HİÇ başlamıyor.
//   • aynı metin + delegation.ts composePrompt'un ZORUNLU kapanış adımı → 3 dosya.
// Yani müşteride hafıza oluşmamasının sebebi izin/yol/dizin DEĞİL: yazma TETİĞİ
// yalnızca lider→worker DELEGASYON yolunda vardı; müşteri pane'i doğrudan kullanınca
// (ofis tıklaması, sohbet, elle görev) o tetik hiç gelmiyordu. Süzgecin kendisi de
// bootstrap'i öldürüyor: hafıza boşken "yalnız kalıcı olanı yaz" kuralı sıradan her
// işi veto ediyor, ilk kayıt hiç yazılmıyor, dolayısıyla recall de hiç başlamıyor.
// ÇÖZÜM (delegasyondaki kanıtlı metnin ortama taşınmış hâli): kapanış ritüelini
// SOMUT + ZORUNLU yap, ve hafıza BOŞKEN açık bir bootstrap talimatı ver.
// Not: "yazacak şey yoksa bunu SÖYLE" kuralı gürültüye karşı sigortadır — ajan
// sessizce atlayamaz, kararını görünür kılar (sessiz başarısızlık yasağı).
function memoryWriteDiscipline(dir, shared, isEmpty) {
  const bootstrap = isEmpty
    ? ' 🌱 HAFIZAN ŞU AN BOŞ (bu workspace\'te ilk kez çalışıyorsun): hafıza ancak İLK kayıtla ' +
      'başlar — bu işin sonunda EN AZ BİR kalıcı gerçek yaz (rolün/kimliğin, kullanıcının ' +
      'tercihleri, bu workspace\'in yapısı/komutları gibi bir sonraki oturumda seni hızlandıracak bir şey).'
    : '';
  return (
    `Çalışırken GELECEKTE faydalı + kalıcı olan şeyleri kendi hafıza dizinine ("${dir}") YAZ: ` +
    // MEM-01 — 🪤 YAZAN ile OKUYAN aynı ALANLARI söylemeli. Metin "updatedAt/type/version"
    // diyordu; hafıza HARİTASI ise `name`/`description` okur (memoryGraph.parseFact) —
    // ölçüldü: ajan tam denileni yazdı, harita düğümü İSİMSİZ + AÇIKLAMASIZ çizdi.
    // Sözleşme burada tek cümlede toplanır (agentMemory.composeFact ile birebir).
    'tek-gerçek-tek-dosya + frontmatter (ZORUNLU alanlar: `name` (dosya adıyla aynı slug), ' +
    '`description` (tek satır özet), `metadata.type` (project|feedback|reference|user); ' +
    // SYNC-F1-4 — TALİMAT SADELEŞTİ: eskiden "MEMORY.md'ye tek-satır pointer" da
    // isteniyordu. Artık indeks fact frontmatter'ından TÜRETİLİYOR (§3.4): ajanın
    // elle eklediği satır bir sonraki türetmede zaten yeniden üretilir, eklemediği
    // satır da eklenir. İki cihazda `MEMORY.md`'ye append etmek ise senkronun TEK
    // gerçek çakışma yüzeyiydi — talimatı kaldırmak o yüzeyi kaynağında kurutur.
    'istersen `updatedAt`) + [[link]]. İNDEKSE (MEMORY.md) ELLE SATIR EKLEME: ' +
    '`description` alanından otomatik türetiliyor. Disiplin: HER oturumu değil yalnız gelecekte-faydalıyı yaz; iş/oturum ' +
    'sonunda kısa reflection; bir işi "bitti" işaretle ancak uçtan-uca DOĞRULANDIYSA (kod ' +
    `yazıldığında değil); kod/git'te zaten olanı yazma; takım geneli bir bilgiyse "${shared}"'e yaz.` +
    ' İŞ SONU RİTÜELİ (ZORUNLU, her görevin son adımı): "bundan kalıcı olarak ne öğrendim?" ' +
    'diye sor ve varsa hafızana YAZ; yazacak kalıcı bir şey yoksa cevabında tek satırla ' +
    '"hafızaya yazılacak yeni bilgi yok" de — sessizce atlama.' +
    bootstrap
  );
}

/**
 * ADP-862 — ajanın ÇALIŞTIRABİLECEĞİ hafıza-arama komutunun yolu, yoksa null.
 *
 * 🪤 PAKETTE `__dirname` app.asar'ın İÇİDİR ve harici bir `node` süreci asar'ın
 * içinden dosya çalıştıramaz (asar okuma yaması yalnız Electron'un içinde geçerli).
 * Bu yüzden pakette `app.asar.unpacked` karşılığına bakılır (electron/package.json
 * `asarUnpack` bu grafiği açar). Bulunmazsa komut cümlesi HİÇ yazılmaz — çalışmayan
 * bir komut vaat etmek, hiç vaat etmemekten kötüdür.
 */
function runnableRecallCli() {
  return runnableCli('memoryRecallCli.cjs');
}

/**
 * MEM-SCOPE-01 — MOTORUN hafızasında arama komutu (ÜRÜNÜNKİ değil: iki ayrı depo).
 * `null` dönerse blok komut UYDURMAZ, grep tarifi yazar.
 */
function runnableEngineMemorySearchCli() {
  return runnableCli('engineMemorySearchCli.cjs');
}

/**
 * Bir repo script'inin PAKETLENMİŞ uygulamada da koşabilen yolu.
 * 🪤 asar İÇİNDEN `node` ile koşulamaz → `app.asar.unpacked` karşılığı aranır;
 *    yoksa `null` (var olmayan bir yolu ajana komut diye vermeyiz).
 */
function runnableCli(basename) {
  try {
    const local = path.join(__dirname, basename);
    if (!local.includes(`app.asar${path.sep}`)) return fs.existsSync(local) ? local : null;
    const unpacked = local.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
    return fs.existsSync(unpacked) ? unpacked : null;
  } catch {
    return null;
  }
}

/**
 * D-07 (SPRINT-TOK-01) — AŞAMA A: spawn'da enjekte edilen ÇEKİRDEK hafıza cümlesi.
 *
 * ⛔ ESKİ DAVRANIŞ (ADP-862) BURADAN KALDIRILDI ve nedeni ölçümdür. Eski sorgu
 * ajanın KİM OLDUĞUydu (kimlik + rol + departman + rol şablonunun ilk paragrafı) ve
 * bununla her spawn'a ~15 kayıt seçiliyordu. D-04 (docs/agent-results/D-04-memory-tax.md)
 * bunu ölçtü:
 *   • kullanım oranı %5,9 · oturumların %41'i enjekte edilen HİÇBİR kaydı açmadı,
 *   • aynı motorla A/B: rol-sorgusu ile görev-sorgusu seçkileri **%80 farklı**,
 *   • blok her spawn'da 6.350±60 karakter — yani seçki değil DOLDURMA çalışıyordu.
 * Kök neden koda kendi yorumunda zaten yazılıydı: "görev metni spawn ANINDA henüz
 * yoktur". D-07'nin kararı: o yüzden spawn'da GÖREVE-GÖRE SEÇKİ YAPMA. Spawn yalnız
 * erişim yolu + arama komutu + (sınıfı gereği HER işte geçerli olan) davranışsal
 * çekirdeği taşır; göreve-göre seçki İLK GÖREV METNİYLE birlikte gelir (Aşama B,
 * memoryTaskBlock.taskBlock → dağıtım kapısı).
 *
 * Hafızası küçük olan ajanda indeks OLDUĞU GİBİ geçer (kayıpsız yol korunur).
 * Çekirdek üretilemezse ESKİ telafiye (tam indeksleri OKU) düşülür — hafıza erişimi
 * hiçbir koşulda tamamen kaybolmaz.
 */
function focusedRecallCue({ dir, shared, global, agentId, opts, workspaceRoot }) {
  const paths =
    `"${path.join(dir, agentMemory.INDEX_FILE)}" (senin) · ` +
    `"${path.join(shared, agentMemory.INDEX_FILE)}" (takım) · ` +
    `"${path.join(global, agentMemory.INDEX_FILE)}" (global)`;
  const tail =
    'Geçmiş işini, kararları ve tercihleri hatırla; kaldığın yerden devam et; aynı şeyleri ' +
    'tekrar tekrar sorma/açıklatma. Bir dosya/flag/isim geçen hafıza ESKİMİŞ olabilir — ona ' +
    'göre davranmadan önce DOĞRULA. ';
  const fallback = `Göreve/sohbete başlamadan ÖNCE şu MEMORY.md index dosyalarını OKU (sonra ilgili konu dosyalarını): ${paths}. ${tail}`;
  try {
    const core = memoryTaskBlock.spawnCore({
      workspaceRoot,
      agentId,
      cliPath: runnableRecallCli(),
      ledger: memoryLedger(),
    });
    if (!core.text) return fallback;
    return `${core.text}\n${tail}`;
  } catch {
    return fallback;
  }
}

// MEM-01 — hafıza enjeksiyonu ATLANDIĞINDA bunu SÖYLE. Eskiden iki sessiz çıkış vardı
// (agentId yok · workspaceRoot yok) ve pane hiç hafıza kuralı görmeden koşuyordu;
// kullanıcı da harita da bunu asla öğrenemiyordu. Log seam best-effort: yoksa no-op.
function memoryLog(log, line) {
  try {
    if (typeof log === 'function') log(`[memory] ${line}`);
  } catch {
    /* log hatası spawn'ı ASLA etkilemez */
  }
}

/**
 * D-07 — spawn'da enjekte edilecek hafıza BLOĞUNU ÜRETİR (yerleştirmez). Ayrılmasının
 * sebebi K3: bloğun nereye ve ne kadarının konacağına, kimliğin/guard'ın/protokolün
 * TAMAMI hesaba katıldıktan sonra karar verilir (bkz. composeSpawnIdentity).
 * '' döner → bu pane'e hafıza enjekte edilmez (sebep log seam'ine düşer).
 */
function memorySpawnBlock(opts, workspaceRoot, log) {
  try {
    const agentId = opts && typeof opts.agentId === 'string' ? opts.agentId.trim() : '';
    if (!agentId) {
      memoryLog(log, 'atlandı: bu pane bir AJAN kimliğine bağlı değil (agentId yok) → hafıza yazmaz');
      return '';
    }
    const dir = agentMemory.agentMemoryDir(workspaceRoot, agentId);
    if (!dir) {
      memoryLog(log, `atlandı: çalışma alanı (workspaceRoot) seçilmemiş → "${agentId}" hafıza yazamaz`);
      return '';
    }
    // MEM-01 — YAZILABİLİRLİK, talimattan ÖNCE ölçülür: yazamayacağı bir dizini
    // ajana göstermek sessiz başarısızlığın ta kendisidir (ajan yazmayı dener,
    // hata yutulur, harita "henüz yok" der). Ölçüm gerçek yazımdır (Windows ACL).
    const health = agentMemory.checkMemoryWritable(workspaceRoot);
    if (!health.ok) memoryLog(log, `YAZILAMIYOR (${health.reason}): ${health.root} — ${health.detail || 'sebep yok'}`);
    const shared = agentMemory.sharedMemoryDir(workspaceRoot);
    const global = agentMemory.globalMemoryDir();

    // SYNC-F1-4 — İNDEKS TÜRETME TETİĞİ (docs/design/SYNC-F1-TASARIM.md §3.4).
    //
    // 🔑 NEDEN TAM BURASI: ajanlar hafıza dosyalarını KENDİ dosya araçlarıyla yazar
    // (ADP-236: claude'un yerel hafıza aracı cwd-kapsamlıdır, bizim dizinlerimize
    // bağlanamaz) — yani `agentMemory.writeFact` ÇALIŞMA ZAMANI YOLU DEĞİLDİR.
    // Türetmeyi yalnız oraya bağlasaydık ajanın elle yazdığı fact indekse hiç
    // girmezdi ve talimattaki "indeks otomatik güncellenir" cümlesi YALAN olurdu.
    // Ölçüm bunu doğruluyor: bugün 37 fact diskte var, indekste YOK.
    //
    // Spawn, doğal ve tek noktadır: indeks zaten burada OKUNUYOR — okumadan hemen
    // önce türetmek, "bir önceki oturumun yazdığı her fact bu oturumda görünür"
    // garantisini tek satırla verir. Süre ÖLÇÜLDÜ (canlı ağaç: 1.480 fact / 30
    // kapsam = 175 ms; ajan+shared+global üçlüsü ≈ 110 ms) ve süreç başlatan bir
    // yolda kabul edilebilir; yine de log'a yazılır ki bir gün büyürse GÖRÜNSÜN.
    // Best-effort: türetme patlarsa spawn ETKİLENMEZ (hafıza asla spawn'ı bloklamaz).
    try {
      const t0 = Date.now();
      const derived = agentMemory.deriveAllIndexes(
        { workspaceRoot, accountRoot: path.dirname(global) },
        { write: true },
      );
      const t = Date.now() - t0;
      if (derived.totals.wrote) {
        memoryLog(
          log,
          `indeks türetildi: ${derived.totals.wrote} kapsam yazıldı ` +
            `(+${derived.totals.added} pointer, -${derived.totals.removed} kırık, ${t} ms)`,
        );
      }
    } catch (err) {
      memoryLog(log, `indeks türetimi atlandı: ${(err && err.message) || err}`);
    }

    // READ / recall — ONLY when some scope already has content (nothing to recall on a
    // first-ever spawn, so we don't send the agent chasing empty files).
    const hasMemory =
      agentMemory.readIndex(dir).trim() ||
      (shared && agentMemory.readIndex(shared).trim()) ||
      agentMemory.readIndex(global).trim();
    // ADP-862 — BAĞLAM OPTİMİZASYONU: "şu üç MEMORY.md'yi OKU" kuralı ölçülüp bırakıldı
    // (yalnız TAKIM indeksi 146 385 karakter → okuma aracının 25 000 jetonluk tavanına
    // çarpıyor, ajan indeksin kuyruğunu HİÇ göremiyor).
    // D-07 — bu satırın ARDINDAKİ SEÇKİ DEĞİŞTİ: spawn'da artık göreve/role göre seçim
    // YAPILMAZ (sorgu ajanın kimliğiydi ve ölçülen kullanım oranı %5,9'du); yerine
    // ÇEKİRDEK gider ve göreve-göre seçki ilk görev metniyle gelir. Küçük hafızada
    // indeks OLDUĞU GİBİ geçer — kayıpsız yol korunur.
    const recall = hasMemory ? focusedRecallCue({ dir, shared, global, agentId, opts, workspaceRoot }) : '';
    if (!hasMemory) memoryLog(log, `bootstrap: "${agentId}" hafızası BOŞ → ilk-kayıt talimatı enjekte edildi (${dir})`);

    return `📓 KALICI HAFIZAN VAR (kimlik: ${agentMemory.safeSlug(agentId)}). ${recall}${memoryWriteDiscipline(dir, shared, !hasMemory)}`;
  } catch {
    return '';
  }
}

/**
 * D-07 — Aşama A'nın karakter bütçesi (ADR-MEMORY-INJECTION §6: ≤2.600 ch).
 * `opts.memoryBudgetChars` ile ezilebilir (test/ölçüm); geçersizse varsayılan.
 * Bu bir ÜST SINIRDIR — kalan yer varsa doldurulmaz, seçki zaten kısa üretir.
 */
const SPAWN_MEMORY_BUDGET_CHARS = identityBudget.SPAWN_MEMORY_BUDGET_CHARS; // IDN-BUDGET-01 — tek kaynak
function memoryBudgetChars(opts) {
  const v = Number(opts && opts.memoryBudgetChars);
  return Number.isFinite(v) && v > 0 ? v : SPAWN_MEMORY_BUDGET_CHARS;
}

/**
 * D-07 (K3) — KİMLİK ÖNCE: hafıza bloğunu, DOKUNULMAZ metnin (guard + protokol +
 * kimlik) uzunluğu düşüldükten sonra kalan paya sığdır.
 *
 * D-04 §1.7 ölçtü: bugüne kadar sıra tersiydi — hafıza BAŞA ekleniyor, 8.000 tavanı
 * KUYRUKTAN kırpıyordu, dolayısıyla kesilen şey HER ZAMAN kimlik oluyordu (4/4 canlı
 * taze spawn'da rol cümlesi ortadan kesilmişti: "…sanal AI-ofisinde görev yapan,").
 * Bu bir jeton sorunu değil DAVRANIŞ hatasıydı. Artık pay önce kimliğe gider; kırpılan
 * varsa HAFIZA kırpılır ve kırpıldığı hem metinde hem log'da SÖYLENİR. Sabit metnin
 * kendisi tavanı dolduruyorsa hafıza tamamen düşer — yarım bir hafıza kuralı, hiç
 * kural olmamasından beterdir (D-04'ün ölçtüğü "yazma disiplininin ortasından kesik"
 * pane'leri tam olarak bu üretiyordu).
 *
 * @returns {string} sığdırılmış blok ('' → hiç enjekte etme)
 */
function fitMemoryBlock(block, fixedLen, opts, log, cap = MAX_SYSTEM_PROMPT_LEN) {
  if (!block) return '';
  const allowance = memoryTargeting.memoryAllowance(cap, fixedLen, memoryBudgetChars(opts));
  const fitted = memoryTargeting.clampMemoryBlock(block, allowance);
  if (!fitted) {
    memoryLog(log, `blok DÜŞTÜ: kimlik+protokol ${fixedLen} ch, tavan ${cap} → hafızaya yer kalmadı`);
    return '';
  }
  if (fitted.length < block.length) {
    memoryLog(log, `blok kırpıldı: ${block.length} → ${fitted.length} ch (kimlik+protokol ${fixedLen} ch KORUNDU)`);
  }
  return fitted;
}

/** ADP-237 uyumluluk sarmalayıcısı: blok + kimlik, kimlik-önce bütçeyle. */
function withRecalledMemory(systemPrompt, opts, workspaceRoot, log) {
  try {
    const block = memorySpawnBlock(opts, workspaceRoot, log);
    if (!block) return systemPrompt;
    const base = typeof systemPrompt === 'string' ? systemPrompt.trim() : '';
    if (!base) return block;
    const fitted = fitMemoryBlock(block, base.length, opts, log);
    return fitted ? `${fitted}\n\n${base}` : base;
  } catch {
    return systemPrompt;
  }
}

/**
 * D-07 — TAZE SPAWN'IN SİSTEM PROMPTUNU KOMPOZE ET (guard → protokol → hafıza → kimlik).
 *
 * Sıra ADP-177/BR-02'deki hâliyle KORUNUR; değişen tek şey BÜTÇENİN sırasıdır: hafızasız
 * kompozisyon (`fixed`) önce ölçülür, hafıza ona kalan paya sığdırılır. Böylece
 * `sanitizeSystemPrompt`ın kuyruk-kırpması hiçbir zaman kimliğe ulaşmaz.
 */
function composeSpawnIdentity({
  systemPrompt,
  opts,
  workspaceRoot,
  log,
  engine,
  cap = MAX_SYSTEM_PROMPT_LEN,
  contextBlock = '',
  // TOKEN-BUDGET-01 — bağlam bloğunun tavanı AYRI verilir. `cap` hafıza payını
  // taşıyıcının BEYAN edilen tavanından ölçer (AD-WIN-02 gerekçesi); bağlam bloğu
  // ise metnin GERÇEKTEN gideceği taşıyıcının tavanına sığmak zorunda — sink yoksa
  // 8.000. İkisini tek sayıya bağlamak, sink'siz bir pane'de bloğun kuyruktan
  // kesilmesi demek olurdu.
  contextCap = null,
}) {
  // PDF2-2 — `engine` artık guard katmanına da geçer: kimliksiz bir pane'e eklenecek
  // koruma, kimlik metninin TAŞIYICISINA bağlıdır (pozisyonel taşıyıcıda eklenmez).
  const wrap = (core) =>
    withPlainGuard(integrationBriefing.withIntegrationProtocol(core, { engine }), opts, engine);
  // TOKEN-BUDGET-01 — BAĞLAM BLOĞU KİMLİĞİN ÖNÜNE GİRER, ARDINA DEĞİL.
  // 🪤 ÖLÇÜLMÜŞ REGRESYON (token-budget-proof R1, iki koşu): blok kimliğin ARDINA
  //    eklendiğinde pane kendini çalışma alanı CLAUDE.md'sindeki LİDER sanıyor
  //    ("Kod adın ne?" → "Fury", doğrusu "Prowl"). Metne "bu kimlik değildir"
  //    uyarısı EKLEMEK YETMEDİ (ikinci koşu da düştü) — kazanan, SON okunan
  //    metindi. Kimlik mührü (ADP-037 "kendini X olarak tanıt") en sonda kalmalı.
  const base = typeof systemPrompt === 'string' ? systemPrompt.trim() : '';
  const block = memorySpawnBlock(opts, workspaceRoot, log);
  // Bağlam bloğunun payı: tavandan kimliğin ve HAFIZA PAYININ çıkarılmasıyla bulunur.
  // Hafıza payını rezerve etmezsek bağlam bloğu onu aç bırakır (D-04'ün tam tersi
  // bir kusur: blok DÜŞER ve pane geçmişini kaybeder).
  const bare = wrap(base);
  const reserved = bare.length + (block ? memoryBudgetChars(opts) : 0);
  const ctxCap = Number.isFinite(contextCap) && contextCap > 0 ? contextCap : cap;
  const ctx =
    typeof contextBlock === 'function'
      ? `${contextBlock(ctxCap - reserved) || ''}`.trim()
      : `${contextBlock || ''}`.trim();
  const withCtx = (identityText) => (ctx ? `${ctx}\n\n${identityText}` : identityText);
  if (!block) return wrap(withCtx(base));
  if (!base) return wrap(withCtx(block));
  const fixed = wrap(withCtx(base)); // hafızasız kompozisyon (bağlam bloğu DAHİL) = DOKUNULMAZ metin
  // AD-WIN-02 — `cap` bu spawn'ın GERÇEK tavanıdır (dosya yolu varsa 32 K). Eskiden
  // burada sabit 8.000 vardı ve 9.005 karakterlik bir lider kimliğinde hafıza bloğu
  // HER ZAMAN düşüyordu; komut satırı taşıyıcı olmadığında bu kısıt gerçek değildi.
  const fitted = fitMemoryBlock(block, fixed.length, opts, log, cap);
  return fitted ? wrap(`${fitted}\n\n${withCtx(base)}`) : fixed;
}

/**
 * ADP-276 — memory WRITE discipline for a RESTART-RESUMED pane. Root cause of the silent
 * loss: `--append-system-prompt` is a PER-LAUNCH flag, NOT conversation state — `--resume`
 * does NOT restore the original append. Probe-proven (claude 2.1.205, 2026-07-09, 3-arm):
 *   • resume WITHOUT append → agent answered "SP-YOK" (no memory rule in its system prompt)
 *     and wrote its fact to claude's cwd-scoped NATIVE memory (~/.claude/projects/<cwd>/memory/)
 *     — a dir the office never reads → knowledge silently lost across restarts.
 *   • resume WITH a write-rule-only append → conversation intact (codeword recalled), agent
 *     did NOT re-introduce itself (ADP-192 invariant holds), and wrote to the CORRECT
 *     .crewpane agent dir + MEMORY.md pointer.
 * So on resume we inject the ADP-238 WRITE rule ONLY — no identity, no plain guard, no READ
 * cue (the restored conversation already carries identity/guard behavior and past recall).
 * Returns null (→ withIdentity no-ops) when there is no agentId/dir or on any error — a
 * memory failure must never block a resume. Callers gate this to claude: codex has no
 * system-prompt flag, and a positional prompt on `codex resume` would POST a visible
 * message into the conversation — worse than the gap (codex resume is rare, ADP-192).
 */
function resumeMemoryPrompt(opts, workspaceRoot) {
  try {
    const agentId = opts && typeof opts.agentId === 'string' ? opts.agentId.trim() : '';
    if (!agentId) return null;
    const dir = agentMemory.agentMemoryDir(workspaceRoot, agentId);
    if (!dir) return null;
    const shared = agentMemory.sharedMemoryDir(workspaceRoot);
    // MEM-01 — bootstrap kuralı RESUME'da da gerekir: müşterinin uygulaması yeniden
    // başladığında pane'ler resume ile döner; hafıza hâlâ boşsa ilk-kayıt talimatı
    // burada da verilmezse bootstrap açığı restart'tan sonra aynen sürerdi.
    const isEmpty = !(
      agentMemory.readIndex(dir).trim() ||
      (shared && agentMemory.readIndex(shared).trim()) ||
      agentMemory.readIndex(agentMemory.globalMemoryDir()).trim()
    );
    return (
      `📓 KALICI HAFIZAN VAR (kimlik: ${agentMemory.safeSlug(agentId)}; bu bir DEVAM oturumu — ` +
      'kimliğin restore edilen konuşmada, kendini TEKRAR TANITMA). ' +
      memoryWriteDiscipline(dir, shared, isEmpty)
    );
  } catch {
    return null;
  }
}

/**
 * ADP-236 (ADR-014 Karar 2) — grant a claude agent FIRST-CLASS access to its memory dirs
 * via `--add-dir <agentDir> <sharedDir> <globalDir>` (an allowed-root + CLAUDE.md-discovery
 * flag). FINDING: Claude Code's NATIVE auto-memory is cwd-scoped (~/.claude/projects/<cwd>/
 * memory) with NO CLI flag to remap it per-agent — so we do NOT rely on it for identity
 * memory; our per-agent memory is the .crewpane/memory/ dirs, read/written via the agent's
 * file tools (cued by ADP-237). This just ensures those dirs are proper allowed roots even
 * if `--dangerously-skip-permissions` is ever tightened. claude-only (codex uses -C/its own
 * roots). Only EXISTING dirs are added (a first-ever agent has none yet → no-op; it creates
 * its dir on first write, added on the next spawn). Best-effort; never blocks a spawn.
 */
function withMemoryDirs(argv, commandKey, opts, workspaceRoot) {
  // ENG-07 — "claude mü?" DEĞİL, "bu motorda EK KÖK bayrağı var mı?"
  // (`extraRoots: {flag,repeat}`; codex'te `null` + gerekçe beyanlı).
  const d = engineCapability(commandKey, 'extraRoots');
  if (!d || !d.flag) return argv;
  try {
    const agentId = opts && typeof opts.agentId === 'string' ? opts.agentId.trim() : '';
    if (!agentId) return argv;
    const candidates = [
      agentMemory.agentMemoryDir(workspaceRoot, agentId),
      agentMemory.sharedMemoryDir(workspaceRoot),
      agentMemory.globalMemoryDir(),
    ];
    const seen = new Set();
    const dirs = candidates.filter((d) => {
      if (!d || seen.has(d)) return false;
      seen.add(d);
      try {
        return fs.statSync(d).isDirectory();
      } catch {
        return false;
      }
    });
    return applyArgs(argv, repeatFlagArgs(d.flag, dirs, d.repeat), d.position);
  } catch {
    return argv;
  }
}

// ---------------------------------------------------------------------------
// ADP-052 (ADR-004) — leader delegation wiring + hard subagent block.
// ---------------------------------------------------------------------------
// A LEADER pane (lead/ceo/orchestrator) gets, on its claude argv:
//   • --mcp-config <cfg> --strict-mcp-config  → ONLY our delegate MCP server
//     (ADP-051, electron/crewpane-delegate-mcp.cjs) is available; the leader's
//     `crewpane_delegate` tool opens each worker in its OWN app pane.
//   • --disallowedTools Task                  → claude's Task/subagent tool is
//     PHYSICALLY removed (ADR-004 hard layer; the ADP-053 identity text is the
//     soft layer). A subagent would run invisibly inside the leader — banned.
// The delegate MCP server reads the bridge port/token from its inherited env
// (main.js/ADP-050 sets CREWPANE_BRIDGE_* on the claude process → the MCP child
// inherits it), so no extra env is added here.

// LDR-F1 — LİSTE ARTIK BURADA YAŞAMIYOR. Eskiden bu satır `agentIdentity.isLeaderRole`
// ile "elle senkron tutulacak" bir KOPYAydı; LDR-F1 lider pane'ine otomatik yazan bir
// yol açtığı için kopyanın kayması artık "yanlış pane'in oturumu silinir" sınıfı bir
// arızadır. Tek kaynak: electron/leaderRole.cjs (saf leaf, sıfır bağımlılık).
// Küme departmandan BAĞIMSIZ: `lead` (Marvel HQ) ve `skool-lead` (Eğitim) dahil her
// kanadın lideri aynı sert subagent engelini alır (ADP-133/ADR-004).
const { LEADER_SLUGS: LEADER_ROLE_SLUGS } = require('./leaderRole.cjs');
// ADP-053 injects this tool name into a LEADER's composed identity only — it is a
// stable, code-like marker we can detect when the raw role isn't passed to spawn.
const DELEGATE_TOOL_MARKER = 'crewpane_delegate';
const DELEGATE_MCP_SERVER_FILE = 'crewpane-delegate-mcp.cjs'; // ADP-051 (fixed path)
const DELEGATE_MCP_SERVER_NAME = 'crewpane-delegate'; // mcp-config server id
// ADP-095 (ADR-006) — headed browser automation MCP, registered alongside the
// delegate server in the SAME leader mcp-config so a leader can drive the app's
// internal browser (navigate/click/type/read/screenshot) over the ADP-050 bridge.
const BROWSER_MCP_SERVER_FILE = 'crewpane-browser-mcp.cjs';
const BROWSER_MCP_SERVER_NAME = 'crewpane-browser';
// ADP-183 (Ratchet) — the Task Board MCP. Registered for EVERY agent (the board is
// every agent's baseline tool): bundled into the leader (withLeaderDelegation) and
// browser-worker (withBrowserCapable) strict configs, and given to every OTHER claude
// agent via withTaskCapable (additive --mcp-config, no --strict → other MCP servers
// are preserved). It writes DIRECTLY to Supabase (no bridge) so a created task shows
// on the board instantly via the renderer's realtime subscription.
const TASK_MCP_SERVER_FILE = 'crewpane-task-mcp.cjs';
const TASK_MCP_SERVER_NAME = 'crewpane-task';
// BR-01 / INT-BRIDGE-02 (ADR-INT-BRIDGE §7) — ENTEGRASYON KEŞİF server'ı. Task MCP ile
// AYNI kapsamda kayıtlıdır: HER ajan pane'i alır, KULLANICININ HİÇ ENTEGRASYONU OLMASA
// BİLE. Sebep sözleşmenin kendisidir: "YOK → bağlarsan senin için şunu yaparım" cümlesi
// ancak araç ORADAYSA kurulabilir; aracı yalnız bağlı kullanıcılara verseydik ajan
// "Sentry bağlı değil" ile "Sentry desteklenmiyor"u yine ayıramazdı. Sır taşımaz
// (durum + metadata), o yüzden entegrasyon anahtarı olmayan pane'de de zararsızdır.
const INTEGRATIONS_MCP_SERVER_FILE = 'crewpane-integrations-mcp.cjs';
const INTEGRATIONS_MCP_SERVER_NAME = 'crewpane-integrations';

// ADP-201 — when PACKAGED, agentRunner runs from INSIDE app.asar, but each MCP server is
// launched by plain `node <path>` and plain node CANNOT read a file inside an asar archive.
// So the *-mcp.cjs files are electron-builder `asarUnpack`'d to app.asar.unpacked/ (real files
// on disk). __dirname still reports the app.asar path, so we redirect it to app.asar.unpacked.
// Pure + testable given a dirname; in dev (no app.asar segment) the dir is returned unchanged.
function resolveMcpServerDir(dirname) {
  const d = typeof dirname === 'string' ? dirname : '';
  if (d.includes('app.asar.unpacked')) return d; // already unpacked → leave as-is
  if (d.endsWith(`${path.sep}app.asar`) || d === 'app.asar') return `${d}.unpacked`;
  const seg = `${path.sep}app.asar${path.sep}`;
  if (d.includes(seg)) return d.replace(seg, `${path.sep}app.asar.unpacked${path.sep}`);
  return d; // dev: agentRunner + the MCP servers are real sibling files on disk
}

/** Directory the MCP server .cjs files actually live in (asar-unpacked when packaged). */
function mcpServerDir() {
  return resolveMcpServerDir(__dirname);
}

// ADP-891 — MCP config'lerinde ÇIPLAK `node` YAZILMAZ.
// Eskiden her server `{ command: 'node' }` diye kaydediliyordu; `node` claude'un
// spawn anındaki PATH'inde ARANIR ve Windows'ta orada Node OLMAYABİLİR (bizim kendi
// kurulum komutumuz claude'u native installer ile kurar, Node kurmaz) → üç server da
// `ENOENT: Executable not found in $PATH: "node"` ile ölür, `/mcp` üçünü de `× failed`
// gösterir. `mcpNode.resolveMcpNode()` ya makinedeki node'un MUTLAK yolunu ya da
// Electron'un kendisini (`ELECTRON_RUN_AS_NODE=1`) verir — ikincisi uygulamayla
// birlikte geldiği için HER müşteride garantidir. Gerekçe + ölçüm: platform/mcpNode.cjs.
/** Bu spawn için MCP server girdisi (command/args[/env]) — çıplak ad ÜRETMEZ. */
/** Bugünkü (claude sınıfı) belge sarmalayıcısı — descriptor beyan etmezse bu geçerlidir. */
const MCP_DEFAULT_ENVELOPE = 'mcpServers';

function mcpEntry(scriptPath, launcher) {
  return mcpNode.mcpServerEntry(scriptPath, launcher);
}

// ---------------------------------------------------------------------------
// ENG-21 (G6) — MCP BELGESİNİN ŞEKLİ DE DESCRIPTOR'DAN GELİR.
// ---------------------------------------------------------------------------
// ÖLÇÜLDÜ (ENG-15 §2.4-G6, amp 0.0.1786968161): ürün her motora claude'un belge
// gövdesini yazıyordu — `{"mcpServers":{…}}`. amp'in doğrulayıcısı bunu REDDEDİYOR
// ("Invalid MCP server configuration: mcpServers: Invalid input") ve pane HİÇ
// AÇILMIYOR. Aynı sunucu haritası SARMALAYICISIZ verildiğinde şema GEÇİYOR.
// Sarmalayıcı adı artık `mcp.envelope` beyanıdır (droid'in `config-only` kaydı bu
// alanı ENG-13'ten beri kullanıyordu; burada `config-file` kayıtlarına da açıldı):
//   • dize  → gövde o anahtarın ALTINA sarılır (claude/copilot/qwen: 'mcpServers')
//   • null  → DÜZ HARİTA (amp)
// ⚠️ Belge YOLU da şekle göre ayrışır: aynı dosyayı iki farklı şekilde yazan iki
//    motor birbirinin belgesini EZERDİ (ölçülmemiş, ama yapısal olarak kaçınılmaz).

/** Descriptor'ın MCP sarmalayıcı beyanı: anahtar adı ya da `null` (düz harita). */
function mcpEnvelopeFor(commandKey) {
  const d = engineCapability(commandKey, 'mcp');
  if (!d) return MCP_DEFAULT_ENVELOPE;
  return Object.prototype.hasOwnProperty.call(d, 'envelope') ? d.envelope : MCP_DEFAULT_ENVELOPE;
}

/** Sunucu haritasını motorun beklediği belge gövdesine sarar. */
function mcpConfigDoc(commandKey, servers) {
  const envelope = mcpEnvelopeFor(commandKey);
  return envelope ? { [envelope]: servers } : { ...servers };
}

/**
 * Belge dosya adı — şekli FARKLI olan motor AYRI dosyaya yazar. Varsayılan şekilde
 * ad bit-bit bugünküdür (`delegate-mcp.json`), yani mevcut yollar hiç değişmez.
 */
function mcpConfigFileName(base, commandKey) {
  const envelope = mcpEnvelopeFor(commandKey);
  return envelope === MCP_DEFAULT_ENVELOPE ? `${base}.json` : `${base}-${envelope || 'flat'}.json`;
}

/** Absolute path to the ADP-051 delegate MCP server (asar-unpacked when packaged). */
function delegateMcpServerPath() {
  return path.join(mcpServerDir(), DELEGATE_MCP_SERVER_FILE);
}

/** Absolute path to the ADP-095 browser MCP server (asar-unpacked when packaged). */
function browserMcpServerPath() {
  return path.join(mcpServerDir(), BROWSER_MCP_SERVER_FILE);
}

/** Absolute path to the ADP-183 task MCP server (asar-unpacked when packaged). */
function taskMcpServerPath() {
  return path.join(mcpServerDir(), TASK_MCP_SERVER_FILE);
}

/** BR-01 — absolute path to the integration-discovery MCP server (asar-unpacked when packaged). */
function integrationsMcpServerPath() {
  return path.join(mcpServerDir(), INTEGRATIONS_MCP_SERVER_FILE);
}

/** Path of the generated MCP config that registers the delegate server. */
function delegateMcpConfigPath(homedir, commandKey) {
  return path.join(instancePaths.crewpaneHome(homedir), mcpConfigFileName('delegate-mcp', commandKey));
}

/**
 * Raw LEADER signal: the role is a leader slug (ADP-133 threads `opts.role` through
 * EVERY agent-pane spawn so this fires for a leader in ANY department — including the
 * office command box, which doesn't compose the full identity text) OR the composed
 * identity carries the ADP-053 `crewpane_delegate` marker (grid spawn / delegation
 * worker). Either signal is department-independent. This is the UN-gated detector —
 * use `isLeaderSpawn` for the wiring decision (it also respects ADP-177 `plain`).
 */
function leaderSignal(opts) {
  if (!opts || typeof opts !== 'object') return false;
  const role = typeof opts.role === 'string' ? opts.role.trim().toLowerCase() : '';
  if (role && LEADER_ROLE_SLUGS.includes(role)) return true;
  const sp = typeof opts.systemPrompt === 'string' ? opts.systemPrompt : '';
  return sp.includes(DELEGATE_TOOL_MARKER);
}

/**
 * Is this a spawn that should get the LEADER delegation WIRING (delegate MCP + leader
 * env)? True for ANY leader signal — INCLUDING a `plain` (office-click) pane.
 *
 * ADP-200 (Eren P0) REVISES ADP-177. ADP-177 withheld the wiring from a `plain` leader
 * (returned false) to stop a clicked leader from AUTO-raising the whole team (a rogue
 * second orchestrator cascading tmux/panes, conflicting with the real lead). But denying
 * the TOOL also left the leader UNABLE to delegate even when the boss EXPLICITLY asked —
 * so it fell back to ad-hoc tmux/spawn-worker (exactly the failure Eren hit). The right
 * split is CAPABILITY vs BEHAVIOR:
 *   • CAPABILITY — a clicked leader now DOES get `crewpane_delegate` (+ browser/task MCP)
 *     and CREWPANE_LEADER_ID/DEPARTMENT, so it CAN delegate IN-APP the moment it is asked.
 *   • BEHAVIOR — the PLAIN_OFFICE_GUARD (prepended for EVERY `plain` spawn in withPlainGuard)
 *     still tells the pane NOT to auto-orchestrate on a mere click; raising the team stays a
 *     deliberate, boss-initiated action.
 * The hard subagent block (`--disallowedTools Task`, added by withLeaderDelegation) still
 * applies, so a clicked leader delegates ONLY through visible in-app panes, never an
 * invisible Task subagent. Net: `plain` no longer strips the leader wiring — the guard,
 * not the missing tool, is what prevents auto-orchestration.
 */
function isLeaderSpawn(opts) {
  return leaderSignal(opts);
}

// ---------------------------------------------------------------------------
// TASK-MQTM0UIEMVZ3S (st2) — ATOMIC JSON write for the leader/agent MCP configs.
// ---------------------------------------------------------------------------
// The delegate/browser/task MCP configs are read by a freshly-spawned `claude` the
// instant the pane opens. Writing them with a bare fs.writeFileSync straight to the
// final path opens a real "PLAIN leader" failure window: if a second spawn races the
// write, or the process is killed mid-write, claude can observe a TRUNCATED
// delegate-mcp.json → it fails to parse `--mcp-config` → the `crewpane_delegate`
// tool never registers → the leader is, in effect, a plain pane with NO in-app
// delegation (exactly the "plain açılmasın" guarantee this task must hold). Writing
// to a unique temp file in the SAME dir and renaming over the target (rename is
// atomic on one filesystem) means a reader only ever sees the previous COMPLETE file
// or the new COMPLETE file — never a partial one. Mode 0600: these live under
// ~/.crewpane and only the local agent processes need them. Throws on IO error so
// the caller's try/catch can degrade to null (today's best-effort contract).
function writeJsonAtomic(targetPath, obj) {
  return winSafeAtomicWrite(targetPath, JSON.stringify(obj, null, 2), { what: path.basename(targetPath) });
}

// ---------------------------------------------------------------------------
// WIN-FIX-01 (W1) — "rename kalıcı olarak düştü" = KAYIP DEĞİL, SON BİR ŞANS DAHA.
// ---------------------------------------------------------------------------
// ADP-835 rename'i win32'de 6 kez (toplam 310 ms) yeniden deniyor; ADP-946 ise
// ölçtü ki bu bazen YETMİYOR ve `atomicWriteFileSync({inPlaceFallback:true})` ile
// hedefe DOĞRUDAN yazmak KURTARIYOR (`MoveFileEx` hedefe DELETE erişimi ister,
// `CreateFile(GENERIC_WRITE)` istemez → dosyayı FILE_SHARE_READ|WRITE ile açık
// tutan bir yedekleme/indeksleme ajanı rename'i bloklar, yazımı BLOKLAMAZ).
//
// AMA O KAPI SADECE İKİ ÇAĞIRANDA AÇIKTI (livePaneRegistry + agentSettings). Bu
// fonksiyonun yazdığı dosyalar ise delegasyonun TAŞIYICI KOLONU:
//   • `bridge.json`            (delegationBridge.writeHandshake → buradan geçer)
//   • `delegate-mcp.json` ve kardeşleri (lider/worker'ın TÜM MCP araçları)
//   • `briefing-settings-<ajan>.json` (liderin bitiş bildirimi)
// Yani win32'de kalıcı bir rename düşüşü tam olarak Miraç'ın bildirdiği tabloyu
// üretir: pane açılır, ama lider ARAÇSIZ ve delegasyon köprüsü BULUNAMAZ.
//
// macOS'ta DAVRANIŞ BİT-BİT AYNI: `inPlaceFallback` modülün içinde
// `platform === 'win32'` ile korunuyor; darwin'de rename tek atıştır ve hata
// bugünkü hatanın TA KENDİSİ olarak fırlar (nöbetçi test: adp946WindowsPersist).
//
// Yerinde yazım ATOMİK DEĞİLDİR — bu yüzden SESSİZ KALMAZ: `onInPlace` log'a düşer.
/**
 * Atomik JSON/metin yazımı + win32 son-çare yerinde-yazım. `tmp` adı bugünküyle
 * BİREBİR aynı tutulur (gizli `.ad.json.<pid>.<rand>.tmp`) — dizin dinleyen hiçbir
 * şey yeni bir dosya deseni görmez. Hata bugünkü gibi FIRLAR (çağıranın catch'i aynı).
 */
function winSafeAtomicWrite(targetPath, data, opts = {}) {
  const dir = path.dirname(targetPath);
  const tmp = path.join(
    dir,
    `.${path.basename(targetPath)}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`,
  );
  const r = atomicWriteFileSync(targetPath, data, {
    tmp,
    mode: 0o600,
    inPlaceFallback: true, // WIN-FIX-01 — yalnız win32'de etkili (modül içinde guard'lı)
    onInPlace: ({ file, code }) => {
      // Sessiz kalmak YASAK: "atomik yazamadım ama YAZDIM" ayrı bir durumdur.
      const line =
        `[agentRunner] win32 atomik yazım düştü (${code}) → YERİNDE yazıldı (atomik DEĞİL): ${file}`;
      try { (opts.log || console.error)(line); } catch { /* log yazımı yazmayı bloklamaz */ }
    },
  });
  restrictFile(targetPath); // ADP-835 (790 I3) — win32'de durumu dürüstçe raporlar
  return r;
}

/**
 * Best-effort: write the MCP config registering ONLY the delegate server. Returns
 * the config path, or null on any IO failure (→ claude just lacks the tool; the
 * pane still opens). Server is a .cjs run via `node` (resolved on the augmented
 * PATH the claude process carries; the MCP child inherits it). Written ATOMICALLY
 * (writeJsonAtomic) so a racing/interrupted spawn never leaves a half-written config
 * that would make claude drop the `crewpane_delegate` tool (→ a silently plain leader).
 */
function ensureDelegateMcpConfig(homedir, commandKey) {
  try {
    const dir = instancePaths.crewpaneHome(homedir);
    fs.mkdirSync(dir, { recursive: true });
    const cfgPath = path.join(dir, mcpConfigFileName('delegate-mcp', commandKey));
    const launcher = mcpNode.resolveMcpNode(); // ADP-891 — tek çözümleme, üç server aynı yorumlayıcı
    const config = mcpConfigDoc(commandKey, {
        [DELEGATE_MCP_SERVER_NAME]: mcpEntry(delegateMcpServerPath(), launcher),
        // ADP-095 — headed browser automation (same bridge, token from inherited
        // env or ~/.crewpane/bridge.json). Additive: --strict-mcp-config still
        // limits the leader to exactly these two CrewPane servers.
        [BROWSER_MCP_SERVER_NAME]: mcpEntry(browserMcpServerPath(), launcher),
        // ADP-183 — the Task Board MCP, bundled here so a leader can list/create/
        // update tasks + create projects/sprints (every agent is board-aware).
        [TASK_MCP_SERVER_NAME]: mcpEntry(taskMcpServerPath(), launcher),
        // BR-01 — entegrasyon KEŞFİ. STRICT config'te olması ŞART: strict, lideri tam
        // olarak burada sayılan server'larla sınırlar; eklemeseydik lider "ne bağlı"
        // sorusunu hiç soramazdı (ve entegrasyonu olmayan kullanıcıda araç zaten
        // hiçbir yerde görünmezdi).
        [INTEGRATIONS_MCP_SERVER_NAME]: mcpEntry(integrationsMcpServerPath(), launcher),
    });
    writeJsonAtomic(cfgPath, config);
    return cfgPath;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// ADP-227 — ENGINE-AGNOSTIC MCP registration (claude + codex).
// ---------------------------------------------------------------------------
// The delegation wiring above was claude-only: a CODEX leader/worker pane got NO
// CrewPane MCP servers at all. This block is the single engine→mechanism map:
//   • claude → JSON config file (ensure*McpConfig) + `--mcp-config <file>`
//     (+ `--strict-mcp-config` on the leader/browser strict paths) and
//     `--disallowedTools Task` as the hard subagent block.
//   • codex  → per-session `-c mcp_servers.<name>.command/args/env=<TOML>` argv
//     overrides (codex 0.133 PROVEN: `codex mcp list -c …` shows the server and a
//     live session lists its tools). Deliberately NOT `codex mcp add` — that
//     PERSISTS into the user's global ~/.codex/config.toml; `-c` is per-launch,
//     exactly like claude's --mcp-config. `-c` overrides are inherently ADDITIVE
//     (the user's own servers/plugins survive; codex has no --strict equivalent —
//     plugin-provided servers can't be stripped by overriding `mcp_servers`).
//     The subagent-block equivalent is `--disable multi_agent` (codex features
//     lists `multi_agent` STABLE/ON — an invisible multi-agent run inside a
//     leader would violate the ADR-004 "delegation only through visible panes"
//     invariant, same as claude's Task tool).
// Adding a new engine = add a branch in the with*Capable/Delegation functions
// below + its registration args builder here (glm/grok deliberately OUT of scope).

// Env keys COPIED from the pane env into a codex MCP server's config `env` map.
// PROVEN (ADP-227 probe): codex launches config-registered stdio servers with a
// MINIMAL env (HOME + a default PATH only) — unlike claude, the MCP child does NOT
// inherit the pane process env. So everything the CrewPane MCP servers read from
// env must be injected per server. ADP-251 — CREWPANE_BRIDGE_* is now bound onto
// childEnv INSIDE buildSpawn (main.js passes `trusted.bridge`) BEFORE the argv
// builders run, so these keys carry the FRESH port/token; the servers' bridge.json
// failover remains for callers that pass no trusted bridge — which is why
// CREWPANE_INSTANCE / CREWPANE_HOME (that file's resolution inputs,
// instancePaths.cjs) MUST still arrive. PATH is injected so `node` resolves even
// from a packaged (launchd-env) app.
// ADP-244 Faz 3 — passthrough listesi ikiz adları da taşır: MCP child'ı yeni-ad-öncelikli
// okuyor; yalnız legacy'yi geçirmek codex MCP'sini sessizce eski ada mahkûm ederdi (claude
// tarafı pane env'ini miras aldığı için bu asimetri fark edilmezdi).
// NEXT_PUBLIC_CREWPANE_SUPABASE_* BİLEREK ikizlenmedi — build-time inline (Faz 3 raporu §Risk).
const CODEX_MCP_ENV_KEYS = Object.freeze([
  ...crewpaneEnv.bothNames('INSTANCE'), // instancePaths dirName → the right ~/.crewpane[-dev] (pin: yazım ikiz, okuma tek)
  ...crewpaneEnv.bothNames('HOME'), // e2e home-relocation seam (aynı pin kuralı)
  // AGY-02 — HESAP KÖKÜ. `instancePaths.crewpaneHome()` bu anahtarla
  // `<instanceHome>/accounts/<key>`e iner; anahtar YOKSA sessizce `<instanceHome>`e
  // düşer. Zararsız görünür, DEĞİLDİR: task MCP'si ADP-717 takım kapısının
  // politikasını `agentSettings.readSettings().teamScope` üzerinden O KÖKTEN okur.
  // ÖLÇÜLDÜ (AGY-02-evidence/03), iki kol, aynı makine:
  //   • ACCOUNT VAR → home=…/accounts/u-ce83…, enforced=true, grants=1 (wonder_woman→chatflow)
  //   • ACCOUNT YOK → home=~/.crewpane,       enforced=true, grants=0, enforcedSince/By=null
  // Yani kapı FAIL-CLOSED kalıyor (iyi) ama VERİLMİŞ ÇAPRAZ-TAKIM İZİNLERİ YOK OLUYOR:
  // izni olan lider reddedilir ve gerekçe "izin verilmemiş" der — oysa verilmiştir.
  // claude/antigravity bunu görmüyordu çünkü ikisinin MCP çocuğu pane env'ini MİRAS
  // ALIYOR (antigravity mirası AGY-02'de ölçüldü); liste yalnız MİRAS ALMAYAN motoru
  // (codex) besliyor → asimetri tam da orada saklanıyordu.
  ...crewpaneEnv.bothNames('ACCOUNT'),
  ...crewpaneEnv.bothNames('BRIDGE_PORT'), // fast path when a caller pre-binds the bridge env
  ...crewpaneEnv.bothNames('BRIDGE_TOKEN'),
  ...crewpaneEnv.bothNames('BRIDGE_HOST'),
  'NEXT_PUBLIC_CREWPANE_SUPABASE_URL', // task MCP fast path (else .env.local failover)
  'NEXT_PUBLIC_CREWPANE_SUPABASE_ANON_KEY',
  // CDX-F1 (H4) — legacy araç ikizi kapısı. codex'in MCP çocukları pane env'ini MİRAS
  // ALMAZ (bu listenin var oluş sebebi) → anahtar buradan geçmezse codex pane'i
  // ikizleri görmeye devam eder ve claude/codex arasında SESSİZ bir asimetri doğardı.
  'CREWPANE_MCP_LEGACY_ALIASES',
  'PATH',
]);

// codex equivalent of claude's `--disallowedTools Task` (see block comment above).
const CODEX_SUBAGENT_BLOCK_ARGS = Object.freeze(['--disable', 'multi_agent']);

/**
 * Escape an arbitrary string into a TOML basic string ("…"). The `-c key=value`
 * value portion is parsed as TOML, and agentId/department/paths flow in from the
 * renderer — escaping quotes/backslashes/control chars means a crafted value can
 * NEVER break out of the string and inject extra TOML keys. Pure.
 */
function tomlBasicString(value) {
  let out = '"';
  for (const ch of String(value)) {
    const code = ch.codePointAt(0);
    if (ch === '"') out += '\\"';
    else if (ch === '\\') out += '\\\\';
    else if (code < 0x20 || code === 0x7f) out += `\\u${code.toString(16).padStart(4, '0')}`;
    else out += ch;
  }
  return out + '"';
}

/**
 * Build the env map a codex-registered CrewPane MCP server needs: the passthrough
 * keys present on the pane env (see CODEX_MCP_ENV_KEYS) + attribution — the leader
 * id for a LEADER spawn (delegate MCP: "who delegates"), the agent id otherwise
 * (browser/task MCP attribution), + the department. Mirrors what withLeaderEnv/
 * withBrowserEnv put on a claude pane's (inherited) env. Pure.
 */
function codexMcpServerEnv(opts, childEnv, leader) {
  const env = {};
  const base = childEnv && typeof childEnv === 'object' ? childEnv : {};
  for (const k of CODEX_MCP_ENV_KEYS) {
    if (typeof base[k] === 'string' && base[k]) env[k] = base[k];
  }
  const agentId = opts && typeof opts.agentId === 'string' ? opts.agentId.trim() : '';
  if (agentId) crewpaneEnv.dualWrite(env, leader ? 'LEADER_ID' : 'AGENT_ID', agentId);
  // TEAM-CASE-01 — env'e KANONİK takım yazılır. Bu değer worker'ın KENDİ department'ı
  // olarak geri döner (crewpane-delegate-mcp: `department ?? readEnv('DEPARTMENT')`);
  // ham `.trim()` burada karma harfli bir adı worker'ın SONRAKİ delegasyonuna taşıyordu.
  const department = normalizeDepartment(opts && opts.department);
  if (department) crewpaneEnv.dualWrite(env, 'DEPARTMENT', department);
  return env;
}

/**
 * argv additions registering CrewPane stdio MCP servers on a codex session via
 * `-c mcp_servers.<name>.…` overrides. Server names are our fixed constants (valid
 * TOML bare keys); paths/env values are TOML-escaped (tomlBasicString). Callers
 * PREPEND the result so codex's positional PROMPT (the identity, withIdentity)
 * stays last on the argv. Pure.
 */
function codexMcpOverrideArgs(servers, env, spec) {
  // ENG-07 — bayrak + anahtar ön-eki DESCRIPTOR'dan gelir (`mcp: {flag:'-c',
  // keyPrefix:'mcp_servers'}`); beyan yoksa bugünkü codex grameri kullanılır.
  const flag = (spec && spec.flag) || '-c';
  const prefix = (spec && spec.keyPrefix) || 'mcp_servers';
  const args = [];
  const entries = Object.entries(env || {});
  const table = entries.map(([k, v]) => `${tomlBasicString(k)}=${tomlBasicString(v)}`).join(',');
  for (const s of servers) {
    args.push(flag, `${prefix}.${s.name}.command="node"`);
    args.push(flag, `${prefix}.${s.name}.args=[${tomlBasicString(s.path)}]`);
    if (entries.length) args.push(flag, `${prefix}.${s.name}.env={${table}}`);
  }
  return args;
}

/**
 * ENG-13 — ARAÇ BAĞLAMA, ÜÇÜNCÜ GRAMER: değer TEK BİR KOMUT DİZESİ
 * (goose `--with-extension "ENV=1 node '/yol/x.cjs'"`). Ölçüldü (ENG-13 kablolama):
 * boşluklu yol TEK TIRNAKLA kapatılınca sunucu bağlandı, araç çağrıldı.
 *
 * 🔑 SIR KURALI: env çiftleri değere YALNIZCA motor pane env'ini MİRAS ALMIYORSA
 * eklenir (`mcp.envInheritance === false`). goose miras ALIYOR (ölçüldü) → env
 * argv'ye HİÇ yazılmaz; bu, ADP-580'in "anahtar argv'ye asla" çizgisinin aynısıdır
 * (`ps` çıktısı argv'yi herkese gösterir, env'i göstermez).
 */
function commandStringExtensionArgs(servers, env, spec) {
  if (!spec || !spec.flag) return [];
  const quote = (v) => {
    const str = String(v);
    if (spec.quote !== 'single' || !/[\s'"$`\\]/.test(str)) return str;
    return `'${str.replace(/'/g, "'\\''")}'`; // POSIX kaçış (tek tırnak içinde tek tırnak)
  };
  const envPairs =
    spec.envInheritance === false
      ? Object.entries(env || {}).map(([k, v]) => `${k}=${quote(v)}`)
      : [];
  const args = [];
  for (const s of servers) {
    args.push(spec.flag, [...envPairs, 'node', quote(s.path)].join(' '));
  }
  return args;
}

/**
 * ENG-07 — ARAÇ BAĞLAMA (2. kapı) tek genel uygulayıcı: MCP server'larını bu motorun
 * beyan ettiği TAŞIYICIYLA kaydeder ve argv KATKISINI döner (argv'ye basmaz).
 *   • `mcp.kind === 'config-file'` → `<flag> <cfgPath>` (+ istenirse `strictFlag`)
 *     — claude yolu; config dosyasını çağıran yazar (`configPath` bir thunk olabilir,
 *     yazım başarısızsa `null` döner → katkı BOŞ, bugünkü nazik düşüş).
 *   • `mcp.kind === 'cli-overrides'` → oturum-başı `-c mcp_servers.…` override'ları
 *     — codex yolu; env pane'den MİRAS ALINMADIĞI için (`envInheritance:false`) her
 *     server'ın env haritası argv'ye yazılır.
 *   • `mcp.kind === 'env-config'` → argv katkısı BOŞ; sunucular `childEnv[mcp.env]`
 *     içindeki JSON belgenin `mcp` alanına BİRLEŞTİRİLİR (opencode, ENG-OPENCODE-MCP-01).
 *   • `'config-only'`/`'none'`/kayıtsız motor → BOŞ katkı; kayıp `unsupported.mcp`
 *     (GÜVENLİK seviyesi) ile beyanlı, sessiz değil.
 */
function mcpRegisterArgs(commandKey, { servers, configPath, strict, env, homedir, childEnv, binFile, log, deps, opts } = {}) {
  let d = engineCapability(commandKey, 'mcp');
  if (!d) return [];
  // CODEX-ARGV-01 — 4. TAŞIYICI: OTURUM PROFİLİ DOSYASI. Tablo `$CODEX_HOME/<ad>.config.toml`e
  // yazılır, argv'ye yalnız `<flag> <ad>` girer (ölçülen kazanç: 4.508 → ~30 karakter).
  // İKİ nazik düşüş, ikisi de LOG'A DÜŞER (sessiz kayıp yasağı):
  //   • motor sürümü eşiğin altında/ölçülemiyor → `fallback` (bugünkü `-c` yolu),
  //   • dosya YAZILAMADI → yine `fallback`; pane araçsız kalmaz.
  if (d.kind === 'config-profile') {
    const profileD = d;
    const supported = codexMcpProfile.supportsProfileFile(
      binFile || commandKey,
      childEnv,
      deps || {},
      profileD.minVersion, // eşiğin TEK kaynağı descriptor'dır (ikinci sabit tutulmaz)
    );
    if (supported) {
      const written = codexMcpProfile.writeProfile(
        {
          servers: servers || [],
          env,
          keyPrefix: profileD.keyPrefix || 'mcp_servers',
          codexHome: codexMcpProfile.codexHomeDir(childEnv, homedir),
        },
        deps || {},
      );
      if (written) {
        if (typeof log === 'function') {
          log(`MCP kaydı DOSYADAN (${commandKey}/${profileD.flag}): ${written.file} (${written.bytes} bayt, ${(servers || []).length} sunucu)`);
        }
        return [profileD.flag, written.name];
      }
      if (typeof log === 'function') {
        log(`MCP profil dosyası YAZILAMADI (${commandKey}) → oturum-başı ${(profileD.fallback && profileD.fallback.flag) || '-c'} yoluna düşüldü (komut satırı UZUN kalır)`);
      }
    } else if (typeof log === 'function') {
      log(`MCP profil dosyası DESTEKLENMİYOR (${commandKey} < ${profileD.minVersion} ya da sürüm ölçülemedi) → oturum-başı ${(profileD.fallback && profileD.fallback.flag) || '-c'} yoluna düşüldü`);
    }
    if (!profileD.fallback) return [];
    d = profileD.fallback; // bugünkü davranış BİT-BİT korunur
  }
  // AGY-01 — 9. TAŞIYICI: ÇALIŞMA-ALANI PLUGIN DEMETİ (antigravity).
  // Sunucular argv'ye DE kullanıcının config'ine DE yazılmaz: pane başına bir KÖK
  // üretilir (`<crewpaneHome>/engine-plugins/<paneKey>`), demet onun altındaki
  // `.agents/plugins/crewpane/`e yazılır ve argv'ye YALNIZ `--add-dir <kök>` girer.
  // Demet yazılamazsa katkı BOŞ döner ve LOG'A düşer — pane araçsız açılır ama bu
  // ürünün BİLDİĞİ ve SÖYLEDİĞİ bir eksiktir (sessiz kayıp yasağı, LEAD-BEHAV-01).
  if (d.kind === 'workspace-plugin') {
    // 🔴 BOŞ KÜME YAZMA. `withIntegrationsMcp`/`withCodeIndexMcp` sunucu LİSTESİ değil
    // hazır bir config DOSYASI yolu verir; bu taşıyıcı onu ifade edemez. Burada demeti
    // yine de yazsaydık, liderin saniyeler önce yazdığı sunucu haritasının ÜSTÜNE BOŞ
    // harita geçer ve pane sessizce araçsız kalırdı. Kayıp beyanlıdır (log), sessiz değil.
    if (!Array.isArray(servers) || !servers.length) {
      if (typeof log === 'function') {
        log(`MCP kaydı ATLANDI (${commandKey}/${d.kind}): bu yol sunucu LİSTESİ vermiyor (config dosyası yolu) → demet DEĞİŞMEDİ`);
      }
      return [];
    }
    const root = agyWorkspacePlugin.pluginRootDir(
      instancePaths.crewpaneHome(homedir),
      // Aynı ev, aynı anahtar: `engine-identity/`, `engine-isolation/` ve
      // `mcp/integrations-<key>.json` ile AYNI "bu pane kim" cevabı (ikinci bir
      // adlandırma şeması iki farklı cevap doğururdu).
      integrationsPaneKey(opts),
    );
    const written = agyWorkspacePlugin.writePlugin({ servers: servers || [], env, root, descriptor: d });
    if (!written) {
      if (typeof log === 'function') {
        log(`MCP demeti YAZILAMADI (${commandKey}/${d.pluginName}) → pane bu araçlar OLMADAN açılıyor`);
      }
      return [];
    }
    // Çökme sonrası sahipsiz kökler burada düşer (spawn başına bir kez, yaş kapılı) —
    // `ensureIntegrationsMcpConfig` içindeki süpürgeyle AYNI desen.
    agyWorkspacePlugin.sweepStalePlugins(instancePaths.crewpaneHome(homedir));
    if (typeof log === 'function') {
      log(
        `MCP kaydı ÇALIŞMA-ALANI DEMETİNDEN (${commandKey}): ${written.dir} ` +
          `(${written.servers} sunucu, ${written.bytes} bayt, değişen: ${written.changed.length ? written.changed.join(',') : 'YOK — idempotent'})`,
      );
    }
    return d.rootFlag ? [d.rootFlag, written.root] : [];
  }
  // ENG-OPENCODE-MCP-01 (OC-DESIGN-0919 §5(a), karar A1) — 10. TAŞIYICI: ENV İÇİNDEKİ
  // CONFIG BELGESİ (opencode `OPENCODE_CONFIG_CONTENT`). Sunucular argv'ye DE diske DE
  // yazılmaz: kimlik yazıcısının (`applyIdentityEnvFile`, json-config) kurduğu belgenin
  // `mcp` alanına BİRLEŞTİRİLİR — kullanıcının kendi sunucuları korunur, aynı adda
  // bizimki kazanır (sahte bir "crewpane-task" araç adını çalamaz). Belge şekli
  // RESEARCH-OC-01 §2.1'de GERÇEK ikiliyle ölçüldü (`01-config-doc.json`:
  // `{type:'local', command:[node, yol], enabled:true, environment:{…}}` → `opencode mcp
  // list` 3/3 connected, `crewpane_delegation_status` çağrısı sahte köprüye ulaştı).
  // Argv katkısı BOŞ — çağıranlar zaten `childEnv`i paylaşır; kablolama ölçüsü
  // (`leaderDelegationStatus`) bu yüzden argv'ye DEĞİL env farkına da bakar.
  // 🔒 `strict` bu motorda UYGULANAMAZ (`strictFlag:null`): kullanıcının global `mcp`
  // sunucuları birleşir (ölçüldü, RESEARCH-OC-01 §2.6). Kabul + LOG; sessiz değil.
  // 🔒 Sunucu env'i belgede taşınır (`serverEnvPath`) → jeton argv/ps'te görünmez.
  if (d.kind === 'env-config') {
    if (!Array.isArray(servers) || !servers.length) {
      if (typeof log === 'function') {
        log(`MCP kaydı ATLANDI (${commandKey}/${d.kind}): bu yol sunucu LİSTESİ vermiyor → belge DEĞİŞMEDİ`);
      }
      return [];
    }
    if (!d.env || typeof d.configPath !== 'string' || !d.configPath || !childEnv || typeof childEnv !== 'object') {
      if (typeof log === 'function') {
        log(`MCP kaydı YAPILAMADI (${commandKey}/${d.kind}): env/configPath beyanı ya da childEnv yok → pane bu araçlar OLMADAN açılıyor`);
      }
      return [];
    }
    const existing = typeof childEnv[d.env] === 'string' ? childEnv[d.env] : '';
    const doc = parseEnvConfigDoc(existing, d.env, 'MCP kaydı', log);
    // ADP-891 — çıplak `node` YAZILMAZ: mutlak yol ya da Electron-as-node (+ env'i).
    const launcher = mcpNode.resolveMcpNode();
    const envKey = d.serverEnvPath || 'environment';
    const map = {};
    for (const s of servers) {
      map[s.name] = {
        type: 'local',
        command: [launcher.command, s.path],
        enabled: true,
        [envKey]: { ...(launcher.env || {}), ...(env || {}) },
      };
    }
    // `configPath` noktalı olabilir (`a.b`); son parça sunucu haritasıdır ve MEVCUT
    // haritayla birleşir (mergeIdentityConfigDoc'un nesne kuralı: nesne → birleştir).
    const segs = d.configPath.split('.');
    let cur = doc;
    for (const seg of segs.slice(0, -1)) {
      if (!cur[seg] || typeof cur[seg] !== 'object' || Array.isArray(cur[seg])) cur[seg] = {};
      cur = cur[seg];
    }
    const leaf = segs[segs.length - 1];
    const prev = cur[leaf] && typeof cur[leaf] === 'object' && !Array.isArray(cur[leaf]) ? cur[leaf] : {};
    cur[leaf] = { ...prev, ...map };
    childEnv[d.env] = JSON.stringify(doc);
    if (typeof log === 'function') {
      const strictNote = strict
        ? d.strictFlag
          ? `strict ${d.strictFlag}`
          : 'strict UYGULANAMAZ (motor sert izolasyon bayrağı beyan etmiyor; kullanıcı sunucuları birleşir)'
        : 'additive';
      log(
        `MCP kaydı ENV-BELGEDEN (${commandKey}): ${servers.length} sunucu → ${d.env}.${d.configPath} ` +
          `(${Object.keys(prev).length} mevcut korundu, yorumlayıcı ${launcher.source}), ${strictNote}`,
      );
    }
    return [];
  }
  if (d.kind === 'config-file') {
    if (!d.flag) return [];
    const cfgPath = typeof configPath === 'function' ? configPath() : configPath;
    if (!cfgPath) return [];
    // ENG-12 — DEĞER ÖNEKİ descriptor'dan. copilot `--additional-mcp-config` değerini
    // "JSON metni ya da @dosya" diye ayrıştırır: öneksiz bir yol JSON sanılır ve kayıt
    // "Invalid MCP server configuration" ile SESSİZCE düşerdi (ölçüldü, ENG-12-evidence-
    // kablolama/01). Öneki OLMAYAN motorda (claude) dize bit-bit bugünküyle aynı kalır.
    const value = `${d.valuePrefix || ''}${cfgPath}`;
    return strict && d.strictFlag ? [d.flag, value, d.strictFlag] : [d.flag, value];
  }
  if (d.kind === 'cli-overrides') return codexMcpOverrideArgs(servers || [], env, d);
  if (d.kind === 'cli-command') return commandStringExtensionArgs(servers || [], env, d);
  return [];
}

/**
 * ENG-07 — KATKILARIN ARGV KONUMU. Kimliği POZİSYONEL taşıyan motorda (codex,
 * `identity.position === 'last'`) her katkı argv'nin BAŞINA girmek zorundadır; aksi
 * hâlde kimlik prompt'u ortada kalır ve motor onu bayrak değeri sanar (ENG-R3 §2.1).
 * Bayrak taşıyıcılı motorda katkılar SONA eklenir (bugünkü claude davranışı).
 */
function contributionPosition(commandKey) {
  const d = engineCapability(commandKey, 'identity');
  return d && d.position === 'last' ? 'prepend' : 'append';
}

/** The LEADER server set: delegate + browser + task (ensureDelegateMcpConfig parity). */
function leaderMcpServers() {
  return [
    { name: DELEGATE_MCP_SERVER_NAME, path: delegateMcpServerPath() },
    { name: BROWSER_MCP_SERVER_NAME, path: browserMcpServerPath() },
    { name: TASK_MCP_SERVER_NAME, path: taskMcpServerPath() },
    // BR-01 — codex pane'i de SORABİLİR (araç sır taşımaz). Cevabı DÜRÜSTTÜR:
    // codex'te entegrasyon araçları yoktur (ADP-227 argv sızıntısı kararı) →
    // toolsLiveInThisPane=false + "claude pane'i gerekir" cümlesi.
    { name: INTEGRATIONS_MCP_SERVER_NAME, path: integrationsMcpServerPath() },
  ];
}

/** The common WORKER server set: task + browser, NEVER delegate (ADP-200 parity). */
function commonMcpServers() {
  return [
    { name: TASK_MCP_SERVER_NAME, path: taskMcpServerPath() },
    { name: BROWSER_MCP_SERVER_NAME, path: browserMcpServerPath() },
    { name: INTEGRATIONS_MCP_SERVER_NAME, path: integrationsMcpServerPath() }, // BR-01
  ];
}

/**
 * LEAD-BEHAV-01 — "bu pane lider gibi davranacak ama DELEGE EDEMEYECEK" durumunu
 * ÖLÇER (beyan etmez). `expected`: spawn bir lider sinyali taşıyor mu. `wired`:
 * `withLeaderDelegation` argv'ye GERÇEKTEN bir katkı yaptı mı. Motor adı dalı YOK —
 * hüküm argv karşılaştırmasından ve descriptor'ın `mcp` alanından çıkar.
 * Lider olmayan spawn'da `null` döner (rozet/uyarı üretilmez).
 */
function leaderDelegationStatus(commandKey, opts, argvBefore, argvAfter, envBefore, envAfter) {
  if (!isLeaderSpawn(opts)) return null;
  const argvWired = argvAfter !== argvBefore && argvAfter.length !== argvBefore.length;
  // ENG-OPENCODE-MCP-01 — env-config taşıyıcısı argv'ye DOKUNMAZ, belgeyi değiştirir:
  // kablolama ölçüsü env anlık görüntüsünün farkıdır (çağıran `mcp.env` değerini
  // ÖNCE/SONRA verir). İkisi de aynıysa `wired:false` + gerekçe — sahte-yeşil yok.
  const envWired = (typeof envBefore === 'string' || typeof envAfter === 'string') && envBefore !== envAfter;
  if (argvWired || envWired) return { expected: true, wired: true, reason: null };
  const mcp = engineCapability(commandKey, 'mcp');
  const reason = mcp
    ? mcp.env
      ? `motorun araç kaydı '${mcp.kind}' — config belgesi (${mcp.env}) DEĞİŞMEDİ, sunucular birleştirilemedi`
      : `motorun araç kaydı '${mcp.kind}' — pane BAŞINA sunucu kaydı yapılamıyor`
    : 'motor MCP araç kaydı beyan etmiyor';
  return { expected: true, wired: false, engine: commandKey, reason };
}

/** env-config taşıyıcısında kablolama ölçüsü için belge anlık görüntüsü (yoksa undefined). */
function mcpEnvSnapshot(commandKey, childEnv) {
  const mcp = engineCapability(commandKey, 'mcp');
  if (!mcp || !mcp.env || !childEnv) return undefined;
  return typeof childEnv[mcp.env] === 'string' ? childEnv[mcp.env] : '';
}

/**
 * Append the leader delegation wiring to a LEADER's argv, per engine (ADP-227):
 *   • claude — `--disallowedTools Task` is ALWAYS added (the hard subagent block
 *     does not depend on the MCP file); the `--mcp-config … --strict-mcp-config`
 *     pair only when the config was written.
 *   • codex  — `--disable multi_agent` (subagent-block equivalent) + `-c` overrides
 *     registering the SAME three servers (delegate+browser+task), each carrying the
 *     env map codex-launched MCP children need (codex strips the pane env). Prepended
 *     so the identity positional prompt stays last.
 * No-op for non-leaders / other engines. Pure given `homedir`; the only side effect
 * is claude's best-effort config write.
 */
function withLeaderDelegation(argv, commandKey, opts, homedir, childEnv, trusted) {
  if (!isLeaderSpawn(opts)) return argv;
  // ENG-07 — motor adı yerine YETENEK: sert alt-ajan bloğu + araç bağlama katkısı
  // TEK grup olarak kurulur ve motorun konumuna göre basılır. Grup sırası
  // (blok → mcp) bugünkü iki yolun argv'siyle birebir aynıdır.
  const group = [
    ...subagentBlockArgs(commandKey, argv),
    ...mcpRegisterArgs(commandKey, {
      servers: leaderMcpServers(),
      configPath: () => ensureDelegateMcpConfig(homedir, commandKey),
      strict: true, // lider yolunda YALNIZ bizim server'larımız görünür (sert izolasyon)
      env: codexMcpServerEnv(opts, childEnv, true),
      opts, // AGY-01 — 'workspace-plugin' demetinin PANE anahtarı buradan çıkar
      // CODEX-ARGV-01 — profil-dosyası taşıyıcısının ihtiyaçları (başka motorda yok sayılır)
      homedir,
      childEnv,
      binFile: trusted && trusted.binFile,
      log: trusted && trusted.log,
      deps: trusted && trusted.mcpProfileDeps,
    }),
  ];
  return applyArgs(argv, group, contributionPosition(commandKey));
}

// ---------------------------------------------------------------------------
// ADP-146 (ADR-009) — browser-capable DELEGATION pane (NOT a leader).
// ---------------------------------------------------------------------------
// A leader gets BOTH the delegate + browser MCP servers (withLeaderDelegation). A
// browser-capable WORKER (delegated to, then asked to drive the headed internal
// browser) must get the `crewpane-browser` server ONLY — never the delegate server
// — so it can navigate/click/type/read the visible browser but CANNOT sub-delegate.
// `--disallowedTools Task` (the hard subagent block) is preserved either way. The
// browser MCP reaches the ADP-050 bridge via the inherited CREWPANE_BRIDGE_* env
// (main.js sets it on EVERY agent pane), so no extra transport wiring is needed.

/** Path of the generated MCP config that registers ONLY the browser server. */
function browserMcpConfigPath(homedir, commandKey) {
  return path.join(instancePaths.crewpaneHome(homedir), mcpConfigFileName('browser-mcp', commandKey));
}

/**
 * Best-effort: write an MCP config registering ONLY the browser server (no delegate
 * server → the worker cannot sub-delegate). Returns the path, or null on IO failure
 * (→ the worker just lacks the tool; the pane still opens). Mirrors
 * ensureDelegateMcpConfig.
 */
function ensureBrowserMcpConfig(homedir, commandKey) {
  try {
    const dir = instancePaths.crewpaneHome(homedir);
    fs.mkdirSync(dir, { recursive: true });
    const cfgPath = path.join(dir, mcpConfigFileName('browser-mcp', commandKey));
    const launcher = mcpNode.resolveMcpNode(); // ADP-891
    const config = mcpConfigDoc(commandKey, {
        [BROWSER_MCP_SERVER_NAME]: mcpEntry(browserMcpServerPath(), launcher),
        // ADP-183 — the Task Board MCP travels with the browser-only config too, so a
        // browser-capable worker is still board-aware (every agent gets the task tool).
        [TASK_MCP_SERVER_NAME]: mcpEntry(taskMcpServerPath(), launcher),
        // BR-01 — keşif aracı burada da (strict config → sayılmayan server YOK olur).
        [INTEGRATIONS_MCP_SERVER_NAME]: mcpEntry(integrationsMcpServerPath(), launcher),
    });
    writeJsonAtomic(cfgPath, config);
    return cfgPath;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// ADP-183 (Ratchet) — Task Board MCP for EVERY OTHER agent.
// ---------------------------------------------------------------------------
// Leaders (withLeaderDelegation) and browser-capable workers (withBrowserCapable)
// already carry the `crewpane-task` server inside their STRICT config. Every other
// claude agent (a normal/plain office pane, a delegation EXECUTION worker) currently
// gets NO --mcp-config — so they would lack the board tool. This wiring gives them a
// task-ONLY config via an ADDITIVE `--mcp-config` (NO --strict-mcp-config): the agent
// gains `crewpane_task` while any user/project MCP servers it had are PRESERVED (a
// regression-safe add — unlike the strict leader/browser paths which intentionally
// restrict to CrewPane servers). Result: the task board is a baseline tool on EVERY
// agent spawn, present + future.

/** Path of the generated MCP config that registers ONLY the task server. */
function taskMcpConfigPath(homedir, commandKey) {
  return path.join(instancePaths.crewpaneHome(homedir), mcpConfigFileName('task-mcp', commandKey));
}

/**
 * Best-effort: write an MCP config registering ONLY the task server. Returns the
 * path, or null on IO failure (→ the agent just lacks the board tool; pane still
 * opens). Mirrors ensureBrowserMcpConfig.
 */
function ensureTaskMcpConfig(homedir, commandKey) {
  try {
    const dir = instancePaths.crewpaneHome(homedir);
    fs.mkdirSync(dir, { recursive: true });
    const cfgPath = path.join(dir, mcpConfigFileName('task-mcp', commandKey));
    // ADP-200 — the common (additive) config every non-leader agent gets now bundles BOTH the
    // task board AND the browser-automation server, so every clicked WORKER can manage the board
    // AND drive the app's internal browser (navigate/click/type/read/screenshot; click/type stay
    // human-approval-gated). Additive (NO --strict): the agent's other MCP servers survive.
    // Leaders keep their own STRICT superset (delegate+browser+task via withLeaderDelegation).
    const launcher = mcpNode.resolveMcpNode(); // ADP-891
    const config = mcpConfigDoc(commandKey, {
      [TASK_MCP_SERVER_NAME]: mcpEntry(taskMcpServerPath(), launcher),
      [BROWSER_MCP_SERVER_NAME]: mcpEntry(browserMcpServerPath(), launcher),
      // BR-01 — entegrasyon keşfi HER ajanın taban aracıdır (task board gibi).
      [INTEGRATIONS_MCP_SERVER_NAME]: mcpEntry(integrationsMcpServerPath(), launcher),
    });
    writeJsonAtomic(cfgPath, config);
    return cfgPath;
  } catch {
    return null;
  }
}

/**
 * Give the COMMON agent tools (Task Board + browser automation; ADP-200) to an agent
 * that does NOT already carry them. No-op for:
 *   • a LEADER spawn (its delegate wiring already bundles task + browser),
 *   • a BROWSER-CAPABLE delegation worker (its browser wiring already bundles them).
 * Per engine (ADP-227):
 *   • claude — appends an ADDITIVE `--mcp-config <task+browser common>` — deliberately
 *     WITHOUT `--strict-mcp-config`, so the agent's other MCP servers are preserved.
 *   • codex  — prepends the `-c mcp_servers.…` overrides for the SAME two servers
 *     (inherently additive; the user's own codex servers/plugins survive). NO delegate
 *     server and NO multi_agent block here — parity with the claude path.
 * This is what makes every clicked WORKER both board-aware AND able to drive the app's
 * internal browser. Pure given `homedir`; the only side effect is claude's best-effort
 * config write.
 */
function withTaskCapable(argv, commandKey, opts, homedir, childEnv, trusted) {
  if (isLeaderSpawn(opts)) return argv; // leader wiring already has the task server
  if (opts && opts.browserCapable) return argv; // browser wiring already has it
  // ENG-07 — ADDITIVE kayıt (strict YOK): kullanıcının kendi MCP server'ları korunur.
  const args = mcpRegisterArgs(commandKey, {
    servers: commonMcpServers(),
    configPath: () => ensureTaskMcpConfig(homedir, commandKey),
    strict: false,
    env: codexMcpServerEnv(opts, childEnv, false),
    opts, // AGY-01 — 'workspace-plugin' demetinin PANE anahtarı
    homedir,
    childEnv,
    binFile: trusted && trusted.binFile,
    log: trusted && trusted.log,
    deps: trusted && trusted.mcpProfileDeps,
  });
  return applyArgs(argv, args, contributionPosition(commandKey));
}

// ---------------------------------------------------------------------------
// ADP-692 — TUR-BAŞI BRİFİNG (KANAL A): lider bekleyen bitişleri KENDİ okur.
// ---------------------------------------------------------------------------
// Eren'in P0 UX şikâyeti: bir worker bitince mesaj liderin composer'ına yazılıyordu;
// kullanıcı o an prompt yazıyorsa metin YARIM PROMPT'un ardına eklenip ENTER'lanıyordu.
// ADP-667 nöbetçisi (composer boş mu?) ekranı okur ve insanın parmağının GERİSİNDEDİR →
// mikro yarış yapısal olarak kapanmaz.
//
// Çözüm enjeksiyonu bırakıp OKUMAYA geçmektir: claude'un `UserPromptSubmit` hook'u
// kullanıcı ENTER'a BASTIKTAN SONRA çalışır ve çıktısını turun bağlamına ekler
// (`additionalContext`). Composer'a bir bayt bile yazılmaz.
//
// Kurulum `--settings <dosya>` ile ADDITIVE'dir: claude'un kendi settings zinciri
// (user/project/local) korunur, üzerine yalnız bu hook eklenir. Config HER spawn'da
// yeniden yazılır (agentId/home değişse de taze kalır) ve LİDER pane'lerine özeldir —
// bir worker'ın kendi bitişini kendine anlatmasının anlamı yok.
//
// codex'te dengi YOK (hook yüzeyi yok) → codex lider için kanal A kurulmaz; supervisor
// o liderde ADP-667 enjeksiyon kanalını (sertleştirilmiş kapılarla) kullanmaya devam eder.
const BRIEFING_HOOK_FILE = 'leaderBriefingHook.cjs';

/** Absolute path to the ADP-692 turn-briefing hook (asar-unpacked when packaged). */
function briefingHookPath() {
  return path.join(mcpServerDir(), BRIEFING_HOOK_FILE);
}

// ---------------------------------------------------------------------------
// KILL-GUARD-01 — "patronun uygulamasını kapatma" TALİMATI yerine KAPI.
// ---------------------------------------------------------------------------
// 08.09 gecesi bir worker iki kez `killall CrewPane` çalıştırdı; uygulama düzenli
// kapandı ve o an koşan ÜÇ worker pane'iyle birlikte öldü. Kartında yasak YAZIYORDU.
// İki kapı kurulur, ikisi de AYNI karar çekirdeğini (killGuard.cjs) çağırır:
//   KAPI 1 — claude `PreToolUse` kancası (bu dosyadaki settings yazımı). Komutu
//            KABUĞA ULAŞMADAN reddeder ve gerekçeyi + izole-kopya reçetesini yazar.
//   KAPI 2 — PATH'in başına konan `killall`/`pkill` sarmalayıcıları (killGuardShim).
//            Kanca yüzeyi OLMAYAN motorlar (codex/goose/droid: engineRegistry'de
//            `hooks: null`) ve düz `shell` pane'i yalnız bununla korunur.
const KILL_GUARD_HOOK_FILE = 'killGuardHook.cjs';
const KILL_GUARD_SHIM_FILE = 'killGuardShim.cjs';

// AGY-03 — antigravity'nin hook süreci. claude'un iki dosyası (brifing + kill-guard)
// burada TEK dosyadır: ikisi de AYNI demetten (`hooks.json`) koşuyor ve aynı paketleme
// nöbetinden geçmek zorunda; ikinci bir dosya ikinci bir unpack riski demekti.
const AGY_HOOK_FILE = 'agyHookRunner.cjs';

function agyHookRunnerPath() {
  return path.join(mcpServerDir(), AGY_HOOK_FILE);
}

function killGuardHookPath() {
  return path.join(mcpServerDir(), KILL_GUARD_HOOK_FILE);
}

function killGuardShimCliPath() {
  return path.join(mcpServerDir(), KILL_GUARD_SHIM_FILE);
}

/**
 * Sarmalayıcının DEVREDECEĞİ gerçek ikilik. Bulunamazsa `null` → sarmalayıcı HİÇ
 * yazılmaz: gerçek yolu bilmeden devretmek `killall`i pane'de tamamen kırardı
 * (kapı işini yapmalı, komutu yok etmemeli).
 */
function resolveRealBin(name, deps = {}) {
  const platform = deps.platform || process.platform;
  // 🪤 `X_OK` Windows'ta ANLAMSIZDIR (Node: win32'de F_OK gibi davranır). Orada
  // "çalıştırılabilir mi" sorusunun cevabı uzantıdadır, izin bitinde değil — bu
  // yüzden Windows dalı doğrudan `.exe` yollarını dener.
  const exists = deps.exists || ((p) => {
    try { fs.accessSync(p, platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK); return true; } catch { return false; }
  });
  // Sabit yollar ÖNCE: PATH'ten çözmek, PATH'in başına KENDİ sarmalayıcımızı
  // koyduğumuz için kendini gösteren bir döngü riski taşır.
  if (platform === 'win32') {
    // WIN-PARITY-01 — Windows'un yıkım ikilikleri System32 altında sabittir.
    // `wmic` KENDİ alt dizinindedir (`wbem`) ve Windows 11'de KALDIRILMIŞ olabilir;
    // `tskill` de her sürümde yok. Bulunamayan için sarmalayıcı YAZILMAZ — ve bu
    // doğru sonuçtur: olmayan bir komutu gölgelemeye gerek yok.
    const root = (deps.env || process.env).SystemRoot || (deps.env || process.env).windir || 'C:\\Windows';
    const sys32 = path.join(root, 'System32');
    const cands = name === 'wmic'
      ? [path.join(sys32, 'wbem', 'WMIC.exe'), path.join(sys32, 'wbem', 'wmic.exe')]
      : [path.join(sys32, `${name}.exe`)];
    for (const p of cands) if (exists(p)) return p;
    return null;
  }
  for (const p of [`/usr/bin/${name}`, `/bin/${name}`, `/usr/sbin/${name}`]) {
    if (exists(p)) return p;
  }
  return null;
}

/**
 * KAPI 2'yi diske yaz: `<instanceHome>/bin/{killall,pkill}`. Dizin `ensureNodeLauncher`
 * ile AYNI (`bin/`) — ikinci bir dizin ikinci bir PATH girdisi demekti. Dönen değer
 * PATH'in başına eklenecek dizin; `null` = yazılamadı/gereksiz → PATH DEĞİŞMEZ.
 */
function ensureKillGuardShims(dir, deps = {}) {
  try {
    const platform = deps.platform || process.platform;
    // WIN-PARITY-01 — win32 dalı artık `null` DÖNMÜYOR: Windows'un kendi yıkım
    // komutları (`taskkill`/`wmic`/`tskill`) sarmalanır. Eski `return null`, KAPI 2'yi
    // Windows'ta tümüyle yok ediyordu.
    const launcher = deps.launcher || mcpNode.resolveMcpNode();
    const realBins = {};
    for (const verb of killGuardShim.shimmedFor(platform)) {
      const real = resolveRealBin(verb, { ...deps, platform });
      if (real) realBins[verb] = real;
    }
    const files = killGuardShim.shimFiles({
      cliPath: deps.cliPath || killGuardShimCliPath(),
      launcher,
      realBins,
      platform,
    });
    // Hiçbir gerçek ikilik çözülemediyse (ör. wmic'siz bir Windows 11 + tskill'siz)
    // dizin YARATILMAZ ve PATH DEĞİŞMEZ — boş bir dizini PATH'in başına koymak
    // sessiz bir yan etki olurdu.

    if (!files.length) return null;
    const binDir = path.join(dir, 'bin');
    fs.mkdirSync(binDir, { recursive: true });
    for (const f of files) {
      // HER spawn'da yeniden yazılır: `process.execPath` bir güncellemeden sonra
      // DEĞİŞİR ve bayat bir sarmalayıcı ölü bir ikiliyi çağırırdı (ensureNodeLauncher
      // ile aynı gerekçe).
      winSafeAtomicWrite(path.join(binDir, f.name), f.contents, {});
      try { fs.chmodSync(path.join(binDir, f.name), f.mode); } catch { /* win32: no-op */ }
    }
    return binDir;
  } catch {
    return null; // yazamadıysak KAPI 1 tek başına kalır (beyanlı düşüş, sessiz değil)
  }
}

/** Path of the generated claude settings file carrying the turn-briefing hook. */
function briefingSettingsPath(homedir, agentId) {
  const safe = String(agentId || '').replace(/[^A-Za-z0-9_.-]/g, '_') || 'leader';
  return path.join(instancePaths.crewpaneHome(homedir), `briefing-settings-${safe}.json`);
}

// ADP-891 — eski yerel `shQuote` KALDIRILDI: tırnak karakteri platforma bağlıdır
// (cmd.exe tek tırnağı tırnak saymaz, dosya adının parçası kabul eder) ve tırnaklama
// artık yorumlayıcı seçimiyle AYNI boğazda yaşıyor: platform/mcpNode.cjs.

/**
 * Best-effort: write the claude settings file that registers the ADP-692
 * `UserPromptSubmit` hook for THIS leader. Returns the path, or null on IO failure
 * (→ lider yalnız kanal B ile bilgilenir; pane yine açılır).
 *
 * `--home` AÇIKÇA geçilir: hook ayrı bir süreçtir ve instance'ı env mirasından tahmin
 * etmesi yanıltıcıdır ([[e2e-pane-env-instance-bypass]]) — main hangi defteri okuyacağını
 * biliyor, söyler.
 */
/**
 * WIN-FIX-01 (W1) — kabuk-bağımsız hook firlaticisini `<instanceHome>/bin/` altına
 * yaz ve DİZİNİ döndür (`null` = gerek yok / yazılamadı → çağıran bugünkü davranışa
 * düşer). Karar + dosya içerikleri SAF `mcpNode` modülünde; burası yalnız I/O.
 *
 * macOS'ta `nodeLauncherFiles` HER ZAMAN boş dizi döner → bu fonksiyon `null` döner
 * ve tek bir bayt bile yazılmaz.
 */
function ensureNodeLauncher(dir, deps = {}) {
  try {
    const launcher = deps.launcher || mcpNode.resolveMcpNode();
    const binDir = path.join(dir, 'bin');
    const files = mcpNode.nodeLauncherFiles(launcher, { platform: deps.platform, dir: binDir });
    if (!files.length) return null;
    fs.mkdirSync(binDir, { recursive: true });
    for (const f of files) {
      // Firlatici HER spawn'da yeniden yazılır: `process.execPath` bir güncellemeden
      // sonra DEĞİŞİR ve bayat bir firlatici sessizce ölü bir ikiliyi çağırırdı.
      winSafeAtomicWrite(path.join(binDir, f.name), f.contents, {});
      try { fs.chmodSync(path.join(binDir, f.name), f.mode); } catch { /* win32: no-op */ }
    }
    return binDir;
  } catch {
    return null; // yazamadıysak komut bugünkü (env ön-ekli) biçimde üretilir
  }
}

// KILL-GUARD-01 — `--settings` claude'da TEK dosya alır: iki kanca da AYNI belgeye
// yazılır. `opts.briefing=false` ise (worker) yalnız `PreToolUse` kalır; lider ayrıca
// ADP-692 `UserPromptSubmit` kancasını taşır. Ayrı bir ikinci settings dosyası
// yazsaydık claude ikincisini sessizce yok sayardı ve iki kanca yarışırdı.
function ensureBriefingSettings(homedir, agentId, opts = {}) {
  try {
    const dir = instancePaths.crewpaneHome(homedir);
    fs.mkdirSync(dir, { recursive: true });
    const cfgPath = briefingSettingsPath(homedir, agentId);
    // ADP-891 — hook da MCP server'larla AYNI SINIF bir süreçtir: claude onu DÜZ node
    // ile, asar DIŞINDAN koşar. Çıplak `node` Windows'ta bulunamaz (bkz. mcpNode.cjs)
    // → hook her turda sessizce patlardı (lider bekleyen bitişleri HİÇ öğrenmez;
    // ADP-692'nin çözdüğü bug geri gelir).
    //
    // ADP-906 — DÜZELTME: burası bir KABUK komutudur ve o kabuk Windows'ta cmd.exe
    // DEĞİL, Git Bash'tir (claude ikilisinin kendi hata metinleriyle ölçüldü). ADP-891
    // buraya cmd.exe sözdizimi (`set "K=V" && …`) yazıyordu; bash'te `set` env değil
    // konumsal parametre atar ⇒ Node'suz Windows makinesinde yorumlayıcı bayrağı
    // kaybolur, komut EXIT 0 verir ve hook yine hiç koşmaz. Sözdizimi artık her
    // platformda bash'tir — tek boğaz: platform/mcpNode.cjs.
    //
    // WIN-FIX-01 (W1) — AD-WIN-02'nin AÇIK BIRAKTIĞI kapı: "makinede Node YOK +
    // kabuk cmd.exe" bileşiminde env ön-eki (`K=V cmd`) ÇALIŞMAZ ve hook sessizce
    // hiç koşmaz. Artık env kabuktan ÇIKARILIYOR: win32'de Electron-as-node dalına
    // düşüldüğünde `<home>/bin/crewpane-node[.cmd]` firlaticisi yazılır ve komut
    // YALNIZCA onu çağırır. macOS'ta `ensureNodeLauncher` HİÇBİR ŞEY yazmaz ve
    // `launcherDir` yok sayılır → üretilen komut metni bit-bit bugünküdür.
    //
    // ⚠️ YORUMLAYICI BİR KEZ ÇÖZÜLÜR ve İKİSİNE DE aynı nesne verilir. İki ayrı
    // `resolveMcpNode()` çağrısı bir DİSK PROBUDUR: arada `node` görünür/kaybolursa
    // firlatici bir dalı, komut metni ÖBÜR dalı anlatırdı (yazılmamış bir firlaticiyi
    // çağıran komut = hook hiç koşmaz). Tek çözümleme = yapısal olarak imkânsız.
    const launcher = mcpNode.resolveMcpNode();
    const launcherDir = ensureNodeLauncher(dir, { launcher });
    const cmd = mcpNode.nodeShellCommand(
      [briefingHookPath(), '--home', dir, '--agent', agentId],
      { launcher, launcherDir },
    );
    const hooks = {};
    if (opts.briefing !== false) {
      hooks.UserPromptSubmit = [
        {
          hooks: [
            // timeout: hook liderin TURUNU BLOKLAR → küçük bir JSON okuması için
            // 10sn fazlasıyla yeter, asılırsa tur kurtulur.
            { type: 'command', command: cmd, timeout: 10 },
          ],
        },
      ];
    }
    if (opts.killGuard !== false) {
      // KILL-GUARD-01 — KAPI 1. `matcher` YALNIZ Bash: kapı kabuk yüzeyine bakar,
      // Read/Edit/MCP çağrılarının önünde durup her turu yavaşlatmaz.
      // timeout 5sn: hook HER Bash çağrısını bloklar; asılırsa araç kurtulur
      // (hook'un kendisi fail-open — bkz. killGuardHook.cjs).
      hooks.PreToolUse = [
        {
          matcher: 'Bash',
          hooks: [
            {
              type: 'command',
              command: mcpNode.nodeShellCommand([killGuardHookPath()], { launcher, launcherDir }),
              timeout: 5,
            },
          ],
        },
      ];
    }
    if (!Object.keys(hooks).length) return null;
    writeJsonAtomic(cfgPath, { hooks });
    return cfgPath;
  } catch {
    return null;
  }
}

/**
 * ADP-692 — LİDER spawn'ına tur-başı brifing hook'unu ekle (claude-only, additive).
 * No-op: lider değilse, claude değilse, agentId yoksa ya da yazım başarısızsa.
 */
function withTurnBriefing(argv, commandKey, opts, homedir) {
  // ENG-07 — "claude mü?" DEĞİL, "bu motorun TUR-KANCASI yüzeyi var mı?"
  // (`hooks.userPromptSubmit.flag`). codex'te `hooks: null` → kanal A kurulamaz ve
  // bu kayıp `unsupported.hooks` gerekçesiyle beyanlıdır (supervisor enjeksiyon
  // kanalına düşer, sessizce brifingsiz kalmaz).
  const hook = (engineCapability(commandKey, 'hooks') || {}).userPromptSubmit;
  if (!hook || !hook.flag) return argv;
  // KILL-SWITCH — bir P0 alt-sistemi kapatılabilir olmalı: "bunu brifing mi yapıyor?"
  // sorusu tek env ile cevaplansın (ADP-659/667 emsali). Kapalıyken davranış ADP-692
  // öncesiyle birebir aynıdır (yalnız sertleştirilmiş enjeksiyon kanalı kalır).
  const wantBriefing = crewpaneEnv.readEnv('TURN_BRIEFING') !== '0' && isLeaderSpawn(opts);
  // KILL-GUARD-01 — KAPI 1 LİDER-ÖZEL DEĞİLDİR: ölçülen arıza WORKER pane'inden
  // geldi. Aynı `--settings` dosyası artık her claude ajan pane'ine yazılır; lider
  // dalında ADP-692 kancası da içinde kalır (tek dosya, iki kanca).
  const wantKillGuard = crewpaneEnv.readEnv('KILL_GUARD') !== '0';
  // Ad yalnız DOSYA ADI için; kimliksiz bir pane de kapıyı hak eder → 'pane'e düşer.
  const named = (opts && typeof opts.agentId === 'string' ? opts.agentId.trim() : '')
    || (opts && typeof opts.leaderId === 'string' ? opts.leaderId.trim() : '');
  const agentId = named || 'pane';
  // Brifing kimliksiz ANLAMSIZDIR (hook `--agent` ile defteri süzer) → yalnız o düşer;
  // kapı düşmez. Eski davranış: ikisi de düşerdi.
  const briefing = wantBriefing && !!named;
  if (!briefing && !wantKillGuard) return argv;
  const cfgPath = ensureBriefingSettings(homedir, agentId, {
    briefing,
    killGuard: wantKillGuard,
  });
  if (!cfgPath) return argv;
  return applyArgs(argv, [hook.flag, cfgPath], contributionPosition(commandKey));
}

// ---------------------------------------------------------------------------
// AGY-03 — ANTIGRAVITY: TUR BRİFİNGİ (PreInvocation) + ALT-AJAN BLOĞU (PreToolUse).
// ---------------------------------------------------------------------------
// claude'da bu İKİ iş İKİ AYRI taşıyıcıdan gider: brifing bir bayraktan (`--settings`,
// `withTurnBriefing`) ve blok BAŞKA bir bayraktan (`--disallowedTools`,
// `withSubagentBlock`). Antigravity'de per-launch hook BAYRAĞI YOK; ikisinin de
// taşıyıcısı AGY-01 demetinin `hooks.json`udur → tek adım, tek dosya yazımı.
//
// 🔴 NEDEN MCP ADIMINA BİNDİRİLMEDİ (ölçülmüş tasarım kararı): `mcpRegisterArgs`
// demeti YALNIZ sunucu LİSTESİ olan yollarda yazıyor. Kapıyı oraya koysaydık
// sunucusuz bir antigravity pane'inde alt-ajan bloğu HİÇ kurulmazdı — oysa blok bir
// GÜVENLİK katmanıdır (`SECURITY_CRITICAL_CAPABILITIES`), araç kablolamasının yan
// ürünü değil. Bu yüzden ayrı bir giriş (`agyWorkspacePlugin.writeHooks`) yalnız
// `hooks.json`u (+ eksikse marker `plugin.json`u) yazar; `mcp_config.json`a DOKUNMAZ.
//
// Katkı argv'ye YALNIZ `--add-dir <kök>`tür ve MCP adımı onu zaten eklediyse TEKRAR
// EKLENMEZ (aynı kök, iki kez verilmesi gereksiz).
function withAgyHooks(argv, commandKey, opts, homedir) {
  // "antigravity mi?" DEĞİL, "bu motorun hook taşıyıcısı DEMET mi?" — motor adına
  // göre `if` yazılmaz, karar descriptor'dan çıkar (669. satırın kuralı).
  const hookD = engineCapability(commandKey, 'hooks');
  if (!hookD || hookD.carrier !== 'workspace-plugin') return argv;
  const mcpD = engineCapability(commandKey, 'mcp');
  if (!mcpD || mcpD.kind !== 'workspace-plugin' || !mcpD.rootFlag) return argv;

  // KILL-SWITCH — claude yolundaki AYNI env (tek soru, tek cevap): "bunu brifing mi
  // yapıyor?". Kapalıyken pane ADP-692 öncesiyle birebir aynı davranır.
  const named = (opts && typeof opts.agentId === 'string' ? opts.agentId.trim() : '')
    || (opts && typeof opts.leaderId === 'string' ? opts.leaderId.trim() : '');
  const wantBriefing =
    crewpaneEnv.readEnv('TURN_BRIEFING') !== '0' && isLeaderSpawn(opts) && !!named;
  // Blok koşulu claude ile PARİTE: delegasyon yürütme pane'i + lider pane'i alır,
  // insanın elle açtığı normal pane almaz (`withIdentityFrontmatter` ile aynı ölçüt).
  const blockD = engineCapability(commandKey, 'subagentBlock');
  const wantGuard =
    !!(blockD && blockD.via === 'workspace-plugin-hook')
    && (!!(opts && opts.disallowSubagent === true) || isLeaderSpawn(opts));
  if (!wantBriefing && !wantGuard) return argv;

  const dir = instancePaths.crewpaneHome(homedir);
  // ⚠️ Yorumlayıcı BİR KEZ çözülür ve iki komuta da AYNI nesne verilir (claude
  // yolundaki aynı gerekçe: iki ayrı çözümleme bir DİSK PROBUDUR).
  const launcher = mcpNode.resolveMcpNode();
  const launcherDir = ensureNodeLauncher(dir, { launcher });
  const runner = agyHookRunnerPath();
  const cmd = (args) => mcpNode.nodeShellCommand([runner, ...args], { launcher, launcherDir });

  // 🔴 DOLAYLI HAT (`call_mcp_tool`) BİR İZİN KARARI İSTER — ölçüldü: boş `{}` cevabı
  // aracı DÜŞÜRÜYOR (agyHooks tuzak C). O yüzden kapı MCP'ye ancak pane'in otonomisi
  // ZATEN `full` beyan edilmişken bakar: orada `allow` yeni izin vermez, motorun
  // `always-proceed` hâlini tekrarlar. Beyan `full` değilse dolaylı hat KAPANIR
  // (kapı yerleşik adlara iner) — kullanıcının onay sorusunu sessizce cevaplamaktansa
  // daha dar bir kapı. Karar motor adından değil BEYANDAN çıkar.
  const permissive = ((engineAutonomy(commandKey) || {}).level === 'full');
  const root = agyWorkspacePlugin.pluginRootDir(dir, integrationsPaneKey(opts));
  const written = agyWorkspacePlugin.writeHooks({
    root,
    descriptor: mcpD,
    hooks: {
      permissive,
      briefingCommand: wantBriefing
        ? cmd(['--event', 'PreInvocation', '--home', dir, '--agent', named])
        : null,
      guardCommand: wantGuard
        ? cmd(permissive ? ['--event', 'PreToolUse', '--permissive'] : ['--event', 'PreToolUse'])
        : null,
    },
  });
  if (!written) return argv; // LEAD-BEHAV-01: kayıp sessiz değil — çağıran log'a yazar

  // Kök zaten verildiyse (MCP adımı ekledi) argv'ye DOKUNMA.
  if (Array.isArray(argv) && argv.includes(written.root)) return argv;
  return applyArgs(argv, [mcpD.rootFlag, written.root], contributionPosition(commandKey));
}

// ---------------------------------------------------------------------------
// ADP-585 (Entegrasyon Merkezi / Dalga 0) — kullanıcının ENTEGRASYON MCP server'ları.
// ---------------------------------------------------------------------------
// Kullanıcı Ayarlar'da bir servis bağladığında (Supabase PAT, GitHub PAT, …) o
// anahtar ADP-584 vault'unda ŞİFRELİ durur. Burası anahtarı pane'e taşıyan yoldur:
//   1. `ensureIntegrationsMcpConfig` — ~/.crewpane/integrations-mcp.json'ı yazar.
//      DİSKE DÜZ-METİN SECRET ASLA (Kural 1): config yalnız `${CREWPANE_SECRET_<id>}`
//      REFERANSI taşır; gerçek değeri claude, pane env'inden genişleterek MCP child'a
//      verir. (claude'un MCP config'i env genişletmesini destekler — ADP-585 gerçek
//      pane koşusunda doğrulandı; desteklemeseydi server auth hatası verirdi, sessiz
//      düz-metin YAZILMAZDI.)
//   2. Kural 2 — server-BAŞINA dar env: her MCP child yalnız KENDİ `${VAR}`'ını alır
//      (GitHub server'ı Supabase anahtarını görmez). Pane sürecinin kendisi çözümlenen
//      anahtarları görür — bu, v1'de KABUL EDİLEN risktir (ADP-584 spike'ı ölçtü;
//      raporun "pane-içi görünürlük" kararına bak). Hafifletmeler: yalnız bu pane için
//      çözümlenen kayıtlar enjekte edilir + env adı OPAQUE'tir (servis adı taşımaz) +
//      miras alınan CREWPANE_SECRET_* değerleri sanitizeEnv'de SİLİNİR.
//   3. Kural 4 — config HER spawn'da yeniden yazılır: vault'tan silinen bir kayıt bir
//      sonraki spawn'da hem env'den hem config'ten düşer (kayıt kalmazsa dosya SİLİNİR).
// Argv tarafı ADDITIVE'dir (`--mcp-config`, `--strict-mcp-config` YOK): kullanıcının
// kendi MCP server'ları korunur; lider/browser STRICT yolları da bozulmaz (onlar
// kendi config'lerini ayrıca taşır — bu yalnız bir dosya daha ekler).

/**
 * INT-0-C — ENTEGRASYON CONFIG'İ PANE BAŞINA. Eskiden TEK paylaşımlı yol vardı
 * (`<accountHome>/integrations-mcp.json`) ve `ensureIntegrationsMcpConfig` liste
 * boşsa onu SİLİYORDU → başka bir pane'in spawn'ı, CANLI pane'lerin gösterdiği
 * dosyayı yok ediyordu (ölçüldü 2026-09-05: üç pane'in argv'si dosyayı gösteriyor,
 * dosya diskte YOK). Arıza SESSİZ: MCP çocukları spawn anında ayağa kalktığı için
 * araçlar çalışmaya devam eder, `crewpane_integrations` "BAĞLI" der — kayıp
 * ancak pane yeniden başlatılınca görünür.
 *
 * Pane anahtarı `identityPaneKey` ile ÜRETİLİR (aynı ev: `engine-identity/` ve
 * `engine-isolation/` dizinleri de bu anahtarla adlanıyor; ikinci bir adlandırma
 * şeması iki farklı "bu pane kim" cevabı doğururdu). Anahtar dosya-adı-güvenlidir
 * (`[^A-Za-z0-9_.-]` süzülür) → ajan adı dizin dışına çıkamaz.
 */
function integrationsMcpConfigDir(homedir) {
  return path.join(instancePaths.crewpaneHome(homedir), 'mcp');
}

/**
 * INT-0-C — bu pane'in config dosya anahtarı.
 *
 * `identityPaneKey` (agentId → paneId → 'pane') aynen KULLANILIR — aynı ev, aynı
 * temizleme kuralı — ama BİR kaynak daha eklenir: `leaderId`. Gerekçe ölçüldü:
 * lider spawn'ı (`role:'lead'`) her zaman `agentId` taşımaz; taşımadığında lider ve
 * kimliksiz bir pane AYNI dosyaya düşer ve kartın düzelttiği yıkım lider↔worker
 * arasında geri gelirdi.
 *
 * KALAN RİSK (bilinçli): ne agentId ne paneId ne leaderId taşıyan İKİ pane hâlâ
 * `integrations-pane.json`'ı paylaşır. Zararsız kalmasının sebebi bağlamlarının da
 * AYNI olması (aynı kasa, aynı proje/ortam) → ikisi de AYNI içeriği yazar. Gerçek
 * çözüm `paneId`'nin buildSpawn'a geçirilmesidir; paneId bugün buildSpawn'dan SONRA
 * (main.js) üretiliyor, o sıralama bu kartın kapsamı dışında.
 */
function integrationsPaneKey(opts) {
  const o = opts || {};
  if (o.agentId || o.paneId) return identityPaneKey(o);
  return identityPaneKey({ agentId: o.leaderId });
}

function integrationsMcpConfigPath(homedir, opts) {
  return path.join(integrationsMcpConfigDir(homedir), `integrations-${integrationsPaneKey(opts)}.json`);
}

/**
 * INT-0-C — SAHİPSİZ config artıkları. Pane kapanışı normalde kendi dosyasını siler
 * (`cleanupIntegrationsMcpConfig`), ama uygulama ÇÖKERSE o adım hiç koşmaz. Yaş
 * kapısı bunu sınırlar: kimse 14 günden eski bir config'i okumuyor olamaz (o pane'in
 * süreci çoktan ölmüştür), dolayısıyla silmek CANLI bir pane'i bozamaz — kartın
 * düzelttiği yıkımı arka kapıdan geri getirmemenin şartı budur.
 */
const INTEGRATIONS_CONFIG_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

function sweepStaleIntegrationsConfigs(homedir, now = Date.now()) {
  const dir = integrationsMcpConfigDir(homedir);
  let removed = 0;
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return 0; // dizin yok — süpürecek bir şey de yok
  }
  for (const name of names) {
    if (!/^integrations-.+\.json$/.test(name)) continue;
    const full = path.join(dir, name);
    try {
      if (now - fs.statSync(full).mtimeMs <= INTEGRATIONS_CONFIG_MAX_AGE_MS) continue;
      fs.unlinkSync(full);
      removed += 1;
    } catch {
      /* best-effort */
    }
  }
  return removed;
}

/**
 * INT-0-C — 0.2.42 ve öncesinin PAYLAŞIMLI dosyası. Yeni şemayla yazarken bir kez
 * silinir: geride kalırsa hiçbir pane onu okumaz ama diskte bayat `${VAR}`
 * referansları taşır (revoke edilmiş bir anahtarın adı orada durur).
 */
function removeLegacySharedIntegrationsConfig(homedir) {
  try {
    fs.unlinkSync(path.join(instancePaths.crewpaneHome(homedir), 'integrations-mcp.json'));
    return true;
  } catch {
    return false; // zaten yok
  }
}

/**
 * INT-0-C — pane kapanınca KENDİ config'ini düşür. Kural 4'ün ("bayat config
 * kalmasın") yıkıcı olmayan hâli: yalnız bu pane'in dosyasına dokunur, komşunun
 * canlı dosyasına ASLA. İki kapanış yolundan da (pty:kill + onExit) çağrılabilsin
 * diye tekrar çağrı ZARARSIZDIR.
 * @returns {boolean} gerçekten bir dosya silindi mi
 */
function cleanupIntegrationsMcpConfig(homedir, opts) {
  // MCP-LAZY-01 — vekil manifesti de bu pane'in dosyasidir; config'le BIRLIKTE
  // duser. Geride kalirsa bayat bir `${VAR}` referans listesi diskte durur.
  try {
    fs.unlinkSync(integrationsLazyManifestPath(homedir, opts));
  } catch {
    /* zaten yok */
  }
  try {
    fs.unlinkSync(integrationsMcpConfigPath(homedir, opts));
    return true;
  } catch {
    return false;
  }
}

/**
 * AGY-01 — pane kapanışında bu pane'in plugin KÖKÜNÜ sil.
 *
 * `cleanupIntegrationsMcpConfig` ile AYNI ev, AYNI anahtar (`integrationsPaneKey`) ve
 * AYNI güvenlik gerekçesi: kök pane BAŞINA olduğu için silme YIKICI DEĞİLDİR — yalnız
 * bu pane'in kökünü siler, komşunun CANLI demetine ASLA dokunmaz. `true` = silindi.
 */
function cleanupAgyWorkspacePlugin(homedir, opts) {
  return agyWorkspacePlugin.cleanupPlugin(instancePaths.crewpaneHome(homedir), integrationsPaneKey(opts));
}

/**
 * AGY-01 — SAHİPSİZ plugin kökleri (uygulama çökerse pane kapanışı hiç koşmaz).
 * `sweepStaleIntegrationsConfigs` ile aynı yaş kapısı: 14 günden eski bir kökü
 * okuyor olan CANLI bir pane olamaz (o sürecin ömrü çoktan bitti).
 */
function sweepStaleAgyWorkspacePlugins(homedir, now = Date.now()) {
  return agyWorkspacePlugin.sweepStalePlugins(instancePaths.crewpaneHome(homedir), now);
}

/**
 * Write (or REMOVE) the integrations MCP config for THIS spawn's resolved credentials.
 * Best-effort: returns the config path, or null when there is nothing to register /
 * on IO failure (→ the pane opens exactly as it does today, just without the
 * integration servers). `resolved` comes from integrationResolver.resolve().
 *
 * Kural 4 gereği liste BOŞSA dosya silinir: "kaydı sildim ama config'te duruyor"
 * durumu hiç oluşmaz (revoke kanıtı dosyanın YOKLUĞU ile de görülebilir).
 */
/**
 * INT-0-A — bir server'ın env bloğuna eklenecek, anahtar DIŞI kullanıcı alanları.
 *
 * YETKİ KATALOGDADIR, KAYITTA DEĞİL (`integrationResolver` dosya başlığındaki
 * "komut/argümanlar DAİMA katalogdan gelir" duruşunun env karşılığı):
 *   • yalnız `entry.userFields` ile BEYAN EDİLEN adlar geçer — kasa dosyasına elle
 *     yazılmış bir `PATH` bir MCP child'ının ortamına ASLA düşmez,
 *   • `entry.envVar` (sırrın adı) DIŞLANIR — bir userField, sır referansını düz
 *     metinle EZEMEZ (Kural 1'e arka kapı yok).
 */
function userFieldEnv(entry, userFields) {
  const out = {};
  if (!userFields || typeof userFields !== 'object') return out;
  const declared = Array.isArray(entry.userFields) ? entry.userFields : [];
  for (const field of declared) {
    const name = field && field.envVar;
    if (typeof name !== 'string' || !name || name === entry.envVar) continue;
    const value = userFields[name];
    if (typeof value !== 'string' || !value.trim()) continue;
    out[name] = value;
  }
  return out;
}

/**
 * INT-0-B — TRANSPORT SÖZLEŞMESİ: bir katalog girişinin config bloğunu üretir.
 *
 * Kart öncesi durum: `entry.mcpServer.transport` BEYAN EDİLİYOR ama yazıcı onu HİÇ
 * okumuyordu — `transport:'http'` bir giriş `{command:undefined, args:[]}` olarak
 * SESSİZCE yanlış yazılırdı. Artık iki dal var ve tanımadığı hiçbir şeyi yazmaz.
 *
 *   stdio → { command, args, env }            (bugünkü davranış, birebir korunur)
 *   http  → { type:'http', url, headers }     (claude'un yerel HTTP taşıması)
 *
 * Yer tutucu haritası (`${X}`) İKİ kaynaktan doldurulur ve başkası KABUL EDİLMEZ:
 *   • `entry.envVar`      → `${CREWPANE_SECRET_<id>}` (Kural 1: değer değil REFERANS;
 *                           claude header'ı pane env'inden genişletir),
 *   • beyan edilen userField adları → düz değer (gizli değiller — INT-0-A duruşu).
 * Haritada olmayan bir `${X}` kalırsa blok `null` döner ve giriş config'e HİÇ
 * YAZILMAZ (fail-closed): yarım genişletilmiş bir header "yetkisiz istek" olarak
 * değil, "bu servis bağlı değil" olarak görünür — sessiz yanlışın panzehiri budur.
 *
 * `https` ZORUNLU: sır bir header'da gidiyor, düz `http://` onu ağda açığa çıkarır.
 */
function integrationServerBlock(entry, item) {
  const server = entry.mcpServer;
  if (!server) return null;
  const fields = userFieldEnv(entry, item.userFields);
  const transport = server.transport === 'http' ? 'http' : 'stdio';

  if (transport === 'stdio') {
    if (typeof server.command !== 'string' || !server.command) return null;
    // MCP-COST-01 — SARMALAYICIYI DUSUR. `npx -y <paket>` sunucunun omru boyunca
    // is yapmayan bir `npm exec` sureci ayakta tutar (olculdu: filoda 48 surec /
    // 1.779 MB; el sikisma coolify'da 465→109 ms). Paket npx onbelleginde zaten
    // cozulmus duruyor → dogrudan `node <bin>` calistirilir. Cozulemezse `null`
    // doner ve BUGUNKU komut aynen korunur (fail-open, davranis degismez).
    // KILL-SWITCH (ADP-659/667 emsali) — bir alt-sistem kapatilabilir olmali.
    // `CREWPANE_MCP_NPX_DIRECT=0` ile davranis MCP-COST-01 oncesiyle BIREBIR
    // ayni olur (katalogdaki `npx` komutu aynen yazilir).
    const direct = crewpaneEnv.readEnv('MCP_NPX_DIRECT') === '0'
      ? null
      : npxDirect.directCommand(server);
    return {
      command: direct ? direct.command : server.command,
      args: direct ? [...direct.args] : (Array.isArray(server.args) ? [...server.args] : []),
      // Kural 1 + Kural 2: REFERANS yazılır (değer değil), yalnız bu server'ın anahtarı.
      // INT-0-A — `userFields` (Coolify sunucu adresi, Supabase proje ref'i…) DÜZ
      // DEĞER yazılır: gizli değiller ve `${VAR}` genişletmesine sokmanın hiçbir
      // faydası yok. Kural 1 GEVŞEMEZ — sır hâlâ yalnız referans olarak durur.
      env: { [entry.envVar]: `\${${item.envVar}}`, ...fields, ...(direct && direct.env) },
    };
  }

  const map = new Map([[entry.envVar, `\${${item.envVar}}`]]);
  for (const [name, value] of Object.entries(fields)) map.set(name, value);
  let broke = false;
  const expand = (raw) => String(raw).replace(/\$\{([A-Za-z0-9_]+)\}/g, (whole, name) => {
    if (!map.has(name)) { broke = true; return whole; }
    return map.get(name);
  });

  if (typeof server.url !== 'string' || !server.url) return null;
  const url = expand(server.url);
  const headers = {};
  for (const [name, value] of Object.entries(server.headers || {})) {
    if (typeof value !== 'string') return null;
    headers[name] = expand(value);
  }
  if (broke) return null;                              // çözülemeyen yer tutucu → giriş DÜŞER
  if (!/^https:\/\//i.test(url)) return null;          // sır header'da: düz http YASAK
  return { type: 'http', url, headers };
}

// ---------------------------------------------------------------------------
// MCP-LAZY-01 (KATMAN 2) — "ILK CAGRIDA BASLAT" (tembel baslatma).
// ---------------------------------------------------------------------------
// claude, config'teki HER server'i oturum basinda acar. Tembelligi ancak araya bir
// vekil koyarak alabiliriz — ve SERVIS BASINA vekil KAZANC URETMEZ (olculdu: bos bir
// node stdio sureci 33 MB, erteledigi server 25-37 MB). Kazanc yalniz PANE BASINA TEK
// vekil dort servisi cogullarsa gelir (33 MB vs ~120 MB). `mcpLazyProxy.cjs` odur.
//
// ESIK NEDEN 2: tek servisli bir pane'de vekil (33 MB) erteledigi server'dan (~30 MB)
// PAHALIDIR. "Tembellestirmeden once tembellestiricinin tabanini olc" dersinin
// dogrudan uygulamasi: kazanc yoksa vekil KURULMAZ, bugunku dogrudan yol kalir.
const LAZY_PROXY_FILE = 'mcpLazyProxy.cjs';
const LAZY_MIN_SERVICES_DEFAULT = 2;
// Bosta kapatma varsayilani. 10 dk: soguk baslangic 0,12-0,68 sn olculdu (MCP-COST-01),
// yani geri gelme bedeli kullanicinin hissetmeyecegi kadar ucuz; buna karsilik bir
// gunluk oturumda cagrilmayan servis saatlerce bellek tutmaz.
const LAZY_IDLE_MS_DEFAULT = 10 * 60 * 1000;

/** Vekilin mutlak yolu (pakette asar-unpacked). */
function lazyProxyPath() {
  return path.join(mcpServerDir(), LAZY_PROXY_FILE);
}

/** Bu pane'in vekil manifesti (SIR TASIMAZ — yalniz komut + env DEGISKEN ADLARI). */
function integrationsLazyManifestPath(homedir, opts) {
  return path.join(integrationsMcpConfigDir(homedir), `lazy-${integrationsPaneKey(opts)}.json`);
}

/** Onbellek dizini: servis basina arac listesi (surec acmadan `tools/list` icin). */
function integrationsToolCacheDir(homedir) {
  return path.join(integrationsMcpConfigDir(homedir), 'tool-cache');
}

/**
 * Tembel baslatma bu spawn'da acik mi + esik kac.
 * KONTROL KOLU: `CREWPANE_MCP_LAZY=0` → tam olarak MCP-LAZY-01 oncesi davranis.
 */
function lazyEnabled() {
  return crewpaneEnv.readEnv('MCP_LAZY') !== '0';
}

function lazyMinServices() {
  const raw = Number(crewpaneEnv.readEnv('MCP_LAZY_MIN'));
  return Number.isFinite(raw) && raw >= 1 ? raw : LAZY_MIN_SERVICES_DEFAULT;
}

/**
 * Dogrudan server bloklarini TEK vekil girdisine cevir.
 *
 * • Yalniz `stdio` bloklar cogullanir. `http` tasimali bir servis (PostHog) zaten
 *   YEREL SUREC ACMAZ — onu vekile sokmak sifir kazanc, artı bir HTTP istemcisi
 *   yazmak demek olurdu; oldugu gibi birakilir.
 * • Vekilin env blogu dort servisin `${VAR}` REFERANSINI tasir (Kural 1 aynen: deger
 *   degil referans; claude pane env'inden genisletir). Vekil her cocuga YALNIZ kendi
 *   anahtarini gecirir — Kural 2 cocuk seviyesinde korunur.
 * @returns {{servers:Object, manifest:object}|null} kurulamiyorsa null (fail-open)
 */
function buildLazyIntegrationServers(stdioBlocks, homedir, opts) {
  const ids = Object.keys(stdioBlocks);
  if (ids.length < lazyMinServices()) return null;
  const proxyScript = lazyProxyPath();
  try {
    if (!fs.existsSync(proxyScript)) return null; // vekil pakette yoksa BUGUNKU yol
  } catch {
    return null;
  }
  const env = {};
  const services = [];
  for (const id of ids) {
    const b = stdioBlocks[id];
    // Launcher mode belongs to this child, not the proxy's shared environment.
    const envKeys = Object.keys(b.env || {}).filter(k => k !== 'ELECTRON_RUN_AS_NODE');
    for (const k of envKeys) env[k] = b.env[k];   // `${CREWPANE_SECRET_x}` / duz userField
    services.push({ id, command: b.command, args: Array.isArray(b.args) ? [...b.args] : [], envKeys,
      ...(b.env && b.env.ELECTRON_RUN_AS_NODE === '1' ? { runAsNode: true } : {}),
    });
  }
  const manifestPath = integrationsLazyManifestPath(homedir, opts);
  // BOSTA KAPATMA — N dk cagrilmayan cocuk iner, sonraki cagrida geri gelir.
  // Deger MANIFESTE yazilir (vekilin kendi env'ine degil): claude'un MCP cocuguna
  // hangi env'i gecirdigi motor detayidir, manifest ise BIZIM sozlesmemizdir.
  // `CREWPANE_MCP_IDLE_MIN=0` → hic indirme (kontrol kolu).
  const idleMin = Number(crewpaneEnv.readEnv('MCP_IDLE_MIN'));
  const manifest = {
    version: 1,
    cacheDir: integrationsToolCacheDir(homedir),
    idleMs: Number.isFinite(idleMin) && idleMin >= 0 ? idleMin * 60 * 1000 : LAZY_IDLE_MS_DEFAULT,
    services,
  };
  const entry = mcpEntry(proxyScript);
  return {
    manifestPath,
    manifest,
    servers: {
      // Server ADI arac adlarinin onune gecer: `mcp__integrations__vercel_getAuthUser`.
      integrations: { command: entry.command, args: [...entry.args, manifestPath], env: { ...env, ...entry.env } },
    },
  };
}

/**
 * MCP-LAZY-01 — BU PANE'IN CONFIG'INDE GERCEKTEN NE YAZIYOR (iddia degil OLCUM).
 *
 * Pane kaydina "tembel mi" diye yazacaksak, karari IKINCI KEZ hesaplamak yerine
 * YAZILAN DOSYAYI okuruz: kural bir gun degisirse kayit sessizce yalan soylemez
 * (`ref_gate_green_on_wrong_target` sinifi tuzagin panzehiri). Dosya yoksa null.
 * @returns {{lazy:boolean, servers:string[]}|null}
 */
function readIntegrationsConfigFacts(homedir, opts) {
  try {
    const doc = JSON.parse(fs.readFileSync(integrationsMcpConfigPath(homedir, opts), 'utf8'));
    const servers = Object.keys((doc && doc.mcpServers) || {});
    return { lazy: servers.includes('integrations'), servers };
  } catch {
    return null;
  }
}

function ensureIntegrationsMcpConfig(homedir, resolved, opts) {
  const list = Array.isArray(resolved) ? resolved.filter(Boolean) : [];
  try {
    const dir = integrationsMcpConfigDir(homedir);
    const cfgPath = integrationsMcpConfigPath(homedir, opts);
    const mcpServers = {};
    for (const item of list) {
      const entry = item.entry;
      if (!entry || !entry.mcpServer || !entry.envVar || !item.envVar) continue;
      const block = integrationServerBlock(entry, item); // INT-0-B: transport'a göre
      if (!block) continue;                              // fail-closed (sessiz yanlış yazma YOK)
      mcpServers[entry.id || item.service] = block;
    }
    // MCP-LAZY-01 — COGULLAYICI. `stdio` bloklar tek vekile toplanir; `http`
    // bloklar (yerel surec acmayanlar) AYNEN kalir. Kurulamazsa `null` doner ve
    // bugunku dogrudan yol yazilir (fail-open: en kotu hali "hicbir sey degismedi").
    if (lazyEnabled()) {
      const stdioBlocks = {};
      const httpBlocks = {};
      for (const [id, block] of Object.entries(mcpServers)) {
        if (block && block.type === 'http') httpBlocks[id] = block;
        else stdioBlocks[id] = block;
      }
      const lazy = buildLazyIntegrationServers(stdioBlocks, homedir, opts);
      if (lazy) {
        fs.mkdirSync(dir, { recursive: true });
        writeJsonAtomic(lazy.manifestPath, lazy.manifest);
        for (const k of Object.keys(mcpServers)) delete mcpServers[k];
        Object.assign(mcpServers, httpBlocks, lazy.servers);
        if (opts && typeof opts.log === 'function') {
          opts.log(`integrations: tembel baslatma acik → ${lazy.manifest.services.length} servis ilk cagriya kadar surec ACMAZ`);
        }
      }
    }
    if (!Object.keys(mcpServers).length) {
      // INT-0-C — YALNIZ BU PANE'İN dosyası düşer. Eskiden burada paylaşımlı yol
      // siliniyordu: bir pane'in "benim entegrasyonum yok" hâli, komşunun canlı
      // config'ini yok ediyordu. Silme SESSİZDİ (log satırı yoktu) — teşhisi bu
      // kadar zorlaştıran şey de oydu, bu yüzden artık iz bırakır.
      let removed = false;
      try {
        fs.unlinkSync(cfgPath);
        removed = true;
      } catch {
        /* zaten yok — Kural 4 sağlanmış */
      }
      if (removed && opts && typeof opts.log === 'function') {
        opts.log(`integrations: bu pane için çözümlenen kayıt yok → ${path.basename(cfgPath)} silindi`);
      }
      return null;
    }
    fs.mkdirSync(dir, { recursive: true });
    writeJsonAtomic(cfgPath, { mcpServers });
    removeLegacySharedIntegrationsConfig(homedir); // 0.2.42 artığı bir kez düşer
    sweepStaleIntegrationsConfigs(homedir);        // çökme sonrası sahipsiz artıklar
    return cfgPath;
  } catch {
    return null;
  }
}

/**
 * Give an agent pane its CONNECTED integrations (mirrors withTaskCapable's shape).
 *   • claude — çözümlenen secret'ları `childEnv[CREWPANE_SECRET_<id>]`'e koyar ve
 *     ADDITIVE bir `--mcp-config <integrations>` ekler (`--strict-mcp-config` YOK).
 *   • codex  — v1'de KAPSAM DIŞI, kasıtlı: codex MCP child'ları pane env'ini MİRAS
 *     ALMAZ (ADP-227 ölçümü), dolayısıyla anahtar `-c mcp_servers.*.env=…` ile ARGV'ye
 *     yazılmak zorunda kalırdı → `ps` çıktısında düz-metin PAT. Bunu sessizce yapmaktansa
 *     codex panelinde entegrasyon YOK (raporda açık iş olarak kayıtlı).
 * Config yazımı liste boş olsa da çalışır (Kural 4: bayat config temizlenir).
 * Saf değil (best-effort dosya yazımı) — withTaskCapable ile aynı sözleşme.
 */
/**
 * MCP-COST-01 + MCP-LAZY-01 (KATMAN 1) — PROFIL KAPISI, TEK EV.
 *
 * "Bagli kalsin ama bu pane'de acilmasin" isareti UC kapsamda cozulur (rol → proje →
 * genel → varsayilan ACIK). Suzulen kayit ne env'e ne MCP config'ine girer; kasadaki
 * kayda DOKUNULMAZ (`integ:list` hala BAGLI der, `integ:test` hala calisir).
 *
 * ⚠️ NEDEN AYRI FONKSIYON: kapi eskiden yalniz `withIntegrations`in ICINDE vardi, ama
 * pane KAYDINA yazilan "enjekte edilenler" listesi SUZULMEMIS listeden uretiliyordu →
 * kapali bir servis icin `toolsLiveInThisPane: true` denirdi (kayit davranisin aynasi
 * degil, IDDIASI olurdu; ajan olmayan bir araci arardi). Artik iki taraf da BU fiili
 * cagirir. Idempotent: suzulmus bir listeyi tekrar suzmek no-op'tur.
 * @returns {{kept:Array, skipped:string[], reasons:Object<string,string>}}
 */
function gateIntegrations(resolved, opts, homedir) {
  const all = Array.isArray(resolved) ? resolved.filter(Boolean) : [];
  return integrationAutostart.filterResolved(all, instancePaths.crewpaneHome(homedir), {
    scope: integrationAutostart.scopeOf(opts),
  });
}

function withIntegrations(argv, commandKey, opts, homedir, childEnv, resolved) {
  // ENV-03 YAYIN MODU KİLİDİ (ENV-R3 §4.12 — ÖLÇÜLDÜ 2026-08-26).
  // Bir ajan pane'inin env'inde entegrasyon sırları DÜZ METİN durur
  // (CREWPANE_SECRET_*). Bu tasarım gereğidir — ama YAYIN sırasında ekrandaki
  // bir pane'de `env` yazan herkes onları GÖRÜR (ölçüm: bu makinede PostHog kişisel
  // API anahtarı + Sentry kullanıcı jetonu pane env'inde açıktaydı). Yayında
  // entegrasyon HİÇ kurulmaz: araçlar "bağlı değil" der, sır ekrana düşmez.
  // Bayrak yalnız SIKILAŞTIRIR (ENV-R3 §4.15) — yazılması hiçbir şeyi gevşetmez.
  const broadcastEnv = (childEnv && childEnv.CREWPANE_BROADCAST) ?? process.env.CREWPANE_BROADCAST;
  if (String(broadcastEnv || '').trim() === '1') return argv;
  const gate = gateIntegrations(resolved, opts, homedir);
  const list = gate.kept;
  if (gate.skipped.length && opts && typeof opts.log === 'function') {
    const why = gate.skipped.map((sv) => `${sv}(${gate.reasons[sv] || 'genel'})`).join(', ');
    opts.log(`integrations: bu pane'in profilinde kapali → ${why} (baglanti duruyor)`);
  }
  const cfgPath = ensureIntegrationsMcpConfig(homedir, list, opts); // Kural 4: her spawn'da tazele (INT-0-C: pane başına)
  if (!list.length || !cfgPath) return argv;
  // ENG-07 — KAPI ARTIK MOTOR ADI DEĞİL, YETENEĞİN KENDİSİ: anahtar yalnız MCP
  // çocuğu pane env'ini MİRAS ALIYORSA (`mcp.envInheritance === true`) verilebilir.
  // Miras almayan motorda (codex) anahtar `-c … .env={…}` ile ARGV'ye yazılmak
  // zorunda kalırdı → `ps` çıktısında düz-metin PAT. Bunu sessizce yapmak yerine
  // entegrasyon HİÇ kurulmaz; kayıp `integrationsInjectable`in okuduğu aynı
  // beyandan (partial/unsupported.mcp) rozete ve log'a düşer.
  if (!integrationsInjectable(commandKey)) return argv;
  if (childEnv && typeof childEnv === 'object') {
    for (const item of list) {
      if (typeof item.envVar === 'string' && typeof item.secret === 'string') {
        childEnv[item.envVar] = item.secret;
      }
    }
  }
  const args = mcpRegisterArgs(commandKey, { configPath: cfgPath, strict: false });
  return applyArgs(argv, args, contributionPosition(commandKey));
}

// ---------------------------------------------------------------------------
// CIDX-1 — KOD İNDEKSİ (opsiyonel, proje başına, VARSAYILAN KAPALI).
// ---------------------------------------------------------------------------
// Kullanıcının kendi makinesine kurduğu `codebase-memory-mcp` ikilisini, YALNIZ
// o proje için anahtarı açılmışsa, ajan pane'ine bir MCP server olarak verir.
//
// ÜÇ ŞEYİ *YAPMADIĞI* İÇİN GÜVENLİ:
//   1. YENİ ENJEKSİYON YOLU YAZMAZ. `mcpRegisterArgs` → additive `--mcp-config`
//      zinciri (ADP-183 task board, ADP-200 browser, ADP-585 entegrasyonlar) aynen
//      kullanılır. Argv'ye tek bir YENİ bayrak girmez; yalnız bir config dosyası
//      daha eklenir. `--strict-mcp-config` YOK → kullanıcının kendi server'ları ve
//      lider/browser strict yolları aynen korunur.
//   2. SIR TAŞIMAZ. Bu MCP %100 yereldir, anahtar istemez (CODE-INDEX-R1 §6) →
//      `credentialVault`/`CREWPANE_SECRET_*` yoluna HİÇ girmez. Belgeye yazılan
//      girdide `env` bloğu YOKTUR (codeIndex.serverEntry). Entegrasyon deseninin
//      yalnız ENJEKSİYON yarısı ödünç alınır, KASA yarısı değil.
//   3. VARSAYILAN AÇILMAZ. Karar `trusted.codeIndex` üzerinden MAIN'den gelir
//      (ayar okuması main-only — `opts` renderer-kontrollüdür, ADP-580 emsali).
//      Çözümleyici yoksa/`null` dönerse bu fonksiyon TAM ANLAMIYLA no-op'tur:
//      bugünkü argv bit-bit korunur.
//
// KAPI MOTOR ADI DEĞİL, YETENEĞİN KENDİSİ (ENG-07 disiplini): server bir
// KOMUT YOLUDUR (node scripti değil), dolayısıyla ancak MCP taşıyıcısı bir CONFIG
// DOSYASI olan motorda ifade edilebilir. codex bu kapıdan GEÇEMEZ — taşıyıcısı
// `-c mcp_servers.…` argv override'ıdır ve kartın "codex kapsam dışı" (ADP-227)
// kuralı böylece motor adı yazmadan, yapısal olarak sağlanır.
//
// ⚠️ MVP SINIRI (CIDX-2'nin işi): burada ikilinin araçlarının TAMAMI açılır (09.09
// koşumunda pane'e ulaşan araç sayısı ÖLÇÜLDÜ: 14 — eskiden "15" yazıyordu) ve
// araç yüzeyi kırpılmaz. Bunun bedeli JETON DEĞİL — CODEINDEX-PROOF-01 §4 uçtan uca
// ölçtü: kırpılmamış yüzeyin yükü 216 jeton/tur (motor şemaları talep üzerine
// yüklüyor; eski "≈5.300 jeton/tur" rakamı ölçülmemiş bir tahmindi). Yüzeyi kırpmanın
// gerekçesi bugün başka: 14 araç ADI arasından model doğru olanı SEÇMİYOR (A/B'de
// kendiliğinden 0 çağrı). Graf-yalnız sarmalayıcı (3 araç + tazelik beyanı +
// `get_code_snippet` KAPALI) CIDX-2'de gelir.

/** Belge yolu — task/browser ile aynı ev, aynı adlandırma sözleşmesi. */
function codeIndexMcpConfigPath(homedir, commandKey) {
  return path.join(instancePaths.crewpaneHome(homedir), mcpConfigFileName('code-index-mcp', commandKey));
}

/**
 * Best-effort: YALNIZ kod indeksi server'ını kaydeden bir MCP belgesi yaz.
 * IO patlarsa `null` → pane araçsız ama SORUNSUZ açılır (ensureTaskMcpConfig sözleşmesi).
 *
 * Belge PANE BAŞINA DEĞİL, motor başına yazılır ve bu bilinçlidir: içerik yalnız
 * ikilinin YOLUNA bağlıdır (proje adı bir ARAÇ ARGÜMANIdır, config'te yer almaz),
 * yani iki pane aynı dosyayı yazsa da AYNI baytları yazar. INT-0-C'nin (paylaşımlı
 * dosyayı silen komşu) yıkımı burada yapısal olarak imkânsız: bu yol hiç SİLMEZ.
 */
function ensureCodeIndexMcpConfig(homedir, commandKey, server) {
  try {
    if (!server || typeof server.command !== 'string' || !server.command) return null;
    const dir = instancePaths.crewpaneHome(homedir);
    fs.mkdirSync(dir, { recursive: true });
    const cfgPath = codeIndexMcpConfigPath(homedir, commandKey);
    writeJsonAtomic(cfgPath, mcpConfigDoc(commandKey, {
      [codeIndexStore.SERVER_NAME]: { command: server.command, args: Array.isArray(server.args) ? [...server.args] : [] },
    }));
    return cfgPath;
  } catch {
    return null;
  }
}

/**
 * CIDX-1 — bu motora kod indeksi VERİLEBİLİR Mİ?
 * Tek ölçüt taşıyıcının şekli: server bir KOMUT (ikili yolu) olduğu için ancak
 * `mcp.kind === 'config-file'` olan motorda ifade edilebilir. `cli-overrides` /
 * `config-profile` (codex) yolunda aynı şey argv'ye yazılmak zorunda kalırdı —
 * kapsam dışı bırakılmasının gerekçesi (ADP-227) budur ve burada BEYANDAN okunur.
 */
function codeIndexInjectable(commandKey) {
  const d = engineCapability(commandKey, 'mcp');
  return !!(d && d.kind === 'config-file' && d.flag);
}

/**
 * Ayarı AÇIK olan projenin pane'ine kod indeksi MCP'sini ekle (additive).
 * `trusted.codeIndex` yoksa (bugünkü çağrıların çoğu, testler) → argv DEĞİŞMEZ.
 */
function withCodeIndex(argv, commandKey, opts, homedir, trusted) {
  const resolver = trusted && trusted.codeIndex;
  if (!resolver || typeof resolver.resolve !== 'function') return argv;
  if (!codeIndexInjectable(commandKey)) return argv;
  // PROJE KİMLİĞİ — ÖLÇÜLDÜ, VARSAYILMADI: `opts.projectId` bugün renderer'ın
  // HİÇBİR spawn çağrısında yok (`grep -rn projectId src/` → yalnız tip tanımı).
  // Yalnız ona bakan bir kapı sessizce HİÇ AÇILMAZDI: ayar açık, araç yok, hata yok
  // — `ref_gate_green_on_wrong_target` sınıfı. Ürünün pane'lerde gerçekten taşıdığı
  // kimlik DEPARTMANDIR ve board sözleşmesinde proje slug'ı zaten "departmandan
  // türer" (create_task: "project — defaults to your department"). O yüzden kimlik
  // önce `projectId`ten, yoksa `department`tan okunur. İkisi de yoksa KAPALI.
  const ctx = integrationContextFor(opts); // proje kimliğinin TEK okuma yeri
  const projectId = ctx.projectId
    || normalizeDepartment(opts && opts.department) || null; // TEAM-CASE-01 — proje kimliği = kanonik takım
  let resolved = null;
  try {
    resolved = resolver.resolve(projectId);
  } catch {
    return argv; // çözümleyici patlarsa spawn ASLA bloklanmaz
  }
  if (!resolved || !resolved.server) return argv;
  const args = mcpRegisterArgs(commandKey, {
    configPath: () => ensureCodeIndexMcpConfig(homedir, commandKey, resolved.server),
    strict: false, // kullanıcının + ürünün diğer MCP server'ları korunur
  });
  return applyArgs(argv, args, contributionPosition(commandKey));
}

/**
 * ENG-07 — bu motorun pane'ine entegrasyon ANAHTARI enjekte edilebilir mi?
 * Tek kural: MCP çocuğu pane env'ini miras alıyor mu (`mcp.envInheritance`). Sır
 * ENV ile gider, ARGV'ye ASLA (ENG-R3 §14-R3 değişmezi). `buildSpawn` pane kaydına
 * yazdığı `integrations.services` listesini de bu kapıdan geçirir: kayıt davranışın
 * AYNASI olmalı, iddiası değil.
 */
function integrationsInjectable(commandKey) {
  // ENG-10 — KURAL TEK EVDE. Buradaki koşulun bir KOPYASI dursaydı, kullanıcıya
  // gösterilen rozet ("entegrasyonlar bu pane'de çalışmaz") ile DAVRANIŞ (anahtar
  // gerçekten enjekte edildi mi) sessizce ayrışabilirdi — ayrışan bir rozet,
  // olmayan rozetten kötüdür. `mcpCanCarrySecrets` aynı beyanı hem argv hunisine
  // hem yetenek matrisine verir.
  return paneCapabilityMatrix.mcpCanCarrySecrets(engineCapability(commandKey, 'mcp'));
}

/**
 * Spawn bağlamı → resolver context. `projectId`/`integrations`/`integrationEnv` opts'tan
 * (renderer) gelir; hiçbiri SECRET değildir ve resolver bunları normalize eder. Anahtarın
 * kendisi ASLA opts'tan gelmez — `trusted.integrations` main-only (ADP-580 providerKeys
 * emsali). Ortam varsayılanı 'dev'; 'prod' yalnız açık işaretle.
 */
function integrationContextFor(opts) {
  const o = opts || {};
  return {
    projectId: typeof o.projectId === 'string' ? o.projectId : null,
    env: o.integrationEnv === 'prod' ? 'prod' : 'dev',
    services: Array.isArray(o.integrations) ? o.integrations : null,
  };
}

/** Best-effort çözümleme; resolver yoksa/patlarsa BOŞ liste (spawn asla bloklanmaz). */
function resolveIntegrationCreds(opts, trusted) {
  const resolver = trusted && trusted.integrations;
  if (!resolver || typeof resolver.resolve !== 'function') return [];
  try {
    const out = resolver.resolve(integrationContextFor(opts));
    return Array.isArray(out) ? out.filter(Boolean) : [];
  } catch {
    return [];
  }
}

/**
 * Append the browser-capable wiring to a delegated WORKER's argv, per engine:
 *   • claude — `--disallowedTools Task` (keep the hard subagent block, no dup) +
 *     `--mcp-config <browser-only>` + `--strict-mcp-config` — expose ONLY
 *     `crewpane_browser`/task (delegate MCP withheld → no sub-delegation).
 *   • codex  — `--disable multi_agent` (subagent-block equivalent, no dup) + the
 *     `-c` overrides for browser+task (NO delegate server → no sub-delegation;
 *     codex has no --strict equivalent, registration is additive — ADP-227).
 * No-op when not requested, OR for a LEADER spawn (a leader already carries all
 * servers via withLeaderDelegation — do not narrow it to browser-only).
 */
function withBrowserCapable(argv, commandKey, opts, homedir, childEnv, trusted) {
  if (!opts || !opts.browserCapable) return argv;
  if (isLeaderSpawn(opts)) return argv; // leader already has delegate+browser MCP
  // ENG-07 — lider yoluyla AYNI grup kuralı; tek fark server kümesi (delegate YOK →
  // alt-delegasyon yapılamaz) ve config'in browser-only olması.
  const group = [
    ...subagentBlockArgs(commandKey, argv), // dedupe: lider yolu eklediyse tekrar EKLENMEZ
    ...mcpRegisterArgs(commandKey, {
      servers: commonMcpServers(),
      configPath: () => ensureBrowserMcpConfig(homedir, commandKey),
      strict: true,
      env: codexMcpServerEnv(opts, childEnv, false),
      opts, // AGY-01 — 'workspace-plugin' demetinin PANE anahtarı
      homedir,
      childEnv,
      binFile: trusted && trusted.binFile,
      log: trusted && trusted.log,
      deps: trusted && trusted.mcpProfileDeps,
    }),
  ];
  return applyArgs(argv, group, contributionPosition(commandKey));
}

/**
 * ADP-146 — a browser-capable worker pane carries CREWPANE_AGENT_ID in its env so
 * the browser MCP server (which reads CREWPANE_LEADER_ID || CREWPANE_AGENT_ID) can
 * attribute its actions/approvals to the right agent. Never overwrites a leader id.
 * ADP-227 — codex panes get it too (scripts the agent runs read it; codex's own MCP
 * children get attribution via the -c env map instead, since codex strips the pane
 * env). Mutates + returns `childEnv`; no-op for shell / missing agentId.
 */
function withBrowserEnv(childEnv, commandKey, opts) {
  // ENG-07 — "iki motordan biri mi?" DEĞİL, "KAYITLI bir motor mu?": atıf env'i her
  // kayıtlı motor pane'ine yazılır (kayıtsız motor/`shell` → yazılmaz, bugünkü hâl).
  if (!engineRegistry.isRegisteredEngine(commandKey) || !opts) return childEnv;
  if (crewpaneEnv.readEnv('LEADER_ID', childEnv)) return childEnv; // leader id already attributes (iki ad da sayılır)
  // ADP-200 — every non-leader claude agent now carries the browser tool (via the common
  // additive config), so every such agent gets CREWPANE_AGENT_ID for action/approval
  // attribution — not just the old `browserCapable` delegation worker. Leaders are attributed
  // via CREWPANE_LEADER_ID (guarded above), so this never clobbers a leader id.
  // ADP-244 Faz 3 — dual-write: CREWPANE_AGENT_ID + CREWPANE_AGENT_ID (aynı değer).
  const agentId = typeof opts.agentId === 'string' ? opts.agentId.trim() : '';
  if (agentId) crewpaneEnv.dualWrite(childEnv, 'AGENT_ID', agentId);
  return childEnv;
}

/**
 * ADP-136 (ADR-004) — HARD subagent block for a DELEGATION EXECUTION pane.
 * A worker pane the delegation engine opens to RUN a subtask must never spin up an
 * invisible claude `Task` subagent: its job is to EXECUTE one leaf task; real
 * sub-delegation only ever goes through the `crewpane_delegate` MCP (leaders only).
 * Eren's repro: a single worker (or a pre-existing, Task-unblocked leader) handed a
 * "3 ajan görevlendir" objective used the Task tool → invisible subagents. So every
 * engine spawn passes `disallowSubagent` → `--disallowedTools Task` is added here,
 * department-independent. No MCP/strict (that is the LEADER wiring); just the block.
 * Skipped when the leader path (withLeaderDelegation) already added it (no dup flag)
 * or when the caller didn't ask for it. ADP-227 — codex equivalent: `--disable
 * multi_agent` (codex's stable multi-agent feature would be the same invisible-
 * subagent surface claude's Task tool is).
 */
function withSubagentBlock(argv, commandKey, opts) {
  if (!opts || !opts.disallowSubagent) return argv;
  return applyArgs(argv, subagentBlockArgs(commandKey, argv), subagentBlockPosition(commandKey));
}

/**
 * ENG-07 — ADR-004'ün SERT katmanının argümanları (descriptor `subagentBlock`).
 * `argv` verilirse `dedupeToken` ile TEKRARI önler (lider/browser yolu zaten
 * eklediyse bayrak iki kez basılmaz — bugünkü davranış). Yeteneği olmayan motorda
 * BOŞ döner: blok kaybı `unsupported.subagentBlock`ta GÜVENLİK olarak beyanlıdır
 * (sessizce kaybolması ENG-R3'ün en somut güvenlik bulgusuydu).
 */
function subagentBlockArgs(commandKey, argv) {
  const d = engineCapability(commandKey, 'subagentBlock');
  if (!d || !Array.isArray(d.args) || !d.args.length) return [];
  if (Array.isArray(argv) && d.dedupeToken && argv.includes(d.dedupeToken)) return [];
  return [...d.args];
}

/** Alt-ajan bloğunun argv konumu ('prepend' → pozisyonel kimlik SON kalsın). */
function subagentBlockPosition(commandKey) {
  return (engineCapability(commandKey, 'subagentBlock') || {}).position;
}

/**
 * ADP-064 — a LEADER claude pane MUST carry CREWPANE_LEADER_ID (+ DEPARTMENT) in
 * its env so its delegate MCP server (ADP-051, which inherits this env) knows WHO
 * is delegating — otherwise `crewpane_delegate` returns "leader identity missing".
 * Uses the SAME leader condition as withLeaderDelegation, so the env is present on
 * EVERY path the MCP tool is (sprite click / agent menu / first pane / workspace) —
 * the renderer already passes `agentId`/`department` in the ADP-029 spawn opts.
 * ADP-227 — a codex leader gets it too (pane-level attribution; codex's MCP children
 * additionally receive it via the -c env map, since codex strips the pane env).
 * Mutates + returns `childEnv`; no-op for non-leaders / shell / missing agentId.
 */
function withLeaderEnv(childEnv, commandKey, opts) {
  // ENG-07 — kayıtlı HER motorun lider pane'i kimlik env'ini taşır (bkz. withBrowserEnv).
  if (!engineRegistry.isRegisteredEngine(commandKey) || !isLeaderSpawn(opts)) return childEnv;
  // ADP-244 Faz 3 — dual-write: her kimlik değeri İKİ adla da yazılır (CREWPANE_* ikizi).
  const agentId = opts && typeof opts.agentId === 'string' ? opts.agentId.trim() : '';
  if (agentId) crewpaneEnv.dualWrite(childEnv, 'LEADER_ID', agentId);
  // TEAM-CASE-01 — env'e KANONİK takım yazılır. Bu değer worker'ın KENDİ department'ı
  // olarak geri döner (crewpane-delegate-mcp: `department ?? readEnv('DEPARTMENT')`);
  // ham `.trim()` burada karma harfli bir adı worker'ın SONRAKİ delegasyonuna taşıyordu.
  const department = normalizeDepartment(opts && opts.department);
  if (department) crewpaneEnv.dualWrite(childEnv, 'DEPARTMENT', department);
  return childEnv;
}

// ---------------------------------------------------------------------------
// ADP-087 (ADR-007 Faz 1) — mint a STABLE claude session id at spawn.
// ---------------------------------------------------------------------------
// claude (>=2.1.183, POC-verified) accepts `--session-id <uuid>`: it uses that
// uuid as the session id instead of auto-generating one. Minting it OURSELVES at
// spawn means the id is known up front (no output-scraping race) so the session
// can later be resumed by id (`claude --resume <uuid>`, ADP-088) and captured in
// the resume queue. Purely ADDITIVE: the session is functionally identical to
// today's — it just has a known id. ONLY claude (codex has no verified equivalent
// flag — ADR R4, ADP-088 verifies). Kill-switch: CREWPANE_DISABLE_SESSION_ID=1
// (ADR §10 "salt-ekleme; flag ile kapanır"). A caller-supplied valid uuid
// (opts.sessionId) is honored verbatim (resume path); otherwise a fresh uuid.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DISABLE_SESSION_ID_ENV = 'CREWPANE_DISABLE_SESSION_ID';

/** True for a canonical v4-shaped UUID string. */
function isUuid(value) {
  return typeof value === 'string' && UUID_RE.test(value);
}

/**
 * Append `--session-id <uuid>` to a claude agent's argv and return the id used.
 * No-op (sessionId=null) for codex/shell or when the kill-switch env is set.
 * @returns {{ argv: string[], sessionId: string|null }}
 */
function withSessionId(argv, commandKey, opts, env) {
  // ENG-07 — oturum kimliğini BİZ basabiliyor muyuz? Descriptor söyler
  // (`session: {mint:'uuid', flag, killSwitchEnv}`); codex'te `mint:null` →
  // basılmaz (kayıp `partial.session`de beyanlı: resume + jeton eşlemesi best-effort).
  const d = engineCapability(commandKey, 'session');
  if (!d || d.mint !== 'uuid' || !d.flag) return { argv, sessionId: null };
  const e = env || process.env;
  const killSwitch = d.killSwitchEnv || DISABLE_SESSION_ID_ENV;
  if (e && e[killSwitch]) return { argv, sessionId: null };
  const provided = opts && isUuid(opts.sessionId) ? opts.sessionId : null;
  const sessionId = provided || crypto.randomUUID();
  return { argv: [...argv, d.flag, sessionId], sessionId };
}

// ---------------------------------------------------------------------------
// ADP-192 (SPRINT-AD-23) — RESTART-resume: re-launch a pane on its prior session.
// ---------------------------------------------------------------------------
// After an app restart the old pane is gone, so (unlike the LIMIT-resume nudge in
// resumeTmux, which types into a still-live TUI) we re-LAUNCH the engine on its
// previous conversation: `claude --resume <uuid>` (ADP-088 reuse) restores the
// FULL context instead of starting fresh. Gated by a valid, resumable session id:
//   • claude → a v4 uuid (minted at the original spawn, ADP-087).
//   • codex  → any non-empty id (codex `resume <id>`; best-effort — codex sessions
//     aren't minted by withSessionId so this rarely fires, ADR R4 graceful).
// When the id is missing/invalid we DON'T take the resume path — buildSpawn falls
// back to a normal fresh spawn (new minted session + full identity), which is the
// graceful "broken session → clean pane" fallback the ADP-192 DoD requires.

/** True when this spawn should RESUME a prior session rather than start fresh. */
function isResumeSpawn(opts, commandKey) {
  if (!opts || opts.resume !== true) return false;
  // ENG-07 — kabul edilen id ŞEKLİ descriptor'da (`session.resume.idShape`):
  // 'uuid' (claude — biz bastık, biçim doğrulanır) · 'sanitized-token' (codex —
  // herhangi bir dolu id, temizlenerek kullanılır). Resume yeteneği beyan etmeyen
  // motorda resume yolu HİÇ açılmaz → taze spawn (bugünkü nazik düşüş).
  const r = (engineCapability(commandKey, 'session') || {}).resume;
  if (!r) return false;
  if (r.idShape === 'uuid') return isUuid(opts.sessionId);
  return typeof opts.sessionId === 'string' && opts.sessionId.length > 0;
}

// RESTORE-DEADSESSION-FALLBACK — "resume ettim ama konuşma diskte yok" imzası.
// M1 mekanizması (E2E-TRIAGE-PTY-jazz §M1): geçerli-FORMATLI ama hiç diske
// yazılmamış sessionId ile `claude --resume` → "No conversation found with
// session ID: <uuid>" basıp exit 1 → pane ölü kalıyordu (buildSpawn'ın ADP-192
// broken-session fallback'i tetiklenmez çünkü uuid biçimi geçerli). Gerçek
// kullanıcıda da olur: ~/.claude/projects dosyası silinmiş/taşınmış olabilir.
const DEAD_SESSION_SIGNATURE = /no conversation found/i;
// Genç-ölüm penceresi: gerçek bir resume oturumu dakikalarca yaşar; ölü-session
// hatası boot'un ilk saniyelerinde basılır. Pencere dışı non-zero exit'ler
// (uzun yaşamış oturumun çökmesi) fallback SAYILMAZ — sonsuz respawn frenlenir.
const DEAD_SESSION_WINDOW_MS = 60_000;

/**
 * Bu pty exit'i "ölü session resume'u" mu? SAF — main'in onExit'i çağırır:
 * non-zero exit + genç ölüm + buffer'da imza ÜÇÜ birden şart.
 */
function isDeadSessionExit({ buffer, exitCode, uptimeMs }) {
  if (!exitCode) return false; // temiz çıkış ölü-session değildir
  if (!Number.isFinite(uptimeMs) || uptimeMs > DEAD_SESSION_WINDOW_MS) return false;
  return DEAD_SESSION_SIGNATURE.test(typeof buffer === 'string' ? buffer : '');
}

/**
 * Turn a validated agent argv into its RESUME form (ADP-192). Caller has already
 * gated with isResumeSpawn, so the id is known-good for the engine:
 *   claude → `<argv…> --resume <uuid>`  (uuid is regex-validated → no injection)
 *   codex  → `resume <id> <argv…>`      (id alnum-sanitized; `resume` is a subcmd)
 * The id is NEVER shell-interpolated (execvp argv element), but we still sanitize.
 */
function appendResume(argv, commandKey, sessionId) {
  // ENG-07 — resume'un ŞEKLİ descriptor'da (`session.resume`):
  //   • form 'subcommand' → `<subcommand> <id> <argv…>` (id temizlenir; id yoksa
  //     `lastFallback` — codex `resume --last`)
  //   • form 'append'     → `<argv…> <flag> <id>` (claude `--resume <uuid>`)
  // Resume beyan etmeyen motora bu fonksiyon HİÇ ulaşmaz (isResumeSpawn eler);
  // yine de savunmacı: beyan yoksa argv DEĞİŞMEZ (uydurma bayrak basmaktan iyidir).
  const r = (engineCapability(commandKey, 'session') || {}).resume;
  if (!r) return argv;
  if (r.form === 'subcommand') {
    const id = typeof sessionId === 'string' ? sessionId.replace(/[^A-Za-z0-9_-]/g, '') : '';
    if (id) return [r.subcommand, id, ...argv];
    return [...(r.lastFallback || [r.subcommand]), ...argv];
  }
  // ENG-13 — bazı motorlarda id İKİNCİ bir bayrakla verilir (goose:
  // `--resume --name <ad>`); tek bayrak yazmak SESSİZCE 'son oturumu' resume ederdi.
  return applyArgs(argv, r.idFlag ? [r.flag, r.idFlag, sessionId] : [r.flag, sessionId], 'append');
}

/** Accept only a bounded array of plain strings; otherwise null (→ defaults). */
function sanitizeArgs(args) {
  if (!Array.isArray(args)) return null;
  if (args.length > MAX_ARGS) return null;
  for (const a of args) {
    if (typeof a !== 'string' || a.length > MAX_ARG_LEN) return null;
  }
  return args.slice();
}

/** Validate a requested cwd; fall back to home if missing/not a directory. */
function sanitizeCwd(cwd) {
  if (typeof cwd !== 'string' || cwd.length === 0) return os.homedir();
  try {
    if (fs.statSync(cwd).isDirectory()) return cwd;
  } catch {
    /* not a usable dir */
  }
  return os.homedir();
}

/**
 * ADP-154 — resolve the spawn cwd so a delegated/office WORKER (an agent CLI) lands
 * in a real PROJECT tree, not HOME. The wrong-cwd bug: delegation + office spawns
 * passed no cwd → sanitizeCwd(undefined) → os.homedir() → the worker's relative
 * paths (git, docs/agent-results/, supabase/migrations/) fell on the floor (status
 * said "done", 0 files written). Resolution order:
 *   1. an explicit, existing cwd — the caller knows best (preserved verbatim),
 *   2. for an AGENT pane (claude/codex — every delegation/office worker) → the
 *      department's project dir (dirForDepartment: crewpane→repoRoot, chatflow/
 *      education→sibling repo; unknown/empty→repoRoot). HOME is NEVER chosen here.
 *   3. otherwise (a bare login-shell pane, or no repoRoot) → the legacy
 *      sanitizeCwd/HOME default.
 * Gating on `isAgent` (not department) is deliberate: ONLY agent CLIs are delegation
 * /office workers, so a plain `shell` terminal keeps its established HOME default
 * (ADP-003 generic terminal; ADP-108 live-watch cwd repro both spawn a department-
 * tagged SHELL and rely on HOME) — this fix is surgical to the actual bug surface.
 * `repoRoot` is main.js's authoritative REPO_ROOT (the crewpane repo); when absent
 * (e.g. a unit test calling buildSpawn without it) we degrade to the legacy HOME
 * fallback, so existing behavior is unchanged unless a root is supplied. Pure.
 *
 * ADP-234 — `deptMapping` (settings.departmentDirs) customizes the department →
 * project-dir layout. It is MAIN-SOURCED ONLY (threaded via buildSpawn's `trusted`,
 * same rule as the bridge token): opts arrives over IPC, and a renderer must not be
 * able to steer a pane into an arbitrary directory. Absent/invalid mapping → the
 * built-in CrewPane sibling layout, i.e. exactly the pre-ADP-234 behavior.
 *
 * B-01 (GIT-BACKBONE-SPEC §2.5) — KADEME-0: `taskWorktree`. Bir görev kendi git
 * worktree'sinde izole koşuyorsa pane O AĞAÇTA açılır ve bu karar HER ŞEYİ EZER.
 * İki kural, ikisi de güvenlik gerekçeli:
 *   • Değer YALNIZ `trusted` üzerinden gelir (`departmentDirs`/`providerKeys`/bridge
 *     jetonuyla AYNI sözleşme). `opts.taskWorktree` diye bir şey OKUNMAZ — renderer
 *     bir dizin adı söyleyebilseydi, git omurgasının bütün kum havuzu (G-1/G-3)
 *     tek satırda delinirdi. Yolu main türetir: görev kaydı → proje → worktree defteri.
 *   • Kademe-0 `opts.cwd`'yi de ezer: izole bir görevde renderer'ın taşıdığı cwd
 *     (eski pane'in kaydı, bayat bir yol) worktree'yi geçersiz kılamaz. Aksi hâlde
 *     "izole başlattım ama ortak ağaçta koştu" sessiz yarım-izolasyonu doğardı.
 * Yol yoksa/dizin değilse kademe-0 hiç uygulanmaz → BUGÜNKÜ sıra bit-bit korunur
 * (izolasyon kapalı kurulumda bu fonksiyon davranış olarak değişmemiştir).
 */
function resolveCwd(opts, repoRoot, isAgent, deptMapping, log, taskWorktree) {
  // ── Kademe 0 (B-01) ──────────────────────────────────────────────────────
  if (typeof taskWorktree === 'string' && taskWorktree.length > 0) {
    try {
      if (fs.statSync(taskWorktree).isDirectory()) {
        if (typeof log === 'function') log(`resolveCwd: görev worktree'si kullanıldı → ${taskWorktree}`);
        return taskWorktree;
      }
      if (typeof log === 'function') log(`resolveCwd: taskWorktree DİZİN DEĞİL, yok sayıldı → ${taskWorktree}`);
    } catch {
      // Yol kaybolmuş (H-7). Sessizce ortak ağaca düşmek yerine LOGLA — çağıran
      // (main) izolasyon zorunluysa spawn'ı zaten hiç başlatmaz.
      if (typeof log === 'function') log(`resolveCwd: taskWorktree YOK, yok sayıldı → ${taskWorktree}`);
    }
  }
  const cwd = opts && opts.cwd;
  if (typeof cwd === 'string' && cwd.length > 0) {
    try {
      if (fs.statSync(cwd).isDirectory()) return cwd;
    } catch {
      /* explicit cwd is gone — fall through to the department/root resolution */
    }
  }
  const root = typeof repoRoot === 'string' && repoRoot.length > 0 ? repoRoot : '';
  if (root && isAgent) {
    const dept = normalizeDepartment(opts && opts.department); // TEAM-CASE-01 (dirForDepartment zaten katlıyordu — sapma kapandı)
    // ADP-502 — `log` (trusted.log, main's logLine) surfaces the silent root
    // fallback inside dirForDepartment (a department whose project dir is missing).
    return dirForDepartment(dept, root, deptMapping, log) || sanitizeCwd(cwd);
  }
  return sanitizeCwd(cwd);
}

// ADP-310 — UTF-8 LOCALE GARANTİSİ (Eren'in canlı vakası: yapıştırılan "→" ",Üí",
// "bağlandın" "bafülandf±n" oluyordu).
//
// PATH ile AYNI KÖK: Finder/Dock'tan açılan bir GUI app launchd'den env alır ve
// launchd'de LANG/LC_* YOKTUR (terminalden açınca vardır — bu yüzden "bende çalışıyor,
// Eren'de bozuluyor"). Baytlar pty'ye DOĞRU gidiyor (ölçüldü: yazma da yapıştırma da
// byte-eşit); bozan taraf TÜKETİCİ: locale UTF-8 değilse satır düzenleyiciler
// çok-baytlı karakteri işleyemez. Gerçek pty ölçümü (2026-07-12):
//   zsh  LANG yok → "ba\x9flandın" (bozuk bayt basımı)
//   bash LANG yok → "balandn"      (Türkçe harfleri TAMAMEN atıyor)
//   tmux LANG yok → her çok-baytlı karakter "_"
//   tmux LANG=…UTF-8 → TEMİZ
// Bu yüzden çocuk env'ine UTF-8 locale'i, PATH gibi, ZORUNLU olarak enjekte ediyoruz.
const DEFAULT_LANG = 'en_US.UTF-8';

/** Bir locale değeri UTF-8 mi (büyük/küçük harf ve "UTF8" yazımı dahil)? */
function isUtf8Locale(v) {
  return typeof v === 'string' && /utf-?8/i.test(v);
}

/**
 * Çocuk env'inde UTF-8 locale garanti et (saf; env nesnesini KOPYALAMAZ, günceller).
 * • LC_ALL varsa ve UTF-8 ise: dokunma (kullanıcı bilinçli seçmiş).
 * • LC_ALL/LANG var ama UTF-8 DEĞİLSE (ör. "C", "POSIX"): UTF-8'e çek — aksi hâlde
 *   Türkçe/emoji/sembol bozulur (yukarıdaki ölçüm).
 * • Hiçbiri yoksa (launchd hâli): LANG=en_US.UTF-8 + LC_CTYPE=UTF-8.
 * Idempotent: ikinci çağrı hiçbir şeyi değiştirmez.
 */
function ensureUtf8Locale(env) {
  const e = env && typeof env === 'object' ? env : {};
  if (e.LC_ALL !== undefined && !isUtf8Locale(e.LC_ALL)) e.LC_ALL = DEFAULT_LANG;
  if (!isUtf8Locale(e.LANG)) e.LANG = DEFAULT_LANG;
  if (!isUtf8Locale(e.LC_CTYPE)) e.LC_CTYPE = DEFAULT_LANG;
  return e;
}

/**
 * GUI apps on macOS inherit a truncated PATH (launchd, not a login shell), so a
 * direct `pty.spawn('claude', …)` can fail to find a Homebrew/npm-global binary.
 * Augment PATH with the common install locations WITHOUT going through a shell
 * (which would reintroduce an injection surface). Idempotent — never duplicates.
 */
function augmentedPath(basePath, opts = {}) {
  // ADP-833 (790 M5 · ADR-W10 Kural 2) — LİSTE platform/envPath.cjs'e taşındı.
  // macOS listesi ve sırası BİT-BİT aynı (nöbetçi testi: agentRunner.test.cjs);
  // Windows'ta yerine motorların GERÇEK kurulum yerleri gelir (792 §3.2) — eskiden
  // eklenen `/opt/homebrew/bin` gibi dizinler orada anlamsızdı ve PATH'i kirletiyordu.
  // Registry OKUNMAZ: burası her pane spawn'ında koşan sıcak yol (senkron); taze
  // registry okuması yalnız "Tekrar dene" hattında (engineCheck) yapılır.
  return envPath.augment(basePath, { home: os.homedir(), ...opts, readRegistry: false });
}

/**
 * ADP-272 — env vars a Claude Code process exports to EVERYTHING it spawns. If the
 * CrewPane app itself was launched from inside a claude session (an installer or
 * `open` run from a Bash tool call), the whole Electron process carries them, and every
 * pane engine we spawn inherits them.
 *
 * `CLAUDE_CODE_CHILD_SESSION=1` is the poison: a claude that sees it treats itself as a
 * NESTED child session — it answers normally but NEVER writes its transcript to
 * ~/.claude/projects/<slug>/<session-id>.jsonl. Proven with a 3-arm node-pty probe
 * (2026-07-09): clean env → transcript written; CHILD_SESSION=1 → answered, zero bytes.
 *
 * Consequence before this fix: no pane conversation survived an app restart. On resume,
 * `--resume <id>` replayed a file frozen at the moment the app was launched, so the agent
 * came back missing every message since — Eren saw "10 mesaj geriden başlamış".
 *
 * `CLAUDE_CODE_SESSION_ID` additionally leaked the LAUNCHING session's id into every pane
 * (all agents claimed to be session 706f2fd4…). EXECPATH would pin workers to the
 * launcher's claude version; EFFORT/ENTRYPOINT leak the launcher's settings.
 *
 * Stripped from the BASE env only — an explicit `extra` may still set them deliberately.
 */
const INHERITED_ENGINE_ENV = Object.freeze([
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_EFFORT',
  'CLAUDECODE',
]);

// ADP-251 — pane-IDENTITY and bridge-TRANSPORT keys are assigned FRESH per pane by
// withLeaderEnv/withBrowserEnv and buildSpawn's trusted-bridge binding. When the app
// itself is launched from inside an agent pane (GATE e2e, electron:dev, packaged app
// opened in a pane), that pane's values leak into process.env and every inner pane
// would inherit them: workers carry the OUTER leader's CREWPANE_LEADER_ID (so
// withBrowserEnv's leader guard skips CREWPANE_AGENT_ID → attribution goes to the
// wrong agent), and codex MCP argv freezes a STALE bridge port/token. Always scrubbed
// from the BASE env; CREWPANE_INSTANCE / CREWPANE_HOME / CREWPANE_TMUX_SESSION are
// DELIBERATELY not listed (instance routing must inherit — instancePaths.cjs).
// E2E-HARDEN-F1 — one exception: a *prod*-valued CREWPANE_INSTANCE is dropped by
// sanitizeEnv itself (see there); dev/test pins keep inheriting unchanged.
// ADP-244 Faz 3 — KRİTİK: bu liste ikiz adlardan TÜRETİLİR (bothNamesAll). Yalnız legacy adı
// scrub etmek, ikiz-yazılan CREWPANE_LEADER_ID'nin iç pane'lere sızmasına ve yeni-ad-öncelikli
// okuyucunun DIŞ liderin kimliğini seçmesine yol açardı — ADP-251'in hatası ikiz üzerinden geri
// gelirdi. Yeni bir env ikizlenirse base adı BURAYA da eklenir.
const PANE_SCOPED_ENV_BASES = Object.freeze([
  'LEADER_ID',
  'AGENT_ID',
  'DEPARTMENT',
  'BRIDGE_PORT',
  'BRIDGE_TOKEN',
  'BRIDGE_HOST',
  // KILL-GUARD-01 — ev sahibi pid'i de PANE BAŞINA tazedir. Uygulama bir ajan
  // pane'inden başlatılırsa (GATE e2e, electron:dev) DIŞ uygulamanın pid'i sızar ve
  // iç pane'lerin kapısı YANLIŞ süreci korurdu: gerçek ev sahibi serbest kalır,
  // masum bir pid ise gereksiz yere kilitlenirdi. Her spawn'da yeniden yazılır.
  'HOST_PID',
  'PANE_PIDS',
]);
const PANE_SCOPED_ENV_KEYS = Object.freeze(crewpaneEnv.bothNamesAll(PANE_SCOPED_ENV_BASES));

// ADP-585 — çözümlenen entegrasyon anahtarlarının env ön-eki. credentialVault.ENV_PREFIX
// ile AYNI olmak ZORUNDA (integrationSpawn.test.cjs iki sabiti karşılaştırır — drift
// guard). Burada require yerine sabit tutuluyor: agentRunner düz `node --test` altında da
// koşuyor ve vault zinciri (packages/crewpane-auth) yalnız bu ön-ek için çekilmemeli.
const INTEGRATION_SECRET_ENV_PREFIX = 'CREWPANE_SECRET_';

/**
 * Merge caller-supplied extra env (plain string→string only, bounded) onto a
 * base env, then ensure PATH is augmented. Non-string values are dropped.
 * ADP-272 — inherited engine-session vars are dropped from the base first.
 * ADP-251 — pane-scoped identity/bridge vars too; scrub runs BEFORE the extra
 * merge, so a caller's explicit `extra` value still wins (contract unchanged).
 */
// WIN-PARITY-01 — PATH'i ortamın KENDİ harfiyle yaz/oku (gerekçe: platform/envPath.cjs).
// Windows `Path` der; `env.PATH=` yazmak node-pty'de OKUNMAYAN ikinci bir anahtar doğurur.
const { setPathVar, getPathVar } = envPath;

function sanitizeEnv(extra, baseEnv) {
  const base = { ...(baseEnv || process.env) };
  for (const k of INHERITED_ENGINE_ENV) delete base[k];
  for (const k of PANE_SCOPED_ENV_KEYS) delete base[k];
  // ADP-585 — MİRAS ALINAN entegrasyon anahtarlarını düşür. ADP-584 spike'ı ÖLÇTÜ:
  // childEnv hem pane'e hem TORUN süreçlere miras geçiyor. Uygulama bir pane'den
  // başlatılırsa (GATE e2e, electron:dev, pane'de açılan paketli app) o pane'in
  // secret'ları process.env'e sızar ve İÇERİDEKİ her pane onları — kapsamı tutmasa
  // bile — miras alırdı. Ön-ek taban env'den her zaman silinir; bu spawn için
  // ÇÖZÜMLENENLER sonra withIntegrations tarafından yeniden yazılır. Yan fayda:
  // revoke sonrası yeni spawn'ın env'i, miras yoluyla bile, TEMİZ olur (Kural 4).
  for (const k of Object.keys(base)) {
    if (k.startsWith(INTEGRATION_SECRET_ENV_PREFIX)) delete base[k];
  }
  // BR-04 (ADR-INT-BRIDGE §6) — VENDOR TELEMETRİ ANAHTARLARI DA DÜŞER.
  // Yukarıdaki satır MÜŞTERİNİN sırlarını miras yoluyla sızmaktan korur; bu satır
  // TERS yönü kapatır: BİZİM (CrewPane'ın) telemetri anahtarlarımız müşterinin
  // ajan pane'ine girmez. Ölçüm (2026-08-12, canlı müşteri build'i):
  // `CREWPANE_POSTHOG_KEY_PROD` pane env'inde `CREWPANE_SECRET_*`in TAM YANINDA
  // duruyordu — `env` yazan herhangi bir ajan ikisini birden görüyordu. Kök neden
  // (telemetry.loadDsnEnvFromCrewPane'ın process.env'i kirletmesi) ayrıca
  // düzeltildi; bu süpürge o düzeltmeden BAĞIMSIZ ikinci savunmadır (değer
  // kabuktan miras da gelebilir). Ad listesi TEK kaynak: telemetry/channel.cjs.
  for (const k of VENDOR_TELEMETRY_ENV_KEYS) delete base[k];
  // E2E-HARDEN-F1 — drop an inherited *prod* instance pin. 'prod' is ALSO the
  // unset-default (instancePaths.instanceId), so a pane engine and its MCP children
  // resolve the exact same ~/.crewpane without it — the pin carries zero information
  // and only arms the bypass: every e2e the pane's agent runs spreads process.env,
  // sees CREWPANE_INSTANCE=prod already set, and impersonates the production app
  // (2026-07-10 incident: prod live-panes.json wiped + dead QA panes resurrected).
  // dev/test pins are LOAD-BEARING (a dev app's pane MCP servers must resolve
  // ~/.crewpane-dev; unset would wrongly resolve prod) and keep inheriting.
  // ADP-244 Faz 3 — pin ikiz YAZILDIĞI için (main.js) prod-drop İKİ adı birden düşürür:
  // yalnız legacy'yi silmek CREWPANE_INSTANCE=prod'u ayakta bırakır → Faz 4'te okuyucu yeni
  // ada döndüğü an bypass sessizce geri açılır. Düşürme koşulu KESİN: env'de mevcut olan TÜM
  // yazılışlar prod olmalı — dev/test pini taşıyan bir yazılış varsa hiçbiri düşmez (dev/test
  // pinleri LOAD-BEARING; yanlışlıkla düşürmek dev pane'ini prod'a çözerdi).
  const instancePins = crewpaneEnv.pinnedValuesPresent('INSTANCE', base);
  if (instancePins.length && instancePins.every((v) => instancePaths.normalize(v) === instancePaths.PROD)) {
    crewpaneEnv.dualDelete(base, 'INSTANCE');
  }
  if (extra && typeof extra === 'object' && !Array.isArray(extra)) {
    let n = 0;
    for (const [k, v] of Object.entries(extra)) {
      if (n >= MAX_ENV_KEYS) break;
      if (typeof k === 'string' && typeof v === 'string' && k.length <= 256) {
        base[k] = v;
        n++;
      }
    }
  }
  // WIN-PARITY-01 — okuma da yazma da anahtarın HARFİNDEN bağımsız (bkz. setPathVar).
  setPathVar(base, augmentedPath(getPathVar(base)));
  // ADP-310 — PATH ile aynı huni: UTF-8 locale garantisi (yoksa Türkçe/emoji bozulur).
  ensureUtf8Locale(base);
  return base;
}

/**
 * Turn a validated spawn request into the concrete node-pty arguments.
 * Throws (via resolveCommand) on a disallowed command — callers must let that
 * reject the IPC, never swallow it.
 *
 * `trusted` comes from MAIN ONLY (never from `opts` — opts arrives over IPC, and a
 * renderer must not be able to forge the bridge token). ADP-251 — `trusted.bridge`
 * ({ port, token, host? }) is bound onto childEnv BEFORE the argv builders run, so
 * codex's `-c mcp_servers.*.env` map (built from childEnv) embeds the FRESH bridge
 * port/token — previously main.js bound these AFTER buildSpawn, so the codex MCP
 * env fast path never saw them (and a polluted base env froze STALE values in).
 *
 * @returns {{ key:string, isAgent:boolean, file:string, argv:string[], cwd:string, env:object }}
 */
function buildSpawn(opts = {}, baseEnv, repoRoot, trusted = {}) {
  const { command, args, env, systemPrompt } = opts;
  const resolved = resolveCommand(command); // may throw — RCE guard
  // ADP-565 — the EFFECTIVE launch model (sanitized; null when none/unusable). Computed
  // once so buildSpawn can BOTH inject `--model` (withModel below) AND return it so main
  // records the AUTHORITATIVE model on the pane (badge reads it, not a config guess).
  const effectiveModel = sanitizeModel(opts.model, resolved.key);
  // CDX-F1 — bu spawn'ın GERÇEK efor değeri (descriptor beyaz listesinden geçmiş; yoksa
  // null). `effectiveModel` emsali: tek yerde çözülür, hem argv'ye basılır hem dönüşte
  // rapor edilir → rozet iddia değil ÖLÇÜM gösterir.
  // AGY-05 — efor artık MODELE de bağlı olabilir (antigravity motorun kendisi doğruluyor),
  // bu yüzden efektif model efektif efordan ÖNCE çözülür ve buraya girdi olur.
  const effectiveEffort = resolveEffort(resolved.key, opts.effort, effectiveModel);
  // TOKEN-BUDGET-01 — bu spawn'ın SABİT YÜK künyesi (kimlik uzunluğu + kapsam
  // kararı + MCP sayısı). main bunu pane kaydına yazar, `pty:tokenUsage` yanıtına
  // koyar ve kart "bu pane'in sabit yükü ~N jeton" satırını çizer. İDDİA DEĞİL
  // KÜNYE: rakamı kart kalibrasyondan üretir, burada yalnız girdiler taşınır.
  let fixedLoadFact = null;
  // LEAD-BEHAV-01 — bu spawn LİDER kablosunu GERÇEKTEN aldı mı (aşağıda ölçülür).
  let leaderDelegationFact = null;
  // ADP-580 — the EFFECTIVE codex provider (Groq/DeepSeek/Kimi), or null. Only a known
  // provider id from `opts` is honored; the API key is bound separately from `trusted`
  // (main-only secret) below. Non-codex / unknown → null → today's behavior.
  // ENG-07 — "codex mü?" DEĞİL "bu motor sağlayıcı seçimini destekliyor mu?" (descriptor).
  // ENG-OPENAI-COMPAT-01 — kullanıcının kendi ucu `trusted`ten okunur (ADRES bir
  // güven kararıdır; renderer `opts` ile dayatamaz — providerKeys emsali).
  const customProviderRow = (trusted && trusted.customProvider) || null;
  const effectiveProvider =
    engineCapability(resolved.key, 'provider') && providers.isProvider(opts.provider, customProviderRow)
      ? opts.provider
      : null;
  // ADP-154 — resolve cwd from the department's project dir (not HOME) for agent /
  // department-tagged spawns; `repoRoot` is main.js's REPO_ROOT (the crewpane repo).
  // ADP-234 — `trusted.departmentDirs` (settings mapping, main-only) may override the
  // built-in sibling layout; it rides in `trusted` for the same reason the bridge
  // token does — a renderer-controlled `opts` must not steer the cwd.
  // B-01 — `trusted.taskWorktree`: main'in görev kaydından ÇÖZDÜĞÜ izole ağaç yolu
  // (kademe-0). `opts`'tan ASLA okunmaz; renderer yol dayatamaz (G-1).
  const cwdResolved = resolveCwd(
    opts,
    repoRoot,
    resolved.isAgent,
    trusted && trusted.departmentDirs,
    trusted && trusted.log, // ADP-502 — main's logLine; department-dir fallback görünür olsun
    resolved.isAgent ? (trusted && trusted.taskWorktree) : undefined,
  );
  const childEnv = sanitizeEnv(env, baseEnv);

  // ADP-936 (ADR-MULTI-ACCOUNT-SWITCH Faz 1) — AI motoru HESAP PROFİLİ. Kullanıcının
  // birden çok kendi aboneliği olabilir; hangisiyle koşacağımız TEK BİR env katkısıyla
  // belirlenir (claude: CLAUDE_SECURESTORAGE_CONFIG_DIR — yalnız KİMLİK ayrışır,
  // `~/.claude/projects` transkripti paylaşımlı kalır ⇒ hesaplar arası `--resume`
  // çalışır; codex: CODEX_HOME).
  //
  // `trusted.engineProfiles` main-only (providerKeys/integrations emsali): renderer
  // en fazla bir `profileId` İSTEYEBİLİR, dizini ASLA veremez — çözüm + containment
  // kapısı electron/engineProfiles.cjs'te. VARSAYILAN profilde katkı BOŞTUR, yani
  // bu blok bugünkü tek-hesap kullanıcı için tam anlamıyla no-op'tur (env bit-bit
  // aynı) ve codex'in test/izole CODEX_HOME dikişini de bozmaz.
  // Uygulama noktası ensureCodexTrusted'dan ÖNCE: codex'in güven dosyası PROFİLİN
  // kendi CODEX_HOME'una yazılmalı, kanonik ~/.codex'e değil.
  // ACCT-FIX-01 — bu spawn'ın ÇÖZÜLEN profili (pane kaydına yazılır; null = çözücü yok
  // / motor değil / defter hatası → "bilinmiyor", uydurulmaz). env ile AYNI çağrı
  // zincirinden geçer: kayıt ile env'in ayrışması yapısal olarak imkânsız.
  let engineProfileId = null;
  if (resolved.isAgent && trusted && trusted.engineProfiles
      && typeof trusted.engineProfiles.envFor === 'function') {
    try {
      const profileEnv = trusted.engineProfiles.envFor(resolved.key, opts.engineProfileId);
      if (profileEnv && typeof profileEnv === 'object') Object.assign(childEnv, profileEnv);
      if (typeof trusted.engineProfiles.resolveId === 'function') {
        const id = trusted.engineProfiles.resolveId(resolved.key, opts.engineProfileId);
        engineProfileId = typeof id === 'string' && id ? id : null;
      }
    } catch {
      /* defter hatası spawn'ı ASLA engellemez → varsayılan hesapla koşar */
    }
  }

  // ADP-283 — pre-accept the engine's directory-trust dialog for THIS cwd (kaçırılırsa
  // TUI diyaloğu ilk prompt'u YUTAR). ENG-07 L2 — tetikleyici motor ADI değil DESCRIPTOR:
  // güven defteri MOTORUN ev dizinindeyse ($CODEX_HOME — hesap profilinin ezdiği değişken)
  // yazım BURADA yapılmak zorunda, çünkü o dizin ancak childEnv çözüldükten sonra bilinir.
  // Kullanıcı ev dizinindeki defterler (claude ~/.claude.json) `pending` döner ve çağıran
  // (main.js) pty'yi doğurmadan hemen önce yazar — davranış iki motorda da bugünküyle aynı.
  const trustPlan = resolved.isAgent ? planEngineTrust(resolved.key, cwdResolved, childEnv) : null;

  // ADP-580 — BYOK: bind the selected provider's API key into the codex pane env
  // (the env var codex reads per `env_key`). The key is a SECRET → it rides in
  // `trusted.providerKeys` (main-only, read from settings.apiKeys), NEVER via `opts`
  // (renderer-controlled). Only when a provider is actually selected; a missing key
  // leaves the env unset so codex surfaces a clear auth error (see withProvider).
  if (effectiveProvider && trusted && trusted.providerKeys) {
    const p = providers.getProvider(effectiveProvider, customProviderRow);
    const keyEnv = providers.providerKeyEnv(
      effectiveProvider,
      trusted.providerKeys[p.settingsKey],
      customProviderRow,
    );
    if (keyEnv) Object.assign(childEnv, keyEnv);
  }

  // ADP-050 / ADP-251 — hand the delegation bridge port+token to AGENT panes via env
  // so a leader's MCP server (ADP-052, inherits this env) can reach the bridge. Only
  // agent CLIs; never the plain login shell. Single binding point (main.js used to
  // re-bind after buildSpawn — removed).
  // ADP-244 Faz 3 — dual-write: bridge transport'u da iki adla (MCP child'ları yeni adı okuyabilsin).
  if (resolved.isAgent && trusted && trusted.bridge && trusted.bridge.port && trusted.bridge.token) {
    crewpaneEnv.dualWrite(childEnv, 'BRIDGE_PORT', String(trusted.bridge.port));
    crewpaneEnv.dualWrite(childEnv, 'BRIDGE_TOKEN', trusted.bridge.token);
    crewpaneEnv.dualWrite(childEnv, 'BRIDGE_HOST', trusted.bridge.host || '127.0.0.1');
  }

  // KILL-GUARD-01 — İKİNCİ HAT: pane KENDİ EV SAHİBİNİN pid'ini bilir.
  // Ad-tabanlı desenler (`killall CrewPane`) bir gün ürün adı değişince kör kalır;
  // ayrıca ajan uygulamayı `ps` ile bulup `kill <pid>` diyerek deseni tümüyle
  // atlayabilir. `CREWPANE_HOST_PID` bu iki kaçışı da kapatır: karar çekirdeği
  // (killGuard R4) bu pid'i hedefleyen her `kill`i reddeder. Değer TAHMİN edilmez,
  // ana süreç kendi pid'ini SÖYLER.
  if (resolved.isAgent) {
    crewpaneEnv.dualWrite(childEnv, 'HOST_PID', String((trusted && trusted.hostPid) || process.pid));
    // Kardeş pane pid'leri VARSA (main verir) ikinci hat onları da kapsar; yoksa
    // alan hiç yazılmaz — boş bir liste "kardeş yok" demek olurdu, o da yalan olurdu.
    const sib = trusted && Array.isArray(trusted.panePids)
      ? trusted.panePids.map((p) => Number(p)).filter((p) => Number.isInteger(p) && p > 0)
      : [];
    if (sib.length) crewpaneEnv.dualWrite(childEnv, 'PANE_PIDS', sib.join(','));
    // KAPI 2 — sarmalayıcılar PATH'in BAŞINA. `augmentedPath` zaten çalıştı; bu dizin
    // onun da ÖNÜNE geçmeli ki `/usr/bin/killall` gölgelensin. Yazılamazsa (`null`)
    // PATH bit-bit bugünküdür.
    const guardBin = crewpaneEnv.readEnv('KILL_GUARD', childEnv) === '0'
      ? null
      : ensureKillGuardShims(instancePaths.crewpaneHome(undefined));
    // WIN-PARITY-01 — `childEnv.PATH = …` YAZMAK WINDOWS'TA YETMEZ: orada anahtar
    // `Path`tir ve node-pty yinelenenleri elemediği için blokta İLK gelen (orijinal
    // `Path`) kazanır ⇒ sarmalayıcı dizini PATH'e konmuş SAYILIR ama hiç okunmaz.
    if (guardBin) setPathVar(childEnv, `${guardBin}${path.delimiter}${getPathVar(childEnv) || ''}`);
  }

  // CDX-F1 (CDX-R1 H4) — YENİ PANE'LER KANONİK-ONLY. ÖLÇÜLDÜ: lider pane'inin araç
  // şemasının %36'sı (7 araç / 9.174 bayt ≈ 2.294 jeton) ADP-244 legacy `crewpane_*`
  // İKİZİYDİ — aynı handler'a bağlı kopyalar. CrewPane'in kendi doğurduğu pane'lerde
  // ikizi kapatıyoruz; kimlik metinleri zaten KANONİK adı yazıyor.
  // 🔑 KILL-SWITCH KULLANICININDIR: değer ZATEN VARSA (kullanıcı/e2e `1` yazmış)
  // DOKUNULMAZ — geri açma yolu ürünün elinden alınmaz (ADR-019 §1 big-bang yasağı).
  if (resolved.isAgent && typeof childEnv.CREWPANE_MCP_LEGACY_ALIASES !== 'string') {
    childEnv.CREWPANE_MCP_LEGACY_ALIASES = '0';
  }

  // ENG-16 — PANE İZOLASYONU: ortak yerel deposu olan motorlarda pane başına ayrı
  // depo (descriptor `isolation`). Beyan etmeyen motorda NO-OP → bugünkü env aynı.
  // Kimlik yazımından ÖNCE: izolasyon kimlikten bağımsızdır ve RESUME yolunda da gerekir.
  // C4 — main canlı pane'lerin ürün-üretimi depo dosyalarını `trusted.liveIsolationFiles`
  // ile verir (main-only ölçüm; `opts` renderer-kontrollü, ikizi o ilan edemez). Fact
  // uygulamadan SONRA env'den ölçülür ve `plan.isolation` ile main'e döner.
  let isolationFact = null;
  if (resolved.isAgent) {
    const liveIsolationFiles = trusted && Array.isArray(trusted.liveIsolationFiles) ? trusted.liveIsolationFiles : [];
    applyPaneIsolationEnv(childEnv, resolved.key, opts, undefined, trusted && trusted.log, liveIsolationFiles);
    isolationFact = paneIsolationPlan(childEnv, resolved.key, opts, undefined, liveIsolationFiles);
  }

  let argv;
  let sessionId = null;
  // BR-01 (ADR-INT-BRIDGE §2.3) — bu spawn'da pane'e GERÇEKTEN enjekte edilen entegrasyon
  // servisleri. main bunu pane kaydına yazar; keşif ucu `toolsLiveInThisPane`i BURADAN
  // cevaplar. "Vault'ta kayıt var" ile "bu pane'in claude'u o server'ı açılışta okudu"
  // FARKLI iki gerçektir (kullanıcı pane açıkken bağlarsa ilki doğru, ikincisi yanlıştır).
  let injectedIntegrations = [];
  let gatedIntegrations = [];
  let lazyFacts = null;
  if (resolved.isAgent) {
    // ADP-192 — a RESTART-resume re-launches the engine on its prior conversation
    // (`--resume <uuid>`); the restored context ALREADY carries the original
    // identity, so we must NOT re-inject `--append-system-prompt` (it would append
    // to the resumed system prompt). The MCP/leader wiring below IS re-applied —
    // those are per-launch flags (claude needs --mcp-config every boot), not
    // conversation state. A non-resumable id never reaches here (isResumeSpawn).
    const wantResume = isResumeSpawn(opts, resolved.key);
    argv = sanitizeArgs(args) ?? defaultArgsFor(resolved.key);
    // ADP-565 — GÖREV-BAŞINA MODEL: `--model <val>` argv'nin BAŞINA (base'e) eklenir,
    // hem taze hem RESUME yolunda uygulanır (model bir per-launch bayrağıdır, konuşma
    // state'i DEĞİL → resume'da da doğru modelde yeniden başlamak için gerekir). Değer
    // verilmezse EKLENMEZ (geriye uyumlu: bugünkü motor-varsayılan davranışı birebir).
    argv = withModel(argv, resolved.key, effectiveModel);
    // CDX-F1 (H1) — GÖREV-BAŞINA EFOR. `withModel` ile AYNI boğaz ve AYNI kural: bu bir
    // PER-LAUNCH bayrağıdır, konuşma state'i DEĞİL → hem taze hem RESUME yolunda
    // uygulanır (resume edilen codex pane'i aksi hâlde sessizce config varsayılanına,
    // yani ölçülmüş `low`a düşerdi). Değer yoksa hiçbir şey eklenmez (geriye uyum).
    argv = withEffort(argv, resolved.key, effectiveEffort, effectiveModel);
    // ADP-580 — register+select a codex custom provider (Groq/DeepSeek/Kimi) via `-c`
    // overrides. Prepended (positional identity prompt stays last). No-op for claude,
    // no provider, or no model. Applied on BOTH fresh + resume (a per-launch flag like
    // --model: a resumed codex pane must re-select its provider or it reverts to default).
    argv = withProvider(argv, resolved.key, effectiveProvider, effectiveModel, customProviderRow);
    // ENG-IMG-01 — attach images to codex CLI via `-i` flag. Claude appends images
    // to the prompt text (caller handles via composePromptWithImages), so images are
    // a no-op for claude. Codex `-i` is a per-launch flag (applied on both fresh + resume).
    argv = withImages(argv, resolved.key, opts.images);
    // ADP-037 — inject the agent's identity so the CLI knows WHO it is. ADP-177 —
    // a `plain` (office-click) pane also gets the conversational guard prepended so
    // it does not auto-orchestrate the team. Skipped on resume (identity is in the
    // restored conversation already).
    // ADP-237 — restart-recall: fold the memory-recall cue into the identity (after the
    // plain guard, before the CLI identity injection). Order: guard → memory cue → identity.
    // BR-02 (ADR-INT-BRIDGE §3) — ÜÇ-DURUM ENTEGRASYON PROTOKOLÜ kimliğin BAŞINA girer.
    // Sıra: plain guard → protokol → hafıza → kimlik. BAŞA eklenir çünkü
    // sanitizeSystemPrompt KUYRUKTAN kırpar (8000) ve ölçülen canlı kompozisyon 8423
    // karakterdi — sona eklenen bir kalıp o pane'de SESSİZCE yok olurdu.
    // D-07 (K3) — kompozisyon TEK YERDE ve KİMLİK ÖNCE bütçelenir. Sıra aynen korunur
    // (guard → protokol → hafıza → kimlik); değişen, 8.000 tavanının kimi kestiği:
    // artık hafıza kırpılır, rol cümlesi ASLA. Bkz. composeSpawnIdentity + D-04 §1.7.
    // AD-WIN-01 — kimliği KOMUT SATIRINDAN çıkaran sink (yalnız win32+claude+destekli).
    // `trusted`ten gelir çünkü DOSYA YOLU üretir ve renderer yol dayatamaz (G-1 emsali).
    // Yoksa/`null`sa satır-içi `--append-system-prompt` bugünkü hâliyle korunur.
    // ENG-21 (G5) — İKİ SİNK, TEK BOĞAZ: AD-WIN-01'in win32 kaçışı (trusted'ten gelir,
    // renderer yol dayatamaz) ÖNCELİKLİ; yoksa descriptor "bu bayrak yalnız DOSYA alır"
    // diyorsa ürünün kendi dosya sink'i devreye girer. Beyan etmeyen motorda `null` →
    // bugünkü satır-içi davranış bit-bit korunur.
    const promptSink =
      (trusted && typeof trusted.promptFile === 'function' ? trusted.promptFile : null) ||
      identityFileFlagSink(resolved.key, opts, undefined, trusted && trusted.log);
    if (!wantResume) {
      // MEM-01 — log seam: hafıza enjeksiyonunun ATLANDIĞI / dizinin YAZILAMADIĞI
      // durumlar artık main'in logLine'ına düşer (sessiz başarısızlık yasağı).
      // TOKEN-BUDGET-01 — BAĞLAM KAPSAMI. Motorun kendi TAM-BOY enjeksiyonu (proje
      // talimatı zinciri + kalıcı hafıza indeksi) her istekte 14.051 jeton taşıyordu;
      // bunun 4.892'si ÇALIŞMA ALANININ ÜSTÜNDEKİ alakasız bir dosyaydı. Plan `null`
      // dönerse hiçbir env set edilmez (HEPSİ-YA-HİÇ; bkz. paneContextScope.cjs).
      // Kontrol kolu: CREWPANE_CONTEXT_SCOPE=off.
      // 🪤 Bütçe, metnin GERÇEKTEN gideceği taşıyıcıdan ölçülür: sink YOKSA metin
      //    satır-içi bayrakla gider ve `sanitizeSystemPrompt` kuyruktan 8.000'de keser.
      let scopePlan = null;
      const composeCap = promptSink ? systemPromptCap.FILE_MAX : systemPromptCap.CLI_MAX;
      // TOKEN-BUDGET-01 — YÜZEY-KOŞULLU BÖLÜMLER. Kimlik renderer'da örülüyor ve
      // orada fs YOK; "bu çalışma alanında mobile/ var mı" ancak burada bilinir.
      // Yüzeyi olmayan bölüm düşer (ölçüldü: mobil kapısı 264 jeton/istek).
      const surfaceTrim = identitySurfaceTrim.trimIdentityToSurfaces(systemPrompt, {
        cwd: cwdResolved,
        workspaceRoot: repoRoot,
        env: childEnv,
        log: trusted && trusted.log,
      });
      let composedIdentity = composeSpawnIdentity({
        contextBlock: (budgetChars) => {
          scopePlan = paneContextScope.planContextScope({
            engineId: resolved.key,
            cwd: cwdResolved,
            workspaceRoot: repoRoot, // main.js buraya `agentWorkspaceRoot`u geçer = ÇALIŞMA ALANI KÖKÜ
            env: childEnv,
            // 🪤 EV DİZİNİ `os.homedir()`DEN DEĞİL ÇOCUĞUN ENV'İNDEN okunur: hafıza
            //    indeksini çözecek olan MOTORDUR ve o `~`yı kendi HOME'undan açar
            //    (hesap profili / test dikişi HOME'u değiştirebilir). `os.homedir()`
            //    kullanmak, sahte-HOME ile koşan birim testlerinde GERÇEK ev dizinini
            //    okumak demekti — ölçüldü: 4 argv testi gerçek indeksi görüp düştü.
            homedir: childEnv.HOME || childEnv.USERPROFILE || os.homedir(),
            budgetChars,
            // MEM-SCOPE-01 — kesilen kayıtlara giden yol. Bu komut olmadan blok
            // "ara" derdi ama ARAYACAK bir şey vermezdi: kesim o hâlde erişim
            // kaybı olurdu. Paketli uygulamada asar.unpacked karşılığı çözülür.
            memorySearchCli: runnableEngineMemorySearchCli(),
            // 🔴 SPAWN'DA GÖREV METNİ YOKTUR ve buraya kimlik/rol GEÇİLMEZ.
            //    D-04 bunu ölçtü: rol-sorgusuyla seçki isabet %6,2 ve blok sabit
            //    hacimde doluyordu (seçki değil DOLDURMA). Aşama A "kurallar + en
            //    son güncellenen N"dir; göreve özel seçki iş metniyle gelir.
            query: '',
            log: trusted && trusted.log,
          });
          return scopePlan ? scopePlan.text : '';
        },
        systemPrompt: surfaceTrim.text,
        opts,
        workspaceRoot: repoRoot,
        log: trusted && trusted.log,
        engine: resolved.key,
        // AD-WIN-02 — bütçe, metnin GERÇEK taşıyıcısına göre. Sink varsa kimlik
        // dosyadan gider (komut satırı duvarı yok) → hafızaya yer kalır.
        // ENG-07 — taşıyıcı kararı withIdentity ile AYNI boğazdan (descriptor'ın
        // `identity.fileFlag`/`cap.file` beyanı); iki yer ayrışırsa metin bir tavana
        // göre kırpılıp BAŞKA bir taşıyıcıyla gönderilirdi.
        // IDN-BUDGET-01 — HAFIZA PAYI DA TAŞIYICININ TAVANINDAN ÖLÇÜLÜR.
        // Eskiden burada POSIX'te sabit 'cli' (8.000) vardı (LEAD-BEHAV-01: "hafıza
        // bloğu büyümesin"). O karar kimlik 8.000'e sığdığı sürece doğruydu; kimlik
        // artık taşıyıcı tavanına örüldüğü için (bir claude LİDERİ 11.4 K) 8.000'lik
        // bir paydan geriye SIFIR kalıyor ve `fitMemoryBlock` hafızayı KOMPLE
        // düşürüyordu — AD-WIN-02 başlığındaki müşteri vakasının (Cihan, "[memory]
        // blok DÜŞTÜ") aynısı. Blok zaten SPAWN_MEMORY_BUDGET_CHARS (2.600) ile
        // sınırlı, yani "hafıza büyümesin" kısıtı korunuyor; değişen tek şey, kalan
        // payın artık metnin GERÇEK taşıyıcısına göre ölçülmesi.
        cap: identityBudget.carrierCap(resolved.key),
        contextCap: composeCap,
      });
      // IDN-BUDGET-01 — SESSİZ KESME YASAĞI. Kimlik bu motorun BEYAN ETTİĞİ taşıyıcıya
      // göre örüldü; taşıyıcı spawn anında gerçekleşmediyse (ör. claude'un dosya
      // bayrağı ÖLÇÜLEMEDİ → sink null) `sanitizeSystemPrompt` kuyruktan kör keser.
      // Bu bir kayıptır ve artık log'a düşer (eskiden hiçbir iz bırakmıyordu).
      if (scopePlan) Object.assign(childEnv, scopePlan.env);
      warnIdentityClamp(composedIdentity, resolved.key, promptSink, trusted && trusted.log);
      fixedLoadFact = {
        identityChars: composedIdentity.length,
        contextScoped: !!scopePlan,
        scopeItems: scopePlan ? scopePlan.items : [],
        surfaceTrimmed: surfaceTrim.dropped,
      };
      argv = withIdentity(argv, resolved.key, composedIdentity, promptSink, process.platform, cwdResolved);
      // ENG-12 — ÜÇÜNCÜ TAŞIYICI: kimlik argv'de DEĞİL, dizin+env ile gidiyorsa
      // (`identity.kind:'env-file'`, copilot) metin BURADA yazılır. argv değişmez;
      // no-op'tur `env-file` beyan ETMEYEN motorlarda (claude/codex bit-bit aynı).
      applyIdentityEnvFile(childEnv, resolved.key, composedIdentity, opts, undefined, trusted && trusted.log);
    }
    // ADP-276 — a RESUME re-launch still needs the ADP-238 memory WRITE discipline:
    // --append-system-prompt is per-launch, so `--resume` restored NONE of the original
    // append (probe-proven) and the pane silently stopped writing to its .crewpane
    // memory. Inject the WRITE rule ONLY (no identity/guard/READ cue — the ADP-192
    // "resume must not re-introduce identity" invariant holds). claude-only; see
    // resumeMemoryPrompt for the probe evidence + the codex rationale.
    // BR-02 — protokol RESUME'da da yeniden verilir (ADP-276'nın tam olarak ölçtüğü
    // sınıf: `--append-system-prompt` PER-LAUNCH'tır, `--resume` orijinal append'in
    // HİÇBİRİNİ geri getirmez → pane sessizce protokolsüz koşardı). Bu bir DAVRANIŞ
    // kuralıdır, KİMLİK değil: ADP-192'nin "resume kimliği yeniden tanıtmaz"
    // değişmezi korunur (buraya kimlik/plain-guard/hafıza-OKU ipucu girmez).
    // AD-WIN-01 — RESUME yolu da aynı sink'ten geçer. Semantik DEĞİŞMEZ: dosya da
    // satır-içi bayrak da PER-LAUNCH append'tir, `--resume` ikisini de geri getirmez.
    // Bu metin kısadır (yalnız YAZMA disiplini + protokol) ama lider argv'sinin geri
    // kalanıyla birlikte yine 8.191'i zorlayabilir → aynı korumadan yararlansın.
    // ENG-07 — koşul artık motor adı değil BEYAN: `identity.resumeReinject`
    // (bayrak taşıyıcısı konuşmaya görünmez → tekrar verilebilir; pozisyonel
    // taşıyıcıda aynı metin kullanıcıya MESAJ olurdu, bkz. supportsResumeReinject).
    else if (supportsResumeReinject(resolved.key))
      argv = withIdentity(
        argv,
        resolved.key,
        integrationBriefing.withIntegrationProtocol(resumeMemoryPrompt(opts, repoRoot), { engine: resolved.key }),
        promptSink,
        process.platform,
        cwdResolved,
      );
    // ADP-052 (ADR-004) — a LEADER pane gets the delegate MCP server + hard subagent
    // block. No-op for non-leaders. ADP-227 — engine-agnostic: claude via --mcp-config/
    // --disallowedTools, codex via -c mcp_servers overrides + --disable multi_agent;
    // childEnv is passed so codex MCP children (which do NOT inherit the pane env) get
    // CREWPANE_INSTANCE/PATH/… injected into their per-server config env.
    // ADP-200 — this now ALSO fires for a `plain` (office-click) leader (isLeaderSpawn no
    // longer excludes plain): a clicked leader is delegation-capable; the PLAIN_OFFICE_GUARD
    // (prepended above) is what keeps it from auto-orchestrating on a mere click.
    // CODEX-ARGV-01 — profil-dosyası taşıyıcısı motorun İKİLİSİNİ sürüm sorgusu için
    // ister; çağıran açıkça vermediyse çözümlenmiş spawn hedefi kullanılır.
    const mcpTrusted = { ...(trusted || {}), binFile: (trusted && trusted.binFile) || resolved.file };
    const argvBeforeLeader = argv;
    const envBeforeLeader = mcpEnvSnapshot(resolved.key, childEnv);
    argv = withLeaderDelegation(argv, resolved.key, opts, undefined, childEnv, mcpTrusted);
    // LEAD-BEHAV-01 — SESSİZ DÜŞÜŞ YASAĞI. `withLeaderDelegation` bir motorda taşıyıcı
    // yoksa (mcp.kind 'config-only') ya da config dosyası/belgesi YAZILAMADIYSA
    // hiçbir şey eklemeden döner; o pane bir LİDER pane'i olduğunu sanır ama
    // `crewpane_delegate` aracı YOKTUR → motor mecburen kendi (görünmez) alt-ajanına
    // düşer. Bugüne kadar bunu yalnız uygulama logu görüyordu. Artık ÖLÇÜLÜR ve
    // spawn sonucuyla renderer'a taşınır; pane açılışında kullanıcıya sarı bir satır
    // olarak YAZILIR (Terminal.tsx). Ölçüm argv KARŞILAŞTIRMASIDIR — beyan değil.
    // ENG-OPENCODE-MCP-01 — env-config taşıyıcısında katkı argv'ye değil BELGEYE gider:
    // ölçü env anlık görüntüsünün farkını da sayar (yalnız argv'ye bakan ölçü, araçlı
    // açılan opencode liderini "delege edemez" diye SUÇLARDI).
    leaderDelegationFact = leaderDelegationStatus(
      resolved.key,
      opts,
      argvBeforeLeader,
      argv,
      envBeforeLeader,
      mcpEnvSnapshot(resolved.key, childEnv),
    );
    // ADP-136 — a DELEGATION EXECUTION pane (opts.disallowSubagent) gets the hard
    // subagent block too, so it can't open invisible Task subagents (no-op if the
    // leader path above already added --disallowedTools Task, or for a normal pane).
    // ADP-200 — a `plain` LEADER now gets the delegate MCP via withLeaderDelegation above,
    // which already adds `--disallowedTools Task`; this block is therefore redundant-but-safe
    // for that case (withSubagentBlock no-ops when the flag is already present). It still
    // guarantees the Task block on the rare path where leaderSignal fires under `plain`
    // without the MCP config having been written, so the ADR-004 "a leader never opens an
    // invisible Task subagent" invariant holds however the pane is opened.
    const blockOpts =
      opts && opts.plain === true && leaderSignal(opts)
        ? { ...opts, disallowSubagent: true }
        : opts;
    argv = withSubagentBlock(argv, resolved.key, blockOpts);
    // ADP-146 — a BROWSER-CAPABLE worker pane (opts.browserCapable) gets the
    // browser-ONLY MCP config (+ strict + Task block), so it can drive the headed
    // internal browser but cannot sub-delegate. No-op for a leader (already has both
    // servers) or a normal worker. Appended after the subagent-block so the Task
    // flag isn't duplicated. ADP-227 — codex equivalent wired too.
    argv = withBrowserCapable(argv, resolved.key, opts, undefined, childEnv, mcpTrusted);
    // ADP-183 — give the Task Board MCP to every OTHER agent (not a leader, not
    // browser-capable — those already bundle it). claude: additive --mcp-config
    // (no --strict) so other MCP servers survive; codex (ADP-227): additive -c
    // overrides. The board tool is present on every agent spawn.
    argv = withTaskCapable(argv, resolved.key, opts, undefined, childEnv, mcpTrusted);
    // ADP-692 — LİDER'e tur-başı brifing hook'u (`--settings`, additive). Kanal A:
    // bekleyen bitişler kullanıcının prompt'u GÖNDERİLDİKTEN sonra bağlama eklenir,
    // composer'a asla yazılmaz. RESUME'da da uygulanır: `--settings` bir per-launch
    // bayrağıdır (konuşma state'i değil), resume edilen lider de hook'u taşımalı.
    argv = withTurnBriefing(argv, resolved.key, opts, undefined);
    // AGY-03 — antigravity dengi: brifing (`PreInvocation`) + alt-ajan bloğu
    // (`PreToolUse deny`) demetin `hooks.json`una yazılır. Hook BAYRAĞI olmayan bu
    // motorda `withTurnBriefing` NO-OP kalır; kapıyı bu adım kurar. Diğer motorlarda
    // bu satır tam anlamıyla no-op'tur (descriptor `hooks.carrier` beyan etmiyor).
    argv = withAgyHooks(argv, resolved.key, opts, undefined);
    // ADP-585 — kullanıcının BAĞLI entegrasyonları (Supabase/GitHub/… MCP server'ları).
    // Anahtarlar `trusted.integrations` üzerinden gelir (main-only, ADP-580 providerKeys
    // emsali; opts renderer-kontrollü olduğu için secret ORADAN ASLA gelmez). Resolver
    // yoksa (bugün main.js henüz bağlamadı — ADP-586) liste boş → argv/env DEĞİŞMEZ:
    // bu satır bugünkü davranışa göre tam anlamıyla no-op'tur. Additive `--mcp-config`,
    // `--strict-mcp-config` YOK → kullanıcının + lider/browser strict yollarının MCP
    // kurulumu aynen korunur.
    const integrationCreds = resolveIntegrationCreds(opts, trusted);
    argv = withIntegrations(argv, resolved.key, opts, undefined, childEnv, integrationCreds);
    // Yalnız claude yolunda gerçekten enjekte edilir (withIntegrations'ın kendi kuralı) —
    // liste burada da o kurala UYAR ki kayıt, davranışın aynası olsun, iddiası değil.
    // MCP-LAZY-01 — KAYIT DAVRANISIN AYNASI. Profil kapisindan GECEN liste yazilir;
    // kapali servis pane kaydinda gorunmez → kesif ucu `toolsLiveInThisPane: false`
    // der ve ajan "bagli ama bu pane'de acik degil" cevabini alir (sessiz yalan yok).
    if (integrationsInjectable(resolved.key)) {
      const gated = gateIntegrations(integrationCreds, opts, undefined);
      injectedIntegrations = gated.kept.map((c) => c.service);
      // MCP-LAZY-01 — "bagli ama bu pane'de kapali" listesi de kayda girer: Ayarlar
      // satiri ve kesif ucu bunu ADIYLA soyleyebilsin (kapali servis SESSIZ olmamali).
      gatedIntegrations = gated.skipped.map((sv) => ({ service: sv, source: gated.reasons[sv] || 'global' }));
      lazyFacts = readIntegrationsConfigFacts(undefined, opts);
    }
    // "Son kullanım" damgası YALNIZ gerçekten enjekte edildiğinde — ateşle-unut.
    if (integrationsInjectable(resolved.key) && integrationCreds.length
      && trusted && trusted.integrations && typeof trusted.integrations.markUsed === 'function') {
      try {
        trusted.integrations.markUsed(integrationCreds.map((c) => c.id));
      } catch {
        /* damga spawn'ı asla etkilemez */
      }
    }
    // CIDX-1 — KOD İNDEKSİ (opsiyonel; proje başına, VARSAYILAN KAPALI). Karar
    // `trusted.codeIndex`ten gelir (main-only). Çözümleyici yoksa ya da bu projede
    // anahtar kapalıysa satır tam anlamıyla no-op'tur — argv bit-bit bugünküdür.
    argv = withCodeIndex(argv, resolved.key, opts, undefined, trusted);
    // ADP-236 — NOT wired: `--add-dir <memory dir>` makes claude prompt to TRUST each added
    // dir (a first-run gate the office pre-accepts only for the cwd), and it adds little —
    // `--dangerously-skip-permissions` + the ADP-237 cue (absolute paths) already give the
    // agent full read/write of its memory dirs. withMemoryDirs() stays exported (a future
    // path if we pre-trust the memory dirs), but is deliberately not applied here.
    // ADP-064 — a LEADER pane also carries CREWPANE_LEADER_ID/DEPARTMENT env so
    // its delegate MCP server knows who delegates (else "leader identity missing").
    withLeaderEnv(childEnv, resolved.key, opts);
    // ADP-146 — a browser-capable worker carries CREWPANE_AGENT_ID so the browser
    // MCP attributes its actions (no-op for a leader: CREWPANE_LEADER_ID wins).
    withBrowserEnv(childEnv, resolved.key, opts);
    if (wantResume) {
      // ADP-192 — re-launch on the prior conversation. The session id is the same
      // one we minted before, so a later restart resumes again (self-healing).
      argv = appendResume(argv, resolved.key, opts.sessionId);
      // ENG-07 — eski satır motor adına göre iki dal taşıyordu; ikisi de ULAŞILABİLİR
      // durumda AYNI değeri veriyor (isResumeSpawn zaten dolu bir id garanti eder),
      // dal düşürüldü: id yoksa `null` (uydurma id kaydedilmez).
      sessionId = opts.sessionId || null;
    } else {
      // ADP-087 (ADR-007 Faz 1) — mint a stable claude session id (additive; codex
      // unchanged). Appended LAST so identity/delegation argv positions are stable.
      const withSid = withSessionId(argv, resolved.key, opts, baseEnv);
      argv = withSid.argv;
      sessionId = withSid.sessionId;
    }
    // ENG-03 — SON NORMALİZASYON: codex `-i` variadic olduğu için, görsel listesinden
    // sonra gelen KONUMSAL prompt yutulur. Argv'nin TAMAMI kurulduktan sonra (kimlik en
    // sonda) listeyi `--` ile kapat. En sonda olmak zorunda: withImages çalıştığında
    // kimlik henüz eklenmemişti, yani o an "arkada konumsal var mı" ölçülemezdi.
    argv = terminateImageList(argv, resolved.key);
  } else {
    // Login shell, no args — identical to ADP-003 spawnPty (regression-safe).
    argv = [];
  }

  return {
    key: resolved.key,
    isAgent: resolved.isAgent,
    file: resolved.file,
    argv,
    cwd: cwdResolved,
    env: childEnv,
    // ADP-087 — known up front for resume-queue capture; null for codex/shell.
    sessionId,
    // ADP-565 — the EFFECTIVE launch model actually passed as `--model` (null when
    // none/unusable/shell). main records it AUTHORITATIVELY on the pane so the model
    // badge reflects what we launched, not a config-file guess (K1) that ignores the flag.
    model: resolved.isAgent ? effectiveModel : null,
    // CDX-F1 — bu pane'e GERÇEKTEN basılan efor (null = bayrak eklenmedi → motorun kendi
    // varsayılanı). main pane kaydına yazar; rozet/log "high istedik" DEMEZ, "high gitti" der.
    effort: resolved.isAgent ? effectiveEffort : null,
    // ADP-580 — the codex custom provider actually selected (null for claude/shell/none).
    // main uses it to render a provider-aware chip ("Groq · Llama 3.3 70B").
    provider: effectiveProvider,
    // ACCT-FIX-01 — bu pane HANGİ hesap profiliyle açıldı (null = bilinmiyor/motor değil).
    // main `ptys.set`e yazar; limit defteri ve "Bu hesaba geç" listesi buradan okur.
    engineProfileId,
    // B-01 — bu pane GERÇEKTEN izole ağaçta mı açıldı? İDDİA değil ÖLÇÜM: kademe-0
    // yalnız yol var VE dizinse uygulanır, o yüzden `cwdResolved` ile karşılaştırılır.
    // main bunu `live-panes.json` satırına yazar (restart-resume aynı ağaca döner,
    // H-2) ve pane başlığındaki branch rozeti bu kayıttan beslenir.
    taskWorktree:
      resolved.isAgent && trusted && typeof trusted.taskWorktree === 'string'
        && cwdResolved === trusted.taskWorktree
        ? trusted.taskWorktree
        : null,
    taskBranch: resolved.isAgent && trusted && typeof trusted.taskBranch === 'string' ? trusted.taskBranch : null,
    taskId: resolved.isAgent && trusted && typeof trusted.taskId === 'string' ? trusted.taskId : null,
    // BR-01 — keşif ucunun pane bağlamı. `services` = bu pane'e YAZILAN entegrasyonlar;
    // `projectId`/`env` = hangi bağlamda çözümlendiği (resolver ile aynı normalizasyon,
    // varsayılan 'dev' — prod açık işaret ister).
    integrations: resolved.isAgent
      ? {
          services: injectedIntegrations,
          projectId: integrationContextFor(opts).projectId,
          env: integrationContextFor(opts).env,
          // MCP-LAZY-01 — profil kapisinin KESTIKLERI + bu pane tembel mi.
          gated: gatedIntegrations,
          lazy: lazyFacts ? lazyFacts.lazy : false,
        }
      : null,
    // ENG-07 (ENG-R3 §2.3 ZORUNLU KURALI) — BU PANE'İN YAPAMAYACAKLARI.
    // Yukarıdaki uygulayıcılar bir yeteneği `null` bulup atladığında bu artık SESSİZ
    // değildir: liste descriptor'ın kendisinden türer (uygulayıcılarla sapması
    // imkânsız), main pane kaydına yazar + log'a düşürür, ENG-10 rozetleri bunu okur.
    // `severity:'security'` olan satırlar (kimlik / alt-ajan bloğu / mcp / trust)
    // "bilgi" değil UYARI'dır: ADR-004'ün sert katmanı kaybolduğunda kimsenin fark
    // etmemesi, envanterdeki en somut güvenlik bulgusuydu.
    capabilities: resolved.isAgent
      ? {
          engine: resolved.key,
          unsupported: unsupportedCapabilities(resolved.key),
          summary: engineRegistry.unsupportedSummary(resolved.key),
          // LEAD-BEHAV-01 — SPAWN seviyesinde hüküm (motor seviyesindeki `unsupported`
          // ile karışmasın): bu pane bir lider pane'i mi ve delege kablosunu aldı mı.
          ...(leaderDelegationFact ? { leaderDelegation: leaderDelegationFact } : {}),
        }
      : null,
    // TOKEN-BUDGET-01 — sabit yük künyesi (kimlik uzunluğu + kapsam kararı).
    fixedLoad: fixedLoadFact,
    // C4 — bu pane'in ÜRÜN-ÜRETİMİ yerel depo dosyası (`{env,file,separated,twinOf}`;
    // null = izolasyon beyan etmeyen motor / kullanıcı kendi deposunu ezmiş). main
    // pane kaydına yazar (ikiz kapısının canlı listesi buradan beslenir) ve
    // `separated` ise pane'e "ayrı veritabanıyla açıldı" satırını basar.
    isolation: isolationFact,
    // ENG-07 L2 — güven ön-kabulü durumu. `pending:true` ise çağıran (main) pty'yi
    // doğurmadan önce `ensureEngineTrusted`ı çağırmak ZORUNDA; `null` = motorun güven
    // yeteneği beyan edilmemiş (kayıp `capabilities`ta görünür, sessiz atlanmaz).
    trust: trustPlan,
  };
}

/**
 * Derive a binding status from last-activity (ADP-014 bridge). `lastDataAt` is
 * 0 before the pane's first byte → "working" (it just started). After that,
 * working while bytes are recent, else idle.
 */
function statusFor(lastDataAt, now) {
  if (!lastDataAt) return 'working';
  return now - lastDataAt < IDLE_AFTER_MS ? 'working' : 'idle';
}

// ---------------------------------------------------------------------------
// TASK-MQTIYIIZE5VR7 (st2) — worker completion REPORT contract (pure helpers).
// ---------------------------------------------------------------------------
// When a delegated worker finishes it must leave a report at
// `docs/agent-results/<task>-<role>.md` so the CrewPane "Raporlar" tab surfaces
// it (src/lib/reports.ts reads that dir). These PURE helpers are the single source
// of truth for the report's filename + on-disk shape, reused by:
//   • the runtime-fallback write channel (delegationBridge.js POST /report), and
//   • any completion-side caller that guarantees a report lands (completion-signal,
//     TASK-MQSE75 — same area, coordinated: it triggers, this builds the bytes).
// src/lib/reports.ts derives task_id from the FILENAME (`<task>-<role>.md`) and
// agent_name/status from `---` frontmatter — so the filename + frontmatter we emit
// here (task_id/agent/status) are exactly what that reader parses back. No fs here:
// the caller owns the write; this module only builds strings (kept unit-testable).

// Known board statuses (mirrors the Task Board lifecycle); an unrecognized status is
// passed through trimmed so a caller can still record e.g. "partial".
const REPORT_STATUSES = Object.freeze(['done', 'failed', 'in_progress', 'review', 'blocked', 'todo', 'backlog']);
// Filename-segment cap — keep `<task>-<role>.md` well under any path limit.
const MAX_REPORT_TOKEN_LEN = 80;

/**
 * REN-02 — Türkçe + yaygın Latin-1 harflerini ASCII'ye KATLA (silme!).
 *
 * Eskiden `sanitizeReportToken` bunları izinsiz sayıp `-`e çeviriyordu: "Öykü" → "-yk-"
 * → "yk". Ad yolda tanınmaz hâle geliyor, üstelik `İ` invariant küçültmede `i` + U+0307
 * (birleşen nokta) üretip DOSYA ADINA giriyordu; Windows (UTF-16, normalizasyon yok)
 * ve Linux (bayt-bayt) bunu ön-birleşik ad ile AYRI dosya sayıyor → kanıt kapısı ıskalıyor.
 * Katlama küçültmeden ÖNCE koştuğu için U+0307 hiç doğmaz.
 *
 * `src/app/lib/agentPathToken.ts` `foldAscii` ile aynı tablo (renderer eşleniği).
 */
const REPORT_TOKEN_FOLD = Object.freeze({
  // ⚠️ ASCII `I`/`i` BU TABLODA YER ALMAZ (PIPE-10). Tablo Türkçe NOKTALI/NOKTASIZ
  // i'yi katlamak için var: `ı`(U+0131) ve `İ`(U+0130). Buraya düz ASCII `I: 'i'`
  // de yazılmıştı ve katlama küçültmeden ÖNCE koştuğu için GÖREV KODUNU bozuyordu:
  // `TASK-MQTIYIIZE5VR7` → `TASK-MQTiYiiZE5VR7`. reports.ts `parseFilename` büyük
  // harfli kod bekler ⇒ rapor dosyası sessizce çözülemez hâle geliyordu (kanıt kapısı
  // ıskalar). Ajan jetonu zaten `toLowerCase()` uygular ⇒ kaldırmak onu ETKİLEMEZ.
  ç: 'c', Ç: 'c', ğ: 'g', Ğ: 'g', ı: 'i', İ: 'i',
  ö: 'o', Ö: 'o', ş: 's', Ş: 's', ü: 'u', Ü: 'u',
  á: 'a', à: 'a', â: 'a', ä: 'a', ã: 'a', å: 'a', Á: 'a', À: 'a', Â: 'a', Ä: 'a', Ã: 'a', Å: 'a',
  é: 'e', è: 'e', ê: 'e', ë: 'e', É: 'e', È: 'e', Ê: 'e', Ë: 'e',
  í: 'i', ì: 'i', î: 'i', ï: 'i', Í: 'i', Ì: 'i', Î: 'i', Ï: 'i',
  ó: 'o', ò: 'o', ô: 'o', õ: 'o', Ó: 'o', Ò: 'o', Ô: 'o', Õ: 'o',
  ú: 'u', ù: 'u', û: 'u', Ú: 'u', Ù: 'u', Û: 'u',
  ñ: 'n', Ñ: 'n', ý: 'y', Ý: 'y', ß: 'ss', æ: 'ae', Æ: 'ae', ø: 'o', Ø: 'o',
});

function foldAscii(raw) {
  let s = typeof raw === 'string' ? raw : '';
  try {
    s = s.normalize('NFC');
  } catch {
    /* normalize yoksa ham metinle devam */
  }
  let out = '';
  for (const ch of s) out += REPORT_TOKEN_FOLD[ch] ?? ch;
  try {
    out = out.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  } catch {
    /* tablo sonucu yeterli */
  }
  return out;
}

/**
 * Sanitize one filename segment (task id / role) to a bare token. Mirrors
 * src/lib/reports.ts `sanitizeFilename` (only [A-Za-z0-9._-], no separators / `..`)
 * so a crafted taskId/role can NEVER escape the results dir — defense in depth on top
 * of the bridge's loopback+token gate. Returns '' for anything unusable. Pure.
 */
function sanitizeReportToken(raw) {
  if (typeof raw !== 'string') return '';
  const t = foldAscii(raw)
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, '-') // collapse disallowed runs → single '-'
    .replace(/^[-.]+|[-.]+$/g, ''); // no leading/trailing separator or dot
  return t.slice(0, MAX_REPORT_TOKEN_LEN);
}

/**
 * REN-02 — AJAN JETONU (rapor dosya adının ikinci segmenti).
 *
 * `sanitizeReportToken`den TEK farkı: küçük harfe indirir. Görev kodu BÜYÜK kalmalı
 * (`REN-02`, reports.ts `parseFilename` büyük harfli kod bekler) ama ajan jetonu her
 * yerde küçük olmalı — aksi hâlde `…-Jazz.md` ile `…-jazz.md` case-insensitive bir
 * dosya sisteminde (NTFS/APFS) BİRBİRİNİN ÜSTÜNE yazar (sessiz yanlış-done), ext4'te
 * ise İKİ AYRI dosya olur (sahte-failed). Aynı ad, üç OS'ta da tek dosya.
 *
 * `src/app/lib/agentPathToken.ts` `agentPathToken` ile AYNI sözleşme (o taraf renderer,
 * bu taraf main/bridge). Pariteyi `src/app/lib/agentPathToken.test.mts` ölçer.
 */
function reportAgentToken(raw) {
  return sanitizeReportToken(raw).toLowerCase();
}

/**
 * Canonical report filename for a (taskId, role): `<task>-<role>.md`. Returns null
 * when taskId is unusable (role optional → falls back to `report`). The result is a
 * bare *.md name that passes reports.ts `sanitizeFilename`, and whose leading
 * segments parse back to the task id via reports.ts `parseFilename`.
 */
function reportFileName(taskId, role) {
  const task = sanitizeReportToken(taskId);
  if (!task) return null;
  // REN-02 — ajan jetonu KÜÇÜK harf (case-kararlı, OS'tan bağımsız tek dosya adı).
  const r = reportAgentToken(role) || 'report';
  return `${task}-${r}.md`;
}

/**
 * Build the on-disk markdown for a completion report, with `---` frontmatter that
 * src/lib/reports.ts parses (task_id / agent / status) plus a body whose first ~300
 * chars become the panel summary. `status` is lowercased to a known slug when
 * recognizable, else passed through trimmed (default `done`). A missing/blank summary
 * yields a terse placeholder — a fallback report still needs a non-empty body so the
 * panel shows something rather than an empty card. Pure.
 */
function buildReportMarkdown(opts = {}) {
  const { taskId, role, agentName, status, summary } = opts;
  const task = sanitizeReportToken(taskId) || 'TASK';
  const agent =
    (typeof agentName === 'string' && agentName.trim()) || sanitizeReportToken(role) || 'agent';
  const rawStatus = typeof status === 'string' ? status.trim() : '';
  const normStatus = REPORT_STATUSES.includes(rawStatus.toLowerCase())
    ? rawStatus.toLowerCase()
    : rawStatus || 'done';
  const body =
    (typeof summary === 'string' && summary.trim()) ||
    '(özet yok — çalışma tamamlandı, ayrıntı eklenmedi.)';
  // REN-02 — `agent_id`: raporun KALICI kimliği (görünen ad değişse de sabit). Raporlar
  // sekmesi eskiden ajanı yalnız dosya adından/`agent:` alanından çıkarıyordu → rename
  // sonrası aynı kişi İKİ ajan gibi listeleniyor ve İKİ farklı renk alıyordu (REN-01 E4:
  // `wonder_woman` hue 6 / `wonderwoman` hue 31). `agent:` insan-okur ad olarak KALIR.
  const agentId = reportAgentToken(role);
  const frontmatter = [
    '---',
    `task_id: ${task}`,
    `agent: ${agent}`,
    ...(agentId ? [`agent_id: ${agentId}`] : []),
    `status: ${normStatus}`,
    '---',
    '',
  ].join('\n');
  return `${frontmatter}# ${task} — ${agent}\n\n${body}\n`;
}

module.exports = {
  ALLOWED_COMMANDS,
  DEFAULT_AGENT_ARGS, // ENG-07 — descriptor.defaultArgs'tan TÜRETİLMİŞ (elle liste değil)
  defaultArgsFor,
  IDLE_AFTER_MS,
  MAX_SYSTEM_PROMPT_LEN, // AD-WIN-02 — KOMUT SATIRI tavanı (dosya dalı: systemPromptCap.FILE_MAX)
  isAllowedCommand,
  resolveCommand,
  sanitizeArgs,
  sanitizeSystemPrompt,
  sanitizeModel, // ADP-565 — model biçim-whitelist (saf)
  // ENG-07 — descriptor-güdümlü argv hunisi: defter dikişi + genel uygulayıcılar.
  setEngineRegistry,
  engineCapability,
  unsupportedCapabilities,
  applyArgs,
  repeatFlagArgs,
  identityCarrier,
  identityFileCarrierIsOverflowOnly, // LEAD-BEHAV-01
  leaderDelegationStatus, // LEAD-BEHAV-01
  mcpEnvSnapshot, // ENG-OPENCODE-MCP-01
  parseEnvConfigDoc, // ENG-OPENCODE-MCP-01
  identityUsesFileCarrier,
  identityFlagIsFileOnly, // ENG-21 (G5)
  identityFileFlagSink, // ENG-21 (G5)
  withIdentityFrontmatter, // ENG-21 (G5)
  supportsResumeReinject,
  subagentBlockArgs,
  mcpRegisterArgs,
  codexMcpServerEnv, // AGY-02 — test dikişi: MİRAS ALMAYAN motorun MCP çocuğuna hangi anahtarlar gidiyor
  contributionPosition,
  integrationsInjectable,
  withModel, // ADP-565 — spawn `--model` (claude/codex)
  withEffort, // CDX-F1 — spawn efor kolu (codex `-c model_reasoning_effort`, claude `--effort`)
  resolveEffort, // CDX-F1 — descriptor beyaz listesinden geçmiş efektif efor (test dikişi)
  withProvider, // ADP-580 — codex custom provider `-c model_provider=…`
  withIdentity,
  applyIdentityEnvFile, // ENG-12 — kimliğin ÜÇÜNCÜ taşıyıcısı (dizin + env)
  identityUsesEnvFile,
  identityEnvDirRoot,
  mergeIdentityConfigDoc, // ENG-16 — json-config kimlik belgesi (saf, test edilebilir)
  applyPaneIsolationEnv, // ENG-16 — pane başına ayrı yerel depo
  paneIsolationPlan, // C4 — izolasyon fact'i (env'den ölçülür; ikiz kapısı)
  withPlainGuard,
  isIdentitylessSpawn, // PDF2-2
  identityCarrierIsSilent, // PDF2-2
  warnIdentityClamp,
  withRecalledMemory,
  // D-07 — iki aşamalı enjeksiyon + kimlik-önce bütçe (mutasyon testinin girdileri)
  memorySpawnBlock,
  fitMemoryBlock,
  composeSpawnIdentity,
  memoryLedger,
  spawnRetrieverFor,
  runnableRecallCli,
  runnableEngineMemorySearchCli,
  SPAWN_MEMORY_BUDGET_CHARS,
  setSpawnMemoryWarm,
  resumeMemoryPrompt,
  withMemoryDirs,
  isUuid,
  withSessionId,
  isResumeSpawn,
  isDeadSessionExit, // RESTORE-DEADSESSION-FALLBACK — ölü-session exit imzası (saf)
  appendResume,
  leaderSignal,
  isLeaderSpawn,
  resolveMcpServerDir,
  mcpServerDir,
  delegateMcpServerPath,
  browserMcpServerPath,
  taskMcpServerPath,
  // BR-01 — entegrasyon keşif server'ı (paketleme + spawn testleri bunu okur)
  integrationsMcpServerPath,
  INTEGRATIONS_MCP_SERVER_NAME,
  INTEGRATIONS_MCP_SERVER_FILE,
  mcpEnvelopeFor, // ENG-21 (G6)
  mcpConfigDoc, // ENG-21 (G6)
  mcpConfigFileName, // ENG-21 (G6)
  delegateMcpConfigPath,
  writeJsonAtomic,
  winSafeAtomicWrite, // WIN-FIX-01 (W1)
  ensureNodeLauncher, // WIN-FIX-01 (W1)
  ensureDelegateMcpConfig,
  withLeaderDelegation,
  withSubagentBlock,
  withAgyHooks,
  agyHookRunnerPath,
  // ENG-03 — codex görsel bayrağı + variadic liste kapatıcı (proof/test bunları okur)
  withImages,
  terminateImageList,
  browserMcpConfigPath,
  ensureBrowserMcpConfig,
  withBrowserCapable,
  withBrowserEnv,
  taskMcpConfigPath,
  ensureTaskMcpConfig,
  withTaskCapable,
  // ADP-692 — tur-başı brifing (kanal A) spawn wiring
  briefingHookPath,
  briefingSettingsPath,
  ensureBriefingSettings,
  withTurnBriefing,
  // ADP-585 — Entegrasyon Merkezi spawn wiring (vault → MCP → ajan)
  integrationsMcpConfigPath,
  ensureIntegrationsMcpConfig,
  readIntegrationsConfigFacts,
  integrationsLazyManifestPath,
  integrationsToolCacheDir,
  lazyProxyPath,
  gateIntegrations,
  cleanupIntegrationsMcpConfig, // INT-0-C — pane kapanışında KENDİ config'i
  cleanupAgyWorkspacePlugin, // AGY-01 — pane kapanışında KENDİ plugin kökü
  sweepStaleAgyWorkspacePlugins, // AGY-01 — uygulama çökmüşse kalan sahipsiz kökler
  sweepStaleIntegrationsConfigs, // INT-0-C — çökme sonrası sahipsiz artıklar
  integrationsPaneKey, // INT-0-C — dosya adı anahtarı (test edilebilir olsun)
  userFieldEnv, // INT-0-A — env allowlist'i (test edilebilir olsun)
  withIntegrations,
  // CIDX-1 — kod indeksi spawn wiring (ayar → additive --mcp-config)
  codeIndexMcpConfigPath,
  ensureCodeIndexMcpConfig,
  codeIndexInjectable,
  withCodeIndex,
  integrationContextFor,
  resolveIntegrationCreds,
  INTEGRATION_SECRET_ENV_PREFIX,
  withLeaderEnv,
  sanitizeCwd,
  resolveCwd,
  sanitizeEnv,
  INHERITED_ENGINE_ENV,
  PANE_SCOPED_ENV_KEYS,
  augmentedPath,
  setPathVar,
  getPathVar,
  ensureUtf8Locale,
  isUtf8Locale,
  DEFAULT_LANG,
  buildSpawn,
  statusFor,
  claudeTrustPatch,
  isClaudeTrusted,
  ensureClaudeTrusted,
  // ENG-07 L2 — güven ön-kabulü TEK BOĞAZ (descriptor `trust.kind` → format yazıcısı)
  ensureEngineTrusted,
  trustWritesAtSpawn,
  planEngineTrust,
  TRUST_WRITERS,
  // ADP-283 — codex trust pre-accept (pure helpers unit-tested; fs wrapper best-effort)
  canonicalCwd,
  codexIsTrusted,
  codexTrustPatch,
  ensureCodexTrusted,
  // TASK-MQTIYIIZE5VR7 (st2) — completion-report format (pure; reused by the bridge).
  REPORT_STATUSES,
  sanitizeReportToken,
  // REN-02 — ad→yol katlaması + kalıcı-kimlik jetonu (parite testi bunları okur)
  foldAscii,
  reportAgentToken,
  reportFileName,
  buildReportMarkdown,
};
