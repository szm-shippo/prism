# GitHub Copilot (Desktop)

Prism は公式 `@github/copilot-sdk` を使い、Obsidian Desktop で GitHub Copilot を回答プロバイダーとして利用できます。GitHub Copilot CLI は利用者自身がインストールします。Prism には同梱されません。このプロバイダーは Desktop 専用です。iOS と Android では Copilot runtime を読み込みません。

## Windows での準備

Copilot を利用できる GitHub account と、SDK 互換の Copilot CLI が必要です。Windows では PowerShell から公式 CLI をインストールします。

```powershell
winget install GitHub.Copilot
```

インストール後に新しい PowerShell ウィンドウを開き、次を実行して GitHub の CLI 用 OAuth でサインインします。

```powershell
copilot login
```

ローカルの Desktop では通常、ブラウザーが開いてサインインが完了します。GitHub 公式 Copilot CLI の認証を使うため、OAuth App の作成、Client ID の設定、Prism への token の貼り付けは不要です。詳しくは GitHub の [Copilot CLI インストール手順](https://docs.github.com/en/copilot/get-started/cli-quickstart) と[認証手順](https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/authenticate-copilot-cli)を参照してください。

Obsidian の Prism 設定で `LLM connection` に `GitHub Copilot (Desktop)` を選び、`Check CLI login` を押します。Prism はまず PATH を探し、見つからなければ OS ごとの限られた標準インストール先を確認して Copilot CLI を自動検出します。通常の設定では executable の path 入力は不要です。Prism はログインと GitHub.com の account も確認します。確認済みの account は `Connected to Prism as <login> (github.com).` と表示されます。続けて `Copilot models` の `Refresh models` で一覧を更新し、model を選んで `Test GitHub Copilot connection` を実行します。

Copilot CLI で使う account を切り替えたら、Prism でもログインを再確認してください。`Disconnect Prism` は Prism の確認済み account と model 一覧を消去しますが、CLI からはログアウトしません。CLI からログアウトする場合は、GitHub 公式 Copilot CLI を確認したうえで CLI を開き、`/logout` を実行します。GitHub の[ログアウト手順](https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/authenticate-copilot-cli#signing-out-and-removing-credentials)も参照してください。

## 認証と runtime

Prism は SDK を `copilot-cli` mode で実行し、Copilot CLI が管理する認証情報を CLI の通常のユーザーホームと OS の credential store から読み込みます。Prism の設定に保存するのは、確認済みの host と login（`github.com` と account 名）だけです。CLI の認証情報は Prism に保存しません。

SDK の作業用 directory と session 設定 directory は一時領域を使います。Prism は SDK session での tool 利用、config hook と config discovery、skill と instruction の discovery、telemetry、session 保存を無効にします。一時領域は session 用ファイルを分離しますが、CLI の認証には通常の Copilot CLI の login context を使います。runtime 全体を利用者の CLI 認証設定から隔離するものではありません。

Copilot CLI の user-level `providers.json` は BYOK provider と model を定義できます。Prism は各一時 runtime workspace に `{ "providers": [], "models": [] }` を作り、`COPILOT_PROVIDERS_CONFIG` でその file を CLI に指定します。また、`COPILOT_PROVIDER_*` などの認証・provider 環境変数を子 process に渡しません。通常の user home と OS credential store にある CLI OAuth は引き続き使いながら、Copilot CLI の BYOK provider registry は Prism の model listing と Ask で使いません。

model 一覧取得、接続テスト、Ask の各 remote request の前に、Prism は SDK の `authType: user`、`github.com`、および確認済み login との一致を要求します。account が一致しない場合や、GitHub CLI の `gh auth`、環境変数 token、API token 認証が使われる場合は request を拒否します。これらの認証方式へ自動で切り替えることはありません。

旧バージョンからの更新では、Prism が保持していた OAuth secret と Client ID 設定を migration で消去します。Copilot CLI の認証情報は変更しません。CLI にサインインが必要なときはターミナルで `copilot login` を実行してください。

## 送信されるデータ

- `Copilot models` の更新では、CLI が管理する認証を使って GitHub Copilot から model 名を取得します。Vault の内容、質問、会話履歴は送りません。
- `Test GitHub Copilot connection` は固定文 `Reply with OK.` だけを選択 model に送ります。Vault の内容や会話履歴は送りません。
- Ask では、現在の質問、直近の成功した最大 6 組の質問と回答（合計 12,000 UTF-8 bytes まで）、および検索で選んだ source ID・chunk ID・本文を GitHub Copilot に送ります。会話履歴は Ask view のメモリ内だけにあり、Markdown には保存しません。
- Vault の索引作成、全文検索、embedding は端末内で実行します。embedding を API に送りません。

この文書の更新では、実際の GitHub account ログイン、インストール済み CLI の動作、各 platform の実機動作は確認していません。リリース前に GitHub CLI 接続と対象 device での動作を確認してください。

SDK 認証の詳細は GitHub の[公式 Copilot SDK 認証ガイド](https://docs.github.com/en/copilot/how-tos/copilot-sdk/auth/authenticate)を参照してください。

## CLI が自動検出されない場合

インストール後に Prism が CLI を見つけられない場合、まず Obsidian Desktop を終了して再起動し、`Check CLI login` をもう一度押します。Prism は PATH の後に、Windows の WinGet link と macOS / Linux の標準 install directory など、限られた場所だけを確認します。ディスク全体を検索することはありません。

それでも見つからないときだけ、`GitHub Copilot CLI path (optional)` に absolute path の override を設定します。Windows では、新しい PowerShell を開いて次のコマンドを実行し、表示された path を使います。

```powershell
(Get-Command copilot.exe).Source
```

Windows で override に指定できるのは native `copilot.exe` です。`cmd`、PowerShell script、JavaScript、npm shim は指定しないでください。明示した path が無効な場合、Prism は自動検出へ切り替えずエラーを表示します。override を消去すると自動検出に戻ります。
