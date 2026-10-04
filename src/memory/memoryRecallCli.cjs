#!/usr/bin/env node
// CrewPane — ADP-862 (st1) HAFIZA ARAMA KOMUTU (ajanların kullandığı uç).
//
//     node electron/memoryRecallCli.cjs "elevenlabs ile ilgili ne biliyoruz"
// Çıktı: kaynak dosya + satır + alıntı. Hafızada yoksa "Hafızada bunu bulamadım." —
// UYDURMA YOK (ADP-871 alaka tabanı + bu katmanda boş-sonuç dürüstlüğü).
//
// ── ENG-06 — BU DOSYA ARTIK BİR ALIAS ──────────────────────────────────────────
// Arama mantığı `crewpaneCli.cjs`'in `memory recall` fiiline TAŞINDI (ENG-R3 §12
// Tier B: MCP'siz motorlar için tek köprü ikilisi, çok alt-komut). Bu script GERİYE
// UYUM için duruyor ve duracak: onu ÇAĞIRAN üç yer var (agentRunner'ın spawn kimliği,
// scripts/memoryContextMeasure.cjs, scripts/memoryRagTokenMeasure.cjs) ve hepsi onu
// bir SÜREÇ olarak koşuyor. Bu yüzden burada değişmemesi gereken tek şey KABUK
// SÖZLEŞMESİdir: aynı bayraklar, bayt-eş stdout/stderr, aynı çıkış kodları.
// (ENG-06 raporu §2 fix-öncesi/sonrası diff'i bunu ölçer.)
//
// ── NEDEN CLI'DA YALNIZ KELİME KATMANI ─────────────────────────────────────────
// Anlam katmanı 543 MB'lık bge-m3'ü yüklüyor; ilk yükleme ONLARCA saniye (ADP-870
// §4c). Bir CLI çağrısında bunu ödemek "hızlı bak" davranışını yok ederdi. Bu yüzden
// CLI kelime katmanıyla (FTS5/BM25, ~5 ms) koşar ve çıktısında `degraded` DER —
// sessizce yarım cevap vermez. Uygulama içi yüzeyler (hafıza sekmesi, sesli katman)
// main'deki sıcak gömme sürecini kullandığı için TAM hibrittir.
//
// Çıkış kodları: 0 = koştu (sonuç bulundu ya da dürüstçe bulunamadı) · 2 = ÖLÇEMEDİM
// (indeks yok / sqlite yok / workspace bulunamadı) — "sonuç yok" ile karıştırılmasın.

'use strict';

const cli = require('../agents/crewpaneCli.cjs');

function parseArgs(argv) {
  const out = { query: [], k: 5, json: false, workspace: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--json') out.json = true;
    else if (a === '--k') out.k = Number(argv[++i]) || 5;
    else if (a === '--workspace') out.workspace = argv[++i] || null;
    else if (a === '--help' || a === '-h') out.help = true;
    else out.query.push(a);
  }
  return { ...out, query: out.query.join(' ').trim() };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.query) {
    console.log('Kullanım: node electron/memoryRecallCli.cjs "<sorgu>" [--k 5] [--json] [--workspace <yol>]');
    process.exit(args.help ? 0 : 2);
  }

  const out = await cli.memoryRecall({ query: args.query, k: args.k, workspace: args.workspace });
  if (!out.ok) {
    console.error(`ÖLÇEMEDİM: ${out.reason}`);
    process.exit(2);
  }

  if (args.json) console.log(JSON.stringify(out.res, null, 2));
  else console.log(cli.renderRecallText(out.res));
  process.exit(0);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`ÖLÇEMEDİM: ${err.message}`);
    process.exit(2);
  });
}

// Geriye uyum: dışarıdan require eden testler/araçlar bu iki fiili bekliyor.
// `resolveWorkspace` artık köprünün tek kopyasıdır (iki tanım = iki farklı kök seçimi).
module.exports = { parseArgs, resolveWorkspace: cli.resolveWorkspace };
