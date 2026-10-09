'use strict';

/** @type {Record<string, import('../index.cjs').IntegrationEntry>} */
const infraServices = {
  supabase: {
    id: 'supabase',
    label: 'Supabase',
    authKind: 'api_key',
    envVar: 'SUPABASE_ACCESS_TOKEN',
    mcpServer: {
      command: 'npx',
      // --read-only: Kural 3'ün MCP tarafındaki karşılığı. Anahtar dar olsa bile
      // server'ı yazma-yetkisiz başlatmak ikinci savunma hattıdır.
      args: ['-y', '@supabase/mcp-server-supabase@latest', '--read-only'],
      transport: 'stdio',
    },
    keyGuidance:
      'Supabase → Account → Access Tokens: yalnız bu makine için AYRI bir token üret. '
      + 'Server --read-only başlar; tek projeye kilitlemek için aşağıdaki proje ref alanını doldur. '
      + 'service_role anahtarını ASLA verme (o, RLS’i tamamen atlar).',
    // --project-ref=<ref> kapsamı TEK projeye indirir; kullanıcıya özel, gizli değil.
    scopesSelectable: true, // INT-0-D — needsScopes KONKRET izin adı (seçilebilir)
    userFields: [
      { envVar: 'SUPABASE_PROJECT_REF', label: 'Proje ref (opsiyonel)', required: false, example: 'abcdefghijklmnop' },
    ],
    // BR-03 — probe 2026-08-12, server supabase@0.10.0, 19 araç (--read-only ile
    // el sıkışıldı; bu bayrak yazma araçlarını tools/list'ten TAMAMEN düşürüyor —
    // yani "yazma" kartı YOK çünkü server bu şablonla asla yazma aracı vermiyor).
    capabilities: [
      { id: 'supabase.projects.read', label: 'Proje ve organizasyon listesini oku', needsScopes: ['projects:read'], kind: 'read' },
      { id: 'supabase.schema.read', label: 'Tablo şemasını, extension ve migration geçmişini incele', needsScopes: ['projects:read'], kind: 'read' },
      { id: 'supabase.sql.read', label: 'Salt-okunur SQL sorgusu çalıştır, proje loglarını sorgula', needsScopes: ['projects:read'], kind: 'read' },
      { id: 'supabase.advisors.read', label: 'Güvenlik/performans danışman uyarılarını (advisors) çek', needsScopes: ['projects:read'], kind: 'read' },
      { id: 'supabase.edge_functions.read', label: 'Edge Function listesini ve kaynak kodunu görüntüle', needsScopes: ['projects:read'], kind: 'read' },
      { id: 'supabase.branches.read', label: "Geliştirme branch'lerini ve durumlarını listele", needsScopes: ['projects:read'], kind: 'read' },
    ],
    mask: { keepPrefix: 3, keepSuffix: 4 },
    docsUrl: 'https://supabase.com/docs/guides/getting-started/mcp',
  },

  hostinger: {
    id: 'hostinger',
    label: 'Hostinger',
    authKind: 'api_key',
    envVar: 'HOSTINGER_API_TOKEN',
    mcpServer: {
      command: 'npx',
      // HOSTINGER_API_TOKEN varsa OAuth akışı TAMAMEN atlanır (paket README'si) —
      // yani pane içinde tarayıcı açan bir giriş denemesi olmaz. (API_TOKEN aynı
      // paketin deprecated alias'ı; yeni adı kullanıyoruz.)
      args: ['-y', 'hostinger-api-mcp'],
      transport: 'stdio',
    },
    keyGuidance:
      'hPanel → Account → API → yeni token: mümkün olan en dar kapsam + SON KULLANMA tarihi ver. '
      + 'Token hesabın tamamına eriştiği için ayrı bir alt-hesap/erişim tercih et; '
      + 'faturalama işlemleri için ayrı token tut ve işin bitince hPanel’den iptal et.',
    // BR-03 — probe 2026-08-12, server hostinger-api-mcp@1.33.1, 314 araç (tam el
    // sıkışma). `needsScopes` HER YERDE bilerek BOŞ: yukarıdaki keyGuidance'ın
    // kendi dediği gibi bu token GRANÜLER değil, hesabın TAMAMINA erişir — sahte
    // bir izin adı yazmak yerine dürüstçe boş bırakıldı. 314 araç arasında GERÇEK
    // PARA harcayan (billing_createPurchaseOrderV1, domains_purchaseNewDomainV1)
    // ve GERİ ALINAMAZ (hosting_deleteWebsiteV1, VPS_deleteProjectV1) araçlar VAR
    // — aşağıdaki kartlar bunu ayrı satırlarda görünür tutuyor (rapora taşındı).
    capabilities: [
      { id: 'hostinger.hosting.read', label: 'Websiteleri, hosting hesaplarını ve PHP/WordPress durumunu listele', needsScopes: [], kind: 'read' },
      { id: 'hostinger.dns_domains.write', label: 'DNS kayıtlarını güncelle, domain yönlendirmesi/bağlantısı değiştir', needsScopes: [], kind: 'write' },
      { id: 'hostinger.deploy.write', label: 'Website/uygulama deploy et (statik, PHP, Node.js, WordPress eklenti/tema)', needsScopes: [], kind: 'write' },
      { id: 'hostinger.vps.write', label: "VPS / Docker Compose projelerini yönet (başlat, durdur, yeniden oluştur, SİL)", needsScopes: [], kind: 'write' },
      { id: 'hostinger.billing.write', label: 'Yeni ürün/domain SATIN AL, aboneliği yenile (gerçek ödeme yapar)', needsScopes: [], kind: 'write' },
    ],
    mask: { keepPrefix: 2, keepSuffix: 4 },
    docsUrl: 'https://developers.hostinger.com/',
  },

  coolify: {
    id: 'coolify',
    label: 'Coolify',
    authKind: 'api_key',
    envVar: 'COOLIFY_ACCESS_TOKEN',
    mcpServer: {
      command: 'npx',
      // Aday karşılaştırması (ikisi de probe'ta UP): coolify-mcp-server (633 indirme/ay,
      // 111 araç) yerine bu — 12.8k indirme/ay, 42 araç (daha az araç = daha az bağlam
      // şişmesi). COOLIFY_ACCESS_TOKEN + COOLIFY_BASE_URL okur.
      args: ['-y', '@masonator/coolify-mcp'],
      transport: 'stdio',
    },
    keyGuidance:
      'Coolify → Security → API Tokens → yeni token: "read-only" yetkisiyle başla; '
      + 'deploy gerekiyorsa yalnız ilgili takım/proje kapsamını ver, "root" token ASLA verme '
      + '(root token sunucu ekleme/silme ve API kapatma yetkisi taşır).',
    // Coolify SELF-HOSTED: instance adresi olmadan server araç çağrısında
    // "Coolify not configured" atar (probe'ta doğrulandı). Gizli değil, ama kullanıcıya özel.
    userFields: [
      { envVar: 'COOLIFY_BASE_URL', label: 'Coolify adresi', required: true, example: 'https://coolify.sirketim.com' },
    ],
    // BR-03 — probe 2026-08-12, server coolify@2.14.1, 44 araç (tam el sıkışma).
    // Coolify'ın izin modeli İKİLİ (read-only token / tam token) — GitHub gibi
    // granüler izin ADLARI yok; `needsScopes` bu ikiliği METİNLE taşır (keyGuidance
    // zaten "read-only başla" diyor), uydurma bir izin listesi değil.
    capabilities: [
      { id: 'coolify.infra.read', label: 'Sunucu/proje/ortam envanterini ve sağlık durumunu oku', needsScopes: ['read-only token yeterli'], kind: 'read' },
      { id: 'coolify.apps.read', label: 'Uygulama/servis/veritabanı listesini ve loglarını oku', needsScopes: ['read-only token yeterli'], kind: 'read' },
      { id: 'coolify.deploy.write', label: 'Uygulamayı deploy et / yeniden başlat / durdur', needsScopes: ['read-only token YETMEZ'], kind: 'write' },
      { id: 'coolify.secrets.write', label: "Ortam değişkenlerini oku/güncelle (env_vars) — DEĞERLER secret OLABİLİR", needsScopes: ['read-only token YETMEZ'], kind: 'write' },
      { id: 'coolify.access.write', label: 'SSH private key, GitHub App bağlantısı, takım/bulut token yönetimi (en yüksek yetki)', needsScopes: ['read-only token YETMEZ'], kind: 'write' },
    ],
    mask: { keepPrefix: 2, keepSuffix: 4 },
    docsUrl: 'https://coolify.io/docs/api-reference/authorization',
  },

  // ── INT-0-E — DSN SINIFININ PİLOTU ────────────────────────────────────────
  //
  // Bu giriş yalnız bir servis eklemez, `authKind:'dsn'` sınıfını AÇAR: bağlantı
  // dizesi taşıyan servisler (PostgreSQL, MySQL, MongoDB, Redis, ClickHouse)
  // API-anahtarı maskesiyle GÜVENLE saklanamaz — bir DSN'in son parçası daima
  // veritabanı adıdır, `keepSuffix` onu doğrudan ekrana yazardı (bkz. `maskDsn`).
  postgres: {
    id: 'postgres',
    label: 'PostgreSQL',
    authKind: 'dsn',
    envVar: 'POSTGRES_CONNECTION_STRING',
    mcpServer: {
      command: 'npx',
      // ADAY KARŞILAŞTIRMASI (hepsi GERÇEK probe'tan geçirildi, 2026-09-05, canlı
      // postgres:17 konteynerine karşı):
      //   • @modelcontextprotocol/server-postgres@0.6.2 — 1 araç (salt-okur `query`),
      //     EN DAR yüzey ama npm'de **DEPRECATED** ("Package no longer supported")
      //     ve DSN'i POZİSYONEL ARGV olarak alıyor → müşteriye desteklenmeyen bir
      //     paket veremeyiz.
      //   • mcp-postgres-server@0.1.3 — 6 araç, ama DSN'i env'den OKUMUYOR
      //     ("Database configuration not set" — ayrık PG* değişkenleri istiyor).
      //   • @henkey/postgres-mcp-server@1.0.7 — 18 araç, DSN'i `POSTGRES_CONNECTION_STRING`
      //     env'inden OKUR ve gerçek bir SELECT döndürdü. **SEÇİLEN.**
      //
      // 🔑 SEÇİMİN BELİRLEYİCİSİ ARAÇ SAYISI DEĞİL, SIRRIN NEREDEN GEÇTİĞİDİR:
      // diğer iki adayda bağlantı dizesi ARGV'ye yazılırdı → parola `ps` çıktısında
      // düz metin. Bir DSN'in argv'ye düşmesi bir API anahtarınınkinden ağırdır
      // (kullanıcı + parola + host + veritabanı, hepsi tek satırda).
      //
      // Sürüm PİNLİ (`@latest` DEĞİL): bu paketin 18 aracı arasında yazma ve
      // veritabanları-arası KOPYALAMA var; sessiz bir sürüm sıçraması, kullanıcının
      // onaylamadığı bir yetenek yüzeyi getirir.
      args: ['-y', '@henkey/postgres-mcp-server@1.0.7'],
      transport: 'stdio',
    },
    keyGuidance:
      'Veritabanında AJANA ÖZEL, SALT-OKUR bir rol aç ve bağlantı dizesini onunla ver: '
      + 'CREATE ROLE ajan LOGIN PASSWORD \'…\'; GRANT CONNECT ON DATABASE … TO ajan; '
      + 'GRANT USAGE ON SCHEMA public TO ajan; GRANT SELECT ON ALL TABLES IN SCHEMA public TO ajan. '
      + 'Uygulamanın kendi kullanıcısını (ya da superuser/postgres rolünü) ASLA verme: bu server '
      + 'yazma, şema değiştirme, kullanıcı yönetimi ve veritabanları-arası kopyalama araçları taşır — '
      + 'yetkiyi ROL seviyesinde kısmazsan ajan onları kullanabilir.',
    // Bağlantı dizesi kullanıcı adı + parola + host + veritabanı adını TEK dizede
    // taşır; `keepPrefix/keepSuffix` profili burada müşteri bilgisi sızdırır.
    mask: { kind: 'dsn' },
    // BR-03 emsali — probe 2026-09-05, server @henkey/postgres-mcp-server@1.0.7,
    // 18 araç (tam el sıkışma) + `pg_execute_query` ile GERÇEK bir SELECT döndü.
    // PostgreSQL'de izinler ROL bazlıdır; uydurma bir "scope" adı YOKTUR → izin
    // beyanı seçilebilir değildir (`scopesSelectable` yok, bkz. scopeOptions).
    capabilities: [
      { id: 'postgres.read', label: 'Şema/tabloları listele, tanımlarını oku ve SELECT çalıştır', needsScopes: ['SELECT yetkisi olan rol yeterli'], kind: 'read' },
      { id: 'postgres.analyze', label: 'Veritabanı sağlığını, indeksleri ve yavaş sorguları incele', needsScopes: ['SELECT yetkisi olan rol yeterli'], kind: 'read' },
      { id: 'postgres.write', label: 'INSERT/UPDATE/DELETE çalıştır ve tabloya veri aktar', needsScopes: ['salt-okur rol YETMEZ'], kind: 'write' },
      { id: 'postgres.schema.write', label: 'Şema, fonksiyon, tetikleyici, indeks, kısıt ve RLS politikalarını DEĞİŞTİR', needsScopes: ['salt-okur rol YETMEZ'], kind: 'write' },
      { id: 'postgres.admin.write', label: 'Rol/kullanıcı yönet ve veritabanları arasında veri KOPYALA (en yüksek yetki)', needsScopes: ['salt-okur rol YETMEZ'], kind: 'write' },
    ],
    docsUrl: 'https://www.postgresql.org/docs/current/sql-createrole.html',
  },

  vercel: {
    id: 'vercel',
    label: 'Vercel',
    authKind: 'api_key',
    envVar: 'VERCEL_API_KEY',
    mcpServer: {
      command: 'npx',
      // Vercel'in resmî MCP'si (mcp.vercel.com) OAuth'ludur → Dalga 1'in işi (ADP-590).
      // Dalga 0'ın "jeton + npx + tek env" sözleşmesine uyan yerel köprü bu paket.
      // Aday karşılaştırması (ikisi de probe'ta UP): vercel-platform-mcp-server
      // (276 indirme/ay, npm'de repo alanı YOK) yerine bu seçildi — 5.7k indirme/ay,
      // açık repo (github.com/MisterTK/vercel-api-mcp), 131 araç.
      args: ['-y', '@mistertk/vercel-mcp'],
      transport: 'stdio',
    },
    keyGuidance:
      'Vercel → Account Settings → Tokens: kapsamı (scope) tek takım/proje seç ve KISA bir son kullanma '
      + 'tarihi ver (ör. 30 gün). Token hesap genelinde geçerli olduğu için "Full Account" '
      + 'kapsamından kaçın; ortam değişkeni okuma araçları prod secret’larını görebilir — '
      + 'prod bağlarken bunu bilerek bağla.',
    // BR-03 — probe 2026-08-12, server vercel-mcp@1.0.0, 131 araç (tam el
    // sıkışma). Vercel token'ı TAKIM/PROJE bazında kapsanır (keyGuidance zaten
    // bunu söylüyor), GitHub tarzı granüler izin ADI yok → `needsScopes` boş;
    // env-okuma kartı ayrıca işaretli çünkü prod secret'larını görebilir.
    capabilities: [
      { id: 'vercel.deployments.read', label: 'Deployment listesini, olaylarını, loglarını ve dosyalarını oku', needsScopes: [], kind: 'read' },
      { id: 'vercel.deployments.write', label: 'Deployment iptal et veya sil', needsScopes: [], kind: 'write' },
      { id: 'vercel.projects.write', label: 'Proje ayarlarını ve domain bağlantısını güncelle/ekle/kaldır', needsScopes: [], kind: 'write' },
      { id: 'vercel.env.write', label: "Ortam değişkenlerini oku/oluştur/güncelle/sil — PROD SECRET'LARINI görebilir", needsScopes: [], kind: 'write' },
      { id: 'vercel.dns.write', label: 'DNS kayıtlarını ve domain bağlantılarını yönet', needsScopes: [], kind: 'write' },
      { id: 'vercel.security.write', label: 'Firewall / saldırı-modu ayarlarını değiştir', needsScopes: [], kind: 'write' },
    ],
    mask: { keepPrefix: 2, keepSuffix: 4 },
    docsUrl: 'https://vercel.com/docs/mcp/vercel-mcp',
  },

  netlify: {
    id: 'netlify',
    label: 'Netlify',
    authKind: 'api_key',
    // ÖLÇÜLDÜ: paket kaynağında geçen TEK Netlify env adı budur (3 kullanım) ve
    // kontrol kolu bunu doğruluyor — aynı sahte anahtar, aynı çağrı:
    //   NETLIFY_PERSONAL_ACCESS_TOKEN → "Failed to fetch API: 401"  (anahtar YUKARI gitti)
    //   NETLIFY_AUTH_TOKEN (kartın önerisi) → "NetlifyUnauthError: You're not logged in…"
    // Yani kartın adı yazılsaydı sunucu sessizce KİMLİKSİZ ayağa kalkardı: el sıkışır,
    // araçlar listelenir, her çağrı "giriş yapmamışsın" der. INT-1 raporu §2.4.
    envVar: 'NETLIFY_PERSONAL_ACCESS_TOKEN',
    mcpServer: {
      command: 'npx',
      args: ['-y', '@netlify/mcp@1.15.1'],
      transport: 'stdio',
    },
    keyGuidance:
      'Netlify → (kullanıcı ikonu) → User settings → OAuth → New access token: yalnız bu makine için ayrı bir '
      + 'Personal Access Token üret ve adını ver. 🔴 Netlify PAT’ı HESAP GENELİNDE geçerlidir — granüler bir '
      + 'kapsam (scope) seçeneği YOK: token senin eriştiğin her takımı ve projeyi görür, deploy tetikleyebilir ve '
      + 'ortam değişkenlerini okuyabilir (prod secret’ları dahil). Bu yüzden kısa ömürlü tut ve iş bitince sil.',
    // INT-1 probe 2026-09-05, netlify-mcp@1.15.1, 9 araç (tam el sıkışma).
    // Araçlar kaba taneli "services-reader/updater" meta-araçlarıdır → kart eşlemesi
    // neredeyse 1:1. `needsScopes` BOŞ: Netlify PAT'ında granüler izin adı YOK
    // (keyGuidance bunu açıkça söylüyor) — uydurma izin adı yazılmadı.
    capabilities: [
      { id: 'netlify.projects.read', label: 'Proje/site listesini, ayarlarını ve yapılandırmasını oku', needsScopes: [], kind: 'read' },
      { id: 'netlify.projects.write', label: 'Proje ayarlarını, form ve ortam değişkenlerini güncelle', needsScopes: [], kind: 'write' },
      { id: 'netlify.deploys.read', label: 'Deploy geçmişini, durumunu ve build loglarını incele', needsScopes: [], kind: 'read' },
      { id: 'netlify.deploys.write', label: 'Yeni deploy tetikle ve deploy ayarlarını değiştir', needsScopes: [], kind: 'write' },
      { id: 'netlify.team.read', label: 'Kullanıcı ve takım bilgisini, kullanım/kota durumunu oku', needsScopes: [], kind: 'read' },
      { id: 'netlify.extensions.write', label: 'Netlify eklentilerini (extension) listele, kur ve yapılandır', needsScopes: [], kind: 'write' },
    ],
    mask: { keepPrefix: 4, keepSuffix: 4 }, // `nfp_` türü görünür
    docsUrl: 'https://docs.netlify.com/welcome/build-with-ai/netlify-mcp-server/',
  },
};

module.exports = infraServices;
