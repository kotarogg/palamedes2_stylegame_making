// シングルの記録（設計補完）：ひたすら／ステージクリアを分けてベスト1件、MODE2シングルは最短クリア時間。
// CPU・2P対戦の結果は記録に混ぜない。保存できなくてもゲームを止めない。
export interface Records {
  endless: { score: number; level: number } | null;
  stage: { score: number; maxStage: number; completed: boolean } | null;
  mode2Single: { bestMs: number } | null;
  /** v3.2.0 MODE2シングルのノーリセットクリア達成回数（旧データにない場合は0。最短時間とは別） */
  mode2NoReset: number;
}

export const RECORDS_KEY = 'palamedes2-like.records.v1';

export const emptyRecords = (): Records => ({ endless: null, stage: null, mode2Single: null, mode2NoReset: 0 });

export function parseRecords(raw: string | null): Records {
  const r = emptyRecords();
  if (!raw) return r;
  try {
    const s = JSON.parse(raw) as Partial<Records>;
    const num = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= 0;
    if (s.endless && num(s.endless.score) && num(s.endless.level)) r.endless = { score: s.endless.score, level: s.endless.level };
    if (s.stage && num(s.stage.score) && num(s.stage.maxStage)) r.stage = { score: s.stage.score, maxStage: s.stage.maxStage, completed: s.stage.completed === true };
    if (s.mode2Single && num(s.mode2Single.bestMs)) r.mode2Single = { bestMs: s.mode2Single.bestMs };
    if (num(s.mode2NoReset)) r.mode2NoReset = Math.floor(s.mode2NoReset!);
  } catch {
    // 壊れていれば空
  }
  return r;
}

export function loadRecords(): Records {
  try {
    return parseRecords(localStorage.getItem(RECORDS_KEY));
  } catch {
    return emptyRecords();
  }
}

export function saveRecords(r: Records): void {
  try {
    localStorage.setItem(RECORDS_KEY, JSON.stringify(r));
  } catch {
    // 保存できない環境では保存しない
  }
}

/** 記録を更新する。新記録なら true */
export function submitEndless(r: Records, score: number, level: number): boolean {
  if (r.endless && r.endless.score >= score) return false;
  r.endless = { score, level };
  return true;
}

export function submitStage(r: Records, score: number, reachedStage: number, completed: boolean): boolean {
  const prev = r.stage;
  const better = !prev || score > prev.score;
  r.stage = {
    score: better ? score : prev!.score,
    maxStage: Math.max(prev?.maxStage ?? 0, reachedStage),
    completed: (prev?.completed ?? false) || completed,
  };
  return better;
}

export function submitMode2(r: Records, ms: number): boolean {
  if (r.mode2Single && r.mode2Single.bestMs <= ms) return false;
  r.mode2Single = { bestMs: ms };
  return true;
}

/** v3.2.0 MODE2シングルのノーリセットクリア：1クリアにつき1回だけ加算（呼出し側がクリアごとに1回呼ぶ） */
export function submitMode2NoReset(r: Records): number {
  r.mode2NoReset += 1;
  return r.mode2NoReset;
}
