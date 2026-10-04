#!/usr/bin/env node
// INT-OBS-01 — CANLI KANIT BETİĞİ (gerçek hesap, gerçek API).
//
// NEDEN AYRI BİR BETİK: `provisionFlow.test.cjs` SÖZLEŞMEYİ kanıtlar (doğru uç,
// doğru sıra, idempotanlık, hata cümleleri) ama gerçek bir hesapta gerçekten
// proje açıldığını KANITLAMAZ. İki kanıt sınıfını karıştırmamak için canlı ayak
// buraya alındı: bu betik gerçek jetonla koşar ve ne yapıp ne yapamadığını
// YETENEK MATRİSİ olarak basar.
//
// KULLANIM:
//   # 1) ÖNCE salt-okuma keşfi (hiçbir şey oluşturmaz — güvenli ilk adım)
//   SENTRY_AUTH_TOKEN=... node electron/telemetry/obs-provision-live.cjs sentry --dry
//   POSTHOG_PERSONAL_API_KEY=... node electron/telemetry/obs-provision-live.cjs posthog --dry
//
//   # 2) SONRA gerçek kurulum (proje AÇAR — geri alınması elle olur)
//   SENTRY_AUTH_TOKEN=... node electron/telemetry/obs-provision-live.cjs sentry --apply
//
// 🔴 SIR HİJYENİ: jeton env'den okunur, ARGV'ye YAZILMAZ (`ps` ile görünürdü) ve
// çıktının hiçbir satırında geçmez. DSN/anahtarlar MASKELİ basılır.
// 🔴 `--apply` verilmedikçe HİÇBİR yazma çağrısı yapılmaz (varsayılan güvenli).

'use strict';

const provisionApi = require('./provisionApi.cjs');
const { maskDsn, mask } = require('./provisionStore.cjs');
const { PROJECT_PLAN } = require('./telemetryProvision.cjs');

const service = (process.argv[2] || '').trim();
const apply = process.argv.includes('--apply');
const orgArg = (process.argv.find((a) => a.startsWith('--org=')) || '').split('=')[1] || null;

function line(s = '') { process.stdout.write(`${s}\n`); }
function row(capability, verdict, detail) {
  line(`  ${verdict.padEnd(4)} │ ${capability.padEnd(34)} │ ${detail || ''}`);
}
const YES = '✅';
const NO = '❌';
const SKIP = '·';

async function runSentry(token) {
  line('\n═══ SENTRY — YETENEK MATRİSİ (gerçek çağrılar) ═══\n');
  const api = provisionApi.createSentryApi({});

  const orgs = await api.verifyToken(token);
  if (!orgs.ok) { row('jeton geçerli + org listesi', NO, orgs.message); return 1; }
  row('jeton geçerli + org listesi (org:read)', YES, `${orgs.orgs.length} org: ${orgs.orgs.map((o) => o.slug).join(', ')}`);

  const org = orgArg ? orgs.orgs.find((o) => o.slug === orgArg) : orgs.orgs[0];
  if (!org) { row('org seçimi', NO, `--org=${orgArg} bulunamadı`); return 1; }
  line(`\n  → org: ${org.slug}   bölge adresi: ${org.regionUrl || 'sentry.io (varsayılan)'}\n`);

  const teams = await api.listTeams(token, org);
  if (!teams.ok) { row('takım listesi (org:read)', NO, teams.message); return 1; }
  row('takım listesi (org:read)', YES, teams.teams.map((t) => t.slug).join(', ') || '(takım yok)');
  const team = teams.teams[0];

  const projects = await api.listProjects(token, org);
  if (!projects.ok) { row('proje listesi (project:read)', NO, projects.message); return 1; }
  row('proje listesi (project:read)', YES, `${projects.projects.length} proje`);

  for (const plan of Object.values(PROJECT_PLAN)) {
    const exists = projects.projects.find((p) => p.slug === plan.slug);
    if (!exists && !apply) { row(`proje: ${plan.slug}`, SKIP, 'YOK — --apply verilmedi, oluşturulmadı'); continue; }
    if (!team && !exists) { row(`proje: ${plan.slug}`, NO, 'takım yok, oluşturulamaz'); continue; }

    const ens = await api.ensureProject(token, org, team, plan.slug, plan.name);
    if (!ens.ok) { row(`proje: ${plan.slug}`, NO, ens.message); continue; }
    row(`proje: ${plan.slug}`, YES, ens.created ? 'OLUŞTURULDU (project:write çalıştı)' : 'zaten vardı (idempotent)');

    const dsn = await api.projectDsn(token, org, ens.project.slug);
    if (!dsn.ok) { row(`  ↳ DSN (project:read)`, NO, dsn.message); continue; }
    row('  ↳ DSN çekildi', YES, maskDsn(dsn.dsn));
  }

  const events = await api.latestEvents(token, org, PROJECT_PLAN.dev.slug);
  row('doğrulama okuması (event:read)', events.ok ? YES : NO,
    events.ok ? `${events.events.length} olay okunabiliyor` : events.message);
  return 0;
}

async function runPostHog(token) {
  line('\n═══ POSTHOG — YETENEK MATRİSİ (gerçek çağrılar) ═══\n');
  const detected = await provisionApi.detectPostHogRegion(token, {});
  if (!detected.ok) { row('anahtar geçerli + bölge bulma', NO, detected.message); return 1; }
  row('anahtar geçerli + bölge OTOMATİK bulundu', YES, `${detected.region.toUpperCase()} → ${detected.host}`);
  row('org listesi (organization:read)', YES, detected.orgs.map((o) => o.name).join(', '));

  const ph = detected.api;
  const org = orgArg ? detected.orgs.find((o) => String(o.id) === orgArg) : detected.orgs[0];
  if (!org) { row('org seçimi', NO, `--org=${orgArg} bulunamadı`); return 1; }
  line(`\n  → org: ${org.name} (${org.id})\n`);

  const projects = await ph.listProjects(token, org);
  if (!projects.ok) { row('proje listesi (project:read)', NO, projects.message); return 1; }
  row('proje listesi (project:read)', YES, `${projects.projects.length} proje`);

  for (const plan of Object.values(PROJECT_PLAN)) {
    const exists = projects.projects.find((p) => p.name === plan.name);
    if (!exists && !apply) { row(`proje: ${plan.name}`, SKIP, 'YOK — --apply verilmedi, oluşturulmadı'); continue; }
    const ens = await ph.ensureProject(token, org, plan.name);
    if (!ens.ok) { row(`proje: ${plan.name}`, NO, ens.message); continue; }
    row(`proje: ${plan.name}`, YES, ens.created ? 'OLUŞTURULDU (project:write çalıştı)' : 'zaten vardı (idempotent)');
    row('  ↳ yazma anahtarı (phc_…)', ens.project.apiToken ? YES : NO, mask(ens.project.apiToken || ''));
  }

  const first = projects.projects[0];
  if (first) {
    const q = await ph.countRecentEvents(token, first.id, 'app_opened', new Date(Date.now() - 864e5).toISOString());
    row('doğrulama okuması (query:read)', q.ok ? YES : NO, q.ok ? `sorgu çalıştı (${q.count})` : q.message);
  }
  return 0;
}

(async () => {
  if (service !== 'sentry' && service !== 'posthog') {
    line('kullanım: obs-provision-live.cjs <sentry|posthog> [--apply] [--org=<slug|id>]');
    process.exit(2);
  }
  const token = (service === 'sentry'
    ? process.env.SENTRY_AUTH_TOKEN
    : process.env.POSTHOG_PERSONAL_API_KEY) || '';
  if (!token.trim()) {
    line(`HATA: ${service === 'sentry' ? 'SENTRY_AUTH_TOKEN' : 'POSTHOG_PERSONAL_API_KEY'} env değişkeni boş.`);
    line('Jetonu ARGV\'ye YAZMA (ps ile görünür) — env ile ver.');
    process.exit(2);
  }
  line(apply
    ? '⚠️  --apply AÇIK: eksik projeler GERÇEKTEN oluşturulacak.'
    : 'ℹ️  salt-okuma modu (--apply yok): hiçbir şey oluşturulmayacak.');
  const code = service === 'sentry' ? await runSentry(token.trim()) : await runPostHog(token.trim());
  line('');
  process.exit(code);
})();
