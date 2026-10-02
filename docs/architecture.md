# モジュール境界

プラグインの実行入口は `src/main.ts`、Obsidian API を使う実装は `src/obsidian/` に置く。Core の処理は Obsidian の型や実体を受け取らず、必要なデータと依存先を通常の TypeScript の型で表す。現時点で動作する処理だけを配置し、後続 Issue のインターフェースや空のクラスは先に作らない。

| 場所 | 責務 |
| --- | --- |
| `src/presentation/` | 表示用の状態・変換。Obsidian の画面構築は `src/obsidian/` で行う。 |
| `src/core/application/` | ユースケースの調整。 |
| `src/core/index/` | 検索用の派生データと、その操作。 |
| `src/core/provider/` | 外部モデルとの通信を表す境界と実装。 |
| `src/obsidian/` | Vault、イベント、設定画面などの Obsidian API との接続。 |

Core は `obsidian` パッケージ、`src/obsidian/`、`src/presentation/` を import しない。`src/core/index/` と `src/core/provider/` は `src/core/application/` を import しない。`src/presentation/` も Obsidian API を import しない。これらは `npm test` の境界検査で確認する。

Vault Markdown が知識の正本である。検索用データは Vault から再構築できる派生データとして扱い、Core の実装から Vault を直接変更しない。具体的なデータ型や Provider 契約は、それらを使う Issue で定義する。

## Source Registry

`src/core/index/source-registry.ts` は Markdown source の ID、Vault 相対パス、内容の SHA-256、更新時刻、サイズを保持する。ID は登録時に生成し、パス変更時にも維持する。レコードはプラグインの保存データ内に置き、設定と共存させる。保存に失敗した操作はメモリ上でも確定しない。不正な保存データは上書きせず、Vault Markdown からの再構築が必要なエラーとして扱う。再構築後の ID は変わり得るため、Registry 全体を派生データとして扱う。

Vault の Markdown 作成イベントは `src/obsidian/source-events.ts` で順に処理する。Obsidian は Vault 読み込み時にも既存ファイルの作成イベントを発行するため、登録済みパスは再登録しない。読み込みや保存に失敗した場合は次のイベント処理を止めず、プラグインからエラーを通知する。

Markdown 更新イベントでは現在の内容の SHA-256 と Registry の値を比較する。内容が同じでも mtime またはサイズが変わればメタデータを更新し、変更判定結果を返す。続いて対象 Source の Chunk を同期する。

Markdown のファイル名変更・移動はパスだけを更新し、source ID と内容ハッシュを維持する。フォルダ移動では配下の Markdown パスを一度に更新する。拡張子が Markdown に変わったファイルは新規登録し、Markdown から外れたファイルは Registry から除く。

Markdown の削除イベントでは対象 Source の Chunk を除いてから Registry レコードを除く。フォルダ削除では配下の Source に同じ処理を行う。検索インデックスの削除は後続のパイプラインで行う。

`src/core/index/chunk-registry.ts` は Chunker の出力を ID と source ID で保持する。登録時に Source Registry の source ID を確認し、source ごとの列挙・置換・一括削除を提供する。レコードはプラグイン保存データ内に置き、Vault Markdown から再生成できる派生データとして扱う。`chunk-pipeline.ts` が作成・更新時に対象 Source の Markdown から Chunk を再生成する。保存失敗時は既存 Chunk をメモリ上で保持し、同じイベントを再処理できる。出典パスは Chunk に複写せず Source Registry から解決するため、移動後も Chunk ID と Source ID を維持する。

## 検索ストア境界

`full-text-search.ts` は Chunk の登録・更新・Source 単位の削除・検索・全消去を定義する。`vector-store.ts` は Vector の登録・更新・Chunk または Source 単位の削除・検索・全消去を定義する。Vector の値は既知のモデル次元数に一致する有限数列として検証する。

`local-full-text-search.ts` は純粋な TypeScript で Chunk のテキストを保存し、大文字小文字を区別しない部分文字列検索を行う。空白で区切った語とクエリ全体の出現回数を順位に使う。これにより識別子、数字、エラー文字列、日本語の連続した文字列を検索できる。形態素解析は行わない。保存先は呼び出し側から注入し、データは Vault Markdown から再構築できる。Chunk 更新は同じ ID の内容を置換し、削除済み Chunk の整理は Source 単位の削除で行う。

`local-vector-store.ts` は純粋な TypeScript で Vector を保存し、コサイン類似度による Top-K 検索を行う。保存先と次元数は呼び出し側から渡す。保存済みの次元数と異なるモデルを使う場合は再構築が必要である。ゼロ Vector、非有限値、次元不一致は拒否する。検索は全件走査とし、ANN は行わない。全文検索・Vector とも、保存失敗時にはメモリ上の旧状態を保持し、Vault Markdown は変更しない。

`hybrid-retrieval.ts` はテキストとクエリ Vector を受け取り、全文検索と Vector 検索を呼び出す。同じ Chunk ID は一件にまとめ、各検索結果の順位の逆数を加算して候補を並べる。両ストアのスコア尺度に依存せず、同じ Chunk ID に異なる Source ID が付いていれば再構築を要する不整合として拒否する。

`retrieval-reranker.ts` は候補の Chunk 本文とクエリを照合し、初期実装では語句の出現回数で並べ直す。追加の外部送信を伴わず Mobile でも使える方式として選んだ。評価エラーや Chunk 不在時は元の Hybrid Retrieval 順へ戻し、指定された Top-N に絞る。スコア付け処理は差し替え可能だが、モデルによる最適化はこの段階では行わない。

Vault の作成・変更・削除イベントは Chunk Registry の更新後にローカル全文検索へ反映する。設定画面の「Send changed chunks to OpenAI for search indexing」は既定でオフにし、利用者がオンにした後の Vault イベントだけで、EmbeddingProvider を通じて `https://api.openai.com/v1/embeddings` に Chunk 本文を送る。オンにしただけでは既存 Note を送らない。オフの間も全文検索は更新し、変更・削除された Source の古い Vector を除く。`index-update-orchestrator.ts` は保存済み Vector の Chunk ID と内容ハッシュを比較し、新規・変更 Chunk のみを送信する。失敗時は現在の全文検索を保ち、古い Vector を残さず、次のイベントで再試行できる。Embedding モデルの変更時は、異なるモデルの Vector を混在させないため、派生 Vector インデックスを消去する。

全再構築は Vault イベントと直列に実行し、派生した Source Registry、Chunk Registry、全文検索、Vector を消去してから Vault の Markdown を再走査する。失敗時は途中までの派生状態を残してエラーを返し、再実行時に最初から作り直す。Vault Markdown は書き換えない。Vector の再生成はリモート索引への明示的な同意と Embedding 設定がある場合だけ行う。

## Markdown Chunker

`src/core/index/markdown-chunker.ts` は見出し行（コードフェンス外）を境界にして、見出しと本文をひとつの Chunk にする。各 Chunk の `location` は元 Markdown の1始まりの行番号で、`content_hash` は内容から、`chunk_id` は source ID・開始行・内容から決定的に算出する。再実行時に同じ入力から同じ ID を得られるようにするためであり、これらは Vault Markdown から再生成できる派生値である。現在の分割は見出し単位で、長さによる再分割は行わない。

## Embedding Provider

`src/core/provider/embedding-provider.ts` は単一テキストと複数テキストのベクトル化を定義する。バッチ結果は入力と同じ順序・件数とし、空入力の結果は空配列とする。`model.id` はモデル識別子、`model.dimensions` は事前に分かる場合のベクトル次元数である。通信方法と実際のモデルは実装側が決める。

初期の具体実装は `src/obsidian/openai-embedding-provider.ts` とし、Obsidian の `requestUrl` から OpenAI の `/v1/embeddings` へ、指定されたテキストとモデル ID を送る。API キーとモデルは呼び出し側から渡す。応答本文や通信例外はエラーメッセージに含めない。送信先は固定し、Vault の他の内容は読み取らない。

## LLM Provider

`src/core/provider/llm-provider.ts` は role 付きメッセージと出典 ID を持つ context をリクエストに分けて渡し、生成テキストを返す。逐次出力は任意の `stream` メソッドで表す。Provider 固有の失敗は `LLMProviderError` の共通コードに変換し、利用者向けメッセージには元の応答本文や認証情報を含めない。実際の通信とエラー変換は具体的な Provider 実装が担う。

初期の具体実装は `src/obsidian/openai-llm-provider.ts` とし、Obsidian の `requestUrl` から OpenAI の `/v1/responses` へ、メッセージ、参照 context の source ID と本文、モデル ID を送る。context は信頼しない参照データとして最終ユーザーメッセージの前に置き、含まれる指示に従わないよう上位メッセージで指定する。応答の保存を要求しない `store: false` を使う。API キーとモデルは呼び出し側から渡す。送信先は固定し、API の応答本文や通信例外をエラー表示に含めない。

Provider 設定 UI はモデル ID をプラグイン設定データへ保存し、API キーを Obsidian Secret Storage へ保存する。通常の設定画面に保存済みキーを再表示しない。Secret Storage が導入された Obsidian 1.11.4 を最低バージョンとし、送信先・送信内容・目的を設定画面に明示する。Provider の実際の呼び出しは後続のインデックス・質問パイプラインが担当する。

## Source Citation

`CitationAnswerer` は検索で使った chunk ID と source ID を LLM context に渡し、回答中の `[cite:CHUNK_ID]` を出典に変換する。出典のパスと行範囲は回答生成後に Chunk Registry と Source Registry から取得する。入力にない chunk、source ID が一致しない chunk、Vault に存在しないパスの marker は出典として採用しない。戻り値は回答文と構造化された出典の組である。引用元を開く際は citation に保存された古いパスを使わず、source ID から現在の Vault パスを調べる。Chat UI は引用番号と出典一覧をボタンで表示し、この source ID による遷移を呼び出す。

## RAG Pipeline

`RagPipeline` は query のベクトル化、Hybrid Retrieval、rerank、context 構築、回答生成、出典付与を接続する。context は上位の完全な chunk を選び、JSON 化した UTF-8 バイト数を保守的な token 上限として使う。初期値は候補 20 件、context 最大 6 chunk、上限 6000 とし、ここでの実装値であって製品仕様の固定値ではない。ベクトル検索は同意済みの現行モデルのインデックスと認証情報が揃う場合だけ行い、それ以外はローカル全文検索を使う。回答に使う chunk の source は現在の Vault で存在を確認する。

## Index Controls

設定画面の Advanced 領域は登録済み source と chunk の件数、再構築の状態を表示する。再構築は Vault Markdown から派生インデックスを作り直す既存の処理を呼び出し、失敗時は再試行できる。リモート embedding の同意が有効な場合に Markdown chunk が OpenAI に送信されることを操作位置に表示する。

除外設定は Vault 相対のファイルまたはフォルダパスを 1 行ずつ受け付ける。フォルダ指定は配下にも適用し、比較は Vault パスと同じ大文字・小文字で行う。設定適用時に該当する source、chunk、全文・ベクトル索引を削除し、新規イベント、移動、再構築でも対象を読み込まない。削除が失敗して派生データが残っても、RAG の候補選択で除外し外部の回答処理へ渡さない。除外を解除した後は明示的な再構築で再登録する。

## Ask View

`PrismChatView` は Obsidian の View として登録し、コマンドとリボンから同じ View を開く。質問を `PrismPlugin.answerQuery` に渡し、回答と出典のパス・行範囲を表示する。回答中の引用番号と出典一覧は、マウス・キーボード・タッチで操作できるボタンとして表示し、`PrismPlugin.openCitation` を呼び出す。処理中は二重送信を止め、失敗時は秘密情報を含む可能性のある例外本文を画面に出さない。回答履歴と Markdown への保存は行わない。
