// 公開用Web版（Cloudflare Pages 等の静的配信）の ZIP 組立て。v3.2.0-rc.1〜
// 使い方: npm run build:release && node scripts/package-release.mjs <出力フォルダ>
//   dist-release（--mode release のビルド）を site/ へコピーし、開発用メモ（素材フォルダの README.md）を除き、
//   build-info.json・SHA256SUMS.txt・README_PUBLISH_JA.txt を加えて納品検査（check-release --web）に合格したら ZIP にする。
//   BGM 3本・採用フォントは公開リポジトリ外の正式素材。public/ に配置してからビルドする（check-release が SHA-256 で照合）。
import { execFileSync, execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const out = process.argv[2];
if (!out) {
  console.error('usage: node scripts/package-release.mjs <out>');
  process.exit(2);
}
if (!existsSync('dist-release/index.html')) throw new Error('dist-release がありません。先に npm run build:release');
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const label = /VITE_RELEASE_LABEL=(.+)/.exec(readFileSync('.env.release', 'utf8'))?.[1].trim();
if (!label) throw new Error('.env.release に VITE_RELEASE_LABEL がありません');
const commit = execSync('git rev-parse HEAD').toString().trim();
const dirty = execSync('git status --porcelain -- src index.html vite.config.ts package.json .env.release').toString().trim();
if (dirty) throw new Error(`コミットしていない変更があります（ビルド識別子と中身がずれるため中止）：\n${dirty}`);
// ビルドに埋め込まれたコミットと一致すること（古いビルドの梱包を防ぐ）
const builtJs = readdirSync('dist-release/assets').filter((f) => f.startsWith('index-') && f.endsWith('.js'));
const embedded = builtJs.map((f) => readFileSync(join('dist-release/assets', f), 'utf8')).join('');
if (!embedded.includes(commit)) throw new Error(`dist-release のビルドが HEAD（${commit}）と一致しません。npm run build:release をやり直してください`);
if (!embedded.includes(label)) throw new Error(`dist-release に版の表示名（${label}）がありません`);

const name = `kotaro_puzzle_${label}_web_${commit.slice(0, 7)}`;
const root = join(out, name);
const site = join(root, 'site');
rmSync(root, { recursive: true, force: true });
mkdirSync(site, { recursive: true });
cpSync('dist-release', site, { recursive: true });
// 開発用メモ（リポジトリ管理外素材の置き場所の説明）は公開しない。ライセンス文（OFL.txt・帰属表記）は残す
const removed = [];
for (const p of ['assets/audio/bgm/README.md', 'gfx/fonts/README.md']) {
  if (existsSync(join(site, p))) {
    rmSync(join(site, p));
    removed.push(p);
  }
}
const builtAt = /"(\d{4}-\d\d-\d\dT[\d:.]+Z)"/.exec(embedded)?.[1] ?? null;
writeFileSync(join(site, 'build-info.json'), `${JSON.stringify({ name: 'コタローくんパズル', version: pkg.version, release: label, commit, builtAt }, null, 1)}\n`);

// 納品検査（公開用Web版）
execFileSync(process.execPath, ['scripts/check-release.mjs', site, '--web'], { stdio: 'inherit' });

const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]));
const files = walk(site).sort();
const sums = files.map((f) => `${createHash('sha256').update(readFileSync(f)).digest('hex')}  ${relative(root, f).replaceAll('\\', '/')}`);
writeFileSync(join(root, 'SHA256SUMS.txt'), `${sums.join('\n')}\n`);
const bytes = files.reduce((a, f) => a + statSync(f).size, 0);
writeFileSync(
  join(root, 'README_PUBLISH_JA.txt'),
  `コタローくんパズル 公開用Web版 ${label}（PC・スマートフォン共通）

【版】
バージョン：${pkg.version}（リリース候補 ${label}）
コミット：${commit}
ビルド：${builtAt ?? '不明'}
内容：site/ 内 ${files.length} ファイル（${(bytes / 1e6).toFixed(1)}MB）。ビルド済み。公開担当側で Node.js・npm による再ビルドは不要です。

【公開方法（Cloudflare Pages 等の静的配信）】
1. この ZIP を展開します。
2. site フォルダーの中身を公開ルートへアップロードします（site/index.html が公開ルートの index.html になる配置）。
3. 公開 URL を PC とスマートフォンで開き、起動・音声・操作を確認します。
・HTML を直接開く file:// 起動では動きません。HTTP(S) で配信してください。
・site 内のフォルダー名・構成は変更しないでください。README_PUBLISH_JA.txt と SHA256SUMS.txt は担当者用で、公開不要です。
・最大のファイルは BGM の WAV（約16.8MB）です。Cloudflare Pages の1ファイル上限（25MiB）以内です。

【PC・スマートフォンの切替】
同じ URL で動作します。タッチ主体の端末（pointer: coarse）ではスマホ用の操作画面を自動表示し、PC ではキーボード・ゲームパッドの従来の画面を表示します。
PC でスマホ用画面を確認する場合は URL の末尾に ?touch=1 を付けます。
スマホ版：横向き推奨。タイトル・メニュー上部「操作：ボタン／フリック」で切替（端末内へ保存）。同一端末の2P対戦は対象外。

【除外したもの】
開発用の機能（素材確認画面・攻撃注入・計測記録・自動検証用フック）・計測用ビルドの機能、ソースマップ、開発用メモ（${removed.join('、') || 'なし'}）。
`,
);
const zip = `${root}.zip`;
rmSync(zip, { force: true });
execFileSync('zip', ['-q', '-r', '-X', `${name}.zip`, name], { cwd: out });
console.log(JSON.stringify({ zip, files: files.length, bytes, commit, label, removed }));
