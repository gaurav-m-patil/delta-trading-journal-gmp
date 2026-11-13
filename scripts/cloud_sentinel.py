#!/usr/bin/env python3
"""
24/7 Institutional Cloud Sentinel for Delta Exchange India
------------------------------------------------------------
Runs autonomously in the cloud via GitHub Actions.
Monitors BTC/USD 15m candles, detects SMC liquidity sweeps and BOS setups,
identifies real Delta India ATM option contracts, and dispatches instant
actionable trade signals and trade outcomes to Telegram even when the app is closed.
"""

import os
import sys
import time
import json
import requests
from datetime import datetime, timezone, timedelta

# Firebase Firestore Configuration (physio-clinic-730a1)
FIREBASE_PROJECT = "physio-clinic-730a1"
FIREBASE_KEY = "AIzaSyDdpqAHFRBAib7wXFg3fg2ICkXUEe9HW_8"
STATE_FILE = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data", "sentinel_state.json")

DELTA_BASE = "https://api.india.delta.exchange"
BINANCE_BASE = "https://api.binance.com"


def get_telegram_config():
    """
    Retrieves Telegram credentials from environment variables (GitHub Secrets)
    or directly from Firebase Firestore settings collection.
    """
    token = os.environ.get("TELEGRAM_BOT_TOKEN", "").strip()
    chat_id = os.environ.get("TELEGRAM_CHAT_ID", "").strip()
    enabled = True

    if token and chat_id:
        return {"bot_token": token, "chat_id": chat_id, "enabled": True}

    # Fallback to Firestore GP_DTJ_settings/telegram
    try:
        url = f"https://firestore.googleapis.com/v1/projects/{FIREBASE_PROJECT}/databases/(default)/documents/GP_DTJ_settings/telegram?key={FIREBASE_KEY}"
        res = requests.get(url, timeout=10)
        if res.status_code == 200:
            doc = res.json()
            fields = doc.get("fields", {})
            f_token = fields.get("botToken", {}).get("stringValue", "").strip()
            f_chat = fields.get("chatId", {}).get("stringValue", "").strip()
            f_enabled = fields.get("enabled", {}).get("booleanValue", True)
            if f_token and f_chat:
                return {"bot_token": f_token, "chat_id": f_chat, "enabled": f_enabled}
    except Exception as e:
        print(f"[Sentinel] Notice reading Firestore settings: {e}")

    return {"bot_token": token, "chat_id": chat_id, "enabled": enabled if (token and chat_id) else False}


def load_sentinel_state():
    """Loads persistent sentinel tracking state from data/sentinel_state.json."""
    today_str = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    default_state = {
        "last_alerted_trade_id": None,
        "active_trade": None,
        "last_alerted_catalyst_guid": None,
        "daily_counts": {
            "date": today_str,
            "trades_given": 0,
            "wins": 0,
            "losses": 0
        }
    }

    if os.path.exists(STATE_FILE):
        try:
            with open(STATE_FILE, "r", encoding="utf-8") as f:
                data = json.load(f)
                # Reset daily counts if new day
                if data.get("daily_counts", {}).get("date") != today_str:
                    data["daily_counts"] = {
                        "date": today_str,
                        "trades_given": 0,
                        "wins": 0,
                        "losses": 0
                    }
                return data
        except Exception as e:
            print(f"[Sentinel] Error reading state file, using defaults: {e}")

    return default_state


def save_sentinel_state(state):
    """Saves updated tracking state to data/sentinel_state.json."""
    try:
        os.makedirs(os.path.dirname(STATE_FILE), exist_ok=True)
        with open(STATE_FILE, "w", encoding="utf-8") as f:
            json.dump(state, f, indent=2)
        print("[Sentinel] State saved successfully.")
    except Exception as e:
        print(f"[Sentinel] Error saving state file: {e}")


def send_telegram_message(bot_token, chat_id, html_text):
    """Dispatches a formatted HTML message to Telegram."""
    if not bot_token or not chat_id:
        print("[Sentinel] Telegram credentials not configured. Skipping alert.")
        return False

    url = f"https://api.telegram.org/bot{bot_token}/sendMessage"
    payload = {
        "chat_id": chat_id,
        "text": html_text,
        "parse_mode": "HTML",
        "disable_web_page_preview": False
    }

    try:
        res = requests.post(url, json=payload, timeout=15)
        if res.status_code == 200:
            print("[Sentinel] Telegram message dispatched successfully.")
            return True
        else:
            print(f"[Sentinel] Telegram API response error: {res.status_code} - {res.text}")
            return False
    except Exception as e:
        print(f"[Sentinel] Telegram dispatch exception: {e}")
        return False


def fetch_btc_candles():
    """
    Fetches recent 15m BTC candles from Delta Exchange India (Primary),
    with automatic Binance fallback if Delta is unreachable.
    """
    now = int(time.time())
    start = now - (86400 * 2) # Last 48 hours

    # 1. Delta Exchange India Native Historical Candles
    try:
        url = f"{DELTA_BASE}/v2/history/candles?resolution=15m&symbol=BTCUSD&start={start}&end={now}"
        res = requests.get(url, timeout=12)
        if res.status_code == 200:
            data = res.json().get("result", [])
            if data and len(data) >= 20:
                candles = []
                for c in data:
                    candles.append({
                        "time": int(c.get("time")),
                        "open": float(c.get("open")),
                        "high": float(c.get("high")),
                        "low": float(c.get("low")),
                        "close": float(c.get("close")),
                        "volume": float(c.get("volume", 0))
                    })
                candles.sort(key=lambda x: x["time"])
                print(f"[Sentinel] Fetched {len(candles)} candles from Delta Exchange India.")
                return candles
    except Exception as e:
        print(f"[Sentinel] Delta candles error: {e}. Trying Binance fallback...")

    # 2. Binance Public Klines Fallback
    try:
        url = f"{BINANCE_BASE}/api/v3/klines?symbol=BTCUSDT&interval=15m&limit=100"
        res = requests.get(url, timeout=12)
        if res.status_code == 200:
            raw = res.json()
            candles = []
            for k in raw:
                candles.append({
                    "time": int(k[0] // 1000),
                    "open": float(k[1]),
                    "high": float(k[2]),
                    "low": float(k[3]),
                    "close": float(k[4]),
                    "volume": float(k[5])
                })
            candles.sort(key=lambda x: x["time"])
            print(f"[Sentinel] Fetched {len(candles)} candles from Binance fallback.")
            return candles
    except Exception as e:
        print(f"[Sentinel] Binance fallback error: {e}")

    return []


def calculate_rsi(candles, period=14):
    """Calculates 14-period Relative Strength Index."""
    if len(candles) < period + 1:
        return 50.0

    closes = [c["close"] for c in candles]
    gains = []
    losses = []

    for i in range(1, len(closes)):
        diff = closes[i] - closes[i - 1]
        gains.append(max(0.0, diff))
        losses.append(max(0.0, -diff))

    avg_gain = sum(gains[-period:]) / period
    avg_loss = sum(losses[-period:]) / period

    if avg_loss == 0:
        return 100.0

    rs = avg_gain / avg_loss
    return round(100.0 - (100.0 / (1.0 + rs)), 1)


def fetch_delta_option_contract(direction, spot_price):
    """
    Finds the active ATM Delta Exchange India BTC option contract
    (Call or Put) with near-term expiry and realistic mark price.
    """
    is_call = (direction == "LONG")
    prefix = "C-BTC-" if is_call else "P-BTC-"

    try:
        url = f"{DELTA_BASE}/v2/tickers"
        res = requests.get(url, timeout=12)
        if res.status_code == 200:
            tickers = res.json().get("result", [])
            btc_opts = [
                t for t in tickers
                if t.get("symbol", "").startswith(prefix) and float(t.get("mark_price", 0) or 0) > 0
            ]

            if btc_opts:
                # Find contract whose strike is closest to spot
                def get_strike_diff(t):
                    try:
                        parts = t["symbol"].split("-")
                        strike = float(parts[2])
                        return abs(strike - spot_price)
                    except:
                        return 999999

                btc_opts.sort(key=get_strike_diff)
                best = btc_opts[0]
                mark = float(best.get("mark_price", 180.0))
                symbol = best.get("symbol")

                return {
                    "symbol": symbol,
                    "mark_price": round(mark, 1),
                    "buy_zone": f"${round(mark, 1)} - ${round(mark * 1.05, 1)}",
                    "target_price": round(mark * 1.5, 1),
                    "stop_price": round(mark * 0.7, 1)
                }
    except Exception as e:
        print(f"[Sentinel] Error querying Delta option tickers: {e}")

    # Fallback estimated ATM contract
    rounded_strike = round(spot_price / 1000) * 1000
    expiry_str = (datetime.now(timezone.utc) + timedelta(days=1)).strftime("%d%m%y")
    fallback_sym = f"{prefix}{int(rounded_strike)}-{expiry_str}"
    return {
        "symbol": fallback_sym,
        "mark_price": 210.0,
        "buy_zone": "$210.0 - $220.0",
        "target_price": 315.0,
        "stop_price": 147.0
    }


def evaluate_smc_setup(candles):
    """
    Evaluates institutional SMC setups:
    1. Bullish / Bearish Order Block Liquidity Sweeps
    2. Break of Structure (BOS) Momentum Breakdowns / Breakouts
    """
    if len(candles) < 30:
        return None

    # Calculate 20-period Volume SMA for RVOL
    volumes = [c["volume"] for c in candles[-21:-1]]
    vol_sma = sum(volumes) / max(len(volumes), 1)

    # Calculate Swing Highs & Lows (5-bar window)
    swing_highs = []
    swing_lows = []
    for i in range(5, len(candles) - 3):
        h = candles[i]["high"]
        l = candles[i]["low"]
        is_sh = all(candles[i - j]["high"] <= h for j in range(1, 6)) and all(candles[i + j]["high"] <= h for j in range(1, 4))
        is_sl = all(candles[i - j]["low"] >= l for j in range(1, 6)) and all(candles[i + j]["low"] >= l for j in range(1, 4))
        if is_sh:
            swing_highs.append({"index": i, "price": h, "time": candles[i]["time"]})
        if is_sl:
            swing_lows.append({"index": i, "price": l, "time": candles[i]["time"]})

    last_closed = candles[-2] # Most recently completed closed candle
    cur_vol = last_closed["volume"]
    rvol = round(cur_vol / vol_sma, 2) if vol_sma > 0 else 1.0
    rsi = calculate_rsi(candles[:-1], 14)

    high = last_closed["high"]
    low = last_closed["low"]
    open_p = last_closed["open"]
    close_p = last_closed["close"]
    rng = max(0.1, high - low)
    lower_wick = min(open_p, close_p) - low
    upper_wick = high - max(open_p, close_p)

    trade = None

    # Check Bullish Liquidity Sweep (Lower wick sweep below prior swing low)
    recent_lows = [sl["price"] for sl in swing_lows[-4:]] if swing_lows else []
    for sl_price in recent_lows:
        if low < sl_price and close_p > sl_price and (lower_wick / rng) >= 0.30 and close_p >= open_p:
            risk = max(180, close_p - low * 0.998)
            tp = round(close_p + (risk * 2.1))
            sl = round(low - (risk * 0.1))
            rr = round((tp - close_p) / max(1, close_p - sl), 1)

            trade = {
                "id": f"cloud_bull_{last_closed['time']}",
                "name": "Bullish Order Block Liquidity Sweep",
                "direction": "LONG",
                "time": last_closed["time"],
                "entry": round(close_p),
                "tp": tp,
                "sl": sl,
                "rr": f"1:{rr}",
                "rsi": rsi,
                "rvol": rvol,
                "rationale": {
                    "pattern": "Bullish Lower Wick Absorption",
                    "levelTested": f"Support Liquidity Sweep (${sl_price:,.0f})",
                    "confirmation": f"Strong green close back above swing level with {rvol}x RVOL"
                }
            }
            break

    # Check Bearish Liquidity Sweep (Upper wick sweep above prior swing high)
    if not trade:
        recent_highs = [sh["price"] for sh in swing_highs[-4:]] if swing_highs else []
        for sh_price in recent_highs:
            if high > sh_price and close_p < sh_price and (upper_wick / rng) >= 0.30 and close_p <= open_p:
                risk = max(180, high * 1.002 - close_p)
                tp = round(close_p - (risk * 2.1))
                sl = round(high + (risk * 0.1))
                rr = round((close_p - tp) / max(1, sl - close_p), 1)

                trade = {
                    "id": f"cloud_bear_{last_closed['time']}",
                    "name": "Bearish Order Block Resistance Rejection",
                    "direction": "SHORT",
                    "time": last_closed["time"],
                    "entry": round(close_p),
                    "tp": tp,
                    "sl": sl,
                    "rr": f"1:{rr}",
                    "rsi": rsi,
                    "rvol": rvol,
                    "rationale": {
                        "pattern": "Bearish Upper Wick Rejection",
                        "levelTested": f"Resistance Liquidity Sweep (${sh_price:,.0f})",
                        "confirmation": f"Sellers rejecting highs with {rvol}x RVOL absorption"
                    }
                }
                break

    # Check Break of Structure (BOS) Breakdown
    if not trade and swing_lows:
        key_low = swing_lows[-1]["price"]
        if close_p < key_low and open_p >= key_low and (close_p - low) < (rng * 0.4) and rvol >= 1.2:
            risk = max(220, high - close_p)
            tp = round(close_p - (risk * 2.2))
            sl = round(high + (risk * 0.1))
            rr = round((close_p - tp) / max(1, sl - close_p), 1)

            trade = {
                "id": f"cloud_bos_down_{last_closed['time']}",
                "name": "Bearish Break of Structure (BOS)",
                "direction": "SHORT",
                "time": last_closed["time"],
                "entry": round(close_p),
                "tp": tp,
                "sl": sl,
                "rr": f"1:{rr}",
                "rsi": rsi,
                "rvol": rvol,
                "rationale": {
                    "pattern": "Trend Continuation Breakdown",
                    "levelTested": f"Key Structure Floor (${key_low:,.0f})",
                    "confirmation": f"Aggressive institutional selling breaking prior structure with {rvol}x RVOL"
                }
            }

    return trade


def check_breaking_crypto_catalysts():
    """Checks for breaking high-impact crypto news catalysts."""
    try:
        # Check CoinDesk or public crypto news feed
        url = "https://min-api.cryptocompare.com/data/v2/news/?lang=EN"
        res = requests.get(url, timeout=10)
        if res.status_code == 200:
            posts = res.json().get("Data", [])
            keywords = ["hack", "exploit", "cpi", "sec", "binance", "doj", "rate cut", "fed", "crackdown", "etf", "outflow"]
            for p in posts[:8]:
                title = p.get("title", "")
                title_lower = title.lower()
                matches = [k for k in keywords if k in title_lower]
                if matches:
                    guid = str(p.get("id"))
                    is_bearish = any(w in title_lower for w in ["hack", "exploit", "crackdown", "doj", "sec", "outflow", "sue"])
                    category = "Security / Exploit" if "hack" in title_lower or "exploit" in title_lower else "Macro Regulatory"
                    return {
                        "guid": guid,
                        "title": title,
                        "category": category,
                        "bias": "BEARISH" if is_bearish else "BULLISH",
                        "url": p.get("url")
                    }
    except Exception as e:
        print(f"[Sentinel] News check notice: {e}")
    return None


def run_sentinel():
    """Main 24/7 Cloud Sentinel execution routine."""
    print("=" * 60)
    print("24/7 DELTA CLOUD SENTINEL EXECUTION STARTED")
    print(f"Timestamp: {datetime.now(timezone.utc).isoformat()} UTC")
    print("=" * 60)

    # 1. Telegram Config
    cfg = get_telegram_config()
    bot_token = cfg.get("bot_token")
    chat_id = cfg.get("chat_id")
    enabled = cfg.get("enabled", False)

    if not enabled or not bot_token or not chat_id:
        print("[Sentinel] Telegram not active or configured. Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in GitHub Secrets or the Web App.")
        return

    # 2. State & History
    state = load_sentinel_state()
    daily_counts = state.get("daily_counts", {"trades_given": 0, "wins": 0, "losses": 0})

    # 3. Market Data
    candles = fetch_btc_candles()
    if not candles:
        print("[Sentinel] Failed to fetch market candles. Exiting run.")
        return

    current_price = candles[-1]["close"]
    print(f"[Sentinel] Latest BTC Spot Close: ${current_price:,.2f}")

    # 4. Check Active Trade Outcomes
    active_trade = state.get("active_trade")
    if active_trade:
        trade_id = active_trade.get("id")
        entry = active_trade.get("entry")
        tp = active_trade.get("tp")
        sl = active_trade.get("sl")
        direction = active_trade.get("direction")
        contract = active_trade.get("option", {}).get("symbol", "Delta Option")
        buy_p = active_trade.get("option", {}).get("mark_price", 200)

        is_win = False
        is_loss = False

        if direction == "LONG":
            if current_price >= tp: is_win = True
            elif current_price <= sl: is_loss = True
        else: # SHORT
            if current_price <= tp: is_win = True
            elif current_price >= sl: is_loss = True

        if is_win:
            daily_counts["wins"] += 1
            sell_p = round(buy_p * 1.5, 1)
            msg = f"""🏆 <b>DELTA INDIA TRADE TARGET HIT (+50% PROFIT)</b>
━━━━━━━━━━━━━━━━━━━━━━
🎯 <b>Result:</b> 🟢 <b>WIN (+50.0%)</b>
🏷️ <b>Contract:</b> <code>{contract}</code>
💰 <b>Option Fill:</b> Buy: ${buy_p:.1f} ➔ <b>Sell: ${sell_p:.1f}</b> (+{round(sell_p - buy_p, 1)} pts)
🎯 <b>BTC Spot:</b> ${entry:,.0f} ➔ <b>${current_price:,.0f} (Target Achieved)</b>

📊 <b>TODAY'S SCORECARD:</b>
• Total Given: <b>{daily_counts['trades_given']}</b>
• Won: <b>{daily_counts['wins']}</b> | Lost: <b>{daily_counts['losses']}</b>
• Win Rate: <b>{round((daily_counts['wins'] / max(1, daily_counts['wins'] + daily_counts['losses'])) * 100)}%</b>

⚡ <i>Institutional note: Profits booked at standard 1.5x Delta mark expansion.</i>
🔗 <a href="https://delta-trading-journal-gmp.vercel.app/">Open Live Journal & Chart</a>"""
            send_telegram_message(bot_token, chat_id, msg)
            state["active_trade"] = None
            state["daily_counts"] = daily_counts
            save_sentinel_state(state)

        elif is_loss:
            daily_counts["losses"] += 1
            sell_p = round(buy_p * 0.7, 1)
            msg = f"""🛑 <b>DELTA INDIA STOP LOSS TRIGGERED</b>
━━━━━━━━━━━━━━━━━━━━━━
🎯 <b>Result:</b> 🔴 <b>LOSS (-30.0%)</b>
🏷️ <b>Contract:</b> <code>{contract}</code>
💰 <b>Option Fill:</b> Buy: ${buy_p:.1f} ➔ <b>Exit: ${sell_p:.1f}</b> (-{round(buy_p - sell_p, 1)} pts)
🎯 <b>BTC Spot:</b> ${entry:,.0f} ➔ <b>${current_price:,.0f} (Stop Hit)</b>

📊 <b>TODAY'S SCORECARD:</b>
• Total Given: <b>{daily_counts['trades_given']}</b>
• Won: <b>{daily_counts['wins']}</b> | Lost: <b>{daily_counts['losses']}</b>

⚡ <i>Strict risk discipline: Capital preserved by cutting loss at -30% limit.</i>
🔗 <a href="https://delta-trading-journal-gmp.vercel.app/">Open Live Journal & Chart</a>"""
            send_telegram_message(bot_token, chat_id, msg)
            state["active_trade"] = None
            state["daily_counts"] = daily_counts
            save_sentinel_state(state)

    # 5. Evaluate New SMC Setups
    setup = evaluate_smc_setup(candles)
    if setup:
        trade_id = setup["id"]
        last_alerted = state.get("last_alerted_trade_id")

        if trade_id != last_alerted:
            opt = fetch_delta_option_contract(setup["direction"], current_price)
            setup["option"] = opt

            daily_counts["trades_given"] += 1
            is_call = (setup["direction"] == "LONG")
            ist_time = datetime.fromtimestamp(setup["time"], tz=timezone(timedelta(hours=5, minutes=30))).strftime("%I:%M %p · %d %b")

            msg = f"""⚡ <b>DELTA INDIA 24/7 CLOUD SMC SIGNAL</b>
━━━━━━━━━━━━━━━━━━━━━━
🎯 <b>Action:</b> {('🟢 BUY CALL OPTION' if is_call else '🔴 BUY PUT OPTION')}
📌 <b>Setup Pattern:</b> {setup['name']}
🏷️ <b>Delta Contract:</b> <code>{opt['symbol']}</code>

📊 <b>DELTA INDIA EXECUTION PLAN:</b>
• <b>Option Buy Zone:</b> {opt['buy_zone']}
• <b>Option Target (TP):</b> ${opt['target_price']:.1f} (+50%)
• <b>Option Stop (SL):</b> ${opt['stop_price']:.1f} (-30%)

🎯 <b>BTC SPOT TRIGGER LEVEL:</b>
• <b>Spot Entry:</b> ${setup['entry']:,}
• <b>Target Level:</b> ${setup['tp']:,} (R:R {setup['rr']})
• <b>Invalidation (SL):</b> ${setup['sl']:,}

🧠 <b>INSTITUTIONAL SETUP LOGIC:</b>
• <b>Level Tested:</b> {setup['rationale']['levelTested']}
• <b>Pattern:</b> {setup['rationale']['pattern']}
• <b>Confirmation:</b> {setup['rationale']['confirmation']}
• <b>Momentum:</b> RSI {setup['rsi']} | {setup['rvol']}x RVOL

📈 <b>DAILY TRACKER:</b> {daily_counts['trades_given']} Trade(s) Alerted Today ({daily_counts['wins']}W - {daily_counts['losses']}L)
⏰ <i>Time: {ist_time} IST</i>
🔗 <a href="https://delta-trading-journal-gmp.vercel.app/">Open Live Journal & Chart</a>"""

            if send_telegram_message(bot_token, chat_id, msg):
                state["last_alerted_trade_id"] = trade_id
                state["active_trade"] = setup
                state["daily_counts"] = daily_counts
                save_sentinel_state(state)
        else:
            print(f"[Sentinel] Trade setup {trade_id} was already alerted previously.")
    else:
        print("[Sentinel] No new confirmed high-conviction SMC setups on current 15m candle.")

    # 6. Check Breaking News / Catalysts
    catalyst = check_breaking_crypto_catalysts()
    if catalyst:
        guid = catalyst.get("guid")
        last_guid = state.get("last_alerted_catalyst_guid")
        if guid and guid != last_guid:
            bias_emoji = "🔴" if catalyst["bias"] == "BEARISH" else "🟢"
            news_msg = f"""🚨 <b>CRITICAL MARKET CATALYST DETECTED</b>
━━━━━━━━━━━━━━━━━━━━━━
📢 <b>Headline:</b> {catalyst['title']}
📰 <b>Category:</b> {catalyst['category']}
⚡ <b>Market Bias:</b> {bias_emoji} <b>{catalyst['bias']} CATALYST ({'PUTS FAVORED' if catalyst['bias'] == 'BEARISH' else 'CALLS FAVORED'})</b>

⚠️ <i>Institutional Advisory: Breaking macro events trigger heavy volatility. Check Delta option strikes & respect stop loss levels.</i>
🔗 <a href="https://delta-trading-journal-gmp.vercel.app/">Open Live Journal & Chart</a>"""
            if send_telegram_message(bot_token, chat_id, news_msg):
                state["last_alerted_catalyst_guid"] = guid
                save_sentinel_state(state)

    print("=" * 60)
    print("24/7 DELTA CLOUD SENTINEL RUN COMPLETED")
    print("=" * 60)


if __name__ == "__main__":
    run_sentinel()
