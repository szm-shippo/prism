// Isolated Electron host for the #99 benchmark. It never opens an Obsidian Vault or a personal profile:
// userData is a disposable directory, only an explicit allowlist of local files is served, every non-local
// Chromium request is cancelled and recorded, and Node networking is blocked in the main process and renderer.
const { app, BrowserWindow, protocol, session } = require('electron');
const { readFile } = require('node:fs/promises');
const path = require('node:path');
const installNodeNetworkGuard = require('./node-network-guard.cjs');

const profile = process.env.PRISM_FMB_PROFILE;
const served = JSON.parse(process.env.PRISM_FMB_FILES ?? '{}');
if (!profile || !path.isAbsolute(profile)) throw new Error('PRISM_FMB_PROFILE must be an absolute disposable directory.');
if (Object.values(served).some((file) => typeof file !== 'string' || !path.isAbsolute(file))) {
  throw new Error('PRISM_FMB_FILES must map asset names to absolute paths.');
}

globalThis.prismNetwork = [];
globalThis.prismNodeNetwork = [];
globalThis.prismMonitors = { mainNodeGuard: installNodeNetworkGuard(require, 'main', (entry) => globalThis.prismNodeNetwork.push(entry)),
  chromiumWebRequest: false };
/** Attempts one Node connection to a non-resolvable synthetic host; the guard must refuse and record it. */
globalThis.prismProbeMainNetwork = (host) => {
  try {
    require('node:net').connect(443, host).destroy();
    return { refused: false };
  } catch (error) {
    return { refused: true, error: error.message };
  }
};

app.setPath('userData', profile);
app.commandLine.appendSwitch('js-flags', '--expose-gc');
app.commandLine.appendSwitch('host-resolver-rules', 'MAP * ~NOTFOUND');
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

const LOCAL = /^(app:\/\/obsidian\.md\/|blob:|data:|devtools:)/;

app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    const allowed = LOCAL.test(details.url);
    globalThis.prismNetwork.push({ url: details.url, method: details.method, resourceType: details.resourceType, allowed });
    callback({ cancel: !allowed });
  });
  globalThis.prismMonitors.chromiumWebRequest = true;
  protocol.handle('app', async (request) => {
    const url = new URL(request.url);
    if (url.host !== 'obsidian.md') return new Response('', { status: 400 });
    const name = decodeURIComponent(url.pathname).replace(/^\/+/, '');
    if (!name) {
      return new Response('<!doctype html><title>Prism frontmatter benchmark</title>', { headers: { 'Content-Type': 'text/html' } });
    }
    if (!Object.hasOwn(served, name)) return new Response('', { status: 404 });
    const type = /\.m?js$/.test(name) ? 'text/javascript' : name.endsWith('.json') ? 'application/json' : 'application/octet-stream';
    return new Response(await readFile(served[name]), { headers: { 'Content-Type': type } });
  });
  const window = new BrowserWindow({
    show: false,
    webPreferences: { nodeIntegration: true, nodeIntegrationInWorker: true, contextIsolation: false, sandbox: false,
      preload: path.join(__dirname, 'electron-preload.cjs') },
  });
  await window.loadURL('app://obsidian.md/');
});
