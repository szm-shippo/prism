# Prism

Obsidian Vault の Markdown を知識の正本として扱い、Vault の内容について質問できるプラグインです。機能と実装順序は [`spec/implementation-order.md`](spec/implementation-order.md) を参照してください。

コードの責務と依存方向は [モジュール境界](docs/architecture.md) に記載しています。

## 開発

Node.js 20.9 以降と npm を用意して、次を実行します。

```sh
npm ci
npm run build
npm test
```

開発中は `npm run dev` で変更を監視して `main.js` を再生成できます。

## Obsidian での確認

ビルド後、`target/` 内の成果物をテスト用 Vault の `.obsidian/plugins/prism/` にコピーします。

## ChatGPT (Codex) 接続

設定の「LLM connection」で「ChatGPT (Codex, experimental)」を選び、「Connect」で表示されたコードを OpenAI の認証ページに入力します。

## GitHub Copilot (Desktop)

Obsidian Desktop では Copilot CLI を `copilot login` で認証し、Prism 設定の「Check CLI login」を実行します。詳細は [GitHub Copilot 接続手順](docs/github-copilot.md) を参照してください。

## ローカル Embedding

使い方は [ローカル Embedding の利用手順](docs/local-embedding.md) を参照してください。

## データとプライバシー

- 回答生成では、質問、送信対象の過去の質問・回答、取得した出典 ID・chunk ID・本文が選択した接続先に送られます。送信範囲は Ask の「Data sent」で確認できます。「Test connection」とモデル一覧の取得では Vault 本文を送信しません。
- OpenAI API キーと ChatGPT/Codex 認証は Obsidian Secret Storage に保存します。Copilot CLI の認証情報は CLI が管理し、Prism には GitHub.com host と login だけを保存します。
- 全文検索とベクトル化は端末内で処理し、OpenAI Embeddings API は使いません。ChatGPT/Codex の接続に失敗しても、OpenAI API キー接続へ自動的に切り替わりません。
