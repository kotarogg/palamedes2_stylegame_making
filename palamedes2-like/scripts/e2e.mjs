// ブラウザ検査（第3版 第20章）：ビルド済み dist を配信し、Chromium で操作・画素照合・音声ログ・実ノード・スクリーンショット・エラー収集。
// 使い方: npm run build && npm run e2e
//   E2E_ROOT=<展開した配布物のwww> で配布物そのものを検証できる。
//   既定は「納品検査」：必須114本（BGM3・SE39・ボイス72）の HTTP200・デコード成功・欠落なし、採用フォントの読込を必須とする。
//   E2E_MODE=fallback（--fallback）は開発用の「フォールバック検査」：BGM 3本の未配置と、採用フォント未配置を許容し、結果にその旨を明記する。
//   E2E_FONT_STANDIN=<@fontsource-variable/noto-sans-jp の package> を付けると、同じ書体の代用で画面を撮る（フォールバック検査のみ。結果に明記）。
// ここでの操作はすべて模擬入力（キーボードイベント・模擬ゲームパッド）。実機・実パッド・聴感の検証ではない。
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { installFontStandin } from './font-standin.mjs';

const PORT = Number(process.env.E2E_PORT ?? 8765);
const ROOT = process.env.E2E_ROOT ?? 'dist';
const OUT = new URL('../test-results/e2e/', import.meta.url);
rmSync(OUT, { recursive: true, force: true }); // 前回の画像を残さない
mkdirSync(new URL('screens/', OUT), { recursive: true });

const BGM = ['bgm_menu.wav', 'bgm_puzzle_single.wav', 'bgm_puzzle_versus.wav'];
const bgmPresent = BGM.filter((f) => existsSync(join(ROOT, 'assets/audio/bgm', f)));
const fontPresent = existsSync(join(ROOT, 'gfx/fonts/NotoSansJP-VF.ttf'));
const MODE = process.env.E2E_MODE === 'fallback' || process.argv.includes('--fallback') ? 'fallback' : 'release';
const STANDIN = MODE === 'fallback' && !fontPresent ? (process.env.E2E_FONT_STANDIN ?? null) : null;
const allowMissingBgm = MODE === 'fallback';
const REQUIRED_AUDIO = 114;
const NON_BGM = 111;
console.log(MODE === 'release' ? `== 納品検査（必須${REQUIRED_AUDIO}音源・採用フォント）==` : '== フォールバック検査（BGM・フォント未配置を許容。納品合格ではない）==');
if (STANDIN) console.log('   画面のフォントは同じ書体（Noto Sans JP 可変）の代用：Fontsource 分割版。配布物には含めない');

const server = spawn(process.execPath, ['scripts/serve.mjs', ROOT, String(PORT)], { stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((ok, ng) => {
  server.stdout.on('data', (d) => String(d).includes('配信中') && ok());
  server.on('exit', (c) => ng(new Error(`server exited ${c}`)));
});

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass: !!pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${String(detail).slice(0, 600)})` : ''}`);
};

const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const padInit = () => {
  const mk = (index) => ({ id: 'mock pad', index, connected: true, buttons: Array.from({ length: 17 }, () => ({ pressed: false, value: 0 })), axes: [0, 0, 0, 0] });
  window.__pad = mk(0);
  window.__pad2 = mk(1);
  window.__padOn = false;
  window.__pad2On = false;
  navigator.getGamepads = () => [window.__padOn ? window.__pad : null, window.__pad2On ? window.__pad2 : null, null, null];
};
async function newContext(opts = {}) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1, ...opts });
  await context.addInitScript(padInit);
  if (STANDIN) await installFontStandin(context, STANDIN);
  return context;
}
const context = await newContext();
const page = await context.newPage();
const consoleErrors = [];
const failedRequests = [];
const responses = [];
const watch = (pg) => {
  pg.on('console', (m) => (m.type() === 'error' || m.type() === 'warning') && consoleErrors.push(`${m.type()}: ${m.text()}`));
  pg.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));
  pg.on('requestfailed', (r) => failedRequests.push(`${r.url()} ${r.failure()?.errorText}`));
  pg.on('response', (r) => responses.push([r.status(), new URL(r.url()).pathname]));
};
watch(page);

const shots = [];
/** スクリーンショット：論理640×360の実ゲーム画面（現在の表示倍率のまま） */
const shot = async (name, pg = page) => {
  const file = `screens/${name}.png`;
  await pg.locator('#screen').screenshot({ path: new URL(file, OUT).pathname });
  shots.push(file);
  return file;
};
const wait = (ms, pg = page) => pg.waitForTimeout(ms);
const ev = (fn, arg, pg = page) => pg.evaluate(fn, arg);
const key = async (k, ms = 120) => {
  await page.keyboard.press(k);
  await wait(ms);
};
const sceneName = (pg = page) => ev(() => window.__p2like.scene().constructor.name, undefined, pg);
const toMenu = () => ev(() => window.__p2like.app.toMenu());
const now = () => ev(() => performance.now());
const logSince = (t) => ev((t) => window.__p2like.bus.log.filter((e) => e.t >= t).map((e) => ({ ...e })), t);
const nodesSince = (ct) => ev((ct) => window.__p2like.bus.nodes.filter((n) => n.start >= ct).map((n) => ({ ...n })), ct);
const ctxTime = () => ev(() => window.__p2like.bus.ctx?.currentTime ?? 0);
/** ロジックを n tick 進める（until：式が真で停止）。演出は実時間の描画で進む */
const steps = (n, until = '') =>
  ev(
    ([n, until]) => {
      const sc = window.__p2like.gameScene();
      let i = 0;
      for (; i < n; i++) {
        sc.step();
        if (until && new Function('sc', `return (${until});`)(sc)) break;
      }
      return i;
    },
    [n, until],
  );
const waitPlaying = () => page.waitForFunction(() => window.__p2like.game()?.playing, null, { timeout: 10000 });
const press = async (which, btn, ms = 150) => {
  await ev(([w, b]) => (window[w].buttons[b].pressed = true), [which, btn]);
  await wait(80);
  await ev(([w, b]) => (window[w].buttons[b].pressed = false), [which, btn]);
  await wait(ms);
};
const pad = (btn, ms) => press('__pad', btn, ms);
/** 同じフレームに複数キーを押す（keydown を同期で連続発行） */
const keysSameFrame = (codes) => ev((codes) => codes.forEach((code) => window.dispatchEvent(new KeyboardEvent('keydown', { code, bubbles: true }))), codes);

// 画素照合：単独画像の不透明画素がキャンバス上の指定座標（論理px）と一致するか
const pixelHelper = `
  window.__cmp = (sheet, id, x, y, alphaMin = 255, tol = 2) => {
    const { app } = window.__p2like;
    const f = app.assets.atlas.frame(sheet, id);
    const n = Number(document.getElementById('screen').dataset.scale) || 1;
    const c = document.createElement('canvas'); c.width = f.w; c.height = f.h;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(app.assets.images.get(f.sheet), f.x, f.y, f.w, f.h, 0, 0, f.w, f.h);
    const s = g.getImageData(0, 0, f.w, f.h).data;
    const screen = document.createElement('canvas'); screen.width = f.w; screen.height = f.h;
    const sg = screen.getContext('2d', { willReadFrequently: true });
    sg.imageSmoothingEnabled = false;
    sg.drawImage(document.getElementById('screen'), Math.round(x) * n, Math.round(y) * n, f.w * n, f.h * n, 0, 0, f.w, f.h);
    const d = sg.getImageData(0, 0, f.w, f.h).data;
    let opaque = 0, bad = 0;
    for (let i = 0; i < s.length; i += 4) {
      if (s[i + 3] < alphaMin) continue;
      opaque++;
      if (Math.abs(s[i] - d[i]) > tol || Math.abs(s[i + 1] - d[i + 1]) > tol || Math.abs(s[i + 2] - d[i + 2]) > tol) bad++;
    }
    return { opaque, bad };
  };`;

const OLD_SFX = ['piece_success', 'role_success', 'chain'];

try {
  const t00 = Date.now();
  await page.goto(`http://127.0.0.1:${PORT}/`);
  await page.waitForSelector('body[data-ready]');
  check('起動（画像49・JSON5・フォント・音声読込）→タイトル', (await ev(() => document.body.dataset.ready)) === '1' && (await sceneName()) === 'TitleScene', `${Date.now() - t00}ms`);
  await page.addScriptTag({ content: pixelHelper });

  // ---- 素材：明示許可リスト・寸法・ハッシュは単体検査。ここでは実際に取得した物を確認 ----
  const ok = (ext) => responses.filter(([s, p]) => p.endsWith(ext) && s === 200).map(([, p]) => p);
  const pngs = ok('.png');
  const jsons = ok('.json').map((p) => p.split('/').pop()).sort();
  check(
    '明示読込一覧の49PNGだけを取得（旧版・見本・previews を読まない）、JSON5件',
    pngs.length === 49 && pngs.every((p) => p.includes('/gfx/assets/')) && jsons.join() === 'credits_text.json,font_styles.json,game_loading_list.json,graphics_manifest_v3.json,screen_layout_v2.json',
    `png=${pngs.length} json=${jsons.join(',')}`,
  );
  const wavs = ok('.wav');
  check(`音声：SE39＋ボイス72（計${NON_BGM}）を HTTP200 で取得`, wavs.filter((p) => !p.includes('/bgm/')).length === NON_BGM, `wav200=${wavs.length}`);
  const bgm200 = wavs.filter((p) => p.includes('/bgm/')).length;
  if (allowMissingBgm) check(`［フォールバック］BGM 3曲（配信物に存在${bgmPresent.length}曲）`, bgm200 === bgmPresent.length, `未配置${3 - bgmPresent.length}曲は404を許容（無音で継続）`);
  else check(`［納品］BGM 3曲を HTTP200 で取得（必須${REQUIRED_AUDIO}本）`, bgm200 === 3 && wavs.length === REQUIRED_AUDIO, `bgm200=${bgm200} wav200=${wavs.length}`);
  check('旧音（sfx_piece_success／role_success／chain／旧 sfx_field_rise）を取得しない', !wavs.some((p) => /sfx_(piece_success|role_success|chain|field_rise)\.wav$/.test(p)));
  const font = await ev(() => ({ loaded: window.__p2like.app.assets.fontLoaded, check: document.fonts.check('600 12px "Noto Sans JP"', 'あ') }));
  const ttf = responses.find(([, p]) => p.endsWith('/gfx/fonts/NotoSansJP-VF.ttf'));
  if (MODE === 'release') check('［納品］採用フォント NotoSansJP-VF.ttf を取得し、読込完了後に描画（代替フォントへ退避しない）', fontPresent && ttf?.[0] === 200 && font.loaded && font.check, JSON.stringify({ fontPresent, ttf, font }));
  else if (STANDIN) check('［フォールバック・フォント代用］同じ書体の代用で読込完了（納品物の採用フォントではない）', font.loaded, JSON.stringify(font));
  else check('［フォールバック］採用フォント未配置：画面上部に警告を常時表示（黙って退避しない）', !font.loaded, JSON.stringify(font));
  const ver = await ev(() => window.__p2like.app.assets.atlas.manifest.version);
  check('マニフェスト graphics-v3', String(ver).startsWith('graphics-v3'), ver);
  const size = await ev(() => {
    const c = document.getElementById('screen');
    return { css: c.style.width, buf: c.width, mode: c.dataset.scaleMode };
  });
  check('DPR1・1280×720：収まる最大＝実画素2倍（描画バッファ1280、CSS 1280px）', size.css === '1280px' && size.buf === 1280 && size.mode === 'fit', JSON.stringify(size));
  const rendering = await ev(() => getComputedStyle(document.getElementById('screen')).imageRendering);
  check('拡大時にドットを滲ませない(image-rendering)', rendering === 'pixelated', rendering);

  // ---- S01 タイトル：ゲームパッドだけの最初の操作（R1）。最初の入力は次の画面へ渡さない ----
  await wait(600);
  await shot('S01_title');
  const logo = await ev(() => window.__cmp('title_logo', 'title_logo', 272, 72));
  check('タイトル：title_logo を原寸で描画（画素一致）', logo.bad === 0 && logo.opaque > 0, JSON.stringify(logo));
  const bgmTitle = await ev(() => window.__p2like.bus.currentBgm);
  const before = await ev(() => ({ ctx: !!window.__p2like.bus.ctx, attempted: window.__p2like.bus.unlockAttempted }));
  await ev(() => (window.__padOn = true));
  await pad(0, 400); // A：タイトル → メインメニュー
  const afterPad = await ev(() => ({ ctx: window.__p2like.bus.ctx?.state ?? null, attempted: window.__p2like.bus.unlockAttempted, scene: window.__p2like.scene().constructor.name, depth: window.__p2like.scene().stack?.length, cursor: window.__p2like.scene().stack?.[0].cursor }));
  check(
    'R1・S01：パッドAだけで音声有効化を試み running、タイトル→メインメニュー。その入力はメニューへ渡らない（MODE1を開かない）',
    !before.ctx && !before.attempted && afterPad.attempted && afterPad.ctx === 'running' && afterPad.scene === 'MenuScene' && afterPad.depth === 1 && afterPad.cursor === 0,
    `before=${JSON.stringify(before)} after=${JSON.stringify(afterPad)}`,
  );
  await wait(300);
  const bgmNodes0 = await ev(() => window.__p2like.bus.nodes.filter((n) => n.kind === 'bgm').map((n) => ({ ...n })));
  check('タイトルはメニュー曲（自動再生を強制せず、有効化後に開始）。タイトル→メニューで再始動しない', bgmTitle === 'menu' && (allowMissingBgm && !bgmPresent.includes('bgm_menu.wav') ? bgmNodes0.length === 0 : bgmNodes0.length === 1 && bgmNodes0[0].id === 'menu'), JSON.stringify(bgmNodes0));
  await shot('S02_menu');
  const menuArt = await ev(() => [window.__cmp('menu_kotaro', 'menu_kotaro', 16, 163), window.__cmp('menu_akane', 'menu_akane', 480, 163)]);
  check('メインメニュー（MODE1／MODE2／オプション／遊び方）：両脇の menu_kotaro・menu_akane を原寸・原点どおりに描画（画素一致）', menuArt.every((m) => m.bad === 0 && m.opaque > 0) && (await ev(() => window.__p2like.scene().stack[0].items.map((i) => i.label).join())) === 'MODE1,MODE2,オプション,遊び方', JSON.stringify(menuArt));

  // ---- パッドだけで CPU対戦（READY／GO はCPUの相手＝アカネ） ----
  await pad(0, 200); // MODE1
  await shot('S03_menu_mode1');
  await pad(13); // ↓ CPU対戦
  let t0 = await now();
  await pad(0, 300);
  await waitPlaying();
  await wait(300);
  const padStart = await ev(() => ({ chars: window.__p2like.gameScene().characters, ann: window.__p2like.gameScene().staging.announcer }));
  const startNodes = await ev(() => window.__p2like.bus.nodes.filter((n) => n.kind === 'voice').map((n) => ({ ...n })));
  const readyNode = startNodes.find((n) => n.id === 'akane_ready');
  const goNode = startNodes.find((n) => n.id === 'akane_go');
  check(
    'パッドだけで MODE1 CPU対戦を開始：1Pコタロー対アカネ、READY／GO の担当はアカネ（同じ話者）・実ノードで再生開始',
    padStart.chars.join() === 'kotaro,akane' && padStart.ann === 'akane' && readyNode && goNode && readyNode.stoppedAt === null,
    JSON.stringify({ padStart, readyNode, goNode }),
  );
  const vlog = await logSince(t0);
  check('対戦BGM（versus）を要求', vlog.some((e) => e.kind === 'bgm' && e.id === 'versus'));
  await ev(() => (window.__padOn = false));

  // ---- S08 受攻撃ストック：7受信→ブロック、消化中の12受信は待機群。接着音は1ライン1回 ----
  t0 = await now();
  const ctx0 = await ctxTime();
  const atk = await ev(() => {
    const sc = window.__p2like.gameScene();
    const g = sc.game;
    const from = g.events.length;
    sc.debugQueue.push({ player: 0, type: 'debugAttack', lines: 7 });
    for (let i = 0; i < 121; i++) sc.step();
    sc.debugQueue.push({ player: 0, type: 'debugAttack', lines: 12 });
    sc.step();
    const v = sc.view.stockView(0, g.tick);
    const evs = g.events.slice(from).filter((e) => e.player === 0 && ['blockStart', 'waveStart', 'attackRow'].includes(e.type));
    return { v, evs: evs.map((e) => [e.type, e.tick, e.lines ?? e.total]) };
  });
  await wait(250);
  await shot('S08_versus_stock_block_and_pending');
  check(
    '受攻撃ストック：処理中ブロック（上）と nextPending（下）を混ぜず表示。予約高さ維持',
    atk.v.blockLines === 6 && atk.v.pendingLines === 12 && atk.v.reservedPx === 32 && atk.v.pendingY === atk.v.blockY + 32 + 6,
    JSON.stringify(atk),
  );
  const tRows = t0;
  const ctxRows = ctx0;
  // ---- 役宣言：代表役ロゴとボイスの同時開始、段階SE、旧SEの二重発音なし ----
  t0 = await now();
  const decl = await ev(() => {
    const sc = window.__p2like.gameScene();
    const g = sc.game;
    const p = g.players[0];
    const mk = (n, s) => g.factory.make(n, s);
    p.roleStock = [mk(1, 'spade'), mk(2, 'spade'), mk(3, 'spade'), mk(4, 'spade'), mk(5, 'spade'), mk(6, 'spade')];
    sc.debugQueue.push({ player: 0, type: 'declare' });
    sc.step();
    const d = g.events.filter((e) => e.type === 'declare' && e.player === 0).at(-1);
    return { tick: g.tick, logos: d?.logos, chain: d?.chainCount };
  });
  await wait(60);
  const roleShow = await ev(() => {
    const sc = window.__p2like.gameScene();
    return sc.roleNames.logoAt(0, sc.game.tick);
  });
  const roleLog = await logSince(t0);
  const roleVoice = roleLog.find((e) => e.kind === 'voice' && e.id.startsWith('kotaro_role_'));
  const declSfx = roleLog.filter((e) => e.kind === 'sfx').map((e) => e.id);
  check(
    '役宣言：代表役（先頭ロゴ）と代表役ボイスを同時開始。役宣言SEは連鎖段階 se_role_declare_0N、旧成立音・連鎖音を鳴らさない',
    roleShow?.logo === decl.logos?.[0] && roleVoice?.id === `kotaro_role_${String(decl.logos[0] + 1).padStart(2, '0')}` && declSfx.includes(`role_declare_${Math.min(5, decl.chain)}`) && !declSfx.some((id) => OLD_SFX.includes(id)),
    JSON.stringify({ decl, roleShow, roleVoice, declSfx }),
  );
  await wait(250);
  await shot('S08_role_chain');
  // 以降の検査で1Pが攻撃ピンチで負けないよう、1Pの受攻撃を空にする（検査用の操作）
  await ev(() => {
    const s = window.__p2like.game().players[0].incoming;
    s.nextPending = s.blockRemaining = s.waveRemaining = 0;
    s.pinchRemaining = null;
  });

  // ---- S26 確認ダイアログ：ゲームは止まらない ----
  const tk0 = await ev(() => window.__p2like.game().tick);
  await key('Escape', 500);
  const dlg = await ev(() => [window.__p2like.gameScene().quit.length, window.__p2like.game().tick]);
  await shot('S26_confirm_quit');
  check('Esc：終了確認ダイアログ（dialog_panel）、確認中もゲームは進行（一時停止なし）', dlg[0] === 1 && dlg[1] > tk0 + 10, `dialog=${dlg[0]} tick ${tk0}→${dlg[1]}`);
  await key('Enter'); // 「続ける」
  check('「続ける」でダイアログを閉じる', (await ev(() => window.__p2like.gameScene().quit.length)) === 0);

  // ---- S13 勝敗演出：敗者モーション→落下（落下開始で se_character_fall）→200ms→勝者＋クラッカー1回 ----
  const runResult = async (loser, name) => {
    const tR = await now();
    await ev((loser) => {
      const sc = window.__p2like.gameScene();
      sc.game.players[loser].defeated = true;
      sc.step();
    }, loser);
    await wait(500);
    await shot(`${name}_motion`);
    await wait(700);
    await shot(`${name}_fall`);
    await wait(1100);
    await shot(`${name}_winner_cracker`);
    return logSince(tR);
  };
  const r1 = await runResult(1, 'S13_round_result');
  const rv = (id) => r1.find((e) => e.id === id && !e.skipped);
  const order = ['win', 'akane_lose', 'character_fall', 'kotaro_win', 'result_cracker'].map((id) => rv(id)?.t ?? null);
  const plan1 = await ev(() => window.__p2like.gameScene().staging.plan);
  check(
    '勝敗演出：勝利SE＋敗者ボイス→（640ms）落下開始で se_character_fall→（700ms＋200ms）勝者ボイスとクラッカーSEが同時。敗者ボイスの終了は待たない',
    order.every((x) => x !== null) &&
      order[2] - order[1] >= 600 &&
      order[3] - order[2] >= 850 &&
      Math.abs(order[4] - order[3]) < 40 &&
      plan1.crackerToward === 0,
    JSON.stringify({ order: order.map((x) => (x === null ? null : Math.round(x - order[0]))), plan1 }),
  );
  const crackerCount = r1.filter((e) => e.id === 'result_cracker' && !e.skipped).length;
  const rowsApplied = await ev(() => window.__p2like.game().events.filter((e) => e.type === 'attackRow').length);
  const rowLog = (await logSince(tRows)).filter((e) => e.id === 'attack_row' && !e.skipped);
  const rowNodes = (await nodesSince(ctxRows)).filter((n) => n.id === 'attack_row');
  check('接着音 sfx_attack_row：実適用1ラインにつき1回（実ノード）', rowsApplied > 0 && rowNodes.length === rowsApplied && rowLog.length === rowsApplied, `rows=${rowsApplied} log=${rowLog.length} nodes=${rowNodes.length}`);
  // 修正R2：上昇音 se_field_rise は実適用1段につき1回（attackRow から）＋自然・手動の上昇。攻撃の rise では重ねない
  const riseExpected = await ev(() => window.__p2like.game().events.filter((e) => e.type === 'attackRow' || (e.type === 'rise' && e.kind !== 'attack')).length);
  const riseReq = (await logSince(tRows)).filter((e) => e.id === 'field_rise').length;
  check('修正R2：上昇音 se_field_rise は攻撃の実適用1段につき1回（自然・手動上昇を含めた要求数が一致、二重要求なし）', rowsApplied > 0 && riseReq === riseExpected, `rows=${rowsApplied} expected=${riseExpected} requested=${riseReq}`);
  check('クラッカーは1回だけ（勝者＝1P・左側へ向けて左右反転）', crackerCount === 1);
  const accept = await ev(() => window.__p2like.gameScene().staging.acceptReady);
  check('勝者演出の開始後に決定入力を受付', accept);
  await key('Enter', 400);
  await waitPlaying();
  // B1：第2ラウンドで CPU が最初から操作する（入力・CPU状態を持ち越さない）
  await wait(2000);
  const r2 = await ev(() => {
    const sc = window.__p2like.gameScene();
    const g = sc.game;
    const first = g.events.find((e) => e.player === 1 && ['move', 'launch', 'rotate'].includes(e.type) && e.tick >= g.playStartTick);
    return { round: sc.session.round, wins: sc.session.wins, firstCpuCmd: first ? first.tick - g.playStartTick : null };
  });
  check('B1：CPU対戦の第2ラウンドでも CPU が開始直後から操作（1.5秒以内）', r2.round === 2 && r2.firstCpuCmd !== null && r2.firstCpuCmd <= 90, JSON.stringify(r2));

  // ---- S14 CPU対戦の終了：勝ち＝次の相手へ／同じ相手と再戦／メニュー ----
  const firstTo = await ev(() => window.__p2like.gameScene().session.settings.firstTo);
  for (let i = 1; i < firstTo; i++) {
    await ev(() => {
      const sc = window.__p2like.gameScene();
      sc.game.players[1].defeated = true;
      sc.step();
    });
    await wait(2300);
    if (i < firstTo - 1) {
      await key('Enter', 400);
      await waitPlaying();
    }
  }
  await wait(400);
  const fin = await ev(() => ({ state: window.__p2like.gameScene().session.state, choices: window.__p2like.gameScene().finalChoices().map((c) => c.label) }));
  await shot('S14_cpu_win');
  check('CPU対戦で勝利：次の相手へ／同じ相手と再戦／メニューへ', fin.state === 'matchResult' && fin.choices.join() === '次の相手へ,同じ相手と再戦,メニューへ', JSON.stringify(fin));
  t0 = await now();
  await key('Enter', 600); // 次の相手へ
  const nx = await ev(() => ({ chars: window.__p2like.gameScene().characters, wins: window.__p2like.gameScene().session.wins, opp: window.__p2like.app.cpuOpponent, ann: window.__p2like.gameScene().staging.announcer }));
  check('「次の相手へ」：相手が東北ずん子に進み、勝利数0から。READY担当は相手（ずん子）', nx.chars.join() === 'kotaro,zunko' && nx.wins.join() === '0,0' && nx.opp === 'zunko' && nx.ann === 'zunko', JSON.stringify(nx));
  await waitPlaying();
  const zSheet = await ev(() => [window.__p2like.gameScene().view.characterSheet(0), window.__p2like.gameScene().view.characterSheet(1)]);
  check('キャラ別モーションシート：コタローS1・ずん子S13', zSheet.join() === 'S1,S13', zSheet.join());
  await shot('S08_versus_kotaro_zunko');
  // 負け：同じ相手に再挑戦／メニューへ
  for (let i = 0; i < firstTo; i++) {
    await ev(() => {
      const sc = window.__p2like.gameScene();
      sc.game.players[0].defeated = true;
      sc.step();
    });
    await wait(2300);
    if (i < firstTo - 1) {
      await key('Enter', 400);
      await waitPlaying();
    }
  }
  await wait(300);
  const lose = await ev(() => window.__p2like.gameScene().finalChoices().map((c) => c.label));
  await shot('S14_cpu_lose');
  check('CPU対戦で敗北：同じ相手に再挑戦／メニューへ', lose.join() === '同じ相手に再挑戦,メニューへ', lose.join());
  const ctxR = await ctxTime();
  await key('Enter', 500); // 再挑戦
  const re = await ev(() => ({ chars: window.__p2like.gameScene().characters, wins: window.__p2like.gameScene().session.wins, opp: window.__p2like.app.cpuOpponent }));
  const leftovers = await ev((ct) => {
    const bus = window.__p2like.bus;
    return bus.nodes.filter((n) => n.kind !== 'bgm' && n.start < ct && n.start + n.duration > ct + 0.05 && (n.stoppedAt === null || n.stoppedAt > ct + 0.05)).map((n) => n.id);
  }, ctxR);
  check('再挑戦：同じ相手（ずん子）のまま、勝利数0から。前の結果の声・SEを持ち越さない', re.chars.join() === 'kotaro,zunko' && re.wins.join() === '0,0' && re.opp === 'zunko' && leftovers.length === 0, JSON.stringify({ re, leftovers }));
  await toMenu();
  const reset = await ev(() => window.__p2like.app.cpuOpponent);
  check('メインメニューへ戻ると CPU の相手順はアカネへ戻る（保存しない）', reset === 'akane', reset);

  // ---- S05 キャラクター選択（2P・キーボード2人）：同フレーム入力は1P→2P、重複不可 ----
  await ev(() => (window.__p2like.scene().stack[0].cursor = 0));
  await key('Enter');
  await key('ArrowDown');
  await key('ArrowDown');
  await key('Enter', 200);
  check('MODE1 › 2P対戦 → キャラクター選択', (await sceneName()) === 'CharacterSelectScene');
  await shot('S05_character_select');
  await keysSameFrame(['KeyD', 'ArrowRight']); // 1P 右、2P 右（同じフレーム）
  await wait(150);
  const cs1 = await ev(() => window.__p2like.scene().sel.cursors);
  check('同じフレームの入力は 1P→2P の順：1Pはアカネを飛ばしてずん子、2Pはずん子を飛ばしてコタロー（カーソル重複なし）', cs1.join() === '2,0', cs1.join());
  t0 = await now();
  await key('KeyF', 200); // 1P 決定
  await key('KeyD', 150); // 決定済みは動かない
  const cs2 = await ev(() => ({ c: window.__p2like.scene().sel.cursors, l: window.__p2like.scene().sel.locked }));
  await shot('S05_character_select_locked');
  await key('KeyG', 150); // 1P 戻る（B入れ替えキー）＝自分の決定だけ取消
  const cs3 = await ev(() => window.__p2like.scene().sel.locked);
  await key('KeyF', 150);
  await key('Comma', 200); // 2P 決定
  const selLog = await logSince(t0);
  check(
    '決定済みカーソルは固定、戻るは自分の決定だけ取消。決定ボイス（select）は決定時に1回',
    cs2.c.join() === '2,0' && cs2.l.join() === 'true,false' && cs3.join() === 'false,false' && selLog.filter((e) => e.id === 'zunko_select').length === 2 && selLog.filter((e) => e.id === 'kotaro_select').length === 1,
    JSON.stringify({ cs2, cs3, voices: selLog.filter((e) => e.kind === 'voice').map((e) => e.id) }),
  );
  await wait(150);
  const vs2 = await ev(() => ({ scene: window.__p2like.scene().constructor.name, chars: window.__p2like.gameScene()?.characters, ann: window.__p2like.gameScene()?.staging.announcer }));
  check('修正R3：両者決定でただちに 2P対戦開始（固定待機なし。1P ずん子・2P コタロー）。READY担当は両者のどちらか', vs2.scene === 'GameScene' && vs2.chars?.join() === 'zunko,kotaro' && ['zunko', 'kotaro'].includes(vs2.ann), JSON.stringify(vs2));
  await page.waitForFunction(() => window.__p2like.game()?.tick > 2, null, { timeout: 5000 });
  await shot('S11_ready');
  await waitPlaying();
  await wait(120);
  await shot('S11_go');
  // R2：1P 終了確認中も 2P の操作は 2P へ（両者キーボード）
  await wait(300);
  await key('Escape', 150);
  const q0 = await ev(() => {
    const sc = window.__p2like.gameScene();
    return { dlg: sc.quit.map((q) => [q.player, q.cursor]), sel2: sc.game.players[1].selectedCol, n: sc.game.events.length };
  });
  await key('ArrowLeft', 400);
  await key('Comma', 500);
  const q1 = await ev((n) => {
    const sc = window.__p2like.gameScene();
    return { dlg: sc.quit.map((q) => [q.player, q.cursor]), sel2: sc.game.players[1].selectedCol, launch2: sc.game.events.slice(n).some((e) => e.type === 'launch' && e.player === 1) };
  }, q0.n);
  check('R2：1P終了確認中も 2P（←・,）の移動と発射は 2P へ届き、1P の確認カーソルは動かない', JSON.stringify(q1.dlg) === '[[0,0]]' && q1.sel2 === q0.sel2 - 1 && q1.launch2, JSON.stringify({ q0, q1 }));
  await key('Escape', 150);
  // S15 2P対戦の終了：同じキャラで再戦／キャラ選択へ／メニューへ
  for (let i = 0; i < firstTo; i++) {
    await ev(() => {
      const sc = window.__p2like.gameScene();
      sc.game.players[1].defeated = true;
      sc.step();
    });
    await wait(2300);
    if (i < firstTo - 1) {
      await key('Enter', 400);
      await waitPlaying();
    }
  }
  await wait(300);
  const fin2 = await ev(() => window.__p2like.gameScene().finalChoices().map((c) => c.label));
  await shot('S15_2p_result');
  check('2P対戦の終了：同じキャラで再戦／キャラ選択へ／メニューへ', fin2.join() === '同じキャラで再戦,キャラ選択へ,メニューへ', fin2.join());
  await key('ArrowDown');
  await key('Enter', 300);
  const back = await sceneName();
  await key('Escape', 300); // 両者未決定で戻る → 前のメニュー（MODE1）
  const back2 = await ev(() => ({ scene: window.__p2like.scene().constructor.name, title: window.__p2like.scene().stack?.at(-1).title }));
  check('「キャラ選択へ」→ 両者未決定の戻るで前のメニュー（MODE1）へ', back === 'CharacterSelectScene' && back2.scene === 'MenuScene' && back2.title === 'MODE1', JSON.stringify({ back, back2 }));
  await shot('S04_menu_mode1_from_select');

  // ---- 修正R3：標準設定（1P コタロー・2P アカネ）でほぼ同時に確定 → 両者の確定ボイスが終端まで鳴る ----
  await ev(() => window.__p2like.app.toMenu(['MODE1']));
  await key('ArrowDown');
  await key('ArrowDown');
  await key('Enter', 200);
  const ctxSel = await ctxTime();
  const tSel = await now();
  await keysSameFrame(['KeyF', 'Comma']);
  await wait(120);
  const selScene = await ev(() => ({ scene: window.__p2like.scene().constructor.name, chars: window.__p2like.gameScene()?.characters }));
  await wait(2400); // コタローの確定ボイス 約1.94秒 を超えるまで
  const selNodes = (await nodesSince(ctxSel)).filter((n) => n.id.endsWith('_select'));
  const nowCt = await ctxTime();
  const selDone = selNodes.map((n) => ({ id: n.id, dur: +n.duration.toFixed(3), stoppedAt: n.stoppedAt, ended: nowCt >= n.start + n.duration }));
  const readyHeard = (await logSince(tSel)).some((e) => e.kind === 'voice' && e.id.endsWith('_ready') && !e.skipped);
  check(
    '修正R3：ほぼ同時の確定でもコタロー・アカネの確定ボイスが各1回、途中停止せず終端まで再生（READYと重なっても止まらない、試合開始は待たない）',
    selScene.scene === 'GameScene' && selScene.chars?.join() === 'kotaro,akane' && selNodes.length === 2 && selDone.every((n) => n.stoppedAt === null && n.ended) && readyHeard,
    JSON.stringify({ selScene, selDone, readyHeard }),
  );
  await ev(() => window.__p2like.app.toMenu(['MODE1']));
  const leftSel = await ev(() => window.__p2like.bus.voicesPlaying());
  check('修正R3：メニュー復帰で声を持ち越さない', leftSel.length === 0, JSON.stringify(leftSel));

  // ---- パッド2台でキャラ選択・2P対戦・START 確認 ----
  const saveDevices = await ev(() => JSON.parse(JSON.stringify(window.__p2like.app.settings.devices)));
  await ev(() => {
    const a = window.__p2like.app;
    a.settings.devices = [{ kind: 'gamepad', index: 0 }, { kind: 'gamepad', index: 1 }];
    window.__padOn = true;
    window.__pad2On = true;
  });
  await key('ArrowDown');
  await key('ArrowDown');
  await key('Enter', 200);
  await press('__pad', 15); // 1P 右 → ずん子
  await press('__pad', 0); // 1P 決定
  await press('__pad2', 14); // 2P 左 → コタロー
  await press('__pad2', 0, 1200); // 2P 決定
  const padVs = await ev(() => window.__p2like.gameScene()?.characters);
  check('パッド2台だけでキャラ選択→2P対戦（1P ずん子・2P コタロー）', padVs?.join() === 'zunko,kotaro', String(padVs));
  await waitPlaying();
  await press('__pad', 9); // 1P START
  const pq0 = await ev(() => ({ dlg: window.__p2like.gameScene().quit.map((q) => [q.player, q.cursor]), sel: window.__p2like.game().players[1].selectedCol, n: window.__p2like.game().events.length }));
  await press('__pad2', 14, 400);
  await press('__pad2', 0, 500);
  const pq1 = await ev((n) => ({ dlg: window.__p2like.gameScene().quit.map((q) => [q.player, q.cursor]), sel: window.__p2like.game().players[1].selectedCol, launch: window.__p2like.game().events.slice(n).some((e) => e.type === 'launch' && e.player === 1) }), pq0.n);
  check('R2：パッド2台：1P確認中も 2P のパッドで移動・発射、1P の確認は動かない', JSON.stringify(pq1.dlg) === '[[0,0]]' && pq1.sel === pq0.sel - 1 && pq1.launch, JSON.stringify({ pq0, pq1 }));
  await press('__pad', 15); // 1P 確認カーソル → 終了する
  await press('__pad', 0, 300); // 決定 → メニュー
  check('パッドだけで終了確認「終了する」→メニュー', (await sceneName()) === 'MenuScene');
  await ev((d) => ((window.__p2like.app.settings.devices = d), (window.__padOn = false), (window.__pad2On = false)), saveDevices);

  // ---- シングル ----
  t0 = await now();
  await ev(() => window.__p2like.app.startGame('mode1', 'single', 'endless'));
  await waitPlaying();
  await wait(300);
  const sLog = await logSince(t0);
  check('シングル：READY担当はコタロー、BGM single', sLog.some((e) => e.id === 'kotaro_ready') && sLog.some((e) => e.kind === 'bgm' && e.id === 'single'), sLog.map((e) => e.id).join(','));
  await shot('S06_endless');
  // 打ち上げ成功の段階SE：連続取得の回数で 01→02（旧成功音は鳴らさない）
  t0 = await now();
  for (let i = 0; i < 2; i++) {
    await ev(() => {
      const g = window.__p2like.game();
      const p = g.players[0];
      const top = p.board.cols[p.selectedCol].find((c) => c.kind === 'piece');
      g.base = g.factory.make(top.piece.n, top.piece.suit);
    });
    await key('KeyF', 700);
  }
  const ls = (await logSince(t0)).filter((e) => e.kind === 'sfx' && !e.skipped).map((e) => e.id);
  check('打ち上げ成功SE：連続取得1→2で se_launch_success_01→02。旧成功音なし', ls.includes('launch_success_1') && ls.includes('launch_success_2') && !ls.some((id) => OLD_SFX.includes(id)), ls.join(','));
  await steps(60 * 600, 'sc.game.result');
  await wait(2600);
  await shot('S17_game_over');
  const go = await ev(() => ({ outcome: window.__p2like.game().result?.outcome, cracker: window.__p2like.gameScene().staging.plan?.crackerTick, choices: window.__p2like.gameScene().finalChoices().map((c) => c.label) }));
  check('ゲームオーバー：結果パネル（再挑戦／メニューへ）、クラッカーなし', go.outcome === 'gameOver' && go.cracker === null && go.choices.join() === '再挑戦,メニューへ', JSON.stringify(go));
  await toMenu();

  await ev(() => window.__p2like.app.startGame('mode1', 'single', 'stage'));
  await page.waitForFunction(() => window.__p2like.game()?.tick > 2, null, { timeout: 5000 });
  await shot('S07_stage_start');
  await waitPlaying();
  await wait(300);
  await shot('S07_stage');
  const clearRun = async (finalStage) => {
    await waitPlaying();
    const prep = await ev((finalStage) => {
      const g = window.__p2like.game();
      const s = g.single;
      const p = g.players[0];
      if (finalStage) {
        s.stage = 10;
        s.quota = 180;
      }
      s.progress = s.quota - 1;
      const col = p.board.cols[p.selectedCol];
      const top = col.find((c) => c.kind === 'piece');
      if (finalStage) p.board.cols.forEach((c, i) => (p.board.cols[i] = i === p.selectedCol ? [top] : []));
      g.base = g.factory.make(top.piece.n, top.piece.suit);
      return { n: window.__p2like.bus.nodes.length };
    }, finalStage);
    await key('KeyF', 3200);
    return ev(([n]) => ({ outcome: window.__p2like.game().result?.outcome, now: window.__p2like.bus.ctx.currentTime, nodes: window.__p2like.bus.nodes.slice(n).map((x) => ({ ...x })), plan: window.__p2like.gameScene().staging.plan }), [prep.n]);
  };
  const endedIntact = (r, id) => {
    const x = r.nodes.find((n) => n.id === id);
    return !!x && x.stoppedAt === null && r.now >= x.start + x.duration;
  };
  const r3a = await clearRun(false);
  await shot('S16_stage_clear');
  check('R3：ステージクリアで sfx_stage_clear が途中停止せず終端まで再生。シングル成功はクラッカーあり', r3a.outcome === 'stageClear' && endedIntact(r3a, 'stage_clear') && r3a.plan?.crackerTick !== null, JSON.stringify({ outcome: r3a.outcome, plan: r3a.plan }));
  await toMenu();
  await ev(() => window.__p2like.app.startGame('mode1', 'single', 'stage'));
  const r3b = await clearRun(true);
  await shot('S16_all_stages');
  check('R3：最終面クリア＋全消し同時で sfx_all_stages_clear・sfx_all_clear とも終端まで再生', r3b.outcome === 'allStagesClear' && endedIntact(r3b, 'all_stages_clear') && endedIntact(r3b, 'all_clear'), r3b.outcome);
  await toMenu();

  // ---- MODE2 ----
  t0 = await now();
  await ev(() => window.__p2like.app.startGame('mode2', 'single', 'mode2'));
  await waitPlaying();
  await wait(300);
  await shot('S09_mode2_single');
  const m2 = await ev(() => {
    const g = window.__p2like.game();
    return { mode: g.mode, remaining: g.remaining(g.players[0]), n: g.players.length };
  });
  check('MODE2 シングル：42個から開始', m2.mode === 'mode2' && m2.remaining === 42 && m2.n === 1, JSON.stringify(m2));
  await ev(() => {
    const g = window.__p2like.game();
    const p = g.players[0];
    const col = p.board.cols[p.selectedCol];
    const top = col.find((c) => c.kind === 'piece');
    p.board.cols.forEach((c, i) => (p.board.cols[i] = i === p.selectedCol ? [top] : []));
    g.base = g.factory.make(top.piece.n, top.piece.suit);
  });
  await key('KeyF', 2600);
  await shot('S18_mode2_clear');
  check('MODE2 シングル：盤面を空にしてクリア', (await ev(() => window.__p2like.game().result?.outcome)) === 'clear');
  await toMenu();
  await ev(() => window.__p2like.app.startGame('mode2', 'cpu'));
  await waitPlaying();
  await steps(60 * 20);
  await wait(400);
  await shot('S10_mode2_versus');
  const m2c = await ev(() => ({ mode: window.__p2like.game().mode, r: window.__p2like.game().players.map((p) => window.__p2like.game().remaining(p)) }));
  check('MODE2 CPU対戦：CPUが打ち上げて残数が減る', m2c.mode === 'mode2' && m2c.r[1] < 42, JSON.stringify(m2c));
  const m2log = await logSince(t0);
  // 出せるピースがない状態を作ってカウントダウン（3・2・1）を表示（検査用の盤面操作）
  await ev(() => window.__p2like.app.startGame('mode2', 'single', 'mode2'));
  await waitPlaying();
  await wait(1200); // GO の表示が終わってから
  const cdStart = await ev(() => {
    const sc = window.__p2like.gameScene();
    const g = sc.game;
    const p = g.players[0];
    p.board.cols.forEach((c, i) => (p.board.cols[i] = [{ kind: 'piece', piece: g.factory.make(1, 'spade') }, { kind: 'piece', piece: g.factory.make(2, 'spade') }]));
    g.base = g.factory.make(4, 'heart');
    for (let i = 0; i < 600; i++) {
      sc.step();
      if (g.events.some((e) => e.type === 'countdown')) break;
    }
    return g.events.filter((e) => e.type === 'countdown').map((e) => e.value);
  });
  await wait(200);
  await shot('S12_countdown');
  check('MODE2：両者（シングルは本人）が出せないと 3・2・1 のカウントダウン', cdStart.length > 0, JSON.stringify(cdStart));
  const mode1Only = m2log.filter((e) => /^(role_|launch_success_[2-5]|counter|attack_|danger|line_clear|level_up)|_role_|_damage$|_attack$/.test(e.id));
  check('MODE2 に MODE1 専用の処理・音（役・攻撃・相殺・危険・段階2以上の成功音）が混入しない', mode1Only.length === 0, mode1Only.map((e) => e.id).join(','));
  await toMenu();

  // ---- オプション（S19〜S24）・遊び方（S25） ----
  await ev(() => (window.__p2like.scene().stack[0].cursor = 2));
  await key('Enter', 200);
  check('オプション：音／操作／対戦／表示／クレジット／設定初期化／戻る', (await sceneName()) === 'OptionsScene' && (await ev(() => window.__p2like.scene().rows().map((r) => r.label).join())) === '音,操作,対戦,表示,クレジット,設定初期化,戻る');
  await shot('S19_options');
  await key('Enter'); // 音
  await key('ArrowLeft'); // BGM 100→90
  await shot('S20_sound');
  const saved = await ev(() => JSON.parse(localStorage.getItem('palamedes2-like.settings.v2') ?? '{}').audio?.bgm);
  check('音量変更（BGM 100→90）が設定に保存される', saved === 90, String(saved));
  await key('ArrowRight');
  // ミュートと声中のBGM減衰（ゲイン値。聴感ではない）
  const duck = await ev(async () => {
    const bus = window.__p2like.bus;
    bus.playVoice('kotaro', 'win', 50, 'result');
    await new Promise((r) => setTimeout(r, 200));
    const during = bus.duck.gain.value;
    bus.stopEffects();
    await new Promise((r) => setTimeout(r, 450));
    return { during, after: bus.duck.gain.value };
  });
  check('声の再生中は BGM を −4dB 減衰し、終了後に戻す（ゲイン値の検査）', Math.abs(duck.during - 0.631) < 0.05 && duck.after > 0.95, JSON.stringify(duck));
  await key('Escape');
  await key('ArrowDown');
  await key('Enter');
  await shot('S21_controls');
  await key('Escape');
  await key('ArrowDown');
  await key('ArrowDown');
  await key('Enter');
  await shot('S22_match_settings');
  await key('Escape');
  await key('ArrowDown');
  await key('ArrowDown');
  await key('ArrowDown');
  await key('Enter');
  await shot('S23_display_settings');
  const disp = await ev(() => window.__p2like.scene().rows().map((r) => `${r.label}:${r.value}:${!!r.disabled}`));
  check('表示設定：「収まる最大」と固定倍率。収まらない倍率は無効（選択不可）と表示', disp[0].startsWith('画面表示倍率:収まる最大') && disp.some((r) => r.includes('現在無効') && r.endsWith(':true')), disp.join(' | '));
  await key('Escape');
  for (let i = 0; i < 4; i++) await key('ArrowDown');
  await ev(() => {
    window.__opened = [];
    window.open = (u) => (window.__opened.push(u), null);
  });
  await key('Enter', 200);
  check('クレジット画面へ', (await sceneName()) === 'CreditsScene');
  await shot('S24_credits');
  await key('ArrowRight', 200);
  await shot('S24_credits_links');
  await key('ArrowDown');
  await key('Enter', 200);
  const opened = await ev(() => ({ urls: window.__opened, page: window.__p2like.app.creditsPage, scene: window.__p2like.scene().constructor.name }));
  check('クレジット：左右でページ切替、URLを選んで決定で外部ブラウザ（window.open）、ページ位置を維持', opened.urls.join() === 'https://x.com/Vno_kotaro' && opened.page === 1 && opened.scene === 'CreditsScene', JSON.stringify(opened));
  await key('Escape', 200);
  await key('Escape', 200);
  await ev(() => (window.__p2like.scene().stack[0].cursor = 3));
  await key('Enter');
  check('遊び方画面', (await sceneName()) === 'HelpScene');
  await shot('S25_help');
  await key('Escape');
  // 設定初期化の確認
  await ev(() => (window.__p2like.scene().stack[0].cursor = 2));
  await key('Enter');
  for (let i = 0; i < 5; i++) await key('ArrowDown');
  await key('Enter', 200);
  await shot('S26_confirm_reset');
  check('設定初期化の確認ダイアログ', (await ev(() => window.__p2like.scene().confirmReset)) === 0);
  await key('Escape');
  await toMenu();

  // ---- BGM：画面遷移で不要な再始動なし、ループ再生 ----
  const bgmAll = await ev(() => window.__p2like.bus.nodes.filter((n) => n.kind === 'bgm').map((n) => ({ ...n })));
  if (!allowMissingBgm || bgmPresent.length === 3) {
    check('BGM：すべてループ再生（複数周）', bgmAll.length > 0 && bgmAll.every((n) => n.loop), JSON.stringify(bgmAll.map((n) => [n.id, n.loop])));
  }

  // ---- 表示倍率（B6）：DPR 1／1.25／1.5／2、固定1〜4、収まる最大、無効倍率、縮小、DPR変更、緊急縮小 ----
  const scaleOf = (pg) =>
    ev(
      () => {
        const c = document.getElementById('screen');
        return { n: Number(c.dataset.scale), mode: c.dataset.scaleMode, bufW: c.width, cssW: parseFloat(c.style.width), dpr: devicePixelRatio, setting: window.__p2like.app.settings.display.scale };
      },
      undefined,
      pg,
    );
  const scaleRows = [];
  for (const dpr of [1, 1.25, 1.5, 2]) {
    const cx = await newContext({ deviceScaleFactor: dpr });
    const pg = await cx.newPage();
    watch(pg);
    await pg.goto(`http://127.0.0.1:${PORT}/`);
    await pg.waitForSelector('body[data-ready]');
    await wait(200, pg);
    const fit = await scaleOf(pg);
    const expect = Math.floor(Math.min((1280 * dpr) / 640, (720 * dpr) / 360) + 1e-9);
    const fixed = [];
    for (const k of [1, 2, 3, 4]) {
      await ev((k) => {
        const a = window.__p2like.app;
        a.settings.display.scale = k;
        a.deps.applyDisplay(a.settings.display);
      }, k, pg);
      await wait(80, pg);
      fixed.push({ k, ...(await scaleOf(pg)) });
    }
    const okFixed = fixed.every((f) => (f.k <= expect ? f.mode === 'fixed' && f.n === f.k && f.bufW === 640 * f.k && Math.abs(f.cssW - (640 * f.k) / dpr) < 0.01 : f.mode === 'fit' && f.setting === 0));
    scaleRows.push({ dpr, fit, fixed });
    check(
      `B6 DPR ${dpr}：収まる最大＝実画素${expect}倍（バッファ${640 * expect}・CSS ${(640 * expect) / dpr}px）。固定1〜4倍は収まるものだけ実画素で採用、収まらない倍率は「収まる最大」へ明示切替`,
      fit.mode === 'fit' && fit.n === expect && fit.bufW === 640 * expect && Math.abs(fit.cssW - (640 * expect) / dpr) < 0.01 && okFixed,
      JSON.stringify({ fit, fixed: fixed.map((f) => [f.k, f.mode, f.n, f.setting]) }),
    );
    if (dpr === 1.25) {
      await ev(() => {
        const a = window.__p2like.app;
        a.settings.display.scale = 2;
        a.deps.applyDisplay(a.settings.display);
      }, undefined, pg);
      await shot('B6_dpr1.25_fixed2', pg);
    }
    await cx.close();
  }
  // ウィンドウ縮小：固定3倍 → 1280×720 では収まらず「収まる最大」へ明示切替（通知）
  await page.setViewportSize({ width: 1920, height: 1080 });
  await wait(200);
  await ev(() => {
    const a = window.__p2like.app;
    a.settings.display.scale = 3;
    a.deps.applyDisplay(a.settings.display);
  });
  await wait(100);
  const big = await scaleOf(page);
  await page.setViewportSize({ width: 1280, height: 720 });
  await wait(250);
  const shrunk = await scaleOf(page);
  await shot('B6_switched_to_fit_notice');
  check('ウィンドウ縮小で固定3倍が収まらなくなると「収まる最大」（2倍）へ切替え、設定も0へ（スクロールなし）', big.mode === 'fixed' && big.n === 3 && shrunk.mode === 'fit' && shrunk.n === 2 && shrunk.setting === 0, JSON.stringify({ big, shrunk }));
  // DPR変更（CDP で devicePixelRatio を 1→2）
  const cdp = await context.newCDPSession(page);
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 2, mobile: false });
  await wait(300);
  const d2 = await scaleOf(page);
  await cdp.send('Emulation.clearDeviceMetricsOverride');
  await wait(300);
  check('DPR変更（1→2）を検知して実画素倍率を選び直す（収まる最大＝4倍・CSS 1280px）', d2.dpr === 2 && d2.n === 4 && d2.bufW === 2560 && Math.abs(d2.cssW - 1280) < 0.01, JSON.stringify(d2));
  // 緊急縮小
  await page.setViewportSize({ width: 500, height: 300 });
  await wait(250);
  const em = await scaleOf(page);
  await shot('B6_emergency');
  check('1倍も収まらない時だけ緊急縮小（通知あり）', em.mode === 'emergency' && em.bufW === 640 && em.cssW < 640, JSON.stringify(em));
  await page.setViewportSize({ width: 1280, height: 720 });
  await wait(250);
  // 全画面切替（ヘッドレス Chromium での要求可否のみ。実ブラウザの全画面表示は未検証）
  const fs = await ev(async () => {
    try {
      await document.documentElement.requestFullscreen();
      await new Promise((r) => setTimeout(r, 200));
      const on = !!document.fullscreenElement;
      await document.exitFullscreen();
      await new Promise((r) => setTimeout(r, 200));
      return { on, off: !document.fullscreenElement, mode: document.getElementById('screen').dataset.scaleMode };
    } catch (e) {
      return { error: String(e) };
    }
  });
  check('全画面の切替（ヘッドレスでの要求・解除と倍率再計算。実機の全画面表示は未検証）', fs.on && fs.off && fs.mode === 'fit', JSON.stringify(fs));

  // 描画ループ
  const fps = await ev(
    () =>
      new Promise((ok) => {
        let n = 0;
        const t0 = performance.now();
        const f = () => (++n, performance.now() - t0 < 1000 ? requestAnimationFrame(f) : ok(n));
        requestAnimationFrame(f);
      }),
  );
  check('描画ループ稼働', fps > 20, `fps≒${fps}`);
  const au = await ev(() => ({ missing: [...window.__p2like.bus.missing], decoded: window.__p2like.bus.decodedCount, state: window.__p2like.bus.ctx?.state }));
  if (allowMissingBgm)
    check(`［フォールバック］音声：未配置はBGMのみ、SE・ボイス${NON_BGM}本はデコード成功`, au.missing.every((f) => f.startsWith('bgm/')) && au.missing.length === 3 - bgmPresent.length && au.decoded === NON_BGM + bgmPresent.length, JSON.stringify(au));
  else check(`［納品］音声：必須${REQUIRED_AUDIO}本すべてデコード成功・欠落なし`, au.missing.length === 0 && au.decoded === REQUIRED_AUDIO && au.state === 'running', JSON.stringify(au));
  const allLog = await ev(() => window.__p2like.bus.log.map((e) => e.id));
  check('旧成功音・旧成立音・連鎖音は一度も要求されない（新旧SEの二重発音なし）', !allLog.some((id) => OLD_SFX.includes(id)));
  writeFileSync(new URL('scale.json', OUT), JSON.stringify(scaleRows, null, 1));
} catch (e) {
  check('E2E実行', false, String(e?.stack ?? e));
}

const allowed404 = (p) => (allowMissingBgm && BGM.some((f) => p.endsWith(`/assets/audio/bgm/${f}`))) || (MODE === 'fallback' && !STANDIN && p.endsWith('/gfx/fonts/NotoSansJP-VF.ttf'));
const bad = responses.filter(([s, p]) => s >= 400 && !allowed404(p));
const errs = consoleErrors.filter((m) => !(MODE === 'fallback' && m.includes('404')));
const note = MODE === 'fallback' ? '（フォールバック：BGM・フォント未配置の404を除く）' : '';
check(`コンソールエラー/警告なし${note}`, errs.length === 0, errs.join(' | '));
const failed2 = failedRequests.filter((r) => !allowed404(new URL(r.split(' ')[0]).pathname));
check(`ネットワーク失敗・4xx/5xxなし${note}`, failed2.length === 0 && bad.length === 0, [...failed2, ...bad.map((r) => r.join(' '))].join(' | '));

writeFileSync(
  new URL('report.json', OUT),
  JSON.stringify({ date: new Date().toISOString(), mode: MODE, root: ROOT, bgmPresent, fontPresent, fontStandin: !!STANDIN, simulatedInputOnly: true, results, screenshots: shots }, null, 2),
);
await browser.close();
server.kill();
const failed = results.filter((r) => !r.pass);
console.log(`\n[${MODE === 'release' ? '納品検査' : 'フォールバック検査（納品合格ではない）'}${STANDIN ? '・フォント代用' : ''}] ${results.length - failed.length}/${results.length} PASS`);
process.exit(failed.length ? 1 : 0);
