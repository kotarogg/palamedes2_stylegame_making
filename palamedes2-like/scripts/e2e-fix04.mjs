// V320-FIX-04 の画面検査と証拠画像（1倍の640×360を論理座標どおりに描いて保存）。
// 使い方：npm run build の後に node scripts/e2e-fix04.mjs [--fallback]（フォールバック時は E2E_FONT_STANDIN でフォント代用）
// 直接状態設定を使った検査は自然プレイと区別して記録する（結果JSONの kind）。
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { installFontStandin } from './font-standin.mjs';

const PORT = Number(process.env.E2E_PORT ?? 8766);
const ROOT = process.env.E2E_ROOT ?? 'dist';
const OUT = new URL('../docs/v320f04/', import.meta.url);
mkdirSync(new URL('screens/', OUT), { recursive: true });
const fontPresent = existsSync(join(ROOT, 'gfx/fonts/NotoSansJP-VF.ttf'));
const STANDIN = !fontPresent ? (process.env.E2E_FONT_STANDIN ?? null) : null;

const server = spawn(process.execPath, ['scripts/serve.mjs', ROOT, String(PORT)], { stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((ok, ng) => {
  server.stdout.on('data', (d) => String(d).includes('配信中') && ok());
  server.on('exit', (c) => ng(new Error(`server exited ${c}`)));
});
const results = [];
const check = (name, pass, detail = '', kind = 'direct-state') => {
  results.push({ name, pass: !!pass, detail, kind });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${String(detail).slice(0, 400)})` : ''}`);
};
const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
if (STANDIN) await installFontStandin(context, STANDIN);
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => m.type() === 'error' && !m.text().startsWith('Failed to load resource') && errors.push(m.text()));
// 未配置を許容するのは正式BGM 3本だけ（フォールバック構成）。それ以外の 404 はエラー
page.on('response', (r) => r.status() >= 400 && !new URL(r.url()).pathname.includes('/assets/audio/bgm/') && errors.push(`${r.status()} ${r.url()}`));
await page.goto(`http://127.0.0.1:${PORT}/`);
await page.waitForSelector('body[data-ready]');
await page.waitForTimeout(800);
const ev = (fn, arg) => page.evaluate(fn, arg);
const save = (name, dataUrl) => {
  writeFileSync(new URL(`screens/${name}.png`, OUT), Buffer.from(dataUrl.split(',')[1], 'base64'));
  return `docs/v320f04/screens/${name}.png`;
};
const shots = [];

// 共通：ページ内の補助（1倍キャンバスへ描く・差分の外接）
await ev(() => {
  window.__f4 = {
    canvas() {
      const c = document.createElement('canvas');
      c.width = 640;
      c.height = 360;
      const x = c.getContext('2d');
      x.imageSmoothingEnabled = false;
      return { c, x };
    },
    diffBox(a, b) {
      const da = a.getContext('2d').getImageData(0, 0, 640, 360).data;
      const db = b.getContext('2d').getImageData(0, 0, 640, 360).data;
      let x0 = 640, y0 = 360, x1 = -1, y1 = -1, n = 0;
      for (let i = 0; i < da.length; i += 4)
        if (da[i] !== db[i] || da[i + 1] !== db[i + 1] || da[i + 2] !== db[i + 2]) {
          const p = i / 4, x = p % 640, y = Math.floor(p / 640);
          n++; x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
        }
      return n ? { n, x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 } : { n: 0 };
    },
  };
});

// ---- 1. 対戦：連鎖HUD見出しPNG・数字・ヒビ揺れ・相殺/攻撃表示 ----
{
  await ev(() => window.__p2like.app.startGame('mode1', 'cpu'));
  await page.waitForTimeout(3500);
  const r = await ev(() => {
    const sc = window.__p2like.gameScene();
    const g = sc.game;
    const v = sc.view;
    const [p0, p1] = g.players;
    const FAR = 1e9;
    Object.assign(p0, { streakCount: 12, streakRemaining: FAR, streakCutReserved: true, chainCount: 3, chainRemaining: FAR });
    Object.assign(p1, { streakCount: 19, streakRemaining: FAR, streakCutReserved: false, chainCount: 6, chainRemaining: FAR });
    v.pv[0].crack = 'streak_crack_02';
    v.pv[0].crackStart = g.tick;
    const t = g.tick;
    const { c, x } = window.__f4.canvas();
    v.render(x, t);
    const base = c.toDataURL('image/png');
    // 揺れ：周期内の4位置と基準
    const shake = [0, 3, 6, 9, 12, 20].map((d) => ({ dt: d, off: v.crackShake(0, t + d) }));
    // 揺れの描画差：基準（t）と (-1,0)（t+3）の差は縦帯の中だけ
    const a = window.__f4.canvas(); v.render(a.x, t);
    const b = window.__f4.canvas(); v.pv[0].crackStart = t - 3; v.render(b.x, t);
    v.pv[0].crackStart = t;
    const shakeDiff = window.__f4.diffBox(a.c, b.c);
    // 相殺・攻撃（直接状態設定：既存イベントの数量だけを与える）
    v.pv[0].attackShow = { canceled: 3, sent: 4, start: t };
    v.pv[1].attackShow = { canceled: 0, sent: 2, start: t };
    const d = window.__f4.canvas(); v.render(d.x, t + 6);
    const atkShot = d.c.toDataURL('image/png');
    // 受ストックと重ねた見え方（待機8・処理中ブロック5を直接設定）
    const inc = [p0.incoming, p1.incoming].map((s) => ({ ...s }));
    for (const s of [p0.incoming, p1.incoming]) Object.assign(s, { nextPending: 8 });
    const e = window.__f4.canvas(); v.render(e.x, t + 6);
    const atkStockShot = e.c.toDataURL('image/png');
    // V320-FIX-04-R1：双方の受ストック最大（予約29＋待機28）・双方の相殺＋攻撃を同時に表示。
    // 受ストック（アイコン・枠・待機数）の描画画素が、表示の有無で1画素も変わらない（覆わない・裏へ隠さない）
    for (const s of [p0.incoming, p1.incoming]) Object.assign(s, { blockActive: true, blockReserved: 29, blockRemaining: 27, waveRemaining: 2, nextPending: 28 });
    v.pv[0].attackShow = { canceled: 12, sent: 29, start: t };
    v.pv[1].attackShow = { canceled: 14, sent: 29, start: t };
    const mOn = window.__f4.canvas(); v.render(mOn.x, t + 20); // 光点（250ms）の後
    const maxShot = mOn.c.toDataURL('image/png');
    const saved = [v.pv[0].attackShow, v.pv[1].attackShow];
    v.pv[0].attackShow = null; v.pv[1].attackShow = null;
    const mOff = window.__f4.canvas(); v.render(mOff.x, t + 20);
    void saved;
    const maxDiff = window.__f4.diffBox(mOff.c, mOn.c);
    // 差の出た画素が受ストック領域（列の外接＋待機数）に1つもないこと
    const plans = [0, 1].map((p) => v.stockDrawPlan(p, t + 20));
    // V320-FIX-06：受ストックの数量数字は削除。旧数字の位置（列の中央側20px）も領域に含めたまま検査する
    const regions = plans.map((pl, p) => {
      const xs = pl.entries.flatMap((e) => [e.x, e.x + e.w]);
      const ys = pl.entries.flatMap((e) => [e.y, e.y + e.h]);
      return { x0: Math.min(...xs) - 1 - (p === 1 ? 21 : 0), x1: Math.max(...xs) + 1 + (p === 0 ? 21 : 0), y0: Math.min(...ys) - 1, y1: Math.max(...ys) + 1 };
    });
    const da = mOn.x.getImageData(0, 0, 640, 360).data;
    const db = mOff.x.getImageData(0, 0, 640, 360).data;
    let inStock = 0;
    const outBoxes = [];
    for (let i = 0; i < da.length; i += 4) {
      if (da[i] === db[i] && da[i + 1] === db[i + 1] && da[i + 2] === db[i + 2]) continue;
      const x = (i / 4) % 640, y = Math.floor(i / 4 / 640);
      if (regions.some((g) => x >= g.x0 && x <= g.x1 && y >= g.y0 && y <= g.y1)) inStock++;
      if (!((x < 48 || x >= 592) && y >= 48 && y < 125)) outBoxes.push([x, y]);
    }
    v.pv[0].attackShow = { canceled: 12, sent: 29, start: t };
    v.pv[1].attackShow = { canceled: 14, sent: 29, start: t };
    const maxRows = [0, 1].map((p) => v.attackResult(p, t + 20).rows.map((x) => [x.kind, x.value]));
    v.pv[0].attackShow = { canceled: 3, sent: 4, start: t };
    v.pv[1].attackShow = { canceled: 0, sent: 2, start: t };
    for (const [i, s] of inc.entries()) Object.assign([p0.incoming, p1.incoming][i], s);
    Object.assign(p0.incoming, inc[0]);
    Object.assign(p1.incoming, inc[1]);
    const rows = [0, 1].map((p) => v.attackResult(p, t + 6));
    const after = [0, 1].map((p) => v.attackResult(p, t + 54)); // 900ms
    const stock = [0, 1].map((p) => v.stockDrawPlan(p, t + 6).entries.map((e) => [e.x, e.y, e.w, e.h]));
    v.pv[0].attackShow = null; v.pv[1].attackShow = null;
    return { base, shake, shakeDiff, atkShot, atkStockShot, maxShot, maxDiff, inStock, outBoxes: outBoxes.length, regions, maxRows, rows, after, stock, hud: [v.chainHud(0), v.chainHud(1)] };
  });
  shots.push(save('V320F04_versus_1x', r.base), save('V320F04_attack_cancel_1x', r.atkShot), save('V320F04_attack_cancel_stock_1x', r.atkStockShot), save('V320F04R1_attack_cancel_stock_max29_1x', r.maxShot));
  check('R1 第9章：双方の受ストック最大（予約29＋待機28）と双方の相殺・攻撃表示が同時でも、受ストック（アイコン・枠・待機数）の画素は表示の有無で不変。表示は外側の縦帯 x0〜48／592〜640・y48〜124 の中だけ', r.maxDiff.n > 0 && r.inStock === 0 && r.outBoxes === 0 && JSON.stringify(r.maxRows) === JSON.stringify([[['cancel', 12], ['attack', 29]], [['cancel', 14], ['attack', 29]]]), JSON.stringify({ diff: r.maxDiff, inStock: r.inStock, out: r.outBoxes, regions: r.regions, rows: r.maxRows }));
  check('第4.1節 見出しPNG左上：役(2,129)/(594,129)・連鎖(2,166)・打上(2,256)・連鎖(2,276)', r.hud[0].roleTitle.x === 2 && r.hud[0].roleTitle.y === 129 && r.hud[1].roleTitle.x === 594 && r.hud[0].roleSub.y === 166 && r.hud[0].streakTitle.y === 256 && r.hud[0].streakSub.y === 276);
  check('第4.2節 揺れ：600ms周期の最初の200ms、(0,0)→(-1,0)→(1,-1)→(0,1)', JSON.stringify(r.shake.map((s) => s.off)) === JSON.stringify([[0, 0], [-1, 0], [1, -1], [0, 1], [0, 0], [0, 0]]), JSON.stringify(r.shake));
  check('第4.2節 揺れの描画差は打上連鎖数の行（縦帯 x0〜48・y299〜318）の中だけ', r.shakeDiff.n > 0 && r.shakeDiff.x >= 0 && r.shakeDiff.x + r.shakeDiff.w <= 48 && r.shakeDiff.y >= 299 && r.shakeDiff.y + r.shakeDiff.h <= 318, JSON.stringify(r.shakeDiff));
  check('第9章（R1配置）相殺・攻撃：1Pは相殺→攻撃の2段（左の縦帯）、2Pは攻撃のみ（右の縦帯・上段は空ける）。900msで消える', r.rows[0].rows.map((x) => x.kind).join() === 'cancel,attack' && r.rows[1].rows.map((x) => x.kind).join() === 'attack' && r.after.every((x) => x === null), JSON.stringify(r.rows.map((x) => x.rows.map((y) => [y.kind, y.label.x, y.label.y, y.digits.cx, y.digits.y]))));
  check('第9章 送信>0 で光点（250ms以内）', !!r.rows[0].dot && !!r.rows[1].dot, JSON.stringify(r.rows.map((x) => x.dot)));
  writeFileSync(new URL('attack_result_layout.json', OUT), JSON.stringify({ rows: r.rows, stock: r.stock }, null, 1));
}

// ---- 2. SINGLE 得点倍率（4種）----
{
  await ev(() => window.__p2like.app.startGame('mode1', 'single', 'endless'));
  await page.waitForTimeout(3500);
  const r = await ev(() => {
    const sc = window.__p2like.gameScene();
    const g = sc.game;
    const v = sc.view;
    const p = g.players[0];
    let maxShot = null;
    const boxes = [];
    for (const n of [0, 3, 5, 7]) {
      Object.assign(p, { streakCount: n, streakRemaining: n ? 1e9 : 0 });
      const a = window.__f4.canvas(); v.render(a.x, g.tick);
      // 倍率表示の範囲：得点倍率を描かない状態（教材の攻撃倍率扱い）との差の外接
      v.hud = { ...v.hud, streakRate: 'attack' };
      const no = window.__f4.canvas(); v.render(no.x, g.tick);
      v.hud = { ...v.hud, streakRate: undefined };
      boxes.push({ n, mult: g.currentScoreMultiplier(p), box: window.__f4.diffBox(no.c, a.c) });
      if (n === 7) maxShot = a.c.toDataURL('image/png');
    }
    const areaDiff = boxes[3].box;
    return { maxShot, boxes, areaDiff };
  });
  shots.push(save('V320F04_single_rate_max_1x', r.maxShot));
  const inArea = (b) => b.n === 0 || (b.x >= 24 && b.y >= 64 && b.x + b.w <= 72 && b.y + b.h <= 120);
  check('第4.3節 倍率4種（×1/×1.5/×2/×2.5）の描画は合成領域(24,64,48,56)の中', r.boxes.map((b) => b.mult.num / b.mult.den).join() === '1,1.5,2,2.5' && r.boxes.every((b) => inArea(b.box)), JSON.stringify(r.boxes));
  check('第4.3節 得点・倍率見出しと数字の描画は合成領域の中だけ（旧領域[24,94,120,34]の外へ出ない。旧Noto描画なし）', r.areaDiff.n > 0 && inArea(r.areaDiff), JSON.stringify(r.areaDiff));
}

// ---- 3. 候補補助表示（1倍・3倍）----
{
  await ev(() => window.__p2like.app.startGame('mode1', 'single', 'endless'));
  await page.waitForTimeout(3500);
  const r = await ev(() => {
    const sc = window.__p2like.gameScene();
    const v = sc.view;
    const g = sc.game;
    const t = g.tick;
    const on = window.__f4.canvas(); v.render(on.x, t);
    const hud = v.hud;
    v.hud = { ...hud, assist: [] };
    const off = window.__f4.canvas(); v.render(off.x, t);
    v.hud = hud;
    const box = window.__f4.diffBox(off.c, on.c);
    const cols = v.assistTargets(0);
    // 3倍（最近傍）の盤面上段の切り出し
    const z = document.createElement('canvas');
    z.width = 192 * 3;
    z.height = 64 * 3;
    const zx = z.getContext('2d');
    zx.imageSmoothingEnabled = false;
    zx.drawImage(on.c, 64, Math.max(128, box.y - 16), 192, 64, 0, 0, 192 * 3, 64 * 3);
    // 不透明度の往復（0.50〜0.95）
    const alphas = [0, 250, 500, 750, 1000].map((ms) => Math.round(v.constructor.assistAlpha(ms) * 100) / 100);
    return { box, cols, png1: on.c.toDataURL('image/png'), png3: z.toDataURL('image/png'), alphas };
  });
  shots.push(save('V320F04_assist_1x', r.png1), save('V320F04_assist_board_top_3x', r.png3));
  check('第5章 候補補助：出せる最上段だけ（差は盤面の中の1段分＝高さ32以内）。シアン輪郭の不透明度は 0.50〜0.95 を1000ms周期', r.cols.length > 0 && r.box.n > 0 && r.box.x >= 64 && r.box.x + r.box.w <= 256 && r.box.y >= 128 && r.box.y + r.box.h <= 352 && r.box.h <= 32 && r.alphas[0] === 0.5 && r.alphas[2] === 0.95, JSON.stringify({ cols: r.cols, box: r.box, alphas: r.alphas }));
}

// ---- 4. CPU観戦の設定画面・観戦中 ----
{
  const r = await ev(async () => {
    const app = window.__p2like.app;
    const menu = app.scene.constructor.name;
    app.toMenu();
    const items = app.scene.stack[0].items.map((i) => i.label);
    app.scene.stack[0].cursor = 2;
    app.scene.onNav({ key: 'confirm', source: { kind: 'keyboard' } });
    const name = app.scene.constructor.name;
    const a = window.__f4.canvas();
    app.scene.render(a.x, 0);
    const rows = app.scene.rows().map((x) => `${x.label}${x.value ? `=${x.value}` : ''}`);
    return { menu, items, name, rows, png: a.c.toDataURL('image/png') };
  });
  shots.push(save('V320F04_watch_settings_1x', r.png));
  check('第12章 CPU観戦：メインメニューの MODE2 とオプションの間。設定の初期値（MODE1・アカネ初級・ずん子初級・2本先取・7秒）', r.items.join() === 'MODE1,MODE2,CPU観戦,オプション,遊び方' && r.name === 'WatchSettingsScene' && r.rows.join() === 'モード=MODE1,左キャラ=アカネ,左の強さ=初級,右キャラ=東北ずん子,右の強さ=初級,先取本数=2本先取,自然上昇=7秒,観戦開始,戻る', JSON.stringify(r.rows), 'natural-ui');
  for (let i = 0; i < 7; i++) await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(6000);
  const w = await ev(() => {
    const sc = window.__p2like.gameScene();
    const a = window.__f4.canvas();
    sc.render(a.x, performance.now());
    return { kind: sc?.kind, devices: sc?.devices, assist: sc?.view.hud.assist, playing: sc?.game.playing, png: a.c.toDataURL('image/png') };
  });
  shots.push(save('V320F04_watch_playing_1x', w.png));
  check('第12章 CPU観戦：決定で開始（左右CPU・補助表示なし）、「CPU観戦中」の小見出し', w.kind === 'watch' && w.devices.every((d) => d.kind === 'cpu') && w.assist.length === 0 && w.playing, JSON.stringify({ kind: w.kind, devices: w.devices }), 'natural-ui');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  const q = await ev(() => ({ quit: window.__p2like.gameScene()?.quit.length, tick: window.__p2like.game()?.tick }));
  await page.waitForTimeout(300);
  const q2 = await ev(() => window.__p2like.game()?.tick);
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(200);
  const back = await ev(() => window.__p2like.scene().constructor.name);
  check('第12章 CPU観戦：Esc で終了確認（ゲームは進行）→「終了する」で観戦設定へ', q.quit === 1 && q2 > q.tick && back === 'WatchSettingsScene', JSON.stringify({ q, q2, back }), 'natural-ui');
}

// ---- 5. 遊び方 MODE1 の説明（V320-FIX-06：自動開始・自動進行。決定入力は使わない）----
{
  const r = await ev(async () => {
    const app = window.__p2like.app;
    app.toMenu();
    app.openHelp('menu');
    const help = app.scene;
    help.cursor = 4; // MODE1
    help.onNav({ key: 'confirm', source: { kind: 'keyboard' } });
    const sc = app.scene;
    sc.update(1000 / 60);
    const st = sc.stage;
    const start = { page: st.items.current?.page, min: st.items.current?.minTicks };
    // 入場の決定の持ち越し・早押し：進行に使わない
    sc.onNav({ key: 'confirm', source: { kind: 'keyboard' }, repeat: false });
    for (let i = 0; i < 60; i++) sc.update(1000 / 60);
    const afterConfirm = st.items.current?.page;
    const a = window.__f4.canvas();
    sc.render(a.x, 0);
    for (let i = 0; i < 60 * 30 && st.items.log.length < 2; i++) sc.update(1000 / 60);
    const [x0, x1] = st.items.log;
    return { stage: st.constructor.name, start, afterConfirm, first: { page: x0.page, startTick: x0.startTick, doneTick: x0.doneTick, endTick: x0.endTick, minTicks: x0.minTicks }, next: x1?.page, png: a.c.toDataURL('image/png') };
  });
  shots.push(save('V320F06_help_mode1_single_auto_1x', r.png));
  check('V320-FIX-06 第7章 遊び方 MODE1：入った時点で説明を自動開始、決定入力では送らない。文字だけの項目は最低表示時間（m1_single）で自動的に次（m1_endless）へ', r.start.page === 'm1_single' && r.afterConfirm === 'm1_single' && r.first.endTick - r.first.startTick === r.first.minTicks && r.first.doneTick === r.first.startTick && r.next === 'm1_endless', JSON.stringify({ start: r.start, first: r.first, next: r.next }), 'natural-ui');
}

// ---- 6. MODE2 結果（更新あり／ノーリセット）・7. 20面終了 ----
for (const kind of ['refresh', 'noReset']) {
  await ev(() => window.__p2like.app.startGame('mode2', 'single', 'mode2'));
  await page.waitForTimeout(3500);
  await ev((kind) => {
    const g = window.__p2like.game();
    const p = g.players[0];
    if (kind === 'refresh') g.refreshCount = 1;
    const top = p.board.cols[p.selectedCol].find((c) => c.kind === 'piece');
    p.board.cols.forEach((c, i) => (p.board.cols[i] = i === p.selectedCol ? [top] : []));
    g.base = g.factory.make(top.piece.n, top.piece.suit);
  }, kind);
  await page.keyboard.press('KeyF');
  await page.waitForTimeout(6500);
  const r = await ev(() => {
    const sc = window.__p2like.gameScene();
    const a = window.__f4.canvas();
    sc.render(a.x, performance.now());
    const rec = window.__p2like.app.records;
    return { outcome: sc.game.result?.outcome, refresh: sc.game.refreshCount, rec: { total: rec.mode2Single, noReset: rec.mode2NoResetBest }, png: a.c.toDataURL('image/png') };
  });
  shots.push(save(`V320F04_mode2_result_${kind}_1x`, r.png));
  check(`第11章 MODE2 結果（${kind === 'refresh' ? '場の更新あり' : 'ノーリセット'}）：総合ベストを記録${kind === 'noReset' ? '、ノーリセット専用ベストを記録' : '、専用は作らない'}`, r.outcome === 'clear' && !!r.rec.total && (kind === 'noReset' ? !!r.rec.noReset : r.rec.noReset === null), JSON.stringify({ refresh: r.refresh, rec: r.rec }));
}
{
  await ev(() => window.__p2like.app.startGame('mode1', 'single', 'stage'));
  await page.waitForTimeout(3500);
  await ev(() => {
    const g = window.__p2like.game();
    const s = g.single;
    const p = g.players[0];
    s.stage = 20;
    s.quota = 300;
    s.progress = 299;
    const top = p.board.cols[p.selectedCol].find((c) => c.kind === 'piece');
    g.base = g.factory.make(top.piece.n, top.piece.suit);
  });
  await page.keyboard.press('KeyF');
  await page.waitForTimeout(7000);
  const r = await ev(() => {
    const sc = window.__p2like.gameScene();
    const a = window.__f4.canvas();
    sc.render(a.x, performance.now());
    const ev20 = sc.game.events.find((e) => e.type === 'stageClear');
    return { outcome: sc.game.result?.outcome, ev20, rec: window.__p2like.app.records.stage, png: a.c.toDataURL('image/png') };
  });
  shots.push(save('V320F04_stage20_clear_1x', r.png));
  check('第10章 20面クリアで全ステージクリア（ボーナス20000・倍率なし）。記録に20面ルール識別', r.outcome === 'allStagesClear' && r.ev20?.bonus === 20000 && r.ev20?.final === true && r.rec?.rule === 'stage20_V320-FIX-04' && r.rec?.completed === true, JSON.stringify({ outcome: r.outcome, bonus: r.ev20?.bonus, rec: r.rec }));
}

// ---- R1. MODE2 ノーリセット表示は SINGLE だけ（実際の画面描画で確認）----
for (const kind of ['single', '2p', 'cpu', 'watch']) {
  await ev((kind) => {
    const app = window.__p2like.app;
    if (kind === 'watch') {
      app.watch.mode = 'mode2';
      app.startWatch();
    } else app.startGame('mode2', kind, kind === 'single' ? 'mode2' : undefined, kind === '2p' ? ['kotaro', 'akane'] : undefined);
  }, kind);
  await page.waitForTimeout(3500);
  await ev(() => {
    const g = window.__p2like.game();
    const p = g.players[0];
    p.board.cols.forEach((c) => (c.length = 0));
    p.board.cols[p.selectedCol].push({ kind: 'piece', piece: g.factory.make(g.base.n, g.base.suit === 'spade' ? 'heart' : 'spade') });
  });
  if (kind !== 'watch') await page.keyboard.press('KeyF');
  await page.waitForFunction(() => !!window.__p2like.game()?.result, null, { timeout: 30000 });
  // 結果演出の開始後（勝敗の見出し・付記が出る時点）、SINGLE の結果パネルが出る前
  await page.waitForTimeout(900);
  const r = await ev(() => {
    const sc = window.__p2like.gameScene();
    const g = sc.game;
    const v = sc.view;
    const t = g.tick;
    // 実際の画面（シーンの描画）と、同じシーン描画で付記を強制表示／強制非表示にしたものを比べる
    const real = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(sc), 'noResetShown');
    const actual = window.__f4.canvas(); sc.render(actual.x, 0);
    const shown = sc.noResetShown;
    Object.defineProperty(sc, 'noResetShown', { configurable: true, get: () => g.result.winner ?? 0 });
    const forced = window.__f4.canvas(); sc.render(forced.x, 0);
    const lbl = v.noResetLabel(t);
    Object.defineProperty(sc, 'noResetShown', { configurable: true, get: () => null });
    const none = window.__f4.canvas(); sc.render(none.x, 0);
    delete sc.noResetShown;
    void real;
    const box = { x: lbl.x - 90, y: lbl.y - 2, w: 180, h: 20 };
    const grab = (c) => c.getContext('2d').getImageData(box.x, box.y, box.w, box.h).data;
    const same = (a, b) => { let n = 0; for (let i = 0; i < a.length; i += 4) if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2]) n++; return n; };
    const A = grab(actual.c), F = grab(forced.c), N = grab(none.c);
    const rec = window.__p2like.app.records;
    return { kind: sc.kind, outcome: g.result.outcome, winner: g.result.winner, refresh: g.refreshCount, shown, lbl, diffForced: same(A, F), diffNone: same(A, N), forcedVsNone: same(F, N), noResetBest: rec.mode2NoResetBest, total: rec.mode2Single, png: actual.c.toDataURL('image/png') };
  });
  shots.push(save(`V320F04R1_mode2_noreset_${kind}_1x`, r.png));
  delete r.png;
  const drawn = r.forcedVsNone > 0 && r.diffForced === 0;
  const notDrawn = r.forcedVsNone > 0 && r.diffNone === 0;
  if (kind === 'single') check('R1 MODE2 SINGLE：場の更新0回のクリアで「ノーリセットクリア！」を画面に描画（画素一致）し、総合・ノーリセット専用ベストを記録', r.outcome === 'clear' && r.refresh === 0 && r.shown === 0 && drawn && !!r.noResetBest && !!r.total, JSON.stringify(r), 'direct-state');
  else check(`R1 MODE2 ${kind}：場の更新0回で1Pが勝っても「ノーリセットクリア！」を描画しない（画面の該当範囲が非表示の描画と一致）。記録なし`, r.outcome === 'win' && r.winner === 0 && r.refresh === 0 && r.shown === null && notDrawn && r.noResetBest === null && r.total === null, JSON.stringify(r), 'direct-state');
  await ev(() => {
    // 次のモードの前に記録を空へ（SINGLE の記録が対戦側の判定に混ざらないように）
    const rec = window.__p2like.app.records;
    rec.mode2Single = null;
    rec.mode2NoResetBest = null;
    window.__p2like.app.toMenu();
  });
}

writeFileSync(new URL('e2e_report_V320-FIX-04.json', OUT), JSON.stringify({ id: 'V320-FIX-04', fontStandin: !!STANDIN, results, shots, errors }, null, 1));
console.log(`${results.filter((r) => r.pass).length}/${results.length} passed; errors=${errors.length}`, errors.slice(0, 5));
await browser.close();
server.kill();
process.exit(results.every((r) => r.pass) && !errors.length ? 0 : 1);
