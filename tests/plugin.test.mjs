import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

test('distributed plugin contains no OpenAI Embeddings API endpoint', async () => {
  const bundle = await readFile(new URL('../main.js', import.meta.url), 'utf8');
  assert.doesNotMatch(bundle, /api\.openai\.com\/v1\/embeddings/);
});

test('legacy search settings migrate to full-text while explicit local mode is preserved', async () => {
  for (const [saved, mode] of [
    [null, 'full-text'],
    [{ allowRemoteEmbeddingIndexing: true, embeddingModel: 'old' }, 'full-text'],
    [{ searchMode: 'openai', allowRemoteEmbeddingIndexing: true }, 'full-text'],
    [{ searchMode: 'local', allowRemoteEmbeddingIndexing: true }, 'local'],
    [{ searchMode: 'full-text', allowRemoteEmbeddingIndexing: true }, 'full-text'],
  ]) {
    const { plugin, requests, writes } = await loadPlugin(saved);
    assert.equal(plugin.settings.searchMode, mode);
    assert.equal('allowRemoteEmbeddingIndexing' in plugin.settings, false);
    assert.equal('embeddingModel' in plugin.settings, false);
    for (const write of writes) {
      assert.equal('allowRemoteEmbeddingIndexing' in write, false);
      assert.equal('embeddingModel' in write, false);
    }
    assert.equal(requests.length, 0);
  }
});

test('legacy credentials and vectors are removed before events, rebuilds and queries without affecting answers', async () => {
  const seed = await loadPlugin(null);
  const seedFile = new seed.MockTFile('facts.md', '# Searchable fact');
  await seed.listeners.get('create')(seedFile);
  const baseline = structuredClone(seed.writes.at(-1));
  for (const model of ['text-embedding-3-small', undefined]) {
    const secrets = new Map([
      ['prism-embedding-api-key', 'obsolete-fixture-key'],
      ['prism-llm-api-key', 'answer-fixture-key'],
      ['prism-codex-credential', 'unchanged-credential-fixture'],
    ]);
    const legacy = { ...baseline, searchMode: 'openai', allowRemoteEmbeddingIndexing: true,
      embeddingModel: 'old-model', llmModel: 'answer-model', vectorIndexModel: model,
      vectorIndex: { dimensions: 'invalid-old-dimensions', entries: [{ obsolete: true }] } };
    const { plugin, listeners, MockTFile, writes, requests, commands, tabs, modals, notices } =
      await loadPlugin(legacy, false, secrets);
    assert.equal(plugin.settings.searchMode, 'full-text');
    assert.equal(writes[0].vectorIndex, null);
    assert.equal(writes[0].vectorIndexModel, null);
    assert.deepEqual(writes[0].sourceRegistry, baseline.sourceRegistry);
    assert.deepEqual(writes[0].chunkRegistry, baseline.chunkRegistry);
    assert.deepEqual(writes[0].fullTextIndex, baseline.fullTextIndex);
    assert.equal(secrets.get('prism-embedding-api-key'), '');
    assert.equal(secrets.get('prism-llm-api-key'), 'answer-fixture-key');
    assert.equal(secrets.get('prism-codex-credential'), 'unchanged-credential-fixture');
    const file = new MockTFile('facts.md', '# Searchable fact');
    plugin.app.vault.files = [file];
    assert.equal((await plugin.answerQuery('Searchable')).citations[0].path, 'facts.md');
    file.content = '# Searchable changed fact';
    file.stat.size = file.content.length;
    await listeners.get('modify')(file);
    file.path = 'renamed.md';
    await listeners.get('rename')(file, 'facts.md');
    const excluded = new MockTFile('Private/secret.md', '# Secret');
    await plugin.setExcludedPaths('Private/');
    await listeners.get('create')(excluded);
    plugin.app.vault.files.push(excluded);
    await commands.find((command) => command.id === 'rebuild-index').callback();
    tabs[0].display();
    const settings = tabs[0].containerEl.children;
    assert.equal(settings.some((item) => ['Embedding model', 'Embedding API key'].includes(item.name)), false);
    assert.equal('openai' in settings.find((item) => item.name === 'Search method').dropdown.options, false);
    await settings.find((item) => item.name === 'Rebuild index').button.click();
    assert.equal(plugin.sourceRegistry.list().length, 1);
    assert.equal(plugin.sourceRegistry.getByPath('Private/secret.md'), undefined);
    assert.equal((await plugin.answerQuery('Searchable')).citations[0].path, 'renamed.md');
    await listeners.get('delete')(file);
    assert.equal((await plugin.fullTextSearch.search('Searchable', 5)).length, 0);
    assert.ok(requests.length > 0);
    assert.ok(requests.every((request) => request.url === 'https://api.openai.com/v1/responses'));
    assert.equal(modals.length, 0);
    assert.equal(notices.some((notice) => notice.includes('could not')), false);
    assert.equal(file.content, '# Searchable changed fact');
    const restart = await loadPlugin(writes.at(-1), false, secrets);
    assert.equal(restart.writes.length, 0);
    assert.equal(restart.requests.length, 0);
    await assert.rejects(plugin.setSearchMode('openai'), /Unknown search mode/);
  }
});

test('migration preserves matching local vectors and discards unlabelled or foreign vectors in local mode', async () => {
  const seed = await loadPlugin(null);
  seed.plugin.localModel = { isReady: async () => true };
  seed.plugin.localEmbeddings = { dispose() {}, embedBatch: async (texts) => texts.map(() => [1, 1]) };
  await seed.plugin.setSearchMode('local');
  const file = new seed.MockTFile('local.md', '# Local fact');
  seed.plugin.app.vault.files = [file];
  await seed.plugin.rebuildIndex();
  const baseline = structuredClone(seed.writes.at(-1));
  for (const model of [baseline.vectorIndexModel, 'old-openai-model', undefined]) {
    const saved = { ...baseline, allowRemoteEmbeddingIndexing: true, embeddingModel: 'retired', vectorIndexModel: model };
    const { plugin, writes, requests, MockTFile } = await loadPlugin(saved);
    assert.equal(plugin.settings.searchMode, 'local');
    const matching = model === baseline.vectorIndexModel;
    assert.deepEqual(writes[0].vectorIndex, matching ? baseline.vectorIndex : null);
    plugin.localEmbeddings = { embed: async () => [1, 1] };
    plugin.app.vault.files = [new MockTFile('local.md', '# Local fact')];
    if (matching) {
      await assert.rejects(plugin.answerQuery('Local'), /Configure an LLM/);
      assert.equal(plugin.vectorStore.listBySource(baseline.sourceRegistry[0].source_id).length, 1);
    } else {
      await assert.rejects(plugin.answerQuery('Local'), /Rebuild the index/);
      assert.equal(plugin.vectorStore, undefined);
    }
    assert.equal(requests.length, 0);
  }
});

test('a failed migration save leaves legacy data retryable and never calls the network', async () => {
  const saved = { searchMode: 'openai', allowRemoteEmbeddingIndexing: true, embeddingModel: 'old', vectorIndex: { invalid: true } };
  const secrets = new Map([['prism-embedding-api-key', 'old-fixture-key']]);
  await assert.rejects(loadPlugin(saved, true, secrets), /storage unavailable/);
  assert.equal(saved.searchMode, 'openai');
  const retry = await loadPlugin(saved, false, secrets);
  assert.equal(retry.writes[0].vectorIndex, null);
  assert.equal(retry.plugin.settings.searchMode, 'full-text');
  assert.equal(retry.requests.length, 0);
});

test('local embeddings rebuild, update only changed chunks, retry failures, remove exclusions and never call OpenAI embeddings', async () => {
  const { plugin, listeners, MockTFile, requests, writes } = await loadPlugin(null);
  const embedded = [];
  let fail = false;
  plugin.localModel = { isReady: async () => true, cancel() {} };
  plugin.localEmbeddings = {
    dispose() {},
    async embedBatch(texts) {
      if (fail) throw new Error('local inference failed');
      embedded.push([...texts]);
      return texts.map(() => [1, 1]);
    },
    async embed(query) { embedded.push([query]); return [1, 1]; },
  };
  await plugin.setSearchMode('local');
  const file = new MockTFile('facts.md', '# A cat is sleeping on the sofa.');
  const excluded = new MockTFile('Private/hidden.md', 'Secret');
  plugin.app.vault.files = [file, excluded];
  await plugin.setExcludedPaths('Private/');
  await plugin.rebuildIndex();
  const source = plugin.sourceRegistry.getByPath('facts.md');
  assert.equal(plugin.sourceRegistry.list().length, 1);
  assert.equal(plugin.vectorStore.listBySource(source.source_id).length, 1);
  assert.equal(embedded.length, 1);
  await listeners.get('modify')(file);
  assert.equal(embedded.length, 1);
  file.content = '# A kitten rests on a couch.';
  file.stat.size = file.content.length;
  fail = true;
  await listeners.get('modify')(file);
  assert.equal(plugin.vectorStore.listBySource(source.source_id).length, 0);
  assert.equal((await plugin.fullTextSearch.search('kitten', 5)).length, 1);
  fail = false;
  await listeners.get('modify')(file);
  assert.equal(plugin.vectorStore.listBySource(source.source_id).length, 1);
  await plugin.setLlmModel('answer-model');
  plugin.setLlmApiKey('fixture-key');
  const answer = await plugin.answerQuery('Where does the animal sleep?');
  assert.equal(answer.citations[0].path, 'facts.md');
  assert.equal(requests.length, 1);
  assert.ok(requests[0].url.endsWith('/responses'));
  assert.equal(plugin.vectorStore.listBySource(source.source_id).length, 1);
  await plugin.setExcludedPaths('Private/\nfacts.md');
  assert.equal(plugin.vectorStore.listBySource(source.source_id).length, 0);
  const added = new MockTFile('added.md', '# Added local note');
  await listeners.get('create')(added);
  const addedId = plugin.sourceRegistry.getByPath(added.path).source_id;
  assert.equal(plugin.vectorStore.listBySource(addedId).length, 1);
  await listeners.get('delete')(added);
  assert.equal(plugin.vectorStore.listBySource(addedId).length, 0);
  await plugin.setSearchMode('full-text');
  assert.equal(plugin.vectorStore, undefined);
  assert.equal(writes.at(-1).vectorIndex, null);
  assert.equal(file.content, '# A kitten rests on a couch.');
});

test('missing local model preserves indexes on rebuild and reports a remedy without remote fallback', async () => {
  const { plugin, listeners, MockTFile, requests, commands, leaves } = await loadPlugin(null);
  const file = new MockTFile('keep.md', '# Keep Markdown');
  plugin.app.vault.files = [file];
  await listeners.get('create')(file);
  await plugin.setSearchMode('local');
  await assert.rejects(plugin.rebuildIndex(), /Download.*before rebuilding/);
  assert.equal(plugin.sourceRegistry.list().length, 1);
  assert.equal((await plugin.fullTextSearch.search('Keep', 5)).length, 1);
  await assert.rejects(plugin.answerQuery('Keep'), /runtime is unavailable/);
  await commands.find((command) => command.id === 'open-chat').callback();
  findElement(leaves[0].view.contentEl, (element) => element.tag === 'textarea').value = 'Keep';
  await findElement(leaves[0].view.contentEl, (element) => element.tag === 'form').submit();
  assert.match(visibleText(leaves[0].view.contentEl), /Reinstall Prism/);
  assert.equal(requests.length, 0);
  assert.equal(file.content, '# Keep Markdown');
});

test('rebuild checks the queued search mode before clearing existing indexes', async () => {
  const { plugin, listeners, MockTFile } = await loadPlugin(null);
  const file = new MockTFile('keep.md', '# Existing text');
  plugin.app.vault.files = [file];
  await listeners.get('create')(file);
  const changing = plugin.setSearchMode('local');
  const rebuilding = plugin.rebuildIndex();
  await changing;
  await assert.rejects(rebuilding, /Download.*before rebuilding/);
  assert.equal(plugin.sourceRegistry.list().length, 1);
  assert.equal((await plugin.fullTextSearch.search('Existing', 5)).length, 1);
});

test('changing mode during local indexing discards late vectors and can rebuild with the new mode', async () => {
  const { plugin, listeners, MockTFile, writes, requests } = await loadPlugin(null);
  let release, started;
  const signal = new Promise((resolve) => { started = resolve; });
  plugin.localEmbeddings = {
    dispose() {},
    embedBatch: () => new Promise((resolve) => { release = resolve; started(); }),
  };
  await plugin.setSearchMode('local');
  const file = new MockTFile('note.md', '# Local note');
  plugin.app.vault.files = [file];
  const indexing = listeners.get('create')(file);
  await signal;
  const changing = plugin.setSearchMode('full-text');
  release([[1, 1]]);
  await Promise.all([indexing, changing]);
  assert.equal(plugin.settings.searchMode, 'full-text');
  assert.equal(writes.at(-1).vectorIndex, null);
  await plugin.rebuildIndex();
  assert.equal(plugin.vectorStore, undefined);
  assert.equal(requests.length, 0);
});

class MockElement {
  constructor(tag) {
    this.tag = tag;
    this.children = [];
    this.listeners = new Map();
    this.style = {};
    this.textContent = '';
    this.value = '';
    this.disabled = false;
    this.classes = [];
  }

  empty() { this.children = []; this.textContent = ''; }
  createEl(tag, options = {}) {
    const child = new MockElement(tag);
    child.textContent = options.text ?? '';
    child.attributes = options.attr ?? {};
    if (options.cls) child.addClass(options.cls);
    this.children.push(child);
    return child;
  }
  createDiv(options) { return this.createEl('div', options); }
  addClass(name) { this.classes.push(name); }
  setAttribute(name, value) { this.attributes ??= {}; this.attributes[name] = value; }
  addEventListener(name, callback) { this.listeners.set(name, callback); }
  focus() { this.focused = true; }
  submit() { return this.listeners.get('submit')({ preventDefault() {} }); }
  click() { return this.listeners.get('click')?.(); }
}

function findElement(root, predicate) {
  if (predicate(root)) return root;
  for (const child of root.children) {
    const found = findElement(child, predicate);
    if (found) return found;
  }
  return undefined;
}

function visibleText(element) {
  return element.textContent + element.children.map(visibleText).join('');
}

async function loadPlugin(savedData, failSave = false, storedSecrets = new Map(), responseOverride) {
  const manifest = JSON.parse(await readFile(new URL('../manifest.json', import.meta.url), 'utf8'));
  const bundle = await readFile(new URL('../main.js', import.meta.url), 'utf8');
  const module = { exports: {} };
  const tabs = [];
  const writes = [];
  const notices = [];
  const listeners = new Map();
  const requests = [];
  const openedFiles = [];
  const viewFactories = new Map();
  const commands = [];
  const modals = [];
  const ribbonIcons = [];
  const leaves = [];
  const revealed = [];

  class MockLeaf {
    async openFile(file) { openedFiles.push(file); }
    async setViewState(state) {
      this.state = state;
      if (!this.view) {
        this.view = viewFactories.get(state.type)(this);
        await this.view.onOpen();
      }
    }
  }

  class MockTFile {
    constructor(path, content = '') {
      this.path = path;
      this.extension = path.split('.').at(-1);
      this.content = content;
      this.stat = { mtime: 1, size: content.length };
    }
  }

  class MockPlugin {
    manifest = manifest;
    app = { workspace: {
      getLeaf() { const leaf = new MockLeaf(); leaves.push(leaf); return leaf; },
      getLeavesOfType(type) { return leaves.filter((leaf) => leaf.state?.type === type); },
      async revealLeaf(leaf) { revealed.push(leaf); },
    }, secretStorage: {
      setSecret(id, value) { storedSecrets.set(id, value); },
      getSecret(id) { return storedSecrets.get(id) ?? null; },
    }, vault: {
      files: [],
      getMarkdownFiles() { return this.files; },
      getAbstractFileByPath(path) { return this.files.find((file) => file.path === path) ?? null; },
      on(name, callback) { listeners.set(name, callback); return { name }; },
      async read(file) { return file.content; },
    } };
    async loadData() { return savedData; }
    async saveData(data) {
      if (failSave) throw new Error('storage unavailable');
      writes.push(structuredClone(data));
    }
    addSettingTab(tab) { tabs.push(tab); }
    registerEvent() {}
    registerView(type, factory) { viewFactories.set(type, factory); }
    addCommand(command) { commands.push(command); }
    addRibbonIcon(icon, title, callback) { ribbonIcons.push({ icon, title, callback }); return {}; }
  }

  class MockItemView {
    constructor(leaf) { this.leaf = leaf; this.contentEl = new MockElement('div'); }
  }

  class MockPluginSettingTab {
    containerEl = {
      children: [],
      empty() { this.children = []; },
      createEl(tag, options) {
        const element = { tag, text: options.text, attributes: {},
          setAttr(name, value) { this.attributes[name] = value; } };
        this.children.push(element);
        return element;
      },
    };
  }

  class MockModal {
    contentEl = new MockElement('div');
    open() { modals.push(this); this.onOpen(); }
    close() { this.closed = true; }
  }

  class MockSetting {
    constructor(container) { container.children.push(this); }
    setName(name) { this.name = name; return this; }
    setDesc(description) { this.description = description; return this; }
    addToggle(callback) {
      const toggle = {
        setValue(value) { this.value = value; return this; },
        onChange(handler) { this.change = handler; return this; },
      };
      callback(toggle);
      this.toggle = toggle;
      return this;
    }
    addDropdown(callback) {
      const dropdown = {
        options: new Map(),
        addOption(value, label) { this.options.set(value, label); return this; },
        setValue(value) { this.value = value; return this; },
        onChange(handler) { this.change = handler; return this; },
      };
      callback(dropdown);
      this.dropdown = dropdown;
      return this;
    }
    addText(callback) {
      const listeners = new Map();
      const text = {
        value: '',
        inputEl: { type: 'text', addEventListener(name, handler) { listeners.set(name, handler); } },
        setPlaceholder(value) { this.placeholder = value; return this; },
        setValue(value) { this.value = value; return this; },
        getValue() { return this.value; },
        onChange(handler) { this.change = handler; return this; },
        commit() { return listeners.get('change')?.(); },
      };
      callback(text);
      this.text = text;
      return this;
    }
    addTextArea(callback) {
      const text = {
        value: '',
        setPlaceholder(value) { this.placeholder = value; return this; },
        setValue(value) { this.value = value; return this; },
        getValue() { return this.value; },
      };
      callback(text);
      this.textArea = text;
      return this;
    }
    addButton(callback) {
      const button = {
        setButtonText(value) { this.label = value; return this; },
        setDisabled(value) { this.disabled = value; return this; },
        onClick(handler) { this.click = handler; return this; },
      };
      callback(button);
      this.button = button;
      (this.buttons ??= []).push(button);
      return this;
    }
  }

  runInNewContext(bundle, {
    crypto: webcrypto,
    TextEncoder,
    module,
    exports: module.exports,
    require(specifier) {
      assert.equal(specifier, 'obsidian');
      return {
        Plugin: MockPlugin,
        ItemView: MockItemView,
        PluginSettingTab: MockPluginSettingTab,
        Modal: MockModal,
        Setting: MockSetting,
        Notice: class { constructor(message) { notices.push(message); } },
        TFile: MockTFile,
        requestUrl: async (request) => {
          requests.push(request);
          const overridden = await responseOverride?.(request);
          if (overridden) return overridden;
          if (request.url.includes('/codex/models')) return { status: 200, text: JSON.stringify({
            models: [{ slug: 'codex-model', visibility: 'list', supported_in_api: true }],
          }) };
          if (request.url.includes('/codex/responses')) {
            const messages = JSON.parse(request.body).input;
            const reference = messages.find((message) => message.content.startsWith('Reference material:\n'));
            if (!reference) return { status: 200, text: 'data: {"type":"response.output_text.delta","delta":"OK"}\n\ndata: {"type":"response.completed"}\n\n' };
            const context = JSON.parse(reference.content.slice('Reference material:\n'.length));
            return { status: 200, text: `data: ${JSON.stringify({ type: 'response.output_text.delta',
              delta: `Grounded answer [cite:${context[0].chunkId}]` })}\n\ndata: {"type":"response.completed"}\n\n` };
          }
          if (request.url.endsWith('/responses')) {
            const messages = JSON.parse(request.body).input;
            const reference = messages.find((message) => message.content.startsWith('Reference material:\n'));
            const context = JSON.parse(reference.content.slice('Reference material:\n'.length));
            return { status: 200, text: JSON.stringify({ output: [{ type: 'message', content: [
              { type: 'output_text', text: `Grounded answer [cite:${context[0].chunkId}]` },
            ] }] }) };
          }
          throw new Error(`Unexpected network request: ${request.url}`);
        },
      };
    },
  });

  const plugin = new module.exports.default();
  await plugin.onload();
  return { manifest, plugin, tabs, writes, notices, listeners, storedSecrets, MockPlugin, MockTFile,
    requests, openedFiles, commands, ribbonIcons, leaves, revealed, modals };
}

test('Ask command opens one view and submits a query through RAG with actionable citations', async () => {
  const { plugin, listeners, MockTFile, commands, ribbonIcons, leaves, revealed, requests, writes,
    openedFiles } =
    await loadPlugin(null);
  await plugin.setLlmModel('answer-model');
  plugin.setLlmApiKey('test-key');
  const file = new MockTFile('facts.md', '# Local fact');
  plugin.app.vault.files = [file];
  await listeners.get('create')(file);
  const open = commands.find((command) => command.id === 'open-chat');
  assert.ok(open);
  await open.callback();
  assert.equal(leaves.length, 1);
  assert.equal(revealed.length, 1);
  const view = leaves[0].view;
  assert.equal(view.getDisplayText(), 'Prism Ask');
  const input = findElement(view.contentEl, (element) => element.tag === 'textarea');
  const form = findElement(view.contentEl, (element) => element.tag === 'form');
  input.value = 'Local';
  await form.submit();
  const conversation = findElement(view.contentEl, (element) => element.classes.includes('prism-ask-conversation'));
  const response = findElement(conversation, (element) => element.classes.includes('prism-ask-answer'));
  assert.equal(visibleText(response), 'Grounded answer [^1]');
  const inline = findElement(response, (element) => element.tag === 'button');
  assert.equal(inline.type, 'button');
  assert.match(inline.attributes['aria-label'], /Open source facts\.md, lines 1–1/);
  await inline.click();
  assert.equal(openedFiles.at(-1), file);
  const citation = findElement(view.contentEl, (element) => element.tag === 'li');
  const sourceButton = findElement(citation, (element) => element.tag === 'button');
  assert.match(sourceButton.textContent, /facts\.md \(lines 1–1\)/u);
  assert.equal(sourceButton.type, 'button');
  file.path = 'moved.md';
  await plugin.sourceRegistry.movePaths('facts.md', 'moved.md');
  await sourceButton.click();
  assert.equal(openedFiles.at(-1), file);
  assert.equal(openedFiles.length, 2);
  plugin.app.vault.files = [];
  await inline.click();
  assert.match(findElement(view.contentEl, (element) => element.attributes?.role === 'status').textContent,
    /Source is unavailable/);
  assert.equal(openedFiles.length, 2);
  assert.equal(requests.length, 1);
  assert.equal(file.content, '# Local fact');
  assert.doesNotMatch(JSON.stringify(writes), /Grounded answer/);
  await ribbonIcons[0].callback();
  assert.equal(leaves.filter((leaf) => leaf.state?.type === 'prism-chat').length, 1);
  assert.equal(revealed.length, 2);
});

test('Ask keeps the input after a scrollable conversation and orders each turn as question then answer and sources', async () => {
  const { plugin, commands, leaves } = await loadPlugin(null);
  await commands.find((command) => command.id === 'open-chat').callback();
  const view = leaves[0].view;
  const heading = view.contentEl.children[0];
  const conversation = findElement(view.contentEl, (element) => element.classes.includes('prism-ask-conversation'));
  const form = findElement(view.contentEl, (element) => element.tag === 'form');
  assert.equal(heading.tag, 'h2');
  assert.ok(view.contentEl.classes.includes('prism-ask-view'));
  assert.ok(conversation.classes.includes('prism-ask-conversation'));
  assert.equal(conversation.attributes.role, 'log');
  assert.ok(form.classes.includes('prism-ask-form'));
  assert.equal(findElement(form, (element) => element.tag === 'textarea')?.tag, 'textarea');
  assert.equal(findElement(form, (element) => element.tag === 'button')?.type, 'submit');

  plugin.answerQuery = async () => ({ content: 'First answer [^1]', citations: [{
    sourceId: 'source', chunkId: 'chunk', path: 'fact.md', startLine: 1, endLine: 2,
  }] });
  findElement(form, (element) => element.tag === 'textarea').value = 'First question';
  await form.submit();
  const turn = conversation.children[0];
  assert.ok(turn.classes.includes('prism-ask-turn'));
  assert.equal(turn.children[0].textContent, 'First question');
  assert.equal(visibleText(turn.children[1]), 'First answer [^1]');
  assert.match(visibleText(turn.children[2]), /fact\.md/);
  assert.equal(view.contentEl.children.at(-1), form);

  assert.equal(view.contentEl.style.display, 'flex');
  assert.equal(view.contentEl.style.flexDirection, 'column');
  assert.equal(conversation.style.minHeight, '0');
  assert.equal(conversation.style.overflowY, 'auto');
  assert.equal(form.style.flex, 'none');
  const input = findElement(form, (element) => element.tag === 'textarea');
  assert.equal(input.style.width, '100%');
  assert.equal(input.style.boxSizing, 'border-box');
});

test('Ask retains ordered turns with their own sources, bounds history and resets context without saving the conversation', async () => {
  const { plugin, commands, leaves, writes } = await loadPlugin(null);
  await commands.find((command) => command.id === 'open-chat').callback();
  const view = leaves[0].view;
  const calls = [];
  const opened = [];
  plugin.answerQuery = async (question, history) => {
    calls.push({ question, history: structuredClone(history) });
    return { content: `answer ${calls.length} [^1]`, citations: [{
      chunkId: `chunk-${calls.length}`, sourceId: `source-${calls.length}`,
      path: `note-${calls.length}.md`, startLine: 1, endLine: 2,
    }] };
  };
  plugin.openCitation = async (citation) => { opened.push(citation.path); return true; };
  const get = (predicate) => findElement(view.contentEl, predicate);
  const conversation = get((element) => element.classes.includes('prism-ask-conversation'));
  const form = get((element) => element.tag === 'form');
  const input = get((element) => element.tag === 'textarea');
  const before = writes.length;
  for (let i = 1; i <= 8; i++) {
    input.value = `question ${i}`;
    await form.submit();
  }
  assert.equal(conversation.children.length, 8);
  assert.deepEqual(calls[1].history, [{ question: 'question 1', answer: 'answer 1 [^1]' }]);
  assert.equal(calls[7].history.length, 6);
  assert.equal(calls[7].history[0].question, 'question 2');
  assert.match(visibleText(conversation.children[7]), /1 earlier question\/answer pairs omitted/);
  assert.equal(writes.length, before);
  for (const index of [0, 7]) {
    const response = conversation.children[index].children[1];
    await findElement(response, (element) => element.tag === 'button').click();
  }
  assert.deepEqual(opened, ['note-1.md', 'note-8.md']);
  assert.match(visibleText(view.contentEl), /question\/answer pairs.*12,000 UTF-8 bytes/);
  assert.match(visibleText(view.contentEl), /api\.openai\.com.*chatgpt\.com/);
  await view.onClose();
  await view.onOpen();
  assert.equal(get((element) => element.classes.includes('prism-ask-conversation')).children.length, 8);
  await get((element) => element.textContent === 'New conversation').click();
  get((element) => element.tag === 'textarea').value = 'New topic';
  await get((element) => element.tag === 'form').submit();
  assert.deepEqual(calls.at(-1).history, []);
  assert.equal(get((element) => element.classes.includes('prism-ask-conversation')).children.length, 1);
});

test('Ask preserves completed turns on failure and retries the last turn with the same successful history', async () => {
  const { plugin, commands, leaves } = await loadPlugin(null);
  await commands.find((command) => command.id === 'open-chat').callback();
  const view = leaves[0].view;
  const form = findElement(view.contentEl, (element) => element.tag === 'form');
  const input = findElement(view.contentEl, (element) => element.tag === 'textarea');
  const conversation = findElement(view.contentEl, (element) => element.classes.includes('prism-ask-conversation'));
  const calls = [];
  plugin.answerQuery = async (question, history) => {
    calls.push({ question, history: structuredClone(history) });
    if (calls.length === 2) throw new Error('private data');
    return { content: 'Supported answer', citations: [] };
  };
  input.value = 'First';
  await form.submit();
  input.value = 'More';
  await form.submit();
  assert.equal(conversation.children.length, 2);
  assert.match(visibleText(conversation.children[0]), /Supported answer/);
  assert.doesNotMatch(visibleText(conversation), /private data/);
  assert.equal(input.value, 'More');
  await findElement(conversation, (element) => element.textContent === 'Retry').click();
  assert.equal(conversation.children.length, 2);
  assert.deepEqual(calls[2], calls[1]);
  assert.match(visibleText(conversation.children[1]), /Supported answer/);
  assert.equal(input.value, '');
});

test('Ask reopens during an in-flight answer without duplicating requests or losing the final result', async () => {
  const { plugin, commands, leaves } = await loadPlugin(null);
  await commands.find((command) => command.id === 'open-chat').callback();
  const view = leaves[0].view;
  let finish;
  let calls = 0;
  plugin.answerQuery = () => { calls++; return new Promise((resolve) => { finish = resolve; }); };
  findElement(view.contentEl, (element) => element.tag === 'textarea').value = 'Question';
  const pending = findElement(view.contentEl, (element) => element.tag === 'form').submit();
  await view.onClose();
  await view.onOpen();
  const form = findElement(view.contentEl, (element) => element.tag === 'form');
  assert.equal(findElement(form, (element) => element.type === 'submit').disabled, true);
  assert.equal(findElement(view.contentEl, (element) => element.textContent === 'New conversation').disabled, true);
  await form.submit();
  await findElement(view.contentEl, (element) => element.textContent === 'New conversation').click();
  assert.equal(calls, 1);
  finish({ content: 'Final answer', citations: [] });
  await pending;
  assert.match(visibleText(view.contentEl), /Final answer/);
  assert.equal(findElement(form, (element) => element.type === 'submit').disabled, false);
  assert.equal(findElement(view.contentEl, (element) => element.tag === 'textarea').value, '');
});

test('ChatGPT selection never charges the configured API key after missing OAuth credentials', async () => {
  const { plugin, listeners, MockTFile, requests, storedSecrets, writes } = await loadPlugin(null);
  plugin.setLlmApiKey('configured-api-key');
  await plugin.setLlmModel('api-model');
  await plugin.setLlmConnection('chatgpt-codex');
  const file = new MockTFile('facts.md', '# Local fact');
  plugin.app.vault.files = [file];
  await listeners.get('create')(file);
  await assert.rejects(plugin.answerQuery('Local fact'));
  assert.equal(requests.length, 0);
  assert.equal(storedSecrets.get('prism-llm-api-key'), 'configured-api-key');
  assert.equal(writes.at(-1).llmConnection, 'chatgpt-codex');
});

test('ChatGPT account answers a local RAG query with citations and no API key', async () => {
  const accessToken = 'test-access';
  const secrets = new Map([['prism-codex-credential', JSON.stringify({
    accessToken, refreshToken: 'test-refresh', accountId: 'account-1', expiresAt: Date.now() + 3600_000,
  })]]);
  const { plugin, listeners, MockTFile, requests, writes } = await loadPlugin(null, false, secrets);
  await plugin.setLlmConnection('chatgpt-codex');
  await plugin.setCodexModel('codex-model');
  const file = new MockTFile('facts.md', '# Local fact');
  plugin.app.vault.files = [file];
  await listeners.get('create')(file);
  const answer = await plugin.answerQuery('Local fact');
  assert.match(answer.content, /Grounded answer/);
  assert.equal(answer.citations.length, 1);
  assert.equal(requests.filter((request) => request.url.includes('/codex/responses')).length, 1);
  assert.equal(requests.some((request) => request.url === 'https://api.openai.com/v1/responses'), false);
  assert.doesNotMatch(JSON.stringify(writes), /test-access|test-refresh|Grounded answer/);
});

test('ChatGPT Ask sends the selected model when the optional model list is unavailable', async () => {
  const secrets = new Map([['prism-codex-credential', JSON.stringify({
    accessToken: 'test-access', refreshToken: 'test-refresh', accountId: 'account-1',
    expiresAt: Date.now() + 3600_000,
  })]]);
  const { plugin, listeners, MockTFile, requests } = await loadPlugin(null, false, secrets,
    (request) => request.url.includes('/codex/models') ? { status: 503, text: '' } : undefined);
  await plugin.setLlmConnection('chatgpt-codex');
  await plugin.setCodexModel('gpt-5.5');
  const file = new MockTFile('library.md', '# 夜間開館\n6月12日には空調設備が停止した。');
  plugin.app.vault.files = [file];
  await listeners.get('create')(file);
  await assert.rejects(plugin.refreshCodexModels(), /ChatGPT returned HTTP 503/);

  const answer = await plugin.answerQuery('6月12日');
  assert.equal(answer.citations[0]?.path, 'library.md');
  assert.deepEqual(requests.map((request) => request.url), [
    'https://chatgpt.com/backend-api/codex/models?client_version=0.155.0',
    'https://chatgpt.com/backend-api/codex/responses',
  ]);
  assert.equal(JSON.parse(requests[1].body).model, 'gpt-5.5');
});

test('settings automatically load Codex models, preserve the saved selection and reuse the cache', async () => {
  const secrets = new Map([['prism-codex-credential', JSON.stringify({
    accessToken: 'test-access', refreshToken: 'test-refresh', accountId: 'account-1',
    expiresAt: Date.now() + 3600_000,
  })]]);
  const { plugin, tabs, requests, writes } = await loadPlugin({
    llmConnection: 'chatgpt-codex', codexModel: 'saved-model',
  }, false, secrets, (request) => request.url.includes('/codex/models') ? { status: 200,
    text: JSON.stringify({ models: [
      { slug: 'gpt-5.5', visibility: 'list' },
      { slug: 'hidden-model', visibility: 'hide' },
    ] }) } : undefined);
  tabs[0].display();
  assert.equal(tabs[0].containerEl.children.find((child) => child.name === 'Codex model').dropdown.value,
    'saved-model');
  await new Promise(setImmediate);
  tabs[0].display();
  assert.equal(requests.filter((request) => request.url.includes('/codex/models')).length, 1);
  const modelSetting = tabs[0].containerEl.children.find((child) => child.name === 'Codex model');
  assert.deepEqual([...modelSetting.dropdown.options], [
    ['saved-model', 'saved-model (saved model)'], ['gpt-5.5', 'gpt-5.5'],
  ]);
  assert.equal(modelSetting.dropdown.value, 'saved-model');
  await modelSetting.dropdown.change('gpt-5.5');
  assert.equal(plugin.settings.codexModel, 'gpt-5.5');
  assert.equal(writes.at(-1).codexModel, 'gpt-5.5');
  await plugin.testCodexConnection();
  assert.equal(JSON.parse(requests.find((request) => request.url.includes('/codex/responses')).body).model,
    'gpt-5.5');
});

test('connection test sends only its disclosed fixed prompt and reports success without saving a response', async () => {
  const secrets = new Map([['prism-codex-credential', JSON.stringify({
    accessToken: 'test-access', refreshToken: 'test-refresh', accountId: 'account-1',
    expiresAt: Date.now() + 3600_000,
  })]]);
  const { plugin, tabs, requests, writes, notices } = await loadPlugin(null, false, secrets);
  await plugin.setLlmConnection('chatgpt-codex');
  tabs[0].display();
  const setting = tabs[0].containerEl.children.find((child) => child.name === 'Test ChatGPT connection');
  assert.match(setting.description, /Reply with OK.*chatgpt\.com\/backend-api\/codex\/responses/);
  assert.equal(setting.button.disabled, false);
  await setting.button.click();
  const sent = requests.filter((request) => request.url.includes('/codex/responses'));
  assert.equal(sent.length, 1);
  assert.deepEqual(structuredClone(JSON.parse(sent[0].body).input), [{ role: 'user', content: 'Reply with OK.' }]);
  assert.equal(requests.some((request) => request.url === 'https://api.openai.com/v1/responses'), false);
  assert.equal(tabs[0].containerEl.children.find((child) => child.attributes?.role === 'status').text,
    'Success: ChatGPT (Codex) responded to the connection test.');
  assert.ok(notices.includes('Success: ChatGPT (Codex) responded to the connection test.'));
  assert.doesNotMatch(JSON.stringify(writes), /test-access|test-refresh|Reply with OK|Connection succeeded/);
});

test('connection test shows safe failure categories and disables the button without OAuth credentials', async () => {
  for (const [status, expected] of [[401, /Authentication failed/], [403, /not permitted/],
    [429, /rate limited/], [503, /unavailable/]]) {
    const secrets = new Map([['prism-codex-credential', JSON.stringify({
      accessToken: 'test-access', refreshToken: 'test-refresh', accountId: 'account-1',
      expiresAt: Date.now() + 3600_000,
    })]]);
    const { plugin, tabs, notices } = await loadPlugin(null, false, secrets,
      (request) => request.url.includes('/codex/responses') ? { status, text: 'private token and note' } : undefined);
    await plugin.setLlmConnection('chatgpt-codex');
    tabs[0].display();
    await tabs[0].containerEl.children.find((child) => child.name === 'Test ChatGPT connection').button.click();
    const message = tabs[0].containerEl.children.find((child) => child.attributes?.role === 'status').text;
    assert.match(message, /^Failed:/);
    assert.match(message, expected);
    assert.ok(notices.includes(message));
    assert.doesNotMatch(message, /private token and note|test-access|account-1/);
  }
  const missing = await loadPlugin({ llmConnection: 'chatgpt-codex' });
  missing.tabs[0].display();
  assert.equal(missing.tabs[0].containerEl.children.find((child) => child.name === 'Test ChatGPT connection').button.disabled, true);
  assert.equal(missing.requests.length, 0);
});

test('sign-out during a connection test discards its late result and prevents duplicate requests', async () => {
  const secrets = new Map([['prism-codex-credential', JSON.stringify({
    accessToken: 'test-access', refreshToken: 'test-refresh', accountId: 'account-1',
    expiresAt: Date.now() + 3600_000,
  })]]);
  let finish;
  let started;
  const requestStarted = new Promise((resolve) => { started = resolve; });
  const { plugin, tabs, requests } = await loadPlugin(null, false, secrets,
    (request) => request.url.includes('/codex/responses')
      ? new Promise((resolve) => { finish = resolve; started(); }) : undefined);
  await plugin.setLlmConnection('chatgpt-codex');
  tabs[0].display();
  const first = tabs[0].containerEl.children.find((child) => child.name === 'Test ChatGPT connection').button;
  const pending = first.click();
  await requestStarted;
  assert.equal(tabs[0].containerEl.children.find((child) => child.name === 'Test ChatGPT connection').button.disabled, true);
  await first.click();
  assert.equal(requests.filter((request) => request.url.includes('/codex/responses')).length, 1);
  tabs[0].containerEl.children.find((child) => child.name === 'ChatGPT account').buttons[1].click();
  finish({ status: 200, text: 'data: {"type":"response.output_text.delta","delta":"OK"}\n\ndata: {"type":"response.completed"}\n\n' });
  await pending;
  assert.equal(tabs[0].containerEl.children.find((child) => child.attributes?.role === 'status'), undefined);
  assert.equal(tabs[0].containerEl.children.find((child) => child.name === 'Test ChatGPT connection').button.disabled, true);
});

test('Ask view validates input, shows loading and safe errors, then renders answer as text', async () => {
  const { plugin, commands, leaves } = await loadPlugin(null);
  await commands.find((command) => command.id === 'open-chat').callback();
  const view = leaves[0].view;
  const form = findElement(view.contentEl, (element) => element.tag === 'form');
  const input = findElement(view.contentEl, (element) => element.tag === 'textarea');
  const button = findElement(form, (element) => element.type === 'submit');
  const inputStatus = findElement(form, (element) => element.attributes?.role === 'status');
  const conversation = findElement(view.contentEl, (element) => element.classes.includes('prism-ask-conversation'));
  const turnStatus = () => findElement(conversation.children.at(-1), (element) => element.attributes?.role === 'status');
  let calls = 0;
  plugin.answerQuery = () => { calls += 1; return Promise.reject(new Error('private note contents')); };
  await form.submit();
  assert.equal(inputStatus.textContent, 'Enter a question.');
  assert.equal(input.focused, true);
  assert.equal(calls, 0);
  input.value = 'Question';
  let fail;
  plugin.answerQuery = () => { calls += 1; return new Promise((_resolve, reject) => { fail = reject; }); };
  const pending = form.submit();
  assert.equal(turnStatus().textContent, 'Answering…');
  assert.equal(button.disabled, true);
  await form.submit();
  assert.equal(calls, 1);
  fail(new Error('private note contents'));
  await pending;
  assert.match(turnStatus().textContent, /Check provider settings, indexing, and network/);
  assert.doesNotMatch(turnStatus().textContent, /private note contents/);
  assert.equal(button.disabled, false);
  plugin.answerQuery = async () => { throw new Error('Connect a ChatGPT account in Prism settings.'); };
  await form.submit();
  assert.match(turnStatus().textContent, /Connect or reconnect your ChatGPT account/);
  plugin.answerQuery = async () => ({ content: '<img src=x onerror=alert(1)>', citations: [{
    sourceId: 'one', chunkId: 'one', path: '<b>source.md', startLine: 2, endLine: 3,
  }] });
  await form.submit();
  assert.equal(visibleText(findElement(conversation.children.at(-1), (element) => element.classes.includes('prism-ask-answer'))),
    '<img src=x onerror=alert(1)>');
  assert.equal(findElement(view.contentEl, (element) => element.tag === 'img'), undefined);
  assert.match(visibleText(findElement(view.contentEl, (element) => element.tag === 'li')), /<b>source\.md/);
  assert.equal(turnStatus().textContent, 'Answer ready.');
});

test('citation open errors remain safe in the Ask view', async () => {
  const { plugin, commands, leaves } = await loadPlugin(null);
  await commands.find((command) => command.id === 'open-chat').callback();
  const view = leaves[0].view;
  plugin.answerQuery = async () => ({ content: 'Answer [^1] and [^9]', citations: [{
    sourceId: 'source', chunkId: 'chunk', path: 'note.md', startLine: 1, endLine: 2,
  }] });
  plugin.openCitation = async () => { throw new Error('private note contents'); };
  findElement(view.contentEl, (element) => element.tag === 'textarea').value = 'Question';
  await findElement(view.contentEl, (element) => element.tag === 'form').submit();
  const answer = findElement(view.contentEl, (element) => element.classes.includes('prism-ask-answer'));
  assert.equal(visibleText(answer), 'Answer [^1] and [^9]');
  assert.equal(answer.children.filter((child) => child.tag === 'button').length, 1);
  await findElement(answer, (element) => element.tag === 'button').click();
  const status = findElement(view.contentEl, (element) => element.attributes?.role === 'status');
  assert.equal(status.textContent, 'Could not open the source. Try again.');
  assert.doesNotMatch(status.textContent, /private note contents/);
});

test('citation opens the current Markdown path after a move and ignores missing sources', async () => {
  const { plugin, MockTFile, openedFiles } = await loadPlugin(null);
  const source = await plugin.sourceRegistry.create({
    path: 'old.md', content: '# Note', mtime: 1, size: 6,
  });
  const file = new MockTFile('old.md', '# Note');
  plugin.app.vault.files = [file];
  const citation = { sourceId: source.source_id, path: 'old.md' };
  assert.equal(await plugin.openCitation(citation), true);
  assert.equal(openedFiles.at(-1), file);
  await plugin.sourceRegistry.movePaths('old.md', 'new.md');
  file.path = 'new.md';
  assert.equal(await plugin.openCitation(citation), true);
  assert.equal(openedFiles.length, 2);
  plugin.app.vault.files = [];
  assert.equal(await plugin.openCitation(citation), false);
  assert.equal(await plugin.openCitation({ sourceId: 'missing' }), false);
  assert.equal(openedFiles.length, 2);
});

test('query flows from local retrieval to a cited answer without remote embedding consent', async () => {
  const { plugin, listeners, MockTFile, requests } = await loadPlugin(null);
  await plugin.setLlmModel('answer-model');
  plugin.setLlmApiKey('test-key');
  const file = new MockTFile('facts.md', '# Local fact');
  plugin.app.vault.files = [file];
  await listeners.get('create')(file);
  const answer = await plugin.answerQuery('Local');
  assert.equal(answer.content, 'Grounded answer [^1]');
  assert.equal(answer.citations.length, 1);
  assert.equal(answer.citations[0].sourceId, plugin.sourceRegistry.getByPath('facts.md').source_id);
  assert.equal(answer.citations[0].path, 'facts.md');
  assert.equal(answer.citations[0].startLine, 1);
  assert.deepEqual(requests.map((request) => request.url), ['https://api.openai.com/v1/responses']);
  assert.equal((await plugin.answerQuery('no-matching-term')).citations.length, 0);
  assert.equal(requests.length, 1);
});

test('an Ask follow-up sends history but refreshes Vault evidence and stops answering after its source is deleted', async () => {
  const { plugin, listeners, MockTFile, requests, commands, leaves } = await loadPlugin(null);
  await plugin.setLlmModel('answer-model');
  plugin.setLlmApiKey('test-key');
  const file = new MockTFile('facts.md', '# Prism\nOriginal fact');
  plugin.app.vault.files = [file];
  await listeners.get('create')(file);
  await commands.find((command) => command.id === 'open-chat').callback();
  const view = leaves[0].view;
  const form = findElement(view.contentEl, (element) => element.tag === 'form');
  const input = findElement(view.contentEl, (element) => element.tag === 'textarea');
  input.value = 'Prism';
  await form.submit();
  file.content = '# Prism\nUpdated fact';
  file.stat.mtime++;
  file.stat.size = file.content.length;
  await listeners.get('modify')(file);
  input.value = 'Tell me more';
  await form.submit();
  const messages = JSON.parse(requests[1].body).input;
  const reference = messages.find((message) => message.content.startsWith('Reference material:\n'));
  assert.match(reference.content, /Updated fact/);
  assert.doesNotMatch(reference.content, /Original fact/);
  assert.ok(messages.some((message) => message.role === 'user' && message.content === 'Prism'));
  assert.ok(messages.some((message) => message.role === 'assistant' && message.content === 'Grounded answer [^1]'));
  assert.equal(messages.at(-1).content, 'Tell me more');
  const conversation = findElement(view.contentEl, (element) => element.classes.includes('prism-ask-conversation'));
  assert.equal(conversation.children.length, 2);
  assert.match(visibleText(conversation.children[1].children[2]), /facts\.md/);
  const beforeDelete = requests.length;
  plugin.app.vault.files = [];
  await listeners.get('delete')(file);
  input.value = 'And then?';
  await form.submit();
  assert.equal(requests.length, beforeDelete);
  assert.match(visibleText(conversation.children[2]), /No relevant Vault context/);
  assert.equal(findElement(conversation.children[2], (element) => element.tag === 'li'), undefined);
  assert.equal(file.content, '# Prism\nUpdated fact');
});

test('a Japanese Ask question retrieves its dated Vault note without remote embedding', async () => {
  const { plugin, listeners, MockTFile, requests } = await loadPlugin(null);
  await plugin.setLlmModel('answer-model');
  plugin.setLlmApiKey('test-key');
  const file = new MockTFile('library.md', '# 夜間開館\n6月12日には空調設備が停止した。貸出・返却窓口は21時まで継続した。');
  plugin.app.vault.files = [file];
  await listeners.get('create')(file);

  const answer = await plugin.answerQuery('6月12日に何が起こり、どのサービスが継続した？');
  assert.equal(answer.citations[0]?.path, 'library.md');
  assert.deepEqual(requests.map((request) => request.url), ['https://api.openai.com/v1/responses']);
  assert.match(requests[0].body, /6月12日には空調設備が停止した/);
});

test('Advanced exclusion rules remove indexed data and block create, rebuild, and retrieval', async () => {
  const { plugin, listeners, MockTFile, tabs, requests, writes, notices } = await loadPlugin(null);
  const privateFile = new MockTFile('Private/secret.md', '# Confidential material');
  const publicFile = new MockTFile('public.md', '# Public material');
  plugin.app.vault.files = [privateFile, publicFile];
  await listeners.get('create')(privateFile);
  await listeners.get('create')(publicFile);
  const privateId = plugin.sourceRegistry.getByPath(privateFile.path).source_id;
  tabs[0].display();
  const setting = tabs[0].containerEl.children.find((child) => child.name === 'Excluded paths');
  setting.textArea.setValue('Private/');
  await setting.button.click();
  assert.deepEqual(structuredClone(plugin.settings.excludedPaths), ['Private']);
  assert.equal(plugin.sourceRegistry.getByPath(privateFile.path), undefined);
  assert.equal(plugin.chunkRegistry.listBySource(privateId).length, 0);
  assert.equal((await plugin.fullTextSearch.search('Confidential', 5)).length, 0);
  assert.equal((await plugin.fullTextSearch.search('Public', 5)).length, 1);
  await listeners.get('create')(privateFile);
  await listeners.get('modify')(privateFile);
  await plugin.rebuildIndex();
  assert.equal(plugin.sourceRegistry.getByPath(privateFile.path), undefined);
  assert.equal(plugin.sourceRegistry.list().length, 1);
  assert.equal((await plugin.answerQuery('Confidential')).citations.length, 0);
  assert.equal(requests.length, 0);
  assert.equal(privateFile.content, '# Confidential material');
  assert.match(notices.at(-1), /exclusions applied/);
  const restarted = await loadPlugin(writes.at(-1));
  assert.deepEqual(structuredClone(restarted.plugin.settings.excludedPaths), ['Private']);
  await assert.rejects(plugin.setExcludedPaths('../outside.md'), /Vault-relative/);
  assert.deepEqual(structuredClone(plugin.settings.excludedPaths), ['Private']);
});

test('moving files and folders across exclusion rules updates indexed sources', async () => {
  const { plugin, listeners, MockTFile } = await loadPlugin(null);
  await plugin.setExcludedPaths('Private/');
  const file = new MockTFile('Public/note.md', '# Movable');
  plugin.app.vault.files = [file];
  await listeners.get('create')(file);
  const originalId = plugin.sourceRegistry.getByPath('Public/note.md').source_id;
  file.path = 'Private/note.md';
  await listeners.get('rename')(file, 'Public/note.md');
  assert.equal(plugin.sourceRegistry.getById(originalId), undefined);
  assert.equal((await plugin.fullTextSearch.search('Movable', 5)).length, 0);
  file.path = 'Public/note.md';
  await listeners.get('rename')(file, 'Private/note.md');
  assert.ok(plugin.sourceRegistry.getByPath('Public/note.md'));
  file.path = 'Private/note.md';
  await listeners.get('rename')({ path: 'Private' }, 'Public');
  assert.equal(plugin.sourceRegistry.getByPath('Private/note.md'), undefined);
  file.path = 'Public/note.md';
  await listeners.get('rename')({ path: 'Public' }, 'Private');
  assert.ok(plugin.sourceRegistry.getByPath('Public/note.md'));
});

test('failed exclusion cleanup still keeps the source out of RAG requests until retry', async () => {
  const { plugin, listeners, MockTFile, requests } = await loadPlugin(null);
  const file = new MockTFile('Private/secret.md', '# Confidential');
  plugin.app.vault.files = [file];
  await listeners.get('create')(file);
  const remove = plugin.fullTextSearch.deleteBySource.bind(plugin.fullTextSearch);
  plugin.fullTextSearch.deleteBySource = async () => { throw new Error('storage failed'); };
  await assert.rejects(plugin.setExcludedPaths('Private/'), /storage failed/);
  assert.equal((await plugin.fullTextSearch.search('Confidential', 5)).length, 1);
  assert.equal((await plugin.answerQuery('Confidential')).citations.length, 0);
  assert.equal(requests.length, 0);
  plugin.fullTextSearch.deleteBySource = remove;
  await plugin.setExcludedPaths('Private/');
  assert.equal((await plugin.fullTextSearch.search('Confidential', 5)).length, 0);
});

test('Vault create event updates the local full-text index without embedding credentials', async () => {
  const { plugin, listeners, MockTFile, notices, requests } = await loadPlugin(null);
  const file = new MockTFile('local.md', '# Local search');
  await listeners.get('create')(file);
  assert.equal((await plugin.fullTextSearch.search('Local', 5))[0].sourceId,
    plugin.sourceRegistry.getByPath('local.md').source_id);
  assert.equal(file.content, '# Local search');
  assert.deepEqual(notices, []);
  assert.deepEqual(requests, []);
});

test('full rebuild replaces stale sources and indexes from Vault Markdown, including local vectors', async () => {
  const { plugin, listeners, MockTFile, requests } = await loadPlugin(null);
  plugin.localModel = { isReady: async () => true };
  plugin.localEmbeddings = { dispose() {}, embedBatch: async (texts) => texts.map(() => [1, 1]) };
  await plugin.setSearchMode('local');
  const stale = new MockTFile('stale.md', '# Stale');
  await listeners.get('create')(stale);
  const staleId = plugin.sourceRegistry.getByPath('stale.md').source_id;
  assert.equal(requests.length, 0);

  const current = new MockTFile('current.md', '# Current');
  plugin.app.vault.files = [current];
  await plugin.rebuildIndex();

  assert.equal(plugin.sourceRegistry.getByPath('stale.md'), undefined);
  const source = plugin.sourceRegistry.getByPath('current.md');
  assert.ok(source);
  assert.equal(plugin.chunkRegistry.listBySource(source.source_id).length, 1);
  assert.equal((await plugin.fullTextSearch.search('Stale', 5)).length, 0);
  assert.equal((await plugin.fullTextSearch.search('Current', 5))[0].sourceId, source.source_id);
  assert.equal(plugin.vectorStore.listBySource(source.source_id).length, 1);
  assert.equal(plugin.vectorStore.listBySource(staleId).length, 0);
  assert.equal(requests.length, 0);
  assert.equal(current.content, '# Current');
  assert.equal(stale.content, '# Stale');
});

test('failed rebuild leaves Markdown intact and can be retried without remote consent', async () => {
  const { plugin, listeners, MockTFile, requests } = await loadPlugin(null);
  const old = new MockTFile('old.md', '# Old');
  await listeners.get('create')(old);
  const current = new MockTFile('current.md', '# Current');
  plugin.app.vault.files = [current];
  const read = plugin.app.vault.read;
  plugin.app.vault.read = async () => { throw new Error('Vault read failed'); };
  await assert.rejects(plugin.rebuildIndex(), /Vault read failed/);
  assert.equal(current.content, '# Current');
  assert.equal(old.content, '# Old');
  plugin.app.vault.read = read;
  await plugin.rebuildIndex();
  assert.equal(plugin.sourceRegistry.list().length, 1);
  assert.equal((await plugin.fullTextSearch.search('Current', 5)).length, 1);
  assert.equal((await plugin.fullTextSearch.search('Old', 5)).length, 0);
  assert.equal(plugin.vectorStore, undefined);
  assert.equal(requests.length, 0);
});

test('Advanced settings shows index counts and rebuilds from Vault Markdown', async () => {
  const { plugin, tabs, MockTFile, notices } = await loadPlugin(null);
  const file = new MockTFile('note.md', '# Vault note');
  plugin.app.vault.files = [file];
  tabs[0].display();
  const children = tabs[0].containerEl.children;
  const advanced = children.findIndex((child) => child.tag === 'h3' && child.text === 'Advanced');
  const status = children.findIndex((child) => child.name === 'Index status');
  assert.ok(status > advanced);
  assert.match(children[status].description, /ready\. 0 sources, 0 chunks/);
  const rebuild = children.find((child) => child.name === 'Rebuild index');
  assert.match(rebuild.description, /No Vault text is sent for indexing/);
  assert.equal(rebuild.button.disabled, false);
  await rebuild.button.click();
  const { lastRebuildMs, ...counts } = structuredClone(plugin.getIndexStatus());
  assert.deepEqual(counts, { state: 'ready', sources: 1, chunks: 1 });
  assert.ok(Number.isFinite(lastRebuildMs) && lastRebuildMs >= 0);
  assert.match(notices.at(-1), /rebuilt from Vault Markdown/);
  const updated = tabs[0].containerEl.children.find((child) => child.name === 'Index status');
  assert.match(updated.description, /ready\. 1 sources, 1 chunks/);
  assert.equal(file.content, '# Vault note');
});

test('Advanced rebuild reports failure and allows a retry', async () => {
  const { plugin, tabs, MockTFile, notices } = await loadPlugin(null);
  const file = new MockTFile('note.md', '# Vault note');
  plugin.app.vault.files = [file];
  const read = plugin.app.vault.read;
  plugin.app.vault.read = async () => { throw new Error('Vault read failed'); };
  tabs[0].display();
  await tabs[0].containerEl.children.find((child) => child.name === 'Rebuild index').button.click();
  assert.equal(plugin.getIndexStatus().state, 'failed');
  assert.match(notices.at(-1), /could not rebuild/);
  assert.equal(file.content, '# Vault note');
  plugin.app.vault.read = read;
  await tabs[0].containerEl.children.find((child) => child.name === 'Rebuild index').button.click();
  assert.equal(plugin.getIndexStatus().state, 'ready');
  assert.equal(plugin.getIndexStatus().sources, 1);
});

test('rebuild command indexes Vault Markdown locally, blocks duplicate runs, and reports retryable failure', async () => {
  const { plugin, commands, MockTFile, notices, requests, modals } = await loadPlugin(null);
  const command = commands.find((item) => item.id === 'rebuild-index');
  assert.equal(command.name, 'Rebuild index');
  const file = new MockTFile('note.md', '# Vault note');
  plugin.app.vault.files = [file];
  const read = plugin.app.vault.read;
  let release;
  let signalRead;
  const readStarted = new Promise((resolve) => { signalRead = resolve; });
  plugin.app.vault.read = () => new Promise((resolve) => {
    release = () => resolve(file.content);
    signalRead();
  });
  const pending = command.callback();
  assert.equal(plugin.getIndexStatus().state, 'rebuilding');
  assert.match(notices.at(-1), /rebuilding/);
  await readStarted;
  await command.callback();
  assert.match(notices.at(-1), /already in progress/);
  release();
  await pending;
  assert.equal(plugin.getIndexStatus().state, 'ready');
  assert.equal((await plugin.fullTextSearch.search('Vault', 5)).length, 1);
  assert.equal(file.content, '# Vault note');
  assert.deepEqual(requests, []);
  assert.equal(modals.length, 0);

  plugin.app.vault.read = async () => { throw new Error('private note contents'); };
  await command.callback();
  assert.equal(plugin.getIndexStatus().state, 'failed');
  assert.match(notices.at(-1), /could not rebuild/);
  assert.doesNotMatch(notices.at(-1), /private note contents/);
  plugin.app.vault.read = read;
  await command.callback();
  assert.equal(plugin.getIndexStatus().state, 'ready');
});

test('failed search mode save keeps full-text enabled', async () => {
  const { plugin, tabs, notices, requests } = await loadPlugin(null, true);
  tabs[0].display();
  const consent = tabs[0].containerEl.children.find((child) => child.name === 'Search method');
  await consent.dropdown.change('local');
  assert.equal(plugin.settings.searchMode, 'full-text');
  assert.equal(consent.dropdown.value, 'full-text');
  assert.match(notices[0], /Could not save search method/);
  assert.equal(requests.length, 0);
});

test('built plugin loads and opens a settings tab with the default Vault notice', async () => {
  const { manifest, plugin, tabs, listeners, MockPlugin } = await loadPlugin(null);
  assert.equal(manifest.id, 'prism');
  assert.equal(manifest.isDesktopOnly, false);
  assert.equal(manifest.minAppVersion, '1.11.4');
  assert.ok(plugin instanceof MockPlugin);
  assert.equal(tabs.length, 1);
  assert.ok(listeners.has('create'));
  assert.ok(listeners.has('modify'));
  assert.ok(listeners.has('rename'));
  assert.ok(listeners.has('delete'));
  tabs[0].display();
  assert.equal(tabs[0].containerEl.children[0].toggle.value, true);
  assert.match(tabs[0].containerEl.children[1].text, /Markdown/);
});

test('changing the notice persists and is restored after restart', async () => {
  const first = await loadPlugin(null);
  first.tabs[0].display();
  await first.tabs[0].containerEl.children[0].toggle.change(false);
  assert.deepEqual(first.writes, [{ showVaultNotice: false }]);
  assert.equal(first.tabs[0].containerEl.children.some((child) => child.text?.includes?.('source of truth')), false);

  const restarted = await loadPlugin(first.writes[0]);
  restarted.tabs[0].display();
  assert.equal(restarted.tabs[0].containerEl.children[0].toggle.value, false);
  assert.equal(restarted.tabs[0].containerEl.children.some((child) => child.text?.includes?.('source of truth')), false);
});

test('invalid saved settings fall back to the default', async () => {
  for (const saved of [null, 'invalid', { showVaultNotice: 'false' }]) {
    const { plugin } = await loadPlugin(saved);
    assert.equal(plugin.settings.showVaultNotice, true);
    assert.equal(plugin.settings.searchMode, 'full-text');
  }
  await assert.rejects(loadPlugin({ excludedPaths: ['../outside.md'] }), /Vault-relative/);
});

test('failed save keeps the previous setting and reports the error', async () => {
  const { plugin, tabs, notices } = await loadPlugin(null, true);
  tabs[0].display();
  const toggle = tabs[0].containerEl.children[0].toggle;
  await toggle.change(false);
  assert.equal(plugin.settings.showVaultNotice, true);
  assert.equal(toggle.value, true);
  assert.match(notices[0], /could not save/);
});

test('source registry records survive restart alongside settings', async () => {
  const first = await loadPlugin({ showVaultNotice: false });
  const record = await first.plugin.sourceRegistry.create({
    path: 'Notes/one.md', content: '# Note', mtime: 12, size: 6,
  });
  assert.equal(first.writes[0].showVaultNotice, false);
  assert.equal(first.writes[0].sourceRegistry[0].source_id, record.source_id);

  const restarted = await loadPlugin(first.writes[0]);
  assert.deepEqual(structuredClone(restarted.plugin.sourceRegistry.getById(record.source_id)), structuredClone(record));
  await restarted.plugin.setShowVaultNotice(true);
  assert.equal(restarted.writes[0].sourceRegistry[0].source_id, record.source_id);
});

test('chunk registry persists alongside sources and settings', async () => {
  const first = await loadPlugin({ showVaultNotice: false });
  const source = await first.plugin.sourceRegistry.create({
    path: 'one.md', content: '# One', mtime: 1, size: 5,
  });
  const chunk = {
    chunk_id: 'chunk-1', source_id: source.source_id, content: '# One',
    content_hash: 'hash-1', location: { startLine: 1, endLine: 1 },
  };
  await first.plugin.chunkRegistry.put([chunk]);
  const restarted = await loadPlugin(first.writes.at(-1));
  assert.equal(restarted.plugin.settings.showVaultNotice, false);
  assert.deepEqual(structuredClone(restarted.plugin.chunkRegistry.get('chunk-1')), chunk);
});

test('provider models persist and remote data transmission is disclosed', async () => {
  const first = await loadPlugin(null);
  first.tabs[0].display();
  const children = first.tabs[0].containerEl.children;
  const disclosure = children.find((child) => typeof child.text === 'string' && child.text.includes('Remote processing'));
  assert.match(disclosure.text, /Search indexing and query embeddings run on this device/);
  assert.match(disclosure.text, /query, up to 6 recent question\/answer pairs.*plus retrieved source IDs, chunk IDs, and text/);
  await children.find((child) => child.name === 'LLM model').text.change('text-model');
  const restarted = await loadPlugin(first.writes.at(-1));
  assert.equal(restarted.plugin.settings.llmModel, 'text-model');
});

test('API keys use Secret Storage and are never shown or saved as plugin data', async () => {
  const first = await loadPlugin(null);
  first.tabs[0].display();
  const keySetting = first.tabs[0].containerEl.children.find((child) => child.name === 'LLM API key');
  assert.equal(keySetting.text.inputEl.type, 'password');
  keySetting.text.setValue('private-test-value');
  keySetting.text.commit();
  assert.equal(first.storedSecrets.get('prism-llm-api-key'), 'private-test-value');
  assert.equal(keySetting.text.value, '');
  assert.doesNotMatch(JSON.stringify(first.writes), /private-test-value/);
  first.tabs[0].display();
  const configured = first.tabs[0].containerEl.children.find((child) => child.name === 'LLM API key');
  assert.equal(configured.text.value, '');
  assert.match(configured.description, /Configured/);
  configured.button.click();
  assert.equal(first.storedSecrets.get('prism-llm-api-key'), '');
});


test('automatic model failure and empty response stop retries until manual refresh', async () => {
  for (const initial of [{ status: 503, text: 'private response' },
    { status: 200, text: JSON.stringify({ models: [] }) }]) {
    const secrets = new Map([['prism-codex-credential', JSON.stringify({
      accessToken: 'test-access', refreshToken: 'test-refresh', accountId: 'account-1',
      expiresAt: Date.now() + 3600_000,
    })]]);
    let response = initial;
    const { plugin, tabs, requests } = await loadPlugin({ llmConnection: 'chatgpt-codex', codexModel: 'saved' },
      false, secrets, (request) => request.url.includes('/codex/models') ? response : undefined);
    const setting = (name) => tabs[0].containerEl.children.find((child) => child.name === name);
    tabs[0].display();
    tabs[0].display();
    await new Promise(setImmediate);
    tabs[0].display();
    await new Promise(setImmediate);
    assert.equal(requests.filter((request) => request.url.includes('/codex/models')).length, 1);
    assert.equal(setting('Codex model').text, undefined);
    assert.equal(setting('Codex model').dropdown.value, 'saved');
    assert.match(setting('Codex models').description, /Could not load/);
    assert.doesNotMatch(setting('Codex models').description, /private response|test-access/);
    assert.equal(plugin.settings.codexModel, 'saved');
    response = { status: 200, text: JSON.stringify({ models: [{ slug: 'fresh', visibility: 'list' }] }) };
    await setting('Codex models').button.click();
    assert.equal(setting('Codex model').dropdown.value, 'saved');
    assert.ok(setting('Codex model').dropdown.options.has('fresh'));
    response = initial;
    await setting('Codex models').button.click();
    assert.ok(setting('Codex model').dropdown.options.has('fresh'));
    assert.equal(plugin.settings.codexModel, 'saved');
    plugin.signOutCodex();
    tabs[0].display();
    await new Promise(setImmediate);
    assert.equal(plugin.getCodexStatus().models.length, 0);
    assert.equal(requests.filter((request) => request.url.includes('/codex/models')).length, 3);
  }
});


test('model loading disables duplicate refresh and does not redraw hidden or signed-out settings', async () => {
  for (const action of ['hide', 'sign-out']) {
    const secrets = new Map([['prism-codex-credential', JSON.stringify({
      accessToken: 'test-access', refreshToken: 'test-refresh', accountId: 'account-1',
      expiresAt: Date.now() + 3600_000,
    })]]);
    let release;
    const { plugin, tabs, requests } = await loadPlugin({ llmConnection: 'chatgpt-codex' }, false, secrets,
      (request) => request.url.includes('/codex/models') ? new Promise((resolve) => { release = resolve; }) : undefined);
    tabs[0].display();
    await new Promise(setImmediate);
    const settings = tabs[0].containerEl;
    const button = settings.children.find((child) => child.name === 'Codex models').button;
    assert.equal(button.disabled, true);
    await button.click();
    tabs[0].display();
    assert.equal(requests.filter((request) => request.url.includes('/codex/models')).length, 1);
    if (action === 'hide') tabs[0].hide();
    else { plugin.signOutCodex(); tabs[0].display(); }
    const children = settings.children;
    release({ status: 200, text: JSON.stringify({ models: [{ slug: 'late', visibility: 'list' }] }) });
    await new Promise(setImmediate);
    assert.equal(settings.children, children);
    if (action === 'sign-out') assert.equal(plugin.getCodexStatus().models.length, 0);
  }
});


test('disconnected Codex model is a dropdown even with no saved selection', async () => {
  const { tabs, requests } = await loadPlugin({ llmConnection: 'chatgpt-codex', codexModel: '' });
  tabs[0].display();
  const model = tabs[0].containerEl.children.find((child) => child.name === 'Codex model');
  assert.equal(model.text, undefined);
  assert.equal(model.dropdown.value, '');
  assert.equal(model.dropdown.options.get(''), 'No models available');
  await new Promise(setImmediate);
  assert.equal(requests.length, 0);
});
