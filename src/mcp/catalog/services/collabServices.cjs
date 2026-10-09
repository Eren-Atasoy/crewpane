'use strict';

/** @type {Record<string, import('../index.cjs').IntegrationEntry>} */
const collabServices = {
  linear: {
    id: 'linear',
    label: 'Linear',
    authKind: 'api_key',
    // ÖLÇÜLDÜ (dist/utils/config.js:27 — `process.env.LINEAR_API_TOKEN || process.env.LINEAR_API_KEY`).
    // 🔴 SIRALAMA TUZAĞI: `LINEAR_API_TOKEN` ÖNCE okunur. Kullanıcının kabuğunda o ad
    // zaten duruyorsa (Linear CLI kurulumları onu bırakır) sunucu BİZİM kasadaki
    // anahtarı DEĞİL, o yabancı jetonu kullanır — sessizce. Kasa yalnız beyan edilen
    // adı yazar (Kural 2), yabancı adı silmez; belirti "yanlış çalışma alanı" olur.
    envVar: 'LINEAR_API_KEY',
    mcpServer: {
      command: 'npx',
      args: ['-y', '@tacticlaunch/mcp-linear@1.4.3'],
      transport: 'stdio',
    },
    keyGuidance:
      'Linear → (sol üst organizasyon avatarı) → Settings → Security & access → Personal API Keys → New API Key: '
      + 'yalnız bu makine için ayrı bir anahtar üret ve adına nereye verdiğini yaz (ör. "CrewPane"). '
      + '🔴 DİKKAT: Linear’ın kişisel API anahtarında GRANÜLER İZİN YOKTUR — anahtar senin tüm çalışma alanını, '
      + 'senin yetkinle görür ve değiştirir (issue silme, webhook, oturum kapatma dahil). Dar yetki gerekiyorsa '
      + 'tek yol OAuth’tur (scope’lar orada seçilir) — o yol bu sürümde YOK. Anahtarı işin bitince Linear’dan iptal et.',
    // INT-1 probe 2026-09-05, linear@1.4.3, 198 araç (tam el sıkışma).
    // 🔴 `needsScopes` HEPSİNDE BOŞ ve bu bir eksiklik DEĞİL, ölçülmüş bir hüküm:
    // paketin README'si (§Authentication) "OAuth scopes are selected when an
    // authorization URL or client-credentials token is requested" diyor — yani
    // `issues:create` / `admin` gibi adlar YALNIZ OAuth jetonuna aittir. Bu giriş
    // kişisel API anahtarı taşıyor, onun granüler izni YOK. Kartlara o OAuth
    // adlarını yazmak kullanıcıya OLMAYAN bir izni seçtirirdi (Kural 5).
    capabilities: [
      { id: 'linear.issues.read', label: 'Issue, yorum, geçmiş ve özel alanları oku, issue ara', needsScopes: [], kind: 'read' },
      { id: 'linear.issues.write', label: 'Issue aç/güncelle, ata, yorumla, etiketle, önceliklendir, arşivle', needsScopes: [], kind: 'write' },
      { id: 'linear.projects.write', label: 'Proje, roadmap, initiative, milestone ve cycle oluştur/güncelle/arşivle', needsScopes: [], kind: 'write' },
      { id: 'linear.docs.write', label: 'Doküman ve müşteri (customer/need) kayıtlarını oku ve düzenle', needsScopes: [], kind: 'write' },
      { id: 'linear.workspace.read', label: 'Takım, kullanıcı, etiket, iş akışı durumu ve organizasyonu oku', needsScopes: [], kind: 'read' },
      { id: 'linear.admin.write', label: '🔴 Webhook, OAuth uygulaması, oturum ve denetim kaydı yönetimi — oturum KAPATABİLİR, webhook sırrı DÖNDÜREBİLİR', needsScopes: [], kind: 'write' },
    ],
    mask: { keepPrefix: 8, keepSuffix: 4 }, // `lin_api_` mi `lin_oauth_` mu ayırt edilsin
    docsUrl: 'https://github.com/tacticlaunch/mcp-linear',
  },

  notion: {
    id: 'notion',
    label: 'Notion',
    authKind: 'api_key',
    // ÖLÇÜLDÜ (paket kaynağı): `NOTION_TOKEN` (34 kullanım). Eski `OPENAPI_MCP_HEADERS`
    // yolu hâlâ destekleniyor ama JSON gövdeli bir header dizesi ister — tek-env
    // sözleşmesine uymaz; bu yüzden BELGELENEN sade ad seçildi.
    envVar: 'NOTION_TOKEN',
    mcpServer: {
      command: 'npx',
      args: ['-y', '@notionhq/notion-mcp-server@2.5.1'],
      transport: 'stdio',
    },
    keyGuidance:
      'Notion → Settings → Connections → Develop or manage integrations → New integration: '
      + 'workspace\'ı seç ve **Capabilities** ekranında yalnız gerekeni işaretle — okuma yetecekse '
      + '"Read content" tek başına yeter, "Update content"/"Insert content" ancak ajanın sayfa '
      + 'yazması gerekiyorsa. "Read user information" için e-postasız seçeneği tercih et. '
      + '🔴 EN KRİTİK ADIM İZİN DEĞİL, PAYLAŞIMDIR: entegrasyon YALNIZ kendisiyle paylaştığın '
      + 'sayfaları görür (sayfa → ⋯ → Connections → entegrasyonu ekle). Workspace\'in kökünü '
      + 'paylaşırsan ajan HER ŞEYİ görür; tek bir çalışma sayfası paylaş.',
    scopesSelectable: true, // Notion'ın kendi "Capabilities" ekranındaki resmî adlar
    // INT-3 probe 2026-09-06, "Notion API"@1.0.0 (paket 2.5.1), 24 araç (tam el sıkışma).
    capabilities: [
      { id: 'notion.pages.read', label: 'Sayfa, blok ve sayfa içeriğini (markdown dahil) oku', needsScopes: ['Read content'], kind: 'read' },
      { id: 'notion.search.read', label: 'Workspace içinde ara; veritabanı/veri kaynağı şemasını ve kayıtlarını sorgula', needsScopes: ['Read content'], kind: 'read' },
      { id: 'notion.pages.write', label: 'Sayfa oluştur/güncelle, blok ekle-düzenle, sayfayı taşı', needsScopes: ['Insert content', 'Update content'], kind: 'write' },
      { id: 'notion.pages.delete', label: '🔴 Blok SİL (API-delete-a-block) — içerik çöp kutusuna gider', needsScopes: ['Update content'], kind: 'write' },
      { id: 'notion.database.write', label: 'Veri kaynağı (database) oluştur ve şemasını güncelle', needsScopes: ['Insert content', 'Update content'], kind: 'write' },
      { id: 'notion.comments.write', label: 'Yorumları oku ve yorum yaz; kullanıcı/bot bilgisini oku', needsScopes: ['Read comments', 'Insert comments'], kind: 'write' },
    ],
    mask: { keepPrefix: 4, keepSuffix: 4 }, // `ntn_` türü görünür
    docsUrl: 'https://github.com/makenotion/notion-mcp-server',
  },

  figma: {
    id: 'figma',
    label: 'Figma',
    authKind: 'api_key',
    // ÖLÇÜLDÜ: sunucu `FIGMA_API_KEY` (PAT) ya da `FIGMA_OAUTH_TOKEN` okuyor. PAT yolu
    // seçildi: OAuth jetonu bizim kasamızda DEĞİL, üçüncü bir yerde yaşardı (ADR §5).
    envVar: 'FIGMA_API_KEY',
    mcpServer: {
      command: 'npx',
      // `--stdio` ZORUNLU: bayraksız çalıştırıldığında paket HTTP sunucusu olarak
      // ayağa kalkar ve pane ile hiç konuşmaz (probe'ta ölçüldü).
      args: ['-y', 'figma-developer-mcp@0.13.2', '--stdio'],
      transport: 'stdio',
    },
    keyGuidance:
      'Figma → (profil) → Settings → Security → Personal access tokens → Generate new token: '
      + 'son kullanma süresi ver ve kapsamda YALNIZ dosya içeriği okumayı aç (yazma kapsamlarını '
      + 'kapalı bırak — bu sunucu zaten yazmıyor). Token hesabının GÖRDÜĞÜ her dosyayı okur; '
      + 'müşteri projeleri aynı hesapta duruyorsa ayrı bir Figma hesabı/ekip kullan. '
      + '🔴 `download_figma_images` diske dosya YAZAR (varsayılan dizin belirtilmezse geçici klasör).',
    // INT-3 probe 2026-09-06, "Figma MCP Server"@0.13.2, **2 araç**.
    // 🔴 KART SAYISI 5±1 KURALININ ALTINDA (2) ve bu bir eksiklik değil, ölçüm:
    // sunucunun TOPLAM aracı iki tane. Kart sayısı araç sayısını aşamaz; uydurma
    // kart eklemek ajana OLMAYAN bir yetenek vaat ederdi.
    // `needsScopes` Figma'nın makine-okur scope adları DOĞRULANMADIĞI için BOŞ
    // bırakıldı (uydurma ad yazılmadı); mekanizma keyGuidance'ta adıyla anılıyor.
    capabilities: [
      { id: 'figma.file.read', label: 'Figma dosyasının/çerçevesinin düzen, stil ve içerik verisini oku (tasarım → kod)', needsScopes: [], kind: 'read' },
      { id: 'figma.images.read', label: 'Tasarımdaki görselleri indir — 🔴 diske dosya YAZAR', needsScopes: [], kind: 'read' },
    ],
    mask: { keepPrefix: 5, keepSuffix: 4 }, // `figd_` türü görünür
    docsUrl: 'https://github.com/GLips/Figma-Context-MCP',
  },

  n8n: {
    id: 'n8n',
    label: 'n8n',
    authKind: 'api_key',
    envVar: 'N8N_API_KEY',
    mcpServer: {
      command: 'npx',
      // Paket iki yarım taşır: DOKÜMAN araçları (anahtarsız çalışır) + YÖNETİM
      // araçları (`n8n_*`, API URL + anahtar ister). Probe'ta 28 araçla el sıkıştı.
      args: ['-y', 'n8n-mcp@2.82.1'],
      transport: 'stdio',
    },
    // ÖLÇÜLDÜ: sunucu `N8N_API_URL` + `N8N_API_KEY` okur (47/42 kullanım).
    userFields: [
      { envVar: 'N8N_API_URL', label: 'n8n adresi', required: true, example: 'https://n8n-dev.sirketim.com' },
    ],
    keyGuidance:
      'n8n → Settings → n8n API → Create an API key. 🔴 DİKKAT: n8n API anahtarında GRANÜLER '
      + 'İZİN YOKTUR — anahtar o instance\'ın TAMAMINI (tüm workflow\'lar, çalıştırmalar ve '
      + 'KİMLİK BİLGİLERİ yönetimi) senin yetkinle açar. 🔴 GERÇEK MÜŞTERİ RİSKİ: `n8n_test_workflow` '
      + 'workflow\'u GERÇEKTEN çalıştırır (canlı bir otomasyon müşteriye mesaj gönderebilir), '
      + '`n8n_update_partial_workflow`/`n8n_delete_workflow` canlı otomasyonu değiştirir/siler. '
      + 'Bu yüzden ÜRETİM instance\'ını değil, önce bir GELİŞTİRME instance\'ını bağla; anahtarı '
      + 'işin bitince Settings → n8n API üzerinden iptal et.',
    // INT-2 probe 2026-09-05, n8n-documentation-mcp@2.82.1, 28 araç.
    // `needsScopes` BOŞ ve bu ölçülmüş bir hüküm: n8n public API anahtarının izin
    // adı YOKTUR (instance geneli). Uydurma bir liste yazılmadı.
    capabilities: [
      { id: 'n8n.docs.read', label: 'Düğüm dokümanını, şablonları ara ve bir workflow taslağını doğrula (anahtarsız da çalışır)', needsScopes: [], kind: 'read' },
      { id: 'n8n.workflows.read', label: 'Workflow listesini, sürümlerini ve çalıştırma geçmişini oku', needsScopes: [], kind: 'read' },
      { id: 'n8n.workflows.write', label: '🔴 CANLI workflow oluştur/güncelle/sil, şablon deploy et', needsScopes: [], kind: 'write' },
      { id: 'n8n.execute', label: '🔴 Workflow\'u GERÇEKTEN çalıştır (n8n_test_workflow) — dış dünyaya mesaj gidebilir', needsScopes: [], kind: 'write' },
      { id: 'n8n.credentials.write', label: '🔴 n8n kimlik bilgilerini (credentials) yönet', needsScopes: [], kind: 'write' },
      { id: 'n8n.instance.admin', label: 'Instance sağlığını, denetimini, klasör/veri tablosu ve ajan ayarlarını yönet', needsScopes: [], kind: 'write' },
    ],
    mask: { keepPrefix: 3, keepSuffix: 4 },
    docsUrl: 'https://github.com/czlonkowski/n8n-mcp',
  },

  metabase: {
    id: 'metabase',
    label: 'Metabase',
    authKind: 'api_key',
    envVar: 'METABASE_API_KEY',
    mcpServer: {
      command: 'npx',
      args: ['-y', 'metabase-mcp@0.1.8'],
      transport: 'stdio',
    },
    // ÖLÇÜLDÜ: sunucu YALNIZ `METABASE_URL` + `METABASE_API_KEY` okuyor.
    userFields: [
      { envVar: 'METABASE_URL', label: 'Metabase adresi', required: true, example: 'https://metabase.sirketim.com' },
    ],
    keyGuidance:
      'Metabase → Admin settings → Authentication → API keys → Create API key: anahtar bir GRUBA '
      + 'bağlanır ve yetkisini o gruptan alır — en dar izinli grubu seç (ör. yalnız ilgili koleksiyonu '
      + 'gören bir grup), "Administrators" ASLA verme. 🔴 `execute_query` HAM SQL çalıştırır: anahtarın '
      + 'grubu hangi veritabanlarını görüyorsa ajan da onları sorgulayabilir (müşteri verisi dahil). '
      + '🔴 `archive_card`/`archive_collection`/`delete_dashboard` başkalarının panolarını kaldırabilir.',
    // INT-2 probe 2026-09-05, metabase-mcp@0.1.8, 19 araç.
    // `needsScopes` BOŞ: Metabase API anahtarının izin ADI yoktur, yetki GRUP üyeliğinden
    // gelir (keyGuidance bunu mekanizma olarak anıyor).
    capabilities: [
      { id: 'metabase.query.read', label: '🔴 Ham SQL sorgusu çalıştır ve kayıtlı soruları koştur (verinin kendisine erişim)', needsScopes: [], kind: 'read' },
      { id: 'metabase.content.read', label: 'Pano, soru (card), koleksiyon ve veritabanı listesini oku, arama yap', needsScopes: [], kind: 'read' },
      { id: 'metabase.cards.write', label: 'Soru (card) oluştur, güncelle ve görselleştirmesini değiştir', needsScopes: [], kind: 'write' },
      { id: 'metabase.dashboards.write', label: 'Pano oluştur, karta ekle, taşı ve pano düzenini güncelle', needsScopes: [], kind: 'write' },
      { id: 'metabase.archive.write', label: '🔴 Kartı/koleksiyonu arşivle, panoyu SİL — başkalarının işini etkiler', needsScopes: [], kind: 'write' },
      { id: 'metabase.collections.write', label: 'Koleksiyon oluştur (içerik düzeni)', needsScopes: [], kind: 'write' },
    ],
    mask: { keepPrefix: 3, keepSuffix: 4 },
    docsUrl: 'https://github.com/hyeongjun-dev/metabase-mcp-server',
  },
};

module.exports = collabServices;
