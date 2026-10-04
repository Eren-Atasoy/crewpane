// ADP-232-C — paketli app İLK AÇILIŞ "çalışma alanı seç" onboarding'inin main-side çekirdeği.
//
// SORUN (ADP-187/234 bilinen sınır, keşifle kanıtlandı): paketli app'te
// settings.workspaceRoot yokken resolveWorkspaceRoot REPO_ROOT'a düşüyordu; paketli
// REPO_ROOT = app.asar'ın kardeşi (/Applications/CrewPane.app/Contents/Resources) —
// salt-okunur bundle içi. Delege edilen ajanlar gerçek projeyi göremiyor, bridge
// results/`.crewpane` yazımları bundle'a düşmeye çalışıyordu.
//
// ÇÖZÜM (üç parça):
//   1. main.js paketliyken fallback'i null geçer (asar-içine düşme YOLU KAPALI);
//      root'suz kalan tüketiciler net hata verir (workspace_not_configured).
//   2. Renderer'da first-run gate (WorkspaceGate.tsx): `firstRunRequired` ise
//      karşılama ekranı — (a) önerilen ~/CrewPane'i oluştur, (b) mevcut klasörü
//      OS dialog'uyla seç. Yol renderer'dan ASLA gelmez (capability-by-user-choice,
//      ADP-103 modeliyle aynı): create sabit varsayılanı kullanır, pick main-side
//      dialog'dan döner.
//   3. Seçim settings.workspaceRoot'a yazılır (applySettingsPatch → restartRequired)
//      ve app ADP-232 Faz A tek-tık relaunch'ıyla yeni kökle açılır.
//
// Bu modül SAF-ish: Electron require'ı YOK (dialog main.js'te kalır); fs/os/path +
// agentSettings/crewpaneEnv. node --test ile gerçek tmp dizinlerde test edilir.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const agentSettings = require('./agentSettings.cjs');
const crewpaneEnv = require('../config/crewpaneEnv.cjs');

// Önerilen varsayılan: ~/CrewPane (görev kararı — boş, kullanıcıya ait, bundle dışı).
const DEFAULT_WORKSPACE_DIRNAME = 'CrewPane';

function defaultWorkspaceDir(homedir) {
  return path.join(homedir || os.homedir(), DEFAULT_WORKSPACE_DIRNAME);
}

/**
 * İlk-açılış gate'i gerekli mi? Kural: configured root YOKSA ve (paketli app VEYA
 * test seam'i CREWPANE/CREWPANE_FORCE_FIRST_RUN=1) → true. Kaynaktan koşan dev
 * (isPackaged=false) REPO_ROOT fallback'iyle bugünkü gibi çalışır — gate görmez;
 * e2e kaynaktan koştuğu için force seam'i şart (packaged-metadata-cli-coercion dersi:
 * paket-zamanı davranışı kaynaktan-koşan e2e göremez, seam olmadan test edilemezdi).
 */
function firstRunRequired({ isPackaged } = {}) {
  if (agentSettings.configuredWorkspaceRoot()) return false;
  if (crewpaneEnv.readEnv('FORCE_FIRST_RUN') === '1') return true;
  return isPackaged === true;
}

/** ADP-852 v3 — erişim reddi (TCC sınıfı) ile "gerçekten yok"u ayıran tek karar. */
function denialReason(err) {
  const code = (err && err.code) || '';
  return code === 'EPERM' || code === 'EACCES' ? 'permission-denied' : 'not-a-directory';
}

/**
 * Seçilen kökü DOĞRULA + settings'e yaz. `forbiddenPrefix` (paketli app'te
 * process.resourcesPath) bundle-içi bir kökü NET HATAYLA reddeder — "asla asar içi
 * path kullanma" guard'ının kemer-askı katmanı (dialog'dan Resources seçilse bile).
 * Dönen restartRequired ADP-232 sözleşmesidir (workspaceRoot restart-gated).
 */
function commitWorkspaceRoot(root, { forbiddenPrefix } = {}) {
  // ADP-852 v3 — SESSİZ/YANLIŞ TEŞHİS YASAK. `realpathSync` macOS TCC reddinde
  // (Documents/Downloads/Desktop izni verilmemiş) **EPERM** fırlatır; eskiden bu da
  // 'not-a-directory' olup "seçilen yol bir klasör değil" diye gösteriliyordu —
  // kullanıcı klasörün orada DURDUĞUNU gördüğü için mesaj yalan gibi okunuyordu ve
  // yapılacak şeyi (izin ver) HİÇ söylemiyordu. Artık izin reddi kendi hükmünü alır.
  let real = root;
  try {
    real = fs.realpathSync(root);
  } catch (err) {
    return { ok: false, reason: denialReason(err), detail: (err && err.code) || undefined };
  }
  const probe = agentSettings.probeDir(real);
  if (!probe.ok) {
    return {
      ok: false,
      reason: probe.reason === 'denied' ? 'permission-denied' : 'not-a-directory',
      detail: probe.code,
    };
  }
  if (forbiddenPrefix) {
    const pfx = forbiddenPrefix.endsWith(path.sep) ? forbiddenPrefix : forbiddenPrefix + path.sep;
    if (real === forbiddenPrefix || real.startsWith(pfx)) {
      return { ok: false, reason: 'inside-app-bundle' };
    }
  }
  // ADP-946 — SEÇİM KALICI OLMADIYSA BUNU SÖYLE. Eskiden bu satır yalnız
  // `restartRequired`i alıyordu ve HER durumda `{ ok:true }` dönüyordu; Windows'ta
  // ayar yazımı düşünce (Defender/indeksleyici hedefi açık tutar) kullanıcı
  // "çalışma alanı seçildi" ekranını görüyor, uygulamayı kapatıp açtığında ise
  // ilk-açılış kapısına geri dönüyordu — hiçbir yerde tek satır hata yoktu.
  // `ok` YİNE true: seçim BU OTURUMDA geçerlidir (canlı geçiş yapılır). Yeni olan,
  // "yeniden açılışta duracak mı" sorusunun DÜRÜST cevabının da dönmesi.
  const { restartRequired, persisted, persistError } = agentSettings.applySettingsPatch({ workspaceRoot: real });
  return { ok: true, root: real, restartRequired, persisted, persistError };
}

// ── BL-01 · BİLİNEN ÇALIŞMA ALANLARI DEFTERİ ────────────────────────────────
//
// NEDEN VAR: paket matrisinde "Çalışma alanı: 1 / sınırsız / sınırsız" satırı var
// ama uygulama TEK bir aktif kök tutuyordu — sayılacak bir şey yoktu, dolayısıyla
// zorlanacak bir şey de yoktu (BL-01 SORUN B). Defter, "kaç çalışma alanım var"
// sorusunun tek cevabıdır.
//
// İKİ SERT KURAL:
//   1. AKTİF KÖK HER ZAMAN BİLİNİR. Defter diskte boş olsa bile (bu özellikten
//      önce kurulmuş her mevcut kullanıcı böyle) sayım aktif kökü İÇERİR. Aksi
//      hâlde ödeyen bir kullanıcı kendi açık çalışma alanına "yeni alan" diye
//      reddedilirdi — bu üründeki en pahalı hata (ADR-027 duruşu).
//   2. GERÇEKLİĞE GÖRE BUDANIR. Diskte artık var olmayan bir kök sayılmaz:
//      klasörünü silen/taşıyan kullanıcı kotasını geri kazanır (ve bu, kota
//      dolduğunda kullanıcının elindeki tek serbest bırakma yoludur).
//
// Saf-ish: yalnız fs + agentSettings. node --test ile gerçek tmp dizinlerde koşar.

/** Yolu karşılaştırılabilir tek biçime indir (realpath; çözülemezse normalize). */
function canonicalRoot(root) {
  const raw = typeof root === 'string' ? root.trim() : '';
  if (!raw) return null;
  try {
    return fs.realpathSync(raw);
  } catch {
    return path.resolve(raw);
  }
}

/** Kök diskte GERÇEKTEN bir dizin mi? (budama ölçütü) */
function rootExists(root) {
  try {
    return fs.statSync(root).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Kullanıcının bildiği çalışma alanları — KURAL 1 + KURAL 2 uygulanmış hâli.
 * @returns {string[]} kanonik, tekilleştirilmiş, diskte var olan kökler
 */
function knownWorkspaces() {
  const settings = agentSettings.readSettings();
  const recorded = Array.isArray(settings.knownWorkspaces) ? settings.knownWorkspaces : [];
  // PLAN-FIX-01 (F-3 / FIX-A) — AKTİF KÖK **ÇÖZÜLMÜŞ** KÖKTÜR, HAM AYAR DEĞİL.
  //
  // ÖLÇÜM (PLAN-GATE-R1 §6, canlı repro): burası `settings.workspaceRoot`'u okuyordu,
  // oysa app'in GERÇEKTEN çalıştığı kök `configuredWorkspaceRootStatus()` ile çözülür
  // (env → settings). `CREWPANE_WORKSPACE_ROOT=<A>` ile açılan bir Basic kurulumda
  // ayar boş olduğu için sayaç **0** diyordu; A klasöründe çalışılıyor olmasına rağmen
  // "hiç alanım yok" hükmü çıkıyor, `switchWorkspace(<C>)` de İKİNCİ alanı onaylıyordu
  // → tavan 1 iken 2 alan. Yani kaçak yalnız env'in kapısızlığı değil, SAYACIN KÖRLÜĞÜYDÜ.
  //
  // Sayım yolu, kararın kullandığı yolla AYNI kalır (`plan:get` de bunu okur): KURAL 1
  // ("aktif kök her zaman bilinir") ancak aktif kök doğru okunursa tutar. `root` null
  // ise (hiçbir kaynak kullanılabilir değil) davranış eskisiyle aynıdır.
  let resolvedActive = null;
  try {
    resolvedActive = agentSettings.configuredWorkspaceRootStatus().root;
  } catch {
    resolvedActive = settings.workspaceRoot; // sayım arızası ödeyeni kendi klasöründen etmez
  }
  const active = canonicalRoot(resolvedActive);
  const out = [];
  for (const entry of [...recorded, ...(active ? [active] : [])]) {
    const canon = canonicalRoot(entry);
    if (!canon || out.includes(canon)) continue;
    if (!rootExists(canon)) continue; // KURAL 2
    out.push(canon);
  }
  return out;
}

/** Bu kök kullanıcının ZATEN bildiği bir alan mı? (bilinen köke geçiş limite girmez) */
function isKnownWorkspace(root) {
  const canon = canonicalRoot(root);
  return !!canon && knownWorkspaces().includes(canon);
}

/**
 * Kökü deftere yaz (idempotent). Limit kararı ÇAĞIRANDA — bu fonksiyon yalnız
 * KAYIT tutar, izin vermez. Best-effort: yazım düşerse kullanıcı engellenmez
 * (defter bir kolaylıktır, kapı değil; aktif kök zaten KURAL 1 ile bilinir).
 */
function rememberWorkspace(root) {
  const canon = canonicalRoot(root);
  if (!canon) return { ok: false, reason: 'empty-root' };
  const settings = agentSettings.readSettings();
  const recorded = Array.isArray(settings.knownWorkspaces) ? settings.knownWorkspaces : [];
  const next = [];
  for (const entry of [...recorded, canon]) {
    const c = canonicalRoot(entry);
    if (c && !next.includes(c)) next.push(c);
  }
  if (next.length === recorded.length && recorded.every((r, i) => canonicalRoot(r) === next[i])) {
    return { ok: true, known: next, changed: false };
  }
  const res = agentSettings.applySettingsPatch({ knownWorkspaces: next });
  return { ok: true, known: next, changed: true, persisted: res.persisted !== false };
}

/**
 * (a) yolu: önerilen varsayılan klasörü OLUŞTUR (yoksa) ve settings'e yaz.
 * Var olan ~/CrewPane yeniden kullanılır (mkdir recursive idempotent) — ikinci
 * kurulum/yeniden onboarding aynı köke döner, veri silinmez/ezilmez.
 */
function provisionDefaultWorkspace({ homedir, forbiddenPrefix } = {}) {
  const dir = defaultWorkspaceDir(homedir);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (err) {
    return { ok: false, reason: 'mkdir-failed', detail: err.message };
  }
  return commitWorkspaceRoot(dir, { forbiddenPrefix });
}

// ── ADP-852 · ÇALIŞMA ALANI YOKKEN PANE'E BASILAN REHBER ─────────────────────
//
// Eskiden bu durum `spawnPty` içinde `throw` idi ve kullanıcıya YALNIZ alt barda
// ham `workspace_not_configured` dizesi olarak görünüyordu (İngilizce, teknik,
// eylemsiz) — pane bomboş siyah kalıyordu. Artık ADP-694'ün kalıbı: motor HİÇ
// başlatılmaz, yerine bu metni basıp canlı kalan bir tutucu açılır.
//
// Bu metin UI kaplamasının (WorkspaceMissingOverlay) YERİNE geçmez, ONUN
// YEDEĞİDİR: kaplama kapatılsa, pane pop-out edilse, ekran görüntüsü alınsa ya da
// mobil defterden okunsa bile kullanıcı ne olduğunu ve ne yapacağını görür.
//
// Ham pty akışı olduğu için satır sonu `\r\n` (yalnız `\n` merdiven yapar).
// Türkçe güvenli: buildSpawn her çocuk env'ine UTF-8 locale enjekte ediyor (ADP-310).

const ESC = '\x1b';
const bold = (s) => `${ESC}[1m${s}${ESC}[0m`;
const warn = (s) => `${ESC}[33m${s}${ESC}[0m`;
const cyan = (s) => `${ESC}[36m${s}${ESC}[0m`;
const dim = (s) => `${ESC}[2m${s}${ESC}[0m`;

/**
 * `opts.defaultDir` — önerilen varsayılan klasör (main `defaultWorkspaceDir()` verir).
 * Verilmezse satır atlanır; metin yine anlamlı kalır.
 */
function missingWorkspaceBanner({ defaultDir } = {}) {
  const lines = [
    '',
    warn('⚠  Çalışma alanı seçilmemiş'),
    '',
    'Ajanlar bir ' + bold('çalışma alanı') + ' klasörü olmadan başlatılamaz:',
    'projelerin, görev sonuçları ve ekip hafızası o klasörde yaşar.',
    dim('(Uygulamanın geri kalanı çalışmaya devam eder.)'),
    '',
    'Bu panelin üzerindeki ' + bold('“Çalışma Alanı Seç”') + ' düğmesine bas —',
    'klasörü seçtiğin anda ajan yeniden başlatılır (uygulamayı kapatman gerekmez).',
    '',
  ];
  if (defaultDir) {
    lines.push(dim('Önerilen klasör: ') + cyan(defaultDir), '');
  }
  lines.push(dim('Seçimini sonra Ayarlar → Çalışma Alanı\'ndan değiştirebilirsin.'), '');
  return lines.join('\r\n') + '\r\n';
}

module.exports = {
  DEFAULT_WORKSPACE_DIRNAME,
  defaultWorkspaceDir,
  firstRunRequired,
  commitWorkspaceRoot,
  provisionDefaultWorkspace,
  // BL-01 — çalışma alanı tavanının SAYIM tarafı (karar main.js'te planDenial ile).
  canonicalRoot,
  knownWorkspaces,
  isKnownWorkspace,
  rememberWorkspace,
  missingWorkspaceBanner, // ADP-852 — rehber pane'inin metni (kaplamanın yedeği)
};
