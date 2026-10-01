import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

async function loadPlugin(savedData, failSave = false, storedSecrets = new Map()) {
  const manifest = JSON.parse(await readFile(new URL('../manifest.json', import.meta.url), 'utf8'));
  const bundle = await readFile(new URL('../main.js', import.meta.url), 'utf8');
  const module = { exports: {} };
  const tabs = [];
  const writes = [];
  const notices = [];
  const listeners = new Map();

  class MockTFile {
    constructor(path, content = '') {
      this.path = path;
      this.extension = path.split('.').at(-1);
      this.content = content;
      this.stat = { mtime: 1, size: content.length };
    }
  }

  class MockPlugin {
    app = { secretStorage: {
      setSecret(id, value) { storedSecrets.set(id, value); },
      getSecret(id) { return storedSecrets.get(id) ?? null; },
    }, vault: {
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
  }

  class MockPluginSettingTab {
    containerEl = {
      children: [],
      empty() { this.children = []; },
      createEl(tag, options) { this.children.push({ tag, text: options.text }); },
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
    addButton(callback) {
      const button = {
        setButtonText(value) { this.label = value; return this; },
        onClick(handler) { this.click = handler; return this; },
      };
      callback(button);
      this.button = button;
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
        PluginSettingTab: MockPluginSettingTab,
        Setting: MockSetting,
        Notice: class { constructor(message) { notices.push(message); } },
        TFile: MockTFile,
      };
    },
  });

  const plugin = new module.exports.default();
  await plugin.onload();
  return { manifest, plugin, tabs, writes, notices, listeners, storedSecrets, MockPlugin, MockTFile };
}

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
  }
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
  assert.match(disclosure.text, /query plus retrieved source IDs and text/);
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
