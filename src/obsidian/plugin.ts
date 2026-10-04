import { Notice, Plugin, PluginSettingTab, Setting, TFile } from 'obsidian';
import { CitationAnswerer, type CitedAnswer, type SourceCitation } from '../core/application/citation-answerer';
import { RagPipeline } from '../core/application/rag-pipeline';
import type { ConversationExchange } from '../core/application/conversation-history';
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
import { LLMProviderError } from '../core/provider/llm-provider';
import { CHAT_VIEW_TYPE, PrismChatView } from './chat-view';
import { loadSettings, type PluginSettings } from '../settings';
import { LocalEmbeddingModel } from './local-embedding-model';
import { LocalEmbeddingProvider } from './local-embedding-provider';
import { LOCAL_MODEL_KEY } from '../core/provider/local-embedding-model';
import { LocalEmbeddingError } from '../core/provider/local-embedding-error';

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
  private prismSettingTab?: PrismSettingTab;
  private localModel?: LocalEmbeddingModel;
  private localEmbeddings?: LocalEmbeddingProvider;
  private embeddingGeneration = 0;
  private lastRebuildMs?: number;

  async onload(): Promise<void> {
    const loaded = await this.loadData();
    this.savedData = typeof loaded === 'object' && loaded !== null && !Array.isArray(loaded)
      ? loaded as Record<string, unknown> : {};
    this.settings = loadSettings(this.savedData);
    const legacySettings = ['allowRemoteEmbeddingIndexing', 'embeddingModel']
      .some((key) => Object.prototype.hasOwnProperty.call(this.savedData, key)) || this.savedData.searchMode === 'openai';
    const obsoleteVectors = (this.savedData.vectorIndex != null || this.savedData.vectorIndexModel != null) &&
      this.savedData.vectorIndexModel !== LOCAL_MODEL_KEY;
    if (this.app.secretStorage.getSecret('prism-embedding-api-key')) {
      this.app.secretStorage.setSecret('prism-embedding-api-key', '');
    }
    if (legacySettings || obsoleteVectors) {
      await this.savePluginData({ searchMode: this.settings.searchMode,
        ...(obsoleteVectors ? { vectorIndex: null, vectorIndexModel: null } : {}) });
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
      generate: async (request) => {
        if (this.settings.llmConnection === 'chatgpt-codex') {
          if (!this.codexAuth) throw new Error('ChatGPT connection is not ready.');
          return new CodexLLMProvider(this.codexAuth, this.settings.codexModel).generate(request);
        }
        const key = this.app.secretStorage.getSecret('prism-llm-api-key');
        if (!key || !this.settings.llmModel.trim()) {
          throw new Error('Configure an LLM model and API key before asking Prism.');
        }
        return new OpenAILLMProvider(key, this.settings.llmModel).generate(request);
      },
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
      return sourceEvents.rename(file, oldPath).catch(() => new Notice('Prism could not move a Markdown source. Check plugin storage.'));
    }));
    this.registerEvent(this.app.vault.on('delete', (file) => {
      return sourceEvents.delete(file).catch(() => new Notice('Prism could not remove a Markdown source. Check plugin storage.'));
    }));
    this.registerView(CHAT_VIEW_TYPE, (leaf) => new PrismChatView(
      leaf, (query, history) => this.answerQuery(query, history), (citation) => this.openCitation(citation)));
    const showChat = () => this.openChatView().catch(() => {
      new Notice('Prism could not open the Ask view. Try again.');
    });
    this.addCommand({ id: 'open-chat', name: 'Open Ask view', callback: showChat });
    this.addCommand({ id: 'rebuild-index', name: 'Rebuild index', callback: () => this.rebuildFromCommand() });
    this.addRibbonIcon('message-square', 'Open Prism Ask', showChat);
    this.prismSettingTab = new PrismSettingTab(this);
    this.addSettingTab(this.prismSettingTab);
  }

  onunload(): void {
    this.embeddingGeneration++;
    this.localModel?.cancel();
    this.localEmbeddings?.dispose();
    this.codexAuth?.cancelPending();
    this.prismSettingTab?.invalidateConnectionTest();
  }

  getCodexStatus(): { accountId?: string; prompt?: DevicePrompt; models: readonly string[]; modelState: 'idle' | 'loading' | 'ready' | 'error'; modelError?: string } {
    return { accountId: this.codexAuth?.accountId, prompt: this.codexPrompt,
      models: this.codexAuth?.availableModels ?? [], modelState: this.codexAuth?.modelListState ?? 'idle',
      modelError: this.codexAuth?.modelListError };
  }

  async startCodexLogin(): Promise<void> {
    if (!this.codexAuth) throw new Error('ChatGPT connection is not ready.');
    const prompt = await this.codexAuth.startDeviceLogin();
    this.codexPrompt = prompt;
    void prompt.complete.then(async () => {
      if (this.codexPrompt === prompt) this.codexPrompt = undefined;
      this.prismSettingTab?.invalidateConnectionTest();
      try { await this.codexAuth?.listModels(true); }
      catch (error) { new Notice(error instanceof CodexModelListError
        ? error.message : 'ChatGPT connected, but Prism could not load available Codex models.'); }
      new Notice('ChatGPT account connected to Prism.');
      this.refreshSettingTab();
    }, () => {
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
    const metrics = this.localEmbeddings?.metrics;
    return `${this.localModel?.status ?? 'Runtime unavailable. Reinstall Prism.'}${metrics?.loadMs
      ? ` Last load: ${Math.round(metrics.loadMs)} ms; inference: ${Math.round(metrics.inferenceMs)} ms / ${metrics.texts} texts; model + WASM buffers: ${(metrics.modelBytes / 1048576).toFixed(1)} MiB (not peak memory).` : ''}`;
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
    await this.savePluginData({ llmModel });
    this.settings = { ...this.settings, llmModel };
  }

  async setLlmConnection(value: 'api-key' | 'chatgpt-codex'): Promise<void> {
    await this.savePluginData({ llmConnection: value });
    this.settings = { ...this.settings, llmConnection: value };
  }

  async setCodexModel(value: string): Promise<void> {
    const codexModel = value.trim();
    await this.savePluginData({ codexModel });
    this.settings = { ...this.settings, codexModel };
  }

  setLlmApiKey(value: string): void {
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

  display(): void {
    this.visible = true;
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
      text: 'Remote processing: Search indexing and query embeddings run on this device. For answers, your selected OpenAI connection receives your query, up to 6 recent question/answer pairs (12,000 UTF-8 bytes), plus retrieved source IDs, chunk IDs, and text. API-key answers go to https://api.openai.com/v1/responses; ChatGPT (Codex) answers go to https://chatgpt.com/backend-api/codex/responses. This data leaves your Vault for those requests.',
    });

    new Setting(containerEl)
      .setName('Search method')
      .setDesc('Local full-text sends no search data. Local Embedding runs on this device. Changing method clears vectors; rebuild to include existing notes. Answers still send retrieved text to the selected LLM.')
      .addDropdown((dropdown) => dropdown
        .addOption('full-text', 'Local full-text')
        .addOption('local', 'Local Embedding (multilingual, WASM)')
        .setValue(this.prism.settings.searchMode)
        .onChange(async (value) => {
          try {
            await this.prism.setSearchMode(value as PluginSettings['searchMode']);
            new Notice('Search method changed. Rebuild the index for existing notes.');
            this.display();
          } catch (error) {
            dropdown.setValue(this.prism.settings.searchMode);
            new Notice(this.prism.getIndexStatus().state === 'rebuilding'
              ? 'Wait for the rebuild to finish before changing search method.' : 'Could not save search method. Try again.');
          }
        }));

    new Setting(containerEl)
      .setName('Local Embedding model')
      .setDesc(`Multilingual MiniLM-L12-v2, Apache-2.0, q8 / 384 dimensions. Download ~129 MiB from huggingface.co (redirects to Hugging Face CDN / Xet storage) for on-device search; no Vault text or questions are sent. Stored under the Prism plugin directory, models/. WASM runtime ships with Prism. Desktop, iOS and Android use a single-thread WASM worker; requires WASM SIMD and module workers. Loading can use hundreds of MiB to over 1 GiB; mobile may be slower or run out of memory. Real-device validation is pending. ${this.prism.getLocalModelStatus()}`)
      .addButton((button) => button.setButtonText('Download / repair model')
        .setDisabled(this.prism.localModelBusy())
        .onClick(async () => {
          try { await this.prism.downloadLocalModel(); new Notice('Local model ready. Rebuild the index.'); }
          catch (error) { new Notice(error instanceof Error ? error.message : 'Could not download local model.'); }
        }))
      .addButton((button) => button.setButtonText('Cancel download')
        .setDisabled(!this.prism.localModelBusy())
        .onClick(() => this.prism.cancelLocalModelDownload()));

    new Setting(containerEl)
      .setName('LLM connection')
      .setDesc('Choose which account pays for answers. Prism never switches connections after an error.')
      .addDropdown((dropdown) => dropdown
        .addOption('api-key', 'OpenAI API key')
        .addOption('chatgpt-codex', 'ChatGPT (Codex, experimental)')
        .setValue(this.prism.settings.llmConnection)
        .onChange(async (value) => {
          try {
            await this.prism.setLlmConnection(value as 'api-key' | 'chatgpt-codex');
            this.invalidateConnectionTest();
            this.display();
          } catch { new Notice('Prism could not change the LLM connection.'); }
        }));

    const codexModels = this.prism.getCodexStatus().models;
    const modelSetting = new Setting(containerEl)
      .setName(this.prism.settings.llmConnection === 'api-key' ? 'LLM model' : 'Codex model')
      .setDesc(this.prism.settings.llmConnection === 'api-key' ? 'OpenAI model ID used for answers.'
        : codexModels.length ? 'Select a model returned for this account. Test the connection to verify access.'
          : 'The model list loads when connected. Use Refresh models to retry; your saved model is retained.');
    if (this.prism.settings.llmConnection === 'chatgpt-codex') {
      const selected = this.prism.settings.codexModel;
      modelSetting.addDropdown((dropdown) => {
        if (!selected) dropdown.addOption('', codexModels.length ? 'Choose a model' : 'No models available');
        if (selected && !codexModels.includes(selected)) dropdown.addOption(selected, `${selected} (saved model)`);
        for (const model of codexModels) dropdown.addOption(model, model);
        dropdown.setValue(selected).onChange(async (value) => {
          try {
            await this.prism.setCodexModel(value);
            this.invalidateConnectionTest();
          } catch { new Notice('Prism could not save the model. Try again.'); }
        });
      });
    } else {
      modelSetting.addText((text) => text
        .setPlaceholder('Model ID')
        .setValue(this.prism.settings.llmModel)
        .onChange(async (value) => {
          try {
            await this.prism.setLlmModel(value);
          } catch { new Notice('Prism could not save the model. Try again.'); }
        }));
    }

    if (this.prism.settings.llmConnection === 'chatgpt-codex') {
      containerEl.createEl('p', { text: 'Experimental Codex compatibility uses a ChatGPT account with Codex access. It uses an interface that can change. Device authorization contacts https://auth.openai.com. You may need to enable device-code sign-in in ChatGPT settings.' });
      const { accountId, prompt, modelState, modelError } = this.prism.getCodexStatus();
      new Setting(containerEl)
        .setName('ChatGPT account')
        .setDesc(accountId ? `Saved account: ${accountId}` : prompt ? 'Complete authorization in your browser.' : 'Not connected on this device.')
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
        containerEl.createEl('p', { text: `Enter code ${prompt.userCode} at the OpenAI device sign-in page.` });
        const link = containerEl.createEl('a', { text: 'Open ChatGPT device sign-in', href: prompt.verificationUrl });
        link.setAttr('target', '_blank');
        new Setting(containerEl).addButton((button) => button.setButtonText('Cancel sign-in')
          .onClick(() => { this.prism.cancelCodexLogin(); this.display(); }));
      }
      if (accountId) {
        new Setting(containerEl).setName('Codex models')
          .setDesc(`Sends the OAuth token to chatgpt.com to load listed model names. No Vault content is sent. Use Test ChatGPT connection to verify the selected model. ${modelState === 'loading' ? 'Loading models...' : modelError ?? ''}`)
          .addButton((button) => button.setButtonText(modelState === 'loading' ? 'Loading models...' : 'Refresh models')
            .setDisabled(modelState === 'loading').onClick(() => this.loadCodexModels(true)));
        if (modelState === 'idle' && !codexModels.length) {
          void Promise.resolve().then(() => {
            if (this.visible && this.prism.settings.llmConnection === 'chatgpt-codex' &&
                this.prism.getCodexStatus().modelState === 'idle') return this.loadCodexModels(false);
          });
        }
      }
      new Setting(containerEl)
        .setName('Test ChatGPT connection')
        .setDesc(accountId
          ? 'Sends only "Reply with OK." to https://chatgpt.com/backend-api/codex/responses. No Vault content is sent.'
          : 'Connect a ChatGPT account on this device to test the connection.')
        .addButton((button) => button
          .setButtonText(this.activeConnectionTest ? 'Testing...' : 'Test connection')
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
              result = 'Success: ChatGPT (Codex) responded to the connection test.';
            } catch (error) {
              const reason = error instanceof LLMProviderError
                ? ({ authentication: 'Authentication failed. Reconnect your ChatGPT account.',
                    rate_limit: 'The account is rate limited or has reached its quota.',
                    usage_limit: 'The account is rate limited or has reached its quota.',
                    quota: 'The account has reached its usage quota. Check account usage.',
                    context_limit: 'The request exceeds the model context limit.',
                    unavailable: 'The Codex service or network is unavailable. Try again.',
                    invalid_request: 'The selected model or account is not permitted to make this request.',
                    unknown: 'The Codex response was incomplete or invalid.' }[error.code])
                : 'Connection test could not run. Check the selected model and try again.';
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
    new Setting(containerEl)
      .setName('Index status')
      .setDesc(`Status: ${status.state}. ${status.sources} sources, ${status.chunks} chunks.${status.lastRebuildMs !== undefined
        ? ` Last rebuild: ${status.lastRebuildMs} ms.` : ''}`);
    let readExclusions = () => this.prism.settings.excludedPaths.join('\n');
    new Setting(containerEl)
      .setName('Excluded paths')
      .setDesc('One Vault-relative Markdown file or folder path per line. Folder paths include descendants. Applying removes matching indexed data; rebuild after removing a rule to include those notes again.')
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
            new Notice('Prism index exclusions applied.');
            this.display();
          } catch {
            new Notice('Prism could not apply index exclusions. Check paths and plugin storage, then retry.');
          }
        }));
    new Setting(containerEl)
      .setName('Rebuild index')
      .setDesc('Recreate search indexes from Vault Markdown on this device. No Vault text is sent for indexing.')
      .addButton((button) => button
        .setButtonText('Rebuild')
        .setDisabled(status.state === 'rebuilding')
        .onClick(() => this.prism.runRebuild()));
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
