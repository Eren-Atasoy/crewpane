'use strict';

const credentialGate = require('../../security/requireCredential.cjs');

/** Parse a dotenv-style file body → { KEY: value }. Strips quotes + comments. */
const parseEnvFile = credentialGate.parseEnvFile;

/**
 * DEV-ONLY `.env.local` görünümü. Prod/test instance'ta `{}` döner (kapı kapalı) —
 * eskiden burada olan "her koşulda oku" davranışı fatura riskiydi.
 */
function loadEnvLocal(rootDir) {
  return credentialGate.devEnvLocal(rootDir);
}

/**
 * Jarvis'in OpenAI anahtarı — KULLANICININ kendi anahtarı (vault/Ayarlar), dev'de
 * ek olarak `.env.local`. Anahtar yoksa '' döner; çağıran (transcribeWhisper /
 * speakOpenAI) NET bir `no-openai-key` hatası üretir (sessiz başarısızlık yok).
 */
function openAiKey(rootDir) {
  const r = credentialGate.resolveCredential('openai', { rootDir });
  return r.ok ? r.secret : '';
}

/** Anahtar yokken kullanıcıya gösterilecek metin (Ayarlar'a yönlendirir). */
function openAiKeyMissingMessage() {
  return credentialGate.missingMessageFor('openai');
}

/**
 * ADP-749 — metnin MAKİNE ikizi: "Ayarlar'ı aç" düğmesinin gideceği {category, field}.
 * Renderer kendi kategori adını UYDURMAZ (eski hata: hardcoded 'engines' → OpenAI
 * alanı olmayan sekme). Kaynak requireCredential.cjs SERVICES kaydı.
 */
function openAiKeySettingsTarget() {
  return credentialGate.settingsTargetFor('openai');
}

module.exports = {
  parseEnvFile,
  loadEnvLocal,
  openAiKey,
  openAiKeyMissingMessage,
  openAiKeySettingsTarget,
};
