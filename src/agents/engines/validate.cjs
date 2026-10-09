// ENG-04 / ENG-08 — Motor Tanımlayıcısı Doğrulama Kuralları
'use strict';

const {
  REQUIRED_KEYS,
  CAPABILITY_KEYS,
  VERIFICATION_CHANNELS,
  AUTONOMY_LEVELS,
  AUTONOMY_CHANNELS,
  EFFORT_KINDS,
  IDENTITY_KINDS,
  BASE_PROMPT_KINDS,
  BASE_PROMPT_FAILURE_MODES,
  IDENTITY_ENV_TARGETS,
  ISOLATION_KINDS,
  MCP_KINDS,
  OUTPUT_KINDS,
  OUTPUT_STDIN_MODES,
  USAGE_KINDS,
  USAGE_LEVELS,
  USAGE_CONTENTS,
  VENDOR_HOSTED_DETECTORS,
  VENDOR_GATE_POLICIES,
  AUTH_FLOWS,
  STATUS_PARSERS,
} = require('./schema.cjs');

function isNonEmptyString(v, min = 1) {
  return typeof v === 'string' && v.trim().length >= min;
}

/**
 * ENG-08 — `auth` bloğunun kapıları. Saf → `{string[]}` hata listesi.
 */
function validateAuth(a) {
  const errors = [];
  if (!AUTH_FLOWS.includes(a.flow)) {
    errors.push(`auth.flow geçersiz ('${a.flow}') — ${AUTH_FLOWS.join('|')}`);
    return errors;
  }
  if (a.needsCode !== (a.flow === 'oauth-code')) {
    errors.push(`auth.needsCode ('${a.needsCode}') flow ('${a.flow}') ile AYNI şeyi söylemiyor`);
  }
  const hasLogin = Array.isArray(a.loginArgv) && a.loginArgv.length > 0;
  if (a.flow === 'oauth-code' || a.flow === 'oauth-callback' || a.flow === 'device-code') {
    if (!hasLogin) errors.push(`auth.loginArgv: '${a.flow}' bir giriş komutu beyan etmeli`);
  } else if (hasLogin) {
    if (a.flow === 'external') {
      if (!isNonEmptyString(a.externalNote, 20)) {
        errors.push(
          "auth.externalNote: 'external' akışında giriş komutu BEYAN edilebilir ama ürünün onu NEDEN " +
            'sürmediği yazılmalı (>=20 karakter) — yoksa UI "Giriş yap" düğmesi çizip kullanıcıyı ' +
            'sürülemeyen bir akışa gönderir',
        );
      }
    } else {
      errors.push(`auth.loginArgv: '${a.flow}' akışında giriş komutu OLAMAZ (abonelik yolu uydurulmaz)`);
    }
  }
  if (a.statusArgv !== null && a.statusArgv !== undefined) {
    if (!Array.isArray(a.statusArgv) || !a.statusArgv.length) errors.push('auth.statusArgv: dolu bir argv dizisi olmalı');
    if (!STATUS_PARSERS.includes(a.statusParse)) {
      errors.push(`auth.statusParse geçersiz ('${a.statusParse}') — ${STATUS_PARSERS.join('|')}`);
    }
  } else if (a.flow !== 'api-key') {
    if (!isNonEmptyString(a.statusNote, 20)) {
      errors.push(
        `auth.statusArgv: '${a.flow}' akışı rozetini motorun KENDİ durum komutundan almak zorunda — ` +
          'komut GERÇEKTEN yoksa `auth.statusNote` ile (>=20 karakter, ÖLÇÜMLE) beyan et',
      );
    }
  }
  if (a.statusParse === 'exit-code' && !isNonEmptyString(a.signedOutPattern, 10)) {
    errors.push(
      "auth.signedOutPattern: 'exit-code' ayrıştırması motorun ÖLÇÜLMÜŞ girişsizlik cümlesini ister " +
        '(>=10 karakter) — yoksa "ölçemedim" ile "hayır" ayırt edilemez',
    );
  }
  if (a.statusArgv && isNonEmptyString(a.statusNote)) {
    errors.push('auth: hem statusArgv DOLU hem statusNote — çelişki (gerekçe yalnız komut YOKKEN yazılır)');
  }
  if (a.statusField !== undefined && a.statusField !== null) {
    if (!isNonEmptyString(a.statusField)) errors.push('auth.statusField: dolu bir alan adı olmalı');
    if (a.statusParse !== 'json') errors.push("auth.statusField: yalnız statusParse:'json' ile anlamlı — başka şekilde OKUNMAZ");
  }
  if (a.apiKeyVerifyArgv !== undefined && a.apiKeyVerifyArgv !== null) {
    if (!Array.isArray(a.apiKeyVerifyArgv) || !a.apiKeyVerifyArgv.length || !a.apiKeyVerifyArgv.every((s) => isNonEmptyString(s))) {
      errors.push('auth.apiKeyVerifyArgv: dolu bir argv dizisi olmalı (yalnız dizgeler)');
    }
    if (a.apiKey === null || a.apiKey === undefined) {
      errors.push('auth.apiKeyVerifyArgv: anahtar bloğu (apiKey) olmayan motorda doğrulama komutu anlamsız');
    }
  }
  if (a.apiKey === null || a.apiKey === undefined) {
    if (a.flow === 'api-key') errors.push("auth.apiKey: 'api-key' akışı bir anahtar bloğu olmadan anlamsız");
    if (!isNonEmptyString(a.apiKeyNote, 20)) {
      errors.push('auth.apiKeyNote: apiKey null ise GEREKÇE zorunlu (>=20 karakter) — sessiz boşluk yasak');
    }
  } else {
    if (a.apiKeyNote !== undefined) errors.push('auth: hem apiKey DOLU hem apiKeyNote — çelişki');
    if (!isNonEmptyString(a.apiKey.env)) {
      errors.push('auth.apiKey.env: anahtar ENV ile gider (argv YASAK) → değişken adı zorunlu');
    }
    if (!isNonEmptyString(a.apiKey.vaultService)) {
      errors.push('auth.apiKey.vaultService: anahtar credentialVault kaydının servis adı zorunlu');
    }
  }
  return errors;
}

function _validateBasePrompt(bp, errors) {
  if (!BASE_PROMPT_KINDS.includes(bp.kind)) {
    errors.push(`identity.basePrompt.kind geçersiz ('${bp.kind}') — ${BASE_PROMPT_KINDS.join('|')}`);
  }
  if (!BASE_PROMPT_FAILURE_MODES.includes(bp.onFailure)) {
    errors.push(
      `identity.basePrompt.onFailure geçersiz ('${bp.onFailure}') — ${BASE_PROMPT_FAILURE_MODES.join('|')}; ` +
        'reçete düşerse kimlik YAZILMAZ (fail-closed), sessizce REPLACE yapılmaz',
    );
  }
  if (bp.kind === 'self-dump') {
    if (!isNonEmptyString(bp.dumpEnv)) errors.push('identity.basePrompt.dumpEnv: dökümü tetikleyen env adı zorunlu');
    if (!isNonEmptyString(bp.readEnv)) errors.push('identity.basePrompt.readEnv: sentinel enjeksiyonu için okuma env adı zorunlu');
    if (!Array.isArray(bp.probeArgv) || !bp.probeArgv.length) {
      errors.push('identity.basePrompt.probeArgv: dökümü üreten argv zorunlu');
    }
  }
  if (bp.kind === 'ledger-dump') {
    if (!isNonEmptyString(bp.homeEnv)) errors.push('identity.basePrompt.homeEnv: defterin yaşadığı ev dizini env adı zorunlu');
    if (!isNonEmptyString(bp.ledgerGlob)) errors.push('identity.basePrompt.ledgerGlob: defter dosyası deseni zorunlu');
    if (!isNonEmptyString(bp.recordType)) errors.push('identity.basePrompt.recordType: taban prompt\'u taşıyan kayıt tipi zorunlu');
    if (!isNonEmptyString(bp.field)) errors.push('identity.basePrompt.field: taban prompt\'un okunacağı alan adı zorunlu');
    if (!Array.isArray(bp.probeArgv) || !bp.probeArgv.length) {
      errors.push('identity.basePrompt.probeArgv: dökümü üreten argv zorunlu');
    }
  }
}

function _validateIdentity(identity, errors) {
  if (!identity) return;
  if (!IDENTITY_KINDS.includes(identity.kind)) {
    errors.push(`identity.kind geçersiz ('${identity.kind}') — ${IDENTITY_KINDS.join('|')}`);
  }
  if (identity.replacesSystemPrompt === true) {
    const bp = identity.basePrompt;
    if (!bp || typeof bp !== 'object') {
      errors.push(
        'identity.basePrompt: `replacesSystemPrompt:true` bir taşıyıcı gömülü sistem prompt\'unu SİLER — ' +
          'geri kazanma reçetesi ZORUNLU (sessiz yetenek kaybı yasağı, ENG-14)',
      );
    } else {
      _validateBasePrompt(bp, errors);
    }
  }
  if ((identity.kind === 'env-file' || identity.kind === 'flag' || identity.kind === 'flag-dir')
      && typeof identity.replacesSystemPrompt !== 'boolean') {
    errors.push(
      'identity.replacesSystemPrompt: `env-file`/`flag` taşıyıcısı EKLİYOR mu YERİNE Mİ geçiyor — ' +
        'ölçülüp AÇIKÇA (true/false) yazılmalı; boş bırakmak "ölçmedik ama iyimseriz" demektir',
    );
  }
  if (identity.kind === 'env-file' && identity.envTarget !== undefined) {
    if (!IDENTITY_ENV_TARGETS.includes(identity.envTarget)) {
      errors.push(`identity.envTarget geçersiz ('${identity.envTarget}') — ${IDENTITY_ENV_TARGETS.join('|')}`);
    } else if (identity.envTarget === 'json-config' || identity.envTarget === 'json-config-dir') {
      if (!isNonEmptyString(identity.configPath)) {
        errors.push("identity.configPath: kimlik YOLUNUN yazılacağı belge alanı beyan edilmeli (ör. 'instructions[]')");
      }
      if (!identity.configBase || typeof identity.configBase !== 'object') {
        errors.push("identity.configBase: belgenin TABANI zorunlu — boş belge motorun kendi config'ini EZER");
      }
      if (identity.envTarget === 'json-config-dir' && !isNonEmptyString(identity.configFileName)) {
        errors.push("identity.configFileName: 'json-config-dir' belgenin SABİT dosya adını beyan etmeli (env yalnız DİZİNİ taşır)");
      }
    }
  }
}

function _validateEffortAndAutonomy(d, errors) {
  if (d.effort) {
    const e = d.effort;
    if (!EFFORT_KINDS.includes(e.kind)) errors.push(`effort.kind geçersiz ('${e.kind}') — ${EFFORT_KINDS.join('|')}`);
    if (!isNonEmptyString(e.flag)) errors.push('effort.flag: argv\'ye basılacak bayrak zorunlu');
    if (e.kind === 'cli-override' && !isNonEmptyString(e.key)) {
      errors.push('effort.key: `cli-override` taşıyıcısında ezilecek config anahtarı zorunlu');
    }
    if (!Array.isArray(e.values) || !e.values.length || e.values.some((v) => !isNonEmptyString(v))) {
      errors.push('effort.values: boş olmayan string dizisi zorunlu — beyaz liste olmadan kusurlu değer pane\'i öldürür');
    }
  }

  const autonomy = d.autonomy;
  if (!autonomy || typeof autonomy !== 'object') {
    errors.push('autonomy: beyan ZORUNLU — pane onay sorar mı sorusu sessiz kalamaz (ENG-20)');
  } else {
    if (!AUTONOMY_LEVELS.includes(autonomy.level)) {
      errors.push(`autonomy.level geçersiz ('${autonomy.level}') — ${AUTONOMY_LEVELS.join('|')}`);
    }
    if (!AUTONOMY_CHANNELS.includes(autonomy.via === undefined ? null : autonomy.via)) {
      errors.push(`autonomy.via geçersiz ('${autonomy.via}') — argv|env|config|null`);
    }
    if (!Array.isArray(autonomy.flags) || autonomy.flags.some((f) => typeof f !== 'string')) {
      errors.push('autonomy.flags: string dizisi olmalı (boş olabilir)');
    } else if (Array.isArray(d.defaultArgs)) {
      const missing = autonomy.flags.filter((f) => !d.defaultArgs.includes(f));
      if (missing.length) {
        errors.push(`autonomy.flags ⊄ defaultArgs — beyan edilen bayrak argv'ye GİTMİYOR: ${missing.join(', ')}`);
      }
    }
    if (autonomy.level === 'full' && !isNonEmptyString(autonomy.measured, 20)) {
      errors.push('autonomy.measured: level "full" ÖLÇÜM ister (>=20 karakter) — ölçmediysen "unknown" yaz');
    }
    if (autonomy.level !== 'full' && !isNonEmptyString(autonomy.why, 20)) {
      errors.push('autonomy.why: claude paritesinin ALTINDA kalmak bir KARAR\'dır, gerekçesi ZORUNLU (>=20 karakter)');
    }
    if (autonomy.via === 'argv' && Array.isArray(autonomy.flags) && autonomy.flags.length === 0) {
      errors.push('autonomy: via="argv" ama flags BOŞ — çelişki');
    }
  }
}

function _validateMcpOutputUsage(d, errors) {
  if (d.mcp) {
    if (!MCP_KINDS.includes(d.mcp.kind)) errors.push(`mcp.kind geçersiz ('${d.mcp.kind}') — ${MCP_KINDS.join('|')}`);
    if (d.mcp.kind === 'workspace-plugin') {
      if (!isNonEmptyString(d.mcp.pluginPath)) errors.push("mcp.pluginPath: 'workspace-plugin' demet dizininin motorun DAYATTIĞI yolunu beyan etmeli");
      if (!isNonEmptyString(d.mcp.pluginName)) errors.push("mcp.pluginName: 'workspace-plugin' demet ADINI beyan etmeli");
      if (!isNonEmptyString(d.mcp.field)) errors.push("mcp.field: sunucu haritasının yazılacağı belge alanı zorunlu");
      if (!isNonEmptyString(d.mcp.rootFlag)) errors.push("mcp.rootFlag: kökü motora veren bayrak zorunlu (yoksa demet YAZILIR ama motora GÖSTERİLMEZ)");
    }
    if (d.mcp.kind === 'env-config-dir') {
      if (!isNonEmptyString(d.mcp.env)) errors.push("mcp.env: 'env-config-dir' config DİZİNİNİ taşıyan env adını beyan etmeli");
      if (!isNonEmptyString(d.mcp.configFileName)) errors.push("mcp.configFileName: 'env-config-dir' motorun DAYATTIĞI dosya adını beyan etmeli");
      if (!isNonEmptyString(d.mcp.configPath)) errors.push("mcp.configPath: sunucu kayıtlarının yazılacağı belge alanı zorunlu");
    }
  }

  if (d.output) {
    if (!OUTPUT_KINDS.includes(d.output.kind)) errors.push(`output.kind geçersiz ('${d.output.kind}') — ${OUTPUT_KINDS.join('|')}`);
    if (d.output.stdin !== undefined && !OUTPUT_STDIN_MODES.includes(d.output.stdin)) {
      errors.push(`output.stdin geçersiz ('${d.output.stdin}') — ${OUTPUT_STDIN_MODES.join('|')}`);
    }
    if (d.output.headlessArgs !== undefined && (!Array.isArray(d.output.headlessArgs) || d.output.headlessArgs.some((a) => !isNonEmptyString(a)))) {
      errors.push('output.headlessArgs: boş olmayan dize DİZİSİ olmalı');
    }
  }

  if (d.usage) {
    if (!USAGE_KINDS.includes(d.usage.kind)) errors.push(`usage.kind geçersiz ('${d.usage.kind}') — ${USAGE_KINDS.join('|')}`);
    if (!USAGE_LEVELS.includes(d.usage.level)) errors.push(`usage.level geçersiz ('${d.usage.level}') — ${USAGE_LEVELS.join('|')}`);
    if ((d.usage.kind === 'session-ledger' || d.usage.kind === 'time-window' || d.usage.kind === 'run-envelope') && !isNonEmptyString(d.usage.reader)) {
      errors.push(`usage.reader: '${d.usage.kind}' bir satır ayrıştırıcı adı beyan etmeli`);
    }
    if (d.usage.kind === 'run-envelope' && d.usage.report) {
      errors.push("usage.report: 'run-envelope' ayrı bir rapor komutu ÇALIŞTIRMAZ (zarf koşunun kendisinden gelir)");
    }
    if (d.usage.kind !== 'none' && !USAGE_CONTENTS.includes(d.usage.content)) {
      errors.push(`usage.content geçersiz ('${d.usage.content}') — ${USAGE_CONTENTS.join('|')}`);
    }
    if (d.usage.kind === 'cli-report' && !(d.usage.report && Array.isArray(d.usage.report.argv))) {
      errors.push("usage.report.argv: 'cli-report' motorun kendi komutunu beyan etmeli");
    }
    const vh = d.usage.billing && d.usage.billing.vendorHosted;
    if (vh) {
      if (!VENDOR_HOSTED_DETECTORS.includes(vh.detect)) errors.push(`usage.billing.vendorHosted.detect geçersiz ('${vh.detect}') — ${VENDOR_HOSTED_DETECTORS.join('|')}`);
      if (!VENDOR_GATE_POLICIES.includes(vh.defaultPolicy)) errors.push(`usage.billing.vendorHosted.defaultPolicy geçersiz ('${vh.defaultPolicy}') — ${VENDOR_GATE_POLICIES.join('|')}`);
      if (!isNonEmptyString(vh.disclosure, 60)) errors.push('usage.billing.vendorHosted.disclosure: kullanıcıya gösterilecek AÇIK cümle zorunlu (>=60 karakter)');
    }
  }
}

/**
 * Bir kaydı şemaya karşı doğrular. Dönen: `{ ok, errors: string[] }`.
 */
function validateDescriptor(descriptor, expectedId) {
  const errors = [];
  const d = descriptor;
  if (!d || typeof d !== 'object') return { ok: false, errors: ['descriptor bir nesne değil'] };

  for (const key of REQUIRED_KEYS) {
    if (key === 'defaultArgs') {
      if (!Array.isArray(d.defaultArgs) || d.defaultArgs.some((a) => typeof a !== 'string')) {
        errors.push('defaultArgs: string dizisi olmalı');
      }
    } else if (!isNonEmptyString(d[key])) {
      errors.push(`${key}: boş olamaz`);
    }
  }
  if (expectedId && d.id !== expectedId) errors.push(`id ('${d.id}') defter anahtarıyla ('${expectedId}') aynı değil`);

  const unsupported = d.unsupported && typeof d.unsupported === 'object' ? d.unsupported : {};
  const partial = d.partial && typeof d.partial === 'object' ? d.partial : {};
  const verification = d.verification && typeof d.verification === 'object' ? d.verification : {};

  for (const key of CAPABILITY_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(d, key)) {
      errors.push(`${key}: yetenek alanı ATLANMIŞ — sessiz boşluk yasak (yoksa açıkça null yaz)`);
      continue;
    }
    const value = d[key];
    const declared = isNonEmptyString(unsupported[key], 20);
    if (value === null || value === undefined) {
      if (!declared) errors.push(`${key}: null yetenek — unsupported['${key}'] gerekçesi ZORUNLU (>=20 karakter)`);
    } else if (unsupported[key] !== undefined) {
      errors.push(`${key}: hem DOLU hem unsupported — çelişki`);
    }
    if (partial[key] !== undefined) {
      if (value === null || value === undefined) errors.push(`${key}: null yetenek 'partial' olamaz (unsupported kullan)`);
      if (!isNonEmptyString(partial[key], 20)) errors.push(`${key}: partial gerekçesi >=20 karakter olmalı`);
    }
    const v = verification[key];
    if (!v || typeof v !== 'object') {
      errors.push(`${key}: verification kanalı beyan EDİLMEMİŞ`);
    } else {
      if (!VERIFICATION_CHANNELS.includes(v.channel)) {
        errors.push(`${key}: verification.channel geçersiz ('${v.channel}')`);
      } else if (v.channel === 'unverified' && value !== null && value !== undefined) {
        errors.push(`${key}: DOLU bir yetenek 'unverified' olamaz — ölç ya da null'a düşür`);
      }
      if (!isNonEmptyString(v.source, 5)) errors.push(`${key}: verification.source (dosya:satır / ölçüm) zorunlu`);
    }
  }

  for (const key of Object.keys(unsupported)) {
    if (!CAPABILITY_KEYS.includes(key)) errors.push(`unsupported['${key}']: böyle bir yetenek alanı yok`);
  }
  for (const key of Object.keys(partial)) {
    if (!CAPABILITY_KEYS.includes(key)) errors.push(`partial['${key}']: böyle bir yetenek alanı yok`);
  }

  _validateEffortAndAutonomy(d, errors);
  _validateIdentity(d.identity, errors);
  _validateMcpOutputUsage(d, errors);

  if (d.isolation) {
    if (!ISOLATION_KINDS.includes(d.isolation.kind)) errors.push(`isolation.kind geçersiz ('${d.isolation.kind}') — ${ISOLATION_KINDS.join('|')}`);
    if (!isNonEmptyString(d.isolation.env)) errors.push('isolation.env: pane başına ayrılacak env değişkeninin adı zorunlu');
  }

  if (d.auth) errors.push(...validateAuth(d.auth));

  return { ok: errors.length === 0, errors };
}

/** Tüm defteri doğrular: `{ ok, errors: { <engineId>: string[] } }`. */
function validateRegistry(registry) {
  const reg = registry || require('./descriptors/index.cjs').ENGINE_REGISTRY;
  const errors = {};
  let ok = true;
  for (const [id, descriptor] of Object.entries(reg)) {
    const res = validateDescriptor(descriptor, id);
    if (!res.ok) {
      ok = false;
      errors[id] = res.errors;
    }
  }
  return { ok, errors };
}

module.exports = {
  isNonEmptyString,
  validateAuth,
  validateDescriptor,
  validateRegistry,
};
