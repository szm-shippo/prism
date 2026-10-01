import { Notice, Plugin, PluginSettingTab, Setting } from 'obsidian';
import { SourceRegistry, type SourceRecord } from '../core/index/source-registry';
import { ChunkRegistry } from '../core/index/chunk-registry';
import { ChunkPipeline } from '../core/index/chunk-pipeline';
import { SourceEventHandler } from './source-events';
import { loadSettings, type PluginSettings } from '../settings';

export default class PrismPlugin extends Plugin {
  settings: PluginSettings = loadSettings(null);
  sourceRegistry?: SourceRegistry;
  chunkRegistry?: ChunkRegistry;
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
    const sourceEvents = new SourceEventHandler(this.app.vault, this.sourceRegistry,
      new ChunkPipeline(this.sourceRegistry, this.chunkRegistry));
    this.registerEvent(this.app.vault.on('create', (file) => {
      void sourceEvents.create(file).catch(() => new Notice('Prism could not register a Markdown source. Check plugin storage.'));
    }));
    this.registerEvent(this.app.vault.on('modify', (file) => {
      void sourceEvents.modify(file).catch(() => new Notice('Prism could not update a Markdown source. Check plugin storage.'));
    }));
    this.registerEvent(this.app.vault.on('rename', (file, oldPath) => {
      void sourceEvents.rename(file, oldPath).catch(() => new Notice('Prism could not move a Markdown source. Check plugin storage.'));
    }));
    this.registerEvent(this.app.vault.on('delete', (file) => {
      void sourceEvents.delete(file).catch(() => new Notice('Prism could not remove a Markdown source. Check plugin storage.'));
    }));
    this.addSettingTab(new PrismSettingTab(this));
  }

  async setShowVaultNotice(value: boolean): Promise<void> {
    await this.savePluginData({ showVaultNotice: value });
    this.settings = { ...this.settings, showVaultNotice: value };
  }

  async setEmbeddingModel(value: string): Promise<void> {
    const embeddingModel = value.trim();
    await this.savePluginData({ embeddingModel });
    this.settings = { ...this.settings, embeddingModel };
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
