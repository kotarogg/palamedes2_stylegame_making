# コタローくんパズル 第3版統合候補 v3.0.0-rc1（2026-10-21）

640×360・16bit風のブラウザパズル（旧称 palamedes2-like）。第1版 v1.0.0-rc1 を基準に、2026-10-21 の第3版統合実装開始指示を反映しました。

- 受攻撃の再設計（ブロック・波・段、ピンチ猶予、上限29、群別のストック表示、接着演出）
- キャラクターとプレイヤー番号の分離（コタロー／アカネ／東北ずん子）、2P対戦のキャラクター選択、CPU対戦の相手順
- 役名表示とボイスの同期（B4・B5）、結果演出（B2・B3：落下→勝者＋クラッカー）、ラウンドごとの入力初期化（B1）
- タイトル・クレジット・新しいメニュー部品、表示倍率（B6：実画素の整数倍）
- 第3版の採用画像49枚・フォント Noto Sans JP・音声114本（段階SE・新相殺音・3キャラのボイス）

> - 仕様差分：`docs/SPEC_DIFF_V3_20261021.md`
> - テスト結果と未確認の範囲：`docs/TEST_REPORT_V3.md`（明細 `docs/TEST_RESULTS_V3_DETAIL.md`）
> - CPU同士のバランス計測：`docs/CPU_BALANCE_V3.md`
> - 残課題：`docs/REMAINING_ISSUES_V3.md`
> - 採用素材の一覧とハッシュ：`docs/ASSETS_V3.md`
> - 納品記録：`docs/DELIVERY_V3_20261021.md`
> - 第1版までの記録（`docs/*_20261018.md`・`*_20261020.md`・`TEST_REPORT.md`・`REMAINING_ISSUES.md`）は残置

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
npm run dev        # 開発サーバー http://127.0.0.1:5173/ （開発ビルドのみ：数字キーで攻撃注入、F9で素材確認画面、F8で計測記録の保存）
```

| コマンド | 内容 |
|---|---|
| `npm run typecheck` | TypeScript 型検査 |
| `npm test` | 自動テスト（Vitest：ルール・段階攻撃・シングル・MODE2・音声・演出・データ） |
| `npm run build` | 型検査＋本番ビルド → `dist/` |
| `npm run e2e` | ブラウザ検査・**納品検査**（必須114本と採用フォントの取得・デコード、第20章の検証、全シーンのスクリーンショット）。結果は `test-results/e2e/` |
| `npm run e2e:fallback` | 開発用のフォールバック検査（BGM 3本と採用フォントの未配置を許容。納品合格ではない。`E2E_FONT_STANDIN=<Fontsource の Noto Sans JP 可変>` で同じ書体を代用して撮影） |
| `node scripts/check-release.mjs <プレイ版フォルダ>` | 配布物の納品検査（素材170件のサイズ・SHA-256・WAVヘッダ、一覧外の同梱なし、JS参照、起動ファイル） |
| `npm run assemble:play <出力>` | プレイ版フォルダの組立て（dist＋起動ファイル） |
| `npm run measure:cpu` | CPU同士のバランス計測（第21章）→ `test-results/cpu-balance/` |
| `npm run measure:mix` | 同時発音のミックスとクリップの波形検査 → `test-results/mix_peak.json` |
| `npm run verify` | 型検査→テスト→ビルド→納品検査（BGM を `public/assets/audio/bgm/` に置いた環境で実行） |
| `npm run verify:fallback` | 同上のフォールバック版（BGM なしの開発環境用） |
| `npm run serve:dist` | `dist/` を http://127.0.0.1:8080/ で配信 |

BGM 3本（各12〜16.7MB）と採用フォント `public/gfx/fonts/NotoSansJP-VF.ttf`（9.6MB）はリポジトリに含めていません（`public/assets/audio/bgm/README.md`・`public/gfx/fonts/README.md` 参照）。フォントが無い場合は画面上部に警告が出ます。
BGM が無くても無音で動きます。ただし納品検査は BGM の欠落を不合格にします。BGM を許容するのは、明示したフォールバック検査だけです。

## 構成

```text
palamedes2-like/
  src/core/     表示非依存のロジック（固定ステップ60tick/秒）
                game.ts（MODE1 対戦・シングル）、mode2.ts（MODE2）、match.ts（試合・シングル進行）、
                balance.ts（数値正本 JSON の読取り）、attack.ts（攻撃量・相殺）、incoming.ts（受攻撃）、metrics.ts（計測）、config.ts（調整値）
  src/data/     mode1_balance_v1.json（数値正本、原本のまま）
  src/input/    キーボード・ゲームパッド・CPU・設定の保存
  src/audio/    audioMap.ts（イベント⇔ファイルの一元表）、audioBus.ts（Web Audio・ミックス）、director.ts（論理イベント→音）
  src/view/     描画（盤面・演出・数字合成・倍率）、presentation.ts（開始・結果演出のタイミング）
  src/ui/       メニュー入力・画面部品・記録
  src/app.ts    画面遷移（タイトル／メニュー／キャラ選択／オプション／クレジット／遊び方／試合）
  public/gfx/    第3版採用画像 49枚（assets/、legacy/ は第2.3版と同一の9シート）・data（マニフェスト・読込一覧・文字・クレジット）・fonts（OFL。本体は配布時に配置）
  public/assets/audio/    sfx 39本・voice 72本（原本のまま）、bgm（配布時に配置）
  public/data/  screen_layout_v2.json（盤面・UI座標。原本のまま）
  tools/        計測（CPU同士のバランス、ミックスの波形検査）
  play/         プレイ版に同梱する起動ファイル・説明
  scripts/      配信サーバー（serve.mjs）・ブラウザ確認（e2e.mjs）・結果一覧生成
  tests/        自動テスト
  docs/         仕様反映記録・素材報告・テスト結果・残課題・環境記録
```

プレイ版の組立ては次の順です。

1. `npm run build` を実行する。
2. `npm run assemble:play <出力>`（`dist/` に `play/*` と `scripts/serve.mjs` を加える）。
3. `assets/audio/bgm/` に BGM 3本、`gfx/fonts/` に NotoSansJP-VF.ttf を置く。
