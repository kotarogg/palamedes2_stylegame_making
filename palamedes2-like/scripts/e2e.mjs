// ブラウザ検査（第3版 第20章）：ビルド済み dist を配信し、Chromium で操作・画素照合・音声ログ・実ノード・スクリーンショット・エラー収集。
// 使い方: npm run build && npm run e2e
//   E2E_ROOT=<展開した配布物のwww> で配布物そのものを検証できる。
//   既定は「納品検査」：必須117本（BGM3・SE39・ボイス75）の HTTP200・デコード成功・欠落なし、採用フォントの読込を必須とする。
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
const REQUIRED_AUDIO = 117;
const NON_BGM = 114;
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
/**
 * 修正R6：音声の状態を条件で待つ（明示的な上限付き。固定の待機時間に依存しない）。
 * 上限に達したら、デコード数・デコード待ち・欠落・AudioContext の状態と時刻・対象ノードの開始／終了／停止を返す。
 */
const audioDiag = (ids) =>
  ev((ids) => {
    const b = window.__p2like.bus;
    return {
      decoded: b.decodedCount,
      pendingDecode: b.pendingDecodeCount,
      missing: [...b.missing],
      ctxState: b.ctx?.state ?? null,
      ctxTime: b.ctx ? +b.ctx.currentTime.toFixed(3) : null,
      nodes: b.nodes.filter((n) => ids.includes(n.id)).map((n) => ({ id: n.id, start: +n.start.toFixed(3), end: +(n.start + n.duration).toFixed(3), duration: +n.duration.toFixed(3), stoppedAt: n.stoppedAt, loop: n.loop })),
    };
  }, ids);
const waitAudio = async (pred, arg, timeoutMs, ids) => {
  const t = Date.now();
  try {
    await page.waitForFunction(pred, arg, { timeout: timeoutMs, polling: 50 });
    return { ok: true, waitedMs: Date.now() - t, diag: await audioDiag(ids) };
  } catch {
    return { ok: false, timeout: true, timeoutMs, diag: await audioDiag(ids) };
  }
};
/** 対象ノード（start が ct 以降）がすべて AudioContext 時刻で start＋duration を過ぎるまで待つ */
const waitNodesEnded = (ct, ids, timeoutMs) =>
  waitAudio(
    ([ct, ids]) => {
      const b = window.__p2like.bus;
      const ns = b.nodes.filter((n) => n.start >= ct && ids.includes(n.id));
      return !!b.ctx && ns.length >= ids.length && ns.every((n) => b.ctx.currentTime >= n.start + n.duration || n.stoppedAt !== null);
    },
    [ct, ids],
    timeoutMs,
    ids,
  );
/** 途中停止なしで終端に達したか（AudioContext 時刻の判定。停止要求が終端より前なら途中停止） */
const intactEnded = (diag, id) => {
  const n = diag.nodes.filter((x) => x.id === id).at(-1);
  return !!n && diag.ctxTime !== null && diag.ctxTime >= n.end && (n.stoppedAt === null || n.stoppedAt >= n.end - 0.005);
};
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
    '明示読込一覧の49PNG＋v3.1.0追加9PNG＋遊び方UI3PNG（tutorial_assets.json）だけを取得（旧版・見本・previews を読まない）、JSON8件',
    pngs.length === 61 && pngs.every((p) => p.includes('/gfx/assets/')) && jsons.join() === 'additional_assets_v310.json,credits_text.json,font_styles.json,game_loading_list.json,graphics_manifest_v3.json,screen_layout_v2.json,tutorial_assets.json,tutorial_font_16.json',
    `png=${pngs.length} json=${jsons.join(',')}`,
  );
  const wavs = ok('.wav');
  check(`音声：SE39＋ボイス75（ピンチ3本を含む。計${NON_BGM}）を HTTP200 で取得`, wavs.filter((p) => !p.includes('/bgm/')).length === NON_BGM, `wav200=${wavs.length}`);
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
  // 修正R6：メニュー曲はデコード完了とノード開始を上限付きで待つ（未配置を許容する検査では、デコード完了まで待って無音を確認）
  const menuBgmExpected = !(allowMissingBgm && !bgmPresent.includes('bgm_menu.wav'));
  const bgmWait = menuBgmExpected
    ? await waitAudio(() => window.__p2like.bus.nodes.some((n) => n.kind === 'bgm' && n.id === 'menu') && window.__p2like.bus.ctx?.state === 'running', undefined, 30000, ['menu'])
    : await waitAudio(() => window.__p2like.bus.pendingDecodeCount === 0 && window.__p2like.bus.ctx?.state === 'running', undefined, 30000, ['menu']);
  const bgmNodes0 = await ev(() => window.__p2like.bus.nodes.filter((n) => n.kind === 'bgm').map((n) => ({ ...n })));
  check(
    '修正R6・タイトルはメニュー曲（自動再生を強制せず、有効化後にデコード完了を待って開始）。タイトル→メニューで再始動しない',
    bgmWait.ok && bgmTitle === 'menu' && (menuBgmExpected ? bgmNodes0.length === 1 && bgmNodes0[0].id === 'menu' : bgmNodes0.length === 0),
    JSON.stringify({ wait: bgmWait, bgmNodes0 }),
  );
  await shot('S02_menu');
  const menuArt = await ev(() => [window.__cmp('menu_kotaro', 'menu_kotaro', 16, 163), window.__cmp('menu_akane', 'menu_akane', 480, 163)]);
  check('メインメニュー（MODE1／MODE2／オプション／遊び方）：両脇の menu_kotaro・menu_akane を原寸・原点どおりに描画（画素一致）', menuArt.every((m) => m.bad === 0 && m.opaque > 0) && (await ev(() => window.__p2like.scene().stack[0].items.map((i) => i.label).join())) === 'MODE1,MODE2,オプション,遊び方', JSON.stringify(menuArt));

  // ---- パッドだけで CPU対戦（READY／GO はCPUの相手＝アカネ） ----
  await pad(0, 200); // MODE1
  await shot('S03_menu_mode1');
  await pad(13); // ↓ CPU対戦
  let t0 = await now();
  await pad(0, 300); // v3.1.0：CPU対戦のキャラクター選択へ（初期コタロー）
  const cpuSel = await ev(() => ({ scene: window.__p2like.scene().constructor.name, ch: window.__p2like.scene().sel?.character }));
  check('v3.1.0 CPU対戦：メニューからキャラクター選択へ（初期カーソル＝コタロー、2Pカーソルなし）', cpuSel.scene === 'CpuCharacterSelectScene' && cpuSel.ch === 'kotaro', JSON.stringify(cpuSel));
  await pad(0, 300); // 決定
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
  // v3.1.0：代表ボイスは役名ボイスか、20%の抽選で代替の攻撃ボイス（どちらか1本だけ）
  const altKind = await ev(() => window.__p2like.gameScene().roleNames.voiceLog.at(-1)?.voice);
  const repVoices = roleLog.filter((e) => e.kind === 'voice' && (e.id.startsWith('kotaro_role_') || e.id === 'kotaro_attack'));
  const wantVoice = altKind === 'attack' ? 'kotaro_attack' : `kotaro_role_${String(decl.logos[0] + 1).padStart(2, '0')}`;
  const declSfxE = roleLog.find((e) => e.kind === 'sfx' && e.id === `role_declare_${Math.min(5, decl.chain)}`);
  const declSfx = roleLog.filter((e) => e.kind === 'sfx').map((e) => e.id);
  check(
    '役宣言：代表役（先頭ロゴ）と代表ボイス（役名、または20%で代替の攻撃ボイス。両方は鳴らさない）を同時開始。役宣言SEは連鎖段階 se_role_declare_0N（代表ボイスと同時なので −2dB）、旧成立音・連鎖音を鳴らさない',
    roleShow?.logo === decl.logos?.[0] && repVoices.length === 1 && repVoices[0].id === wantVoice && declSfxE?.gainDb === -2 && !declSfx.some((id) => OLD_SFX.includes(id)),
    JSON.stringify({ decl, roleShow, altKind, repVoices, declSfxE, declSfx }),
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
  const order = ['akane_lose', 'character_fall', 'win', 'kotaro_win', 'result_cracker'].map((id) => rv(id)?.t ?? null);
  const plan1 = await ev(() => window.__p2like.gameScene().staging.plan);
  check(
    'v3.1.0 勝敗演出：敗者ボイス→（640ms）落下開始で se_character_fall→（700ms＋200ms）勝者演出の開始で勝利SE・勝者ボイス・クラッカーSEが同時（人が勝ったCPU対戦は敗北SEなし、勝利SEは1回）',
    order.every((x) => x !== null) &&
      order[1] - order[0] >= 600 &&
      order[2] - order[1] >= 850 &&
      Math.abs(order[3] - order[2]) < 40 &&
      Math.abs(order[4] - order[2]) < 40 &&
      r1.filter((e) => e.id === 'win' && !e.skipped).length === 1 &&
      !r1.some((e) => e.id === 'lose' && !e.skipped) &&
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
  check('CPU対戦で勝利：次の相手へ／同じ相手と再戦／キャラ選択へ／メニューへ', fin.state === 'matchResult' && fin.choices.join() === '次の相手へ,同じ相手と再戦,キャラ選択へ,メニューへ', JSON.stringify(fin));
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
  check('CPU対戦で敗北：同じ相手に再挑戦／キャラ選択へ／メニューへ', lose.join() === '同じ相手に再挑戦,キャラ選択へ,メニューへ', lose.join());
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
  // 修正R6：固定待機ではなく、AudioContext.currentTime が各ノードの start＋duration を過ぎるまで待つ（上限付き）
  const selIds = ['kotaro_select', 'akane_select'];
  const selWait = await waitNodesEnded(ctxSel, selIds, 10000);
  const selNodes = (await nodesSince(ctxSel)).filter((n) => n.id.endsWith('_select'));
  const selDone = selIds.map((id) => ({ id, intact: intactEnded(selWait.diag, id) }));
  const readyHeard = (await logSince(tSel)).some((e) => e.kind === 'voice' && e.id.endsWith('_ready') && !e.skipped);
  check(
    '修正R3・R6：ほぼ同時の確定でもコタロー・アカネの確定ボイスが各1回、途中停止せず終端まで再生（AudioContext時刻で判定。READYと重なっても止まらない、試合開始は待たない）',
    selWait.ok && selScene.scene === 'GameScene' && selScene.chars?.join() === 'kotaro,akane' && selNodes.length === 2 && selDone.every((n) => n.intact) && readyHeard,
    JSON.stringify({ selScene, wait: selWait, selDone, readyHeard }),
  );
  await ev(() => window.__p2like.app.toMenu(['MODE1']));
  const leftSel = await ev(() => window.__p2like.bus.voicesPlaying());
  check('修正R3：メニュー復帰で声を持ち越さない', leftSel.length === 0, JSON.stringify(leftSel));

  // ---- 修正R5：相殺の消失演出（2P対戦。実素材で描画した結果を画素照合し、画像を保存） ----
  await ev(() => window.__p2like.app.startGame('mode1', '2p'));
  await waitPlaying();
  await wait(900); // GO の見出し（中央）が消えてから描画を確かめる（v3.1.0 でストック列が中央エリアへ移ったため）
  const r5 = await ev(() => {
    const sc = window.__p2like.gameScene();
    const g = sc.game;
    const v = sc.view;
    const FAR = 1e9;
    const shots = {};
    const canvases = {};
    const render = (name) => {
      const c = document.createElement('canvas');
      c.width = 640;
      c.height = 360;
      const ctx = c.getContext('2d', { willReadFrequently: true });
      v.render(ctx, g.tick);
      canvases[name] = c;
      const big = document.createElement('canvas');
      big.width = 1280;
      big.height = 720;
      const bg = big.getContext('2d');
      bg.imageSmoothingEnabled = false;
      bg.drawImage(c, 0, 0, 1280, 720);
      shots[name] = big.toDataURL('image/png');
    };
    // 描画結果に素材画像（不透明画素）がその位置で描かれているか（前面に見えているか）
    const match = (name, sheet, id, x, y) => {
      const { app } = window.__p2like;
      const f = app.assets.atlas.frame(sheet, id);
      const t = document.createElement('canvas');
      t.width = f.w;
      t.height = f.h;
      const tg = t.getContext('2d', { willReadFrequently: true });
      tg.drawImage(app.assets.images.get(f.sheet), f.x, f.y, f.w, f.h, 0, 0, f.w, f.h);
      const s = tg.getImageData(0, 0, f.w, f.h).data;
      const d = canvases[name].getContext('2d', { willReadFrequently: true }).getImageData(Math.round(x), Math.round(y), f.w, f.h).data;
      let opaque = 0;
      let bad = 0;
      for (let i = 0; i < s.length; i += 4) {
        if (s[i + 3] < 255) continue;
        opaque++;
        if (Math.abs(s[i] - d[i]) > 2 || Math.abs(s[i + 1] - d[i + 1]) > 2 || Math.abs(s[i + 2] - d[i + 2]) > 2) bad++;
      }
      return { opaque, bad };
    };
    const set = (p, o) => {
      const s = g.players[p].incoming;
      s.blockActive = (o.cur ?? 0) > 0;
      s.blockReserved = o.reserved ?? 0;
      s.blockRemaining = o.cur ?? 0;
      s.waveRemaining = 0;
      s.nextPending = o.pending;
      s.nextStepTick = FAR;
      s.nextBlockTick = o.nextBlockTick ?? null;
    };
    const cancel = (p, n) => {
      const s = g.players[p].incoming;
      s.nextPending -= n;
      s.stats.canceled += n;
      g.events.push({ type: 'attackCancel', tick: g.tick, player: p, canceled: n, total: s.nextPending + s.blockRemaining + s.waveRemaining, pending: s.nextPending });
    };
    const vanishOf = (plan) => plan.entries.filter((e) => e.type === 'burst' || (e.type === 'icon' && e.vanish));
    const inScreen = (plan) => plan.entries.every((e) => e.x >= 0 && e.y >= 0 && e.x + e.w <= 640 && e.y + e.h <= 360);
    const out = {};
    // A：1P 予約29・現残1・待機28 → 12相殺 → 6受信
    set(0, { reserved: 29, cur: 1, pending: 28 });
    set(1, { pending: 0 });
    cancel(0, 12);
    render('R5_a0_cancel12');
    const yA = v.stockAfterimages(0, g.tick)[0]?.y;
    sc.debugQueue.push({ player: 0, type: 'debugAttack', lines: 6 });
    sc.step();
    sc.step();
    render('R5_a1_receive6_during_burst');
    const planA = v.stockDrawPlan(0, g.tick);
    const lastBurst = planA.entries.filter((e) => e.type === 'burst').at(-1);
    out.a = {
      pending: g.players[0].incoming.nextPending,
      label: planA.label?.text,
      y0: yA,
      y1: v.stockAfterimages(0, g.tick)[0]?.y,
      inScreen: inScreen(planA),
      maxBottom: Math.max(...planA.entries.map((e) => e.y + e.h)),
      burstFront: lastBurst ? match('R5_a1_receive6_during_burst', lastBurst.size === 'large' ? 'attack_stock_cancel_burst_sheet' : 'attack_stock_cancel_burst_small_sheet', String(lastBurst.frame), lastBurst.x, lastBurst.y) : null,
    };
    for (let i = 0; i < 10; i++) sc.step();
    render('R5_a2_after_160ms');
    out.a.after = { vanish: vanishOf(v.stockDrawPlan(0, g.tick)).length, label: v.pendingCountLabel(0, g.tick)?.text };
    // B：2P 待機10のうち3を相殺 → 爆発中にブロック開始（現ブロック7、相殺の3は即時打切り）
    set(0, { pending: 0 });
    set(1, { pending: 10, nextBlockTick: FAR });
    cancel(1, 3);
    sc.step();
    render('R5_b0_p2_cancel3');
    const b0 = vanishOf(v.stockDrawPlan(1, g.tick)).length;
    g.players[1].incoming.nextBlockTick = g.tick + 1;
    g.players[1].incoming.nextStepTick = FAR;
    sc.step();
    render('R5_b1_p2_block_start_cut');
    const planB = v.stockDrawPlan(1, g.tick);
    const firstIcon = planB.entries.find((e) => e.type === 'icon');
    out.b = {
      vanishBefore: b0,
      vanishAfter: vanishOf(planB).length,
      blockStart: g.events.filter((e) => e.type === 'blockStart' && e.player === 1).at(-1)?.lines,
      icons: planB.entries.filter((e) => e.type === 'icon').length,
      frames: planB.entries.filter((e) => e.type === 'frame').length,
      xd: planB.entries.filter((e) => e.type === 'icon' && e.xd).length,
      inScreen: inScreen(planB),
      blockIcon: firstIcon ? match('R5_b1_p2_block_start_cut', `attack_stock_nekotaro_${firstIcon.size}`, '0', firstIcon.x, firstIcon.y) : null,
      canceled: g.players[1].incoming.stats.canceled,
    };
    let revived = 0;
    for (let i = 0; i < 12; i++) {
      sc.step();
      revived += vanishOf(v.stockDrawPlan(1, g.tick)).length;
    }
    out.b.revived = revived;
    return { out, shots };
  });
  for (const [name, url] of Object.entries(r5.shots)) {
    const file = `screens/${name}.png`;
    writeFileSync(new URL(file, OUT), Buffer.from(url.split(',')[1], 'base64'));
    shots.push(file);
  }
  const ra = r5.out.a;
  check(
    '修正R5：予約29・現残1・待機28→12相殺→6受信。数字は待機22（消失対象を含めない）、爆発は相殺時の位置のまま画面内、小爆発が前面に描かれている（画素照合）',
    ra.pending === 22 && ra.label === '22' && ra.y0 === ra.y1 && ra.inScreen && ra.maxBottom <= 360 && ra.burstFront && ra.burstFront.opaque > 0 && ra.burstFront.bad === 0 && ra.after.vanish === 0 && ra.after.label === '22',
    JSON.stringify(ra),
  );
  const rb = r5.out.b;
  check(
    '修正R5：2Pの爆発中にブロック開始 → 相殺した3の表示を即時打切り、有効な7だけで現ブロック（囲いあり）。数量は減らし直さず、演出は復活しない',
    rb.vanishBefore > 0 && rb.vanishAfter === 0 && rb.blockStart === 7 && rb.frames === 1 && rb.xd === 0 && rb.inScreen && rb.blockIcon && rb.blockIcon.bad === 0 && rb.canceled === 3 && rb.revived === 0,
    JSON.stringify(rb),
  );
  await ev(() => window.__p2like.app.toMenu(['MODE1']));

  // ==== v3.1.0 ====
  // ---- 開始前待機：表示準備後 1000ms はゲームを進めない。待機中の操作を解除後へ持ち越さない ----
  /**
   * 修正R1：開始前待機の間、描画のたびに画面を調べ、READY・GO（S9 の A/B/C 全位相）が描かれていないこと。
   * 待機が終わった後に READY が描かれることも確かめる（待機中の判定が見逃しでないことの確認）
   */
  const holdBannerSampler = () =>
    ev(
      () =>
        new Promise((resolve) => {
          const ids = ['A', 'B', 'C'].flatMap((ph) => [`show_ready_${ph}`, `show_go_${ph}`]);
          const out = { frames: 0, drawn: [], readyAfter: false, tickMax: 0 };
          let afterFrames = 0;
          const tick = () => {
            const sc = window.__p2like.gameScene();
            if (!sc) return resolve(out);
            const drawn = ids.filter((id) => {
              const m = window.__cmp('S9', id, 240, 144);
              return m.opaque > 0 && m.bad === 0;
            });
            if (sc.preStartHolding) {
              out.frames++;
              out.tickMax = Math.max(out.tickMax, sc.game.tick);
              out.drawn.push(...drawn);
            } else {
              if (drawn.some((d) => d.startsWith('show_ready'))) out.readyAfter = true;
              if (++afterFrames > 30 || out.readyAfter) return resolve(out);
            }
            requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);
        }),
    );
  {
    const tH = await now();
    await ev(() => window.__p2like.app.startGame('mode1', '2p'));
    const samp0 = holdBannerSampler();
    await wait(120);
    const h0 = await ev(() => ({ holding: window.__p2like.gameScene().preStartHolding, tick: window.__p2like.game().tick }));
    await page.keyboard.press('KeyF'); // 1P 発射（待機中）
    await page.keyboard.press('Comma'); // 2P 発射（待機中）
    await wait(400);
    const h1 = await ev(() => ({ holding: window.__p2like.gameScene().preStartHolding, tick: window.__p2like.game().tick }));
    const voiceDuringHold = (await logSince(tH)).filter((e) => e.kind === 'voice' && e.id.endsWith('_ready'));
    await page.waitForFunction(() => !window.__p2like.gameScene().preStartHolding, null, { timeout: 5000 });
    const released = (await now()) - tH;
    await waitPlaying();
    await wait(300);
    const after = await ev(() => ({ launches: window.__p2like.game().events.filter((e) => e.type === 'launch').length, tick: window.__p2like.game().tick }));
    const readyAfter = (await logSince(tH)).some((e) => e.kind === 'voice' && e.id.endsWith('_ready') && !e.skipped);
    const s0 = await samp0;
    // 新ラウンド（勝敗の後、決定で次のラウンド）と再戦（同じキャラで再戦＝同じ処理）でも同じ
    await wait(900);
    await ev(() => {
      const sc = window.__p2like.gameScene();
      sc.game.players[0].defeated = true;
      sc.step();
    });
    await wait(2300);
    await key('Enter', 0);
    const s1 = await holdBannerSampler();
    await waitPlaying();
    await ev(() => {
      const sc = window.__p2like.gameScene();
      sc.session.rematch();
      sc.onNewRound();
    });
    const s2 = await holdBannerSampler();
    const round = await ev(() => window.__p2like.gameScene().session.round);
    check(
      'v3.1.0 修正R1：開始前待機中は READY・GO とも描かない（最初・新ラウンド・再戦。画素照合、全位相）。待機後に既存の READY→GO へ進む',
      [s0, s1, s2].every((x) => x.frames >= 20 && x.drawn.length === 0 && x.tickMax === 0 && x.readyAfter) && round === 1,
      JSON.stringify({ s0, s1, s2, round }),
    );
    check(
      'v3.1.0 開始前待機：表示後1000msはゲームを進めない（tick 0・READY前）。待機中の発射を解除後へ持ち越さない',
      h0.holding && h0.tick === 0 && h1.holding && h1.tick === 0 && voiceDuringHold.length === 0 && released >= 1000 && released < 1800 && after.launches === 0 && readyAfter,
      JSON.stringify({ h0, h1, voiceDuringHold: voiceDuringHold.length, released: Math.round(released), after, readyAfter }),
    );
  }

  // ---- ヒビのマスク（全数字×3種×3位相）：数字の外へ出ない・数字内に残る。17px 縮小後も同じ ----
  {
    const mask = await ev(() => {
      const { app, numeric } = window.__p2like;
      const A = app.assets;
      // 読み取り用の写しへ描いてから読む（元の合成キャッシュには読み取り属性を付けない）
      const alpha = (c) => {
        const t = document.createElement('canvas');
        t.width = c.width;
        t.height = c.height;
        const tg = t.getContext('2d', { willReadFrequently: true });
        tg.drawImage(c, 0, 0);
        return tg.getImageData(0, 0, c.width, c.height).data;
      };
      const out = { cases: 0, outside: 0, invisible: [] };
      for (const ch of '0123456789')
        for (const ph of ['A', 'B', 'C'])
          for (const cr of ['streak_crack_01', 'streak_crack_02', 'streak_crack_03']) {
            const plain = alpha(numeric.numericGlyph(A, ch, ph, null).canvas);
            const crack = alpha(numeric.numericGlyph(A, ch, ph, cr).canvas);
            let inside = 0;
            for (let i = 0; i < plain.length; i += 4) {
              if (plain[i + 3] === 0 && crack[i + 3] !== 0) out.outside++;
              if (plain[i + 3] !== 0 && (plain[i] !== crack[i] || plain[i + 1] !== crack[i + 1] || plain[i + 2] !== crack[i + 2])) inside++;
            }
            if (inside === 0) out.invisible.push(`${ch}${ph}${cr}`);
            out.cases++;
          }
      // 17px（縦横等比・最近傍）：複数桁「12」「19」
      const draw = (text, crack) => {
        const c = document.createElement('canvas');
        c.width = 80;
        c.height = 20;
        const cg = c.getContext('2d', { willReadFrequently: true });
        numeric.drawNumericScaled(cg, A, text, 0, 0, 17, 80, 'left', 'B', crack);
        return cg.getImageData(0, 0, 80, 20).data;
      };
      let outside17 = 0;
      let inside17 = 0;
      for (const t of ['12', '19']) {
        const a = draw(t, null);
        const b = draw(t, 'streak_crack_03');
        for (let i = 0; i < a.length; i += 4) {
          if (a[i + 3] === 0 && b[i + 3] !== 0) outside17++;
          if (a[i + 3] !== 0 && (a[i] !== b[i] || a[i + 1] !== b[i + 1])) inside17++;
        }
      }
      return { ...out, outside17, inside17 };
    });
    check(
      'v3.1.0 ヒビ：数字セルの(2,0)へ重ね、数字の不透明部でマスク（全数字×3種×A/B/C で数字外0px・数字内に残る）。17px 縮小・複数桁でも外へ出ない',
      mask.cases === 90 && mask.outside === 0 && mask.invisible.length === 0 && mask.outside17 === 0 && mask.inside17 > 0,
      JSON.stringify(mask),
    );
  }

  // ---- 代表状態：連続出し（予約中のヒビ）・役連鎖・中央の受攻撃ストック（最大＋相殺）・ピンチ3 ----
  await waitPlaying(); // 再戦の開始前待機が終わり、GO の見出しが消えてから
  await wait(900);
  const v310 = await ev(() => {
    const sc = window.__p2like.gameScene();
    const g = sc.game;
    const v = sc.view;
    const FAR = 1e9;
    const set = (p, o) => Object.assign(g.players[p].incoming, { blockActive: o.cur > 0, blockReserved: o.reserved ?? 0, blockRemaining: o.cur ?? 0, waveRemaining: 0, nextPending: o.pending, nextStepTick: FAR, nextBlockTick: null });
    const cancel = (p, n) => {
      const s = g.players[p].incoming;
      s.nextPending -= n;
      s.stats.canceled += n;
      g.events.push({ type: 'attackCancel', tick: g.tick, player: p, canceled: n, total: s.nextPending + s.blockRemaining + s.waveRemaining, pending: s.nextPending });
    };
    const p0 = g.players[0];
    const p1 = g.players[1];
    Object.assign(p0, { streakCount: 12, streakRemaining: FAR, streakCutReserved: true, chainCount: 3, chainRemaining: FAR });
    Object.assign(p1, { streakCount: 19, streakRemaining: FAR, streakCutReserved: false, chainCount: 6, chainRemaining: FAR });
    v.pv[0].crack = 'streak_crack_02';
    set(0, { reserved: 29, cur: 1, pending: 28 });
    set(1, { reserved: 10, cur: 4, pending: 14 });
    cancel(0, 12);
    cancel(1, 3);
    sc.debugQueue.push({ player: 0, type: 'debugAttack', lines: 6 });
    // 2P を7段にしてピンチ（攻撃ピンチ猶予 2500ms 残り＝数字3）
    while (p1.board.height() < 7) for (const c of p1.board.cols) if (c.length < 7) c.push({ kind: 'piece', piece: g.factory.make(1 + (c.length % 6), 'spade') });
    p1.incoming.pinchRemaining = g.ticks(2500);
    v.pv[1].height = p1.board.height(); // 検査用に足した段を表示の段数にも反映（上昇イベントを経ないため）
    sc.step();
    for (let i = 0; i < 12; i++) sc.step(); // 3 の出現（150ms）を終える
    const c = document.createElement('canvas');
    c.width = 640;
    c.height = 360;
    v.render(c.getContext('2d', { willReadFrequently: true }), g.tick);
    const big = document.createElement('canvas');
    big.width = 1280;
    big.height = 720;
    const bg = big.getContext('2d');
    bg.imageSmoothingEnabled = false;
    bg.drawImage(c, 0, 0, 1280, 720);
    const A = window.__p2like.app.assets;
    const img = (id) => A.images.get(id);
    const cmpImg = (src, sx, sy, sw, sh, x, y) => {
      const t = document.createElement('canvas');
      t.width = sw;
      t.height = sh;
      const tg = t.getContext('2d', { willReadFrequently: true });
      tg.drawImage(src, sx, sy, sw, sh, 0, 0, sw, sh);
      const a = tg.getImageData(0, 0, sw, sh).data;
      const b = c.getContext('2d', { willReadFrequently: true }).getImageData(x, y, sw, sh).data;
      let opaque = 0;
      let bad = 0;
      for (let i = 0; i < a.length; i += 4) {
        if (a[i + 3] < 255) continue;
        opaque++;
        if (Math.abs(a[i] - b[i]) > 2 || Math.abs(a[i + 1] - b[i + 1]) > 2 || Math.abs(a[i + 2] - b[i + 2]) > 2) bad++;
      }
      return { opaque, bad };
    };
    const sl0 = v.streakHudLayout(0);
    const sl1 = v.streakHudLayout(1);
    const pc = v.pinchCountView(1, g.tick);
    const f3 = pc ? A.atlas.frame('S9', `show_countdown_${pc.value}_${v.s9Phase(g.tick)}`) : null;
    const plans = [0, 1].map((p) => v.stockDrawPlan(p, g.tick));
    return {
      png: big.toDataURL('image/png'),
      label0: cmpImg(img('label_launch_streak'), 0, 0, 80, 20, sl0.label.x, sl0.label.y),
      label1: cmpImg(img('label_launch_streak'), 0, 0, 80, 20, sl1.label.x, sl1.label.y),
      pinch: pc,
      pinchPx: f3 ? cmpImg(A.images.get('S9'), f3.x, f3.y, f3.w, f3.h, pc.x, pc.y) : null,
      stock: plans.map((pl) => ({ n: pl.entries.length, minX: Math.min(...pl.entries.map((e) => e.x)), maxX: Math.max(...pl.entries.map((e) => e.x + e.w)), maxY: Math.max(...pl.entries.map((e) => e.y + e.h)), label: pl.label })),
      pending: [p0.incoming.nextPending, p1.incoming.nextPending],
      mult: [g.currentStreakPercent(p0), g.currentStreakPercent(p1)],
    };
  });
  writeFileSync(new URL('screens/V310_hud_stock_pinch.png', OUT), Buffer.from(v310.png.split(',')[1], 'base64'));
  shots.push('screens/V310_hud_stock_pinch.png');
  check(
    'v3.1.0 連続出し（見出し・成功数17px・攻撃倍率、1P予約中のヒビ）：見出しを原寸で描画（画素一致）。成功数12＝×1.25、19＝×1.75',
    v310.label0.bad === 0 && v310.label0.opaque > 0 && v310.label1.bad === 0 && v310.mult.join() === '125,175',
    JSON.stringify({ label0: v310.label0, label1: v310.label1, mult: v310.mult }),
  );
  check(
    'v3.1.0 受攻撃ストックの中央配置：1P（予約29＋待機22＋相殺12）・2P（予約10＋待機11＋相殺3）とも中央エリア x264〜376・下端360以内。数字は列の中央側',
    v310.stock.every((s) => s.minX >= 264 && s.maxX <= 376 && s.maxY <= 360) && v310.stock[0].label?.text === '22' && v310.stock[1].label?.text === '11' && v310.stock[0].label.x < v310.stock[1].label.x,
    JSON.stringify(v310.stock),
  );
  check(
    'v3.1.0 ピンチの数字：残り猶予に同期して 3（枠なしS9、2Pの盤面上）を描画（画素一致）',
    v310.pinch?.value === 3 && v310.pinchPx && v310.pinchPx.bad === 0 && v310.pinchPx.opaque > 0,
    JSON.stringify({ pinch: v310.pinch, px: v310.pinchPx }),
  );
  await shot('V310_versus_live');

  // ---- 日本語の結果見出し（勝利・敗北／対戦結果） ----
  {
    const firstTo = await ev(() => window.__p2like.gameScene().session.settings.firstTo);
    for (let i = 0; i < firstTo; i++) {
      await ev(() => {
        const sc = window.__p2like.gameScene();
        sc.game.players[0].defeated = true;
        sc.step();
      });
      await wait(2300);
      if (i === 0) await shot('V310_round_result_ja');
      if (i < firstTo - 1) {
        await key('Enter', 400);
        await waitPlaying();
        await wait(1100);
      }
    }
    await wait(400);
    await shot('V310_match_result_ja');
    const heads = await ev(() => {
      const sc = window.__p2like.gameScene();
      const A = window.__p2like.app.assets;
      const n = Number(document.getElementById('screen').dataset.scale) || 1;
      const cmp = (id, x, y) => {
        const im = A.images.get(id);
        const t = document.createElement('canvas');
        t.width = im.width;
        t.height = im.height;
        const tg = t.getContext('2d', { willReadFrequently: true });
        tg.drawImage(im, 0, 0);
        const a = tg.getImageData(0, 0, im.width, im.height).data;
        const s2 = document.createElement('canvas');
        s2.width = im.width;
        s2.height = im.height;
        const sg = s2.getContext('2d', { willReadFrequently: true });
        sg.imageSmoothingEnabled = false;
        sg.drawImage(document.getElementById('screen'), x * n, y * n, im.width * n, im.height * n, 0, 0, im.width, im.height);
        const b = sg.getImageData(0, 0, im.width, im.height).data;
        let opaque = 0;
        let bad = 0;
        for (let i = 0; i < a.length; i += 4) {
          if (a[i + 3] < 255) continue;
          opaque++;
          if (Math.abs(a[i] - b[i]) > 2 || Math.abs(a[i + 1] - b[i + 1]) > 2 || Math.abs(a[i + 2] - b[i + 2]) > 2) bad++;
        }
        return { opaque, bad };
      };
      return { state: sc.session.state, match: cmp('result_match_ja', 240, 42) };
    });
    check('v3.1.0 対戦の最終結果の見出し「対戦結果」（result_match_ja、原寸・画素一致）', heads.state === 'matchResult' && heads.match.bad === 0 && heads.match.opaque > 0, JSON.stringify(heads));
  }
  await ev(() => window.__p2like.app.toMenu(['MODE1']));

  // ---- CPU対戦のキャラクター選択：アカネを選ぶ → 相手はコタロー、READY／GO は相手。キャンセル確認 ----
  {
    await ev(() => (window.__p2like.scene().stack.at(-1).cursor = 1));
    await key('Enter', 300); // CPU対戦
    await key('ArrowRight', 200); // アカネ
    await key('Escape', 200); // 確認
    const d0 = await ev(() => ({ dialog: window.__p2like.scene().sel.dialog, ch: window.__p2like.scene().sel.character }));
    await shot('V310_cpu_select_cancel_dialog');
    await key('ArrowLeft', 150); // ポップアップ内の移動（背後は動かない）
    await key('ArrowLeft', 150);
    await key('Enter', 200); // 戻らない
    const d1 = await ev(() => ({ scene: window.__p2like.scene().constructor.name, dialog: window.__p2like.scene().sel.dialog, ch: window.__p2like.scene().sel.character }));
    await shot('V310_cpu_select_akane');
    await key('Enter', 400); // 決定
    await waitPlaying();
    const st = await ev(() => ({ chars: window.__p2like.gameScene().characters, ann: window.__p2like.gameScene().staging.announcer, opp: window.__p2like.app.cpuOpponent, cpuChar: window.__p2like.gameScene().controllers[1].character }));
    check(
      'v3.1.0 CPU対戦キャラ選択：キャンセルで「メニューに戻りますか？」（初期「戻らない」、背後は動かない）→ 戻らないで位置維持 → アカネで開始、相手はコタロー・READY担当も相手、CPU設定のキャラも一致',
      d0.dialog === 0 && d0.ch === 'akane' && d1.scene === 'CpuCharacterSelectScene' && d1.dialog === null && d1.ch === 'akane' && st.chars.join() === 'akane,kotaro' && st.ann === 'kotaro' && st.opp === 'kotaro' && st.cpuChar === 'kotaro',
      JSON.stringify({ d0, d1, st }),
    );
    await ev(() => window.__p2like.app.toMenu(['MODE1']));
  }

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
    const ct = await ctxTime();
    await key('KeyF');
    // 修正R6：クリア音のノードが AudioContext 時刻で終端を過ぎるまで待つ（上限付き）
    const ids = finalStage ? ['all_stages_clear', 'all_clear'] : ['stage_clear'];
    const w = await waitNodesEnded(ct, ids, 15000);
    const r = await ev(() => ({ outcome: window.__p2like.game().result?.outcome, plan: window.__p2like.gameScene().staging.plan }));
    return { ...r, wait: w };
  };
  const endedIntact = (r, id) => r.wait.ok && intactEnded(r.wait.diag, id);
  const r3a = await clearRun(false);
  await shot('S16_stage_clear');
  check('R3：ステージクリアで sfx_stage_clear が途中停止せず終端まで再生。シングル成功はクラッカーあり', r3a.outcome === 'stageClear' && endedIntact(r3a, 'stage_clear') && r3a.plan?.crackerTick !== null, JSON.stringify({ outcome: r3a.outcome, plan: r3a.plan, wait: r3a.wait }));
  await toMenu();
  await ev(() => window.__p2like.app.startGame('mode1', 'single', 'stage'));
  const r3b = await clearRun(true);
  await shot('S16_all_stages');
  check('R3：最終面クリア＋全消し同時で sfx_all_stages_clear・sfx_all_clear とも終端まで再生', r3b.outcome === 'allStagesClear' && endedIntact(r3b, 'all_stages_clear') && endedIntact(r3b, 'all_clear'), JSON.stringify({ outcome: r3b.outcome, wait: r3b.wait }));
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
  check('オプション：音／操作／対戦／表示／クレジット／遊び方／デモ再生／設定初期化／戻る', (await sceneName()) === 'OptionsScene' && (await ev(() => window.__p2like.scene().rows().map((r) => r.label).join())) === '音,操作,対戦,表示,クレジット,遊び方,デモ再生,設定初期化,戻る');
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
  check('遊び方：メインメニューの既存入口から目次へ', (await sceneName()) === 'HelpMenuScene');
  await shot('S25_help');
  await key('Escape');
  // 設定初期化の確認
  await ev(() => (window.__p2like.scene().stack[0].cursor = 2));
  await key('Enter');
  for (let i = 0; i < 7; i++) await key('ArrowDown');
  await key('Enter', 200);
  await shot('S26_confirm_reset');
  check('設定初期化の確認ダイアログ', (await ev(() => window.__p2like.scene().confirmReset)) === 0);
  await key('Escape');
  await toMenu();

  // ---- 遊び方・放置デモ（タイトル無操作20秒・オプションのデモ再生・説明実演・SINGLE自動・対戦・暗転・割込み・後始末） ----
  // 早送り：シーンの update を固定刻みで直接呼ぶ（教材・ゲームは本編の固定tickで進む。描画は rAF のまま）
  const ff = (ms) =>
    ev((ms) => {
      const a = window.__p2like.app;
      const seen = [];
      for (let t = 0; t < ms; t += 1000 / 60) {
        a.scene.update(1000 / 60);
        const sc = a.scene;
        const id = sc.constructor.name === 'DemoScene' ? `${sc.chapterId}:${sc.phase}` : sc.constructor.name;
        if (seen[seen.length - 1] !== id) seen.push(id);
      }
      return seen;
    }, ms);
  const raf = () => ev(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
  /** 論理座標の矩形内で、黒（RGB合計<30）でない画素の数（キャンバスは実画素倍率） */
  const litPixels = (x, y, w, h) =>
    ev(([x, y, w, h]) => {
      const src = document.querySelector('canvas');
      const k = src.width / 640;
      // 表示用キャンバスから直接読まず、読み取り用の写しから調べる（表示側の性能警告を出さない）
      const c = document.createElement('canvas');
      c.width = Math.round(w * k);
      c.height = Math.round(h * k);
      const g = c.getContext('2d', { willReadFrequently: true });
      g.drawImage(src, Math.round(x * k), Math.round(y * k), c.width, c.height, 0, 0, c.width, c.height);
      const d = g.getImageData(0, 0, c.width, c.height).data;
      let n = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i] + d[i + 1] + d[i + 2] >= 30) n++;
      return n;
    }, [x, y, w, h]);
  {
    // タイトル無操作：描画完了から20秒。マウス移動ではリセットしない
    await ev(() => window.__p2like.app.toTitle());
    await raf();
    await ev(() => (window.__p2like.scene().idleMs = 18800));
    await page.mouse.move(100, 100);
    await page.mouse.move(400, 300);
    await wait(1600);
    const leaving = await ev(() => ({ scene: window.__p2like.scene().constructor.name, leaving: window.__p2like.scene().leavingMs }));
    await wait(800);
    const idle = await ev(() => ({ scene: window.__p2like.scene().constructor.name, by: window.__p2like.scene().startedBy, ch: window.__p2like.scene().chapterId }));
    check('タイトルの無操作20秒で暗転（600ms＋黒300ms）して放置デモ（マウス移動ではリセットしない）。最初は説明（基本操作）', leaving.scene === 'TitleScene' && leaving.leaving > 0 && idle.scene === 'DemoScene' && idle.by === 'idle' && idle.ch === 'basic', JSON.stringify({ leaving, idle }));
    // 押しっぱなし（キーリピート）では終了しない。新しいキーで暗転してタイトルへ。終了操作は消費（タイトルの決定へ渡さない）
    await ev(() => window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Enter', repeat: true, bubbles: true })));
    await wait(100);
    const afterRepeat = await ev(() => window.__p2like.scene().ending);
    await key('Enter', 100);
    const ending = await ev(() => ({ ending: window.__p2like.scene().ending, phase: window.__p2like.scene().phase }));
    await wait(1300);
    check('デモ中：保持入力（リピート）では終了せず、新しい決定入力で暗転→タイトル。その入力でメニューへ進まない', afterRepeat === false && ending.ending && (await sceneName()) === 'TitleScene', JSON.stringify({ afterRepeat, ending, scene: await sceneName() }));
    // タイトルに戻ったら20秒を再計測（キー入力でリセット）
    await ev(() => (window.__p2like.scene().idleMs = 18800));
    await key('KeyQ', 50);
    const reset = await ev(() => window.__p2like.scene().idleMs);
    check('タイトル：有効なキー入力で無操作時間をリセット', reset < 300, String(reset));

    // オプションの「デモ再生」：最初の説明から。開始に使った決定入力・押したままのパッドを持ち越さない
    await toMenu();
    await ev(() => (window.__p2like.scene().stack[0].cursor = 2));
    await key('Enter', 150);
    await ev(() => (window.__p2like.scene().cursor = 6));
    await ev(() => {
      window.__padOn = true;
      window.__pad.buttons[0].pressed = true; // 押したまま開始
    });
    await key('Enter', 300);
    const opt = await ev(() => ({ scene: window.__p2like.scene().constructor.name, by: window.__p2like.scene().startedBy, ch: window.__p2like.scene().chapterId, ending: window.__p2like.scene().ending }));
    await ev(() => (window.__pad.axes[0] = 0.3)); // 小さな傾き（ドリフト相当）
    await wait(300);
    const drift = await ev(() => window.__p2like.scene().ending);
    check('オプション「デモ再生」：最初の説明から。開始の決定・押したままのボタン・小さな傾きでは終了しない', opt.scene === 'DemoScene' && opt.by === 'option' && opt.ch === 'basic' && !opt.ending && drift === false, JSON.stringify({ opt, drift }));
    await ev(() => {
      window.__pad.axes[0] = 0;
      window.__pad.buttons[0].pressed = false;
    });
    await wait(100);
    await pad(2, 50);
    const padEnd = await ev(() => window.__p2like.scene().ending);
    check('パッドの新しいボタン押下で終了（暗転へ）', padEnd === true);
    await wait(1300);
    await ev(() => (window.__padOn = false));
    // クリックで終了
    await ev(() => window.__p2like.app.startDemo('option'));
    await wait(200);
    await page.mouse.click(640, 360);
    const clickEnd = await ev(() => window.__p2like.scene().ending);
    await wait(1300);
    check('マウスクリックで終了してタイトルへ', clickEnd === true && (await sceneName()) === 'TitleScene');

    // 非アクティブ：進行と音を止め、復帰でタイトルへ
    await ev(() => window.__p2like.app.startDemo('option'));
    await ff(3000);
    const hid = await ev(() => {
      const a = window.__p2like.app;
      a.onVisibility(true);
      const tick = a.scene.stage.game.tick;
      const n = window.__p2like.bus.log.length;
      a.scene.update(1000);
      return { tick, after: a.scene.stage.game.tick, logs: window.__p2like.bus.log.length - n, bgm: window.__p2like.bus.currentBgm };
    });
    await ev(() => window.__p2like.app.onVisibility(false));
    check('非アクティブ中は進行・音を止め、復帰でタイトルへ（本編は変更なし）', hid.tick === hid.after && hid.logs === 0 && hid.bgm === null && (await sceneName()) === 'TitleScene', JSON.stringify(hid));

    // 完走：説明（基本操作→役成立〜連続出し・役連鎖→ピンチ）→SINGLE→対戦→暗転してタイトル
    await ev(() => window.__p2like.app.startDemo('option'));
    const seq = [];
    let lessonCheck = null;
    for (let i = 0; i < 400; i++) {
      seq.push(...(await ff(1000)));
      const st = await ev(() => {
        const sc = window.__p2like.app.scene;
        if (sc.constructor.name !== 'DemoScene' || !sc.stage) return null;
        const g = sc.stage.game ?? sc.stage.match?.game;
        const ev = g?.events ?? [];
        return {
          ch: sc.chapterId,
          phase: sc.phase,
          maxStreak: Math.max(0, ...ev.filter((e) => e.type === 'arrive' && e.success).map((e) => e.streak)),
          chains: ev.filter((e) => e.type === 'declare').map((e) => e.chainCount),
          gen: sc.generation,
        };
      });
      if (st?.ch === 'roles' && st.phase === 'fadeOut') lessonCheck = st;
      if (!st) break;
    }
    const chapters = [...new Set(seq.filter((s) => s.includes(':')).map((s) => s.split(':')[0]))];
    check('放置デモの章順：基本操作→4/4/6→ピンチ→SINGLE→対戦→タイトル（完走後はタイトルで20秒を再計測）', chapters.join() === 'basic,roles,pinch,single,versus' && (await sceneName()) === 'TitleScene', `${chapters.join()} → ${await sceneName()}`);
    check('4/4/6 教材（ブラウザ）：連続取得14回・役連鎖3回が実処理で成立', lessonCheck?.maxStreak === 14 && lessonCheck.chains.join() === '1,2,3', JSON.stringify(lessonCheck));

    // 暗転中も戻る案内を残す（シングル形式：右下2行／対戦形式：中央1行）。案内以外は黒
    await ev(() => window.__p2like.app.startDemo('option'));
    const toPhase = (want) =>
      ev((want) => {
        const a = window.__p2like.app;
        for (let i = 0; i < 60 * 400; i++) {
          a.scene.update(1000 / 60);
          if (`${a.scene.chapterId}:${a.scene.phase}` === want) return true;
        }
        return false;
      }, want);
    const freeze = () => ev(() => {
      const sc = window.__p2like.app.scene;
      window.__savedUpdate = sc.update;
      sc.update = () => undefined; // 描画を調べる間だけ進行を止める
    });
    const unfreeze = () => ev(() => (window.__p2like.app.scene.update = window.__savedUpdate));
    await toPhase('basic:black');
    await freeze();
    await raf();
    const singleBlack = { hint: await litPixels(396, 308, 168, 38), outside: await litPixels(64, 128, 300, 200) };
    await shot('DEMO_blackout_single');
    await unfreeze();
    await toPhase('versus:play');
    await freeze();
    await raf();
    await shot('DEMO_versus');
    const versusHint = await litPixels(222, 270, 196, 20);
    await unfreeze();
    // 修正R1：決着後（勝者演出・クラッカーの後）も中央の「対戦結果」は描かない。左右の勝利／敗北は描く
    await ev(() => {
      const sc = window.__p2like.app.scene;
      for (let i = 0; i < 60 * 120; i++) {
        const st = sc.stage;
        const plan = st.resultPlan;
        if (plan && plan.crackerTick !== null && st.game.tick >= plan.crackerTick + 40) return;
        sc.update(1000 / 60);
      }
    });
    await freeze();
    await raf();
    await shot('DEMO_versus_result');
    const r1 = await ev(() => {
      const A = window.__p2like.app.assets;
      const L = A.layout;
      const n = Number(document.getElementById('screen').dataset.scale) || 1;
      const st = window.__p2like.app.scene.stage;
      const cmp = (id, x, y) => {
        const im = A.images.get(id);
        const t = document.createElement('canvas');
        t.width = im.width;
        t.height = im.height;
        const tg = t.getContext('2d', { willReadFrequently: true });
        tg.drawImage(im, 0, 0);
        const a = tg.getImageData(0, 0, im.width, im.height).data;
        const s2 = document.createElement('canvas');
        s2.width = im.width;
        s2.height = im.height;
        const sg = s2.getContext('2d', { willReadFrequently: true });
        sg.imageSmoothingEnabled = false;
        sg.drawImage(document.getElementById('screen'), x * n, y * n, im.width * n, im.height * n, 0, 0, im.width, im.height);
        const b = sg.getImageData(0, 0, im.width, im.height).data;
        let opaque = 0;
        let bad = 0;
        for (let i = 0; i < a.length; i += 4) {
          if (a[i + 3] < 255) continue;
          opaque++;
          if (Math.abs(a[i] - b[i]) > 2 || Math.abs(a[i + 1] - b[i + 1]) > 2 || Math.abs(a[i + 2] - b[i + 2]) > 2) bad++;
        }
        return { opaque, bad };
      };
      const rb = L.rect('ready_banner');
      const w0 = L.pRect(0, 'win_lose_banner');
      const w1 = L.pRect(1, 'win_lose_banner');
      return {
        winner: st.game.result?.winner,
        banner: st.view.resultBanner(st.game.tick),
        match: cmp('result_match_ja', rb.x, rb.y),
        lose0: cmp('result_lose_ja', w0.x, w0.y),
        win1: cmp('result_win_ja', w1.x, w1.y),
        log: window.__p2like.bus.log.filter((e) => ['akane_lose', 'character_fall', 'zunko_win', 'result_cracker'].includes(e.id)).map((e) => e.id),
      };
    });
    await unfreeze();
    const drawn = (c) => c.opaque > 0 && c.bad / c.opaque < 0.02;
    check(
      '修正R1：対戦デモの決着後、中央の「対戦結果」を描かない。左右の敗北（1P）／勝利（2P）は描き、敗者の落下・勝者ボイス・クラッカーは鳴る',
      r1.winner === 1 && r1.banner === null && !drawn(r1.match) && r1.match.bad / r1.match.opaque > 0.3 && drawn(r1.lose0) && drawn(r1.win1) && ['akane_lose', 'character_fall', 'zunko_win', 'result_cracker'].every((id) => r1.log.includes(id)),
      JSON.stringify(r1),
    );
    await toPhase('versus:black');
    await freeze();
    await raf();
    const versusBlack = { hint: await litPixels(222, 270, 196, 20), outside: await litPixels(0, 0, 640, 260) };
    await shot('DEMO_blackout_versus');
    await unfreeze();
    check('暗転中も戻る案内を残し、形式の位置を保つ（シングル右下2行／対戦中央1行）。案内以外は黒', singleBlack.hint > 50 && singleBlack.outside === 0 && versusHint > 50 && versusBlack.hint > 50 && versusBlack.outside === 0, JSON.stringify({ singleBlack, versusHint, versusBlack }));
    await ff(2000);

    // 教材の画面（説明パネル・注目枠）と収録外文字
    await ev(() => window.__p2like.app.startDemo('option'));
    await toPhase('roles:play');
    await ff(9000);
    await raf();
    await shot('DEMO_roles_lesson');
    await toPhase('single:play');
    await ff(8000);
    await raf();
    await shot('DEMO_single_auto');
    await ev(() => window.__p2like.app.scene.interrupt());
    await ff(1500);
    const missing = await ev(() => [...window.__p2like.demo.missingGlyphs]);
    check('説明・案内の文字はすべて共通ビットマップフォントに収録（収録外の代替描画なし）', missing.length === 0, missing.join(','));

    // 遊び方：目次（5項目＋操作一覧）→役一覧（16役）→戻る→目次→戻る→呼出元
    await toMenu();
    await ev(() => (window.__p2like.scene().stack[0].cursor = 3));
    await key('Enter', 150);
    const items = await ev(() => window.__p2like.scene().constructor.name);
    await key('ArrowDown');
    await key('ArrowDown');
    await key('ArrowDown');
    await key('Enter', 150);
    const roles = [];
    for (let i = 0; i < 16; i++) {
      roles.push(await ev(() => ({ i: window.__p2like.scene().index, ...window.__p2like.scene().info() })));
      if (i === 15) await shot('HELP_roles_16');
      await key('ArrowRight', 60);
    }
    check('役一覧：1役ずつ16役、役名ロゴは本体の表示名対応どおり（R01〜R16）', items === 'HelpMenuScene' && roles.map((r) => r.logos.join('+')).join() === [...Array(16).keys()].join(), JSON.stringify(roles.map((r) => [r.logos, r.clear, r.attack])));
    check('役一覧の値は本体の役データ：フォーカード消去1/基本攻撃0、フラッシュ3/2、スーパーストレート3/2', roles[0].clear === 1 && roles[0].attack === 0 && roles[12].clear === 3 && roles[12].attack === 2 && roles[6].clear === 3 && roles[6].attack === 2);
    await key('Escape', 150);
    const backToc = await sceneName();
    await key('Escape', 150);
    const backMenu = await sceneName();
    // オプションから入った場合はオプションへ戻る
    await ev(() => (window.__p2like.scene().stack[0].cursor = 2));
    await key('Enter', 150);
    await ev(() => (window.__p2like.scene().cursor = 5));
    await key('Enter', 150);
    const fromOpt = await sceneName();
    await key('Escape', 150);
    check('遊び方：戻るで目次→呼出元（メインメニュー／オプション）へ。放置デモのタイトル復帰と混同しない', backToc === 'HelpMenuScene' && backMenu === 'MenuScene' && fromOpt === 'HelpMenuScene' && (await sceneName()) === 'OptionsScene', [backToc, backMenu, fromOpt, await sceneName()].join());
    await toMenu();
  }

  // 音声の有効化前もデモは進む（無音は locked、素材欠落は missing として区別）
  {
    const p2 = await (await newContext()).newPage();
    watch(p2);
    await p2.goto(`http://127.0.0.1:${PORT}/`);
    await p2.waitForSelector('body[data-ready]');
    const r = await ev(() => {
      const a = window.__p2like.app;
      a.startDemo('idle');
      for (let i = 0; i < 60 * 20; i++) a.scene.update(1000 / 60);
      const log = window.__p2like.bus.log;
      // 重複抑制など論理的に鳴らさなかった記録（skipped）は除き、鳴らすはずだった要求がすべて locked
      const req = log.filter((e) => !e.skipped);
      return { unlocked: window.__p2like.bus.unlocked, ch: a.scene.chapterId, tick: a.scene.stage?.game?.tick ?? 0, locked: req.filter((e) => e.locked).length, missing: log.filter((e) => e.skipped === 'missing').length, total: req.length };
    }, undefined, p2);
    check('音声の有効化前でもデモは進行し、未解除の無音（locked）と素材欠落（missing）を区別して記録', !r.unlocked && r.tick > 60 && r.locked === r.total && r.total > 0 && r.missing === 0, JSON.stringify(r));
    await p2.close();
  }

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
  // v3.1.0 採用ボイス：ピンチ3本が実ブラウザでデコード・再生ノード作成でき、実尺のまま（固定長で切らない）。READY 中は鳴らさない（数値・状態の確認で、聴感ではない）
  const pinchRt = await ev(async () => {
    const b = window.__p2like.bus;
    const out = [];
    for (const c of ['kotaro', 'akane', 'zunko']) {
      b.stopEffects();
      // 記録は最新500件で切り詰めるため、件数ではなく再生開始時刻で今回のノードを探す
      const t0 = b.ctx.currentTime;
      const played = b.playOptionalVoice(c, 'pinch', 5);
      const rec = [...b.nodes].reverse().find((n) => n.id === `${c}_pinch` && n.start >= t0);
      out.push({ c, played, dur: rec ? Math.round(rec.duration * 1e6) / 1e6 : null, durMs: b.voiceDurationMs(c, 'pinch') });
    }
    b.stopEffects();
    b.playVoice('akane', 'ready', 40, 'announce');
    const busy = b.playOptionalVoice('zunko', 'pinch', 5);
    b.stopEffects();
    return { out, busy, missing: [...b.missing].filter((f) => f.includes('pinch')) };
  });
  const PINCH_SEC = { kotaro: 1.53, akane: 1.306896, zunko: 1.170208 };
  check(
    'v3.1.0 ピンチボイス3本：実デコード・再生ノード作成・実尺どおり。READY 中は鳴らさない（状態確認。聴感は未確認）',
    pinchRt.missing.length === 0 && pinchRt.out.every((o) => o.played && o.dur !== null && Math.abs(o.dur - PINCH_SEC[o.c]) < 0.001) && pinchRt.busy === false,
    JSON.stringify(pinchRt),
  );
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
