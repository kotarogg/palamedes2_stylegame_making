#!/bin/sh
# パラメデス２風 第1版統合候補：ローカルHTTPサーバーを起動してブラウザを開く（Node.js 18以上が必要）。停止は Ctrl+C
cd "$(dirname "$0")" && node serve.mjs . 8080 --open
