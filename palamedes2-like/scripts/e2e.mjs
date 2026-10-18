// ブラウザ実機確認（ビルド済み dist を配信し、Chromiumで操作・画素照合・スクリーンショット・エラー収集）
// 使い方: npm run build && npm run e2e   （Chromiumが無い環境では npx playwright-core install chromium）
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright-core';

const PORT = Number(process.env.E2E_PORT ?? 8765);
const OUT = new URL('../test-results/e2e/', import.meta.url);
rmSync(OUT, { recursive: true, force: true }); // 前回の画像を残さない
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
  };
  // 半透明の前面光：不透明度192以上の画素位置で、キャンバス側が水色寄り（B・GがRより明るい）か
  window.__cyan = (sheet, id, x, y) => {
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
    let n = 0, cyan = 0;
    for (let i = 0; i < s.length; i += 4) {
      if (s[i + 3] < 192) continue;
      n++;
      if (d[i + 2] > d[i] + 30 && d[i + 1] > d[i] + 30) cyan++;
    }
    return { n, cyan };
  };`;

try {
  await page.goto(`http://127.0.0.1:${PORT}/?seed=20261018`);
  await page.waitForSelector('body[data-ready]');
  check('起動（素材・JSON読込）', (await ev(() => document.body.dataset.ready)) === '1');
  await page.addScriptTag({ content: pixelHelper });
  // 検証用の短縮：ゲーム状態を読む窓口
  await page.addScriptTag({
    content: `window.G = () => window.__p2like.app.match.game; window.T = () => window.G().tick + window.__p2like.app.driver.alpha;`,
  });

  const pngs = responses.filter(([s, p]) => p.endsWith('.png') && s === 200).map(([, p]) => p);
  const jsons = responses.filter(([s, p]) => p.endsWith('.json') && s === 200).map(([, p]) => p);
  check(
    '読み込み許可リストの7シートだけを取得（個別PNG・旧版は読まない）、JSON3件（マニフェストv2.1・画面・許可リスト）',
    pngs.length === 7 && !pngs.some((p) => p.includes('role_glow_frames')) && jsons.length === 3 && jsons.some((p) => p.endsWith('asset_loading_policy.json')),
    `png=${pngs.length} json=${jsons.map((p) => p.split('/').pop()).join(',')}`,
  );
  const ver = await ev(() => window.__p2like.app.assets.atlas.manifest.version);
  check('マニフェスト内部version 2.1', ver === '2.1', ver);
  const size = await ev(() => [document.getElementById('screen').style.width, document.getElementById('screen').width]);
  check('論理640×360を整数倍(2倍)で表示', size[0] === '1280px' && size[1] === 640, size.join(' / '));
  const rendering = await ev(() => getComputedStyle(document.getElementById('screen')).imageRendering);
  check('拡大時にドットを滲ませない(image-rendering)', rendering === 'pixelated', rendering);

  await shot('ready');
  const ready = await ev(() => window.__cmp('S5', 'banner_ready', 272, 144));
  check('READYバナー座標(272,144)', ready.bad === 0 && ready.opaque > 0, JSON.stringify(ready));

  await page.waitForFunction(() => window.G().playing);
  await wait(800);
  await ev(() => (window.__p2like.app.paused = true));
  await wait(50);
  await shot('play_initial');
  const base = await ev(() => {
    const b = window.G().base;
    return window.__cmp('S4', `piece_${b.n}_${b.suit}`, 302, 48);
  });
  check('共通基準ピース座標(302,48)', base.bad === 0 && base.opaque > 0, JSON.stringify(base));
  const boardPieces = await ev(() => {
    const { app } = window.__p2like;
    const out = [];
    for (const p of [0, 1]) {
      const st = window.G().players[p];
      const bx = p === 0 ? 64 : 384;
      const bar = app.view.pieceBar(p, window.T());
      st.board.cols.forEach((col, c) =>
        col.forEach((s, i) => s.kind === 'piece' && out.push({ p, c, i, ...window.__cmp('S4', `piece_${s.piece.n}_${s.piece.suit}`, bx + 32 * c, bar + 32 * i) })),
      );
    }
    return { cells: out.length, bad: out.reduce((a, r) => a + r.bad, 0), badCells: out.filter((r) => r.bad > 0), bar0: app.view.barVisual(0, window.T()) };
  });
  check('初期盤面36個（各18個・下側3段）の描画座標', boardPieces.cells === 36 && boardPieces.bad < 40 && boardPieces.bar0 === 256, JSON.stringify(boardPieces));
  const chara = await ev(() => {
    const { app } = window.__p2like;
    const t = window.T();
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

  // ---- 打ち上げ（初期割当：1P=F、2P=カンマ）と発射中の操作硬直 ----
  const sel0 = await ev(() => window.G().players[0].selectedCol);
  await page.keyboard.press('KeyF');
  await page.keyboard.press('Comma');
  await wait(60);
  await page.keyboard.press('KeyA'); // 発射中：左右移動できない
  await wait(30);
  const fl = await ev(() => ({ n: window.__p2like.app.view.activeFlights().length, sel: window.G().players[0].selectedCol }));
  check('1P/2P別系統入力で同時に打ち上げ（初期割当 F / ,）・発射中は左右移動できない', fl.n === 2 && fl.sel === sel0, JSON.stringify(fl));
  await shot('launch_midflight');
  await page.waitForFunction(() => window.G().events.filter((e) => e.type === 'arrive').length === 2, null, { timeout: 3000 });
  await shot('after_arrival');
  await page.waitForFunction(() => window.G().flights.length === 0, null, { timeout: 5000 });

  // ---- 失敗帰還中に手動上昇（予約追従・固定時間）、帰還中の別列操作 ----
  await wait(300);
  await ev(() => {
    const g = window.G();
    const p = g.players[0];
    const top = p.board.cols[p.selectedCol][0].piece;
    const n = ((top.n + 2) % 6) + 1; // 確実に失敗させるため基準を不一致の種類へ差し替え（検証用操作）
    g.base = g.factory.make(n, top.suit === 'spade' ? 'heart' : 'spade');
  });
  await page.keyboard.press('KeyF');
  await page.waitForFunction(() => window.__p2like.app.view.activeFlights().some((f) => f.failed));
  const f = await ev(() => {
    const fl = window.__p2like.app.view.activeFlights().find((x) => x.failed);
    return { arcStart: fl.arcStart, arcEnd: fl.arcEnd, returnEnd: fl.returnEnd, col: fl.col };
  });
  await page.waitForFunction((tk) => window.G().tick >= tk, f.arcStart + 6);
  await shot('fail_arc');
  await page.keyboard.press('KeyD'); // 帰還中でも別列へ移動できる
  await page.waitForFunction((tk) => window.G().tick >= tk, f.arcEnd + 4);
  await page.keyboard.press('KeyW'); // 手動上昇（初期割当 W）
  await wait(90);
  await shot('fail_descent_during_rise');
  await page.waitForFunction((tk) => window.G().tick >= tk, f.returnEnd);
  const ret = await ev(() => ({
    returned: window.G().events.filter((e) => e.type === 'returned').map((e) => e.tick),
    moved: window.G().players[0].selectedCol,
    manual: window.G().events.some((e) => e.type === 'rise' && e.kind === 'manual'),
  }));
  check('失敗帰還：帰還中に別列へ移動でき、手動上昇が重なっても帰還完了tickは固定', ret.returned.includes(f.returnEnd) && ret.moved === f.col + 1 && ret.manual, `returnEnd=${f.returnEnd} ${JSON.stringify(ret)}`);
  await wait(60);
  await shot('returned');

  // ---- B入替（初期割当 G：暗色・背面・キャラ一瞬ポーズ）----
  await wait(300);
  await page.keyboard.press('KeyG');
  await wait(60);
  const rot = await ev(() => {
    const { app } = window.__p2like;
    const r = window.G().events.filter((e) => e.type === 'rotate').at(-1);
    const t = window.T();
    return { rotated: !!r, pose: app.view.characterFrame(0, t).id, x: app.view.characterX(0, t) };
  });
  check('B入替（G）：キャラは攻撃枠1枚の一瞬ポーズ・座標不変', rot.rotated && rot.pose.startsWith('attack_') && rot.x === 176, JSON.stringify(rot));
  await shot('rotate_dark_behind');

  // ---- 攻撃ストック表示・波 ----
  for (const k of ['Digit2', 'Digit1', 'Digit9', 'Digit9', 'Digit9', 'Digit0']) await page.keyboard.press(k);
  await wait(80);
  const atk = await ev(() => window.G().players.map((p) => p.attackStock));
  check('攻撃注入と29飽和', atk[0] === 11 && atk[1] === 29, JSON.stringify(atk));
  const icons = await ev(() => ({
    p1big: window.__cmp('S5', 'attack_icon_big', 256, 128),
    p1small: window.__cmp('S5', 'attack_icon_small', 256, 160),
    p2big2: window.__cmp('S5', 'attack_icon_big', 352, 160),
    p2small9: window.__cmp('S5', 'attack_icon_small', 368, 240),
  }));
  check('攻撃アイコン座標（1P起点256,128／2P 29本＝大2＋小9、右列4個目 y=240）', Object.values(icons).every((r) => r.bad === 0 && r.opaque > 0), JSON.stringify(icons));
  await shot('attack_icons_11_29');
  await page.waitForFunction(() => window.G().events.some((e) => e.type === 'rise' && e.kind === 'attack'), null, { timeout: 6000 });
  await wait(50);
  await shot('attack_wave_snap');
  const waves = await ev(() => window.G().events.filter((e) => e.type === 'rise' && e.kind === 'attack').map((e) => [e.player, e.rows, e.heightAfter, e.tick - window.G().events.find((x) => x.type === 'attackStock' && x.player === e.player).tick]));
  check('攻撃波：最初の受信から2秒後・1波最大3ライン・攻撃による盤面は6段まで', waves.every(([, r, h]) => r <= 3 && h <= 6) && waves.some(([, , , d]) => d === 120), JSON.stringify(waves));

  // ---- 役成立光（宣言前から発光・区間配置・共有時計）----
  await ev(() => {
    const g = window.G();
    const mk = (n, s) => g.factory.make(n, s);
    // 2P：1♥2♥ 6♦ 3♥4♥ → 採用位置0,1,3,4（2区間）
    g.players[1].roleStock = [mk(1, 'heart'), mk(2, 'heart'), mk(6, 'diamond'), mk(3, 'heart'), mk(4, 'heart')];
  });
  await wait(40);
  const glow = await ev(() => {
    const { app } = window.__p2like;
    const t = window.T();
    const ph = app.view.glowPhase(t);
    const pl = app.view.glowPlacements(1, app.view.glowTargets(1, t).indices, ph);
    // 前面光の画素がキャンバスに出ているか（前面光は最前面側。ピース・キャラに覆われない）
    return { ph, pl: pl.map((p) => [p.front.id, p.x, p.y]), px: pl.map((p) => window.__cyan('S6', p.front.id, p.x, p.y)) };
  });
  check(
    '役成立光：宣言前から発光。2区間（開始位置1と4に2枠用）・原点オフセット(0,4)で配置',
    glow.pl.length === 2 && glow.pl[0][1] === 386 && glow.pl[1][1] === 458 && glow.pl.every((p) => p[2] === 32 && p[0].startsWith('role_glow_2_front')) && glow.px.every((r) => r.n > 0 && r.cyan >= r.n * 0.9),
    JSON.stringify(glow),
  );
  const phases = [];
  for (let i = 0; i < 8; i++) {
    phases.push(await ev(() => [window.__p2like.app.view.glowClockMs(window.T()), window.__p2like.app.view.glowPhase(window.T())]));
    await wait(70);
  }
  check('役成立光：A/B各250msで切替（共有時計 phase=floor(ms/250)%2）', phases.every(([ms, ph]) => ph === (Math.floor(ms / 250) % 2 === 0 ? 'a' : 'b')) && new Set(phases.map((p) => p[1])).size === 2, JSON.stringify(phases.map((p) => p[1])));
  await shot('role_glow_before_declare');

  // ---- 役宣言（2P：/）：役名ロゴ・ライン消去・攻撃・宣言者のみロック ----
  const before = await ev(() => ({ h: window.G().players[1].board.height(), sel: window.G().players.map((p) => p.selectedCol) }));
  await page.keyboard.press('Slash');
  await wait(40);
  const decl = await ev(() => window.G().events.filter((e) => e.type === 'declare').map((e) => ({ p: e.player, han: e.result.han, logos: e.logos })));
  check('役宣言（/）：ストレートフラッシュ4翻・R14の専用ロゴのみ表示', decl.length === 1 && decl[0].han === 4 && decl[0].logos.length === 1 && decl[0].logos[0] === 13, JSON.stringify(decl));
  const logo = await ev(() => ['A', 'B', 'C'].map((l) => window.__cmp('S7', `role_13_${l}`, 360, 34)));
  check('役名ロゴ座標(360,34)：A/B/Cのいずれかと一致', logo.some((r) => r.bad === 0 && r.opaque > 0), JSON.stringify(logo));
  await shot('declare_role_name');
  await page.keyboard.press('KeyA');
  await page.keyboard.press('ArrowLeft');
  await wait(60);
  const after = await ev(() => window.G().players.map((p) => p.selectedCol));
  check('宣言者(2P)だけ操作不能、相手(1P)は継続', after[0] === before.sel[0] - 1 && after[1] === before.sel[1], `${JSON.stringify(before.sel)} -> ${JSON.stringify(after)}`);
  const letters = [];
  for (let i = 0; i < 6; i++) {
    letters.push(await ev(() => ['A', 'B', 'C'].findIndex((l) => window.__cmp('S7', `role_13_${l}`, 360, 34).bad === 0)));
    await wait(45);
  }
  check('役名の色替えA/B/C（FRAME）が切り替わる', new Set(letters.filter((x) => x >= 0)).size >= 2, JSON.stringify(letters));
  await page.waitForFunction(() => window.G().events.some((e) => e.type === 'lineClear'), null, { timeout: 3000 });
  await wait(60);
  await shot('line_clear');
  await page.waitForFunction(() => window.G().events.some((e) => e.type === 'roleEnd'), null, { timeout: 5000 });
  const role = await ev(() => {
    const g = window.G();
    const lc = g.events.filter((e) => e.type === 'lineClear');
    const a = g.events.find((e) => e.type === 'attack');
    return { lines: lc.length, heights: lc.map((e) => [e.heightBefore, e.heightAfter]), atk: a.breakdown, counter: a.counter, h: g.players[1].board.height(), stocks: g.players.map((p) => p.attackStock) };
  });
  check(
    '役処理：上側から1ラインずつ消去（予定4ライン・盤面が空なら打切り）→攻撃計算（基本3）→相殺→送信',
    role.lines >= 1 && role.lines <= 4 && role.heights.every(([b, a]) => a === b - 1) && role.atk.base === 3 && role.counter.usedPower + role.counter.sent === role.atk.power,
    JSON.stringify(role),
  );
  await shot('after_role');

  // ---- 不成立宣言（1P：H）----
  await ev(() => {
    const g = window.G();
    g.players[0].roleStock = [g.factory.make(1, 'spade'), g.factory.make(1, 'diamond'), g.factory.make(2, 'spade'), g.factory.make(4, 'diamond')];
  });
  await page.keyboard.press('KeyH');
  await wait(40);
  const fail = await ev(() => ({ f: window.G().events.filter((e) => e.type === 'declareFail').length, stock: window.G().players[0].roleStock.length, lock: window.G().players[0].lockUntil - window.G().tick }));
  check('不成立宣言：失敗処理・約0.5秒の硬直・役ストック維持', fail.f === 1 && fail.stock === 4 && fail.lock > 20 && fail.lock <= 30, JSON.stringify(fail));
  await shot('declare_fail');
  await wait(600);

  // ---- 手動上昇TWEEN（2P：↑）----
  await page.keyboard.press('ArrowUp');
  await wait(100);
  await shot('manual_rise_tween');

  // ---- 一時停止（Esc）----
  await page.keyboard.press('Escape');
  const tp = await ev(() => window.G().tick);
  await wait(200);
  const tp2 = await ev(() => window.G().tick);
  const pauseBanner = await ev(() => window.__cmp('S5', 'banner_pause', 272, 144));
  check('Escで一時停止（ロジック停止・PAUSE表示）', tp === tp2 && pauseBanner.bad === 0 && pauseBanner.opaque > 0, `${tp}->${tp2} ${JSON.stringify(pauseBanner)}`);
  await shot('pause');
  await page.keyboard.press('Escape');

  // ---- 危険状態→猶予→敗北→勝敗表示→決定→READY ----
  await ev(() => {
    const g = window.G();
    // 1Pを7段にして自然上昇時刻を早める（検証用操作）
    const p = g.players[0];
    while (p.board.height() < 7) p.board.appendRow(Array.from({ length: 6 }, () => g.factory.make(5, 'club')));
    p.riseCountdown = 5;
    g.players[1].riseCountdown = 100000;
  });
  await page.waitForFunction(() => window.G().events.some((e) => e.type === 'danger' && e.state === 'grace'), null, { timeout: 3000 });
  await wait(300);
  await shot('danger_grace');
  await page.waitForFunction(() => window.__p2like.app.match.state !== 'round', null, { timeout: 6000 });
  await wait(900);
  const res = await ev(() => ({ r: window.G().result, wins: [...window.__p2like.app.match.wins], st: window.__p2like.app.match.state, h: window.G().players[0].board.height() }));
  const winB = await ev(() => [window.__cmp('S5', 'banner_lose', 116, 148), window.__cmp('S5', 'banner_win', 436, 148)]);
  check('猶予3秒後も7段なら8段目の追加前に敗北。勝敗表示（1P LOSE／2P WIN）・勝利数+1', res.r?.winner === 1 && res.h === 7 && res.wins[1] === 1 && res.st === 'roundResult' && winB.every((b) => b.bad === 0 && b.opaque > 0), JSON.stringify({ res, winB }));
  await shot('round_result');
  await page.keyboard.press('Enter');
  await wait(100);
  const next = await ev(() => ({ st: window.__p2like.app.match.state, round: window.__p2like.app.match.round, playing: window.G().playing, tick: window.G().tick }));
  check('決定入力（Enter）で次ラウンドのREADYへ', next.st === 'round' && next.round === 2 && !next.playing, JSON.stringify(next));
  await shot('next_round_ready');

  // ---- 設定画面（F2）：CPU選択・反映 ----
  await page.keyboard.press('F2');
  await wait(60);
  await shot('settings');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown'); // 2P 使用機器
  for (let i = 0; i < 7; i++) await page.keyboard.press('ArrowRight'); // キーボード→パッド1〜4→CPU初級→中級→上級
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowUp'); // 先取本数
  await page.keyboard.press('ArrowRight'); // 3本先取
  for (let i = 0; i < 9; i++) await page.keyboard.press('ArrowDown'); // 試合開始
  await page.keyboard.press('Enter');
  await wait(100);
  const cfg = await ev(() => ({ dev: window.__p2like.app.settings.devices[1], firstTo: window.__p2like.app.match.settings.firstTo, mode: window.__p2like.app.mode }));
  check('設定画面：2PをCPU（上級）、3本先取に変更して新しい試合を開始', cfg.dev.kind === 'cpu' && cfg.dev.level === 'hard' && cfg.firstTo === 3 && cfg.mode === 'game', JSON.stringify(cfg));
  await page.waitForFunction(() => window.G().events.filter((e) => e.type === 'launch' && e.player === 1).length >= 2, null, { timeout: 8000 });
  await wait(200);
  check('CPU（2P）が自動で打ち上げる', true);
  await shot('cpu_playing');

  // ---- 操作説明・素材確認画面 ----
  await page.keyboard.press('F1');
  await wait(60);
  await shot('help');
  await page.keyboard.press('F1');
  await page.keyboard.press('KeyV');
  for (let i = 0; i < 7; i++) {
    await wait(250);
    await shot(`viewer_page${i + 1}`);
    await page.keyboard.press('ArrowRight');
  }
  await page.keyboard.press('KeyV');
  await wait(100);

  // ---- 新しい試合（R）----
  await page.keyboard.press('KeyR');
  await wait(100);
  const restarted = await ev(() => window.G().tick < 30 && window.__p2like.app.match.wins.every((w) => w === 0));
  check('Rキーで新しい試合', restarted);
  const fps = await ev(() => window.__p2like.app.fps);
  check('描画ループ稼働', fps > 20, `fps≒${fps.toFixed(1)}`);
  // 設定は次回のためこのブラウザに保存される（検証後は初期値へ戻す）
  await ev(() => localStorage.clear());
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
