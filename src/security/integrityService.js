'use strict';

/**
 * Package Integrity Report & Anti-Tamper Service (SEC-W2-A2 / Phase 3.6.44)
 *
 * TEMBEL BİLEREK: ölçüm bu makinede 324 dosya + 27,6 MB asar için ~440 ms
 * sürüyor. Açılış yoluna binmemesi için ilk kez lisans jetonu tazelenirken
 * (zaten eşzamansız, açılıştan SONRA) hesaplanır ve bir daha hesaplanmaz —
 * paketin dosyaları uygulama açıkken değişmez.
 *
 * TELEMETRİ DE BURADAN ÇIKAR: "ölçtüm" ile "raporladım" tek yerde kalsın diye.
 */
class IntegrityService {
  constructor({
    integrityCheck,
    tamperSignals,
    instancePaths,
    isCustomerBuild = () => false,
    resourcesPath = null,
    logLine = () => {},
    analyticsNow = () => null,
    obsReporterNow = () => null,
  } = {}) {
    this._integrityCheck = integrityCheck;
    this._tamperSignals = tamperSignals;
    this._instancePaths = instancePaths;
    this._isCustomerBuild = isCustomerBuild;
    this._resourcesPath = resourcesPath;
    this._logLine = logLine;
    this._analyticsNow = analyticsNow;
    this._obsReporterNow = obsReporterNow;
    this._integrityReportCache = null;
  }

  integrityReportOnce() {
    if (this._integrityReportCache) return this._integrityReportCache;
    let report;
    try {
      report = this._integrityCheck.run({
        packagedBaked: this._instancePaths.packagedBuild(),
        bakedBuild: this._instancePaths.bakedBuildType(),
        customerBuild:
          typeof this._isCustomerBuild === 'function' ? this._isCustomerBuild() : Boolean(this._isCustomerBuild),
        resources: this._resourcesPath || process.resourcesPath || null,
      });
    } catch (e) {
      this._logLine(`integrity: ölçüm atlandı (${e && e.message})`);
      report = { status: this._integrityCheck.STATUS.SKIPPED, reason: 'measure_failed', jws: null, root: null };
    }
    this._integrityReportCache = report;

    this._handleReportStatus(report);
    return this._integrityReportCache;
  }

  _handleReportStatus(report) {
    if (report.status === this._integrityCheck.STATUS.MISMATCH) {
      this._emitMismatchTelemetry(report);
    } else if (report.status === this._integrityCheck.STATUS.OK) {
      this._logLine(`integrity: paket doğrulandı (${report.durationMs} ms)`);
    } else {
      this._logLine(`integrity: denetim koşmadı (${report.reason})`);
    }
  }

  _emitMismatchTelemetry(report) {
    const file = this._integrityCheck.primaryFile(report);
    this._logLine(
      `integrity: AYRIŞMA — değişen=${report.changed.length} eksik=${report.missing.length} ` +
        `eklenen=${report.added.length} (${report.durationMs} ms)`,
    );
    const event = { reason: this._tamperSignals.REASONS.UNPACKED_HASH_MISMATCH, signature: 'unknown' };
    if (file) event.file = file;

    try {
      const a = this._analyticsNow();
      if (a && typeof a.track === 'function') a.track('tamper', event);
    } catch {
      /* analitik hata üretmez */
    }

    try {
      const obs = this._obsReporterNow();
      if (obs && typeof obs.capture === 'function') {
        obs.capture({
          surface: 'main',
          module: 'tamper',
          label: event.reason,
          message: `paket bütünlüğü tutarsız: ${event.reason}`,
          level: 'warning',
          tamper: true,
        });
      }
    } catch {
      /* hata takibi hata üretmez */
    }
  }
}

function createIntegrityService(deps) {
  return new IntegrityService(deps);
}

module.exports = {
  createIntegrityService,
  IntegrityService,
};
