// AD-001 spike — RENDERER (xterm.js UI). No Node access here; the only bridge
// to the OS is window.ptyApi (from preload). UMD globals: Terminal, FitAddon.

(function () {
  console.log('renderer boot: Terminal=' + typeof window.Terminal + ' FitAddon=' + typeof window.FitAddon + ' ptyApi=' + typeof window.ptyApi);
  const TerminalCtor = window.Terminal;
  const FitAddonCtor = (window.FitAddon && window.FitAddon.FitAddon) || window.FitAddon;

  const term = new TerminalCtor({
    fontFamily: 'ui-monospace, Menlo, monospace',
    fontSize: 13,
    cursorBlink: true,
    theme: { background: '#0d0f17', foreground: '#d7dcff', cursor: '#7c8cff' },
  });
  const fit = new FitAddonCtor();
  term.loadAddon(fit);
  term.open(document.getElementById('terminal'));
  fit.fit();

  const isAutotest = new URLSearchParams(location.search).get('autotest') === '1';

  // ADP-003: the pty API is now paneId-keyed. This single-terminal spike owns
  // exactly one pane; capture its id on spawn and filter events to it.
  let myPaneId = null;

  // pty output → xterm. In autotest, also echo back to main as round-trip proof.
  let renderedBuf = '';
  window.ptyApi.onData(({ paneId, data }) => {
    if (myPaneId && paneId !== myPaneId) return;
    term.write(data);
    if (isAutotest) {
      renderedBuf += data;
      window.spikeProbe.rendered(data);
    }
  });

  // keyboard / paste → pty
  term.onData((data) => { if (myPaneId) window.ptyApi.write(myPaneId, data); });

  // resize: xterm fit → pty.resize
  function doResize() {
    fit.fit();
    if (myPaneId) window.ptyApi.resize(myPaneId, { cols: term.cols, rows: term.rows });
  }
  window.addEventListener('resize', doResize);

  window.ptyApi.onExit(({ paneId, code }) => {
    if (myPaneId && paneId !== myPaneId) return;
    term.write(`\r\n\x1b[33m[pty exited: ${code}]\x1b[0m\r\n`);
    if (isAutotest) {
      const ok = renderedBuf.includes('SPIKE_PTY_OK');
      window.spikeProbe.done({
        roundTripOk: ok,
        exitCode: code,
        renderedBytes: renderedBuf.length,
        cols: term.cols,
        rows: term.rows,
      });
    }
  });

  (async () => {
    const info = await window.ptyApi.spawn({ cols: term.cols, rows: term.rows });
    myPaneId = info.paneId;
    term.focus();

    if (isAutotest) {
      // Drive the full path automatically: input → pty → output → render.
      // Print a sentinel, show which agent CLIs are reachable, then exit.
      const cmd =
        'echo "SPIKE_PTY_OK pid=' + info.pid + '"; ' +
        'echo "shell=$0"; ' +
        'command -v claude codex zsh 2>/dev/null; ' +
        // Actually EXECUTE an agent CLI inside the pty (real run, not just lookup).
        'claude --version 2>/dev/null && echo "CLAUDE_RAN_OK"; ' +
        'exit\n';
      // small delay so the shell prompt is ready
      setTimeout(() => window.ptyApi.write(myPaneId, cmd), 600);
    }
  })();
})();
