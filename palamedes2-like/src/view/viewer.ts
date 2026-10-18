// 素材確認画面（全PNG切出し・主要モーション・役名16×3フレーム・攻撃表示0〜29）
import { layoutAttackIcons } from '../core/attack';
import { DEFAULT_VIEW_CONFIG } from '../core/config';
import { drawFrame, type Assets } from './assets';
import type { ManifestFrame } from './data';

export const VIEWER_PAGES = ['キャラ・猫モーション', '役名16種×A/B/C', 'S4ピース（通常・小型・B暗色）', 'S6エフェクト', 'S5 UI', '攻撃表示 0〜29'] as const;

export class AssetViewer {
  page = 0;

  constructor(private readonly assets: Assets) {}

  next(dir: number): void {
    this.page = (this.page + dir + VIEWER_PAGES.length) % VIEWER_PAGES.length;
  }

  render(ctx: CanvasRenderingContext2D, ms: number): void {
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = '#14142a';
    ctx.fillRect(0, 0, 640, 360);
    [this.motions, this.roles, this.pieces, this.effects, this.ui, this.attack][this.page].call(this, ctx, ms);
    this.label(ctx, `素材確認 ${this.page + 1}/${VIEWER_PAGES.length}：${VIEWER_PAGES[this.page]}（←→で切替 / Vで戻る）`, 4, 348);
  }

  private label(ctx: CanvasRenderingContext2D, s: string, x: number, y: number, color = '#ffffff'): void {
    ctx.font = '9px "Noto Sans CJK JP", "Yu Gothic", "Meiryo", sans-serif';
    ctx.textBaseline = 'top';
    ctx.fillStyle = color;
    ctx.fillText(s, x, y);
  }

  private anim(sheet: string, name: string, ms: number, per: number): ManifestFrame {
    const fr = this.assets.atlas.animation(sheet, name);
    return fr[Math.floor(ms / per) % fr.length];
  }

  private motions(ctx: CanvasRenderingContext2D, ms: number): void {
    const names = ['idle', 'walk', 'launch', 'attack', 'win', 'lose_fall'];
    ['S1', 'S2'].forEach((sheet, row) => {
      names.forEach((n, i) => {
        const x = 8 + i * 70;
        const y = 8 + row * 84;
        drawFrame(ctx, this.assets, this.anim(sheet, n, ms, 160), x, y);
        this.label(ctx, `${sheet} ${n}`, x, y + 58);
      });
    });
    const cat = ['idle', 'ready', 'start', 'cracker', 'joy', 'surprise', 'panic', 'sad'];
    cat.forEach((n, i) => {
      const x = 8 + i * 60;
      drawFrame(ctx, this.assets, this.anim('S3', n, ms, 200), x, 190);
      this.label(ctx, `S3 ${n}`, x, 240);
    });
    // B押下時の一瞬ポーズに使う枠
    const pose = DEFAULT_VIEW_CONFIG.bPoseSlotId;
    drawFrame(ctx, this.assets, this.assets.atlas.frame('S1', pose), 440, 8);
    drawFrame(ctx, this.assets, this.assets.atlas.frame('S2', pose), 440, 92);
    this.label(ctx, `Bポーズ ${pose}`, 440, 66);
    this.label(ctx, '予備透明枠(reserved)はアニメーションに含めない', 8, 262, '#9aa4c0');
  }

  private roles(ctx: CanvasRenderingContext2D, ms: number): void {
    const letter = (['A', 'B', 'C'] as const)[Math.floor(ms / DEFAULT_VIEW_CONFIG.roleFrameMs) % 3];
    for (let i = 0; i < 16; i++) {
      const x = (i % 4) * 160;
      const y = Math.floor(i / 4) * 84;
      drawFrame(ctx, this.assets, this.assets.atlas.role(i, letter), x, y);
      this.label(ctx, `R${String(i + 1).padStart(2, '0')} ${letter}`, x + 2, y + 66, '#c0d8ff');
    }
  }

  private flow(ctx: CanvasRenderingContext2D, frames: ManifestFrame[], x0: number, y0: number, maxX: number, dark = false): number {
    let x = x0;
    let y = y0;
    let rowH = 0;
    for (const f of frames) {
      if (x + f.w > maxX) {
        x = x0;
        y += rowH + 3;
        rowH = 0;
      }
      ctx.strokeStyle = '#30305a';
      ctx.strokeRect(x - 0.5, y - 0.5, f.w + 1, f.h + 1);
      drawFrame(ctx, this.assets, f, x, y, { dark });
      x += f.w + 3;
      rowH = Math.max(rowH, f.h);
    }
    return y + rowH;
  }

  private pieces(ctx: CanvasRenderingContext2D): void {
    const s4 = this.assets.atlas.manifest.frames.filter((f) => f.sheet === 'S4');
    const normal = s4.filter((f) => f.id.startsWith('piece_'));
    let y = this.flow(ctx, normal, 4, 4, 640);
    y = this.flow(ctx, s4.filter((f) => f.id.startsWith('small_')), 4, y + 6, 640);
    this.label(ctx, '↓B入替中の暗色表示（元PNGは変更せず描画時に生成）', 4, y + 6);
    this.flow(ctx, normal, 4, y + 18, 640, true);
  }

  private effects(ctx: CanvasRenderingContext2D): void {
    this.flow(ctx, this.assets.atlas.manifest.frames.filter((f) => f.sheet === 'S6'), 4, 4, 636);
  }

  private ui(ctx: CanvasRenderingContext2D): void {
    this.flow(ctx, this.assets.atlas.manifest.frames.filter((f) => f.sheet === 'S5'), 4, 4, 636);
  }

  private attack(ctx: CanvasRenderingContext2D): void {
    const rules = this.assets.layout.attackRules();
    const big = this.assets.atlas.frame('S5', 'attack_icon_big');
    const small = this.assets.atlas.frame('S5', 'attack_icon_small');
    for (let n = 0; n <= 29; n++) {
      const ox = 6 + (n % 15) * 42;
      const oy = 14 + Math.floor(n / 15) * 166;
      this.label(ctx, String(n), ox, oy - 11, '#c0d8ff');
      ctx.strokeStyle = '#30305a';
      ctx.strokeRect(ox - 0.5, oy - 0.5, 41, 145);
      const icons = layoutAttackIcons(n, [ox, oy], rules);
      icons.big.forEach((b) => drawFrame(ctx, this.assets, big, b.x, b.y));
      icons.small.forEach((s) => drawFrame(ctx, this.assets, small, s.x, s.y));
    }
  }
}
