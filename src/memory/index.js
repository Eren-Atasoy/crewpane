'use strict';
/**
 * CrewPane Domain: MEMORY
 */
const path = require('node:path');

module.exports = {
  get agentMemory() { return require(path.join(__dirname, "agentMemory.cjs")); },
  get mem_scope_recall() { return require(path.join(__dirname, "mem-scope-recall.cjs")); },
  get memoryChunker() { return require(path.join(__dirname, "memoryChunker.cjs")); },
  get memoryEmbedder() { return require(path.join(__dirname, "memoryEmbedder.cjs")); },
  get memoryEmbedHosted() { return require(path.join(__dirname, "memoryEmbedHosted.cjs")); },
  get memoryEmbedInstall() { return require(path.join(__dirname, "memoryEmbedInstall.cjs")); },
  get memoryEmbedLimits() { return require(path.join(__dirname, "memoryEmbedLimits.cjs")); },
  get memoryEmbedWorker() { return require(path.join(__dirname, "memoryEmbedWorker.cjs")); },
  get memoryGraph() { return require(path.join(__dirname, "memoryGraph.cjs")); },
  get memoryHybrid() { return require(path.join(__dirname, "memoryHybrid.cjs")); },
  get memoryIndexDerive() { return require(path.join(__dirname, "memoryIndexDerive.cjs")); },
  get memoryIndexer() { return require(path.join(__dirname, "memoryIndexer.cjs")); },
  get memoryIndexPoison() { return require(path.join(__dirname, "memoryIndexPoison.cjs")); },
  get memoryIndexService() { return require(path.join(__dirname, "memoryIndexService.cjs")); },
  get memoryIndexStore() { return require(path.join(__dirname, "memoryIndexStore.cjs")); },
  get memoryIndexWorker() { return require(path.join(__dirname, "memoryIndexWorker.cjs")); },
  get memoryLexical() { return require(path.join(__dirname, "memoryLexical.cjs")); },
  get memoryLexicalScan() { return require(path.join(__dirname, "memoryLexicalScan.cjs")); },
  get memoryQueryVectorCache() { return require(path.join(__dirname, "memoryQueryVectorCache.cjs")); },
  get memoryRecall() { return require(path.join(__dirname, "memoryRecall.cjs")); },
  get memoryRecallCli() { return require(path.join(__dirname, "memoryRecallCli.cjs")); },
  get memorySearchService() { return require(path.join(__dirname, "memorySearchService.cjs")); },
  get memorySecretMask() { return require(path.join(__dirname, "memorySecretMask.cjs")); },
  get memorySpawnRetrieval() { return require(path.join(__dirname, "memorySpawnRetrieval.cjs")); },
  get memoryTargeting() { return require(path.join(__dirname, "memoryTargeting.cjs")); },
  get memoryTaskBlock() { return require(path.join(__dirname, "memoryTaskBlock.cjs")); },
  get memoryUsageLedger() { return require(path.join(__dirname, "memoryUsageLedger.cjs")); },
  get searchIndexService() { return require(path.join(__dirname, "searchIndexService.cjs")); },
  get searchIndexSources() { return require(path.join(__dirname, "searchIndexSources.cjs")); },
  get searchIndexStore() { return require(path.join(__dirname, "searchIndexStore.cjs")); },
  get searchIndexWorker() { return require(path.join(__dirname, "searchIndexWorker.cjs")); },
};
