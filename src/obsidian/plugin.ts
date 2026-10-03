import { Modal, Notice, Plugin, PluginSettingTab, Setting, TFile } from 'obsidian';
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
import { OpenAIEmbeddingProvider } from './openai-embedding-provider';
import { OpenAILLMProvider } from './openai-llm-provider';
import { CodexAuth, CodexModelListError, type DevicePrompt } from './codex-auth';
import { CodexLLMProvider } from './codex-llm-provider';
import { LLMProviderError } from '../core/provider/llm-provider';
import { CHAT_VIEW_TYPE, PrismChatView } from './chat-view';
import { loadSettings, type PluginSettings } from '../settings';

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
  private codexAuth?: CodexAuth;
  private codexPrompt?: DevicePrompt;
  private prismSettingTab?: PrismSettingTab;

  async onload(): Promise<void> {
    const loaded = await this.loadData();
    this.savedData = typeof loaded === 'object' && loaded !== null && !Array.isArray(loaded)
      ? loaded as Record<string, unknown> : {};
    this.settings = loadSettings(this.savedData);
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
      if (!this.settings.allowRemoteEmbeddingIndexing ||
          this.savedData.vectorIndexModel !== this.settings.embeddingModel) return [];
      const store = await getVectorStore();
      const key = this.app.secretStorage.getSecret('prism-embedding-api-key');
      if (!store || !key || !this.settings.embeddingModel.trim()) return [];
      return new OpenAIEmbeddingProvider(key, this.settings.embeddingModel).embed(query);
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
    this.codexAuth?.cancelPending();
    this.prismSettingTab?.invalidateConnectionTest();
  }

  getCodexStatus(): { accountId?: string; prompt?: DevicePrompt; models: readonly string[] } {
    return { accountId: this.codexAuth?.accountId, prompt: this.codexPrompt,
      models: this.codexAuth?.availableModels ?? [] };
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

  async refreshCodexModels(): Promise<void> {
    if (!this.codexAuth) throw new Error('ChatGPT connection is not ready.');
    await this.codexAuth.listModels(true);
  }

  async testCodexConnection(): Promise<void> {
    if (this.settings.llmConnection !== 'chatgpt-codex' || !this.codexAuth?.connected) {
      throw new LLMProviderError('authentication');
    }
    await new CodexLLMProvider(this.codexAuth, this.settings.codexModel).generate({
      messages: [{ role: 'user', content: 'Reply with OK.' }],
      context: [],
    });
  }

  private refreshSettingTab(): void {
    this.prismSettingTab?.display();
  }

  getIndexStatus(): { state: 'ready' | 'rebuilding' | 'failed'; sources: number; chunks: number } {
    const sourceIds = this.sourceRegistry?.list().map((source) => source.source_id) ?? [];
    return {
      state: this.rebuildState,
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

  private async openChatView(): Promise<void> {
    const workspace = this.app.workspace;
    const leaf = workspace.getLeavesOfType(CHAT_VIEW_TYPE)[0] ?? workspace.getLeaf(true);
    await leaf.setViewState({ type: CHAT_VIEW_TYPE, active: true });
    await workspace.revealLeaf(leaf);
  }

  rebuildIndex(): Promise<void> {
    if (!this.sourceEvents) return Promise.reject(new Error('Prism indexes are not ready.'));
    if (this.rebuildPromise) return this.rebuildPromise;
    this.rebuildState = 'rebuilding';
    const rebuild = this.sourceEvents.rebuild().then(() => {
      this.rebuildState = 'ready';
    }, (error: unknown) => {
      this.rebuildState = 'failed';
      throw error;
    });
    this.rebuildPromise = rebuild.finally(() => { this.rebuildPromise = undefined; });
    return this.rebuildPromise;
  }

  rebuildFromCommand(): void | Promise<void> {
    if (this.rebuildState === 'rebuilding') {
      new Notice('Prism index rebuild is already in progress.');
      return;
    }
    if (this.settings.allowRemoteEmbeddingIndexing) {
      new RebuildConfirmModal(this.app, () => this.runRebuild()).open();
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
    } catch {
      new Notice('Prism could not rebuild the index. Check Vault access, embedding settings, and plugin storage, then retry.');
    } finally {
      this.refreshSettingTab();
    }
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
    this.invalidateConnectionTest();
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
      text: 'Remote processing: OpenAI receives Markdown or chunk text for embeddings when enabled, and your query plus retained previous questions for vector search when a consented vector index exists. For answers, your selected OpenAI connection receives your query, up to 6 recent question/answer pairs (12,000 UTF-8 bytes), plus retrieved source IDs, chunk IDs, and text. API-key answers go to https://api.openai.com/v1/responses; ChatGPT (Codex) answers go to https://chatgpt.com/backend-api/codex/responses. This data leaves your Vault for those requests.',
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
          : 'Enter a model ID or refresh the model list to choose one.');
    if (this.prism.settings.llmConnection === 'chatgpt-codex' && codexModels.length) {
      const selected = this.prism.settings.codexModel;
      modelSetting.addDropdown((dropdown) => {
        if (!selected) dropdown.addOption('', 'Choose a model');
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
        .setValue(this.prism.settings.llmConnection === 'api-key' ? this.prism.settings.llmModel : this.prism.settings.codexModel)
        .onChange(async (value) => {
          try {
            if (this.prism.settings.llmConnection === 'api-key') await this.prism.setLlmModel(value);
            else {
              await this.prism.setCodexModel(value);
              this.invalidateConnectionTest();
            }
          } catch { new Notice('Prism could not save the model. Try again.'); }
        }));
    }

    if (this.prism.settings.llmConnection === 'chatgpt-codex') {
      containerEl.createEl('p', { text: 'Experimental Codex compatibility uses a ChatGPT account with Codex access. It uses an interface that can change. Device authorization contacts https://auth.openai.com. You may need to enable device-code sign-in in ChatGPT settings.' });
      const { accountId, prompt } = this.prism.getCodexStatus();
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
          .setDesc('Sends the OAuth token to chatgpt.com to load listed model names. No Vault content is sent. Use Test ChatGPT connection to verify the selected model.')
          .addButton((button) => button.setButtonText('Refresh models').onClick(async () => {
            try { await this.prism.refreshCodexModels(); this.display(); }
            catch (error) { new Notice(error instanceof CodexModelListError
              ? error.message : 'Prism could not load Codex models. Try again.'); }
          }));
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

    this.addApiKeySetting('Embedding API key', this.prism.hasEmbeddingApiKey(),
      (value) => this.prism.setEmbeddingApiKey(value));
    this.addApiKeySetting('LLM API key', this.prism.hasLlmApiKey(),
      (value) => this.prism.setLlmApiKey(value));

    containerEl.createEl('h3', { text: 'Advanced' });
    const status = this.prism.getIndexStatus();
    new Setting(containerEl)
      .setName('Index status')
      .setDesc(`Status: ${status.state}. ${status.sources} sources, ${status.chunks} chunks.`);
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
      .setDesc('Recreate search indexes from Vault Markdown. If remote embedding indexing is enabled, this sends Markdown chunks to OpenAI.')
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

class RebuildConfirmModal extends Modal {
  constructor(app: PrismPlugin['app'], private readonly confirm: () => Promise<void>) {
    super(app);
  }

  onOpen(): void {
    this.contentEl.createEl('h2', { text: 'Rebuild Prism index?' });
    this.contentEl.createEl('p', {
      text: 'Remote embedding indexing is enabled. Rebuilding sends Markdown chunks from included Vault notes to https://api.openai.com/v1/embeddings to recreate the search index.',
    });
    new Setting(this.contentEl)
      .addButton((button) => button.setButtonText('Cancel').onClick(() => this.close()))
      .addButton((button) => button.setButtonText('Rebuild').onClick(() => {
        this.close();
        return this.confirm();
      }));
  }
}
