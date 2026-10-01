import { Notice, Plugin, PluginSettingTab, Setting } from 'obsidian';
import { SourceRegistry, type SourceRecord } from '../core/index/source-registry';
import { SourceEventHandler } from './source-events';
import { loadSettings, type PluginSettings } from '../settings';

export default class PrismPlugin extends Plugin {
  settings: PluginSettings = loadSettings(null);
  sourceRegistry?: SourceRegistry;
  private savedData: Record<string, unknown> = {};

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
    const sourceEvents = new SourceEventHandler(this.app.vault, this.sourceRegistry);
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

  private async savePluginData(changes: Record<string, unknown>): Promise<void> {
    const updated = { ...this.savedData, ...changes };
    await this.saveData(updated);
    this.savedData = updated;
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
  }
}
