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
