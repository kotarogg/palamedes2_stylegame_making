// プレイ版フォルダの納品検査（ブラウザ不要）。必須素材（第3版の画像49＋v3.1.0追加9・JSON6・フォント・音声114）の実在・サイズ・SHA-256・WAVヘッダ、
// index.html が参照するビルド済みJSの実在、使われない旧ハッシュJSが残っていないこと、起動ファイルの同梱を確認する。
// 使い方: node scripts/check-release.mjs <プレイ版フォルダ> [--allow-missing-bgm]
//   --allow-missing-bgm は開発用のフォールバック検査（BGM 3本と採用フォントの未配置だけを許容）。納品合格の判定には使わない。
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2];
const allowMissingBgm = process.argv.includes('--allow-missing-bgm');
if (!dir) {
  console.error('usage: node scripts/check-release.mjs <dir> [--allow-missing-bgm]');
  process.exit(2);
}
const expected = JSON.parse(readFileSync(new URL('./release-expected.json', import.meta.url), 'utf8')).files;
const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass: !!pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};

/** RIFF/WAVE の fmt・data チャンクがファイル長と整合するか（デコード可能性の簡易確認。実デコードはブラウザ検査） */
function wavOk(buf) {
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') return 'RIFF/WAVEでない';
  let off = 12;
  let fmt = false;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === 'fmt ') fmt = true;
    if (id === 'data') return fmt && off + 8 + size <= buf.length ? null : 'data チャンク長が不正';
    off += 8 + size + (size % 2);
  }
  return 'data チャンクなし';
}

const bad = [];
let missingBgm = 0;
for (const f of expected) {
  const p = join(dir, f.path);
  const isBgm = f.path.startsWith('assets/audio/bgm/') || f.path === 'gfx/fonts/NotoSansJP-VF.ttf';
  if (!existsSync(p)) {
    if (isBgm) missingBgm++;
    if (!(isBgm && allowMissingBgm)) bad.push(`${f.path}: なし`);
    continue;
  }
  const buf = readFileSync(p);
  if (buf.length !== f.size) bad.push(`${f.path}: サイズ ${buf.length} ≠ ${f.size}`);
  if (f.sha256 && createHash('sha256').update(buf).digest('hex') !== f.sha256) bad.push(`${f.path}: SHA-256 不一致`);
  if (f.path.endsWith('.wav')) {
    const e = wavOk(buf);
    if (e) bad.push(`${f.path}: ${e}`);
  }
}
const n = (pre) => expected.filter((f) => f.path.startsWith(pre)).length;
check(
  `${allowMissingBgm ? '［フォールバック］' : '［納品］'}必須素材 画像${n('gfx/assets/')}・JSON${expected.filter((f) => f.path.endsWith('.json')).length}・フォント1・音声${n('assets/audio/')}（BGM${n('assets/audio/bgm/')}・SE${n('assets/audio/sfx/')}・ボイス${n('assets/audio/voice/')}）の実在・サイズ・SHA-256・WAVヘッダ`,
  bad.length === 0,
  bad.length ? bad.slice(0, 8).join(' / ') : allowMissingBgm && missingBgm ? `BGM・フォント未配置${missingBgm}件を許容` : '全件一致',
);
// 旧版・試聴・原音を本番へ混ぜない：一覧にない画像・音声・フォントが無いこと
const listed = new Set(expected.map((f) => f.path));
const walk = (d) => (existsSync(join(dir, d)) ? readdirSync(join(dir, d), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(`${d}/${e.name}`) : [`${d}/${e.name}`])) : []);
const extra = [...walk('gfx'), ...walk('assets/audio'), ...walk('data'), ...walk('assets/sprites')].filter((p) => /\.(png|wav|ttf|json|ogg|mp3)$/.test(p) && !listed.has(p));
check('一覧外の画像・音声・フォント・JSON（旧版スプライト・旧SE・試聴音源など）を同梱しない', extra.length === 0, extra.slice(0, 8).join(', '));

const html = existsSync(join(dir, 'index.html')) ? readFileSync(join(dir, 'index.html'), 'utf8') : '';
// 第3版：配布JSは圧縮・分割（入口1＋モジュール）。index.html が参照するJSがすべて実在し、参照されないJS（旧ハッシュ）が残っていない
const refs = [...html.matchAll(/(?:src|href)="\.?\/?(assets\/[\w-]+\.js)"/g)].map((m) => m[1]);
const entry = [...html.matchAll(/<script[^>]+src="\.?\/?(assets\/index-[\w-]+\.js)"/g)].map((m) => m[1]);
const jsFiles = existsSync(join(dir, 'assets')) ? readdirSync(join(dir, 'assets')).filter((f) => f.endsWith('.js')).map((f) => `assets/${f}`) : [];
check(
  'index.html が参照するビルド済みJS（入口1＋分割モジュール）がすべて実在し、参照されないJS（旧ハッシュ）が残っていない',
  entry.length === 1 && refs.every((r) => existsSync(join(dir, r))) && jsFiles.length === new Set(refs).size && jsFiles.every((f) => refs.includes(f)),
  `参照=${[...new Set(refs)].join(',')} 実在=${jsFiles.join(',')}`,
);
const launch = ['start-windows.bat', 'serve.mjs', 'README_PLAY.md', 'start-mac-linux.sh'];
check('起動ファイル（start-windows.bat・serve.mjs・README_PLAY.md・start-mac-linux.sh）を同梱', launch.every((f) => existsSync(join(dir, f)) && statSync(join(dir, f)).size > 0), launch.filter((f) => !existsSync(join(dir, f))).join(','));
const bat = existsSync(join(dir, 'start-windows.bat')) ? readFileSync(join(dir, 'start-windows.bat')) : Buffer.alloc(0);
check('start-windows.bat は ASCII・CRLF（Windows の cmd で文字化けしない）', bat.length > 0 && [...bat].every((b) => b < 128) && !/[^\r]\n/.test(bat.toString('latin1')));

const failed = results.filter((r) => !r.pass);
console.log(`\n[${allowMissingBgm ? 'フォールバック検査（納品合格ではない）' : '納品検査'}] ${results.length - failed.length}/${results.length} PASS`);
process.exit(failed.length ? 1 : 0);
