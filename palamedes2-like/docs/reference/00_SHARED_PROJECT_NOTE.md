# パラメデス２風ゲーム：プロジェクト共通ノート
2026-10-18 持ち帰り統合仕様反映／内容改訂v0.2


## 目的と役割
640×360、16:9、16bit風のブラウザ対戦パズルゲームを制作する。第1版の目標はCPU対戦と1台PCでのローカル2人対戦。オンライン対戦は第1版対象外。後から追加可能なようにロジック・入力・表示を分離する。

| 担当 | 責任 |
|---|---|
| ChatGPT Work | 企画・仕様設計、仕様書更新、矛盾検証、レビュー、進行管理、Claude向け指示書 |
| Claude Code | プログラミング、ゲームロジック・画面・アニメーション、動作テスト、実行版 |
| 別のChatGPT画像生成セッション | 画像素材。本番画像は未着手・開始しない |
| 人間 | 企画の最終決定、資料提供、必要時の実機テスト |

Claude Codeへの指示はまだ一度も送っていない。プログラムは未着手。今回の指示書保存は実行許可・送信を意味しない。

## 共通の保存先
https://drive.google.com/drive/folders/1RbNA7ztMvSUFSeFXUuvTE4LWxulRbx00

| 保存内容 | フォルダ |
|---|---|
| 共有ノート、課題・決定管理、初回作業指示 | 00_共有ノート・進行管理 |
| 基本仕様、画面座標、動作仕様、矩形番地JSON/CSV | 01_仕様書・設計資料 |
| 納品仮PNG7枚 | 02_画像素材/02_スプライトシート・納品 |
| 原作連続画像52枚、キャラクター参考 | 02_画像素材/01_参考画像・キャラ資料 |
| ソースコード | 03_プログラム成果物/01_ソースコード |
| プレイ可能版 | 03_プログラム成果物/02_プレイ可能なテスト版 |
| 検査・テスト結果 | 04_テスト・検証/01_テスト結果・不具合 |
| 実行画面記録 | 04_テスト・検証/02_スクリーンショット・録画 |
| 過去版 | 90_旧版・保管 |

## 参照順序・確定度
最新のユーザー決定を優先。今回引継ぎ本文で明示されたルールは確定基準として収録。ユーザーが持ち帰った統合仕様v1.0を受領・保存。これは過去単一文書の原文コピーではなく、前セッションの再構成資料。本文自身の暫定・未確定区分を維持する。
仕様を上書きする新たなゲームルールは決定していない。数値は「確定」「既存暫定」「未確認」「技術提案」で区別。未確認値を設定値として埋めて正式仕様扱いしない。

読む順：00_game_spec_integrated_v1.0.md → 01_game_rules_v0.1.md → 02_screen_coordinates_v0.1.md → 03_sprite_addresses_v2.md / sprite_manifest_v2.json → 04_motion_state_spec_v0.1.md → 05_CLAUDE_FIRST_TASK_v1.0.md。
保留項目と着手条件は 01_OPEN_ISSUES_AND_DECISIONS.md。参考画像索引は 05_reference_materials.md / reference_inventory.json。

## 現在の到達点
- 仮PNG7枚が共有先に存在。286矩形を実バイトから再検査しPASS。
- 番地v2はS4小型Y=96とS5/S6追補を統合し、JSON/CSV/一覧を同じ定義から生成。
- 連続画像52枚を確認。連番は動作順の資料であり、採取間隔不明のため秒数の根拠にはしない。
- ルール・動作・座標・初回指示の文書を整備。受領仕様により役条件・主要UI・描画順を補完。攻撃式/消去/勝敗の一部は受領資料でも未確定。
- 総合判定：確定部分の基礎実装を開始する初回指示書は準備済み。完全な対戦ゲーム仕様はG01〜G06の決定待ち。Claudeへの開始操作は人間の別途指示を待つ。

## 更新手順
既存ファイルの削除・無断移動は行わない。仕様変更時は変更理由・ユーザー決定・影響ファイル・版を課題台帳へ記録し、マニフェストと表示側を同じ版で更新する。旧 v1 の寸法や番地を現行PNGへ適用しない。

## 今回作成したファイルへの直接リンク

- [sprite_manifest_v2.json](https://drive.google.com/file/d/11xfdxEa5gVrWLrTWX5WxY_NzTLOWDQnq/view?usp=drivesdk)
- [01_game_rules_v0.1.md](https://drive.google.com/file/d/1BeszCSdeyAMa-uciLTZ2QyoXX1IBEEyj/view?usp=drivesdk)
- [02_screen_coordinates_v0.1.md](https://drive.google.com/file/d/1muJTgZpY-luxH0R8_9Qu6pSpWL8aIGeW/view?usp=drivesdk)
- [03_sprite_addresses_v2.md](https://drive.google.com/file/d/1izfLVpK7f5TtI2a5rSy258TjUwNAMdkW/view?usp=drivesdk)
- [04_motion_state_spec_v0.1.md](https://drive.google.com/file/d/19OsWkMJw-3NoMJBf0e2UbXlvkpQINvBB/view?usp=drivesdk)
- [05_reference_materials.md](https://drive.google.com/file/d/1_QyMdbUfI0bzkFFm3CHtJ1OeLp2vvIQj/view?usp=drivesdk)
- [reference_inventory.json](https://drive.google.com/file/d/1LhzxXMyEP9WskeogbusrjBnU1uN2782Q/view?usp=drivesdk)
- [screen_coordinates_v2.csv](https://drive.google.com/file/d/1epyptAZyFvgE1gYHih7LrV37nTfNsxtv/view?usp=drivesdk)
- [screen_layout_v2.json](https://drive.google.com/file/d/1i5TXbX-9YNMXnd-HKK8_BB6Noztgza3j/view?usp=drivesdk)
- [sprite_rectangles_v2.csv](https://drive.google.com/file/d/1_KiAVP-XwruuLLXWMnYeyA3NkZ6koIIe/view?usp=drivesdk)
- [06_asset_validation_20261018.md](https://drive.google.com/file/d/1b2_yc3FWT6ab05KZX0iHZnVqkrJIVCtq/view?usp=drivesdk)
- [sprite_validation_v2.json](https://drive.google.com/file/d/14TikAVlb1KF8CI2ro7ex1VWSdwZ2XkFC/view?usp=drivesdk)
- [07_drive_audit_20261018.md](https://drive.google.com/file/d/1Q-EUI7neqZUjNq8ZE21B-U4sOO8UkcXT/view?usp=drivesdk)
- [01_OPEN_ISSUES_AND_DECISIONS.md](https://drive.google.com/file/d/1dSMbxYo9QU8K7Uv35I1EkgCGrOop0qH_/view?usp=drivesdk)
- [05_CLAUDE_FIRST_TASK_v1.0.md](https://drive.google.com/file/d/1Rj6e9FH9t0Jszb_nQL_SeRytr_pcdfmY/view?usp=drivesdk)

## 受領反映の要点

攻撃小アイコンは左5・右4。役名より帰還・打上げを前面。発射時は上詰めせず成功後に詰める。v0.1名の本文は改訂v0.2へ更新。新規受領資料と差分記録へのリンクは下記。

- [SOURCE_game_spec_conversation_v1.0.txt](https://drive.google.com/file/d/1Dds06l2zYXAGt8H5seyQKP96bHrj-Jd8/view?usp=drivesdk)
- [00_game_spec_integrated_v1.0.md](https://drive.google.com/file/d/1Fj5prj9THcn9mJy-lK6ZO5lmk-aZ77St/view?usp=drivesdk)
- [08_handoff_integration_20261018.md](https://drive.google.com/file/d/1ZV9UimXcZtkE06tPcjtk8Y1dOAyWQJpL/view?usp=drivesdk)

## 正式な初回指示書

2026-10-18：05_CLAUDE_FIRST_TASK_v1.0.mdを正式作成。既存ファイルIDを維持しDRAFT名を正式名へ更新。環境確認、Drive接続、作業コピー、依存/Git、起動・検証・納品手順を追加。ユーザーがClaudeへ開始命令を貼り付ける運用。ChatGPTからClaudeへの送信・起動は行っていない。
