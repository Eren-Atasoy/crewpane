// ADP-584 (Entegrasyon Merkezi / Dalga 0) — servis kataloğu: TEK doğruluk kaynağı.
//
// Hem Ayarlar UI'ı (ADP-587: hangi servisler var, hangi anahtar isteniyor, nasıl
// dar-yetkili üretilir) hem spawn resolver'ı (ADP-585: hangi MCP server, hangi env
// değişkeni) BURADAN okur. İki yerde ayrı liste tutmak = sessiz drift (bir servisi
// UI'da gösterip spawn'da unutmak); bu yüzden şablon tek dosyada.
//
// ADP-588 Dalga 0'ı TAMAMLADI: 8 servis (Supabase · GitHub · Sentry · Stripe ·
// PostHog · Hostinger · Coolify · Vercel). Her şablonun `mcpServer`'ı GERÇEK bir
// stdio probe'uyla (initialize + tools/list, sahte jetonla) doğrulandı — kanıt:
// docs/agent-results/ADP-588-jazz.md. Yeni servis eklerken aynı çıta geçerlidir:
// "npm'de duruyor" kanıt DEĞİL, protokolü konuşan bir handshake kanıttır.
//
// BR-03 (INT-BRIDGE-03, 2026-08-12) her girişe `capabilities` ekledi — ADR §4
// "yetenek kartı" sözleşmesi. Kaynak: TAZE bir stdio probe (initialize+tools/list,
// sahte jeton — Supabase/GitHub/Sentry/Hostinger/Coolify/Vercel el sıkışmayı
// TAMAMLADI, gerçek araç adlarıyla) + Stripe/PostHog'un OFİSYEL araç referansı
// (uzak server'a giden köprüler, sahte jetonla el sıkışma tamamlanamaz — ADP-588
// zaten aynı tespiti yapmıştı). Tam kanıt + yöntem: docs/agent-results/BR-03-capability-cards.md.
// `kind` (read/write) tool ADINDAN çıkarıldı (create/update/delete/deploy/purchase
// = write, get/list/search/query = read) — bu YÖNTEM raporda açık yazılı, gizli
// sezgi değil. `needsScopes` YALNIZ bu dosyanın kendi `keyGuidance`'ında zaten
// yazılı olan ya da servisin resmî izin-adı sözlüğünden (GitHub fine-grained PAT,
// Sentry API scope, Stripe RAK kaynak izni) gelen dizeleri taşır; Hostinger/
// Vercel/Coolify'da granüler bir izin adı YOKSA (token hesap/takım genelinde
// çalışır) dizi bilerek BOŞ bırakıldı — uydurma izin adı yazılmadı.
//
// Saf veri + saf fonksiyon: electron/node-pty/fs bağı YOK → `node --test` ile koşar.
//
// TRANSPORT SÖZLEŞMESİ (INT-0-B, 2026-09-05 — eski "TASARIM SINIRI" notunun yerine):
// agentRunner.integrationServerBlock artık `transport`'u GERÇEKTEN okuyor:
//   • `stdio` → `{command, args, env:{<envVar>: ${CREWPANE_SECRET_x}}}` (değişmedi),
//   • `http`  → `{type:'http', url, headers}` — claude'un yerel HTTP taşıması; yazıcı
//     `url`/`headers` içindeki `${<envVar>}` yer tutucusunu `${CREWPANE_SECRET_x}`
//     REFERANSINA çevirir, claude onu pane env'inden genişletir (ölçüldü: mcp_servers
//     status=connected). Tanımadığı bir yer tutucu ya da `https` olmayan bir URL
//     görürse giriş config'e HİÇ yazılmaz (fail-closed).
//   • OAuth'la korunan uzak sunucular (Linear/Notion/GitHub/Stripe remote — dördü de
//     401 + `WWW-Authenticate: … resource_metadata=…` döndürüyor) HÂLÂ KAPSAM DIŞI:
//     onların jetonu claude'un kendi kimlik deposunda yaşar, bizim kasada değil.
//     Bu bilinçli sınır ADR-INT-BRIDGE §7'de gerekçesiyle yazılı.
//   • Anahtarın YANINDA gereken GİZLİ OLMAYAN kullanıcı alanları (Coolify örnek
//     URL'i, self-hosted Sentry host'u) `userFields` ile BEYAN edilir ama henüz
//     kimse tüketmez → bkz. dosya sonundaki AÇIK İŞ notu.

'use strict';

/**
 * @typedef {object} UserField
 * @property {string} envVar   - MCP server'ın okuduğu env adı (GİZLİ DEĞİL)
 * @property {string} label    - UI etiketi
 * @property {boolean} required- boşsa server çalışmaz mı?
 * @property {string} [example]
 */

/**
 * @typedef {object} IntegrationEntry
 * @property {string} id                 - servis anahtarı (kayıtlardaki `service`)
 * @property {string} label              - UI'da görünen ad
 * @property {'api_key'|'oauth'|'dsn'} authKind - Katman B (vault) / Katman A (vault'suz /mcp)
 * @property {string|null} envVar        - MCP server'ın okuduğu env adı (oauth'ta null)
 * @property {{command?:string,args?:string[],url?:string,headers?:Object<string,string>,transport:'stdio'|'http'}} mcpServer
 *   INT-0-B: `stdio` → command+args (+ env yazıcıda üretilir) · `http` → url+headers.
 *   `headers`/`url` içinde YALNIZ `${<envVar>}` ve beyan edilen userField adları
 *   yer tutucu olabilir; başkası yazıcıda girişi DÜŞÜRÜR.
 * @property {string} keyGuidance        - DAR-YETKİLİ anahtar üretme rehberi (Kural 3) — MÜŞTERİ yüzü
 * @property {string} [keyGuidanceVendor]- BR-04 (ADR §6): yalnız VENDOR build'inde gösterilen genişletilmiş
 *                                         rehber (telemetri otomatik kurulumunun istediği ek izinler).
 *                                         Yoksa `keyGuidance` her iki yüzde de aynıdır.
 * @property {{keepPrefix:number,keepSuffix:number}} mask - maskeleme profili
 * @property {UserField[]} [userFields]  - anahtar DIŞI, kullanıcıya özel, gizli OLMAYAN ayarlar
 * @property {Capability[]} [capabilities] - BR-03: yetenek kartları (ADR §4) — probe/resmi araç listesinden
 * @property {string} [docsUrl]
 */

/**
 * @typedef {object} Capability
 * @property {string} id            - `<service>.<alan>.<fiil>` biçiminde, katalog genelinde tekil
 * @property {string} label         - ajanın kullanıcıya SÖYLEYECEĞİ somut iş tanımı
 * @property {string[]} needsScopes - scopeHint ile kıyaslanacak izin adları (granüler değilse [])
 * @property {'read'|'write'} kind
 */

/** @type {Record<string, IntegrationEntry>} */
const CATALOG = {
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

  github: {
    scopesSelectable: true, // INT-0-D — needsScopes KONKRET izin adı (seçilebilir)
    id: 'github',
    label: 'GitHub',
    authKind: 'api_key',
    envVar: 'GITHUB_PERSONAL_ACCESS_TOKEN',
    mcpServer: {
      command: 'npx',
      // NOT: bu npm paketi "deprecated" işaretli ama ÇALIŞIYOR (probe: github-mcp-server
      // 0.6.2, 26 araç). GitHub'ın bugünkü resmî yolu Go binary'si (docker/ghcr) ya da
      // OAuth'lu uzak server — ikisi de Dalga 0'ın "npx + tek env" sözleşmesine uymuyor.
      // Dalga 1'de (ADP-590, OAuth) resmî uzak server'a taşınacak.
      args: ['-y', '@modelcontextprotocol/server-github'],
      transport: 'stdio',
    },
    keyGuidance:
      'Settings → Developer settings → Fine-grained PAT: SADECE ilgili repo(lar)ı seç, '
      + 'Contents/Pull requests: Read and write, kalan izinler No access. Classic PAT (repo:*) kullanma.',
    // BR-03 — probe 2026-08-12, server github-mcp-server@0.6.2, 26 araç (tam el
    // sıkışma). `needsScopes` GitHub fine-grained PAT'in GERÇEK izin adları
    // (Settings → Developer settings ekranındaki isimler) — uydurma değil.
    // NOT (rapora taşındı): bugünkü keyGuidance yalnız Contents+Pull requests
    // öneriyor; create_issue/update_issue/add_issue_comment için PAT'a AYRICA
    // "Issues: Read and write" eklenmesi gerekir — bu satır o boşluğu ortaya çıkardı.
    capabilities: [
      { id: 'github.repos.read', label: 'Repo içeriğini, dosyaları ve commit geçmişini oku/ara', needsScopes: ['Contents: Read'], kind: 'read' },
      { id: 'github.pulls.read', label: "PR ve issue'ları listele/ara, durumlarını incele", needsScopes: ['Pull requests: Read', 'Issues: Read'], kind: 'read' },
      { id: 'github.issues.write', label: 'Issue aç/güncelle, yorum ekle', needsScopes: ['Issues: Read and write'], kind: 'write' },
      { id: 'github.pulls.write', label: 'PR aç, inceleme ekle, birleştir, branch güncelle', needsScopes: ['Pull requests: Read and write'], kind: 'write' },
      { id: 'github.repos.write', label: 'Dosya oluştur/güncelle, yeni repo/branch/fork oluştur', needsScopes: ['Contents: Read and write'], kind: 'write' },
    ],
    mask: { keepPrefix: 4, keepSuffix: 4 },
    docsUrl: 'https://github.com/settings/personal-access-tokens',
  },

  sentry: {
    id: 'sentry',
    label: 'Sentry',
    authKind: 'api_key',
    envVar: 'SENTRY_ACCESS_TOKEN',
    mcpServer: {
      command: 'npx',
      // Anahtar env'den okunur; --access-token=… BİLİNÇLİ kullanılmadı (argv `ps` ile
      // görünür → Kural 1'in ruhu). SaaS varsayılanı sentry.io; self-hosted için
      // SENTRY_HOST (userFields).
      args: ['-y', '@sentry/mcp-server@latest'],
      transport: 'stdio',
    },
    // 🔴 INT-OBS-01 — REHBER DEĞİŞTİ, GEREKÇESİYLE. Eski metin "project:write VERME"
    // diyordu ve o gün DOĞRUYDU: jetonun tek işi ajanlara okuma araçları vermekti.
    // Artık aynı jeton İKİNCİ bir iş yapıyor — kullanıcı adına PROJE AÇMAK. İki
    // kullanım da meşru olduğu için kapsam SEÇİMİ kullanıcıya AÇIKÇA bırakılır;
    // "en dar yetki" ilkesi terk edilmedi, KOŞULLU hâle getirildi.
    // Ürün bu seçimi CEZALANDIRMAZ: yazma izni olmayan jetonla da akış çalışır,
    // yalnız "projeyi ben açamam, sen aç" der (bkz. telemetryProvision Kural 6).
    // 🔴 BR-04 (ADR §6) — REHBER İKİYE AYRILDI. Yukarıdaki INT-OBS-01 gerekçesi
    // VENDOR yüzü için aynen geçerli; ama müşteriye `project:write` istemek
    // ANLAMSIZDI: o izin YALNIZ bizim telemetri projelerimizi (crewpane-prod/
    // crewpane-dev/crewpane-com) AÇMAK için gerekiyordu ve o akış müşteri
    // build'inde artık YOK (main'de kapalı, UI'da çizilmiyor). Müşteriden
    // kullanmayacağı bir YAZMA izni istemek "en dar yetki" ilkesinin ihlaliydi.
    keyGuidance:
      'Sentry → Settings → Auth Tokens (Organization Tokens). Ajanların hataları '
      + 'okuyup inceleyebilmesi için org:read, project:read, event:read, issue:read yeter. '
      + 'Hatayı çözme/atama gibi işleri de ajana yaptıracaksan event:write ekle. '
      + 'org:admin ve project:write hiçbir durumda gerekmez.',
    keyGuidanceVendor:
      'Sentry → Settings → Auth Tokens (Organization Tokens). İki kullanım var: '
      + '(1) Ajanlara yalnız OKUMA aracı vermek istiyorsan org:read, project:read, event:read, issue:read yeter. '
      + '(2) Otomatik kurulumu da istiyorsan (projeleri ürün açsın, DSN’i kendi çeksin) '
      + 'ek olarak project:write ver. Yazma izni vermezsen kurulum yine çalışır ama '
      + 'projeleri Sentry’de kendin açman gerekir. org:admin hiçbir durumda gerekmez.',
    scopesSelectable: true, // INT-0-D — needsScopes KONKRET izin adı (seçilebilir)
    userFields: [
      { envVar: 'SENTRY_HOST', label: 'Self-hosted host (opsiyonel)', required: false, example: 'sentry.sirketim.com' },
    ],
    // BR-03 — probe 2026-08-12, server "Sentry MCP"@0.37.0, 9 araç (tam el
    // sıkışma). `search_sentry_tools`/`execute_sentry_tool` bir KEŞİF ÇİFTİ:
    // server "birçok işlem BİLEREK üst-seviye araç olarak açılmıyor" diyor —
    // yani gerçek yüzey bu 9'dan GENİŞ ama alt-araçların adı/izni önceden
    // bilinmiyor; kart bunu "keşfeder" diye anar, izin adı UYDURULMADI (boş dizi).
    capabilities: [
      { id: 'sentry.issues.read', label: 'Organizasyon/proje bul, son hataları ara ve incele', needsScopes: ['org:read', 'project:read', 'event:read'], kind: 'read' },
      { id: 'sentry.issues.analyze', label: 'Seer ile hatanın kök nedenini analiz et, kod düzeltmesi öner', needsScopes: ['event:read'], kind: 'read' },
      { id: 'sentry.issues.write', label: 'Hatayı çöz/yeniden aç/ata (issue durumunu değiştir)', needsScopes: ['event:write'], kind: 'write' },
      { id: 'sentry.tools.discover', label: 'Üstteki listede olmayan ek Sentry işlemlerini arayıp çağırabilir (izni işleme göre değişir)', needsScopes: [], kind: 'read' },
    ],
    // INT-OBS-01 — bu servis "bağlandıktan SONRA kendi kendini kurabilir".
    provision: {
      kind: 'telemetry',
      title: 'Hata takibini otomatik kur',
      /** Kullanıcıya SÖZ VERDİĞİMİZ şey — sahte otomasyon olmasın diye burada yazılı. */
      does: 'Organizasyonunu bulur, crewpane-prod · crewpane-dev · crewpane-com '
        + 'projelerini (yoksa) açar, her birinin DSN’ini çeker ve kanal başına yazar.',
      /** Servisin İZİN VERDİĞİ sınır — F1 spike ölçümü (rapor: INT-OBS-01-jazz.md). */
      needs: 'org:read + project:read (zorunlu) · project:write (proje açmak için) · event:read (doğrulama okuması için)',
    },
    mask: { keepPrefix: 4, keepSuffix: 4 },
    docsUrl: 'https://docs.sentry.io/product/sentry-mcp/',
  },

  stripe: {
    id: 'stripe',
    label: 'Stripe',
    authKind: 'api_key',
    envVar: 'STRIPE_SECRET_KEY',
    mcpServer: {
      command: 'npx',
      // @stripe/mcp artık mcp.stripe.com'a giden bir STDIO köprüsü; araç izinleri
      // tamamen anahtarın (RAK) izinlerinden gelir. `--tools=…` bayrağı 0.3.x'te
      // KALDIRILDI (probe stderr'i bunu yazıyor) — eklemek uyarı üretir, iş görmez.
      args: ['-y', '@stripe/mcp'],
      transport: 'stdio',
    },
    keyGuidance:
      'Stripe → Developers → API keys → "Create restricted key" (rk_…): yalnız ihtiyacın olan '
      + 'kaynaklara READ ver (ör. Customers/Charges: Read), yazma kutularını KAPALI bırak. '
      + 'Önce TEST modunda dene (rk_test_…). Standart secret key (sk_live_…) ASLA verme — '
      + 'araç izinleri yalnız bu anahtarın kapsamıyla sınırlanır.',
    // BR-03 — probe sahte jetonla el sıkışmayı TAMAMLAYAMADI (uzak server, 401 —
    // ADP-588'in zaten ölçtüğü davranış). Kaynak: docs.stripe.com/mcp resmî araç
    // tablosu (2026-08-12 çekildi). RAK izinleri Stripe Dashboard'da KAYNAK BAZLI
    // seçilir (Customers/Charges/… her biri ayrı Read/Write anahtarı) — GitHub/
    // Sentry'deki gibi tek bir sabit izin adı YOK; bu yüzden `needsScopes` genel
    // bir kaynak-izni AÇIKLAMASI taşır, uydurma sabit liste değil.
    capabilities: [
      { id: 'stripe.data.read', label: 'Müşteri, ödeme, abonelik, fatura, bakiye verilerini oku', needsScopes: ["<Kaynak>: Read (RAK'ta seçilen kaynaklar, ör. Customers/Charges: Read)"], kind: 'read' },
      { id: 'stripe.data.write', label: "RAK'ın izin verdiği kaynaklarda yaz (müşteri/ürün/fiyat/kupon/webhook oluştur-güncelle)", needsScopes: ["<Kaynak>: Write (RAK'ta seçilen kaynaklar)"], kind: 'write' },
      { id: 'stripe.refunds.write', label: 'İade oluştur', needsScopes: ['Refunds: Write'], kind: 'write' },
      { id: 'stripe.docs.read', label: "Stripe dokümantasyonunda ara, entegrasyon adımlarını planla (Stripe verisine dokunmaz)", needsScopes: [], kind: 'read' },
      { id: 'stripe.reports.write', label: 'Rapor / rapor çalıştırması oluştur ve sonucunu getir', needsScopes: ['Reporting: Read'], kind: 'write' },
    ],
    mask: { keepPrefix: 7, keepSuffix: 4 },
    docsUrl: 'https://docs.stripe.com/mcp',
  },

  posthog: {
    scopesSelectable: true, // INT-0-D — needsScopes KONKRET izin adı (seçilebilir)
    id: 'posthog',
    label: 'PostHog',
    authKind: 'api_key',
    envVar: 'POSTHOG_PERSONAL_API_KEY',
    // INT-0-B — İLK `transport:'http'` GİRİŞİ. PostHog'un yerel stdio server'ı yok;
    // eskiden `npx mcp-remote@latest … --header Authorization:Bearer ${…}` köprüsüyle
    // gidiliyordu. Köprü çalışıyordu ama üç bedeli vardı ve üçü de ÖLÇÜLDÜ (INT-0-B §2):
    //   1. her pane için fazladan iki süreç (`npm exec` + `mcp-remote`),
    //   2. anahtar GEÇERSİZSE mcp-remote sessizce OAuth'a düşüp tarayıcıda geniş
    //      kapsamlı bir izin ekranı açıyordu — Kural 3'ün TERSİ,
    //   3. jeton mcp-remote'un KENDİ önbelleğinde (`~/.mcp-auth`) ikinci bir kimlik
    //      evi kuruyordu (ADR §5 "tek kimlik yolu" ile çatışır).
    // Yerel taşımada bunların üçü de yok: claude header'ı doğrudan pane env'inden
    // genişletir. Yer tutucu yazıcı tarafından `${CREWPANE_SECRET_<id>}`'ye çevrilir;
    // config'e DÜZ ANAHTAR yazılmaz ve ARGV diye bir yüzey zaten OLUŞMAZ.
    mcpServer: {
      transport: 'http',
      url: 'https://mcp.posthog.com/mcp',
      headers: { Authorization: 'Bearer ${POSTHOG_PERSONAL_API_KEY}' },
    },
    // 🔴 INT-OBS-01 — Sentry ile AYNI gerekçe: anahtarın ikinci bir işi var (kurulum).
    // Bölge (EU/US) SORULMAZ — anahtarın kendisi söyler (ölçüldü: yanlış bölge 401
    // döner, doğru bölge 200; `detectPostHogRegion`).
    // 🔴 BR-04 (ADR §6) — Sentry ile AYNI ayrım: `project:write` + "All organizations"
    // YALNIZ bizim telemetri projelerimizi açan vendor akışının şartıydı; müşteri
    // yüzünde o akış YOK, dolayısıyla o izinler de İSTENMEZ.
    keyGuidance:
      'PostHog → Settings → Personal API keys → yeni anahtar. Ajanların analitiği '
      + 'okuyabilmesi için "Query: Read" (+ istersen "Insight: Read") yeter; kapsamı '
      + 'yalnız ilgili projeye daralt. Feature flag yönetimini de ajana yaptıracaksan '
      + '"Feature flag: Write" ekle. Bölgeyi (AB/ABD) sormuyoruz, anahtardan buluyoruz.',
    keyGuidanceVendor:
      'PostHog → Settings → Personal API keys → yeni anahtar. İki kullanım var: '
      + '(1) Ajanlara okuma aracı vermek için "Query: Read" (+ istersen "Insight: Read") yeter. '
      + '(2) Otomatik kurulum için organization:read + project:read + project:write ver ve '
      + 'kapsamı "All organizations" bırak — yoksa ürün projeleri açamaz. '
      + 'Doğrulama okumasını da istiyorsan query:read ekle. Bölgeyi (AB/ABD) sormuyoruz, '
      + 'anahtardan buluyoruz.',
    // BR-03 — probe sahte jetonla el sıkışmayı TAMAMLAYAMADI (uzak server, OAuth
    // geri-düşüşü — bkz. yukarıdaki mcpServer notu). Kaynak: PostHog'un RESMİ araç
    // referansı, posthog.com/docs/model-context-protocol/tools.md (2026-08-12,
    // ham fetch — CURATED: sayfa 700+ araç/58 kategori listeliyor, aşağıdaki 5
    // kart yalnız en sık istenen kategorilerin TEMSİLCİSİ; tam liste ve dışarıda
    // kalanların dökümü BR-03-capability-cards.md'de). `kind` tool adının
    // ön ekinden çıkarıldı (create-/update-/delete- = write, get-/list-/query- =
    // read) — sayfa kendisi read/write etiketlemiyor, yöntem raporda açık.
    capabilities: [
      { id: 'posthog.analytics.read', label: "Ürün analitiği sorgula: insight/dashboard oku, HogQL/event sorgusu çalıştır", needsScopes: ['Query: Read', 'Insight: Read'], kind: 'read' },
      { id: 'posthog.errors.read', label: "Error tracking issue'larını sorgula ve özetle", needsScopes: ['Query: Read'], kind: 'read' },
      { id: 'posthog.feature_flags.read', label: 'Feature flag tanımlarını ve aktiflik durumunu listele', needsScopes: ['Feature flag: Read'], kind: 'read' },
      { id: 'posthog.feature_flags.write', label: 'Feature flag oluştur/güncelle/sil', needsScopes: ['Feature flag: Write'], kind: 'write' },
      { id: 'posthog.experiments.read', label: 'A/B test (experiment) sonuçlarını ve geçmişini getir', needsScopes: ['Query: Read'], kind: 'read' },
    ],
    provision: {
      kind: 'telemetry',
      title: 'Ürün analitiğini otomatik kur',
      does: 'Bölgeni bulur, organizasyonunu listeler, crewpane-prod · crewpane-dev · '
        + 'crewpane-com projelerini (yoksa) açar, yazma anahtarlarını (phc_…) çeker ve kanal başına yazar.',
      needs: 'organization:read + project:read (zorunlu) · project:write (proje açmak için) · query:read (doğrulama okuması için)',
    },
    mask: { keepPrefix: 4, keepSuffix: 4 },
    docsUrl: 'https://posthog.com/docs/model-context-protocol',
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

  // ── INT-1 (Dalga 1, 2026-09-05) — GitLab · Linear · Netlify · Resend ───────
  //
  // Dördü de bugünkü sözleşmeye ("npx + stdio + TEK env değişkeni") ön koşulsuz
  // uyuyor. Hepsi TAZE bir stdio probe'undan geçti (initialize + tools/list, SAHTE
  // jetonla) — kanıt, tam araç listeleriyle: docs/agent-results/INT-1-probe.md.
  // ADP-588 çıtası aynen: "npm'de duruyor" kanıt DEĞİL, el sıkışma kanıttır.
  //
  // 🔴 SÜRÜMLER PİNLİ (`@latest` YOK). Dalga 0'ın bazı girişleri hâlâ `@latest`
  // taşıyor; 80 servis çağında bu, kod değişmeden kırmızıya dönen bir kapı üretir
  // (sabitlenmemiş bağımlılık kapıyı kırar). Yeni girişler o borcu BÜYÜTMÜYOR.
  //
  // `keyGuidance` yolları paketlerin KENDİ README'lerinden alındı, hafızadan
  // değil — kart özetindeki iki yol ölçümde YANLIŞ çıktı (Linear "Settings → API"
  // değil "Settings → Security & access"; Netlify env adı `NETLIFY_AUTH_TOKEN`
  // değil `NETLIFY_PERSONAL_ACCESS_TOKEN`). Detay: INT-1 raporu §3.

  gitlab: {
    id: 'gitlab',
    label: 'GitLab',
    authKind: 'api_key',
    // ÖLÇÜLDÜ (build/config.js:22 — `getConfig("token", "GITLAB_PERSONAL_ACCESS_TOKEN")`):
    // sunucu env tarafında YALNIZ bu adı okur. Kart özetindeki `GITLAB_TOKEN` yalnız
    // paketin kendi test betiğinde geçer; onunla açılan sunucu el sıkışmadan ölür
    // ("GITLAB_PERSONAL_ACCESS_TOKEN environment variable is not set" — INT-1 raporu §2.4).
    // Diğer yol `--token=…` ARGV'dir ve Kural 1 onu yasaklar.
    envVar: 'GITLAB_PERSONAL_ACCESS_TOKEN',
    mcpServer: {
      command: 'npx',
      // --permission-mode=modify: Supabase'in `--read-only`'sinin GitLab karşılığı,
      // Kural 3'ün MCP tarafındaki ikinci savunma hattı. Probe'ta ÖLÇÜLDÜ:
      // full=117 araç · modify=106 · readonly=64. `modify` tam olarak 11 `delete_*`
      // aracını düşürür (issue/branch/label/not silme) ama MR açma, yorum yazma,
      // dosya push'lama gibi ASIL işi bırakır. `readonly` seçilseydi servis
      // hedef listesindeki değerinin (MR/issue akışı) yarısını kaybederdi.
      args: ['-y', '@zereight/mcp-gitlab@2.1.58', '--permission-mode=modify'],
      transport: 'stdio',
    },
    keyGuidance:
      'GitLab → Preferences → Access tokens → Add new token: SALT bu makine için ayrı bir token üret ve '
      + 'kapsamı (scope) daralt — yalnız okuma yetecekse `read_api`, MR/issue açması gerekiyorsa `api`. '
      + 'Son kullanma tarihi ver (ör. 30 gün) ve token’ı tek bir projeye (Project access token) bağlayabiliyorsan '
      + 'grup/hesap genelinde bırakma. Sunucu ayrıca `--permission-mode=modify` ile başlar: 11 silme aracı '
      + 'tools/list’ten TAMAMEN düşer, yani token `api` taşısa bile bu pane’den issue/branch SİLİNEMEZ.',
    scopesSelectable: true, // GitLab'ın resmî PAT scope adları (api / read_api / read_user)
    userFields: [
      // Self-hosted GitLab için. BOŞ bırakılırsa sunucu gitlab.com'a düşer (probe:
      // GITLAB_API_URL vermeden de 106 araçla el sıkıştı) ve boş userField env'e
      // hiç yazılmaz (agentRunner.userFieldEnv boş değeri atlar) → varsayılan korunur.
      { envVar: 'GITLAB_API_URL', label: 'API adresi (self-hosted ise)', required: false, example: 'https://gitlab.example.com/api/v4' },
    ],
    // INT-1 probe 2026-09-05, zereight-gitlab-mcp-server@2.1.58, `--permission-mode=modify`
    // ile 106 araç (tam el sıkışma). Kartlar BR-03 yöntemiyle gerçek araç adlarından.
    capabilities: [
      { id: 'gitlab.repo.read', label: 'Proje, branch, commit, dosya ve dizin ağacını oku', needsScopes: ['read_api'], kind: 'read' },
      { id: 'gitlab.merge_requests.write', label: "Merge request aç/güncelle, onayla, yorum ve tartışma yaz, MERGE ET", needsScopes: ['api'], kind: 'write' },
      { id: 'gitlab.issues.write', label: 'Issue aç/güncelle, etiket, bağlantı, not ve todo yönet', needsScopes: ['api'], kind: 'write' },
      { id: 'gitlab.repo.write', label: 'Dosya push’la, branch aç/koru, repo fork’la, commit durumu yaz', needsScopes: ['api'], kind: 'write' },
      { id: 'gitlab.ci.read', label: 'Pipeline’ları, CI lint sonucunu ve CI katalog kaynaklarını incele', needsScopes: ['read_api'], kind: 'read' },
      { id: 'gitlab.users.read', label: 'Kullanıcı, grup, namespace ve üyelik bilgisini oku', needsScopes: ['read_user'], kind: 'read' },
    ],
    mask: { keepPrefix: 6, keepSuffix: 4 }, // `glpat-` türü görünür, gövde görünmez
    docsUrl: 'https://github.com/zereight/gitlab-mcp',
  },

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

  resend: {
    id: 'resend',
    label: 'Resend',
    authKind: 'api_key',
    envVar: 'RESEND_API_KEY',
    mcpServer: {
      command: 'npx',
      // Resend'in KENDİ paketi (repo: github.com/resend/resend-mcp) — topluluk
      // sarmalayıcısı değil. Aynı kod Resend'in barındırdığı uzak sunucuyu da
      // besliyor; biz stdio yolunu kullanıyoruz (bugünkü sözleşme).
      args: ['-y', 'resend-mcp@2.19.0'],
      transport: 'stdio',
    },
    keyGuidance:
      'Resend → API Keys → Create API Key: izin olarak `sending_access` seç (yalnız e-posta gönderir) ve '
      + 'mümkünse tek bir doğrulanmış alan adına (domain) kilitle. `full_access` YALNIZCA ajanın domain/contact/'
      + 'broadcast yönetmesi gerekiyorsa gerekir — 🔴 o izinle ajan YENİ API anahtarı üretebilir ve mevcutları '
      + 'silebilir, yani kendi yetkisini genişletebilir. Ayrı bir anahtar üret, üretim anahtarını PAYLAŞMA.',
    scopesSelectable: true, // Resend'in resmî izin adları (create-api-key şemasından)
    // INT-1 probe 2026-09-05, resend@2.19.0, 103 araç (tam el sıkışma).
    // `needsScopes` adları UYDURMA DEĞİL: sunucunun kendi `create-api-key` girdi
    // şemasındaki `z.enum(['full_access','sending_access'])` — yani Resend'in resmî
    // izin sözlüğü, paketin içinden ölçüldü.
    capabilities: [
      { id: 'resend.emails.write', label: 'E-posta gönder (tekil ve toplu), planla, iptal et', needsScopes: ['sending_access'], kind: 'write' },
      { id: 'resend.emails.read', label: 'Gönderilen/gelen e-postaları, metrikleri ve logları oku', needsScopes: ['full_access'], kind: 'read' },
      { id: 'resend.domains.write', label: 'Alan adı (domain) ekle, doğrula, güncelle ve kaldır', needsScopes: ['full_access'], kind: 'write' },
      { id: 'resend.audience.write', label: 'Kişi, segment, konu ve gönderim engeli (suppression) listelerini yönet', needsScopes: ['full_access'], kind: 'write' },
      { id: 'resend.broadcasts.write', label: 'Toplu gönderim (broadcast), şablon ve otomasyon oluştur ve YAYINLA', needsScopes: ['full_access'], kind: 'write' },
      { id: 'resend.apikeys.write', label: '🔴 API anahtarı ve webhook yönetimi — YENİ anahtar üretebilir, mevcutları silebilir', needsScopes: ['full_access'], kind: 'write' },
    ],
    mask: { keepPrefix: 3, keepSuffix: 4 }, // `re_` türü görünür
    docsUrl: 'https://resend.com/docs/knowledge-base/mcp-server',
  },
  // ── INT-2 (Dalga 1.5, 2026-09-05) — Shopify · n8n · Metabase ────────────────
  //
  // Üçünün ORTAK yanı: anahtarın YANINDA gizli-olmayan bir alan istiyorlar (mağaza
  // domaini / instance adresi). INT-0-A'nın `userFields` zinciri olmasaydı üçü de
  // "bağlı görünüp patlayan" entegrasyon olurdu — bugünkü Coolify kaydı gibi
  // (kök neden ÖLÇÜLDÜ: sunucu `COOLIFY_BASE_URL` yoksa sessizce `http://localhost:3000`
  // deniyor → "fetch failed"; INT-2 raporu §2.1).
  //
  // Grafana bu dalgadan DÜŞTÜ: npm'de resmî bir MCP paketi yok (ölçüldü — `npm view`
  // `mcp-grafana` / `grafana-mcp` / `@grafana/mcp` için 404; aramada yalnız topluluk
  // sarmalayıcıları çıkıyor ve `mcp-grafana-npx` çalışma anında bir ikili indiriyor).
  // Bugünkü sözleşme "npx + stdio + resmî/yaygın paket"; gerekçe raporda §4.
  //
  // Sürümler PİNLİ, üçü de TAZE stdio probe'undan geçti (kanıt: INT-2-probe.md).

  shopify: {
    id: 'shopify',
    label: 'Shopify',
    authKind: 'api_key',
    envVar: 'SHOPIFY_ACCESS_TOKEN',
    mcpServer: {
      command: 'npx',
      args: ['-y', 'shopify-mcp@1.0.8'],
      transport: 'stdio',
    },
    // ÖLÇÜLDÜ (paket kaynağı): sunucu `SHOPIFY_ACCESS_TOKEN` + `MYSHOPIFY_DOMAIN` okur;
    // `SHOPIFY_API_VERSION` opsiyoneldir. Domain GİZLİ DEĞİL ama kullanıcıya özeldir.
    userFields: [
      { envVar: 'MYSHOPIFY_DOMAIN', label: 'Mağaza adresi', required: true, example: 'magazam.myshopify.com' },
    ],
    keyGuidance:
      'Shopify Admin → Settings → Apps and sales channels → Develop apps → Create an app → '
      + 'Configure Admin API scopes: SADECE gerekenleri işaretle (`read_products` ile başla; '
      + 'ürün düzenlemesi gerekiyorsa `write_products`). Install App → Admin API access token (`shpat_…`). '
      + '🔴 GERÇEK PARA VE GERÇEK MÜŞTERİ: `write_orders` verirsen ajan CANLI siparişi değiştirebilir '
      + '(`update-order`), `write_products` verirsen ürün SİLEBİLİR (`delete-product`) — ikisi de geri '
      + 'alınamaz. `read_customers`/`read_orders` müşteri adı, e-posta ve adresini pane\'e taşır (KVKK). '
      + 'Önce bir GELİŞTİRME mağazasında dene, üretim mağazasına salt-okuma ver.',
    scopesSelectable: true, // Shopify'ın resmî Admin API scope adları
    // INT-2 probe 2026-09-05, shopify-mcp@1.0.8, 14 araç (tam el sıkışma).
    capabilities: [
      { id: 'shopify.products.read', label: 'Ürünleri, varyantları ve stok bilgisini oku', needsScopes: ['read_products'], kind: 'read' },
      { id: 'shopify.products.write', label: 'Ürün oluştur/güncelle, varyant ve seçenekleri yönet', needsScopes: ['write_products'], kind: 'write' },
      { id: 'shopify.products.delete', label: '🔴 Ürünü ve varyantlarını SİL — geri alınamaz', needsScopes: ['write_products'], kind: 'write' },
      { id: 'shopify.customers.read', label: '🔴 Müşteri kayıtlarını ve sipariş geçmişini oku (ad, e-posta, adres — KİŞİSEL VERİ)', needsScopes: ['read_customers'], kind: 'read' },
      { id: 'shopify.orders.read', label: 'Siparişleri ve sipariş detaylarını oku', needsScopes: ['read_orders'], kind: 'read' },
      { id: 'shopify.orders.write', label: '🔴 CANLI siparişi ve müşteri kaydını güncelle — gerçek para, gerçek müşteri', needsScopes: ['write_orders', 'write_customers'], kind: 'write' },
    ],
    mask: { keepPrefix: 6, keepSuffix: 4 }, // `shpat_` türü görünür
    docsUrl: 'https://github.com/GeLi2001/shopify-mcp',
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

  // ── INT-3 (Dalga 2, 2026-09-06) — Notion · Figma ────────────────────────────
  //
  // Bu dalganın konusu "uzak/OAuth"tu; INT-0-B'nin kararı (ADR §9) OAuth korumalı
  // uzak sunucuları KAPSAM DIŞI bıraktı (jetonları claude'un kendi deposunda yaşardı,
  // §5 "tek kimlik yolu" delinirdi). Bu yüzden buraya YALNIZ statik jetonla çalışan
  // ve bugünkü sözleşmeye ön koşulsuz uyan iki servis girdi. Cloudflare · Linear-OAuth ·
  // GitHub-remote KARARA BAĞLANDI ve girmedi — gerekçeler INT-3 raporu §3-§5.

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

  // ── INT-4 (Dalga 2 devam, 2026-09-06) — Discord · Slack · fal.ai ────────────
  //
  // Kart 5 servis istiyordu: Discord, Slack, Docker, fal.ai, PostgreSQL.
  //   • PostgreSQL: INT-0-E'de ZATEN eklendi (bkz. yukarıdaki `postgres` girişi,
  //     DSN sınıfının pilotu) — bu kartta TEKRAR EKLENMEDİ, ön koşul zaten bitmişti.
  //   • Docker DÜŞTÜ (kataloğa girmedi) — gerekçe: aday paketler (`docker-mcp-server`,
  //     `@0xshariq/docker-mcp-server`) İKİ ayrı noktada bugünkü sözleşmeye uymuyor:
  //     (1) SIR TAŞIMIYORLAR — yerel Docker soketine/daemon'a bağlanıyorlar, yani
  //     `authKind`/`envVar`/vault modelinin dayandığı "bir hesap sırrı var" varsayımı
  //     yok; bağlanma adımı (Ayarlar → Entegrasyonlar → bağla) hiç karşılığı olmayan
  //     bir akış olurdu. (2) DAĞITIM ŞEKLİ `npx -y <pkg>` DEĞİL — resmî MCP config
  //     örnekleri `"command":"node","args":["/path/to/docker-mcp-server/dist/index.js"]`
  //     istiyor, yani önce repo klonlanmalı; bugünkü yazıcı yalnız katalogdan gelen
  //     sabit `args` üretir, yerel bir dosya yoluna asla referans veremez (Kural 1'in
  //     ruhu: keyfi ikili/yol çalıştırma yüzeyi açılmaz). Bu, Playwright'ın INT-1'de
  //     düşme gerekçesiyle AYNI SINIF ("sözleşme uyuşmazlığı", el sıkışma sorunu
  //     değil) — ayrıca burada host'un Docker daemon'ına (kapsayıcı başlatma/durdurma/
  //     silme, hacim bağlama = pratikte host'a kod çalıştırma) sınırsız erişim, hiçbir
  //     "anahtarı daralt" adımı OLMADAN verilmiş olurdu; bu ayrı bir ürün kararı
  //     ister (yeni bir `authKind:'none'`/yerel-araç sınıfı + güvenlik incelemesi).
  //     Rapor: docs/agent-results/INT-4-blaster.md §3.
  //
  // Discord/Slack İKİSİ DE "en çok indirilen" paket YERİNE, ÖLÇÜLMÜŞ bir kritere göre
  // seçildi — ayrıntı INT-4-probe.md.

  discord: {
    id: 'discord',
    label: 'Discord',
    authKind: 'api_key',
    // ÖLÇÜLDÜ (kaynak: dist/client.js, dist/tools/*.js — `process.env.DISCORD_TOKEN`).
    envVar: 'DISCORD_TOKEN',
    mcpServer: {
      command: 'npx',
      args: ['-y', '@pasympa/discord-mcp@2.2.0'],
      transport: 'stdio',
    },
    keyGuidance:
      'Discord Developer Portal → Applications → (uygulaman) → Bot → Reset Token: '
      + 'yalnız bu bot için üretilen token’ı kullan. Aynı sayfada YALNIZ gereken '
      + 'Privileged Gateway Intents’i aç (mesaj İÇERİĞİ okunacaksa "Message Content", '
      + 'üye listesi gerekiyorsa "Server Members" — ikisi de kapalıysa bağlantı '
      + 'reddedilir, ama açık bıraktığın HER intent botun gördüğü veriyi genişletir). '
      + 'Sonra OAuth2 → URL Generator’da botu sunucuya DAVET ederken yalnız ihtiyaç '
      + 'duyduğun izinleri işaretle (ör. View Channels, Send Messages, Read Message '
      + 'History) — "Administrator" ASLA verme, o TÜM sunucuyu (kanal silme, ban, rol '
      + 'yönetimi dahil) tek izinle açar. 🔴 Bot yalnız DAVET EDİLDİĞİ sunucuları görür — '
      + 'ek daraltma için aşağıdaki iki alanı doldurabilirsin: hangi sunucu(lar)da '
      + 'çalışsın (Allowed Guilds) ve hangi araç grupları açık olsun (Toolsets). '
      + '🔴 Kick/ban/toplu-silme gibi geri alınamaz eylemler dry-run önizlemeyle başlar '
      + '(paketin kendi güvenlik anahtarı), ama TEK kişilik kick/ban dry-run YAPMAZ.',
    scopesSelectable: true, // Discord'un resmî OAuth2 izin adları (Developer Portal'daki aynı adlar)
    // Kullanıcıya özel, GİZLİ OLMAYAN daraltma alanları — ikisi de ÖLÇÜLDÜ (davranışsal
    // kontrol kolu, INT-4-probe.md): DISCORD_MCP_TOOLSETS verilince tools/list 99'dan
    // 24'e düşüyor (discovery+messages toolset'i), yani sahte bir userField değil.
    userFields: [
      { envVar: 'DISCORD_ALLOWED_GUILDS', label: 'İzin verilen sunucu ID listesi (opsiyonel)', required: false, example: '123456789012345678' },
      { envVar: 'DISCORD_MCP_TOOLSETS', label: 'Açık araç grupları (opsiyonel, virgülle)', required: false, example: 'discovery,messages,channels' },
    ],
    // INT-4 probe 2026-09-06, "discord-mcp"@2.2.0, 99 araç (tam el sıkışma, sahte token).
    // Kart sayısı 6 (5±1 kuralı): 99 aracın tamamı yerine FONKSİYONEL alanlar
    // gruplandı (Coolify/GitLab/Linear emsaliyle aynı yöntem — INT-1/BR-03).
    capabilities: [
      { id: 'discord.server.read', label: 'Sunucu, kanal, rol, üye ve istatistik bilgisini oku; mesaj geçmişini getir ve ara', needsScopes: ['View Channels', 'Read Message History'], kind: 'read' },
      { id: 'discord.messages.write', label: 'Mesaj/embed gönder, yanıtla, düzenle, sil, thread aç, emoji tepkisi ekle-kaldır', needsScopes: ['Send Messages', 'Manage Messages'], kind: 'write' },
      { id: 'discord.channels.write', label: 'Kanal/forum/webhook oluştur, düzenle, taşı, sil; kanal izinlerini (permission overwrite) ayarla', needsScopes: ['Manage Channels', 'Manage Webhooks'], kind: 'write' },
      { id: 'discord.roles.write', label: 'Rol oluştur/güncelle/sil, üyeye rol ata veya kaldır', needsScopes: ['Manage Roles'], kind: 'write' },
      { id: 'discord.members.write', label: '🔴 Üyeyi banla/banını kaldır, at (kick), zaman aşımına al, toplu banla, inaktif üyeleri temizle (prune)', needsScopes: ['Kick Members', 'Ban Members'], kind: 'write' },
      { id: 'discord.dm.write', label: 'Doğrudan mesaj (DM) gönder, oku, düzenle, sil', needsScopes: [], kind: 'write' },
    ],
    mask: { keepPrefix: 2, keepSuffix: 4 }, // sabit bir marka öneki yok (JWT-benzeri, kullanıcıya özel)
    docsUrl: 'https://github.com/PaSympa/discord-mcp',
  },

  slack: {
    id: 'slack',
    label: 'Slack',
    authKind: 'api_key',
    // 🔴 SEÇİM GEREKÇESİ (en çok indirilen DEĞİL): `slack-mcp-server` (korotovsky,
    // ~88k indirme/ay) SAHTE jetonla el sıkışmayı TAMAMLAMIYOR — server jetonu
    // `initialize` cevabından ÖNCE Slack'in gerçek `auth.test` uç noktasına karşı
    // doğruluyor ve geçersizse `process.exit(1)` ile ölüyor (ÖLÇÜLDÜ: INT-4-probe.md
    // §Slack — "Using Bot token authentication" logu + `invalid_auth` + exit code 1).
    // ADP-588 çıtası "protokolü konuşan bir el sıkışma"dır; bu paket gerçek bir
    // kimlik OLMADAN o çıtayı hiç geçemiyor, yani BU turda kanıtlanamadı. Paket ayrıca
    // "stealth mode" adıyla xoxc/xoxd TARAYICI OTURUM çerezleriyle çalışabiliyor —
    // bu, Slack'in KENDİ izin/scope modelini tamamen atlayan bir mekanizma ve
    // Kural 3'ün (dar-yetkili anahtar) ruhuyla ÇATIŞIYOR. Bunun yerine Anthropic'in
    // MIT lisanslı referans sunucusunun (arşivlenmiş, `@modelcontextprotocol/server-slack`
    // npm'de DEPRECATED — INT-0-E'nin `@modelcontextprotocol/server-postgres`'i
    // reddetme gerekçesiyle AYNI) aktif bir devamı seçildi: `@zencoderai/slack-mcp-server`.
    // SAHTE jetonla TAM el sıkışma verdi (8 araç) ve yalnız standart Bot OAuth token
    // (xoxb-) kabul ediyor — tarayıcı oturumu bypass'ı YOK.
    envVar: 'SLACK_BOT_TOKEN',
    mcpServer: {
      command: 'npx',
      args: ['-y', '@zencoderai/slack-mcp-server@0.0.1'],
      transport: 'stdio',
    },
    keyGuidance:
      'Slack → api.slack.com/apps → Create New App → From scratch: uygulamayı YALNIZ '
      + 'ilgili workspace için oluştur. OAuth & Permissions → Scopes → Bot Token Scopes\'a '
      + 'YALNIZ şunları ekle: channels:history, channels:read, chat:write, reactions:write, '
      + 'users:read, users.profile:read — daha fazlası gerekmiyorsa ekleme. "Install to '
      + 'Workspace" sonrası "Bot User OAuth Token"ı (xoxb- ile başlar) kopyala. '
      + '🔴 EN GÜÇLÜ DARALTMA İZİN ADI DEĞİL, DAVETTİR: bot yalnız EKLENDİĞİ (davet '
      + 'edildiği) kanalları görür — Notion\'daki sayfa paylaşımıyla aynı mantık. Botu '
      + 'yalnız gerçekten gerekli kanallara davet et, workspace geneline ekleme. '
      + 'Workspace ID\'yi (T ile başlar) aşağıdaki alana gir — token bu ID olmadan hiç '
      + 'başlamaz. 🔴 Bu paket topluluk paketidir (Anthropic\'in orijinal, artık '
      + 'DEPRECATED işaretli referans sunucusundan türetildi); "stealth mode" / '
      + 'tarayıcı-çerezi jetonu (xoxc/xoxd) sunan ALTERNATİF bir Slack paketi VARDIR ama '
      + 'BİLEREK seçilmedi — o mod Slack\'in kendi izin ekranını tamamen atlar.',
    scopesSelectable: true, // Slack'in resmî OAuth Bot Token Scope adları (api.slack.com/scopes)
    userFields: [
      { envVar: 'SLACK_TEAM_ID', label: 'Workspace/Team ID', required: true, example: 'T0123ABCD' },
      { envVar: 'SLACK_CHANNEL_IDS', label: 'Ön tanımlı kanal ID listesi (opsiyonel)', required: false, example: 'C0123ABCD,C0456EFGH' },
    ],
    // INT-4 probe 2026-09-06, "Slack MCP Server"@1.0.0 (paket 0.0.1), 8 araç (tam el
    // sıkışma, sahte jeton + sahte team id). Kart sayısı 4 — sunucunun aracı zaten az,
    // uydurma kart eklenmedi (Figma emsali).
    capabilities: [
      { id: 'slack.channels.read', label: 'Kanal listesini ve kanal/thread geçmişini oku (yalnız botun davet edildiği kanallar)', needsScopes: ['channels:read', 'channels:history'], kind: 'read' },
      { id: 'slack.messages.write', label: 'Kanala mesaj gönder, bir thread\'e yanıt yaz', needsScopes: ['chat:write'], kind: 'write' },
      { id: 'slack.reactions.write', label: 'Bir mesaja emoji tepkisi ekle', needsScopes: ['reactions:write'], kind: 'write' },
      { id: 'slack.users.read', label: 'Workspace kullanıcı listesini ve profil bilgisini oku', needsScopes: ['users:read', 'users.profile:read'], kind: 'read' },
    ],
    mask: { keepPrefix: 5, keepSuffix: 4 }, // `xoxb-` türü görünür
    docsUrl: 'https://github.com/zencoderai/slack-mcp-server',
  },

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

};

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
const EXTERNAL_KEY_STORE = 'settings';

CATALOG.elevenlabs = {
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
};

const DEFAULT_MASK = { keepPrefix: 2, keepSuffix: 4 };

/**
 * INT-0-E — KASADA SIR TAŞIYAN authKind'ler (Katman B). `oauth` burada YOKTUR:
 * onun jetonu CLI'nın kendi deposunda yaşar, vault'ta yalnız "bağlı" kaydı durur.
 * Hüküm TEK EVDE: kasa, resolver, durum cevabı ve IPC aynı listeyi sorar — bir
 * kopya bırakılsaydı yeni bir sınıf (dsn) eklenirken katmanlardan biri sessizce
 * "bu kayıt yok" der ve servis "bağlı ama araçsız" görünürdü.
 */
const SECRET_AUTH_KINDS = Object.freeze(['api_key', 'dsn']);

/** @param {string} authKind */
function carriesSecret(authKind) {
  return SECRET_AUTH_KINDS.includes(authKind);
}

/** Anahtarı BAŞKA bir yüzeyin yönettiği servisler (vault'a yazılamaz). */
function isExternallyManaged(service) {
  const entry = get(service);
  return !!(entry && entry.keyStore === EXTERNAL_KEY_STORE);
}

/** Katalog girişi (bilinmeyen servis → null; çağıran karar verir, biz uydurmayız). */
function get(service) {
  if (typeof service !== 'string') return null;
  return Object.prototype.hasOwnProperty.call(CATALOG, service) ? CATALOG[service] : null;
}

/** Tüm girişler — UI listesi için (dizi, id sırasında deterministik). */
function list() {
  return Object.keys(CATALOG).sort().map((k) => CATALOG[k]);
}

function has(service) {
  return get(service) !== null;
}

/**
 * Maskeleme — UI/log/transcript'te secret'ın YERİNE geçen tek gösterim.
 * Kısa secret'ta baş/son parçalar çakışırsa TAMAMEN maskelenir (sızdırmaktansa
 * hiçbir şey gösterme). Dönüş asla ham secret'ı içermez.
 */
/**
 * INT-0-E — BAĞLANTI DİZESİ (DSN) MASKESİ.
 *
 * `{keepPrefix, keepSuffix}` profili bir API anahtarı için doğrudur ama bir DSN'de
 * YIKICIDIR: bir DSN'in SON parçası daima yol/veritabanı bölgesidir, yani
 * `keepSuffix` doğrudan MÜŞTERİ BİLGİSİ gösterir (ölçüldü: `postgres://root:toor@
 * localhost/app` → `po••••/app`). Bu profil bunun yerine dizeyi AYRIŞTIRIR ve
 * yalnız iki şeyi bırakır: ŞEMA (kullanıcı ne tür bağlantı olduğunu bilmeli) ve
 * host'un SON İKİ ETİKETİ (sağlayıcı: `supabase.co`, `mongodb.net`).
 *
 * Gizlenen: kullanıcı adı · parola · port · veritabanı adı · query string ·
 * host'un kiracı/proje etiketleri · IP adresinin tamamı.
 *
 * AYRIŞTIRILAMAYAN dize TAMAMEN maskelenir — `maskSecret`in "sızdırmaktansa hiçbir
 * şey gösterme" duruşu (kısa secret dalı) burada da geçerlidir. libpq'nun
 * `host=… user=…` anahtar-değer biçimi ve unix-socket varyantları bu dala düşer:
 * ayrıştırmayı zorlamak, yanlış ayrıştırıp parolayı "host" sanmak demek olurdu.
 */
function maskDsn(secret) {
  let u;
  try {
    u = new URL(secret);
  } catch {
    return '••••';
  }
  if (!u.protocol || !u.hostname) return '••••';
  const scheme = u.protocol.replace(/:$/, '');
  if (!/^[a-z][a-z0-9+.-]*$/i.test(scheme)) return '••••';

  // Host: IP ise TAMAMEN gizle (bir IP doğrudan kimliktir). Alan adında yalnız son
  // iki etiket kalır → sağlayıcı tanınır, kiracı/proje tanınmaz.
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const isIp = /^[0-9.]+$/.test(host) || host.includes(':');
  let shownHost;
  if (isIp) shownHost = '••••';
  else {
    const labels = host.split('.').filter(Boolean);
    shownHost = labels.length > 2 ? `••••.${labels.slice(-2).join('.')}` : host;
  }
  return `${scheme}://••••@${shownHost}/••••`;
}

function maskSecret(secret, service) {
  if (typeof secret !== 'string' || secret.length === 0) return '';
  const spec = (get(service) || {}).mask || DEFAULT_MASK;
  if (spec.kind === 'dsn') return maskDsn(secret);
  const keepPrefix = Math.max(0, spec.keepPrefix | 0);
  const keepSuffix = Math.max(0, spec.keepSuffix | 0);
  // 4 karakterlik güvenlik payı: baş+son, secret'ın tamamını ele vermemeli.
  if (secret.length < keepPrefix + keepSuffix + 4) return '••••';
  return `${secret.slice(0, keepPrefix)}••••${secret.slice(-keepSuffix)}`;
}

/**
 * Bir servisin anahtar DIŞI, kullanıcıya özel ayarları (gizli DEĞİL).
 * AÇIK İŞ (ADP-588 raporu): bugün bunu kimse tüketmiyor — ADP-587 (UI) bu alanları
 * sormalı, ADP-585 (ensureIntegrationsMcpConfig) server'ın env bloğuna eklemeli.
 * O olana kadar `required:true` alanı olan servis (Coolify) araç çağrısında
 * "not configured" der; sunucusu yine ayağa kalkar.
 */
function userFields(service) {
  const entry = get(service);
  return entry && Array.isArray(entry.userFields) ? entry.userFields : [];
}

/**
 * INT-0-D — kullanıcının BEYAN edebileceği izinlerin SEÇİLEBİLİR listesi.
 *
 * Kaynak TEK ve zaten var: `capabilities[].needsScopes` (BR-03 probe'unda gerçek
 * servis dokümanından yazıldı). Burada YENİ izin adı ÜRETİLMEZ — yalnız yazılı
 * olanlar tekilleştirilir. Serbest metin beyanı işe yaramıyordu: `needsScopes` ile
 * kıyaslanamayan bir beyan, ajanın "bu anahtar bu işi taşır mı" sorusunu yanıtlamaz.
 *
 * `scopesSelectable` BAYRAĞI NEDEN VAR: her `needsScopes` bir izin ADI değildir.
 * Coolify'ınki düzyazıdır ("read-only token yeterli" — o servisin granüler izni YOK,
 * modeli ikili), Stripe'ınki şablondur ("<Kaynak>: Read (RAK'ta seçilen kaynaklar)").
 * Bunları seçenek diye sunmak kullanıcıya OLMAYAN bir izin adı seçtirirdi. Bayrak
 * metin sezgisiyle DEĞİL, katalog yazarının beyanıyla belirlenir (bir gün Coolify
 * granüler izne geçerse tek satır eklenir).
 */
function scopeOptions(service) {
  const entry = get(service);
  if (!entry || entry.scopesSelectable !== true) return [];
  const out = [];
  for (const cap of Array.isArray(entry.capabilities) ? entry.capabilities : []) {
    for (const scope of Array.isArray(cap.needsScopes) ? cap.needsScopes : []) {
      if (typeof scope === 'string' && scope && !out.includes(scope)) out.push(scope);
    }
  }
  return out;
}

/** `required:true` userField'ı olan servisler — UI "eksik ayar" rozeti için. */
function requiresUserFields(service) {
  return userFields(service).some((f) => f.required === true);
}

/**
 * BR-04 (ADR §6) — anahtar rehberinin HANGİ yüzü gösterilecek.
 *
 * MÜŞTERİ varsayılandır: `keyGuidance` her zaman müşterinin göreceği, telemetri
 * kurulumundan hiç söz etmeyen dar-yetki metnidir. Vendor genişletmesi AYRI bir
 * alandır (`keyGuidanceVendor`) ve YALNIZ açıkça `{vendor:true}` denince döner.
 *
 * 🔴 Yön BİLEREK böyle: bayrak okunamazsa/unutulursa düşülecek yer MÜŞTERİ
 * metnidir. Ters kurulumda (vendor varsayılan + müşteride kırp) bir hata,
 * müşteriye bizim iç akışımızı gösterirdi — sessiz sızıntı. Burada aynı hata
 * yalnız bize eksik bir cümle gösterir.
 *
 * @param {object|string} entryOrService
 * @param {{vendor?: boolean}} [opts]
 * @returns {string|null}
 */
function guidanceFor(entryOrService, opts = {}) {
  const entry = typeof entryOrService === 'string' ? get(entryOrService) : entryOrService;
  if (!entry) return null;
  if (opts.vendor === true && typeof entry.keyGuidanceVendor === 'string' && entry.keyGuidanceVendor) {
    return entry.keyGuidanceVendor;
  }
  return typeof entry.keyGuidance === 'string' ? entry.keyGuidance : null;
}

/**
 * BR-04 — bu servis VENDOR-İÇİ bir kurulum akışı taşıyor mu (telemetri
 * provisioning)? Müşteri build'inde bu akışın yüzeyi HİÇ çizilmez, IPC kapısı
 * main'de kapanır. Tek kaynak: girişin kendi `provision.kind` alanı — servis ADI
 * ile karar veren bir liste (if service==='sentry') AÇILMADI.
 */
function isVendorOnlyProvision(service) {
  const entry = typeof service === 'string' ? get(service) : service;
  return !!(entry && entry.provision && entry.provision.kind === 'telemetry');
}

module.exports = {
  CATALOG, DEFAULT_MASK, EXTERNAL_KEY_STORE, SECRET_AUTH_KINDS, carriesSecret,
  get, list, has, maskSecret, maskDsn, userFields,
  requiresUserFields, scopeOptions, isExternallyManaged, guidanceFor, isVendorOnlyProvision,
};
