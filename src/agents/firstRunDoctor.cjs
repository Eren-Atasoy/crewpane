// ADP-625 — İLK AÇILIŞ DOKTORU (ADP-616 §5.4).
//
// SORUN (ADP-616 §5.2 + ADP-615): yeni bir makinede eksik olan her şey müşteriye
// HAM TEKNİK HATA olarak görünüyordu — en kötüsü `TypeError: Failed to fetch`.
// Bir SaaS'ın ilk açılışında bu tek cümle güveni bitirir. Eksiklik bir HATA değil,
// bir DURUMDUR: ne eksik, ne olacak, ne yapmalı.
//
// Bu modül tek bir soruya cevap verir: "bu kurulum çalışır durumda mı?" — ve
// cevabı üç renkli, aksiyonu belli bir liste olarak döner:
//
//   ok   ✅ çalışıyor
//   warn ⚠️  çalışıyor ama eksik (uygulama açılır, o özellik kapalı)
//   fail ❌ bu haliyle çalışmaz (yine de uygulama AÇILIR — kapı değil, teşhis)
//
// SÖZLEŞME — bu modül ASLA:
//   • throw etmez (her kontrol kendi hatasını yutar; doktor hastayı öldürmez),
//   • uygulamayı bloklamaz (hiçbir kontrol "kapı" değildir),
//   • ham exception metnini kullanıcı diline sızdırmaz (`detail` bizim cümlemiz;
//     ham metin YALNIZ `raw` alanında, destek/log için).
//
// SAF + ENJEKTE EDİLEBİLİR: I/O'nun tamamı `deps` üzerinden gelir (fs, fetch,
// motor probu, hesap anlık görüntüsü) → Electron'suz `node --test` edilebilir.
// Çalıştır: node --test electron/firstRunDoctor.test.cjs

'use strict';

const nodeFs = require('node:fs');
const nodePath = require('node:path');
// ADP-835 (790 I1) — "dar izinli klasör" iddiası platforma göre DEĞİŞİR:
// POSIX'te 0o700 ölçülebilir, Windows'ta izin bitleri anlamsızdır ve ACL'i
// ölçmedik. Doktor bu farkı SÖYLER; sessizce "yerinde" demez.
const { restrictDir, auditRestriction, STATES } = require('../../platform/restrictPath.cjs');
// ADP-907 — YABANCI KANCA teşhisi: "bu komutu çalıştıracak program kurulu mu?"
// sorusunu motor CLI'larıyla AYNI boğazdan sorar (üç-durumlu: present/absent/unknown).
const { resolveBinaryState } = require('../../platform/binResolve.cjs');
// ADP-911 — o soruyu SORARKEN kullanılacak PATH: uygulamanın ham PATH'i DEĞİL,
// kancanın gerçekte koşacağı zenginleştirilmiş PATH (aşağıdaki `hookProbePath` bloğu).
const envPath = require('../../platform/envPath.cjs');

const OK = 'ok';
const WARN = 'warn';
const FAIL = 'fail';

/** Kötüden iyiye sıralama — genel durum = en kötü kontrol. */
const SEVERITY = { [OK]: 0, [WARN]: 1, [FAIL]: 2 };

/**
 * ADP-616 §5.3 — yeni makinede OLUŞMASI GEREKEN dizinler.
 * `mode` verilenler gizli veri tutar (0700: yalnız kullanıcı).
 * Hepsi idempotent oluşturulur — var olanı bozmaz, ikinci koşuda no-op.
 */
// ADP-703 — `device: true` = CİHAZ kökünde yaşar (hesap kökünde DEĞİL).
// `auth/` hesabı BELİRLEYEN blob'ları tutar (session.bin/license.bin), yani hesap
// kökünün İÇİNDE olamaz — döngü olurdu (bkz. docs/design/ACCOUNT-SCOPED-STORE.md §2/17).
// GERÇEK APP ÖLÇÜMÜ: bu bayrak yokken doktor her hesap kökünde BOŞ bir `auth/`
// yaratıyordu (adp703 spec'i S5'te kırmızı verdi) — zararsız ama yanıltıcı: "oturumum
// hesabın içinde" izlenimi verir ve ADP-704 senkron kapsamını kirletirdi.
const REQUIRED_DIRS = [
  { rel: '', label: 'yapılandırma klasörü' },
  { rel: 'auth', label: 'oturum klasörü', mode: 0o700, device: true },
  { rel: 'credentials', label: 'anahtar kasası', mode: 0o700 },
  { rel: 'memory', label: 'ajan hafızası' },
];

/** Ağ hatası mı (sunucuya ULAŞILAMADI) yoksa sunucu mu konuştu? */
function isNetworkFailure(err) {
  const name = String((err && err.name) || '');
  const msg = String((err && err.message) || err || '');
  if (name === 'AbortError' || name === 'TimeoutError') return true;
  return /fetch failed|failed to fetch|ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|ENETUNREACH|ETIMEDOUT|network|socket hang up/i.test(
    msg,
  );
}

/**
 * Dizin kontrolü — eksikleri OLUŞTURUR (§5.4 adım 1: "idempotent, tek yerde").
 * Oluşturmak bir uyarı sebebi DEĞİLDİR: ilk açılışta hepsi eksiktir, bu normaldir.
 * Yalnız oluşturULAMAYAN bir dizin ❌'tir (disk dolu / izin yok).
 */
function checkDirs(deps) {
  const fs = deps.fs || nodeFs;
  const home = deps.home;
  if (typeof home !== 'string' || !home) {
    // Çağıran ev dizinini veremediyse HİÇBİR ŞEY yaratmayız (rastgele bir yola
    // yazmak, bu kontrolün önlemeye çalıştığı hasarın ta kendisidir).
    return {
      id: 'dirs',
      label: 'Yerel klasörler',
      status: WARN,
      detail: 'Yapılandırma klasörü bu ortamda çözümlenemedi.',
    };
  }
  // ADP-703 — cihaz girdileri instance kökünde kontrol edilir. `deviceHome`
  // verilmezse `home`a düşer → hesap kapsamı OLMAYAN çağıranlar (ve mevcut birim
  // testleri) için davranış birebir aynı kalır.
  const deviceHome = typeof deps.deviceHome === 'string' && deps.deviceHome ? deps.deviceHome : home;
  const created = [];
  const broken = [];
  const unprotected = [];   // ölçtük: DAR DEĞİL
  const unmeasured = [];    // ölçemedik (win32 ACL) — "korunuyor" DEMİYORUZ
  const platform = deps.platform || process.platform;
  for (const d of REQUIRED_DIRS) {
    const base = d.device ? deviceHome : home;
    const dir = d.rel ? nodePath.join(base, d.rel) : base;
    try {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true, ...(d.mode ? { mode: d.mode } : {}) });
        created.push(d.label);
      }
    } catch (err) {
      broken.push({ label: d.label, raw: String((err && err.message) || err) });
      continue;
    }
    if (!d.mode) continue;
    // ADP-835 (790 I1) — sır taşıyan klasörün kısıtlaması TEK BOĞAZDAN geçer ve
    // sonucu RAPORLANIR. `mkdirSync(...,{mode})` VAR OLAN bir klasörün modunu
    // değiştirmez; boğaz idempotent olarak uygular (POSIX) ya da uygulanamadığını
    // söyler (win32).
    restrictDir(dir, { mode: d.mode, fs, platform });
    const audit = auditRestriction(dir, { mode: d.mode, fs, platform });
    if (audit.state === STATES.FAILED) unprotected.push(d.label);
    else if (audit.state === STATES.UNKNOWN) unmeasured.push(d.label);
  }
  if (broken.length) {
    return {
      id: 'dirs',
      label: 'Yerel klasörler',
      status: FAIL,
      detail: `Şu klasörler oluşturulamadı: ${broken.map((b) => b.label).join(', ')}. Disk dolu olabilir ya da ${home} yazılamıyor olabilir.`,
      hint: 'Diskte yer aç veya klasör izinlerini kontrol et.',
      raw: broken.map((b) => `${b.label}: ${b.raw}`).join(' | '),
    };
  }
  const base = created.length
    ? `Eksik klasörler oluşturuldu: ${created.join(', ')}.`
    : 'Ayarlar, oturum, anahtar ve hafıza klasörleri yerinde.';
  // ÖLÇTÜK ve DAR DEĞİL → gerçek bir uyarı (sırlar başka yerel kullanıcıya açık).
  if (unprotected.length) {
    return {
      id: 'dirs',
      label: 'Yerel klasörler',
      status: WARN,
      detail: `${base} Ancak şu klasörler dar izinli DEĞİL: ${unprotected.join(', ')}.`,
      hint: 'Klasör izinlerini yalnız kendi kullanıcına açık olacak şekilde daralt.',
      meta: home,
    };
  }
  // ÖLÇEMEDİK (win32 ACL) → sessizce "yerinde" DEMEK yalan olurdu; OK kalır ama
  // durum açıkça yazılır (793 §C-P5 çıkış kapısı: "ne yaptığını söylüyor").
  return {
    id: 'dirs',
    label: 'Yerel klasörler',
    status: OK,
    detail: unmeasured.length
      ? `${base} Klasör izinleri bu platformda ACL ile yönetilir; daraltma DOĞRULANMADI (${unmeasured.join(', ')}).`
      : base,
    meta: home,
  };
}

/**
 * Backend erişimi — §5.4 adım 2/3.
 *
 * "Ulaşılabilir" = SUNUCU CEVAP VERDİ. 401/404 bile ulaşılabilirdir (PostgREST
 * kökü anahtarsız 401 döner) — yetki ayrı bir sorundur, bağlantı sorunu değil.
 * ❌ yalnızca hiç cevap gelmediğinde (ağ yok / adres ölü / zaman aşımı).
 */
async function checkBackend(deps) {
  const target = deps.backend || {};
  if (!target.url || !target.anonKey) {
    return {
      id: 'backend',
      label: 'Uygulama sunucusu',
      status: FAIL,
      detail:
        'Sunucu adresi ayarlı değil. Ofis, görevler ve ekip verisi yüklenemez; terminal ve dosyalar çalışmaya devam eder.',
      hint: 'Kurulumu tamamla ya da destek ile iletişime geç.',
    };
  }
  const fetchImpl = deps.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    return {
      id: 'backend',
      label: 'Uygulama sunucusu',
      status: WARN,
      detail: 'Bağlantı kontrolü bu ortamda yapılamadı.',
      meta: target.url,
    };
  }
  const timeoutMs = deps.timeoutMs || 6000;
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const res = await fetchImpl(`${String(target.url).replace(/\/+$/, '')}/rest/v1/`, {
      method: 'GET',
      headers: { apikey: target.anonKey, Authorization: `Bearer ${target.anonKey}` },
      ...(controller ? { signal: controller.signal } : {}),
    });
    const status = Number(res && res.status) || 0;
    if (status >= 500) {
      return {
        id: 'backend',
        label: 'Uygulama sunucusu',
        status: WARN,
        detail: 'Sunucuya ulaşıldı ama şu an hata veriyor. Bağlantı kurulduğunda pano kendiliğinden dolar.',
        meta: `${target.url} · HTTP ${status}`,
      };
    }
    return {
      id: 'backend',
      label: 'Uygulama sunucusu',
      status: OK,
      detail: 'Bağlı.',
      meta: `${target.url}${target.schema ? ` · ${target.schema}` : ''}`,
    };
  } catch (err) {
    const offline = isNetworkFailure(err);
    return {
      id: 'backend',
      label: 'Uygulama sunucusu',
      status: FAIL,
      detail: offline
        ? 'Sunucuya ulaşılamıyor — çevrimdışı çalışıyorsun. Terminal, dosyalar ve ajanlar çalışır; ofis ve görev panosu bağlantı gelince kendiliğinden dolar.'
        : 'Sunucu yanıtı beklendiği gibi değil. Bağlantı kurulduğunda pano kendiliğinden dolar.',
      hint: 'İnternet bağlantını kontrol et — uygulama tekrar denemeye devam ediyor.',
      meta: target.url,
      raw: String((err && err.message) || err), // destek/log için; kullanıcı cümlesi yukarıda
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * CrewPane ID oturumu + lisans (ADP-622/628).
 *
 * Kimlik modu 'crewpane-id' DEĞİLSE (yerel 54321 / e2e stack) bu kontrol
 * anlamsızdır → ✅ "bu kurulumda gerekmiyor" (gereksiz uyarı üretmeyiz).
 */
function checkIdentity(deps) {
  const account = deps.account || null;
  const identityMode = deps.identityMode || 'anon';
  if (identityMode !== 'crewpane-id' && identityMode !== 'crewpane-id') {
    return {
      id: 'identity',
      label: 'CrewPane ID',
      status: OK,
      detail: 'Bu kurulumda hesap girişi gerekmiyor (yerel veritabanı).',
    };
  }
  if (!account) {
    return {
      id: 'identity',
      label: 'CrewPane ID',
      status: WARN,
      detail: 'Hesap durumu okunamadı. Ayarlar → Hesap ekranından giriş durumunu kontrol edebilirsin.',
      action: { label: 'Hesap ayarları', category: 'account' },
    };
  }
  if (!account.signedIn) {
    return {
      id: 'identity',
      label: 'CrewPane ID',
      status: WARN,
      detail: 'Giriş yapılmadı. Ofis verisi hesabına bağlı — giriş yapmadan kişisel ofisin yüklenmez.',
      hint: 'Ayarlar → Hesap üzerinden CrewPane hesabınla giriş yap.',
      action: { label: 'Hesap ayarları', category: 'account' },
    };
  }
  const license = String(account.licenseStatus || 'none');
  if (license === 'expired' || license === 'invalid') {
    return {
      id: 'identity',
      label: 'CrewPane ID',
      status: WARN,
      detail:
        license === 'expired'
          ? 'Lisansın süresi dolmuş. Giriş açık ama lisansa bağlı özellikler kapalı.'
          : 'Lisans doğrulanamadı. Giriş açık ama lisansa bağlı özellikler kapalı.',
      hint: 'Ayarlar → Hesap üzerinden lisansı yenile.',
      action: { label: 'Hesap ayarları', category: 'account' },
      meta: account.email || undefined,
    };
  }
  return {
    id: 'identity',
    label: 'CrewPane ID',
    status: OK,
    detail: license === 'grace' ? 'Giriş yapıldı (lisans çevrimdışı doğrulandı).' : 'Giriş yapıldı, lisans geçerli.',
    meta: account.email || undefined,
  };
}

/**
 * AI motoru CLI'ları (ADP-615). Hiçbiri kurulu değilse ajan koşamaz — ama bu bir
 * ÇÖKME değil, bir KURULUM ADIMIDIR: rehber + link veririz.
 */
async function checkEngines(deps) {
  const probe = deps.checkEngines;
  if (typeof probe !== 'function') {
    return { id: 'engines', label: 'AI motoru', status: WARN, detail: 'Motor kontrolü bu ortamda yapılamadı.' };
  }
  let result;
  try {
    result = await probe();
  } catch {
    result = null;
  }
  const engines = (result && Array.isArray(result.engines) ? result.engines : []).map((e) => ({
    id: e.id,
    label: e.label || e.id,
    found: !!e.found,
    // ADP-833 (ADR-W7) — üç-durum: 'unknown' = ÖLÇEMEDİK. Eski main → türet.
    state: e.state || (e.found ? 'present' : 'absent'),
    installUrl: e.installUrl || null,
    // ADP-694 — Eren'in sorusu ("indirmesini mi sağlayacağız?"): link tek başına
    // yetmiyor. Eksik motorun kopyalanabilir kurulum KOMUTU da rapora giriyor.
    // OTOMATİK KURULUM YOK — bu üçüncü-parti CLI'lar kendi hesaplarını ister.
    installCommand: e.installCommand || null,
  }));
  const found = engines.filter((e) => e.found).map((e) => e.id);
  const missing = engines.filter((e) => !e.found);
  const unknown = engines.filter((e) => e.state === 'unknown');
  if (!engines.length) {
    return { id: 'engines', label: 'AI motoru', status: WARN, detail: 'Motor kontrolü sonuç vermedi.' };
  }
  // ADP-833 (ADR-W7) — hiçbiri BULUNAMADI ama en az biri ÖLÇÜLEMEDİYSE, "hiçbir motor
  // kurulu değil" (FAIL) demek YALAN olur: motor kurulu olabilir, biz okuyamadık.
  // Bu tam olarak Windows'un "kur → hâlâ yok diyor" döngüsünün başladığı yer.
  if (!found.length && unknown.length) {
    return {
      id: 'engines',
      label: 'AI motoru',
      status: WARN,
      detail: `Motor durumu kontrol edilemedi (${unknown.map((e) => e.id).join(', ')}) — kurulu olup olmadığını okuyamadık.`,
      hint: 'Uygulamayı yeniden başlatıp tekrar dene. Sorun sürerse motoru kurup Ayarlar → AI Motorları üzerinden giriş yap.',
      action: { label: 'AI Motorları', category: 'engines' },
    };
  }
  if (!found.length) {
    return {
      id: 'engines',
      label: 'AI motoru',
      status: FAIL,
      detail:
        'Hiçbir AI motoru kurulu değil. Ajanlar bu haliyle çalışamaz — uygulamanın geri kalanı (ofis, dosyalar, terminal) açılır.',
      hint: 'Kurulum gerekli: en az bir motoru (claude ya da codex) kur, sonra Ayarlar → AI Motorları üzerinden hesabınla giriş yap.',
      action: { label: 'AI Motorları', category: 'engines' },
      links: missing.filter((e) => e.installUrl).map((e) => ({ label: `${e.label} kurulumu`, url: e.installUrl })),
      // ADP-694 — tek tık kopyalanabilir kurulum komutları (UI `SystemStatusSection`
      // bunları kopyala düğmesiyle çizer). Boşsa alan hiç eklenmez (eski davranış).
      commands: missing
        .filter((e) => e.installCommand)
        .map((e) => ({ label: e.label, command: e.installCommand })),
    };
  }
  if (missing.length) {
    return {
      id: 'engines',
      label: 'AI motoru',
      status: OK,
      detail: `Kurulu: ${found.join(', ')}. (${missing.map((e) => e.id).join(', ')} kurulu değil — gerekmiyorsa sorun değil.)`,
      action: { label: 'AI Motorları', category: 'engines' },
      // ADP-694 — burada durum ✅ (en az bir motor var), ama eksik olanın komutu yine
      // gösterilir: kullanıcı ikinci motoru istediğinde Ayarlar'a gitmek zorunda kalmaz.
      commands: missing
        .filter((e) => e.installCommand)
        .map((e) => ({ label: e.label, command: e.installCommand })),
    };
  }
  return {
    id: 'engines',
    label: 'AI motoru',
    status: OK,
    detail: `Kurulu: ${found.join(', ')}.`,
    action: { label: 'AI Motorları', category: 'engines' },
  };
}

/** Çalışma alanı kökü — ajanların dosya gördüğü klasör (ADP-616 §5.3). */
function checkWorkspace(deps) {
  const fs = deps.fs || nodeFs;
  const root = deps.workspaceRoot;
  // ADP-852 v3 — "SEÇİLMEDİ" ile "SEÇİLDİ AMA ERİŞİLEMİYOR" AYNI HÜKÜM DEĞİL.
  // Müşteri (0.2.27) Ayarlar→Genel'de klasörünü DOLU görürken burada
  // "Çalışma klasörü seçilmedi" yazıyordu → ekran kendi ayarını yalanlıyordu.
  // `workspaceStatus` (agentSettings.configuredWorkspaceRootStatus) artık SEÇİLEN
  // yolu ve NEDEN tutmadığını taşır; iki ekran aynı gerçeği anlatır.
  const st = deps.workspaceStatus || null;
  if (!root && st && st.configured) {
    if (st.reason === 'denied') {
      return {
        id: 'workspace',
        label: 'Çalışma alanı',
        status: WARN,
        detail: 'Seçili çalışma klasörüne erişim izni yok. Ajanlar dosyalarını göremez.',
        hint: 'Sistem Ayarları → Gizlilik ve Güvenlik → Dosyalar ve Klasörler altında '
          + 'CrewPane\'e izin ver (Belgeler/İndirilenler/Masaüstü), ya da Ayarlar → Genel\'den '
          + 'erişilebilir başka bir klasör seç.',
        action: { label: 'Genel ayarlar', category: 'general' },
        meta: st.configured,
      };
    }
    return {
      id: 'workspace',
      label: 'Çalışma alanı',
      status: WARN,
      detail: 'Seçili çalışma klasörü bulunamadı (taşınmış ya da silinmiş olabilir).',
      hint: 'Ayarlar → Genel üzerinden klasörü yeniden seç.',
      action: { label: 'Genel ayarlar', category: 'general' },
      meta: st.configured,
    };
  }
  if (!root) {
    return {
      id: 'workspace',
      label: 'Çalışma alanı',
      status: WARN,
      detail: 'Çalışma klasörü seçilmedi. Ajanlar dosyalarını göremez.',
      hint: 'Ayarlar → Genel üzerinden bir klasör seç.',
      action: { label: 'Genel ayarlar', category: 'general' },
    };
  }
  let exists = false;
  let deniedCode = null; // ADP-852 v3 — EPERM/EACCES "yok" değil "bakamıyorum"dur
  try {
    exists = fs.existsSync(root) && fs.statSync(root).isDirectory();
  } catch (e) {
    exists = false;
    if (e && (e.code === 'EPERM' || e.code === 'EACCES')) deniedCode = e.code;
  }
  if (deniedCode) {
    return {
      id: 'workspace',
      label: 'Çalışma alanı',
      status: WARN,
      detail: 'Seçili çalışma klasörüne erişim izni yok. Ajanlar dosyalarını göremez.',
      hint: 'Sistem Ayarları → Gizlilik ve Güvenlik → Dosyalar ve Klasörler altında '
        + 'CrewPane\'e izin ver, ya da Ayarlar → Genel\'den erişilebilir başka bir klasör seç.',
      action: { label: 'Genel ayarlar', category: 'general' },
      meta: root,
    };
  }
  if (!exists) {
    return {
      id: 'workspace',
      label: 'Çalışma alanı',
      status: WARN,
      detail: 'Seçili çalışma klasörü bulunamadı (taşınmış ya da silinmiş olabilir).',
      hint: 'Ayarlar → Genel üzerinden klasörü yeniden seç.',
      action: { label: 'Genel ayarlar', category: 'general' },
      meta: root,
    };
  }
  return { id: 'workspace', label: 'Çalışma alanı', status: OK, detail: 'Hazır.', meta: root };
}

// ─── ADP-907 — YABANCI KANCALAR (bizim olmayan hatalar, bizim penceremizde) ────
//
// VAKA: yeni müşterinin İLK ekranı kırmızı hata satırlarıyla doluydu. Hatalar
// CrewPane'in değildi: makinede kurulu BAŞKA bir araç, kullanıcının
// `~/.claude/settings.json`'ına her turda çalışan komutlar (hook) yazmış ve o
// komutlar çıplak `node` ile başlıyordu. O makinede Node kurulu değil → claude her
// turda kancayı çalıştırmayı deniyor, ENOENT basıyor. Kullanıcı ekranda bunu
// görüyor ve "CrewPane bozuk" diye okuyor.
//
// SÖZLEŞMEMİZ (bu modülün tamamı için geçerli olanın üstüne):
//   • KULLANICININ AYAR DOSYASINA ASLA YAZMAYIZ. Bu kontrol SALT-OKUNUR — teşhis
//     eder, cümleye döker, iki seçeneği anlatır; kararı kullanıcı verir.
//   • "ÖLÇEMEDİM" ≠ "YOK". Yorumlayıcı probu `unknown` derse (PATH okunamadı,
//     beklenmedik fs hatası) UYARI ÜRETMEYİZ — yanlış alarm, gerçek alarmdan
//     daha pahalıdır (ADP-833 dersi: Windows'un "kur → hâlâ yok diyor" döngüsü).
//   • YALNIZ ÇIPLAK YORUMLAYICI ADI. `~/.claude/hooks/foo` gibi yol içeren bir
//     komut bizim işimiz değil (yolu biz çözemeyiz, kabuk çözer); `node`,
//     `python`… gibi PATH'ten aranan adlar ise tam olarak burada ölçülebilir.

/** PATH'ten aranan, kancalarda yaygın yorumlayıcılar. Kapalı liste — genişletmek bilinçli bir karardır. */
const HOOK_INTERPRETERS = Object.freeze(['node', 'python', 'python3', 'bun', 'deno']);

/** Windows'ta aynı yorumlayıcı `node.exe` diye yazılmış olabilir; eşleştirme uzantısız yapılır. */
const EXEC_SUFFIX = /\.(exe|cmd|bat)$/i;

/** Kullanıcının GÖRDÜĞÜ yol — platformun kendi dili (destek konuşmasında bu yazılır). */
function hookSettingsDisplayPath(scope, platform, absPath) {
  if (scope !== 'user') return absPath;
  return platform === 'win32' ? '%USERPROFILE%\\.claude\\settings.json' : '~/.claude/settings.json';
}

/**
 * Bir hook komutunun İLK SÖZCÜĞÜ çıplak bir yorumlayıcı adı mı?
 * → 'node' | 'python3' | … | null (yol içeriyor, tırnakla başlıyor, listede değil)
 * Saf: I/O yok.
 */
function bareInterpreter(command) {
  const raw = typeof command === 'string' ? command.trim() : '';
  if (!raw) return null;
  const first = raw.split(/\s+/, 1)[0];
  // Tırnakla başlayan hedef = tam yol yazılmış (ya da boşluklu ad) → PATH'ten aranmaz.
  if (!first || first.startsWith('"') || first.startsWith("'")) return null;
  // Yol içeren hedef (mutlak/göreli/`~`) PATH'te ARANMAZ → bu kontrolün konusu değil.
  if (/[\\/]/.test(first) || first.startsWith('~')) return null;
  // `VAR=deger node x.js` gibi env ön-ekleri: ilk sözcük yorumlayıcı DEĞİL → atla.
  if (first.includes('=')) return null;
  const name = first.replace(EXEC_SUFFIX, '').toLowerCase();
  return HOOK_INTERPRETERS.includes(name) ? name : null;
}

/**
 * `hooks.<Olay>[].hooks[].command` metinlerini düzleştir. Bir claude ayar dosyasının
 * kanca şeması bu; şekli bozuk her düğüm SESSİZCE atlanır (doktor hastayı öldürmez).
 * Saf: I/O yok.
 */
function collectHookCommands(settings) {
  const out = [];
  const hooks = settings && typeof settings === 'object' ? settings.hooks : null;
  if (!hooks || typeof hooks !== 'object') return out;
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      const list = group && Array.isArray(group.hooks) ? group.hooks : [];
      for (const entry of list) {
        const command = entry && typeof entry.command === 'string' ? entry.command : '';
        if (command.trim()) out.push({ event, command: command.trim() });
      }
    }
  }
  return out;
}

/** Taranacak ayar dosyaları (kullanıcı + proje). Sıra = claude'un kendi okuma sırası. */
function hookSettingsFiles(deps) {
  const platform = deps.platform || process.platform;
  const P = platform === 'win32' ? nodePath.win32 : nodePath.posix;
  const files = [];
  const push = (scope, base, name) => {
    if (typeof base !== 'string' || !base) return;
    const abs = P.join(base, '.claude', name);
    if (files.some((f) => f.path === abs)) return; // proje kökü = ev dizini olabilir
    files.push({ scope, path: abs, displayPath: hookSettingsDisplayPath(scope, platform, abs) });
  };
  push('user', deps.userHome, 'settings.json');
  push('project', deps.workspaceRoot, 'settings.json');
  push('project', deps.workspaceRoot, 'settings.local.json');
  return files;
}

// ── ADP-911 — PROBUN PATH'i: UYGULAMANIN DEĞİL, KANCANIN PATH'i ───────────────
//
// YANLIŞ ALARM (Eren'in makinesinde ölçüldü, 0.2.30-dev.2): node KURULU
// (`/opt/homebrew/bin/node`, v23.6.1) ama doktor "Node.js kurulu değil" dedi.
// Sebep tek satırdı: prob `deps.env` içindeki HAM PATH ile ölçüyordu. macOS'ta
// Dock/Finder'dan açılan bir GUI uygulaması login shell'den geçmez; launchd ona
// asgari bir PATH verir (`/usr/bin:/bin:/usr/sbin:/sbin`) — Homebrew'un
// `/opt/homebrew/bin`'i orada YOKTUR. Yani ölçtüğümüz PATH, kancanın gerçekte
// koşacağı PATH DEĞİLDİ.
//
// Kanca `claude` süreci tarafından çalıştırılır; `claude`'u biz spawn ediyoruz ve
// pane'e verdiğimiz PATH `agentRunner.augmentedPath` = `envPath.augment(...)`.
// Doğru ölçüm bu yüzden AYNI zenginleştirmeden geçmek zorunda — `mcpNode.resolveMcpNode`
// node'u tam olarak böyle arıyor (ADP-891). Burada o desen YENİDEN YAZILMAZ, ÇAĞRILIR.
//
// ÜÇ-DURUM KORUNUR (ADP-907 §2): present→sessizlik, absent→bulgu, unknown→SESSİZLİK.
// Zenginleştirme yalnız yanlış `absent`i eler; "ölçemedim"i "var"a çevirmez.
/**
 * Yorumlayıcı probunun tarayacağı PATH.
 *
 * Dayatma sırası (ilk eşleşen kazanır):
 *   1. `deps.searchPath` — birim testlerin dikişi: verilen dize AYNEN kullanılır.
 *   2. `CREWPANE_HOOK_SCAN_PATH` / `CREWPANE_HOOK_SCAN_PATH` env dikişi (main.js
 *      bunu `env.PATH` olarak yazar) — e2e "program yok/var/ölçemedim" üç vakasını
 *      gerçek PATH'e dokunmadan kurar. Dayatılmış PATH ZENGİNLEŞTİRİLMEZ: dikişin
 *      anlamı "tam olarak bu PATH"tir; üstüne Homebrew eklemek vakayı yok ederdi.
 *   3. Üretim: `envPath.augment(env.PATH, …)` — kancanın gerçekte koşacağı PATH.
 *      `readRegistry:false`: burası açılış yolunda senkron koşar (agentRunner'ın
 *      pane spawn'ında yaptığı tercihin aynısı).
 */
function hookProbePath(deps) {
  const platform = deps.platform || process.platform;
  const env = deps.env || process.env;
  if (deps.searchPath !== undefined) return String(deps.searchPath == null ? '' : deps.searchPath);
  const seam = env.CREWPANE_HOOK_SCAN_PATH;
  if (typeof seam === 'string') return typeof env.PATH === 'string' ? env.PATH : seam;
  // `home` KULLANICININ ev dizinidir (`~/.local/bin` oradan türer) — `deps.home`
  // ~/.crewpane instance köküdür, bu listeye girmez.
  return envPath.augment(env.PATH, { platform, env, home: deps.userHome, readRegistry: false });
}

/**
 * ADP-907 — başka bir aracın kurduğu, çalışamayan kancalar.
 *
 * @returns {{id:'foreignHooks', label:string, status:'ok'|'warn', detail:string, hint?:string,
 *            meta?:string, foreign?:{interpreters:string[], files:Array, entries:Array}}}
 */
function checkForeignHooks(deps) {
  const fs = deps.fs || nodeFs;
  const platform = deps.platform || process.platform;
  const env = deps.env || process.env;
  const files = hookSettingsFiles(deps);
  // ADP-911 — ölçüm PATH'i: uygulamanınki değil, kancanın koşacağı (yukarıdaki blok).
  const searchPath = hookProbePath(deps);
  const probeEnv = { ...env, PATH: searchPath };

  const missing = [];    // ÖLÇTÜK: yorumlayıcı YOK → gerçek bulgu
  const unmeasured = []; // ÖLÇEMEDİK: 'yok' DEMİYORUZ (yanlış alarm yasak)
  let scanned = 0;       // okunabilen dosya sayısı
  let commandCount = 0;  // görülen kanca komutu sayısı
  const probeCache = new Map();
  const probe = (name) => {
    if (!probeCache.has(name)) probeCache.set(name, resolveBinaryState(name, probeEnv, { fs, platform }));
    return probeCache.get(name);
  };

  for (const file of files) {
    let parsed = null;
    try {
      // Dosya yoksa/bozuksa bu bir BULGU DEĞİLDİR: kullanıcının kancası yok demektir.
      parsed = JSON.parse(fs.readFileSync(file.path, 'utf8'));
    } catch {
      continue;
    }
    scanned += 1;
    for (const { event, command } of collectHookCommands(parsed)) {
      commandCount += 1;
      const interpreter = bareInterpreter(command);
      if (!interpreter) continue;
      const state = probe(interpreter).state;
      if (state === 'absent') missing.push({ ...file, event, command, interpreter });
      else if (state === 'unknown') unmeasured.push({ ...file, event, command, interpreter });
    }
  }

  if (!missing.length) {
    const detail = !scanned
      ? 'Başka bir aracın kurduğu kanca bulunmadı.'
      : unmeasured.length
        ? `Başka araçların kurduğu ${commandCount} kanca var; ${unmeasured.length} tanesinin gerektirdiği program bu ortamda OKUNAMADI — ölçemediğimiz için bir şey iddia etmiyoruz.`
        : `Başka araçların kurduğu ${commandCount} kanca var; gerektirdikleri programlar kurulu.`;
    return { id: 'foreignHooks', label: 'Başka araçların kancaları', status: OK, detail };
  }

  // Aynı yorumlayıcı/dosya onlarca kanca girdisinde tekrar eder — kullanıcıya SAYI değil
  // ANLAM lazım: hangi program eksik, hangi dosyada yazıyor.
  const interpreters = [...new Set(missing.map((m) => m.interpreter))];
  const byFile = [];
  for (const m of missing) {
    let row = byFile.find((f) => f.path === m.path);
    if (!row) {
      row = { scope: m.scope, path: m.path, displayPath: m.displayPath, count: 0, events: [] };
      byFile.push(row);
    }
    row.count += 1;
    if (!row.events.includes(m.event)) row.events.push(m.event);
  }
  const programs = interpreters.join(', ');
  return {
    id: 'foreignHooks',
    label: 'Başka araçların kancaları',
    status: WARN,
    detail:
      `Bilgisayarında başka bir araç, her mesajda çalışan komutlar (kanca) tanımlamış: ${byFile[0].displayPath}. ` +
      `Bu komutlar ${programs} programını istiyor ama bu bilgisayarda kurulu değil — ekranda gördüğün kırmızı satırlar bundan geliyor. ` +
      'CrewPane bu durumdan etkilenmiyor: ajanlar, terminal ve dosyalar normal çalışıyor.',
    hint:
      `İki yolun var: ya ${programs} kurulur ve o araç çalışmaya başlar, ya da ayar dosyasındaki o kanca girdisi kaldırılır. ` +
      'Ayar dosyası senin; CrewPane onu kendiliğinden değiştirmez.',
    meta: byFile[0].displayPath,
    // ADP-911 — DESTEK ALANI (kullanıcıya çizilmez): "kurulu ama yok dedi" şikâyeti
    // ancak PROBUN taradığı PATH ile teşhis edilebilir. Uygulamanın ham PATH'i ile
    // arasındaki fark tam olarak bu bug sınıfının imzasıdır.
    raw: `prob PATH=${searchPath}`,
    // Kart bu yapıyı çizer (detail metnini AYRIŞTIRMAZ — ekran ile ölçüm tek kaynaktan).
    foreign: { interpreters, files: byFile, entries: missing.map((m) => ({ event: m.event, interpreter: m.interpreter, path: m.path })) },
  };
}

/** Genel durum = en kötü kontrol (tek bakışta yeşil/sarı/kırmızı). */
function worstStatus(checks) {
  let worst = OK;
  for (const c of checks) if (SEVERITY[c.status] > SEVERITY[worst]) worst = c.status;
  return worst;
}

/**
 * Tüm kontrolleri koş.
 *
 * @param {object} deps
 *   home            {string}   ~/.crewpane[-dev|-test]
 *   fs              {object}   node:fs ikamesi (test)
 *   fetchImpl       {Function} global fetch ikamesi (test)
 *   backend         {{url,anonKey,schema}} ADP-621 çözümlemesi (mantığı DEĞİŞTİRİLMEZ, okunur)
 *   identityMode    {'crewpane-id'|'anon'}
 *   account         {{signedIn,email,licenseStatus}|null} seatGate anlık görüntüsü
 *   checkEngines    {Function} engineCheck.checkEngines ikamesi
 *   workspaceRoot   {string|null}
 *   timeoutMs       {number}
 *   now             {Function} Date.now ikamesi
 * @returns {Promise<{generatedAt:number, overall:'ok'|'warn'|'fail', checks:Array}>}
 */
/**
 * ENV-02 (ENV-R2 §6 · ENV-R1 §8 Faz 2 madde 6) — HANGİ ORTAMDAYIM?
 *
 * KAPATILAN SINIF: dört katman (URL şeması · uygulama DB · kimlik sunucusu · giriş
 * sayfası) üç ayrı hatta dağılabiliyor ve ürün bunu HİÇBİR EKRANDA söylemiyordu.
 * ENV-01 açılış log'una tek satır ekledi — ama GUI'den açılan bir app'te log'a
 * yazılan şey, kimsenin görmediği şeydir (`devChannel.misconfigurationWarning`
 * tam bu yüzden ADP-780-B'yi önleyemedi). Doktor, log'a bakmayan kullanıcının
 * bakabileceği tek yerdir.
 *
 * ⛔ İKİNCİ ÇÖZÜMLEME YOK: `deps.envView` main'in `envLayerView()`ından gelir —
 * banner ve arayüz rozetiyle AYNI nesne. Karışım durumu da burada TÜRETİLMEZ,
 * ENV-01'in `mixed` alanı OKUNUR.
 *
 * Renk: `mixed.level==='warn'` ⇒ ⚠️ (iki-stack lokal · test kanalı · açık kaçış),
 * aksi hâlde ✅. `block` bu ekrana hiç ULAŞAMAZ (açılış zaten durdu) ama gelirse
 * ❌ gösterilir — sessiz kalmaktansa.
 */
function checkEnvironment(deps) {
  const view = (deps && deps.envView) || null;
  const base = { id: 'env', label: 'Ortam' };
  if (!view) {
    return {
      ...base,
      status: WARN,
      detail: 'Ortam bilgisi okunamadı — hangi sunuculara bağlı olduğun bu ekranda gösterilemiyor.',
    };
  }
  // Katman listesi: ekran `detail` cümlesini AYRIŞTIRMAZ (ADP-907 `foreign` deseni).
  const layers = [
    { id: 'scheme', label: 'URL şeması', value: view.scheme ? `${view.scheme}://` : null },
    { id: 'appdb', label: 'uygulama DB', value: view.dbUrl ? `${view.dbUrl}${view.dbSchema ? ` · ${view.dbSchema}` : ''}` : null },
    { id: 'identity', label: 'kimlik sunucusu', value: view.authUrl || null },
    { id: 'login', label: 'giriş sayfası', value: view.loginUrl || null },
  ];
  // Mailpit yalnız `local`de anlamlıdır ve GÖSTERİLMELİDİR (ENV-R2 §5.1): giden
  // e-posta yoktur, yazılmazsa kullanıcı "kod gelmedi" sanır ve akış orada ölür.
  if (view.mailUrl) layers.push({ id: 'mail', label: 'giriş kodları (Mailpit)', value: view.mailUrl });

  const profile = view.profile || null;
  const channel = view.channel || null;
  const mixed = view.mixed && view.mixed.level && view.mixed.level !== 'ok' ? view.mixed : null;
  const status = !mixed ? OK : mixed.level === 'block' ? FAIL : WARN;

  const profileText = profile
    ? `Ortam profili: ${profile}.`
    : 'Ortam profili seçilmedi (CREWPANE_ENV verilmedi) — hedefler tek tek çözüldü.';
  const detail = mixed && mixed.message
    ? `${profileText} ${mixed.message}`
    : `${profileText} Aşağıdaki dört katmanın hepsi aynı karardan geliyor.`;

  const out = {
    ...base,
    status,
    detail,
    meta: [profile ? `profil=${profile}` : 'profil=yok', channel ? `kanal=${channel}` : null]
      .filter(Boolean).join(' · '),
    layers,
    env: { profile, channel, mixedReason: mixed ? mixed.reason : null },
  };
  if (!profile) {
    out.hint = 'Tek komutla hattı seçmek için: CREWPANE_ENV=local | dev | prod.';
  }
  return out;
}

/**
 * LX-SAFESTORAGE-01 (ADR-CREWPANE-LINUX §9 madde 2 · §11) — SIR SAKLAMA SATIRI.
 *
 * KAPATILAN SINIF: kullanıcı giriş yapıyor, her açılışta yeniden soruluyor ve
 * ÜRÜN HİÇBİR EKRANDA sebebini söylemiyordu (HATA-11 D6). Sebep şudur: Linux'ta
 * Chromium sır arka ucunu masaüstü ortamı BEYAN EDİLMEDİĞİNDE `basic_text` seçer
 * (libsecret kurulu ve anahtarlık AÇIK olsa bile — LX-LOGIN-01 §2.3 c/d kolları),
 * `safeStorage.isEncryptionAvailable()` false döner ve ADR-027/G2 gereği jeton
 * DİSKE YAZILMAZ (düz metin fallback YASAK).
 *
 * ⛔ BURADA ÖLÇÜM YOK: hüküm açılışta `secretBackendState` boğazından geçmiştir ve
 * bu fonksiyon onu yalnız CÜMLEYE çevirir. İkinci bir `safeStorage` sorgusu ikinci
 * bir gerçek üretirdi (ENV-02'nin `envView` deseniyle aynı kural).
 *
 * "Ölçülemedi" bir DEĞER DEĞİLDİR (ADP-721): o hâlde satır ⚠️ olur ve ne
 * bilinmediğini söyler — sessizce ✅ göstermez.
 */
function checkSecretBackend(deps) {
  const base = { id: 'secretBackend', label: 'Sır saklama' };
  const view = (deps && deps.secretBackend) || null;
  const platform = (deps && deps.platform) || process.platform;
  if (!view || view.measured !== true) {
    return {
      ...base,
      status: WARN,
      detail: 'Sır saklama arka ucu ÖLÇÜLEMEDİ — girişinin bu makinede kalıcı olup '
        + 'olmayacağını şu an söyleyemiyoruz.',
      hint: 'Uygulamayı yeniden başlatmak ölçümü tazeler.',
    };
  }
  if (view.plaintext === true) {
    return {
      ...base,
      status: FAIL,
      detail: 'KORUMASIZ (basic_text): bu makinede bir anahtar zinciri bulunamadı. '
        + 'Girişin diske YAZILMIYOR (düz metin saklama bilerek reddediliyor), bu yüzden '
        + 'uygulama her açıldığında yeniden giriş isteniyor.',
      hint: platform === 'linux'
        ? 'Masaüstü ortamı beyan edilmemiş olabilir (XDG_CURRENT_DESKTOP) ya da anahtarlık '
          + 'kurulu değildir: GNOME\'da gnome-keyring, KDE\'de kwallet.'
        : 'İşletim sisteminin anahtar zinciri kilitli ya da erişilemez durumda.',
      meta: view.backend || 'basic_text',
    };
  }
  if (view.canStore === false) {
    return {
      ...base,
      status: WARN,
      detail: 'Güvenli saklama şu anda kullanılamıyor — girişin diske yazılamıyor ve '
        + 'her açılışta yeniden giriş istenecek.',
      hint: 'İşletim sisteminin anahtar zincirini aç/kilidini kaldır ve uygulamayı yeniden başlat.',
      meta: view.backend || null,
    };
  }
  return {
    ...base,
    status: OK,
    detail: view.backend
      ? `Girişin şifrelenerek saklanıyor (arka uç: ${view.backend}).`
      : 'Girişin işletim sisteminin anahtar zincirinde şifrelenerek saklanıyor.',
    meta: view.backend || null,
  };
}

async function runFirstRunDoctor(deps = {}) {
  const now = deps.now || Date.now;
  // Sıra = kullanıcının umursama sırası: önce "bağlanıyor mu", sonra "kim", sonra "neyle".
  const checks = [
    // ENV-02 — EN BAŞTA: "hangi ortamdayım" sorusu, "sunucu çalışıyor mu"dan da
    // önce gelir (yanlış ortamda çalışan bir sunucu, çalışmayan sunucudan kötüdür).
    checkEnvironment(deps),
    await checkBackend(deps),
    checkIdentity(deps),
    await checkEngines(deps),
    checkWorkspace(deps),
    checkDirs(deps),
    // LX-SAFESTORAGE-01 — "neden her açılışta giriş istiyor?" sorusunun cevabı.
    checkSecretBackend(deps),
    // ADP-907 — en sona: "bizim olmayan ama bizim penceremizde görünen" hata sınıfı.
    checkForeignHooks(deps),
  ];
  return { generatedAt: now(), overall: worstStatus(checks), checks };
}

/** Log satırı — destek için tek satırda özet (sır/PII yok: e-posta yazılmaz). */
function formatDoctorLog(report) {
  const marks = { [OK]: 'ok', [WARN]: 'uyarı', [FAIL]: 'hata' };
  const parts = (report.checks || []).map((c) => `${c.id}=${marks[c.status] || c.status}`);
  return `[doctor] genel=${marks[report.overall] || report.overall} ${parts.join(' ')}`;
}

module.exports = {
  runFirstRunDoctor,
  formatDoctorLog,
  checkDirs,
  // ENV-02 — ortam bölümü (saf: yalnız `deps.envView` görüntüsünü okur).
  checkEnvironment,
  checkBackend,
  checkIdentity,
  checkEngines,
  checkWorkspace,
  // LX-SAFESTORAGE-01 — sır saklama satırı (saf: yalnız `deps.secretBackend` okunur).
  checkSecretBackend,
  // ADP-907 — yabancı kanca teşhisi (salt-okunur; kullanıcının dosyasına yazmaz).
  checkForeignHooks,
  // ADP-911 — probun taradığı PATH (kancanın koşacağı PATH; uygulamanınki değil).
  hookProbePath,
  bareInterpreter,
  collectHookCommands,
  hookSettingsFiles,
  hookSettingsDisplayPath,
  HOOK_INTERPRETERS,
  worstStatus,
  isNetworkFailure,
  REQUIRED_DIRS,
  OK,
  WARN,
  FAIL,
};
