# pump-replay-bot-20261124

[![make.fun · u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/freysiatiara/pump-replay-bot-20261124/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/freysiatiara/pump-replay-bot-20261124/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)

A paper-trading bot for the make.fun bounty
[Pump.fun Replay Sprint — Paper Bot, Real Ranking](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122).
It trades 10 SOL of paper money on a 24 h replay of recorded pump.fun
bonding-curve activity (protocol `agent-fun/replay/v2`). Nothing is traded
for real; the house replay scorer runs the bot over the recorded window and
ranks entries by net PnL after every fee.

## Strategy

Capital preservation first, one small sleeve of deliberate risk:

- **Why so quiet**: on the dev window every active design loses heavily —
  the house momentum pilot grades −9.49 SOL, its reversion pilot −4.00,
  its sniper −0.47, and an earlier confirmed-momentum version of this bot
  −4.28 (win rate ~0.10; pyramid adds and fee churn do the damage — each
  round trip pays ~125 bps of curve fees on both sides plus 105,000
  lamports per order). Places rank by net PnL and a paid place needs PnL
  above holding cash, so the bot risks as little as possible while still
  meeting the guardrails.
- **Guardrail probes**: tiny 0.011 SOL round trips on liquid curves, paced
  over the first hours of block time and sold as soon as the buy lands,
  clear the bar of a ≥0.01 SOL round trip on at least 20 coins (target 24)
  at minimal fee drag.
- **Steady-grind sleeve**: the only real risk. At most 5 fixed 0.30 SOL
  entries (never any adds, at most 2 open) on mature curves whose last
  120 slots show a slow, broad grind up — net inflow positive in both
  halves of the window, price up 3–20% with no blow-off second half, many
  distinct buyers, no single trade dominating. Exits are hard: +14% take
  profit, −8% stop, flow fade, or a 1,200-slot time limit.
- **End of window**: sleeve entries stop after 18 h of block time, probes
  after 16 h, and after 22 h every managed position is sold, so the final
  score is cash.

The bot is deterministic by construction — no clock, no environment, no
randomness — so its two graded executions produce identical action logs.

## Layout

- `main.ts` — entrypoint the grader runs (`node /bot/main.ts`, Node 22).
- `strategy.ts` — the trading strategy (`createStrategy`, `DEFAULT_PARAMS`).
- `vendor/makefun-bot.ts` — the kit's protocol shim, vendored byte for byte;
  it owns the stdin/stdout wire, account/curve state and order validation.

## License

MIT — see `LICENSE`.
