// MCP-COST-01 — `npx -y <paket>` yerine COZULMUS IKILI YOLUNU dogrudan calistir.
//
// ARIZA (olculdu 09.09): entegrasyon MCP'leri katalogda `npx -y <paket>` olarak
// tanimli. `npx`, paketi calistirmak icin once bir `npm exec` surecini ayakta
// TUTAR — o surec sunucunun omru boyunca yasar ve HICBIR IS YAPMAZ:
//
//   canli filo (14 pane, 4 entegrasyon):  48 `npm exec` sureci · 1.779 MB
//   tek sunucu, soguk acilis olcumu:      npm exec 103 MB + gercek sunucu 66 MB
//   el sikisma gecikmesi (3 kosu ort.):   coolify 465→109 ms · vercel 1.145→622 ms
//
// COZUM: paket npx onbelleginde (`~/.npm/_npx/<hash>`) ZATEN cozulmus duruyor.
// Oradaki `bin` yolunu bulup `node <yol>` olarak calistiririz → sarmalayici hic
// dogmaz. Indirme/cozumleme yapmayiz; YALNIZ ONBELLEKTE OLANI kullaniriz.
//
// FAIL-OPEN (bilincli): onbellekte yoksa, `bin` okunamiyorsa, dosya yoksa →
// `null` doner ve cagiran BUGUNKU `npx` komutunu aynen kullanir. Bu dosya hicbir
// kosulda bir spawn'i bozamaz; en kotu hali "hicbir sey degismedi"dir.
//
// BILINCLI TAKAS — `@latest` ARTIK "ILK KURULUMDAKI EN SON"tur.
// `npx -y pkg@latest` her aciliste kayit defterine sorup gunceller; cozulmus yol
// onbellekteki surume SABITLENIR. Tazeleme yolu KAPANMAZ, elle kalir:
// Ayarlar → Entegrasyonlar → "Baglantiyi dene" (`integ:test`) HALA `npx` ile
// kosar, onbellegi tazeler ve bir sonraki pane acilisi yeni surumu alir.
// Cozulen surum `version` alaninda doner → Ayarlar satirinda gosterilebilir,
// yani sabitlenme SESSIZ degildir.
//
// Calistir: node --test electron/npxDirect.test.cjs

'use strict';

const nodeFs = require('node:fs');
const nodePath = require('node:path');
const nodeChildProcess = require('node:child_process');
const os = require('node:os');
const mcpNode = require('../../platform/mcpNode.cjs');

/** `npx`/`npm exec` cagrisinda PAKETTEN ONCE gelen, paket OLMAYAN bayraklar. */
const PASSTHROUGH_FLAGS = new Set(['-y', '--yes', '-q', '--quiet', '--silent', '--no-install', 'exec', 'x', '--']);

/**
 * `@scope/ad@surum` → `@scope/ad` · `ad@latest` → `ad`.
 * Kapsam isareti (`@` ilk karakter) surum ayiraciyla karistirilmaz.
 */
function packageNameOf(spec) {
  if (typeof spec !== 'string' || !spec) return null;
  const at = spec.lastIndexOf('@');
  if (at <= 0) return spec; // 'ad' ya da '@scope/ad' (ilk karakter @)
  return spec.slice(0, at);
}

/**
 * Katalog girisini ayristir: hangi paket, sunucuya hangi argumanlar gidiyor.
 * `npx`/`npm` DISINDA bir komut → `null` (bu modul yalniz npx yolunu bilir).
 * @returns {{pkgSpec:string, pkgName:string, rest:string[]}|null}
 */
function parseNpxInvocation(command, args) {
  const base = nodePath.basename(String(command || ''));
  if (base !== 'npx' && base !== 'npm') return null;
  const list = Array.isArray(args) ? args.map(String) : [];
  let i = 0;
  if (base === 'npm') {
    // `npm exec <paket>` — `exec`/`x` zorunlu, yoksa bu bir MCP cagrisi degildir.
    while (i < list.length && PASSTHROUGH_FLAGS.has(list[i]) && list[i] !== 'exec' && list[i] !== 'x') i += 1;
    if (list[i] !== 'exec' && list[i] !== 'x') return null;
    i += 1;
  }
  while (i < list.length && PASSTHROUGH_FLAGS.has(list[i])) i += 1;
  const pkgSpec = list[i];
  if (!pkgSpec || pkgSpec.startsWith('-')) return null;
  const pkgName = packageNameOf(pkgSpec);
  if (!pkgName) return null;
  return { pkgSpec, pkgName, rest: list.slice(i + 1) };
}

function readJson(fs, file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Paketin `bin` girdisinden CALISTIRILACAK dosyayi sec.
 * `bin` string ise odur; nesne ise paket adinin son parcasiyla eslesen anahtar,
 * yoksa ilk anahtar. (Katalogdaki 4 paketin hepsi bu iki sekilden birini kullanir.)
 */
function pickBin(pkgJson, pkgName) {
  const bin = pkgJson && pkgJson.bin;
  if (typeof bin === 'string') return bin;
  if (!bin || typeof bin !== 'object') return null;
  const short = String(pkgName).split('/').pop();
  if (typeof bin[short] === 'string') return bin[short];
  const first = Object.keys(bin)[0];
  return first && typeof bin[first] === 'string' ? bin[first] : null;
}

/**
 * WIN-PARITY-01 — npx ONBELLEK KOKLERI, PLATFORMA GORE.
 *
 * ARIZA (olculdu 09.09, XPLAT-01 §2 satir 2): bu dosya onbellegi `<home>/.npm/_npx`
 * diye CIVILIYORDU. O yol npm'in POSIX varsayilanidir; Windows'ta npm onbellegi
 * `%LOCALAPPDATA%\npm-cache` altindadir. Sonuc: Windows'ta `resolveCachedBin` HER
 * ZAMAN null donuyordu → fail-open ile `npx` sarmalayicisi geri geliyordu → bu
 * dosyanin butun kazanci (filoda 1.779 MB / 48 surec) Windows'ta SIFIRDI.
 *
 * 🔴 HIZLI LISTE TEK BASINA YETMEZ — WINDOWS CI'DA OLCULDU (kosum 34370550221).
 * Ilk denemede bu fonksiyon YALNIZ env degiskeni + platform varsayilani doneyordu.
 * GitHub'in windows-latest imajinda npm onbellegi `C:\npm\cache`tir ve bu deger
 * bir **npmrc DOSYASINDA** tanimlidir — hicbir ortam degiskeni onu acik etmez.
 * Sonuc: kok yine bulunamadi, `resolved:null`, kazanc yine SIFIR. Yani "npm'e
 * sormak" gercekten sart; env kanali onun sadece bir alt kumesi.
 *
 * COZUM — TEK ATIS, TEMBEL, SUREC OMRU BOYUNCA BELLEKTE (`askNpmCacheRoot`):
 * hizli adaylardan HICBIRI diskte YOKSA npm'e bir kez sorulur. O durumda zaten
 * `null` donup `npx`e dusecektik; yani ~0,5 sn'lik tek alt surec, sonucu YANLIS
 * olan makinede ve YALNIZ BIR KEZ odenir. Hizli aday varsa (mac/linux'ta olagan
 * hal) alt surec HIC dogmaz.
 *
 * @returns {string[]} denenecek `_npx` kokleri, oncelik sirasiyla (tekrarsiz)
 */
function npxCacheRoots({ homedir, env, platform } = {}) {
  const home = homedir || os.homedir();
  const e = env || process.env;
  const plat = platform || process.platform;
  const roots = [];
  const push = (base) => {
    if (!base) return;
    const p = nodePath.join(base, '_npx');
    if (!roots.includes(p)) roots.push(p);
  };
  push(e.npm_config_cache);
  push(e.NPM_CONFIG_CACHE);
  if (plat === 'win32') {
    // npm belgelenmis Windows varsayilani: `%LocalAppData%\npm-cache`.
    push(e.LOCALAPPDATA ? nodePath.join(e.LOCALAPPDATA, 'npm-cache') : null);
    push(nodePath.join(home, 'AppData', 'Local', 'npm-cache'));
    // Git-Bash/WSL kurulumundan gelmis POSIX yerlesimi de olabilir — SON sirada:
    // varsa kullanilir, yoksa `readdirSync` patlar ve sessizce atlanir.
    push(nodePath.join(home, '.npm'));
  } else {
    push(nodePath.join(home, '.npm'));
  }
  return roots;
}

/**
 * npm'in KENDI cevabi — surec omru boyunca TEK KEZ sorulur (`undefined` = henuz
 * sorulmadi · `null` = soruldu, cevap alinamadi). Bir daha DENENMEZ: cevap
 * alinamayan bir makinede her lookup'ta yeniden alt surec acmak, cozmeye
 * calistigimiz gecikmenin ta kendisi olurdu.
 *
 * 🪤 Windows'ta `npm` bir `.cmd`tir ve Node 22+ `.cmd`i `shell` OLMADAN
 * calistirmayi REDDEDER (EINVAL) → orada `shell:true`. POSIX'te kabuk ACILMAZ.
 */
let npmCacheAnswer;

function askNpmCacheRoot(opts = {}) {
  if (npmCacheAnswer !== undefined) return npmCacheAnswer;
  if (opts.ask === false) { npmCacheAnswer = null; return null; }
  const run = opts.exec || nodeChildProcess.execFileSync;
  const isWin = (opts.platform || process.platform) === 'win32';
  try {
    const out = String(run(isWin ? 'npm.cmd' : 'npm', ['config', 'get', 'cache'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 10000,
      shell: isWin,
    })).trim();
    // npm ayarsizken de bir yol basar; "undefined"/"null" metinleri cevap DEGILDIR.
    npmCacheAnswer = out && out !== 'undefined' && out !== 'null' ? nodePath.join(out, '_npx') : null;
  } catch {
    npmCacheAnswer = null; // npm yok / zaman asimi → bugunku davranis (npx'e dus)
  }
  return npmCacheAnswer;
}

/** Test kancasi: tek-atis cevabini sifirla. */
function clearNpmCacheAnswer() {
  npmCacheAnswer = undefined;
}

/** Bellekte tutulan cozum — spawn yolu senkron, her aciliste 50 JSON okumasin. */
const memo = new Map(); // pkgName → {at:number, value:object|null}
const MEMO_TTL_MS = 60 * 1000;

function clearCache() {
  memo.clear();
  npmCacheAnswer = undefined;
}

/**
 * Paketin npx ONBELLEGINDEKI ikili yolunu bul. Indirme YOK, ag YOK.
 * @returns {{binPath:string, version:string|null, cacheDir:string}|null}
 */
function resolveCachedBin(pkgName, opts = {}) {
  const fs = opts.fs || nodeFs;
  const homedir = opts.homedir || os.homedir();
  const now = opts.now ?? Date.now();
  let roots = opts.cacheRoots || npxCacheRoots({ homedir, env: opts.env, platform: opts.platform });
  // HIZLI ADAYLARIN HICBIRI DISKTE YOKSA npm'e SOR (tek atis, bkz. askNpmCacheRoot).
  // Bu dal olmadan npmrc ile ozellestirilmis onbellek (GitHub windows-latest:
  // `C:\npm\cache`) HIC bulunamiyordu ve kazanc SIFIR kaliyordu.
  if (!opts.cacheRoots && !roots.some((r) => { try { return fs.existsSync(r); } catch { return false; } })) {
    const asked = askNpmCacheRoot({ platform: opts.platform, exec: opts.exec, ask: opts.askNpm });
    if (asked && !roots.includes(asked)) roots = [...roots, asked];
  }
  const memoKey = `${roots.join('|')} ${pkgName}`;
  const hit = memo.get(memoKey);
  if (hit && now - hit.at < MEMO_TTL_MS) return hit.value;

  let value = null;
  // Birden fazla kok denenir: ilk EŞLEŞEN kazanir. Var olmayan kok `readdirSync`te
  // patlar ve o kok atlanir — "dizin yok" bir HATA degil, bir CEVAPTIR.
  for (const root of roots) {
    if (value) break;
    try {
      for (const dir of fs.readdirSync(root)) {
        const base = nodePath.join(root, dir);
        const manifest = readJson(fs, nodePath.join(base, 'package.json'));
        const deps = manifest && manifest.dependencies;
        if (!deps || !Object.prototype.hasOwnProperty.call(deps, pkgName)) continue;
        const pkgDir = nodePath.join(base, 'node_modules', ...pkgName.split('/'));
        const pkgJson = readJson(fs, nodePath.join(pkgDir, 'package.json'));
        const rel = pickBin(pkgJson, pkgName);
        if (!rel) continue;
        const binPath = nodePath.join(pkgDir, rel);
        // "VAR MI" degil "DOGRU MU": dosya gercekten okunabiliyor olmali, yoksa
        // spawn `node ENOENT` ile OLUR — npx'e dusmek her zaman daha iyidir.
        try {
          fs.accessSync(binPath, (fs.constants && fs.constants.R_OK) || 4);
        } catch {
          continue;
        }
        value = { binPath, version: (pkgJson && pkgJson.version) || null, cacheDir: base };
        break;
      }
    } catch {
      // bu kok yok / okunamiyor → SONRAKI koke gec (fail-open korunuyor)
    }
  }
  memo.set(memoKey, { at: now, value });
  return value;
}

/**
 * Katalog `mcpServer` blogunu SARMALAYICISIZ hale getir.
 *
 * @param {{command:string, args:string[]}} server
 * @returns {{command:string, args:string[], via:'direct', package:string,
 *            version:string|null}|null} `null` = degisiklik yok, npx'i kullan.
 */
function directCommand(server, opts = {}) {
  if (!server || typeof server !== 'object') return null;
  const parsed = parseNpxInvocation(server.command, server.args);
  if (!parsed) return null;
  const found = resolveCachedBin(parsed.pkgName, opts);
  if (!found) return null;
  // In a packaged app process.execPath is the GUI executable, not system Node.
  const launcher = mcpNode.resolveMcpNode({ ...opts, home: opts.homedir });
  return {
    command: launcher.command,
    args: [found.binPath, ...parsed.rest],
    ...(launcher.env ? { env: { ...launcher.env } } : {}),
    via: 'direct',
    package: parsed.pkgName,
    version: found.version,
  };
}

module.exports = {
  PASSTHROUGH_FLAGS,
  packageNameOf,
  parseNpxInvocation,
  pickBin,
  npxCacheRoots,
  askNpmCacheRoot,
  clearNpmCacheAnswer,
  resolveCachedBin,
  directCommand,
  clearCache,
};
