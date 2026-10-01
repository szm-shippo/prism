import { TFile, type TAbstractFile, type Vault } from 'obsidian';
import { hashSourceContent, type SourceRegistry } from '../core/index/source-registry';

export class SourceEventHandler {
  private pending: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly vault: Pick<Vault, 'read'>,
    private readonly registry: SourceRegistry,
  ) {}

  create(file: TAbstractFile): Promise<void> {
    return this.enqueue(async () => {
      if (!(file instanceof TFile) || file.extension !== 'md' || this.registry.getByPath(file.path)) return;
      const content = await this.vault.read(file);
      await this.registry.create({
        path: file.path,
        content,
        mtime: file.stat.mtime,
        size: file.stat.size,
      });
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
      return { sourceId: existing.source_id, contentChanged };
    });
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.pending.then(operation);
    this.pending = result.then(() => undefined, () => undefined);
    return result;
  }
}
