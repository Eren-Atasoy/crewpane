'use strict';

/** @type {Record<string, import('../index.cjs').IntegrationEntry>} */
const commServices = {
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
};

module.exports = commServices;
