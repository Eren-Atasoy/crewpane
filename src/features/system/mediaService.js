'use strict';

const os = require('node:os');
const path = require('node:path');
const tempImageStoreDefault = require('../../services/tempImageStore.cjs');
const attachmentStoreDefault = require('../../services/attachmentStore.cjs');
const feedbackBridgeDefault = require('../../services/feedbackBridge.cjs');

function makeAttachmentThumb(buf, nativeImage) {
  const img = nativeImage.createFromBuffer(buf);
  if (!img || img.isEmpty()) return null;
  const size = img.getSize();
  const target = size.width > 160 ? img.resize({ width: 160, quality: 'good' }) : img;
  return {
    dataUrl: `data:image/jpeg;base64,${target.toJPEG(60).toString('base64')}`,
    width: size.width,
    height: size.height,
  };
}

function makeFeedbackImage(buf, opts = {}, nativeImage) {
  const img = nativeImage.createFromBuffer(buf);
  if (!img || img.isEmpty()) return null;
  const size = img.getSize();
  const width = Math.max(64, Math.min(2000, Number(opts.width) || 160));
  const quality = Math.max(30, Math.min(90, Number(opts.quality) || 60));
  const target = size.width > width ? img.resize({ width, quality: 'good' }) : img;
  return {
    dataUrl: `data:image/jpeg;base64,${target.toJPEG(quality).toString('base64')}`,
    width: size.width,
    height: size.height,
  };
}

function resolveAgentShotDir() {
  try {
    return path.join(os.homedir(), '.agentshot', 'shots');
  } catch {
    return null;
  }
}

/**
 * Media, Temp Image & Task Attachments Core Service (Faz 3.6.17)
 */
function createMediaService(deps = {}) {
  const {
    nativeImage,
    instancePaths,
    tempImageStore = tempImageStoreDefault,
    attachmentStoreMod = attachmentStoreDefault,
    feedbackBridgeMod = feedbackBridgeDefault,
    logLine = () => {},
    getBoundAccount = () => null,
    getLogPath = () => null,
  } = deps;

  const imageStore = tempImageStore.createTempImageStore({ log: (line) => logLine(line) });

  let _attachmentStore = null;
  let _attachmentStoreRoot = null;
  let _feedbackBridge = null;

  function saveTempImage(payload) {
    return imageStore.save(payload);
  }

  function saveBrowserShot(base64, tag) {
    const res = imageStore.save({
      data: Buffer.from(String(base64 || ''), 'base64'),
      type: 'image/png',
      name: tag || 'shot',
      prefix: 'crewpane-browser',
    });
    if (res.ok) return res.path;
    logLine(`browser screenshot save failed: ${res.reason || 'unknown'}`);
    return null;
  }

  function attachmentStore() {
    const root = instancePaths.crewpaneHome();
    if (_attachmentStore && _attachmentStoreRoot === root) return _attachmentStore;
    const boundAccount = getBoundAccount();
    _attachmentStore = attachmentStoreMod.createAttachmentStore({
      root,
      deviceId: (boundAccount && boundAccount.deviceId) || null,
      makeThumb: (buf) => makeAttachmentThumb(buf, nativeImage),
      log: (line) => logLine(line),
    });
    _attachmentStoreRoot = root;
    return _attachmentStore;
  }

  function ingestTaskAttachment(payload) {
    const p = payload && typeof payload === 'object' ? payload : {};
    const store = attachmentStore();
    const out = p.path
      ? store.ingestFile({
        sourcePath: p.path,
        taskId: p.taskId,
        title: p.title,
        kind: p.kind,
        source: p.source,
        createdBy: p.createdBy,
      })
      : store.ingestBuffer({
        data: p.data,
        taskId: p.taskId,
        title: p.title,
        kind: p.kind,
        source: p.source,
        createdBy: p.createdBy,
      });
    if (!out.ok) logLine(`[attach] reddedildi (${out.reason}${out.detail ? `: ${out.detail}` : ''})`);
    return out;
  }

  function feedbackBridge() {
    if (!_feedbackBridge) {
      _feedbackBridge = feedbackBridgeMod.createFeedbackBridge({
        logPath: () => getLogPath(),
        shotsDir: resolveAgentShotDir,
        makeImage: (buf, opts) => makeFeedbackImage(buf, opts, nativeImage),
      });
    }
    return _feedbackBridge;
  }

  return {
    imageStore,
    saveTempImage,
    saveBrowserShot,
    attachmentStore,
    ingestTaskAttachment,
    feedbackBridge,
    makeAttachmentThumb: (buf) => makeAttachmentThumb(buf, nativeImage),
    makeFeedbackImage: (buf, opts) => makeFeedbackImage(buf, opts, nativeImage),
  };
}

module.exports = {
  createMediaService,
};
