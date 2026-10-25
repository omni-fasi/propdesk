# PropDesk — product & engineering spec

PropDesk is a **local, single-user paper-trading terminal that behaves like a prop-firm platform**.
It streams real market prices, executes simulated orders with realistic costs, enforces prop-firm
challenge rules (max loss, daily loss, profit target, consistency…), shows a **monthly P&L calendar**
and a trade journal, and is designed to make the money **feel real** so the trader can practise
emotional control and discipline.

The user is a beginner/intermediate trader in Toronto (America/Toronto, en-CA). Their example
challenge: *$50,000 account, $2,000 max loss, $3,000 profit target* (= preset `fut-50k`).

---

## 1. Principles

1. **Real prices, real costs.** Live data, real spreads, commissions, slippage on stops. No "fill at
   the price I clicked" when the market moved.
2. **Consequences are permanent.** No undo, no deleting trades, no resetting a failed account, no
   editing prices of history. A failed challenge stays failed (and its fee is gone). Journal fields
   (mood, notes, review) are the only editable things on a trade.
3. **The broker never sleeps.** The server runs as a background service. Stops, targets, limits and
   rule breaches execute even with the UI closed. After the laptop sleeps, the server replays the
   missed minutes (pessimistically) before resuming.
4. **Money is shown as money.** Dollars with cents, live ticking P&L, optional "≈ 6 h of work"
   conversion, a wallet that pays challenge fees and receives payouts.
5. **Discipline guard-rails the trader cannot bypass.** Tilt cooldowns, max trades per day,
   personal daily stop, revenge-trade warnings. Enforced by the server, not just the UI.
6. **Looks like a real platform.** Black & white, dense, professional (color only for P&L / buy-sell / candles). No "PAPER" watermarks, no cartoon
   gamification. Think TopstepX / Tradovate / TradingView, polished.

---

## 2. Architecture

```
            ┌───────────────────────────── server (Node 26, TypeScript, runs as user service) ─────────────────────────────┐
 Binance ──▶│ market/ (MarketHub)  ──quotes/candles/gaps──▶  engine/ (orders, fills, positions, trades, rules, wallet)   │
 Yahoo   ──▶│   providers, sessions,                          │   ▲                         │                             │
            │   candle cache                                  ▼   │ commands                 ▼ persistence (node:sqlite)   │
            │                                     api/ (Hono REST + ws WebSocket)  ◀────────▶  ~/.local/share/propdesk/     │
            └──────────────────────────────────────────────────┬─────────────────────────────────────────────────────────────┘
                                                               │  /api/*  /ws   (127.0.0.1:4777, serves web/dist in prod)
            ┌──────────────────────────── web (React 19 + Vite 8 + Tailwind 4 + zustand + lightweight-charts) ────────────┐
            │  api/ client + socket → store/ → features/{trade, calendar, journal, challenges, wallet, settings, realism}  │
            └──────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

### Tech & conventions

- **Node 26 runs TypeScript directly** (type stripping). Therefore in `server/**` and `shared/**`:
  - relative imports **must include the `.ts` extension** (`import { x } from './engine.ts'`);
  - `import type` for type-only imports (`verbatimModuleSyntax`);
  - **no enums, no namespaces, no parameter properties, no decorators** (`erasableSyntaxOnly`).
- Web code imports shared code as `@shared/types`, `@shared/risk` … and its own code as `@/…`.
- TypeScript 7 (native `tsc`). `npm run typecheck:server`, `npm run typecheck:web`.
- Tests: `node:test` + `node:assert/strict`, files `server/test/**/*.test.ts`, `shared/**/*.test.ts`.
  Run one file with `node --test server/test/engine.test.ts`.
- Server: Hono (`hono`, `@hono/node-server`) for REST, `ws` for the WebSocket server (attach to the
  same http server, path `/ws`). Database: built-in `node:sqlite` (`DatabaseSync`), WAL mode.
- Data dir: `$PROPDESK_DATA_DIR` or `~/.local/share/propdesk` (db file `propdesk.db`).
- Port: `$PROPDESK_PORT` or `4777`, bind `127.0.0.1`. In production the server also serves
  `web/dist` (SPA fallback to index.html).
- Dev: `npm run dev` (server with `--watch` + Vite on 5173 proxying `/api` and `/ws`).
- `PROPDESK_FAKE_MARKET=1` → use `server/src/market/fake.ts` random walk instead of real feeds.
- IDs: `crypto.randomUUID()`.
- **Machine has 7 GB RAM shared with other agents**: do not start long-running dev servers or
  browsers unless your task says so; run `tsc` once at the end, not in loops; kill anything you start.

### Shared contracts (owned by the lead — do not edit; ask in your report if you need a change)

| File | What |
|---|---|
| `shared/types.ts` | Domain model (instruments, quotes, candles, rules, accounts, snapshots, orders, positions, fills, trades, journal, events, wallet, settings) |
| `shared/api.ts` | Every REST endpoint + request/response types + WebSocket messages |
| `shared/instruments.ts` | Instrument catalog (`INSTRUMENTS`, `getInstrument`) |
| `shared/presets.ts` | Challenge presets, `rulesForPhase`, `practiceRules`, `buildCustomRules`, `suggestedFee` |
| `shared/time.ts` | Time zones, trading days (`tradingDayOf`, `tradingDayBounds`, `nextRolloverAt`), sessions |
| `shared/risk.ts` | Tick/qty rounding, P&L, notional, commission, risk/qty sizing, bracket validation |
| `shared/format.ts` | Money/percent/price/qty/duration/work-hours formatting |
| `shared/journal.ts` | Moods, setup grades, mistakes, `DEFAULT_SETTINGS` |
| `server/src/market/types.ts` | `MarketHub` interface; `server/src/market/fake.ts` test/dev hub |

### Module ownership

| Owner | Paths |
|---|---|
| lead | `shared/**`, configs, `docs/**`, `server/src/market/types.ts`, `server/src/market/fake.ts`, `web/src/{main.tsx,App.tsx}`, `web/src/{api,store,components/ui,lib/format.ts,styles}/**`, `web/index.html` |
| backend agent | `server/src/**` except `server/src/market/**`; `server/test/**` except `server/test/market*` |
| market agent | `server/src/market/**` (except types.ts, fake.ts), `server/test/market*.test.ts` |
| trade-ui agent | `web/src/features/trade/**` |
| insights-ui agent | `web/src/features/calendar/**`, `web/src/features/journal/**` |
| realism-ui agent | `web/src/features/{challenges,wallet,settings,realism}/**`, `web/src/lib/sounds.ts` |

---

## 3. Market data (`server/src/market`)

Implements `MarketHub` (`server/src/market/types.ts`); factory `createMarketHub(opts)` in
`server/src/market/index.ts`.

### Providers

**Binance USDⓈ-M futures** (crypto + metals/energy/stock "TradFi" perps; `provider: 'binance'`):
- WS `wss://fstream.binance.com/stream` with dynamic `{"method":"SUBSCRIBE","params":[...],"id":n}`
  (≤ 5 control msgs/s). Streams per feed symbol: `<sym>@bookTicker` (real bid/ask) and
  `<sym>@kline_1m` (live 1m candle; its close is `last`). Binance drops connections every 24 h and
  sends pings — reconnect with backoff and resubscribe.
- REST history `https://fapi.binance.com/fapi/v1/klines?symbol&interval&endTime&limit` (≤ 1500).
- 24h change: `/fapi/v1/ticker/24hr?symbol=` (poll every ~60 s for retained symbols) or derive.

**Yahoo Finance** (CME futures, forex; `provider: 'yahoo'`):
- WS `wss://streamer.finance.yahoo.com/?version=2`, header `Origin: https://finance.yahoo.com`,
  send `{"subscribe":["NQ=F",...]}`. Messages: `{"type":"pricing","message":"<base64 protobuf>"}`.
  Protobuf `PricingData` (hand-decode varint / 32-bit float / zigzag sint64 / length-delimited):
  `1 id string, 2 price float, 3 time sint64 (ms), 4 currency, 5 exchange, 6 quoteType int32,
  7 marketHours int32, 8 changePercent float, 9 dayVolume sint64, 10 dayHigh float, 11 dayLow float,
  12 change float, 13 shortName, … 16 previousClose float, … 22 lastSize sint64, 23 bid float,
  24 bidSize sint64, 25 ask float, 26 askSize sint64, 27 priceHint sint64`. Verify on live data.
- REST history `https://query1.finance.yahoo.com/v8/finance/chart/<sym>?interval=1m&period1&period2`
  (1m ≈ last 7 days per request window, 5m/15m 60 days, 1h 730 days, 1d all). Send a browser UA.
  `4h` is aggregated from `1h`.
- Fallback: if the streamer is silent for a symbol while its market is open, poll the chart API
  (`range=1d&interval=1m`) every 3–5 s.

### Quote synthesis
- `bidask` instruments: bid/ask from the book; last from kline close (fallback mid).
- `last` instruments: synthesize top of book from trade prices with `syntheticSpreadTicks`:
  - futures (spread 1 tick): **tick rule** — uptick ⇒ trade hit the ask: `ask = last, bid = last − tick`;
    downtick ⇒ `bid = last, ask = last + tick`; unchanged ⇒ keep previous assignment.
  - forex (spread N ticks): `bid = last − N/2·tick`, `ask = last + N/2·tick` (on the tick grid).
  - if the feed provides real bid/ask (Yahoo sometimes does for FX), use them.
- Several app symbols can share a feed (NQ & MNQ ← `NQ=F`): fan out one quote per app symbol,
  rounded to each instrument's tick.

### Delayed data → time shift
Yahoo CME data is typically delayed ~10 min. Detect delay per feed symbol from
`now − quote.time` (median of recent samples, rounded to the minute, only when the market is open).
If delay ≥ 60 s, **shift all timestamps of that feed (quotes, live candles, history) forward by the
delay** so the data plays as if live, and report `FeedStatus.delaySec`. The engine and charts then
see one consistent "now".

### Live proxies (CME futures)
A delayed feed with a `liveProxy` (NQ=F ← Binance QQQUSDT, ES=F ← SPYUSDT, RTY=F ← IWMUSDT,
CL=F ← CLUSDT, GC=F ← XAUUSDT) is not time-shifted. Its price is the proxy's mid × a ratio: the median
of `feed close / proxy close` over the last 15 minutes both have (refit every minute while the market
is open; after a weekend the last session's minutes). Delayed ticks only anchor (ratio, delay,
reference price); quotes and live bars come from the proxy and only while the CME session is open.
History keeps the feed's real bars at their real times; the ~10 minutes it does not have yet are
proxy bars scaled by the ratio (volume 0). Measured error vs. the real CME price (5 days of 1m
closes): NQ median ~2 pts (p90 ~5), ES ~0.5, RTY ~0.6, GC ~0.25, CL ~1 tick. The Dow (DIA) tracks
too poorly and YM/MYM were removed.

### Candles
- `onCandle` emits live **1m** bars for retained symbols (Binance kline stream; Yahoo: aggregated from
  ticks, volume from `dayVolume` deltas).
- `getCandles(symbol, tf, {endSec, limit})` returns history oldest-first, cached in memory (and
  optionally on disk under cacheDir) — repeated chart loads must not hammer providers. The current
  forming bar may be included.
- `getHistory1m(symbol, from, to)` for reconciliation.

### Gaps
Detect (a) process suspend: a 1 s interval timer that fires late by > 5 s, (b) WS disconnects > 5 s.
After data resumes, emit `onGap({fromMs, toMs, symbols})` once per gap with all retained symbols.

### Feed status
`FeedStatus` per provider: `connecting | live | degraded (stale/partial) | down`, `lastMessageAt`,
`delaySec`, human message. Emit on change.

### Sessions
Use `sessionState(spec.session, ts)` from `shared/time.ts`. While a market is closed, quotes keep
their last values; do not emit synthetic quotes.

---

## 4. Trading engine (`server/src/engine`)

All state changes go through the engine; it persists synchronously (SQLite) and emits events for the
API layer to broadcast. Every quote from `MarketHub.onQuote` is processed (unthrottled) for the
accounts that hold positions or working orders in that symbol. The engine retains (`market.retain(sym,
'engine')`) every symbol with an open position or working order in an active account.

### Order types & fills
- **Market**: buy at ask, sell at bid. Taker fee.
- **Limit**: if marketable on placement (buy limit ≥ ask / sell limit ≤ bid) fill immediately at the
  current ask/bid (taker). Otherwise rests; fills **at the limit price** (maker) when:
  `bidask` model: buy when `ask ≤ limit`, sell when `bid ≥ limit`;
  `last` model: buy when `last < limit` (trade-through) — or `last ≤ limit` after 3 s at the price;
  sell symmetric. (Simple trade-through is fine.)
- **Stop** (stop-market): trigger — `bidask`: buy when `ask ≥ stop`, sell when `bid ≤ stop`;
  `last`: on last. Fills at the **current** ask/bid after trigger (so gaps cause slippage). Taker fee.
- Rounding: prices to tick, quantities floored to qtyStep; reject qty < minQty or off-step.
- Commissions per `spec.commission` (`commissionFor` in shared/risk.ts) on every fill — except practice accounts with `rules.fees = 'off'` (switch on the account card / practice form; `PATCH /accounts/:id {fees}` is refused for challenge accounts), which pay none (`accountCommission`).
- **Several positions per symbol** (schema v5: a position is keyed by its trade id). Every entry opens a
  position of its own — never merged into an existing one — with its own entry price, `sl`/`tp`, trade and
  P&L. A symbol's positions are always on the same side: an order the other way closes them **oldest first**
  (FIFO; a partial close keeps the bracket), and what is left opens a new position on the other side (flip:
  the closed trades get exit reason `reversal`). One execution writes one fill per position it touches,
  the commission split by qty (`splitFee`), so every fill belongs to exactly one trade.
- **Brackets live on each position**: `Position.sl` (stop-market for that position's size) and `Position.tp`
  (limit for its size). An entry order may carry `sl`/`tp`; they become the new position's bracket. When one
  triggers, only that position closes (role `stop_loss` / `take_profit`). `PATCH /positions/bracket` with a
  `tradeId` changes one position, without one every position of the symbol (it returns the changed ones).
- `POST /positions/close` with a `tradeId` closes (or partially closes, `qty`) that position; without one it
  closes the symbol's positions oldest first. Rules (margin, max contracts, reduce-only caps) look at a
  symbol's positions together — they are on one side, so their sizes add up.
- Discipline: positions closed by one execution count as one result for the losing streak; each closed
  position counts as a trade for max trades per day.
- Working limit/stop orders that would *reduce* a position are allowed; `reduceOnly` orders are capped
  to the position size and cancelled when the position is flat.
- `modify` on working orders: price/qty/sl/tp. `cancel`. `flatten account` = cancel all + close all.
- `reverse` = market order of 2× the symbol's total size in the opposite direction: closes all its positions, opens one on the other side.

### Validation (reject with ApiError code)
- account must exist, be `active` (`passed`/`failed`/`closed` → `account_closed`).
- locked accounts (`lock` set and not expired) may only reduce risk: closes, flatten, cancel, tighten/
  remove brackets, reduce-only orders. New entries → `locked` with the lock message.
- market closed (`sessionState(...).open === false`) → `market_closed` with "Market closed — opens …".
- no quote yet → `no_price`.
- instrument class not in `rules.allowedClasses` → `rule_violation`.
- position limit: Σ mini-equivalents of all futures positions after the fill > `maxContracts` →
  `rule_violation` ("Max position size is 5 contracts (50 micros)").
- margin: Σ |notional| / leverage[class] after the fill > equity → `insufficient_margin` (message names the largest position the account can hold in that symbol: (equity − other positions' margin) × leverage).
- `settings.requireStopLoss` and an entry without sl → `stop_required` (every entry opens its own position, so every entry needs its own stop).
- invalid bracket (`validateBracket`) → `invalid`.
- Order affecting a position that is currently being liquidated → `busy`.

### Position marks & trades
- Mark longs at **bid**, shorts at **ask** (`Position.markPrice`, `openPnl` exclude exit fees).
- Equity = balance + Σ openPnl.
- `Trade` = one position from open to close (see types). Update `mae`/`mfe` on every quote (persist at most every
  few seconds while open; always on close). `initialStop` = position SL right after the opening fill
  (or the first SL set within 10 s of opening); `riskAmount`, `rMultiple = netPnl / riskAmount`.
  `exitReason` from the closing fill's role/context. `tags` come from the opening order's tags (later
  editable via PATCH). Trades close on the trading day of their final fill.
- Fills store `tradingDay = tradingDayOf(ts, account.rules.rollover)`.

### Balance & daily stats
- `balance += realizedPnl − fee` on every fill. Round to cents.
- `DailyStat` per (account, trading day): created at the first activity or rollover; tracks start/end
  balance, gross, fees, net, trades/wins/losses (closed trades by close day), fills, high/low equity,
  flags. Days without activity need no row. The calendar shows `netPnl`.
- Day flags record what happened that day and stay after a lock is over: `breach`, `daily_loss`, `tilt`,
  `locked` (max trades / personal daily stop), `break` (voluntary), `passed`, `payout`. A lock's flag follows
  from its reason (`LOCK_FLAGS`). The calendar's day drawer shows when each lock was in force, from the
  day's `locked` events (`GET /events?from&before`). Schema v3 re-flagged days whose `locked` came only from
  a break.
- Equity points: every 60 s for accounts with open positions, plus on every fill (table `equity`).

---

## 5. Challenge rules (`server/src/engine`)

Evaluated on every equity change (every quote touching the account), on every fill, at rollover, and
on a 1 s scheduler tick.

### Max loss threshold (`rules.maxLoss`)
- `static`: `threshold = startingBalance − amount`.
- `trailing_intraday`: `highWaterMark = max(hwm, equity)` on every update;
  `threshold = min(lockAt ?? ∞, hwm − amount)` and never decreases.
- `trailing_eod`: at each rollover `hwm = max(hwm, endOfDayBalance)`;
  `threshold = min(lockAt ?? ∞, hwm − amount)`, never decreases. Intraday it does not move.
- **Breach**: `equity ≤ threshold` → immediately liquidate every position at market (role
  `liquidation`, exit reason `breach`), cancel all orders, `status = 'failed'`,
  `endReason = 'Max loss limit breached'`, event `breach` (danger). Fill prices are whatever the market
  gives — equity may end below the threshold (that is realistic).

### Daily loss (`rules.dailyLoss`)
- `dailyThreshold = dayStartBalance − amount` (dayStartBalance = balance at rollover).
- `equity ≤ dailyThreshold` → liquidate + cancel; `action 'fail'` → failed ("Daily loss limit
  breached"); `action 'lock'` → `lock = {reason: 'daily_loss', until: null}` until next rollover, event
  `locked` (danger), DailyStat flag `daily_loss`.
- Warnings (event `warning`, once per level per day): max-loss buffer and daily-loss buffer at 50 % and
  25 % remaining; 5 minutes before `flatBy`.

### Profit target & passing
Pass when all hold: `balance − startingBalance ≥ profitTarget`, no open positions, `tradingDays ≥
minTradingDays`, consistency OK (`bestDayNet ≤ consistencyPct × totalProfit`). Otherwise list human
reasons in `snapshot.passBlockers` (e.g. "Close your open positions to lock in the pass", "Trade 1 more
day (2 required)", "Best day is 62% of profit — max 50%. Keep trading to dilute it.").
On pass: cancel orders, `status = 'passed'`, `endReason = 'Profit target reached'`.
- Multi-phase evaluation (phase < phaseCount): event `phase_passed`; automatically create the next
  phase account (fee 0, `parentId`, `rulesForPhase(preset, phase)`), name "50K 2-Step · Phase 2".
- Final phase: event `passed` ("You passed! Activate your funded account"). `POST /accounts/:id/activate`
  charges `activationFee` from the wallet and creates a `funded` account with `preset.funded.rules` and
  `payout` policy (one activation per passed evaluation).
- `maxCalendarDays`: not passed within N days of createdAt → failed "Time limit expired".

### Trading days & rollover
- At each account's `nextRolloverAt(rules.rollover)`: close the DailyStat, update EOD trailing, set
  `dayStartBalance = balance`, `tradingDay = new key`, clear `daily_loss` / `max_trades` /
  `personal_loss_limit` locks, check time limit and pass conditions. Event `day_rollover` (info) only if
  the account traded that day. Must also run correctly after downtime (process all missed rollovers).
- `tradingDays` = distinct trading days with ≥ 1 fill.

### Auto-flatten & weekend
- `flatBy` (Mon–Fri): at that time flatten futures positions and cancel working futures orders
  (exit reason `auto_flatten`, event `auto_flatten`, warning 5 min before).
- `noWeekendHolding`: Friday at `flatBy` (or 16:55 ET) flatten everything.

### Funded accounts & payouts
- No target. Same loss rules. `GET /accounts/:id/payout-eligibility`: winning days (DailyStat net ≥
  `minDayProfit`) since activation/last payout ≥ `minWinningDays`, profit > 0, amount between
  `minAmount` and `maxPctOfProfit × profit`, no open positions.
- `POST /accounts/:id/payouts {amount}`: balance −= amount (does **not** count as trading P&L: adjust
  dayStartBalance by the same amount so daily loss is unaffected), wallet += amount × profitSplit
  (tx `payout`), `totalPayouts`, `lastPayoutAt`, event `payout` (success), DailyStat flag `payout`.

### Discipline guard (from `Settings.tilt`, applies to every active account)
- `maxConsecutiveLosses` losing trades in a row (same trading day) → `lock {reason:'tilt_cooldown',
  until: now + cooldownMinutes}`; event `locked` (warning) "3 losses in a row — 15 minute cooldown".
- `maxTradesPerDay` closed trades → lock until rollover (`max_trades`).
- `personalDailyLoss`: day net ≤ −X → flatten + lock until rollover (`personal_loss_limit`).
- Voluntary break `POST /accounts/:id/break {minutes}` → lock `break`, day flag `break` (not `locked`).
- Locks are never removable by the client before they expire. Expired locks are cleared by the
  scheduler (event `unlocked`).
- Revenge guard is UI-side (warning only).

---

## 6. Wallet

Single wallet (the trader's personal "prop budget"). Onboarding deposits an initial amount.
- Creating an evaluation charges `preset.fee` (or the custom fee) → tx `challenge_fee`; insufficient
  balance → 400 `insufficient_funds` ("Wallet balance $40.00 — this challenge costs $149.00").
- `POST /accounts/:id/retry` (failed evaluation with a preset): charges `resetFee ?? fee`, creates a
  fresh phase-1 account ("Futures 50K · Attempt 3") with `parentId` = failed account.
- Activation fee → tx `activation_fee`. Payouts → tx `payout`. Deposits → tx `deposit`.
- `WalletSummary.monthSpent` = fees paid this calendar month (local tz); `monthBudget` from settings.
- Practice accounts are free.

---

## 7. Persistence

`node:sqlite` with WAL. Suggested tables: `accounts`, `orders`, `positions`, `fills`, `trades`,
`daily_stats`, `equity`, `events`, `wallet_tx`, `notes`, `settings` (single JSON row), `meta`
(schema version, `last_processed_ts`). JSON columns for nested objects (rules, tags, review, lock).
Indices on (account_id, ts) / (account_id, day). Schema migrations by version number.
Everything the UI shows must survive a restart. Startup: load state → reconcile gap since
`last_processed_ts` (section 8) → process missed rollovers → resume live.

**Trade replay** (schema v2): `ticks` (symbol, ts, bid, ask) is written by `server/src/replay/recorder.ts`
— every quoted symbol is sampled every 250 ms when bid/ask moved, the last 10 min are kept in memory and
written once a position opens in that symbol, then live until 3 min after it closes; 120-day retention.
`trade_brackets` (trade_id, ts, sl, tp) gets a row whenever a position's stop / target changes
(`recordBracket` in the engine). `GET /trades/:id/replay` (`server/src/replay/build.ts`) returns the trade,
its fills, its bracket history (inferred from the initial stop / take-profit fill for older trades) and the
price path over a window of 3–10 min before the entry to 1–5 min after the exit: recorded ticks when they
cover the trade, else Binance aggTrades sampled to 250 ms (windows ≤ 2 h), else 1-minute bars. The web
player (`web/src/features/journal/TradeReplay.tsx`, model in `shared/replay.ts`) builds bars of 5 s–5 min
from that path and replays position, P&L, worst / best and the brackets at any moment.

**Chart drawings** (schema v4): `drawings` (id, symbol, kind, points JSON, tp, sl, created_at, updated_at),
per symbol, shown on every timeframe. Kinds: `trendline` / `rect` (2 points), `hline` / `hray` (1 point),
`long` / `short` (entry point + right edge, with `tp` / `sl` on their own side of the entry). Points are
(unix seconds, price). `GET /drawings?symbol`, `PUT /drawings/:id` (create or replace; the client makes the
id), `DELETE /drawings/:id` (idempotent), `DELETE /drawings?symbol`; at most 500 per symbol; validation in
`server/src/engine/drawings.ts`. Client: `web/src/features/trade/chart/drawings/` — a series primitive paints
them (`render.ts`), `layer.ts` turns pointer gestures into drawings through the controller's
`ChartInteraction` hook (an armed tool gets presses first; otherwise price lines first, then drawings), the
store saves optimistically. Times map to bar indexes with `shared/drawings.ts` (gaps snap to the next bar;
outside the loaded bars it extrapolates by the timeframe).

**Order book heatmap** (schema v6): `book_rows` (symbol, t = minute start in seconds, step, bids JSON, asks
JSON), kept 24 h. Binance markets only (Yahoo has no order book). `server/src/market/depth.ts` keeps a local
book per symbol from a REST snapshot (`/fapi/v1/depth?limit=1000`) plus the `<feed>@depth@500ms` diff stream
on the /public route (Binance's sync procedure: drop events older than the snapshot, then `pu` must equal the
previous `u`, else snapshot again; levels past the snapshot appear as they change). Each second the book is
bucketed (step ≈ 0.01 % of the price, a round number of ticks) within ±1.5 % of the mid: pushed to watching
clients (WS `book` → `{type:'book', frame}`), and averaged per minute into a row (WS `book_row`; buckets under
0.2 % of the row's largest are dropped). Watchlist symbols are recorded all the time, others while watched
(≤ 12 symbols). `GET /book?symbol&from&to` (seconds) serves the rows. Client: `web/src/features/trade/chart/book/`
— a series primitive draws the minutes behind the candles (green bids, red asks, brightness relative to the
visible cells' 97th percentile; columns under 2 px merge) and the live book as depth bars on the right edge
with the three biggest walls per side labelled; toggled from the chart header (remembered per browser).

---

## 8. Gap reconciliation (sleep / downtime / disconnect)

On startup (gap = `last_processed_ts → now`) and on `market.onGap`, for each active account with
positions or working orders, fetch `getHistory1m` for the involved symbols over the gap and replay the
1m bars in time order, **pessimistically**:
1. adverse extreme first: long SL triggers if `low ≤ sl` → fill at `sl`, or at `open` if the bar opened
   beyond it (gap); short symmetric with `high`. Working stop entries likewise.
2. max-loss / daily-loss checks use equity at each position's adverse extreme of that bar; on breach
   liquidate at the price where equity crosses the threshold (bounded by the bar range), or at the
   bar's open if it opened beyond.
3. then favorable extreme: TP / limit fills at their price if `high ≥ tp` (long).
4. trailing_intraday HWM updates from the bar close only (pessimistic).
5. rollovers / flatBy times inside the gap are applied at their timestamps (flatBy fills at that bar's
   open).
Fills from reconciliation carry their historical timestamps; emit one `catch_up` event per account
summarizing ("While you were away: stop-loss hit on MNQ at 25,012.25 (−$184.50)"). Persist
`last_processed_ts` every few seconds while live. Gaps shorter than 5 s are ignored. If history is
unavailable, fall back to the first live quote after the gap.

---

## 9. API layer (`server/src/api`)

Implements exactly `shared/api.ts`. Hono app mounted at `/api`, JSON errors `{error, code}` with 400
(validation/rules), 404, 409 (state conflict), 500. WebSocket `/ws`:
- on connect send `hello`; client sends `subscribe` (quote symbols) and `chart` (1 symbol).
- quotes: batch per client every ~125 ms (latest quote per symbol only).
- `candle`: live 1m bars for the client's chart symbol.
- account snapshots: throttle ≤ 4/s per account, plus immediate after fills / status changes.
- everything else (order/position/fill/trade/event/wallet/settings/account/feeds) pushed immediately
  to all clients.
- The server keeps `market.retain(sym, 'ws:<id>')` for client subscriptions and releases on close.
- `GET /api/candles` proxies `market.getCandles`.
- Static: serve `web/dist` with SPA fallback when it exists.

---

## 10. Web app

**Monochrome UI (user requirement): black / white / grays only.** Color is used ONLY for trading
semantics — green for profit / buy / up candles, red for loss / sell / down candles, amber for rule
warnings. No blue or other accent colors anywhere: primary actions are white with black text, active
states use white/gray, charts use white/gray for everything except candles, P&L and buy/sell markers.
Dark professional trading UI, dense but calm. Desktop-first (1920×1080 at 83 % scale ≈ 2300×1300
CSS px; must also work at 1280×720). Fonts: Inter (UI) + JetBrains Mono (numbers, tabular).
Green `profit` / red `loss` semantic colors; never rely on color alone (always signs/arrows).
Tokens live in `web/src/styles/index.css` (`bg-bg`, `bg-panel(-2/-3)`, `border-line(-strong)`,
`text-fg`, `text-muted`, `text-faint`, `bg-accent`/`text-accent-fg` (white/black), `text-profit`,
`text-loss`, `text-warn`).

Foundation (lead): `web/src/api/client.ts` (typed REST), `web/src/api/socket.ts` (WS → store, event
bus), `web/src/store/*` (zustand), `web/src/components/ui/*` (primitives), `web/src/lib/format.ts`,
`web/src/App.tsx` (shell, nav, routes). Feature agents build pages in `web/src/features/<feature>/`.

### Pages
1. **Trade** (`/trade`) — the terminal. Account header (balance, equity, open P&L, day P&L, max-loss
   buffer meter, daily-loss buffer meter, target progress, lock state), watchlist, chart (candles +
   volume, timeframes, position/SL/TP/working-order lines that can be **dragged** to modify, fill
   markers, live last bar, drawing tools with a magnet, the price source and its TradingView symbol),
   order ticket (market/limit/stop, qty or **risk-$ sizing**, SL/TP in price /
   ticks / $, live risk & reward in $ + % of buffer + R:R + work-hours, big Buy (ask) / Sell (bid)
   buttons, flatten, reverse, mood/setup check-in, confirmation per settings), bottom tabs (positions,
   working orders, fills, today's trades, account events).
2. **Calendar** (`/calendar`) — month grid (Sun–Sat + weekly totals column), each day: net P&L,
   trades, win rate, heat-tinted; month summary (net, green/red days, win rate, best/worst, avg day);
   account filter (All / each account); year heatmap; click a day → drawer with that day's trades,
   intraday equity curve, fills, notes editor.
3. **Journal** (`/journal`) — trade log with filters (account, symbol, side, result, mood, date range),
   trade detail drawer (chart around the trade with entry/exit markers, tags/review editing),
   analytics: KPIs (net, win rate, profit factor, expectancy, avg win/loss, avg R, max drawdown, avg hold),
   equity curve, P&L by mood / setup / symbol / weekday / hour / side, plan-adherence stats.
4. **Challenges** (`/challenges`) — active/passed/failed accounts as cards with rule progress, "New
   challenge" (preset gallery with fees and rules, or custom builder), practice account creation,
   retry failed, activate funded, payouts, a sober "graveyard" of failed attempts with what they cost.
5. **Wallet** (`/wallet`) — balance, deposited, fees paid, payouts, net; monthly budget usage; ledger.
6. **Settings** (`/settings`) — discipline (tilt guard, require SL, confirmations, check-ins), realism
   (hourly wage, sounds, volume, notifications), watchlist, data feed status.

### Cross-cutting realism layer (realism-ui agent, mounted once in App)
- Sounds, TradingView's way (`web/src/lib/sounds.ts`): every fill plays `settings.fillSound` (the "Order
  filled" voice clip or one of TradingView's 8 execution sounds); account alerts (warning, breach, pass, lock,
  unlock, auto-flatten, payout) play `settings.alertSound` (a TradingView alert sound, null = silent). Placing,
  modifying, cancelling and rejecting orders is silent. One sound at a time, like TradingView.
- Full-screen moments: breach ("ACCOUNT FAILED", fee lost, stats), pass (celebration + next steps),
  lock overlay with countdown + reflection prompt (saved as day note), catch-up summary.
- Post-trade review prompt after a trade closes (followed plan? rating, mistakes, mood after).
- Onboarding on first run: name, wallet deposit ("money you'd really spend on challenges"), hourly
  wage, first account (preset or practice).
- Desktop notifications when the window is hidden.
