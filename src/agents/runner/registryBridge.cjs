'use strict';

const engineRegistryModule = require('../engineRegistry.cjs');

let engineRegistry = engineRegistryModule;

/** Test/entegrasyon dikişi: defteri değiştir (argüman yok/`null` → varsayılan). */
function setEngineRegistry(next) {
  engineRegistry = next && typeof next.capability === 'function' ? next : engineRegistryModule;
  return engineRegistry;
}

function getEngineRegistry() {
  return engineRegistry;
}

/** Bir motorun yeteneği (kayıtsız motor / kayıtsız alan → `null`, uydurma YOK). */
function engineCapability(commandKey, key) {
  return engineRegistry.capability(commandKey, key);
}

/**
 * Bu motorun OTONOMİ beyanı (ENG-20). `engineCapability` ile AYNI enjekte edilebilir
 * defterden okunur — ikinci bir kaynak ikinci bir gerçek doğururdu.
 * AGY-03: dolaylı MCP kapısı bu beyana bakar (`level === 'full'` → `allow` basılabilir).
 */
function engineAutonomy(commandKey) {
  return typeof engineRegistry.engineAutonomy === 'function'
    ? engineRegistry.engineAutonomy(commandKey)
    : null;
}

/**
 * Bu pane'in YAPAMAYACAKLARI: `[{capability,state,reason,severity}]` (ENG-10 rozet
 * girdisi). Kaynak descriptor'ın kendisi olduğu için uygulayıcılarla SAPMASI imkânsız.
 */
function unsupportedCapabilities(commandKey) {
  return engineRegistry.unsupportedCapabilities(commandKey);
}

module.exports = {
  setEngineRegistry,
  getEngineRegistry,
  engineCapability,
  engineAutonomy,
  unsupportedCapabilities,
};
