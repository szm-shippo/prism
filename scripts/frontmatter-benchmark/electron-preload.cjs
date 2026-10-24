// Renderer preload: installs the Node network guard before any page script can reach Node networking.
const installNodeNetworkGuard = require('./node-network-guard.cjs');

globalThis.prismNodeNetwork = [];
globalThis.prismRendererGuard = installNodeNetworkGuard(require, 'renderer', (entry) => globalThis.prismNodeNetwork.push(entry));
