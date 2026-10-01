import { Notice, Plugin, PluginSettingTab, Setting } from 'obsidian';
import { SourceRegistry, type SourceRecord } from '../core/index/source-registry';
import { ChunkRegistry } from '../core/index/chunk-registry';
import { ChunkPipeline } from '../core/index/chunk-pipeline';
import { IndexUpdateOrchestrator } from '../core/index/index-update-orchestrator';
import { LocalFullTextSearch } from '../core/index/local-full-text-search';
import { LocalVectorStore, type VectorStoreState } from '../core/index/local-vector-store';
import { SourceEventHandler } from './source-events';
import { OpenAIEmbeddingProvider } from './openai-embedding-provider';
import { loadSettings, type PluginSettings } from '../settings';

export default class PrismPlugin extends Plugin {
  settings: PluginSettings = loadSettings(null);
  sourceRegistry?: SourceRegistry;
  chunkRegistry?: ChunkRegistry;
  fullTextSearch?: LocalFullTextSearch;
  vectorStore?: LocalVectorStore;
  private savedData: Record<string, unknown> = {};
  private dataWrite: Promise<void> = Promise.resolve();

  async onload(): Promise<void> {
    const loaded = await this.loadData();
    this.savedData = typeof loaded === 'object' && loaded !== null && !Array.isArray(loaded)
      ? loaded as Record<string, unknown> : {};
    this.settings = loadSettings(this.savedData);
    this.sourceRegistry = await SourceRegistry.open({
      load: async () => this.savedData.sourceRegistry,
      save: async (records: readonly SourceRecord[]) => {
        await this.savePluginData({ sourceRegistry: records });
      },
    });
    this.chunkRegistry = await ChunkRegistry.open({
      load: async () => this.savedData.chunkRegistry,
      save: async (chunks) => {
        await this.savePluginData({ chunkRegistry: chunks });
      },
    }, this.sourceRegistry);
    this.fullTextSearch = await LocalFullTextSearch.open({
      load: async () => this.savedData.fullTextIndex,
      save: async (entries) => {
        await this.savePluginData({ fullTextIndex: entries });
      },
    });
    const fullText = this.fullTextSearch;
    const chunks = this.chunkRegistry;
    const vectorStorage = {
      load: async () => this.savedData.vectorIndex,
      save: async (state: VectorStoreState) => {
        await this.savePluginData({ vectorIndex: state, vectorIndexModel: this.settings.embeddingModel });
      },
    };
    const getVectorStore = async (dimensions?: number): Promise<LocalVectorStore | undefined> => {
      const saved = this.savedData.vectorIndex as { dimensions?: unknown } | null | undefined;
      const target = dimensions ?? saved?.dimensions;
      if (target === undefined) return undefined;
      if (typeof target !== 'number') throw new Error('Vector index dimensions are invalid.');
      if (dimensions !== undefined && typeof this.savedData.vectorIndexModel === 'string' &&
          this.savedData.vectorIndexModel !== this.settings.embeddingModel) {
        throw new Error('Embedding model changed; rebuild the vector index.');
      }
      if (!this.vectorStore || this.vectorStore.dimensions !== target) {
        this.vectorStore = await LocalVectorStore.open(vectorStorage, target);
      }
      return this.vectorStore;
    };
    const remoteIndexes = new IndexUpdateOrchestrator(chunks, fullText, {
      embedBatch: async (texts) => {
        if (!this.settings.allowRemoteEmbeddingIndexing) {
          throw new Error('Remote embedding indexing is not enabled.');
        }
        const key = this.app.secretStorage.getSecret('prism-embedding-api-key');
        if (!key || !this.settings.embeddingModel.trim()) {
          throw new Error('Configure an embedding model and API key before remote indexing.');
        }
        if (typeof this.savedData.vectorIndexModel === 'string' &&
            this.savedData.vectorIndexModel !== this.settings.embeddingModel) {
          throw new Error('Embedding model changed; rebuild the vector index.');
        }
        const model = this.settings.embeddingModel;
        const vectors = await new OpenAIEmbeddingProvider(key, model).embedBatch(texts);
        if (!this.settings.allowRemoteEmbeddingIndexing || this.settings.embeddingModel !== model) {
          throw new Error('Embedding settings changed during indexing.');
        }
        return vectors;
      },
    }, getVectorStore);
    const localIndexes = {
      sync: async (sourceId: string): Promise<void> => {
        const current = chunks.listBySource(sourceId);
        await fullText.deleteBySource(sourceId);
        await fullText.index(current);
      },
    };
    const indexUpdates = {
      sync: async (sourceId: string): Promise<void> => {
        if (this.settings.allowRemoteEmbeddingIndexing) {
          await remoteIndexes.sync(sourceId);
        } else {
          await localIndexes.sync(sourceId);
          await (await getVectorStore())?.deleteBySource(sourceId);
        }
      },
      delete: (sourceId: string): Promise<void> => remoteIndexes.delete(sourceId),
    };
    const sourceEvents = new SourceEventHandler(this.app.vault, this.sourceRegistry,
      new ChunkPipeline(this.sourceRegistry, this.chunkRegistry), indexUpdates);
    this.registerEvent(this.app.vault.on('create', (file) => {
      return sourceEvents.create(file).catch(() => new Notice('Prism could not index a Markdown source. Check embedding settings and plugin storage.'));
    }));
    this.registerEvent(this.app.vault.on('modify', (file) => {
      return sourceEvents.modify(file).catch(() => new Notice('Prism could not update search indexes. Check embedding settings and plugin storage.'));
    }));
    this.registerEvent(this.app.vault.on('rename', (file, oldPath) => {
      return sourceEvents.rename(file, oldPath).catch(() => new Notice('Prism could not move a Markdown source. Check plugin storage.'));
    }));
    this.registerEvent(this.app.vault.on('delete', (file) => {
      return sourceEvents.delete(file).catch(() => new Notice('Prism could not remove a Markdown source. Check plugin storage.'));
    }));
    this.addSettingTab(new PrismSettingTab(this));
  }

  async setShowVaultNotice(value: boolean): Promise<void> {
    await this.savePluginData({ showVaultNotice: value });
    this.settings = { ...this.settings, showVaultNotice: value };
  }

  async setEmbeddingModel(value: string): Promise<void> {
    const embeddingModel = value.trim();
    if (embeddingModel !== this.settings.embeddingModel) {
      await this.savePluginData({ embeddingModel, vectorIndex: null, vectorIndexModel: null });
      this.vectorStore = undefined;
    }
    this.settings = { ...this.settings, embeddingModel };
  }

  async setAllowRemoteEmbeddingIndexing(value: boolean): Promise<void> {
    await this.savePluginData({ allowRemoteEmbeddingIndexing: value });
    this.settings = { ...this.settings, allowRemoteEmbeddingIndexing: value };
  }

  async setLlmModel(value: string): Promise<void> {
    const llmModel = value.trim();
    await this.savePluginData({ llmModel });
    this.settings = { ...this.settings, llmModel };
  }

  setEmbeddingApiKey(value: string): void {
    this.app.secretStorage.setSecret('prism-embedding-api-key', value.trim());
  }

  setLlmApiKey(value: string): void {
    this.app.secretStorage.setSecret('prism-llm-api-key', value.trim());
  }

  hasEmbeddingApiKey(): boolean {
    return Boolean(this.app.secretStorage.getSecret('prism-embedding-api-key'));
  }

  hasLlmApiKey(): boolean {
    return Boolean(this.app.secretStorage.getSecret('prism-llm-api-key'));
  }

  private async savePluginData(changes: Record<string, unknown>): Promise<void> {
    const write = this.dataWrite.then(async () => {
      const updated = { ...this.savedData, ...changes };
      await this.saveData(updated);
      this.savedData = updated;
    });
    this.dataWrite = write.catch(() => undefined);
    await write;
  }
}

class PrismSettingTab extends PluginSettingTab {
  constructor(private readonly prism: PrismPlugin) {
    super(prism.app, prism);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName('Show Vault information')
      .setDesc('Show a reminder that Vault Markdown is the source of truth.')
      .addToggle((toggle) => toggle
        .setValue(this.prism.settings.showVaultNotice)
        .onChange(async (value) => {
          try {
            await this.prism.setShowVaultNotice(value);
            this.display();
          } catch {
            toggle.setValue(this.prism.settings.showVaultNotice);
            new Notice('Prism could not save the setting. Try again.');
          }
        }));

    if (this.prism.settings.showVaultNotice) {
      containerEl.createEl('p', {
        text: 'Prism uses Markdown in your Vault as its source of truth.',
      });
    }

    containerEl.createEl('p', {
      text: 'Remote processing: OpenAI receives Markdown or chunk text for embeddings, and your query plus retrieved source IDs and text for answers. This data leaves your Vault for those requests.',
    });

    new Setting(containerEl)
      .setName('Send changed chunks to OpenAI for search indexing')
      .setDesc('Off by default. When enabled, Prism sends new or changed Markdown chunks, including previously unindexed chunks in a changed note, to https://api.openai.com/v1/embeddings using your configured embedding model and API key. Local full-text indexing continues when off. Enabling does not send existing notes immediately.')
      .addToggle((toggle) => toggle
        .setValue(this.prism.settings.allowRemoteEmbeddingIndexing)
        .onChange(async (value) => {
          try {
            await this.prism.setAllowRemoteEmbeddingIndexing(value);
          } catch {
            toggle.setValue(this.prism.settings.allowRemoteEmbeddingIndexing);
            new Notice('Prism could not save remote indexing consent. Try again.');
          }
        }));

    new Setting(containerEl)
      .setName('Embedding model')
      .setDesc('OpenAI model ID used for embeddings.')
      .addText((text) => text
        .setPlaceholder('Model ID')
        .setValue(this.prism.settings.embeddingModel)
        .onChange(async (value) => {
          try {
            await this.prism.setEmbeddingModel(value);
          } catch {
            new Notice('Prism could not save the embedding model. Try again.');
          }
        }));

    new Setting(containerEl)
      .setName('LLM model')
      .setDesc('OpenAI model ID used for answers.')
      .addText((text) => text
        .setPlaceholder('Model ID')
        .setValue(this.prism.settings.llmModel)
        .onChange(async (value) => {
          try {
            await this.prism.setLlmModel(value);
          } catch {
            new Notice('Prism could not save the LLM model. Try again.');
          }
        }));

    this.addApiKeySetting('Embedding API key', this.prism.hasEmbeddingApiKey(),
      (value) => this.prism.setEmbeddingApiKey(value));
    this.addApiKeySetting('LLM API key', this.prism.hasLlmApiKey(),
      (value) => this.prism.setLlmApiKey(value));
  }

  private addApiKeySetting(name: string, configured: boolean, save: (value: string) => void): void {
    new Setting(this.containerEl)
      .setName(name)
      .setDesc(configured ? 'Configured in Obsidian Secret Storage. Enter a new key and leave the field to replace it.'
        : 'Enter a key and leave the field to save it in Obsidian Secret Storage.')
      .addText((text) => {
        text.inputEl.type = 'password';
        text.setPlaceholder(configured ? 'Configured' : 'API key');
        text.inputEl.addEventListener('change', () => {
          const value = text.getValue().trim();
          if (!value) return;
          try {
            save(value);
            text.setValue('');
            this.display();
          } catch {
            text.setValue('');
            new Notice('Prism could not save the API key. Try again.');
          }
        });
      })
      .addButton((button) => button
        .setButtonText('Clear')
        .onClick(() => {
          try {
            save('');
            this.display();
          } catch {
            new Notice('Prism could not clear the API key. Try again.');
          }
        }));
  }
}
