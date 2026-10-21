// 開発環境専用：採用フォント NotoSansJP-VF.ttf が手元に無い環境で、画面確認・スクリーンショットを同じ書体で撮るための代用。
// 使い方：E2E_FONT_STANDIN=<@fontsource-variable/noto-sans-jp を展開した package フォルダ> npm run e2e
//   - 同じ書体（Google Fonts の Noto Sans JP 可変・SIL OFL 1.1）を Fontsource の分割 woff2 で読み込む
//   - ゲームが要求する gfx/fonts/NotoSansJP-VF.ttf には、その分割のうち欧文部分を返す（日本語は同じファミリーの他の分割が描く）
// 配布物には一切含めない。これを使った検査結果・画像には「フォント代用」と明記する（納品の合格判定には使わない）。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export async function installFontStandin(context, dir) {
  const css = readFileSync(join(dir, 'index.css'), 'utf8')
    .replaceAll("'Noto Sans JP Variable'", "'Noto Sans JP'")
    .replaceAll('url(./files/', 'url(/__font_standin/');
  await context.route('**/__font_standin/*', (route) => {
    const name = new URL(route.request().url()).pathname.split('/').pop();
    route.fulfill({ status: 200, contentType: 'font/woff2', body: readFileSync(join(dir, 'files', name)) });
  });
  await context.route('**/gfx/fonts/NotoSansJP-VF.ttf', (route) =>
    route.fulfill({ status: 200, contentType: 'font/woff2', body: readFileSync(join(dir, 'files', 'noto-sans-jp-latin-wght-normal.woff2')) }),
  );
  await context.addInitScript((cssText) => {
    const add = () => {
      const st = document.createElement('style');
      st.textContent = cssText;
      document.documentElement.appendChild(st);
      // canvas の文字は読込を待たないため、分割を先に読み込む
      void document.fonts.ready.then(() => document.fonts.forEach((f) => f.family.includes('Noto Sans JP') && f.load().catch(() => undefined)));
    };
    if (!location.protocol.startsWith('http')) return;
    if (document.documentElement) add();
    else document.addEventListener('DOMContentLoaded', add);
  }, css);
}
