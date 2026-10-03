import { LocalEmbeddingError } from '../core/provider/local-embedding-error';
import type { EmbeddingProvider } from '../core/provider/embedding-provider';
import { LOCAL_MODEL, LOCAL_MODEL_KEY } from '../core/provider/local-embedding-model';
import type { LocalEmbeddingModel } from './local-embedding-model';

export class LocalEmbeddingProvider implements EmbeddingProvider {
  readonly model = { id: LOCAL_MODEL_KEY, dimensions: LOCAL_MODEL.dimensions };
  private worker?: Worker;
  private loading?: Promise<void>;
  private nextId = 0;
  private pending = new Map<number, { resolve(value: number[][]): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  private generation = 0;
  metrics = { loadMs: 0, inferenceMs: 0, texts: 0, modelBytes: 0 };

  constructor(private readonly files: LocalEmbeddingModel) {}

  embed(text: string): Promise<number[]> {
    return this.embedBatch([text]).then((vectors) => vectors[0]);
  }

  async embedBatch(texts: readonly string[]): Promise<number[][]> {
    if (!texts.length) return [];
    await this.ready();
    const started = performance.now();
    const result = await this.send({ type: 'embed', texts: [...texts] });
    this.metrics.inferenceMs = performance.now() - started;
    this.metrics.texts = texts.length;
    return result;
  }

  dispose(): void {
    this.generation++;
    this.worker?.terminate();
    this.worker = undefined;
    this.loading = undefined;
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(new LocalEmbeddingError('Local embedding stopped. Retry the operation.'));
    }
    this.pending.clear();
  }

  private ready(): Promise<void> {
    if (!this.loading) {
      const generation = this.generation;
      this.loading = this.initialize(generation).catch((error: unknown) => {
        if (this.generation === generation) this.dispose();
        throw error;
      });
    }
    return this.loading;
  }

  private async initialize(generation: number): Promise<void> {
    const started = performance.now();
    const models = await this.files.load();
    const { script, factory, wasm } = await this.files.loadRuntime();
    if (this.generation !== generation) throw new LocalEmbeddingError('Local embedding stopped. Retry.');
    const url = URL.createObjectURL(new Blob([script], { type: 'text/javascript' }));
    try { this.worker = new Worker(url, { type: 'module' }); }
    catch { throw new LocalEmbeddingError('This WebView cannot start local WASM inference. Update Obsidian / OS or choose full-text search.'); }
    finally { URL.revokeObjectURL(url); }
    this.worker.onmessage = (event: MessageEvent) => {
      const { id, vectors, error } = event.data;
      const pending = this.pending.get(id);
      if (!pending) return;
      this.pending.delete(id);
      clearTimeout(pending.timer);
      if (error) {
        pending.reject(new LocalEmbeddingError('Local inference failed. Check memory, restart Prism, and retry; no OpenAI fallback occurred.'));
        this.dispose();
      }
      else pending.resolve(vectors);
    };
    this.worker.onerror = () => this.dispose();
    this.worker.onmessageerror = () => this.dispose();
    this.metrics.modelBytes = Object.values(models).reduce((sum, bytes) => sum + bytes.byteLength, 0) + wasm.byteLength;
    await this.send({ type: 'init', models, factory, wasm }, [...Object.values(models), wasm]);
    this.metrics.loadMs = performance.now() - started;
  }

  private send(message: Record<string, unknown>, transfer: Transferable[] = []): Promise<number[][]> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new LocalEmbeddingError('Local embedding timed out. Free memory, restart Prism, and retry.'));
        this.dispose();
      }, 120000);
      this.pending.set(id, { resolve, reject, timer });
      try { this.worker!.postMessage({ ...message, id }, transfer); }
      catch {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new LocalEmbeddingError('Local embedding worker is unavailable. Restart Prism and retry.'));
      }
    });
  }
}
