const { app, BrowserWindow, protocol } = require('electron');
const path = require('node:path');

// Isolated test app: it never opens an Obsidian Vault or the user's app profile.
app.setPath('userData', path.resolve('target/local-embedding-electron-profile'));
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

app.whenReady().then(async () => {
  const port = Number(process.env.PRISM_TEST_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid fixture port.');
  protocol.handle('app', async (request) => {
    const url = new URL(request.url);
    if (url.host !== 'obsidian.md') return new Response('', { status: 400 });
    return fetch(`http://127.0.0.1:${port}${url.pathname}`);
  });
  const window = new BrowserWindow({
    show: false,
    webPreferences: { nodeIntegration: true, nodeIntegrationInWorker: true, contextIsolation: false },
  });
  await window.loadURL('app://obsidian.md/');
});
