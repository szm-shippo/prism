import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

class MockElement {
  constructor(tag) {
    this.tag = tag;
    this.children = [];
    this.listeners = new Map();
    this.style = {};
    this.textContent = '';
    this.value = '';
    this.disabled = false;
  }

  empty() { this.children = []; this.textContent = ''; }
  createEl(tag, options = {}) {
    const child = new MockElement(tag);
    child.textContent = options.text ?? '';
    child.attributes = options.attr ?? {};
    this.children.push(child);
    return child;
  }
  createDiv(options) { return this.createEl('div', options); }
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
          const inputs = JSON.parse(request.body).input;
          return { status: 200, text: JSON.stringify({
            data: inputs.map((_, index) => ({ index, embedding: [index + 1, 1] })),
          }) };
        },
      };
    },
  });

  const plugin = new module.exports.default();
  await plugin.onload();
  return { manifest, plugin, tabs, writes, notices, listeners, storedSecrets, MockPlugin, MockTFile,
    requests, openedFiles, commands, ribbonIcons, leaves, revealed };
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
  assert.equal(visibleText(view.contentEl.children.at(-2)), 'Grounded answer [^1]');
  const inline = findElement(view.contentEl.children.at(-2), (element) => element.tag === 'button');
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
  const button = findElement(view.contentEl, (element) => element.tag === 'button');
  const status = findElement(view.contentEl, (element) => element.attributes?.role === 'status');
  let calls = 0;
  plugin.answerQuery = () => { calls += 1; return Promise.reject(new Error('private note contents')); };
  await form.submit();
  assert.equal(status.textContent, 'Enter a question.');
  assert.equal(input.focused, true);
  assert.equal(calls, 0);
  input.value = 'Question';
  let fail;
  plugin.answerQuery = () => { calls += 1; return new Promise((_resolve, reject) => { fail = reject; }); };
  const pending = form.submit();
  assert.equal(status.textContent, 'Answering…');
  assert.equal(button.disabled, true);
  await form.submit();
  assert.equal(calls, 1);
  fail(new Error('private note contents'));
  await pending;
  assert.match(status.textContent, /Check provider settings, indexing, and network/);
  assert.doesNotMatch(status.textContent, /private note contents/);
  assert.equal(button.disabled, false);
  plugin.answerQuery = async () => ({ content: '<img src=x onerror=alert(1)>', citations: [{
    sourceId: 'one', chunkId: 'one', path: '<b>source.md', startLine: 2, endLine: 3,
  }] });
  await form.submit();
  assert.equal(visibleText(view.contentEl.children.at(-2)), '<img src=x onerror=alert(1)>');
  assert.equal(findElement(view.contentEl, (element) => element.tag === 'img'), undefined);
  assert.match(visibleText(findElement(view.contentEl, (element) => element.tag === 'li')), /<b>source\.md/);
  assert.equal(status.textContent, 'Answer ready.');
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
  const answer = view.contentEl.children.at(-2);
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

test('query uses a consented vector index and discloses the query embedding request', async () => {
  const { plugin, listeners, MockTFile, requests, tabs } = await loadPlugin(null);
  await plugin.setEmbeddingModel('embedding-model');
  plugin.setEmbeddingApiKey('test-key');
  await plugin.setAllowRemoteEmbeddingIndexing(true);
  await plugin.setLlmModel('answer-model');
  plugin.setLlmApiKey('test-key');
  const file = new MockTFile('facts.md', '# Searchable fact');
  plugin.app.vault.files = [file];
  await listeners.get('create')(file);
  const answer = await plugin.answerQuery('Searchable');
  assert.equal(answer.citations[0].path, 'facts.md');
  assert.deepEqual(requests.map((request) => request.url), [
    'https://api.openai.com/v1/embeddings',
    'https://api.openai.com/v1/embeddings',
    'https://api.openai.com/v1/responses',
  ]);
  assert.deepEqual(JSON.parse(requests[1].body).input, ['Searchable']);
  tabs[0].display();
  assert.match(tabs[0].containerEl.children.find((child) => child.text?.startsWith('Remote processing')).text,
    /query for vector search/);
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

test('excluded Markdown is never sent for remote embedding and existing vectors are removed', async () => {
  const { plugin, listeners, MockTFile, requests } = await loadPlugin(null);
  await plugin.setEmbeddingModel('embedding-model');
  plugin.setEmbeddingApiKey('test-key');
  await plugin.setAllowRemoteEmbeddingIndexing(true);
  await plugin.setExcludedPaths('Private/');
  const privateFile = new MockTFile('Private/secret.md', '# Secret');
  await listeners.get('create')(privateFile);
  assert.equal(requests.length, 0);
  const publicFile = new MockTFile('public.md', '# Public');
  await listeners.get('create')(publicFile);
  assert.equal(requests.length, 1);
  const publicId = plugin.sourceRegistry.getByPath('public.md').source_id;
  assert.equal(plugin.vectorStore.listBySource(publicId).length, 1);
  await plugin.setExcludedPaths('Private/\npublic.md');
  assert.equal(plugin.vectorStore.listBySource(publicId).length, 0);
  assert.equal(plugin.sourceRegistry.getByPath('public.md'), undefined);
  assert.equal(requests.length, 1);
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

test('full rebuild replaces stale sources and indexes from Vault Markdown, including consented vectors', async () => {
  const { plugin, listeners, MockTFile, requests } = await loadPlugin(null);
  await plugin.setEmbeddingModel('test-embedding-model');
  plugin.setEmbeddingApiKey('test-key');
  await plugin.setAllowRemoteEmbeddingIndexing(true);
  const stale = new MockTFile('stale.md', '# Stale');
  await listeners.get('create')(stale);
  const staleId = plugin.sourceRegistry.getByPath('stale.md').source_id;
  assert.equal(requests.length, 1);

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
  assert.equal(requests.length, 2);
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
  assert.match(rebuild.description, /sends Markdown chunks to OpenAI/);
  assert.equal(rebuild.button.disabled, false);
  await rebuild.button.click();
  assert.deepEqual(structuredClone(plugin.getIndexStatus()), { state: 'ready', sources: 1, chunks: 1 });
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

test('remote indexing sends only changed chunks after explicit opt-in and stops after opt-out', async () => {
  const { plugin, listeners, MockTFile, requests, tabs, writes } = await loadPlugin(null);
  await plugin.setEmbeddingModel('test-embedding-model');
  plugin.setEmbeddingApiKey('test-key');
  const file = new MockTFile('private.md', '# First\n## Detail\nBody');
  await listeners.get('create')(file);
  assert.equal(requests.length, 0);
  tabs[0].display();
  const consent = tabs[0].containerEl.children.find((child) => child.name === 'Send changed chunks to OpenAI for search indexing');
  assert.equal(consent.toggle.value, false);
  assert.match(consent.description, /https:\/\/api\.openai\.com\/v1\/embeddings/);
  assert.match(consent.description, /new or changed Markdown chunks/);
  await consent.toggle.change(true);
  assert.equal(requests.length, 0);
  assert.equal(plugin.settings.allowRemoteEmbeddingIndexing, true);
  const enabled = await loadPlugin(writes.at(-1));
  assert.equal(enabled.plugin.settings.allowRemoteEmbeddingIndexing, true);
  assert.equal(enabled.requests.length, 0);
  file.content = '# Updated\n## Detail\nBody';
  file.stat.size = file.content.length;
  await listeners.get('modify')(file);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://api.openai.com/v1/embeddings');
  assert.deepEqual(JSON.parse(requests[0].body).input, ['# Updated', '## Detail\nBody']);
  assert.equal(writes.at(-1).vectorIndex.entries.length, 2);
  await listeners.get('modify')(file);
  assert.equal(requests.length, 1);
  file.content = '# Updated\n## Detail\nChanged body';
  file.stat.size = file.content.length;
  await listeners.get('modify')(file);
  assert.equal(requests.length, 2);
  assert.deepEqual(JSON.parse(requests[1].body).input, ['## Detail\nChanged body']);
  await plugin.setAllowRemoteEmbeddingIndexing(false);
  const disabled = await loadPlugin(writes.at(-1));
  assert.equal(disabled.plugin.settings.allowRemoteEmbeddingIndexing, false);
  file.content = '# Local only';
  file.stat.size = file.content.length;
  await listeners.get('modify')(file);
  assert.equal(requests.length, 2);
  assert.equal((await plugin.fullTextSearch.search('Local only', 5)).length, 1);
  assert.equal((await plugin.vectorStore.search([1, 1], 5)).length, 0);
  await listeners.get('delete')(file);
  assert.equal((await plugin.fullTextSearch.search('Local only', 5)).length, 0);
  assert.equal(requests.length, 2);
});

test('failed consent save leaves remote indexing disabled', async () => {
  const { plugin, tabs, notices, requests } = await loadPlugin(null, true);
  tabs[0].display();
  const consent = tabs[0].containerEl.children.find((child) => child.name === 'Send changed chunks to OpenAI for search indexing');
  await consent.toggle.change(true);
  assert.equal(plugin.settings.allowRemoteEmbeddingIndexing, false);
  assert.equal(consent.toggle.value, false);
  assert.match(notices[0], /could not save remote indexing consent/);
  assert.equal(requests.length, 0);
});

test('missing embedding credentials after opt-in keep local text searchable without a request', async () => {
  const { plugin, listeners, MockTFile, requests, notices } = await loadPlugin(null);
  await plugin.setAllowRemoteEmbeddingIndexing(true);
  const file = new MockTFile('no-key.md', '# Local result');
  await listeners.get('create')(file);
  assert.equal(requests.length, 0);
  assert.equal((await plugin.fullTextSearch.search('Local result', 5)).length, 1);
  assert.match(notices[0], /embedding settings/);
  assert.equal(file.content, '# Local result');
});

test('changing the embedding model discards vectors from the previous model', async () => {
  const { plugin, listeners, MockTFile, requests, writes } = await loadPlugin(null);
  await plugin.setEmbeddingModel('model-one');
  plugin.setEmbeddingApiKey('test-key');
  await plugin.setAllowRemoteEmbeddingIndexing(true);
  const file = new MockTFile('model.md', '# Model');
  await listeners.get('create')(file);
  assert.equal(requests.length, 1);
  assert.equal(writes.at(-1).vectorIndexModel, 'model-one');
  await plugin.setEmbeddingModel('model-two');
  assert.equal(plugin.vectorStore, undefined);
  assert.equal(writes.at(-1).vectorIndex, null);
  assert.equal(requests.length, 1);
  file.content = '# New model';
  file.stat.size = file.content.length;
  await listeners.get('modify')(file);
  assert.equal(requests.length, 2);
  assert.equal(writes.at(-1).vectorIndexModel, 'model-two');
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
    assert.equal(plugin.settings.allowRemoteEmbeddingIndexing, false);
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
  assert.match(disclosure.text, /OpenAI receives Markdown or chunk text/);
  assert.match(disclosure.text, /query plus retrieved source IDs, chunk IDs, and text/);
  await children.find((child) => child.name === 'Embedding model').text.change('embedding-model');
  await children.find((child) => child.name === 'LLM model').text.change('text-model');
  const restarted = await loadPlugin(first.writes.at(-1));
  assert.equal(restarted.plugin.settings.embeddingModel, 'embedding-model');
  assert.equal(restarted.plugin.settings.llmModel, 'text-model');
});

test('API keys use Secret Storage and are never shown or saved as plugin data', async () => {
  const first = await loadPlugin(null);
  first.tabs[0].display();
  const keySetting = first.tabs[0].containerEl.children.find((child) => child.name === 'Embedding API key');
  assert.equal(keySetting.text.inputEl.type, 'password');
  keySetting.text.setValue('private-test-value');
  keySetting.text.commit();
  assert.equal(first.storedSecrets.get('prism-embedding-api-key'), 'private-test-value');
  assert.equal(keySetting.text.value, '');
  assert.doesNotMatch(JSON.stringify(first.writes), /private-test-value/);
  first.tabs[0].display();
  const configured = first.tabs[0].containerEl.children.find((child) => child.name === 'Embedding API key');
  assert.equal(configured.text.value, '');
  assert.match(configured.description, /Configured/);
  configured.button.click();
  assert.equal(first.storedSecrets.get('prism-embedding-api-key'), '');
});
