# Prism

Obsidian Vault の Markdown を知識の正本として扱い、Vault の内容について質問できるプラグインです。機能と実装順序は [`spec/implementation-order.md`](spec/implementation-order.md) を参照してください。

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

Provider 設定で OpenAI の LLM モデル ID と API キーを入力し、既存ノートは Advanced の「Rebuild index」で検索索引を作成します。コマンドパレットの「Prism: Open Ask view」またはリボンの Prism アイコンから質問画面を開き、質問を入力して「Ask」を押します。回答中の引用番号または Sources 一覧の出典をクリック・タップすると、現在の Vault パスにある原文を開きます。原文が見つからない場合は質問画面に通知します。回答は Markdown に保存されません。

モデル ID はプラグイン設定データ、API キーは Obsidian Secret Storage に保存されます。API キーは保存後に再表示されません。回答生成時には質問と取得した source ID・chunk ID・本文が OpenAI に送信されます。リモート Embedding を有効にすると、新規・変更した Markdown chunk と、ベクトル検索時の質問も OpenAI に送信されます。無効時はローカル全文検索を使います。Advanced ではファイル・フォルダを検索索引から除外できます。
