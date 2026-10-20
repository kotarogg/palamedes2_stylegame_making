// ブラウザ実機確認（ビルド済み dist を配信し、Chromiumで操作・画素照合・音声ログ・スクリーンショット・エラー収集）
// 使い方: npm run build && npm run e2e
//   E2E_ROOT=<展開した配布物のwww> で配布物そのものを検証できる。
//   BGM（3曲）が配信物に無い環境では、その3件の404だけを「素材未配置」として許容し、結果に明記する。
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright-core';

const PORT = Number(process.env.E2E_PORT ?? 8765);
const ROOT = process.env.E2E_ROOT ?? 'dist';
const OUT = new URL('../test-results/e2e/', import.meta.url);
rmSync(OUT, { recursive: true, force: true }); // 前回の画像を残さない
mkdirSync(OUT, { recursive: true });

const BGM = ['bgm_menu.wav', 'bgm_puzzle_single.wav', 'bgm_puzzle_versus.wav'];
const bgmPresent = BGM.filter((f) => existsSync(join(ROOT, 'assets/audio/bgm', f)));

const server = spawn(process.execPath, ['scripts/serve.mjs', ROOT, String(PORT)], { stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((ok, ng) => {
  server.stdout.on('data', (d) => String(d).includes('配信中') && ok());
  server.on('exit', (c) => ng(new Error(`server exited ${c}`)));
});

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass: !!pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};

const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
// ゲームパッドの模擬（navigator.getGamepads を差し替え、window.__pad で押下状態を操作）
await context.addInitScript(() => {
  const mk = () => ({ id: 'mock pad', index: 0, connected: true, buttons: Array.from({ length: 17 }, () => ({ pressed: false, value: 0 })), axes: [0, 0, 0, 0] });
  window.__pad = mk();
  window.__padOn = false;
  navigator.getGamepads = () => [window.__padOn ? window.__pad : null, null, null, null];
});
const page = await context.newPage();
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
const key = async (k, ms = 120) => {
  await page.keyboard.press(k);
  await wait(ms);
};
const sceneName = () => ev(() => window.__p2like.scene().constructor.name);
const toMenu = () => ev(() => window.__p2like.app.toMenu());
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
const audioLog = () => ev(() => window.__p2like.bus.log.map((e) => ({ ...e })));
const logMark = () => ev(() => window.__p2like.bus.log.length);
const logSince = (n) => ev((n) => window.__p2like.bus.log.slice(n).map((e) => ({ ...e })), n);

// 画素照合：スプライトの不透明画素がキャンバス上の指定座標と一致するか
const pixelHelper = `
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
  await page.goto(`http://127.0.0.1:${PORT}/`);
  await page.waitForSelector('body[data-ready]');
  check('起動（画像・JSON・音声読込）→メインメニュー', (await ev(() => document.body.dataset.ready)) === '1' && (await sceneName()) === 'MenuScene');
  await page.addScriptTag({ content: pixelHelper });

  // ---- 素材 ----
  const ok = (ext) => responses.filter(([s, p]) => p.endsWith(ext) && s === 200).map(([, p]) => p);
  const pngs = ok('.png');
  const jsons = ok('.json');
  check(
    '読み込み許可リストの13枚（12シート＋メニュー背景）だけを取得、JSON3件',
    pngs.length === 13 && pngs.some((p) => p.endsWith('menu_background.png')) && jsons.length === 3,
    `png=${pngs.length} json=${jsons.map((p) => p.split('/').pop()).join(',')}`,
  );
  const wavs = ok('.wav');
  check('音声：効果音30＋ボイス46（計76）を取得', wavs.filter((p) => !p.includes('/bgm/')).length === 76, `wav200=${wavs.length}`);
  check(
    `BGM 3曲（配信物に存在${bgmPresent.length}曲）`,
    bgmPresent.length === 3 ? wavs.filter((p) => p.includes('/bgm/')).length === 3 : true,
    bgmPresent.length === 3 ? 'BGM取得' : `未配置${3 - bgmPresent.length}曲は404を許容（無音で継続）`,
  );
  const ver = await ev(() => window.__p2like.app.assets.atlas.manifest.version);
  check('マニフェスト内部version 2.3', ver === '2.3', ver);
  const size = await ev(() => [document.getElementById('screen').style.width, document.getElementById('screen').width]);
  check('論理640×360を整数倍(2倍)で表示', size[0] === '1280px' && size[1] === 640, size.join(' / '));
  const rendering = await ev(() => getComputedStyle(document.getElementById('screen')).imageRendering);
  check('拡大時にドットを滲ませない(image-rendering)', rendering === 'pixelated', rendering);

  // ---- メニュー（キーボード） ----
  await wait(200);
  await shot('menu');
  const cur = await ev(() => window.__cmp('S8', 'selection_cursor', 177, 115));
  check('メニューの選択カーソル（S8）座標(177,115)', cur.bad === 0 && cur.opaque > 0, JSON.stringify(cur));
  let m0 = await logMark();
  await key('ArrowDown');
  await key('ArrowUp');
  const uiLog = await logSince(m0);
  check('メニュー移動でUI効果音（初回操作で音声を有効化）', uiLog.some((e) => e.kind === 'sfx' && e.id === 'ui_move' && !e.skipped), JSON.stringify(uiLog.map((e) => `${e.id}:${e.skipped ?? 'ok'}`)));
  const bgmMenu = (await audioLog()).filter((e) => e.kind === 'bgm' && !e.skipped).map((e) => e.id);
  check('メニューBGM（menu）を要求', bgmMenu.includes('menu'), bgmMenu.join(','));

  // ---- オプション：音量変更と保存 ----
  await key('ArrowDown');
  await key('ArrowDown'); // MODE1, MODE2, オプション
  await key('Enter');
  check('オプション画面へ', (await sceneName()) === 'OptionsScene');
  await key('Enter'); // 音
  await key('ArrowLeft'); // BGM 100→90
  await shot('options_audio');
  const saved = await ev(() => JSON.parse(localStorage.getItem('palamedes2-like.settings.v2') ?? '{}').audio?.bgm);
  check('音量変更（BGM 100→90）が設定に保存される', saved === 90, String(saved));
  await key('ArrowRight');
  await toMenu();
  await wait(100);

  // ---- ゲームパッド模擬でメニュー操作 ----
  await ev(() => (window.__padOn = true));
  const pad = async (btn, ms = 120) => {
    await ev((b) => (window.__pad.buttons[b].pressed = true), btn);
    await wait(80);
    await ev((b) => (window.__pad.buttons[b].pressed = false), btn);
    await wait(ms);
  };
  await pad(13); // 十字下 → MODE2
  await pad(0); // A → MODE2 サブメニュー
  await pad(1); // B → 戻る
  const padNav = await ev(() => window.__p2like.scene().stack?.length ?? -1);
  await pad(12); // 十字上 → MODE1
  await pad(0);
  const padNav2 = await ev(() => window.__p2like.scene().stack?.length ?? -1);
  check('ゲームパッド（十字・A・B）でメニュー操作', padNav === 1 && padNav2 === 2, `${padNav} → ${padNav2}`);
  await ev(() => (window.__padOn = false));

  // ---- MODE1 CPU対戦（キーボードで開始） ----
  m0 = await logMark();
  await key('ArrowDown'); // シングル → CPU対戦
  await key('Enter', 300);
  const kind = await ev(() => [window.__p2like.scene().constructor.name, window.__p2like.gameScene()?.kind, window.__p2like.game()?.mode]);
  check('MODE1 › CPU対戦を開始', kind.join() === 'GameScene,cpu,mode1', kind.join());
  await wait(400);
  await shot('cpu_ready');
  const startLog = await logSince(m0);
  check('READY：CPU対戦の担当は相手（アカネ）・ready効果音', startLog.some((e) => e.id === 'akane_ready' && e.channel === 'announce') && startLog.some((e) => e.id === 'ready'), startLog.map((e) => e.id).join(','));
  check('対戦BGM（versus）を要求', startLog.some((e) => e.kind === 'bgm' && e.id === 'versus'));
  await page.waitForFunction(() => window.__p2like.game().playing, null, { timeout: 8000 });
  const goLog = await logSince(m0);
  check('GO：アカネ go 音声', goLog.some((e) => e.id === 'akane_go'));

  // 段階的な攻撃：5ライン注入→1波目3ライン（0/200/400ms）
  const atk = await ev(() => {
    const sc = window.__p2like.gameScene();
    const g = sc.game;
    const h0 = null;
    sc.debugQueue.push({ player: 0, type: 'debugAttack', lines: 5 }); // 1Pが5ライン受信
    const startTick = g.tick;
    const from = g.events.length;
    for (let i = 0; i < 60 * 4; i++) sc.step();
    const evs = g.events.slice(from).filter((e) => e.player === 0 && (e.type === 'waveStart' || e.type === 'attackRow'));
    return { h0, startTick, evs: evs.map((e) => ({ type: e.type, tick: e.tick, waveId: e.waveId, lines: e.lines, step: e.step, applied: e.applied })) };
  });
  const wave = atk.evs.find((e) => e.type === 'waveStart');
  const rows = atk.evs.filter((e) => e.type === 'attackRow' && e.waveId === wave?.waveId);
  const gaps = rows.map((r) => r.tick - (wave?.tick ?? 0));
  check(
    '段階攻撃：1波は最大3ライン、0/200/400ms（0/12/24tick）で1段ずつ',
    wave?.lines === 3 && gaps.join() === '0,12,24',
    `wave=${JSON.stringify(wave)} rowsΔtick=${gaps.join(',')} applied=${rows.map((r) => r.applied).join(',')}`,
  );
  await wait(300);
  const atkLog = await audioLog();
  check('攻撃段の効果音（attack_row）', atkLog.some((e) => e.id === 'attack_row'));
  await shot('cpu_after_attack');

  // 終了確認：ゲームは止まらない
  const t0 = await ev(() => window.__p2like.game().tick);
  await key('Escape', 500);
  const dlg = await ev(() => [window.__p2like.gameScene().quit.length, window.__p2like.game().tick]);
  await shot('quit_dialog');
  check('Esc：終了確認ダイアログ、確認中もゲームは進行（一時停止なし）', dlg[0] === 1 && dlg[1] > t0 + 10, `dialog=${dlg[0]} tick ${t0}→${dlg[1]}`);
  await key('Enter'); // 「続ける」
  check('「続ける」でダイアログを閉じる', (await ev(() => window.__p2like.gameScene().quit.length)) === 0);

  // 勝敗演出：1Pを放置して決着まで進める
  m0 = await logMark();
  const n = await steps(60 * 600, 'sc.game.result');
  await wait(2500);
  const res = await ev(() => {
    const g = window.__p2like.game();
    return { outcome: g.result?.outcome, winner: g.result?.winner };
  });
  const resLog = (await logSince(m0)).filter((e) => e.kind === 'voice' && e.channel === 'result');
  await shot('round_result');
  const order = resLog.map((e) => e.id);
  const loser = res.winner === 0 ? 'akane' : 'kotaro';
  const winner = res.winner === 0 ? 'kotaro' : 'akane';
  check(
    '勝敗演出：敗者 lose 音声 → 勝者 win 音声の順',
    res.outcome === 'win' && order[0] === `${loser}_lose` && order[1] === `${winner}_win`,
    `ticks=${n} ${JSON.stringify(res)} ${order.join(',')}`,
  );
  const wl = await ev(() => window.__p2like.game().result.winner);
  check('勝者決定後に決定入力受付（次ラウンド案内）', await ev(() => window.__p2like.gameScene().staging.acceptReady), `winner=${wl}`);
  await key('Enter', 400);
  check('決定で次ラウンドへ', await ev(() => window.__p2like.gameScene().session.round === 2));

  // メニューへ戻る（Esc→終了する）
  await key('Escape');
  await key('ArrowRight');
  await key('Enter', 300);
  check('終了確認「終了する」でメニューへ戻る', (await sceneName()) === 'MenuScene');

  // ---- MODE1 シングル ひたすら ----
  m0 = await logMark();
  await ev(() => window.__p2like.app.startGame('mode1', 'single', 'endless'));
  await wait(300);
  const sLog = await logSince(m0);
  check('シングル：READY担当はコタロー、BGM single', sLog.some((e) => e.id === 'kotaro_ready') && sLog.some((e) => e.kind === 'bgm' && e.id === 'single'), sLog.map((e) => e.id).join(','));
  await page.waitForFunction(() => window.__p2like.game().playing, null, { timeout: 8000 });
  await wait(300);
  await shot('single_endless');
  const sg = await ev(() => {
    const g = window.__p2like.game();
    return { n: g.players.length, kind: g.single?.kind, level: g.single?.level, score: g.single?.score };
  });
  check('シングル（ひたすら）：1人・Lv1・得点0から開始', sg.n === 1 && sg.kind === 'endless' && sg.level === 1 && sg.score === 0, JSON.stringify(sg));
  await steps(60 * 600, 'sc.game.result');
  await wait(2500);
  await shot('single_gameover');
  const go = await ev(() => [window.__p2like.game().result?.outcome, window.__p2like.gameScene().finalCursor]);
  check('シングル：ゲームオーバー→結果パネル', go[0] === 'gameOver', JSON.stringify(go));
  await toMenu();

  // ---- MODE1 シングル ステージ ----
  await ev(() => window.__p2like.app.startGame('mode1', 'single', 'stage'));
  await steps(240);
  await wait(200);
  await shot('single_stage');
  const st = await ev(() => {
    const g = window.__p2like.game();
    return { kind: g.single?.kind, stage: g.single?.stage, quota: g.single?.quota };
  });
  check('ステージクリア：ステージ1・ノルマ30', st.kind === 'stage' && st.stage === 1 && st.quota === 30, JSON.stringify(st));
  await toMenu();

  // ---- MODE2 シングル／CPU ----
  await ev(() => window.__p2like.app.startGame('mode2', 'single', 'mode2'));
  await steps(200);
  await wait(200);
  await shot('mode2_single');
  const m2 = await ev(() => {
    const g = window.__p2like.game();
    return { mode: g.mode, remaining: g.remaining(g.players[0]), n: g.players.length };
  });
  check('MODE2 シングル：42個から開始', m2.mode === 'mode2' && m2.remaining === 42 && m2.n === 1, JSON.stringify(m2));
  await toMenu();
  await ev(() => window.__p2like.app.startGame('mode2', 'cpu'));
  await steps(600);
  await wait(200);
  await shot('mode2_cpu');
  const m2c = await ev(() => {
    const g = window.__p2like.game();
    return { mode: g.mode, r: g.players.map((p) => g.remaining(p)) };
  });
  check('MODE2 CPU対戦：NPCが打ち上げて残数が減る', m2c.mode === 'mode2' && m2c.r[1] < 42, JSON.stringify(m2c));
  await toMenu();

  // ---- 2P対戦 ----
  await ev(() => window.__p2like.app.startGame('mode1', '2p'));
  await page.waitForFunction(() => window.__p2like.game().playing, null, { timeout: 8000 });
  const sel0 = await ev(() => window.__p2like.game().players.map((p) => p.selectedCol));
  await key('KeyD', 60);
  await key('ArrowLeft', 60);
  const sel1 = await ev(() => window.__p2like.game().players.map((p) => p.selectedCol));
  check('2P対戦：1P(D)と2P(←)が別々に操作できる', sel1[0] === sel0[0] + 1 && sel1[1] === sel0[1] - 1, `${sel0} → ${sel1}`);
  await shot('versus_2p');
  await toMenu();

  // ---- 遊び方 ----
  await ev(() => {
    const s = window.__p2like.scene();
    s.stack[0].cursor = 3;
  });
  await key('Enter');
  check('遊び方画面', (await sceneName()) === 'HelpScene');
  await shot('help');
  await key('Escape');

  // ---- 表示倍率（自動＝収まる最大の整数倍） ----
  await page.setViewportSize({ width: 1920, height: 1080 });
  await wait(200);
  const s3 = await ev(() => document.getElementById('screen').style.width);
  check('ウィンドウ拡大で3倍表示', s3 === '1920px', s3);
  await page.setViewportSize({ width: 1280, height: 720 });

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
  const missing = await ev(() => [...window.__p2like.bus.missing]);
  check(
    '音声：未配置はBGMのみ（効果音・ボイスの欠落なし）',
    missing.every((f) => f.startsWith('bgm/')) && missing.length === 3 - bgmPresent.length,
    missing.join(',') || 'なし',
  );
} catch (e) {
  check('E2E実行', false, String(e?.stack ?? e));
}

const allowed404 = (p) => BGM.some((f) => p.endsWith(`/assets/audio/bgm/${f}`)) && bgmPresent.length < 3;
const bad = responses.filter(([s, p]) => s >= 400 && !allowed404(p));
const errs = consoleErrors.filter((m) => !(m.includes('404') && bgmPresent.length < 3));
check('コンソールエラー/警告なし（BGM未配置の404を除く）', errs.length === 0, errs.join(' | '));
check('ネットワーク失敗・4xx/5xxなし（BGM未配置の404を除く）', failedRequests.length === 0 && bad.length === 0, [...failedRequests, ...bad.map((r) => r.join(' '))].join(' | '));

writeFileSync(new URL('report.json', OUT), JSON.stringify({ date: new Date().toISOString(), root: ROOT, bgmPresent, results }, null, 2));
await browser.close();
server.kill();
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} PASS`);
process.exit(failed.length ? 1 : 0);
