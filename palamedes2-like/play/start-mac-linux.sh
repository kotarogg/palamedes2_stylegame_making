#!/bin/sh
# パラメデス２風 検証版：ローカルHTTPサーバーを起動（Node.js 18以上が必要）。停止は Ctrl+C
cd "$(dirname "$0")" && node serve.mjs . 8080
