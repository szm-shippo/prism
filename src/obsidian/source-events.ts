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
    private readonly isExcluded: (path: string) => boolean = () => false,
  ) {}

  create(file: TAbstractFile): Promise<void> {
    return this.enqueue(() => this.indexFile(file));
  }

  removeExcluded(): Promise<void> {
    return this.enqueue(() => this.removeExcludedSources());
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
      if (this.isExcluded(file.path)) {
        await this.removeSource(existing.source_id);
        return undefined;
      }
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
        if (this.isExcluded(file.path)) {
          const source = existing ?? this.registry.getByPath(file.path);
          if (source) await this.removeSource(source.source_id);
          return source ? [source.source_id] : [];
        }
        if (file.extension !== 'md') {
          if (existing) await this.removeSource(existing.source_id);
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
      const moved = await this.registry.movePaths(oldPath, file.path);
      await this.removeExcludedSources();
      if (!(file instanceof TFile)) {
        for (const candidate of this.vault.getMarkdownFiles()) {
          if ((candidate.path === file.path || candidate.path.startsWith(`${file.path}/`)) &&
              !this.registry.getByPath(candidate.path)) await this.indexFile(candidate);
        }
      }
      return moved;
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
    if (this.isExcluded(file.path)) {
      const existing = this.registry.getByPath(file.path);
      if (existing) await this.removeSource(existing.source_id);
      return;
    }
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

  private async removeExcludedSources(): Promise<void> {
    for (const source of this.registry.list()) {
      if (this.isExcluded(source.path)) await this.removeSource(source.source_id);
    }
  }

  private async removeSource(sourceId: string): Promise<void> {
    await this.indexes?.delete(sourceId);
    await this.chunks?.delete(sourceId);
    await this.registry.delete(sourceId);
  }
}
