// CrewPane — Delegation MCP Tool Runners (Phase 4.13)
'use strict';

const crewpaneEnv = require('../../config/crewpaneEnv.cjs');

const {
  discoverBridgeCandidates,
  bridgeRequestFailover,
  toolError,
  toolOk,
} = require('./bridgeClient.cjs');

const {
  summarizeStatus,
  summarizeSupervisor,
  summarizeSprintStatus,
  summarizePanes,
} = require('./formatters.cjs');

async function runDelegate(args) {
  const objective = typeof args.objective === 'string' ? args.objective.trim() : '';
  if (!objective) return toolError('objective is required (the work to distribute; a numbered list works best).');

  const candidates = discoverBridgeCandidates();
  if (!candidates.length) {
    return toolError(
      'CrewPane app bridge not found — open the CrewPane app (its workspace) so delegation can spawn real worker panes.',
    );
  }
  const leaderId = (crewpaneEnv.readEnv('LEADER_ID') || '').trim();
  const department = (typeof args.department === 'string' && args.department.trim()) || (crewpaneEnv.readEnv('DEPARTMENT') || '').trim();
  if (!leaderId) return toolError('leader identity missing (CREWPANE_LEADER_ID not set on this session).');
  if (!department) return toolError('department missing — pass `department` or set CREWPANE_DEPARTMENT.');

  const payload = { objective, leaderId, department };
  if (Array.isArray(args.workers)) payload.workers = args.workers;
  // ADP-565 — objective-level MODEL (applied to workers with no explicit model). The bridge
  // + agentRunner.sanitizeModel validate it downstream; a crafted value is dropped there.
  if (typeof args.model === 'string' && args.model.trim()) payload.model = args.model.trim();
  // ADP-595 — objective-level SAĞLAYICI (görev-başına override). Aynı disiplin: burada
  // doğrulanmaz, main'de `providers.isProvider` bilinmeyeni düşürür (motor varsayılanına döner).
  if (typeof args.provider === 'string' && args.provider.trim()) payload.provider = args.provider.trim();

  let res;
  try {
    res = await bridgeRequestFailover(candidates, 'POST', '/delegate', payload);
  } catch (err) {
    return toolError(`could not reach the CrewPane bridge: ${err.message}`);
  }
  if (res.status === 401) return toolError('CrewPane bridge rejected the token (stale handshake?).');
  // ADP-717 — TAKIM KAPSAMI reddi. Mesaj kullanıcı diliyle gelir ve İZNİN NASIL VERİLECEĞİNİ
  // söyler; lider bunu patrona aynen iletebilsin diye AYNEN geçiriyoruz (kendi cümlemizle
  // örtmüyoruz — "delegasyon başarısız" demek bu vakada kullanıcıyı hiçbir yere götürmez).
  if (res.status === 403) {
    return toolError(
      `${(res.body && res.body.error) || 'bu takıma iş verme iznin yok.'} ` +
        'Bu bir hata DEĞİL: iş verebildiğin her takımı YÖNETEBİLMEN (pane kapatabilmen) için ' +
        'kapsam tek kural olarak uygulanıyor. İzin gerekiyorsa patrondan iste.',
    );
  }
  // ADP-538 — KUYRUK ≠ HATA ≠ BAŞLADI (hayalet-görev fix'i). Köprü 202 {ok,queued}
  // döndüğünde iş SIRAYA girdi ama HİÇBİR pane açılmadı; eski kod bunu
  // "delegation failed (202): …kuyruğa alındı" diye basıyordu — lider ya "failed"
  // ya da (mesajı okuyup) "verdim" diye raporluyordu, ikisi de gerçek değil.
  if (res.status === 202 && res.body && res.body.queued) {
    return toolOk(
      `⏳ KUYRUĞA ALINDI — görev henüz BAŞLAMADI (hiçbir worker pane açılmadı): ${res.body.message || res.body.error || 'hedef ajan meşgul'}. ` +
        'Uçuştaki iş bitince otomatik başlayacak. Bu görevi "verildi/başladı" diye RAPORLAMA; ' +
        'crewpane_delegation_status ile başladığını görene kadar "kuyrukta" de.',
    );
  }
  if (res.status !== 200 || !res.body || !res.body.ok) {
    return toolError(`delegation failed (${res.status}): ${(res.body && res.body.error) || 'unknown error'}`);
  }
  const delegationId = res.body.delegationId;

  // ADP-538 — "started" iddiası status probuyla DOĞRULANIR: alt-görev listesi
  // gelirse pane sayısı raporlanır; gelmezse lider teyitsiz "başladı" dememesi
  // için açık uyarı taşır (iyimser varsayım = hayalet görev).
  let paneNote = '';
  let verified = false;
  try {
    const st = await bridgeRequestFailover(candidates, 'GET', `/delegation/status?id=${encodeURIComponent(delegationId)}`);
    const subs = st.body && st.body.snapshot && Array.isArray(st.body.snapshot.subtasks) ? st.body.snapshot.subtasks : null;
    if (subs) {
      verified = true;
      paneNote = ` ${subs.length} worker pane(s) are spawning (one per subtask), each in its own pane with its own engine.`;
    }
  } catch {
    /* status is optional */
  }

  // TC-03 (ADR §9.3, 3. giriş noktası) — ROL BOŞLUĞU İPUCU. Köprü bu alanı YALNIZ
  // hedefin andığı bir katalog rolü ekipte yokken ve o rol bu oturumda İLK KEZ geçerken
  // doldurur (döngü koruması renderer'da: rosterRoleGap.RoleGapMemory). İş ZATEN
  // dağıtıldı — bu satır bir hata değil, liderin "bu rolde kimse yok, önereyim mi"
  // diyebilmesi için tek satırlık bir bilgidir.
  const roleGapNote =
    res.body && typeof res.body.roleGapHint === 'string' && res.body.roleGapHint.trim()
      ? ` ${res.body.roleGapHint.trim()}`
      : '';
  return toolOk(
    `Delegation started in the CrewPane app (delegationId=${delegationId}).${paneNote} ` +
      'These are REAL worker panes (not a Task subagent) — the boss can watch them in the office. ' +
      (verified
        ? 'Call crewpane_delegation_status to follow progress.'
        : 'UYARI: başlangıç status ile DOĞRULANAMADI — crewpane_delegation_status ile teyit etmeden bu görevi "verildi/başladı" diye raporlama.') +
      roleGapNote,
  );
}

async function runStatus(args) {
  const candidates = discoverBridgeCandidates();
  if (!candidates.length) return toolError('CrewPane app bridge not found (is the app running?).');
  const id = typeof args.delegationId === 'string' && args.delegationId.trim() ? args.delegationId.trim() : '';
  // ADP-659 — bu çağrı liderin GERÇEKTEN baktığının kanıtıdır (ACK). Lider kimliği
  // sorguya eklenir; app tarafındaki supervisor bu ajana bekleyen uyandırma
  // tekrarlarını kapatır (aksi halde lider zaten okumuşken nudge basmaya devam eder).
  const leaderId = (crewpaneEnv.readEnv('LEADER_ID') || '').trim();
  const q = [id ? `id=${encodeURIComponent(id)}` : '', leaderId ? `leader=${encodeURIComponent(leaderId)}` : '']
    .filter(Boolean)
    .join('&');
  let res;
  try {
    res = await bridgeRequestFailover(candidates, 'GET', `/delegation/status${q ? `?${q}` : ''}`);
  } catch (err) {
    return toolError(`could not reach the CrewPane bridge: ${err.message}`);
  }
  if (res.status === 401) return toolError('CrewPane bridge rejected the token.');
  if (res.status !== 200 || !res.body || !res.body.ok) {
    return toolError(`status failed (${res.status}).`);
  }
  // ADP-672 — MOTOR defteri + MAIN defteri BİRLİKTE. Canlı vaka: lider yalnız motor
  // defterini okuyordu, orada hiçbir şey settle olmadığı için 48 dakika "stark:working"
  // gördü ve patrona "hâlâ çalışıyor" dedi. Main defteri renderer'dan bağımsızdır ve
  // sessiz worker / kanıt / izlenmeyen pane gerçeğini taşır.
  return toolOk([summarizeStatus(res.body.snapshot), summarizeSupervisor(res.body.supervisor)].filter(Boolean).join('\n\n'));
}

async function runSprintStop(args) {
  const candidates = discoverBridgeCandidates();
  if (!candidates.length) {
    return toolError('CrewPane app bridge not found — open the CrewPane app to stop a sprint.');
  }
  const leaderId = (crewpaneEnv.readEnv('LEADER_ID') || '').trim();
  const department = (typeof args.department === 'string' && args.department.trim()) || (crewpaneEnv.readEnv('DEPARTMENT') || '').trim();
  if (!leaderId) return toolError('leader identity missing (CREWPANE_LEADER_ID not set on this session).');
  if (!department) return toolError('department missing — pass `department` or set CREWPANE_DEPARTMENT.');

  const payload = { leaderId, department };
  if (typeof args.sprintId === 'string' && args.sprintId.trim()) payload.id = args.sprintId.trim();
  if (typeof args.reason === 'string' && args.reason.trim()) payload.reason = args.reason.trim();

  let res;
  try {
    res = await bridgeRequestFailover(candidates, 'POST', '/sprint/stop', payload);
  } catch (err) {
    return toolError(`could not reach the CrewPane bridge: ${err.message}`);
  }
  if (res.status === 401) return toolError('CrewPane bridge rejected the token (stale handshake?).');
  if (res.status === 403) return toolError((res.body && res.body.error) || 'bu takımın sprintini durdurma iznin yok.');
  if (res.status !== 200 || !res.body || !res.body.ok) {
    return toolError(`sprint stop failed (${res.status}): ${(res.body && res.body.error) || 'unknown error'}`);
  }
  const c = (res.body && res.body.summary) || {};
  return toolOk(
    `Sprint durduruldu (${res.body.sprintId}${res.body.wasLive ? ', canlı sürücü kapatıldı' : ', diskte takılıydı'}). ` +
      `${c.done ?? 0}/${c.total ?? '?'} bitmişti; kalanlar 'skipped' yazıldı. ` +
      'Tek-aktif-sprint kilidi AÇIK — yeni sprint başlatabilirsin.',
  );
}

async function runSprint(args) {
  const action = typeof args.action === 'string' ? args.action.trim().toLowerCase() : 'start';
  if (action === 'stop') return runSprintStop(args);
  if (action && action !== 'start') return toolError(`unknown action '${action}' — use 'start' or 'stop'.`);

  const objective = typeof args.objective === 'string' ? args.objective.trim() : '';
  if (!objective) return toolError('objective is required (sprint hedefi, tek cümle yeter).');
  if (!Array.isArray(args.tasks) || args.tasks.length === 0) {
    return toolError('tasks is required — [{id, title, prompt, dependsOn?, workerAgentId?}] listesi. Her prompt sonuç dosyası YOLU içermeli (ör. docs/agent-results/<id>-<rol>.md), yoksa plan reddedilir.');
  }
  const candidates = discoverBridgeCandidates();
  if (!candidates.length) {
    return toolError('CrewPane app bridge not found — open the CrewPane app so the sprint can run real worker panes.');
  }
  const leaderId = (crewpaneEnv.readEnv('LEADER_ID') || '').trim();
  const department = (typeof args.department === 'string' && args.department.trim()) || (crewpaneEnv.readEnv('DEPARTMENT') || '').trim();
  if (!leaderId) return toolError('leader identity missing (CREWPANE_LEADER_ID not set on this session).');
  if (!department) return toolError('department missing — pass `department` or set CREWPANE_DEPARTMENT.');

  const payload = { objective, leaderId, department, tasks: args.tasks };
  if (Number.isInteger(args.maxConcurrent) && args.maxConcurrent > 0) payload.maxConcurrent = args.maxConcurrent;

  let res;
  try {
    res = await bridgeRequestFailover(candidates, 'POST', '/sprint', payload);
  } catch (err) {
    return toolError(`could not reach the CrewPane bridge: ${err.message}`);
  }
  if (res.status === 401) return toolError('CrewPane bridge rejected the token (stale handshake?).');
  if (res.status === 403) {
    return toolError(
      `${(res.body && res.body.error) || 'bu takıma iş verme iznin yok.'} ` +
        'Bu bir hata DEĞİL: iş verebildiğin her takımı YÖNETEBİLMEN (pane kapatabilmen) için ' +
        'kapsam tek kural olarak uygulanıyor. İzin gerekiyorsa patrondan iste.',
    );
  }
  if (res.status !== 200 || !res.body || !res.body.ok) {
    return toolError(`sprint start failed (${res.status}): ${(res.body && res.body.error) || 'unknown error'}`);
  }
  return toolOk(
    `Sprint started (sprintId=${res.body.sprintId}, ${args.tasks.length} task). ` +
      'Plan artık DİSKTE ve app içinde dalga dalga koşuyor — bu oturum kapansa bile devam eder. ' +
      'Planı unutabilirsin; ilerlemeyi crewpane_sprint_status ile sorgula (sayısal özet döner).',
  );
}

async function runSprintStatus(args) {
  const candidates = discoverBridgeCandidates();
  if (!candidates.length) return toolError('CrewPane app bridge not found (is the app running?).');
  const id = typeof args.sprintId === 'string' && args.sprintId.trim() ? args.sprintId.trim() : '';
  let res;
  try {
    res = await bridgeRequestFailover(candidates, 'GET', `/sprint/status${id ? `?id=${encodeURIComponent(id)}` : ''}`);
  } catch (err) {
    return toolError(`could not reach the CrewPane bridge: ${err.message}`);
  }
  if (res.status === 401) return toolError('CrewPane bridge rejected the token.');
  if (res.status !== 200 || !res.body || !res.body.ok) return toolError(`sprint status failed (${res.status}).`);
  return toolOk(summarizeSprintStatus(res.body.status));
}

async function runPane(args) {
  const action = typeof args.action === 'string' ? args.action.trim() : '';
  if (!['list', 'close', 'focus'].includes(action)) {
    return toolError("action is required: 'list' | 'close' | 'focus'");
  }
  const candidates = discoverBridgeCandidates();
  if (!candidates.length) return toolError('CrewPane app bridge not found (is the app running?).');
  const leaderId = (crewpaneEnv.readEnv('LEADER_ID') || '').trim();
  const department =
    (typeof args.department === 'string' && args.department.trim()) || (crewpaneEnv.readEnv('DEPARTMENT') || '').trim();

  try {
    if (action === 'list') {
      const qs = new URLSearchParams();
      if (leaderId) qs.set('leader', leaderId);
      if (department) qs.set('department', department);
      const suffix = qs.toString() ? `?${qs.toString()}` : '';
      const res = await bridgeRequestFailover(candidates, 'GET', `/panes${suffix}`);
      if (res.status !== 200 || !res.body || !res.body.ok) return toolError(`pane list failed (${res.status}).`);
      return toolOk(summarizePanes(res.body.panes || []));
    }

    if (action === 'focus') {
      const paneId = typeof args.paneId === 'string' ? args.paneId.trim() : '';
      if (!paneId) return toolError('paneId is required for action=focus.');
      const res = await bridgeRequestFailover(candidates, 'POST', '/pane/focus', { paneId, leaderId, department });
      if (res.status === 403) {
        return toolError((res.body && res.body.error) || 'bu pane senin takımında değil.');
      }
      if (res.status !== 200 || !res.body || !res.body.ok) {
        return toolError(`focus failed (${res.status}): ${(res.body && res.body.error) || 'unknown error'}`);
      }
      return toolOk(`Pane ${paneId} is now in front.`);
    }

    // close
    const payload = { leaderId, department, force: args.force === true };
    if (typeof args.paneId === 'string' && args.paneId.trim()) payload.paneId = args.paneId.trim();
    if (typeof args.agentId === 'string' && args.agentId.trim()) payload.agentId = args.agentId.trim();
    if (args.exitedOnly === true) payload.exitedOnly = true;
    if (args.all === true) payload.all = true;
    const res = await bridgeRequestFailover(candidates, 'POST', '/pane/close', payload);
    if (res.status !== 200 || !res.body || !res.body.ok) {
      return toolError(`close failed (${res.status}): ${(res.body && res.body.error) || 'unknown error'}`);
    }
    const closed = res.body.closed || [];
    const denied = res.body.denied || [];
    const deniedNote = denied.length
      ? `\nRefused: ${denied.map((d) => `${d.paneId} (${d.reason})`).join('; ')}`
      : '';
    return toolOk(
      (closed.length
        ? `Closed ${closed.length} pane(s): ${closed.join(', ')} — gone from the office exactly as if the × button was pressed (transcripts stay on disk).`
        : 'No pane was closed.') + deniedNote,
    );
  } catch (err) {
    return toolError(`could not reach the CrewPane bridge: ${err.message}`);
  }
}

async function runTeamCompose(args) {
  const action = typeof args.action === 'string' ? args.action.trim().toLowerCase() : '';
  if (!['propose', 'apply', 'undo'].includes(action)) {
    return toolError("action is required — use 'propose', 'apply' or 'undo'.");
  }

  const candidates = discoverBridgeCandidates();
  if (!candidates.length) {
    return toolError('CrewPane app bridge not found — open the CrewPane app so the team card can be shown.');
  }
  const leaderId = (crewpaneEnv.readEnv('LEADER_ID') || '').trim();
  const department =
    (typeof args.department === 'string' && args.department.trim()) || (crewpaneEnv.readEnv('DEPARTMENT') || '').trim();
  if (!leaderId) return toolError('leader identity missing (CREWPANE_LEADER_ID not set on this session).');
  if (!department) return toolError('department missing — pass `department` or set CREWPANE_DEPARTMENT.');

  const payload = { action, leaderId, department, source: 'leader' };
  if (action === 'propose') {
    const objective = typeof args.objective === 'string' ? args.objective.trim() : '';
    if (!objective) return toolError('objective is required for propose (the boss\'s sentence, verbatim).');
    payload.objective = objective;
    if (Array.isArray(args.roles)) payload.roles = args.roles.filter((r) => typeof r === 'string');
    if (typeof args.mode === 'string' && args.mode.trim()) payload.mode = args.mode.trim();
    if (typeof args.teamName === 'string' && args.teamName.trim()) payload.teamName = args.teamName.trim();
    if (typeof args.engine === 'string' && args.engine.trim()) payload.engine = args.engine.trim().toLowerCase();
    if (Array.isArray(args.agents)) payload.agents = args.agents.filter((a) => typeof a === 'string' && a.trim());
  } else {
    const proposalId = typeof args.proposalId === 'string' ? args.proposalId.trim() : '';
    if (!proposalId) return toolError(`proposalId is required for ${action} (it comes back from propose).`);
    payload.proposalId = proposalId;
    if (action === 'apply' && typeof args.approvalToken === 'string' && args.approvalToken.trim()) {
      payload.approvalToken = args.approvalToken.trim();
    }
  }

  let res;
  try {
    res = await bridgeRequestFailover(candidates, 'POST', '/team/compose', payload);
  } catch (err) {
    return toolError(`could not reach the CrewPane bridge: ${err.message}`);
  }
  if (res.status === 401) return toolError('CrewPane bridge rejected the token (stale handshake?).');
  if (res.status === 501) return toolError('team compose is not wired in this build.');
  const body = res.body || {};
  if (res.status === 403) return toolError(body.error || 'bu takıma çalışan ekleme iznin yok.');
  if (res.status === 429) return toolError(body.error || 'öneri tavanı aşıldı.');
  if (res.status === 409) {
    if (body.code === 'awaiting-approval') {
      return toolOk(
        `⏳ ONAY BEKLENİYOR — kart kullanıcıya gösterildi, HİÇBİR satır yazılmadı. ${body.error || ''} `.trim() +
          ' Kullanıcı karttaki "Ekibe ekle" / "Add to the team" düğmesine basınca ürün ekibi KENDİSİ kurar ve sana ' +
          'terminaline ✅ [EKİP KURUCU] notu gelir — apply çağırmana gerek yok; kendi onayını UYDURAMAZSIN, ' +
          'not gelmeden "ekibi kurdum" DEME.',
      );
    }
    if (body.code === 'in-progress') {
      return toolOk(
        `⏳ KURULUM SÜRÜYOR — ${body.error || 'patron onayladı, ürün kuruyor.'} Sonuç terminaline ✅ [EKİP KURUCU] ` +
          'notu olarak gelecek; apply tekrar ÇAĞIRMA, not gelmeden "ekibi kurdum" DEME.',
      );
    }
    return toolError(body.error || 'onay jetonu geçersiz ya da kullanılmış.');
  }
  if (res.status === 422) {
    const list = (k) => (Array.isArray(body[k]) ? body[k].filter((x) => typeof x === 'string' && x) : []);
    const lines = [
      `❌ ÖNERİ ÜRETİLMEDİ — KART AÇILMADI, hiçbir çalışan eklenmedi/değişmedi. reason=${body.reason || 'no-match'}`,
      body.error ? `Neden: ${body.error}` : '',
      list('existing').length ? `Ekipte zaten var: ${list('existing').join(', ')}` : '',
      list('unmatched').length ? `Katalogda yok: ${list('unmatched').join(', ')}` : '',
      list('nearest').length ? `En yakın katalog rolleri: ${list('nearest').join(', ')}` : '',
      list('rejected').length ? `Patron bu oturumda reddetti: ${list('rejected').join(', ')}` : '',
      list('unknownAgents').length ? `Takımda böyle biri yok: ${list('unknownAgents').join(', ')}` : '',
      body.howTo ? `Nasıl: ${body.howTo}` : '',
      'Patrona bunu OLDUĞU GİBİ söyle; "ekledim/kurdum/motoru değiştirdim" DEME — hiçbir şey yazılmadı. ' +
        'Doğru çağrı şeklini yukarıdan al ve bir kez daha dene; yine reddedilirse patrona sor.',
    ].filter(Boolean);
    return toolError(lines.join('\n'));
  }
  if (res.status !== 200 || !body.ok) {
    return toolError(`team compose failed (${res.status}): ${body.error || 'unknown error'}`);
  }

  if (action === 'propose' && body.mode === 'engine') {
    const rows = Array.isArray(body.rows) ? body.rows : [];
    const lines = rows.map((r) => `• ${r.name} (${r.roleTitle}) · ${r.oneLiner} → ${r.modelLabel}${r.effort ? ` · ${r.effort}` : ''}`);
    const head =
      body.status === 'approved'
        ? 'Motor değişikliği önerisi hazır ve ayarın gereği ÖNCEDEN ONAYLI — apply ile uygulayabilirsin.'
        : 'Motor değişikliği önerisi kullanıcıya KART olarak gösterildi. Henüz hiçbir şey değişmedi.';
    return toolOk(
      [
        `${head} (proposalId=${body.proposalId})`,
        ...lines,
        body.status === 'approved'
          ? 'Uygulamak için: action:"apply" + bu proposalId.'
          : 'Kullanıcı karttaki "Motoru değiştir" / "Switch engine" düğmesine basınca ürün motoru KENDİSİ değiştirir ve ' +
            'terminaline ✅ [EKİP KURUCU] notu gelir. apply ÇAĞIRMA; onayı SEN veremezsin; not gelmeden "motoru değiştirdim" DEME. ' +
            'Pane açık olanlar için patron ayrıca "Yeni motorla yeniden başlat" şeridine basar — o zamana kadar eski motor koşar.',
      ]
        .filter(Boolean)
        .join('\n'),
    );
  }

  if (action === 'propose') {
    const rows = Array.isArray(body.rows) ? body.rows : [];
    const lines = rows.map((r) => `• ${r.roleTitle} — ${r.name} · ${r.oneLiner} · ${r.modelLabel}${r.effort ? ` · ${r.effort}` : ''}`);
    const head =
      body.status === 'approved'
        ? 'Ekip önerisi hazır ve ayarın gereği ÖNCEDEN ONAYLI — apply ile kurabilirsin.'
        : 'Ekip önerisi kullanıcıya KART olarak gösterildi. Henüz hiçbir satır yazılmadı.';
    return toolOk(
      [
        `${head} (proposalId=${body.proposalId})`,
        body.teamName ? `Takım: ${body.teamName}` : '',
        ...lines,
        body.planNote || '',
        body.status === 'approved'
          ? 'Kurmak için: action:"apply" + bu proposalId.'
          : 'Kullanıcı karttaki "Ekibe ekle" / "Add to the team" düğmesine basınca ürün ekibi KENDİSİ kurar ve ' +
            'terminaline ✅ [EKİP KURUCU] notu gelir. apply ÇAĞIRMA; onayı SEN veremezsin; not gelmeden "ekibi kurdum" DEME.',
      ]
        .filter(Boolean)
        .join('\n'),
    );
  }

  if (action === 'apply') {
    if (typeof body.receiptText === 'string' && body.receiptText.trim()) return toolOk(body.receiptText.trim());
    const names = Array.isArray(body.names) ? body.names : [];
    return toolOk(
      `Ekip kuruldu: ${body.teamName || 'takım'} — ${body.employees || names.length} kişi yazıldı` +
        (names.length ? ` (${names.join(', ')})` : '') +
        '. Ofiste görünüp görünmediği ÖLÇÜLEMEDİ — "masalarında" deme. Aynı oturumda crewpane_delegate ile ' +
        'onlara iş verebilirsin. Kullanıcı 10 dakika içinde geri alabilir.',
    );
  }

  if (Number(body.restoredEngines) > 0 && !(body.removedEmployees > 0)) {
    return toolOk(
      `Geri alındı: ${body.restoredEngines} kişinin motoru eski hâline döndü. Kimse silinmedi; açık pane'lerde şerit yine "Yeni motorla yeniden başlat" der.`,
    );
  }
  return toolOk(
    `Geri alındı: ${body.removedEmployees || 0} çalışan` +
      (body.removedTeam ? ' ve takım' : '') +
      ' silindi. Yetim kalan satır yok.',
  );
}

module.exports = {
  runDelegate,
  runStatus,
  runSprintStop,
  runSprint,
  runSprintStatus,
  runPane,
  runTeamCompose,
};
