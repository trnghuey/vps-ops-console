const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktopAPI', {
  pickSshKey: () => ipcRenderer.invoke('dialog:pick-ssh-key')
});
