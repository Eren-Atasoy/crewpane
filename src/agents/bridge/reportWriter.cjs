'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crewpaneEnv = require('../../config/crewpaneEnv.cjs');
const { reportFileName, buildReportMarkdown } = require('../agentRunner.js');

function defaultResultsDir() {
  const envDir = crewpaneEnv.readEnv('RESULTS_DIR');
  if (envDir) return envDir;
  return path.join(os.homedir(), 'Downloads', 'CrewPane Apps', 'crewpane', 'docs', 'agent-results');
}

/**
 * TASK-MQTIYIIZE5VR7 (st2) — write a completion report into `resultsDir`. FALLBACK
 * semantics by default: if `<task>-<role>.md` already exists with content, it is the
 * worker's own (richer) report → DO NOT clobber it (returns { ok, skipped:true }).
 */
function writeReportFile(value, resultsDir) {
  const dir = resultsDir || defaultResultsDir();
  const filename = reportFileName(value.taskId, value.role);
  if (!filename) return { ok: false, error: 'could not derive a report filename' };
  const full = path.join(dir, filename);
  const resolved = path.resolve(full);
  if (resolved !== path.resolve(dir, filename) || !resolved.startsWith(path.resolve(dir) + path.sep)) {
    return { ok: false, error: 'refusing to write outside the results dir' };
  }
  try {
    if (!value.force) {
      try {
        if (fs.statSync(full).size > 0) return { ok: true, filename, skipped: true };
      } catch {
        /* missing → write it */
      }
    }
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      full,
      buildReportMarkdown({
        taskId: value.taskId,
        role: value.role,
        agentName: value.agentName,
        status: value.status,
        summary: value.summary,
      }),
    );
    return { ok: true, filename };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
}

module.exports = {
  defaultResultsDir,
  writeReportFile,
};
