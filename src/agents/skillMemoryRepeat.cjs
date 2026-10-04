// CrewPane — SK-07 (ADR-SKILL-CENTER §6.1 T-C) HAFIZADAN → SKILL TASLAĞI.
//
// Memory = "ne öğrendim" (olgu). Skill = "nasıl yaparım" (yordam). Bu modül ikisi
// arasındaki TEK köprüdür: bir ajanın kalıcı hafızasında AYNI YORDAMA tekrar tekrar
// dönüldüğünü ÖLÇER ve o yordamı bir skill ADAYI olarak öne sürer.
//
// ⛔ YAYIN YAPMAZ — SK-06'nın yazma ucunu (`skillSuggest.suggestDraft`) çağırır, o da
// yalnız `.crewpane/skill-drafts/` altına yazar. Yeni bir kanal AÇILMADI: taslak
// yolu, provenans zorunlulukları ve lint aynen SK-06'nınki. Bu modülün eklediği tek
// şey TETİĞİN KAYNAĞIdır (`T-C` = ölçülen tekrar) ve kanıtın kendisi.
//
// ── NEDEN "ATIF SAYISI" TEK BAŞINA YETMEZ (bu tasarımın kalbi) ────────────────────
// Bu külliyat olgun bir hafıza grafiği: 975 fakt dosyasının 934'ü en az bir [[bağ]]
// içeriyor. "Çok atıf alan" ölçütü tek başına 217 aday üretiyordu (ölçüldü) — yani
// külliyatın beşte biri. Gürültülü bir öneri kuyruğu insan onayını "hepsini onayla"
// refleksine çevirir; ADR §6.1'in T-C'yi SK-08'e ertelemesinin sebebi tam olarak bu.
//
// Bu yüzden "tekrar" sinyali ÇIKARSAMA ile değil, ajanın KENDİ KAYDINDAN okunuyor:
// bir yordama yeni bir görevde geri dönüp sürümü artırmak (`version: 17`) ve o
// görevlerin kodlarını dosyaya yazmak (`v12 (ADP-295) … v15 (ADP-363) …`) zaten
// bugünkü hafıza disiplininin parçası. Yani tekrar TAHMİN EDİLMİYOR, okunuyor.
//
// fs kullanır ama Electron'a bağımlı DEĞİL (unit testler tmp dizinlerle koşar).

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const agentMemory = require('../memory/agentMemory.cjs');
const skillStore = require('./skillStore.cjs');
const skillSuggest = require('./skillSuggest.cjs');

const TRIGGER = 'T-C'; // ADR §6.1 — "ölçülen tekrar"
const INDEX_FILE = agentMemory.INDEX_FILE; // MEMORY.md — indeks, fakt değil

/**
 * EŞİKLER — hepsi AYNI ANDA sağlanmalı (VE). Gerçek külliyatta ölçülerek seçildi;
 * `docs/agent-results/SK-07-inferno.md` duyarlılık tablosunu taşır.
 *
 * 🔑 Eşik "hangi hafıza iyidir"i değil "hangi hafıza TEKRAR EDEN BİR YORDAMDIR"ı
 * sorar. Dördü de aynı iddianın farklı yüzü:
 *   minVersion   — ajan bu dosyaya geri DÖNDÜ (sürüm sayacı arttı)
 *   minTasks     — dönüşler FARKLI görevlerdeydi (dosyanın kendi metnindeki kodlar)
 *   minCitations — başka faktlar bu yordama DAYANIYOR (yalıtılmış bir not değil)
 *   güçlü işaret — metin kendini YORDAM ilan ediyor ("How to apply" / "Kural:" / reçete)
 */
// ── SK-08 (d) — YANLIŞ-POZİTİF ORANI ÖLÇÜLDÜ (ADR §6.1'in şartı) ─────────────
// Gerçek hafıza taraması (7 ajan × kendi+paylaşımlı kapsam, 3.070 fakt):
//   eşiği geçen aday 148 → AYRIK 30 (kalanı aynı paylaşımlı faktın tekrarı)
//   ayrık 30'un 7'si (%23,3) TEK ADIMLI: "yordam" değil, bir kural/gotcha cümlesi.
// Tek adımlı bir skill, motorun bağlamını işgal eder ama uygulanacak bir yordam
// taşımaz — T2'nin (açıklama işgali) ucuz akrabası. Bu yüzden eşik 1→2 çekildi;
// ölçüm raporda (docs/agent-results/SK-08-inferno.md §2.6) tabloyla duruyor.
const DEFAULT_THRESHOLDS = Object.freeze({
  minVersion: 3,
  minTasks: 3,
  minCitations: 3,
  minSteps: 2,
});

/** Bir koşuda önerilecek EN FAZLA taslak. Kuyruğu insan ölçeğinde tutar. */
const DEFAULT_MAX_SUGGESTIONS = 3;

/** Tek adımın karakter tavanı — aşan adım DÜŞMEZ, görünür biçimde kırpılır. */
const STEP_MAX_CHARS = 600;

// Board görev kodu — DAR ve kasıtlı. Geniş bir desen (`\b[A-Z]{2,}-?\d+`) sürüm
// numaralarını, tarihleri ve rastgele kimlikleri de yakalayıp "33 görev" gibi
// anlamsız sayılar üretiyordu (ölçüldü: kalibrasyon-1).
const TASK_CODE_RE = /\b(?:ADP|SK|CF|AS|LX|REL|WP|AV|NF|PROMOTE)-\d{1,4}\b/g;

// GÜÇLÜ yordam işaretleri: metin kendini bir yordam olarak İLAN ediyor.
// (Numaralı liste BİLEREK yok — her belgede bulunur, yordam kanıtı değildir.)
const PROCEDURE_MARKERS = Object.freeze([
  /^\s*\*{0,2}How to apply/im,
  /^\s*\*{0,2}Kural:?\*{0,2}/im,
  /reçete/i,
  /^\s*#{2,}\s*(Nasıl|Adım|Yöntem|Reçete|Uygula)/im,
]);

function oneLine(s) {
  return String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
}

/** Frontmatter + gövde ayır; `version` iki şemayı da kabul eder (üst düzey / metadata altı). */
function parseFact(text) {
  const raw = typeof text === 'string' ? text : '';
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(raw);
  const fm = m ? m[1] : '';
  const body = m ? raw.slice(m[0].length) : raw;
  const pick = (key) => {
    const hit = new RegExp(`^\\s*${key}:\\s*"?([^"\\n]+)"?\\s*$`, 'im').exec(fm);
    return hit ? hit[1].trim() : '';
  };
  const ver = parseInt(pick('version'), 10);
  return {
    name: pick('name'),
    description: pick('description'),
    type: pick('type'),
    version: Number.isFinite(ver) && ver > 0 ? ver : 1,
    body,
    text: raw,
  };
}

/** Bir hafıza dizinindeki fakt dosyaları (MEMORY.md indeksi HARİÇ — o bir fakt değil). */
function listFactFiles(dir) {
  let ents = [];
  try {
    ents = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return ents
    .filter((e) => e.isFile() && e.name.endsWith('.md') && e.name !== INDEX_FILE)
    .map((e) => path.join(dir, e.name))
    .sort();
}

/**
 * Taranacak hafıza kapsamları. `agent` verilirse YALNIZ o ajan + shared taranır
 * (bir ajan başka bir ajanın hafızasından kendine skill öneremez — provenans karışır).
 */
function memoryScopes(workspaceRoot, agent) {
  const root = agentMemory.workspaceMemoryRoot(workspaceRoot);
  if (!root) return [];
  const out = [];
  const agentsRoot = path.join(root, 'agents');
  const wanted = oneLine(agent) ? [agentMemory.safeSlug(agent)] : null;
  let dirs = [];
  try {
    dirs = fs
      .readdirSync(agentsRoot, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch {
    dirs = [];
  }
  for (const id of dirs) {
    if (wanted && !wanted.includes(id)) continue;
    out.push({ scope: `agent:${id}`, dir: path.join(agentsRoot, id) });
  }
  const shared = agentMemory.sharedMemoryDir(workspaceRoot);
  if (shared) out.push({ scope: 'shared', dir: shared });
  return out;
}

/**
 * Bir metin bloğunu madde madde böl — SARAN SATIRLARI aynı maddeye katarak.
 *
 * 🪤 Gerçek hafıza maddeleri 100 karakterde sarılıyor. "Her satır bir madde" varsayan
 * ilk sürüm adımları CÜMLE ORTASINDA kesiyordu ("…(`git status` → başka ajanın
 * commit'lenmemiş"), yani yarım bir yordam üretiyordu. Yarım yordam YANLIŞ yordamdır:
 * bir skill hatırlatmaz, YAPTIRIR. Madde, bir sonraki madde imine / boş satıra /
 * başlığa kadar sürer.
 */
function splitListItems(section, { numberedOnly = false } = {}) {
  const isBullet = (l) => (numberedOnly ? /^\s*\d+[.)]\s+\S/.test(l) : /^\s*(?:[-*•]|\d+[.)])\s+\S/.test(l));
  const items = [];
  let cur = null;
  for (const line of String(section || '').split('\n')) {
    if (isBullet(line)) {
      if (cur) items.push(cur);
      cur = line.trim();
    } else if (cur !== null) {
      // Sarma satırı: boş satır ya da başlık maddeyi BİTİRİR; girintili devam katılır.
      if (!line.trim() || /^\s*#{1,6}\s+\S/.test(line) || /^\S/.test(line)) {
        items.push(cur);
        cur = null;
      } else {
        cur += ` ${line.trim()}`;
      }
    }
  }
  if (cur) items.push(cur);
  return items;
}

/**
 * "How to apply" / "Kural:" bölümünden ADIMLARI çıkar.
 *
 * 🔑 Adım çıkaramıyorsak ADAY DEĞİLDİR: bir skill "hatırlatmaz, YAPTIRIR" (ADR T5).
 * Adımsız bir metin bir olgudur (memory), yordam değil — bu, eşiğin beşinci ve en
 * sert ayağıdır ve mimari HARİTALARI (bkz. `notification-stack-map`) eler.
 */
function extractSteps(body, { max = 8 } = {}) {
  const text = String(body || '');
  const out = [];
  const push = (s) => {
    let v = oneLine(s).replace(/^[-*•]\s*/, '').replace(/^\d+[.)]\s*/, '');
    if (v.length < 12) return; // başlık kırıntısı — adım değil
    // Uzun maddeyi DÜŞÜRME, kırp: sessizce düşen bir adım, eksik bir yordam demektir
    // (ve eksikliği kimse fark etmez). Kırpma görünür (…) ve kaynak hafızada tamamı var.
    if (v.length > STEP_MAX_CHARS) {
      const cut = v.slice(0, STEP_MAX_CHARS);
      const sp = cut.lastIndexOf(' ');
      v = `${(sp > STEP_MAX_CHARS * 0.6 ? cut.slice(0, sp) : cut).trimEnd()}…`;
    }
    if (out.length < max && !out.includes(v)) out.push(v);
  };

  // 1) "How to apply" / "Nasıl" / "Adım" bölümünün madde imleri — en güvenilir kaynak.
  //
  // 🪤 Başlık süslemesi SERBEST sıradadır: gerçek külliyattaki yaygın biçim
  // `**How to apply:**` — yani iki nokta yıldızların İÇİNDE. `\*{0,2}:?` yazmak
  // (yıldız SONRA iki nokta) tam da bu biçimi kaçırıyordu ve adım listesi BOŞ
  // dönüyordu. Sondaki süsleme kümesini sırasız kabul et.
  const secRe = /^\s*(?:\*{0,2}How to apply[:*\s]*|#{2,}\s*(?:Nasıl|Adım(?:lar)?|Yöntem|Reçete|Uygulama?)[:*\s]*)$/im;
  const hit = secRe.exec(text);
  if (hit) {
    const after = text.slice(hit.index + hit[0].length);
    // Bir sonraki başlığa kadar
    const stop = /^\s*#{1,6}\s+\S/m.exec(after);
    const section = stop ? after.slice(0, stop.index) : after;
    for (const item of splitListItems(section)) push(item);
  }

  // 2) Yetmezse gövdedeki numaralı listeyi dene.
  if (out.length < 1) {
    for (const item of splitListItems(text, { numberedOnly: true })) push(item);
  }

  // 3) Hâlâ yoksa "**Kural:**" cümlesi tek adımlık bir yordamdır.
  if (out.length < 1) {
    const rule = /^\s*\*{0,2}Kural:?\*{0,2}\s*(.+)$/im.exec(text);
    if (rule) push(rule[1]);
  }
  return out;
}

/** Gövde bir yordam olduğunu ilan ediyor mu? (kaç güçlü işaret) */
function procedureMarkerCount(body) {
  return PROCEDURE_MARKERS.filter((re) => re.test(String(body || ''))).length;
}

/**
 * HAFIZADA TEKRAR EDEN YORDAMLARI TARA.
 *
 * @returns {{ok:boolean, scanned:number, thresholds:object, candidates:Array, errors:Array}}
 * `candidates` puana göre AZALAN sırada; eşit puanda slug'a göre (deterministik —
 * testler ve "aynı koşu aynı sırayı verir" için).
 */
function scanRepeats(workspaceRoot, { agent, thresholds } = {}) {
  if (!agentMemory.workspaceMemoryRoot(workspaceRoot)) {
    return {
      ok: false,
      scanned: 0,
      thresholds: { ...DEFAULT_THRESHOLDS },
      candidates: [],
      errors: [{ code: 'no-workspace', message: 'workspaceRoot yok/geçersiz — hafıza nerede aranacak bilinmiyor' }],
    };
  }
  const th = { ...DEFAULT_THRESHOLDS, ...(thresholds && typeof thresholds === 'object' ? thresholds : {}) };

  // — Tara: tüm kapsamlardaki fakt dosyalarını oku
  const facts = [];
  for (const { scope, dir } of memoryScopes(workspaceRoot, agent)) {
    for (const file of listFactFiles(dir)) {
      let text = '';
      try {
        text = fs.readFileSync(file, 'utf8');
      } catch {
        continue; // okunamayan dosya sessizce atlanır (yarım hafıza ≠ hata)
      }
      const slug = path.basename(file, '.md');
      facts.push({ slug, scope, file, ...parseFact(text) });
    }
  }

  // — Atıf indeksi: slug → ATIF YAPAN farklı dosyalar. Bir dosyanın aynı bağı 5 kez
  //   yazması 1 sayılır (yoksa tek bir uzun not sinyali şişirirdi).
  const citedBy = new Map();
  for (const f of facts) {
    const seen = new Set();
    for (const m of f.text.matchAll(/\[\[([^\]]+)\]\]/g)) {
      const target = path.basename(oneLine(m[1])); // `../../shared/foo` → `foo`
      if (!target || seen.has(target)) continue;
      seen.add(target);
      if (!citedBy.has(target)) citedBy.set(target, new Set());
      citedBy.get(target).add(f.file);
    }
  }

  const candidates = [];
  for (const f of facts) {
    const citing = new Set(citedBy.get(f.slug) || []);
    citing.delete(f.file); // kendine atıf sayılmaz
    const tasks = [...new Set((f.text.match(TASK_CODE_RE) || []).map((s) => s.toUpperCase()))].sort();
    const markers = procedureMarkerCount(f.body);
    const steps = extractSteps(f.body);

    const meets =
      f.version >= th.minVersion &&
      tasks.length >= th.minTasks &&
      citing.size >= th.minCitations &&
      markers >= 1 &&
      steps.length >= th.minSteps;
    if (!meets) continue;

    candidates.push({
      slug: f.slug,
      scope: f.scope,
      file: f.file,
      description: f.description,
      version: f.version,
      citations: citing.size,
      citingFiles: [...citing].sort(),
      tasks,
      markers,
      steps,
      // Puan: sürüm en ağır sinyal (geri dönüş = yordamın canlılığı), sonra görev
      // çeşitliliği, sonra dayanılırlık. Sıralama İÇİN — eşik değil.
      score: f.version * 3 + tasks.length * 2 + citing.size,
    });
  }

  candidates.sort((a, b) => b.score - a.score || a.slug.localeCompare(b.slug));
  return { ok: true, scanned: facts.length, thresholds: th, candidates, errors: [] };
}

/** Aday → SKILL.md açıklaması (≤1024, motor skilli BUNA bakarak seçer). */
function composeDescription(c) {
  const base = oneLine(c.description) || `Hafızada ${c.version} kez güncellenen tekrar eden yordam: ${c.slug}`;
  const suffix = ` Kullan: bu yordam ${c.tasks.slice(0, 4).join(', ')} görevlerinde tekrarlandı.`;
  const room = 1024 - suffix.length;
  return (base.length > room ? `${base.slice(0, room - 1).trimEnd()}…` : base) + suffix;
}

/**
 * Aday → öneri gövdesi. SK-06'nın `composeSuggestionBody` şablonunu KULLANIR (yeni
 * şablon yazılmadı) ve "## Kaynak" bölümüne KAYNAK HAFIZA DOSYALARINI ekler:
 * insan onaylarken önerinin nereden türediğini dosya dosya görebilmeli.
 */
function composeBody(c, { sourceTask, agent } = {}) {
  const base = skillSuggest.composeSuggestionBody({
    title: c.slug,
    whenToUse:
      oneLine(c.description) ||
      `Bu yordam ${c.slug} hafızasında kayıtlı; aynı durum tekrar ettiğinde uygulanır.`,
    steps: c.steps,
    rationale: `Bu yordama ${c.tasks.length} farklı görevde geri dönüldü (hafıza sürümü v${c.version}, ${c.citations} fakt buna dayanıyor).`,
    sourceTask,
    sourceTaskTitle: 'hafızadan tekrar tespiti (T-C)',
    evidence:
      `Ölçüm — hafıza sürümü: **v${c.version}** · geri dönülen görevler: **${c.tasks.length}** ` +
      `(${c.tasks.join(', ')}) · bu yordama dayanan fakt sayısı: **${c.citations}** · ` +
      `yordam işareti: **${c.markers}**.`,
  });
  const lines = [
    base.trimEnd(),
    '',
    '### Kaynak hafıza dosyaları',
    '',
    `Bu öneri **${agent || 'ajan'}** hafızasındaki şu faktten türetildi:`,
    '',
    `- \`${c.scope}\` → **${c.slug}** (v${c.version}) — birincil kaynak`,
  ];
  for (const f of c.citingFiles.slice(0, 8)) {
    lines.push(`- dayanan fakt: \`${path.basename(f, '.md')}\``);
  }
  if (c.citingFiles.length > 8) lines.push(`- …ve ${c.citingFiles.length - 8} fakt daha`);
  lines.push('', '> Kaynak hafıza dosyalarına DOKUNULMADI (ADR §6.2): terfi kopyalar, taşımaz.', '');
  return lines.join('\n');
}

/**
 * TARA → ilk N ADAYI TASLAK OLARAK ÖNER.
 *
 * Yayın YOK: her yazım `skillSuggest.suggestDraft` üzerinden `skill-drafts/`e iner ve
 * `pendingApproval: true` döner. Zaten taslağı/yayını olan aday ATLANIR (sessizce
 * üzerine yazmak, incelenmemiş bir öneriyi incelenmiş olanın yerine koyardı).
 *
 * 🔑 SESSİZ KIRPMA YOK: `total` kaç aday bulunduğunu, `suggested`/`skipped` ne
 * olduğunu söyler — çağıran "hepsi bu kadar" sanmasın.
 */
function proposeFromMemory(workspaceRoot, { agent, sourceTask, max, thresholds, now } = {}) {
  const scan = scanRepeats(workspaceRoot, { agent, thresholds });
  if (!scan.ok) return { ok: false, total: 0, suggested: [], skipped: [], errors: scan.errors, scanned: 0 };

  const who = oneLine(agent);
  if (!who) {
    return {
      ok: false,
      total: scan.candidates.length,
      suggested: [],
      skipped: [],
      scanned: scan.scanned,
      errors: [{ code: 'agent-missing', message: 'ÖNEREN ajan zorunlu (provenans damgası)' }],
    };
  }
  const task = oneLine(sourceTask);
  if (!task) {
    return {
      ok: false,
      total: scan.candidates.length,
      suggested: [],
      skipped: [],
      scanned: scan.scanned,
      errors: [{ code: 'source-task-missing', message: 'Kaynak görev zorunlu — bu tarama HANGİ görevde koştu?' }],
    };
  }

  const limit = Number.isFinite(max) && max > 0 ? Math.floor(max) : DEFAULT_MAX_SUGGESTIONS;
  const suggested = [];
  const skipped = [];

  for (const c of scan.candidates) {
    if (suggested.length >= limit) break;
    // Zaten var mı? (taslak ya da yayın) — SK-06 de reddederdi, ama burada ERKEN
    // eleyip kotayı gerçekten YENİ adaylara ayırıyoruz.
    if (skillStore.readSkill(workspaceRoot, c.slug, 'draft')) {
      skipped.push({ slug: c.slug, reason: 'draft-exists' });
      continue;
    }
    if (skillStore.readSkill(workspaceRoot, c.slug, 'published')) {
      skipped.push({ slug: c.slug, reason: 'already-published' });
      continue;
    }

    const res = skillSuggest.suggestDraft({
      workspaceRoot,
      name: c.slug,
      description: composeDescription(c),
      agent: who,
      trigger: TRIGGER,
      sourceTask: task,
      sourceTaskTitle: 'hafızadan tekrar tespiti (T-C)',
      rationale: `Aynı yordama ${c.tasks.length} farklı görevde geri dönüldü (v${c.version}, ${c.citations} fakt dayanıyor)`,
      sourceMemory: `${c.scope}/${c.slug}`,
      body: composeBody(c, { sourceTask: task, agent: who }),
      now,
    });
    if (res.ok) suggested.push({ ...c, file: res.file, name: res.name, pendingApproval: true });
    else skipped.push({ slug: c.slug, reason: (res.errors[0] && res.errors[0].code) || 'rejected', errors: res.errors });
  }

  return {
    ok: true,
    scanned: scan.scanned,
    thresholds: scan.thresholds,
    total: scan.candidates.length,
    limit,
    suggested,
    skipped,
    errors: [],
  };
}

module.exports = {
  TRIGGER,
  DEFAULT_THRESHOLDS,
  DEFAULT_MAX_SUGGESTIONS,
  PROCEDURE_MARKERS,
  parseFact,
  listFactFiles,
  memoryScopes,
  extractSteps,
  procedureMarkerCount,
  scanRepeats,
  composeDescription,
  composeBody,
  proposeFromMemory,
};
