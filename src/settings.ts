export interface PluginSettings {
  showVaultNotice: boolean;
  embeddingModel: string;
  llmModel: string;
}

const DEFAULT_SETTINGS: PluginSettings = {
  showVaultNotice: true,
  embeddingModel: '',
  llmModel: '',
};

export function loadSettings(data: unknown): PluginSettings {
  if (typeof data !== 'object' || data === null) {
    return { ...DEFAULT_SETTINGS };
  }

  const saved = data as Record<string, unknown>;
  return {
    showVaultNotice: typeof saved.showVaultNotice === 'boolean'
      ? saved.showVaultNotice
      : DEFAULT_SETTINGS.showVaultNotice,
    embeddingModel: typeof saved.embeddingModel === 'string' ? saved.embeddingModel : DEFAULT_SETTINGS.embeddingModel,
    llmModel: typeof saved.llmModel === 'string' ? saved.llmModel : DEFAULT_SETTINGS.llmModel,
  };
}
