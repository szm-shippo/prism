import { TFile, type TAbstractFile, type Vault } from 'obsidian';
import { hashSourceContent, type SourceRegistry } from '../core/index/source-registry';
import type { ChunkPipeline } from '../core/index/chunk-pipeline';
import type { IndexUpdateOrchestrator } from '../core/index/index-update-orchestrator';

export class SourceEventHandler {
  private pending: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly vault: Pick<Vault, 'read' | 'getMarkdownFiles'>,
    private readonly registry: SourceRegistry,
    private readonly chunks?: ChunkPipeline,
    private readonly indexes?: Pick<IndexUpdateOrchestrator, 'sync' | 'delete'> & { clear(): Promise<void> },
  ) {}

  create(file: TAbstractFile): Promise<void> {
    return this.enqueue(() => this.indexFile(file));
  }

  rebuild(): Promise<void> {
    return this.enqueue(async () => {
      if (!this.chunks || !this.indexes) throw new Error('Index rebuild requires chunks and indexes.');
      const files = this.vault.getMarkdownFiles();
      await this.indexes.clear();
      await this.chunks.clear();
      await this.registry.clear();
      for (const file of files) await this.indexFile(file);
    });
  }

  modify(file: TAbstractFile): Promise<{ sourceId: string; contentChanged: boolean } | undefined> {
    return this.enqueue(async () => {
      if (!(file instanceof TFile) || file.extension !== 'md') return undefined;
      const existing = this.registry.getByPath(file.path);
      if (!existing) return undefined;
      const content = await this.vault.read(file);
      const contentChanged = await hashSourceContent(content) !== existing.content_hash;
      if (contentChanged || file.stat.mtime !== existing.mtime || file.stat.size !== existing.size) {
        await this.registry.update(existing.source_id, {
          path: file.path,
          content,
          mtime: file.stat.mtime,
          size: file.stat.size,
        });
      }
      await this.chunks?.sync(existing.source_id, content);
      await this.indexes?.sync(existing.source_id);
      return { sourceId: existing.source_id, contentChanged };
    });
  }

  rename(file: TAbstractFile, oldPath: string): Promise<string[]> {
    return this.enqueue(async () => {
      if (file instanceof TFile) {
        const existing = this.registry.getByPath(oldPath);
        if (file.extension !== 'md') {
          if (existing) {
            await this.indexes?.delete(existing.source_id);
            await this.chunks?.delete(existing.source_id);
            await this.registry.delete(existing.source_id);
          }
          return existing ? [existing.source_id] : [];
        }
        if (!existing) {
          const registered = this.registry.getByPath(file.path);
          if (registered) {
            const content = await this.vault.read(file);
            await this.chunks?.sync(registered.source_id, content);
            await this.indexes?.sync(registered.source_id);
            return [];
          }
          const content = await this.vault.read(file);
          const created = await this.registry.create({
            path: file.path, content, mtime: file.stat.mtime, size: file.stat.size,
          });
          await this.chunks?.sync(created.source_id, content);
          await this.indexes?.sync(created.source_id);
          return [created.source_id];
        }
      }
      return this.registry.movePaths(oldPath, file.path);
    });
  }

  delete(file: TAbstractFile): Promise<string[]> {
    return this.enqueue(async () => {
      if (file instanceof TFile && file.extension !== 'md') return [];
      const removed = this.registry.list().filter((source) =>
        source.path === file.path || source.path.startsWith(`${file.path}/`));
      for (const source of removed) {
        await this.indexes?.delete(source.source_id);
        await this.chunks?.delete(source.source_id);
      }
      return this.registry.deletePaths(file.path);
    });
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.pending.then(operation);
    this.pending = result.then(() => undefined, () => undefined);
    return result;
  }

  private async indexFile(file: TAbstractFile): Promise<void> {
    if (!(file instanceof TFile) || file.extension !== 'md') return;
    const content = await this.vault.read(file);
    const source = this.registry.getByPath(file.path) ?? await this.registry.create({
      path: file.path,
      content,
      mtime: file.stat.mtime,
      size: file.stat.size,
    });
    await this.chunks?.sync(source.source_id, content);
    await this.indexes?.sync(source.source_id);
  }
}
