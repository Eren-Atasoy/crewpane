#!/usr/bin/env node
// CrewPane — ADP-692: liderin `UserPromptSubmit` hook'u (KANAL A'nın ucu).
//
// Kullanıcı liderin composer'ına yazıp ENTER'a BASTIKTAN SONRA çalışır. Bekleyen
// delegasyon bitişlerini main'in kalıcı defterinden okur ve turun bağlamına ekler.
// Composer'a HİÇBİR ŞEY yazmaz, hiçbir tuş simüle etmez → kullanıcının metnine
// dokunulması YAPISAL OLARAK imkânsızdır (ADP-667 nöbetçisinin mikro-yarışı burada yok).
//
// Çağrı:  node leaderBriefingHook.cjs --home <crewpaneHome> --agent <leaderId>
// Çıktı:  stdout'a `{"hookSpecificOutput":{…,"additionalContext":"…"}}` (bekleyen yoksa
//         HİÇBİR ŞEY) · her hâlükârda EXIT 0.
//
// 🔴 DAYANIKLILIK KURALI: bu süreç liderin HER TURUNU BLOKLAR. Bir hata, bozuk JSON ya
// da eksik dosya liderin prompt'unu ASLA düşürmemeli → tüm gövde try/catch, exit hep 0,
// stderr'e bile yazmayız (claude hook stderr'ini kullanıcıya gösterebilir).

'use strict';
function main() {
  // AGY-03 — defter/makbuz IO'su `briefingLedger.cjs`e taşındı: aynı brifingi artık
  // antigravity `PreInvocation` kancası da okuyor ve iki motorun AYNI deftere bakıp
  // AYNI makbuzu yazması ŞART (yoksa lider aynı bitişi iki kez okur ya da hiç okumaz).
  // Bu dosyada yalnız claude'un ZARFİ kalır — davranış bit-bit aynıdır.
  const ledger = require('./briefingLedger.cjs');
  const briefing = require('./leaderBriefing.cjs');

  const { home, agentId } = ledger.parseArgs(process.argv.slice(2));
  if (!agentId || !home) return;

  const pending = ledger.pendingFor(home, agentId);
  if (pending.length === 0) return; // BOŞ brifing basma (bağlam israfı + yanıltıcı)

  process.stdout.write(`${JSON.stringify(briefing.hookPayload(ledger.briefingText(pending)))}\n`);

  ledger.commitReceipt(home, agentId, pending);
}

try {
  main();
} catch {
  /* hook bir turu ASLA düşürmez */
}
process.exit(0);
