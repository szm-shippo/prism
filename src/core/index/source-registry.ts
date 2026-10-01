export interface SourceRecord {
  source_id: string;
  path: string;
  content_hash: string;
  mtime: number;
  size: number;
}

export interface SourceRegistryStorage {
  load(): Promise<unknown>;
  save(records: readonly SourceRecord[]): Promise<void>;
}

interface SourceInput {
  path: string;
  content: string;
  mtime: number;
  size: number;
}

function validVaultPath(path: string): boolean {
  return !path.startsWith('/') &&
    !path.split('/').some((part) => part === '' || part === '.' || part === '..' || /[\\:\0]/.test(part));
}

function validPath(path: string): boolean {
  return path.endsWith('.md') && validVaultPath(path);
}

function validateInput(input: SourceInput): void {
  if (!validPath(input.path)) throw new Error('A Vault-relative Markdown path is required.');
  if (!Number.isFinite(input.mtime) || input.mtime < 0 ||
      !Number.isSafeInteger(input.size) || input.size < 0) {
    throw new Error('Valid source mtime and size are required.');
  }
}

export async function hashSourceContent(content: string): Promise<string> {
  const bytes = new TextEncoder().encode(content);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function isSourceRecord(value: unknown): value is SourceRecord {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record.source_id === 'string' && record.source_id.length > 0 &&
    typeof record.path === 'string' && validPath(record.path) &&
    typeof record.content_hash === 'string' && /^[a-f0-9]{64}$/.test(record.content_hash) &&
    typeof record.mtime === 'number' && Number.isFinite(record.mtime) && record.mtime >= 0 &&
    typeof record.size === 'number' && Number.isSafeInteger(record.size) && record.size >= 0;
}

export class SourceRegistry {
  private constructor(
    private readonly storage: SourceRegistryStorage,
    private records: SourceRecord[],
  ) {}

  static async open(storage: SourceRegistryStorage): Promise<SourceRegistry> {
    const loaded = await storage.load();
    if (loaded === undefined || loaded === null) return new SourceRegistry(storage, []);
    if (!Array.isArray(loaded) || !loaded.every(isSourceRecord) ||
        new Set(loaded.map((record) => record.source_id)).size !== loaded.length ||
        new Set(loaded.map((record) => record.path)).size !== loaded.length) {
      throw new Error('Source Registry data is invalid; rebuild it from Vault Markdown.');
    }
    return new SourceRegistry(storage, loaded.map((record) => ({ ...record })));
  }

  list(): SourceRecord[] {
    return this.records.map((record) => ({ ...record }));
  }

  getById(sourceId: string): SourceRecord | undefined {
    const record = this.records.find((item) => item.source_id === sourceId);
    return record && { ...record };
  }

  getByPath(path: string): SourceRecord | undefined {
    const record = this.records.find((item) => item.path === path);
    return record && { ...record };
  }

  async create(input: SourceInput): Promise<SourceRecord> {
    validateInput(input);
    if (this.getByPath(input.path)) throw new Error('Source path already exists in the registry.');
    const record: SourceRecord = {
      source_id: crypto.randomUUID(),
      path: input.path,
      content_hash: await hashSourceContent(input.content),
      mtime: input.mtime,
      size: input.size,
    };
    await this.commit([...this.records, record]);
    return { ...record };
  }

  async update(sourceId: string, input: SourceInput): Promise<SourceRecord> {
    validateInput(input);
    const index = this.records.findIndex((record) => record.source_id === sourceId);
    if (index < 0) throw new Error('Source ID was not found in the registry.');
    if (this.records.some((record) => record.path === input.path && record.source_id !== sourceId)) {
      throw new Error('Source path already exists in the registry.');
    }
    const record = {
      source_id: sourceId,
      path: input.path,
      content_hash: await hashSourceContent(input.content),
      mtime: input.mtime,
      size: input.size,
    };
    const next = [...this.records];
    next[index] = record;
    await this.commit(next);
    return { ...record };
  }

  async delete(sourceId: string): Promise<boolean> {
    const next = this.records.filter((record) => record.source_id !== sourceId);
    if (next.length === this.records.length) return false;
    await this.commit(next);
    return true;
  }

  async clear(): Promise<void> {
    if (this.records.length > 0) await this.commit([]);
  }

  async deletePaths(path: string): Promise<string[]> {
    if (!validVaultPath(path)) throw new Error('A Vault-relative path is required to delete sources.');
    const removed = this.records.filter((record) => record.path === path || record.path.startsWith(`${path}/`));
    if (removed.length === 0) return [];
    const removedIds = new Set(removed.map((record) => record.source_id));
    await this.commit(this.records.filter((record) => !removedIds.has(record.source_id)));
    return removed.map((record) => record.source_id);
  }

  async movePaths(oldPath: string, newPath: string): Promise<string[]> {
    if (!validVaultPath(oldPath) || !validVaultPath(newPath)) {
      throw new Error('Vault-relative paths are required to move sources.');
    }
    const movedIds: string[] = [];
    const next = this.records.map((record) => {
      if (record.path !== oldPath && !record.path.startsWith(`${oldPath}/`)) return record;
      const path = `${newPath}${record.path.slice(oldPath.length)}`;
      if (!validPath(path)) throw new Error('Moved source must remain a Markdown path.');
      movedIds.push(record.source_id);
      return { ...record, path };
    });
    if (movedIds.length === 0) return [];
    if (new Set(next.map((record) => record.path)).size !== next.length) {
      throw new Error('Moved source path already exists in the registry.');
    }
    await this.commit(next);
    return movedIds;
  }

  private async commit(next: SourceRecord[]): Promise<void> {
    await this.storage.save(next);
    this.records = next;
  }
}
