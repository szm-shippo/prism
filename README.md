# Prism

Obsidian Vault の Markdown を知識の正本として扱うプラグインです。現在はプラグインの最小プロジェクト構成のみを実装しています。機能と実装順序は [`spec/implementation-order.md`](spec/implementation-order.md) を参照してください。

コードの責務と依存方向は [モジュール境界](docs/architecture.md) に記載しています。

## 開発

Node.js と npm を用意して、次を実行します。

```sh
npm ci
npm run build
npm test
```

開発中は `npm run dev` で変更を監視して `main.js` を再生成できます。

## Obsidian での確認

テスト用 Vault の `.obsidian/plugins/prism/` に `manifest.json` とビルドした `main.js` を置き、Obsidian のコミュニティプラグイン設定から Prism を有効にします。現段階では追加の画面やコマンドはありません。
