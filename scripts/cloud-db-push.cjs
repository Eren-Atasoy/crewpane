'use strict';
// Apply supabase/migrations/*.sql to the CrewPane cloud project, record them the way the
// Supabase CLI does, then apply supabase/cloud/lockdown.sql. Uses psql inside the local
// Supabase db container (no CLI needed). Reads secrets from .env.cloud.local.
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const env = Object.fromEntries(fs.readFileSync(path.join(ROOT, '.env.cloud.local'), 'utf8')
  .split(/\r?\n/).filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const CONTAINER = process.env.CREWPANE_PSQL_CONTAINER || 'supabase_db_AgentSpace-source-FULL';
const base = ['exec', '-i', '-e', `PGPASSWORD=${env.SUPABASE_DB_PASSWORD}`, CONTAINER, 'psql',
  '-h', env.SUPABASE_POOLER_HOST, '-p', '5432', '-U', `postgres.${env.SUPABASE_PROJECT_REF}`, '-d', 'postgres',
  '-v', 'ON_ERROR_STOP=1', '-q'];
const psql = (sql, extra = []) => execFileSync('docker', [...base, ...extra], { input: sql, encoding: 'utf8' });

psql(`create schema if not exists supabase_migrations;
create table if not exists supabase_migrations.schema_migrations (version text primary key, statements text[], name text);`);
const applied = new Set(psql('select version from supabase_migrations.schema_migrations;', ['-At']).split('\n').filter(Boolean));
const dir = path.join(ROOT, 'supabase', 'migrations');
for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) {
  const m = f.match(/^(\d+)_(.+)\.sql$/);
  if (applied.has(m[1])) { console.log('skip (already applied)', f); continue; }
  const sql = fs.readFileSync(path.join(dir, f), 'utf8');
  const esc = (s) => s.replace(/'/g, "''");
  psql(`begin;\n${sql}\n;insert into supabase_migrations.schema_migrations(version, name, statements) values ('${m[1]}', '${esc(m[2])}', array['${esc(sql)}']);\ncommit;`);
  console.log('applied', f);
}
if (process.argv.includes('--lockdown')) {
  psql(fs.readFileSync(path.join(ROOT, 'supabase', 'cloud', 'lockdown.sql'), 'utf8'), ['-1']);
  console.log('lockdown applied');
}
