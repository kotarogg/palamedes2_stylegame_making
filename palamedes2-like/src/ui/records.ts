// シングルの記録（設計補完）：ひたすら／ステージクリアを分けてベスト1件、MODE2シングルは最短クリア時間。
// CPU・2P対戦・教材・放置デモ・CPU観戦の結果は記録に混ぜない。保存できなくてもゲームを止めない。
// V320-FIX-04：ステージクリアは全20面ルール（旧全10面の記録は消さず「旧ルール」として別に保持し、20面クリアとして表示しない）。
// MODE2シングルは総合ベストとノーリセット専用ベストの2種類（同タイムは新記録でない。tickで比較）。ノーリセット達成回数は今後加算しない。

/** 更新する記録へ付けるルール識別 */
export const STAGE_RULE_ID = 'stage20_V320-FIX-04';
export const MODE2_RULE_ID = 'mode2_V320-FIX-04';

export interface StageRecord {
  score: number;
  maxStage: number;
  completed: boolean;
  /** ルール識別（無い旧データは全10面ルールの記録） */
  rule?: string;
}

/** MODE2 のベストタイム。ticks があれば ticks で比較（旧データは ms のみ） */
export interface Mode2Best {
  bestMs: number;
  bestTicks?: number;
  rule?: string;
}

export interface Records {
  endless: { score: number; level: number } | null;
  /** 全20面ルールのステージ記録 */
  stage: StageRecord | null;
  /** 旧ルール（全10面）のステージ記録。読込のみ・更新しない */
  stageLegacy10: StageRecord | null;
  /** MODE2シングル 総合ベスト（全正常クリア） */
  mode2Single: Mode2Best | null;
  /** MODE2シングル ノーリセット専用ベスト（場の更新0回の完走だけ） */
  mode2NoResetBest: Mode2Best | null;
  /** v3.2.0 のノーリセット達成回数（旧保存値。読み出しと保存の保持だけで、今後は加算・表示しない） */
  mode2NoReset: number;
}

export const RECORDS_KEY = 'palamedes2-like.records.v1';

export const emptyRecords = (): Records => ({ endless: null, stage: null, stageLegacy10: null, mode2Single: null, mode2NoResetBest: null, mode2NoReset: 0 });

export function parseRecords(raw: string | null): Records {
  const r = emptyRecords();
  if (!raw) return r;
  try {
    const s = JSON.parse(raw) as Partial<Records>;
    const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
    const stage = (x: StageRecord | null | undefined): StageRecord | null =>
      x && num(x.score) && num(x.maxStage) ? { score: x.score, maxStage: x.maxStage, completed: x.completed === true, ...(typeof x.rule === 'string' ? { rule: x.rule } : {}) } : null;
    const best = (x: Mode2Best | null | undefined): Mode2Best | null =>
      x && num(x.bestMs) ? { bestMs: x.bestMs, ...(num(x.bestTicks) ? { bestTicks: Math.floor(x.bestTicks) } : {}), ...(typeof x.rule === 'string' ? { rule: x.rule } : {}) } : null;
    if (s.endless && num(s.endless.score) && num(s.endless.level)) r.endless = { score: s.endless.score, level: s.endless.level };
    const st = stage(s.stage);
    // ルール識別のない旧ステージ記録は全10面ルール。消さずに旧ルール欄へ移す
    if (st && st.rule === STAGE_RULE_ID) r.stage = st;
    else if (st) r.stageLegacy10 = st;
    r.stageLegacy10 = stage(s.stageLegacy10) ?? r.stageLegacy10;
    r.mode2Single = best(s.mode2Single);
    r.mode2NoResetBest = best(s.mode2NoResetBest);
    if (num(s.mode2NoReset)) r.mode2NoReset = Math.floor(s.mode2NoReset);
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

/** 全20面ルールのステージ記録（旧ルール記録とは比較しない） */
export function submitStage(r: Records, score: number, reachedStage: number, completed: boolean): boolean {
  const prev = r.stage;
  const better = !prev || score > prev.score;
  r.stage = {
    score: better ? score : prev!.score,
    maxStage: Math.max(prev?.maxStage ?? 0, reachedStage),
    completed: (prev?.completed ?? false) || completed,
    rule: STAGE_RULE_ID,
  };
  return better;
}

/** 速いか（tick があれば tick、旧データは ms で比較。同値は false） */
function faster(ticks: number, ms: number, prev: Mode2Best | null): boolean {
  if (!prev) return true;
  return prev.bestTicks !== undefined ? ticks < prev.bestTicks : ms < prev.bestMs;
}

export interface Mode2Submit {
  /** 総合ベストの更新 */
  total: boolean;
  /** ノーリセット専用ベストの更新（noReset でなければ常に false） */
  noReset: boolean;
}

/** MODE2シングルのクリア：総合と（noReset のときだけ）専用を独立に判定する。同タイムは新記録でない */
export function submitMode2(r: Records, ticks: number, ms: number, noReset: boolean): Mode2Submit {
  const rec: Mode2Best = { bestMs: ms, bestTicks: ticks, rule: MODE2_RULE_ID };
  const total = faster(ticks, ms, r.mode2Single);
  if (total) r.mode2Single = { ...rec };
  const nr = noReset && faster(ticks, ms, r.mode2NoResetBest);
  if (nr) r.mode2NoResetBest = { ...rec };
  return { total, noReset: nr };
}
