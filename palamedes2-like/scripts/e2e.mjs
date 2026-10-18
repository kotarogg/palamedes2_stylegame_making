// ブラウザ実機確認（ビルド済み dist を配信し、Chromiumで操作・画素照合・スクリーンショット・エラー収集）
// 使い方: npm run build && npm run e2e   （Chromiumが無い環境では npx playwright-core install chromium）
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright-core';

const PORT = Number(process.env.E2E_PORT ?? 8765);
const OUT = new URL('../test-results/e2e/', import.meta.url);
mkdirSync(OUT, { recursive: true });

// E2E_ROOT で配信ディレクトリを変更可能（展開した配布ZIPの検証用）
const server = spawn(process.execPath, ['scripts/serve.mjs', process.env.E2E_ROOT ?? 'dist', String(PORT)], { stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((ok, ng) => {
  server.stdout.on('data', (d) => String(d).includes('配信中') && ok());
  server.on('exit', (c) => ng(new Error(`server exited ${c}`)));
});

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass: !!pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const consoleErrors = [];
const failedRequests = [];
const responses = [];
page.on('console', (m) => (m.type() === 'error' || m.type() === 'warning') && consoleErrors.push(`${m.type()}: ${m.text()}`));
page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));
page.on('requestfailed', (r) => failedRequests.push(`${r.url()} ${r.failure()?.errorText}`));
page.on('response', (r) => responses.push([r.status(), new URL(r.url()).pathname]));

let shotNo = 0;
const shot = async (name) => {
  const file = `${String(++shotNo).padStart(2, '0')}_${name}.png`;
  await page.locator('#screen').screenshot({ path: new URL(file, OUT).pathname });
  return file;
};
const wait = (ms) => page.waitForTimeout(ms);
const ev = (fn, arg) => page.evaluate(fn, arg);

// 画素照合：スプライトの不透明画素がキャンバス上の指定座標と一致するか
const pixelHelper = `
  // 検証側の読取りは別キャンバスへ複製して行う（ゲーム側キャンバスへ readback 負荷を掛けない）
  window.__cmp = (sheet, id, x, y, alphaMin = 255, tol = 2) => {
    const { app } = window.__p2like;
    const f = app.assets.atlas.frame(sheet, id);
    const c = document.createElement('canvas'); c.width = f.w; c.height = f.h;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(app.assets.images.get(f.sheet), f.x, f.y, f.w, f.h, 0, 0, f.w, f.h);
    const s = g.getImageData(0, 0, f.w, f.h).data;
    const screen = document.createElement('canvas'); screen.width = f.w; screen.height = f.h;
    const sg = screen.getContext('2d', { willReadFrequently: true });
    sg.drawImage(document.getElementById('screen'), Math.round(x), Math.round(y), f.w, f.h, 0, 0, f.w, f.h);
    const d = sg.getImageData(0, 0, f.w, f.h).data;
    let opaque = 0, bad = 0;
    for (let i = 0; i < s.length; i += 4) {
      if (s[i + 3] < alphaMin) continue;
      opaque++;
      if (Math.abs(s[i] - d[i]) > tol || Math.abs(s[i + 1] - d[i + 1]) > tol || Math.abs(s[i + 2] - d[i + 2]) > tol) bad++;
    }
    return { opaque, bad };
  };`;

try {
  await page.goto(`http://127.0.0.1:${PORT}/?seed=20261018`);
  await page.waitForSelector('body[data-ready]');
  check('起動（素材・JSON読込）', (await ev(() => document.body.dataset.ready)) === '1');
  await page.addScriptTag({ content: pixelHelper });

  const pngs = responses.filter(([s, p]) => p.endsWith('.png') && s === 200).length;
  const jsons = responses.filter(([s, p]) => p.endsWith('.json') && s === 200).length;
  check('仮PNG7枚・JSON2件をHTTP 200で取得', pngs === 7 && jsons === 2, `png=${pngs} json=${jsons}`);
  const size = await ev(() => [document.getElementById('screen').style.width, document.getElementById('screen').width]);
  check('論理640×360を整数倍(2倍)で表示', size[0] === '1280px' && size[1] === 640, size.join(' / '));
  const rendering = await ev(() => getComputedStyle(document.getElementById('screen')).imageRendering);
  check('拡大時にドットを滲ませない(image-rendering)', rendering === 'pixelated', rendering);

  await shot('ready');
  const ready = await ev(() => window.__cmp('S5', 'banner_ready', 272, 144));
  check('READYバナー座標(272,144)', ready.bad === 0 && ready.opaque > 0, JSON.stringify(ready));

  await page.waitForFunction(() => window.__p2like.app.game.playing);
  await wait(800);
  await ev(() => (window.__p2like.app.paused = true));
  await wait(50);
  await shot('play_initial');
  const base = await ev(() => {
    const b = window.__p2like.app.game.base;
    return window.__cmp('S4', `piece_${b.n}_${b.suit}`, 302, 48);
  });
  check('共通基準ピース座標(302,48)', base.bad === 0 && base.opaque > 0, JSON.stringify(base));
  const frameChk = await ev(() => window.__cmp('S5', 'base_piece_frame', 294, 40));
  check('基準枠座標(294,40)（基準ピースに覆われない画素で照合）', frameChk.opaque > 0 && frameChk.bad < frameChk.opaque, JSON.stringify(frameChk));
  const boardPieces = await ev(() => {
    const { app } = window.__p2like;
    const out = [];
    for (const p of [0, 1]) {
      const st = app.game.players[p];
      const bx = p === 0 ? 64 : 384;
      const bar = app.view.barVisual(p, app.driver.time);
      st.board.cols.forEach((col, c) =>
        col.forEach((s, i) => s.kind === 'piece' && out.push(window.__cmp('S4', `piece_${s.piece.n}_${s.piece.suit}`, bx + 32 * c, bar + 32 * i))),
      );
    }
    return { cells: out.length, bad: out.reduce((a, r) => a + r.bad, 0), bar0: app.view.barVisual(0, app.driver.time) };
  });
  check('初期盤面36個（各18個・下側3段）の描画座標', boardPieces.cells === 36 && boardPieces.bad < 40 && boardPieces.bar0 === 256, JSON.stringify(boardPieces));
  const chara = await ev(() => {
    const { app } = window.__p2like;
    const t = app.driver.time;
    return [0, 1].map((p) => {
      const f = app.view.characterFrame(p, t);
      const x = app.view.characterX(p, t);
      const y = app.view.barVisual(p, t);
      return { x, y, id: f.id, ...window.__cmp(f.sheet, f.id, x - 24, y - 56, 250, 8) };
    });
  });
  check(
    'キャラ足元＝列中心X・最長列上端Y（1P x=144, 2P x=464, y=256。仮素材はα251〜253主体のためα≥250で照合）',
    chara[0].x === 144 && chara[1].x === 464 && chara.every((c) => c.y === 256 && c.opaque > 300 && c.bad === 0),
    JSON.stringify(chara),
  );
  await ev(() => (window.__p2like.app.paused = false));

  // ---- 打ち上げ（両者）----
  await page.keyboard.press('KeyW');
  await page.keyboard.press('ArrowUp');
  await wait(180);
  const fl = await ev(() => window.__p2like.app.view.activeFlights().length);
  check('1P/2P別系統入力で同時に打ち上げ', fl === 2, `flights=${fl}`);
  await shot('launch_midflight');
  await wait(450);
  await shot('after_arrival');
  const arrivals = await ev(() => window.__p2like.app.game.events.filter((e) => e.type === 'arrive').map((e) => [e.player, e.success, e.tick]));
  check('到達イベントがロジック側で処理される', arrivals.length === 2, JSON.stringify(arrivals));
  await page.waitForFunction(() => window.__p2like.app.game.flights.length === 0, null, { timeout: 5000 });

  // ---- 失敗帰還中に手動上昇（予約追従・固定時間）----
  const plan = await ev(() => {
    const { app } = window.__p2like;
    const g = app.game;
    const p = g.players[0];
    const top = p.board.cols[p.selectedCol][0].piece;
    // 確実に失敗させるため基準を不一致の種類へ差し替え（検証用操作）
    const n = ((top.n + 2) % 6) + 1;
    const suit = top.suit === 'spade' ? 'heart' : 'spade';
    g.base = g.factory.make(n, suit);
    return { top: `${top.n}${top.suit}`, base: `${n}${suit}` };
  });
  await page.keyboard.press('KeyW');
  const t0 = await ev(() => window.__p2like.app.game.tick);
  await page.waitForFunction(() => window.__p2like.app.view.activeFlights().some((f) => f.failed));
  const f = await ev(() => {
    const fl = window.__p2like.app.view.activeFlights().find((x) => x.failed);
    return { arcStart: fl.arcStart, arcEnd: fl.arcEnd, returnEnd: fl.returnEnd, launchTick: fl.launchTick };
  });
  await page.waitForFunction((tk) => window.__p2like.app.game.tick >= tk, f.arcStart + 6);
  await shot('fail_arc');
  await page.waitForFunction((tk) => window.__p2like.app.game.tick >= tk, f.arcEnd + 4);
  await page.keyboard.press('KeyE');
  await wait(90);
  await shot('fail_descent_during_rise');
  await page.waitForFunction((tk) => window.__p2like.app.game.tick >= tk, f.returnEnd);
  const ret = await ev(() => window.__p2like.app.game.events.filter((e) => e.type === 'returned').map((e) => e.tick));
  check('失敗帰還：手動上昇が重なっても帰還完了tickは固定', ret.includes(f.returnEnd) && f.launchTick >= t0, `${JSON.stringify(plan)} returnEnd=${f.returnEnd} returned=${JSON.stringify(ret)}`);
  await wait(60);
  await shot('returned');

  // ---- B入替（暗色・背面・キャラ一瞬ポーズ）----
  await wait(300);
  await page.keyboard.press('KeyS');
  await wait(60);
  const rot = await ev(() => {
    const { app } = window.__p2like;
    const r = app.game.events.filter((e) => e.type === 'rotate').at(-1);
    const t = app.driver.time;
    return { rotated: !!r, pose: app.view.characterFrame(0, t).id, x: app.view.characterX(0, t) };
  });
  check('B入替：キャラは攻撃枠1枚の一瞬ポーズ・座標不変', rot.rotated && rot.pose.startsWith('attack_') && rot.x === 144, JSON.stringify(rot));
  await shot('rotate_dark_behind');

  // ---- 攻撃ストック表示・波 ----
  await page.keyboard.press('Digit2');
  await page.keyboard.press('Digit1');
  await page.keyboard.press('Digit9');
  await page.keyboard.press('Digit9');
  await page.keyboard.press('Digit9');
  await page.keyboard.press('Digit0');
  await wait(80);
  const atk = await ev(() => window.__p2like.app.game.players.map((p) => p.attackStock));
  check('攻撃注入と29飽和', atk[0] === 11 && atk[1] === 29, JSON.stringify(atk));
  const icons = await ev(() => ({
    p1big: window.__cmp('S5', 'attack_icon_big', 256, 128),
    p1small: window.__cmp('S5', 'attack_icon_small', 256, 160),
    p2big2: window.__cmp('S5', 'attack_icon_big', 352, 160),
    p2small9: window.__cmp('S5', 'attack_icon_small', 368, 240),
  }));
  check('攻撃アイコン座標（1P起点256,128／2P 29本＝大2＋小9、右列4個目 y=240）', Object.values(icons).every((r) => r.bad === 0 && r.opaque > 0), JSON.stringify(icons));
  await shot('attack_icons_11_29');
  await page.waitForFunction(() => window.__p2like.app.game.events.some((e) => e.type === 'rise' && e.kind === 'attack'), null, { timeout: 6000 });
  await wait(50);
  await shot('attack_wave_snap');
  const waves = await ev(() => window.__p2like.app.game.events.filter((e) => e.type === 'rise' && e.kind === 'attack').map((e) => [e.player, e.rows, e.heightAfter]));
  check('攻撃波：1波最大3ライン・攻撃による盤面は6段まで', waves.every(([, r, h]) => r <= 3 && h <= 6), JSON.stringify(waves));

  // ---- 役宣言（2P）：役名ロゴ・発光・宣言者のみロック ----
  await ev(() => {
    const g = window.__p2like.app.game;
    g.players[1].roleStock = [1, 2, 3, 4].map((n) => g.factory.make(n, 'heart'));
  });
  await page.keyboard.press('Slash');
  await wait(40);
  const decl = await ev(() => window.__p2like.app.game.events.filter((e) => e.type === 'declare').map((e) => ({ p: e.player, han: e.result.han, logos: e.logos })));
  check('役宣言：ストレートフラッシュ4翻・R14表示', decl.length === 1 && decl[0].han === 4 && decl[0].logos[0] === 13, JSON.stringify(decl));
  const logo = await ev(() => ['A', 'B', 'C'].map((l) => window.__cmp('S7', `role_13_${l}`, 360, 34)));
  check('役名ロゴ座標(360,34)：A/B/Cのいずれかと一致', logo.some((r) => r.bad === 0 && r.opaque > 0), JSON.stringify(logo));
  await shot('declare_role_name');
  const lockTest = await ev(() => [window.__p2like.app.game.players[0].selectedCol, window.__p2like.app.game.players[1].selectedCol]);
  await page.keyboard.press('KeyA');
  await page.keyboard.press('ArrowLeft');
  await wait(60);
  const after = await ev(() => [window.__p2like.app.game.players[0].selectedCol, window.__p2like.app.game.players[1].selectedCol]);
  check('宣言者(2P)だけ操作ロック、相手(1P)は継続', after[0] === lockTest[0] - 1 && after[1] === lockTest[1], `${JSON.stringify(lockTest)} -> ${JSON.stringify(after)}`);
  await wait(150);
  const letters = [];
  for (let i = 0; i < 6; i++) {
    const r = await ev(() => ['A', 'B', 'C'].findIndex((l) => window.__cmp('S7', `role_13_${l}`, 360, 34).bad === 0));
    letters.push(r);
    await wait(45);
  }
  check('役名の色替えA/B/C（FRAME）が切り替わる', new Set(letters.filter((x) => x >= 0)).size >= 2, JSON.stringify(letters));
  await shot('declare_color_cycle');

  // ---- 手動上昇TWEEN ----
  await wait(2200);
  await page.keyboard.press('Period');
  await wait(100);
  await shot('manual_rise_tween');

  // ---- 操作説明・素材確認画面 ----
  await page.keyboard.press('F1');
  await wait(60);
  await shot('help');
  await page.keyboard.press('F1');
  await page.keyboard.press('KeyV');
  for (let i = 0; i < 6; i++) {
    await wait(250);
    await shot(`viewer_page${i + 1}`);
    await page.keyboard.press('ArrowRight');
  }
  await page.keyboard.press('KeyV');
  await wait(100);

  // ---- 再開始 ----
  await page.keyboard.press('KeyR');
  await wait(100);
  const restarted = await ev(() => window.__p2like.app.game.tick < 30 && window.__p2like.app.game.events.length === 0);
  check('Rキーで最初から', restarted);
  const fps = await ev(() => window.__p2like.app.fps);
  check('描画ループ稼働', fps > 20, `fps≒${fps.toFixed(1)}`);
} catch (e) {
  check('E2E実行', false, String(e?.stack ?? e));
} finally {
  check('コンソールエラー/警告なし', consoleErrors.length === 0, consoleErrors.join(' | '));
  check('ネットワーク失敗・4xx/5xxなし', failedRequests.length === 0 && responses.every(([s]) => s < 400), [...failedRequests, ...responses.filter(([s]) => s >= 400).map((r) => r.join(' '))].join(' | '));
  writeFileSync(new URL('report.json', OUT), JSON.stringify({ date: new Date().toISOString(), results, responses }, null, 2));
  await browser.close();
  server.kill();
}
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} PASS`);
process.exit(failed.length ? 1 : 0);
