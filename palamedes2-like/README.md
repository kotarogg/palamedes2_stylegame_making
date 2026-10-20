# palamedes2-like 第1版統合候補 v1.0.0-rc1（2026-10-20）

パラメデス２風の、640×360・16bit風のブラウザパズルです。
対戦検証版 v0.2.0 の確定挙動を維持したまま、次の要素を統合しました。

- メインメニュー・オプション・遊び方
- MODE1 シングル（ひたすら／ステージクリア）
- MODE2（シングル／CPU対戦／2P対戦）
- 段階的な攻撃（0／200／400ms）
- 採用グラフィック v2.3（13PNG・454枠）
- BGM・効果音・キャラクターボイス
- 開始演出・勝敗演出

> - 仕様の反映と補完した設定値：`docs/SPEC_DECISIONS_20261020.md`
> - 素材不足の報告：`docs/ASSET_ISSUES_20261020.md`
> - テスト結果と実機未確認の範囲：`docs/TEST_REPORT.md`
> - 残課題：`docs/REMAINING_ISSUES.md`
> - v0.2.0 時点の記録：`docs/SPEC_DECISIONS_20261018.md`（残置）

## 遊ぶ（ビルド済みプレイ版）

プレイ版フォルダの `README_PLAY.md` を参照してください。手順は次のとおりです。

1. Windows PC に Node.js 18 以上を入れる。
2. プレイ版フォルダの `start-windows.bat` をダブルクリックする。
3. ブラウザが `http://127.0.0.1:8080/` を開く。ポートが使用中の場合は 8081〜8090 を自動で使う。

HTMLを直接開く方法（file://）では動きません。

## 動作環境（開発）

| 項目 | 内容 |
|---|---|
| 実行 | Chromium系（Edge／Chrome）最新版を想定。Firefox でも動く想定（未検証）。ローカルHTTPサーバー経由で開く |
| 開発 | Node.js 22.12 以上（Vitest 5 の要件。検証は 22.22.0）、npm 10 系 |
| 入力 | キーボード、ゲームパッド（ブラウザの Gamepad API・標準マッピング） |

## セットアップと検証（開発用）

```bash
cd palamedes2-like
npm ci
npm run dev        # 開発サーバー http://127.0.0.1:5173/ （開発ビルドのみ：数字キーで攻撃注入、F9で素材確認画面）
```

| コマンド | 内容 |
|---|---|
| `npm run typecheck` | TypeScript 型検査 |
| `npm test` | 自動テスト（Vitest：ルール・段階攻撃・シングル・MODE2・音声・演出・データ） |
| `npm run build` | 型検査＋本番ビルド → `dist/` |
| `npm run e2e` | ブラウザ確認（Chromium、ビルド済み dist）。結果は `test-results/e2e/` |
| `npm run verify` | 型検査→テスト→ビルド→ブラウザ確認 |
| `npm run serve:dist` | `dist/` を http://127.0.0.1:8080/ で配信 |

BGM 3本（各12〜16.7MB）はリポジトリに含めていません（`public/assets/audio/bgm/README.md` 参照）。
BGM が無くても無音で動きます。e2e では、その3件の404だけを素材未配置として許容します。

## 構成

```text
palamedes2-like/
  src/core/     表示非依存のロジック（固定ステップ60tick/秒）
                game.ts（MODE1 対戦・シングル）、mode2.ts（MODE2）、match.ts（試合・シングル進行）、
                balance.ts（数値正本 JSON の読取り）、attack.ts（段階攻撃）、config.ts（調整値）
  src/data/     mode1_balance_v1.json（数値正本、原本のまま）
  src/input/    キーボード・ゲームパッド・CPU・設定の保存
  src/audio/    audioMap.ts（イベント⇔ファイルの一元表）、audioBus.ts（Web Audio・ミックス）、director.ts（論理イベント→音）
  src/view/     描画（盤面・演出・数字合成・倍率）、presentation.ts（開始・結果演出のタイミング）
  src/ui/       メニュー入力・画面部品・記録
  src/app.ts    画面遷移（メニュー／オプション／遊び方／試合）
  public/assets/sprites/  採用PNG 13枚（原本のまま、SHA-256照合済み）
  public/assets/audio/    sfx 30本・voice 46本（原本のまま）、bgm（配布時に配置）
  public/data/  sprite_manifest_v2.json（2.3）・screen_layout_v2.json・asset_loading_policy.json（原本のまま）
  play/         プレイ版に同梱する起動ファイル・説明
  scripts/      配信サーバー（serve.mjs）・ブラウザ確認（e2e.mjs）・結果一覧生成
  tests/        自動テスト
  docs/         仕様反映記録・素材報告・テスト結果・残課題・環境記録
```

プレイ版の組立ては次の順です。

1. `npm run build` を実行する。
2. `dist/` に `play/*` と `scripts/serve.mjs` を加える。
3. `assets/audio/bgm/` に BGM 3本を置く。
