// Isolated on-disk store for benchmark state. Every component is one JSON file, written to a temporary name and
// renamed, and every save is awaited, so timed windows include real disk writes. The same layout is used for
// M/C/A; it is a harness store, not the product's data.json.
import { KINDS } from './search-index.mjs';

/** `fs` is node:fs/promises and `path` node:path (renderer or Node). */
export function createFileStore(fs, path, directory) {
  const written = new Map();
  const file = (name) => path.join(directory, `${name}.json`);
  const read = async (name) => {
    try { return JSON.parse(await fs.readFile(file(name), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
  };
  const write = async (name, value) => {
    const text = JSON.stringify(value ?? null);
    const target = file(name);
    await fs.writeFile(`${target}.tmp`, text);
    await fs.rename(`${target}.tmp`, target);
    written.set(name, text);
  };
  return {
    directory,
    read,
    write,
    storage: (name) => ({ load: () => read(name), save: (value) => write(name, value) }),
    /** Actual on-disk sizes of every component file. */
    async fileBytes() {
      const result = {};
      for (const entry of (await fs.readdir(directory)).sort()) {
        if (entry.endsWith('.json')) result[entry.slice(0, -5)] = (await fs.stat(path.join(directory, entry))).size;
      }
      return result;
    },
    /** UTF-8 sizes of what this process last wrote, for comparison with the on-disk bytes. */
    serializedBytes() {
      return Object.fromEntries([...written].map(([name, text]) => [name, new TextEncoder().encode(text).length]));
    },
    /** Names whose disk content differs from the last write by this process. */
    async readbackMismatches() {
      const mismatches = [];
      for (const [name, text] of written) if (await fs.readFile(file(name), 'utf8') !== text) mismatches.push(name);
      return mismatches;
    },
  };
}

/** Persists a FrontmatterSearchIndex state as separate files per vector kind, metadata and full text. */
export function indexStorage(store) {
  return {
    async save(state) {
      await store.write('index-meta', { version: state.version, projections: state.projections });
      await store.write('fulltext', state.fullText ?? []);
      for (const kind of KINDS) await store.write(`vectors-${kind}`, state.entries.filter((entry) => entry.kind === kind));
    },
    async load() {
      const meta = await store.read('index-meta');
      if (!meta) return undefined;
      if (await store.read('vectors-attribute-note') !== undefined) throw new Error('Legacy vector channel found; rebuild the index.');
      const entries = [];
      for (const kind of KINDS) entries.push(...(await store.read(`vectors-${kind}`) ?? []));
      return { version: meta.version, projections: meta.projections, entries, fullText: await store.read('fulltext') ?? [] };
    },
  };
}
