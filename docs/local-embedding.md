# ローカル Embedding

Prism の「Search method」で検索方式を選びます。全文検索は初期値で、モデルを必要としません。Local Embedding は Markdown chunk と検索質問を端末内でベクトル化し、全文検索と組み合わせます。OpenAI Embedding は選択時に画面で示す送信へ同意したうえで使う API 課金の方式です。Local Embedding が失敗しても OpenAI へ切り替わりません。

この選択は検索の設定です。Ask の回答生成は引き続き選択した外部 LLM へ質問、会話履歴、取得した本文と出典 ID を送ります。ローカル検索にしても回答生成はオフラインにはなりません。

## 導入

1. `npm run build` で生成した `target/` の配布ファイルをプラグインディレクトリへ配置します。`main.js`、`manifest.json` に加えて `local-embedding-worker.js`、`ort-wasm-simd-threaded.jsep.mjs`、`ort-wasm-simd-threaded.jsep.wasm`、`LOCAL_EMBEDDING_LICENSES.txt` が必要です。モデル・設定・既存の `data.json` は上書きしないでください。
2. 設定の「Local Embedding model」で送信先・サイズを確認し、「Download / repair model」を押します。モデルはプラグイン有効化時、検索方式の選択時、Rebuild 時には自動取得しません。ダウンロードの通信は公開ファイルの GET のみで、Vault 本文や質問は含みません。
3. 「Search method」を「Local Embedding」にして「Rebuild index」を実行します。導入後の索引作成・検索はオフラインで実行できます。モデルがない状態の再構築は既存の索引を消す前に停止します。

取得元は [Xenova/paraphrase-multilingual-MiniLM-L12-v2](https://huggingface.co/Xenova/paraphrase-multilingual-MiniLM-L12-v2) の revision `2c4055b12046f11709e9df2c122e59ffbdc2f900` です。[元モデル](https://huggingface.co/sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2) は Apache-2.0 です。q8 ONNX 重み、tokenizer、設定を合わせて 135,392,488 bytes（約 129 MiB）を取得します。huggingface.co から Hugging Face の CDN / Xet 配布ホストへリダイレクトされる場合があります。すべてのファイルを固定 SHA-256 とサイズで検証します。

保存先は `<プラグインディレクトリ>/models/<revision>/` です。通常は `.obsidian/plugins/prism/models/` 以下です。モデルは端末ごとに必要です。Vault の同期方式がこのディレクトリを含む場合はモデルも同期される可能性があります。索引は従来のプラグイン `data.json` に保存します。Markdown は変更しません。WASM ランタイムはビルドに同梱するため、推論時の CDN ダウンロードはありません。Transformers.js 3.8.1 は Apache-2.0、ONNX Runtime は MIT で、配布用 `LOCAL_EMBEDDING_LICENSES.txt` にライセンスと第三者通知を含めます。

## 更新と復旧

既存設定の移行では、保存済みの OpenAI 送信同意がある場合は OpenAI、ない場合は全文検索を保持します。移行だけでモデルを取得したりノートを送ったりしません。

検索方式または OpenAI モデルを変更すると旧ベクトルを破棄します。Local Embedding の索引にはモデル revision、量子化方式、pooling、正規化方式を記録し、異なるベクトルを混ぜません。既存ノートを含めるには再構築が必要です。ローカル検索中に OpenAI モデル名だけを編集してもローカル索引は破棄しません。

新規・変更ノートは必要な chunk のみベクトル化します。削除・除外パスは既存の索引更新経路と同様に処理します。除外解除後は再構築してください。途中で推論や保存が失敗した場合、ノート本文は保持します。同じノートの再更新、または再構築で再試行できます。途中の再構築は部分的な索引を残す場合があります。

「Cancel download」は現在の GET が完了するまで待つ場合があります。キャンセルや失敗では新たな準備完了マーカーを保存せず、再試行時はハッシュ検証済みファイルを再利用します。モデルの欠落・破損は「Download / repair model」、ランタイムの欠落は全ビルド成果物の再配置で修復します。オフラインで未導入のモデルを選んだ場合は、接続して導入するか全文検索を選んでください。

推論エラー・Worker 終了時には Worker を破棄し、次の操作で読み込み直します。120 秒応答がない場合も停止して再試行を案内します。メモリ不足の場合は他のアプリを閉じ、Prism を再読み込みするか全文検索を選んでください。

## 負荷とプラットフォーム

ブラウザー用の [Transformers.js](https://huggingface.co/docs/transformers.js/en/custom_usage) と WebAssembly SIMD を専用 module Worker 内で動かします。Node、Electron、GPU、SharedArrayBuffer は不要です。Worker を 1 スレッドとし、入力を 1 件ずつ処理します。Desktop・iOS・Android 共通の Obsidian DataAdapter と Worker API を使いますが、実機での利用可否と速度は未確認です。古い OS / WebView で WASM SIMD や module Worker が使えない場合は更新または全文検索が必要です。

モデルと WASM の入力バッファだけで約 150 MiB あり、tokenizer の展開、推論メモリ、プラグインの索引などが加わります。読み込み時には数百 MiB から 1 GiB を超えるメモリを使う可能性があります。モバイルではアプリが OS に終了される場合があるため、小さいテスト Vault から確認してください。長い chunk / 質問は tokenizer の上限（512 tokens）で末尾が切り詰められます。全文検索には元の chunk 全体が残ります。

設定の「Local Embedding model」には直近の読み込み時間、推論時間、入力件数、モデル＋WASM のバッファ量を表示します。これはプロセスのピークメモリではありません。「Index status」には直近の再構築時間を表示します。

## 検証記録（2026-10-03）

- 自動テスト: モデルの欠落・破損・キャンセル・再試行、通信無効化、Worker 終了後の再起動、設定移行、索引更新・除外・削除、検索方式変更中の遅延ベクトル破棄を検証。
- Windows / headless Edge `154.0.4258.53`: 公開モデルを読み、ブラウザーを offline にして実際の配布 Worker と WASM を実行。「子猫は長椅子で休んでいます。」で「猫がソファで眠っています。」を無関係な天気・バックアップの文より高く取得。類似度は約 0.647 / -0.021 / 0.081、384 次元、外部リクエスト 0 件。
- この PC の 1 回の測定: モデル初期化 852 ms、3 文のベクトル化は初期化を含め 942 ms、質問 1 文の推論 12 ms。推論後の headless ブラウザー全プロセスの PrivateMemorySize64 合計は約 1.28 GiB。テストページ、ブラウザー、tokenizer、WASM などを含む値で、Prism 単体のピークメモリではありません。テスト用モデルを事前にメモリへ読み込んでから測定しており、Obsidian DataAdapter の読み込みや SHA-256 検証の時間は含みません。Vault 全体の索引時間や他端末の負荷には換算できません。
- Obsidian Desktop・iOS・Android の実機でのモデル導入、表示・操作、ピークメモリ、初回読み込み・索引作成時間、および実際の LLM 接続は未実施です。
- Desktop 起動の回帰検証: Obsidian の `nodeIntegrationInWorker: true` と同じ設定、`app://obsidian.md/` の独立した Electron アプリで、旧ビルドが Node backend を選んで Worker 起動時に停止することを再現。Worker と WASM factory の両方をビルド時にブラウザー用へ固定し、Electron `44.5.1` / Chromium `152.0.7977.130` で実モデルのオフライン推論と外部リクエスト 0 件を確認。初期化約 1.01 秒、質問推論約 12 ms。この検証アプリはユーザーの Obsidian プロファイルや Vault を開きません。

実モデルの検証スクリプトは通常の `npm test` に含めず、合成文だけを使用します。再実行には `npm run build` 後に Playwright を一時導入します。

```powershell
npm install --no-save --package-lock=false playwright
$env:PRISM_BROWSER = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
node scripts/validate-local-embedding.mjs --download-model
```

`--download-model` は公開モデルの取得を許可する引数です。次回はこの引数なしで検証済みの `target/models/` を再利用できます。モデル・検証用ファイルは Git に含めません。ブラウザーの場所が異なる場合は `PRISM_BROWSER` を変更してください。

Desktop の起動条件も確認する場合は、独立した Electron 検証アプリを使います。

```powershell
npm install --no-save --package-lock=false playwright electron
node scripts/validate-local-embedding.mjs --electron --download-model
```

Electron の初回導入時には検証用実行ファイルをダウンロードします。検証用プロファイルは `target/local-embedding-electron-profile/` に保存し、ウィンドウは非表示で実行します。
