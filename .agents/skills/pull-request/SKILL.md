---
name: pull-request
description: このリポジトリで PR を作成・更新するときに使う。
---

# PR の作成・更新

PR を作成する前に、対象 Issue、作業ブランチ、`main` との差分、検証結果を確認する。既存の PR がある場合は重複作成せず、その PR を更新する。単独 Issue の PR はその作業ブランチから `main` に向ける。同じ wave の複数 Issue を連続して実装する場合、各 Issue ブランチは wave ブランチへ直接マージし、wave 全体の PR だけを `main` に向ける。

PR 本文には [PR テンプレート](../../../.github/PULL_REQUEST_TEMPLATE.md)を使う。変更の目的と内容、関連 Issue、実施した検証と結果、レビュー時に知っておくべき未確認事項を、実際の差分に基づいて簡潔に記載する。wave の PR には親 Issue、対象の sub-issue、Issue ごとの検証結果を記載する。Issue が完全に解決する場合だけ `Closes #番号` を使い、それ以外は `Refs #番号` で関連付ける。wave PR では完了した親 Issue と各 sub-issue を個別に `Closes #番号` で列挙する。これは既定ブランチ `main` 宛ての PR がマージされたときに各 Issue を自動クローズするためであり、親子関係だけに自動クローズを任せない。実施していない検証を実施済みと書かない。

作成・更新後は PR の URL と、検証結果や未確認事項を報告する。
