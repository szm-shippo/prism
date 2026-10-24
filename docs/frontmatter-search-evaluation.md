# 検索用 frontmatter の比較評価

[#99](https://github.com/szm-shippo/prism/issues/99) で、frontmatter を検索の手掛かりに使う A を、厳密な body-only control と比べるための実験用ハーネスです。B は利用者の決定で比較対象から外しました。現段階の採用方向は A ですが、受け入れ判定はまだ出ていません。製品コード、設定、索引形式は変更しません。判定の閾値と手順は `scripts/frontmatter-benchmark/metrics.mjs` に実装しています。測定後に閾値・重み・経路判定を変更しないでください。

## 構成

| 構成 | 内容 |
| --- | --- |
| M | base `2c5ad3b` の main と同じ処理。raw frontmatter を含む Chunk を埋め込み、全文検索・rerank します。参照値で、判定には使いません。 |
| C | body-only control。先頭 frontmatter を除いた検索用テキストだけを全文検索・Vector・rerank に使います。 |
| A | C の本文 Vector に加え、Chunk ごとに「8 属性 + 空行 + Section 見出し」の Vector を別の型付き索引に持ちます。 |

## ファイル

- `scripts/benchmark-frontmatter-search.mjs`: CLI。使い方は冒頭のコメントにあります。
- `scripts/frontmatter-benchmark/`: 検索入力の射影、型付き索引と融合、データセット読込、凍結スナップショット、指標と判定、ディスク保存、Electron 実行部。
- `scripts/frontmatter-benchmark/fixtures/original/`: #96 の実行前 fixture（24 ノート・48 問）。復元時のバイト列のまま置き、`manifest.json` にファイルごとの SHA-256 と、ノート・質問・更新シナリオをまとめた履歴上の結合ハッシュを記録しています。結合ハッシュは正解だけを個別に保証するものではありません。

データセットは `corpus/**.md`、`questions.json`、必須の `manifest.json` を置いたディレクトリです。正解は `goldLine`（1 始まりの行番号）、なければ `section` と一致する行から機械的に求め、その行を含む Chunk を正解 Chunk とします。更新シナリオは `excludedEdits`・`attributeEdits`・`bodyEdits`（パスごとの `[置換前, 置換後]`）を使います。原本形式の `excludedLines`・`addedTag` は #96 のハーネスと同じ置換へ変換します。読込時に次を満たさない場合は実行しません。

- 対象ノートは異なる 4 件で、いずれも索引対象の属性と本文を持つ。
- 属性以外の編集と属性の編集は frontmatter の中だけを変える。
- 本文の編集は本文の 1 行の中に収まる。編集前の行も、編集後の行全体（変わらない前後の部分を含む）も、main の chunker の規則で ATX 見出しにならない。

この検査は行と見出しだけを確かめるもので、編集が 1 文であることは確認しません。1 文の範囲は、独立した custodian が人手で確認し、PASS の semantic seal として記録する必要があります。seal には次を含めます。

- seal ファイルの SHA-256
- 両データセットのスナップショット SHA-256
- `updateScenariosSha256`
- 全編集の範囲

この seal は最初の C 実行の前に必要な手順で、ハーネスには自動検証として実装していません。CLI が技術的に開始できても PASS の seal がない間は計測を始めません。custodian は preC・アンカー封印・evaluate・select の各時点でも seal と対応する証跡を手動で照合します。

## 凍結スナップショット

最初の C 実行の前に、データセットごとに 1 回だけ `freeze-snapshot` を実行します。出力には次を固定して記録します。

- ファイルごとの SHA-256、結合ハッシュ、manifest の SHA-256、改行正規化後のノート
- Source ID の導出方法（パスから決定的に 1 回だけ計算）と、SourceRecord の配列
- main の chunker による Chunk 一覧（ID、内容、ハッシュ、行範囲）
- 質問と、解決済みの正解（Source ID、Chunk ID、行）
- それぞれの正規化した SHA-256

ファイルの SHA-256 はハーネスの外で記録してください。held-out では、独立した custodian が記録した値を使います。

以降の `run`・`seal-anchors`・`report`・`evaluate` は、このファイルと記録済み SHA-256 を必須とします。データセットを読み直すたびにスナップショットと照合し、Source ID は再計算せずにスナップショットから読みます。各回の記録と C のアンカーには、スナップショットの各ダイジェストと実装ハッシュを結び付けます。

## 実行

実行前に `npm run build` で `target/` の Worker と WASM ランタイムを生成し、`target/models/<revision>/` に固定ハッシュのモデルを置きます。ハーネスはモデルをダウンロードしません。Playwright と Electron はリポジトリの依存関係に含めないため、パスを指定します。

1. `freeze-snapshot` で凍結し、SHA-256 を記録します。
2. custodian が semantic seal の PASS と対象スナップショット・更新範囲を確認した後、`run --configs C --runs 5` で C を 5 回実行します。
3. `seal-anchors` で Section First@6 のアンカーを封印します。
4. `run --configs C,M,A --runs 5 --anchors … --baseline <C の results.json>` で候補を実行します。推論の前に、指定した C の結果からアンカーを封印し直し、保存済みのアンカーと完全に一致することを確認します。
5. `evaluate` でデータセットごとに判定し、`select` で原本と held-out の判定をまとめます。

`report` は、記録した各回の結果から監査用の集計を出力します。トークン分布、保存前後の実ファイルバイト数、Vector 数は 5 回すべての値と、中央値・最小・最大を示します。A には質問・回ごとの metadata 上位 20 件の異なる Source 数、vector と hybrid それぞれの非保護候補の Source 内訳、正解 Chunk の候補包含経路（protected-body / body-tail / metadata-entry / absent / unavailable）も示します。これは包含経路の診断であり、品質改善や rerank 順位の原因を示すものではなく、採否のゲートにも使いません。各 `run` は最初に tokenizer の一致確認（parity preflight）を別プロセスで行い、一致しなければ実行を止めます。出力先は既存のファイルを上書きしません。各回の生記録は `runs/<構成>-run<回>.json` に保存し、`results.json` にその SHA-256 を記録します。

## 計測方法

- 各回・各構成で、新しい Electron プロセスと一時プロファイルを使います。プロファイルには vault のコピーと索引保存先を置きます。
- 資産を読み込んだ後、推論の前にブラウザーをオフラインにします。`navigator.onLine` が page と Worker の両方で `false` であることを、実行の前後で記録します。
- 通信の自動監視記録は Chromium webRequest の要求遮断・記録と、main・renderer・Worker の Node 通信ガードです。必要な監視記録が欠ければ BLOCKED です。Chromium の DNS は `host-resolver-rules` (`MAP * ~NOTFOUND`) で遮断する設定ですが、この設定自体の確認結果は自動記録されず、`privacyCheck` に DNS 専用のゲートはありません。凍結した privacy 要件を満たすため、計測前に custodian が DNS 設定と遮断の証跡を手動で確認します。確認できない測定は採用可能な証拠として扱いません。
- 合成の `.invalid` ホストへのプローブが拒否されることを確認します。プローブは実際の通信とは別に記録します。
- 推論は、製品の `LocalEmbeddingProvider` と `target/local-embedding-worker.js` だけで行います（q8、WASM、1 スレッド、mean pooling、L2 正規化）。Electron は Worker でも Node を有効にするため、製品 Worker のスクリプトの前に、Node 通信ガードだけを行う `worker-guard.js` を付けて起動します。製品 Worker の本体はハッシュ検証済みのまま変更しません。ガードの記録はプロファイル内のログに書き、parity preflight でベクトルが変わらないことを確認します。
- トークン数は、同じハッシュの tokenizer ファイルを Transformers.js 3.8.1 の `AutoTokenizer` で読む専用 Worker で数えます。parity preflight では、この ID 列を feature-extraction pipeline 自身の tokenizer の ID 列と比べます。さらに、同じ設定の pipeline のベクトルが製品 Worker のベクトルと一致することも確認します。
- C・A では、512 トークンを超える入力を、トークン化し直して上限に収まる最長のコードポイント前方部分に縮めます。トークン数は前方部分の長さに対して単調とは限らないため、長い方から全て確認します。A の属性部分の上限は 384 トークンです。`embedBatch` に実際に渡した文字列は、SHA-256、トークン化し直した数、射影結果との一致を記録します。M はモデル内部の切り詰めに任せ、元のトークン数だけを記録します。
- 再構築時間には次が含まれます。モデルの初期化は別に記録します。
  - 凍結した SourceRegistry の読込
  - vault からのノートの読込
  - 索引作成
  - 全ての書き込み（一時名に書いて rename し、各書き込みを待ちます）

  索引は M・C・A とも同じ形式で、要素ごとの JSON ファイルに保存します。製品の `data.json` とは別の実験用の保存形式です。書き込み後に読み戻して内容を照合し、実ファイルのバイト数と直列化サイズを分けて記録します。型付き索引は、読み戻した状態を現在のソースから再導出した入力ハッシュ一式と照合してから検索に使います。旧版と廃止された Vector チャネルを含む保存状態は再構築が必要です。
- 更新シナリオでは、毎回、初回構築後の保存状態と vault に戻してから編集を書き込みます。時間には、ノートの読込、Registry 更新、索引の更新、全ての書き込みが含まれます。
- メモリは、`gc()` の後に `app.getAppMetrics()` の private bytes を Electron の全プロセスで合計した値です。同じ PID 集合で 3 回連続して 1% 以内に収まった時点を静止状態とします（Windows のみ取得可能）。ピークは 100 ms 間隔で採った合計の最大値です。`peakWorkingSetBytes` は OS の working set のピークで、private bytes のピークではありません。

測定値や証跡が欠けたゲートは BLOCKED とし、候補の状態は INCOMPLETE になります。BLOCKED・NON_EVALUABLE は合格として扱いません。FAIL と BLOCKED は分けて報告します。M・C の各回にも、次の不変条件を課します。満たさない回がある場合も、候補の不合格ではなく BLOCKED です。

- 通信・オフラインの証跡
- Registry の一致
- 保存の読み戻し
- 実際に渡した入力の記録
- C のみ、512 トークン以内であること（M は切り詰めない元の入力を使うため、上限を課しません）

採否には異なる 2 データセットについて、それぞれ封印済み C の基準と M・C・A の完全な 5 回分、parity とゲート報告が必要です。すべての A ゲートが PASS なら A を採用し、完全な証跡の下で FAIL または NOT_ADOPTABLE があれば非採用とします。不完全なら blocked であり、採否を主張しません。`smoke-write-failure` は採点しないスモークです。body Vector の一時ファイルを rename できない状態で、計測がその書き込みの失敗として止まることを確認します。それ以外の理由による失敗は、スモークの失敗になります。

この範囲の変更だけでは #99 は完了しません。原本の版上げ（original-r2）は未承認で元のバイト列を保持しています。親 coordinator の報告では、held-out は 24 ノート・48 問を回収し、過去のスナップショット SHA-256 `2775ef223d2d14262c4fe8d3fb0658a7df5279b90682970260d5de371059c6c6` と一致し、独立した custodian による 12 件の編集の監査は PASS でした（実装者は held-out の本文・正解にアクセスしていません）。原本の PASS seal、凍結・独立実装レビュー、両データセットの採点と採否、Obsidian Desktop の手動確認が残ります。製品への組み込みは A がすべての凍結済み受け入れゲートに合格した場合に限って検討し、別 Issue へ自動的に延期しません。
