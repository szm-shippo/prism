export interface PluginSettings {
  showVaultNotice: boolean;
}

const DEFAULT_SETTINGS: PluginSettings = {
  showVaultNotice: true,
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
  };
}
