import { TFile, type TAbstractFile, type Vault } from 'obsidian';
import type { SourceRegistry } from '../core/index/source-registry';

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

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.pending.then(operation);
    this.pending = result.then(() => undefined, () => undefined);
    return result;
  }
}
