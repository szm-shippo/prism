import { Notice, Plugin, PluginSettingTab, Setting } from 'obsidian';
import { loadSettings, type PluginSettings } from './settings';

export default class PrismPlugin extends Plugin {
  settings: PluginSettings = loadSettings(null);

  async onload(): Promise<void> {
    this.settings = loadSettings(await this.loadData());
    this.addSettingTab(new PrismSettingTab(this));
  }

  async setShowVaultNotice(value: boolean): Promise<void> {
    const updated = { ...this.settings, showVaultNotice: value };
    await this.saveData(updated);
    this.settings = updated;
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
