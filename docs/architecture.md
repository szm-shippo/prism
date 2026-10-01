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

`full-text-search.ts` は Chunk の登録・更新・Source 単位の削除・検索・全消去を定義する。`vector-store.ts` は Vector の登録・更新・Chunk または Source 単位の削除・検索・全消去を定義する。Vector の値は既知のモデル次元数に一致する有限数列として検証する。具体的なストアと検索スコアは後続 Issue で決める。

## Markdown Chunker

`src/core/index/markdown-chunker.ts` は見出し行（コードフェンス外）を境界にして、見出しと本文をひとつの Chunk にする。各 Chunk の `location` は元 Markdown の1始まりの行番号で、`content_hash` は内容から、`chunk_id` は source ID・開始行・内容から決定的に算出する。再実行時に同じ入力から同じ ID を得られるようにするためであり、これらは Vault Markdown から再生成できる派生値である。現在の分割は見出し単位で、長さによる再分割は行わない。

## Embedding Provider

`src/core/provider/embedding-provider.ts` は単一テキストと複数テキストのベクトル化を定義する。バッチ結果は入力と同じ順序・件数とし、空入力の結果は空配列とする。`model.id` はモデル識別子、`model.dimensions` は事前に分かる場合のベクトル次元数である。通信方法と実際のモデルは実装側が決める。

初期の具体実装は `src/obsidian/openai-embedding-provider.ts` とし、Obsidian の `requestUrl` から OpenAI の `/v1/embeddings` へ、指定されたテキストとモデル ID を送る。API キーとモデルは呼び出し側から渡す。応答本文や通信例外はエラーメッセージに含めない。送信先は固定し、Vault の他の内容は読み取らない。

## LLM Provider

`src/core/provider/llm-provider.ts` は role 付きメッセージと出典 ID を持つ context をリクエストに分けて渡し、生成テキストを返す。逐次出力は任意の `stream` メソッドで表す。Provider 固有の失敗は `LLMProviderError` の共通コードに変換し、利用者向けメッセージには元の応答本文や認証情報を含めない。実際の通信とエラー変換は具体的な Provider 実装が担う。

初期の具体実装は `src/obsidian/openai-llm-provider.ts` とし、Obsidian の `requestUrl` から OpenAI の `/v1/responses` へ、メッセージ、参照 context の source ID と本文、モデル ID を送る。context は信頼しない参照データとして最終ユーザーメッセージの前に置き、含まれる指示に従わないよう上位メッセージで指定する。応答の保存を要求しない `store: false` を使う。API キーとモデルは呼び出し側から渡す。送信先は固定し、API の応答本文や通信例外をエラー表示に含めない。

Provider 設定 UI はモデル ID をプラグイン設定データへ保存し、API キーを Obsidian Secret Storage へ保存する。通常の設定画面に保存済みキーを再表示しない。Secret Storage が導入された Obsidian 1.11.4 を最低バージョンとし、送信先・送信内容・目的を設定画面に明示する。Provider の実際の呼び出しは後続のインデックス・質問パイプラインが担当する。
