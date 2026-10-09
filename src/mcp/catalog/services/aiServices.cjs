'use strict';

const { EXTERNAL_KEY_STORE } = require('../constants.cjs');

/** @type {Record<string, import('../index.cjs').IntegrationEntry>} */
const aiServices = {
  fal: {
    id: 'fal',
    label: 'fal.ai',
    authKind: 'api_key',
    // ÖLÇÜLDÜ (dist/index.js:6 `const FAL_KEY = process.env.FAL_KEY`, dist/tools.js:257
    // `Authorization: Key ${process.env.FAL_KEY}`) — sunucu YALNIZ bu adı okur.
    envVar: 'FAL_KEY',
    mcpServer: {
      command: 'npx',
      // Aday karşılaştırması (üçü de probe'ta TAM el sıkıştı — INT-4-probe.md):
      // `fal-ai-mcp-server` (derekalia, 1611 indirme/ay, 12 araç) 10 aydır
      // GÜNCELLENMEMİŞ; `fal-mcp` (danielrosehill, 564 indirme/ay) yalnız görsel+TTS
      // ile SINIRLI (5 araç). Bu paket (enescanguven) taze (2026-03), benzer indirme
      // sayısı (1624/ay) ve görsel+video+ses+model-arama'yı TEK yüzeyde veriyor (9 araç).
      args: ['-y', 'fal-ai-mcp@0.2.1'],
      transport: 'stdio',
    },
    keyGuidance:
      'fal.ai → fal.ai/dashboard/keys → yeni anahtar üret: yalnız bu makine için ayrı '
      + 'bir anahtar oluştur ve işin bitince oradan sil/döndür (rotate). 🔴 GRANÜLER '
      + 'İZİN YOKTUR — fal.ai anahtarı hesabının TÜMÜNE (tüm modeller + faturalama) '
      + 'erişir, Linear\'daki kişisel API anahtarıyla aynı sınıf. 🔴 HER görsel/video/'
      + 'ses üretimi hesabından GERÇEK PARA/KREDİ harcar ve `run_model` aracı '
      + 'fal.ai\'deki 600+ modelden HERHANGİ birini keyfi parametrelerle çalıştırabilir '
      + '— ajana sınırsız bir üretim/harcama yetkisi verdiğini bil. Kota/harcama '
      + 'sınırını fal.ai panelinden ayarla, bu sunucu kendi tarafında bir üst sınır '
      + 'UYGULAMAZ.',
    // fal.ai'nin OAuth/granüler scope sözlüğü YOK (n8n/Linear emsali) — `scopesSelectable`
    // bilerek YAZILMADI, needsScopes hepsinde boş.
    capabilities: [
      { id: 'fal.image.write', label: 'Metinden görsel üret, mevcut görseli düzenle/upscale et (FLUX, Recraft vb.)', needsScopes: [], kind: 'write' },
      { id: 'fal.video.write', label: 'Metin veya görselden video üret (Kling, Veo, Sora, LTX)', needsScopes: [], kind: 'write' },
      { id: 'fal.audio.write', label: 'Konuşmayı metne çevir, metinden konuşma/müzik üret', needsScopes: [], kind: 'write' },
      { id: 'fal.models.read', label: 'fal.ai model kataloğunda ara, model bilgisini oku', needsScopes: [], kind: 'read' },
      { id: 'fal.models.write', label: '🔴 fal.ai\'deki HERHANGİ bir modeli keyfi parametrelerle doğrudan çalıştır (run_model) — bilinen bir görev tanımıyla sınırlı değil', needsScopes: [], kind: 'write' },
    ],
    mask: { keepPrefix: 2, keepSuffix: 4 }, // sabit bir marka öneki yok (uuid:secret biçimi)
    docsUrl: 'https://github.com/enescanguven/fal-mcp',
  },

  // ── ADP-848-B — ElevenLabs: katalogda GÖRÜNÜR, ama anahtarı BURADA DURMAZ ─────
  //
  // 🔴 TEK GERÇEK KURALI. ElevenLabs anahtarının bugünkü tek yeri
  // `requireCredential` + `settings.json → apiKeys.elevenlabs` (Ayarlar → Ses →
  // Erişim). Bu servisi normal bir katalog girişi yapıp vault'a da yazdırsaydık
  // AYNI anahtarın İKİ deposu olurdu ve `resolveCredential` sırası (vault → ayarlar)
  // yüzünden kullanıcı Ayarlar'daki anahtarı değiştirdiğinde ürün hâlâ vault'taki
  // ESKİ anahtarı kullanırdı — sessiz, teşhisi zor, faturayı yanlış hesaba yazan
  // bir hata. Bu yüzden giriş `keyStore:'settings'` ile işaretlidir:
  //   • Bağlı hesaplar ekranında GÖRÜNÜR (kullanıcı "neyim bağlı" sorusunu tek
  //     ekrandan cevaplasın — maddenin isteği buydu),
  //   • ama "Bağla" formu AÇILMAZ; `integrationIpc.add` bu servisi REDDEDER,
  //   • ekran kullanıcıyı gerçek alana (Ayarlar → Ses → Erişim) yollar.
  // Yeni bir servisi buraya `keyStore:'settings'` ile eklemek = "anahtarı başka
  // bir yüzey yönetiyor, katalog yalnız aynayı tutuyor" demektir.
  elevenlabs: {
    id: 'elevenlabs',
    label: 'ElevenLabs',
    authKind: 'api_key',
    // MCP server'ı YOK: bu bir ajan aracı değil, uygulamanın kendi seslendirme
    // sağlayıcısı. envVar null → spawn resolver'ı bu girişe hiç dokunmaz.
    envVar: null,
    mcpServer: null,
    keyStore: EXTERNAL_KEY_STORE,
    /** Anahtarın GERÇEKTEN yönetildiği yer — UI derin-bağlantısı buradan türer. */
    managedAt: { category: 'voice', field: 'voice-elevenlabs-key' },
    managedLabel: 'Ayarlar → Ses & Agent X → Erişim',
    keyGuidance:
      'ElevenLabs → Profile → API Keys: yalnız bu bilgisayar için ayrı bir anahtar üret; '
      + 'izinleri "Text to Speech" + "Voices: read" ile sınırla. Anahtar Agent X’in sesi için '
      + 'kullanılır ve fatura SENİN hesabına işlenir — CrewPane araya girmez.',
    mask: { keepPrefix: 3, keepSuffix: 4 },
    docsUrl: 'https://elevenlabs.io/app/settings/api-keys',
  },
};

module.exports = aiServices;
