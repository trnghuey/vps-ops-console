const { app, BrowserWindow, dialog, ipcMain } = require('electron');
const http = require('http');
const net = require('net');
const path = require('path');
const fs = require('fs');
const { autoUpdater } = require('electron-updater');

let mainWindow;
let serverInstance;
let appPort = 0;

function findFreePort(start = 18080) {
  return new Promise((resolve, reject) => {
    const tryPort = (port) => {
      const tester = net.createServer();
      tester.once('error', () => tryPort(port + 1));
      tester.once('listening', () => {
        tester.close(() => resolve(port));
      });
      tester.listen(port, '127.0.0.1');
    };
    tryPort(start);
  });
}

function waitForServer(url, timeoutMs = 15000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const attempt = () => {
      http.get(url, (res) => {
        res.resume();
        resolve();
      }).on('error', () => {
        if (Date.now() - started > timeoutMs) {
          reject(new Error('Server start timeout'));
          return;
        }
        setTimeout(attempt, 500);
      });
    };
    attempt();
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 1100,
    minHeight: 760,
    backgroundColor: '#0b1220',
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.loadURL(`http://127.0.0.1:${appPort}`);
}


ipcMain.handle('dialog:pick-ssh-key', async () => {
  if (!mainWindow) return { canceled: true };
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Ch?n SSH private key',
    properties: ['openFile'],
    filters: [
      { name: 'SSH key', extensions: ['pem', 'ppk', 'key'] },
      { name: 'All files', extensions: ['*'] }
    ]
  });
  if (result.canceled || !result.filePaths?.length) return { canceled: true };
  return { canceled: false, path: result.filePaths[0] };
});
function readUpdateConfig() {
  const candidates = [
    process.env.VPS_OPS_UPDATE_URL,
    path.join(app.getPath('userData'), 'update-config.json'),
    path.join(process.resourcesPath, 'update-config.json'),
    path.join(__dirname, 'update-config.json')
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      if (candidate.startsWith && /^https?:/i.test(candidate)) {
        return { updateUrl: candidate };
      }
      if (fs.existsSync(candidate)) {
        const parsed = JSON.parse(fs.readFileSync(candidate, 'utf8'));
        if (parsed.updateUrl || parsed.provider === 'github') {
          return parsed;
        }
      }
    } catch {}
  }

  return null;
}

function resolveUpdateFeed(config) {
  if (!config) return null;
  if (config.provider === 'github' && config.owner && config.repo) {
    return {
      provider: 'github',
      owner: config.owner,
      repo: config.repo,
      private: !!config.private,
      releaseType: config.releaseType || 'release'
    };
  }
  if (config.updateUrl && !/example\.com/.test(config.updateUrl)) {
    return { provider: 'generic', url: config.updateUrl };
  }
  return null;
}

function setupAutoUpdater() {
  if (!app.isPackaged) return;
  const config = readUpdateConfig();
  const feed = resolveUpdateFeed(config);
  if (!feed) return;

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.setFeedURL(feed);

  autoUpdater.on('error', (error) => {
    dialog.showMessageBox({ type: 'error', title: 'Update Error', message: `Không th? check update: ${error.message}` }).catch(() => {});
  });

  autoUpdater.on('update-available', async (info) => {
    const result = await dialog.showMessageBox({ type: 'info', buttons: ['T?i update', 'B? qua'], defaultId: 0, cancelId: 1, title: 'Có b?n c?p nh?t m?i', message: `Ðã có b?n m?i ${info.version}. B?n mu?n t?i ngay không?` });
    if (result.response === 0) autoUpdater.downloadUpdate();
  });

  autoUpdater.on('download-progress', (progress) => {
    if (mainWindow) mainWindow.setProgressBar(Math.max(0, Math.min(1, progress.percent / 100)));
  });

  autoUpdater.on('update-downloaded', async () => {
    if (mainWindow) mainWindow.setProgressBar(-1);
    const result = await dialog.showMessageBox({ type: 'info', buttons: ['Cài và kh?i d?ng l?i', 'Ð? sau'], defaultId: 0, cancelId: 1, title: 'Update dã t?i xong', message: 'B?n c?p nh?t dã t?i xong. Cài ngay bây gi??' });
    if (result.response === 0) autoUpdater.quitAndInstall();
  });

  setTimeout(() => autoUpdater.checkForUpdates().catch(() => {}), 4000);
}

async function boot() {
  process.env.VPS_OPS_DATA_DIR = path.join(app.getPath('userData'), 'runtime');
  const { startServer } = require('./server');
  appPort = await findFreePort(18080);
  serverInstance = await startServer(appPort);
  await waitForServer(`http://127.0.0.1:${appPort}`);
}

app.whenReady().then(async () => {
  try {
    await boot();
  } catch (error) {
    console.error(error);
    dialog.showErrorBox('Startup Error', error.message || 'Unknown startup error');
  }
  createWindow();
  setupAutoUpdater();

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', function () {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  try { serverInstance?.close(); } catch {}
});

