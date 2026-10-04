// SYNC-F1-4 (Blaster) — MEMORY.md TÜRETME: indeks artık YAZILMAZ, fact dosyalarından
//                       ÜRETİLİR. Tasarım: docs/design/SYNC-F1-TASARIM.md §3.3 · §3.4
//                       Kök gerekçe: SYNC-R1-jazz.md §1.2 · SYNC-F1-3-wheeljack.md §16.7
//
// ═══════════════════════════════════════════════════════════════════════════════
// NEDEN TÜRETME — ölçülmüş gerekçe (§3.3)
// ═══════════════════════════════════════════════════════════════════════════════
// 1.481 fact dosyası birbirine DEĞMEZ (her biri bir kez yazılır). Çarpışan TEK dosya
// `MEMORY.md`: her ajan her yazımda ona satır ekler, `shared/MEMORY.md` bugün 360 KB.
// Tek makinede bunun çözümü `appendFileSync`ti (agentMemory §ADP-874); İKİ makinede
// append yarışının çözümü YOKTUR — LWW her turda birinin pointer'ını sessizce siler.
// Bu yüzden indeks senkron kümesinin DIŞINDA (syncClasses EXCLUDE_RULES + DB CHECK)
// ve her cihazda kendi fact kümesinden yeniden üretilir.
//
// ═══════════════════════════════════════════════════════════════════════════════
// 🔴 TASARIM §3.4'TEN İKİ ÖLÇÜLMÜŞ SAPMA — "kaynak öncelik sırası" TERS ÇEVRİLDİ
// ═══════════════════════════════════════════════════════════════════════════════
// §3.4 şunu diyordu:
//     başlık = frontmatter.name        ?? mevcut indeksteki başlık ?? slug
//     kanca  = frontmatter.description ?? mevcut indeksteki kanca  ?? ilk satır
// Canlı ağaçta (1.481 fact / 30 kapsam) ölçüldü — ikisi de VERİ KAYBEDİYOR:
//
//   (a) `frontmatter.name` HER ZAMAN SLUG'DUR, insan başlığı değil. `composeFact`
//       bilerek `name: ${slug}` yazar. Ölçüm: 699 pointer'ın indeksteki başlığı
//       frontmatter.name'den FARKLI ("Ref: COV-ENGINE render doğrulama" ↔
//       "ref-cov-engine-render-verification"). §3.4 sırası bu 699 insan başlığını
//       slug'a çevirirdi — geri alınamaz bir okunabilirlik kaybı.
//
//   (b) `description` indeksteki kancadan KISADIR. Ölçüm: indeks kancaları toplam
//       733.046 B, karşılık gelen description'lar 344.430 B. §3.4 sırası indeksin
//       küratörlü metninin %53'ünü (≈389 KB) silerdi.
//
// KARAR: VAR OLAN POINTER SATIRI AYNEN KORUNUR. Türetme yalnız KÜMEYİ sahiplenir:
//   · fact'i olmayan pointer DÜŞER      (bugün 4 kırık pointer — bu bir DÜZELTME)
//   · pointer'ı olmayan fact EKLENİR    (bugün 37 görünmez hafıza — bu da düzeltme)
//   · aynı slug iki kez geçiyorsa ilki kalır (bugün 2 kopya)
// Var olan satırın METNİ hiç değişmez ⇒ gölge diff'i "37 ekle + 4 sil" ile sınırlı,
// yani geri dönüşü tek `git checkout` olan bir değişiklik.
//
// ═══════════════════════════════════════════════════════════════════════════════
// POINTER NEDİR — ve KORUNAN BÖLGE neden bu kadar geniş (§3.4 madde 4)
// ═══════════════════════════════════════════════════════════════════════════════
// Bir satır ancak şu üçü birden doğruysa pointer sayılır:
//   1) `- [Başlık](hedef.md) — kanca` biçiminde,
//   2) satırda TEK bir markdown bağı var,
//   3) hedef `/` ya da `\` İÇERMEZ (yani bu kapsamın kendi dosyası).
// Ölçülen gerçek biçimler bu üç kapının neden gerektiğini gösteriyor:
//   · `- (shared) [X](../../shared/y.md) — …`  → BAŞKA kapsamın dosyası (14 satır)
//   · `- [A](../a.md) + [B](../b.md) — …`      → çok-bağlı satır (39 satır)
//   · `- ADP-937 → shared: [[../../shared/z]]` → wiki-bağ, markdown bağı yok
//   · `- CE-07R (…) → sonuç docs/agent-results/…` → bağsız serbest not
//   · başlık, HTML yorumu, MEMORY.md'nin KENDİ frontmatter'ı (codex-i-abla), sarma satırı
// Hiçbiri bu kapsamın fact kümesinden ÜRETİLEMEZ; hepsi KORUNAN BÖLGEDİR ve satır
// sırasındaki yerinde AYNEN kalır.
//
// ⚠️ SAF ÇEKİRDEK + İNCE KABUK: `deriveIndexText` fs'e dokunmaz (node --test ile
//    disksiz sınanır); dosya okuma/yazma yalnız `deriveScope`/`deriveAll`ta.
//    `agentMemory`i REQUIRE ETMEZ — tersi olur (döngüsel bağımlılık yasağı).

'use strict';

const nodeFs = require('node:fs');
const nodePath = require('node:path');

const INDEX_FILE = 'MEMORY.md';

/**
 * Yeni üretilen kancanın tavanı. Var olan kancalara UYGULANMAZ (onlar korunur).
 *
 * 🔴 NEDEN 1000 VE NEDEN DAHA DÜŞÜK DEĞİL — ölçülmüş bir geri adım:
 * İlk değer 300'dü ("indeks spawn'da yalnız 25 KB'ı enjekte edilir, tek satır bütçeyi
 * yemesin"). `memoryTaskBlock`in mevcut testi bunu KIRMIZIYA çevirdi ve haklıydı:
 * D-07'de aday havuzu `readFullIndex` ile TAM indeksten okunur — 25 KB kesmesi yalnız
 * ENJEKSİYONA uygulanır, SEÇİME değil. Yani kancayı DOSYADA kırpmak, ilgili hafızanın
 * göreve göre seçilmesini sağlayan terimleri kalıcı olarak siler: bütçe sorununu
 * çözerken recall'ı bozardı. Bütçeyi zaten `agentMemory.capIndex` koruyor.
 * Tavan yine de var: ölçülen en uzun `description` 6.000+ karakter
 * (shared/concurrent-duplicate-spawn) ve tek satırın enjekte edilen indeksin
 * dörtte birini yemesi ayrı bir arızadır. 1000, canlı ağaçtaki en uzun ELLE yazılmış
 * kancanın (1.862 karakter) altında ama ortalamanın (507) iki katının üstünde.
 */
const NEW_HOOK_MAX = 1000;

/** Gövdeden kanca türetilirken alınan ilk anlamlı satırın tavanı (§3.4 madde 2). */
const FIRST_LINE_MAX = 120;

/**
 * İndeks hiç yoksa kullanılan başlık. BİRİNCİL yol bu DEĞİL:
 * `agentMemory.ensureMemoryScaffold` indeksi başlığıyla açar ve türetme onun
 * üstüne çalışır. Bu sabit yalnız bootstrap'ta (yeni cihaz, hiç indeks yok) devreye
 * girer — o an ortada `agentMemory` çağıran bir yol olmayabilir.
 */
const FALLBACK_HEADER = '# Memory Index\n';

/** Satırda kaç markdown bağı var? (`[[wiki]]` bağı SAYILMAZ: ardından `(` gelmez.) */
const RE_MD_LINK = /\[[^\]]*\]\([^)]*\)/g;

/** `- [Başlık](hedef.md) — kanca` — ayraç em-dash/en-dash/tire ya da hiç olabilir. */
const RE_POINTER = /^\s*-\s+\[([^\]]*)\]\(([^)]+)\)\s*(?:—|–|-)?[ \t]*(.*)$/;

// ─────────────────────────────────────────────────────────────────────────────
// SAF YARDIMCILAR
// ─────────────────────────────────────────────────────────────────────────────

/** Tek satıra indir + kırp. */
function oneLine(s) {
  return String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
}

/**
 * Fact frontmatter'ından ÜST SEVİYE anahtarları oku. Tam bir YAML ayrıştırıcısı
 * DEĞİL ve olmamalı: hafıza dosyalarının frontmatter'ı `composeFact`ın ürettiği
 * sabit biçimdir (`name`, `description`, `metadata:` altında girintili alanlar).
 * Girintili satırlar bilerek atlanır — `metadata.type` indekste kullanılmıyor.
 * Değer `"…"` ya da `'…'` ile sarılıysa açılır (ölçüldü: description alanında
 * `:` geçen kayıtlar bu biçimde yazılmış).
 */
function parseFrontmatter(text) {
  const s = String(text || '');
  if (!s.startsWith('---')) return null;
  const nl = s.indexOf('\n');
  if (nl < 0) return null;
  const end = s.indexOf('\n---', nl);
  if (end < 0) return null;
  const out = Object.create(null);
  for (const raw of s.slice(nl + 1, end).split('\n')) {
    const line = raw.replace(/\r$/, '');
    const m = /^([A-Za-z_][A-Za-z0-9_-]*):[ \t]*(.*)$/.exec(line);
    if (!m) continue; // girintili (metadata alt alanları) ya da boş satır
    out[m[1]] = unquote(m[2]);
  }
  return out;
}

function unquote(v) {
  const s = String(v == null ? '' : v).trim();
  if (s.length >= 2 && s[0] === '"' && s[s.length - 1] === '"') {
    try {
      return JSON.parse(s);
    } catch {
      return s.slice(1, -1);
    }
  }
  if (s.length >= 2 && s[0] === "'" && s[s.length - 1] === "'") return s.slice(1, -1).replace(/''/g, "'");
  return s;
}

/** Frontmatter'dan SONRAKİ ilk anlamlı satır (kanca son çaresi). */
function firstMeaningfulLine(text) {
  let s = String(text || '');
  if (s.startsWith('---')) {
    const nl = s.indexOf('\n');
    const end = nl < 0 ? -1 : s.indexOf('\n---', nl);
    if (end >= 0) {
      const after = s.indexOf('\n', end + 1);
      s = after < 0 ? '' : s.slice(after + 1);
    }
  }
  for (const raw of s.split('\n')) {
    const line = oneLine(raw.replace(/^#+\s*/, ''));
    if (line) return line.length > FIRST_LINE_MAX ? `${line.slice(0, FIRST_LINE_MAX - 1)}…` : line;
  }
  return '';
}

/**
 * Bir indeks satırını pointer olarak çöz — ya da `null`.
 * `null` dönmesi "bu satır KORUNAN BÖLGEDİR" demektir (yukarıdaki üç kapı).
 * @returns {{slug:string, target:string, title:string, hook:string}|null}
 */
function parsePointerLine(line) {
  const s = String(line == null ? '' : line).replace(/\r$/, '');
  const m = RE_POINTER.exec(s);
  if (!m) return null;
  const links = s.match(RE_MD_LINK);
  if (!links || links.length !== 1) return null; // çok-bağlı satır: üretilemez, korunur
  const target = m[2].trim();
  if (target.includes('/') || target.includes('\\')) return null; // başka kapsamın dosyası
  if (!/\.md$/i.test(target)) return null;
  return { slug: target.replace(/\.md$/i, ''), target, title: m[1].trim(), hook: m[3].trim() };
}

/** Yeni bir pointer satırı kur (yalnız indekste HİÇ olmayan fact'ler için). */
function buildPointerLine(fact, opts = {}) {
  const hookMax = Number.isFinite(opts.hookMaxChars) ? opts.hookMaxChars : NEW_HOOK_MAX;
  const slug = fact.slug;
  const title = oneLine(fact.title) || oneLine(fact.name) || slug;
  let hook = oneLine(fact.hook) || oneLine(fact.description) || oneLine(fact.firstLine) || '';
  // Tavanın gerekçesi ve neden 300 DEĞİL 1000 olduğu: NEW_HOOK_MAX yorumunda.
  if (hook.length > hookMax) hook = `${hook.slice(0, hookMax - 1)}…`;
  return hook ? `- [${title}](${slug}.md) — ${hook}` : `- [${title}](${slug}.md)`;
}

// ─────────────────────────────────────────────────────────────────────────────
// SAF ÇEKİRDEK
// ─────────────────────────────────────────────────────────────────────────────

/**
 * İndeks metnini fact kümesinden TÜRET. fs YOK, yan etki YOK, deterministik.
 *
 * @param {{currentText?:string,
 *          facts:Array<{slug:string,name?:string,description?:string,firstLine?:string,
 *                       title?:string,hook?:string}>,
 *          hookMaxChars?:number}} input
 * @returns {{text:string, changed:boolean, added:string[], removed:string[],
 *            deduped:string[], kept:number, preserved:number}}
 */
function deriveIndexText(input = {}) {
  const currentText = typeof input.currentText === 'string' ? input.currentText : '';
  const facts = Array.isArray(input.facts) ? input.facts : [];
  const bySlug = new Map();
  for (const f of facts) if (f && typeof f.slug === 'string' && f.slug) bySlug.set(f.slug, f);

  // EOL sözleşmesi: dosyanın KENDİ ayracı korunur (Windows'ta CRLF indeks, tek
  // satır ekledi diye LF'e dönerse `git diff` dosyanın tamamını değişmiş gösterir).
  const eol = currentText.includes('\r\n') ? '\r\n' : '\n';
  const body = currentText.replace(/(\r?\n)+$/, '');
  const lines = body.length ? body.split(/\r?\n/) : [];

  const out = [];
  const seen = new Set();
  const removed = [];
  const deduped = [];
  let preserved = 0;
  let kept = 0;

  for (const line of lines) {
    const p = parsePointerLine(line);
    if (!p) {
      out.push(line.replace(/\r$/, ''));
      preserved += 1;
      continue;
    }
    if (!bySlug.has(p.slug)) {
      removed.push(p.slug); // KIRIK pointer: işaret ettiği fact yok → düşer
      continue;
    }
    if (seen.has(p.slug)) {
      deduped.push(p.slug); // aynı slug ikinci kez: ilki kalır
      continue;
    }
    seen.add(p.slug);
    out.push(line.replace(/\r$/, '')); // 🔴 METİN AYNEN KORUNUR (yukarıdaki (a)/(b))
    kept += 1;
  }

  // Yeni fact'ler SONA, slug'a göre alfabetik (§3.4 madde 3): var olan sıra bozulmaz,
  // ama sıralama deterministiktir — aynı fact kümesi iki cihazda aynı kuyruğu verir.
  const added = [...bySlug.keys()].filter((s) => !seen.has(s)).sort();
  if (added.length) {
    if (out.length && out[out.length - 1].trim() !== '') out.push('');
    for (const slug of added) out.push(buildPointerLine(bySlug.get(slug), { hookMaxChars: input.hookMaxChars }));
  }

  const text = out.length ? out.join(eol) + eol : '';
  return { text, changed: text !== currentText, added, removed, deduped, kept, preserved };
}

// ─────────────────────────────────────────────────────────────────────────────
// KABUK — fs
// ─────────────────────────────────────────────────────────────────────────────

/** Bir kapsam dizinindeki fact dosyalarını oku (MEMORY.md HARİÇ, gizli/tmp HARİÇ). */
function listFacts(dir, deps = {}) {
  const fs = deps.fs || nodeFs;
  const path = deps.path || nodePath;
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return null; // kapsam kökü yok → çağıran "silme" diye okumamalı (syncEngine §1.4 dersi)
  }
  const facts = [];
  for (const name of names.slice().sort()) {
    if (!/\.md$/i.test(name)) continue;
    if (name === INDEX_FILE) continue;
    if (name.startsWith('.') || name.startsWith('~$')) continue;
    let text = '';
    try {
      text = fs.readFileSync(path.join(dir, name), 'utf8');
    } catch {
      continue; // okunamayan fact için pointer ÜRETME (yarım gerçek, hiç gerçekten kötü)
    }
    const fm = parseFrontmatter(text) || {};
    facts.push({
      slug: name.replace(/\.md$/i, ''),
      name: fm.name || '',
      description: fm.description || '',
      firstLine: firstMeaningfulLine(text),
    });
  }
  return facts;
}

/**
 * TEK kapsamın indeksini türet.
 *
 * `write` VARSAYILAN OLARAK KAPALI (gölge fazı, §3.4): türetme koşar, fark ölçülür,
 * disk DEĞİŞMEZ. Yazma ancak çağıran açıkça `write:true` derse olur.
 *
 * @param {string} dir kapsam dizini
 * @param {{write?:boolean, fs?:object, path?:object, writeAtomic?:Function,
 *          titleHints?:object, hookHints?:object, hookMaxChars?:number}} opts
 */
function deriveScope(dir, opts = {}) {
  const fs = opts.fs || nodeFs;
  const path = opts.path || nodePath;
  const facts = listFacts(dir, opts);
  if (facts === null) return { ok: false, reason: 'no_dir', dir, changed: false };

  // Çağıranın bildiği başlık/kanca (addIndexPointer yolu): frontmatter'da yalnız
  // slug var, insan başlığı ÇAĞIRANDA. Yalnız YENİ satırlar için kullanılır.
  const titleHints = opts.titleHints || {};
  const hookHints = opts.hookHints || {};
  for (const f of facts) {
    if (titleHints[f.slug]) f.title = titleHints[f.slug];
    if (hookHints[f.slug]) f.hook = hookHints[f.slug];
  }

  const idxPath = path.join(dir, INDEX_FILE);
  let currentText = '';
  let existed = true;
  try {
    currentText = fs.readFileSync(idxPath, 'utf8');
  } catch {
    existed = false;
    currentText = facts.length ? FALLBACK_HEADER : '';
  }

  const res = deriveIndexText({ currentText, facts, hookMaxChars: opts.hookMaxChars });
  const out = {
    ok: true,
    dir,
    indexPath: idxPath,
    existed,
    facts: facts.length,
    ...res,
    wrote: false,
  };
  if (!opts.write || !res.changed) return out;

  const writeAtomic = typeof opts.writeAtomic === 'function' ? opts.writeAtomic : defaultWriteAtomic;
  writeAtomic(idxPath, res.text, { encoding: 'utf8' });
  out.wrote = true;
  return out;
}

/** Varsayılan yazıcı: `atomicWrite` (yarım indeks, olmayan indeksten kötüdür). */
function defaultWriteAtomic(file, text, o) {
  const { atomicWriteFileSync } = require('../../platform/atomicWrite.cjs');
  atomicWriteFileSync(file, text, o);
}

/**
 * Türetilebilir KAPSAMLARI say. 🔴 Bu liste bir kolaylık değil, bir NÖBET:
 * `<workspaceRoot>/.crewpane/memory` KÖKÜ bir kapsam DEĞİLDİR (içinde tek bir
 * fact yok, yalnız `agents/` ve `shared/` var). Kök yanlışlıkla kapsam sayılsaydı
 * türetme orada "0 fact" görüp indeksini boşaltırdı — bu yüzden kapsamlar
 * SAYILIR, tahmin edilmez.
 *
 * @param {{workspaceRoot?:string, accountRoot?:string}} roots
 * @returns {Array<{id:string, scope:'agent'|'shared'|'global', dir:string}>}
 */
function listScopes(roots = {}, deps = {}) {
  const fs = deps.fs || nodeFs;
  const path = deps.path || nodePath;
  const out = [];
  if (roots.workspaceRoot) {
    const memRoot = path.join(roots.workspaceRoot, '.crewpane', 'memory');
    const agentsRoot = path.join(memRoot, 'agents');
    let ids = [];
    try {
      ids = fs.readdirSync(agentsRoot).sort();
    } catch {
      ids = [];
    }
    for (const id of ids) {
      if (id.startsWith('.')) continue;
      const dir = path.join(agentsRoot, id);
      try {
        if (!fs.statSync(dir).isDirectory()) continue;
      } catch {
        continue;
      }
      out.push({ id: `agents/${id}`, scope: 'agent', dir });
    }
    const shared = path.join(memRoot, 'shared');
    try {
      if (fs.statSync(shared).isDirectory()) out.push({ id: 'shared', scope: 'shared', dir: shared });
    } catch {
      /* shared henüz açılmamış */
    }
  }
  if (roots.accountRoot) {
    const g = path.join(roots.accountRoot, 'memory');
    try {
      if (fs.statSync(g).isDirectory()) out.push({ id: 'global', scope: 'global', dir: g });
    } catch {
      /* global hafıza henüz yok */
    }
  }
  return out;
}

/**
 * TÜM kapsamları türet (gölge fazı ölçümünün ve bootstrap'ın tek girişi).
 * `write` yine varsayılan KAPALI.
 */
function deriveAll(roots = {}, opts = {}) {
  const scopes = listScopes(roots, opts);
  const results = [];
  const totals = { scopes: 0, facts: 0, added: 0, removed: 0, deduped: 0, kept: 0, preserved: 0, changed: 0, wrote: 0 };
  for (const s of scopes) {
    const r = deriveScope(s.dir, opts);
    if (!r.ok) continue;
    results.push({ ...s, ...r });
    totals.scopes += 1;
    totals.facts += r.facts;
    totals.added += r.added.length;
    totals.removed += r.removed.length;
    totals.deduped += r.deduped.length;
    totals.kept += r.kept;
    totals.preserved += r.preserved;
    if (r.changed) totals.changed += 1;
    if (r.wrote) totals.wrote += 1;
  }
  return { totals, results };
}

/**
 * `syncEngine`in `deriveIndexes` DI kancası (SYNC-F1-3 §16.7'nin bıraktığı yüzey).
 *
 * Motor pull sonunda `deriveIndexes([...touchedDirs])`, bootstrap sonunda
 * `deriveIndexes(null)` çağırır. `touchedDirs` `rel_path`in DİZİN parçasıdır
 * (`memory/agents/jazz`) — SINIF BİLGİSİ TAŞIMAZ, yani `memory/…` hem workspace
 * hem hesap kapsamına ait olabilir. Bu yüzden eşleme YOLDAN DEĞİL KAPSAM
 * LİSTESİNDEN yapılır: dokunulan dizin, sayılmış bir kapsamın son parçalarıyla
 * eşleşiyorsa o kapsam türetilir; eşleşmiyorsa HİÇBİR ŞEY yapılmaz (bilinmeyen
 * bir dizinde indeks üretmek, o dizinin indeksini boşaltmak demektir).
 */
function createDeriveIndexesHook(cfg = {}) {
  const path = cfg.path || nodePath;
  const log = typeof cfg.log === 'function' ? cfg.log : () => {};
  return function deriveIndexes(touched) {
    const roots = typeof cfg.roots === 'function' ? cfg.roots() : cfg.roots || {};
    const opts = { ...cfg, write: cfg.write === true };
    const scopes = listScopes(roots, opts);
    let targets = scopes;
    if (Array.isArray(touched) && touched.length) {
      const want = new Set(touched.map((t) => String(t).replace(/\\/g, '/').replace(/\/+$/, '')));
      targets = scopes.filter((s) => {
        const norm = s.dir.replace(/\\/g, '/');
        for (const w of want) if (w && norm.endsWith(`/${w}`)) return true;
        return false;
      });
    }
    const results = [];
    for (const s of targets) {
      try {
        const r = deriveScope(s.dir, opts);
        if (r.ok) results.push({ id: s.id, added: r.added.length, removed: r.removed.length, wrote: r.wrote });
      } catch (err) {
        log(`[memory] indeks türetimi başarısız (${s.id}): ${err.message}`);
      }
    }
    return results;
  };
}

module.exports = {
  INDEX_FILE,
  NEW_HOOK_MAX,
  FIRST_LINE_MAX,
  FALLBACK_HEADER,
  parseFrontmatter,
  firstMeaningfulLine,
  parsePointerLine,
  buildPointerLine,
  deriveIndexText,
  listFacts,
  deriveScope,
  listScopes,
  deriveAll,
  createDeriveIndexesHook,
};
