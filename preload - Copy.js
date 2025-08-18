// ===============================
// Save this second part as: preload.js
// ===============================
// Exposes safe bridge with BOTH camelCase and kebab‑case channels for back‑compat

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // DB
  pickAccessFile:      () => ipcRenderer.invoke('pickAccessFile'),
  getSavedDbPath:      () => ipcRenderer.invoke('getSavedDbPath'),
  fetchMembers:        () => ipcRenderer.invoke('fetchMembers'),

  // Exports folder
  getExportsDir:       () => ipcRenderer.invoke('getExportsDir'),
  setExportsDir:       (folder) => ipcRenderer.invoke('setExportsDir', folder),
  pickExportsDir:      () => ipcRenderer.invoke('pickExportsDir'),
  pickSaveFolder:      () => ipcRenderer.invoke('pickExportsDir'), // extra alias used by some builds

  // QR codes
  exportQrPngs:        (rows) => ipcRenderer.invoke('exportQrPngs', rows),

  // Check-ins
  appendCheckin:       (row) => ipcRenderer.invoke('appendCheckin', row),

  // Emailing / finalisation
  sendMemberEmail:     (payload) => ipcRenderer.invoke('sendMemberEmail', payload),
  emailAttendance:     (payload) => ipcRenderer.invoke('email-attendance', payload), // legacy path (calls finalize)
  finalizeParticipation:(payload) => ipcRenderer.invoke('finalize-participation', payload),

  // Misc
  setFullScreen:       (on) => ipcRenderer.invoke('setFullScreen', on),
  ping:                () => ipcRenderer.invoke('ping')
});

// Also expose kebab‑case bridges for very old renderers that call window.electronAPI.invoke directly
contextBridge.exposeInMainWorld('electronAPICompat', {
  'get-exports-dir':   () => ipcRenderer.invoke('get-exports-dir'),
  'set-exports-dir':   (folder) => ipcRenderer.invoke('set-exports-dir', folder),
  'pick-exports-dir':  () => ipcRenderer.invoke('pick-exports-dir'),
  'send-member-email': (payload) => ipcRenderer.invoke('send-member-email', payload)
});
