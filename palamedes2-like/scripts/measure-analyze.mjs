// V320-MEASURE-01 計測記録の集計（要件10）。判断の正誤・最善手率は自動採点しない。生データ（件数・中央値・分布・生の値）を残す。
// 使い方：node scripts/measure-analyze.mjs <kotaro_measure_*.json> [出力.json]
//   出力を省略すると <入力>.analysis.json に保存し、要約を標準出力へ表示する。
// 時間の基準：
//   - ゲーム内の時間（硬直・役演出・操作可能・ラウンド）＝ tick（60tick/秒）を ms に換算。ラウンドをまたぐ比較はしない
//   - 入力の間隔・押下時間＝ t（performance.now 基準のセッション経過 ms。パッドは取得＝フレームの観測時刻で、精度は約1フレーム）
//   - 画面非表示・フォーカス喪失の区間に掛かる間隔は「除外」へ分けて数える（プレイヤーの判断時間へ混ぜない）
import { readFileSync, writeFileSync } from 'node:fs';

const TICK_MS = 1000 / 60;
const HUMAN_SRC = new Set(['pad', 'keyboard']);
/** 予約（1枠）を閉じる破棄理由。'left+right' の同時押しはコマンド自身の破棄 */
const BUFFER_CLOSE = new Set(['overwritten', 'expired', 'released', 'locked', 'edge', 'state']);

export function stats(values) {
  const v = values.filter((x) => typeof x === 'number' && Number.isFinite(x)).sort((a, b) => a - b);
  const n = v.length;
  if (!n) return { n: 0, median: null, mean: null, min: null, max: null, p10: null, p90: null };
  const q = (p) => {
    const i = (n - 1) * p;
    const lo = Math.floor(i);
    const hi = Math.ceil(i);
    return r1(v[lo] + (v[hi] - v[lo]) * (i - lo));
  };
  return { n, median: q(0.5), mean: r1(v.reduce((a, b) => a + b, 0) / n), min: v[0], max: v[n - 1], p10: q(0.1), p90: q(0.9) };
}

/** 分布（固定幅の度数）。生の値は raw に別途残す */
export function histogram(values, width) {
  const h = {};
  for (const x of values) {
    if (typeof x !== 'number' || !Number.isFinite(x)) continue;
    const b = Math.floor(x / width) * width;
    const k = `${b}-${b + width}`;
    h[k] = (h[k] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(h).sort((a, b) => parseFloat(a[0]) - parseFloat(b[0])));
}

const r1 = (x) => Math.round(x * 10) / 10;
const dist = (values, width) => ({ ...stats(values), hist: histogram(values, width), raw: values.map(r1) });
const inc = (o, k, n = 1) => (o[k] = (o[k] ?? 0) + n);

/** 非表示・フォーカス喪失の区間（t）。終わっていない区間は記録の最後まで */
export function hiddenIntervals(recs) {
  const out = [];
  let since = null;
  for (const r of recs) {
    if (r.e === 'visibility') {
      const away = r.d.hidden || !r.d.focused;
      if (away && since === null) since = r.t;
      else if (!away && since !== null) {
        out.push([since, r.t]);
        since = null;
      }
    }
    if (r.e === 'measureStop' && since !== null) {
      out.push([since, r.t]);
      since = null;
    }
  }
  if (since !== null) out.push([since, recs.length ? recs[recs.length - 1].t : since]);
  return out;
}

export function analyze(json) {
  const recs = json.records;
  const hidden = hiddenIntervals(recs);
  const overlapsHidden = (a, b) => hidden.some(([h0, h1]) => a <= h1 && b >= h0);
  // 計測区間の切れ目（停止〜再開）をまたぐ間隔も除外
  const gaps = [];
  let lastStop = null;
  for (const r of recs) {
    if (r.e === 'measureStop') lastStop = r.t;
    if (r.e === 'measureStart' && lastStop !== null) {
      gaps.push([lastStop, r.t]);
      lastStop = null;
    }
  }
  const crossesGap = (a, b) => gaps.some(([g0, g1]) => a <= g0 && b >= g1);
  const excluded = { hidden: 0, segmentGap: 0 };
  const okSpan = (a, b) => {
    if (overlapsHidden(a, b)) return (excluded.hidden++, false);
    if (crossesGap(a, b)) return (excluded.segmentGap++, false);
    return true;
  };

  // ---- 人間のプレイヤー（試合ごと） ----
  const humansByMatch = new Map();
  for (const r of recs) if (r.e === 'matchStart') humansByMatch.set(r.m, new Set(r.d.humans ?? []));
  const isHuman = (m, p) => humansByMatch.get(m)?.has(p) ?? false;

  // ---- コマンドの結果（受理・予約・破棄） ----
  const cmds = new Map(); // id -> {id, p, a, rep, src, t, at, f, m, r, outcome, reason, buffered}
  const pendingBuf = new Map(); // `${m}/${r}/${p}` -> cmd id
  const unattributed = {};
  const freshByFrame = new Map(); // `${f}/${p}` -> cmds（同じフレームで受けたコマンド）
  const close = (c, outcome, reason = null) => {
    if (!c || c.outcome) return;
    c.outcome = outcome;
    c.reason = reason;
  };
  for (const r of recs) {
    if (r.e === 'cmd') {
      const c = { id: r.d.id, p: r.d.p, a: r.d.a, rep: r.d.rep, src: r.d.src, t: r.t, at: r.d.at ?? r.t, f: r.f, m: r.m, r: r.r, outcome: null, reason: null, buffered: false };
      cmds.set(c.id, c);
      const key = `${r.f}/${c.p}`;
      if (!freshByFrame.has(key)) freshByFrame.set(key, []);
      freshByFrame.get(key).push(c);
      continue;
    }
    if (r.e === 'cmdDrop') {
      close(cmds.get(r.d.id), 'dropped', r.d.reason);
      continue;
    }
    if (r.e !== 'in') continue;
    const d = r.d;
    const bk = `${r.m}/${r.r}/${d.p}`;
    const own = d.id !== null ? cmds.get(d.id) : null;
    switch (d.kind) {
      case 'execute':
        if (d.d?.via === 'buffer') close(cmds.get(pendingBuf.get(bk)), 'executedBuffered'), pendingBuf.delete(bk);
        else close(own, 'executed');
        break;
      case 'reject':
        if (d.d?.via === 'buffer') close(cmds.get(pendingBuf.get(bk)), 'bufferRejected', d.reason), pendingBuf.delete(bk);
        else if (own) close(own, 'rejected', d.reason);
        else inc(unattributed, `reject:${d.reason}`);
        break;
      case 'drop':
        if (own) close(own, 'dropped', d.reason);
        else inc(unattributed, `drop:${d.reason}`);
        break;
      case 'buffer':
        if (own) {
          own.buffered = true;
          pendingBuf.set(bk, own.id);
        } else inc(unattributed, 'buffer');
        break;
      case 'consume':
        break; // 次の execute／reject（via buffer）で閉じる
      case 'discard': {
        if (d.reason === 'repeatIgnored') close(own, 'discarded', d.reason);
        else if (d.reason === 'simultaneous' && d.a === 'left+right') {
          const same = (freshByFrame.get(`${r.f}/${d.p}`) ?? []).filter((c) => !c.outcome && (c.a === 'left' || c.a === 'right') && !c.rep);
          if (same.length) same.forEach((c) => close(c, 'discarded', 'simultaneous'));
          else inc(unattributed, 'discard:simultaneous');
        } else if (BUFFER_CLOSE.has(d.reason) || d.reason === 'simultaneous') {
          const id = pendingBuf.get(bk);
          if (id !== undefined) {
            close(cmds.get(id), 'bufferDiscarded', d.reason);
            pendingBuf.delete(bk);
          } else inc(unattributed, `discard:${d.reason}`);
        } else if (own) close(own, 'discarded', d.reason);
        else inc(unattributed, `discard:${d.reason}`);
        break;
      }
      default:
        break; // lock は硬直の記録
    }
  }
  for (const c of cmds.values()) if (!c.outcome) c.outcome = c.buffered ? 'bufferPendingAtEnd' : 'noTrace';

  const players = new Map(); // `${m}/${p}`→ 集計
  const human = [...cmds.values()].filter((c) => HUMAN_SRC.has(c.src) && c.a !== 'cancelRepeat');
  const outcomeTable = (list) => {
    const by = {};
    const reasons = {};
    for (const c of list) {
      inc(by, c.outcome);
      if (c.reason) inc(reasons, `${c.outcome}:${c.reason}`);
    }
    const n = list.length;
    const accepted = (by.executed ?? 0) + (by.executedBuffered ?? 0);
    const reserved = list.filter((c) => c.buffered).length;
    const discarded = n - accepted - (by.bufferPendingAtEnd ?? 0);
    return {
      n,
      accepted,
      reserved,
      discarded,
      rate: n ? { accepted: Math.round((accepted / n) * 1000) / 10, reserved: Math.round((reserved / n) * 1000) / 10, discarded: Math.round((discarded / n) * 1000) / 10 } : null,
      byOutcome: by,
      byReason: reasons,
    };
  };
  const byAction = {};
  for (const c of human) (byAction[c.a] ??= []).push(c);

  // ---- 押下間隔・反復間隔 ----
  const newPress = human.filter((c) => !c.rep);
  const intervals = (list) => {
    const out = [];
    for (let i = 1; i < list.length; i++) {
      const a = list[i - 1];
      const b = list[i];
      if (a.p !== b.p) continue;
      if (okSpan(a.at, b.at)) out.push(b.at - a.at);
    }
    return out;
  };
  const perPlayer = (list) => {
    const g = {};
    for (const c of list) (g[`${c.src}:${c.p}`] ??= []).push(c);
    return Object.values(g);
  };
  const newPressAll = perPlayer(newPress).flatMap(intervals);
  const newPressSame = {};
  for (const [a, list] of Object.entries(byAction)) newPressSame[a] = dist(perPlayer(list.filter((c) => !c.rep)).flatMap(intervals), 50);
  const repeatSame = {};
  for (const [a, list] of Object.entries(byAction)) {
    const rep = perPlayer(list).flatMap((pl) => {
      const out = [];
      for (let i = 1; i < pl.length; i++) if (pl[i].rep && okSpan(pl[i - 1].at, pl[i].at)) out.push(pl[i].at - pl[i - 1].at);
      return out;
    });
    if (rep.length) repeatSame[a] = dist(rep, 25);
  }

  // ---- 押下時間（パッドのボタン・キー） ----
  const holdPad = {};
  const downPad = new Map();
  const holdKey = {};
  const downKey = new Map();
  for (const r of recs) {
    if (r.e === 'padBtn') {
      const k = `${r.d.i}/${r.d.b}`;
      const ts = r.t; // 観測（取得）時刻。Gamepad.timestamp は実装差があるため生値として残すだけ
      if (r.d.p) {
        if (!downPad.has(k)) downPad.set(k, ts);
      } else if (downPad.has(k)) {
        const t0 = downPad.get(k);
        downPad.delete(k);
        if (okSpan(t0, ts)) (holdPad[`b${r.d.b}`] ??= []).push(ts - t0);
      }
    } else if (r.e === 'padGone' || r.e === 'measureStop') {
      downPad.clear(); // 切断・停止で押下中の対応は捨てる（誤った長押しを作らない）
    } else if (r.e === 'keyDown' && !r.d.repeat) {
      if (!downKey.has(r.d.code)) downKey.set(r.d.code, r.d.at ?? r.t);
    } else if (r.e === 'keyUp' && downKey.has(r.d.code)) {
      const t0 = downKey.get(r.d.code);
      downKey.delete(r.d.code);
      const t1 = r.d.at ?? r.t;
      if (okSpan(t0, t1)) (holdKey[r.d.code] ??= []).push(t1 - t0);
    }
  }

  // ---- 硬直・役演出・操作可能の時間（tick）と、操作可能になってから次の実行まで ----
  const lockTicks = {}; // `${p}` -> {lock kind: ticks}
  const operableToExec = [];
  const cur = new Map(); // `${m}/${r}/${p}` -> {lock, moving, k}
  const operableSince = new Map(); // key -> {k, t}
  const roundEndTick = new Map();
  for (const r of recs) if (r.e === 'ev' && r.d.type === 'roundEnd') roundEndTick.set(`${r.m}/${r.r}`, r.k);
  const accLock = (key, p, upto) => {
    const s = cur.get(key);
    if (!s || upto == null || s.k == null) return;
    const kind = s.lock !== 'none' ? s.lock : s.moving !== null ? 'moving' : 'operable';
    inc((lockTicks[p] ??= {}), kind, Math.max(0, upto - s.k));
    s.k = upto;
  };
  for (const r of recs) {
    if (r.e === 'roundStart') {
      for (const pl of r.d.players ?? []) {
        if (!isHuman(r.m, pl.id)) continue;
        const key = `${r.m}/${r.r}/${pl.id}`;
        // 開始前待機（playStartTick 前）は数えない
        cur.set(key, { lock: pl.lock, moving: pl.moving, k: Math.max(r.k ?? 0, r.d.playStartTick ?? 0) });
      }
      continue;
    }
    if (r.e === 'measureStop') {
      for (const [key, s] of cur) {
        const p = key.split('/')[2];
        accLock(key, p, r.k ?? s.k);
        cur.delete(key);
      }
      operableSince.clear();
      continue;
    }
    if (r.e === 'st' && r.d.p !== undefined && isHuman(r.m, r.d.p) && ('lock' in r.d || 'moving' in r.d)) {
      const key = `${r.m}/${r.r}/${r.d.p}`;
      const end = roundEndTick.get(`${r.m}/${r.r}`);
      if (end !== undefined && r.k > end) continue;
      if (!cur.has(key)) continue;
      accLock(key, r.d.p, r.k);
      const s = cur.get(key);
      if ('lock' in r.d) s.lock = r.d.lock;
      if ('moving' in r.d) s.moving = r.d.moving;
      const operable = s.lock === 'none' && s.moving === null;
      if (operable && !operableSince.has(key)) operableSince.set(key, { k: r.k, t: r.t });
      if (!operable) operableSince.delete(key);
      continue;
    }
    if (r.e === 'in' && r.d.kind === 'execute' && isHuman(r.m, r.d.p)) {
      const key = `${r.m}/${r.r}/${r.d.p}`;
      const o = operableSince.get(key);
      if (o && okSpan(o.t, r.t)) operableToExec.push((r.k - o.k) * TICK_MS);
      operableSince.delete(key);
      continue;
    }
    if (r.e === 'ev' && r.d.type === 'roundEnd') {
      for (const [key, s] of cur) if (key.startsWith(`${r.m}/${r.r}/`)) accLock(key, key.split('/')[2], r.k), cur.delete(key);
    }
  }
  const lockMs = Object.fromEntries(Object.entries(lockTicks).map(([p, o]) => [p, Object.fromEntries(Object.entries(o).map(([k, v]) => [k, r1(v * TICK_MS)]))]));

  // ---- 打ち上げ・連鎖切れ・宣言・役連鎖・ピンチ・ラウンド ----
  const evOf = (type) => recs.filter((r) => r.e === 'ev' && r.d.type === type);
  const humanEv = (type) => evOf(type).filter((r) => isHuman(r.m, r.d.player));
  const cpuEv = (type) => evOf(type).filter((r) => r.d.player !== undefined && !isHuman(r.m, r.d.player));
  const launchStats = (list) => {
    const ok = list.filter((r) => r.d.success).length;
    return { arrive: list.length, success: ok, fail: list.length - ok, successRate: list.length ? Math.round((ok / list.length) * 1000) / 10 : null };
  };
  const cuts = humanEv('streakCut');
  const ended = cuts.filter((r) => r.d.state === 'ended');
  const declares = humanEv('declare');
  const declareIntervals = [];
  const readyToDeclare = [];
  const chainNext = { declares: 0, continued: 0 };
  const byPR = (list) => {
    const g = {};
    for (const r of list) (g[`${r.m}/${r.r}/${r.d.player}`] ??= []).push(r);
    return g;
  };
  const decl = byPR(declares);
  const ready = byPR(humanEv('roleAvailable'));
  for (const [key, list] of Object.entries(decl)) {
    for (let i = 0; i < list.length; i++) {
      chainNext.declares++;
      if (i + 1 < list.length && list[i + 1].d.chainCount === list[i].d.chainCount + 1) chainNext.continued++;
      if (i > 0 && okSpan(list[i - 1].t, list[i].t)) declareIntervals.push((list[i].k - list[i - 1].k) * TICK_MS);
    }
    // 成立（roleAvailable）→ 次の宣言
    for (const ra of ready[key] ?? []) {
      const next = list.find((d) => d.k >= ra.k);
      if (next && okSpan(ra.t, next.t)) readyToDeclare.push((next.k - ra.k) * TICK_MS);
    }
  }
  const pinch = { start: 0, recovered: 0, defeated: 0, endOther: 0 };
  for (const [key, list] of Object.entries(byPR(humanEv('pinchWarn')))) {
    for (const r of list) {
      if (r.d.state === 'start') pinch.start++;
      if (r.d.state === 'end') {
        const [m, rr, p] = key.split('/');
        const lost = recs.some((x) => x.e === 'ev' && x.d.type === 'roundEnd' && `${x.m}` === m && `${x.r}` === rr && x.d.winner !== null && `${x.d.winner}` !== p && Math.abs(x.k - r.k) <= 1);
        const defeatEv = recs.some((x) => x.e === 'ev' && (x.d.type === 'danger' || x.d.type === 'attackPinch') && x.d.state === 'defeat' && `${x.m}` === m && `${x.r}` === rr && `${x.d.player}` === p && Math.abs(x.k - r.k) <= 1);
        if (lost || defeatEv) pinch.defeated++;
        else pinch.recovered++;
      }
    }
  }
  const rounds = [];
  for (const r of recs) {
    if (r.e !== 'roundStart' || r.d.why === 'measureStart' && rounds.some((x) => x.m === r.m && x.r === r.r)) continue;
    const end = recs.find((x) => x.e === 'ev' && x.d.type === 'roundEnd' && x.m === r.m && x.r === r.r);
    rounds.push({ m: r.m, r: r.r, startedMidRound: r.d.why === 'measureStart', playStartTick: r.d.playStartTick, endTick: end?.k ?? null, playMs: end ? r1((end.k - Math.max(r.d.playStartTick ?? 0, r.k ?? 0)) * TICK_MS) : null, winner: end?.d.winner ?? null, outcome: end?.d.outcome ?? null, humans: [...(humansByMatch.get(r.m) ?? [])] });
  }
  const matches = [];
  for (const r of recs) {
    if (r.e !== 'matchStart' || r.d.why === 'measureStart' && matches.some((x) => x.m === r.m)) continue;
    const res = [...recs].reverse().find((x) => x.e === 'session' && x.m === r.m && x.d.state === 'matchResult');
    const lastSess = [...recs].reverse().find((x) => x.e === 'session' && x.m === r.m);
    matches.push({ m: r.m, mode: r.d.mode, kind: r.d.kind, difficulty: r.d.difficulty ?? null, characters: r.d.characters, profile: r.d.profile, humans: r.d.humans, finished: !!res, wins: (res ?? lastSess)?.d.wins ?? null, rounds: rounds.filter((x) => x.m === r.m).length, timeMs: res ? r1(res.t - r.t) : null });
  }

  return {
    format: 'kotaro-puzzle-measure-analysis',
    version: 1,
    source: { session: json.header?.session?.id ?? null, records: recs.length, formatVersion: json.header?.formatVersion ?? null, profile: json.header?.settings?.selectedProfile ?? null },
    notes: [
      '判断の正誤・最善手率は採点しない（要件10）',
      'ゲーム内時間は tick 換算。入力の間隔・押下時間は t（取得時の観測時刻。約1フレームの精度）。物理的な押下時刻ではない',
      '非表示・フォーカス喪失の区間、計測停止〜再開の区間に掛かる間隔は除外（excluded に件数）',
      '「役が成立していた時間」は成立（roleAvailable）から宣言までの時間で、プレイヤーが認識した時刻ではない',
    ],
    excluded,
    hiddenIntervals: hidden,
    commands: { human: outcomeTable(human), byAction: Object.fromEntries(Object.entries(byAction).map(([a, l]) => [a, outcomeTable(l)])), cpu: outcomeTable([...cmds.values()].filter((c) => c.src === 'cpu')), unattributedTrace: unattributed },
    newPressIntervalMs: dist(newPressAll, 50),
    newPressIntervalSameActionMs: newPressSame,
    repeatIntervalSameActionMs: repeatSame,
    holdMs: { pad: Object.fromEntries(Object.entries(holdPad).map(([k, v]) => [k, dist(v, 50)])), keyboard: Object.fromEntries(Object.entries(holdKey).map(([k, v]) => [k, dist(v, 50)])) },
    timeByStateMs: lockMs,
    operableToNextExecuteMs: dist(operableToExec, 50),
    launch: { human: launchStats(humanEv('arrive')), cpu: launchStats(cpuEv('arrive')) },
    streakCut: { reserved: cuts.filter((r) => r.d.state === 'reserved').length, ended: ended.length, endedLength: dist(ended.map((r) => r.d.count), 1) },
    declare: { count: declares.length, intervalMs: dist(declareIntervals, 500), roleReadyToDeclareMs: dist(readyToDeclare, 250), fails: humanEv('declareFail').length },
    chain: { ...chainNext, continuationRate: chainNext.declares ? Math.round((chainNext.continued / chainNext.declares) * 1000) / 10 : null },
    pinch: { ...pinch, recoveryRate: pinch.recovered + pinch.defeated ? Math.round((pinch.recovered / (pinch.recovered + pinch.defeated)) * 1000) / 10 : null },
    rounds,
    matches,
  };
}

function summary(a) {
  const c = a.commands.human;
  return [
    `セッション ${a.source.session}（${a.source.records}件、打上${a.source.profile}）`,
    `人間の操作 ${c.n}件：受理 ${c.accepted}（${c.rate?.accepted}%）・予約 ${c.reserved}（${c.rate?.reserved}%）・破棄 ${c.discarded}（${c.rate?.discarded}%）`,
    `破棄・却下の理由：${JSON.stringify(c.byReason)}`,
    `新規押下の間隔 中央値 ${a.newPressIntervalMs.median}ms（${a.newPressIntervalMs.n}件）／操作可能→次の実行 中央値 ${a.operableToNextExecuteMs.median}ms（${a.operableToNextExecuteMs.n}件）`,
    `打ち上げ成功率 人間 ${a.launch.human.successRate}%（${a.launch.human.arrive}）／CPU ${a.launch.cpu.successRate}%（${a.launch.cpu.arrive}）`,
    `連鎖切れ ${a.streakCut.ended}回（長さ中央値 ${a.streakCut.endedLength.median}）／宣言 ${a.declare.count}回・間隔中央値 ${a.declare.intervalMs.median}ms・成立→宣言 中央値 ${a.declare.roleReadyToDeclareMs.median}ms`,
    `役連鎖の継続率 ${a.chain.continuationRate}%／ピンチ ${a.pinch.start}回・回復率 ${a.pinch.recoveryRate}%`,
    `ラウンド ${a.rounds.length}／試合 ${a.matches.length}。除外：非表示 ${a.excluded.hidden}・停止区間 ${a.excluded.segmentGap}`,
    `状態別の時間（ms）：${JSON.stringify(a.timeByStateMs)}`,
  ].join('\n');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [, , input, output] = process.argv;
  if (!input) {
    console.error('使い方：node scripts/measure-analyze.mjs <kotaro_measure_*.json> [出力.json]');
    process.exit(2);
  }
  const json = JSON.parse(readFileSync(input, 'utf8'));
  const a = analyze(json);
  writeFileSync(output ?? `${input}.analysis.json`, JSON.stringify(a, null, 1));
  console.log(summary(a));
}
