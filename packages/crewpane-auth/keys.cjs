// ADP-383 (wheeljack) — gömülü lisans PUBLIC key'leri (kid → SPKI PEM), ADR-027 §4
//
// PUBLIC key repoya girebilir (sır değil). PRIVATE key ASLA repoya girmez —
// yalnız Edge Function secret'ı (LICENSE_SIGNING_KEY_B64; local dev:
// crewpane-id/supabase/functions/.env, gitignored).
//
// Rotasyon: yeni kid + yeni public key buraya EKLENİR (eski silinmez), Edge
// Function secret'ı yeni private key'e çevrilir; eski jetonlar exp+grace boyunca
// eski kid ile doğrulanmaya devam eder. App aynı anda 2 anahtar taşır (ADR-027).
//
// 'crewpane-dev-2026-07' = LOCAL DEV anahtarı.
// 'prod-2026-07' = PROD anahtarı — ADP-560; private key yalnız prod Edge Function secret'ında.
//
// TODO(F-013): Bu iki public key'in PRIVATE karşılıkları CrewPane'in elinde DEĞİL. Satıştan
// önce yeni bir ES256 anahtar çifti üretilip yeni kid ile buraya eklenmeli ve lisans imzalayan
// Edge Function (repo'da henüz yok) CrewPane'in Supabase projesine kurulmalı.

'use strict';

const LICENSE_PUBLIC_KEYS = {
  'crewpane-dev-2026-07': `-----BEGIN PUBLIC KEY-----
MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEF3ZEkYtUzVjOffY4XuyUHULi6pN2
7H7VmUOBIvdaEYWARpFLMghVd4JwGgfWxqsREjUHpUEIxGEmlBryltpKIg==
-----END PUBLIC KEY-----
`,
  'prod-2026-07': `-----BEGIN PUBLIC KEY-----
MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEo2B2NGohaEYFK4ENgtkz3Wj4lpzt
8n51Tyy5c5UZX6xnPTFaMixkOdZHBmtBi6zgc/os5E4F/71sZNx/1IXl+w==
-----END PUBLIC KEY-----
`,
};

module.exports = { LICENSE_PUBLIC_KEYS };
