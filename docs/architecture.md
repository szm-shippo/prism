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

## Markdown Chunker

`src/core/index/markdown-chunker.ts` は見出し行（コードフェンス外）を境界にして、見出しと本文をひとつの Chunk にする。各 Chunk の `location` は元 Markdown の1始まりの行番号で、`content_hash` は内容から、`chunk_id` は source ID・開始行・内容から決定的に算出する。再実行時に同じ入力から同じ ID を得られるようにするためであり、これらは Vault Markdown から再生成できる派生値である。現在の分割は見出し単位で、長さによる再分割は行わない。

## Embedding Provider

`src/core/provider/embedding-provider.ts` は単一テキストと複数テキストのベクトル化を定義する。バッチ結果は入力と同じ順序・件数とし、空入力の結果は空配列とする。`model.id` はモデル識別子、`model.dimensions` は事前に分かる場合のベクトル次元数である。通信方法と実際のモデルは実装側が決める。

## LLM Provider

`src/core/provider/llm-provider.ts` は role 付きメッセージと出典 ID を持つ context をリクエストに分けて渡し、生成テキストを返す。逐次出力は任意の `stream` メソッドで表す。Provider 固有の失敗は `LLMProviderError` の共通コードに変換し、利用者向けメッセージには元の応答本文や認証情報を含めない。実際の通信とエラー変換は具体的な Provider 実装が担う。
