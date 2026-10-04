// D-07 (SPRINT-TOK-01) — HAFIZA KULLANIM DEFTERİ (ADR-MEMORY-INJECTION K4).
//
// D-04 ölçtü: 26 kayıt bir gecede 8-41 kez enjekte edildi ve 0 kez kullanıldı.
// O ölçüm elle yapılan bir rapor koşusuydu; burası onu ÜRÜNE koyar — "what gets
// measured gets managed": enjekte edilen slug'lar yazılır, oturum bitince
// transkriptte aranır, sonuç bir sonraki seçkinin skorunu düşürür.
//
// SÖZLEŞME:
//   • DEFTER İŞ DÜŞÜRMEZ. Dosya yazılamazsa/bozuksa defter bellekte çalışır ve
//     enjeksiyon aynen olur. Bir ölçüm aracı, ölçtüğü şeyi bozamaz.
//   • KULLANIM = ATIF (kaydın adının/dosyasının transkriptte geçmesi). ETKİ
//     ÖLÇÜLEMEZ ve bu dürüstlük sınırı sayının yanında taşınır: davranışsal sınıf
//     (memoryTargeting.BEHAVIORAL_TYPES) cezadan MUAFtır, çünkü doğası gereği
//     atıf almaz (D-04 §1.4 kutusu).
//   • KİMLİK KÖRÜ. `agentId` yalnız ADRES olarak (hangi defter satırı) taşınır;
//     hiçbir karar ajanın adına/rolüne bakmaz.
//
// Biçim (tek JSON dosyası, küçük ve insan-okunur):
//   { version, records: { <slug>: { injected, used, lastInjectedAt, lastUsedAt } },
//     open: [ { key, slugs, agentId, paneId, cwd, sessionId, atMs } ] }
// `open` = enjekte edildi, henüz kullanım taraması YAPILMADI. Tarama oturum
// bitince (ya da bir sonraki enjeksiyonda tembel olarak) koşar.

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { mkdirpSync } = require('../../platform/mkdirp.cjs'); // PIPE-10 — asılmayan `mkdir -p`

const VERSION = 1;
/** Açık kayıt tavanı — defter sınırsız büyümesin (en eskisi düşer). */
const MAX_OPEN = 200;
/** Kaç slug'a kadar tek enjeksiyon kaydı tutulur (blok zaten k≤6). */
const MAX_SLUGS = 32;

function nowMs() {
  return Date.now();
}

function emptyState() {
  return { version: VERSION, records: {}, open: [] };
}

function readState(file) {
  if (!file) return emptyState();
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return emptyState();
    return {
      version: VERSION,
      records: parsed.records && typeof parsed.records === 'object' ? parsed.records : {},
      open: Array.isArray(parsed.open) ? parsed.open : [],
    };
  } catch {
    // Bozuk/eksik defter = ÖLÇÜM YOK, hata DEĞİL. Sıfırdan başlar.
    return emptyState();
  }
}

function writeState(file, state) {
  if (!file) return false;
  try {
    // PIPE-10 — `fs.mkdirSync(recursive:true)` DEĞİL: `file` çağırandan gelir ve
    // Linux'ta procfs benzeri bir hedefte node'un özyineli mkdir'i SONSUZ DÖNGÜYE
    // girer; aşağıdaki `catch` onu yakalayamaz. Bkz. platform/mkdirp.cjs.
    mkdirpSync(path.dirname(file));
    fs.writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    return true;
  } catch {
    return false; // bellekte devam — çağıran bunu bilir ama iş DÜŞMEZ
  }
}

function cleanSlugs(slugs) {
  const out = [];
  for (const s of Array.isArray(slugs) ? slugs : []) {
    const v = String(s || '').trim();
    if (!v || out.includes(v)) continue;
    out.push(v);
    if (out.length >= MAX_SLUGS) break;
  }
  return out;
}

/**
 * Defter örneği. `file` yoksa yalnız BELLEKTE çalışır (test/geçici mod).
 *
 * @param {{file?:string|null, now?:()=>number}} opts
 */
function createLedger(opts = {}) {
  const file = opts.file || null;
  const now = typeof opts.now === 'function' ? opts.now : nowMs;
  let state = readState(file);
  let dirty = false;

  function persist() {
    if (!dirty) return true;
    const ok = writeState(file, state);
    dirty = false;
    return ok;
  }

  function rec(slug) {
    if (!state.records[slug]) state.records[slug] = { injected: 0, used: 0, lastInjectedAt: null, lastUsedAt: null };
    return state.records[slug];
  }

  return {
    /** Ham durum (test/rapor). */
    state() {
      return state;
    },

    /** Bir slug'ın sayaçları — seçkinin `stats` seam'i. Bilinmiyorsa null. */
    stats(slug) {
      const r = state.records[String(slug || '')];
      return r ? { injected: r.injected, used: r.used, lastInjectedAt: r.lastInjectedAt, lastUsedAt: r.lastUsedAt } : null;
    },

    /**
     * ENJEKSİYON KAYDI. `key` = bu enjeksiyonun adresi (pane+oturum): aynı key
     * yeniden gelirse eski açık kayıt DEĞİŞTİRİLİR (aynı pane'e ikinci görev
     * yazıldığında iki ayrı tarama açmayalım — ikincisi zaten birincinin
     * transkriptini de kapsar).
     */
    recordInjection({ key, slugs, agentId = null, paneId = null, cwd = null, sessionId = null, stage = 'task' } = {}) {
      const list = cleanSlugs(slugs);
      if (!list.length) return { ok: true, slugs: [] };
      const at = now();
      for (const s of list) {
        const r = rec(s);
        r.injected += 1;
        r.lastInjectedAt = at;
      }
      const k = String(key || `${paneId || ''}|${sessionId || ''}|${at}`);
      const prev = state.open.findIndex((o) => o.key === k);
      const entry = { key: k, slugs: list, agentId, paneId, cwd, sessionId, stage, atMs: at };
      if (prev >= 0) {
        // Aynı adres → slug'ları BİRLEŞTİR (ilk görevin kayıtları da taranmalı).
        entry.slugs = cleanSlugs([...state.open[prev].slugs, ...list]);
        state.open[prev] = entry;
      } else {
        state.open.push(entry);
        while (state.open.length > MAX_OPEN) state.open.shift();
      }
      dirty = true;
      persist();
      return { ok: true, slugs: list };
    },

    /** Bir enjeksiyonun oturum künyesini SONRADAN tamamla (sessionId spawn'dan sonra oluşur). */
    attachSession(key, { cwd = null, sessionId = null } = {}) {
      const i = state.open.findIndex((o) => o.key === String(key || ''));
      if (i < 0) return false;
      if (cwd) state.open[i].cwd = cwd;
      if (sessionId) state.open[i].sessionId = sessionId;
      dirty = true;
      persist();
      return true;
    },

    /** Kullanım İŞARETLE (tarama sonucu). */
    recordUsage(slugs) {
      const list = cleanSlugs(slugs);
      if (!list.length) return 0;
      const at = now();
      for (const s of list) {
        const r = rec(s);
        r.used += 1;
        r.lastUsedAt = at;
      }
      dirty = true;
      persist();
      return list.length;
    },

    /**
     * AÇIK KAYITLARI KAPAT: her biri için `probe(entry)` çağrılır ve dönen
     * slug listesi KULLANILMIŞ sayılır. `probe` null döndürürse (ölçülemedi)
     * kayıt AÇIK KALIR — "ölçemedim" ile "kullanılmadı" karıştırılmaz
     * (memoryRecall.cjs'in kendi kuralı).
     *
     * @param {(entry:object)=>string[]|null} probe
     * @param {{filter?:(entry:object)=>boolean, maxAgeMs?:number}} o
     */
    settle(probe, o = {}) {
      if (typeof probe !== 'function') return { settled: 0, used: 0, unmeasured: 0 };
      const keep = [];
      let settled = 0;
      let used = 0;
      let unmeasured = 0;
      const cutoff = Number(o.maxAgeMs) > 0 ? now() - Number(o.maxAgeMs) : null;
      for (const entry of state.open) {
        if (typeof o.filter === 'function' && !o.filter(entry)) {
          keep.push(entry);
          continue;
        }
        let hits = null;
        try {
          hits = probe(entry);
        } catch {
          hits = null;
        }
        if (hits === null || hits === undefined) {
          // Ölçülemedi. Çok eskiyse defteri şişirmesin diye düşer ama KULLANILDI
          // ya da KULLANILMADI diye SAYILMAZ (sessiz yalan yasağı).
          if (cutoff !== null && entry.atMs < cutoff) unmeasured += 1;
          else keep.push(entry);
          continue;
        }
        settled += 1;
        const list = cleanSlugs(hits);
        for (const s of list) {
          const r = rec(s);
          r.used += 1;
          r.lastUsedAt = now();
          used += 1;
        }
        dirty = true;
      }
      state.open = keep;
      dirty = true;
      persist();
      return { settled, used, unmeasured };
    },

    /** Rapor/ölçüm özeti: isabet oranı (kullanılan enjeksiyon / toplam enjeksiyon). */
    summary() {
      let injected = 0;
      let used = 0;
      let dead = 0;
      const slugs = Object.keys(state.records);
      for (const s of slugs) {
        const r = state.records[s];
        injected += r.injected;
        used += r.used;
        if (r.used === 0 && r.injected >= 5) dead += 1;
      }
      return {
        slugs: slugs.length,
        injected,
        used,
        dead,
        open: state.open.length,
        hitRate: injected > 0 ? used / injected : null,
      };
    },

    flush: persist,
  };
}

module.exports = { VERSION, MAX_OPEN, MAX_SLUGS, createLedger, readState, writeState };
