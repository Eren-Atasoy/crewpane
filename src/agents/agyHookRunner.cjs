#!/usr/bin/env node
// AGY-03 — ANTIGRAVITY HOOK SÜRECİ (iki olay, tek dosya).
//
// Çağrı (`hooks.json`tan, MUTLAK yollarla):
//   node agyHookRunner.cjs --event PreInvocation --home <crewpaneHome> --agent <liderId>
//   node agyHookRunner.cjs --event PreToolUse [--permissive]
//
// Sözleşme (motorun gömülü belgesi, `agy-customizations/docs/hooks.md`):
//   stdin  ← tek bir JSON gövde (camelCase — protojson)
//   stdout → tek bir JSON obje
//   `PreInvocation` : {"injectSteps":[{"ephemeralMessage":"…"}]}   (yoksa `{}`)
//   `PreToolUse`    : {"decision":"deny","reason":"…"} | {"decision":"allow"}
//
// ── NEDEN TEK DOSYA ──────────────────────────────────────────────────────────────
// claude tarafında iki ayrı dosya var (`leaderBriefingHook.cjs`, `killGuardHook.cjs`)
// çünkü orada kancalar AYRI settings girdilerinden koşuyor ve ikisi ayrı ADP'den geldi.
// Burada ikisi de AYNI demetten (`hooks.json`) koşuyor ve ikisi de aynı paketleme
// nöbetinden geçmek zorunda; ikinci bir dosya ikinci bir unpack riski demekti
// ([[ref_untracked_required_module_breaks_origin]] sınıfı: zincire girmeyen dosya
// paketli uygulamada require'da ölür ve kapı SESSİZCE kaybolur).
//
// 🔴 DAYANIKLILIK KURALI: bu süreç ajanın HER model çağrısını / HER araç çağrısını
// BLOKLAR. Hiçbir hata bir turu düşürmemeli → tüm gövde try/catch, EXIT HEP 0.
//
// 🔒 FAIL-CLOSED / FAIL-OPEN AYRIMI (bilerek asimetrik):
//   • BRİFİNG fail-OPEN'dır: okunamadıysa `{}` basılır, tur normal koşar. Brifing bir
//     kolaylıktır; kaybı işi durdurmaz.
//   • BLOK fail-OPEN'dır da — ve bu bir TERCİHTİR, kaza değil: gövdesi okunamayan bir
//     çağrıyı reddetseydik bozuk tek bir JSON pane'in TÜM araçlarını kilitlerdi. Kapının
//     SERT katmanı bu hook değil, `matcher`ın kendisidir: hook hiç koşmasa bile
//     alt-ajan araçları listede kalır — bu yüzden kayıp BEYANLIDIR (registry
//     `subagentBlock.via` + spawn logu), sessiz değil.
//   • 🔴 `decision` ZORUNLU — BOŞ `{}` ARACI DÜŞÜRÜR (ölçüldü: ilk sürüm izinli dalda
//     `{}` bastı ve MCP çağrısı `state:"ERROR"` oldu; transcript'e tool result hiç
//     düşmedi). Yani "karar basmamak" motorda "geç" değil "düştü" demek.
//     ⇒ Bir araca BAKIYORSAK ona bir cevap borçluyuz. `allow` yalnız `--permissive`
//       ile, yani pane otonomisi registry'de ZATEN `full` beyan edilmişken basılır
//       (`--dangerously-skip-permissions` + `permission_mode:"always-proceed"`);
//       orada yeni bir izin VERMEZ, beyan edileni tekrarlar. Bayrak yoksa
//       `call_mcp_tool` matcher'a hiç girmez (agyHooks.cjs tuzak C).

'use strict';

function readStdin() {
  return new Promise((resolve) => {
    let raw = '';
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve(raw);
    };
    try {
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (c) => { raw += c; });
      process.stdin.on('end', finish);
      process.stdin.on('error', finish);
    } catch {
      finish();
    }
  });
}

function emit(obj) {
  try {
    process.stdout.write(JSON.stringify(obj || {}));
  } catch {
    /* stdout kapandıysa yapacak bir şey yok — yine de EXIT 0 */
  }
}

async function main() {
  const hooks = require('./agyHooks.cjs');
  const ledger = require('./briefingLedger.cjs');
  const { home, agentId, event } = ledger.parseArgs(process.argv.slice(2));

  const raw = await readStdin();
  let payload = null;
  try {
    payload = JSON.parse(raw);
  } catch {
    payload = null;
  }

  if (event === 'PreToolUse') {
    // Gövde okunamadıysa karar BASMA (fail-open, yukarıdaki gerekçe).
    // `--permissive`: pane otonomisi registry'de `full` beyan edilmiş demektir —
    // izinli MCP dalında `allow` basılır. Bayrak YOKSA `call_mcp_tool` matcher'a
    // zaten girmez (agyHooks tuzak C), yani bu dal ulaşılmaz kalır.
    const permissive = process.argv.includes('--permissive');
    emit(payload ? hooks.preToolUseDecision(payload, { permissive }) : null);
    return;
  }

  if (event === 'PreInvocation') {
    // 🪤 ÖLÇÜLDÜ (agy 1.2.2): bu olay TUR başına değil MODEL ÇAĞRISI başına ateşler
    // (tek `-p` turunda invocationNum 0,1,2). Brifing yalnız İLKİNDE verilir; yoksa
    // aynı metin aynı turda üç kez bağlama girerdi.
    if (!agentId || !home || (payload && !hooks.isFirstInvocation(payload))) {
      emit({});
      return;
    }
    const pending = ledger.pendingFor(home, agentId);
    if (!pending.length) {
      emit({}); // BOŞ brifing basma (bağlam israfı + lideri "yeni bir şey var" diye yanıltır)
      return;
    }
    emit(hooks.injectStepsPayload(ledger.briefingText(pending)));
    // MAKBUZ — "lider bunu gördü": main bunu tüketip kaydı ack'ler, böylece aynı bitiş
    // bir de pane'e ENJEKTE edilmez (çift anlatım yasağı). claude yoluyla AYNI defter.
    ledger.commitReceipt(home, agentId, pending);
    return;
  }

  emit({}); // bilinmeyen olay → sessiz, zararsız
}

main()
  .catch(() => { try { process.stdout.write('{}'); } catch { /* yut */ } })
  .finally(() => process.exit(0));
