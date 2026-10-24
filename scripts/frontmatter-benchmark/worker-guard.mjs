// Prelude prepended to the product embedding Worker script (whose bytes stay hash-verified and otherwise unchanged).
// Electron exposes Node in workers, so Node networking there is blocked and every attempt is appended to a log
// file in the disposable profile, because the product Worker's message channel cannot carry these records.
import installNodeNetworkGuard from './node-network-guard.cjs';

const nodeRequire = Reflect.get(globalThis, 'require');
const log = Reflect.get(globalThis, 'prismWorkerGuardLog');
if (typeof nodeRequire === 'function' && typeof log === 'string') {
  const fs = nodeRequire('node:fs');
  const append = (entry) => fs.appendFileSync(log, `${JSON.stringify(entry)}\n`);
  installNodeNetworkGuard(nodeRequire, 'embedding-worker', append);
  append({ process: 'embedding-worker', api: 'guard-installed', allowed: true });
}
