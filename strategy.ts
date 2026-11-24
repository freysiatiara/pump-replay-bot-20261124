// Capital-preservation strategy for the pump.fun bonding-curve replay
// (protocol agent-fun/replay/v2). Paper money only.
//
// Why this shape: on the dev window every active design the house ships
// loses heavily — its momentum pilot grades -9.49 SOL, its reversion pilot
// -4.00 SOL, its sniper -0.47 SOL, and a confirmed-momentum bot with pyramid
// adds graded -4.28 SOL (win rate ~0.10; the adds and the fee drag on churn
// do the damage: each round trip pays ~125 bps of curve fees on both sides
// plus 105,000 lamports per order, filled or not). Places are ranked by net
// PnL and a paid place needs net PnL above holding cash, so the only route
// to a prize is finishing above zero — which means risking as little as
// possible while still meeting the guardrail bar (a round trip of at least
// 0.01 SOL on at least 20 coins, max drawdown 50%).
//
// The bot therefore has exactly two moving parts:
//
// 1. Guardrail probes. Tiny 0.011 SOL round trips on liquid curves, paced
//    over the first hours of the window, sold whole as soon as the buy
//    lands. They exist only to clear the 20-coin bar with margin (target
//    24) at the smallest possible fee drag (~0.0005 SOL per coin).
//
// 2. A small "steady grind" sleeve — the only deliberate risk. It buys
//    mature curves whose tape over the last 120 slots shows a slow,
//    broad, two-half-confirmed grind upward (net inflow positive in both
//    halves, price up 3-20% across the window with no blow-off second
//    half, many distinct buyers, no single trade dominating) — the exact
//    opposite of the spike-chasing entries that bleed. Fixed 0.30 SOL
//    stake, never any adds, at most 2 open and 5 entries per run, and
//    hard exits: +14% take profit, -8% stop, flow fade, 1,200-slot time
//    limit. One or two take-profits cover the probe drag several times
//    over; a full slate of stops costs ~0.16 SOL, still far ahead of
//    every active baseline.
//
// Near the end of the window entries stop and everything managed is
// flattened, so the score is cash. Deterministic by construction: no
// clock, no environment, no randomness — only the batch stream,
// iterated in insertion order.

import type { Batch, Bot, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

export interface Params {
  // ---- guardrail probes ----
  /** Size of one probe round trip, SOL (bar is a 0.01 SOL round trip). */
  probeSol: number;
  /** Coins with a round trip the pacing aims for (bar is 20). */
  targetCoins: number;
  /** Block-time seconds over which the coin target is paced. */
  paceSeconds: number;
  /** Real SOL reserves a probe curve must hold (the 1%-of-reserves cap needs ~1.1). */
  probeMinRealSol: number;
  /** Most probe positions open at once. */
  maxConcurrentProbes: number;

  // ---- steady-grind sleeve ----
  /** Tape lookback (slots) the grind signal reads. */
  grindWindowSlots: number;
  /** Net SOL inflow (buys minus sells) required over the whole lookback... */
  grindMinNetInSol: number;
  /** ...and in each half of it (both halves must confirm). */
  grindMinHalfNetInSol: number;
  /** Buy trades required over the lookback. */
  grindMinBuyTrades: number;
  /** Distinct buying wallets required over the lookback. */
  grindMinDistinctBuyers: number;
  /** Price rise over the lookback: at least this, at most this. */
  grindMinRise: number;
  grindMaxRise: number;
  /** Second-half rise may not exceed this (no blow-off tops)... */
  grindMaxSecondHalfRise: number;
  /** ...and neither half may fall more than this (no mid-window collapse). */
  grindMaxHalfDrop: number;
  /** Largest single trade's share of gross window inflow allowed. */
  grindMaxTradeShare: number;
  /** Real SOL reserves bounds for a sleeve entry. */
  grindMinRealQuoteSol: number;
  grindMaxRealQuoteSol: number;
  /** Slots after the CreateEvent before any sleeve entry. */
  grindMinAgeSlots: number;
  /** Fixed stake per sleeve position, SOL. No adds, ever. */
  sleeveStakeSol: number;
  /** Most sleeve positions open at once. */
  sleeveMaxConcurrent: number;
  /** Most sleeve entries over the whole run. */
  sleeveMaxEntries: number;
  /** Slippage tolerance on buys, bps. Sells always go out at 10_000. */
  buySlippageBps: number;
  /** Take profit: exit when close value reaches cost * (1 + this). */
  takeProfitFrac: number;
  /** Stop: exit when close value falls to cost * (1 - this). */
  stopLossFrac: number;
  /** Flow-fade exit: net SOL over the last fadeWindowSlots below -fadeOutSol exits. */
  fadeWindowSlots: number;
  fadeOutSol: number;
  /** Time exit after this many slots held. */
  maxHoldSlots: number;

  // ---- window end ----
  /** Block-time seconds into the window after which no new buys open... */
  stopEntriesAfterSec: number;
  /** ...probes stop a little earlier (they must still round-trip)... */
  stopProbesAfterSec: number;
  /** ...and after which every managed position is sold. */
  flattenAfterSec: number;
}

export const DEFAULT_PARAMS: Params = {
  probeSol: 0.011,
  targetCoins: 24,
  paceSeconds: 5 * 3600,
  probeMinRealSol: 2.5,
  maxConcurrentProbes: 1,

  grindWindowSlots: 120,
  grindMinNetInSol: 1.5,
  grindMinHalfNetInSol: 0.25,
  grindMinBuyTrades: 10,
  grindMinDistinctBuyers: 6,
  grindMinRise: 0.03,
  grindMaxRise: 0.2,
  grindMaxSecondHalfRise: 0.12,
  grindMaxHalfDrop: 0.02,
  grindMaxTradeShare: 0.4,
  grindMinRealQuoteSol: 25,
  grindMaxRealQuoteSol: 85,
  grindMinAgeSlots: 600,
  sleeveStakeSol: 0.3,
  sleeveMaxConcurrent: 2,
  sleeveMaxEntries: 5,
  buySlippageBps: 1500,
  takeProfitFrac: 0.14,
  stopLossFrac: 0.08,
  fadeWindowSlots: 30,
  fadeOutSol: 1.0,
  maxHoldSlots: 1200,

  stopEntriesAfterSec: 18 * 3600,
  stopProbesAfterSec: 16 * 3600,
  flattenAfterSec: 22 * 3600,
};

const SOL = 1e9;
/** Curve fee share used when valuing a position for exits (protocol + creator, ~125 bps). */
const CURVE_FEE = 0.0125;

interface TapeTrade {
  slot: number;
  buy: boolean;
  sol: number;
  user: string;
  price: number;
}

interface Tape {
  createdSlot: number | null;
  trades: TapeTrade[];
}

interface SleevePosition {
  openedSlot: number;
  exitSent: boolean;
  anyFill: boolean;
}

export function createStrategy(p: Params = DEFAULT_PARAMS): Bot {
  const tapes = new Map<Pubkey, Tape>();
  const sleeve = new Map<Pubkey, SleevePosition>();
  /** Mints the sleeve has ever entered: one entry per mint, no re-chasing. */
  const sleeveUsed = new Set<Pubkey>();
  let sleeveEntries = 0;
  /** Probe round trips in flight, by mint: false while the buy is out, true once selling. */
  const probes = new Map<Pubkey, boolean>();
  const myCoins = new Set<Pubkey>();
  let firstBlockTime: number | null = null;
  let lastBlockTime: number | null = null;
  const keepSlots = p.grindWindowSlots + 10;

  const tapeOf = (mint: Pubkey): Tape => {
    let t = tapes.get(mint);
    if (t === undefined) {
      t = { createdSlot: null, trades: [] };
      tapes.set(mint, t);
    }
    return t;
  };

  /** Net recorded SOL flow (buys minus sells) on a tape over the last `w` slots. */
  const netFlow = (t: Tape, now: number, w: number): number => {
    let net = 0;
    for (let i = t.trades.length - 1; i >= 0; i--) {
      const tr = t.trades[i]!;
      if (tr.slot <= now - w) break;
      net += tr.buy ? tr.sol : -tr.sol;
    }
    return net;
  };

  /**
   * The grind signal: a slow, broad, two-half-confirmed rise on a mature
   * curve. Every clause rejects a way spike-chasing entries die — a hot
   * second half (blow-off), a collapsed half (dead bounce), one whale
   * carrying the tape, or a curve that already ran too far.
   */
  const grindOk = (t: Tape, now: number, realQuoteSol: number): boolean => {
    if (realQuoteSol < p.grindMinRealQuoteSol || realQuoteSol > p.grindMaxRealQuoteSol) return false;
    if (t.createdSlot === null || now - t.createdSlot < p.grindMinAgeSlots) return false;
    const from = now - p.grindWindowSlots;
    const mid = now - p.grindWindowSlots / 2;
    let startPrice = -1;
    let midPrice = -1;
    let lastPrice = 0;
    let netFirst = 0;
    let netSecond = 0;
    let grossIn = 0;
    let biggestTrade = 0;
    let buyTrades = 0;
    const byBuyer = new Map<string, number>();
    for (const tr of t.trades) {
      if (tr.slot <= from) {
        startPrice = tr.price;
        continue;
      }
      if (startPrice < 0) startPrice = tr.price;
      if (midPrice < 0 && tr.slot > mid) midPrice = tr.price;
      const signed = tr.buy ? tr.sol : -tr.sol;
      if (tr.slot <= mid) netFirst += signed;
      else netSecond += signed;
      if (tr.buy) {
        grossIn += tr.sol;
        buyTrades++;
        byBuyer.set(tr.user, (byBuyer.get(tr.user) ?? 0) + tr.sol);
      }
      if (tr.sol > biggestTrade) biggestTrade = tr.sol;
      lastPrice = tr.price;
    }
    if (startPrice <= 0 || midPrice <= 0 || lastPrice <= 0) return false;
    if (buyTrades < p.grindMinBuyTrades || byBuyer.size < p.grindMinDistinctBuyers) return false;
    if (netFirst + netSecond < p.grindMinNetInSol) return false;
    if (netFirst < p.grindMinHalfNetInSol || netSecond < p.grindMinHalfNetInSol) return false;
    if (grossIn > 0 && biggestTrade > p.grindMaxTradeShare * grossIn) return false;
    const riseFirst = midPrice / startPrice - 1;
    const riseSecond = lastPrice / midPrice - 1;
    const rise = lastPrice / startPrice - 1;
    if (rise < p.grindMinRise || rise > p.grindMaxRise) return false;
    if (riseSecond > p.grindMaxSecondHalfRise) return false;
    if (riseFirst < -p.grindMaxHalfDrop || riseSecond < -p.grindMaxHalfDrop) return false;
    return true;
  };

  /** Close value (SOL) of `tokens` on a curve at reserves (vq, vt), curve fee and one tx fee out. */
  const closeValueSol = (tokens: number, vq: number, vt: number, txSol: number): number =>
    ((tokens * vq) / (vt + tokens) / SOL) * (1 - CURVE_FEE) - txSol;

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const now = batch.slot;
      const caps = state.hello.caps;
      const txSol = Number(state.txFeeLamports()) / SOL;

      // ---- ingest: my fills, then the event stream into tapes ----
      for (const f of batch.fills) {
        if (f.status === 'filled' && !f.client_id.startsWith('_')) {
          myCoins.add(f.mint);
        }
      }
      const traded = new Set<Pubkey>();
      for (const e of batch.events) {
        if (e.block_time !== null) {
          if (firstBlockTime === null) firstBlockTime = e.block_time;
          if (lastBlockTime === null || e.block_time > lastBlockTime) lastBlockTime = e.block_time;
        }
        if (e.event === 'CreateEvent') {
          tapeOf(e.mint).createdSlot = e.slot;
        } else if (e.event === 'TradeEvent') {
          const t = tapeOf(e.mint);
          t.trades.push({
            slot: e.slot,
            buy: e.is_buy,
            sol: Number(e.sol_amount) / SOL,
            user: e.user,
            price: Number(e.virtual_sol_reserves) / Number(e.virtual_token_reserves),
          });
          traded.add(e.mint);
        }
      }
      for (const mint of traded) {
        const t = tapes.get(mint)!;
        let cut = 0;
        while (cut < t.trades.length && t.trades[cut]!.slot <= now - keepSlots) cut++;
        if (cut > 0) t.trades.splice(0, cut);
      }

      const elapsedSec =
        firstBlockTime !== null && lastBlockTime !== null ? lastBlockTime - firstBlockTime : 0;
      const entriesClosed = elapsedSec >= p.stopEntriesAfterSec;
      const probesClosed = elapsedSec >= p.stopProbesAfterSec;
      const flattenNow = elapsedSec >= p.flattenAfterSec;

      const marks = new Map(batch.marks.map((m) => [m.mint, m] as const));
      const pendingByMint = new Map<Pubkey, { buy: boolean; sell: boolean }>();
      for (const po of state.pending.values()) {
        const rec = pendingByMint.get(po.order.mint) ?? { buy: false, sell: false };
        if (po.order.side === 'buy') rec.buy = true;
        else rec.sell = true;
        pendingByMint.set(po.order.mint, rec);
      }
      const pendingOf = (mint: Pubkey) => pendingByMint.get(mint) ?? { buy: false, sell: false };

      const orders: OrderInput[] = [];
      const sellWhole = (mint: Pubkey, tokens: bigint) => {
        orders.push({ side: 'sell', mint, token_amount: tokens, max_slippage_bps: 10_000 });
      };

      // ---- sleeve exits first: risk rules outrank everything else ----
      for (const [mint, pos] of sleeve) {
        const heldPos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (heldPos === undefined) {
          const pend = pendingOf(mint);
          if (!pend.buy && !pend.sell) sleeve.delete(mint);
          continue;
        }
        pos.anyFill = true;
        if (curve === undefined || curve.complete) continue; // the replay closes completed curves
        const mk = marks.get(mint);
        const vq = mk ? Number(mk.virtual_sol_reserves) : Number(curve.virtual_quote_reserves);
        const vt = mk ? Number(mk.virtual_token_reserves) : Number(curve.virtual_token_reserves);
        const tokens = Number(heldPos.token_amount);
        const value = closeValueSol(tokens, vq, vt, txSol);
        const cost = Number(heldPos.cost_lamports) / SOL;

        let exit = pos.exitSent || flattenNow;
        if (!exit && value >= cost * (1 + p.takeProfitFrac)) exit = true;
        if (!exit && value <= cost * (1 - p.stopLossFrac)) exit = true;
        if (!exit && netFlow(tapeOf(mint), now, p.fadeWindowSlots) < -p.fadeOutSol) exit = true;
        if (!exit && now - pos.openedSlot > p.maxHoldSlots) exit = true;
        if (!exit) continue;
        pos.exitSent = true;
        if (pendingOf(mint).sell) continue; // a sell is already on its way
        if (orders.length >= caps.max_orders_per_batch) break;
        sellWhole(mint, heldPos.token_amount);
      }

      // ---- probes: sell the whole probe as soon as its buy has landed ----
      for (const [mint, selling] of probes) {
        const heldPos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (heldPos === undefined) {
          const pend = pendingOf(mint);
          if (!pend.buy && !pend.sell) probes.delete(mint);
          continue;
        }
        if (curve === undefined || curve.complete) continue;
        const pend = pendingOf(mint);
        if (pend.buy || pend.sell) continue;
        if (orders.length >= caps.max_orders_per_batch) break;
        sellWhole(mint, heldPos.token_amount);
        if (!selling) probes.set(mint, true);
      }

      let freeSol = Number(state.freeCashLamports()) / SOL;
      let slotsLeft = caps.max_open_positions - state.committedPositionCount();

      // ---- sleeve entries: fixed stake, no adds, only on curves that traded ----
      if (!entriesClosed && sleeveEntries < p.sleeveMaxEntries) {
        for (const mint of traded) {
          if (orders.length >= caps.max_orders_per_batch) break;
          if (sleeve.size >= p.sleeveMaxConcurrent || sleeveEntries >= p.sleeveMaxEntries) break;
          if (slotsLeft <= 0) break;
          if (sleeve.has(mint) || sleeveUsed.has(mint) || probes.has(mint)) continue;
          if (state.positions.has(mint)) continue;
          const pend = pendingOf(mint);
          if (pend.buy || pend.sell) continue;
          const curve = state.curves.get(mint);
          if (curve === undefined || curve.complete) continue;
          const t = tapes.get(mint)!;
          const realQuoteSol = Number(curve.real_quote_reserves) / SOL;
          if (!grindOk(t, now, realQuoteSol)) continue;
          const capSol = Number(state.maxBuyLamports(mint)) / SOL;
          let amountSol = Math.min(capSol, p.sleeveStakeSol);
          if (amountSol > freeSol - txSol) amountSol = freeSol - txSol;
          if (amountSol < p.probeSol) continue; // a sleeve entry smaller than a probe is pointless
          orders.push({
            side: 'buy',
            mint,
            quote_lamports: BigInt(Math.floor(amountSol * SOL)),
            max_slippage_bps: p.buySlippageBps,
          });
          freeSol -= amountSol + txSol;
          sleeve.set(mint, { openedSlot: now, exitSent: false, anyFill: false });
          sleeveUsed.add(mint);
          sleeveEntries++;
          slotsLeft--;
        }
      }

      // ---- guardrail pacing: tiny probe round trips when coins lag the pace ----
      if (
        !probesClosed &&
        !flattenNow &&
        probes.size < p.maxConcurrentProbes &&
        slotsLeft > 0 &&
        firstBlockTime !== null &&
        lastBlockTime !== null
      ) {
        const pace = Math.min(1, elapsedSec / p.paceSeconds);
        const coinsDue = Math.ceil(p.targetCoins * pace);
        if (myCoins.size < coinsDue) {
          // If the run is far into the window and coins still lag, relax the
          // reserve floor so the bar is met on thinner curves rather than missed.
          const behind = elapsedSec > p.paceSeconds / 2 && myCoins.size < coinsDue / 2;
          const minRealSol = behind ? 1.3 : p.probeMinRealSol;
          for (const mint of traded) {
            if (orders.length >= caps.max_orders_per_batch || probes.size >= p.maxConcurrentProbes) break;
            if (sleeve.has(mint) || probes.has(mint) || state.positions.has(mint)) continue;
            const pend = pendingOf(mint);
            if (pend.buy || pend.sell) continue;
            if (myCoins.has(mint)) continue;
            const curve = state.curves.get(mint);
            if (curve === undefined || curve.complete) continue;
            // The probe must clear the 1%-of-reserves size cap with room to spare.
            if (Number(curve.real_quote_reserves) / SOL < Math.max(minRealSol, p.probeSol * 200)) continue;
            if (freeSol < p.probeSol + 2 * txSol) break;
            orders.push({
              side: 'buy',
              mint,
              quote_lamports: BigInt(Math.floor(p.probeSol * SOL)),
              max_slippage_bps: p.buySlippageBps,
            });
            probes.set(mint, false);
            freeSol -= p.probeSol + txSol;
          }
        }
      }

      return orders;
    },
  };
}
