// TOKEN-BUDGET-01 — "BU PANE'İN SABİT YÜKÜ ~N JETON" (kullanıcıya görünür rakam).
//
// NİÇİN VAR. Bir pane'in her isteğinde taşıdığı sabit yük bugüne kadar görünmezdi;
// karar ("hafızayı kısalım mı", "şu MCP'yi kapatalım mı") hep sezgiyle veriliyordu.
// Bu modül o rakamı pane açılışında görünür kılar.
//
// 🔴 BU BİR TAHMİNDİR VE ÖYLE SÖYLER. Gerçek ölçüm bir model çağrısı ister
// (`npm run token:budget`, ~$0,15 ve ~2 dakika); her pane açılışında bunu yapmak
// saçma olurdu. Bunun yerine ÖLÇÜLMÜŞ sabitler (docs/token-budget-calibration.json)
// kullanılır ve çıktı "~" ile işaretlenir. Kalibrasyon dosyası yoksa ya da motor
// sürümü değiştiyse rakam yine verilir ama "kalibrasyon eski" notuyla — sessizce
// yanlış sayı göstermek, sayı göstermemekten kötüdür.
//
// Kalibrasyonun ÖLÇÜLDÜĞÜ koşullar (2026-09-09, claude 2.1.265, haiku kolu, n=1,
// gerçek worker pane argv'si):
//   TAM PANE 40.950 · motor tabanı 15.501 · hafıza indeksi 10.185 ·
//   proje talimatları 6.824 · bizim sistem promptumuz 5.460 · MCP 2.781 · skill 199
// Bağlam-kapsamı kesiminden SONRA aynı pane: 29.618 (−%27,5).

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CALIBRATION_FILE = path.join(__dirname, '..', 'docs', 'token-budget-calibration.json');

/** Kalibrasyon okunamazsa kullanılan taban değerler (ÖLÇÜLDÜ, yukarıdaki koşullar). */
const FALLBACK = Object.freeze({
  engineFloorTokens: 15501,
  identityCharsPerToken: 2.28,
  memoryIndexCharsPerToken: 2.41,
  projectDocCharsPerToken: 2.31,
  mcpTokensPerServer: 1390,
  skillCatalogTokens: 199,
  measuredAt: '2026-09-09',
  engineVersion: '2.1.265 (Claude Code)',
});

function readCalibration(file) {
  try {
    const j = JSON.parse(fs.readFileSync(file || CALIBRATION_FILE, 'utf8'));
    return { ...FALLBACK, ...j };
  } catch {
    return { ...FALLBACK, stale: 'kalibrasyon dosyası yok' };
  }
}

function sizeOf(p) {
  try {
    return fs.statSync(p).size;
  } catch {
    return 0;
  }
}

/**
 * Bir pane'in sabit yükü — kalem kalem TAHMİN.
 *
 * @param {object} o
 * @param {string} [o.identityText]  bu pane'e giden kimlik metni (varsa)
 * @param {number} [o.identityChars] metin yerine yalnız uzunluk
 * @param {string} [o.cwd]           pane'in çalışma dizini
 * @param {string} [o.workspaceRoot] çalışma alanı kökü (kapsam sınırı)
 * @param {string[]} [o.mcpConfigs]  bu pane'e verilen MCP config dosyaları
 * @param {boolean} [o.contextScoped] bağlam-kapsamı kesimi uygulandı mı
 * @returns {{ total:number, rows:Array, lines:string[], summary:string, calibration:object }}
 */
function estimatePaneFixedLoad(o = {}) {
  const cal = readCalibration(o.calibrationFile);
  const rows = [];
  const push = (label, tokens, note) => {
    if (tokens > 0) rows.push({ label, tokens: Math.round(tokens), note: note || '' });
  };

  push('motor tabanı (sistem promptu + gömülü araçlar)', cal.engineFloorTokens, 'kapatılamaz');

  const idChars = typeof o.identityChars === 'number' ? o.identityChars : (o.identityText || '').length;
  push('kimlik + protokol + hafıza bloğu', idChars / (cal.identityCharsPerToken || 2.28), 'CrewPane');

  // Proje talimatları: kapsam açıkken YALNIZ çalışma alanı içi, kapalıyken kök'e kadar.
  if (o.cwd) {
    const scope = require('./paneContextScope.cjs');
    const docs = o.contextScoped
      ? scope.projectDocChain(o.cwd, o.workspaceRoot || o.cwd, 'CLAUDE.md')
      : scope.projectDocChain(o.cwd, null, 'CLAUDE.md');
    const chars = docs.reduce((s, p) => s + sizeOf(p), 0);
    push(`proje talimatları (${docs.length} dosya)`, chars / (cal.projectDocCharsPerToken || 2.31));

    const idx = path.join(
      o.homedir || os.homedir(),
      '.claude',
      'projects',
      scope.cwdSlug(o.cwd),
      'memory',
      'MEMORY.md',
    );
    const idxChars = sizeOf(idx);
    if (idxChars) {
      // MEM-SCOPE-01 — GÖRÜNÜRLÜK: rakam artık SABİT BİR TAVANDAN değil, o pane'e
      // GERÇEKTEN örülecek bloktan gelir ve kaç kayıt taşındığını SAYIYLA söyler.
      // 🪤 Eski satır `min(idxChars, 1600)` diyordu; kesim kural bölümünü koşulsuz
      //    taşıdığı için bu tahmin artık gerçeğin YARISINI bile göstermezdi.
      let carried = idxChars;
      let note = 'TAM BOY';
      // 🔑 EN DOĞRU KAYNAK: o pane'e GERÇEKTEN örülen bloğun künyesi. Kapsam kolu
      //    (`CREWPANE_MEMORY_SCOPE`) pane'e göre değişebilir; burada yeniden plan
      //    üretmek, `trim` ile açılmış bir pane'e `full` rakamı göstermek olurdu.
      const fact = (o.scopeItems || []).find((i) => i && i.kind === 'memoryIndex') || null;
      if (o.contextScoped && fact && fact.chars > 0) {
        carried = fact.chars;
        note =
          `hafıza: ${fact.shown}/${fact.total} kayıt taşınıyor` +
          (fact.mode ? ` (${fact.mode})` : '');
      } else if (o.contextScoped) {
        try {
          const plan = require('../agents/engineMemoryScope.cjs').planMemoryIndex({
            indexPath: idx,
            env: o.env || {},
            cliPath: null,
          });
          if (plan && plan.text) {
            carried = plan.text.length;
            note =
              `hafıza: ${plan.stats.carried}/${plan.stats.total} kayıt taşınıyor ` +
              `(${plan.stats.rules} kural + ${plan.stats.selected} seçki; kalanı aranabilir)`;
          }
        } catch {
          // Plan üretilemedi → eski tahmine düş, ama bunu SÖYLE (sessiz yanlış sayı yok).
          carried = Math.min(idxChars, scope.MEMORY_SELECTION_CHARS);
          note = `seçki (tam indeks ${Math.round(idxChars / 1024)} KB · kapsam planı okunamadı)`;
        }
      }
      push('kalıcı hafıza indeksi', carried / (cal.memoryIndexCharsPerToken || 2.41), note);
    }
  }

  const mcpCount = Array.isArray(o.mcpConfigs) ? o.mcpConfigs.length : 0;
  if (mcpCount) push(`MCP araç şemaları (${mcpCount} sunucu)`, mcpCount * (cal.mcpTokensPerServer || 1390));
  push('skill kataloğu', cal.skillCatalogTokens);

  const total = rows.reduce((s, r) => s + r.tokens, 0);
  const lines = rows.map((r) => `${r.label}: ~${r.tokens.toLocaleString('tr-TR')}${r.note ? ` (${r.note})` : ''}`);
  return {
    total,
    rows,
    lines,
    summary:
      `bu pane'in sabit yükü ~${total.toLocaleString('tr-TR')} jeton/istek` +
      (cal.stale ? ' (kalibrasyon eski)' : ''),
    calibration: cal,
  };
}

module.exports = { estimatePaneFixedLoad, readCalibration, CALIBRATION_FILE, FALLBACK };
