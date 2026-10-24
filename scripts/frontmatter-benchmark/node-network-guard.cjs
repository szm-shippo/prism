// Blocks and records Node networking (TCP/TLS connects and DNS) in an Electron process that has Node enabled.
// Chromium requests are handled separately by the session hook; this covers http/https/fetch/net/dns via Node.
const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1']);

function connectTarget(args) {
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  if (first && typeof first === 'object') return { path: first.path, host: first.host ?? 'localhost', port: first.port };
  if (typeof first === 'string' && Number.isNaN(Number(first))) return { path: first };
  return { host: typeof args[1] === 'string' ? args[1] : 'localhost', port: first };
}

module.exports = function installNodeNetworkGuard(requireFn, processLabel, record) {
  const net = requireFn('node:net');
  const dns = requireFn('node:dns');
  const connect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function guardedConnect(...args) {
    const target = connectTarget(args);
    const allowed = Boolean(target.path) || LOOPBACK.has(target.host);
    record({ process: processLabel, api: 'net.Socket.connect',
      target: target.path ? `ipc:${target.path}` : `${target.host}:${target.port}`, allowed });
    if (!allowed) throw new Error('Network access is disabled in the Prism benchmark.');
    return connect.apply(this, args);
  };
  const refuse = (api, hostname) => {
    const allowed = LOOPBACK.has(hostname);
    record({ process: processLabel, api, target: String(hostname), allowed });
    return allowed;
  };
  for (const name of ['lookup', 'resolve', 'resolve4', 'resolve6', 'resolveAny']) {
    const original = dns[name];
    dns[name] = function guardedResolve(hostname, ...rest) {
      if (refuse(`dns.${name}`, hostname)) return original.call(this, hostname, ...rest);
      const callback = rest.find((item) => typeof item === 'function');
      const error = Object.assign(new Error('DNS is disabled in the Prism benchmark.'), { code: 'ENOTFOUND' });
      if (callback) setTimeout(() => callback(error), 0);
      else throw error;
      return undefined;
    };
    const promised = dns.promises[name];
    dns.promises[name] = async function guardedPromise(hostname, ...rest) {
      if (refuse(`dns.promises.${name}`, hostname)) return promised.call(this, hostname, ...rest);
      throw Object.assign(new Error('DNS is disabled in the Prism benchmark.'), { code: 'ENOTFOUND' });
    };
  }
  return true;
};
