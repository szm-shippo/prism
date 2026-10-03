import { LocalEmbeddingError } from '../core/provider/local-embedding-error';
import { requestUrl, type DataAdapter } from 'obsidian';

import { LOCAL_MODEL, LOCAL_MODEL_KEY, MODEL_FILES } from '../core/provider/local-embedding-model';

type ModelAdapter = Pick<DataAdapter, 'exists' | 'mkdir' | 'read' | 'readBinary' | 'write' | 'writeBinary'>;

export class LocalEmbeddingModel {
  private cancelled = false;
  private downloading = false;
  status = 'Not checked on this device. Download the local model before rebuilding.';
  readonly directory: string;

  constructor(private readonly adapter: ModelAdapter, readonly pluginDirectory: string,
    private readonly download = async (url: string) => (await requestUrl({ url })).arrayBuffer) {
    if (!pluginDirectory || pluginDirectory.startsWith('/') || /[\\:]|(^|\/)\.\.?($|\/)/.test(pluginDirectory)) {
      throw new LocalEmbeddingError('Local model storage must be inside the plugin directory.');
    }
    this.directory = `${pluginDirectory}/models/${LOCAL_MODEL.revision}`;
  }

  get busy(): boolean { return this.downloading; }

  cancel(): void { this.cancelled = true; }

  async isReady(): Promise<boolean> {
    try {
      return await this.adapter.read(`${this.directory}/ready.json`) === LOCAL_MODEL_KEY &&
        (await Promise.all(MODEL_FILES.map((file) => this.adapter.exists(`${this.directory}/${file.name}`))))
          .every(Boolean);
    } catch { return false; }
  }

  async install(): Promise<void> {
    if (this.downloading) return;
    this.downloading = true;
    this.cancelled = false;
    try {
      for (const path of [`${this.pluginDirectory}/models`, this.directory, `${this.directory}/onnx`]) {
        if (!await this.adapter.exists(path)) await this.adapter.mkdir(path);
      }
      for (const file of MODEL_FILES) {
        if (this.cancelled) throw new LocalEmbeddingError('cancelled');
        this.status = `Downloading / checking ${file.name}.`;
        let bytes: ArrayBuffer | undefined;
        try {
          const cached = await this.adapter.readBinary(`${this.directory}/${file.name}`);
          if (await this.valid(file, cached)) bytes = cached;
        } catch { /* Missing files are downloaded only after the user starts installation. */ }
        if (!bytes) {
          bytes = await this.download(`https://huggingface.co/${LOCAL_MODEL.id}/resolve/${LOCAL_MODEL.revision}/${file.name}`);
          if (this.cancelled) throw new LocalEmbeddingError('cancelled');
          if (!await this.valid(file, bytes)) throw new LocalEmbeddingError('invalid model file');
          await this.adapter.writeBinary(`${this.directory}/${file.name}`, bytes);
        }
      }
      if (this.cancelled) throw new LocalEmbeddingError('cancelled');
      await this.adapter.write(`${this.directory}/ready.json`, LOCAL_MODEL_KEY);
      this.status = 'Local model downloaded. Choose Local Embedding and rebuild the index.';
    } catch {
      this.status = this.cancelled
        ? 'Download cancelled. Retry to reuse verified files; the current request may finish first.'
        : 'Model download failed. Check internet access and free storage, then retry. Verified files are reused.';
      throw new LocalEmbeddingError(this.status);
    } finally { this.downloading = false; }
  }

  async load(): Promise<Record<string, ArrayBuffer>> {
    if (!await this.isReady()) throw new LocalEmbeddingError('Local model is missing. Download it in Prism settings, then rebuild.');
    const files: Record<string, ArrayBuffer> = {};
    for (const file of MODEL_FILES) {
      const bytes = await this.adapter.readBinary(`${this.directory}/${file.name}`);
      if (!await this.valid(file, bytes)) throw new LocalEmbeddingError('Local model is damaged. Download it again in Prism settings.');
      files[file.name] = bytes;
    }
    return files;
  }

  async loadRuntime(): Promise<{ script: string; factory: string; wasm: ArrayBuffer }> {
    try {
      const script = await this.adapter.read(`${this.pluginDirectory}/local-embedding-worker.js`);
      const factory = await this.adapter.read(`${this.pluginDirectory}/ort-wasm-simd-threaded.jsep.mjs`);
      const wasm = await this.adapter.readBinary(`${this.pluginDirectory}/ort-wasm-simd-threaded.jsep.wasm`);
      return { script, factory, wasm };
    } catch { throw new LocalEmbeddingError('Local runtime files are missing. Reinstall all Prism build artifacts.'); }
  }

  private async valid(file: { size: number; hash: string }, bytes: ArrayBuffer): Promise<boolean> {
    if (bytes.byteLength !== file.size) return false;
    const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    return Array.from(hash, (value) => value.toString(16).padStart(2, '0')).join('') === file.hash;
  }
}
