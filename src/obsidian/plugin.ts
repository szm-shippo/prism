import { ButtonComponent, FileSystemAdapter, MarkdownView, Modal, Notice, Platform, Plugin, PluginSettingTab,
  Setting, setIcon, TFile, type TAbstractFile } from 'obsidian';
import { CitationAnswerer, type CitedAnswer, type SourceCitation } from '../core/application/citation-answerer';
import { RagPipeline } from '../core/application/rag-pipeline';
import type { ConversationExchange } from '../core/application/conversation-history';
import { generateSearchFrontmatter, checkSearchFrontmatterBody, type SearchFrontmatter } from '../core/application/search-frontmatter';
import { SourceRegistry, type SourceRecord } from '../core/index/source-registry';
import { ChunkRegistry } from '../core/index/chunk-registry';
import { ChunkPipeline } from '../core/index/chunk-pipeline';
import { IndexUpdateOrchestrator } from '../core/index/index-update-orchestrator';
import { LocalFullTextSearch } from '../core/index/local-full-text-search';
import { LocalVectorStore, type VectorStoreState } from '../core/index/local-vector-store';
import { HybridRetrieval } from '../core/index/hybrid-retrieval';
import { RetrievalReranker } from '../core/index/retrieval-reranker';
import { isExcludedPath, parseExcludedPaths } from '../core/index/exclusion-rules';
import { SourceEventHandler } from './source-events';
import { OpenAILLMProvider } from './openai-llm-provider';
import { CodexAuth, CodexModelListError, type DevicePrompt } from './codex-auth';
import { CodexLLMProvider } from './codex-llm-provider';
import { clearLegacyCopilotCredential } from './copilot-auth';
import { CopilotLLMProvider, CopilotLLMProviderError } from './copilot-llm-provider';
import type { CopilotModelInfo, CopilotRuntimeErrorStage, CopilotSdkRuntime } from './copilot-sdk-runtime';
import { LLMProviderError, type LLMRequest, type LLMResponse } from '../core/provider/llm-provider';
import { CHAT_VIEW_TYPE, PrismChatView } from './chat-view';
import { loadSettings, type CopilotAccount, type PluginSettings } from '../settings';
import { LocalEmbeddingModel } from './local-embedding-model';
import { LocalEmbeddingProvider } from './local-embedding-provider';
import { LOCAL_MODEL_KEY } from '../core/provider/local-embedding-model';
import { LocalEmbeddingError } from '../core/provider/local-embedding-error';
import { FrontmatterError, parseNote, type ParsedNote } from './frontmatter-update';

interface LlmSelectionSnapshot {
  connection: PluginSettings['llmConnection'];
  modelId: string;
  destination: string;
  accountLabel?: string;
  accountId?: string;
  copilotAccount?: CopilotAccount;
  apiKey?: string;
  generation: number;
}

interface FrontmatterTargetSnapshot {
  file: TFile;
  path: string;
  editorText: string;
  diskText: string;
  fileRevision: number;
  note: ParsedNote;
}

/** Raised before Prism changes the note, so the note is known to be untouched. */
class FrontmatterRunConflict extends Error {
  constructor(readonly reason: 'changed' | 'multiple-views' = 'changed') { super(reason); }
}

type FrontmatterWriteOutcome = 'unchanged' | 'expected' | 'partial' | 'unknown';

/** Raised after a write was attempted; the outcome comes from re-reading the editor and the file. */
class FrontmatterWriteError extends Error {
  constructor(readonly outcome: FrontmatterWriteOutcome) { super(outcome); }
}

function joinDesktopPath(root: string, directory: string, filename: string): string {
  const separator = root.includes('\\') ? '\\' : '/';
  const normalizedRoot = root.replace(/[\\/]+$/, '') || separator;
  const relative = [directory, filename].map((part) => part.replace(/[\\/]+/g, separator)
    .replace(new RegExp(`^${separator === '\\' ? '\\\\' : '/'}`), '')
    .replace(/[\\/]+$/, '')).filter(Boolean).join(separator);
  return normalizedRoot === separator ? `${separator}${relative}` : `${normalizedRoot}${separator}${relative}`;
}

const COPILOT_LOGIN_STAGE_NOTICES: Record<CopilotRuntimeErrorStage, string> = {
  sidecar_load: 'Reinstall Prism and restart Obsidian.',
  cli_discovery: 'Install Copilot CLI on PATH and restart Obsidian.',
  workspace: 'Check temporary storage and retry.',
  cli_start: 'Repair Copilot CLI and restart Obsidian.',
  auth_status: 'Update Copilot CLI and check again.',
  identity: 'Run copilot login, then check CLI login.',
  cleanup: 'Restart Obsidian and retry.',
};

function copilotLoginFailureNotice(error: unknown): string {
  // Copilot errors can cross the runtime sidecar/test VM boundary, so use the
  // diagnostic name and a fixed own-property whitelist instead of instanceof.
  if (error && typeof error === 'object' &&
      (error as { name?: unknown }).name === 'CopilotLLMProviderError') {
    const stage = (error as { stage?: unknown }).stage;
    if (typeof stage === 'string' && Object.prototype.hasOwnProperty.call(COPILOT_LOGIN_STAGE_NOTICES, stage)) {
      return COPILOT_LOGIN_STAGE_NOTICES[stage as CopilotRuntimeErrorStage];
    }
  }
  if (error instanceof LLMProviderError && error.code === 'authentication') {
    return COPILOT_LOGIN_STAGE_NOTICES.identity;
  }
  if (error instanceof LLMProviderError && error.code === 'invalid_request') {
    return COPILOT_LOGIN_STAGE_NOTICES.cli_discovery;
  }
  return 'Check Copilot CLI login and retry.';
}

export default class PrismPlugin extends Plugin {
  settings: PluginSettings = loadSettings(null);
  sourceRegistry?: SourceRegistry;
  chunkRegistry?: ChunkRegistry;
  fullTextSearch?: LocalFullTextSearch;
  vectorStore?: LocalVectorStore;
  private sourceEvents?: SourceEventHandler;
  private ragPipeline?: RagPipeline;
  private savedData: Record<string, unknown> = {};
  private dataWrite: Promise<void> = Promise.resolve();
  private rebuildState: 'ready' | 'rebuilding' | 'failed' = 'ready';
  private rebuildPromise?: Promise<void>;
  private chatOpening?: Promise<void>;
  private codexAuth?: CodexAuth;
  private codexPrompt?: DevicePrompt;
  private copilotProviders = new Set<CopilotLLMProvider>();
  private copilotModels: CopilotModelInfo[] = [];
  private copilotModelState: 'idle' | 'loading' | 'ready' | 'error' = 'idle';
  private copilotModelLoad?: Promise<void>;
  private copilotGeneration = 0;
  private copilotRuntime?: CopilotSdkRuntime;
  private prismSettingTab?: PrismSettingTab;
  private localModel?: LocalEmbeddingModel;
  private localEmbeddings?: LocalEmbeddingProvider;
  private embeddingGeneration = 0;
  private lastRebuildMs?: number;
  private llmSelectionGeneration = 0;
  private readonly frontmatterFileRevision = new WeakMap<TFile, number>();
  private readonly activeFrontmatterRuns = new Set<TFile>();

  async onload(): Promise<void> {
    const loaded = await this.loadData();
    this.savedData = typeof loaded === 'object' && loaded !== null && !Array.isArray(loaded)
      ? loaded as Record<string, unknown> : {};
    this.settings = loadSettings(this.savedData);
    clearLegacyCopilotCredential(this.app.secretStorage);
    const legacySettings = ['allowRemoteEmbeddingIndexing', 'embeddingModel']
      .some((key) => Object.prototype.hasOwnProperty.call(this.savedData, key)) || this.savedData.searchMode === 'openai';
    const obsoleteVectors = (this.savedData.vectorIndex != null || this.savedData.vectorIndexModel != null) &&
      this.savedData.vectorIndexModel !== LOCAL_MODEL_KEY;
    const obsoleteCopilotSettings = [
      'copilotClientId', 'copilotCredential', 'copilotAccessToken', 'copilotRefreshToken', 'copilotCliPath',
    ].some((key) => Object.prototype.hasOwnProperty.call(this.savedData, key)) ||
      (this.savedData.copilotAccount !== undefined && this.savedData.copilotAccount !== null && !this.settings.copilotAccount);
    if (this.app.secretStorage.getSecret('prism-embedding-api-key')) {
      this.app.secretStorage.setSecret('prism-embedding-api-key', '');
    }
    if (legacySettings || obsoleteVectors || obsoleteCopilotSettings) {
      await this.savePluginData({ searchMode: this.settings.searchMode,
        ...(obsoleteVectors ? { vectorIndex: null, vectorIndexModel: null } : {}),
        ...(obsoleteCopilotSettings ? { copilotAccount: this.settings.copilotAccount ?? null } : {}) });
    }
    if (this.manifest.dir && this.app.vault.adapter) {
      this.localModel = new LocalEmbeddingModel(this.app.vault.adapter, this.manifest.dir);
      this.localEmbeddings = new LocalEmbeddingProvider(this.localModel);
    }
    this.codexAuth = new CodexAuth(this.app.secretStorage);
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
    const sources = this.sourceRegistry;
    const vectorStorage = {
      load: async () => this.savedData.vectorIndex,
      save: async (state: VectorStoreState) => {
        await this.savePluginData({ vectorIndex: state, vectorIndexModel: LOCAL_MODEL_KEY });
      },
    };
    const getVectorStore = async (dimensions?: number): Promise<LocalVectorStore | undefined> => {
      const saved = this.savedData.vectorIndex as { dimensions?: unknown } | null | undefined;
      const target = dimensions ?? saved?.dimensions;
      if (target === undefined) return undefined;
      if (typeof target !== 'number') throw new Error('Vector index dimensions are invalid.');
      if (dimensions !== undefined && typeof this.savedData.vectorIndexModel === 'string' &&
          this.savedData.vectorIndexModel !== LOCAL_MODEL_KEY) {
        throw new Error('Embedding model changed; rebuild the vector index.');
      }
      if (!this.vectorStore || this.vectorStore.dimensions !== target) {
        this.vectorStore = await LocalVectorStore.open(vectorStorage, target);
      }
      return this.vectorStore;
    };
    const semanticIndexes = new IndexUpdateOrchestrator(chunks, fullText, {
      embedBatch: async (texts) => {
        const generation = this.embeddingGeneration;
        if (this.settings.searchMode === 'local') {
          if (!this.localEmbeddings) throw new LocalEmbeddingError('Local embedding runtime is unavailable. Reinstall Prism.');
          if (this.savedData.vectorIndexModel && this.savedData.vectorIndexModel !== LOCAL_MODEL_KEY) {
            throw new Error('Search model changed. Rebuild the index.');
          }
          const vectors = await this.localEmbeddings.embedBatch(texts);
          if (generation !== this.embeddingGeneration) throw new Error('Search settings changed. Rebuild the index.');
          return vectors;
        }
        throw new Error('Local embedding indexing is not enabled.');
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
        if (this.settings.searchMode === 'local' &&
            this.savedData.vectorIndex && this.savedData.vectorIndexModel !== LOCAL_MODEL_KEY) {
          await localIndexes.sync(sourceId);
          throw new LocalEmbeddingError('Vector index uses another model. Rebuild the index in Prism settings.');
        }
        if (this.settings.searchMode === 'local') {
          await semanticIndexes.sync(sourceId);
        } else {
          await localIndexes.sync(sourceId);
          await (await getVectorStore())?.deleteBySource(sourceId);
        }
      },
      delete: (sourceId: string): Promise<void> => semanticIndexes.delete(sourceId),
      clear: async (): Promise<void> => {
        await fullText.clear();
        await this.savePluginData({ vectorIndex: null, vectorIndexModel: null });
        this.vectorStore = undefined;
      },
    };
    const sourceEvents = new SourceEventHandler(this.app.vault, sources,
      new ChunkPipeline(sources, chunks), indexUpdates,
      (path) => isExcludedPath(path, this.settings.excludedPaths));
    this.sourceEvents = sourceEvents;
    const sourceAllowed = (sourceId: string) => {
      const source = sources.getById(sourceId);
      if (!source || isExcludedPath(source.path, this.settings.excludedPaths)) return false;
      const file = this.app.vault.getAbstractFileByPath(source.path);
      return file instanceof TFile && file.extension === 'md';
    };
    const allowedChunk = (chunkId: string) => {
      const chunk = chunks.get(chunkId);
      return chunk && sourceAllowed(chunk.source_id) ? chunk : undefined;
    };
    const retrieval = new HybridRetrieval({
      search: async (query, limit) => (await fullText.search(query, limit))
        .filter((hit) => sourceAllowed(hit.sourceId)),
    }, {
      search: async (vector, limit) => {
        if (vector.length === 0) return [];
        const store = await getVectorStore();
        return (await store?.search(vector, limit) ?? [])
          .filter((hit) => sourceAllowed(hit.sourceId));
      },
    });
    const reranker = new RetrievalReranker((chunkId) => allowedChunk(chunkId)?.content);
    const answerer = new CitationAnswerer({
      generate: (request) => this.generateWithSelectedLlm(request),
    }, chunks, (path) => {
      const file = this.app.vault.getAbstractFileByPath(path);
      return !isExcludedPath(path, this.settings.excludedPaths) &&
        file instanceof TFile && file.extension === 'md';
    });
    this.ragPipeline = new RagPipeline(async (query) => {
      if (this.settings.searchMode === 'full-text') return [];
      if (this.settings.searchMode === 'local') {
        if (!this.localEmbeddings) throw new LocalEmbeddingError('Local embedding runtime is unavailable. Reinstall Prism.');
        if (this.savedData.vectorIndexModel !== LOCAL_MODEL_KEY) {
          throw new LocalEmbeddingError('Local vector index is missing or uses another model. Rebuild the index in Prism settings.');
        }
        const generation = this.embeddingGeneration;
        const vector = await this.localEmbeddings.embed(query);
        if (generation !== this.embeddingGeneration) throw new Error('Search settings changed. Retry the question.');
        return vector;
      }
      return [];
    }, retrieval, reranker, { get: allowedChunk }, answerer);
    this.registerEvent(this.app.vault.on('create', (file) => {
      return sourceEvents.create(file).catch(() => new Notice('Prism could not index a Markdown source. Check embedding settings and plugin storage.'));
    }));
    this.registerEvent(this.app.vault.on('modify', (file) => {
      return sourceEvents.modify(file).catch(() => new Notice('Prism could not update search indexes. Check embedding settings and plugin storage.'));
    }));
    this.registerEvent(this.app.vault.on('rename', (file, oldPath) => {
      this.recordFrontmatterFileRevision(file);
      return sourceEvents.rename(file, oldPath).catch(() => new Notice('Prism could not move a Markdown source. Check plugin storage.'));
    }));
    this.registerEvent(this.app.vault.on('delete', (file) => {
      this.recordFrontmatterFileRevision(file);
      return sourceEvents.delete(file).catch(() => new Notice('Prism could not remove a Markdown source. Check plugin storage.'));
    }));
    this.registerView(CHAT_VIEW_TYPE, (leaf) => new PrismChatView(
      leaf, (query, history) => this.answerQuery(query, history), (citation) => this.openCitation(citation)));
    const showChat = () => this.openChatView().catch(() => {
      new Notice('Prism could not open the Ask view. Try again.');
    });
    this.addCommand({ id: 'open-chat', name: 'Open Ask view', callback: showChat });
    this.addCommand({ id: 'rebuild-index', name: 'Rebuild index', callback: () => this.rebuildFromCommand() });
    this.addCommand({ id: 'generate-search-frontmatter', name: 'Generate search frontmatter',
      callback: () => this.generateFrontmatterFromActiveNote() });
    this.addRibbonIcon('message-square', 'Open Prism Ask', showChat);
    this.prismSettingTab = new PrismSettingTab(this);
    this.addSettingTab(this.prismSettingTab);
  }

  onunload(): void {
    this.embeddingGeneration++;
    this.llmSelectionGeneration++;
    this.localModel?.cancel();
    this.localEmbeddings?.dispose();
    this.codexAuth?.cancelPending();
    this.invalidateCopilotOperations();
    this.prismSettingTab?.invalidateConnectionTest();
  }

  private createCopilotProvider(modelId = this.settings.copilotModel,
    expectedAccount = this.settings.copilotAccount): CopilotLLMProvider {
    if (!Platform.isDesktopApp) throw new LLMProviderError('unavailable');
    const pluginDirectory = this.manifest.dir;
    const adapter = this.app.vault.adapter;
    if (!pluginDirectory || !(adapter instanceof FileSystemAdapter)) throw new LLMProviderError('unavailable');
    const sidecarPath = joinDesktopPath(adapter.getBasePath(), pluginDirectory, 'copilot-sdk-runtime.cjs');
    return new CopilotLLMProvider({
      expectedAccount,
      modelId,
      sidecarPath,
      isDesktop: () => Platform.isDesktopApp,
      onAuthenticationFailure: () => this.forgetCopilotAccount(),
      ...(this.copilotRuntime ? { runtime: this.copilotRuntime } : {}),
    });
  }

  private invalidateCopilotOperations(resetCatalog = true): void {
    this.copilotGeneration += 1;
    this.copilotModelLoad = undefined;
    for (const provider of this.copilotProviders) void provider.dispose();
    this.copilotProviders.clear();
    if (resetCatalog) {
      this.copilotModels = [];
      this.copilotModelState = 'idle';
    }
  }

  private forgetCopilotAccount(): void {
    const hadAccount = Boolean(this.settings.copilotAccount);
    this.llmSelectionGeneration++;
    this.settings = { ...this.settings, copilotAccount: undefined };
    this.invalidateCopilotOperations();
    this.prismSettingTab?.invalidateConnectionTest();
    if (hadAccount) {
      void this.savePluginData({ copilotAccount: null }).catch(() => {
        new Notice('Prism could not save the GitHub Copilot disconnection.');
      });
    }
    this.refreshSettingTab();
  }

  getCopilotStatus(): {
    account?: CopilotAccount;
    models: readonly CopilotModelInfo[];
    modelState: 'idle' | 'loading' | 'ready' | 'error';
  } {
    return { account: this.settings.copilotAccount,
      models: this.copilotModels, modelState: this.copilotModelState };
  }

  async refreshCopilotModels(force = true): Promise<void> {
    if (!Platform.isDesktopApp) throw new LLMProviderError('unavailable');
    if (!this.settings.copilotAccount) throw new LLMProviderError('authentication');
    if (this.copilotModelState === 'loading' && this.copilotModelLoad) return this.copilotModelLoad;
    if (!force && this.copilotModelState === 'ready') return;

    const generation = this.copilotGeneration;
    this.copilotModelState = 'loading';
    const provider = this.createCopilotProvider('');
    this.copilotProviders.add(provider);
    const load = provider.listModels().then((models) => {
      if (generation !== this.copilotGeneration) return;
      this.copilotModels = models.filter((model) => model.id.trim() && model.name.trim() && model.policy?.state !== 'disabled');
      this.copilotModelState = 'ready';
    }, (error: unknown) => {
      if (generation === this.copilotGeneration) this.copilotModelState = 'error';
      throw error;
    }).finally(async () => {
      this.copilotProviders.delete(provider);
      await provider.dispose();
      if (this.copilotModelLoad === load) this.copilotModelLoad = undefined;
    });
    this.copilotModelLoad = load;
    return load;
  }

  private async requireCopilotModel(modelId = this.settings.copilotModel): Promise<void> {
    if (!modelId.trim()) throw new LLMProviderError('invalid_request');
    if (this.copilotModelState !== 'ready') await this.refreshCopilotModels(false);
    if (!this.copilotModels.some((model) => model.id === modelId && model.policy?.state !== 'disabled')) {
      throw new LLMProviderError('invalid_request');
    }
  }

  async checkCopilotLogin(): Promise<void> {
    if (!Platform.isDesktopApp) throw new LLMProviderError('unavailable');
    this.llmSelectionGeneration++;
    this.settings = { ...this.settings, copilotAccount: undefined };
    this.invalidateCopilotOperations();
    this.prismSettingTab?.invalidateConnectionTest();
    await this.savePluginData({ copilotAccount: null });
    const generation = this.copilotGeneration;
    const provider = this.createCopilotProvider('');
    this.copilotProviders.add(provider);
    try {
      const account = await provider.checkAuth();
      if (generation !== this.copilotGeneration) return;
      await this.savePluginData({ copilotAccount: account });
      if (generation !== this.copilotGeneration) return;
      this.settings = { ...this.settings, copilotAccount: account };
      this.invalidateCopilotOperations();
      this.prismSettingTab?.invalidateConnectionTest();
      const connectedGeneration = this.copilotGeneration;
      try { await this.refreshCopilotModels(true); }
      catch {
        if (connectedGeneration !== this.copilotGeneration || !this.settings.copilotAccount) return;
        new Notice('GitHub Copilot CLI is connected to Prism, but its models could not be loaded.');
      }
      if (connectedGeneration !== this.copilotGeneration || !this.settings.copilotAccount) return;
      new Notice(`GitHub account ${account.login} connected to Prism.`);
      this.refreshSettingTab();
    } finally {
      this.copilotProviders.delete(provider);
      await provider.dispose();
      this.refreshSettingTab();
    }
  }

  async disconnectCopilot(): Promise<void> {
    this.llmSelectionGeneration++;
    this.settings = { ...this.settings, copilotAccount: undefined };
    this.invalidateCopilotOperations();
    this.prismSettingTab?.invalidateConnectionTest();
    await this.savePluginData({ copilotAccount: null });
    this.refreshSettingTab();
  }

  async testCopilotConnection(): Promise<void> {
    if (this.settings.llmConnection !== 'github-copilot') throw new LLMProviderError('invalid_request');
    if (!Platform.isDesktopApp) throw new LLMProviderError('unavailable');
    if (!this.settings.copilotAccount) throw new LLMProviderError('authentication');
    await this.requireCopilotModel();
    const provider = this.createCopilotProvider();
    this.copilotProviders.add(provider);
    try {
      const response = await provider.generate({
        messages: [{ role: 'user', content: 'Reply with OK.' }],
        context: [],
      });
      if (response.incompleteReason) throw new LLMProviderError('unknown');
    } finally {
      this.copilotProviders.delete(provider);
      await provider.dispose();
    }
  }

  getCodexStatus(): { accountId?: string; prompt?: DevicePrompt; models: readonly string[]; modelState: 'idle' | 'loading' | 'ready' | 'error' } {
    return { accountId: this.codexAuth?.accountId, prompt: this.codexPrompt,
      models: this.codexAuth?.availableModels ?? [], modelState: this.codexAuth?.modelListState ?? 'idle' };
  }

  async startCodexLogin(): Promise<void> {
    if (!this.codexAuth) throw new Error('ChatGPT connection is not ready.');
    this.llmSelectionGeneration++;
    const prompt = await this.codexAuth.startDeviceLogin();
    this.codexPrompt = prompt;
    void prompt.complete.then(async () => {
      this.llmSelectionGeneration++;
      if (this.codexPrompt === prompt) this.codexPrompt = undefined;
      this.prismSettingTab?.invalidateConnectionTest();
      try { await this.codexAuth?.listModels(true); }
      catch (error) { new Notice(error instanceof CodexModelListError
        ? error.message : 'ChatGPT connected, but Prism could not load available Codex models.'); }
      new Notice('ChatGPT account connected to Prism.');
      this.refreshSettingTab();
    }, () => {
      this.llmSelectionGeneration++;
      if (this.codexPrompt === prompt) this.codexPrompt = undefined;
      this.prismSettingTab?.invalidateConnectionTest();
      new Notice('ChatGPT authorization did not complete. Try connecting again.');
      this.refreshSettingTab();
    });
  }

  cancelCodexLogin(): void {
    this.codexPrompt?.cancel();
    this.codexPrompt = undefined;
  }

  signOutCodex(): void {
    this.llmSelectionGeneration++;
    this.codexAuth?.signOut();
    this.codexPrompt = undefined;
  }

  async refreshCodexModels(force = true): Promise<void> {
    if (!this.codexAuth) throw new Error('ChatGPT connection is not ready.');
    await this.codexAuth.listModels(force);
  }

  async testCodexConnection(): Promise<void> {
    if (this.settings.llmConnection !== 'chatgpt-codex' || !this.codexAuth?.connected) {
      throw new LLMProviderError('authentication');
    }
    const response = await new CodexLLMProvider(this.codexAuth, this.settings.codexModel).generate({
      messages: [{ role: 'user', content: 'Reply with OK.' }],
      context: [],
    });
    if (response.incompleteReason) throw new LLMProviderError('unknown');
  }

  private refreshSettingTab(): void {
    this.prismSettingTab?.display();
  }

  getIndexStatus(): { state: 'ready' | 'rebuilding' | 'failed'; sources: number; chunks: number; lastRebuildMs?: number } {
    const sourceIds = this.sourceRegistry?.list().map((source) => source.source_id) ?? [];
    return {
      state: this.rebuildState,
      lastRebuildMs: this.lastRebuildMs,
      sources: sourceIds.length,
      chunks: sourceIds.reduce((count, id) => count + (this.chunkRegistry?.listBySource(id).length ?? 0), 0),
    };
  }

  async openCitation(citation: Pick<SourceCitation, 'sourceId'>): Promise<boolean> {
    const source = this.sourceRegistry?.getById(citation.sourceId);
    if (!source || isExcludedPath(source.path, this.settings.excludedPaths)) return false;
    const file = this.app.vault.getAbstractFileByPath(source.path);
    if (!(file instanceof TFile) || file.extension !== 'md') return false;
    await this.app.workspace.getLeaf(false).openFile(file);
    return true;
  }

  private captureLlmSelection(): LlmSelectionSnapshot {
    const connection = this.settings.llmConnection;
    if (connection === 'api-key') {
      const apiKey = this.app.secretStorage.getSecret('prism-llm-api-key') ?? undefined;
      if (!apiKey || !this.settings.llmModel.trim()) {
        throw new Error('Configure an LLM model and API key before asking Prism.');
      }
      return { connection, modelId: this.settings.llmModel, destination: 'OpenAI API (api.openai.com)',
        apiKey, generation: this.llmSelectionGeneration };
    }
    if (connection === 'chatgpt-codex') {
      if (!this.codexAuth?.connected || !this.codexAuth.accountId) throw new LLMProviderError('authentication');
      if (!this.settings.codexModel.trim()) throw new LLMProviderError('invalid_request');
      return { connection, modelId: this.settings.codexModel, destination: 'ChatGPT (chatgpt.com)',
        accountLabel: this.codexAuth.accountId, accountId: this.codexAuth.accountId,
        generation: this.llmSelectionGeneration };
    }
    if (!Platform.isDesktopApp) throw new LLMProviderError('unavailable');
    const account = this.settings.copilotAccount;
    if (!account) throw new LLMProviderError('authentication');
    if (!this.settings.copilotModel.trim()) throw new LLMProviderError('invalid_request');
    return { connection, modelId: this.settings.copilotModel, destination: 'GitHub Copilot',
      accountLabel: account.login, copilotAccount: { ...account }, generation: this.llmSelectionGeneration };
  }

  private llmSelectionIsCurrent(selection: LlmSelectionSnapshot): boolean {
    if (selection.generation !== this.llmSelectionGeneration || this.settings.llmConnection !== selection.connection) return false;
    if (selection.connection === 'api-key') {
      return this.settings.llmModel === selection.modelId &&
        this.app.secretStorage.getSecret('prism-llm-api-key') === selection.apiKey;
    }
    if (selection.connection === 'chatgpt-codex') {
      return this.settings.codexModel === selection.modelId && this.codexAuth?.connected === true &&
        this.codexAuth.accountId === selection.accountId;
    }
    const current = this.settings.copilotAccount;
    return Platform.isDesktopApp && this.settings.copilotModel === selection.modelId &&
      current?.host === selection.copilotAccount?.host && current?.login === selection.copilotAccount?.login;
  }

  private async generateWithLlmSelection(selection: LlmSelectionSnapshot, request: LLMRequest): Promise<LLMResponse> {
    if (!this.llmSelectionIsCurrent(selection)) throw new LLMProviderError('invalid_request');
    if (selection.connection === 'api-key') {
      return new OpenAILLMProvider(selection.apiKey!, selection.modelId).generate(request);
    }
    if (selection.connection === 'chatgpt-codex') {
      if (!this.codexAuth) throw new LLMProviderError('authentication');
      return new CodexLLMProvider(this.codexAuth, selection.modelId).generate(request);
    }

    await this.requireCopilotModel(selection.modelId);
    if (!this.llmSelectionIsCurrent(selection)) throw new LLMProviderError('invalid_request');
    const provider = this.createCopilotProvider(selection.modelId, selection.copilotAccount);
    this.copilotProviders.add(provider);
    try { return await provider.generate(request); }
    finally {
      this.copilotProviders.delete(provider);
      await provider.dispose();
    }
  }

  private generateWithSelectedLlm(request: LLMRequest): Promise<LLMResponse> {
    return this.generateWithLlmSelection(this.captureLlmSelection(), request);
  }

  private getOpenMarkdownViews(file: TFile): MarkdownView[] {
    return this.app.workspace.getLeavesOfType('markdown')
      .map((leaf) => leaf.view)
      .filter((view): view is MarkdownView => view instanceof MarkdownView && view.file === file);
  }

  private frontmatterFileIsCurrent(target: Pick<FrontmatterTargetSnapshot, 'file' | 'path' | 'fileRevision'>): boolean {
    return target.file.path === target.path &&
      this.app.vault.getAbstractFileByPath(target.path) === target.file &&
      (this.frontmatterFileRevision.get(target.file) ?? 0) === target.fileRevision;
  }

  private recordFrontmatterFileRevision(file: TAbstractFile): void {
    if (!(file instanceof TFile)) return;
    this.frontmatterFileRevision.set(file, (this.frontmatterFileRevision.get(file) ?? 0) + 1);
  }

  private async readFrontmatterTarget(target: Omit<FrontmatterTargetSnapshot, 'note'>): Promise<string> {
    if (!this.frontmatterFileIsCurrent(target)) throw new FrontmatterRunConflict();
    return this.app.vault.read(target.file);
  }

  // Returns the editor showing the note, if any. Separate editors cannot be updated as one change,
  // so a second editor on the note stops the run.
  private currentFrontmatterView(target: Omit<FrontmatterTargetSnapshot, 'note'>,
    diskText: string): MarkdownView | undefined {
    if (!this.frontmatterFileIsCurrent(target) ||
        (diskText !== target.diskText && diskText !== target.editorText)) {
      throw new FrontmatterRunConflict();
    }
    const views = this.getOpenMarkdownViews(target.file);
    if (views.length > 1) throw new FrontmatterRunConflict('multiple-views');
    const [view] = views;
    if (view ? view.editor.getValue() !== target.editorText : diskText !== target.editorText) {
      throw new FrontmatterRunConflict();
    }
    return view;
  }

  private async captureFrontmatterTarget(file: TFile, view: MarkdownView): Promise<FrontmatterTargetSnapshot> {
    const path = file.path;
    const editorText = view.editor.getValue();
    const fileRevision = this.frontmatterFileRevision.get(file) ?? 0;
    const diskText = await this.app.vault.read(file);
    const target = { file, path, editorText, diskText, fileRevision };
    if (view.file !== file || this.currentFrontmatterView(target, diskText) !== view) {
      throw new FrontmatterRunConflict();
    }
    return { ...target, note: parseNote(editorText) };
  }

  // Compares every open editor and the file with the original and expected text, without changing either.
  private async inspectFrontmatterWrite(snapshot: FrontmatterTargetSnapshot,
    expected: string): Promise<FrontmatterWriteOutcome> {
    const states = this.getOpenMarkdownViews(snapshot.file).map((view) => {
      const text = view.editor.getValue();
      return text === expected ? 'expected' : text === snapshot.editorText ? 'original' : 'other';
    });
    try {
      if (!this.frontmatterFileIsCurrent(snapshot)) return 'unknown';
      const diskText = await this.app.vault.read(snapshot.file);
      states.push(diskText === expected ? 'expected'
        : diskText === snapshot.editorText || diskText === snapshot.diskText ? 'original' : 'other');
    } catch {
      return 'unknown';
    }
    if (states.includes('other')) return 'unknown';
    if (states.every((state) => state === 'expected')) return 'expected';
    return states.every((state) => state === 'original') ? 'unchanged' : 'partial';
  }

  private async requestFrontmatterConsent(snapshot: FrontmatterTargetSnapshot,
    selection: LlmSelectionSnapshot): Promise<boolean> {
    return new Promise((resolve) => {
      let settled = false;
      const settle = (consented: boolean) => {
        if (settled) return;
        settled = true;
        modal.close();
        resolve(consented);
      };
      const modal = new class extends Modal {
        onOpen(): void {
          this.setTitle('Generate search frontmatter');
          this.contentEl.empty();
          const account = selection.accountLabel ? ` for account “${selection.accountLabel}”` : '';
          this.contentEl.createEl('p', { text:
            `Send only the body of “${snapshot.file.basename}” to ${selection.destination} with model “${selection.modelId}”${account}? ` +
            'Prism will automatically update prism_summary, prism_keywords and prism_aliases.' });
          const actions = this.contentEl.createDiv();
          actions.createEl('button', { text: 'Send' }).addEventListener('click', () => settle(true));
          actions.createEl('button', { text: 'Cancel' }).addEventListener('click', () => settle(false));
        }
        onClose(): void { if (!settled) { settled = true; resolve(false); } }
      }(this.app);
      modal.open();
    });
  }

  private async writeSearchFrontmatter(snapshot: FrontmatterTargetSnapshot, selection: LlmSelectionSnapshot,
    metadata: SearchFrontmatter): Promise<void> {
    const update = snapshot.note.update(metadata);
    const diskText = await this.readFrontmatterTarget(snapshot);
    // No await from this final check until the editor transaction or the Vault.process call.
    const view = this.currentFrontmatterView(snapshot, diskText);
    if (!this.llmSelectionIsCurrent(selection)) throw new FrontmatterRunConflict();
    if (view) {
      try {
        view.editor.transaction({ changes: [{ from: view.editor.offsetToPos(update.from),
          to: view.editor.offsetToPos(update.to), text: update.text }] });
        if (view.editor.getValue() === update.content) await view.save();
      } catch {
        throw new FrontmatterWriteError(await this.inspectFrontmatterWrite(snapshot, update.content));
      }
    } else {
      let returned = false;
      try {
        await this.app.vault.process(snapshot.file, (currentText) => {
          // process() covers only the file; an editor opened since the last check could later save over it.
          if (currentText !== snapshot.editorText || !this.frontmatterFileIsCurrent(snapshot) ||
              !this.llmSelectionIsCurrent(selection) || this.getOpenMarkdownViews(snapshot.file).length > 0) {
            throw new FrontmatterRunConflict();
          }
          returned = true;
          return update.content;
        });
      } catch (error) {
        if (!returned && error instanceof FrontmatterRunConflict) throw error;
        throw new FrontmatterWriteError(await this.inspectFrontmatterWrite(snapshot, update.content));
      }
    }
    const outcome = await this.inspectFrontmatterWrite(snapshot, update.content);
    if (outcome !== 'expected') throw new FrontmatterWriteError(outcome);
  }

  private frontmatterWriteNotice(error: unknown, name: string): string {
    if (error instanceof FrontmatterRunConflict) {
      return error.reason === 'multiple-views'
        ? 'This note was opened in another tab, so nothing was written. Close the other tabs and retry.'
        : 'The note or LLM settings changed, so nothing was written. Retry.';
    }
    if (error instanceof FrontmatterError) return 'Prism cannot safely update this note frontmatter, so nothing was written.';
    return {
      unchanged: 'Prism could not write search frontmatter; the note still has its previous content. Retry.',
      expected: `Search frontmatter was written to “${name}”, but Obsidian reported an error. Check the note.`,
      partial: `Search frontmatter for “${name}” was only partly applied: the editor and the file differ. ` +
        'Check the note before retrying.',
      unknown: `Prism could not confirm the content of “${name}” after an error. Check the note before retrying.`,
    }[error instanceof FrontmatterWriteError ? error.outcome : 'unknown'];
  }

  private async generateFrontmatterFromActiveNote(): Promise<void> {
    const active = this.app.workspace.getActiveFile() as TAbstractFile | null;
    if (!active) {
      new Notice('Open a Markdown note to generate search frontmatter.');
      return;
    }
    if (!(active instanceof TFile) || active.extension !== 'md') {
      new Notice('Search frontmatter can be generated only for Markdown notes.');
      return;
    }
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view || view.file !== active) {
      new Notice('Search frontmatter can be generated only for Markdown notes.');
      return;
    }
    if (this.activeFrontmatterRuns.has(active)) {
      new Notice('Search frontmatter is already being generated for this note.');
      return;
    }

    const notSent = (error: unknown) => new Notice(
      error instanceof FrontmatterRunConflict && error.reason === 'multiple-views'
        ? 'This note is open in more than one tab. Close the other tabs and retry; nothing was sent.'
        : 'The note or LLM settings changed, so nothing was sent. Retry.');
    this.activeFrontmatterRuns.add(active);
    try {
      let snapshot: FrontmatterTargetSnapshot;
      try { snapshot = await this.captureFrontmatterTarget(active, view); }
      catch (error) {
        if (error instanceof FrontmatterError) {
          new Notice(error.reason === 'invalid_yaml'
            ? 'The note frontmatter is not valid YAML, so nothing was sent. Fix it and retry.'
            : 'Prism cannot safely update this note frontmatter, so nothing was sent.');
        } else {
          notSent(error);
        }
        return;
      }
      try { checkSearchFrontmatterBody(snapshot.note.body); }
      catch (error) {
        new Notice(error instanceof Error && error.message.includes('12,000')
          ? 'The note body exceeds 12,000 UTF-8 bytes, so nothing was sent. Shorten it and retry.'
          : 'The note body is empty, so nothing was sent.');
        return;
      }

      let selection: LlmSelectionSnapshot;
      try { selection = this.captureLlmSelection(); }
      catch {
        new Notice('Set up the selected LLM connection in Prism settings; nothing was sent.');
        return;
      }
      const consented = await this.requestFrontmatterConsent(snapshot, selection);
      if (!consented) {
        new Notice('Search frontmatter cancelled; nothing was sent.');
        return;
      }
      try {
        this.currentFrontmatterView(snapshot, await this.readFrontmatterTarget(snapshot));
        if (!this.llmSelectionIsCurrent(selection)) throw new FrontmatterRunConflict();
      } catch (error) {
        notSent(error);
        return;
      }

      let metadata: SearchFrontmatter;
      try {
        metadata = await generateSearchFrontmatter({
          generate: (request) => this.generateWithLlmSelection(selection, request),
        }, snapshot.note.body);
      } catch {
        new Notice('Search frontmatter generation failed. The note was not changed; check the selected connection and retry.');
        return;
      }

      try { await this.writeSearchFrontmatter(snapshot, selection, metadata); }
      catch (error) {
        new Notice(this.frontmatterWriteNotice(error, snapshot.file.basename));
        return;
      }
      new Notice(`Search frontmatter updated in “${snapshot.file.basename}”.`);
    } finally {
      this.activeFrontmatterRuns.delete(active);
    }
  }

  async answerQuery(query: string, history: readonly ConversationExchange[] = []): Promise<CitedAnswer> {
    if (!this.ragPipeline) throw new Error('Prism search is not ready.');
    return this.ragPipeline.answer(query, history);
  }

  private openChatView(): Promise<void> {
    if (!this.chatOpening) {
      this.chatOpening = this.showChatInSidebar().finally(() => { this.chatOpening = undefined; });
    }
    return this.chatOpening;
  }

  private async showChatInSidebar(): Promise<void> {
    const workspace = this.app.workspace;
    const existing = workspace.getLeavesOfType(CHAT_VIEW_TYPE)[0];
    if (existing?.getRoot() === workspace.rightSplit) {
      await workspace.revealLeaf(existing);
      return;
    }
    const leaf = workspace.getRightLeaf(false);
    if (!leaf) throw new Error('Right sidebar is unavailable.');
    if (existing) {
      await existing.loadIfDeferred();
      const view = existing.view;
      // Reopen the same view so its conversation and in-flight answer survive the move.
      await existing.setViewState({ type: 'empty' });
      view.leaf = leaf;
      await leaf.open(view);
      existing.detach();
    } else {
      await leaf.setViewState({ type: CHAT_VIEW_TYPE, active: true });
    }
    await workspace.revealLeaf(leaf);
  }

  rebuildIndex(): Promise<void> {
    if (!this.sourceEvents) return Promise.reject(new Error('Prism indexes are not ready.'));
    if (this.rebuildPromise) return this.rebuildPromise;
    this.rebuildState = 'rebuilding';
    const started = Date.now();
    const rebuild = this.sourceEvents.rebuild(async () => {
      if (this.settings.searchMode === 'local') {
        if (!this.localModel || !await this.localModel.isReady()) {
          throw new LocalEmbeddingError('Local model is missing. Download it in Prism settings before rebuilding.');
        }
      }
    }).then(() => {
      this.rebuildState = 'ready';
    }, (error: unknown) => {
      this.rebuildState = 'failed';
      throw error;
    });
    this.rebuildPromise = rebuild.finally(() => {
      this.lastRebuildMs = Date.now() - started;
      this.rebuildPromise = undefined;
    });
    return this.rebuildPromise;
  }

  rebuildFromCommand(): void | Promise<void> {
    if (this.rebuildState === 'rebuilding') {
      new Notice('Prism index rebuild is already in progress.');
      return;
    }
    return this.runRebuild();
  }

  async runRebuild(): Promise<void> {
    if (this.rebuildState === 'rebuilding') {
      new Notice('Prism index rebuild is already in progress.');
      return;
    }
    try {
      const rebuild = this.rebuildIndex();
      new Notice('Prism is rebuilding the index from Vault Markdown.');
      this.refreshSettingTab();
      await rebuild;
      new Notice('Prism index rebuilt from Vault Markdown.');
    } catch (error) {
      new Notice(error instanceof LocalEmbeddingError
        ? error.message : 'Prism could not rebuild the index. Check Vault access, embedding settings, and plugin storage, then retry.');
    } finally {
      this.refreshSettingTab();
    }
  }

  async setShowVaultNotice(value: boolean): Promise<void> {
    await this.savePluginData({ showVaultNotice: value });
    this.settings = { ...this.settings, showVaultNotice: value };
  }

  async setSearchMode(searchMode: PluginSettings['searchMode']): Promise<void> {
    if (!['full-text', 'local'].includes(searchMode)) throw new Error('Unknown search mode.');
    if (this.rebuildPromise) throw new Error('Wait for the rebuild to finish before changing search mode.');
    if (searchMode === this.settings.searchMode) return;
    this.embeddingGeneration++;
    this.localEmbeddings?.dispose();
    await this.sourceEvents?.configureIndexes(async () => {
      await this.savePluginData({ searchMode,
        vectorIndex: null, vectorIndexModel: null });
      this.vectorStore = undefined;
      this.settings = { ...this.settings, searchMode };
    });
  }

  getLocalModelStatus(): string {
    return this.localModel?.status ?? 'Runtime unavailable. Reinstall Prism.';
  }

  localModelBusy(): boolean { return this.localModel?.busy ?? false; }

  async downloadLocalModel(): Promise<void> {
    if (!this.localModel) throw new Error('Local model storage is unavailable. Reinstall Prism.');
    const download = this.localModel.install();
    this.refreshSettingTab();
    try { await download; }
    finally { this.refreshSettingTab(); }
  }

  cancelLocalModelDownload(): void { this.localModel?.cancel(); }

  async setExcludedPaths(value: string): Promise<void> {
    const excludedPaths = parseExcludedPaths(value);
    await this.savePluginData({ excludedPaths });
    this.settings = { ...this.settings, excludedPaths };
    await this.sourceEvents?.removeExcluded();
  }

  async setLlmModel(value: string): Promise<void> {
    const llmModel = value.trim();
    if (llmModel !== this.settings.llmModel) this.llmSelectionGeneration++;
    await this.savePluginData({ llmModel });
    this.settings = { ...this.settings, llmModel };
  }

  async setLlmConnection(value: PluginSettings['llmConnection']): Promise<void> {
    if (!['api-key', 'chatgpt-codex', 'github-copilot'].includes(value)) throw new Error('Unknown LLM connection.');
    if (value === 'github-copilot' && !Platform.isDesktopApp) throw new LLMProviderError('unavailable');
    const changed = this.settings.llmConnection !== value;
    if (changed) this.llmSelectionGeneration++;
    await this.savePluginData({ llmConnection: value });
    if (changed) this.invalidateCopilotOperations();
    this.settings = { ...this.settings, llmConnection: value };
  }

  async setCodexModel(value: string): Promise<void> {
    const codexModel = value.trim();
    if (codexModel !== this.settings.codexModel) this.llmSelectionGeneration++;
    await this.savePluginData({ codexModel });
    this.settings = { ...this.settings, codexModel };
  }

  async setCopilotModel(value: string): Promise<void> {
    const copilotModel = value.trim();
    if (copilotModel === this.settings.copilotModel) return;
    this.llmSelectionGeneration++;
    await this.savePluginData({ copilotModel });
    this.settings = { ...this.settings, copilotModel };
    this.invalidateCopilotOperations(false);
    this.prismSettingTab?.invalidateConnectionTest();
  }

  setLlmApiKey(value: string): void {
    if (this.app.secretStorage.getSecret('prism-llm-api-key') !== value.trim()) this.llmSelectionGeneration++;
    this.app.secretStorage.setSecret('prism-llm-api-key', value.trim());
  }

  hasLlmApiKey(): boolean {
    return Boolean(this.app.secretStorage.getSecret('prism-llm-api-key'));
  }

  private async savePluginData(changes: Record<string, unknown>): Promise<void> {
    const write = this.dataWrite.then(async () => {
      const updated = { ...this.savedData, ...changes };
      delete updated.allowRemoteEmbeddingIndexing;
      delete updated.embeddingModel;
      delete updated.copilotClientId;
      delete updated.copilotCredential;
      delete updated.copilotAccessToken;
      delete updated.copilotRefreshToken;
      delete updated.copilotCliPath;
      await this.saveData(updated);
      this.savedData = updated;
    });
    this.dataWrite = write.catch(() => undefined);
    await write;
  }
}

class PrismSettingTab extends PluginSettingTab {
  private visible = false;
  private activeConnectionTest?: object;
  private connectionTestResult?: string;
  private settingsToLabel: Array<{ setting: Setting; name: string }> = [];

  constructor(private readonly prism: PrismPlugin) {
    super(prism.app, prism);
  }

  invalidateConnectionTest(): void {
    this.activeConnectionTest = undefined;
    this.connectionTestResult = undefined;
  }

  hide(): void {
    this.visible = false;
    this.invalidateConnectionTest();
  }

  private async loadCodexModels(force: boolean): Promise<void> {
    const accountId = this.prism.getCodexStatus().accountId;
    if (!accountId || this.prism.getCodexStatus().modelState === 'loading') return;
    const loading = this.prism.refreshCodexModels(force);
    this.display();
    try { await loading; } catch { /* The catalog stores a safe error for the settings UI. */ }
    if (this.visible && this.prism.settings.llmConnection === 'chatgpt-codex' &&
        accountId === this.prism.getCodexStatus().accountId) this.display();
  }

  private async loadCopilotModels(force: boolean): Promise<void> {
    const account = this.prism.getCopilotStatus().account;
    const accountKey = account ? `${account.host}/${account.login.toLowerCase()}` : undefined;
    if (!accountKey || this.prism.getCopilotStatus().modelState === 'loading') return;
    const loading = this.prism.refreshCopilotModels(force);
    this.display();
    try { await loading; } catch { /* The catalog stores a safe error for the settings UI. */ }
    const currentAccount = this.prism.getCopilotStatus().account;
    if (this.visible && this.prism.settings.llmConnection === 'github-copilot' &&
        accountKey === (currentAccount ? `${currentAccount.host}/${currentAccount.login.toLowerCase()}` : undefined)) {
      this.display();
    }
  }

  private createSetting(container: HTMLElement, name: string, iconName: Parameters<typeof setIcon>[1],
    description?: string): Setting {
    const setting = new Setting(container).setName(name);
    if (description) {
      setting.setDesc(description);
      setting.descEl.id = `prism-setting-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-description`;
    }
    const icon = setting.nameEl.createSpan();
    icon.setAttribute('aria-hidden', 'true');
    icon.setAttribute('focusable', 'false');
    setIcon(icon, iconName);
    this.settingsToLabel.push({ setting, name });
    return setting;
  }

  private setIconButton(button: ButtonComponent, icon: Parameters<typeof setIcon>[1],
    tooltip: string, description?: string): void {
    button.setIcon(icon).setTooltip(tooltip);
    // Obsidian reads the tooltip from aria-label, so keep both strings identical.
    button.buttonEl.setAttribute('aria-label', tooltip);
    if (description) button.buttonEl.setAttribute('aria-description', description);
  }

  private localModelStatus(): string {
    if (this.prism.localModelBusy()) return 'Downloading…';
    const status = this.prism.getLocalModelStatus();
    if (status.startsWith('Local model downloaded.')) return 'Ready';
    if (status.startsWith('Download cancelled.')) return 'Cancelled';
    if (status.startsWith('Model download failed.')) return 'Download failed; check network and storage.';
    if (status.startsWith('Runtime unavailable.')) return 'Reinstall Prism to restore the runtime.';
    if (status.startsWith('Downloading / checking ')) return 'Downloading…';
    if (status.startsWith('Not checked')) return 'Not checked';
    return 'Not checked';
  }

  private modelListStatus(state: 'idle' | 'loading' | 'ready' | 'error', count: number): string | undefined {
    if (state === 'loading') return 'Loading…';
    if (state === 'error') return 'Models unavailable; refresh to retry.';
    return count ? undefined : 'No models available';
  }

  private addIconNotice(container: HTMLElement, iconName: Parameters<typeof setIcon>[1], text: string): void {
    const notice = container.createEl('p');
    const icon = notice.createSpan();
    icon.setAttribute('aria-hidden', 'true');
    icon.setAttribute('focusable', 'false');
    setIcon(icon, iconName);
    notice.createSpan({ text });
  }

  private associateSettingControls(): void {
    for (const { setting, name } of this.settingsToLabel) {
      const descriptionId = setting.descEl.id;
      for (const component of setting.components) {
        const controls = component as unknown as {
          inputEl?: HTMLElement;
          selectEl?: HTMLElement;
          toggleEl?: HTMLElement;
          buttonEl?: HTMLElement;
        };
        for (const control of [controls.inputEl, controls.selectEl, controls.toggleEl, controls.buttonEl]) {
          if (!control) continue;
          if (descriptionId && !control.getAttribute('aria-description')) {
            control.setAttribute('aria-describedby', descriptionId);
          }
          if (control !== controls.buttonEl) control.setAttribute('aria-label', name);
          else if (!control.getAttribute('aria-label') && !control.textContent?.trim()) {
            control.setAttribute('aria-label', name);
          }
        }
      }
    }
  }

  display(): void {
    this.visible = true;
    const { containerEl } = this;
    this.settingsToLabel = [];
    containerEl.empty();

    const connection = this.prism.settings.llmConnection;
    const destination = connection === 'api-key' ? 'api.openai.com'
      : connection === 'chatgpt-codex' ? 'chatgpt.com' : 'GitHub Copilot';

    this.createSetting(containerEl, 'Vault reminder', 'info')
      .addToggle((toggle) => toggle
        .setValue(this.prism.settings.showVaultNotice)
        .onChange(async (value) => {
          try {
            await this.prism.setShowVaultNotice(value);
            this.display();
          } catch {
            toggle.setValue(this.prism.settings.showVaultNotice);
            new Notice('Could not save; retry.');
          }
        }));

    if (this.prism.settings.showVaultNotice) {
      this.addIconNotice(containerEl, 'info', 'Vault Markdown is the source of truth.');
    }

    if (connection === 'github-copilot' && !Platform.isDesktopApp) {
      this.addIconNotice(containerEl, 'plug', 'GitHub Copilot requires Desktop; choose another connection.');
    } else {
      this.addIconNotice(containerEl, 'shield',
        `Answers send questions, history and retrieved note text to ${destination}.`);
      this.addIconNotice(containerEl, 'shield',
        `Search frontmatter sends only the active note body to ${destination} after you confirm.`);
    }

    this.createSetting(containerEl, 'Search method', 'search',
      'Changing methods clears vectors and requires a rebuild.')
      .addDropdown((dropdown) => dropdown
        .addOption('full-text', 'Local full-text')
        .addOption('local', 'Local Embedding')
        .setValue(this.prism.settings.searchMode)
        .onChange(async (value) => {
          try {
            await this.prism.setSearchMode(value as PluginSettings['searchMode']);
            new Notice('Search changed; rebuild the index.');
            this.display();
          } catch {
            dropdown.setValue(this.prism.settings.searchMode);
            new Notice(this.prism.getIndexStatus().state === 'rebuilding'
              ? 'Wait for the rebuild to finish.' : 'Could not save; retry.');
          }
        }));

    const downloadDescription = 'Download/repair ~129 MiB from huggingface.co/CDN/Xet (high RAM; mobile memory risk; no Vault text is sent).';
    this.createSetting(containerEl, 'Local Embedding model', 'download', this.localModelStatus())
      .addButton((button) => {
        this.setIconButton(button, 'download', downloadDescription, downloadDescription);
        button.setDisabled(this.prism.localModelBusy()).onClick(async () => {
          try {
            await this.prism.downloadLocalModel();
            new Notice('Model ready; rebuild the index.');
          } catch {
            if (this.localModelStatus() !== 'Cancelled') {
              new Notice('Download failed; check network and storage.');
            }
          }
        });
      })
      .addButton((button) => {
        this.setIconButton(button, 'x', 'Cancel download');
        button.setDisabled(!this.prism.localModelBusy())
          .onClick(() => this.prism.cancelLocalModelDownload());
      });

    this.createSetting(containerEl, 'LLM connection', 'plug')
      .addDropdown((dropdown) => {
        dropdown.addOption('api-key', 'OpenAI API key')
          .addOption('chatgpt-codex', 'ChatGPT (Codex, experimental)');
        if (Platform.isDesktopApp || this.prism.settings.llmConnection === 'github-copilot') {
          dropdown.addOption('github-copilot', Platform.isDesktopApp
            ? 'GitHub Copilot (Desktop)' : 'GitHub Copilot (Desktop only)');
        }
        dropdown.setValue(this.prism.settings.llmConnection).onChange(async (value) => {
          try {
            await this.prism.setLlmConnection(value as PluginSettings['llmConnection']);
            this.invalidateConnectionTest();
            this.display();
          } catch {
            this.display();
            new Notice('Could not change connection.');
          }
        });
      });

    const codexStatus = this.prism.getCodexStatus();
    const codexModels = codexStatus.models;
    const copilotStatus = this.prism.getCopilotStatus();
    const copilotModels = copilotStatus.models;
    const modelName = connection === 'api-key' ? 'LLM model' : connection === 'chatgpt-codex' ? 'Codex model' : 'Copilot model';
    const modelDescription = connection === 'github-copilot' && !Platform.isDesktopApp ? 'Desktop only' : undefined;
    const modelSetting = this.createSetting(containerEl, modelName, 'bot', modelDescription);
    if (this.prism.settings.llmConnection === 'chatgpt-codex') {
      const selected = this.prism.settings.codexModel;
      modelSetting.addDropdown((dropdown) => {
        if (!selected) dropdown.addOption('', codexModels.length ? 'Choose a model' : 'No models available');
        if (selected && !codexModels.includes(selected)) dropdown.addOption(selected, `${selected} (saved)`);
        for (const model of codexModels) dropdown.addOption(model, model);
        dropdown.setValue(selected).onChange(async (value) => {
          try {
            await this.prism.setCodexModel(value);
            this.invalidateConnectionTest();
          } catch { new Notice('Could not save model; retry.'); }
        });
      });
    } else if (connection === 'github-copilot' && Platform.isDesktopApp) {
      const selected = this.prism.settings.copilotModel;
      modelSetting.addDropdown((dropdown) => {
        if (!selected) dropdown.addOption('', copilotModels.length ? 'Choose a model' : 'No models available');
        if (selected && !copilotModels.some((model) => model.id === selected)) dropdown.addOption(selected, `${selected} (saved)`);
        for (const model of copilotModels) dropdown.addOption(model.id, model.name);
        dropdown.setValue(selected).onChange(async (value) => {
          try {
            await this.prism.setCopilotModel(value);
            this.invalidateConnectionTest();
          } catch { new Notice('Could not save model; retry.'); }
        });
      });
    } else if (connection === 'api-key') {
      modelSetting.addText((text) => text
        .setPlaceholder('Model ID')
        .setValue(this.prism.settings.llmModel)
        .onChange(async (value) => {
          try {
            await this.prism.setLlmModel(value);
          } catch { new Notice('Could not save model; retry.'); }
        }));
    }

    if (connection === 'github-copilot' && Platform.isDesktopApp) {
      const { account, modelState } = copilotStatus;
      this.createSetting(containerEl, 'GitHub account', 'user', account
        ? `Connected: ${account.login} (${account.host})`
        : 'Run copilot login, then check CLI login.')
        .addButton((button) => button.setButtonText('Check CLI login')
          .onClick(async () => {
            try { await this.prism.checkCopilotLogin(); this.display(); }
            catch (error) { new Notice(copilotLoginFailureNotice(error)); }
          }))
        .addButton((button) => button.setButtonText('Disconnect Prism')
          .setTooltip('Disconnect Prism without signing out of the CLI.')
          .setDisabled(!account)
          .onClick(async () => {
            this.invalidateConnectionTest();
            try { await this.prism.disconnectCopilot(); this.display(); }
            catch { new Notice('Could not disconnect Prism; retry.'); }
          }));
      if (account) {
        this.createSetting(containerEl, 'Copilot models', 'list',
          this.modelListStatus(modelState, copilotModels.length))
          .addButton((button) => {
            this.setIconButton(button, 'refresh-cw', 'Refresh models');
            button.setDisabled(modelState === 'loading')
              .onClick(() => this.loadCopilotModels(true));
          });
        if (modelState === 'idle' && !copilotModels.length) {
          void Promise.resolve().then(() => {
            if (this.visible && this.prism.settings.llmConnection === 'github-copilot' &&
                this.prism.getCopilotStatus().modelState === 'idle') return this.loadCopilotModels(false);
          });
        }
      }
      this.createSetting(containerEl, 'Connection test', 'plug', account
        ? 'Sends only “Reply with OK.” to GitHub Copilot.'
        : 'Check CLI login first.')
        .addButton((button) => button.setButtonText(this.activeConnectionTest ? 'Testing…' : 'Test connection')
          .setDisabled(!account || !this.prism.settings.copilotModel.trim() || Boolean(this.activeConnectionTest))
          .onClick(async () => {
            if (this.activeConnectionTest || !this.prism.getCopilotStatus().account) return;
            const run = {};
            this.activeConnectionTest = run;
            this.connectionTestResult = undefined;
            this.display();
            let result: string;
            try {
              await this.prism.testCopilotConnection();
              result = 'Connection successful.';
            } catch (error) {
              const reason = error instanceof LLMProviderError
                ? ({ authentication: 'Run copilot login, then check CLI login.',
                    rate_limit: 'Rate limited; retry later.',
                    usage_limit: 'Check account usage or retry later.',
                    quota: 'Check account usage.',
                    context_limit: 'Shorten the request.',
                    unavailable: 'Check the CLI and network, then retry.',
                    invalid_request: 'Check the CLI installation and selected model.',
                    unknown: 'Retry the connection test.' }[error.code] ?? 'Retry the connection test.')
                : 'Retry the connection test.';
              result = `Failed: ${reason}`;
            }
            if (this.activeConnectionTest !== run ||
                this.prism.settings.llmConnection !== 'github-copilot') return;
            this.activeConnectionTest = undefined;
            this.connectionTestResult = result;
            new Notice(result);
            this.display();
          }));
      if (this.connectionTestResult) {
        const result = containerEl.createEl('p', { text: this.connectionTestResult });
        result.setAttr('role', 'status');
      }
    }

    if (connection === 'chatgpt-codex') {
      this.addIconNotice(containerEl, 'info',
        'Experimental sign-in uses auth.openai.com.');
      const { accountId, prompt, modelState } = codexStatus;
      const accountSetting = this.createSetting(containerEl, 'ChatGPT account', 'user',
        accountId ? `Connected: ${accountId}` : prompt ? 'Complete browser sign-in.' : 'Not connected.');
      accountSetting
        .addButton((button) => button
          .setButtonText(accountId ? 'Reconnect' : 'Connect')
          .setDisabled(Boolean(prompt))
          .onClick(async () => {
            try { await this.prism.startCodexLogin(); this.display(); }
            catch { new Notice('Prism could not start ChatGPT authorization.'); }
          }))
        .addButton((button) => button
          .setButtonText('Sign out')
          .setDisabled(!accountId && !prompt)
          .onClick(() => { this.invalidateConnectionTest(); this.prism.signOutCodex(); this.display(); }));
      if (prompt) {
        containerEl.createEl('p', { text: `Enter code ${prompt.userCode}.` });
        const link = containerEl.createEl('a', { text: 'Open sign-in', href: prompt.verificationUrl });
        link.setAttr('target', '_blank');
        accountSetting.addButton((button) => {
          this.setIconButton(button, 'x', 'Cancel sign-in');
          button.onClick(() => { this.prism.cancelCodexLogin(); this.display(); });
        });
      }
      if (accountId) {
        this.createSetting(containerEl, 'Codex models', 'list',
          this.modelListStatus(modelState, codexModels.length))
          .addButton((button) => {
            this.setIconButton(button, 'refresh-cw', 'Refresh models');
            button.setDisabled(modelState === 'loading')
              .onClick(() => this.loadCodexModels(true));
          });
        if (modelState === 'idle' && !codexModels.length) {
          void Promise.resolve().then(() => {
            if (this.visible && this.prism.settings.llmConnection === 'chatgpt-codex' &&
                this.prism.getCodexStatus().modelState === 'idle') return this.loadCodexModels(false);
          });
        }
      }
      this.createSetting(containerEl, 'Connection test', 'plug', accountId
        ? 'Sends only “Reply with OK.” to chatgpt.com.'
        : 'Connect ChatGPT first.')
        .addButton((button) => button
          .setButtonText(this.activeConnectionTest ? 'Testing…' : 'Test connection')
          .setDisabled(!accountId || Boolean(this.activeConnectionTest))
          .onClick(async () => {
            if (this.activeConnectionTest || !this.prism.getCodexStatus().accountId) return;
            const run = {};
            this.activeConnectionTest = run;
            this.connectionTestResult = undefined;
            this.display();
            let result: string;
            try {
              await this.prism.testCodexConnection();
              result = 'Connection successful.';
            } catch (error) {
              const reason = error instanceof LLMProviderError
                ? ({ authentication: 'Reconnect ChatGPT.',
                    rate_limit: 'Rate limited; retry later.',
                    usage_limit: 'Check account usage or retry later.',
                    quota: 'Check account usage.',
                    context_limit: 'Shorten the request.',
                    unavailable: 'Check the network and retry.',
                    invalid_request: 'Choose another model.',
                    unknown: 'Retry the connection test.' }[error.code] ?? 'Retry the connection test.')
                : 'Retry the connection test.';
              result = `Failed: ${reason}`;
            }
            if (this.activeConnectionTest !== run ||
                this.prism.settings.llmConnection !== 'chatgpt-codex') return;
            this.activeConnectionTest = undefined;
            this.connectionTestResult = result;
            new Notice(result);
            this.display();
          }));
      if (this.connectionTestResult) {
        const result = containerEl.createEl('p', { text: this.connectionTestResult });
        result.setAttr('role', 'status');
      }
    }

    this.addApiKeySetting('LLM API key', this.prism.hasLlmApiKey(),
      (value) => this.prism.setLlmApiKey(value));

    containerEl.createEl('h3', { text: 'Advanced' });
    const status = this.prism.getIndexStatus();
    this.createSetting(containerEl, 'Index status', 'database',
      `${status.state} · ${status.sources} sources · ${status.chunks} chunks${status.lastRebuildMs !== undefined
        ? ` · Rebuild: ${status.lastRebuildMs} ms` : ''}`);
    let readExclusions = () => this.prism.settings.excludedPaths.join('\n');
    this.createSetting(containerEl, 'Excluded paths', 'folder',
      'One Vault path per line; rebuild after removing exclusions.')
      .addTextArea((text) => {
        text.setPlaceholder('Private/\nDraft.md')
          .setValue(this.prism.settings.excludedPaths.join('\n'));
        readExclusions = () => text.getValue();
      })
      .addButton((button) => button
        .setButtonText('Apply')
        .onClick(async () => {
          try {
            await this.prism.setExcludedPaths(readExclusions());
            new Notice('Exclusions applied.');
            this.display();
          } catch {
            new Notice('Could not apply exclusions; check paths and storage.');
          }
        }));
    this.createSetting(containerEl, 'Rebuild index', 'refresh-cw',
      'Rebuilds locally; no Vault text is sent or changed.')
      .addButton((button) => button
        .setButtonText('Rebuild')
        .setDisabled(status.state === 'rebuilding')
        .onClick(() => this.prism.runRebuild()));
    this.associateSettingControls();
  }

  private addApiKeySetting(name: string, configured: boolean, save: (value: string) => void): void {
    this.createSetting(this.containerEl, name, 'key', configured
      ? 'Configured in Obsidian Secret Storage.'
      : 'Saved in Obsidian Secret Storage on field exit.')
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
            new Notice('Could not save key; retry.');
          }
        });
      })
      .addButton((button) => {
        this.setIconButton(button, 'trash-2', 'Clear API key');
        button.onClick(() => {
          try {
            save('');
            this.display();
          } catch {
            new Notice('Could not clear key; retry.');
          }
        });
      });
  }
}
