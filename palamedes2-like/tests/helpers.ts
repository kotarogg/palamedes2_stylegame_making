import { readFileSync } from 'node:fs';
import { DEFAULT_CONFIG, type GameConfig } from '../src/core/config';
import { Game, type Command } from '../src/core/game';
import type { Piece, PlayerId, Suit } from '../src/core/types';
import { Layout, SpriteAtlas, type ScreenLayout, type SpriteManifest } from '../src/view/data';

export const ROOT = new URL('..', import.meta.url);

export function readJson<T>(rel: string): T {
  return JSON.parse(readFileSync(new URL(rel, ROOT), 'utf8')) as T;
}

export const manifest = () => readJson<SpriteManifest>('public/data/sprite_manifest_v2.json');
export const layoutData = () => readJson<ScreenLayout>('public/data/screen_layout_v2.json');
export const layout = () => new Layout(layoutData());
export const atlas = () => new SpriteAtlas(manifest());

const SUIT: Record<string, Suit> = { s: 'spade', d: 'diamond', c: 'club', h: 'heart' };

/** '2h' → 2♥ */
export const kind = (code: string): { n: number; suit: Suit } => ({ n: Number(code[0]), suit: SUIT[code[1]] });

/** 自然上昇なしの検証用設定（必要に応じて上書き） */
export function testConfig(over: Partial<GameConfig> = {}): GameConfig {
  return { ...DEFAULT_CONFIG, naturalRiseIntervalMs: null, ...over };
}

export interface Setup {
  base?: string;
  /** player -> col -> 上から並べたピースコード */
  boards?: Partial<Record<PlayerId, Record<number, string[]>>>;
}

export function makeGame(setup: Setup = {}, config: GameConfig = testConfig(), seed = 7): Game {
  return new Game({
    seed,
    config,
    setup: (g) => {
      if (setup.base) g.base = g.factory.make(kind(setup.base).n, kind(setup.base).suit);
      for (const [pid, cols] of Object.entries(setup.boards ?? {})) {
        const b = g.players[Number(pid) as PlayerId].board;
        for (const [c, codes] of Object.entries(cols as Record<number, string[]>))
          b.cols[Number(c)] = codes.map((code) => ({ kind: 'piece' as const, piece: g.factory.make(kind(code).n, kind(code).suit) }));
      }
    },
  });
}

/** 入力受付開始（READY終了）まで進める */
export function toPlay(g: Game): void {
  while (!g.playing) g.step();
}

export function stepN(g: Game, n: number, cmds: (tick: number) => Command[] = () => []): void {
  for (let i = 0; i < n; i++) g.step(cmds(g.tick + 1));
}

export function stepUntil(g: Game, tick: number, cmds: (tick: number) => Command[] = () => []): void {
  while (g.tick < tick) g.step(cmds(g.tick + 1));
}

export const top = (g: Game, p: PlayerId, col: number): Piece | null => {
  const s = g.players[p].board.cols[col][0];
  return s && s.kind === 'piece' ? s.piece : null;
};

export const label = (p: { n: number; suit: Suit }) => `${p.n}${p.suit[0]}`;

/** 役ストックを差し替える（コード列 '1s' など） */
export function setStock(g: Game, p: PlayerId, ...codes: string[]): void {
  g.players[p].roleStock = codes.map((c) => g.factory.make(kind(c).n, kind(c).suit));
}

/** 全列を同じ段数のピースで埋めた盤面指定（上から） */
export function rows(n: number, code = '5c'): Record<number, string[]> {
  const out: Record<number, string[]> = {};
  for (let c = 0; c < 6; c++) out[c] = Array.from({ length: n }, () => code);
  return out;
}

export const EMPTY: Record<number, string[]> = rows(0);

/** 盤面・移動中のピースIDがすべて一意か */
export function allPieceIds(g: Game): number[] {
  const ids: number[] = [];
  for (const p of g.players) ids.push(...p.board.allIds());
  return ids;
}
