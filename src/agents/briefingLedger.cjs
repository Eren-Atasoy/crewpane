// AGY-03 — TUR-BAŞI BRİFİNGİN IO KATMANI (defter okuma + makbuz yazma).
//
// NEDEN AYRI BİR DOSYA: ADP-692'nin brifing mantığı üç parçaya ayrılır ve üçüncüsü
// bugüne kadar TEK BİR motorun hook dosyasının içinde yaşıyordu:
//   1. `leaderBriefing.cjs`   — SAF karar/metin (hangi kayıt bekliyor, ne yazılır,
//                                makbuz nasıl birleşir). fs YOK, öyle kalmalı.
//   2. bu dosya               — o kararın DİSK ucu: defteri oku, makbuzu süz, yaz.
//   3. `<motor>Hook.cjs`      — yalnız MOTORUN ZARFİ (stdout sözleşmesi).
//
// AGY-03 ikinci bir motora (antigravity) aynı brifingi taşıyor. 3. katman motora
// göre değişir (claude `UserPromptSubmit` → `additionalContext`; antigravity
// `PreInvocation` → `injectSteps[].ephemeralMessage`) ama 1. ve 2. katman AYNI
// OLMAK ZORUNDADIR: iki motor aynı deftere bakıp aynı makbuzu yazmazsa lider aynı
// bitişi iki kez okur ya da hiç okumaz. Kopyalanan fs kodu ikinci bir GERÇEK
// doğururdu — bu yüzden taşındı, çoğaltılmadı.
//
// 🔴 DAYANIKLILIK KURALI (hook süreçlerinden miras): buradaki hiçbir şey bir turu
// düşürmemeli. Tüm gövde try/catch; okunamayan defter = "bekleyen yok".

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const briefing = require('./leaderBriefing.cjs');
// ADP-835 (790 K1) — atomik yazımın rename adımı platform boğazından geçer:
// Windows'ta Defender/Search hedefi açık tutunca EPERM/EBUSY gelir ve bu çağrıların
// çoğu best-effort catch içinde OLDUĞU İÇİN kayıt SESSİZCE kaybolurdu.
const { renameWithRetrySync } = require('../../platform/atomicWrite.cjs');
// ADP-835 (790 I3) — makbuz dosyasının `{mode:0o600}` iddiası Windows'ta SESSİZCE
// etkisiz; boğaz ne yaptığını söyler.
const { restrictFile } = require('../../platform/restrictPath.cjs');

/** Süpervizör defterinin adı (main yazar, hook OKUR — tek yönlü). */
const STATE_FILE = 'delegation-supervisor.json';

/**
 * Bu lider için HENÜZ ANLATILMAMIŞ bitişler. Boş dizi = brifing YOK.
 *
 * 🪤 Defterdeki `briefedAt` damgasını MAIN vurur (makbuzu tüketince). İki tur arası
 * main'in tick'inden kısaysa (kullanıcı arka arkaya iki prompt gönderdi) defter hâlâ
 * "anlatılmadı" der ve lider AYNI bitişi iki kez okur. Makbuz burada da süzülür.
 */
function pendingFor(home, agentId) {
  try {
    const id = String(agentId || '').trim();
    if (!id || !home) return [];
    const state = JSON.parse(fs.readFileSync(path.join(home, STATE_FILE), 'utf8'));
    let prev = null;
    try {
      prev = JSON.parse(fs.readFileSync(path.join(home, briefing.RECEIPT_FILE), 'utf8'));
    } catch {
      prev = null;
    }
    const already = new Set(briefing.receiptKeys(prev));
    return briefing.pendingFor(state, id).filter((r) => !already.has(r.key));
  } catch {
    return []; // defter yok/bozuk → sessiz geç (lider normal turunu koşar)
  }
}

/**
 * MAKBUZ — "lider bunları gördü". main bunu tüketip kayıtları ack'ler, böylece aynı
 * bitiş bir de pane'e enjekte edilmez (çift anlatım = ADP-667'nin çözdüğü israf).
 *
 * AYRI dosya olması ŞART: hook AYRI BİR SÜREÇTİR ve `delegation-supervisor.json`'a
 * yazsaydı main'in oku-değiştir-yaz döngüsüyle yarışıp uçuştaki kayıtları SİLEBİLİRDİ
 * (atomik rename yalnız yarım dosyayı önler, KAYIP GÜNCELLEMEYİ değil).
 */
function commitReceipt(home, agentId, records) {
  const list = Array.isArray(records) ? records.filter(Boolean) : [];
  if (!list.length || !home) return false;
  const receiptPath = path.join(home, briefing.RECEIPT_FILE);
  let prev = null;
  try {
    prev = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
  } catch {
    prev = null;
  }
  let next = prev;
  for (const rec of list) next = briefing.mergeReceipt(next, { key: rec.key, leaderId: agentId });
  const tmp = `${receiptPath}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
    renameWithRetrySync(tmp, receiptPath); // atomik: main asla yarım dosya okumaz
    restrictFile(receiptPath); // ADP-835 (790 I3) — win32'de durumu dürüstçe raporlar
    return true;
  } catch {
    try { fs.unlinkSync(tmp); } catch { /* best-effort */ }
    return false;
  }
}

/**
 * `--home` / `--agent` argüman çifti (iki hook dosyası da AYNI sözleşmeyi konuşur).
 * Home AÇIKÇA verilir (main biliyor); verilmediyse instance env'inden türetilir —
 * ama env mirası yanıltıcı olabildiği için ([[e2e-pane-env-instance-bypass]]) açık
 * argüman KAZANIR.
 */
function parseArgs(argv) {
  const list = Array.isArray(argv) ? argv : [];
  const argOf = (name) => {
    const i = list.indexOf(name);
    return i >= 0 && i + 1 < list.length ? String(list[i + 1]) : '';
  };
  let home = argOf('--home').trim();
  if (!home) {
    try {
      home = require('../config/instancePaths.cjs').crewpaneHome();
    } catch {
      home = '';
    }
  }
  return { home, agentId: argOf('--agent').trim(), event: argOf('--event').trim() };
}

module.exports = {
  STATE_FILE,
  pendingFor,
  commitReceipt,
  parseArgs,
  briefingText: briefing.briefingText, // metin TEK yerde yaşar (leaderBriefing.cjs)
};
