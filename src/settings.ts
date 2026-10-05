import { parseExcludedPaths } from './core/index/exclusion-rules';

export interface PluginSettings {
  searchMode: 'full-text' | 'local';
  showVaultNotice: boolean;
  llmModel: string;
  llmConnection: 'api-key' | 'chatgpt-codex' | 'github-copilot';
  codexModel: string;
  copilotAccount?: CopilotAccount;
  copilotModel: string;
  excludedPaths: string[];
}

export interface CopilotAccount {
  host: 'github.com';
  login: string;
}

const DEFAULT_SETTINGS: PluginSettings = {
  searchMode: 'full-text',
  showVaultNotice: true,
  llmModel: '',
  llmConnection: 'api-key',
  codexModel: 'gpt-5.4',
  copilotModel: '',
  excludedPaths: [],
};

function parseCopilotAccount(value: unknown): CopilotAccount | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const account = value as Record<string, unknown>;
  const login = typeof account.login === 'string' ? account.login.trim() : '';
  if (account.host !== 'github.com' || !/^[A-Za-z0-9-]{1,39}$/.test(login)) return undefined;
  return { host: 'github.com', login };
}

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
      ? saved.searchMode : 'full-text',
    showVaultNotice: typeof saved.showVaultNotice === 'boolean'
      ? saved.showVaultNotice
      : DEFAULT_SETTINGS.showVaultNotice,
    llmModel: typeof saved.llmModel === 'string' ? saved.llmModel : DEFAULT_SETTINGS.llmModel,
    llmConnection: saved.llmConnection === 'chatgpt-codex' || saved.llmConnection === 'github-copilot'
      ? saved.llmConnection : 'api-key',
    codexModel: typeof saved.codexModel === 'string' ? saved.codexModel : DEFAULT_SETTINGS.codexModel,
    copilotAccount: parseCopilotAccount(saved.copilotAccount),
    copilotModel: typeof saved.copilotModel === 'string' ? saved.copilotModel.trim() : '',
    excludedPaths,
  };
}
