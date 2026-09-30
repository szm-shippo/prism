# 作業別 Skill の選択

作業内容に応じて、着手前に以下の Skill を読む。依頼が複数の作業を含む場合は、該当する Skill をすべて使う。

- 機能の実装、既存コードの変更、リファクタリング: [implementation](.agents/skills/implementation/SKILL.md)
- 同じ wave の複数 Issue を連続して実装する作業: [wave-implementation](.agents/skills/wave-implementation/SKILL.md)
- テストケースの設計・作成・変更: [test-cases](.agents/skills/test-cases/SKILL.md)
- README、仕様書、利用手順などの文書の作成・変更: [documentation](.agents/skills/documentation/SKILL.md)
- PR の作成・更新: [pull-request](.agents/skills/pull-request/SKILL.md)

コードの変更に必要なテストや文書の変更も、それぞれの作業に該当する Skill を使う。各作業の詳細ルールと禁止事項は、対応する Skill に置く。

wave の作業では `implementation` と `wave-implementation` を併用し、ブランチと PR の運用は `wave-implementation` に従う。
