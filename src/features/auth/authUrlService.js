'use strict';

/**
 * Authentication Deep Link & OS URL Routing Service (Faz 3.6.36)
 * Encapsulates scheme validation, queueing pending auth callbacks,
 * Windows argv deep linking, and automated session auth blocks.
 */

const defaultDeepLinkArgv = require('../../services/deepLinkArgv.cjs');
const defaultAppScheme = require('../../core/appScheme.cjs');

class AuthUrlService {
  constructor(deps = {}) {
    this.deps = deps;
    this.app = deps.app;
    this.appUrlPrefix = deps.appUrlPrefix || '';
    this.getSeatGate = deps.getSeatGate || (() => null);
    this.isAutomatedSession = Boolean(deps.isAutomatedSession);
    this.automatedSessionReason = deps.automatedSessionReason || '';
    this.logLine = deps.logLine || (() => {});
    this.deepLinkArgv = deps.deepLinkArgv || defaultDeepLinkArgv;
    this.appScheme = deps.appScheme || defaultAppScheme;

    this.pendingAuthUrls = [];
    this.schemeVerdict = null;
    this._deepLinkConsumer = null;

    if (this.app && typeof this.app.on === 'function' && deps.registerListener !== false) {
      this.registerOpenUrlListener();
    }
  }

  handleAuthUrl(url) {
    if (typeof url !== 'string' || !url) return;
    if (!url.toLowerCase().startsWith(this.appUrlPrefix.toLowerCase())) {
      this.logLine(`⛔ giriş dönüşü YOKSAYILDI — şema eşleşmedi (beklenen ${this.appUrlPrefix}, `
        + `gelen ${url.split('?')[0]})`);
      return;
    }
    const seatGate = this.getSeatGate();
    if (!seatGate) {
      this.pendingAuthUrls.push(url);
      return;
    }
    seatGate.handleUrl(url).catch((e) => this.logLine(`seatGate handleUrl error: ${e.message}`));
  }

  drainPendingAuthUrls() {
    while (this.pendingAuthUrls.length) {
      this.handleAuthUrl(this.pendingAuthUrls.shift());
    }
  }

  osAuthUrlBlockedReason(url) {
    const isPackaged = this.app ? this.app.isPackaged : false;
    if (isPackaged && this.isAutomatedSession
        && process.env.CREWPANE_E2E_ALLOW_AUTH_URL !== '1'
        && String(url || '').startsWith(this.appUrlPrefix)) {
      return `otomasyon oturumu (${this.automatedSessionReason})`;
    }
    return null;
  }

  consumeArgvDeepLink(argv, source) {
    if (!this._deepLinkConsumer) {
      this._deepLinkConsumer = this.deepLinkArgv.createDeepLinkConsumer({
        prefix: () => this.appScheme.appSchemePrefix(),
        deliver: (url) => this.handleAuthUrl(url),
        blocked: (url) => this.osAuthUrlBlockedReason(url),
        log: (line) => this.logLine(line),
        defer: setImmediate,
      });
    }
    return this._deepLinkConsumer(argv, source);
  }

  registerOpenUrlListener() {
    this.app.on('open-url', (event, url) => {
      event.preventDefault();
      this.logLine(`open-url: ${String(url).split('?')[0]}`);
      const blocked = this.osAuthUrlBlockedReason(url);
      if (blocked) {
        this.logLine(`⛔ open-url REDDEDİLDİ — ${blocked}. `
          + 'ADP-801: bu dönüş kullanıcının kopyasına ait; test süreci tüketmez.');
        return;
      }
      this.handleAuthUrl(url);
    });
  }
}

function createAuthUrlService(deps) {
  return new AuthUrlService(deps);
}

module.exports = {
  createAuthUrlService,
  AuthUrlService,
};
