---
name: wave-implementation
description: このリポジトリで同じ実装 wave の複数 Issue を、人間の Issue ごとのマージ操作を待たずに順次実装するときに使う。単独 Issue の作業には使わない。
---

# wave の連続実装

対象 wave の親 Issue を用意し、対象 Issue を sub-issue として登録する。既存の親子関係やブランチがあれば再利用する。Issue の依存関係と完了条件を確認し、前提を満たす順番で進める。

`main` から wave ブランチを作成する。Issue ごとに、その時点の wave ブランチから作業ブランチを作成し、[implementation](../implementation/SKILL.md) に従って実装する。必要な [test-cases](../test-cases/SKILL.md) と [documentation](../documentation/SKILL.md) も適用する。完了条件と検証結果を確認したら、Issue ブランチを wave ブランチへ直接マージする。Issue ごとの PR は作らない。wave ブランチで統合後の検証を行い、次の Issue ブランチはこの更新済み wave ブランチから作る。このループは対象 wave の完了まで継続し、Issue 間の人間によるマージ操作を待たない。

wave 全体の完了条件とテストを確認し、wave ブランチと `main` の差分をレビューした後、[pull-request](../pull-request/SKILL.md) に従って `main` 宛ての PR を 1 件作成する。親 Issue と各 sub-issue の実装・検証結果を記載する。完了条件を満たした各 sub-issue は PR 本文にそれぞれ `Closes #番号` と書き、`main` への PR マージ時に自動でクローズさせる。親 Issue も全 sub-issue と wave 全体の完了条件を満たす場合だけ `Closes #番号` とする。未完了の Issue は `Refs #番号` とし、未実施の検証を実施済みと記載しない。手動確認を省略する判断がユーザーから明示された場合は、未実施であることと省略の判断を PR に記録する。Issue ブランチを wave ブランチへマージした時点では Issue をクローズしない。`main` へのマージは PR のレビュー後に行う。

wave PR のマージ後は親 Issue と各 sub-issue の状態を確認する。自動クローズされなかった完了済み Issue があれば、PR 本文やリポジトリの自動クローズ設定を確認し、完了条件と省略判断の記録が揃っている場合に手動でクローズする。

既存の作業ツリーにある無関係な変更を取り込まない。マージや検証で問題が出た場合は解消してから次の Issue へ進み、解消できない場合は問題と残作業を報告する。
