// Confirmed-momentum strategy for the pump.fun bonding-curve replay
// (protocol agent-fun/replay/v2). Paper money only: the harness replays
// recorded chain events in batches, one batch per slot, and this bot answers
// each batch with the orders it wants filled two slots later.
//
// Idea in one paragraph: most fresh pump.fun curves are bundled launches that
// dump within minutes, so a curve only becomes a candidate once it is a few
// hundred slots old and its recent tape shows *broad, accelerating* demand —
// net SOL flowing in, several distinct buyers, no single wallet dominating,
// price rising but still hugging its window high. The first buy is a small
// feeler; size is added only while the position is winning and flow stays
// positive, up to a fixed stake. Every position carries hard exits (stop
// loss, trailing stop, flow fade, time limit), and tiny probe round trips on
// liquid curves keep the run above the guardrail bar of round trips of at
// least 0.01 SOL on at least 20 coins. Near the end of the 24 h window the
// bot stops opening risk and flattens what it manages, so the score is cash,
// not bags marked at a stale price.
//
// Deterministic by construction: no clock, no environment, no randomness —
// only the batch stream, iterated in insertion order.

import type { Batch, Bot, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

export interface Params {
  /** Tape window (slots) the entry signal reads. */
  windowSlots: number;
  /** Net SOL inflow (buys minus sells) required over the window. */
  minNetInSol: number;
  /** Buy trades required in the window. */
  minBuyTrades: number;
  /** Distinct buying wallets required in the window. */
  minDistinctBuyers: number;
  /** Price rise over the window must be at least this fraction... */
  minPriceRise: number;
  /** ...and at most this fraction (skip curves that already mooned). */
  maxPriceRise: number;
  /** Current price must be at least this share of the window high. */
  nearHighShare: number;
  /** Largest single buyer's share of window buy SOL allowed. */
  maxTopBuyerShare: number;
  /** Real SOL reserves bounds for a curve to be tradable at entry. */
  minRealQuoteSol: number;
  maxRealQuoteSol: number;
  /** Slots after the CreateEvent before any entry (bundled launches dump early). */
  minAgeSlots: number;
  /** First buy of a position, SOL. */
  firstBuySol: number;
  /** Each pyramid add, SOL. */
  addBuySol: number;
  /** Total SOL one position may absorb. */
  maxStakeSol: number;
  /** Smallest buy worth its transaction fee; also above the 0.01 SOL round-trip bar. */
  minOrderSol: number;
  /** Slippage tolerance on buys, bps. Sells always go out at 10_000. */
  buySlippageBps: number;
  /** Exit when close value falls to cost * (1 - stopLossFrac). */
  stopLossFrac: number;
  /** Trailing stop arms once value reached cost * (1 + trailArmFrac)... */
  trailArmFrac: number;
  /** ...and exits when value falls to peak * (1 - trailDropFrac). */
  trailDropFrac: number;
  /** Flow-fade exit: net SOL over the last fadeWindowSlots below -fadeOutSol exits. */
  fadeWindowSlots: number;
  fadeOutSol: number;
  /** Time exit after this many slots held, waived while up at least holdIfUpFrac. */
  maxHoldSlots: number;
  holdIfUpFrac: number;
  /** Slots after an exit before the same curve can be re-entered. */
  cooldownSlots: number;
  /** Most separate entries per curve over the whole run. */
  maxEntriesPerMint: number;
  /** Most momentum positions open at once (position cap is 5; probes share it). */
  maxMomentumPositions: number;
  /** Most SOL at cost across momentum positions at once. */
  maxExposureSol: number;
  /** Guardrail probes: size of one probe round trip, SOL. */
  probeSol: number;
  /** Coins with a round trip the pacing aims for (bar is 20). */
  targetCoins: number;
  /** Block-time seconds over which the coin target is paced. */
  paceSeconds: number;
  /** Most probe positions open at once. */
  maxConcurrentProbes: number;
  /** Block-time seconds into the window after which no new buys are opened... */
  stopEntriesAfterSec: number;
  /** ...and after which every managed position is sold. */
  flattenAfterSec: number;
}

export const DEFAULT_PARAMS: Params = {
  windowSlots: 40,
  minNetInSol: 0.8,
  minBuyTrades: 4,
  minDistinctBuyers: 4,
  minPriceRise: 0.04,
  maxPriceRise: 1.2,
  nearHighShare: 0.97,
  maxTopBuyerShare: 0.6,
  minRealQuoteSol: 3,
  maxRealQuoteSol: 80,
  minAgeSlots: 300,
  firstBuySol: 0.06,
  addBuySol: 0.15,
  maxStakeSol: 0.75,
  minOrderSol: 0.011,
  buySlippageBps: 1500,
  stopLossFrac: 0.18,
  trailArmFrac: 0.06,
  trailDropFrac: 0.25,
  fadeWindowSlots: 15,
  fadeOutSol: 0.75,
  maxHoldSlots: 1200,
  holdIfUpFrac: 0.25,
  cooldownSlots: 200,
  maxEntriesPerMint: 2,
  maxMomentumPositions: 4,
  maxExposureSol: 4,
  probeSol: 0.012,
  targetCoins: 24,
  paceSeconds: 14_400,
  maxConcurrentProbes: 1,
  stopEntriesAfterSec: 21 * 3600,
  flattenAfterSec: 23 * 3600,
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
  entries: number;
  lastExitSlot: number;
}

interface Position {
  openedSlot: number;
  investedSol: number;
  peakValueSol: number;
  lastValueSol: number;
  lastBuyPrice: number;
  exitSent: boolean;
  anyFill: boolean;
}

export function createStrategy(p: Params = DEFAULT_PARAMS): Bot {
  const tapes = new Map<Pubkey, Tape>();
  const positions = new Map<Pubkey, Position>();
  /** Probe round trips in flight, by mint: false while the buy is out, true once selling. */
  const probes = new Map<Pubkey, boolean>();
  let myFills = 0;
  const myCoins = new Set<Pubkey>();
  let firstBlockTime: number | null = null;
  let lastBlockTime: number | null = null;
  const keepSlots = Math.max(p.windowSlots, p.fadeWindowSlots) + 5;

  const tapeOf = (mint: Pubkey): Tape => {
    let t = tapes.get(mint);
    if (t === undefined) {
      t = { createdSlot: null, trades: [], entries: 0, lastExitSlot: -1_000_000_000 };
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

  /** The entry signal: broad, accelerating buy pressure on a mature curve. */
  const signalOk = (t: Tape, now: number, realQuoteSol: number): boolean => {
    if (realQuoteSol < p.minRealQuoteSol || realQuoteSol > p.maxRealQuoteSol) return false;
    if (t.createdSlot === null || now - t.createdSlot < p.minAgeSlots) return false;
    const from = now - p.windowSlots;
    const mid = now - p.windowSlots / 2;
    let buySol = 0;
    let sellSol = 0;
    let buyTrades = 0;
    let netOlder = 0;
    let netNewer = 0;
    let startPrice = -1;
    let high = 0;
    let lastPrice = 0;
    const byBuyer = new Map<string, number>();
    for (const tr of t.trades) {
      if (tr.slot <= from) {
        startPrice = tr.price;
        continue;
      }
      if (startPrice < 0) startPrice = tr.price;
      const signed = tr.buy ? tr.sol : -tr.sol;
      if (tr.slot <= mid) netOlder += signed;
      else netNewer += signed;
      if (tr.buy) {
        buySol += tr.sol;
        buyTrades++;
        byBuyer.set(tr.user, (byBuyer.get(tr.user) ?? 0) + tr.sol);
      } else {
        sellSol += tr.sol;
      }
      if (tr.price > high) high = tr.price;
      lastPrice = tr.price;
    }
    if (buyTrades < p.minBuyTrades || byBuyer.size < p.minDistinctBuyers) return false;
    if (buySol - sellSol < p.minNetInSol) return false;
    if (startPrice <= 0 || lastPrice <= 0) return false;
    const rise = lastPrice / startPrice - 1;
    if (rise < p.minPriceRise || rise > p.maxPriceRise) return false;
    if (lastPrice < high * p.nearHighShare) return false;
    if (netNewer <= 0 || netNewer < netOlder) return false;
    let topBuyer = 0;
    for (const v of byBuyer.values()) if (v > topBuyer) topBuyer = v;
    if (topBuyer > p.maxTopBuyerShare * buySol) return false;
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
          myFills++;
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

      // ---- exits first: risk rules outrank everything else ----
      for (const [mint, pos] of positions) {
        const heldPos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (heldPos === undefined) {
          const pend = pendingOf(mint);
          if (!pend.buy && !pend.sell) {
            positions.delete(mint);
            const t = tapeOf(mint);
            if (pos.anyFill) t.lastExitSlot = now;
            else t.entries--;
          }
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
        if (value > pos.peakValueSol) pos.peakValueSol = value;
        pos.lastValueSol = value;

        let exit = pos.exitSent || flattenNow;
        if (!exit && value < cost * (1 - p.stopLossFrac)) exit = true;
        if (!exit && pos.peakValueSol >= cost * (1 + p.trailArmFrac) && value < pos.peakValueSol * (1 - p.trailDropFrac)) exit = true;
        if (!exit && netFlow(tapeOf(mint), now, p.fadeWindowSlots) < -p.fadeOutSol) exit = true;
        if (!exit && now - pos.openedSlot > p.maxHoldSlots && value < cost * (1 + p.holdIfUpFrac)) exit = true;
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

      // ---- entries and pyramid adds, only on curves that traded this batch ----
      let freeSol = Number(state.freeCashLamports()) / SOL;
      let slotsLeft = caps.max_open_positions - state.committedPositionCount();
      let exposureSol = 0;
      for (const [mint, pos] of positions) {
        const heldPos = state.positions.get(mint);
        exposureSol += Math.max(pos.investedSol, heldPos ? Number(heldPos.cost_lamports) / SOL : 0);
      }
      if (!entriesClosed) {
        for (const mint of traded) {
          if (orders.length >= caps.max_orders_per_batch) break;
          const curve = state.curves.get(mint);
          if (curve === undefined || curve.complete) continue;
          const pend = pendingOf(mint);
          if (pend.buy || pend.sell || probes.has(mint)) continue;
          const t = tapes.get(mint)!;
          const held = positions.get(mint);
          const price = Number(curve.virtual_quote_reserves) / Number(curve.virtual_token_reserves);
          const realQuoteSol = Number(curve.real_quote_reserves) / SOL;
          let wantSol: number;
          if (held === undefined) {
            if (slotsLeft <= 0 || positions.size >= p.maxMomentumPositions) continue;
            if (t.entries >= p.maxEntriesPerMint || now - t.lastExitSlot < p.cooldownSlots) continue;
            if (!signalOk(t, now, realQuoteSol)) continue;
            wantSol = Math.min(p.firstBuySol, p.maxStakeSol);
          } else {
            // Pyramid into strength only: price at/above the last buy's price,
            // position not underwater, flow still positive over the window.
            if (held.exitSent || !held.anyFill || held.investedSol >= p.maxStakeSol - p.minOrderSol) continue;
            if (state.positions.get(mint) === undefined) continue;
            if (price < held.lastBuyPrice) continue;
            if (held.lastValueSol < Number(state.positions.get(mint)!.cost_lamports) / SOL) continue;
            if (netFlow(t, now, p.windowSlots) < 0) continue;
            if (realQuoteSol > p.maxRealQuoteSol) continue;
            wantSol = Math.min(p.addBuySol, p.maxStakeSol - held.investedSol);
          }
          const capSol = Number(state.maxBuyLamports(mint)) / SOL;
          let amountSol = Math.min(capSol, wantSol, p.maxExposureSol - exposureSol);
          if (amountSol > freeSol - txSol) amountSol = freeSol - txSol;
          if (amountSol < p.minOrderSol) continue;
          orders.push({
            side: 'buy',
            mint,
            quote_lamports: BigInt(Math.floor(amountSol * SOL)),
            max_slippage_bps: p.buySlippageBps,
          });
          freeSol -= amountSol + txSol;
          exposureSol += amountSol;
          if (held === undefined) {
            positions.set(mint, {
              openedSlot: now,
              investedSol: amountSol,
              peakValueSol: 0,
              lastValueSol: 0,
              lastBuyPrice: price,
              exitSent: false,
              anyFill: false,
            });
            t.entries++;
            slotsLeft--;
          } else {
            held.investedSol += amountSol;
            held.lastBuyPrice = price;
          }
        }
      }

      // ---- guardrail pacing: tiny probe round trips when coins lag the pace ----
      if (
        !entriesClosed &&
        probes.size < p.maxConcurrentProbes &&
        slotsLeft > 0 &&
        firstBlockTime !== null &&
        lastBlockTime !== null
      ) {
        const pace = Math.min(1, elapsedSec / p.paceSeconds);
        const coinsDue = Math.ceil(p.targetCoins * pace);
        if (myCoins.size < coinsDue) {
          for (const mint of traded) {
            if (orders.length >= caps.max_orders_per_batch || probes.size >= p.maxConcurrentProbes) break;
            if (positions.has(mint) || probes.has(mint) || state.positions.has(mint)) continue;
            const pend = pendingOf(mint);
            if (pend.buy || pend.sell) continue;
            if (myCoins.has(mint)) continue;
            const curve = state.curves.get(mint);
            if (curve === undefined || curve.complete) continue;
            // The probe must clear the 1%-of-reserves size cap with room to spare.
            if (Number(curve.real_quote_reserves) / SOL < p.probeSol * 200) continue;
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
