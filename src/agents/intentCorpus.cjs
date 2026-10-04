// ADP-854 (Wheeljack) — TÜRKÇE NİYET REGRESYON KORPUSU.
//
// NEDEN AYRI DOSYA: aynı cümle listesi İKİ tüketiciye lazım —
//   1. `electron/intentRegression.test.cjs`  → kapı (node --test, kırmızıda cümleyi basar)
//   2. `electron/spike-adp854-intent.cjs`    → ÖNCE/SONRA kanıt tablosu (rapora yapıştırılır)
// Korpus tek gerçek olsun ki "testte yeşil, kanıtta başka" ayrışması olamasın.
//
// KURAL: her düzeltilen yanlış-eşleşme buraya BİR VAKA olarak girer (görev §7/§11).
// `expect` = kararda AYNEN eşleşmesi gereken alanlar. `expectNot` = ASLA olmaması
// gereken alanlar (tuzak cümleleri: "yanlış eyleme düşmesin" yeter, tek doğru yok).

'use strict';

/**
 * Gerçekçi bağlam: renderer'ın (JarvisWidget.tsx:861) gönderdiği şekil —
 * aliases[{match,id,department,role}] + departments[] + defaultDepartment.
 * `role` alanı ADP-854'te EKLENDİ (rolle hedefleme onsuz imkânsızdı).
 */
const CTX = {
  defaultDepartment: 'crewpane',
  departments: [
    { id: 'crewpane', label: 'Transformers HQ', shortLabel: 'CrewPane' },
    { id: 'chatflow', label: 'Avengers Takımı', shortLabel: 'ChatFlow' },
  ],
  aliases: [
    { match: 'reis', id: 'reis', department: 'crewpane', role: 'lead' },
    { match: 'wheeljack', id: 'wheeljack', department: 'crewpane', role: 'rnd' },
    { match: 'bumblebee', id: 'bumblebee', department: 'crewpane', role: 'frontend' },
    { match: 'ratchet', id: 'ratchet', department: 'crewpane', role: 'backend' },
    { match: 'jazz', id: 'jazz', department: 'crewpane', role: 'qa' },
    { match: 'parker', id: 'parker', department: 'chatflow', role: 'frontend' },
  ],
  panes: [],
};


/**
 * AXP-01 — NİYET YÖNLENDİRİCİ korpusunun bağlamı (AXP-00 `today-rule-path.cjs` ile BİREBİR:
 * CrewPane Marvel ekibi + Transformers). Ayrı CTX, çünkü 38 cümle bu rosterin adlarını
 * ("Stark", "Barton", "Marvel") söylüyor; yukarıdaki ADP-854 bağlamına bu adları eklemek
 * eski vakaların çözümlemesini (ör. "takım" → departman) sessizce değiştirebilirdi.
 * `Case.ctx` alanı verilen vaka bu bağlamla koşar (intentRegression.test.cjs).
 */
const CTX_AXP = {
  defaultDepartment: 'crewpane',
  departments: [
    { id: 'crewpane', label: 'Transformers', shortLabel: 'Transformers' },
    { id: 'chatflow', label: 'Marvel', shortLabel: 'Marvel' },
  ],
  aliases: [
    { match: 'optimus', id: 'optimus', department: 'crewpane', role: 'lead' },
    { match: 'bumblebee', id: 'bumblebee', department: 'crewpane', role: 'frontend' },
    { match: 'fury', id: 'fury', department: 'chatflow', role: 'lead' },
    { match: 'stark', id: 'stark', department: 'chatflow', role: 'backend' },
    { match: 'vision', id: 'vision', department: 'chatflow', role: 'backend' },
    { match: 'parker', id: 'parker', department: 'chatflow', role: 'frontend' },
    { match: 'cap', id: 'cap', department: 'chatflow', role: 'frontend' },
    { match: 'wanda', id: 'wanda', department: 'chatflow', role: 'rnd' },
    { match: 'barton', id: 'barton', department: 'chatflow', role: 'qa' },
    { match: 'romanoff', id: 'romanoff', department: 'chatflow', role: 'explorer' },
  ],
  panes: [],
};

/**
 * AXP-06/AXP-09 §2.5 — iki kelimelik ajan adı ("Kamil Amca"): gövdesiz rica cümlesi vakaları.
 * CTX_AXP'ye EKLENMEDİ: 38'lik AXP-01 korpusunun bağlamı sabit kalsın (ölçüm tabanı).
 */
const CTX_AXP_KAMIL = {
  ...CTX_AXP,
  aliases: [...CTX_AXP.aliases, { match: 'kamil amca', id: 'kamil-amca', department: 'crewpane', role: 'backend' }],
};

/**
 * @typedef {{ id:string, group:string, say:string, expect?:object, expectNot?:object, why?:string, ctx?:object }} Case
 *   `expect` anahtarları NOKTALI olabilir ('route.cls') — iç alan karşılaştırılır (AXP-01).
 */

/** @type {Case[]} */
const CASES = [
  // ── AXP-08. TEMA TABAN SÖZCÜKLERİ (preset ADI DEĞİL) ───────────────────────
  // Ekran vakası (AXP-05 §3 S1): beyin KAPALIYKEN "Temayı koyu yap" → "Bunu
  // anlayamadım". Kural yolu yalnız preset adlarını (Fosfor/Kömür/Gündüz…)
  // tanıyordu. Ölçüm: 31 ifade, ÖNCE 13/31 → SONRA 31/31.
  { id: 'TB1', group: 'tema', say: 'Temayı koyu yap', expect: { action: 'settings', op: 'theme' } },
  { id: 'TB2', group: 'tema', say: 'Karanlık temaya geç', expect: { action: 'settings', op: 'theme' } },
  { id: 'TB3', group: 'tema', say: 'Temayı açık yap', expect: { action: 'settings', op: 'theme' } },
  { id: 'TB4', group: 'tema', say: 'Gece temasına geç', expect: { action: 'settings', op: 'theme' } },
  {
    id: 'TB5', group: 'tema',
    say: 'Temayı koyu yapma',
    expect: { action: 'reply' },
    why: 'AXP-08: taban sözcüğü TANINDIKTAN SONRA olumsuz kapı zorunlu oldu — önce zaten sessizdi ama SEBEBİ "koyu"yu hiç tanımamasıydı',
  },
  {
    id: 'TB6', group: 'tema',
    say: 'Gece Vardiyası temasına geç',
    expect: { action: 'settings', op: 'theme', theme: 'gece-vardiyasi' },
    why: 'preset ADI tabandan ÖNCE denenir — yoksa "gece" tabanına düşer ve YANLIŞ preset gelirdi',
  },
  // ── A. AÇ / KAPAT ÇİFTLERİ (terminal) ──────────────────────────────────────
  {
    id: 'A1', group: 'aç/kapat',
    say: 'Yeni bir terminal aç',
    expect: { action: 'terminal', op: 'new-shell' },
  },
  {
    id: 'A2', group: 'aç/kapat',
    say: 'Açtığın kodeks terminallerini kapatır mısın?',
    expect: { action: 'terminal', op: 'kill' },
    why: 'EKRANDAKİ VAKA (görev §10): "Açtığın" içindeki "aç" spawn kapısını tetikliyordu → 1 codex pane AÇILIYORDU.',
  },
  {
    id: 'A3', group: 'aç/kapat',
    say: 'Tüm terminalleri kapat',
    expect: { action: 'terminal', op: 'kill', target: 'all' },
  },
  {
    id: 'A4', group: 'aç/kapat',
    say: '5 tane codex terminali aç',
    expect: { action: 'spawn', count: 5, engine: 'codex' },
  },
  {
    id: 'A5', group: 'aç/kapat',
    say: '3 claude 2 codex başlat',
    expect: { action: 'spawn', count: 5 },
  },
  {
    id: 'A6', group: 'aç/kapat',
    say: 'Wheeljack’in terminalini öne al',
    expect: { action: 'terminal', op: 'focus' },
  },
  {
    id: 'A7', group: 'aç/kapat',
    say: 'Codex terminallerini kapat',
    expect: { action: 'terminal', op: 'kill' },
  },
  {
    id: 'A8', group: 'aç/kapat',
    say: 'Boştaki terminalleri sonlandır',
    expect: { action: 'terminal', op: 'kill' },
  },

  // ── B. OLUMSUZLAMA ─────────────────────────────────────────────────────────
  {
    id: 'B1', group: 'olumsuzlama',
    say: 'Ajan açma, sen kendin yap',
    expect: { executor: 'self' },
    expectNot: { action: 'spawn' },
  },
  {
    id: 'B2', group: 'olumsuzlama',
    say: 'Delege etme, sen yap',
    expect: { executor: 'self' },
    expectNot: { action: 'delegate' },
  },
  {
    id: 'B3', group: 'olumsuzlama',
    say: 'Bu işi takıma verme, kendin bak',
    expect: { executor: 'self' },
    expectNot: { action: 'delegate' },
  },
  {
    id: 'B4', group: 'olumsuzlama',
    say: 'Terminali kapatma, açık kalsın',
    expectNot: { op: 'kill' },
    why: 'TUZAK: TERM_KILL_RE /kapat/ olumsuz "kapatma"yı da yakalıyordu → kullanıcı "kapatma" derken terminal ÖLÜYORDU.',
  },
  {
    id: 'B5', group: 'olumsuzlama',
    say: '3 codex terminalini başlatma',
    expectNot: { action: 'spawn' },
    why: 'TUZAK: spawn fiil kapısı /başlat/ olumsuz "başlatma"yı da yakalıyordu → 3 pane açılıyordu.',
  },
  {
    id: 'B6', group: 'olumsuzlama',
    say: 'Sayfayı okuma, ben okurum',
    expectNot: { action: 'browser', op: 'read' },
  },

  // ── C. AJAN ADIYLA HEDEFLEME ───────────────────────────────────────────────
  {
    id: 'C1', group: 'ajan-adı',
    say: 'Reis’e söyle, dev branch’teki testleri koştursun',
    expect: { action: 'prompt', target: 'reis', 'route.cls': 'prompt', 'route.target.agentId': 'reis' },
    why: 'GÖREV §4: bugün "böyle bir ajan yok" ya da BAŞKA ajana gidiyor. AXP-01: hedefli cümle artık `tell` (anında yazım) değil `prompt` (taslak akışı) — hedef taşınır.',
  },
  {
    id: 'C2', group: 'ajan-adı',
    say: 'Wheeljack’e görev ver: ses zincirini ölç',
    expect: { action: 'prompt', target: 'wheeljack', 'route.body': 'ses zincirini ölç' },
  },
  {
    id: 'C3', group: 'ajan-adı',
    say: 'Bumblebee ne dedi?',
    expect: { action: 'agent', op: 'last-message', target: 'bumblebee' },
  },
  {
    id: 'C4', group: 'ajan-adı',
    say: 'Ratchet’e ADP-854’ü ata',
    expect: { action: 'board', op: 'assign', taskId: 'ADP-854', assignee: 'ratchet' },
  },
  {
    id: 'C5', group: 'ajan-adı',
    say: 'Jazz’a söyle regresyon takımını koşsun',
    expect: { action: 'prompt', target: 'jazz', 'route.body': 'regresyon takımını koşsun' },
  },
  {
    id: 'C6', group: 'ajan-adı',
    say: 'Zorbotron’a söyle şunu yapsın',
    expect: { action: 'reply', unresolvedTarget: 'zorbotron' },
    expectNot: { action: 'delegate' },
    why: 'GÖREV §4: bulamazsa UYDURUP BAŞKASINA VERME — SOR.',
  },
  {
    id: 'C7', group: 'ajan-adı',
    say: 'wheeljak’e ver bu işi',
    expect: { action: 'prompt', target: 'wheeljack' },
    why: 'STT harf düşürür; yakın-eşleşme (mesafe ≤1) kabul edilmeli.',
  },

  // ── D. ROLLE / TAKIMLA HEDEFLEME ───────────────────────────────────────────
  {
    id: 'D1', group: 'rol/takım',
    say: 'Frontendçi bir ajana ver: buton hizasını düzelt',
    expect: { action: 'prompt', target: 'bumblebee', 'route.body': 'buton hizasını düzelt' },
    why: 'GÖREV §5: bugün rol çözümleme HİÇ YOK.',
  },
  {
    id: 'D2', group: 'rol/takım',
    say: 'Backend’ci birine ver şu migration işini',
    expect: { action: 'prompt', target: 'ratchet' },
  },
  {
    id: 'D3', group: 'rol/takım',
    say: 'Test mühendisine ver: e2e koşsun',
    expect: { action: 'prompt', target: 'jazz' },
  },
  {
    id: 'D4', group: 'rol/takım',
    say: 'Takım liderine söyle sprintimizi kapatsın',
    expect: { action: 'prompt', target: 'reis' },
  },
  {
    id: 'D5', group: 'rol/takım',
    say: 'ChatFlow takımına dağıt: landing sayfasını yenile',
    expect: { action: 'prompt', department: 'chatflow', executor: 'team', 'route.target.teamId': 'chatflow', 'route.body': 'landing sayfasını yenile' },
  },
  {
    id: 'D6', group: 'rol/takım',
    say: 'Tasarımcı bir ajana ver bu işi',
    expect: { action: 'reply', unresolvedRole: 'design' },
    expectNot: { action: 'delegate' },
    why: 'Rosterde tasarımcı YOK → uydurup başkasına verme, sor.',
  },

  // ── E. RAPOR ───────────────────────────────────────────────────────────────
  {
    id: 'E1', group: 'rapor',
    say: 'ADP-854 raporunu aç',
    expect: { action: 'report', op: 'open', taskId: 'ADP-854' },
  },
  {
    id: 'E2', group: 'rapor',
    say: '854 raporunu aç',
    expect: { action: 'report', op: 'open', taskId: '854' },
    why: 'GÖREV §6: numaranın BAŞI/çıplak numara da açmalı.',
  },
  {
    id: 'E3', group: 'rapor',
    say: 'ADP-85 raporunu aç',
    expect: { action: 'report', op: 'open', taskId: 'ADP-85' },
    why: 'Önek — çok aday varsa yürütücü LİSTELER (pickReport ambiguity).',
  },
  {
    id: 'E4', group: 'rapor',
    say: 'Son raporu oku',
    expect: { action: 'report', op: 'read', taskId: null },
  },
  {
    id: 'E5', group: 'rapor',
    say: 'Raporları listele',
    expect: { action: 'report', op: 'list' },
  },
  {
    id: 'E6', group: 'rapor',
    say: 'ADP-854’ün raporunu özetle',
    expect: { action: 'report', op: 'read', taskId: 'ADP-854' },
  },

  // ── F. PANO (board) ────────────────────────────────────────────────────────
  {
    id: 'F1', group: 'pano',
    say: 'Yeni görev aç: login ekranını düzelt',
    expect: { action: 'board', op: 'create', title: 'login ekranını düzelt' },
  },
  {
    id: 'F2', group: 'pano',
    say: 'Panodaki görevleri listele',
    expect: { action: 'board', op: 'list' },
  },
  {
    id: 'F3', group: 'pano',
    say: 'Done olan görevleri göster',
    expect: { action: 'board', op: 'list', taskStatus: 'done' },
  },
  {
    id: 'F4', group: 'pano',
    say: 'ADP-854’ü bitti yap',
    expect: { action: 'board', op: 'status', taskId: 'ADP-854', taskStatus: 'done' },
  },

  // ── G. SEKME GEZİNME ───────────────────────────────────────────────────────
  {
    id: 'G1', group: 'sekme',
    say: 'Görevler sekmesine geç',
    expect: { action: 'navigate', op: 'tab', target: 'görevler' },
  },
  {
    id: 'G2', group: 'sekme',
    say: 'Raporlar sekmesini aç',
    expect: { action: 'navigate', op: 'tab', target: 'raporlar' },
    why: 'ÇAKIŞMA: "rapor"+"aç" bugün report/open üretiyor; "sekme" ipucu KAZANMALI.',
  },
  {
    id: 'G3', group: 'sekme',
    say: 'Tarayıcı sekmesini kapat',
    expect: { action: 'navigate', op: 'tab-close', target: 'tarayıcı' },
  },
  {
    id: 'G4', group: 'sekme',
    say: 'Hafıza sekmesini göster',
    expect: { action: 'navigate', op: 'tab', target: 'hafıza' },
  },

  // ── H. TARAYICI ────────────────────────────────────────────────────────────
  {
    id: 'H1', group: 'tarayıcı',
    say: 'google.com’u aç',
    expect: { action: 'browser', op: 'open' },
  },
  {
    id: 'H2', group: 'tarayıcı',
    say: 'İnternette Türkçe TTS motorları diye ara',
    expect: { action: 'browser', op: 'search' },
  },
  {
    id: 'H3', group: 'tarayıcı',
    say: 'Sayfayı oku',
    expect: { action: 'browser', op: 'read' },
  },
  {
    id: 'H4', group: 'tarayıcı',
    say: 'Geri git',
    expect: { action: 'browser', op: 'back' },
  },
  {
    id: 'H5', group: 'tarayıcı',
    say: 'İlk linke tıkla',
    expect: { action: 'browser', op: 'click', selector: 'a' },
  },

  // ── I. TUZAKLAR (yanlış-eşleşme yemleri) ───────────────────────────────────
  {
    id: 'I1', group: 'tuzak',
    say: 'Bu kodun ne yaptığına dair bir açıklama yap',
    expectNot: { action: 'spawn' },
    why: 'TUZAK "açıklama": kök-harf "aç" spawn/aç kapılarına yem.',
  },
  {
    id: 'I2', group: 'tuzak',
    say: 'Çöken terminali kurtar',
    expectNot: { action: 'spawn' },
    why: 'TUZAK "kurtar": "kur" kökü spawn fiil kapısına yem.',
  },
  {
    id: 'I3', group: 'tuzak',
    say: 'İki rapor arasındaki farkı anlat',
    expectNot: { action: 'browser', op: 'search' },
    why: 'TUZAK "arasında": "ara" kökü arama kapısına yem.',
  },
  {
    id: 'I4', group: 'tuzak',
    say: 'Şu iki terminal arasında geçiş yapmayı anlat',
    expectNot: { action: 'browser', op: 'search' },
  },
  {
    id: 'I5', group: 'tuzak',
    say: 'Açık kaynak lisansını incele',
    expectNot: { action: 'spawn' },
    why: 'TUZAK "açık": kök-harf "aç" yemi.',
  },
  // ── AGENTX-RT-2 — 'bekle' kesme fiiline eklendi: BİLDİRME kipi tuzağı ───────
  // Kelime EMİR kipinde iptaldir ("bekle, yapma"); BİLDİRME kipinde bilgidir
  // ("3 komut bekliyor"). Morfoloji ikisini AYIRMAZ → deny listesi yazıldı.
  // Kesme SINIFLANDIRMASININ olumlu+olumsuz vakaları: src/app/lib/voiceRuntime.test.mts
  // ("KESME (RT-2)" / "OLUMSUZ (RT-2)" / "BİLDİRME (RT-2)"). Buradakiler BEYİN
  // yolunun aynı cümlelerde yoldan çıkmadığını kilitler.
  {
    id: 'I5b', group: 'tuzak',
    say: 'Kaç komut bekliyor?',
    expectNot: { action: 'terminal' },
    why: 'TUZAK "bekliyor": AGENTX-RT-2 ile "bekle" kesme fiili oldu; bildirme kipi eylem üretmemeli.',
  },
  {
    id: 'I5c', group: 'tuzak',
    say: 'Bumblebee sonucu bekliyor mu',
    expectNot: { action: 'spawn' },
    why: 'TUZAK "bekliyor": durum sorusu iptal/eylem değildir.',
  },
  {
    id: 'I6', group: 'tuzak',
    say: 'Silah sektörü raporunu özetle',
    expectNot: { action: 'terminal', op: 'kill' },
    why: 'TUZAK "silah": TERM_KILL_RE /sil\\b/ yemi (bugün \\b sayesinde temiz — regresyon kilidi).',
  },
  {
    id: 'I7', group: 'tuzak',
    say: 'Sakın özetleme, tam metni istiyorum',
    expectNot: { action: 'status' },
    why: 'TUZAK "özetleme": STATUS_RE /özetle/ olumsuz biçimi de yakalıyordu → kullanıcı "özetleme" derken DURUM ÖZETİ üretiliyordu.',
  },
  {
    id: 'I8', group: 'tuzak',
    say: 'Kapak görselini yenile',
    expectNot: { action: 'terminal', op: 'kill' },
    why: 'TUZAK "kapak": "kapa" kökü kapatma kapısına yem.',
  },
  {
    id: 'I9', group: 'tuzak',
    say: 'Aralık ayının maliyet tablosunu çıkar',
    expectNot: { action: 'browser', op: 'search' },
    why: 'TUZAK "aralık": "ara" kökü yemi.',
  },
  {
    id: 'I10', group: 'tuzak',
    say: 'Atama kurallarını dokümana yaz',
    expectNot: { action: 'board', op: 'assign' },
    why: 'TUZAK "atama": "ata" kökü atama kapısına yem.',
  },

  // ── J. DURUM / DELEGASYON (davranış kilidi) ────────────────────────────────
  {
    id: 'J1', group: 'durum',
    say: 'Takım ne durumda?',
    expect: { action: 'status' },
  },
  {
    id: 'J2', group: 'durum',
    say: 'Kim ne yapıyor, özetle',
    expect: { action: 'status' },
  },
  {
    id: 'J3', group: 'delegasyon',
    say: 'Takıma dağıt: ödeme akışını baştan yaz',
    expect: { action: 'prompt', executor: 'team', 'route.cls': 'prompt' },
  },
  {
    id: 'J4', group: 'delegasyon',
    say: 'Tek bir ajana ver: CI kırmızısını düzelt',
    expect: { action: 'prompt', executor: 'single', target: null, 'route.body': 'CI kırmızısını düzelt' },
    why: 'Ad YOK → prompt (hedef sonra sorulur) ama genişlik 1e kilitli (ADP-322 davranışı korunmalı).',
  },

  // ── K. YÜZEY AÇMA (ADP-883) ───────────────────────────────────────────────
  // Kayıt tabanlı ortak katman: her satır AYRI bir `if` değil, `uiSurfaces.cjs`
  // kaydındaki bir satırın sesli karşılığıdır. Yeni bir ayar sayfası eklendiğinde
  // kayda bir satır girer ve bu grup kendiliğinden onu da kapsar.
  {
    id: 'K1', group: 'yüzey',
    say: 'Ayarları aç',
    expect: { action: 'navigate', op: 'surface', target: 'settings.root' },
    why: 'ADP-883 §1: kural yolunda Ayarlar paneli HİÇ yoktu → cümle `reply`e düşüyordu.',
  },
  {
    id: 'K2', group: 'yüzey',
    say: 'Ayarlara git',
    expect: { action: 'navigate', op: 'surface', target: 'settings.root' },
  },
  {
    id: 'K3', group: 'yüzey',
    say: 'Genel ayarları aç',
    expect: { action: 'navigate', op: 'surface', target: 'settings.general' },
  },
  {
    id: 'K4', group: 'yüzey',
    say: 'Görünüm ayarlarını aç',
    expect: { action: 'navigate', op: 'surface', target: 'settings.appearance' },
  },
  {
    id: 'K5', group: 'yüzey',
    say: 'Kısayolları göster',
    expect: { action: 'navigate', op: 'surface', target: 'settings.shortcuts' },
  },
  {
    id: 'K6', group: 'yüzey',
    say: 'Ses ayarlarını aç',
    expect: { action: 'navigate', op: 'surface', target: 'settings.voice' },
  },
  {
    id: 'K7', group: 'yüzey',
    say: 'AI motorlarını aç',
    expect: { action: 'navigate', op: 'surface', target: 'settings.engines' },
    why: "🪤 'AI' Türkçe locale'de 'aı' olur — yalnız 'ai' yazılı ifade HİÇ eşleşmiyordu.",
  },
  {
    id: 'K8', group: 'yüzey',
    say: 'Entegrasyonları aç',
    expect: { action: 'navigate', op: 'surface', target: 'settings.integrations' },
    why: 'useSettingsLauncher KNOWN listesinde `integrations` EKSİKTİ → olayla açılsa bile Genel açılıyordu.',
  },
  {
    id: 'K9', group: 'yüzey',
    say: 'Bildirim ayarlarını aç',
    expect: { action: 'navigate', op: 'surface', target: 'settings.notifications' },
  },
  {
    id: 'K10', group: 'yüzey',
    say: 'Cihazları aç',
    expect: { action: 'navigate', op: 'surface', target: 'settings.devices' },
  },
  {
    id: 'K11', group: 'yüzey',
    say: 'Güven ayarlarını aç',
    expect: { action: 'navigate', op: 'surface', target: 'settings.trust' },
  },
  {
    id: 'K12', group: 'yüzey',
    say: 'Takım ayarlarını aç',
    expect: { action: 'navigate', op: 'surface', target: 'settings.teamScope' },
    why: 'EN UZUN İFADE KAZANIR: çıplak "ayarlar" değil "takım ayarları".',
  },
  {
    id: 'K13', group: 'yüzey',
    say: 'Hesap ayarlarını aç',
    expect: { action: 'navigate', op: 'surface', target: 'settings.account' },
  },
  {
    id: 'K14', group: 'yüzey',
    say: 'Sistem durumunu göster',
    expect: { action: 'navigate', op: 'surface', target: 'settings.status' },
  },
  {
    id: 'K15', group: 'yüzey',
    say: 'Şirket ağacını göster',
    expect: { action: 'navigate', op: 'surface', target: 'org.tree' },
  },
  {
    id: 'K16', group: 'yüzey',
    say: 'Takım yönetimini aç',
    expect: { action: 'navigate', op: 'surface', target: 'org.tree' },
  },
  {
    id: 'K17', group: 'yüzey',
    say: 'Yeni takım ekle',
    expect: { action: 'navigate', op: 'surface', target: 'org.addTeam' },
  },
  {
    id: 'K18', group: 'yüzey',
    say: 'Yeni çalışan ekle',
    expect: { action: 'navigate', op: 'surface', target: 'org.addEmp' },
  },
  {
    id: 'K19', group: 'yüzey',
    say: 'Ofisi aç',
    expect: { action: 'navigate', op: 'surface', target: 'tab.office' },
  },
  {
    id: 'K20', group: 'yüzey',
    say: 'Hafızayı aç',
    expect: { action: 'navigate', op: 'surface', target: 'tab.memory' },
  },
  {
    id: 'K21', group: 'yüzey',
    say: 'Ayarları açma',
    expectNot: { op: 'surface' },
    why: 'OLUMSUZLAMA TUZAĞI (görev §12): "açma" ⊃ "aç" — kullanıcı YAPMA derken panel AÇILMAMALI.',
  },
  {
    id: 'K22', group: 'yüzey',
    say: 'Muhasebe ekranını aç',
    expect: { action: 'reply', unknownSurface: 'muhasebe' },
    expectNot: { op: 'surface' },
    why: 'UYDURMA YASAK (görev §5/§13): olmayan ekran için "bulamadım" — en yakınına da atlamaz.',
  },

  // ── L. TARAYICIDA GERÇEK ETKİLEŞİM (ADP-884) ──────────────────────────────
  {
    id: 'L1', group: 'tarayıcı-etkileşim',
    say: 'Aşağı kaydır',
    expect: { action: 'browser', op: 'scroll' },
    why: 'ADP-884: tarayıcıda KAYDIRMA fiili HİÇ yoktu (input.scroll app penceresine gider, guest webview\'e DEĞİL).',
  },
  {
    id: 'L2', group: 'tarayıcı-etkileşim',
    say: 'Yukarı çık',
    expect: { action: 'browser', op: 'scroll' },
  },
  {
    id: 'L3', group: 'tarayıcı-etkileşim',
    say: 'Sayfanın sonuna git',
    expect: { action: 'browser', op: 'scroll', scrollTo: 'bottom' },
  },
  {
    id: 'L4', group: 'tarayıcı-etkileşim',
    say: 'Biraz aşağı',
    expect: { action: 'browser', op: 'scroll' },
    why: 'MİKTAR YOK → makul varsayılan (görev §7); fiil de yok, yön sözcüğü tek başına niyeti taşır.',
  },
  {
    id: 'L5', group: 'tarayıcı-etkileşim',
    say: 'Aşağı kaydırma, olduğu yerde kalsın',
    expectNot: { op: 'scroll' },
    why: 'OLUMSUZLAMA: "kaydırma" ⊃ "kaydır".',
  },
  {
    id: 'L6', group: 'tarayıcı-etkileşim',
    say: 'Giriş yap düğmesine bas',
    expect: { action: 'browser', op: 'click', findText: 'giriş yap' },
    why: 'METİNLE ÖGE BULMA: bugün yalnız CSS seçici vardı → kullanıcı seçici söyleyemez.',
  },
  {
    id: 'L7', group: 'tarayıcı-etkileşim',
    say: 'Arama kutusuna pixel art yaz',
    expect: { action: 'browser', op: 'type', objective: 'pixel art' },
    why: 'FORM DOLDURMA: browser op="type" sesli yolda HİÇ yoktu (CDP\'de vardı).',
  },
  {
    id: 'L8', group: 'tarayıcı-etkileşim',
    say: 'Başlıkları söyle',
    expect: { action: 'browser', op: 'read', selector: 'h1, h2, h3' },
  },
  {
    id: 'L9', group: 'tarayıcı-etkileşim',
    say: 'Sayfayı yenile',
    expect: { action: 'browser', op: 'reload' },
  },
  {
    id: 'L10', group: 'tarayıcı-etkileşim',
    say: 'İleri git',
    expect: { action: 'browser', op: 'forward' },
  },
  {
    id: 'L11', group: 'tarayıcı-etkileşim',
    say: 'Sayfanın başına dön',
    expect: { action: 'browser', op: 'scroll', scrollTo: 'top' },
  },
  {
    id: 'L12', group: 'tuzak',
    say: 'Aşağıdaki tabloyu rapora ekle',
    expectNot: { action: 'browser', op: 'scroll' },
    why: 'TUZAK "aşağıdaki": yön sözcüğü bir SIFAT burada, kaydırma emri değil.',
  },

  // ── M. İNGİLİZCE KAYDIRMA (ADP-884/jazz) ──────────────────────────────────
  // Leksikon başlığının kararı: İngilizce destek ÇEVİRİ değil İKİNCİ LEKSİKON.
  // Buradaki her vaka, kural yolunun (beyin YOKKEN) İngilizceyi de anladığını ölçer.
  {
    id: 'M1', group: 'tarayıcı-etkileşim-en',
    say: 'scroll down',
    expect: { action: 'browser', op: 'scroll' },
    why: 'ÖLÇÜLDÜ (ADP-884/jazz): İngilizce kaydırma cümleleri kural yolunda SESSİZCE reply’e düşüyordu.',
  },
  {
    id: 'M2', group: 'tarayıcı-etkileşim-en',
    say: 'scroll up',
    expect: { action: 'browser', op: 'scroll' },
  },
  {
    id: 'M3', group: 'tarayıcı-etkileşim-en',
    say: 'scroll to the bottom',
    expect: { action: 'browser', op: 'scroll', scrollTo: 'bottom' },
  },
  {
    id: 'M4', group: 'tarayıcı-etkileşim-en',
    say: 'go to the top of the page',
    expect: { action: 'browser', op: 'scroll', scrollTo: 'top' },
  },
  {
    id: 'M5', group: 'tarayıcı-etkileşim-en',
    say: 'page down',
    expect: { action: 'browser', op: 'scroll' },
  },
  {
    id: 'M6', group: 'tuzak',
    say: "don't scroll down",
    expectNot: { action: 'browser', op: 'scroll' },
    why: 'OLUMSUZLAMA İngilizcede EKTE DEĞİL AYRI SÖZCÜKTE: turkishMorph.negV bunu OLUMLU görür → ayrı EN kapısı şart.',
  },
  {
    id: 'M7', group: 'tuzak',
    say: 'Bumblebee’ye söyle, scroll bug’ını düzeltsin',
    expectNot: { action: 'browser', op: 'scroll' },
    why: 'TUZAK: "scroll" kelimesi bir DELEGASYON cümlesinin içinde geçiyor — sayfa kaymamalı.',
  },
  {
    id: 'M8', group: 'tuzak',
    say: 'Kod editörünü aç ve dosyayı göster',
    expectNot: { action: 'browser', op: 'scroll' },
    why: 'YANLIŞ-POZİTİF FRENİ: İngilizce dalı Türkçe cümlelere bulaşmamalı.',
  },

  // ── N. 2. TUR QA (ADP-884/jazz) — kelimenin GEÇMESİ niyet değildir ────────
  // Korpusta olmayan cümlelerle ölçüldü; ikisi de canlı davranışı bozuyordu.
  {
    id: 'N1', group: 'tuzak',
    say: 'the scroll bar is broken',
    expectNot: { action: 'browser', op: 'scroll' },
    why: 'ÖLÇÜLDÜ (2. tur): yön/uç/miktar aranmadığı için "scroll" ADI geçen HER İngilizce cümle 600px kaydırıyordu — ADP-854 alt-dize tuzağının İngilizce ikizi.',
  },
  {
    id: 'N2', group: 'tuzak',
    say: 'tell wheeljack to fix the scroll bug',
    expectNot: { action: 'browser', op: 'scroll' },
    why: 'M7’nin İNGİLİZCE cümle yapısındaki hâli: Türkçe delegasyon freni (isDelegate) bunu görmez.',
  },
  {
    id: 'N3', group: 'tarayıcı-etkileşim-en',
    say: 'scroll',
    expect: { action: 'browser', op: 'scroll' },
    why: 'N1/N2 kapısı DAR olmalı: çıplak emir hâlâ kaydırır (yön söylenmediyse aşağı).',
  },
  {
    id: 'N4', group: 'tuzak',
    say: 'yukarı kaydırmayı bırak',
    expectNot: { action: 'browser', op: 'scroll' },
    why: 'ÖLÇÜLDÜ (2. tur): olumsuzluk EKLE değil FİİLLE kurulunca (kaydırmayı + bırak) kapı boştu — classifyToken("kaydırmayı") = null.',
  },
  {
    id: 'N5', group: 'tarayıcı-etkileşim',
    say: 'bırak aşağı kaydır',
    expect: { action: 'browser', op: 'scroll' },
    why: 'N4 kapısının DARLIK kanıtı: "bırak" burada söylem parçacığı, kaydırma EMİR kipinde → kaymalı.',
  },
  // ── P. PROMPT SINIFI (AXP-01) — aksiyon / prompt / belirsiz / yok ─────────
  // Kaynak: docs/agent-results/AXP-00-evidence/intent-corpus.cjs (38 cümle, AXP-00 §2.5).
  // Ölçüm: bugünkü kural yolu 25/38 (today-rule-path.md) → hedef 38/38. Her vaka
  // `route.cls`i kilitler; prompt vakaları hedefi de (`route.target.*`). Bağlam CTX_AXP.
  // Sınıfın anlamı: aksiyon = bugünkü yol AYNEN (dokunulmaz) · prompt = taslak akışı
  // (cümle terminale YAZILMAZ) · belirsiz = tek soru iki seçenek · yok = sessiz onay.
  ...[
    // A. aksiyon — uygulamanın kendi düğmeleri (bugün zaten çalışıyor; KORUNUR)
    { id: 'P-A01', say: 'Temayı koyuya al', expect: { 'route.cls': 'aksiyon', action: 'settings', op: 'theme' }, why: 'kayıtlı ayar kontrolü (tema) + değiştirme fiili; AXP-08’e kadar kural yolu reply veriyordu — taban sözcüğü ("koyu") artık kural yolunda da çözülüyor' },
    { id: 'P-A02', say: 'Dili İngilizceye çevir', expect: { 'route.cls': 'aksiyon', action: 'settings', op: 'locale' } },
    { id: 'P-A03', say: 'Ofisi göster', expect: { 'route.cls': 'aksiyon', action: 'navigate', op: 'surface' } },
    { id: 'P-A04', say: 'Marvel sekmesine geç', expect: { 'route.cls': 'aksiyon', action: 'navigate', op: 'tab' } },
    { id: 'P-A05', say: 'Yeni bir terminal aç', expect: { 'route.cls': 'aksiyon', action: 'terminal', op: 'new-shell' } },
    { id: 'P-A06', say: 'Parker’ın terminalini öne al', expect: { 'route.cls': 'aksiyon', action: 'terminal', op: 'focus' }, why: 'ajan adı geçiyor ama fiil ODAKLA — pane işlemi, iş verme değil' },
    { id: 'P-A07', say: 'Boştaki terminalleri kapat', expect: { 'route.cls': 'aksiyon', action: 'terminal', op: 'kill' } },
    { id: 'P-A08', say: 'Takım ne durumda?', expect: { 'route.cls': 'aksiyon', action: 'status' } },
    { id: 'P-A09', say: 'Ayarları aç', expect: { 'route.cls': 'aksiyon', action: 'navigate', op: 'surface' } },
    { id: 'P-A10', say: 'Sayfayı aşağı kaydır', expect: { 'route.cls': 'aksiyon', action: 'browser', op: 'scroll' } },
    { id: 'P-A11', say: 'Stark ne dedi?', expect: { 'route.cls': 'aksiyon', action: 'agent', op: 'last-message' }, why: 'hitap gibi başlıyor ama SORU + katalog eylemi → aksiyon' },
    // B. prompt — bir ajana detaylı iş (taslak akışı; cümle terminale YAZILMAZ)
    { id: 'P-B01', say: 'Parker’a söyle: landing sayfasındaki hero başlığını kısalt, mobilde iki satıra sığsın', expect: { 'route.cls': 'prompt', action: 'prompt', 'route.target.agentId': 'parker', 'route.body': 'landing sayfasındaki hero başlığını kısalt, mobilde iki satıra sığsın' } },
    { id: 'P-B02', say: 'Stark’a bir iş vereceğim', expect: { 'route.cls': 'prompt', 'route.target.agentId': 'stark', 'route.body': null }, why: 'NİYET BEYANI — gövde yok; bugün bu cümlenin KENDİSİ Stark’ın terminaline yazılıyordu (AXP-00 B02)' },
    { id: 'P-B03', say: 'Marvel’daki Parker’a şunu ilet', expect: { 'route.cls': 'prompt', 'route.target.agentId': 'parker', 'route.target.teamId': 'chatflow', 'route.body': null } },
    { id: 'P-B04', say: 'Frontendçiye ver: ürün kartındaki fiyat yazısı tema değişince kayboluyor, düzeltsin', expect: { 'route.cls': 'prompt', 'route.target.agentId': 'bumblebee' }, why: '"tema" gövdenin İÇİNDE — kontrol sözcüğü işin parçası, belirsiz DEĞİL' },
    { id: 'P-B05', say: 'Barton, ödeme akışını baştan sona test et, kartı reddedilen senaryoyu da dene', expect: { 'route.cls': 'prompt', 'route.target.agentId': 'barton', 'route.body': 'ödeme akışını baştan sona test et, kartı reddedilen senaryoyu da dene' }, why: 'HİTAP + emir — hedefleme fiili YOK (bugünkü kural yolu reply veriyordu)' },
    { id: 'P-B06', say: 'Bir görev vereceğim, dinle', expect: { 'route.cls': 'prompt', target: null, 'route.body': null }, why: 'hedef yok → taslak açılır, hedef sonra sorulur (AXP-02)' },
    { id: 'P-B07', say: 'Şunu Stark’a yaptır: Supabase’deki orders tablosuna created_at indeksi ekle, migration dosyasını da yaz', expect: { 'route.cls': 'prompt', 'route.target.agentId': 'stark', 'route.body': 'Supabase’deki orders tablosuna created_at indeksi ekle, migration dosyasını da yaz' } },
    { id: 'P-B08', say: 'Romanoff araştırsın: rakiplerin fiyatlandırma sayfalarını topla, tabloya koy', expect: { 'route.cls': 'prompt', 'route.target.agentId': 'romanoff' }, expectNot: { action: 'browser', op: 'search' }, why: '"araştır" TUZAĞI: ajan adı + 3.tekil emir → tarayıcı araması DEĞİL, prompt (AXP-00 B08)' },
    { id: 'P-B09', say: 'Cap’e ilet, Shopify temasında sepet sayfası boşken gösterilen metni değiştirsin', expect: { 'route.cls': 'prompt', 'route.target.agentId': 'cap', 'route.body': 'Shopify temasında sepet sayfası boşken gösterilen metni değiştirsin' } },
    { id: 'P-B10', say: 'Wanda için bir iş: n8n’deki kargo bildirimi akışına kargo takip linki ekle', expect: { 'route.cls': 'prompt', 'route.target.agentId': 'wanda', 'route.body': 'n8n’deki kargo bildirimi akışına kargo takip linki ekle' }, why: '"için bir iş" kalıbı (fiilsiz hedefleme)' },
    { id: 'P-B11', say: 'Takım liderine söyle sprint planını yeniden yazsın, önce QA kartları gelsin', expect: { 'route.cls': 'prompt', 'route.target.agentId': 'optimus' } },
    { id: 'P-B12', say: 'ChatFlow takımına dağıt: onboarding ekranlarını sadeleştirin', expect: { 'route.cls': 'prompt', 'route.target.teamId': 'chatflow', executor: 'team', 'route.body': 'onboarding ekranlarını sadeleştirin' } },
    { id: 'P-B13', say: 'Parker şu hatayı düzeltsin, konsolda hydration uyarısı var', expect: { 'route.cls': 'prompt', 'route.target.agentId': 'parker' }, why: 'ad başta + -sin' },
    { id: 'P-B14', say: 'Stark’a de ki API’deki rate limit 100’den 300’e çıksın', expect: { 'route.cls': 'prompt', 'route.target.agentId': 'stark', 'route.body': 'API’deki rate limit 100’den 300’e çıksın' }, why: '"de ki" kalıbı' },
    { id: 'P-B15', say: 'Vision’a küçük bir iş: log dosyalarını tarihe göre ayır', expect: { 'route.cls': 'prompt', 'route.target.agentId': 'vision', 'route.body': 'log dosyalarını tarihe göre ayır' } },
    // C. belirsiz — tek soru, iki seçenek (yan etki YOK)
    { id: 'P-C01', say: 'Landing sayfasını düzelt', expect: { 'route.cls': 'belirsiz', action: 'prompt', target: null }, why: 'iş var ama kim yapacak yok' },
    { id: 'P-C02', say: 'Parker', expect: { 'route.cls': 'belirsiz', 'route.target.agentId': 'parker' }, why: 'yalnız ad: terminal mi, iş mi?' },
    { id: 'P-C03', say: 'Stark ile ilgilen', expect: { 'route.cls': 'belirsiz', 'route.target.agentId': 'stark' } },
    { id: 'P-C04', say: 'Şu testleri koştur', expect: { 'route.cls': 'belirsiz' } },
    { id: 'P-C05', say: 'Temayı Parker’a sor', expect: { 'route.cls': 'belirsiz', 'route.target.agentId': 'parker' }, expectNot: { action: 'settings' }, why: 'tema (aksiyon sözcüğü) + sor (iletim) → tek soru; ne tema değişir ne cümle yazılır' },
    { id: 'P-C06', say: 'Ofisi düzenle', expect: { 'route.cls': 'belirsiz' }, expectNot: { op: 'surface' } },
    // D. yok — olumsuz: hiçbir şey yapılmaz (bugün 6/6 sessiz — KORUNUR)
    { id: 'P-D01', say: 'Temayı değiştirme', expect: { 'route.cls': 'yok', action: 'reply' }, expectNot: { action: 'settings' } },
    { id: 'P-D02', say: 'Parker’a hiçbir şey söyleme', expect: { 'route.cls': 'yok', action: 'reply' }, expectNot: { action: 'prompt' } },
    { id: 'P-D03', say: 'Terminali kapatma, açık kalsın', expect: { 'route.cls': 'yok', action: 'reply' }, expectNot: { op: 'kill' } },
    { id: 'P-D04', say: 'Bu işi takıma verme, dur', expect: { 'route.cls': 'yok', action: 'reply' }, expectNot: { action: 'prompt' } },
    { id: 'P-D05', say: 'Sekmeyi değiştirme, burada kal', expect: { 'route.cls': 'yok', action: 'reply' }, expectNot: { action: 'navigate' } },
    { id: 'P-D06', say: 'Kimseye iş verme şimdilik', expect: { 'route.cls': 'yok', action: 'reply' }, expectNot: { action: 'prompt' } },
  ].map((c) => ({ ...c, group: 'prompt-sınıfı', ctx: CTX_AXP })),

  // ── P3. AXP-06 — "Şunu hallet." kural yolunda DELEGE DEĞİL, TEK SORU (AXP-05 S7/B1) ──
  // Kök neden (ölçüldü): `promptRouter.classify` null, `parseIntent` eski `delegate`
  // refleksi, `isRuleOwn=true` → `mergeBrain(null,null)` → karar AYNEN → boştaki ajana
  // "Görev: Şunu hallet." + yeni pane. Tasarım (AXP-01 §2.2 adım 5): iş fiili var, alıcı
  // yok → belirsiz. Cümlenin KENDİSİ hiçbir koşulda gövde/objective olamaz.
  ...[
    { id: 'P3-1', say: 'Şunu hallet.', expect: { 'route.cls': 'belirsiz', action: 'prompt', 'route.via': 'work-no-target', target: null, objective: null, 'route.question.options.length': 2 }, expectNot: { action: 'delegate' }, why: 'AXP-05 S7: beyin kapalıyken "Lale\'ye verdim, boştaydı. Görev: Şunu hallet." + yeni pane açıldı' },
    { id: 'P3-2', say: 'Bunu hallet', expect: { 'route.cls': 'belirsiz', action: 'prompt', target: null, objective: null }, expectNot: { action: 'delegate' } },
    { id: 'P3-3', say: 'Şunu halleder misin?', expect: { 'route.cls': 'belirsiz', action: 'prompt', objective: null }, expectNot: { action: 'delegate' }, why: 'yumuşama (t→d) + rica soru eki: hâlâ alıcısız iş → soru' },
    // kontrol kolu — hedefli cümlede aynı gövde PROMPT kalır (kart madde 4)
    { id: 'P3-4', say: 'Stark’a söyle: şunu hallet', expect: { 'route.cls': 'prompt', 'route.target.agentId': 'stark', 'route.body': 'şunu hallet', objective: 'şunu hallet' } },
  ].map((c) => ({ ...c, group: 'axp-06', ctx: CTX_AXP })),

  // ── P4. AXP-06 EK (AXP-09 §2.4–2.5) — gövdesiz rica: cümlenin kendisi terminale DÜŞMEZ ──
  // "Kamil amcaya söyler misin?" → parseIntent `tell + objective=cümlenin kendisi`; yönlendirici
  // soru işareti yüzünden hüküm vermiyordu → route null → karar aynen → pane-11'e ham cümle
  // yazıldı (transkript 15:05:47). Rica soru eki (m[ıiuü]s[ıiuü]n(ız)?) SORU DEĞİL, İLETİM;
  // gövde soru ekinden ve "?"den SONRA başlar; rica tek başınaysa gövde YOK (taslak hedefli açılır).
  ...[
    { id: 'P4-1', say: 'Kamil amcaya söyler misin?', expect: { 'route.cls': 'prompt', action: 'prompt', 'route.target.agentId': 'kamil-amca', 'route.body': null, objective: null, target: 'kamil-amca' }, expectNot: { action: 'tell' }, why: 'gövdesiz rica: taslak hedefli/gövdesiz açılır ("Dinliyorum. Kamil Amca için işi söyle"), terminale 0 bayt' },
    { id: 'P4-2', say: 'Kamil amcaya söyler misin? Benim için selam yazsın.', expect: { 'route.cls': 'prompt', 'route.target.agentId': 'kamil-amca', 'route.body': 'Benim için selam yazsın.', objective: 'Benim için selam yazsın.' }, why: 'gövde "misin? …" ile BAŞLAMAZ; rica cümlesi düşer, gövde sonraki cümledir' },
    { id: 'P4-3', say: 'Parker’a iletir misiniz? Build kırmızı, bir baksın.', expect: { 'route.cls': 'prompt', 'route.target.agentId': 'parker', 'route.body': 'Build kırmızı, bir baksın.' }, why: '"misiniz" biçimi (ız eki)' },
    { id: 'P4-4', say: 'Stark’a sorar mısın?', expect: { 'route.cls': 'prompt', 'route.target.agentId': 'stark', 'route.body': null, objective: null }, why: '"sor" ailesi: rica eki + gövde yok → hedefli taslak, cümle yazılmaz' },
    // kontrol kolu — GERÇEK soru (geçmiş zaman + "mi") rica DEĞİL: yönlendirici hüküm vermez, beyin cevaplar
    { id: 'P4-5', say: 'Kamil amcaya söyledin mi?', expect: { objective: null }, expectNot: { action: 'tell' }, why: 'BİLGİ SORUSU ("söyledin mi" — rica eki değil): yönlendirici hüküm vermez (beyin cevaplar); beyin yokken parseIntent tell+cümle refleksi EK(a) kapısına takılır — soru cümlesi terminale YAZILMAZ' },
  ].map((c) => ({ ...c, group: 'axp-06', ctx: CTX_AXP_KAMIL })),

  // ── P2. PROMPT SINIFI — YANLIŞ-POZİTİF FRENLERİ (AXP-01, ölçülerek eklendi) ──
  {
    id: 'P2-1', group: 'prompt-tuzak',
    say: 'Arama kutusuna pixel art yaz',
    expect: { action: 'browser', op: 'type', 'route.cls': 'aksiyon' },
    why: 'ÖLÇÜLDÜ: "araMA" olumsuz emir DEĞİL, fiilden isim (arama kutusu). İlk yönlendirici bunu `yok` sayıp formu doldurmuyordu.',
  },
  {
    id: 'P2-2', group: 'prompt-tuzak',
    say: 'Atama kurallarını dokümana yaz',
    expectNot: { 'route.cls': 'yok' },
    why: 'aynı sınıf: "ataMA" isim (atama kuralları). Olumsuz emir yan cümleyi BİTİRİR; ardından çekimli isim geliyorsa fiil değildir.',
  },
  {
    id: 'P2-3', group: 'prompt-tuzak',
    say: 'Ratchet’e ADP-854’ü ata',
    expect: { action: 'board', op: 'assign', 'route.cls': 'aksiyon' },
    why: 'ÖLÇÜLDÜ: pano ataması ajan adını KENDİ parametresi olarak tüketir — "ad + ver/ata" istisnası burada UYGULANMAZ (katalog kazanır).',
  },
  {
    id: 'P2-4', group: 'prompt-tuzak',
    say: 'Tasarımcı bir ajana ver bu işi',
    expect: { action: 'reply', unresolvedRole: 'design' },
    expectNot: { action: 'prompt' },
    why: 'Çözülemeyen rol prompt OLMAZ: kural yolunun dürüst sorusu konuşur (uydurup başkasına verme yasağı).',
  },
  {
    id: 'P2-5', group: 'prompt-tuzak',
    say: 'Ajan açma, sen kendin yap',
    expect: { executor: 'self' },
    expectNot: { 'route.cls': 'yok' },
    why: '"sen kendin yap" = kullanıcı bir şey İSTİYOR; olumsuz kutup değil (B1 korunur).',
  },

  // ── R. AXP-15 — SESLİ "TEKRAR GÖNDER" = MAKBUZ YENİDEN DENEMESİ (kontrol sınıfı) ──
  // AXP-09 §5: "Tekrar gönder." (15:03:51) kural yolunda prompt/belirsiz → YENİ TASLAK açtı;
  // kullanıcı İLETİLEMEDİ makbuzunu kastetmişti. Bu vakalar kural yolundan DEĞİL
  // `agentxRetryVoice.classifyRetryDelivery` kapısından ölçülür (`gate: 'retry-voice'`,
  // intentRegression KAPI 1c) — dur/sus/uyu gibi kontrol sınıfları da beyne varmaz.
  // `expect.retry` = kapının hükmü. Olumsuz/gövdeli/hedefli cümleler kapıdan GEÇMEZ:
  // onlar yönlendiricinin işidir (yanlış pozitif = başkasının işini yeniden denemek).
  ...[
    { id: 'R-1', say: 'Tekrar gönder.', expect: { retry: true }, why: 'AXP-09 §5 15:03:51 — bugün yeni taslak açıyordu' },
    { id: 'R-2', say: 'Yeniden dene', expect: { retry: true } },
    { id: 'R-3', say: 'Bir daha gönder', expect: { retry: true } },
    { id: 'R-4', say: 'Jarvis, tekrar gönder', expect: { retry: true }, why: 'hitap toleransı' },
    { id: 'R-5', say: 'Send it again', expect: { retry: true }, why: 'EN ayrı küme (çeviri değil)' },
    { id: 'R-6', say: 'Try again.', expect: { retry: true } },
    // kontrol kolu — OLUMSUZ ve GÖVDELİ cümleler kapıdan geçmez
    { id: 'R-N1', say: 'Tekrar gönderme', expect: { retry: false }, why: 'olumsuz biçim (-me): kullanıcı TERSİNİ istiyor' },
    { id: 'R-N2', say: 'Raporu tekrar gönder', expect: { retry: false }, why: 'iş gövdesi var → yönlendiricinin işi (prompt)' },
    { id: 'R-N3', say: 'Parker’a tekrar gönder', expect: { retry: false }, why: 'hedefli iletim → yönlendirici (hedefli taslak)' },
    { id: 'R-N4', say: 'Gönder', expect: { retry: false }, why: '"gönder" tek başına taslak kapanış sözüdür (DRAFT_CONTROL_WORDS.finish), yeniden deneme değil' },
  ].map((c) => ({ ...c, group: 'receipt-retry', gate: 'retry-voice', ctx: CTX_AXP })),
];

module.exports = { CTX, CTX_AXP, CTX_AXP_KAMIL, CASES };
