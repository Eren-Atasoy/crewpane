#!/usr/bin/env node
// CrewPane — KILL-GUARD-01: claude'un `PreToolUse` kancasının ucu (KAPI 1).
//
// claude her Bash çağrısından ÖNCE bu süreci çalıştırır ve stdin'e olay JSON'unu
// yazar. Biz komutu `killGuard.cjs`e sorar, "hayır" cevabını claude'un ANLADIĞI
// biçimde geri veririz — komut kabuğa HİÇ ULAŞMAZ.
//
// Çağrı:  node killGuardHook.cjs
// Girdi:  stdin ← {"hook_event_name":"PreToolUse","tool_name":"Bash",
//                  "tool_input":{"command":"killall CrewPane"}}
// Çıktı:  stdout → {"hookSpecificOutput":{"hookEventName":"PreToolUse",
//                   "permissionDecision":"deny","permissionDecisionReason":"…"}}
//         EXIT her zaman 0 (ret KARARLA bildirilir, çökmeyle değil).
//
// 🔴 DAYANIKLILIK KURALI (leaderBriefingHook.cjs ile aynı): bu süreç ajanın HER
// ARAÇ ÇAĞRISINI bloklar. Bir hata/bozuk JSON aracı ASLA düşürmemeli → tüm gövde
// try/catch, karar veremezsek SESSİZCE GEÇ. Fail-open bilinçli: bu bir kaza duvarı;
// kendi arızası yüzünden bütün ajanları çalışamaz hâle getirmesi daha kötüdür.
// (Fail-CLOSED olan yer sarmalayıcıdır — orada yalnız `killall`/`pkill` etkilenir.)

'use strict';

function readStdin() {
  const fs = require('node:fs');
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function main() {
  const guard = require('./killGuard.cjs');
  if (!guard.isEnabled(process.env)) return; // KILL-SWITCH: CREWPANE_KILL_GUARD=0

  let evt = null;
  try {
    evt = JSON.parse(readStdin());
  } catch {
    return; // olayı okuyamadık → aracı bloklamayız
  }
  if (!evt || typeof evt !== 'object') return;

  // Yalnız kabuk yüzeyi ilgilendirir. Başka araç adları (Read/Edit/…) dokunulmadan geçer.
  const tool = String(evt.tool_name || '');
  if (!/^(Bash|BashOutput)$/i.test(tool)) return;

  const input = evt.tool_input && typeof evt.tool_input === 'object' ? evt.tool_input : {};
  const command = typeof input.command === 'string' ? input.command : '';
  if (!command.trim()) return;

  const ctx = guard.contextFromEnv(process.env);
  // LAUNCH-GUARD-01 (R8) — CANLILIK YALNIZ NİYET VARSA ÖLÇÜLÜR. Bu kanca her Bash
  // çağrısında koşuyor; desen eşleşmesi saf ve bedavadır, ölçüm ise nadir yolda.
  if (!ctx.allowLive && guard.hasLaunchIntent(command)) {
    ctx.installedAppAlive = guard.installedAppAlive({ env: process.env });
  }
  const verdict = guard.inspectCommand(command, ctx);
  if (verdict.allowed) return;

  process.stdout.write(
    `${JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: guard.denyMessage(verdict),
      },
    })}\n`,
  );
}

try {
  main();
} catch {
  /* sessiz: kapının kendi hatası ajanı durdurmaz */
}
process.exit(0);
