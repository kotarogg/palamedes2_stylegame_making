// ブラウザ実機確認（ビルド済み dist を配信し、Chromiumで操作・画素照合・音声ログ・スクリーンショット・エラー収集）
// 使い方: npm run build && npm run e2e
//   E2E_ROOT=<展開した配布物のwww> で配布物そのものを検証できる。
//   既定は「納品検査」：必須79本（BGM3・SE30・ボイス46）の HTTP200・デコード成功・欠落なしを必須とする。
//   E2E_MODE=fallback は開発用の「フォールバック検査」：BGM 3本の未配置（404・無音で継続）だけを許容し、結果にその旨を明記する。
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
const MODE = process.env.E2E_MODE === 'fallback' || process.argv.includes('--fallback') ? 'fallback' : 'release';
const allowMissingBgm = MODE === 'fallback';
console.log(MODE === 'release' ? '== 納品検査（必須79音源）==' : '== フォールバック検査（BGM未配置を許容。納品合格ではない）==');

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
  window.__pad2 = { ...mk(), index: 1 };
  window.__padOn = false;
  window.__pad2On = false;
  navigator.getGamepads = () => [window.__padOn ? window.__pad : null, window.__pad2On ? window.__pad2 : null, null, null];
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
  const bgm200 = wavs.filter((p) => p.includes('/bgm/')).length;
  if (allowMissingBgm) check(`［フォールバック］BGM 3曲（配信物に存在${bgmPresent.length}曲）`, bgm200 === bgmPresent.length, `未配置${3 - bgmPresent.length}曲は404を許容（無音で継続）`);
  else check('［納品］BGM 3曲を HTTP200 で取得（必須79本＝BGM3・SE30・ボイス46）', bgm200 === 3 && wavs.length === 79, `bgm200=${bgm200} wav200=${wavs.length}`);
  const ver = await ev(() => window.__p2like.app.assets.atlas.manifest.version);
  check('マニフェスト内部version 2.3', ver === '2.3', ver);
  const size = await ev(() => [document.getElementById('screen').style.width, document.getElementById('screen').width]);
  check('論理640×360を整数倍(2倍)で表示', size[0] === '1280px' && size[1] === 640, size.join(' / '));
  const rendering = await ev(() => getComputedStyle(document.getElementById('screen')).imageRendering);
  check('拡大時にドットを滲ませない(image-rendering)', rendering === 'pixelated', rendering);

  // ---- R1：キー・マウスに触れず、ゲームパッドだけで最初の操作 → 音声有効化 → CPU対戦の READY／GO ----
  const pad = async (btn, ms = 120) => {
    await ev((b) => (window.__pad.buttons[b].pressed = true), btn);
    await wait(80);
    await ev((b) => (window.__pad.buttons[b].pressed = false), btn);
    await wait(ms);
  };
  const before = await ev(() => ({ ctx: !!window.__p2like.bus.ctx, attempted: window.__p2like.bus.unlockAttempted }));
  await ev(() => (window.__padOn = true));
  await pad(0, 400); // A → MODE1
  const afterPad = await ev(() => ({ ctx: window.__p2like.bus.ctx?.state ?? null, attempted: window.__p2like.bus.unlockAttempted, depth: window.__p2like.scene().stack?.length }));
  check(
    'R1：パッドだけの初回操作で音声の有効化を試み、AudioContext が running になる（キー・マウス未使用）',
    !before.ctx && !before.attempted && afterPad.attempted && afterPad.ctx === 'running' && afterPad.depth === 2,
    `before=${JSON.stringify(before)} after=${JSON.stringify(afterPad)}`,
  );
  await pad(13); // ↓ CPU対戦
  await pad(0, 300);
  await page.waitForFunction(() => window.__p2like.game()?.playing, null, { timeout: 8000 });
  await wait(300);
  const padNodes = await ev(() => ({ state: window.__p2like.bus.ctx.state, nodes: window.__p2like.bus.nodes.map((n) => ({ ...n })), t: window.__p2like.bus.ctx.currentTime }));
  const readyNode = padNodes.nodes.find((n) => n.id === 'akane_ready');
  const goNode = padNodes.nodes.find((n) => n.id === 'akane_go');
  check(
    'R1：パッド操作だけで開始した CPU対戦で READY／GO のボイスが実ノードとして再生開始（途中停止なし）',
    padNodes.state === 'running' && readyNode && goNode && readyNode.stoppedAt === null && goNode.stoppedAt === null,
    JSON.stringify({ state: padNodes.state, readyNode, goNode, sfx: padNodes.nodes.filter((n) => n.kind === 'sfx').map((n) => n.id).join(',') }),
  );
  await ev(() => (window.__padOn = false));
  await toMenu();

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

  // R3：ノルマ直前から成功1個を通常の時間進行で打ち上げ、クリアSEが実ノードとして終端まで鳴る（直後に止めない）
  const clearRun = async (finalStage) => {
    await page.waitForFunction(() => window.__p2like.game().playing, null, { timeout: 8000 });
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
      if (finalStage) p.board.cols.forEach((c, i) => (p.board.cols[i] = i === p.selectedCol ? [top] : [])); // 全消しと同時のクリア
      g.base = g.factory.make(top.piece.n, top.piece.suit);
      return { stage: s.stage, n: window.__p2like.bus.nodes.length };
    }, finalStage);
    await key('KeyF', 3200);
    return ev(
      ([n]) => {
        const bus = window.__p2like.bus;
        const g = window.__p2like.game();
        return { outcome: g.result?.outcome, now: bus.ctx.currentTime, nodes: bus.nodes.slice(n).map((x) => ({ ...x })) };
      },
      [prep.n],
    );
  };
  const endedIntact = (r, id) => {
    const x = r.nodes.find((n) => n.id === id);
    return !!x && x.stoppedAt === null && r.now >= x.start + x.duration;
  };
  const r3a = await clearRun(false);
  check(
    'R3：ステージクリア（stageClear→roundEnd 同時）で sfx_stage_clear が途中停止せず終端まで再生',
    r3a.outcome === 'stageClear' && endedIntact(r3a, 'stage_clear'),
    JSON.stringify({ outcome: r3a.outcome, now: r3a.now, nodes: r3a.nodes.filter((n) => n.kind === 'sfx').map((n) => [n.id, +n.start.toFixed(2), +n.duration.toFixed(2), n.stoppedAt]) }),
  );
  await toMenu();
  await ev(() => window.__p2like.app.startGame('mode1', 'single', 'stage'));
  const r3b = await clearRun(true);
  check(
    'R3：最終面クリア＋全消し同時で sfx_all_stages_clear・sfx_all_clear とも途中停止せず終端まで再生',
    r3b.outcome === 'allStagesClear' && endedIntact(r3b, 'all_stages_clear') && endedIntact(r3b, 'all_clear'),
    JSON.stringify({ outcome: r3b.outcome, now: r3b.now, nodes: r3b.nodes.filter((n) => n.kind === 'sfx').map((n) => [n.id, +n.start.toFixed(2), +n.duration.toFixed(2), n.stoppedAt]) }),
  );
  await shot('single_all_stages_clear');
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

  // R2：両者キーボード。1Pが終了確認を開いても、2Pの移動・発射は2Pへ届き、1Pの確認カーソルは動かない
  await wait(400);
  await key('Escape', 150);
  const q0 = await ev(() => {
    const sc = window.__p2like.gameScene();
    const g = sc.game;
    return { dlg: sc.quit.map((q) => [q.player, q.cursor]), sel2: g.players[1].selectedCol, tick: g.tick, n: g.events.length };
  });
  await key('ArrowLeft', 400); // 2P 移動
  await key('Comma', 500); // 2P 発射
  const q1 = await ev((n) => {
    const sc = window.__p2like.gameScene();
    const g = sc.game;
    return { dlg: sc.quit.map((q) => [q.player, q.cursor]), sel2: g.players[1].selectedCol, tick: g.tick, launch2: g.events.slice(n).some((e) => e.type === 'launch' && e.player === 1) };
  }, q0.n);
  await shot('versus_2p_quit_dialog');
  check(
    'R2：1P終了確認中も 2P（←・,）の移動と発射は 2P へ届き、1P の確認カーソルは動かない。ゲームは進行',
    JSON.stringify(q0.dlg) === '[[0,0]]' && JSON.stringify(q1.dlg) === '[[0,0]]' && q1.sel2 === q0.sel2 - 1 && q1.launch2 && q1.tick > q0.tick,
    `${JSON.stringify(q0)} → ${JSON.stringify(q1)}`,
  );
  await key('KeyD'); // 1P の右 → 確認カーソル「終了する」
  const c1 = await ev(() => window.__p2like.gameScene().quit.map((q) => q.cursor));
  await key('KeyA');
  await key('Escape', 150); // 1P（共有Esc の所有者）が閉じる
  const c2 = await ev(() => window.__p2like.gameScene().quit.length);
  check('R2：確認の操作は開いた 1P の割当キー（A/D・F）と共有の Esc／Enter だけ', c1.join() === '1' && c2 === 0, `cursor=${c1} after=${c2}`);
  await toMenu();

  // R2：キーボード（1P）＋パッド（2P）、パッド2台。片側の確認中も相手は移動・発射でき、確認は開いた側の入力だけで操作
  const press = async (which, btn, ms = 150) => {
    await ev(([w, b]) => (window[w].buttons[b].pressed = true), [which, btn]);
    await wait(80);
    await ev(([w, b]) => (window[w].buttons[b].pressed = false), [which, btn]);
    await wait(ms);
  };
  const snap = (n = 0) =>
    ev((n) => {
      const sc = window.__p2like.gameScene();
      const g = sc.game;
      return { dlg: sc.quit.map((q) => [q.player, q.cursor]), sel: g.players.map((p) => p.selectedCol), tick: g.tick, n: g.events.length, launch: [0, 1].map((pl) => g.events.slice(n).some((e) => e.type === 'launch' && e.player === pl)) };
    }, n);
  const startWith = async (devices) => {
    await ev((d) => {
      const a = window.__p2like.app;
      a.settings.devices = d;
      a.startGame('mode1', '2p');
    }, devices);
    await page.waitForFunction(() => window.__p2like.game().playing, null, { timeout: 8000 });
    await wait(300);
  };
  const saveDevices = await ev(() => JSON.parse(JSON.stringify(window.__p2like.app.settings.devices)));
  await ev(() => ((window.__padOn = true), (window.__pad2On = true)));
  // キーボード＋パッド：1P がキーボードで確認、2P はパッドで移動・発射
  await startWith([{ kind: 'keyboard' }, { kind: 'gamepad', index: 0 }]);
  await key('Escape', 150);
  const k0 = await snap();
  await press('__pad', 14, 400); // 2P 十字左
  await press('__pad', 0, 500); // 2P A＝発射
  const k1 = await snap(k0.n);
  // パッド（2P）が START で確認、1P はキーボードで移動
  await key('Escape', 150); // 1P の確認を閉じる
  await press('__pad', 9, 150); // 2P START
  const k2 = await snap();
  await key('KeyD', 400);
  await press('__pad', 15, 150); // 2P 確認のカーソル
  const k3 = await snap(k2.n);
  check(
    'R2：キーボード＋パッド：1P確認中に2P（パッド）が移動・発射、2P確認中に1P（キー）が移動。確認は開いた側だけで操作',
    JSON.stringify(k1.dlg) === '[[0,0]]' && k1.sel[1] === k0.sel[1] - 1 && k1.launch[1] && JSON.stringify(k2.dlg) === '[[1,0]]' && k3.sel[0] === k2.sel[0] + 1 && JSON.stringify(k3.dlg) === '[[1,1]]',
    JSON.stringify({ k0, k1, k2, k3 }),
  );
  await press('__pad', 1, 150); // 2P B で閉じる
  await toMenu();
  // パッド2台：1P（パッド1）の確認中に 2P（パッド2）が移動・発射
  await startWith([{ kind: 'gamepad', index: 0 }, { kind: 'gamepad', index: 1 }]);
  await press('__pad', 9, 150); // 1P START
  const p0 = await snap();
  await press('__pad2', 14, 400);
  await press('__pad2', 0, 500);
  const p1 = await snap(p0.n);
  check(
    'R2：パッド2台：1P確認中も 2P のパッドで移動・発射でき、1P の確認は動かない',
    JSON.stringify(p1.dlg) === '[[0,0]]' && p1.sel[1] === p0.sel[1] - 1 && p1.launch[1] && p1.tick > p0.tick,
    JSON.stringify({ p0, p1 }),
  );
  await press('__pad', 1, 150);
  await ev(() => ((window.__padOn = false), (window.__pad2On = false)));
  await ev((d) => (window.__p2like.app.settings.devices = d), saveDevices);
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
  const au = await ev(() => ({ missing: [...window.__p2like.bus.missing], decoded: window.__p2like.bus.decodedCount, state: window.__p2like.bus.ctx?.state, bgmNodes: window.__p2like.bus.nodes.filter((n) => n.kind === 'bgm').map((n) => [n.id, n.loop]) }));
  if (allowMissingBgm)
    check('［フォールバック］音声：未配置はBGMのみ、SE・ボイス76本はデコード成功', au.missing.every((f) => f.startsWith('bgm/')) && au.missing.length === 3 - bgmPresent.length && au.decoded === 76 + bgmPresent.length, JSON.stringify(au));
  else
    check('［納品］音声：必須79本すべてデコード成功・欠落なし、BGMは実ノードでループ再生', au.missing.length === 0 && au.decoded === 79 && au.state === 'running' && au.bgmNodes.length > 0 && au.bgmNodes.every(([, loop]) => loop), JSON.stringify(au));
} catch (e) {
  check('E2E実行', false, String(e?.stack ?? e));
}

const allowed404 = (p) => allowMissingBgm && BGM.some((f) => p.endsWith(`/assets/audio/bgm/${f}`));
const bad = responses.filter(([s, p]) => s >= 400 && !allowed404(p));
const errs = consoleErrors.filter((m) => !(allowMissingBgm && m.includes('404')));
const sfxName = allowMissingBgm ? '（フォールバック：BGM未配置の404を除く）' : '';
check(`コンソールエラー/警告なし${sfxName}`, errs.length === 0, errs.join(' | '));
check(`ネットワーク失敗・4xx/5xxなし${sfxName}`, failedRequests.length === 0 && bad.length === 0, [...failedRequests, ...bad.map((r) => r.join(' '))].join(' | '));

writeFileSync(new URL('report.json', OUT), JSON.stringify({ date: new Date().toISOString(), mode: MODE, root: ROOT, bgmPresent, results }, null, 2));
await browser.close();
server.kill();
const failed = results.filter((r) => !r.pass);
console.log(`\n[${MODE === 'release' ? '納品検査' : 'フォールバック検査（納品合格ではない）'}] ${results.length - failed.length}/${results.length} PASS`);
process.exit(failed.length ? 1 : 0);
