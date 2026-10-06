'use strict';

const { BrowserWindow } = require('electron');

/**
 * File IPC Handlers (Faz 3.5 — Sıra 1)
 * Channels: file:read, file:write, file:list, file:openDialog, file:allowPaneRoot,
 *           file:editorState:get, file:editorState:set
 */
function registerFileIpc({
  ipcMain,
  readWorkspaceFile,
  writeWorkspaceFile,
  listWorkspaceDir,
  openFolderDialog,
  allowPaneRoot,
  readEditorState,
  writeEditorState,
}) {
  ipcMain.handle('file:read', (_event, p) => readWorkspaceFile(p));
  ipcMain.handle('file:write', (_event, payload) => writeWorkspaceFile(payload));
  ipcMain.handle('file:list', (_event, dir) => listWorkspaceDir(dir));
  ipcMain.handle('file:openDialog', (event) =>
    openFolderDialog(BrowserWindow.fromWebContents(event.sender)));
  ipcMain.handle('file:allowPaneRoot', (_event, paneId) => allowPaneRoot(paneId));
  ipcMain.on('file:editorState:get', (event) => { event.returnValue = readEditorState(); });
  ipcMain.handle('file:editorState:set', (_event, state) => writeEditorState(state));
}

module.exports = { registerFileIpc };
