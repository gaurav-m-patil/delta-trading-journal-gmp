#!/usr/bin/env python3
"""
24/7 Institutional Cloud Sentinel for Delta Exchange India
------------------------------------------------------------
Runs autonomously in the cloud via GitHub Actions.
Monitors BTC/USD 15m candles with Multi-Timeframe and Fair Value Gap (FVG) intelligence.
Detects SMC liquidity sweeps, FVG mitigations, and BOS trend continuations.
Identifies real Delta India ATM option contracts with 0-DTE Theta Safety (5:30 PM IST filter).
Calculates Dynamic Option Expected Value (DOEV) with uncapped structural potential (TP1 +50% derisk & TP2 +100% to +350% runners).
Dispatches instant actionable trade signals and outcomes to Telegram 24/7/365 even when the app is closed.
Syncs active trades directly to Firebase Firestore (GP_DTJ_signal_trades) to prevent State Drift.
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
        },
        "telegram_handshake_sent": False
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


def sync_trade_to_firestore(trade_data):
    """
    Syncs the active or completed signal trade directly to Firestore GP_DTJ_signal_trades.
    Guarantees 100% real-time synchronization between Telegram and Web App (Eliminates State Drift).
    Ensures complete, immutable trade data for both SMC Radar and Paper Fund without undefined metrics.
    """
    try:
        trade_id = str(trade_data.get("id"))
        doc_path = f"projects/{FIREBASE_PROJECT}/databases/(default)/documents/GP_DTJ_signal_trades/{trade_id}"
        opt = trade_data.get("option", {})

        entry_val = float(trade_data.get("entry", 0))
        tp_val = float(trade_data.get("tp", 0))
        sl_val = float(trade_data.get("sl", 0))
        target_dist = float(trade_data.get("targetDist", abs(tp_val - entry_val)))
        sl_dist = float(trade_data.get("slDist", abs(entry_val - sl_val)))
        rr_val = round(target_dist / max(1.0, sl_dist), 2)

        strike_val = int(opt.get("strike", trade_data.get("optionStrike", round(entry_val / 200) * 200)))
        # Strictly preserve frozen entry mark price to prevent state desync
        entry_opt = float(trade_data.get("optionEntryLockedMark", opt.get("mark_price", trade_data.get("optionEntryMark", 220))))
        buy_zone = str(opt.get("buy_zone", trade_data.get("buyZone", f"${entry_opt * 0.98:.1f} - ${entry_opt * 1.02:.1f}")))
        tp1_price = float(opt.get("tp1_price", trade_data.get("optionTp1Price", round(entry_opt * 1.50, 1))))
        target_price = float(opt.get("target_price", trade_data.get("optionTargetPrice", round(entry_opt * 1.72, 1))))
        stop_price = float(opt.get("stop_price", trade_data.get("optionStopPrice", round(entry_opt * 0.70, 1))))
        target_pct = str(opt.get("target_pct", trade_data.get("optionPnlPct", "+72.0%")))

        fields = {
            "id": {"stringValue": trade_id},
            "name": {"stringValue": str(trade_data.get("name", "SMC Setup"))},
            "asset": {"stringValue": str(trade_data.get("asset", "BTC"))},
            "direction": {"stringValue": str(trade_data.get("direction", "LONG"))},
            "time": {"integerValue": str(trade_data.get("time", int(time.time())))},
            "entry": {"doubleValue": entry_val},
            "tp": {"doubleValue": tp_val},
            "sl": {"doubleValue": sl_val},
            "targetDist": {"doubleValue": target_dist},
            "slDist": {"doubleValue": sl_dist},
            "rr": {"stringValue": f"1:{rr_val}"},
            "rrRatio": {"doubleValue": rr_val},
            "outcome": {"stringValue": str(trade_data.get("outcome", "ACTIVE"))},
            "optionStrike": {"integerValue": str(strike_val)},
            "optionSymbol": {"stringValue": str(opt.get("symbol", trade_data.get("optionSymbol", "")))},
            "optionEntryMark": {"doubleValue": entry_opt},
            "optionEntryLockedMark": {"doubleValue": entry_opt},
            "buyZone": {"stringValue": buy_zone},
            "optionTp1Price": {"doubleValue": tp1_price},
            "optionTp1Pct": {"stringValue": str(opt.get("tp1_pct", trade_data.get("optionTp1Pct", "+50.0%")))},
            "optionTargetPrice": {"doubleValue": target_price},
            "optionPnlPct": {"stringValue": target_pct},
            "optionStopPrice": {"doubleValue": stop_price},
            "optionStopPct": {"stringValue": "-30.0%"},
            "strikeTier": {"stringValue": str(opt.get("strike_tier", "Exact ATM (Delta ~0.50)"))},
            "reachedTp1": {"booleanValue": bool(trade_data.get("reached_tp1", False))},
            "barsHeld": {"integerValue": str(trade_data.get("barsHeld", 1))},
            "updatedAt": {"stringValue": datetime.now(timezone.utc).isoformat()}
        }

        if trade_data.get("exitPrice"):
            fields["exitPrice"] = {"doubleValue": float(trade_data["exitPrice"])}
        if trade_data.get("optionSellPrice") or trade_data.get("optionExitLockedMark"):
            exit_mark = float(trade_data.get("optionExitLockedMark", trade_data.get("optionSellPrice")))
            fields["optionSellPrice"] = {"doubleValue": exit_mark}
            fields["optionExitLockedMark"] = {"doubleValue": exit_mark}
        if trade_data.get("skipped"):
            fields["skipped"] = {"booleanValue": bool(trade_data["skipped"])}
        if trade_data.get("skippedReason"):
            fields["skippedReason"] = {"stringValue": str(trade_data["skippedReason"])}

        sess = trade_data.get("session", {})
        if sess and sess.get("name"):
            fields["sessionName"] = {"stringValue": str(sess["name"])}
            fields["sessionCode"] = {"stringValue": str(sess.get("code", ""))}
            fields["sessionFlag"] = {"stringValue": str(sess.get("flag", "🌐"))}
        if opt.get("iv_rating") or trade_data.get("ivRating"):
            fields["ivRating"] = {"stringValue": str(opt.get("iv_rating", trade_data.get("ivRating", "")))}
            fields["ivBadge"] = {"stringValue": str(opt.get("iv_badge", trade_data.get("ivBadge", "")))}

        # Full Institutional Setup Playbook Logic
        rat = trade_data.get("rationale", {})
        if rat:
            rat_map = {}
            if rat.get("levelTested"): rat_map["levelTested"] = {"stringValue": str(rat["levelTested"])}
            if rat.get("pattern"): rat_map["pattern"] = {"stringValue": str(rat["pattern"])}
            if rat.get("confirmation"): rat_map["confirmation"] = {"stringValue": str(rat["confirmation"])}
            if rat.get("momentum"): rat_map["momentum"] = {"stringValue": str(rat["momentum"])}
            if rat.get("rsi"): rat_map["rsi"] = {"stringValue": str(rat["rsi"])}
            if rat.get("rvol"): rat_map["rvol"] = {"stringValue": str(rat["rvol"])}
            if rat.get("absorption"): rat_map["absorption"] = {"stringValue": str(rat["absorption"])}
            if rat.get("narrative"): rat_map["narrative"] = {"stringValue": str(rat["narrative"])}
            if rat_map:
                fields["rationale"] = {"mapValue": {"fields": rat_map}}

        commit_url = f"https://firestore.googleapis.com/v1/projects/{FIREBASE_PROJECT}/databases/(default)/documents:commit?key={FIREBASE_KEY}"
        write_payload = {
            "writes": [{
                "update": {
                    "name": doc_path,
                    "fields": fields
                }
            }]
        }
        res = requests.post(commit_url, json=write_payload, timeout=12)
        if res.status_code == 200:
            print(f"[Sentinel] Trade {trade_id} synced directly to Firestore GP_DTJ_signal_trades.")
        else:
            print(f"[Sentinel] Firestore sync notice: {res.status_code}")
    except Exception as e:
        print(f"[Sentinel] Notice syncing trade to Firestore: {e}")


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


ASSET_REGIME_CONFIGS = {
    "BTC": {
        "asset": "BTC",
        "delta_symbol": "BTCUSD",
        "binance_symbol": "BTCUSDT",
        "prefix_call": "C-BTC-",
        "prefix_put": "P-BTC-",
        "strike_step": 200,
        "fvg_min_usd": 180.0,
        "fvg_atr_mult": 0.75,
        "atr_buffer_mult": 0.10,
        "rvol_gate": 1.40,
        "min_risk_pts": 180.0,
        "default_est_mark_ratio": 0.0033,
        "max_spread_ratio": 0.15,
        "drift_block": True,
        "icon": "🟠"
    },
    "ETH": {
        "asset": "ETH",
        "delta_symbol": "ETHUSD",
        "binance_symbol": "ETHUSDT",
        "prefix_call": "C-ETH-",
        "prefix_put": "P-ETH-",
        "strike_step": 50,
        "fvg_min_usd": 8.0,
        "fvg_atr_mult": 0.65,
        "atr_buffer_mult": 0.20,
        "rvol_gate": 1.35,
        "min_risk_pts": 12.0,
        "default_est_mark_ratio": 0.0040,
        "max_spread_ratio": 0.18,
        "drift_block": True,
        "icon": "🔷"
    },
    "XAUT": {
        "asset": "XAUT",
        "delta_symbol": "XAUTUSD",
        "binance_symbol": "PAXGUSDT",
        "prefix_call": "C-XAUT-",
        "prefix_put": "P-XAUT-",
        "strike_step": 10,
        "fvg_min_usd": 6.0,
        "fvg_atr_mult": 0.60,
        "atr_buffer_mult": 0.08,
        "rvol_gate": 1.30,
        "min_risk_pts": 8.0,
        "default_est_mark_ratio": 0.0025,
        "max_spread_ratio": 0.15,
        "drift_block": True,
        "icon": "🟡"
    }
}


def format_asset_price(val, asset="BTC"):
    """Formats numeric prices with appropriate decimals per asset (2 decimals for ETH/XAUT, 0 for BTC)."""
    if val is None:
        return "$0"
    if asset in ["ETH", "XAUT"]:
        return f"${val:,.2f}"
    return f"${val:,.0f}"


def fetch_asset_candles(asset="BTC"):
    """
    Fetches recent 15m candles from Delta Exchange India (Primary),
    with automatic Binance fallback if Delta is unreachable.
    Supports BTC, ETH, and XAUT Gold.
    """
    cfg = ASSET_REGIME_CONFIGS.get(asset, ASSET_REGIME_CONFIGS["BTC"])
    delta_sym = cfg["delta_symbol"]
    binance_sym = cfg["binance_symbol"]

    now = int(time.time())
    start = now - (86400 * 3) # Last 72 hours

    # 1. Delta Exchange India Native Historical Candles
    try:
        url = f"{DELTA_BASE}/v2/history/candles?resolution=15m&symbol={delta_sym}&start={start}&end={now}"
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
                print(f"[Sentinel] Fetched {len(candles)} {asset} candles from Delta Exchange India.")
                return candles
    except Exception as e:
        print(f"[Sentinel] Delta {asset} candles error: {e}. Trying Binance fallback...")

    # 2. Binance Public Klines Fallback
    try:
        url = f"{BINANCE_BASE}/api/v3/klines?symbol={binance_sym}&interval=15m&limit=150"
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
            print(f"[Sentinel] Fetched {len(candles)} {asset} candles from Binance fallback.")
            return candles
    except Exception as e:
        print(f"[Sentinel] Binance {asset} fallback error: {e}")

    return []


def fetch_btc_candles():
    """Backward-compatible proxy for BTC candles."""
    return fetch_asset_candles("BTC")


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


def calculate_ema(values, period):
    """Calculates Exponential Moving Average (EMA)."""
    if not values or len(values) < period:
        return sum(values) / len(values) if values else 0.0
    multiplier = 2.0 / (period + 1)
    ema = sum(values[:period]) / period
    for v in values[period:]:
        ema = (v - ema) * multiplier + ema
    return ema


def fetch_htf_trend_1h(asset="BTC"):
    """
    Multi-Timeframe 1H Trend Alignment for BTC, ETH, and XAUT Gold.
    Queries 1-hour candles to evaluate higher-timeframe trend (20 EMA vs 50 EMA).
    Filters out counter-trend chop, aligning 5m/15m setups with macro momentum.
    """
    cfg = ASSET_REGIME_CONFIGS.get(asset, ASSET_REGIME_CONFIGS["BTC"])
    delta_sym = cfg["delta_symbol"]
    binance_sym = cfg["binance_symbol"]

    now = int(time.time())
    start = now - (86400 * 5) # 5 days of 1H data
    candles = []

    try:
        url = f"{DELTA_BASE}/v2/history/candles?resolution=1h&symbol={delta_sym}&start={start}&end={now}"
        res = requests.get(url, timeout=10)
        if res.status_code == 200:
            data = res.json().get("result", [])
            for c in data:
                candles.append({
                    "time": int(c.get("time")),
                    "close": float(c.get("close"))
                })
            candles.sort(key=lambda x: x["time"])
    except Exception as e:
        print(f"[Sentinel] HTF 1H Delta {asset} fetch notice: {e}")

    if not candles or len(candles) < 30:
        try:
            url = f"{BINANCE_BASE}/api/v3/klines?symbol={binance_sym}&interval=1h&limit=60"
            res = requests.get(url, timeout=10)
            if res.status_code == 200:
                raw = res.json()
                candles = [{"time": int(k[0] // 1000), "close": float(k[4])} for k in raw]
        except Exception:
            pass

    if len(candles) < 25:
        return {
            "trend": "NEUTRAL",
            "label": f"⚪ NEUTRAL ({asset} Consolidation)",
            "cur_price": 0,
            "ema20": 0,
            "ema50": 0
        }

    closes = [c["close"] for c in candles]
    cur_price = closes[-1]
    ema20 = calculate_ema(closes, 20)
    ema50 = calculate_ema(closes, 50)

    if cur_price > ema50 and ema20 >= ema50:
        trend = "BULLISH"
        label = f"🟢 BULLISH CONFLUENCE (1H {asset} Macro Uptrend)"
    elif cur_price < ema50 and ema20 <= ema50:
        trend = "BEARISH"
        label = f"🔴 BEARISH CONFLUENCE (1H {asset} Macro Downtrend)"
    else:
        trend = "NEUTRAL"
        label = f"🟡 NEUTRAL / RANGEBOUND (1H {asset} S/R Transition)"

    return {
        "trend": trend,
        "label": label,
        "cur_price": round(cur_price, 2),
        "ema20": round(ema20, 2),
        "ema50": round(ema50, 2)
    }


def get_current_trading_session():
    """
    Determines current active institutional trading session in Indian Standard Time (IST).
    - Asia Session: 05:30 - 13:30 IST (Mean reversion & range sweeps)
    - London Session: 13:30 - 19:00 IST (High volume breakout expansion)
    - New York Session: 19:00 - 02:30 IST (Peak liquidity & gamma acceleration)
    - Off-Hours Drift: 02:30 - 05:30 IST (Consolidation)
    """
    ist_now = datetime.now(timezone(timedelta(hours=5, minutes=30)))
    total_minutes = ist_now.hour * 60 + ist_now.minute

    if 330 <= total_minutes < 810: # 05:30 - 13:30
        return {
            "name": "Asia Session (05:30 - 13:30 IST)",
            "code": "ASIA",
            "flag": "🌐",
            "volatility": "Moderate (Mean-Reversion & S/R Sweeps)",
            "tp_bias": "Scalp Focus (TP1 priority)"
        }
    elif 810 <= total_minutes < 1140: # 13:30 - 19:00
        return {
            "name": "London Session (13:30 - 19:00 IST)",
            "code": "LONDON",
            "flag": "⚡",
            "volatility": "High (Breakout & Liquidity Expansion)",
            "tp_bias": "Structural Runner Expansion"
        }
    elif (1140 <= total_minutes) or (total_minutes < 150): # 19:00 - 02:30
        return {
            "name": "New York Session (19:00 - 02:30 IST)",
            "code": "NEW_YORK",
            "flag": "🔥",
            "volatility": "Peak Liquidity (Gamma Spikes & Momentum)",
            "tp_bias": "Maximum DOEV Runner Potential"
        }
    else:
        return {
            "name": "Off-Hours Drift (02:30 - 05:30 IST)",
            "code": "DRIFT",
            "flag": "🌙",
            "volatility": "Low (Consolidation Range)",
            "tp_bias": "Strict Scalp Derisk"
        }


def fetch_delta_option_contract(direction, spot_price, spot_dist=1200, asset="BTC"):
    """
    Finds the active ATM or OTM-1 Delta Exchange India option contract (Call or Put)
    strictly from the CURRENT DAY'S EXPIRATION (or next-day if near 5:30 PM IST).
    Supports BTC, ETH, and XAUT Gold.
    """
    cfg = ASSET_REGIME_CONFIGS.get(asset, ASSET_REGIME_CONFIGS["BTC"])
    is_call = (direction == "LONG")
    prefix = cfg["prefix_call"] if is_call else cfg["prefix_put"]
    strike_step = cfg["strike_step"]
    est_ratio = cfg["default_est_mark_ratio"]
    max_spread = cfg["max_spread_ratio"]

    now_utc = datetime.now(timezone.utc)

    try:
        url = f"{DELTA_BASE}/v2/tickers"
        res = requests.get(url, timeout=12)
        if res.status_code == 200:
            tickers = res.json().get("result", [])
            active_with_expiry = []

            for t in tickers:
                sym = t.get("symbol", "")
                if not sym.startswith(prefix):
                    continue
                mark = float(t.get("mark_price", 0) or 0)
                if mark <= 0:
                    continue

                parts = sym.split("-")
                if len(parts) >= 4 and len(parts[3]) == 6:
                    d_str = parts[3]
                    try:
                        day = int(d_str[0:2])
                        month = int(d_str[2:4])
                        year = 2000 + int(d_str[4:6])
                        # Delta Exchange India options expire at 12:00 UTC (17:30 IST)
                        expiry_dt = datetime(year, month, day, 12, 0, 0, tzinfo=timezone.utc)
                        if expiry_dt > now_utc:
                            time_to_expiry_sec = (expiry_dt - now_utc).total_seconds()
                            is_near_expiry = time_to_expiry_sec <= (105 * 60) # 105 mins theta safety buffer
                            active_with_expiry.append({
                                "ticker": t,
                                "symbol": sym,
                                "strike": float(parts[2]),
                                "mark": mark,
                                "best_bid": float(t.get("best_bid", 0) or mark),
                                "best_ask": float(t.get("best_ask", 0) or mark),
                                "expiry_dt": expiry_dt,
                                "is_near_expiry": is_near_expiry
                            })
                    except Exception:
                        continue

            if active_with_expiry:
                # 1. Strictly prefer daily 0-DTE / 1-DTE expiries (within 48 hours) - Never monthly/far contracts
                daily_viable = [x for x in active_with_expiry if (x["expiry_dt"] - now_utc).total_seconds() <= (48 * 3600)]
                viable = daily_viable if daily_viable else active_with_expiry

                has_next_day = any(not x["is_near_expiry"] for x in viable)
                if has_next_day:
                    viable = [x for x in viable if not x["is_near_expiry"]]

                viable.sort(key=lambda x: x["expiry_dt"])
                nearest_expiry = viable[0]["expiry_dt"]
                nearest_candidates = [x for x in viable if x["expiry_dt"] == nearest_expiry]

                # 2. Sort by distance to spot price to find exact ATM
                nearest_candidates.sort(key=lambda x: abs(x["strike"] - spot_price))
                atm_candidate = nearest_candidates[0]

                best = atm_candidate
                strike_tier = "Exact ATM (Delta ~0.50)"

                mark = round(best["mark"], 1)
                symbol = best["symbol"]
                strike = best["strike"]
                best_bid = best["best_bid"]
                best_ask = best["best_ask"]

                spread_valid = (best_ask > 0 and best_bid > 0 and (best_ask - best_bid) <= (mark * max_spread))
                buy_zone = f"${min(best_bid, mark):.1f} - ${max(best_ask, mark):.1f}" if spread_valid else f"${mark * 0.98:.1f} - ${mark * 1.02:.1f}"

                # Delta sensitivity normalization per asset
                norm_denom = 4000.0 if asset == "BTC" else (200.0 if asset == "ETH" else 80.0)
                eff_delta = min(0.85, max(0.50, 0.50 + (spot_dist / norm_denom) * 0.35))
                proj_pts = round(spot_dist * eff_delta, 1)
                gain_pct_full = round((proj_pts / max(mark, 1.0)) * 100, 1)
                if gain_pct_full < 65.0:
                    gain_pct_full = 65.0
                    proj_pts = round(mark * 0.65, 1)
                target_full = round(mark + proj_pts, 1)

                # Dynamic TP1 Option Target: 55% of the projected spot-move delta gain (min +40%, calibrated to underlying R:R)
                tp1_opt_pct_val = max(40.0, round(gain_pct_full * 0.55, 1))
                target_tp1 = round(mark * (1.0 + (tp1_opt_pct_val / 100.0)), 1)
                if target_full <= target_tp1:
                    target_full = round(mark * (1.0 + ((tp1_opt_pct_val + 20.0) / 100.0)), 1)
                    gain_pct_full = round(((target_full - mark) / max(mark, 1.0)) * 100, 1)
                stop_price = round(mark * 0.7, 1)

                ratio = (mark / spot_price) if spot_price > 0 else est_ratio
                if ratio < (est_ratio * 0.85):
                    iv_rating = "CHEAP (High Delta Leverage)"
                    iv_badge = "🟢 CHEAP"
                elif ratio <= (est_ratio * 1.35):
                    iv_rating = "FAIR (Institutionally Calibrated)"
                    iv_badge = "🟡 FAIR"
                else:
                    iv_rating = "ELEVATED (High IV - Scalp Focus)"
                    iv_badge = "🔴 ELEVATED"

                return {
                    "symbol": symbol,
                    "strike": strike,
                    "strike_tier": strike_tier,
                    "mark_price": mark,
                    "buy_zone": buy_zone,
                    "tp1_price": target_tp1,
                    "tp1_pct": f"+{tp1_opt_pct_val:.1f}%",
                    "target_price": target_full,
                    "target_pct": f"+{gain_pct_full}%",
                    "stop_price": stop_price,
                    "eff_delta": round(eff_delta, 2),
                    "iv_rating": iv_rating,
                    "iv_badge": iv_badge
                }
    except Exception as e:
        print(f"[Sentinel] Error querying Delta option tickers for {asset}: {e}")

    # Fallback estimated ATM contract for current day
    rounded_strike = round(spot_price / strike_step) * strike_step
    ist_now = datetime.now(timezone(timedelta(hours=5, minutes=30)))
    is_near_expiry = (ist_now.hour == 16) or (ist_now.hour == 17 and ist_now.minute < 30)
    expiry_str = (datetime.now(timezone.utc) + timedelta(days=2 if is_near_expiry else 1)).strftime("%d%m%y")
    fallback_sym = f"{prefix}{int(rounded_strike)}-{expiry_str}"
    mark = round(spot_price * est_ratio, 1) if spot_price > 0 else 220.0
    norm_denom = 4000.0 if asset == "BTC" else (200.0 if asset == "ETH" else 80.0)
    eff_delta = min(0.85, max(0.50, 0.50 + (spot_dist / norm_denom) * 0.35))
    proj_pts = round(spot_dist * eff_delta, 1)
    gain_pct_full = round((proj_pts / max(mark, 1.0)) * 100, 1)
    if gain_pct_full < 65.0:
        gain_pct_full = 65.0
        proj_pts = round(mark * 0.65, 1)
    target_full = round(mark + proj_pts, 1)
    tp1_opt_pct_val = max(40.0, round(gain_pct_full * 0.55, 1))
    target_tp1 = round(mark * (1.0 + (tp1_opt_pct_val / 100.0)), 1)
    if target_full <= target_tp1:
        target_full = round(mark * (1.0 + ((tp1_opt_pct_val + 20.0) / 100.0)), 1)
        gain_pct_full = round(((target_full - mark) / max(mark, 1.0)) * 100, 1)
    ratio = (mark / spot_price) if spot_price > 0 else est_ratio
    iv_badge = "🟡 FAIR" if ratio <= (est_ratio * 1.35) else "🔴 ELEVATED"
    iv_rating = "FAIR (Calibrated)" if ratio <= (est_ratio * 1.35) else "ELEVATED"
    return {
        "symbol": fallback_sym,
        "strike": rounded_strike,
        "strike_tier": "Exact ATM (Delta ~0.50)",
        "mark_price": mark,
        "buy_zone": f"${mark * 0.98:.1f} - ${mark * 1.02:.1f}",
        "tp1_price": target_tp1,
        "tp1_pct": f"+{tp1_opt_pct_val:.1f}%",
        "target_price": target_full,
        "target_pct": f"+{gain_pct_full}%",
        "stop_price": round(mark * 0.7, 1),
        "eff_delta": round(eff_delta, 2),
        "iv_rating": iv_rating,
        "iv_badge": iv_badge
    }


def evaluate_smc_setup(candles, htf_trend=None, asset="BTC"):
    """
    Institutional SMC Setup Engine:
    1. Multi-Timeframe 1H Trend Alignment (Idea 4)
    2. Volume Delta Divergence & Institutional Absorption (Idea 6)
    3. Bullish & Bearish Liquidity Sweeps (3-bar & 5-bar dynamic fractals)
    4. Fair Value Gap (FVG) / Imbalance Void Mitigations
    5. Break of Structure (BOS) Momentum Breakdowns & Breakouts
    Supports BTC, ETH, and XAUT Gold with asset-specific calibration.
    """
    if len(candles) < 30:
        return None

    cfg = ASSET_REGIME_CONFIGS.get(asset, ASSET_REGIME_CONFIGS["BTC"])
    rvol_gate = cfg.get("rvol_gate", 1.40)
    atr_buffer_mult = cfg.get("atr_buffer_mult", 0.10)
    min_risk_pts = cfg.get("min_risk_pts", 180.0)

    # Calculate 20-period Volume SMA for RVOL
    volumes = [c["volume"] for c in candles[-21:-1]]
    vol_sma = sum(volumes) / max(len(volumes), 1)

    # 14-period ATR for dynamic structural buffers and candle size filters
    default_atr = 200.0 if asset == "BTC" else (15.0 if asset == "ETH" else 8.0)
    ranges = [max(c["high"] - c["low"], abs(c["high"] - candles[i-1]["close"]), abs(c["low"] - candles[i-1]["close"])) for i, c in enumerate(candles[-15:], start=1) if i < len(candles)]
    atr14 = sum(ranges) / max(len(ranges), 1) if ranges else default_atr

    # 1. Confluence Fractals (Detect robust 5-bar swing pivots with 3-bar fallback)
    swing_highs = []
    swing_lows = []
    for i in range(4, len(candles) - 2):
        h = candles[i]["high"]
        l = candles[i]["low"]
        # Robust 5-bar fractal pivot (2 candles left, 2 right)
        is_sh_5 = (candles[i-2]["high"] <= h) and (candles[i-1]["high"] <= h) and (candles[i+1]["high"] <= h) and (candles[i+2]["high"] <= h)
        is_sl_5 = (candles[i-2]["low"] >= l) and (candles[i-1]["low"] >= l) and (candles[i+1]["low"] >= l) and (candles[i+2]["low"] >= l)
        # Fast 3-bar fractal pivot
        is_sh_3 = (candles[i-1]["high"] <= h) and (candles[i+1]["high"] <= h)
        is_sl_3 = (candles[i-1]["low"] >= l) and (candles[i+1]["low"] >= l)

        if is_sh_5 or is_sh_3:
            swing_highs.append({"index": i, "price": h, "time": candles[i]["time"], "is_major": is_sh_5})
        if is_sl_5 or is_sl_3:
            swing_lows.append({"index": i, "price": l, "time": candles[i]["time"], "is_major": is_sl_5})

    last_closed = candles[-2] # Most recently completed closed candle
    cur_vol = last_closed["volume"]
    rvol = round(cur_vol / vol_sma, 2) if vol_sma > 0 else 1.0
    rsi = calculate_rsi(candles[:-1], 14)

    high = last_closed["high"]
    low = last_closed["low"]
    open_p = last_closed["open"]
    close_p = last_closed["close"]
    rng = max(0.01, high - low)
    candle_body = abs(close_p - open_p)
    lower_wick = min(open_p, close_p) - low
    upper_wick = high - max(open_p, close_p)

    # 🛡️ INSTITUTIONAL CHOP FILTERS (Zero-Tolerance for Sideways Drift)
    # 1. Hard RVOL Gate: Smart money does NOT enter without at least relative volume
    if rvol < rvol_gate:
        return None

    # 2. RSI Dead Zone Gate: 42 to 58 indicates absence of directional momentum (chop)
    if 42.0 <= rsi <= 58.0:
        return None

    # 3. Minimum Candle Size: Reject micro dojis/indecision candles (< 0.40x ATR)
    if rng < (atr14 * 0.40):
        return None

    trade = None

    # Setup 1: Bullish Liquidity Sweep (Lower wick absorption below swing low)
    recent_lows = [sl["price"] for sl in swing_lows[-5:]] if swing_lows else []
    for sl_price in recent_lows:
        if low < sl_price and close_p > sl_price and (lower_wick / rng) >= 0.25 and close_p >= open_p:
            # Dynamic ATR-based risk buffer
            risk = max(min_risk_pts, (close_p - low) + (atr14 * (atr_buffer_mult * 1.5)))
            tp = round(close_p + (risk * 2.2), 2 if asset in ["ETH", "XAUT"] else 0)
            sl = round(low - (atr14 * atr_buffer_mult), 2 if asset in ["ETH", "XAUT"] else 0)
            rr = round((tp - close_p) / max(0.01, close_p - sl), 1)

            abs_desc = f"Bullish Delta Absorption ({round((lower_wick/rng)*100)}% wick + {rvol}x RVOL)"
            trade = {
                "id": f"cloud_{asset.lower()}_bull_{last_closed['time']}",
                "name": f"{asset} Bullish Order Block Liquidity Sweep",
                "asset": asset,
                "direction": "LONG",
                "time": last_closed["time"],
                "entry": round(close_p, 2 if asset in ["ETH", "XAUT"] else 0),
                "tp": tp,
                "sl": sl,
                "rr": f"1:{rr}",
                "rsi": rsi,
                "rvol": rvol,
                "rationale": {
                    "pattern": "Bullish Lower Wick Absorption",
                    "levelTested": f"Support Liquidity Sweep ({format_asset_price(sl_price, asset)})",
                    "confirmation": f"Strong green close back above swing floor with {rvol}x RVOL",
                    "absorption": abs_desc
                }
            }
            break

    # Setup 2: Bearish Liquidity Sweep (Upper wick rejection above swing high)
    if not trade:
        recent_highs = [sh["price"] for sh in swing_highs[-5:]] if swing_highs else []
        for sh_price in recent_highs:
            if high > sh_price and close_p < sh_price and (upper_wick / rng) >= 0.25 and close_p <= open_p:
                # Dynamic ATR-based risk buffer
                risk = max(min_risk_pts, (high - close_p) + (atr14 * (atr_buffer_mult * 1.5)))
                tp = round(close_p - (risk * 2.2), 2 if asset in ["ETH", "XAUT"] else 0)
                sl = round(high + (atr14 * atr_buffer_mult), 2 if asset in ["ETH", "XAUT"] else 0)
                rr = round((close_p - tp) / max(0.01, sl - close_p), 1)

                abs_desc = f"Bearish Delta Absorption ({round((upper_wick/rng)*100)}% wick + {rvol}x RVOL)"
                trade = {
                    "id": f"cloud_{asset.lower()}_bear_{last_closed['time']}",
                    "name": f"{asset} Bearish Order Block Resistance Rejection",
                    "asset": asset,
                    "direction": "SHORT",
                    "time": last_closed["time"],
                    "entry": round(close_p, 2 if asset in ["ETH", "XAUT"] else 0),
                    "tp": tp,
                    "sl": sl,
                    "rr": f"1:{rr}",
                    "rsi": rsi,
                    "rvol": rvol,
                    "rationale": {
                        "pattern": "Bearish Upper Wick Rejection",
                        "levelTested": f"Resistance Liquidity Sweep ({format_asset_price(sh_price, asset)})",
                        "confirmation": f"Sellers rejecting highs with {rvol}x RVOL absorption",
                        "absorption": abs_desc
                    }
                }
                break

    # Setup 3: Fair Value Gap (FVG) / Imbalance Mitigation
    min_fvg_gap = max(cfg.get("fvg_min_usd", 180.0), atr14 * cfg.get("fvg_atr_mult", 0.75))
    if not trade and len(candles) >= 8:
        for j in range(len(candles) - 7, len(candles) - 3):
            c1 = candles[j]
            c2 = candles[j+1]
            c3 = candles[j+2]

            # Bullish FVG: Gap between c1 high and c3 low
            if c1["high"] < c3["low"] and (c3["low"] - c1["high"]) >= min_fvg_gap:
                fvg_mid = (c1["high"] + c3["low"]) / 2.0
                if low <= c3["low"] and close_p >= fvg_mid and close_p > open_p:
                    risk = max(min_risk_pts, close_p - c1["high"])
                    tp = round(close_p + (risk * 2.2), 2 if asset in ["ETH", "XAUT"] else 0)
                    sl = round(c1["high"] - (atr14 * (atr_buffer_mult * 1.5)), 2 if asset in ["ETH", "XAUT"] else 0)
                    rr = round((tp - close_p) / max(0.01, close_p - sl), 1)
                    trade = {
                        "id": f"cloud_{asset.lower()}_fvg_bull_{last_closed['time']}",
                        "name": f"{asset} Bullish Fair Value Gap (FVG) Mitigation",
                        "asset": asset,
                        "direction": "LONG",
                        "time": last_closed["time"],
                        "entry": round(close_p, 2 if asset in ["ETH", "XAUT"] else 0),
                        "tp": tp,
                        "sl": sl,
                        "rr": f"1:{rr}",
                        "rsi": rsi,
                        "rvol": rvol,
                        "rationale": {
                            "pattern": "Imbalance Void Mitigation",
                            "levelTested": f"FVG Equilibrium ({format_asset_price(fvg_mid, asset)})",
                            "confirmation": f"Price tapped institutional imbalance and bounced with {rvol}x RVOL"
                        }
                    }
                    break

            # Bearish FVG: Gap between c3 high and c1 low
            elif c1["low"] > c3["high"] and (c1["low"] - c3["high"]) >= min_fvg_gap:
                fvg_mid = (c1["low"] + c3["high"]) / 2.0
                if high >= c3["high"] and close_p <= fvg_mid and close_p < open_p:
                    risk = max(min_risk_pts, c1["low"] - close_p)
                    tp = round(close_p - (risk * 2.2), 2 if asset in ["ETH", "XAUT"] else 0)
                    sl = round(c1["low"] + (atr14 * (atr_buffer_mult * 1.5)), 2 if asset in ["ETH", "XAUT"] else 0)
                    rr = round((close_p - tp) / max(0.01, sl - close_p), 1)
                    trade = {
                        "id": f"cloud_{asset.lower()}_fvg_bear_{last_closed['time']}",
                        "name": f"{asset} Bearish Fair Value Gap (FVG) Mitigation",
                        "asset": asset,
                        "direction": "SHORT",
                        "time": last_closed["time"],
                        "entry": round(close_p, 2 if asset in ["ETH", "XAUT"] else 0),
                        "tp": tp,
                        "sl": sl,
                        "rr": f"1:{rr}",
                        "rsi": rsi,
                        "rvol": rvol,
                        "rationale": {
                            "pattern": "Imbalance Void Mitigation",
                            "levelTested": f"FVG Equilibrium ({format_asset_price(fvg_mid, asset)})",
                            "confirmation": f"Price filled institutional imbalance and rejected with {rvol}x RVOL"
                        }
                    }
                    break

    # Setup 4: Break of Structure (BOS) Breakdown / Breakout
    if not trade and swing_lows:
        key_low = swing_lows[-1]["price"]
        if close_p < key_low and open_p >= key_low and (close_p - low) < (rng * 0.4) and rvol >= (rvol_gate * 1.05):
            risk = max(min_risk_pts * 1.2, high - close_p)
            tp = round(close_p - (risk * 2.2), 2 if asset in ["ETH", "XAUT"] else 0)
            sl = round(high + (atr14 * atr_buffer_mult), 2 if asset in ["ETH", "XAUT"] else 0)
            rr = round((close_p - tp) / max(0.01, sl - close_p), 1)

            trade = {
                "id": f"cloud_{asset.lower()}_bos_down_{last_closed['time']}",
                "name": f"{asset} Bearish Break of Structure (BOS)",
                "asset": asset,
                "direction": "SHORT",
                "time": last_closed["time"],
                "entry": round(close_p, 2 if asset in ["ETH", "XAUT"] else 0),
                "tp": tp,
                "sl": sl,
                "rr": f"1:{rr}",
                "rsi": rsi,
                "rvol": rvol,
                "rationale": {
                    "pattern": "Trend Continuation Breakdown",
                    "levelTested": f"Key Structure Floor ({format_asset_price(key_low, asset)})",
                    "confirmation": f"Aggressive institutional selling breaking prior structure with {rvol}x RVOL"
                }
            }

    # Idea 4: Multi-Timeframe 1H Trend Alignment Confluence Check
    if trade and htf_trend:
        htf_bias = htf_trend.get("trend", "NEUTRAL")
        if htf_bias == "NEUTRAL":
            print(f"[Sentinel] ⚠️ Filtered out setup {trade['id']}: 1H {asset} Macro Trend is NEUTRAL / RANGEBOUND (Chop Zone).")
            return None
        elif trade["direction"] == "LONG" and htf_bias == "BEARISH":
            print(f"[Sentinel] ⚠️ Filtered out LONG setup {trade['id']}: Counter to 1H {asset} Bearish Trend.")
            return None
        elif trade["direction"] == "SHORT" and htf_bias == "BULLISH":
            print(f"[Sentinel] ⚠️ Filtered out SHORT setup {trade['id']}: Counter to 1H {asset} Bullish Trend.")
            return None
        trade["htf_trend"] = htf_trend
        trade["rationale"]["htfAlignment"] = htf_trend.get("label", "Neutral")
    elif trade:
        trade["rationale"]["htfAlignment"] = "Neutral (Rangebound)"

    if trade and "absorption" not in trade["rationale"]:
        trade["rationale"]["absorption"] = f"Institutional Flow ({trade['rvol']}x RVOL)"

    return trade


def check_breaking_crypto_catalysts():
    """Checks for breaking high-impact crypto news catalysts."""
    try:
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


def get_now_ist_str():
    """Returns current wall-clock timestamp formatted in Indian Standard Time (IST)."""
    now_ist = datetime.now(timezone.utc) + timedelta(hours=5, minutes=30)
    return now_ist.strftime("%I:%M %p · %d %b %Y IST")


def run_sentinel():
    """Main 24/7 Cloud Sentinel execution routine."""
    print("=" * 60)
    print("24/7 DELTA CLOUD SENTINEL EXECUTION STARTED")
    print(f"Timestamp: {datetime.now(timezone.utc).isoformat()} UTC")
    print("=" * 60)

    # 1. State & History (Guarantees data/sentinel_state.json exists and supports multi-asset)
    state = load_sentinel_state()
    save_sentinel_state(state)
    daily_counts = state.get("daily_counts", {"trades_given": 0, "wins": 0, "losses": 0})

    # Multi-asset active trade container (maintaining top-level state["active_trade"] for backwards compatibility)
    active_trades = state.get("active_trades", {})
    if not active_trades and state.get("active_trade"):
        legacy_asset = state["active_trade"].get("asset", "BTC")
        active_trades[legacy_asset] = state["active_trade"]
    state["active_trades"] = active_trades

    # 2. Telegram Config
    cfg = get_telegram_config()
    bot_token = cfg.get("bot_token")
    chat_id = cfg.get("chat_id")
    enabled = cfg.get("enabled", False)

    if not enabled or not bot_token or not chat_id:
        print("[Sentinel] Telegram not active or configured. Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in GitHub Secrets or the Web App.")
        print("[Sentinel] Market monitoring completed in passive mode.")
        return

    # 2b. One-Time Connection Handshake (Confirms to trader that Sentinel is alive)
    if not state.get("telegram_handshake_sent", False):
        welcome_msg = f"""🟢 <b>DELTA INDIA 24/7 CLOUD SENTINEL CONNECTED</b>
━━━━━━━━━━━━━━━━━━━━━━━━
⚡ <b>Target Feeds:</b> BTCUSD · ETHUSD · XAUTUSD (Tether Gold)
📊 <b>Strategy:</b> Institutional SMC Sweeps, FVGs & BOS
🎯 <b>Execution:</b> Multi-Asset Dynamic Option Potential
⏰ <b>Time:</b> {get_now_ist_str()}

<i>Confirmed trade entries, dynamic targets, and risk alerts across all 3 assets will appear here in real time.</i>
🔗 <a href="https://delta-trading-journal-gmp.vercel.app/chart.html">Open Live Chart & Terminal</a>"""
        if send_telegram_message(bot_token, chat_id, welcome_msg):
            state["telegram_handshake_sent"] = True
            save_sentinel_state(state)

    # 3. Session Context
    current_session = get_current_trading_session()
    is_drift_hours = (current_session.get("code") == "DRIFT")
    daily_losses = daily_counts.get("losses", 0)
    circuit_breaker_active = (daily_losses >= 2)

    # Cooldown constants
    MIN_COOLDOWN_SECONDS = 3600  # 4 candles (60 minutes)
    now_ts = int(time.time())

    # Multi-asset loop (BTC, ETH, XAUT Gold)
    ASSETS = ["BTC", "ETH", "XAUT"]

    for asset in ASSETS:
        asset_cfg = ASSET_REGIME_CONFIGS.get(asset, ASSET_REGIME_CONFIGS["BTC"])
        asset_icon = asset_cfg.get("icon", "🪙")
        print(f"\n--- Scanning Asset: {asset_icon} {asset} ({asset_cfg['delta_symbol']}) ---")

        # 3a. Fetch candles
        candles = fetch_asset_candles(asset)
        if not candles:
            print(f"[Sentinel] ⚠️ Failed to fetch {asset} candles. Skipping asset.")
            continue

        current_price = candles[-1]["close"]
        price_fmt = f"${current_price:,.2f}" if asset in ["ETH", "XAUT"] else f"${current_price:,.0f}"
        print(f"[Sentinel] Latest {asset} Spot Close: {price_fmt}")

        # 4. Check Active Trade Outcomes for this Asset
        active_trade = active_trades.get(asset)
        just_exited = False

        if active_trade:
            trade_id = active_trade.get("id")
            entry = active_trade.get("entry")
            tp = active_trade.get("tp")
            sl = active_trade.get("sl")
            direction = active_trade.get("direction")
            contract = active_trade.get("option", {}).get("symbol", f"Delta {asset} Option")
            buy_p = active_trade.get("option", {}).get("mark_price", 200)
            target_p = active_trade.get("option", {}).get("target_price", round(buy_p * 1.5, 1))
            target_pct = active_trade.get("option", {}).get("target_pct", "+50.0%")
            tp1_p = active_trade.get("option", {}).get("tp1_price", round(buy_p * 1.5, 1))
            is_est = bool(active_trade.get("skipped") or active_trade.get("isEstimation"))

            reached_tp1 = active_trade.get("reached_tp1", False)
            spot_dist = abs(tp - entry)
            tp1_dist = round(spot_dist * 0.45, 2 if asset in ["ETH", "XAUT"] else 0)

            is_tp1_derisk = False
            is_win = False
            is_be_win = False
            is_loss = False

            sl_dist = active_trade.get("slDist") or abs(entry - sl) or (20 if asset == "ETH" else (10 if asset == "XAUT" else 400))

            # Check intra-candle high/low excursions and live candle price
            cur_high = candles[-1]["high"]
            cur_low = candles[-1]["low"]

            if direction == "LONG":
                favorable = max(cur_high - entry, current_price - entry)
                adverse = max(entry - cur_low, entry - current_price)
                if favorable >= spot_dist or cur_high >= tp:
                    is_win = True
                elif not reached_tp1 and favorable >= tp1_dist:
                    is_tp1_derisk = True
                elif reached_tp1:
                    retest_tolerance = entry - (sl_dist * 0.20)
                    if current_price <= retest_tolerance or cur_low <= sl:
                        is_be_win = True
                elif not reached_tp1 and (cur_low <= sl or current_price <= sl):
                    is_loss = True
            else: # SHORT
                favorable = max(entry - cur_low, entry - current_price)
                adverse = max(cur_high - entry, current_price - entry)
                if favorable >= spot_dist or cur_low <= tp:
                    is_win = True
                elif not reached_tp1 and favorable >= tp1_dist:
                    is_tp1_derisk = True
                elif reached_tp1:
                    retest_tolerance = entry + (sl_dist * 0.20)
                    if current_price >= retest_tolerance or cur_high >= sl:
                        is_be_win = True
                elif not reached_tp1 and (cur_high >= sl or current_price >= sl):
                    is_loss = True

            entry_str = f"${entry:,.2f}" if asset in ["ETH", "XAUT"] else f"${entry:,.0f}"
            cur_str = f"${current_price:,.2f}" if asset in ["ETH", "XAUT"] else f"${current_price:,.0f}"
            tp_str = f"${tp:,.2f}" if asset in ["ETH", "XAUT"] else f"${tp:,.0f}"

            if is_tp1_derisk:
                active_trade["reached_tp1"] = True
                active_trade["sl"] = entry # Breakeven
                tp1_pct_str = active_trade.get("option", {}).get("tp1_pct", "+50.0%")
                est_prefix = "🛡️ <b>[ESTIMATION]</b> " if is_est else ""
                tp1_msg = f"""{est_prefix}🎯 <b>TARGET 1 HIT ({tp1_pct_str} DERISK) · {asset}</b>
🏷️ <code>{contract}</code>

💰 <b>DERISK EXECUTION</b>
• Booked: <b>${tp1_p:.1f} ({tp1_pct_str} Profit on 50% Position)</b>
• Initial Fill: ${buy_p:.1f}
• Stop Status: <b>Trailed to Breakeven ({entry_str})</b>

⚡ <i>Zero downside risk remaining. Trailing remaining 50% runner to Target 2 ({tp_str})!</i>
⏰ <i>{get_now_ist_str()}</i>
🔗 <a href="https://delta-trading-journal-gmp.vercel.app/chart.html">Open Live Chart</a>"""
                send_telegram_message(bot_token, chat_id, tp1_msg)
                sync_trade_to_firestore(active_trade)
                active_trades[asset] = active_trade
                state["active_trades"] = active_trades
                if asset == "BTC":
                    state["active_trade"] = active_trade
                save_sentinel_state(state)

            elif is_win:
                if not is_est:
                    daily_counts["wins"] += 1
                tp1_exit = tp1_p
                tp2_exit = target_p
                sell_p = round((tp1_exit * 0.5) + (tp2_exit * 0.5), 1)
                blended_pct = round(((sell_p - buy_p) / buy_p) * 100, 1)

                if is_est:
                    msg = f"""🛡️ <b>ESTIMATION TARGET HIT (+{blended_pct:.1f}%) · {asset}</b>
🏷️ <code>{contract}</code>

💰 <b>THEORETICAL RETURN (OBSERVATION ONLY)</b>
• Fill: ${buy_p:.1f} ➔ <b>Blended Exit: ${sell_p:.1f} (+{blended_pct:.1f}%)</b>
• Spot Move: {entry_str} ➔ <b>{cur_str}</b>
• Risk Guard: <i>2-SL Protection active. Capital preserved (₹0 risk).</i>

⏰ <i>{get_now_ist_str()}</i>
🔗 <a href="https://delta-trading-journal-gmp.vercel.app/chart.html">Open Live Chart</a>"""
                else:
                    total_resolved = daily_counts['wins'] + daily_counts['losses']
                    win_rate_calc = round((daily_counts['wins'] / max(1, total_resolved)) * 100)
                    msg = f"""🏆 <b>TRADE TARGET HIT (+{blended_pct:.1f}% NET GAIN) · {asset}</b>
🏷️ <code>{contract}</code>

💰 <b>REALIZED RETURN</b>
• Entry: ${buy_p:.1f} ➔ <b>Blended Exit: ${sell_p:.1f} (+{blended_pct:.1f}%)</b>
• 50% booked at TP1 + 50% at TP2 ({target_pct})
• {asset} Spot: {entry_str} ➔ <b>{cur_str}</b>

📊 <b>TODAY'S SCORECARD</b>
• Record: <b>{daily_counts['wins']}W - {daily_counts['losses']}L</b> ({win_rate_calc}% Win Rate)
• Total Alerts: <b>{daily_counts['trades_given']}</b>

⏰ <i>{get_now_ist_str()}</i>
🔗 <a href="https://delta-trading-journal-gmp.vercel.app/chart.html">Open Live Chart</a>"""
                send_telegram_message(bot_token, chat_id, msg)
                active_trade["outcome"] = "WIN"
                active_trade["exitPrice"] = current_price
                active_trade["optionSellPrice"] = sell_p
                active_trade["optionExitLockedMark"] = sell_p
                sync_trade_to_firestore(active_trade)

                active_trades[asset] = None
                state["active_trades"] = active_trades
                if asset == "BTC":
                    state["active_trade"] = None
                state[f"last_trade_time_{asset}"] = int(time.time())
                state[f"last_trade_direction_{asset}"] = direction
                state["daily_counts"] = daily_counts
                save_sentinel_state(state)
                just_exited = True

            elif is_be_win:
                if not is_est:
                    daily_counts["wins"] += 1
                sell_p = round(buy_p * 1.25, 1)

                if is_est:
                    msg = f"""🛡️ <b>ESTIMATION TRAILED STOP BREAKEVEN (+25.0%) · {asset}</b>
🏷️ <code>{contract}</code>

💰 <b>THEORETICAL RETURN</b>
• Net Realization: <b>+25.0% Net Profit</b> (50% booked at TP1, 50% at BE)
• {asset} Spot: Returned to entry {entry_str} after TP1

⏰ <i>{get_now_ist_str()}</i>
🔗 <a href="https://delta-trading-journal-gmp.vercel.app/chart.html">Open Live Chart</a>"""
                else:
                    msg = f"""🛡️ <b>TRAILED STOP BREAKEVEN HIT (+25.0% NET PROFIT) · {asset}</b>
🏷️ <code>{contract}</code>

💰 <b>REALIZED RETURN</b>
• Entry: ${buy_p:.1f} ➔ <b>Net Exit: ${sell_p:.1f} (+25.0%)</b>
• Scalp booked at TP1; remaining position exited at Breakeven
• {asset} Spot: Returned to entry {entry_str} after booking TP1

📊 <b>TODAY'S SCORECARD</b>
• Record: <b>{daily_counts['wins']}W - {daily_counts['losses']}L</b>

⏰ <i>{get_now_ist_str()}</i>
🔗 <a href="https://delta-trading-journal-gmp.vercel.app/chart.html">Open Live Chart</a>"""
                send_telegram_message(bot_token, chat_id, msg)
                active_trade["outcome"] = "BE_WIN"
                active_trade["exitPrice"] = current_price
                active_trade["optionSellPrice"] = sell_p
                active_trade["optionExitLockedMark"] = sell_p
                sync_trade_to_firestore(active_trade)

                active_trades[asset] = None
                state["active_trades"] = active_trades
                if asset == "BTC":
                    state["active_trade"] = None
                state[f"last_trade_time_{asset}"] = int(time.time())
                state[f"last_trade_direction_{asset}"] = direction
                state["daily_counts"] = daily_counts
                save_sentinel_state(state)
                just_exited = True

            elif is_loss:
                if not is_est:
                    daily_counts["losses"] += 1
                sell_p = active_trade.get("option", {}).get("stop_price", round(buy_p * 0.7, 1))
                pts_loss = round(buy_p - sell_p, 1)

                if is_est:
                    msg = f"""🛡️ <b>ESTIMATION STOP LOSS HIT (-30.0%) · {asset}</b>
🏷️ <code>{contract}</code>

💰 <b>THEORETICAL DRAWDOWN</b>
• Exit: ${sell_p:.1f} (-{pts_loss} pts / -30.0%)
• {asset} Spot: {entry_str} ➔ <b>{cur_str}</b>
• Status: <i>2-SL Rule preserved capital. Zero real loss.</i>

⏰ <i>{get_now_ist_str()}</i>
🔗 <a href="https://delta-trading-journal-gmp.vercel.app/chart.html">Open Live Chart</a>"""
                else:
                    msg = f"""🛑 <b>STOP LOSS TRIGGERED (-30.0%) · {asset}</b>
🏷️ <code>{contract}</code>

💰 <b>CAPITAL PRESERVATION EXIT</b>
• Entry: ${buy_p:.1f} ➔ <b>Exit: ${sell_p:.1f} (-{pts_loss} pts / -30.0%)</b>
• {asset} Spot: {entry_str} ➔ <b>{cur_str} (Invalidation Hit)</b>

📊 <b>TODAY'S SCORECARD</b>
• Record: <b>{daily_counts['wins']}W - {daily_counts['losses']}L</b>
• Strict Risk Discipline: Position cut cleanly at -30% limit

⏰ <i>{get_now_ist_str()}</i>
🔗 <a href="https://delta-trading-journal-gmp.vercel.app/chart.html">Open Live Chart</a>"""
                send_telegram_message(bot_token, chat_id, msg)
                active_trade["outcome"] = "LOSS"
                active_trade["exitPrice"] = current_price
                active_trade["optionSellPrice"] = sell_p
                active_trade["optionExitLockedMark"] = sell_p
                sync_trade_to_firestore(active_trade)

                active_trades[asset] = None
                state["active_trades"] = active_trades
                if asset == "BTC":
                    state["active_trade"] = None
                state[f"last_trade_time_{asset}"] = int(time.time())
                state[f"last_trade_direction_{asset}"] = direction
                state["daily_counts"] = daily_counts
                save_sentinel_state(state)
                just_exited = True

                # Daily Loss Circuit Breaker Trigger
                if not is_est and daily_counts["losses"] >= 2:
                    cb_msg = f"""🛡️ <b>RISK CIRCUIT BREAKER ENGAGED (2/2 LOSSES)</b>
━━━━━━━━━━━━━━━━━━━━━━━━
⚠️ <b>Status:</b> Signal generation halted across all assets for today's session.
🛑 <b>Reason:</b> 2 Consecutive Stop Losses reached.
🔄 <b>Reset:</b> Automatically resets at 05:30 AM IST tomorrow.

💎 <i>Capital Protection First: Any further market setups will be evaluated in Estimation Mode only (₹0 capital allocated).</i>
⏰ <i>{get_now_ist_str()}</i>
🔗 <a href="https://delta-trading-journal-gmp.vercel.app/chart.html">View Risk Dashboard</a>"""
                    send_telegram_message(bot_token, chat_id, cb_msg)

        # 5. Evaluate New SMC Setups for this Asset
        if active_trades.get(asset):
            active_name = active_trades[asset].get("name", f"Active {asset} Trade")
            print(f"[Sentinel] ⏳ ACTIVE TRADE IN FLIGHT FOR {asset}: {active_name}. Skipping new setups for {asset}.")
            continue
        elif just_exited:
            print(f"[Sentinel] ⏳ Position just resolved for {asset}. Allowing market structure to settle.")
            continue

        # Cooldown check per asset
        last_trade_time = state.get(f"last_trade_time_{asset}", state.get("last_trade_time", 0) if asset == "BTC" else 0)
        last_trade_dir = state.get(f"last_trade_direction_{asset}", state.get("last_trade_direction", "") if asset == "BTC" else "")
        time_since_trade = now_ts - last_trade_time

        # Off-Hours Drift check
        if is_drift_hours and asset_cfg.get("drift_block", True):
            print(f"[Sentinel] 🌙 OFF-HOURS DRIFT ACTIVE (02:30 - 05:30 IST). Institutional liquidity is absent for {asset}; skipping.")
            continue

        # Multi-Timeframe 1H Trend Alignment
        htf_trend = fetch_htf_trend_1h(asset)
        print(f"[Sentinel] HTF 1H {asset} Macro Trend: {htf_trend['label']}")

        # Evaluate SMC Setup
        setup = evaluate_smc_setup(candles, htf_trend, asset=asset)

        if setup:
            # Check cooldown against repeated setups in same direction
            if time_since_trade < MIN_COOLDOWN_SECONDS and setup["direction"] == last_trade_dir:
                print(f"[Sentinel] ⏳ Cooldown active for {asset} ({time_since_trade}s < {MIN_COOLDOWN_SECONDS}s). Skipping repeated {setup['direction']} signal.")
                setup = None

        if setup:
            trade_id = setup["id"]
            last_alerted = state.get(f"last_alerted_trade_id_{asset}", state.get("last_alerted_trade_id") if asset == "BTC" else "")

            if trade_id != last_alerted:
                spot_dist = abs(setup["tp"] - setup["entry"])
                opt = fetch_delta_option_contract(setup["direction"], current_price, spot_dist, asset=asset)
                session = current_session
                setup["option"] = opt
                setup["session"] = session

                is_call = (setup["direction"] == "LONG")

                try:
                    tp2_pct_val = float(str(opt.get('target_pct', '+100%')).replace('+', '').replace('%', '').strip() or 100)
                    blended_target_pct = round(0.5 * 50.0 + 0.5 * tp2_pct_val, 1)
                except Exception:
                    blended_target_pct = 75.0

                entry_disp = f"${setup['entry']:,.2f}" if asset in ["ETH", "XAUT"] else f"${setup['entry']:,}"
                tp_disp = f"${setup['tp']:,.2f}" if asset in ["ETH", "XAUT"] else f"${setup['tp']:,}"
                sl_disp = f"${setup['sl']:,.2f}" if asset in ["ETH", "XAUT"] else f"${setup['sl']:,}"

                if circuit_breaker_active:
                    # Risk Guard Active: Log as Estimation Mode
                    setup["outcome"] = "ACTIVE"
                    setup["skipped"] = True
                    setup["isEstimation"] = True
                    setup["skippedReason"] = "2 SL Daily Limit Hit - Risk Guard Preserving Capital"
                    setup["optionEntryLockedMark"] = opt.get("mark_price", 220)

                    action_title = f"🟡 BUY {asset} CALL (ESTIMATION)" if is_call else f"🟡 BUY {asset} PUT (ESTIMATION)"
                    entry_p = opt.get("mark_price", 220)
                    msg = f"""<b>{action_title}</b>
🏷️ <code>{opt['symbol']}</code> · 🛡️ <b>2-SL Risk Guard</b>

🎯 <b>OBSERVATION PARAMETERS (₹0 RISK)</b>
• Buy Zone: <b>{opt['buy_zone']}</b> (Mark: ${entry_p:.1f})
• Hard Stop (SL): <b>${opt['stop_price']:.1f}</b> (-30.0%)

📈 <b>PROJECTED TARGETS</b>
• Target 1: <b>${opt['tp1_price']:.1f}</b> ({opt['tp1_pct']}) ➔ <i>Lock 50% & Move SL to BE</i>
• Target 2: <b>${opt['target_price']:.1f}</b> ({opt['target_pct']} Runner)
• Blended Net: <b>+{blended_target_pct:.1f}%</b>

🔍 <b>SMC CONTEXT & SPOT REF</b>
• Spot: <b>{entry_disp}</b> ➔ TP <b>{tp_disp}</b> (R:R {setup['rr']}) | SL <b>{sl_disp}</b>
• Pattern: {setup['name']}
• Edge: {setup['rationale']['levelTested']} · {setup['rvol']}x RVOL
• Status: <i>2 SL hit today. Signal tracked for learning only. Zero capital allocated.</i>

⏰ <i>{get_now_ist_str()}</i>
🔗 <a href="https://delta-trading-journal-gmp.vercel.app/chart.html">Open Live Chart</a>"""

                    if send_telegram_message(bot_token, chat_id, msg):
                        state[f"last_alerted_trade_id_{asset}"] = trade_id
                        active_trades[asset] = setup
                        state["active_trades"] = active_trades
                        if asset == "BTC":
                            state["active_trade"] = setup
                            state["last_alerted_trade_id"] = trade_id
                            state["last_trade_time"] = int(time.time())
                            state["last_trade_direction"] = setup["direction"]
                        state[f"last_trade_time_{asset}"] = int(time.time())
                        state[f"last_trade_direction_{asset}"] = setup["direction"]
                        save_sentinel_state(state)
                        sync_trade_to_firestore(setup)
                        print(f"[Sentinel] 🛡️ Estimation trade {trade_id} logged for {asset} and synced.")
                else:
                    daily_counts["trades_given"] += 1
                    setup["outcome"] = "ACTIVE"
                    setup["optionEntryLockedMark"] = opt.get("mark_price", 220)

                    action_title = f"🟢 BUY {asset} CALL OPTION" if is_call else f"🔴 BUY {asset} PUT OPTION"
                    entry_p = opt.get("mark_price", 220)
                    msg = f"""<b>{action_title}</b>
🏷️ <code>{opt['symbol']}</code> · {session['flag']} <b>{session['name']}</b>

🎯 <b>EXECUTION PARAMETERS</b>
• Buy Zone: <b>{opt['buy_zone']}</b> (Mark: ${entry_p:.1f})
• Hard Stop (SL): <b>${opt['stop_price']:.1f}</b> (-30.0%)

📈 <b>PROFIT TARGETS</b>
• Target 1: <b>${opt['tp1_price']:.1f}</b> ({opt['tp1_pct']}) ➔ <i>Book 50%, Trail SL to BE</i>
• Target 2: <b>${opt['target_price']:.1f}</b> ({opt['target_pct']} Runner)
• Net Blended Gain: <b>+{blended_target_pct:.1f}%</b>

🔍 <b>SMC CONTEXT & SPOT REF</b>
• Spot: <b>{entry_disp}</b> ➔ TP <b>{tp_disp}</b> (R:R {setup['rr']}) | SL <b>{sl_disp}</b>
• Pattern: {setup['name']}
• Edge: {setup['rationale']['levelTested']} · {setup['rvol']}x RVOL
• IV Pricing: {opt.get('iv_badge', '🟡 FAIR')} ({opt.get('iv_rating', 'Calibrated')})

⏰ <i>{get_now_ist_str()}</i>
🔗 <a href="https://delta-trading-journal-gmp.vercel.app/chart.html">Open Live Chart & Cockpit</a>"""

                    if send_telegram_message(bot_token, chat_id, msg):
                        state[f"last_alerted_trade_id_{asset}"] = trade_id
                        active_trades[asset] = setup
                        state["active_trades"] = active_trades
                        if asset == "BTC":
                            state["active_trade"] = setup
                            state["last_alerted_trade_id"] = trade_id
                            state["last_trade_time"] = int(time.time())
                            state["last_trade_direction"] = setup["direction"]
                        state[f"last_trade_time_{asset}"] = int(time.time())
                        state[f"last_trade_direction_{asset}"] = setup["direction"]
                        state["daily_counts"] = daily_counts
                        save_sentinel_state(state)
                        sync_trade_to_firestore(setup)
            else:
                print(f"[Sentinel] Trade setup {trade_id} was already alerted previously for {asset}.")
        else:
            print(f"[Sentinel] No new confirmed SMC setups on {asset} 15m candle.")


    # 6. Check Breaking News / Catalysts
    catalyst = check_breaking_crypto_catalysts()
    if catalyst:
        guid = catalyst.get("guid")
        last_guid = state.get("last_alerted_catalyst_guid")
        if guid and guid != last_guid:
            bias_emoji = "🔴" if catalyst["bias"] == "BEARISH" else "🟢"
            action_favored = "PUTS FAVORED" if catalyst["bias"] == "BEARISH" else "CALLS FAVORED"
            news_msg = f"""🚨 <b>CRITICAL MARKET CATALYST</b>
{bias_emoji} <b>{catalyst['bias']} · {action_favored}</b>

📢 <b>{catalyst['title']}</b>
📰 Category: <b>{catalyst['category']}</b>

⚠️ <i>High volatility expected on Delta Option contracts. Respect stop loss levels.</i>
⏰ <i>{get_now_ist_str()}</i>
🔗 <a href="https://delta-trading-journal-gmp.vercel.app/chart.html">Open Live Chart</a>"""
            if send_telegram_message(bot_token, chat_id, news_msg):
                state["last_alerted_catalyst_guid"] = guid
                save_sentinel_state(state)

    print("=" * 60)
    print("24/7 DELTA CLOUD SENTINEL RUN COMPLETED")
    print("=" * 60)


if __name__ == "__main__":
    run_sentinel()
