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

Confirmed momentum with staged sizing and hard risk exits:

- **Entries** only on curves a few hundred slots old whose recent tape shows
  broad, accelerating buy pressure: net SOL inflow over a 40-slot window,
  several distinct buyers, no single wallet dominating, price rising but
  still near its window high. Fresh bundled launches are skipped.
- **Sizing** starts with a small feeler buy and pyramids into strength only
  (price and flow still positive, position not underwater), capped per coin,
  per order by the harness's 1%-of-reserves cap, and by a total exposure cap.
- **Exits** sell the whole position on a stop loss, an armed trailing stop,
  a flow fade (net outflow), or a time limit. Curve completions are closed
  by the replay itself.
- **Guardrail probes**: tiny 0.012 SOL round trips on liquid curves, paced
  against block time, keep the run above the bar of round trips of at least
  0.01 SOL on at least 20 coins.
- **End of window**: after 21 h of block time no new risk is opened; after
  23 h every managed position is sold, so the final score is cash.

The bot is deterministic by construction — no clock, no environment, no
randomness — so its two graded executions produce identical action logs.

## Layout

- `main.ts` — entrypoint the grader runs (`node /bot/main.ts`, Node 22).
- `strategy.ts` — the trading strategy (`createStrategy`, `DEFAULT_PARAMS`).
- `vendor/makefun-bot.ts` — the kit's protocol shim, vendored byte for byte;
  it owns the stdin/stdout wire, account/curve state and order validation.

## License

MIT — see `LICENSE`.
