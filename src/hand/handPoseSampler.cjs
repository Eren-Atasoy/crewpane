// electron/handPoseSampler.cjs — HAND-G4: POZ ÖRNEKLEYİCİ + KANYON KARŞILAŞTIRICI.
//
// "Benim elimde çalışmıyor" sınıfının çözümü eşik oynatmak DEĞİL, ölçüm aracı +
// protokoldür. barehands'in en değerli katkısı kodu değil YÖNTEMİ (AGPL: satır
// alınmaz, yöntem serbest): doğru pozu örnekle · taklitçi pozu örnekle ·
// ÖRTÜŞMEYEN metriği (kanyonu) bul · kesimi kanyonun ORTASINDAN öner.
//
// GİZLİLİK SINIRI (R1 §5.4): burada KARE de LANDMARK da tutulmaz. Yalnız
// aşağıdaki kapalı listedeki SAYILAR toplanır; katalog dışı her alan düşer.
// Bu bir yorum değil kapı: `push()` beyaz listeden geçmeyeni almaz.
//
// Saf ve DI'lı (saat dışarıdan) — `node --test` doğrudan yükler, Electron YOK.

'use strict';

/** Kapı metriklerinin KAPALI LİSTESİ (tasarım §7). Sıra ekranda da bu sıradır. */
const POSE_METRICS = Object.freeze([
  'pinchIndex',
  'pinchMiddle',
  'pinky',
  'scale',
  'backMean',
  'indexArch',
  'aspect',
  'twoFingers',
  'fps',
]);

/** Sayıya çevir; çevrilemiyorsa null (örneğe GİRMEZ). `twoFingers` gibi mandal
 *  alanları 0/1 olur — oranı ("karelerin %62'sinde iki parmak") okunabilsin. */
function numeric(v) {
  if (typeof v === 'boolean') return v ? 1 : 0;
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function median(sorted) {
  const n = sorted.length;
  if (!n) return 0;
  const mid = n >> 1;
  return n % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

const round3 = (v) => Math.round(v * 1000) / 1000;

/**
 * Sabit süreli poz örnekleyici. `push()` her karede çağrılır; `done` olunca
 * çağıran durur ve `summary()` okur.
 */
class PoseSampler {
  /** @param {object} o { ms: süre, now: () => ms saat } */
  constructor({ ms = 4000, now = () => Date.now() } = {}) {
    this.ms = ms;
    this._now = now;
    this.startedAt = now();
    /** metrik → değer dizisi (yalnız sayılar). */
    this.values = new Map();
    this.frames = 0;
  }

  get elapsed() { return this._now() - this.startedAt; }
  get progress() { return Math.max(0, Math.min(1, this.elapsed / this.ms)); }
  get done() { return this.elapsed >= this.ms; }

  /** Bir karenin metriklerini al. Katalog dışı alanlar ve sayı olmayanlar DÜŞER. */
  push(frame) {
    if (!frame || typeof frame !== 'object') return;
    this.frames += 1;
    for (const key of POSE_METRICS) {
      const v = numeric(frame[key]);
      if (v === null) continue;
      let arr = this.values.get(key);
      if (!arr) { arr = []; this.values.set(key, arr); }
      arr.push(v);
    }
  }

  /** Her metrik için min/medyan/maks/n + toplam kare ve efektif fps. */
  summary() {
    const metrics = {};
    for (const key of POSE_METRICS) {
      const arr = this.values.get(key);
      if (!arr || !arr.length) continue; // ÖRNEK YOKSA SATIR YOK (uydurma sayı yasak)
      const sorted = [...arr].sort((a, b) => a - b);
      metrics[key] = {
        min: round3(sorted[0]),
        med: round3(median(sorted)),
        max: round3(sorted[sorted.length - 1]),
        n: sorted.length,
      };
    }
    const secs = Math.max(this.elapsed, 1) / 1000;
    return { ms: this.ms, frames: this.frames, fps: Math.round((this.frames / secs) * 10) / 10, metrics };
  }
}

/**
 * İki poz örneğini metrik metrik karşılaştır. Kanyon = bantların HİÇ örtüşmediği
 * metrik; kesim kanyonun ORTASI. Öneri UYGULANMAZ, gösterilir (karar insanda).
 *
 * @returns {{metrics: object, canyons: string[]}} `canyons` ayırma gücüne göre sıralı.
 */
function compareSamples(a, b) {
  const am = (a && a.metrics) || {};
  const bm = (b && b.metrics) || {};
  const metrics = {};
  const ranked = [];
  for (const key of POSE_METRICS) {
    const A = am[key];
    const B = bm[key];
    if (!A || !B) continue; // tek örnekte olan metrik karşılaştırmaya GİRMEZ
    const lower = A.max <= B.max ? 'a' : 'b';
    const lo = lower === 'a' ? A : B;
    const hi = lower === 'a' ? B : A;
    // SINIRA DEĞMEK ÖRTÜŞMEDİR: eşit uçlarda kanyon yoktur (bir tek kare bile
    // iki bandı birleştiriyorsa o metrik güvenli bir kapı değildir).
    const gap = hi.min - lo.max;
    const canyon = gap > 0;
    metrics[key] = {
      a: { min: A.min, med: A.med, max: A.max, n: A.n },
      b: { min: B.min, med: B.med, max: B.max, n: B.n },
      canyon,
      gap: round3(gap),
      lower,
      cut: canyon ? round3((lo.max + hi.min) / 2) : null,
      // Ayırma gücü: boşluğun iki bandın toplam genişliğine oranı — "0,1'lik
      // boşluk" dar bir metrikte büyük, geniş bir metrikte önemsizdir.
      power: canyon ? round3(gap / Math.max(1e-9, (A.max - A.min) + (B.max - B.min) + gap)) : 0,
    };
    if (canyon) ranked.push([key, metrics[key].power]);
  }
  ranked.sort((x, y) => y[1] - x[1]);
  return { metrics, canyons: ranked.map(([k]) => k) };
}

module.exports = { PoseSampler, compareSamples, POSE_METRICS };
