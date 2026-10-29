// V320-FIX-05 の画面検査と証拠画像（ピンチ警告・役名の横スライド）。FIX-04 の検査は scripts/e2e-fix04.mjs（1倍の640×360を論理座標どおりに描いて保存）。
// 使い方：npm run build の後に node scripts/e2e-fix04.mjs [--fallback]（フォールバック時は E2E_FONT_STANDIN でフォント代用）
// 直接状態設定を使った検査は自然プレイと区別して記録する（結果JSONの kind）。
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { installFontStandin } from './font-standin.mjs';

const PORT = Number(process.env.E2E_PORT ?? 8767);
const ROOT = process.env.E2E_ROOT ?? 'dist';
const OUT = new URL('../docs/v320f05/', import.meta.url);
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
  return `docs/v320f05/screens/${name}.png`;
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


// ---- 1. ピンチ警告（左右同時・最大ストック・役名演出中）----
{
  await ev(() => window.__p2like.app.startGame('mode1', 'cpu'));
  await page.waitForTimeout(3500);
  const r = await ev(() => {
    const sc = window.__p2like.gameScene();
    const g = sc.game;
    const v = sc.view;
    for (const p of g.players) {
      while (p.board.height() < 7) for (const c of p.board.cols) if (c.length < 7) c.push({ kind: 'piece', piece: g.factory.make(1 + (c.length % 6), 'spade') });
      Object.assign(p.incoming, { blockActive: true, blockReserved: 29, blockRemaining: 27, waveRemaining: 2, nextPending: 28 });
      p.incoming.pinchRemaining = g.ticks(2500);
    }
    v.pv[0].height = v.pv[1].height = 7;
    for (let i = 0; i < 3; i++) sc.step();
    // 役名演出中（左右とも2役の切替中）
    const t0 = g.tick;
    for (const p of [0, 1]) sc.roleNames.schedules[p].declare([0, 7], null, t0 - 40);
    const t = g.tick;
    const on = window.__f4.canvas(); sc.render(on.x, 0);
    const views = [0, 1].map((p) => v.pinchWarnView(p));
    // 警告の描画範囲：警告を消した描画との差の外接（左右別）
    const keep = g.players.map((p) => ({ ...p.pinchWarn }));
    for (const p of g.players) p.pinchWarn = { active: false, value: null };
    const off = window.__f4.canvas(); sc.render(off.x, 0);
    g.players.forEach((p, i) => (p.pinchWarn = keep[i]));
    const a = on.x.getImageData(0, 0, 640, 360).data;
    const b = off.x.getImageData(0, 0, 640, 360).data;
    const box = [{ x0: 640, y0: 360, x1: -1, y1: -1 }, { x0: 640, y0: 360, x1: -1, y1: -1 }];
    let stray = 0;
    for (let i = 0; i < a.length; i += 4) {
      if (a[i] === b[i] && a[i + 1] === b[i + 1] && a[i + 2] === b[i + 2]) continue;
      const x = (i / 4) % 640, y = Math.floor(i / 4 / 640);
      const k = x < 320 ? 0 : 1;
      const bx = box[k];
      bx.x0 = Math.min(bx.x0, x); bx.y0 = Math.min(bx.y0, y); bx.x1 = Math.max(bx.x1, x); bx.y1 = Math.max(bx.y1, y);
      if (y < 16 || y >= 31) stray++;
    }
    // 大型 3/2/1（S9 の show_countdown）が盤面に無い：盤面の上半分で S9 の数字の画素が出ていないことは、描画経路の撤去（pinchCountView なし）で確認
    return { t, views, box, stray, hasOldCountdown: typeof v.pinchCountView === 'function', png: on.c.toDataURL('image/png') };
  });
  shots.push(save('V320F05_pinch_warn_both_maxstock_role_1x', r.png));
  const inArea = (b, x0) => b.x0 >= x0 && b.x1 < x0 + 144 && b.y0 >= 16 && b.y1 <= 30;
  check('第5章 ピンチ警告：左右同時に「ピンチ X.X秒」を盤面上部の指定領域（88,16,144,14）／（408,16,144,14）の中だけに描画（可視範囲 y16〜30）。大型3/2/1・危険秒の描画経路なし', r.views.every((w) => /^ピンチ \d\.\d秒$/.test(w?.text ?? '')) && inArea(r.box[0], 88) && inArea(r.box[1], 408) && r.stray === 0 && !r.hasOldCountdown, JSON.stringify({ views: r.views.map((w) => w?.text), box: r.box, stray: r.stray }));
}

// ---- 2. 役名の横スライド（実素材・1倍）----
{
  const r = await ev(() => {
    const sc = window.__p2like.gameScene();
    const g = sc.game;
    const v = sc.view;
    const A = window.__p2like.app.assets;
    for (const p of g.players) p.pinchWarn = { active: false, value: null };
    const t0 = g.tick + 1;
    sc.roleNames.schedules[0].declare([0, 7], null, t0); // 1P：フォーカード＋フォーブラック
    sc.roleNames.schedules[1].declare([15], null, t0); // 2P：スーパーストレートフラッシュ（単役）
    const rect = (p) => A.layout.pRect(p, 'role_logo');
    const out = [];
    const shots = {};
    for (const ms of [0, 60, 120, 630, 690, 750, 1110, 1170, 1230]) {
      const t = t0 + g.ticks(ms === 0 ? 0 : ms) - (ms === 0 ? g.ticks(1) - 0 : 0);
      const tt = ms === 0 ? t0 : t0 + Math.round((ms * 60) / 1000);
      const views = [0, 1].map((p) => v.roleLogoViews(p, tt));
      const c = window.__f4.canvas();
      v.hud = { ...v.hud, roleLogos: (p, x) => sc.roleNames.logosAt(p, x) };
      v.render(c.x, tt);
      // 定位置（静止）のとき：役名ロゴの矩形が素材の切出しと画素一致（原寸・定位置）
      let match = null;
      if (views[0].length === 1 && views[0][0].dx === 0 && views[0][0].alpha === 1) {
        const lv = views[0][0];
        const letter = ['A', 'B', 'C'][Math.floor((tt - lv.since) / 5.4) % 3];
        const f = A.atlas.role(lv.logo, letter);
        const tc = document.createElement('canvas');
        tc.width = f.w; tc.height = f.h;
        const tg = tc.getContext('2d');
        tg.drawImage(A.images.get(f.sheet), f.x, f.y, f.w, f.h, 0, 0, f.w, f.h);
        const src = tg.getImageData(0, 0, f.w, f.h).data;
        const R = rect(0);
        const dst = c.x.getImageData(R.x, R.y, f.w, f.h).data;
        let opaque = 0, bad = 0;
        for (let i = 0; i < src.length; i += 4) { if (src[i + 3] < 255) continue; opaque++; if (Math.abs(src[i] - dst[i]) > 2 || Math.abs(src[i + 1] - dst[i + 1]) > 2 || Math.abs(src[i + 2] - dst[i + 2]) > 2) bad++; }
        match = { opaque, bad };
      }
      out.push({ ms, tick: tt, p1: views[0].map((x) => [x.logo + 1, x.dx, Math.round(x.alpha * 100) / 100]), p2: views[1].map((x) => [x.logo + 1, x.dx, Math.round(x.alpha * 100) / 100]), match });
      if ([0, 60, 120, 690, 750, 1170, 1230].includes(ms)) {
        const z = document.createElement('canvas');
        z.width = 640; z.height = 72;
        const zx = z.getContext('2d');
        zx.drawImage(c.c, 0, 30, 640, 72, 0, 0, 640, 72);
        shots[ms] = z.toDataURL('image/png');
      }
    }
    return { out, shots };
  });
  for (const [ms, png] of Object.entries(r.shots)) shots.push(save(`V320F05_role_slide_${String(ms).padStart(4, '0')}ms_band_1x`, png));
  const at = (ms) => r.out.find((x) => x.ms === ms);
  const ok =
    JSON.stringify(at(0).p1) === JSON.stringify([[1, -16, 0]]) &&
    JSON.stringify(at(120).p1) === JSON.stringify([[1, 0, 1]]) &&
    at(120).match && at(120).match.bad === 0 && at(120).match.opaque > 100 &&
    at(690).p1.length === 2 && at(690).p1[0][0] === 1 && at(690).p1[1][0] === 8 && at(690).p1[0][1] > 0 && at(690).p1[1][1] < 0 &&
    JSON.stringify(at(750).p1) === JSON.stringify([[8, 0, 1]]) &&
    JSON.stringify(at(1110).p1) === JSON.stringify([[8, 0, 1]]) &&
    at(1170).p1.length === 1 && at(1170).p1[0][1] > 0 &&
    at(1230).p1.length === 0 &&
    JSON.stringify(at(0).p2) === JSON.stringify([[16, 16, 0]]) && at(690).p2.length === 1 && at(690).p2[0][1] < 0 && at(750).p2.length === 0;
  check('第6章 役名：0/120/630/750/1110/1230ms（実素材・1倍）。1Pは左→右・2Pは右→左に16px、静止時は原寸・定位置で素材と画素一致、2役は630〜750msだけ2枚（後続が前面）、後続は750〜1110ms静止・1230msで終了、単役は750msで終了', ok, JSON.stringify(r.out));
}

writeFileSync(new URL('e2e_report_V320-FIX-05.json', OUT), JSON.stringify({ id: 'V320-FIX-05', fontStandin: !!STANDIN, results, shots, errors }, null, 1));
console.log(`${results.filter((r) => r.pass).length}/${results.length} passed; errors=${errors.length}`, errors.slice(0, 5));
await browser.close();
server.kill();
process.exit(results.every((r) => r.pass) && !errors.length ? 0 : 1);
