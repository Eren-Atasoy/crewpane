'use strict';

/** @type {Record<string, import('../index.cjs').IntegrationEntry>} */
const devServices = {
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
};

module.exports = devServices;
