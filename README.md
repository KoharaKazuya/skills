# KoharaKazuya/skills

Claude Code、GitHub Copilot、Codex、Cursor、Antigravity などのコーディング AI に再利用可能な rules / skills を与えるためのリポジトリです。

このリポジトリは、単なるプロンプト集ではありません。
PdM やプロダクトオーナーが、コーディング AI を通じて直接扱えるソフトウェア生成システムを構築するための運用知識をまとめます。

## 思想・哲学・設計方針

このリポジトリは、コーディング AI を単なるコード生成ツールではなく、検証可能なソフトウェア生成システムとして扱うための共通基盤です。

この思想を具体化するため、次の課題をどのような skills / rules で解決していくかを追跡します。

* プロダクト意図をエージェントが参照できる形にする。
* 重要な意思決定を ADR として記録できるようにする。
* 保証すべき振る舞いを自動テストとして表現できるようにする。
* 実装前に検証方法を確立できるようにする。
* エージェントが自律的に実装、検証、報告できるようにする。
* オーナーのエンジニアが主要な仕組みを説明できる状態を維持する。

詳しくは [思想・哲学・設計方針](philosophy.md) を参照してください。

## 目的

このリポジトリの目的は、コーディング AI を安全かつ継続的に使うための再利用可能な rules / skills を提供することです。

主な対象は以下です。

* エージェントに常時適用する方針
* 特定タスクで呼び出す作業手順
* 実装前に検証方法を確立するための作業規約
* コード化できない情報をドキュメントとして扱うための方針
* エージェントが自律的にテストするための方針

## インストール

### skills

Agent Skill のインストーラーが利用できる場合は、それを使います。

```sh
gh skill preview KoharaKazuya/skills <skill-name>
gh skill install KoharaKazuya/skills <skill-name> --agent claude-code --scope user
```

### rules

rules は Agent Skill ではありません。
常時適用する方針です。

各ツール向けの adapter をコピーして使います。

Claude Code:

```sh
cp adapters/claude-code/CLAUDE.md /path/to/your/project/CLAUDE.md
```

Codex:

```sh
cp adapters/codex/AGENTS.md /path/to/your/project/AGENTS.md
```

GitHub Copilot:

```sh
mkdir -p /path/to/your/project/.github
cp adapters/github-copilot/.github/copilot-instructions.md /path/to/your/project/.github/copilot-instructions.md
```

既存の指示ファイルがある場合は、上書きせず差分を確認してください。

## 利用方針

このリポジトリは、コーディング AI 利用の共通基盤として扱います。

プロジェクト固有の指示は、このリポジトリではなく対象プロジェクト側に置きます。

このリポジトリに含めるべきもの:

* 汎用的な検証方針
* 汎用的なテスト方針
* Git 操作の安全方針
* 不具合修正の共通手順
* TDD 実装の共通手順
* PR レビューの共通観点
* コードベース理解を支援する手順

このリポジトリに含めるべきでないもの:

* 会社内部の情報
* 特定プロダクトのビジネスルール
* 非公開リポジトリ名
* 認証情報
* 顧客情報
* 一度きりの実装計画
* 一時的なタスクメモ
