'use strict';

/**
 * Backend & Supabase Environment Configuration Service (Faz 3.6.41)
 * Encapsulates public supabase env discovery, channel routing, app DB identity mode,
 * auth/access token acquisition for app DB, environment layer viewing,
 * mixed-target validation guard, and renderer target configuration.
 */

const { dialog: electronDialog, app: electronApp } = require('electron');
const defaultPublicBackendEnv = require('../../config/publicBackendEnv.cjs');
const defaultBackendTarget = require('../../config/backendTarget.cjs');
const defaultAppDbIdentity = require('../../config/appDbIdentity.cjs');
const defaultEnvProfileModule = require('../../config/envProfile.cjs');
const defaultMixedTargetGuard = require('../../config/mixedTargetGuard.cjs');
const defaultDevChannel = require('../../config/devChannel.cjs');
const { crewpaneIdConfig: defaultCrewpaneIdConfig } = require('../../config/crewpaneId.cjs');

const APPDB_TOKEN_TIMEOUT_MS = 12_000;

const defaultDeps = {
  repoRoot: '',
  publicBackendEnv: defaultPublicBackendEnv,
  backendTarget: defaultBackendTarget,
  appDbIdentity: defaultAppDbIdentity,
  envProfileModule: defaultEnvProfileModule,
  mixedTargetGuard: defaultMixedTargetGuard,
  devChannel: defaultDevChannel,
  crewpaneIdConfig: defaultCrewpaneIdConfig,
  instancePaths: { instanceId: () => 'prod' },
  getSeatGate: () => null,
  seatDenial: () => null,
  logLine: () => {},
  envProfile: { name: 'prod', overridden: [], rejected: [] },
  appUrlScheme: 'crewpane',
  app: electronApp,
  dialog: electronDialog,
  tokenTimeoutMs: APPDB_TOKEN_TIMEOUT_MS,
  env: process.env,
};

class BackendEnvService {
  constructor(deps = {}) {
    this.deps = deps;
    Object.assign(this, defaultDeps, deps);

    this.publicSupabaseEnvCache = null;
    this.lastBackendTarget = null;
    this.appDbIdentityLogged = null;
    this.mixedTargetDecision = null;
  }

  _applyE2ESentinel(target, out, schemaKey) {
    if (target.isE2E && target.keyMissing) {
      out.NEXT_PUBLIC_CREWPANE_SUPABASE_URL = target.url;
      out.NEXT_PUBLIC_CREWPANE_SUPABASE_ANON_KEY = 'CREWPANE_E2E_ANON_KEY_MISSING';
      out[schemaKey] = target.schema;
      this.logLine(
        `⛔ [backend] ADP-741 — e2e anon anahtarı YOK (${target.keyMissing}). Hedef ${target.url} olarak ` +
        `sabitlendi ama istekler 401 alacak. Çözüm: CREWPANE_E2E_SUPABASE_ANON_KEY ver ` +
        `(anahtarı e2e/e2eAnonKey.cjs → resolveE2EAnonKey() çözer) ya da npm run e2e:db:start.`
      );
    }
  }

  _applyTargetRejections(target) {
    if (!target.rejected || !Array.isArray(target.rejected)) return;
    for (const r of target.rejected) {
      this.logLine(`[backend] ${target.instance} kanalında YEREL hedef reddedildi (${r.reason}): ${r.url} → ${target.url}`);
    }
  }

  _checkDevMisconfiguration() {
    try {
      const devWarn = this.devChannel ? this.devChannel.misconfigurationWarning() : null;
      if (devWarn) this.logLine(devWarn);
    } catch (e) {
      this.logLine(`[dev-kanal] uyarı üretilemedi: ${e.message}`);
    }
  }

  publicSupabaseEnv() {
    if (this.publicSupabaseEnvCache) return this.publicSupabaseEnvCache;
    const URL_K = 'NEXT_PUBLIC_CREWPANE_SUPABASE_URL';
    const ANON_K = 'NEXT_PUBLIC_CREWPANE_SUPABASE_ANON_KEY';
    const SCHEMA_K = 'NEXT_PUBLIC_CREWPANE_SUPABASE_SCHEMA';
    const out = {};

    const live = this.publicBackendEnv.readLivePair({ repoRoot: this.repoRoot });
    if (live.url) out[URL_K] = live.url;
    if (live.anonKey) out[ANON_K] = live.anonKey;

    const instanceId = this.instancePaths ? this.instancePaths.instanceId() : 'prod';
    const target = this.backendTarget.resolveBackendTarget(this.env, instanceId, {
      url: out[URL_K],
      anonKey: out[ANON_K],
      schema: live.schema,
    });
    this.lastBackendTarget = target;

    if (target.url && target.anonKey) {
      out[URL_K] = target.url;
      out[ANON_K] = target.anonKey;
      out[SCHEMA_K] = target.schema;
    } else {
      this._applyE2ESentinel(target, out, SCHEMA_K);
    }

    this._applyTargetRejections(target);
    this._checkDevMisconfiguration();

    this.publicSupabaseEnvCache = out[URL_K] && out[ANON_K] ? out : {};
    return this.publicSupabaseEnvCache;
  }

  appDbIdentityMode() {
    const authUrl = this.crewpaneIdConfig(this.env).supabaseUrl;
    const dbUrl = this.publicSupabaseEnv().NEXT_PUBLIC_CREWPANE_SUPABASE_URL;
    const decision = this.appDbIdentity.resolveIdentityMode({
      authUrl,
      dbUrl,
    });
    const line = `${decision.mode}/${decision.reason}/${decision.project || '-'}`;
    if (this.appDbIdentityLogged !== line) {
      this.appDbIdentityLogged = line;
      this.logLine(`[appdb] kimlik modu=${decision.mode} (${decision.reason}) hedef=${decision.project || '-'}`);
    }
    return decision;
  }

  async appDbTokenFor(action) {
    const decision = this.appDbIdentityMode();
    if (decision.mode !== 'crewpane-id') return { ok: false, reason: decision.reason };

    const seatGate = this.getSeatGate ? this.getSeatGate() : null;
    if (!seatGate) return { ok: false, reason: 'not_ready' };

    const denied = this.seatDenial ? this.seatDenial(action) : null;
    if (denied) return { ok: false, reason: denied.reason, message: denied.message };

    let timer = null;
    try {
      const deadline = new Promise((_, reject) => {
        timer = setTimeout(() => {
          const e = new Error(`appdb token ${this.tokenTimeoutMs}ms içinde dönmedi`);
          e.name = 'TimeoutError';
          reject(e);
        }, this.tokenTimeoutMs);
      });
      const p = seatGate.accessToken();
      p.catch(() => {});
      return await Promise.race([p, deadline]);
    } catch (e) {
      if (e && e.name === 'TimeoutError') {
        this.logLine(`appdb token timeout (${action}) — anon'a düşülüyor`);
        return { ok: false, reason: 'timeout' };
      }
      this.logLine(`appdb token error (${action}): ${e.message}`);
      return { ok: false, reason: 'error' };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  mobileAppDbToken() {
    return this.appDbTokenFor('mobile:/m/office');
  }

  envLayerView() {
    const idCfg = this.crewpaneIdConfig(this.env);
    const dbEnv = this.publicSupabaseEnv();
    const instanceId = this.instancePaths ? this.instancePaths.instanceId() : 'prod';
    const channel = this.lastBackendTarget ? this.lastBackendTarget.instance : instanceId;
    const mixed = this.mixedTargetDecision;

    return {
      profile: this.envProfile.name,
      channel,
      scheme: this.appUrlScheme,
      dbUrl: dbEnv.NEXT_PUBLIC_CREWPANE_SUPABASE_URL || null,
      dbSchema: dbEnv.NEXT_PUBLIC_CREWPANE_SUPABASE_SCHEMA || null,
      authUrl: idCfg.supabaseUrl || null,
      loginUrl: idCfg.loginUrl || null,
      mailUrl: this.envProfile.name === 'local' ? this.envProfileModule.LOCAL_MAILPIT_URL : null,
      customerBuild: Boolean(idCfg.customerBuild),
      mixed: mixed
        ? {
          level: mixed.level,
          reason: mixed.reason,
          message: mixed.message || null,
        }
        : null,
    };
  }

  _logProfileOverrides() {
    if (this.envProfile.overridden && this.envProfile.overridden.length) {
      this.logLine(`[env] profil EZİLDİ (kabuktaki açık env kazandı): ${this.envProfile.overridden.join(', ')}`);
    }
    if (this.envProfile.rejected && this.envProfile.rejected.length) {
      for (const r of this.envProfile.rejected) {
        this.logLine(`[env] kaçış yok sayıldı (${r.reason}): ${r.key}`);
      }
    }
  }

  _handleBlockedDecision(decision) {
    this.logLine(decision.message);
    if (this.app && this.app.isPackaged) {
      try {
        if (this.dialog && this.dialog.showErrorBox) {
          this.dialog.showErrorBox('CrewPane — ortam karışımı', decision.message);
        }
      } catch { /* headless */ }
    }
    if (this.app && this.app.exit) {
      this.app.exit(1);
    }
  }

  logEnvBannerAndGuard() {
    const view = this.envLayerView();
    const idCfg = this.crewpaneIdConfig(this.env);
    const dbUrl = view.dbUrl;

    this.logLine(this.envProfileModule.bootBannerLine(view));
    this._logProfileOverrides();

    const instanceId = this.instancePaths ? this.instancePaths.instanceId() : 'prod';
    const decision = this.mixedTargetGuard.checkMixedTargets({
      authUrl: idCfg.supabaseUrl,
      dbUrl,
      loginUrl: idCfg.loginUrl,
      instanceId,
      allowMixed: this.mixedTargetGuard.truthy(this.env[this.mixedTargetGuard.ALLOW_MIXED_KEY]),
      customerBuild: Boolean(idCfg.customerBuild),
    });
    this.mixedTargetDecision = decision;

    if (decision.level === 'warn' && decision.message) {
      this.logLine(`[env] ${decision.message}`);
    }
    if (decision.level === 'block') {
      this._handleBlockedDecision(decision);
    }
    return decision;
  }

  rendererSupabaseTarget() {
    const env = this.publicSupabaseEnv();
    const envView = this.envLayerView();
    const instanceId = this.instancePaths ? this.instancePaths.instanceId() : 'prod';
    const channel = this.lastBackendTarget ? this.lastBackendTarget.instance : instanceId;
    const mixed = this.mixedTargetDecision;

    return {
      url: env.NEXT_PUBLIC_CREWPANE_SUPABASE_URL,
      anonKey: env.NEXT_PUBLIC_CREWPANE_SUPABASE_ANON_KEY,
      schema: env.NEXT_PUBLIC_CREWPANE_SUPABASE_SCHEMA,
      auth: this.appDbIdentityMode().mode === 'crewpane-id' ? 'crewpane-id' : undefined,
      isE2E: instanceId === 'test',
      channel,
      customerBuild: this.lastBackendTarget ? Boolean(this.lastBackendTarget.customerBuild) : undefined,
      mixed: mixed && mixed.level === 'warn'
        ? { reason: mixed.reason, message: mixed.message }
        : undefined,
      env: {
        profile: envView.profile,
        scheme: envView.scheme,
        dbUrl: envView.dbUrl,
        dbSchema: envView.dbSchema,
        authUrl: envView.authUrl,
        loginUrl: envView.loginUrl,
        mailUrl: envView.mailUrl,
      },
    };
  }
}

function createBackendEnvService(deps) {
  return new BackendEnvService(deps);
}

module.exports = {
  createBackendEnvService,
  BackendEnvService,
  APPDB_TOKEN_TIMEOUT_MS,
};
