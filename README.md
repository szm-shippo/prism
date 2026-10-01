# Prism

Obsidian Vault の Markdown を知識の正本として扱うプラグインです。現在は Source・Chunk の派生データ管理と Provider 設定までを実装しています。機能と実装順序は [`spec/implementation-order.md`](spec/implementation-order.md) を参照してください。

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

Obsidian 1.11.4 以降を使用します。テスト用 Vault の `.obsidian/plugins/prism/` に `manifest.json` とビルドした `main.js` を置き、Obsidian のコミュニティプラグイン設定から Prism を有効にします。設定画面の Prism タブでは、Vault の Markdown が知識の正本であることを示す案内文を切り替えられます。

Provider 設定では OpenAI の Embedding・LLM モデル ID と API キーを入力できます。モデル ID はプラグイン設定データ、API キーは Obsidian Secret Storage に保存します。API キー欄は入力後に離れると保存され、保存済みの値は再表示されません。設定画面からキーを消去できます。Embedding リクエストでは Markdown または Chunk の本文、回答生成では質問と取得した source ID・本文が OpenAI へ送信されます。現時点で設定画面からリクエストを実行する機能はありません。
