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

Obsidian 1.11.4 以降を使用します。ビルドで生成する `target/` の `manifest.json`、`main.js`、`local-embedding-worker.js`、`ort-wasm-simd-threaded.jsep.mjs`、`ort-wasm-simd-threaded.jsep.wasm`、`LOCAL_EMBEDDING_LICENSES.txt` をテスト用 Vault の `.obsidian/plugins/prism/` に置き、Obsidian のコミュニティプラグイン設定から Prism を有効にします。設定画面の Prism タブでは、Vault の Markdown が知識の正本であることを示す案内文を切り替えられます。

Provider 設定で回答に使う接続とモデルを選び、API キー接続ではキーも入力します。既存ノートは Advanced の「Rebuild index」またはコマンドパレットの「Prism: Rebuild index」で検索索引を作成します。リモート Embedding を有効にしている場合、コマンドからの再構築は Markdown chunk の OpenAI への送信を確認してから始まります。コマンドパレットの「Prism: Open Ask view」またはリボンの Prism アイコンから質問画面を開き、質問を入力して「Ask」を押します。回答中の引用番号または Sources 一覧の出典をクリック・タップすると、現在の Vault パスにある原文を開きます。原文が見つからない場合は質問画面に通知します。回答は Markdown に保存されません。

同じ Ask 画面で追質問すると、質問・回答・出典がターンごとに順番に表示されます。各ターンで Vault を検索し、過去の回答は質問の文脈にだけ使います。「New conversation」で履歴をリセットできます。送信する履歴は直近の成功した最大 6 組の質問・回答、JSON 表現で 12,000 UTF-8 bytes までです。組を分割せず、収まらない組とそれ以前を省略して、そのターンに省略件数を表示します。検索には送信対象の過去の質問を加えます。長い会話や話題変更で結果が不十分な場合は、質問に対象を明記するか新しい会話を始めてください。失敗しても既存の会話と入力を保持し、最後の失敗ターンは「Retry」で再試行できます。送信中は入力・再送信・リセットを無効にします。同じ view の再表示では処理中の回答も保持します。view を破棄した場合やプラグインの再読み込み後は履歴が失われ、永続保存・端末間同期は行いません。

Issue #72 の対話機能は共通の Obsidian View API・DOM・メモリ内状態で実装し、Desktop・iOS・Android 固有の依存を追加していません。2026-10-03 時点でモックによる自動検証を実施しました。Desktop・iOS・Android の実機での表示・操作、実際の LLM 接続での追質問品質は未確認です。

モデル ID と接続の選択はプラグイン設定データ、API キーと ChatGPT 認証情報は Obsidian Secret Storage に保存されます。API キーは保存後に再表示されません。回答生成時には質問、送信対象の過去の質問・回答、取得した source ID・chunk ID・本文が選択した OpenAI の送信先に送られます。Ask 画面の「Data sent」にも送信範囲を表示します。リモート Embedding を有効にすると、新規・変更した Markdown chunk と、ベクトル検索時の質問（送信対象の過去の質問を含む）も OpenAI に送信されます。検索方式が Local full-text の場合はローカル全文検索、Local Embedding の場合は端末内のベクトル化と全文検索を使います。Advanced ではファイル・フォルダを検索索引から除外できます。

## ChatGPT (Codex) 接続

設定の「LLM connection」で「ChatGPT (Codex, experimental)」を選び、「Connect」で表示されたコードを OpenAI の Device Code 認証ページに入力します。ChatGPT 側の設定で Device Code ログインの有効化が必要な場合があります。接続後は Codex モデル ID を指定します。「Test connection」は固定文 `Reply with OK.` のみを `https://chatgpt.com/backend-api/codex/responses` に送信し、現在の接続で応答できるか確認します。このテストでは Vault の内容を送信しません。ChatGPT 認証情報はデバイスごとの Obsidian Secret Storage に保存され、「Sign out」でローカルから消去されます。

接続済みで設定を開くと、モデル一覧を自動取得してメモリ内に保持します。「Refresh models」で最新の一覧を取得でき、失敗時は表示された状態を確認して同じボタンで再試行できます。保存済みの選択モデルは保持され、一覧にない場合は「saved model」と表示します。一覧取得では OAuth トークンを `chatgpt.com` に送信し、Vault 本文は送信しません。

この接続は Codex との実験的な互換方式です。回答時には質問、送信対象の過去の質問・回答、検索で選ばれた出典 ID・本文を `https://chatgpt.com/backend-api/codex/responses` に送信します。公開 API とは異なる経路なので、OpenAI 側の変更で動作しなくなる可能性があります。認証や回答が失敗しても、OpenAI API キーでの課金へ自動的に切り替わりません。OpenAI Embedding を選ぶ場合は別の API キーが必要です。Local Embedding と全文検索には Embedding API キーは不要です。

## ローカル Embedding

検索方式の選択・モデル導入・負荷と検証状況は [ローカル Embedding の利用手順](docs/local-embedding.md) を参照してください。
