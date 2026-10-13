# Live strategies: entry and exit rules (reference)

Reference only. This describes what the live server bot does as of 1 Oct 2026. Nothing here changes the code.

All times are IST. "Nifty" means the NIFTY 50 spot index. "WS" means the Zerodha Kite websocket (live tick feed). All examples use a Nifty lot size of 65.

---

## 0. The big picture

The server runs two independent morning trades on the same bot, plus an optional afternoon fade:

| | 9:15 trade | 9:16 trade | 14:05 fade (optional) |
|---|---|---|---|
| What it reads | The first 10 seconds of the 9:15 minute | The full 9:15 minute (open to close) | 14:05 close vs 9:15 open + range vs yesterday |
| When it buys | 9:15:11 | 9:16:01 | 14:06 (first tick in window) |
| Signal | Red ≥ 5 / green ≥ 10 vs open | Red/green ≥ 15 on 9:15 candle | 100+ from open **and** today’s range through 14:05 > yesterday full range → **fade** |
| Order type | Market buy | Market buy | Market buy |
| Main exit | Trailing P&amp;L ladder on option | Take-profit limit + Nifty index exit | **Nifty index trail** (25 / 5 / 4 / 10) + −30% capital stop |

A day can have no trade, only the 9:15 trade, only the 9:16 trade, or both morning legs one after the other. The two morning legs can never be open together. If the 9:15 trade is still open at 9:16:00, the 9:16 trade is skipped for the day (with one exception, see 1.10).

The **14:05 fade** runs only after the morning session logic has finished for the day (no morning leg still open), if enabled on the server. It never overlaps a morning trade. At most one 14:05 entry per day.

Traps, the later-session strategy, is a separate bot and is currently switched off on the server. It is not covered here.

### Terms used in this document

- **Open (9:15 open):** the first Nifty WS tick from 9:15:00 onwards (must arrive by 9:15:15).
- **Mark (9:15:10 read):** the last Nifty WS tick strictly before 9:15:10. A tick at 9:15:09.98 counts; a tick at 9:15:10.02 does not.
- **9:15 close (for the 9:16 entry):** the last Nifty WS tick strictly before 9:16:00.
- **Δ (delta):** 9:15 close − 9:15 open. Negative means a red candle, positive means green.
- **ATM:** the at-the-money strike, meaning the Nifty strike nearest the current spot.
- **Entry spot:** the Nifty level at the moment the option buy fills. All index-based exits are measured from this number.
- **Capital deployed:** average option entry price × quantity. Take-profit % is always measured on this, never on the Nifty index.
- **₹0.05 tick:** NSE option prices move in steps of ₹0.05, so every limit price is rounded to the nearest ₹0.05.

---

## 1. The 9:15 trade (PE or CE at 9:15:11)

### 1.1 Step 1: capture the 9:15 open

From 9:15:00 the bot listens to the Nifty websocket. The first tick it receives is locked as the 9:15 open.

If no tick arrives between 9:15:00 and 9:15:15, there is no 9:15 trade that day.

> Example: the first tick after 9:15:00 arrives at 9:15:00.21 with Nifty at 24,000.00. **Open = 24,000.00.**

### 1.2 Step 2: pre-resolve both options at 9:15:04

At 9:15:04 the bot uses the live Nifty spot to look up the ATM CE and ATM PE contracts. It also warms them up, so that at 9:15:11 it only has to place the order.

The first order attempt uses this strike even if Nifty has moved a little since 9:15:04. Retries look the strike up again from the latest spot.

> Example: spot at 9:15:04 is 24,003 → ATM strike 24,000 → contracts NIFTY…24000CE and NIFTY…24000PE are ready.

### 1.3 Step 3: read the direction at 9:15:10

The bot compares the mark (last tick before 9:15:10) with the open:

| Read at 9:15:10 | Rule | Result |
|---|---|---|
| Red, drop ≥ 5 points | open − mark ≥ 5 | Buy ATM **PE** at 9:15:11 |
| Green, rise ≥ 10 points | mark − open ≥ 10 | Buy ATM **CE** at 9:15:11 |
| Red but drop < 5 | | No 9:15 trade |
| Green but rise < 10 | | No 9:15 trade |
| Flat (mark = open) | | No 9:15 trade |

Note that green needs a bigger move (10 points) than red (5 points).

> Examples (open = 24,000.00):
>
> | Mark (last tick before 9:15:10) | Move | Decision |
> |---|---|---|
> | 23,993.50 | Red by 6.50 | **Buy PE** |
> | 23,995.00 | Red by exactly 5.00 | **Buy PE** (5 is enough) |
> | 23,996.00 | Red by 4.00 | No trade |
> | 24,011.20 | Green by 11.20 | **Buy CE** |
> | 24,010.00 | Green by exactly 10.00 | **Buy CE** (10 is enough) |
> | 24,007.00 | Green by 7.00 | No trade (green needs 10) |
> | 24,000.00 | Flat | No trade |

### 1.4 Step 4: sizing (how many lots)

1. The bot reads the option's last traded price (LTP) twice over REST, 1 second apart, and sizes on the **lower** of the two prices. This protects against an opening spike in the first quote.
2. It uses the full available balance, with a **3% margin cushion**: lots = floor(available balance ÷ (LTP × 1.03 × 65)). Kite blocks margin for a market buy about 3% above the last price (on 28 Sep it asked ₹1,09,473 for an order worth ₹1,06,265 at the last price), so sizing on the raw price would get the first order refused.
3. Kite allows at most 25 lots per order, so a larger size is split into parallel orders (for example 29 lots → one order of 25 and one of 4). It is still one position.

Timing note: the two price reads take about 1 second, so the order usually reaches Kite at about 9:15:12, not exactly 9:15:11.000.

> Example: available balance ₹2,00,000. PE quotes are ₹101.00, then ₹100.00 one second later. The bot sizes on ₹100.00 × 1.03 = ₹103.00. One lot counts as 103 × 65 = ₹6,695, so 2,00,000 ÷ 6,695 = 29.9 → **29 lots (1,885 qty)**, sent as 25 + 4 lots.

### 1.5 Step 5: the entry order

- **NRML market buy.** It fills at the live price, not at a fixed limit, so it gets filled fast.
- Your actual entry price is the average fill price Kite reports. It can be a little different from the price used for sizing.

### 1.6 What happens if Kite says "insufficient funds"

The 3% cushion covers the usual extra margin, but the live price can still move between sizing and placement, so Kite can occasionally reject for margin.

1. The bot immediately retries with fewer lots:
   - If Kite quotes "Required" and "Available" amounts, the bot scales the size down in one step: new lots = floor(current lots × available ÷ required). It always drops at least 1 lot.
   - If Kite doesn't quote the amounts, it drops exactly 1 lot.
2. It keeps retrying instantly, with no deliberate pause, **until 9:15:15**.
3. If it still hasn't got in by 9:15:16, the 9:15 trade is skipped for the day. The 9:16 trade is not affected.

> Example: the bot tries 29 lots. Kite replies "Required: ₹2,01,500 · Available: ₹2,00,000". The scaled size is floor(29 × 2,00,000 ÷ 2,01,500) = floor(28.78) = **28 lots**, retried at once. If 28 is also rejected, it tries 27, and so on, until 9:15:15.

### 1.7 Partial fill

If some of the split orders fill and others are rejected (for example the 25-lot order fills but the 4-lot order is refused), the bot keeps what filled. It then tops up the missing lots, using the same downsize logic, **until 9:15:20**.

> Example: the target is 29 lots, but only the 25-lot order filled. The bot tries to buy 4 more lots. If 4 is refused for margin, it tries 3, then 2, and so on. It stops trying at 9:15:20 and manages whatever quantity it holds.

### 1.8 Exit 1: take-profit limit sell (the main exit)

The moment the buy fills, the bot places a resting **limit sell** for the whole quantity at:

**limit price = entry price × (1 + take-profit %), rounded to the nearest ₹0.05**

| Leg | Mon | Tue | Wed | Thu | Fri |
|---|---|---|---|---|---|
| **PE** (red 9:15) | 5% | 5% | 3% | 3% | 3% |
| **CE** (green 9:15) | 3% | 3% | 3% | 3% | 3% |

The % is profit on capital deployed (entry price × quantity), not a Nifty move.

> Example A (PE on a Monday): entry ₹100.00 × 1,885 qty = ₹1,88,500 deployed. Limit = 100 × 1.05 = **₹105.00**. If it fills, profit = 5 × 1,885 = **₹9,425** (5% of ₹1,88,500).
>
> Example B (PE on a Wednesday): same entry. Limit = 100 × 1.03 = **₹103.00**. Profit = **₹5,655** (3%).
>
> Example C (CE on any day): same entry. Limit = **₹103.00**. Profit = **₹5,655** (3%).
>
> Example D (rounding): entry ₹87.35 at 3% → 87.35 × 1.03 = 89.9705 → nearest ₹0.05 = **₹89.95**.

If Kite rejects the limit order, the bot retries straight away, up to 15 attempts. If it still can't place it, the market backup below still protects the target.

### 1.9 Exit 2: market backup

The bot also watches live unrealised P&L. If P&L reaches the same target (PE weekday % or CE 3%) but the limit sell hasn't filled, the bot cancels the limit and sells at market.

> Example: the limit sits at ₹105.00, the option trades at ₹105.10 for a moment, but your limit doesn't fill (queue or partial). Live P&L shows ≥ ₹9,425, so the bot cancels the limit and sells at market.

### 1.10 Exit 3: small-body exit at 9:16:01

This checks whether the whole 9:15 minute confirmed the move.

1. At 9:16:00 the bot seals the 9:15 close (last Nifty tick before 9:16:00).
2. If the 9:15 trade is still open and **|9:15 close − 9:15 open| < 5 points**, the exit is armed.
3. On the first Nifty tick in the 9:16:01 second, the bot cancels the take-profit limit and sells everything at market, whatever the P&L.

Why: the trade was bought because of the move at 9:15:10. If the full minute closes almost flat, that move has faded and the reason for the trade is gone.

> Example (PE): open 24,000.00. At 9:15:10 Nifty is 23,993 (red by 7), so the bot buys a PE. By 9:15:59 Nifty has bounced to 23,998, a body of only 2 points. The take-profit hasn't filled, so the PE is sold at market at 9:16:01.
>
> Counter-example: if the close had been 23,990 (body 10 points), nothing happens. The trade carries on with its take-profit, market backup, hard stop and 3:25 PM exit.

It applies the same way to CE trades; only the size of the body matters, not its direction.

When this exit is armed, the 9:16 trade is not marked as skipped, because the 9:15 trade is being closed at 9:16:01 anyway. In every other case where the 9:15 trade is still open at 9:16:00, the 9:16 trade is skipped for the day.

### 1.11 Exit 4: hard stop (from 10:00 AM)

From 10:00 AM, the bot exits at market if Nifty has moved **30 points against** the trade, measured from the entry spot:

- **PE:** exit when Nifty ≥ entry spot + 30
- **CE:** exit when Nifty ≤ entry spot − 30

Before 10:00 there is no hard stop.

> Example (PE): entry spot 23,990. From 10:00 the stop level is 24,020. If Nifty is at 24,035 at 9:45, nothing happens because the stop isn't active yet. If Nifty is 24,020 or higher at any time from 10:00, the bot sells at market.
>
> Example (CE): entry spot 24,012. The stop level is 23,982 from 10:00.

### 1.12 Exit 5: 3:25 PM square-off

Any 9:15 position still open at 3:25 PM is sold at market, whatever the P&L.

### 1.13 Capital stop −30%

On every option websocket tick, if unrealised P&L reaches **−30% of capital deployed** (entry premium × quantity), any resting limit is cancelled and the position is sold at market. The same stop applies to the 9:16 trade. Whichever exit prints first closes the leg.

### 1.14 There is no trailing stop

Apart from the exits above, there is no other option-price stop and no trailing ladder on this write-up. The trade either hits a take-profit, the −30% capital stop, the small-body exit or the hard stop, or runs until 3:25 PM.

### 1.15 9:15 trade, full worked example (a Monday)

1. 9:15:00.2: open = 24,000.00.
2. 9:15:04: ATM 24000 CE and PE are pre-resolved.
3. 9:15:09.9: last tick before 9:15:10 is 23,992.40, red by 7.60, so the decision is to buy the PE.
4. About 9:15:12: quotes are ₹101.00 and ₹100.00, so it sizes on ₹100 × 1.03 = ₹103. With a ₹2,00,000 balance that's 29 lots, sent as 25 + 4.
5. Fills at an average of ₹100.20, 1,885 qty, so ₹1,88,877 deployed.
6. Take-profit limit (Monday, PE, 5%): 100.20 × 1.05 = 105.21 → **₹105.20**.
7. 9:16:00: 9:15 close 23,985 (body 15), so no small-body exit.
8. At 9:22 the option reaches ₹105.20, the limit fills, and profit is about (105.20 − 100.20) × 1,885 = **₹9,425**.

---

## 2. The 9:16 trade (PE or CE at 9:16:01)

### 2.1 Entry decision: Δ of the full 9:15 candle

- **9:15 open:** the same first tick from 9:15:00 used by the 9:15 trade.
- **9:15 close:** the last Nifty WS tick strictly before 9:16:00, logged as the 9:15:59 close.
- **Δ = close − open.**

| Δ | Result |
|---|---|
| Flat (Δ = 0) | No trade |
| \|Δ\| < 15 | No trade |
| Red, \|Δ\| ≥ 15 | Buy ATM **PE** at 9:16:01 |
| Green, \|Δ\| ≥ 15 | Buy ATM **CE** at 9:16:01 |

> Examples (open = 24,000.00):
>
> | 9:15 close | Δ | Decision |
> |---|---|---|
> | 23,980.00 | −20 | **Buy PE** |
> | 23,985.00 | −15 (exactly) | **Buy PE** |
> | 23,990.00 | −10 | No trade |
> | 24,018.00 | +18 | **Buy CE** |
> | 24,015.00 | +15 (exactly) | **Buy CE** |
> | 24,009.00 | +9 | No trade |

**Blocked:** if the 9:15 trade is still open at 9:16:00, the 9:16 trade is skipped for the day. The exception is the small-body exit case in 1.10.

### 2.2 Pre-arming at 9:15:58

At 9:15:58 the bot looks up the ATM CE and PE strikes from the live spot and subscribes both options to the websocket. That way the 9:16:01 order doesn't need any slow REST calls.

### 2.3 Sizing at 9:16:01

At exactly 9:16:01.000 (a dedicated timer) the bot sizes the order on the **latest option websocket price** it already has for the chosen option. Both options have been streaming since 9:15:58, so there's no waiting for a new tick. If that price is more than 3 seconds old, it reads one REST quote instead.

Kite blocks margin for a market buy about 3% above the last price, so a full-balance order sized on the raw price would be refused. The bot therefore sizes as if the premium were **3% higher**.

> Example: latest PE price ₹78.20, balance ₹1,17,010. Sizing price = 78.20 × 1.03 = ₹80.55. One lot = 80.55 × 65 = ₹5,236, so 1,17,010 ÷ 5,236 = 22.3 → **22 lots**.

### 2.4 The entry order

- **NRML market buy** at 9:16:01, split into 25-lot orders if larger (up to 9 orders sent at the same moment). There's no limit price and nothing to wait for; it fills at the market price.
- The bot checks for the fill every 0.2 seconds.
- **Retries until 9:16:30:** if an attempt fails, the bot re-reads prices and tries again until 9:16:30. After that there is no 9:16 trade that day.

### 2.5 Partial fill and margin short

- **Partial fill:** the bot keeps what filled and tops up the missing lots until 9:16:30.
- **Insufficient margin:** it steps the size down and retries instantly, with no pause (for example 25 → 24 → 23), scaling in one jump when Kite quotes the required and available amounts.

> Example: the bot tries 26 lots as 25 + 1. The 25-lot order fills and the 1-lot order is rejected for margin. It keeps the 25 lots and tries to top up 1 lot until 9:16:30.

### 2.6 Exit 1: take-profit limit sell

The moment the entry fills, a resting **limit sell** is placed at:

**limit price = entry price × (1 + take-profit %), rounded to the nearest ₹0.05**

Same percentage for PE and CE. Same colour means the 9:16:00 open keeps the 9:15 colour (PE: open ≤ 9:15:59 close · CE: open ≥ 9:15:59 close). Different colour is the gap the other way.

| 9:16 colour vs 9:15 | Mon | Tue | Wed | Thu | Fri |
|---|---|---|---|---|---|
| **Same colour** | 10% | 10% | 3% | 6% | 9% |
| **Different colour** | 7% | 8% | 2% | 4% | 6% |

> Example (Tuesday, same colour, either PE or CE): entry ₹64.75 × 1,625 qty (25 lots) = ₹1,05,219 deployed. Limit = 64.75 × 1.10 = 71.225 → **₹71.25**.

If Kite rejects the limit order, the bot retries straight away, up to 15 attempts.

### 2.7 Exit 2: market backup

This works the same as the 9:15 trade. If unrealised P&L reaches the target % but the limit hasn't filled, the bot cancels the limit and sells at market.

### 2.8 Exit 3: parallel Nifty index exit (market sell)

This runs at the same time as the take-profit limit; whichever is hit first closes the trade. It watches the Nifty index, not the option price.

Three reference ticks decide the target:

- **9:15:59 close:** the last Nifty tick inside the 9:15:59 second.
- **9:16:00 open:** the first Nifty tick inside the 9:16:00 second.
- **9:16:59 close:** the last Nifty tick inside the 9:16:59 second.

Any difference counts, even 0.05: an open slightly below the 9:15:59 close is red, slightly above is green. An open exactly equal to the 9:15:59 close counts as the same colour as the 9:15 candle for that trade (the 12-point tier).

#### PE trade (red 9:15)

| Condition | Target |
|---|---|
| 9:16:00 open ≤ 9:15:59 close (both candles red) | Nifty ≤ entry spot **− 12**, until a tick above the 9:15:59 close, then **− 8** |
| 9:16:00 open > 9:15:59 close (green gap at 9:16) | Nifty ≤ entry spot **− 8** until 9:17:00 |

**Same-colour open (−12):** any later Nifty websocket tick that trades **above the 9:15:59 close** — including the first tick after the 9:16:00 entry — moves the index aim to entry spot **− 8** and replaces the limit sell at that weekday's different-colour %. A print equal to the 9:15:59 close does not flip it.

**Gap open (−8):** from 9:17:00, if the 9:16 minute closed green (9:16:59 close > 9:15:59 close), the target moves to Nifty ≤ entry spot **− 6**.

> Example (Tuesday PE, both red):
> - 9:15:59 close = 22,000. 9:16:00 open = 21,999, so both are red. Aim is **−12** and the limit is **+10%**.
> - The next tick prints 22,001, above the 9:15:59 close. On that tick the aim becomes **−8** and the limit is replaced at **+8%**.

#### CE trade (green 9:15), the mirror image

| Condition | Target (until 9:17:00) |
|---|---|
| 9:16:00 open ≥ 9:15:59 close (both candles green) | Nifty ≥ entry spot **+ 12** |
| 9:16:00 open < 9:15:59 close (red gap at 9:16) | Nifty ≥ entry spot **+ 8** |

**Until 9:17:** same-colour open is +12 (a print below the 9:15:59 close moves it to +8 and switches the limit, including right after entry). A gap open is +8.

**From 9:17:** the CE index aim is the Nifty entry spot only. +12, +8 and +6 stop. Market sell when Nifty is at or above the entry spot.

> Example (CE, both green):
> - 9:15:59 close = 24,018.00. 9:16:00 first tick = 24,019.00, so both candles are green.
> - Entry spot at fill = 24,020.00, so until 9:17 the **target is 24,032.00** (+12).
> - From 9:17 the aim is **24,020.00**, the entry spot. A print at or above that sells at market.

Why the target shrinks: when the second candle goes against the trade, the move is weaker, so the bot settles for a smaller, quicker index target.

Edge cases:

- If a CE is already at or above its entry spot at 9:17:00, the entry-spot exit fires on that tick.
- If no Nifty tick arrives in the 9:16:00 second, the bot uses the entry spot as the 9:16 open.
- If no Nifty tick arrives in the 9:15:59 second, the index exit isn't armed for that day. The trade then relies on the take-profit, market backup, hard stop and 3:25 PM exits. This is rare, because Nifty normally ticks several times a second.

### 2.9 Exit 4: adverse checkpoint + entry return (not the 10:00 hard stop)

On the **first Nifty websocket tick** at or after the checkpoint second:

- **PE:** exit at market if Nifty ≥ entry spot **+ 40** (checkpoint **9:26:00 IST**)
- **CE:** exit at market if Nifty ≤ entry spot **− 40** (checkpoint **9:17:00 IST**)

If the 40-point stop does **not** fire at that tick, the bot arms **entry return**: exit at market the instant Nifty touches the entry spot again (PE: spot ≤ entry · CE: spot ≥ entry) on any later websocket tick.

Runs alongside the take-profit limit and parallel index exit; the first to trigger wins. The 9:15 leg still uses the **10:00 AM ±30** hard stop; the 9:16 leg does not.

**9:17:00 opposite-body exit.** On the first Nifty websocket tick at or after 9:17:00 (only within the 9:17 minute), the bot compares the two candle bodies from websocket ticks:

- 9:15 body = 9:15:59 close − 9:15 open (the body that chose the trade)
- 9:16 body = last tick in 9:16:59 − first tick at 9:16:00

If the 9:16 body points the other way and is **at least as many points** as the 9:15 body, the 9:16 trade is sold at market. Example: 9:15 red by 20 (PE bought), 9:16 green by 20 or more → exit at 9:17:00. This check runs before the 9:17 CE retarget and the CE 40-point checkpoint. If either candle's ticks are missing, the check is skipped and logged.

### 2.10 Exit 5: 3:25 PM square-off

Any 9:16 position still open at 3:25 PM is sold at market.

### 2.11 Capital stop −30%

On every option websocket tick, if unrealised P&L reaches **−30% of capital deployed** (entry premium × quantity), the resting take-profit limit is cancelled and the position is sold at market. The same stop applies to the 9:15 trade.

### 2.12 There is no trailing stop

There is no trailing ladder. The trade closes on the first of the take-profit limit, market backup, −30% capital stop, index exit, 9:17 opposite-body exit, adverse checkpoint / entry return, or 3:25 PM.

### 2.13 How an exit actually fires (both trades)

- Parallel index exit, adverse checkpoint, and entry return are checked on **every Nifty websocket tick**, about 4 a second. A separate **1-second safety check** repeats them even if the rest of the bot stalls. They never wait behind a Kite request.
- On the tick that crosses the level, the bot cancels the take-profit limit and sells the **whole position at market** in parallel orders (max 25 lots each, up to 9 at once). Fills are checked every 0.2 seconds.
- If the take-profit limit was confirmed unfilled within the last 3 seconds and Kite accepted the cancel, the sell goes out without waiting for a holdings check. Holdings are verified straight after, and if a fill slipped in and the account ends up short, the excess is bought back at once.
- Kite read requests (orders, positions, quotes) give up after 6 seconds per attempt and retry, so a stuck request can't freeze the bot.
- If any bot step is busy for more than 20 seconds, the session log shows `Bot loop stalled … at "<step>"`.

### 2.14 9:16 trade, full worked example (a Tuesday, PE)

1. 9:15 open 24,000.00, 9:15 close (last tick before 9:16:00) 23,980.00, so Δ = −20, red, and |Δ| ≥ 15. Buy PE.
2. 9:15:58: ATM 24000 CE and PE are resolved and subscribed.
3. 9:16:00 first Nifty tick is 23,978.50, which is ≤ the 9:15:59 close of 23,980.00, so both candles are red and the index tier is −12.
4. 9:16:01.000: the latest PE websocket price is ₹64.75, so it sizes on 64.75 × 1.03 and sends a market buy. Fills at an average of ₹64.75: 25 lots = 1,625 qty.
5. Entry spot at fill is 23,976.00, so the index target is 23,964.00.
6. Take-profit limit (Tuesday, same colour, 10%): 64.75 × 1.10 → **₹71.25**.
7. Nifty stays at or below the 9:15:59 close of 23,980.00, so the −12 aim is not reduced. Any tick above 23,980.00 would have moved the aim to −8 and the limit to 8% on that tick. The 9:16:59 last tick is 23,972.00, so the gap-open −6 rule also does not apply.
8. 9:19: Nifty touches 23,964.00 before the option reaches ₹71.25, so the index exit fires. The bot cancels the take-profit limit and sells at market.

---

## 3. The 14:05 trend-day fade (optional afternoon leg)

Enabled when the server flag is on (default on unless `FADE_1405_ENABLED=0`). Uses the same websocket Nifty feed and the same sizing rules as the morning legs.

### 3.1 Entry (all at 14:05 close, entry at 14:06)

1. **Distance from open:** Nifty at the **14:05 close** is at least **100 points** above or below the **9:15 open** (same open as the morning bot).
2. **Range expansion:** Today’s high–low from **9:15 through 14:05** is **strictly greater** than **yesterday’s full session** high–low (prior weekday, from Kite 1-minute candles).
3. **Fade:** If Nifty is 100+ **above** the open → buy **ATM PE**. If 100+ **below** → buy **ATM CE**.
4. **Timing:** Entry on the **14:06** websocket window (same bot as 9:15/9:16). Skipped if a morning trade is still open, the 14:06 window is missed, or the leg already traded/settled today.

### 3.2 Exit

- **Nifty trail on every tick:** initial stop **25** points against the entry spot; once **+5** in favour, trail **4** points behind the best favourable move with floor **+5**; hard cap **+10** on Nifty points; if still open, **flat at 3:20 PM** on the index schedule used in backtest.
- **−30% capital stop** on option LTP (same as morning legs).
- **3:25 PM** market square-off if anything is still open (bot-wide cutoff).

There is **no** 9:16-style take-profit limit or ±12/±8 index target on this leg.

---

## 4. Quick comparison

| | 9:15 trade | 9:16 trade | 14:05 fade |
|---|---|---|---|
| Signal | 9:15:10 read vs open | Full 9:15 candle Δ | 14:05 close + range vs yesterday |
| Red threshold | ≥ 5 points → PE | ≥ 15 points → PE | 100+ below open → CE (fade) |
| Green threshold | ≥ 10 points → CE | ≥ 15 points → CE | 100+ above open → PE (fade) |
| Entry time | 9:15:11 (order ~9:15:12) | 9:16:01 | ~14:06 |
| Entry order | Market buy | Market buy (latest WS price + 3% sizing cushion) | Market buy |
| Margin retries until | 9:15:15 (top-ups until 9:15:20) | 9:16:30 | Same burst pattern in 14:06 window |
| PE take-profit | trailing ladder from +3% | weekday × same/different colour (section 2.6) | Nifty trail only |
| CE take-profit | trailing ladder from +3% | same table as PE (section 2.6) | Nifty trail only |
| Market backup | Yes, same % | Yes, same % | No TP limit — trail / capital stop |
| Index exit | No | Yes: ∓12 / ∓8, then ∓6 from 9:17 | Trail 25/5/4/10 + 3:20 flat |
| Small-body exit | Yes, at 9:16:01 if 9:15 body < 5 | No | No |
| Hard stop / adverse | From 10:00, 30 points against | PE @ 9:26 · CE @ 9:17: 40 pts adverse, else entry return | Initial 25-pt Nifty stop only |
| Force exit | 3:25 PM | 3:25 PM | 3:25 PM (3:20 trail flat in backtest) |
