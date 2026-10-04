#!/usr/bin/env node
/**
 * scripts/clean_tasks.cjs
 *
 * Utility to manage, inspect, and clean up tasks in CrewPane / Atasoy Agency.
 *
 * Usage:
 *   node scripts/clean_tasks.cjs                 # Cleans all 'done' tasks across all projects
 *   node scripts/clean_tasks.cjs --list          # Displays summary of tasks per project & status
 *   node scripts/clean_tasks.cjs --project=xyz   # Cleans 'done' tasks for project 'xyz' only
 *   node scripts/clean_tasks.cjs --status=all    # Cleans all tasks (backlog, todo, review, done)
 *   node scripts/clean_tasks.cjs --dry-run       # Previews which tasks would be deleted
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

// 1. Read Supabase config
let supabaseUrl = 'http://127.0.0.1:54321';
let anonKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0';

try {
  const envPath = path.resolve(__dirname, '../.env.local');
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
  // Use defaults
}

const parsedUrl = new URL(supabaseUrl);

function apiRequest(options, postData) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || 80,
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
    if (postData) req.write(postData);
    req.end();
  });
}

// 2. Parse arguments
const args = process.argv.slice(2);
const isListOnly = args.includes('--list');
const isDryRun = args.includes('--dry-run');
const isAllStatus = args.includes('--all') || args.some(a => a.startsWith('--status=all'));

let targetProject = null;
const projectArg = args.find(a => a.startsWith('--project='));
if (projectArg) {
  targetProject = projectArg.split('=')[1].trim();
}

let targetStatus = 'done';
const statusArg = args.find(a => a.startsWith('--status=') && !a.startsWith('--status=all'));
if (statusArg) {
  targetStatus = statusArg.split('=')[1].trim();
}

async function main() {
  console.log('=====================================================');
  console.log('       ATASOY AGENCY · GÖREV YÖNETİM & TEMİZLİK      ');
  console.log('=====================================================\n');

  // Fetch all tasks
  let tasksRes;
  try {
    tasksRes = await apiRequest({ path: '/rest/v1/tasks?select=*' });
  } catch (err) {
    console.error('[HATA] Supabase ile bağlantı kurulamadı:', err.message);
    console.error('Supabase servisinin 127.0.0.1:54321 üzerinde çalıştığından emin olun.\n');
    process.exit(1);
  }

  const tasks = tasksRes.data || [];
  if (tasks.length === 0) {
    console.log('[BİLGİ] Veritabanında kayıtlı hiçbir görev bulunmuyor.');
    return;
  }

  // Group tasks by project
  const byProject = {};
  for (const t of tasks) {
    const prj = t.project || 'genel';
    if (!byProject[prj]) byProject[prj] = [];
    byProject[prj].push(t);
  }

  console.log(`Toplam Görev Sayısı: ${tasks.length}`);
  console.log('Projeler ve Durum Dağılımı:');
  for (const [prj, pTasks] of Object.entries(byProject)) {
    const counts = {};
    for (const t of pTasks) counts[t.status] = (counts[t.status] || 0) + 1;
    const countStr = Object.entries(counts).map(([st, cnt]) => `${st}: ${cnt}`).join(', ');
    console.log(`  📁 [${prj}] (${pTasks.length} görev) -> ${countStr}`);
  }
  console.log('');

  if (isListOnly) {
    console.log('[BİLGİ] --list modu: Görevler listelendi, herhangi bir silme yapılmadı.');
    return;
  }

  // Filter tasks to delete
  const toDelete = tasks.filter(t => {
    if (targetProject && t.project !== targetProject) return false;
    if (isAllStatus) return true;
    return t.status === targetStatus;
  });

  if (toDelete.length === 0) {
    console.log(`[BİLGİ] Kriterlere uyan silinecek görev bulunamadı (Proje: ${targetProject || 'Tümü'}, Durum: ${isAllStatus ? 'Tümü' : targetStatus}).`);
    return;
  }

  console.log(`Temizlenecek Görevler (${toDelete.length} adet):`);
  toDelete.forEach(t => {
    console.log(`  - [${t.project}] (${t.status.toUpperCase()}) ${t.title} [${t.id}]`);
  });
  console.log('');

  if (isDryRun) {
    console.log('[BİLGİ] --dry-run modu: Değişiklik yapılmadı.');
    return;
  }

  // Delete via Supabase REST API
  let deletePath = '/rest/v1/tasks?';
  const queryParts = [];
  if (!isAllStatus) {
    queryParts.push(`status=eq.${encodeURIComponent(targetStatus)}`);
  }
  if (targetProject) {
    queryParts.push(`project=eq.${encodeURIComponent(targetProject)}`);
  }

  deletePath += queryParts.join('&');

  const delRes = await apiRequest({
    path: deletePath,
    method: 'DELETE',
    headers: {
      'Prefer': 'return=representation'
    }
  });

  if (delRes.status >= 200 && delRes.status < 300) {
    console.log(`✅ [BAŞARILI] ${toDelete.length} adet görev veritabanından tamamen temizlendi.`);
    const remaining = tasks.length - toDelete.length;
    console.log(`Kalan aktif görev sayısı: ${remaining}`);
  } else {
    console.error('❌ [HATA] Görevler silinirken hata oluştu:', delRes);
  }
}

main().catch(err => {
  console.error('Beklenmeyen hata:', err);
  process.exit(1);
});
