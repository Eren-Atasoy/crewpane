// ADP-888 (ADP-885 Faz A) — ANA SÜREÇ İngilizce sözlüğü = SÖZLEŞME.
//
// AYRI SÖZLÜK, ÇÜNKÜ AYRI SÜREÇ: menü/diyalog/bildirim renderer'ın React ağacında
// DEĞİL (`dialog.showOpenDialog`, `new Notification`). Main, renderer daha hiç
// açılmadan diyalog gösterebilir (çökme bildirimi, lisans hatası) — bu yüzden
// kendi sözlüğünü kendisi okur (ADP-885 §3.2/2).
//
// `main.*` kökü BİLEREK renderer sözlüğünde YOK: iki dosyanın anahtar uzayı
// kesişmez, biri diğerinden metin ödünç almaz.

'use strict';

module.exports = {
  'main.dialog.openFolder.title': 'Open Folder',
  'main.dialog.chooseWorkspace.title': 'Choose Workspace',
  'main.dialog.chooseWorkspace.button': 'Use This Folder',
  'main.dialog.switchWorkspace.title': 'Change Workspace',

  'main.notify.crashLoop.title': 'CrewPane crashed repeatedly',
  'main.notify.crashLoop.body':
    'The window gave up on automatic recovery. Restart the app - your agents keep running in the background.',
  'main.notify.screenshotsMoved.title': 'Screenshots now live in AgentShot',
  'main.notify.screenshotsMoved.body':
    'Cmd+Shift+2 and the gallery moved to the AgentShot app; your old captures are in the AgentShot gallery.',


  // HATA-03 — tek-örnek kilidi ikinci kopya diyalogu. `detail` sonundaki cumle
  // ONEMLI: kilit onceki oturumdan kalmis olabilir ve kullanicinin cikisi vardir.
  'main.singleInstance.title': 'CrewPane is already open',
  // WIN-DUP-INSTANCE-01 - honest copy: no "brought to front" (that happens on
  // "Close") and no "no window? choose Open anyway" (that sentence steered users
  // into a second copy whenever the window was closed but the process alive -
  // the normal state after X on Windows, HATA-14; FB-1012 had 7 copies).
  'main.singleInstance.message': 'CrewPane is already running - this second copy did not open.',
  'main.singleInstance.detail':
    'Two copies cannot share the same data folder.{who}\n'
    + 'Press "Close" to bring the running CrewPane to the front; if its window is closed, it reopens.\n\n'
    + '"Open anyway" runs two copies at once: you may be signed out, and your phone link and '
    + 'agent tasks get split between the copies. Choose it only if you are sure no CrewPane is open.',
  'main.singleInstance.button.close': 'Close',
  'main.singleInstance.button.openAnyway': 'Open anyway',
  // WIN-DUP-INSTANCE-01 - "Open anyway" needs EXPLICIT consent: second box, default "Cancel".
  'main.singleInstance.confirm.title': 'Two copies of CrewPane will run at once',
  'main.singleInstance.confirm.message': 'Open this copy without closing the running CrewPane first?',
  'main.singleInstance.confirm.detail':
    'With two copies running you may be signed out, your phone link can drop and your agent tasks '
    + 'get split between the copies.\n\nTry "Cancel" and close the running CrewPane first.',
  'main.singleInstance.confirm.button.cancel': 'Cancel',
  'main.singleInstance.confirm.button.yes': 'Yes, open anyway',
  // WIN-DUP-INSTANCE-01 - when the guard could NOT be set up (data folder not
  // writable) the app no longer opens silently: the user confirms.
  'main.singleInstance.degraded.title': 'Single-copy protection could not be set up',
  'main.singleInstance.degraded.message': 'CrewPane could not set up the guard that stops a second copy from opening at the same time.',
  'main.singleInstance.degraded.detail':
    'The data folder may not be writable (read-only or a permission problem).\n'
    + 'If another CrewPane is open, the two copies can corrupt each other\'s data.\n\n'
    + 'Choose "Open anyway" only if you are sure no CrewPane is open; otherwise "Close".',
  // ENV-08 - third button: the second copy relaunches into its own world
  // (--instance=test) without touching the owner's data root.
  'main.singleInstance.button.separateProfile': 'Open with a separate test profile',

  // ENV-08 (d) - transient location (AppTranslocation / DMG) notice.
  'main.translocation.title': 'CrewPane is running from a temporary location',
  'main.translocation.message': 'The app was opened from the DMG or from macOS\'s translocated (temporary) copy.',
  'main.translocation.detail':
    'This location is not permanent; updates and data are unreliable from here.\n\n'
    + 'Move CrewPane to the Applications folder and open it from there. If this copy '
    + 'is only for testing, choose "Restart with a separate test profile" - it will not touch your real data.',
  'main.translocation.button.ok': 'Got it',
  'main.translocation.button.separateProfile': 'Restart with a separate test profile',

  'main.error.seatNotReady': 'License check is not ready yet - try again in a few seconds.',
  // WIN-DUP-INSTANCE-01 (FB-1012) - phone wizard: when the port is taken the reason
  // is SAID (no internals: no port number, no error code).
  'main.mobile.portInUse': 'Another CrewPane is open on this computer and is holding the connection - close it and try again.',
  'main.mobile.startFailed': 'The phone link could not start - restart the app and try again.',

  // RESET-03 - command-line reset (--reset) and the startup notice.
  // These are MAIN's own boxes; the in-app dialog lives in RESET-02's dictionary.
  // No file name, folder path or error code in user text ([[feedback_ui_copy_no_internals]]).
  'main.reset.badLevel.title': 'Reset command not understood',
  'main.reset.badLevel.detail': 'Valid use: --reset (everything) or --reset=session (session only). Nothing was deleted.',
  'main.reset.locked.title': 'CrewPane is open',
  'main.reset.locked.message': 'CrewPane must be closed before it can be reset.',
  'main.reset.locked.detail': 'Close the open CrewPane window, then run this command again.',
  'main.reset.confirm.title': 'Reset this installation',
  'main.reset.confirm.message': 'The office, agents, memory, saved keys and session on this computer will be deleted.',
  'main.reset.confirm.detail':
    'Your account and plan stay with CrewPane; the sign-ins of tools like Claude/Codex and '
    + 'your project folders are left untouched.\n\nThis cannot be undone.',
  'main.reset.confirm.button.yes': 'Yes, reset',
  'main.reset.confirm.button.cancel': 'Cancel',
  'main.reset.session.message': 'The session on this computer will be deleted; the office, agents and memory stay.',
  'main.reset.partial.title': 'Reset did not finish',
  'main.reset.partial.message': 'Some files could not be deleted.',
  'main.reset.partial.detail': 'Close CrewPane and open it again - the remaining files are deleted on the next start.',
  'main.reset.partial.button.ok': 'OK',

  // WIN-FIRSTRUN-01 (K1) — Windows shell prerequisite: guidance pane banner.
  'main.pane.shellMissing.title': '{label} could not start on this computer',
  'main.pane.shellMissing.body':
    '{label} needs Git for Windows to run on Windows, and it was not found on this computer. '
    + 'Install Git for Windows from the address below (the default options are fine):',
  'main.pane.shellMissing.after': 'When the install finishes, press "Retry" in this window.',

  // ENG-OPENCODE-PROVIDER-01 — model pre-validation gate: the engine was NOT started.
  'main.pane.modelGate.title': 'Agent not started with {model}',
  'main.pane.modelGate.notListed':
    "'{model}' is not in the {label} model list on this computer. Check the output of `opencode models` in a terminal; "
    + 'a misspelled name can silently send your code to a different provider — that is why the agent was not started.',
  'main.pane.modelGate.internetHttp':
    "The provider for '{model}' points to an unencrypted internet address (http://{host}). Code and prompts would travel in plain text; "
    + 'CrewPane does not accept this. Switch the address to https:// or move the server onto your own network.',
  'main.pane.modelGate.lanHttpNeedsAck':
    "The provider for '{model}' points to an unencrypted address on your local network (http://{host}). If this server is on your own network "
    + 'and you accept the unencrypted connection, set `{setting}` to true in CrewPane settings. Remember: on shared Wi-Fi your code travels in plain text.',
  'main.pane.modelGate.unreachable':
    "The provider address for '{model}' did not answer within {timeout} seconds: {url} ({error}). The engine would have retried silently for minutes, "
    + 'so the agent was not started. Check that the server is running and reachable from this computer.',
  'main.pane.modelGate.invalidUrl':
    "The provider address for '{model}' is invalid ({url}). Fix the baseURL line in opencode.json.",
  'main.pane.modelGate.guide': 'Guide to connecting your own model: {guide}',
  'main.pane.modelGate.after': 'After fixing it, restart the agent.',

  // WIN-FIRSTRUN-01 (K2) — closing line written into the pane of an engine that died at startup.
  'main.pane.earlyExit.line': 'The engine closed right after starting - the lines above are the last thing it said.',
  'main.pane.earlyExit.silent': 'The engine closed right after starting without writing anything.',

  // ENG-OPENCODE-DB-01 (C4) — the agent's second window opened with its own database;
  // no internals (file path/env name), only what happened.
  'main.pane.isolationTwin.line': 'Another window of this agent is already open - this window opened with a separate database; the earlier conversation is in the other window.',

  // ASK-CARD-01 — leader's decision question mirrored into the Agent X approval card (desktop + phone).
  'main.ask.title': '{agent} is waiting for your decision',
};
