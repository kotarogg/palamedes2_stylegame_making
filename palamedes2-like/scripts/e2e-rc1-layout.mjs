// v3.2.0-rc.1：評価済みスマホ版（旧ZIP）と公開候補版のスマホ操作画面を同条件で比較する。
// 使い方: node scripts/e2e-rc1-layout.mjs <旧スマホ版の公開フォルダー> <公開候補版 site>
//   画面サイズ別（横 844×390・横 750×342・縦 390×844）に、タイトル／メニュー／MODE1・MODE2 のゲーム中（ボタン方式・フリック方式）の
//   操作ボタン・フリック面・ツールバーの文言と位置（getBoundingClientRect）、操作設定パネルの文言を取り出して突き合わせる。
//   版表示（旧：V320-FIX-05 固定表記、新：v3.2.0-rc.1・コミット）だけは差分として許容し、結果に明記する。
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright-core';

const [OLD, NEW] = process.argv.slice(2);
if (!OLD || !NEW) throw new Error('usage: node scripts/e2e-rc1-layout.mjs <old> <new>');
const OUT = new URL('../test-results/e2e-rc1/', import.meta.url);
mkdirSync(OUT, { recursive: true });
const serve = (root, port) =>
  new Promise((ok, ng) => {
    const p = spawn(process.execPath, ['scripts/serve.mjs', root, String(port)], { stdio: ['ignore', 'pipe', 'inherit'] });
    p.stdout.on('data', (d) => String(d).includes('配信中') && ok(p));
    p.on('exit', (c) => ng(new Error(`server exited ${c}`)));
  });
const servers = [await serve(OLD, 8792), await serve(NEW, 8793)];
const browser = await chromium.launch();
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Mobile Safari/537.36';
const SIZES = [
  [844, 390],
  [750, 342],
  [390, 844],
];
const VERSION = /V320-FIX-05|基準 9cf3911|v3\.2\.0-rc\.1|v3\.2\.0 FIX-05|[0-9a-f]{7}$/;

const snap = (page) =>
  page.evaluate(() => {
    const r = (e) => e.getBoundingClientRect();
    const box = (e) => [r(e).x, r(e).y, r(e).width, r(e).height].map((v) => Math.round(v));
    const items = [...document.querySelectorAll('#mobile-shell button, #mobile-shell .mobile-flick-pad, #mobile-shell canvas')]
      .filter((e) => !e.closest('[hidden]') && !e.hidden)
      .map((e) => ({ area: e.closest('#mobile-left') ? 'left' : e.closest('#mobile-right') ? 'right' : e.closest('#mobile-menu') ? 'menu' : e.closest('#mobile-toolbar') ? 'toolbar' : e.tagName === 'CANVAS' ? 'stage' : '?', text: e.innerText ?? '', action: e.dataset?.action ?? '', box: box(e) }));
    return { playing: document.getElementById('mobile-shell')?.dataset.playing, movement: document.getElementById('mobile-shell')?.dataset.movement, hint: document.querySelector('.mobile-hint')?.textContent, items };
  });

async function run(port, w, h) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, hasTouch: true, isMobile: true, deviceScaleFactor: 1, userAgent: UA });
  const page = await ctx.newPage();
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load' });
  await wait(2500);
  const out = {};
  const tap = async (label) => {
    await page.locator('#mobile-menu button', { hasText: new RegExp(`^${label}$`) }).first().click();
    await wait(450);
  };
  const back = async () => {
    await page.click('#mobile-right button:has-text("戻る")');
    await wait(450);
  };
  const toTitle = async () => {
    await page.reload({ waitUntil: 'load' });
    await wait(2200);
  };
  out.title = await snap(page);
  await page.click('.mobile-settings-open');
  await wait(300);
  out.settings = await page.evaluate(() => [...document.querySelectorAll('#mobile-settings h2, #mobile-settings p, #mobile-settings button')].map((e) => e.textContent));
  out.settingsVersion = await page.textContent('#mobile-settings small');
  await page.click('#mobile-settings button:has-text("設定を閉じる")');
  await tap('タップしてはじめる');
  out.menu = await snap(page);
  for (const movement of ['buttons', 'flick']) {
    if (movement === 'flick') {
      await toTitle();
      await page.click('.mobile-settings-open');
      await page.click('#mobile-settings button[data-mode="flick"]');
      out.flickDetail = await page.textContent('.mobile-mode-detail');
      await page.click('#mobile-settings button:has-text("設定を閉じる")');
      await wait(300);
      out.titleFlick = await snap(page);
      await tap('タップしてはじめる');
    }
    await tap('MODE1');
    out[`m1menu`] = await snap(page);
    await tap('シングル');
    await tap('ひたすら');
    await wait(1800);
    out[`m1_${movement}`] = await snap(page);
    await toTitle();
    await tap('タップしてはじめる');
    await tap('MODE2');
    out[`m2menu`] = await snap(page);
    await tap('シングル');
    await wait(1800);
    out[`m2_${movement}`] = await snap(page);
    await page.click('#mobile-toolbar button:has-text("終了")');
    await wait(500);
    out[`m2_${movement}_quit`] = await snap(page);
    await toTitle();
  }
  // 操作方式の保存は旧版と同じ保存キー
  out.storage = await page.evaluate(() => localStorage.getItem('kotaro_mobile_controls_v1'));
  await ctx.close();
  return out;
}

const diffs = [];
const versionDiffs = [];
const walk = (a, b, path) => {
  if (typeof a !== 'object' || a === null || typeof b !== 'object' || b === null) {
    if (a !== b) (VERSION.test(String(a)) && VERSION.test(String(b)) ? versionDiffs : diffs).push({ path, old: a, new: b });
    return;
  }
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) walk(a[k], b[k], `${path}.${k}`);
};
const report = {};
for (const [w, h] of SIZES) {
  const o = await run(8792, w, h);
  const n = await run(8793, w, h);
  walk(o, n, `${w}x${h}`);
  report[`${w}x${h}`] = { old: o, new: n };
}
await browser.close();
for (const s of servers) s.kill();
writeFileSync(new URL('layout-compare.json', OUT), JSON.stringify({ old: OLD, new: NEW, diffs, versionDiffs, report }, null, 1));
for (const d of versionDiffs) console.log(`版表示の差（許容）  ${d.path}: ${JSON.stringify(d.old)} → ${JSON.stringify(d.new)}`);
for (const d of diffs) console.log(`DIFF  ${d.path}: ${JSON.stringify(d.old)} → ${JSON.stringify(d.new)}`);
const n = Object.values(report).reduce((a, r) => a + Object.values(r.new).filter((v) => v?.items).reduce((x, v) => x + v.items.length, 0), 0);
console.log(`\n[スマホ操作画面 旧版比較] ${SIZES.length}画面サイズ・比較要素${n}件  差分 ${diffs.length}件（版表示 ${versionDiffs.length}件は許容）`);
process.exit(diffs.length === 0 ? 0 : 1);
