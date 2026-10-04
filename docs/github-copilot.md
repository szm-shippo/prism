# GitHub Copilot (Desktop)

Prism は Obsidian Desktop で GitHub Copilot を回答プロバイダーとして使用できます。公式 `@github/copilot-sdk` を使い、SDK と互換性のある GitHub Copilot CLI 実行ファイルは利用者がインストールします。CLI は Prism に同梱されません。iOS と Android ではこのプロバイダーや SDK runtime を読み込まず、OpenAI API キーと ChatGPT (Codex) の既存接続を引き続き利用できます。

## 接続の準備

1. GitHub Copilot を利用できるアカウントで、互換性のある GitHub Copilot CLI をインストールします。
2. GitHub OAuth App を自分で作成し、Device Flow を有効にします。Prism に OAuth App の Client ID を入力します。Client Secret や repository scope は要求しません。
3. Prism の `LLM connection` で `GitHub Copilot (Desktop)` を選び、Client ID と CLI 実行ファイルの絶対パスを設定します。
4. `Connect` を押し、表示されたコードを `https://github.com/login/device` で入力して認証します。
5. SDK が返したモデル一覧からモデルを選び、`Test connection` で接続を確認します。

OAuth の access token と GitHub account 情報は、この Obsidian デバイスの Secret Storage に保存されます。GitHub が実際に返した expiry と refresh token だけを保存し、期限のない token に有効期限を補いません。期限の切れた token を更新できない場合は再接続が必要です。Client ID、CLI path、選択モデルは Prism の通常の設定データに保存されます。

## 送信されるデータ

- SDK のモデル一覧取得では、OAuth token を使って利用可能なモデル名を読み込みます。Vault の Markdown、質問、会話履歴は送りません。
- `Test connection` は固定文 `Reply with OK.` のみを選択モデルへ送り、Vault の内容や会話履歴は送りません。
- Ask では、質問、直近の成功した最大 6 往復（合計 12,000 UTF-8 bytes まで）、および検索で選んだ出典 ID・Chunk ID・本文を GitHub Copilot に送ります。会話履歴は Ask view のメモリ内だけにあり、Markdown へ保存しません。
- 全文検索、Embedding、検索インデックスの作成と更新はこのデバイスで実行します。GitHub Copilot が失敗しても別の Provider や API key に自動で切り替えません。

GitHub の OAuth App Device Flow は OAuth App の Client ID を使い、Client Secret を token 交換へ含めません。詳しくは [GitHub OAuth App Device Flow](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps) と [公式 Copilot SDK for Node.js](https://github.com/github/copilot-sdk/tree/v1.0.16/nodejs) を参照してください。

実際の GitHub account、インストール済み CLI、macOS / Windows / Linux、iOS / Android での動作確認はリリース前に別途実施が必要です。
