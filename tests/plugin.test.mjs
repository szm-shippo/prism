import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

async function loadPlugin(savedData, failSave = false) {
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
    app = { vault: {
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
  return { manifest, plugin, tabs, writes, notices, listeners, MockPlugin, MockTFile };
}

test('built plugin loads and opens a settings tab with the default Vault notice', async () => {
  const { manifest, plugin, tabs, listeners, MockPlugin } = await loadPlugin(null);
  assert.equal(manifest.id, 'prism');
  assert.equal(manifest.isDesktopOnly, false);
  assert.ok(plugin instanceof MockPlugin);
  assert.equal(tabs.length, 1);
  assert.ok(listeners.has('create'));
  assert.ok(listeners.has('modify'));
  tabs[0].display();
  assert.equal(tabs[0].containerEl.children[0].toggle.value, true);
  assert.match(tabs[0].containerEl.children[1].text, /Markdown/);
});

test('changing the notice persists and is restored after restart', async () => {
  const first = await loadPlugin(null);
  first.tabs[0].display();
  await first.tabs[0].containerEl.children[0].toggle.change(false);
  assert.deepEqual(first.writes, [{ showVaultNotice: false }]);
  assert.equal(first.tabs[0].containerEl.children.length, 1);

  const restarted = await loadPlugin(first.writes[0]);
  restarted.tabs[0].display();
  assert.equal(restarted.tabs[0].containerEl.children[0].toggle.value, false);
  assert.equal(restarted.tabs[0].containerEl.children.length, 1);
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
