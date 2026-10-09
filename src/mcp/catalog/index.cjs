'use strict';

/**
 * ADP-584 (Entegrasyon Merkezi / Dalga 0) — servis kataloğu: TEK doğruluk kaynağı.
 *
 * Hem Ayarlar UI'ı (ADP-587: hangi servisler var, hangi anahtar isteniyor, nasıl
 * dar-yetkili üretilir) hem spawn resolver'ı (ADP-585: hangi MCP server, hangi env
 * değişkeni) BURADAN okur. İki yerde ayrı liste tutmak = sessiz drift (bir servisi
 * UI'da gösterip spawn'da unutmak); bu yüzden şablon tek dosyada.
 */

const { CATALOG } = require('./services/index.cjs');
const { DEFAULT_MASK, EXTERNAL_KEY_STORE, SECRET_AUTH_KINDS } = require('./constants.cjs');
const {
  carriesSecret,
  isExternallyManaged,
  get,
  list,
  has,
  userFields,
  requiresUserFields,
  scopeOptions,
  guidanceFor,
  isVendorOnlyProvision,
} = require('./helpers.cjs');
const { maskSecret, maskDsn } = require('./masking.cjs');

module.exports = {
  CATALOG,
  DEFAULT_MASK,
  EXTERNAL_KEY_STORE,
  SECRET_AUTH_KINDS,
  carriesSecret,
  get,
  list,
  has,
  maskSecret,
  maskDsn,
  userFields,
  requiresUserFields,
  scopeOptions,
  isExternallyManaged,
  guidanceFor,
  isVendorOnlyProvision,
};
