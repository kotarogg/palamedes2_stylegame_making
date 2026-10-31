// V320-MEASURE-01 計測用テストビルドのブラウザ検査（模擬ゲームパッド。実パッドの確認ではない）。
// 使い方：npm run build:measure && npm run build の後に node scripts/e2e-measure01.mjs（フォールバック時は E2E_FONT_STANDIN）
// navigator.getGamepads を検査用の模擬パッドへ差し替え、パッドの START→確認画面→「計測開始」、ゲーム操作、停止、計測メニューから保存までを通す。
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { installFontStandin } from './font-standin.mjs';

const PORT = Number(process.env.E2E_PORT ?? 8771);
const OUT = new URL('../docs/measure01/', import.meta.url);
mkdirSync(new URL('screens/', OUT), { recursive: true });
const STANDIN = !existsSync(join('dist-measure', 'gfx/fonts/NotoSansJP-VF.ttf')) ? (process.env.E2E_FONT_STANDIN ?? null) : null;

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass: !!pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${String(detail).slice(0, 500)})` : ''}`);
};

async function serve(root, port) {
  const server = spawn(process.execPath, ['scripts/serve.mjs', root, String(port)], { stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((ok, ng) => {
    server.stdout.on('data', (d) => String(d).includes('配信中') && ok());
    server.on('exit', (c) => ng(new Error(`server exited ${c}`)));
  });
  return server;
}

const FAKE_PAD = () => {
  const mk = () => ({ pressed: false, touched: false, value: 0 });
  const pad = { id: 'E2E Fake Pad (STANDARD GAMEPAD Vendor: 0000 Product: 0000)', index: 0, connected: true, mapping: 'standard', timestamp: 0, buttons: Array.from({ length: 17 }, mk), axes: [0, 0, 0, 0] };
  window.__fakePad = {
    pad,
    set(i, on) {
      pad.buttons[i] = { pressed: on, touched: on, value: on ? 1 : 0 };
      pad.timestamp = performance.now();
    },
    axis(i, v) {
      pad.axes[i] = v;
      pad.timestamp = performance.now();
    },
  };
  navigator.getGamepads = () => [pad, null, null, null];
};

const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const shots = [];
const errors = [];

// ---- 計測用ビルド ----
{
  const server = await serve('dist-measure', PORT);
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1, acceptDownloads: true });
  if (STANDIN) await installFontStandin(context, STANDIN);
  await context.addInitScript(FAKE_PAD);
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && !m.text().startsWith('Failed to load resource') && errors.push(m.text()));
  page.on('response', (r) => r.status() >= 400 && !new URL(r.url()).pathname.includes('/assets/audio/bgm/') && errors.push(`${r.status()} ${r.url()}`));
  await page.goto(`http://127.0.0.1:${PORT}/`);
  await page.waitForSelector('body[data-ready]');
  await page.waitForTimeout(600);
  const ev = (fn, arg) => page.evaluate(fn, arg);
  const shot = async (name) => {
    const png = await ev(() => {
      const c = document.createElement('canvas');
      c.width = 640;
      c.height = 360;
      const x = c.getContext('2d');
      x.imageSmoothingEnabled = false;
      const src = document.getElementById('screen');
      x.drawImage(src, 0, 0, 640, 360);
      return c.toDataURL('image/png');
    });
    writeFileSync(new URL(`screens/${name}.png`, OUT), Buffer.from(png.split(',')[1], 'base64'));
    shots.push(`docs/measure01/screens/${name}.png`);
  };
  const press = async (i, ms = 80) => {
    await ev((i) => window.__fakePad.set(i, true), i);
    await page.waitForTimeout(ms);
    await ev((i) => window.__fakePad.set(i, false), i);
    await page.waitForTimeout(60);
  };

  const info = await ev(() => ({ title: document.title, measure: !!window.__p2like.measure, state: window.__p2like.measure?.state, profile: window.__p2like.measure?.profile, build: window.__p2like.measure?.build }));
  check('計測用ビルド：記録器あり・未計測・打上硬直の初期選択B・タイトルに計測用の表記・ビルドにコミット', info.measure && info.state === 'idle' && info.profile === 'B' && /計測用/.test(info.title) && /^[0-9a-f]{40}$/.test(info.build.commit), JSON.stringify(info));

  // タイトル→メニュー→「計測（テスト）」（パッドの十字キー・A）
  await press(0);
  await page.waitForTimeout(300);
  const menuItems = await ev(() => window.__p2like.scene().constructor.name);
  for (let i = 0; i < 5; i++) await press(13);
  await press(0);
  await page.waitForTimeout(200);
  const sc = await ev(() => ({ name: window.__p2like.scene().constructor.name, rows: window.__p2like.scene().rows?.().map((r) => `${r.label}:${r.value ?? ''}`) }));
  await shot('M01_measure_menu');
  check('メインメニューに「計測（テスト）」：パッドで開ける。開始前設定（打上硬直B：200＋50ms・15tick）を確認できる', menuItems === 'MenuScene' && sc.name === 'MeasureMenuScene' && sc.rows[0].includes('B：200＋50ms（15tick）'), JSON.stringify(sc));
  // 左右で A へ切替 → 戻して B
  await press(15);
  const a = await ev(() => window.__p2like.measure.profile);
  await press(14);
  const b = await ev(() => window.__p2like.measure.profile);
  check('打上硬直設定を左右で A／B に切り替えられる（初期B）', a === 'A' && b === 'B', `${a}→${b}`);
  await press(1); // B＝戻る

  // 1Pをゲームパッドにして MODE1 CPU対戦を開始
  await ev(() => {
    const app = window.__p2like.app;
    app.settings.devices[0] = { kind: 'gamepad', index: 0 };
    app.settings.npcLevel = 'easy';
    app.startGame('mode1', 'cpu');
  });
  await page.waitForTimeout(3600); // 開始前待機＋READY／GO
  const cfg = await ev(() => {
    const g = window.__p2like.game();
    return { launch: g.t.launchMs, pack: g.t.packMs, cfg: [g.config.timing.launchMs, g.config.timing.packMs], profile: window.__p2like.gameScene().measureProfile };
  });
  check('開始した試合へ B を適用：飛行12tick・列詰め3tick（設定 200／50ms）', cfg.launch === 12 && cfg.pack === 3 && cfg.cfg.join() === '200,50' && cfg.profile === 'B', JSON.stringify(cfg));

  // START → 確認画面 → 右 → A＝「計測開始」
  await press(9);
  await page.waitForTimeout(100);
  const dlg = await ev(() => ({ quit: window.__p2like.gameScene().quit.length, choices: window.__p2like.gameScene().dialogChoices() }));
  await shot('M01_pause_dialog_start');
  await press(15);
  await press(0);
  await page.waitForTimeout(100);
  const started = await ev(() => ({ state: window.__p2like.measure.state, quit: window.__p2like.gameScene().quit.length, sid: window.__p2like.measure.sessionId }));
  check('プレイ中：START の確認画面に「計測開始」（続ける／計測開始／終了する）。パッドで選んで計測開始、確認は閉じる', dlg.quit === 1 && dlg.choices.join() === '続ける,計測開始,終了する' && started.state === 'recording' && started.quit === 0 && /^M01-\d{8}-\d{6}-[0-9a-f]{4}$/.test(started.sid), JSON.stringify({ dlg, started }));

  // ゲーム操作：A（発射）を短く数回、A を押しっぱなし、左を押しっぱなし（反復）、スティック右
  for (let i = 0; i < 4; i++) await press(0, 60);
  await ev(() => window.__fakePad.set(0, true));
  await page.waitForTimeout(900);
  await ev(() => window.__fakePad.set(0, false));
  await ev(() => window.__fakePad.set(14, true));
  await page.waitForTimeout(700);
  await ev(() => window.__fakePad.set(14, false));
  await ev(() => window.__fakePad.axis(0, 0.3));
  await page.waitForTimeout(100);
  await ev(() => window.__fakePad.axis(0, 0.9));
  await page.waitForTimeout(100);
  await ev(() => window.__fakePad.axis(0, 0.0));
  await page.waitForTimeout(200);
  await shot('M01_playing_overlay');
  // フォーカス喪失・復帰
  await ev(() => {
    window.dispatchEvent(new Event('blur'));
    window.dispatchEvent(new Event('focus'));
  });
  // パッドの切断・接続（イベントの記録）
  await ev(() => {
    const e1 = new Event('gamepaddisconnected');
    Object.defineProperty(e1, 'gamepad', { value: window.__fakePad.pad });
    window.dispatchEvent(e1);
    const e2 = new Event('gamepadconnected');
    Object.defineProperty(e2, 'gamepad', { value: window.__fakePad.pad });
    window.dispatchEvent(e2);
  });
  // ラウンドをまたぐ：2Pを強制的に敗北させて次のラウンドへ（記録が続くこと）
  await ev(() => {
    const g = window.__p2like.game();
    g.players[1].defeated = true;
  });
  await page.waitForTimeout(400);
  // ラウンド結果 → 次のラウンド（決定の受付が可能になってから決定を1回。A の連打で試合結果のメニューを選ばない）
  const trail = [];
  for (let i = 0; i < 80; i++) {
    await page.waitForTimeout(150);
    const st = await ev(() => {
      const s = window.__p2like.gameScene();
      if (!s) return { scene: window.__p2like.scene().constructor.name };
      return { state: s.session.state, round: s.session.round, ready: s.staging.acceptReady };
    });
    trail.push(st.state ?? st.scene);
    if (!st.state || (st.state === 'round' && st.round >= 2)) break;
    if (st.state === 'roundResult' && st.ready) await ev(() => (window.__p2like.gameScene().confirmQueued = true));
  }
  console.log('round trail', [...new Set(trail)].join('>'));
  await page.waitForTimeout(3500);
  for (let i = 0; i < 3; i++) await press(0, 60);
  // START → 右 → A＝「計測停止」
  await press(9);
  await press(15);
  const dlg2 = await ev(() => window.__p2like.gameScene().dialogChoices());
  await press(0);
  await page.waitForTimeout(100);
  const stopped = await ev(() => ({ state: window.__p2like.measure.state, count: window.__p2like.measure.count, unsaved: window.__p2like.measure.unsaved, round: window.__p2like.gameScene().session.round }));
  check('確認画面の「計測停止」で停止（記録は保持・未保存）。ラウンドをまたいで記録', dlg2.join() === '続ける,計測停止,終了する' && stopped.state === 'stopped' && stopped.count > 100 && stopped.unsaved && stopped.round >= 2, JSON.stringify({ dlg2, stopped }));

  // メニューへ戻っても記録は残る → 計測メニューから保存
  await ev(() => window.__p2like.app.toMenu());
  await page.waitForTimeout(200);
  const kept = await ev(() => window.__p2like.measure.count);
  await ev(() => {
    const app = window.__p2like.app;
    // メニューの「計測（テスト）」へ（パッド操作は上で確認済み）
    for (let i = 0; i < 5; i++) app.scene.onNav({ key: 'down', source: { kind: 'keyboard' }, repeat: false });
    app.scene.onNav({ key: 'confirm', source: { kind: 'keyboard' }, repeat: false });
    for (let i = 0; i < 4; i++) app.scene.onNav({ key: 'down', source: { kind: 'keyboard' }, repeat: false });
  });
  await page.waitForTimeout(200);
  await shot('M01_measure_menu_stopped');
  const dl = page.waitForEvent('download');
  await press(0); // 「記録を保存」
  const download = await dl;
  const file = new URL(`saved_${download.suggestedFilename()}`, OUT);
  await download.saveAs(file.pathname);
  const savedState = await ev(() => ({ saved: window.__p2like.measure.saved, unsaved: window.__p2like.measure.unsaved, count: window.__p2like.measure.count }));
  check('メニューへ戻っても記録は消えない。「記録を保存」でローカルへダウンロード（ファイル名にセッションID）、保存後も記録を保持', kept === stopped.count && download.suggestedFilename() === `kotaro_measure_${started.sid}.json` && savedState.saved && !savedState.unsaved && savedState.count === kept, JSON.stringify({ kept, name: download.suggestedFilename(), savedState }));

  // 保存ファイルの検査
  const json = JSON.parse(readFileSync(file, 'utf8'));
  const recs = json.records;
  const by = (e) => recs.filter((r) => r.e === e);
  const seqOk = recs.every((r, i) => r.s === i) && recs.every((r, i) => i === 0 || r.t >= recs[i - 1].t);
  check('保存ファイル：形式・形式バージョン・ビルド（mode・コミット）・セッション・設定（A／Bの ms と tick）を含み、記録の連番・時刻が単調', json.header.format === 'kotaro-puzzle-measure' && json.header.formatVersion === 1 && json.header.build.mode === 'measure' && json.header.session.id === started.sid && json.header.settings.profiles.B.successLockTicks === 15 && json.header.settings.profiles.A.successLockTicks === 25 && seqOk, JSON.stringify({ header: { ...json.header, settings: undefined }, n: recs.length }));
  const rounds = [...new Set(recs.filter((r) => r.e === 'roundStart').map((r) => r.r))];
  const kBack = recs.some((r, i) => i > 0 && r.k !== null && recs[i - 1].k !== null && r.r > recs[i - 1].r && r.k < recs[i - 1].k);
  check('ラウンド変更：roundStart が2回以上、ラウンドが変わって k が戻っても s・t で全体の順序を保持', rounds.length >= 2 && kBack, JSON.stringify({ rounds }));
  const padCmds = by('cmd').filter((r) => r.d.src === 'pad');
  const launchPress = by('padBtn').filter((r) => r.d.b === 0 && r.d.p === 1).length;
  const launchCmds = padCmds.filter((r) => r.d.a === 'launch' && !r.d.rep).length;
  const leftRep = padCmds.filter((r) => r.d.a === 'left' && r.d.rep === 1).length;
  const leftNew = padCmds.filter((r) => r.d.a === 'left' && !r.d.rep).length;
  check('押しっぱなしを連打と誤計測しない：A の押下（padBtn）と発射コマンドの新規件数が対応、左の押しっぱなしは新規1・反復複数（rep＝1）', launchCmds > 0 && launchCmds <= launchPress && leftNew >= 1 && leftRep >= 2, JSON.stringify({ launchPress, launchCmds, leftNew, leftRep }));
  const ins = by('in');
  const kinds = [...new Set(ins.map((r) => `${r.d.kind}:${r.d.reason ?? ''}`))];
  const linked = ins.filter((r) => r.d.id !== null && padCmds.some((c) => c.d.id === r.d.id)).length;
  check('入力の追跡：パッドのコマンドID と結果（execute／reject・理由）が対応付く', linked > 0 && kinds.some((k) => k.startsWith('execute')) && ins.some((r) => r.d.kind === 'reject' || r.d.kind === 'drop'), JSON.stringify(kinds));
  const dialogDrops = by('cmdDrop').filter((r) => r.d.reason === 'dialog' || r.d.reason === 'result' || r.d.reason === 'prestart');
  check('ゲームへ渡さなかった入力も理由付き（確認画面中・結果表示中・開始前待機）', dialogDrops.length > 0, JSON.stringify([...new Set(dialogDrops.map((r) => r.d.reason))]));
  const pads = { info: by('padInfo').length, axis: by('padAxis').map((r) => r.d.v), dir: by('padDir').map((r) => r.d.dir), conn: by('padConnected').length + by('padDisconnected').length };
  check('パッド：識別情報・mapping、スティックの生値（0.3→0.9→0）と方向判定（0.5 閾値で→と中立）、接続／切断を記録', pads.info >= 1 && pads.axis.includes(0.3) && pads.axis.includes(0.9) && pads.dir.includes(1) && pads.dir.includes(0) && pads.conn === 2 && by('padInfo')[0].d.mapping === 'standard', JSON.stringify(pads));
  const vis = by('visibility').map((r) => r.d.cause);
  check('フォーカス喪失・復帰を記録（記録は破損しない）', vis.includes('blur') && vis.includes('focus') && seqOk, JSON.stringify(vis));
  const st = by('st').length;
  const evs = [...new Set(by('ev').map((r) => r.d.type))];
  const snaps = by('snapshot').length + by('roundStart').length;
  check('盤面・状態：ラウンド開始の全体（設定・tick換算・盤面）、状態の差分、ゲームイベント（移動・発射・到達など）', st > 20 && snaps >= 2 && ['move', 'launch', 'arrive'].every((x) => evs.includes(x)) && by('roundStart')[0].d.timingTicks.launchMs === 12, JSON.stringify({ st, snaps, evs }));
  const ms = by('matchStart')[0]?.d;
  check('試合の記録：モード・キャラクター・seed・難易度・適用した設定（B）', ms && ms.mode === 'mode1' && ms.kind === 'cpu' && ms.profile === 'B' && typeof ms.seed === 'number' && ms.profileReport.successLockTicks === 15, JSON.stringify(ms));

  // 初期化：未保存の再計測は確認、保存済みは確認なし
  const clear = await ev(() => {
    const m = window.__p2like.measure;
    const app = window.__p2like.app;
    const sc = app.scene;
    m.start();
    m.stop();
    const unsavedBefore = m.unsaved;
    sc.cursor = 5;
    sc.onNav({ key: 'confirm', source: { kind: 'keyboard' }, repeat: false });
    const dialog = sc.confirmClear;
    sc.onNav({ key: 'confirm', source: { kind: 'keyboard' }, repeat: false }); // 「やめる」
    const kept = m.count;
    sc.cursor = 5;
    sc.onNav({ key: 'confirm', source: { kind: 'keyboard' }, repeat: false });
    sc.onNav({ key: 'right', source: { kind: 'keyboard' }, repeat: false });
    sc.onNav({ key: 'confirm', source: { kind: 'keyboard' }, repeat: false }); // 「初期化する」
    return { unsavedBefore, dialog, kept, after: m.count, state: m.state };
  });
  check('未保存の状態で初期化すると確認を表示（やめる＝保持、初期化する＝消去して未計測）', clear.unsavedBefore && clear.dialog === 0 && clear.kept > 0 && clear.after === 0 && clear.state === 'idle', JSON.stringify(clear));
  await context.close();
  server.kill();
}

// ---- 通常ビルド：計測の記録器・表示が無い ----
{
  const server = await serve('dist', PORT + 1);
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  if (STANDIN) await installFontStandin(context, STANDIN);
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${PORT + 1}/`);
  await page.waitForSelector('body[data-ready]');
  const r = await page.evaluate(() => ({ measure: !!window.__p2like.measure, appMeasure: window.__p2like.app.measure, title: document.title }));
  check('通常ビルド：記録器なし（app.measure＝null）・計測の表記なし', !r.measure && r.appMeasure === null && !/計測/.test(r.title), JSON.stringify(r));
  await context.close();
  server.kill();
}

writeFileSync(new URL('e2e_report_MEASURE-01.json', OUT), JSON.stringify({ id: 'V320-MEASURE-01', simulatedPad: true, fontStandin: !!STANDIN, results, shots, errors }, null, 1));
console.log(`${results.filter((x) => x.pass).length}/${results.length} passed; errors=${errors.length}`, errors.slice(0, 5));
await browser.close();
process.exit(results.every((x) => x.pass) && !errors.length ? 0 : 1);
