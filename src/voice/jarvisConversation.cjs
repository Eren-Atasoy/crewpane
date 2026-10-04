// ADP-317 — JARVİS KONUŞMASI: TEK GERÇEK (main süreçte).
//
// Kök neden (Eren'in canlı vakası): Jarvis konuşması YALNIZ renderer'ın React
// state'inde (JarvisWidget.lines) yaşıyordu. Telefondan gelen komut ise gateway →
// main → mobileBridgeClient.cmdJarvis yolundan gidip DOĞRUDAN action-bus'a düşüyordu:
// iş yapılıyordu (Optimus'un pane'ine ulaştı) ama masaüstü paneli o konuşmayı hiç
// görmüyordu. İki uç, iki ayrı hafıza → "iki Jarvis".
//
// Çözüm: konuşma (kullanıcı satırı + Jarvis cevabı + eylem etiketi + onay kartları)
// MAIN'de tek yerde tutulur. Renderer da gateway de BURADAN beslenir:
//   • renderer → append → main → broadcast('jarvis:conv:changed') → tüm pencereler
//   • main → emitMobileEvent (SSE /m/stream) → telefon
//   • telefon açılışta GET /m/jarvis/history → aynı defter
//
// Kalıcılık: instance-scoped tek dosya (delegationQueueStore deseni) — kısa geçmiş
// restart'ı atlatır. Atomik tmp+rename; bozuk dosya asla fırlatmaz (konuşma kaybı
// uygulamayı düşürmemeli).

'use strict';

const fs = require('node:fs');
// ADP-835 (790 K1) — atomik yazımın rename adımı platform boğazından geçer:
// Windows'ta Defender/Search hedefi açık tutunca EPERM/EBUSY gelir ve bu çağrıların
// çoğu best-effort catch içinde OLDUĞU İÇİN kayıt SESSİZCE kaybolurdu.
const { renameWithRetrySync } = require('../../platform/atomicWrite.cjs');
const path = require('node:path');
const crypto = require('node:crypto');
const instancePaths = require('../config/instancePaths.cjs');

const STORE_VERSION = 1;
const FILE_NAME = 'jarvis-conversation.json';
/**
 * ADP-329 — defter artık SAYFALANIYOR (aşağıdaki `page()`), yani telefon açılışta
 * tamamını indirmiyor. Eski 60 satırlık tavan tam da "hepsi tek seferde gidiyor"
 * korkusundan geliyordu; o kısıt kalkınca defter GERÇEK bir hafıza olabilir.
 * Masaüstü paneli zaten kendi tavanıyla (TRANSCRIPT_MAX) kırpıyor → etkilenmez.
 */
const MAX_TURNS = 300;
const MAX_APPROVALS = 20;
const MAX_TEXT = 4000;
/** Telefonun bir sayfada aldığı satır sayısı (ADP-324 pane tail'iyle aynı ölçek). */
const PAGE_DEFAULT = 30;
const PAGE_MAX = 100;

function convPath(homedir) {
  return path.join(instancePaths.crewpaneHome(homedir), FILE_NAME);
}

function newId(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
}

function str(v, max = MAX_TEXT) {
  return String(v == null ? '' : v).slice(0, max);
}

/** ADP-322 — kart seçenekleri: [{id,label}]. Bozuk/eksik → [] (kart ikiliye düşer). */
const MAX_CHOICES = 4;
function normalizeChoices(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((c) => c && typeof c === 'object' && c.id)
    .map((c) => ({ id: str(c.id, 32), label: str(c.label, 40) || str(c.id, 32) }))
    .slice(0, MAX_CHOICES);
}

/** Şekil toleransı: her zaman { turns: [], approvals: [] }. */
function normalizeState(raw) {
  const s = raw && typeof raw === 'object' ? raw : {};
  const turns = (Array.isArray(s.turns) ? s.turns : [])
    .filter((t) => t && typeof t === 'object' && (t.who === 'user' || t.who === 'jarvis'))
    .map((t) => ({
      id: str(t.id, 64) || newId('t'),
      who: t.who,
      // trim: yalnız-boşluk satır defteri kirletmesin (appendTurn onu boş sayar).
      text: str(t.text).trim(),
      // 'desktop' | 'mobile' — konuşmanın hangi uçtan geldiği (UI rozeti + audit).
      source: t.source === 'mobile' ? 'mobile' : 'desktop',
      action: t.action ? str(t.action, 200) : null,
      at: Number.isFinite(Number(t.at)) ? Number(t.at) : Date.now(),
    }))
    .slice(-MAX_TURNS);
  const approvals = (Array.isArray(s.approvals) ? s.approvals : [])
    .filter((a) => a && typeof a === 'object' && a.id)
    .map((a) => ({
      id: str(a.id, 64),
      title: str(a.title, 200) || 'Onay gerekiyor',
      detail: str(a.detail, 1000),
      source: a.source === 'mobile' ? 'mobile' : 'desktop',
      // open → henüz cevaplanmadı · allowed/denied/expired → KAPALI (iki uçta da kapanır)
      status: ['open', 'allowed', 'denied', 'expired'].includes(a.status) ? a.status : 'open',
      // ADP-322 — ÇOK SEÇENEKLİ kart (fan-out: Onayla / Tek ajan / Sen kendin yap / İptal).
      // Boşsa kart eski İKİLİ yüzeyini korur → mevcut onaylar (kill/spawn/click) REGRESYONSUZ.
      // Seçenekler DEFTERDE durur: telefon açılışta (GET /m/jarvis/history) aynı butonları çizer.
      choices: normalizeChoices(a.choices),
      // Verilen cevap (yalnız çok-seçenekli kartta anlamlı; ikili kartta null).
      choice: a.choice ? str(a.choice, 32) : null,
      at: Number.isFinite(Number(a.at)) ? Number(a.at) : Date.now(),
    }))
    .slice(-MAX_APPROVALS);
  return { version: STORE_VERSION, turns, approvals };
}

function loadState(homedir) {
  try {
    return normalizeState(JSON.parse(fs.readFileSync(convPath(homedir), 'utf8')));
  } catch {
    return normalizeState(null); // dosya yok / bozuk → boş defter (asla fırlatma)
  }
}

function saveState(state, homedir) {
  const clean = normalizeState(state);
  const file = convPath(homedir);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(clean, null, 2));
    renameWithRetrySync(tmp, file); // atomik: yarım JSON asla görünmez
  } catch {
    /* disk yazımı best-effort: konuşma bellekte YAŞAR, kalıcılık kaybı akışı bozmaz */
  }
  return clean;
}

/**
 * Tek yazarlı defter. Main süreçte bir kez kurulur; her mutasyon `onChange`
 * dinleyicilerine (renderer broadcast + mobil SSE) TEK bir olay verir.
 */
function createConversation({ homedir, log } = {}) {
  let state = loadState(homedir);
  const listeners = new Set();
  // Restart: bekleyen onayın CEVAP ALICISI (promise resolver) süreçle birlikte öldü →
  // onu "open" diye geri basmak yalan olur (basılsa da hiçbir şeyi çalıştıramaz).
  // Dürüst hâl: expired. Konuşma satırları KALIR (kısa geçmiş restart'ı atlatır).
  let expired = 0;
  for (const a of state.approvals) {
    if (a.status === 'open') {
      a.status = 'expired';
      expired++;
    }
  }
  if (expired) {
    state = saveState(state, homedir);
    if (log) log(`jarvis conv: ${expired} bekleyen onay restart'ta expired işaretlendi`);
  }

  const emit = (event) => {
    for (const cb of listeners) {
      try {
        cb(event);
      } catch (err) {
        if (log) log(`jarvis conv: dinleyici hatası: ${err.message}`);
      }
    }
  };

  const persist = () => {
    state = saveState(state, homedir);
  };

  return {
    /** Anlık defter (renderer hydrate — masaüstü paneli kendi tavanıyla kırpar). */
    snapshot: () => ({ turns: [...state.turns], approvals: [...state.approvals] }),

    /**
     * ADP-329 — SAYFA: son `limit` satır; `before=<turnId>` verilirse O SATIRDAN ÖNCEKİ
     * sayfa. Dönen `turns` HER ZAMAN eskiden yeniye sıralı (ekran olduğu gibi dizer).
     *
     * İmleç neden `id` (pane'lerdeki gibi `seq` değil): konuşma satırının zaten kalıcı,
     * tekil bir id'si var ve telefon onunla tekilleştirme yapıyor (ADP-317). İkinci bir
     * numaralandırma uydurmak iki gerçeğe yol açardı.
     *
     * Bilinmeyen imleç (satır defterden düşmüş) → BOŞ sayfa + hasMore:false. Sessizce
     * "en sondan" sayfalamak, telefona AYNI satırları ikinci kez yollamak olurdu.
     */
    page({ limit = PAGE_DEFAULT, before = null } = {}) {
      const raw = Number(limit);
      const n = Number.isFinite(raw) ? Math.min(PAGE_MAX, Math.max(1, Math.trunc(raw))) : PAGE_DEFAULT;
      let end = state.turns.length;
      if (before) {
        const i = state.turns.findIndex((t) => t.id === before);
        if (i < 0) return { turns: [], hasMore: false, firstId: null };
        end = i;
      }
      const start = Math.max(0, end - n);
      const turns = state.turns.slice(start, end).map((t) => ({ ...t }));
      return { turns, hasMore: start > 0, firstId: turns.length ? turns[0].id : null };
    },

    /** GET /m/jarvis/history'nin tek kaynağı: sayfa + AÇIK onaylar. */
    history(q = {}) {
      const p = this.page(q);
      return {
        turns: p.turns,
        approvals: state.approvals.filter((a) => a.status === 'open').map((a) => ({ ...a })),
        hasMore: p.hasMore,
        firstId: p.firstId,
      };
    },

    /** Bir konuşma satırı ekle. Aynı id ikinci kez gelirse YOK SAYILIR (echo koruması). */
    appendTurn(turn) {
      const t = normalizeState({ turns: [turn || {}] }).turns[0];
      if (!t.text) return null;
      if (state.turns.some((x) => x.id === t.id)) return null; // idempotent
      state.turns = [...state.turns, t].slice(-MAX_TURNS);
      persist();
      emit({ type: 'turn', turn: t });
      return t;
    },

    /** Onay kartı aç (hangi uçtan doğduğu fark etmez — İKİ uçta da görünür). */
    openApproval(approval) {
      const a = normalizeState({ approvals: [{ ...(approval || {}), status: 'open' }] }).approvals[0];
      if (!a || !a.id) return null;
      if (state.approvals.some((x) => x.id === a.id)) return null;
      state.approvals = [...state.approvals, a].slice(-MAX_APPROVALS);
      persist();
      emit({ type: 'approval', approval: a });
      return a;
    },

    /**
     * Onayı KAPAT. Tek kazanan kuralı: zaten kapalıysa `null` döner → ikinci uçtan
     * gelen cevap eylemi İKİNCİ KEZ ÇALIŞTIRAMAZ (çift onay yok).
     *
     * ADP-322 — `choice` (opsiyonel): çok-seçenekli kartta HANGİ çıkışın seçildiği
     * ('approve'|'single'|'self'|'cancel'). Tek-kazanan kapısından o da geçer, yani
     * telefondan "tek ajan yap" denince masaüstündeki kart aynı cevapla kapanır.
     * İkili kartlarda null → eski davranış birebir korunur.
     */
    closeApproval(approvalId, decision, choice) {
      const id = str(approvalId, 64);
      const a = state.approvals.find((x) => x.id === id);
      if (!a || a.status !== 'open') return null;
      const status = decision === 'allow' || decision === 'allowed' ? 'allowed'
        : decision === 'expired' ? 'expired'
          : 'denied';
      // Seçenek listesi VARSA yalnız listedeki bir id kabul edilir (uydurma seçim yok).
      const picked =
        choice && a.choices.some((c) => c.id === choice) ? str(choice, 32) : null;
      a.status = status;
      a.choice = picked;
      persist();
      emit({ type: 'approval-resolved', approvalId: id, status, choice: picked });
      return { ...a };
    },

    /** Açık (cevaplanmamış) onaylar — restart sonrası UI'ın yeniden basacağı kartlar. */
    openApprovals: () => state.approvals.filter((a) => a.status === 'open').map((a) => ({ ...a })),

    clear() {
      state = normalizeState(null);
      persist();
      emit({ type: 'cleared' });
    },

    onChange(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
}

module.exports = {
  MAX_TURNS,
  MAX_APPROVALS,
  PAGE_DEFAULT,
  PAGE_MAX,
  convPath,
  normalizeState,
  loadState,
  saveState,
  createConversation,
  newId,
};
