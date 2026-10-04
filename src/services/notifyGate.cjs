// CrewPane — ADP-667: BİLDİRİM KAPISI (tekilleştirme + toplama).
//
// ─────────────────────────────────────────────────────────────────────────────
// NEDEN (Eren'in şikâyeti #1)
// ─────────────────────────────────────────────────────────────────────────────
// "Aynı bitiş İKİ-ÜÇ KEZ bildiriliyor" — token israfı. Ölçülen üç kaynak:
//
//   1. ÇİFT YOL. Bir alt-görevin bitişini İKİ bağımsız yazar bildirebilir:
//      renderer follow-loop'u (`workerNotifyFor` → IPC 'notify:workerEvent') ve
//      ADP-659 supervisor'ı (`notifyOnce`). Supervisor "renderer settle etmişse
//      sus" der ama bu YALNIZ renderer ÖNCE settle ettiğinde tutar: supervisor
//      kanıtı 15sn'lik tick'inde ilk gördüğünde kaydı terminal yapar, sonra gelen
//      renderer `settle()` çağrısı erken döner ve renderer KENDİ notify'ını yine
//      de yazar → aynı bitiş için 2 satır.
//   2. AYNI ADP, FARKLI delegationId. Bir görev yeniden dispatch edilince (retry /
//      sprint dalgası / respawn) yeni delegationId+subtaskId üretilir ama görev
//      KODU aynıdır → lider aynı bitişi tekrar okur.
//   3. DONE + REPORT. Tek alt-görevli delegasyonda `done` satırının hemen ardından
//      `REPORT: dlg-… (1/1)` satırı düşer — aynı bitişin ikinci anlatımı.
//
// ─────────────────────────────────────────────────────────────────────────────
// BU MODÜL
// ─────────────────────────────────────────────────────────────────────────────
// notify-log'a yazan TEK boğaz. İki iş yapar:
//
//   (a) TEKİLLEŞTİRME — idempotent defter. Anahtar = kind + departman + İŞİN KİMLİĞİ:
//       KANIT DOSYASI (varsa — bir işin sonucu tek artefakta yazılır, kim raporlarsa
//       raporlasın aynı bitiştir), yoksa görev kodu + alt-görev kimliği. TTL içinde
//       aynı anahtar bir daha yazılmaz ve çağırana `duplicate:true` döner (kararın
//       SENKRON olması şart: çağıran buna bakarak ikinci kanalını da susturabilsin).
//   (b) TOPLAMA — kabul edilen olaylar `coalesceMs` penceresinde biriktirilir; süre
//       dolunca departman+kind başına TEK satır yazılır ("3 görev bitti: X, Y, Z").
//       Pencerede tek olay varsa satır BİREBİR eski formatındadır (ADP-538
//       sözleşmesi + mevcut e2e'ler değişmeden geçer).
//
// Ayrıca aynı delegasyonun `done` satırı zaten batch'teyse `report` satırı DÜŞÜRÜLÜR
// (kaynak #3) — rapor bir bilgi taşımıyor, aynı bitişi ikinci kez anlatıyor.
//
// TÜM IO ENJEKTE (fs/electron/timer yok) → `node --test` doğrudan koşar
// ([[leaf-module-node-test]]).

'use strict';

/** Varsayılanlar (main env ile override eder; testler doğrudan). */
const DEFAULTS = Object.freeze({
  /** Biriktirme penceresi. Eren: "10-20sn penceresinde biriken bitişleri TEK mesaj". */
  coalesceMs: 12_000,
  /** Aynı anahtarın bir daha yazılmayacağı süre. Gerçek bir YENİDEN koşu bu süreden
   *  sonra tekrar bildirilebilsin diye sonsuz değil. */
  dedupeTtlMs: 30 * 60_000,
  /** Defterin üst sınırı (bellek freni; en eskiler düşer). */
  ledgerMax: 500,
  /** Toplu satırda listelenecek en fazla görev adı. */
  batchNamesMax: 8,
});

/** Başlıktan/task alanından görev kodunu çek ("ADP-667 …" → "ADP-667"); yoksa null. */
function taskCodeIn(text) {
  const m = /\b([A-Z]{2,}-\d+[A-Za-z]?)\b/.exec(String(text == null ? '' : text));
  return m ? m[1] : null;
}

/** Yol → dosya adı (renderer GÖRELİ, main MUTLAK yol taşır; anahtar aynı olmalı). */
function evidenceKey(evidence) {
  const s = String(evidence == null ? '' : evidence).trim();
  if (!s) return '';
  const parts = s.split(/[\\/]/);
  return parts[parts.length - 1] || '';
}

/**
 * Tekilleştirme anahtarı — "AYNI BİTİŞ" nedir sorusunun cevabı.
 *
 * En güçlü kimlik KANIT DOSYASIDIR: bir işin sonucu tek bir artefakta yazılır, o
 * dosyayı kim raporlarsa raporlasın (renderer follow-loop'u / main supervisor'ı /
 * farklı bir delegationId'nin retry'ı) AYNI bitiştir → tek satır. Kanıt yoksa
 * görev kodu + alt-görev kimliğine düşülür.
 *
 * 🪤 YALNIZ görev koduna bakmak YANLIŞ: otopilotta aynı ADP altında ARDIŞIK farklı
 * işler koşar ("ADP-659 GÖREV-1/2/3") ve hepsi tek satıra çökerdi — ADP-659 e2e'si
 * S3'te bunu KIRMIZI vererek yakaladı (kanıt dosyaları farklı: t1.md/t2.md/t3.md).
 *
 * `report` olayları delegasyon başınadır (task = delegationId) → doğal olarak ayrışır.
 */
function dedupeKeyFor(evt) {
  const kind = String((evt && evt.kind) || '');
  const dept = String((evt && evt.department) || '-');
  const raw = String((evt && evt.task) || '');
  if (kind === 'report') return `${kind}|${dept}|${raw}`;
  const ev = evidenceKey(evt && evt.evidence);
  if (ev) return `${kind}|${dept}|ev:${ev}`;
  const code = taskCodeIn(raw) || raw;
  const sub = String((evt && evt.subtaskId) || '');
  return `${kind}|${dept}|${code}${sub ? `|st:${sub}` : ''}`;
}

/** Toplu satırın görev adı listesi ("ADP-1, ADP-2, +3 tane"). */
function joinNames(names, max) {
  const uniq = [];
  for (const n of names) {
    const v = String(n || '').trim();
    if (v && !uniq.includes(v)) uniq.push(v);
  }
  if (uniq.length <= max) return uniq.join(', ');
  return `${uniq.slice(0, max).join(', ')}, +${uniq.length - max} tane`;
}

/** kind → toplu satırın fiil metni. */
const BATCH_VERB = Object.freeze({
  done: 'görev bitti',
  fail: 'görev BAŞARISIZ',
  timeout: 'görev zaman aşımı',
  report: 'delegasyon raporlandı',
});

/**
 * Bir departman+kind grubunu TEK olaya indir. Tek elemanlı grup DEĞİŞMEDEN döner
 * (eski satır formatı korunur — ADP-538 sözleşmesi ve mevcut e2e'ler).
 */
function collapseGroup(kind, events, opts) {
  if (events.length === 1) return events[0];
  // İki iş AYNI görev kodunu taşıyabilir (aynı ADP altında ardışık işler): o zaman
  // ad tek başına ayırt etmez ve toplu satır "3 görev bitti: ADP-659" gibi bilgi
  // KAYBEDEN bir satıra düşer → çakışan adlara kanıt dosyası eklenir.
  const counts = new Map();
  for (const e of events) counts.set(e.task, (counts.get(e.task) || 0) + 1);
  const labelOf = (e) => {
    const ev = evidenceKey(e.evidence);
    return counts.get(e.task) > 1 && ev ? `${e.task}→${ev}` : e.task;
  };
  const names = events.map(labelOf);
  // Toplu satırda AD listesi zaten dosyayı taşıyor → detay olarak yalnız KİM
  // (ajan adı) kalır; aksi hâlde satır aynı yolları iki kez yazan bir duvara döner.
  const who = [];
  for (const e of events) {
    const first = String(e.detail || '').split(':')[0].trim();
    if (first && !first.includes('/') && !who.includes(first)) who.push(first);
  }
  return {
    kind,
    task: `${events.length} ${BATCH_VERB[kind] || 'olay'}: ${joinNames(names, opts.batchNamesMax)}`,
    detail: who.length ? who.join(', ') : undefined,
    department: events[0].department,
  };
}

/**
 * Kapıyı yarat.
 *
 * deps:
 *   emit(evt)                 → satırı gerçekten yaz (notifyLog.appendWorkerEvent sarmalı)
 *   now()                     → epoch ms
 *   setTimer(fn, ms)          → handle  (varsayılan setTimeout + unref)
 *   clearTimer(handle)        → void
 *   log(line)                 → void
 *   opts                      → DEFAULTS override
 */
function createNotifyGate(deps) {
  const d = deps || {};
  const cfg = { ...DEFAULTS, ...(d.opts || {}) };
  const now = d.now || (() => Date.now());
  const log = d.log || (() => {});
  const emit = d.emit || (() => false);
  const setTimer =
    d.setTimer ||
    ((fn, ms) => {
      const t = setTimeout(fn, ms);
      if (t && typeof t.unref === 'function') t.unref();
      return t;
    });
  const clearTimer = d.clearTimer || ((t) => clearTimeout(t));

  /** key → son yazım anı (idempotent defter). */
  const ledger = new Map();
  /** Bekleyen (kabul edilmiş, henüz yazılmamış) olaylar. */
  let buffer = [];
  let timer = null;

  function pruneLedger(t) {
    for (const [k, at] of ledger) {
      if (t - at >= cfg.dedupeTtlMs) ledger.delete(k);
    }
    while (ledger.size > cfg.ledgerMax) {
      const oldest = ledger.keys().next();
      if (oldest.done) break;
      ledger.delete(oldest.value);
    }
  }

  /** Biriken olayları YAZ (departman+kind başına tek satır). */
  function flush() {
    if (timer) { clearTimer(timer); timer = null; }
    if (buffer.length === 0) return 0;
    const batch = buffer;
    buffer = [];
    // Aynı delegasyonun `done` satırı batch'teyse `report` satırı gereksiz (kaynak #3).
    const doneDelegations = new Set(
      batch.filter((e) => e.kind === 'done' && e.delegationId).map((e) => e.delegationId),
    );
    // 🪤 YALNIZ TAM BAŞARILI roll-up düşürülür: "3/5 ok — eksik/başarısız var" YENİ
    // bilgidir ve her zaman yazılır (bildirim azaltma, HATA SUSTURMA değildir).
    const kept = batch.filter(
      (e) => !(e.kind === 'report' && e.ok !== false && e.delegationId && doneDelegations.has(e.delegationId)),
    );
    const groups = new Map();
    for (const e of kept) {
      const g = `${e.department || '-'}|${e.kind}`;
      const list = groups.get(g) || [];
      list.push(e);
      groups.set(g, list);
    }
    let written = 0;
    for (const [g, events] of groups) {
      const kind = g.split('|').pop();
      const evt = collapseGroup(kind, events, cfg);
      try {
        if (emit(evt)) written++;
      } catch (err) {
        log(`notifyGate: yazım hatası: ${(err && err.message) || err}`);
      }
    }
    if (kept.length !== batch.length) {
      log(`notifyGate: ${batch.length - kept.length} gereksiz REPORT satırı düşürüldü (done zaten batch'te)`);
    }
    if (batch.length > 1) log(`notifyGate: ${batch.length} bildirim ${written} satırda toplandı`);
    return written;
  }

  /**
   * Bir bildirimi kapıdan geçir.
   * @returns {{accepted:boolean, duplicate:boolean, reason?:string}}
   *   `duplicate:true` = bu bitiş ZATEN bildirildi; çağıran ikinci kanalını da sussun.
   */
  function admit(evt) {
    if (!evt || typeof evt !== 'object' || !evt.kind || !evt.task) {
      return { accepted: false, duplicate: false, reason: 'invalid' };
    }
    const t = now();
    pruneLedger(t);
    const key = dedupeKeyFor(evt);
    const prev = ledger.get(key);
    if (prev !== undefined && t - prev < cfg.dedupeTtlMs) {
      log(`notifyGate: YİNELENEN bildirim düşürüldü (${key})`);
      return { accepted: false, duplicate: true, reason: 'duplicate' };
    }
    ledger.set(key, t);
    if (cfg.coalesceMs <= 0) {
      buffer.push(evt);
      flush();
      return { accepted: true, duplicate: false };
    }
    buffer.push(evt);
    if (!timer) timer = setTimer(() => { timer = null; flush(); }, cfg.coalesceMs);
    return { accepted: true, duplicate: false };
  }

  return {
    admit,
    /** Test/kapatma dikişi — bekleyenleri hemen yaz. */
    flushNow: flush,
    pending: () => buffer.length,
    ledgerSize: () => ledger.size,
    config: () => ({ ...cfg }),
  };
}

module.exports = { DEFAULTS, taskCodeIn, evidenceKey, dedupeKeyFor, collapseGroup, joinNames, createNotifyGate };
