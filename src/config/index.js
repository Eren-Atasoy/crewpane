'use strict';
/**
 * CrewPane Domain: CONFIG
 */
const path = require('node:path');

module.exports = {
  get accountScope() { return require(path.join(__dirname, "accountScope.cjs")); },
  get adapter() { return require(path.join(__dirname, "adapter.cjs")); },
  get crewpaneEnv() { return require(path.join(__dirname, "crewpaneEnv.cjs")); },
  get crewpanePaths() { return require(path.join(__dirname, "crewpanePaths.cjs")); },
  get appDbIdentity() { return require(path.join(__dirname, "appDbIdentity.cjs")); },
  get backendTarget() { return require(path.join(__dirname, "backendTarget.cjs")); },
  get branchName() { return require(path.join(__dirname, "branchName.cjs")); },
  get buildChannel() { return require(path.join(__dirname, "buildChannel.cjs")); },
  get builderFiles() { return require(path.join(__dirname, "builderFiles.cjs")); },
  get demoSitePath() { return require(path.join(__dirname, "demoSitePath.cjs")); },
  get devChannel() { return require(path.join(__dirname, "devChannel.cjs")); },
  get envGuard() { return require(path.join(__dirname, "envGuard.cjs")); },
  get envProfile() { return require(path.join(__dirname, "envProfile.cjs")); },
  get escapes() { return require(path.join(__dirname, "escapes.cjs")); },
  get instancePaths() { return require(path.join(__dirname, "instancePaths.cjs")); },
  get ledgerPath() { return require(path.join(__dirname, "ledgerPath.cjs")); },
  get mixedTargetGuard() { return require(path.join(__dirname, "mixedTargetGuard.cjs")); },
  get crewpaneId() { return require(path.join(__dirname, "crewpaneId.cjs")); },
  get nextServerPolicy() { return require(path.join(__dirname, "nextServerPolicy.cjs")); },
  get planCatalog() { return require(path.join(__dirname, "planCatalog.cjs")); },
  get planLimits() { return require(path.join(__dirname, "planLimits.cjs")); },
  get projectRepos() { return require(path.join(__dirname, "projectRepos.cjs")); },
  get providerKeysEnvFile() { return require(path.join(__dirname, "providerKeysEnvFile.cjs")); },
  get publicBackendEnv() { return require(path.join(__dirname, "publicBackendEnv.cjs")); },
  get supabaseTarget() { return require(path.join(__dirname, "supabaseTarget.cjs")); },
  get worktreePath() { return require(path.join(__dirname, "worktreePath.cjs")); },
};
