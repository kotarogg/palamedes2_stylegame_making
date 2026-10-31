// V320-FIX-06 の画面検査と証拠画像（役一覧の新しい数値・複合役の結果・受ストック数量数字の削除・遊び方実演の自動開始/完了/移行）。
// 使い方：npm run build の後に node scripts/e2e-fix06.mjs（フォールバック時は E2E_FONT_STANDIN でフォント代用）。1倍の640×360を論理座標どおりに描いて保存
// 直接状態設定を使った検査は自然プレイと区別して記録する（結果JSONの kind）。
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { installFontStandin } from './font-standin.mjs';

const PORT = Number(process.env.E2E_PORT ?? 8768);
const ROOT = process.env.E2E_ROOT ?? 'dist';
const OUT = new URL('../docs/v320f06/', import.meta.url);
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
  return `docs/v320f06/screens/${name}.png`;
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



// ---- 1. 役一覧（新しい数値表。フルカード・フラッシュ・スーパーストレートフラッシュ）----
{
  const r = await ev(() => {
    const app = window.__p2like.app;
    app.toMenu();
    app.openHelp('menu');
    const help = app.scene;
    help.cursor = 3; // 役一覧
    help.onNav({ key: 'confirm', source: { kind: 'keyboard' } });
    const sc = app.scene;
    const out = {};
    for (const i of [0, 4, 12, 15]) {
      while (sc.index !== i) sc.onNav({ key: 'right', source: { kind: 'keyboard' } });
      const c = window.__f4.canvas();
      sc.render(c.x, 300);
      const v = sc.info();
      out[i] = { name: window.__p2like.app.scene.roles?.[i]?.name, clear: v.clear, attack: v.attack, png: c.c.toDataURL('image/png') };
    }
    sc.onNav({ key: 'back', source: { kind: 'keyboard' } });
    return out;
  });
  for (const [i, x] of Object.entries(r)) shots.push(save(`V320F06_role_list_${String(Number(i) + 1).padStart(2, '0')}_1x`, x.png));
  const vals = Object.fromEntries(Object.entries(r).map(([i, x]) => [i, `${x.clear}/${x.attack}`]));
  check('第2章 役一覧：フォーカード 2/2・フルカード 4/5・フラッシュ（4個の例）3/2・スーパーストレートフラッシュ 6/8 を本体の数値表から表示', JSON.stringify(vals) === JSON.stringify({ 0: '2/2', 4: '4/5', 12: '3/2', 15: '6/8' }), JSON.stringify(vals), 'natural-ui');
}

// ---- 2. 複合役の結果（フォーカード＋オールマーク＝消去3／基本攻撃4、役名ロゴ2つ・代表ボイスは先頭）----
{
  await ev(() => window.__p2like.app.startGame('mode1', 'cpu'));
  await page.waitForTimeout(3500);
  const r = await ev(() => {
    const sc = window.__p2like.gameScene();
    const g = sc.game;
    const v = sc.view;
    sc.controllers = sc.controllers.map((c, i) => (i === 1 ? { poll: () => [] } : c));
    const p = g.players[0];
    for (const c of p.board.cols) while (c.length < 5) c.push({ kind: 'piece', piece: g.factory.make(5, 'club') });
    p.roleStock = [['spade', 3], ['diamond', 3], ['club', 3], ['heart', 3]].map(([s, n]) => g.factory.make(n, s));
    v.syncEvents();
    const glow = v.glowTargets(0, g.tick);
    sc.debugQueue.push({ player: 0, type: 'declare' });
    sc.step();
    const d = g.events.filter((e) => e.type === 'declare' && e.player === 0).at(-1);
    sc.roleNames.update(); // 役名・代表ボイスの選定（本編は毎フレームの update で行う）
    for (let i = 0; i < 30; i++) sc.step();
    const c = window.__f4.canvas();
    sc.render(c.x, 0);
    const voice = sc.roleNames.showLog.filter((x) => x.player === 0).at(-1);
    for (let i = 0; i < 400 && !g.events.some((e) => e.type === 'attack' && e.player === 0 && e.tick > d.tick); i++) sc.step();
    const a = g.events.filter((e) => e.type === 'attack' && e.player === 0).at(-1);
    const lines = g.events.filter((e) => e.type === 'lineClear' && e.player === 0 && e.tick > d.tick).length;
    return { result: { nr: d.result.numberRole, sr: d.result.suitRole, clear: d.result.clear, attack: d.result.baseAttack, idx: d.result.indices }, glow: glow?.indices, logos: d.logos, voice: voice ? { logos: voice.logos, file: voice.voiceFile } : null, breakdown: a?.breakdown, lines, png: c.c.toDataURL('image/png') };
  });
  shots.push(save('V320F06_combo_fourcard_allmark_1x', r.png));
  check('第2・3章 複合役：フォーカード＋オールマーク＝消去3／基本攻撃4（複合表）。成立光の位置＝宣言の採択位置、役名ロゴは数字役→属性役の2つ、代表ボイスは先頭ロゴ（R01）、実消去3ライン・基本攻撃4', r.result.clear === 3 && r.result.attack === 4 && r.result.nr === 'four_card' && r.result.sr === 'all_mark' && JSON.stringify(r.glow) === JSON.stringify(r.result.idx) && JSON.stringify(r.logos) === '[0,11]' && r.voice && r.voice.logos[0] === 'R01' && r.lines === 3 && r.breakdown?.base === 4, JSON.stringify({ ...r, png: undefined }));
}

// ---- 3. 受ストック：左右の数量数字を描かない（アイコン・囲い・相殺の消失演出は残す）----
{
  const r = await ev(() => {
    const sc = window.__p2like.gameScene();
    const g = sc.game;
    const v = sc.view;
    for (const p of g.players) p.role = null;
    const t = g.tick;
    const set = (pending) => {
      for (const p of g.players) Object.assign(p.incoming, { blockActive: true, blockReserved: 9, blockRemaining: 7, waveRemaining: 2, nextPending: pending, nextBlockTick: g.tick + 100000, nextStepTick: g.tick + 100000 });
    };
    // 旧数字の位置（1P 列の右・2P 列の左、待機群の上端から14px）の画素：待機あり／なしで差がないこと
    const region = (p, y) => {
      const [ox] = v.pvc.stock.origin[p];
      return p === 0 ? { x: ox + 18, y, w: 22, h: 14 } : { x: ox - 24, y, w: 22, h: 14 };
    };
    set(12);
    const on = window.__f4.canvas(); sc.render(on.x, 0);
    const ys = [0, 1].map((p) => v.stockView(p, g.tick).pendingY);
    const icons = [0, 1].map((p) => v.stockDrawPlan(p, g.tick).entries.filter((e) => e.type === 'icon').length);
    const frames = [0, 1].map((p) => v.stockDrawPlan(p, g.tick).entries.filter((e) => e.type === 'frame').length);
    const keys = [0, 1].map((p) => Object.keys(v.stockDrawPlan(p, g.tick)));
    set(0);
    const off = window.__f4.canvas(); sc.render(off.x, 0);
    const diffIn = [0, 1].map((p) => {
      const R = region(p, ys[p]);
      const a = on.x.getImageData(R.x, R.y, R.w, R.h).data;
      const b = off.x.getImageData(R.x, R.y, R.w, R.h).data;
      let n = 0;
      for (let i = 0; i < a.length; i += 4) if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2]) n++;
      return n;
    });
    // 相殺の消失演出（XD顔・小爆発）は残る
    set(12);
    const s = g.players[0].incoming;
    s.nextPending -= 5;
    g.events.push({ type: 'attackCancel', tick: g.tick, player: 0, canceled: 5, total: 14, pending: s.nextPending });
    v.syncEvents();
    const after = v.stockAfterimages(0, g.tick);
    const plan = v.stockDrawPlan(0, g.tick);
    const cc = window.__f4.canvas(); sc.render(cc.x, 0);
    return { icons, frames, keys, diffIn, counter: after.map((x) => [x.kind, x.lines]), burst: plan.entries.filter((e) => e.type === 'burst').length, xd: plan.entries.filter((e) => e.type === 'icon' && e.xd).length, pngOn: on.c.toDataURL('image/png'), pngCancel: cc.c.toDataURL('image/png') };
  });
  shots.push(save('V320F06_stock_no_count_both_1x', r.pngOn), save('V320F06_stock_cancel_effect_1x', r.pngCancel));
  check('第8章 受ストック：1P・2Pとも数量数字なし（描画計画に数字がなく、旧数字の位置の画素は待機12と0で同一）。小アイコン・囲いは描画', r.keys.every((k) => k.join() === 'entries') && r.diffIn.every((n) => n === 0) && r.icons.every((n) => n > 0) && r.frames.every((n) => n > 0), JSON.stringify({ keys: r.keys, diffIn: r.diffIn, icons: r.icons, frames: r.frames }));
  check('第8章 相殺の消失演出（XD顔・小爆発）は維持', JSON.stringify(r.counter) === '[["counter",5]]' && r.xd > 0 && r.burst > 0, JSON.stringify({ counter: r.counter, xd: r.xd, burst: r.burst }));
}

// ---- 4. 遊び方の実演：自動開始・実演完了・次項目への移行（基本操作）----
{
  const r = await ev(() => {
    const app = window.__p2like.app;
    app.toMenu();
    app.openHelp('menu');
    const help = app.scene;
    help.cursor = 1; // 基本操作
    help.onNav({ key: 'confirm', source: { kind: 'keyboard' } });
    const sc = app.scene;
    const st = sc.stage;
    const pngs = {};
    const snap = (k) => {
      const c = window.__f4.canvas();
      sc.render(c.x, 0);
      pngs[k] = c.c.toDataURL('image/png');
    };
    sc.update(1000 / 60);
    snap('start');
    const startPage = st.items.current?.page;
    const startGameTick = st.game.tick;
    let doneSnap = false;
    for (let i = 0; i < 60 * 30 && st.items.log.length < 2; i++) {
      sc.update(1000 / 60);
      const cur = st.items.current;
      if (!doneSnap && cur && cur.doneTick !== null) {
        snap('done');
        doneSnap = true;
      }
    }
    snap('next');
    const log = st.items.log.map((x) => ({ page: x.page, start: x.startTick, done: x.doneTick, min: x.minTicks, end: x.endTick }));
    return { startPage, startGameTick, firstMoveTick: st.game.events.find((e) => e.type === 'move')?.tick ?? null, log, pngs };
  });
  for (const [k, png] of Object.entries(r.pngs)) shots.push(save(`V320F06_help_basic_${k}_1x`, png));
  const a = r.log[0];
  check('第7章 遊び方：項目へ入った時点で説明と実演を自動開始（最初の移動は開始直後）。実演完了（移動3回＋待ち）後は最低表示時間の残りだけ待って次項目（列入れ替え）へ', r.startPage === 'basic_move' && r.firstMoveTick !== null && r.firstMoveTick <= r.startGameTick + 2 && a.done !== null && a.done - a.start < a.min && a.end - a.start === a.min && r.log[1]?.page === 'rotate', JSON.stringify({ log: r.log, first: r.firstMoveTick, t0: r.startGameTick }), 'natural-ui');
}

// ---- 6. R1：役一覧の副ページ（オールマーク・フラッシュの6個）----
{
  const r = await ev(() => {
    const app = window.__p2like.app;
    app.toMenu();
    app.openHelp('menu');
    const help = app.scene;
    help.cursor = 3;
    help.onNav({ key: 'confirm', source: { kind: 'keyboard' } });
    const sc = app.scene;
    const out = {};
    for (const [i, sub] of [[11, 0], [11, 1], [12, 0], [12, 1]]) {
      while (!(sc.index === i && sc.sub === sub)) sc.onNav({ key: 'right', source: { kind: 'keyboard' } });
      const c = window.__f4.canvas();
      sc.render(c.x, 300);
      const v = sc.info();
      out[`${i}_${sub}`] = { counter: sc.counter(), pieces: v.pieces, val: `${v.clear}/${v.attack}`, png: c.c.toDataURL('image/png') };
    }
    sc.onNav({ key: 'back', source: { kind: 'keyboard' } });
    return out;
  });
  for (const [k, x] of Object.entries(r)) if (k.endsWith('_1')) shots.push(save(`V320F06R1_role_list_${k}_6pieces_1x`, x.png));
  const got = Object.fromEntries(Object.entries(r).map(([k, x]) => [k, `${x.counter} ${x.pieces}個 ${x.val}`]));
  check('R1 第2項 役一覧：オールマーク・フラッシュは同じ役の副ページで4個／6個の実例と消去・基本攻撃を表示（12/16・1/2 4個2/2 → 2/2 6個3/3、13/16・1/2 4個3/2 → 2/2 6個4/3）', JSON.stringify(got) === JSON.stringify({ '11_0': '12/16・1/2 4個 2/2', '11_1': '12/16・2/2 6個 3/3', '12_0': '13/16・1/2 4個 3/2', '12_1': '13/16・2/2 6個 4/3' }), JSON.stringify(got), 'natural-ui');
}

// ---- 7. R1：説明と実演の同期（ライン消去・連鎖切り予約）----
{
  const r = await ev(() => {
    const app = window.__p2like.app;
    app.toMenu();
    app.openHelp('menu');
    const help = app.scene;
    help.cursor = 2; // 連鎖説明（4/4/6 → ヒビ）
    help.onNav({ key: 'confirm', source: { kind: 'keyboard' } });
    const sc = app.scene;
    const out = { pngs: {} };
    const snap = (k) => {
      const c = window.__f4.canvas();
      sc.render(c.x, 0);
      out.pngs[k] = c.c.toDataURL('image/png');
    };
    // 最初のライン消去の tick（同じフレーム）
    for (let i = 0; i < 60 * 60; i++) {
      sc.update(1000 / 60);
      const g = sc.stage.game;
      const lc = g.events.find((e) => e.type === 'lineClear');
      if (lc) {
        out.lineClear = { tick: lc.tick, text: sc.stage.items.text, lines: sc.stage.panel().lines };
        snap('line_clear');
        break;
      }
    }
    // ヒビ教材へ（連鎖説明の2つ目の舞台）
    for (let i = 0; i < 60 * 120 && sc.stage.def?.id !== 'crack'; i++) sc.update(1000 / 60);
    const st = sc.stage;
    const seen = [];
    for (let i = 0; i < 60 * 30 && !st.finished; i++) {
      sc.update(1000 / 60);
      const tx = st.items.text;
      const key = `${tx.page}#${tx.panel}`;
      if (seen.at(-1) !== key) {
        seen.push(key);
        const p = st.game.players[0];
        out[`crack_${tx.panel}`] = { streak: p.streakCount, reserved: p.streakCutReserved };
        if (tx.panel === 1) snap('crack_success_keeps');
      }
    }
    out.seen = seen;
    out.segments = st.items.log[0].segments.map((x) => [x.panel + 1, x.trigger]);
    return out;
  });
  for (const [k, png] of Object.entries(r.pngs)) shots.push(save(`V320F06R1_sync_${k}_1x`, png));
  check('R1 第1項 ライン消去：最初のライン消去と同じフレームに「ライン消去」の説明（＋消去数）を表示', r.lineClear && r.lineClear.text.page === 'line_clear' && r.lineClear.lines[0] === '強い役ほど、' && r.lineClear.lines.at(-1) === '消去２ライン', JSON.stringify(r.lineClear));
  check('R1 第1項 連鎖切り予約：ヒビ発生→（予約中の成功）「成功してもヒビは残る」表示時は予約が残る→次の打ち上げで「もう一度失敗すると切れる」', JSON.stringify(r.seen) === JSON.stringify(['streak_crack#0', 'streak_crack#1', 'streak_crack#2']) && r.crack_1.reserved === true && r.crack_1.streak === 2 && r.segments.length === 4, JSON.stringify({ seen: r.seen, c1: r.crack_1, segments: r.segments }), 'natural-ui');
}

writeFileSync(new URL('e2e_report_V320-FIX-06.json', OUT), JSON.stringify({ id: 'V320-FIX-06', fontStandin: !!STANDIN, results, shots, errors }, null, 1));
console.log(`${results.filter((r) => r.pass).length}/${results.length} passed; errors=${errors.length}`, errors.slice(0, 5));
await browser.close();
server.kill();
process.exit(results.every((r) => r.pass) && !errors.length ? 0 : 1);
