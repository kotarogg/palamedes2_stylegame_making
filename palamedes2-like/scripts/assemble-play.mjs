// プレイ版フォルダの組立て：ビルド済み dist ＋起動ファイル（play/）＋簡易サーバー（scripts/serve.mjs）。
// 使い方: npm run build && node scripts/assemble-play.mjs <出力フォルダ>
// BGM 3本と採用フォントは大容量のためリポジトリに無い。共有ドライブの原本を同じパスへ配置する（README_PLAY.md 参照）。
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const out = process.argv[2];
if (!out) {
  console.error('usage: node scripts/assemble-play.mjs <out>');
  process.exit(2);
}
if (!existsSync('dist/index.html')) throw new Error('dist がありません。先に npm run build');
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
cpSync('dist', out, { recursive: true });
for (const f of ['README_PLAY.md', 'start-windows.bat', 'start-mac-linux.sh']) cpSync(join('play', f), join(out, f));
cpSync('scripts/serve.mjs', join(out, 'serve.mjs'));
console.log(`assembled ${out}`);
