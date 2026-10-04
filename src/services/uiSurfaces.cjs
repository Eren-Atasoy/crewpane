// ADP-883 (Wheeljack) — AÇILABİLİR YÜZEY KAYDI (tek gerçek, iki süreç).
//
// ── SINIF TANIMI (tek tek özel durum DEĞİL) ─────────────────────────────────
// "Ayarları aç", "ses ayarlarını aç", "şirket ağacını göster" bugün HİÇBİR dala
// uymuyordu: kural yolunda yalnız `sekme` isimli dock görünümleri vardı, Ayarlar
// panelinin 12 alt kategorisi ve org paneli (şirket ağacı / +Takım / +Çalışan)
// SESLE ULAŞILAMAZ yüzeylerdi. Her biri için ayrı bir `if` yazmak aynı hatayı
// yarın yeni bir ayar sayfası eklendiğinde tekrar üretirdi.
//
// ÇÖZÜM: yüzeyler VERİ olur. Bir satır = bir yüzey (id + nasıl açılır + hangi
// Türkçe ifadeler onu söyler). Kural yolu (main) ve yürütücü (renderer) AYNI
// kaydı okur; yeni bir ayar kategorisi eklemek = buraya BİR SATIR (ve drift
// kapısı — `settingsCategories.drift.test.cjs` — satırı unutursan KIRMIZI verir).
//
// NEDEN electron/ (src/ değil): main süreç `src/`i okuyamaz (paketleme listesi
// yalnız `*.cjs`/`*.js`/`renderer/**` alır — voiceName.cjs'in aynı gerekçesi).
// Renderer ise `electron/*.cjs`i statik import edebilir (turkishMorph/voiceName
// emsali). Yön TERS DEĞİL.
//
// EŞLEŞTİRME: alt-dize araması YOK (ADP-854 sınıfı). İfade = BİTİŞİK jeton dizisi;
// her jeton isim çekimine toleranslı eşleşir ("ayar" ⊇ "ayarları"). En UZUN ifade
// kazanır ("takım ayarları" → Takım İzinleri, çıplak "ayarlar" DEĞİL).
//
// AÇMA `kind`'ı SEMBOLİKTİR (olay adı DEĞİL): olay adları renderer'da tek yerde
// (actionBus.ts) yaşamaya devam eder — ADP-263'ün "event adı tek yerde" kuralı.
//
// ADP-885/st1 — i18n-exempt: intent-token. `phrases`/`keywords` KULLANICININ
// SÖYLEDİĞİ ifadelerdir → ÇEVRİLMEZ. (`label` arayüzde de görünür; o çevrilebilir
// ama eşleştirme `phrases` üzerinden yapılır — ikisi ayrı alanda durduğu için
// birini çevirmek diğerini bozmaz.) Kayıt zaten TEK DOSYA olduğu için ifadeler
// leksikona taşınmadı: ifade ile açma köprüsü aynı satırda anlamlıdır.

'use strict';

const morph = require('../voice/turkishMorph.cjs');
const { VOICE_SETTINGS_LABEL } = require('../voice/voiceName.cjs');

/**
 * Ayarlar panelinin kategori id'leri — `SettingsPanel.tsx::CategoryId` ile AYNI
 * küme olmak ZORUNDA (drift kapısı: electron/settingsCategories.drift.test.cjs).
 * `useSettingsLauncher` de bu listeden beslenir; eskiden orada AYRI bir kopya
 * vardı ve 'integrations' ORADA EKSİKTİ → "Entegrasyonları aç" sessizce Genel'i
 * açıyordu (ölçüldü, bkz. ADP-883 raporu §ÖNCE).
 */
const SETTINGS_CATEGORY_IDS = Object.freeze([
  'general',
  // CI-GREEN-01 (2. tur) — panelde COMMIT'Lİ olup kayıtta olmayan üç kategori
  // ('projects', 'office', 'characters'; SettingsPanel.tsx::CategoryId satır 301).
  // Sürüklenme yönü yine panel→kayıt. Üçü de aşağıda konuşulabilir bir ifadeyle
  // karşılanır; 'office' için ÇIPLAK 'ofis' KULLANILAMAZ (tab.office onu sahiplenir).
  'projects',
  'office',
  'characters',
  'appearance',
  'shortcuts',
  // CI-GREEN-01 — panelde VAR olup kayıtta olmayan dört kategori (sürüklenme yönü:
  // panel ilerledi, kayıt geride kaldı). Her biri aşağıda konuşulabilir bir ifadeyle
  // de karşılanır — yoksa ikinci DRIFT kapısı ("sesle açılamayan kategori") kırılır.
  'editor',
  'sync',
  'feedbackMine',
  'feedbackAdmin',
  'voice',
  'engines',
  // 🪤 CI-GREEN-01 — 'engineAccounts' BURADAN ÇIKARILDI: ADP-936'nın ayrı kategorisi
  // panelde artık YOK (`CategoryId` birleşiminde geçmiyor, motor hesapları 'engines'
  // altında yaşıyor). Kayıtta bırakmak "sesle açılabilir ama panelde karşılığı olmayan"
  // bir kategori üretirdi — DRIFT kapısının ters yönü.
  'integrations',
  'notifications',
  'devices',
  'trust',
  'teamScope',
  'account',
  'status',
  // TOUR-02-A — YARDIM: turlar + "İlk 10 Dakika" görev günlüğü + topluluk.
  // 🪤 Bu satır bir KAPININ parçası: kategoriyi yalnız SettingsPanel'in
  // `CategoryId` birleşimine eklemek YETMEZ — `OPEN_SETTINGS_EVENT` kategoriyi bu
  // kayda göre süzer ve kayıtta olmayan kategori SESSİZCE düşer, panel "Genel"de
  // açılır. Tam olarak bu oldu: TOUR-02-A'nın ilk e2e koşusunda "Ayarlar → Yardım
  // → Geri aç" düğmesi bulunamadı ve neden buydu (ADP-883 yorumunun uyardığı tuzak).
  'help',
  // ADP-936 tarafından eklendi: 'memory' union üyesi (ADP-900) BENİM `engineAccounts`
  // eklememle AYNI SATIRDA yaşıyor (`export type CategoryId = …`) → o satırı
  // commit'lemek ONU da commit'lemek demek. Aşağıdaki 🪤 notunun tam olarak uyardığı
  // durum artık geçerli DEĞİL: kategori id'si artık commit'li, dolayısıyla kaydı da
  // (ve konuşulabilir ifadesi) burada olmak ZORUNDA — yoksa DRIFT kapısı kırmızıya
  // döner. ADP-900'ün kalan parçaları (CATEGORIES satırı + render bloğu) kendi
  // commit'iyle iner; bu satır onları BEKLEMEZ, tek işi kapıyı tutarlı tutmak.
  'memory',
  // 🪤 ADP-921 (ölçüldü): bu liste SettingsPanel'in COMMIT'LENMİŞ kategorilerini
  // izler — commit'siz bir çalışma ağacındakini DEĞİL. 'memory' (Anlama göre
  // arama) satırı bir tur buraya yazılmıştı ama karşılığı olan kategori henüz
  // ADP-900'ün commit'siz WIP'indeydi: `dev`'in temiz kopyasında DRIFT testi
  // TERS yönden kırmızıya döndü. Kategoriyi commit'leyen tur bu satırı da ekler
  // (kapının söylediği iş budur); başkasının WIP'ini burada ÖNCEDEN karşılamak
  // kaydı o WIP'in inmesine BAĞIMLI kılar.
]);

/**
 * @typedef {Object} UiSurface
 * @property {string} id      kararda taşınan kararlı kimlik ('settings.voice')
 * @property {'tab'|'settings'|'org'} kind  yürütücünün hangi köprüyü süreceği
 * @property {string|null} key  köprünün parametresi (viewId · CategoryId · OrgPanelIntent)
 * @property {string} label   sesli cümlede geçen Türkçe ad ("Ses & Agent X ayarları")
 * @property {string[][]} phrases  bitişik jeton dizileri (isim çekimine toleranslı)
 * @property {string[]} [keywords]  TEK-jetonlu ayırt edici sözcükler — YALNIZ hedef
 *   ALANI çözülürken (`{loose:true}`) bakılır. Cümlenin TAMAMINI tararken bakılmaz:
 *   "hesap" gibi bir sözcük serbest cümlede yüzey adı değildir. 🪤 ÖLÇÜLDÜ: beyin
 *   `target`i kendi tek sözcüğüyle yolluyor ("güven"/"hesap") ve yalnız iki-jetonlu
 *   ifade bırakmak koşudan koşuya DEĞİŞEN sahte-kırmızı üretiyordu.
 * @property {boolean} [selfActuating]  ifade fiili İÇERİYORSA true → ayrı açma fiili aranmaz
 */

/** @type {UiSurface[]} */
const SURFACES = [
  // ── Dock görünümleri ──────────────────────────────────────────────────────
  // NOT: "<ad> sekmesi" biçimi ZATEN ayrı bir dalda (parseIntent §7) çözülüyor;
  // buradaki ifadeler "sekme" demeden söylenen hâli kapatır ("ofisi aç").
  { id: 'tab.office', kind: 'tab', key: 'office', label: 'Ofis', phrases: [['ofis']] },
  { id: 'tab.terminals', kind: 'tab', key: 'terminals', label: 'Terminaller', phrases: [['terminal', 'panel']] },
  { id: 'tab.editor', kind: 'tab', key: 'editor', label: 'Kod editörü', phrases: [['kod', 'editör'], ['editör']] },
  { id: 'tab.browser', kind: 'tab', key: 'browser', label: 'Tarayıcı', phrases: [['tarayıcı'], ['browser']] },
  { id: 'tab.kanban', kind: 'tab', key: 'kanban', label: 'Görev panosu', phrases: [['görev', 'panosu'], ['görev', 'pano'], ['kanban']] },
  { id: 'tab.memory', kind: 'tab', key: 'memory', label: 'Hafıza', phrases: [['hafıza'], ['bellek']] },
  // NOT: sesli asistan widget'ı'ı KAYITTA YOK — o bir dock görünümü değil, kendi
  // aç/kapa mantığı olan yüzen bir pencere (ADP-882'nin kapsamı). Buraya bir satır
  // koymak "kayıtta var ama açılmıyor" sınıfını üretirdi.

  // ── Ayarlar (panel + 12 alt kategori) ────────────────────────────────────
  // Çıplak "ayarlar" paneli KENDİ varsayılan kategorisinde açar; alt kategoriler
  // DAHA UZUN ifadeyle kazanır (en-uzun-eşleşme kuralı).
  { id: 'settings.root', kind: 'settings', key: null, label: 'Ayarlar', phrases: [['ayar']] },
  { id: 'settings.general', kind: 'settings', key: 'general', label: 'Genel ayarlar', phrases: [['genel', 'ayar']], keywords: ['genel'] },
  {
    id: 'settings.appearance', kind: 'settings', key: 'appearance', label: 'Görünüm ve Dil',
    // ADP-921 — sekmenin ADI artık "Görünüm ve Dil" (ADP-899 dil seçiciyi buraya
    // koydu) ama kayıt eski adla kalmıştı: "Görünüm ve Dil'e git" HİÇBİR ifadeye
    // uymuyordu. 🪤 'dil' KEYWORD OLAMAZ: `uiControls.cjs::settings.locale`
    // kontrolünün ifadesiyle çakışır ve "dili İngilizce yap" DEĞER değiştirmek
    // yerine EKRAN açardı. Bu yüzden yalnız BİTİŞİK ifadeler.
    phrases: [['görünüm', 'ayar'], ['tema', 'ayar'], ['görünüm', 've', 'dil'], ['dil', 'ayar']],
    keywords: ['görünüm', 'tema'],
  },
  { id: 'settings.shortcuts', kind: 'settings', key: 'shortcuts', label: 'Kısayollar', phrases: [['kısayol']], keywords: ['kısayol'] },
  {
    id: 'settings.voice', kind: 'settings', key: 'voice', label: `${VOICE_SETTINGS_LABEL} ayarları`,
    phrases: [['ses', 'ayar'], ['agent', 'x', 'ayar'], ['ses', 've', 'agent', 'x']],
    keywords: ['ses'],
  },
  {
    id: 'settings.engines', kind: 'settings', key: 'engines', label: 'AI Motorları',
    // 🪤 'AI' Türkçe locale'de 'aı' olur ('I'.toLocaleLowerCase('tr') === 'ı') —
    // ölçüldü: yalnız 'ai' yazılınca "AI motorlarını aç" HİÇ eşleşmiyordu.
    phrases: [['aı', 'motor'], ['ai', 'motor'], ['motor', 'ayar'], ['motorlar'], ['yapay', 'zeka']],
    keywords: ['motor'],
  },
  {
    // CI-GREEN-01 — panelde 'editor' KATEGORİSİ var (Çalışma alanı grubu).
    // 🪤 ÇIPLAK 'editör' YAZILAMAZ: `tab.editor` (kod editörü DOCK görünümü) onu
    // tek jetonla tutuyor — "editörü aç" ayar sayfası değil SEKME açmalı. Bu yüzden
    // yalnız iki-jetonlu ifadeler ve keyword YOK.
    id: 'settings.editor', kind: 'settings', key: 'editor', label: 'Editör ayarları',
    phrases: [['editör', 'ayar'], ['editör', 'tercih']],
  },
  {
    id: 'settings.sync', kind: 'settings', key: 'sync', label: 'Senkron',
    phrases: [['senkron', 'ayar'], ['senkronizasyon'], ['senkron']],
    keywords: ['senkron', 'senkronizasyon'],
  },
  {
    // 🪤 SIRA ÖNEMLİ: "geri bildirimlerim" iki ifadeye de uyar (ÇEKİM serbest:
    // 'bildirim' ⊇ 'bildirimlerim') ve ikisi de İKİ jetondur → eşitlikte KAYIT SIRASI
    // kazanır. Bu yüzden ÖZEL olan ('…lerim' = benimkiler) GENEL olandan ÖNCE durur.
    id: 'settings.feedbackMine', kind: 'settings', key: 'feedbackMine', label: 'Geri bildirimlerim',
    phrases: [['geri', 'bildirimlerim'], ['bildirimlerim']],
  },
  {
    id: 'settings.feedbackAdmin', kind: 'settings', key: 'feedbackAdmin', label: 'Geri bildirimler',
    // 🪤 ÇIPLAK 'bildirim' YAZILAMAZ: `settings.notifications` onu keyword olarak
    // tutuyor ("bildirimleri aç" = bildirim AYARLARI). Ayırt edici olan 'geri'.
    phrases: [['tüm', 'geri', 'bildirim'], ['geri', 'bildirim']],
  },
  { id: 'settings.integrations', kind: 'settings', key: 'integrations', label: 'Entegrasyonlar', phrases: [['entegrasyon']], keywords: ['entegrasyon'] },
  {
    id: 'settings.notifications', kind: 'settings', key: 'notifications', label: 'Bildirim ayarları',
    // 🪤 ÖLÇÜLDÜ (e2e): beyin `target`i KENDİ sözcüğüyle yolluyor ("bildirimler") —
    // yalnız iki-jetonlu ifade bırakmak "kayıtta var ama çözülemiyor" üretiyordu.
    phrases: [['bildirim', 'ayar'], ['bildirimler']],
    keywords: ['bildirim'],
  },
  { id: 'settings.devices', kind: 'settings', key: 'devices', label: 'Cihazlar', phrases: [['cihaz', 'ayar'], ['cihazlar']], keywords: ['cihaz'] },
  { id: 'settings.trust', kind: 'settings', key: 'trust', label: 'Güven ayarları', phrases: [['güven', 'ayar']], keywords: ['güven'] },
  {
    id: 'settings.teamScope', kind: 'settings', key: 'teamScope', label: 'Takım İzinleri',
    phrases: [['takım', 'izin'], ['takım', 'ayar'], ['ekip', 'ayar']],
    // 🪤 'takım' KEYWORD OLAMAZ: org.tree ve org.addTeam ile çakışır.
    keywords: ['izin'],
  },
  { id: 'settings.account', kind: 'settings', key: 'account', label: 'Hesap', phrases: [['hesap', 'ayar'], ['hesabım']], keywords: ['hesap'] },
  {
    // ADP-900 kategorisi (ADP-936 ile birlikte kayda girdi — gerekçe yukarıda).
    // 🪤 çıplak 'hafıza' YAZILAMAZ: `tab.memory` (Hafıza dock görünümü) ile çakışır,
    // "hafızayı aç" sekme yerine ayar sayfası açardı.
    id: 'settings.memory', kind: 'settings', key: 'memory', label: 'Anlama göre arama',
    phrases: [['anlamsal', 'arama'], ['anlam', 'arama'], ['semantik', 'arama'], ['hafıza', 'ayar']],
    keywords: ['semantik'],
  },
  {
    id: 'settings.status', kind: 'settings', key: 'status', label: 'Sistem Durumu',
    phrases: [['sistem', 'durum'], ['sistem', 'ayar']],
    keywords: ['sistem'],
  },
  // TOUR-02-A — Yardım: sesle de ulaşılabilir olmalı, yoksa ikinci DRIFT kapısı
  // ("kayıtta var ama konuşulamıyor") kırılır.
  {
    id: 'settings.help', kind: 'settings', key: 'help', label: 'Yardım',
    phrases: [['yardım'], ['tur'], ['görev', 'günlüğ'], ['ilk', 'dakika']],
    keywords: ['yardım', 'tur', 'günlük'],
  },
  {
    id: 'settings.projects', kind: 'settings', key: 'projects', label: 'Projeler',
    phrases: [['proje', 'ayar'], ['projeler'], ['proje', 'klasör']],
    keywords: ['proje'],
  },
  {
    // 🪤 ÇIPLAK 'ofis' YAZILAMAZ: `tab.office` onu sahiplenir ("ofisi aç" SEKMEDİR).
    // settings.memory ↔ tab.memory ile birebir aynı tuzak — ifade nitelenmek zorunda.
    id: 'settings.office', kind: 'settings', key: 'office', label: 'Ofis paketi',
    phrases: [['ofis', 'paket'], ['ofis', 'dışa'], ['ofis', 'içe'], ['ofis', 'ayar']],
    keywords: [],
  },
  {
    id: 'settings.characters', kind: 'settings', key: 'characters', label: 'Karakterler',
    phrases: [['karakter'], ['avatar', 'paket'], ['avatar']],
    keywords: ['karakter', 'avatar'],
  },

  // ── Org paneli (şirket ağacı + iki diyalog) ──────────────────────────────
  {
    id: 'org.tree', kind: 'org', key: 'tree', label: 'Şirket ağacı',
    phrases: [
      ['şirket', 'ağac'], ['şirket', 'yapı'], ['org', 'ağac'],
      ['organizasyon', 'şema'], ['organizasyon'],
      ['takım', 'yönetim'], ['çalışan', 'yönetim'],
    ],
    keywords: ['şirket', 'organizasyon'],
  },
  {
    id: 'org.addTeam', kind: 'org', key: 'addTeam', label: 'Yeni takım',
    phrases: [['yeni', 'takım'], ['takım', 'ekle']], selfActuating: true,
  },
  {
    id: 'org.addEmp', kind: 'org', key: 'addEmp', label: 'Yeni çalışan',
    phrases: [['yeni', 'çalışan'], ['çalışan', 'ekle'], ['personel', 'ekle']], selfActuating: true,
  },
];

const BY_ID = new Map(SURFACES.map((s) => [s.id, s]));

/** Kayıttaki tüm yüzeyler (kopya — çağıran mutasyona uğratamaz). */
function listSurfaces() {
  return SURFACES.map((s) => ({ ...s }));
}

/** id ile yüzey (yoksa null). */
function surfaceById(id) {
  return BY_ID.get(String(id || '')) || null;
}

/**
 * Bir jeton, ifade parçasıyla eşleşiyor mu? İsim çekimi serbest ("ayar" ⊇
 * "ayarları"), ama TÜREV serbest değil (NOUN_SUFFIX_RE izin listesi).
 */
function tokenMatches(tok, part) {
  if (!tok || !tok.startsWith(part)) return false;
  return morph.NOUN_SUFFIX_RE.test(tok.slice(part.length));
}

/** İfade (bitişik jeton dizisi) metinde geçiyor mu? */
function phraseHit(toks, phrase) {
  if (!phrase.length || phrase.length > toks.length) return false;
  for (let i = 0; i + phrase.length <= toks.length; i++) {
    let all = true;
    for (let j = 0; j < phrase.length; j++) {
      if (!tokenMatches(toks[i + j], phrase[j])) { all = false; break; }
    }
    if (all) return true;
  }
  return false;
}

/**
 * Konuşulan metinde bir yüzey adı geçiyor mu?
 * EN UZUN ifade kazanır: "takım ayarlarını aç" → Takım İzinleri (çıplak "ayarlar"
 * DEĞİL). Eşitlikte kayıt sırası kazanır (üstteki daha geneldir).
 *
 * @returns {{ surface: UiSurface, phrase: string[] } | null}
 */
function resolveSurface(text, opts = {}) {
  const toks = Array.isArray(text) ? text : morph.tokens(text);
  if (!toks.length) return null;
  let best = null;
  for (const surface of SURFACES) {
    for (const phrase of surface.phrases) {
      if (!phraseHit(toks, phrase)) continue;
      if (!best || phrase.length > best.phrase.length) best = { surface, phrase };
    }
  }
  if (best || !opts.loose) return best;
  // GEVŞEK tur: yalnız HEDEF ALANI çözülürken (beyin `target`i kendi sözcüğüyle
  // yolladığında) tek-jetonlu ayırt edici sözcüklere de bakılır. Cümlenin tamamı
  // taranırken ASLA — orada "hesap"/"güven" yüzey adı değildir.
  for (const surface of SURFACES) {
    for (const kw of surface.keywords || []) {
      if (phraseHit(toks, [kw])) return { surface, phrase: [kw], loose: true };
    }
  }
  return null;
}

/**
 * Bulunamayan bir ekran için EN YAKIN aday (uydurma yok — "bunu mu demek
 * istedin?" cümlesi bundan doğar). Yalnız GERÇEKTEN yakınsa döner (mesafe ≤2 ve
 * jeton ≥4 harf); yoksa null → "öyle bir ekran bulamadım" tek başına konuşur.
 */
function suggestSurface(text) {
  const toks = (Array.isArray(text) ? text : morph.tokens(text)).filter((t) => t.length >= 4);
  if (!toks.length) return null;
  let best = null;
  for (const surface of SURFACES) {
    for (const phrase of surface.phrases) {
      for (const part of phrase) {
        if (part.length < 4) continue;
        for (const tok of toks) {
          const d = morph.editDistance(tok.slice(0, part.length + 2), part, 2);
          if (d <= 2 && (!best || d < best.distance)) best = { surface, distance: d };
        }
      }
    }
  }
  return best ? best.surface : null;
}

module.exports = {
  SETTINGS_CATEGORY_IDS,
  SURFACES,
  listSurfaces,
  surfaceById,
  resolveSurface,
  suggestSurface,
  phraseHit,
  tokenMatches,
};
