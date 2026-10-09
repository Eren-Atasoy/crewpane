// CrewPane — Delegation Status & Pane Output Formatters (Phase 4.13)
'use strict';

/** Yaş → insan okur ("3dk", "2sa 5dk"). */
function humanAge(ms) {
  const m = Math.max(0, Math.round(Number(ms || 0) / 60_000));
  return m >= 60 ? `${Math.floor(m / 60)}sa ${m % 60}dk` : `${m}dk`;
}

/**
 * ADP-672 — main'in KALICI defteri, liderin okuyacağı dille. Üç şeyi açıkça söyler:
 *   • uçuştaki iş GERÇEKTEN uçuşta mı (pane yaşıyor mu, ne kadardır bekliyor),
 *   • biten iş nasıl tespit edildi (kanıt/marker/sessizlik) ve kanıtı nerede,
 *   • defterde KAYDI OLMAYAN açık worker pane'leri (eski-yol delegasyon) — sessizce
 *     "her şey yolunda" DENMEZ.
 */
function summarizeSupervisor(sup) {
  if (!sup || typeof sup !== 'object') return '';
  const recs = Array.isArray(sup.records) ? sup.records : [];
  const untracked = Array.isArray(sup.untracked) ? sup.untracked : [];
  if (recs.length === 0 && untracked.length === 0) return '';
  const lines = ['SUPERVISOR DEFTERİ (main süreç, kalıcı — renderer\'dan bağımsız GERÇEK):'];
  for (const r of recs) {
    const bits = [`${r.agentId || '?'}: ${r.status}`];
    if (r.taskCode) bits.push(r.taskCode);
    if (r.status === 'in-flight') {
      bits.push(`${humanAge(r.ageMs)}dır uçuşta`, r.paneAlive ? 'pane AYAKTA' : 'pane YOK');
    } else {
      if (r.settledBy) bits.push(`tespit=${r.settledBy}`);
      if (r.status === 'done' && r.evidencePath) bits.push(`→ ${r.evidencePath}`);
      if (r.status !== 'done' && r.reason) bits.push(String(r.reason).slice(0, 140));
      bits.push(r.leaderNotified ? 'sana bildirildi' : 'HENÜZ bildirilmedi');
    }
    lines.push(`• ${bits.join(' · ')}`);
  }
  if (untracked.length) {
    lines.push(
      `⚠ İZLENMEYEN ${untracked.length} worker pane (bu delegasyon motoruyla açılmamış — ` +
        `supervisor tamamlanmasını TESPİT EDEMEZ, kendin kontrol et): ` +
        untracked.map((p) => `${p.paneId}${p.agentId ? `(${p.agentId})` : ''}`).join(', '),
    );
  }
  return lines.join('\n');
}

/** Turn a delegation snapshot (one or many) into a short human summary. */
// ADP-563 — lider TEK komutla GERÇEĞİ okusun: done alt-görevde kanıt dosyası, geç-kanıtla
// düzeltilmişte "(geç-kanıt)" izi, başarısızda kısa neden. Eski özet yalnız "worker:status"
// döndürüyordu — lider hangi sonuç dosyasının düştüğünü/neden fail göründüğünü göremiyordu.
// DLG-MSG-01 (BUG-R3 #7) — durum satırı sebep hijyeni. Kaynak hijyen renderer'da
// (delegation.ts sanitizeFailReason); burası SON savunma: eski/yabancı snapshot'ta
// bile doldurulmamış şablon (`<sebep>]`) ve `]]` biçimi basılamaz.
function cleanStatusReason(raw) {
  let s = String(raw ?? '').replace(/\s+/g, ' ').trim();
  if (!s || /^<[^<>]+>\s*\]?$/.test(s)) return null;
  while (s.endsWith(']') && (s.match(/\[/g) || []).length < (s.match(/\]/g) || []).length) {
    s = s.slice(0, -1).trimEnd();
  }
  return s || null;
}

function summarizeStatus(snapshot) {
  if (!snapshot) return 'No active delegations.';
  const list = Array.isArray(snapshot) ? snapshot : [snapshot];
  if (list.length === 0) return 'No active delegations.';
  const lines = list.map((d) => {
    const subs = Array.isArray(d.subtasks) ? d.subtasks : [];
    const parts = subs
      .map((s) => {
        let p = `${s.workerAgentId || '?'}:${s.status || '?'}`;
        // PANE-CAP-01 — KAPASİTE BEKLEMESİ ≠ BAŞARISIZLIK. Alt-görev 'pending'
        // kalır (statü YALAN söylemez) ama liderin bunu "duruyor/unutulmuş" diye
        // okumaması için sebep AÇIKÇA yazılır. 02.09'da kaynak yokluğu 'failed'
        // olarak yüzeye çıkıyordu ve lider sprint'i düşmüş sanıyordu.
        if (s.capacityWait) {
          p += `(⏳ kaynak bekliyor — ${s.capacityWait.attempts || 1}. deneme; makine boşalınca kendiliğinden sürecek)`;
        }
        if (s.lateEvidence === true) p += '(geç-kanıt)';
        if (s.status === 'done' && s.evidenceRef) p += ` → ${s.evidenceRef}`;
        else if (s.status !== 'done' && s.error) {
          // DLG-MSG-01 — sebep hijyeni: şablon sebep HİÇ basılmaz, dengesiz kuyruk `]`
          // silinir → `yagmur:failed [<sebep>]]` sınıfı liderin ekranına çıkamaz.
          const r = cleanStatusReason(s.error);
          if (r) p += ` [${r.slice(0, 90)}]`;
        }
        return p;
      })
      .join(', ');
    return `• ${d.id} [${d.status}] — ${subs.length} subtask(s): ${parts || '(none)'}`;
  });
  return lines.join('\n');
}

/** Sprint durumunu lider-context-dostu KISA metne çevir (tail yok, sayısal özet). */
function summarizeSprintStatus(status) {
  const list = Array.isArray(status) ? status : status ? [status] : [];
  if (!list.length) return 'No sprints found.';
  return list
    .map((s) => {
      const c = s.summary || {};
      const head = `• ${s.id}${s.active ? ' [RUNNING]' : s.settled ? ' [SETTLED]' : ' [ON DISK]'} — ` +
        `${c.done ?? 0}/${c.total ?? '?'} done, ${c.dispatched ?? 0} in-flight, ${c.pending ?? 0} pending, ` +
        `${c.failed ?? 0} failed, ${c.skipped ?? 0} skipped` +
        (Array.isArray(c.pausedWorkers) && c.pausedWorkers.length ? `, paused: ${c.pausedWorkers.join(',')}` : '');
      const tasks = Array.isArray(s.tasks) ? `\n  ${s.tasks.join(' · ')}` : '';
      return head + tasks;
    })
    .join('\n');
}

/** Bir pane listesini lider için tek satırlık özetlere çevir. */
function summarizePanes(panes) {
  if (!Array.isArray(panes) || panes.length === 0) return 'No live panes.';
  // STAT-D1 §KN-2 — STATÜ artık AYRI bir alan olarak basılır ve label'dan ÖNCE gelir.
  // Liderin okuduğu satırda bugüne kadar durum bilgisi YOKTU: tek okunabilir alan
  // `label`dı ve `paneRecycler` onu 'Boşta' yazdığı için lider çalışan bir worker'ı
  // boşta sanıyordu (STAT-R1 §KN-2: pane-70, 49 dk boyunca). Label artık KİMLİK,
  // statü ise ÖLÇÜM — ikisi ayrı okunur.
  return panes
    .map((p) => {
      const st = p.status ? p.status.toUpperCase() : 'UNKNOWN';
      const task = p.taskId || p.labelTaskCode;
      return (
        `• ${p.paneId} — ${p.agentId || '(no agent)'}${p.department ? ` @${p.department}` : ''} ` +
        `[${st}]${task ? ` <${task}>` : ''} ` +
        `[${p.command || '?'}${p.worker ? ', worker' : ''}${p.exited ? ', EXITED' : ''}]` +
        `${p.label ? ` "${p.label}"` : ''}`
      );
    })
    .join('\n');
}

module.exports = {
  humanAge,
  cleanStatusReason,
  summarizeSupervisor,
  summarizeStatus,
  summarizeSprintStatus,
  summarizePanes,
};
