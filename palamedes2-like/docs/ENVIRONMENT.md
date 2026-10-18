# 環境記録（2026-10-18 初回作成、v0.2.0 で更新）

## 実行環境（実際に確認した値）

| 項目 | 値 |
|---|---|
| 作業場所 | Claude Code のクラウド実行環境（コンテナ）。Windows PC・ユーザーのローカル環境には接続していない |
| OS | Ubuntu 24.04.5 LTS（Linux 6.18 x86_64） |
| シェル | bash |
| 作業ディレクトリ | `/home/user/palamedes2_stylegame_making/palamedes2-like`（既存Gitリポジトリ配下に専用プロジェクトを作成） |
| 書込み権限 | 作業ディレクトリ・一時領域に書込み可（確認済み） |
| 空き容量 | 約30GB（作業開始時） |
| ターミナル | 利用可 |
| ブラウザ検証 | 利用可：Chromium 141 系（Playwright 同梱ビルド chromium-1194、`/opt/pw-browsers`）をヘッドレスで使用 |
| Git | 2.43.0。作業開始時はコミットなしのリポジトリ（ブランチ `claude/sweet-meitner-jt0diu`）。author は環境既定値を使用 |
| Node.js / npm | v22.22.0 / 10.9.4（既存を使用。グローバル環境は変更していない） |

コンテナは一定時間で破棄されます。成果物は共有Driveへ保存しました（下記）。

## 依存関係（package.json に完全一致の版で固定、package-lock.json 保存済み）

| パッケージ | 版 | 用途 |
|---|---|---|
| typescript | 5.9.3 | 型検査 |
| vite | 7.3.7 | 開発サーバー・ビルド |
| vitest | 5.0.5 | 自動テスト（3.2系は既知の脆弱性指摘があったため 5.0.5 を採用。`npm audit` 0件） |
| playwright-core | 1.56.1 | ブラウザ確認（環境の Chromium 1194 と同じ組合せ） |
| @types/node | 22.20.5 | テスト・スクリプトの型 |

導入：`npm ci`。実行時依存（dependencies）はありません（ゲーム本体はブラウザ標準APIのみ）。
`.nvmrc` に Node 22 を記載（開発・テストは Node 22.12 以上が必要。実行版の起動用サーバーは Node 18 以上で可）。

## 起動・ビルド・型検査・テスト

README.md の「セットアップと起動」を参照。検証時の実行結果：

- `npm run typecheck`：エラー0
- `npm test`：114/114 PASS
- `npm run build`：成功（`dist/` 約0.8MB、JS 約100KB）
- `npm run e2e`：32/32 PASS（Chromium、1280×720・2倍表示、コンソール/ネットワークエラー0）
- `npm audit`：脆弱性0件

開発サーバー：127.0.0.1:5173（`npm run dev`）、プレビュー：127.0.0.1:4173、配布用サーバー：127.0.0.1:8080（`node serve.mjs`）。いずれも Ctrl+C で停止。

## 共有Driveへの取得・保存（実施結果）

| 項目 | 結果 |
|---|---|
| 接続手段 | Claude 側の Google Drive コネクタ（認証済み）。ChatGPT 側の接続は使用していない |
| 一覧取得 | 可（共有ルート・各サブフォルダを列挙） |
| 全文取得 | 可。仕様書・JSON・CSVを全文取得し、サイズがDriveの記録と一致することを確認 |
| PNG取得 | 可。7枚を取得し、マニフェスト記載の SHA-256 と全一致（v0.2.0 では v2.1 の effects_sheet.png を再取得し、新マニフェストの SHA-256 と一致） |
| v2.1 追加資料 | sprite_manifest_v2.json（内部version 2.1）、asset_loading_policy.json、03_sprite_addresses_v2.md、sprite_rectangles_v2.csv、役成立光の納品記録・検証JSONを取得。旧版・確認用フォルダは読んでいない |
| コンテナからDriveへの直接HTTP | 不可（プロキシが drive.google.com を拒否、403） |
| 新規保存 | 可。テキストはコネクタで作成、PNG/JSON原本はDrive内でサーバー側コピー |
| バイナリ（ZIP・スクリーンショットPNG）の保存 | **不可（実用上）**：コネクタは内容をツール呼出しの本文として渡す方式のため、ZIP/PNGの大きなバイナリを正確に転送できない（試行時に転記誤りを検出）。ZIPはコンテナ内で作成・展開検証のみ実施 |

補足：取得した仕様・JSON/CSV は `docs/reference/` に読取り専用コピーとして保存（原本は変更していない）。
Drive コネクタの出力が大きい場合にファイルへ保存されるよう、ローカル設定 `.claude/settings.local.json`（リポジトリ管理外）で `MAX_MCP_OUTPUT_TOKENS` を下げて取得しました。資格情報・トークンは記録していません。
