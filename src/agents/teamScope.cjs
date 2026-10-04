// ADP-717 — TAKIM KAPSAMI: delegasyon VE yönetim için TEK yetki kararı.
//
// Eren'in sorusu (2026-07-28): "sen Fury ve Stark'ı nasıl kullanabiliyorsun, onlar da
// senin takımında değil, buna yetki nasıl aldın?" — ölçüldü, haklıydı:
//
//   crewpane_delegate      → kapsam kontrolü YOKTU  (optimus, chatflow/education/dc
//                              ajanlarına sorunsuz iş verdi)
//   crewpane_pane close    → kapsam kontrolü VARDI  ("out of scope: pane belongs to
//                              department 'education', caller is 'crewpane'")
//
// Yani lider YÖNETEMEYECEĞİ çalışana İŞ VEREBİLİYORDU: iş başladı, boşta/kirli pane
// temizlenemedi, ADP-706 + ADP-715 teslim edilemedi. Satılacak bir üründe bu ciddi bir
// tasarım açığı — kullanıcı ne olduğunu göremiyor bile.
//
// BU MODÜL O KARARIN KENDİSİDİR (tasarım: docs/design/DELEGATION-PERMISSIONS.md):
//
//        İZİN = (hedef takım == kendi takımım)  ∪  (sahibin verdiği açık izin)
//
// ve `delegate` ile `manage` AYNI fonksiyondan geçer — ASİMETRİ YAPISAL OLARAK İMKÂNSIZ.
//
// TASARIM SINIRLARI (hepsi kasıtlı):
//   • SAF: IO yok, Electron yok, zaman `now` ile enjekte edilir → `node --test` doğrudan koşar.
//   • İSİM HARDCODE YOK: bu dosyada tek bir takım/departman adı geçmez. Kapsam bir
//     EŞİTLİK karşılaştırmasıdır → yeni eklenen takım hiçbir listeye dokunmadan doğru
//     davranır (birim testi bunu ölçer).
//   • `force` TAKIM SINIRINI AŞMAZ. force yalnız ADP-303'ün iki yumuşak korumasını
//     (kendi pane'im / kapsamsız pane) gevşetir.
//   • Karar deterministik kodda; ajanın/sayfanın METNİ izni asla yükseltemez
//     (browserTrust ADR-026 ile aynı disiplin).
//
// Kapsam birimi = TAKIMIN wing slug'ı (`teams.wing_slug || teams.slug`, ADP-482 —
// departman katmanı DEPRECATED). Runtime'da bu değer zaten her iki araçta da
// `department` adıyla taşınıyordu → geriye uyum bedava.

'use strict';

/** Karara giren eylem sınıfları. `delegate` iş BAŞLATIR, `manage` başlatılanı YÖNETİR. */
const ACTIONS = Object.freeze(['delegate', 'manage']);

/** İzin modları. `once` ilk delegasyonda tüketilir ve `manage`'e DÖNÜŞÜR (silinmez). */
const GRANT_MODES = Object.freeze(['always', 'once', 'manage']);

/** Her takımı kapsayan joker. */
const ANY_SCOPE = '*';

/**
 * Kapsam anahtarını normalize et. Kapsam kullanıcı verisinden gelir (takım slug'ı);
 * karşılaştırma büyük/küçük harf ve boşluk duyarsız olmalı ki "CrewPane" ile
 * "crewpane" iki ayrı takım sanılmasın.
 * @returns {string} normalize edilmiş slug ya da '' (bilinmiyor/kapsamsız)
 */
function normalizeScope(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

/** Ajan/lider kimliğini normalize et (aynı gerekçe). */
function normalizeId(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Zaman damgasını ms'e çevir. İKİ biçim de gelir ve bu KASITLI:
 * ayarlar ISO string tutar (elle okunabilir olsun), pane defteri `Date.now()` sayısı
 * tutar (main.js `startedAt: Date.now()`). Birini kabul edip diğerini sessizce null
 * yapmak, geçiş maddesini (§3.5) hiç çalışmaz hâle getirirdi.
 * @returns {number|null}
 */
function toTime(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || !value) return null;
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : null;
}

/**
 * Tek bir izin kaydını doğrula + normalize et. Çöp girdi → null (asla throw etmez:
 * bozuk bir settings.json yetkiyi AÇMAMALI, sessizce yok saymalı — fail-closed).
 */
function sanitizeGrant(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const leaderId = normalizeId(raw.leaderId);
  if (!leaderId) return null;
  const scopes = Array.isArray(raw.scopes)
    ? [...new Set(raw.scopes.map(normalizeScope).filter(Boolean))]
    : [];
  if (!scopes.length) return null;
  const mode = GRANT_MODES.includes(raw.mode) ? raw.mode : 'always';
  const expiresAt = typeof raw.expiresAt === 'string' && toTime(raw.expiresAt) !== null ? raw.expiresAt : null;
  const grantedAt = typeof raw.grantedAt === 'string' && toTime(raw.grantedAt) !== null ? raw.grantedAt : null;
  const origin = raw.origin === 'system' ? 'system' : 'user';
  return { leaderId, scopes, mode, expiresAt, grantedAt, origin };
}

/**
 * `settings.teamScope`'u doğrula + normalize et (agentSettings bunu çağırır).
 * Eksik/çöp → varsayılan: kural AÇIK, izin YOK.
 */
function sanitizeTeamScope(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const grants = Array.isArray(src.grants) ? src.grants.map(sanitizeGrant).filter(Boolean) : [];
  return {
    // Kill-switch (§5): yalnız AÇIK `false` kuralı kapatır; çöp değer → açık.
    enforced: src.enforced !== false,
    // §3.5 geçiş mandalı — bundan ÖNCE başlamış pane'ler yönetilebilir kalır.
    enforcedSince: typeof src.enforcedSince === 'string' && toTime(src.enforcedSince) !== null
      ? src.enforcedSince
      : null,
    // ADP-737 — mandalı KİM çaktı? (kapıyı taşıyan build'in sürümü). Bkz. isOrphanMandate.
    enforcedBy: typeof src.enforcedBy === 'string' && src.enforcedBy.trim()
      ? src.enforcedBy.trim().slice(0, 64)
      : null,
    grants,
  };
}

/**
 * ADP-737 — MANDAL SAHİPSİZ Mİ? (ADP-729 §5'te ölçülen mayın)
 *
 * ADP-717'de `enforcedSince` ayarların HER yazımında damgalanıyordu. Sonuç: kapı
 * modülünü İÇERMEYEN bir build (ya da kaynaktan koşan bir dev/e2e süreci) kullanıcının
 * hesabına "kural yürürlükte" damgası basabiliyordu. Kullanıcı kapıyı taşıyan sürüme
 * geçtiği an kural GERİYE DÖNÜK yürürlükteydi: ayakta olan hiçbir pane `legacy-pane`
 * toleransına giremiyor, izin listesi de boş olduğu için lider takım dışına
 * dokunamıyordu — kullanıcı diliyle "ajanlara erişemiyorum".
 *
 * Ayırt edici işaret: damga VAR ama onu çakan sürüm YOK. Bu durumda mandal, kapının
 * GERÇEKTEN koştuğu ilk anda yeniden çakılır (agentSettings.ensureTeamScopeMandate).
 */
function isOrphanMandate(policy) {
  const p = sanitizeTeamScope(policy);
  return !!p.enforcedSince && !p.enforcedBy;
}

/** Mandal geçerli biçimde çakılmış mı (damga + onu çakan sürüm)? */
function mandateArmed(policy) {
  const p = sanitizeTeamScope(policy);
  return !!p.enforcedSince && !!p.enforcedBy;
}

/** İzin süresi dolmuş mu? */
function isExpired(grant, now) {
  const exp = toTime(grant.expiresAt);
  return exp !== null && exp <= now;
}

/** İzin bu eylemi kapsıyor mu? (`manage` modu yeni iş VERDİRMEZ.) */
function grantAllowsAction(grant, action) {
  return action === 'manage' ? true : grant.mode !== 'manage';
}

/** İzin bu takımı kapsıyor mu? */
function grantCoversScope(grant, targetScope) {
  return grant.scopes.includes(ANY_SCOPE) || grant.scopes.includes(targetScope);
}

/**
 * `leaderId`'nin `targetScope` üzerinde `action` için geçerli izni (yoksa null).
 * SAF — tüketim (once → manage) çağıranın işi (`consumeGrant`).
 */
function findGrant(grants, leaderId, targetScope, action, now) {
  const id = normalizeId(leaderId);
  const scope = normalizeScope(targetScope);
  if (!id || !scope) return null;
  const list = Array.isArray(grants) ? grants : [];
  for (const raw of list) {
    const g = sanitizeGrant(raw);
    if (!g) continue;
    if (g.leaderId !== id) continue;
    if (isExpired(g, now)) continue;
    if (!grantCoversScope(g, scope)) continue;
    if (!grantAllowsAction(g, action)) continue;
    return g;
  }
  return null;
}

/**
 * Kullanıcı diliyle red mesajı. TEK yer — `delegate` ve `manage` AYNI cümleyi döner
 * (mesaj farkı, kuralın farklı sanılmasına yol açar).
 */
function explainRefusal({ callerId, callerScope, targetScope }) {
  const who = normalizeId(callerId) || 'bu lider';
  const mine = normalizeScope(callerScope);
  const target = normalizeScope(targetScope);
  return (
    `Reddedildi: "${target}" senin takımın değil` +
    (mine ? ` (sen "${mine}" takımındasın)` : '') +
    '. Bu takıma iş verip yönetebilmen için sahibin izin vermeli: ' +
    `Ayarlar → Takım İzinleri → "${who}" → "Diğer takımlara da iş verebilsin". ` +
    'İzin verilmeden bu takımın ajanlarına iş veremez, pane\'lerini kapatamazsın.'
  );
}

/**
 * TEK YETKİ KARARI (docs/design/DELEGATION-PERMISSIONS.md §3.3).
 *
 * @param {object} input
 * @param {'delegate'|'manage'} input.action
 * @param {string}  input.callerId      lider agents.id
 * @param {string}  input.callerScope   liderin KENDİ takımı (canlı pane defterinden çözülür)
 * @param {string}  input.targetScope   hedef takım (delege: istenen; manage: pane'in takımı)
 * @param {object}  input.policy        sanitizeTeamScope çıktısı
 * @param {boolean} [input.force]       ADP-303 yumuşak korumaları gevşetir (takım sınırını AŞMAZ)
 * @param {number}  [input.now]         ms epoch (test dikişi)
 * @param {string}  [input.targetStartedAt] yalnız `manage`: hedef pane'in başlangıcı (ISO)
 * @returns {{ok:true, via:string, grant?:object} | {ok:false, code:string, reason:string}}
 */
function authorize(input = {}) {
  const action = ACTIONS.includes(input.action) ? input.action : null;
  if (!action) return { ok: false, code: 'bad-action', reason: `unknown action: ${String(input.action)}` };

  const policy = sanitizeTeamScope(input.policy);
  const callerId = normalizeId(input.callerId);
  const callerScope = normalizeScope(input.callerScope);
  const targetScope = normalizeScope(input.targetScope);
  const force = input.force === true;
  const now = Number.isFinite(input.now) ? input.now : Date.now();

  // Kill-switch: kural kapalıysa eski davranış (§5). Log'da görünür, UI'da uyarı var.
  if (!policy.enforced) return { ok: true, via: 'policy-disabled' };

  // 1 — kendi takımım.
  if (targetScope && targetScope === callerScope) return { ok: true, via: 'own-scope' };

  // Çağıranın kapsamı bilinmiyorsa (pane'siz köprü çağrısı, kapsamsız shell) kural
  // uygulanamaz: kimin adına karar vereceğimizi bilmiyoruz → eski davranışı koru.
  // Bu bir DELİK DEĞİL: liderler her zaman kimlikli bir pane'den çağırır (withLeaderEnv).
  if (!callerScope) return { ok: true, via: 'caller-scope-unknown' };

  // 2 — hedef kapsamsız (departmansız shell pane): ADP-303'ün mevcut davranışı aynen.
  if (!targetScope) {
    if (force) return { ok: true, via: 'force' };
    return {
      ok: false,
      code: 'no-scope',
      reason: 'out of scope: pane has no department (pass force:true to close it anyway)',
    };
  }

  // 3 — sahibin verdiği açık izin.
  const grant = findGrant(policy.grants, callerId, targetScope, action, now);
  if (grant) return { ok: true, via: 'grant', grant };

  // 4 — GEÇİŞ (§3.5): kural yürürlüğe girmeden ÖNCE başlamış pane YÖNETİLEBİLİR kalır.
  //     Yalnız `manage`. Yeni iş başlatmayı ASLA açmaz; o pane kapanınca etkisi biter.
  if (action === 'manage') {
    const since = toTime(policy.enforcedSince);
    const started = toTime(input.targetStartedAt);
    if (since !== null && started !== null && started < since) {
      return { ok: true, via: 'legacy-pane' };
    }
  }

  // 5 — RED. `force` buraya YETİŞMEZ (takım sınırı force ile aşılmaz).
  return {
    ok: false,
    code: 'cross-team',
    reason: explainRefusal({ callerId, callerScope, targetScope }),
  };
}

/**
 * `once` iznini TÜKET: silme — `manage`'e DÖNÜŞTÜR. Böylece tasarımın 4. kuralı
 * ("yönetim delegasyonu takip eder") sağlanır: tek-seferlik izinle başlatılan işin
 * pane'i sonradan da kapatılabilir. SAF: yeni grants dizisi döner.
 */
function consumeGrant(grants, grant) {
  const list = Array.isArray(grants) ? grants : [];
  if (!grant || grant.mode !== 'once') return { grants: list, changed: false };
  let changed = false;
  const next = list.map((raw) => {
    const g = sanitizeGrant(raw);
    if (!g || changed) return raw;
    if (g.leaderId !== grant.leaderId || g.mode !== 'once') return raw;
    if (JSON.stringify(g.scopes) !== JSON.stringify(grant.scopes)) return raw;
    changed = true;
    return { ...g, mode: 'manage' };
  });
  return { grants: next, changed };
}

/**
 * ADP-737 — İZİN EKLE (sahibin onay akışının yazma ucu). SAF: yeni grants dizisi döner.
 *
 * Aynı lider + aynı mod için ikinci bir satır AÇMAZ, kapsamları BİRLEŞTİRİR: yoksa
 * "her takım için ayrı bir izin satırı" birikir ve kullanıcı Ayarlar'da ne verdiğini
 * okuyamaz hâle gelir. `'*'` verildiğinde diğer kapsamlar gereksizdir → tek başına kalır.
 *
 * TC-05 — BİRLEŞTİRME ANAHTARINA `origin` DE GİRER. Takım kurucu apply'dan sonra
 * lidere KENDİ KURDURDUĞU takım için bir izin yazar (`origin:'system'`) ve geri alma
 * o izni SİLER. Sahibin kendi eliyle verdiği izinle (`origin:'user'`) aynı satırda
 * birleşselerdi, geri alma sahibin iznini de götürürdü — sistemin yazdığını sistem
 * geri alır, kullanıcının verdiğine DOKUNMAZ.
 */
function addGrant(grants, grant, now) {
  const list = Array.isArray(grants) ? grants : [];
  const t = Number.isFinite(now) ? now : Date.now();
  const incoming = sanitizeGrant({
    ...(grant || {}),
    grantedAt: (grant && grant.grantedAt) || new Date(t).toISOString(),
  });
  if (!incoming) return { grants: list, changed: false };

  let merged = false;
  const next = list.map((raw) => {
    const g = sanitizeGrant(raw);
    if (!g || merged) return raw;
    if (g.leaderId !== incoming.leaderId || g.mode !== incoming.mode || g.origin !== incoming.origin) return raw;
    merged = true;
    const scopes = [...new Set([...g.scopes, ...incoming.scopes])];
    return {
      ...g,
      scopes: scopes.includes(ANY_SCOPE) ? [ANY_SCOPE] : scopes,
      grantedAt: incoming.grantedAt,
      // Süre: ikisinden GENİŞ olanı (null = süresiz) — daralan bir yenileme sürpriz olurdu.
      expiresAt: !g.expiresAt || !incoming.expiresAt ? null : (toTime(g.expiresAt) > toTime(incoming.expiresAt) ? g.expiresAt : incoming.expiresAt),
    };
  });
  if (merged) return { grants: next, changed: true };
  return { grants: [...list, incoming], changed: true };
}

/**
 * TC-05 — İZNİ GERİ AL (takım kurucunun "geri al"ının yazma ucu). SAF: yeni grants dizisi döner.
 *
 * `addGrant`ın TERSİ ve ondan DAR: yalnız (lider, kapsam, origin) üçlüsüne birebir uyan
 * satırlardan O KAPSAMI çıkarır. Kapsamı kalmayan satır düşer; başka kapsamları varsa
 * satır DURUR. `origin` verilmezse hiçbir şey yapılmaz — "kimin yazdığını bilmeden
 * silme" kuralı kasıtlıdır: sahibin kendi verdiği izin (`origin:'user'`) bir geri
 * almayla ASLA kaybolmamalı.
 *
 * `'*'` joker satırına DOKUNMAZ: onu bu akış yazmadı, daraltmak da sürpriz olurdu.
 *
 * @returns {{grants:object[], changed:boolean}}
 */
function revokeGrant(grants, { leaderId, scope, origin } = {}) {
  const list = Array.isArray(grants) ? grants : [];
  const id = normalizeId(leaderId);
  const target = normalizeScope(scope);
  const who = origin === 'system' || origin === 'user' ? origin : null;
  if (!id || !target || !who || target === ANY_SCOPE) return { grants: list, changed: false };

  let changed = false;
  const next = [];
  for (const raw of list) {
    const g = sanitizeGrant(raw);
    if (!g || g.leaderId !== id || g.origin !== who || !g.scopes.includes(target)) {
      next.push(raw);
      continue;
    }
    changed = true;
    const scopes = g.scopes.filter((s) => s !== target);
    if (scopes.length) next.push({ ...g, scopes }); // başka kapsamları varsa satır DURUR
  }
  return { grants: next, changed };
}

/**
 * Bir lider için, o an geçerli olan kapsamların özeti (UI + log). SAF.
 * @returns {{ any:boolean, scopes:string[], modes:string[] }}
 */
function grantSummary(grants, leaderId, now) {
  const id = normalizeId(leaderId);
  const t = Number.isFinite(now) ? now : Date.now();
  const scopes = new Set();
  const modes = new Set();
  for (const raw of Array.isArray(grants) ? grants : []) {
    const g = sanitizeGrant(raw);
    if (!g || g.leaderId !== id || isExpired(g, t)) continue;
    g.scopes.forEach((s) => scopes.add(s));
    modes.add(g.mode);
  }
  return { any: scopes.size > 0, scopes: [...scopes], modes: [...modes] };
}

/**
 * Bir pane listesini çağıranın kapsamına süz (`/panes`). ESKİDEN bu süzme MCP
 * istemcisindeydi (crewpane-delegate-mcp.cjs:454) — yani kandırılabilirdi.
 * Artık sunucu tarafında, AYNI `authorize` ile.
 */
function visiblePanes(panes, { callerId, callerScope, policy, now } = {}) {
  const list = Array.isArray(panes) ? panes : [];
  return list.filter((p) => {
    const dec = authorize({
      action: 'manage',
      callerId,
      callerScope,
      targetScope: p && p.department,
      policy,
      now,
      targetStartedAt: p && p.startedAt,
      // Kapsamsız pane'i listede GÖSTER (kapatmak için force gerekir; görmek zararsız
      // ve liderin "kimin bu?" diye sorabilmesi için gerekli).
      force: true,
    });
    return dec.ok;
  });
}

module.exports = {
  ACTIONS,
  GRANT_MODES,
  ANY_SCOPE,
  normalizeScope,
  sanitizeGrant,
  sanitizeTeamScope,
  isOrphanMandate, // ADP-737
  mandateArmed, // ADP-737
  findGrant,
  authorize,
  consumeGrant,
  addGrant, // ADP-737 — onay akışının yazma ucu
  revokeGrant, // TC-05 — takım kurucunun geri almasının yazma ucu
  grantSummary,
  visiblePanes,
  explainRefusal,
};
