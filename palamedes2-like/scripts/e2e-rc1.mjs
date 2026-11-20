// v3.2.0-rc.1 公開用Web版の動作確認（PC・スマホ）。梱包済み site/ をそのまま配信して検査する。
// 使い方: node scripts/e2e-rc1.mjs <site フォルダー>
//   公開版には自動検証用フック（__p2like）が無いため、DOM・画面の画素変化・コンソールエラー・HTTP 応答で確認する。
//   スマホは Chromium の端末エミュレーション（タッチ・pointer: coarse・画面サイズ）。実機・聴感の検証ではない。
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { chromium, devices } from 'playwright-core';

const ROOT = process.argv[2];
if (!ROOT) throw new Error('usage: node scripts/e2e-rc1.mjs <site>');
const PORT = Number(process.env.E2E_PORT ?? 8791);
const URL0 = `http://127.0.0.1:${PORT}/`;
const OUT = new URL('../test-results/e2e-rc1/', import.meta.url);
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const server = spawn(process.execPath, ['scripts/serve.mjs', ROOT, String(PORT)], { stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((ok, ng) => {
  server.stdout.on('data', (d) => String(d).includes('配信中') && ok());
  server.on('exit', (c) => ng(new Error(`server exited ${c}`)));
});
const results = [];
const check = (group, name, pass, detail = '') => {
  results.push({ group, name, pass: !!pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  [${group}] ${name}${detail ? `  (${String(detail).slice(0, 300)})` : ''}`);
};
const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function open(group, opts, query = '') {
  const ctx = await browser.newContext(opts);
  const page = await ctx.newPage();
  const errors = [];
  const bad = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  // ブラウザが自動で要求する /favicon.ico の404（ゲームは参照しない。基準 a70b851・旧スマホ版でも同じ）は別記録
  const favicon = [];
  page.on('console', (m) => m.type() === 'error' && (m.location().url.endsWith('/favicon.ico') ? favicon.push(m.text()) : errors.push(m.text())));
  page.on('response', (r) => r.status() >= 400 && bad.push(`${r.status()} ${r.url()}`));
  await page.goto(URL0 + query, { waitUntil: 'load' });
  await wait(2500);
  return { ctx, page, errors, bad, group, favicon };
}
const canvasHash = (page) => page.evaluate(() => document.querySelector('canvas').toDataURL()).then((s) => createHash('sha1').update(s).digest('hex'));
const shot = (page, name) => page.screenshot({ path: new URL(`${name}.png`, OUT).pathname });
const noHScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
const menuLabels = (page) => page.$$eval('#mobile-menu button', (b) => b.map((x) => x.textContent));
const tapMenu = async (page, label) => {
  await page.locator('#mobile-menu button', { hasText: new RegExp(`^${label}$`) }).first().click();
  await wait(400);
};
// 実際のタッチ入力（CDP Input.dispatchTouchEvent）。ブラウザがタッチからポインターイベントを生成する
const cdpOf = new WeakMap();
const touch = async (page, type, x, y, id = 1) => {
  if (!cdpOf.has(page)) cdpOf.set(page, await page.context().newCDPSession(page));
  await cdpOf.get(page).send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y, id }] });
};
const center = async (page, sel) => {
  const b = await page.locator(sel).first().boundingBox();
  return [b.x + b.width / 2, b.y + b.height / 2];
};
const press = async (page, sel, ms = 120) => {
  const [x, y] = await center(page, sel);
  await touch(page, 'touchStart', x, y);
  await wait(ms);
  const held = await page.locator(sel).first().evaluate((e) => e.classList.contains('held'));
  await touch(page, 'touchEnd');
  await wait(80);
  return held;
};

// ───── PC ─────
{
  const s = await open('PC', { viewport: { width: 1280, height: 720 } });
  const { page } = s;
  const info = await page.evaluate(() => fetch('build-info.json').then((r) => r.json()));
  check('PC', '起動・ビルド情報（build-info.json）', info.release === 'v3.2.0-rc.1' && info.version === '3.2.0', JSON.stringify(info));
  check('PC', 'スマホ用の操作画面を出さない（pointer: fine）', await page.evaluate(() => !document.body.classList.contains('mobile') && !document.getElementById('mobile-shell')));
  check('PC', '自動検証用フック（__p2like）が公開版に無い', await page.evaluate(() => typeof window.__p2like === 'undefined'));
  const fonts = await page.evaluate(() => document.fonts.check('16px "Noto Sans JP"') || [...document.fonts].some((f) => f.status === 'loaded'));
  check('PC', '採用フォントの読込', fonts);
  await shot(page, 'pc_01_title');
  const h0 = await canvasHash(page);
  await page.keyboard.press('Enter');
  await wait(900);
  const h1 = await canvasHash(page);
  await shot(page, 'pc_02_menu');
  check('PC', 'キーボード：タイトル→メインメニュー（画面が変化）', h0 !== h1);
  // MODE1 → シングル → ひたすら
  for (const k of ['Enter', 'Enter', 'Enter']) {
    await page.keyboard.press(k);
    await wait(700);
  }
  await wait(1500);
  const g0 = await canvasHash(page);
  for (const k of ['ArrowRight', 'ArrowRight', 'Space', 'ArrowLeft', 'Space']) {
    await page.keyboard.press(k);
    await wait(250);
  }
  await wait(800);
  const g1 = await canvasHash(page);
  await shot(page, 'pc_03_game');
  check('PC', 'キーボード：MODE1 シングル開始・移動・打上げ（画面が変化）', g0 !== h1 && g0 !== g1);
  await page.keyboard.press('Escape');
  await wait(600);
  await shot(page, 'pc_04_esc');
  check('PC', 'コンソールエラー・ページエラーなし', s.errors.length === 0, s.errors.join(' / '));
  check('PC', 'HTTP 4xx/5xx なし', s.bad.length === 0, s.bad.join(' / '));
  await s.ctx.close();
}

// ───── スマホ（横向き・タッチ端末を自動判定）─────
const phoneL = { ...devices['iPhone 13 landscape'], userAgent: devices['Pixel 7'].userAgent };
{
  const s = await open('スマホ横', { ...phoneL, defaultBrowserType: undefined });
  const { page } = s;
  check('スマホ横', 'タッチ端末で操作画面を自動表示（?touch なし）', await page.evaluate(() => document.body.classList.contains('mobile') && !!document.getElementById('mobile-shell')));
  check('スマホ横', '横スクロールが出ない', await noHScroll(page));
  const fit = await page.evaluate(() => {
    const r = document.querySelector('canvas').getBoundingClientRect();
    return { ok: r.left >= -1 && r.top >= -1 && r.right <= innerWidth + 1 && r.bottom <= innerHeight + 1 && r.width > 200, r: [r.left, r.top, r.width, r.height].map(Math.round), vw: innerWidth, vh: innerHeight };
  });
  check('スマホ横', 'ゲーム画面が画面内に収まる', fit.ok, JSON.stringify(fit));
  check('スマホ横', 'タイトルに「タップしてはじめる」・版表示 v3.2.0-rc.1', (await menuLabels(page)).includes('タップしてはじめる') && (await page.textContent('.mobile-hint')).includes('v3.2.0-rc.1'));
  await shot(page, 'sp_l_01_title');
  // 操作設定（ボタン／フリック）・版表示
  await page.click('.mobile-settings-open');
  await wait(300);
  const ver = await page.textContent('#mobile-settings small');
  check('スマホ横', '操作設定パネル：版表示（v3.2.0-rc.1・コミット）', /^v3\.2\.0-rc\.1 · [0-9a-f]{7}$/.test(ver), ver);
  await shot(page, 'sp_l_02_settings');
  await page.click('#mobile-settings button:has-text("設定を閉じる")');
  await wait(300);
  await tapMenu(page, 'タップしてはじめる');
  await wait(600);
  const top = await menuLabels(page);
  check('スマホ横', 'メインメニューをボタンで表示', top.includes('MODE1') && top.includes('MODE2'), top.join(','));
  await tapMenu(page, 'MODE1');
  const m1 = await menuLabels(page);
  await shot(page, 'sp_l_03_mode1');
  check('スマホ横', 'MODE1：同一端末の2P対戦を表示しない', m1.includes('シングル') && m1.includes('CPU対戦') && !m1.includes('2P対戦'), m1.join(','));
  await page.click('#mobile-right button:has-text("戻る")');
  await wait(400);
  await tapMenu(page, 'MODE2');
  const m2 = await menuLabels(page);
  check('スマホ横', 'MODE2：同一端末の2P対戦を表示しない', m2.includes('シングル') && !m2.includes('2P対戦'), m2.join(','));
  await page.click('#mobile-right button:has-text("戻る")');
  await wait(400);
  await tapMenu(page, 'MODE1');
  await tapMenu(page, 'シングル');
  await tapMenu(page, 'ひたすら');
  await wait(1800);
  const playing = await page.getAttribute('#mobile-shell', 'data-playing');
  const btns = await page.$$eval('#mobile-left button, #mobile-right button', (b) => b.map((x) => x.textContent));
  check('スマホ横', 'MODE1 シングル開始：操作ボタン（↑せり上げ・◀・▶・打上げ・列入替・役宣言）', playing === 'true' && ['↑ せり上げ', '◀', '▶', '打上げ', '列入替', '役宣言'].every((x) => btns.includes(x)), `${playing} ${btns.join(',')}`);
  const g0 = await canvasHash(page);
  const heldR = await press(page, '[data-action="right"]', 150);
  await press(page, '[data-action="launch"]');
  await press(page, '[data-action="left"]', 150);
  await press(page, '[data-action="rotate"]');
  await press(page, '[data-action="launch"]');
  await wait(600);
  const g1 = await canvasHash(page);
  await shot(page, 'sp_l_04_mode1_game');
  check('スマホ横', 'タッチ：押下中はボタンを強調表示・移動・打上げ・列入替（画面が変化）', heldR && g0 !== g1, `held=${heldR}`);
  // 中断（アプリ切替・通知などでフォーカスを失う）→タップで再開
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await wait(300);
  const p0 = await canvasHash(page);
  await wait(1200);
  const p1 = await canvasHash(page);
  const resumeShown = await page.isVisible('#mobile-resume');
  await shot(page, 'sp_l_05_paused');
  check('スマホ横', '中断：再開案内を表示し、ゲームが止まる（画面が静止）', resumeShown && p0 === p1);
  await page.click('#mobile-resume button');
  await wait(1200);
  check('スマホ横', 'タップで再開（案内が消え、進行再開）', !(await page.isVisible('#mobile-resume')) && (await canvasHash(page)) !== p1);
  await page.click('#mobile-toolbar button:has-text("終了")');
  await wait(600);
  await shot(page, 'sp_l_06_quit');
  check('スマホ横', '「終了」で終了確認を表示（ゲーム外の操作に切替）', (await page.getAttribute('#mobile-shell', 'data-playing')) === 'false');
  check('スマホ横', 'コンソールエラー・ページエラーなし', s.errors.length === 0, s.errors.join(' / '));
  check('スマホ横', 'HTTP 4xx/5xx なし', s.bad.length === 0, s.bad.join(' / '));
  await s.ctx.close();
}

// ───── スマホ：MODE2・フリック・保存 ─────
{
  const s = await open('スマホMODE2', phoneL);
  const { page } = s;
  await page.click('.mobile-settings-open');
  await page.click('#mobile-settings button[data-mode="flick"]');
  const saved = await page.evaluate(() => localStorage.getItem('kotaro_mobile_controls_v1'));
  await page.click('#mobile-settings button:has-text("設定を閉じる")');
  check('スマホMODE2', '操作方法「フリック移動」を端末に保存', /flick/.test(saved ?? ''), saved);
  await page.reload({ waitUntil: 'load' });
  await wait(2000);
  check('スマホMODE2', '再読込後もフリック移動を維持', (await page.textContent('.mobile-settings-open')).includes('フリック'));
  await tapMenu(page, 'タップしてはじめる');
  await wait(500);
  await tapMenu(page, 'MODE2');
  await tapMenu(page, 'シングル');
  await wait(1800);
  const right = await page.$$eval('#mobile-right button', (b) => b.map((x) => x.textContent));
  const pad = await page.$('.mobile-flick-pad');
  const up = pad ? await pad.$eval('.flick-up', (e) => e.textContent) : '';
  check('スマホMODE2', 'MODE2：右は打上げのみ・左はフリック面（せり上げなし）', right.join(',') === '打上げ' && !!pad && !up.includes('せり上げ'), `${right.join(',')} / ${up}`);
  const g0 = await canvasHash(page);
  const box = await pad.boundingBox();
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await touch(page, 'touchStart', cx, cy);
  for (let i = 1; i <= 6; i++) {
    await touch(page, 'touchMove', cx + i * 6, cy);
    await wait(30);
  }
  const dir = await pad.getAttribute('data-direction');
  await wait(300);
  await touch(page, 'touchEnd');
  await wait(100);
  const cleared = (await pad.getAttribute('data-direction')) === null;
  await press(page, '[data-action="launch"]');
  await wait(600);
  await shot(page, 'sp_m2_01_flick_game');
  check('スマホMODE2', 'フリック：右へなぞると右移動として認識・離すと解除・画面が変化', dir === 'right' && cleared && (await canvasHash(page)) !== g0, `${dir} cleared=${cleared}`);
  check('スマホMODE2', 'コンソールエラー・ページエラーなし', s.errors.length === 0, s.errors.join(' / '));
  await s.ctx.close();
}

// ───── スマホ：MODE1 フリック（上なぞりでせり上げ）→ ボタン方式へ戻す ─────
{
  const s = await open('スマホ切替', phoneL);
  const { page } = s;
  await page.click('.mobile-settings-open');
  await page.click('#mobile-settings button[data-mode="flick"]');
  await page.click('#mobile-settings button:has-text("設定を閉じる")');
  await tapMenu(page, 'タップしてはじめる');
  await wait(500);
  await tapMenu(page, 'MODE1');
  await tapMenu(page, 'シングル');
  await tapMenu(page, 'ひたすら');
  await wait(1800);
  const pad = await page.$('.mobile-flick-pad');
  const up = pad ? await pad.$eval('.flick-up', (e) => e.textContent) : '';
  const right = await page.$$eval('#mobile-right button', (b) => b.map((x) => x.textContent));
  check('スマホ切替', 'MODE1 フリック方式：左はフリック面（↑せり上げ表示）・右は打上げ／列入替／役宣言', !!pad && up.includes('せり上げ') && right.join(',') === '打上げ,列入替,役宣言' && !(await page.$('[data-action="left"]')), `${up} / ${right.join(',')}`);
  const box = await pad.boundingBox();
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const g0 = await canvasHash(page);
  await touch(page, 'touchStart', cx, cy);
  for (let i = 1; i <= 6; i++) {
    await touch(page, 'touchMove', cx, cy - i * 6);
    await wait(30);
  }
  const dir = await pad.getAttribute('data-direction');
  await touch(page, 'touchEnd');
  await wait(500);
  check('スマホ切替', 'MODE1 フリック：上へなぞるとせり上げとして認識・画面が変化', dir === 'manualRise' && (await canvasHash(page)) !== g0, dir);
  await page.click('#mobile-toolbar button:has-text("終了")');
  await wait(400);
  await page.reload({ waitUntil: 'load' });
  await wait(2000);
  await page.click('.mobile-settings-open');
  await page.click('#mobile-settings button[data-mode="buttons"]');
  const saved = await page.evaluate(() => localStorage.getItem('kotaro_mobile_controls_v1'));
  await page.click('#mobile-settings button:has-text("設定を閉じる")');
  check('スマホ切替', 'ボタン移動へ戻す切替・端末に保存・表示「操作：ボタン」', /buttons/.test(saved ?? '') && (await page.textContent('.mobile-settings-open')).includes('ボタン'), saved);
  await tapMenu(page, 'タップしてはじめる');
  await wait(500);
  await tapMenu(page, 'MODE1');
  await tapMenu(page, 'シングル');
  await tapMenu(page, 'ひたすら');
  await wait(1800);
  check('スマホ切替', 'ボタン方式に戻ると左右ボタン・せり上げボタンを表示（フリック面なし）', !(await page.$('.mobile-flick-pad')) && !!(await page.$('[data-action="left"]')) && !!(await page.$('[data-action="manualRise"]')));
  const settingsHidden = await page.isHidden('.mobile-settings-open');
  check('スマホ切替', 'ゲーム中は操作設定ボタンを出さない', settingsHidden);
  check('スマホ切替', 'コンソールエラー・ページエラーなし', s.errors.length === 0, s.errors.join(' / '));
  await s.ctx.close();
}

// ───── スマホ縦・PC で ?touch=1 ─────
{
  const s = await open('スマホ縦', devices['Pixel 7']);
  const { page } = s;
  await shot(s.page, 'sp_p_01_title');
  check('スマホ縦', '縦向き：操作画面を表示・横スクロールなし', (await page.evaluate(() => !!document.getElementById('mobile-shell'))) && (await noHScroll(page)));
  check('スマホ縦', 'コンソールエラー・ページエラーなし', s.errors.length === 0, s.errors.join(' / '));
  await s.ctx.close();
  const t = await open('PC ?touch=1', { viewport: { width: 1280, height: 720 } }, '?touch=1');
  await shot(t.page, 'pc_touch1_title');
  check('PC ?touch=1', 'PC で ?touch=1 を付けるとスマホ用画面を確認できる', await t.page.evaluate(() => !!document.getElementById('mobile-shell')));
  check('PC ?touch=1', 'コンソールエラー・ページエラーなし', t.errors.length === 0, t.errors.join(' / '));
  await t.ctx.close();
}

await browser.close();
server.kill();
const pass = results.filter((r) => r.pass).length;
writeFileSync(new URL('results.json', OUT), JSON.stringify({ root: ROOT, pass, total: results.length, results }, null, 1));
console.log(`\n[公開用Web版 動作確認] ${pass}/${results.length} PASS`);
process.exit(pass === results.length ? 0 : 1);
