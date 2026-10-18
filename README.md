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

## 検索用 frontmatter の生成

コマンドパレットから「Generate search frontmatter」を実行すると、選択中のLLM接続先とモデルを使い、実行ごとの確認後に現在のMarkdown本文だけを送信します。ファイル名、既存frontmatter、Askの会話履歴、検索結果は送りません。LLM応答は3項目だけのJSONオブジェクト（summaryは文字列、keywordsとaliasesは文字列配列）として検証し、`prism_summary`、`prism_keywords`、`prism_aliases` だけを自動更新します。

本文はUTF-8で12,000バイトまでです。summaryは240文字まで、keywordsは12件まで、aliasesは8件までで、各語句は64文字までです。応答JSONに同じキーが重複している場合も書き込みません。

既存frontmatterでは3項目の値の部分だけを置き換え、ない項目はfrontmatterの末尾に追加します。値は `"..."` の文字列と `["...", "..."]` のリストで書きます。他のプロパティ、コメント、空行、引用符などの書き方、BOM、改行コード、本文は変えません。重複キーやアンカーなど、置き換える範囲を確実に特定できないfrontmatterでは送信前に中断します（対象は[モジュール境界](docs/architecture.md#検索用-frontmatter)を参照）。

同じノートを複数のタブで開いている場合や、確認後にノートまたはLLM設定が変わった場合も中断し、再試行を案内します。書き込み中にエラーが起きた場合は、エディターとファイルを読み直し、変更なし・書き込み済み・一部のみ反映・確認できない、のいずれかを通知します。自動で元に戻したり再試行したりはしません。

この機能では選択中のLLMに本文を送り、失敗しても別の接続先へ切り替えません。ローカルの全文検索・Embedding処理とは別の機能です。

## ローカル Embedding

使い方は [ローカル Embedding の利用手順](docs/local-embedding.md) を参照してください。

## データとプライバシー

- 回答生成では、質問、送信対象の過去の質問・回答、取得した出典 ID・chunk ID・本文が選択した接続先に送られます。送信範囲は Ask の「Data sent」で確認できます。「Test connection」とモデル一覧の取得では Vault 本文を送信しません。
- OpenAI API キーと ChatGPT/Codex 認証は Obsidian Secret Storage に保存します。Copilot CLI の認証情報は CLI が管理し、Prism には GitHub.com host と login だけを保存します。
- 全文検索とベクトル化は端末内で処理し、OpenAI Embeddings API は使いません。ChatGPT/Codex の接続に失敗しても、OpenAI API キー接続へ自動的に切り替わりません。
