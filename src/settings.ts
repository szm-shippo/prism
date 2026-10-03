import { parseExcludedPaths } from './core/index/exclusion-rules';

export interface PluginSettings {
  searchMode: 'full-text' | 'local' | 'openai';
  showVaultNotice: boolean;
  allowRemoteEmbeddingIndexing: boolean;
  embeddingModel: string;
  llmModel: string;
  llmConnection: 'api-key' | 'chatgpt-codex';
  codexModel: string;
  excludedPaths: string[];
}

const DEFAULT_SETTINGS: PluginSettings = {
  searchMode: 'full-text',
  showVaultNotice: true,
  allowRemoteEmbeddingIndexing: false,
  embeddingModel: '',
  llmModel: '',
  llmConnection: 'api-key',
  codexModel: 'gpt-5.4',
  excludedPaths: [],
};

export function loadSettings(data: unknown): PluginSettings {
  if (typeof data !== 'object' || data === null) {
    return { ...DEFAULT_SETTINGS };
  }

  const saved = data as Record<string, unknown>;
  if (saved.excludedPaths !== undefined &&
      (!Array.isArray(saved.excludedPaths) || !saved.excludedPaths.every((path) => typeof path === 'string'))) {
    throw new Error('Saved index exclusions are invalid.');
  }
  const excludedPaths = parseExcludedPaths((saved.excludedPaths as string[] | undefined ?? []).join('\n'));
  return {
    searchMode: saved.searchMode === 'local' || saved.searchMode === 'full-text'
      ? saved.searchMode : saved.allowRemoteEmbeddingIndexing === true ? 'openai' : 'full-text',
    showVaultNotice: typeof saved.showVaultNotice === 'boolean'
      ? saved.showVaultNotice
      : DEFAULT_SETTINGS.showVaultNotice,
    allowRemoteEmbeddingIndexing: saved.allowRemoteEmbeddingIndexing === true &&
      saved.searchMode !== 'local' && saved.searchMode !== 'full-text',
    embeddingModel: typeof saved.embeddingModel === 'string' ? saved.embeddingModel : DEFAULT_SETTINGS.embeddingModel,
    llmModel: typeof saved.llmModel === 'string' ? saved.llmModel : DEFAULT_SETTINGS.llmModel,
    llmConnection: saved.llmConnection === 'chatgpt-codex' ? 'chatgpt-codex' : 'api-key',
    codexModel: typeof saved.codexModel === 'string' ? saved.codexModel : DEFAULT_SETTINGS.codexModel,
    excludedPaths,
  };
}
