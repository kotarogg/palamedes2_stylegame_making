# v3.1.0 実機テスト・修正引き継ぎ

更新日：2026-10-26（日本時間）

## 参照する版
- 正式な版番号は package.json に合わせて **v3.1.0**。「v0.3.1」と混同しないこと。
- テスト用ブランチ：`test/v3.1.0`
- ゲームコード・素材の基点：`c244855ed36730bd41c00f1e9c6249b8b1dc2492`
- ボイス組み込みコミット：`c99c81c3149ddd87227d2e6a12740c5fa49b666d`
- アプリのルート：`palamedes2-like/`
- 元のプログラマ作業ブランチ：`claude/sweet-meitner-jt0diu`
- このテスト用ブランチを起点として修正ブランチを作ること。mainへのマージ・force pushは依頼していない。

## 評価状態
- 採用ボイス：差し替え11本・ピンチ追加3本。candidates/Aの計14本を採用。B案は比較保管のみ。
- PMの静的コードレビューでは、今回の音声組み込みに仕様違反は見つかっていない。
- プログラマ報告：単体279/279、ブラウザ86/86、配布物5/5。BGM・採用フォント未配置を許容する構成。
- PMによる当該コミットの独立ビルド・自動テスト再実行は未完了。実機の聴感・バランスは合格未確定。
- 発注者の実機確認中。BGMが鳴らない問題について、開いたBGMフォルダが空との報告あり。全配置先・配信先の照合や解消確認は未完了。コードの不具合とはまだ断定しない。

## リポジトリ外の必須素材
GitHubのソースZIPだけでは正式素材一式にならない。以下の4ファイルを別途取得する。

| ファイル | Drive原本 | ソース内の配置先 |
|---|---|---|
| bgm_menu.wav | https://drive.google.com/file/d/1sgOFRD2g9q_UevQ2BigyhCfoe5BnM0u6/view | public/assets/audio/bgm/bgm_menu.wav |
| bgm_puzzle_single.wav | https://drive.google.com/file/d/11FmPMDl2St45hcOakuhxLmjEb3-NlUxG/view | public/assets/audio/bgm/bgm_puzzle_single.wav |
| bgm_puzzle_versus.wav | https://drive.google.com/file/d/18K4JIxMphECQhOYquZVuEvQHacfSI-_K/view | public/assets/audio/bgm/bgm_puzzle_versus.wav |
| NotoSansJP-VF.ttf | https://drive.google.com/file/d/1q4pf3F1sfFPhjTlfR3rvP3-sFDsmTrCh/view | public/gfx/fonts/NotoSansJP-VF.ttf |

配置先はすべて palamedes2-like/ からの相対パス。
空フォルダの存在だけで配置合格としない。ファイル名・サイズ・取得成功を確認する。
その他の必須素材は scripts/release-expected.json、音源登録は src/audio/audioMap.ts を参照する。

## ビルドとダブルクリック起動
ソースのビルドにはNode.js >=22.12が必要。palamedes2-like/で実行する。

```powershell
npm.cmd ci
npm.cmd run build
npm.cmd run assemble:play -- play-v3.1.0
```

組み立て後は play-v3.1.0/start-windows.bat をダブルクリックする。
buildはdistを更新し、assemble:playはdistをプレイ用フォルダへコピーする。素材をpublicへ追加した場合は両方が必要。
assemble:playは指定した出力フォルダを作り直すため、素材の保存元はpublicに置くこと。
毎回の起動にビルドやnpm ciは不要。古いサーバーを終了し、起動時に表示されたURL/ポートを使用する。
index.htmlのfile://直接起動は使用しない。

## 今回の音声条件と試聴重点
- 攻撃代替は役名の代わりに20％、連続採用しない。通常の与ダメ・被ダメ声を復活させない。
- ピンチは到達時30％、同一連続ピンチで抽選1回。外れ・競合でも再抽選なし。低優先度、後からキュー再生しない。
- 自然上昇と攻撃でピンチの原因が移っても同一ピンチなら機会を増やさない。
- 音源は整音済み。再ノーマライズ・速度変更・切り詰めや、音声尺に合わせたゲーム待機延長は行わない。
- 選択ボイスとREADYの重なり（特にコタロー）、ピンチ声とカウントダウンSE、結果の声の間隔、連続宣言時の表示テンポを実機確認する。
- 決定入力による結果ボイスの打ち切りは演出送りとして現状許容。
- ずん子の敗北・ピンチ台詞は指摘を受けたうえで今回は採用済み。再提案・再制作を勝手に始めない。

## 参照資料と納品方式
- 統合報告：docs/REPORT_V310_FIX_R1R2_20261023.md
- 元仕様差分：docs/SPEC_DIFF_V310_20261023.md
- 起動・操作：play/README_PLAY.md
- Drive最新報告：https://drive.google.com/file/d/1RDmCPthJUKvBm_yVxcLMJUnRmPzR7wrz/view
- ボイス納品：https://drive.google.com/drive/folders/11CQ8GuapaC7nkvwCtNjHArOW5h-rzqMr
- ソース・変更素材はGitHubへ通常push。Driveは統合報告書を基本とする。
- 数百ファイルのDrive再納品、専用ZIP作成、納品先から全件取り直す重複検査は不要。
- バグは再現条件・期待結果・実結果・変更理由・実施テストを報告する。
- 実機不具合はまだ収集中。未報告の修正を推測で実施しない。
