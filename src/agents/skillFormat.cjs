// CrewPane — SK-02 (ADR-SKILL-CENTER Karar 1) SKILL.md formatı: ayrıştır + doğrula + yaz.
//
// SAF: node builtin'i bile gerekmiyor (fs YOK) — depo yönetimi skillStore.cjs'in işi.
// Kanonik biçim Agent Skills açık standardının `SKILL.md`'sidir; CrewPane kendi ara
// formatını YAZMAZ (SK-01 Ö1-Ö5: aynı dosya claude ve codex'te değiştirilmeden çalışıyor).
//
// v1 SÖZLEŞMESİ (ADR §2 + §7):
//   • Yalnız standardın alanları: name, description, license, compatibility, metadata.
//   • Claude'a özel alanlar (when_to_use, context, agent, paths, …) YASAK — taşınabilirliği
//     kırar, codex'te "unexpected key" üretir.
//   • `allowed-tools` YASAK ve "güvenlik önlemi" SAYILMAZ: SK-01 Ö7 ölçtü, her pane
//     `--dangerously-skip-permissions` ile koşuyor → bu alan hiçbir şeyi kısıtlamaz.
//     Onu şemaya almak sahte güvence olurdu; tek gerçek kapı taslak/yayın DİZİN ayrımıdır.
//   • CrewPane'e ait her şey `metadata:` altında (`crewpane.*`) — standart `metadata`yı
//     açıkça istemcinin serbest alanı diye tanımlıyor.
//
// ⚠️ `metadata.crewpane.status: draft` BİR KAPI DEĞİLDİR (ADR §3): motorlar metadata
// içeriğine göre davranmaz. Alan yalnız insanın/UI'nin okuduğu bir etikettir; gerçek kapı
// dosyanın HANGİ DİZİNDE durduğudur (skill-drafts hiçbir motor yoluna bağlanmaz).

'use strict';

const SKILL_FILE = 'SKILL.md';

const LIMITS = Object.freeze({
  NAME_MAX: 64, // standart
  DESCRIPTION_MAX: 1024, // standart
  COMPATIBILITY_MAX: 500, // standart
  BODY_MAX_BYTES: 32 * 1024, // tavan: bunun üstü reddedilir
  BODY_WARN_BYTES: 12 * 1024, // ~5k jeton önerisi aşıldı → uyarı (yayın engellenmez)
});

// Standardın kabul ettiği üst-düzey alanlar (allowed-tools BİLEREK yok — yukarı bak).
const STANDARD_KEYS = Object.freeze(['name', 'description', 'license', 'compatibility', 'metadata']);

// Reddedilen alanlar → NEDEN reddedildiği mesajın parçası (kapının adı değil ölçtüğü şey önemli).
const BANNED_KEYS = Object.freeze({
  'allowed-tools':
    'v1de yasak: pane zaten --dangerously-skip-permissions ile koşuyor, bu alan hiçbir şeyi kısıtlamaz (sahte güvence)',
  'disallowed-tools': 'Claudea özel alan — codexte taşınabilir değil',
  when_to_use: 'Claudea özel alan — codexte taşınabilir değil (açıklamayı `description` içine yaz)',
  'disable-model-invocation': 'Claudea özel alan — codexte taşınabilir değil',
  'user-invocable': 'Claudea özel alan — codexte taşınabilir değil',
  context: 'Claudea özel alan — codexte taşınabilir değil',
  agent: 'Claudea özel alan — codexte taşınabilir değil',
  paths: 'Claudea özel alan — codexte taşınabilir değil',
  'argument-hint': 'Claudea özel alan — codexte taşınabilir değil',
});

const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const VALID_STATUS = Object.freeze(['draft', 'published', 'retired']);

/** Skill adı için güvenli slug (agentMemory.safeSlug deseni; dizin adı = `name` olmak zorunda). */
function safeName(id) {
  const s = typeof id === 'string' ? id.trim().toLowerCase() : '';
  return (
    s
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, LIMITS.NAME_MAX) || 'unnamed-skill'
  );
}

function unquote(v) {
  const s = String(v).trim();
  if (s.length >= 2 && ((s[0] === '"' && s.endsWith('"')) || (s[0] === "'" && s.endsWith("'")))) {
    let unquoted = s.slice(1, -1);
    // Double quote varsa: \" → ", \\ → \
    if (s[0] === '"') {
      unquoted = unquoted.replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    }
    return unquoted;
  }
  return s;
}

/**
 * Frontmatter + gövde ayrıştır. YAML'ın DAR bir alt kümesi (skalar + tek düzey iç harita) —
 * tam bir YAML ayrıştırıcısı bilerek YOK: bir bağımlılık eklemek yerine dilbilgisini dar
 * tutup anlaşılmayan her satırı GÖRÜNÜR hata yapıyoruz (sessizce yutmak yerine).
 * Dönen: { ok, frontmatter, body, errors:[{code,message}] }
 */
function parseSkillMd(text) {
  const errors = [];
  const frontmatter = {};
  if (typeof text !== 'string' || !text.trim()) {
    return { ok: false, frontmatter, body: '', errors: [{ code: 'empty', message: 'SKILL.md boş' }] };
  }
  const lines = text.split('\n');
  if (!/^---\s*$/.test(lines[0] || '')) {
    return {
      ok: false,
      frontmatter,
      body: text,
      errors: [{ code: 'no-frontmatter', message: 'Dosya `---` frontmatter satırıyla BAŞLAMALI' }],
    };
  }
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (/^---\s*$/.test(lines[i])) {
      end = i;
      break;
    }
  }
  if (end < 0) {
    return {
      ok: false,
      frontmatter,
      body: '',
      errors: [{ code: 'unterminated-frontmatter', message: 'Frontmatter kapanmıyor (ikinci `---` yok)' }],
    };
  }

  let parentKey = null;
  for (let i = 1; i < end; i++) {
    const raw = lines[i];
    if (!raw.trim() || /^\s*#/.test(raw)) continue;
    const indented = /^\s+/.test(raw);
    const m = raw.match(/^(\s*)([A-Za-z0-9_.-]+)\s*:\s*(.*)$/);
    if (!m) {
      errors.push({ code: 'bad-yaml-line', message: `Anlaşılmayan frontmatter satırı (${i + 1}): ${raw.trim()}` });
      continue;
    }
    const [, indent, key, rest] = m;
    if (!indented) {
      parentKey = null;
      if (rest.trim() === '') {
        frontmatter[key] = {};
        parentKey = key;
      } else {
        frontmatter[key] = unquote(rest);
      }
    } else {
      if (!parentKey || typeof frontmatter[parentKey] !== 'object') {
        errors.push({
          code: 'orphan-nested-key',
          message: `Girintili alanın üst anahtarı yok (${i + 1}): ${key}`,
        });
        continue;
      }
      if (indent.length > 4) {
        errors.push({
          code: 'too-deep',
          message: `v1 yalnız tek düzey iç harita destekler (${i + 1}): ${key}`,
        });
        // SKL-B9-parse FIX: continue yerine değeri kaydet (sessiz veri kaybını durdur)
        // Hata olsa da veri korunacak, sonra validateSkill tarafından uyarılacak
      }
      frontmatter[parentKey][key] = unquote(rest);
    }
  }

  return {
    ok: errors.length === 0,
    frontmatter,
    body: lines.slice(end + 1).join('\n').replace(/^\n+/, ''),
    errors,
  };
}

/**
 * SKILL.md doğrula. Saf — dosya sistemine BAKMAZ; `dirName` ve `entries` (skill dizinindeki
 * girdi adları) çağıran tarafından verilir.
 * Dönen: { ok, name, errors:[{code,message}], warnings:[…], frontmatter, body }
 */
function validateSkill({ text, dirName, entries = [] } = {}) {
  const parsed = parseSkillMd(text);
  const errors = parsed.errors.slice();
  const warnings = [];
  const fm = parsed.frontmatter || {};

  const push = (code, message) => errors.push({ code, message });

  // — name: zorunlu, biçim, sınır, DİZİN ADIYLA AYNI (standart zorunlu kılıyor)
  const name = typeof fm.name === 'string' ? fm.name.trim() : '';
  if (!name) push('name-missing', '`name` zorunlu');
  else {
    if (name.length > LIMITS.NAME_MAX) push('name-too-long', `\`name\` ≤ ${LIMITS.NAME_MAX} karakter olmalı`);
    if (!NAME_RE.test(name)) push('name-format', '`name` yalnız küçük harf/rakam/tire içerebilir (ör. `n8n-stale-reload`)');
    if (dirName && name !== dirName) {
      push('name-dir-mismatch', `\`name\` (${name}) dizin adıyla (${dirName}) AYNI olmalı — standart zorunlu kılıyor`);
    }
  }

  // — description: zorunlu, sınır
  const description = typeof fm.description === 'string' ? fm.description.trim() : '';
  if (!description) push('description-missing', '`description` zorunlu (motor skilli BUNA bakarak seçer)');
  else if (description.length > LIMITS.DESCRIPTION_MAX) {
    push('description-too-long', `\`description\` ≤ ${LIMITS.DESCRIPTION_MAX} karakter olmalı`);
  }

  if (typeof fm.compatibility === 'string' && fm.compatibility.length > LIMITS.COMPATIBILITY_MAX) {
    push('compatibility-too-long', `\`compatibility\` ≤ ${LIMITS.COMPATIBILITY_MAX} karakter olmalı`);
  }

  // — alan kümesi: yalnız standart alanlar; yasaklılar GEREKÇESİYLE reddedilir
  for (const key of Object.keys(fm)) {
    if (Object.prototype.hasOwnProperty.call(BANNED_KEYS, key)) {
      push('banned-key', `\`${key}\` alanı yasak — ${BANNED_KEYS[key]}`);
    } else if (!STANDARD_KEYS.includes(key)) {
      push('unknown-key', `Bilinmeyen alan \`${key}\` — CrewPanee ait her şey \`metadata:\` altında yaşar`);
    }
  }

  if (fm.metadata !== undefined && (typeof fm.metadata !== 'object' || fm.metadata === null)) {
    push('metadata-not-map', '`metadata` bir harita olmalı');
  }
  const meta = (fm.metadata && typeof fm.metadata === 'object') ? fm.metadata : {};
  const status = meta['crewpane.status'];
  if (status !== undefined && !VALID_STATUS.includes(String(status))) {
    push('bad-status', `\`metadata.crewpane.status\` şunlardan biri olmalı: ${VALID_STATUS.join(' | ')}`);
  }

  // — gövde: boş olamaz, tavan var (listeleme bütçesi + bağlam maliyeti)
  const body = String(parsed.body || '');
  const bodyBytes = Buffer.byteLength(body, 'utf8');
  if (!body.trim()) push('body-empty', 'Gövde boş — skill "nasıl yaparım"ı anlatmalı');
  if (bodyBytes > LIMITS.BODY_MAX_BYTES) {
    push('body-too-large', `Gövde ${bodyBytes} bayt — tavan ${LIMITS.BODY_MAX_BYTES} bayt`);
  } else if (bodyBytes > LIMITS.BODY_WARN_BYTES) {
    warnings.push({ code: 'body-large', message: `Gövde ${bodyBytes} bayt — ~5k jeton önerisi aşıldı, bölmeyi düşün` });
  }

  // — T4: v1de çalıştırılabilir skill YOK. Pane skip-permissions ile koştuğu için
  //   `scripts/` içeriği onay sorulmadan yürüyecek bir yük olurdu.
  if (Array.isArray(entries) && entries.includes('scripts')) {
    push('scripts-forbidden', '`scripts/` v1de YASAK (T4): pane onay sormadan koşar → yalnız metin skilli');
  }

  return {
    ok: errors.length === 0,
    name: name || (dirName || ''),
    description,
    errors,
    warnings,
    frontmatter: fm,
    body,
  };
}

/**
 * Frontmatter + gövdeden kanonik SKILL.md metni üret. Saf.
 * `metadata` düz bir harita olarak yazılır (anahtarlar `crewpane.*`).
 */
function composeSkillMd({ name, description, license, compatibility, metadata, body } = {}) {
  const slug = safeName(name);
  const desc = String(description || '').replace(/\s+/g, ' ').trim();
  // SKL-B10: description tırnakla, `:` ve `"` karakterleri escape et
  const descEscaped = desc.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const out = ['---', `name: ${slug}`, `description: "${descEscaped}"`];
  if (license) out.push(`license: ${String(license).replace(/\s+/g, ' ').trim()}`);
  if (compatibility) out.push(`compatibility: ${String(compatibility).replace(/\s+/g, ' ').trim()}`);
  const meta = metadata && typeof metadata === 'object' ? metadata : null;
  if (meta && Object.keys(meta).length) {
    out.push('metadata:');
    for (const [k, v] of Object.entries(meta)) {
      if (v === undefined || v === null || v === '') continue;
      out.push(`  ${k}: ${String(v).replace(/\s+/g, ' ').trim()}`);
    }
  }
  out.push('---', '', String(body || '').trim(), '');
  return { name: slug, content: out.join('\n') };
}

module.exports = {
  SKILL_FILE,
  LIMITS,
  STANDARD_KEYS,
  BANNED_KEYS,
  VALID_STATUS,
  safeName,
  parseSkillMd,
  validateSkill,
  composeSkillMd,
};
