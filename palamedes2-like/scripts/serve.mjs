// 依存なしのローカル静的サーバー（ビルド済み実行版の起動用）。
// 使い方: node serve.mjs [公開ディレクトリ=.] [ポート=8080] [--open]   停止: Ctrl+C
// ポートが使用中なら次の番号（最大10個先まで）で起動する。--open で起動後に既定のブラウザを開く。
import { spawn } from 'node:child_process';
import { createReadStream, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const openBrowser = process.argv.includes('--open');
const root = resolve(args[0] ?? '.');
const firstPort = Number(args[1] ?? 8080);
let port = firstPort;
const host = '127.0.0.1';
const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.wav': 'audio/wav',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const server = createServer((req, res) => {
  let path = decodeURIComponent(new URL(req.url ?? '/', `http://${host}`).pathname);
  if (path.endsWith('/')) path += 'index.html';
  const file = normalize(join(root, path));
  if (file !== root && !file.startsWith(root + sep)) {
    res.writeHead(403).end('forbidden');
    return;
  }
  try {
    if (!statSync(file).isFile()) throw new Error('not file');
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('not found');
    return;
  }
  res.writeHead(200, { 'content-type': types[extname(file).toLowerCase()] ?? 'application/octet-stream', 'cache-control': 'no-cache' });
  createReadStream(file).pipe(res);
});

function open(url) {
  const cmd = process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  try {
    spawn(cmd[0], cmd[1], { stdio: 'ignore', detached: true }).on('error', () => undefined).unref();
  } catch {
    /* ブラウザを開けない環境では URL を手で開く */
  }
}

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE' && port < firstPort + 10) {
    console.log(`ポート ${port} は使用中のため ${port + 1} を試します`);
    port += 1;
    server.listen(port, host);
    return;
  }
  console.error(`サーバーを起動できませんでした: ${e.message}`);
  process.exit(1);
});

server.on('listening', () => {
  const url = `http://${host}:${port}/`;
  console.log(`配信中: ${url}  （公開ディレクトリ: ${root}）`);
  console.log('ブラウザで上記URLを開いてください。停止は Ctrl+C またはこのウィンドウを閉じる');
  if (openBrowser) open(url);
});

server.listen(port, host);
