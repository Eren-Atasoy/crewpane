// INT-OBS-01 — "BAĞLA" AKIŞI: tek jetondan uçtan uca kurulum.
//
// Kullanıcının yaptığı TEK iş: servis kartına bir kimlik yapıştırmak.
// Bu modülün yaptığı iş (Eren'in isteğinin tamamı):
//   1. Jetonu DOĞRULA   → hangi organizasyonlar görünüyor
//   2. Org SEÇ          → tek org varsa sorma, birden çoksa SOR (uydurma yok)
//   3. Proje BUL/AÇ     → crewpane-prod · crewpane-dev · crewpane-com
//   4. Anahtarı ÇEK     → Sentry DSN / PostHog `phc_…`
//   5. Kanal başına YAZ → provisionStore (channel.cjs kilidi DOKUNULMADAN)
//   6. DOĞRULA          → gerçek olay gönder + panoda GÖRÜNDÜĞÜNÜ API'den OKU
//
// ─── KANAL KİLİDİ BURADA DA GEÇERLİ (Kural 2 — en ince nokta) ────────────────
// 🔴 Doğrulama olayı YALNIZ İÇİNDE BULUNULAN KANALIN projesine gönderilir.
// İlk tasarımda "kurduğun her projeye bir test olayı at" vardı; bu, dev
// makinesinden PROD projesine olay yazmak demekti — yani ADP-715'ten beri
// koruduğumuz kilidi kurulum sihirbazının kendi eliyle delmek. Prod anahtarı
// yazılır ama doğrulaması PROD YAPIDAN yapılır ve durum satırı bunu açıkça
// söyler ("prod: anahtar yazıldı · doğrulama prod yapıdan").
//
// ─── İDEMPOTANLIK (Kural 5) ─────────────────────────────────────────────────
// Her adım ÖNCE ARAR, sonra oluşturur (`ensureProject`), ve sonuç store'da
// servis başına TEK kayda ÜSTÜNE yazılır. "Bağla"ya beş kez basmak beş proje
// değil, aynı projeyi beş kez bulmak demektir.
//
// ─── SAHTE OTOMASYON YOK (Kural 6) ──────────────────────────────────────────
// Servisin izin vermediği yer AÇIKÇA söylenir:
//   • Jetonda `project:write` yoksa PROJE AÇILMAZ → "şu projeyi kendin aç ya da
//     şu izni ekle" denir; var olan projeler yine bulunup bağlanır.
//   • Jetonda okuma-doğrulama izni (`event:read` / `query:read`) yoksa olay
//     gönderilir ama "panoda gördüm" DENMEZ; "gönderildi, doğrulayamadım" denir.
//
// Saf + DI: `api`, `store`, `wire`, `now`, `sleep` enjekte edilir → `node --test`.

'use strict';

const provisionApi = require('./provisionApi.cjs');

/** Ürünün açtığı projeler. Kanal eşlemesi olan ikisi + siteye ait olan üçüncüsü. */
const PROJECT_PLAN = Object.freeze({
  prod: { slug: 'crewpane-prod', name: 'crewpane-prod', channel: 'prod' },
  dev: { slug: 'crewpane-dev', name: 'crewpane-dev', channel: 'dev' },
  // 🔸 crewpane-com bu UYGULAMANIN kanallarından biri DEĞİL: web sitesinin kendi
  // yüzeyi. Açılır, DSN'i saklanır ve durum ekranında KOPYALANABİLİR gösterilir —
  // ama uygulamanın telemetri env'ine YAZILMAZ (yanlış projeye rapor üretmesin).
  site: { slug: 'crewpane-com', name: 'crewpane-com', channel: null },
});

const VERIFY_EVENT_NAME = 'telemetry_verification';

function fail(code, message, extra = {}) {
  return { ok: false, code, message, ...extra };
}

/**
 * @param {object} opts
 * @param {object} opts.store            provisionStore örneği
 * @param {object} [opts.api]            provisionApi (test ikizi için)
 * @param {object} [opts.wire]           { sentry: sentryWire, posthog: posthogWire }
 * @param {()=>string} opts.channel      resolveChannel() — İÇİNDE BULUNULAN kanal
 * @param {()=>string} [opts.now]        ISO zaman damgası
 * @param {(ms:number)=>Promise} [opts.sleep]
 * @param {(line:string)=>void} [opts.log]
 * @param {string} [opts.appVersion]
 */
function createTelemetryProvisioner(opts = {}) {
  const store = opts.store;
  const api = opts.api || provisionApi;
  const wire = opts.wire || {
    sentry: require('./sentryWire.cjs'),
    posthog: require('./posthogWire.cjs'),
  };
  const channelNow = opts.channel || (() => require('./channel.cjs').resolveChannel());
  const now = opts.now || (() => new Date().toISOString());
  const sleep = opts.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const log = opts.log || (() => {});
  const appVersion = opts.appVersion || '0.0.0';

  // ── Sentry ────────────────────────────────────────────────────────────────

  async function connectSentry(token, choice) {
    const sentry = api.createSentryApi({});
    const verified = await sentry.verifyToken(token);
    if (!verified.ok) return verified;

    // Org SEÇİMİ: tek org varsa sorma (Eren'in isteği "gerisini sen yap"),
    // birden çoksa UYDURMA — kullanıcıya sor (yanlış org'a proje açmak geri
    // alınması zor bir yan etkidir).
    const orgs = verified.orgs;
    let org = orgs.length === 1 ? orgs[0] : orgs.find((o) => o.slug === choice.orgSlug);
    if (!org) {
      return fail(
        'choose-org',
        'Bu jeton birden fazla Sentry organizasyonu görüyor — hangisine kuracağımı seç.',
        { orgs: orgs.map((o) => ({ id: o.slug, label: `${o.name} (${o.slug})` })) },
      );
    }

    const teamsRes = await sentry.listTeams(token, org);
    if (!teamsRes.ok) return teamsRes;
    const team = teamsRes.teams.find((t) => t.slug === choice.teamSlug) || teamsRes.teams[0];
    if (!team) {
      return fail(
        'no-team',
        `“${org.slug}” organizasyonunda hiç takım yok; Sentry proje açmak için takım ister. `
        + 'Sentry → Settings → Teams bölümünden bir takım oluştur, sonra tekrar “Bağla”ya bas.',
      );
    }

    const channels = {};
    const extras = {};
    const notes = [];
    for (const plan of Object.values(PROJECT_PLAN)) {
      const res = await sentry.ensureProject(token, org, team, plan.slug, plan.name);
      if (!res.ok) {
        // Kural 6 — yazma izni yoksa AKIŞI ÖLDÜRME: eksik olanı söyle, bulabildiğini bağla.
        // INT-OBS-02: plan tavanı da (aynı sınıflandırmadan geçer) akışı öldürmez.
        if (res.code === 'missing-scope' || res.code === 'plan-limit') {
          notes.push(`“${plan.slug}” açılamadı: ${res.message}`);
          continue;
        }
        return res;
      }
      const dsnRes = await sentry.projectDsn(token, org, res.project.slug);
      if (!dsnRes.ok) {
        notes.push(`“${plan.slug}” DSN'i okunamadı: ${dsnRes.message}`);
        continue;
      }
      const entry = { project: res.project.slug, dsn: dsnRes.dsn, created: res.created };
      if (plan.channel) channels[plan.channel] = entry;
      else extras[plan.slug] = entry;
      log(`telemetry-provision: sentry ${plan.slug} ${res.created ? 'OLUŞTURULDU' : 'bulundu'}`);
    }

    if (!Object.keys(channels).length) {
      return fail(
        'nothing-provisioned',
        'Hiçbir Sentry projesi bağlanamadı. ' + (notes[0] || 'Jetonun izinlerini kontrol et.'),
        { notes },
      );
    }

    await store.save('sentry', {
      org: { slug: org.slug, name: org.name, regionUrl: org.regionUrl },
      team: { slug: team.slug },
      channels,
      extras,
    });
    return { ok: true, service: 'sentry', org: org.slug, channels, extras, notes };
  }

  // ── PostHog ───────────────────────────────────────────────────────────────

  async function connectPostHog(token, choice) {
    // Bölgeyi SORMUYORUZ — anahtarın kendisi söylüyor (ölçüldü: yanlış bölge 401).
    const detected = await api.detectPostHogRegion(token, {});
    if (!detected.ok) return detected;
    const { api: ph, region, host, orgs } = detected;

    let org = orgs.length === 1 ? orgs[0] : orgs.find((o) => String(o.id) === String(choice.orgSlug));
    if (!org) {
      return fail(
        'choose-org',
        'Bu anahtar birden fazla PostHog organizasyonu görüyor — hangisine kuracağımı seç.',
        { orgs: orgs.map((o) => ({ id: String(o.id), label: o.name })) },
      );
    }

    const channels = {};
    const extras = {};
    const notes = [];
    let planLimited = false;
    for (const plan of Object.values(PROJECT_PLAN)) {
      const res = await ph.ensureProject(token, org, plan.name);
      if (!res.ok) {
        if (res.code === 'missing-scope') { notes.push(`“${plan.name}” açılamadı: ${res.message}`); continue; }
        // 🔑 INT-OBS-02: PLAN TAVANI ≠ izin sorunu ve akışı ÖLDÜRMEZ. Ücretsiz
        // PostHog planı TEK projeye izin verir; 3-proje düzeni yapısal olarak
        // imkânsızdır. Var olan projeler yine bulunur (`ensureProject` önce
        // arar); açılamayanlar için aşağıdaki tek-proje fallback'i devreye girer.
        if (res.code === 'plan-limit') { planLimited = true; continue; }
        return res;
      }
      if (!res.project.apiToken) {
        notes.push(`“${plan.name}” projesinin yazma anahtarı (phc_…) okunamadı — `
          + 'anahtara `project:read` izni ekleyip tekrar dene.');
        continue;
      }
      const entry = {
        projectId: res.project.id,
        projectName: res.project.name,
        apiToken: res.project.apiToken,
        created: res.created,
      };
      if (plan.channel) channels[plan.channel] = entry;
      else extras[plan.slug] = entry;
      log(`telemetry-provision: posthog ${plan.name} ${res.created ? 'OLUŞTURULDU' : 'bulundu'}`);
    }

    // ── ÜCRETSİZ-PLAN FALLBACK (INT-OBS-02) ─────────────────────────────────
    // Plan tavanına çarpıldıysa kurulum DURMAZ: org'un mevcut TEK projesi
    // (project:read yeter) üretim kanalına bağlanır. Olaylar zaten her olayın
    // ortak damgasındaki `app` (crewpane/crewpane-com) + `channel` (prod/dev)
    // özellikleriyle ayrışır (analyticsSchema.BASE) — tek panoda okunabilir.
    let planMode = 'multi';
    if (planLimited) {
      planMode = 'free-single';
      if (!channels.prod) {
        const listed = await ph.listProjects(token, org);
        if (!listed.ok) return listed;
        const pick = listed.projects.find((p) => p.apiToken);
        if (!pick) {
          return fail(
            'plan-limit',
            'PostHog planı yeni proje açtırmıyor ve mevcut projenin yazma anahtarı (phc_…) da '
            + 'okunamadı. Anahtara `project:read` izni ekle ya da PostHog planını yükselt.',
            { notes },
          );
        }
        channels.prod = {
          projectId: pick.id,
          projectName: pick.name,
          apiToken: pick.apiToken,
          created: false,
          sharedFreePlan: true,
        };
        notes.push(`PostHog ücretsiz planın tek projeye izin veriyor; mevcut “${pick.name}” projesi `
          + 'üretim kanalına bağlandı. Olaylar `app` + `channel` özellikleriyle ayrışır. '
          + 'Plan yükseltince “Kurulumu yenile” 3-proje düzenine geçirir.');
        log(`telemetry-provision: posthog ücretsiz-plan fallback → tek proje "${pick.name}"`);
      }
      if (!channels.dev) {
        // 🔴 KANAL KİLİDİ: aynı anahtar dev'e YAZILMAZ (channel.cjs: dev==prod → null).
        // Ücretsiz planda dev analitiği BİLİNÇLİ kapalıdır ve bunu AÇIKÇA söyleriz —
        // sessiz değil. `null` yazmak store birleştirmesinde bayat dev kaydını da siler.
        channels.dev = null;
        notes.push('Geliştirme kanalı: ücretsiz planda kapalı — aynı anahtar dev yapıya yazılmaz '
          + '(kanal kilidi). Dev analitiği plan yükseltilince açılır.');
      }
      if (!extras['crewpane-com'] && channels.prod) {
        // Site aynı TEK projeyi paylaşır; olayları `app:"crewpane-com"` ile ayrışır.
        extras['crewpane-com'] = {
          projectId: channels.prod.projectId,
          projectName: channels.prod.projectName,
          apiToken: channels.prod.apiToken,
          created: false,
          sharedFreePlan: true,
        };
      }
    }

    if (!Object.values(channels).some(Boolean)) {
      return fail(
        'nothing-provisioned',
        'Hiçbir PostHog projesi bağlanamadı. ' + (notes[0] || 'Anahtarın kapsamlarını kontrol et.'),
        { notes },
      );
    }

    await store.save('posthog', {
      org: { id: org.id, name: org.name, slug: String(org.id) },
      region,
      host,
      channels,
      extras,
      planMode,
    });
    // Dönüşte null kanal taşınmaz (UI `Object.entries` ile çizer; null satır çizilmez).
    const resultChannels = {};
    for (const [k, v] of Object.entries(channels)) if (v) resultChannels[k] = v;
    return {
      ok: true, service: 'posthog', org: org.name, region,
      channels: resultChannels, extras, notes, planMode,
    };
  }

  // ── Doğrulama: GERÇEK olay + panoda GÖRÜNDÜĞÜNÜ OKU ───────────────────────

  /**
   * İçinde bulunulan kanalın projesine bir doğrulama olayı gönderir ve olayın
   * sunucuya İŞLENDİĞİNİ API'den okuyarak kanıtlar.
   *
   * 🔴 Kanal kilidi: `channelNow()` prod değilse PROD projesine TEK OLAY GİTMEZ.
   * @returns {Promise<{ok, channel, sent, confirmed, method, message}>}
   */
  async function verify(service, token, deps = {}) {
    const channel = deps.channel || channelNow();
    const doc = await store.read();
    const svc = (doc.services || {})[service];
    if (!svc) return fail('not-provisioned', 'Önce “Bağla” ile kurulumu tamamla.');

    // 'test' kanalı da prod DEĞİLDİR → dev projesine yazar (channel.cjs ile aynı duruş).
    const target = channel === 'prod' ? 'prod' : 'dev';
    const conf = (svc.channels || {})[target];
    if (!conf) {
      // INT-OBS-02: ücretsiz-plan modunda dev kanalı BİLİNÇLİ kapalıdır — "kurulumu
      // tekrar çalıştır" demek kullanıcıyı çözümsüz bir döngüye sokar; gerçeği söyle.
      if (svc.planMode === 'free-single' && target === 'dev') {
        return fail(
          'free-plan-dev-closed',
          'Bu yapı dev kanalında; ücretsiz planda dev analitiği bilinçli kapalı (aynı anahtar '
          + 'dev yapıya yazılmaz — kanal kilidi). Doğrulama üretim yapısından yapılır; '
          + 'dev kanalı için planı yükseltip “Kurulumu yenile”ye bas.',
        );
      }
      return fail(
        'no-channel-key',
        `Bu yapı “${channel}” kanalında çalışıyor ama ${target} projesi kurulmamış. `
        + 'Kurulumu tekrar çalıştır.',
      );
    }

    const attemptedAt = now();
    let sent = null;
    if (service === 'sentry') {
      // `buildEvent` sözleşmesi sentryWire.cjs'te: type/value/environment/release
      // (serbest `message` alanı YOK — olay gövdesi beyaz listedir).
      const event = wire.sentry.buildEvent({
        type: 'TelemetryVerification',
        value: 'INT-OBS-01 doğrulama olayı — kurulumun uçtan uca çalıştığını kanıtlar',
        level: 'info',
        environment: channel,
        release: `crewpane@${appVersion}`,
        tags: { verification: 'true', channel },
        // Sabit parmak izi: her doğrulama TEK bir konu altında toplansın, panoyu
        // her kurulumda yeni bir "issue" ile kirletmesin.
        fingerprint: ['int-obs-01-verification'],
      });
      sent = await wire.sentry.sendEnvelope({ dsn: conf.dsn, event });
    } else {
      sent = await wire.posthog.sendBatch({
        apiKey: conf.apiToken,
        host: svc.host,
        distinctId: `provision-verify-${channel}`,
        events: [{
          name: VERIFY_EVENT_NAME,
          // Serbest metin YOK — yalnız kapalı küme değerleri (analytics duruşu).
          properties: { channel, app_version: appVersion },
          timestamp: Date.parse(attemptedAt),
        }],
      });
    }

    if (!sent || sent.ok !== true) {
      const res = fail(
        'send-failed',
        `Doğrulama olayı gönderilemedi (${(sent && (sent.error || sent.status)) || 'bilinmeyen'}). `
        + 'Anahtar yanlış yazılmış olabilir ya da ağ engelli; “Bağla”yı tekrar çalıştır.',
        { channel, sent: false, confirmed: false },
      );
      await store.noteVerify(service, { ok: false, channel, method: 'send', detail: res.message });
      return res;
    }

    // ── OKUMA AYAĞI: "gönderdim" ≠ "göründü" ────────────────────────────────
    // Ingest asenkrondur; birkaç saniye içinde işlenir. Sınırlı sayıda yoklama
    // yaparız (sonsuz döngü yok, oran sınırını yemeyiz).
    const attempts = Number.isFinite(deps.attempts) ? deps.attempts : 6;
    const waitMs = Number.isFinite(deps.waitMs) ? deps.waitMs : 5000;
    let readBack = null;
    for (let i = 0; i < attempts; i += 1) {
      await sleep(waitMs);
      readBack = service === 'sentry'
        ? await api.createSentryApi({}).latestEvents(token, { slug: svc.org.slug, links: { regionUrl: svc.org.regionUrl } }, conf.project)
        : await api.createPostHogApi({ host: svc.host }).countRecentEvents(token, conf.projectId, VERIFY_EVENT_NAME, attemptedAt);
      if (!readBack.ok) break; // izin yok / hata → yoklamayı sürdürmenin anlamı yok
      const seen = service === 'sentry'
        ? (readBack.events || []).some((e) => Date.parse(e.dateCreated || e.dateReceived || 0) >= Date.parse(attemptedAt) - 60000)
        : (readBack.count || 0) > 0;
      if (seen) {
        const detail = `${conf.project || conf.projectName} · ${channel} kanalı`;
        await store.noteVerify(service, { ok: true, channel, method: 'read-back', detail });
        return {
          ok: true,
          channel,
          sent: true,
          confirmed: true,
          method: 'read-back',
          message: `Doğrulama olayı gönderildi ve ${detail} panosunda GÖRÜLDÜ.`,
        };
      }
    }

    // Kural 6 — okuyamadıysak "doğrulandı" DEMEYİZ. Neden okuyamadığımızı söyleriz.
    const why = readBack && readBack.ok === false
      ? readBack.message
      : 'Olay henüz panoda görünmedi (ingest gecikmesi olabilir).';
    const message = `Doğrulama olayı ${conf.project || conf.projectName} projesine GÖNDERİLDİ (kabul edildi), `
      + `ama panoda göründüğünü ben doğrulayamadım. ${why}`;
    await store.noteVerify(service, { ok: false, channel, method: 'send-only', detail: message });
    return { ok: true, channel, sent: true, confirmed: false, method: 'send-only', message };
  }

  return {
    PROJECT_PLAN,
    VERIFY_EVENT_NAME,

    /**
     * Tam kurulum. Jeton ÇAĞIRAN tarafından (vault'tan) verilir — bu modül
     * jetonu SAKLAMAZ, LOG'LAMAZ, dönüşünde TAŞIMAZ.
     * @param {{service:'sentry'|'posthog', token:string, orgSlug?:string, teamSlug?:string}} input
     */
    async connect(input = {}) {
      const service = input.service;
      const token = typeof input.token === 'string' ? input.token.trim() : '';
      if (!token) return fail('no-token', 'Önce servisin kimliğini (jetonunu) gir.');
      if (!store.isAvailable()) {
        return fail(
          'store-unavailable',
          'Sistem anahtar deposu (Keychain) şu an kullanılamıyor; kurulum sonucu güvenli '
          + 'saklanamayacağı için işlem yapılmadı. Oturumu kilitleyip açtıktan sonra tekrar dene.',
        );
      }
      const choice = { orgSlug: input.orgSlug || null, teamSlug: input.teamSlug || null };
      if (service === 'sentry') return connectSentry(token, choice);
      if (service === 'posthog') return connectPostHog(token, choice);
      return fail('unknown-service', `Bilinmeyen servis: ${String(service || '')}`);
    },

    verify,

    /** Durum yüzeyi (F4) — sır içermez. */
    status() {
      return store.status();
    },
  };
}

module.exports = {
  createTelemetryProvisioner,
  PROJECT_PLAN,
  VERIFY_EVENT_NAME,
};
