'use strict';

/**
 * src/services/taskBrainService.cjs
 *
 * Backend brain service to manage and clean tasks across teams/projects.
 * Operates with the local or cloud Supabase database.
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

// Local-dev fallback: the PUBLIC, well-known `supabase-demo` anon key that every local
// Supabase stack ships with (role=anon, no secrets). Real targets come from env.
const LOCAL_DEMO_URL = 'http://127.0.0.1:54321';
const LOCAL_DEMO_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0';

let supabaseUrl = LOCAL_DEMO_URL;
let anonKey = LOCAL_DEMO_ANON_KEY;

try {
  const envPath = path.resolve(__dirname, '../../.env.local');
  if (fs.existsSync(envPath)) {
    const lines = fs.readFileSync(envPath, 'utf8').split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('NEXT_PUBLIC_SUPABASE_URL=')) {
        supabaseUrl = trimmed.split('=')[1].trim();
      } else if (trimmed.startsWith('NEXT_PUBLIC_SUPABASE_ANON_KEY=')) {
        anonKey = trimmed.split('=')[1].trim();
      }
    }
  }
} catch (e) {
  // Use fallback defaults
}

// Explicit process env wins over file/fallback (see .env.example).
if (process.env.CREWPANE_TASKBRAIN_SUPABASE_URL) supabaseUrl = process.env.CREWPANE_TASKBRAIN_SUPABASE_URL;
if (process.env.CREWPANE_TASKBRAIN_ANON_KEY) anonKey = process.env.CREWPANE_TASKBRAIN_ANON_KEY;

function sendRequest(options, bodyData) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(supabaseUrl);
    const client = parsed.protocol === 'https:' ? https : http;

    const req = client.request({
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: options.path,
      method: options.method || 'GET',
      headers: {
        'apikey': anonKey,
        'Authorization': `Bearer ${anonKey}`,
        'Content-Type': 'application/json',
        ...(options.headers || {})
      }
    }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = data ? JSON.parse(data) : null;
          resolve({ status: res.statusCode, data: json });
        } catch (e) {
          resolve({ status: res.statusCode, raw: data });
        }
      });
    });

    req.on('error', reject);
    if (bodyData) req.write(bodyData);
    req.end();
  });
}

/**
 * Clean all completed ('done') tasks for a specific team/project, or across all teams.
 * @param {Object} [opts]
 * @param {string} [opts.project] - Project slug (e.g. 'crewpane', 'dbforge', or 'all')
 */
async function cleanTeamDoneTasks(opts = {}) {
  const project = opts.project || 'all';
  let pathStr = '/rest/v1/tasks?status=eq.done';
  if (project !== 'all') {
    pathStr += `&project=eq.${encodeURIComponent(project)}`;
  }

  const res = await sendRequest({
    path: pathStr,
    method: 'DELETE',
    headers: { 'Prefer': 'return=representation' }
  });

  if (res.status >= 200 && res.status < 300) {
    const deletedCount = Array.isArray(res.data) ? res.data.length : 0;
    return { ok: true, project, deletedCount };
  }
  return { ok: false, error: res.data || res.raw || `HTTP ${res.status}` };
}

/**
 * Clean ALL tasks (all statuses: backlog, todo, in_progress, review, done) across ALL teams.
 */
async function cleanAllTasks() {
  const pathStr = '/rest/v1/tasks?id=neq.__none__';
  const res = await sendRequest({
    path: pathStr,
    method: 'DELETE',
    headers: { 'Prefer': 'return=representation' }
  });

  if (res.status >= 200 && res.status < 300) {
    const deletedCount = Array.isArray(res.data) ? res.data.length : 0;
    return { ok: true, deletedCount };
  }
  return { ok: false, error: res.data || res.raw || `HTTP ${res.status}` };
}

/**
 * List summary of tasks per project & status.
 */
async function listTasksSummary() {
  const res = await sendRequest({ path: '/rest/v1/tasks?select=id,project,status,title' });
  if (res.status >= 200 && res.status < 300 && Array.isArray(res.data)) {
    const byProject = {};
    for (const t of res.data) {
      const p = t.project || 'genel';
      if (!byProject[p]) byProject[p] = { total: 0, done: 0, review: 0, in_progress: 0, todo: 0, backlog: 0 };
      byProject[p].total++;
      if (byProject[p][t.status] !== undefined) byProject[p][t.status]++;
    }
    return { ok: true, total: res.data.length, byProject, tasks: res.data };
  }
  return { ok: false, error: res.data || res.raw };
}

module.exports = {
  cleanTeamDoneTasks,
  cleanAllTasks,
  listTasksSummary
};
