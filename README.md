# PropDesk

A local, prop-firm style **paper-trading terminal** built to make simulated money feel real.

- **Live market data** — CME futures (MNQ, NQ, MES, ES, M2K, RTY, MCL, CL, MGC, GC) and forex
  from Yahoo; crypto, gold/silver/oil and stock perpetuals (BTC, ETH, SOL, XAU, NVDA, QQQ…) from
  Binance, real-time and 24/7.
- **Realistic execution** — fills at bid/ask, commissions, stop orders that slip on gaps, limit orders
  that need the market to come to you, positions marked at the price you could actually close at.
- **Several positions per symbol** — every order opens its own position with its own stop-loss and
  take-profit (its own row, chart lines and journal trade); an order the other way closes the oldest first.
- **Prop-firm challenges** — presets (Futures 50K/100K/150K with end-of-day trailing drawdown, intraday
  trailing, 2-step 50K/100K with static drawdown, a 24/7 crypto challenge) or your own rules: profit
  target, max loss (static / trailing), daily loss limit, minimum days, consistency, contract limits,
  auto-flatten at 4:10 PM ET. Breach a rule and the account is liquidated and failed — for good.
- **A wallet that hurts** — challenges cost money from a budget you choose; failed attempts are gone,
  funded accounts pay out. Your real scoreboard is *payouts − fees*.
- **P&L calendar** — the whole month at a glance, daily and weekly totals, a year heatmap, and a
  journal note for every day.
- **Journal & analytics** — every trade with mood, setup, plan and post-trade review; win rate,
  profit factor, expectancy, R, drawdown, and P&L by mood / setup / symbol / hour.
- **Trade replay** — watch any trade play back (1–120×): price, fills, stop / target as they were and
  the P&L moving. PropDesk records bid / ask while you're in a position; older crypto trades are rebuilt
  from Binance's trade history, others from 1-minute bars.
- **Chart drawing tools** — trend lines, horizontal lines and rays, rectangles, and TradingView-style
  long / short position boxes (stop-loss and target zones with R:R and $ at your ticket size) that can be
  sent to the order ticket. A magnet snaps points to candle highs / lows; drawings are saved per symbol
  and show on every timeframe.
- **Order book heatmap** — for Binance markets (crypto, gold, oil, stock perpetuals): where buy orders
  (green) and sell orders (red) are waiting, brighter = bigger, minute by minute behind the candles, plus
  the live book along the chart's right edge with the biggest walls labelled. Watchlist symbols are
  recorded all the time (24 h kept), so the history is there when you open the chart.
- **Discipline guard-rails** — tilt cooldown after losing streaks, max trades per day, personal daily
  stop, revenge-trade warnings, optional mandatory stop-loss, hold-to-confirm on risky orders, losses
  shown as hours of work.
- **The broker never sleeps** — the server runs as a background service, so stops and rules execute
  with the window closed; after the laptop sleeps it replays the missed minutes before resuming.

## Run

```sh
npm install
npm run dev            # server on :4777 (watch mode) + Vite on :5173
npm test               # engine, rules, market and shared tests
npm run typecheck
```

Install as a desktop app (user service + launcher in the app menu):

```sh
deploy/install.sh      # builds web/dist, installs ~/.config/systemd/user/propdesk.service and the "PropDesk" launcher
systemctl --user status propdesk
journalctl --user -u propdesk -f
```

Data lives in `~/.local/share/propdesk/propdesk.db` (SQLite). Environment: `PROPDESK_PORT` (4777),
`PROPDESK_DATA_DIR`, `PROPDESK_FAKE_MARKET=1` (offline random-walk prices), `PROPDESK_LOG_LEVEL`.

## Notes

- CME futures trade Sunday 6 PM → Friday 5 PM ET with a daily 5–6 PM break; on weekends use the
  24/7 markets (crypto, metals, stock perps) or the 24/7 challenge.
- Yahoo's CME data is delayed (~10 minutes), so futures run live off a Binance perpetual of the same
  market (NQ/MNQ ← QQQ, ES/MES ← SPY, RTY/M2K ← IWM, CL/MCL ← oil, GC/MGC ← gold), scaled to the real
  CME price and re-anchored every minute — usually within a few ticks. The Dow has no close-tracking
  perpetual and is not offered.
- Sounds work like TradingView: every fill plays the fill sound (the "Order filled" voice clip, or one of
  TradingView's 8 execution sounds), account alerts play a TradingView alert sound, and placing or cancelling
  orders is silent. The sound files are not included in this repository (they belong to TradingView and
  their authors): put your own `order-filled.ogg` and `tv-<name>.mp3` files in `web/public/sounds/`.
  Without them the app is simply silent.
- Architecture and rule semantics: [`docs/SPEC.md`](docs/SPEC.md).
