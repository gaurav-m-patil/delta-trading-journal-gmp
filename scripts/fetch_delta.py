import os
import time
import json
import hmac
import hashlib
import requests
from datetime import datetime, timezone

API_KEY = os.environ.get("DELTA_API_KEY", "").strip()
API_SECRET = os.environ.get("DELTA_API_SECRET", "").strip()
PROXY_URL = os.environ.get("PROXY_URL", "").strip()
BASE_URL = "https://api.india.delta.exchange"
PROXIES = {"http": PROXY_URL, "https": PROXY_URL} if PROXY_URL else None

def get_signature(secret, method, path, query=""):
    timestamp = str(int(time.time()))
    query_str = f"?{query}" if query else ""
    message = method + timestamp + path + query_str
    sig = hmac.new(secret.encode('utf-8'), message.encode('utf-8'), hashlib.sha256).hexdigest()
    return sig, timestamp

def get_ts_us(item):
    """Safely extracts timestamps to microseconds"""
    ts_str = str(item.get("created_at") or item.get("updated_at") or "")
    if "T" in ts_str:
        return int(datetime.fromisoformat(ts_str.replace("Z", "+00:00")).timestamp() * 1000000)
    try:
        raw_num = int(ts_str)
        return raw_num * 1000000 if raw_num < 10**12 else raw_num
    except:
        return int(time.time() * 1000000)

def fetch_history_backwards(path, extra_params=""):
    """
    Stateless, bulletproof pagination.
    Walks backwards in time using end_time cursors to guarantee no infinite loops.
    """
    results = []
    seen_ids = set()
    current_end = int(time.time() * 1000000)
    cutoff_time = 1704067200000000 # Stop at Jan 1, 2024
    
    print(f"Fetching {path} backwards from today...")
    
    while current_end >= cutoff_time:
        query = f"page_size=100&end_time={current_end}"
        if extra_params: 
            query += f"&{extra_params}"
            
        url = f"{BASE_URL}{path}?{query}"
        sig, ts = get_signature(API_SECRET, "GET", path, query)
        headers = {"api-key": API_KEY, "signature": sig, "timestamp": ts}
        
        try:
            res = requests.get(url, headers=headers, proxies=PROXIES, timeout=15)
            if res.status_code != 200:
                print(f"  -> API returned status {res.status_code}. Stopping.")
                break
                
            batch = res.json().get("result", [])
            if not batch or len(batch) == 0:
                break
                
            unique_batch = [b for b in batch if b.get("id") not in seen_ids]
            results.extend(unique_batch)
            for b in unique_batch: 
                seen_ids.add(b.get("id"))
                
            print(f"  -> Pulled {len(batch)} records. (Total stored: {len(results)})")
            
            if len(batch) < 100:
                break # Reached the absolute end of the exchange's available data
                
            # Move the time cursor to just before the oldest record in this batch
            oldest_in_batch = min(get_ts_us(b) for b in batch)
            current_end = oldest_in_batch - 1
            time.sleep(0.15)
            
        except Exception as e:
            print(f"  -> Error: {str(e)}")
            break
            
    return results

def parse_date(ts_val):
    if not ts_val: return datetime.now(timezone.utc)
    ts_str = str(ts_val)
    if "T" in ts_str: return datetime.fromisoformat(ts_str.replace("Z", "+00:00"))
    try:
        raw_num = int(ts_str)
        if raw_num > 10**12: return datetime.fromtimestamp(raw_num / 1000000, tz=timezone.utc)
        return datetime.fromtimestamp(raw_num, tz=timezone.utc)
    except:
        return datetime.now(timezone.utc)

def main():
    os.makedirs("data", exist_ok=True)
    
    print("--- Pulling Wallet Ledger ---")
    wallet_txs = fetch_history_backwards("/v2/wallet/transactions")
    
    print("--- Pulling Closed Orders ---")
    closed_orders = fetch_history_backwards("/v2/orders/history", "state=closed")

    total_deposits = 0.0
    total_withdrawals = 0.0
    total_brokerage = 0.0
    total_taxes_tds = 0.0
    total_taxes_gst = 0.0
    total_gross_pnl = 0.0
    total_net_pnl = 0.0

    daily_rollup = {}
    monthly_rollup = {}
    trade_list = []

    # 1. PARSE WALLET (Deposits, Withdrawals, Statutory Taxes)
    for tx in wallet_txs:
        tx_type = str(tx.get("transaction_type", "")).lower()
        amount = float(tx.get("amount", 0.0) or 0.0)
        abs_amount = abs(amount)
        
        dt = parse_date(tx.get("created_at"))
        m_key = dt.strftime("%Y-%m")

        if m_key not in monthly_rollup:
            monthly_rollup[m_key] = {"month": m_key, "deposits": 0.0, "withdrawals": 0.0, "gross_pnl": 0.0, "brokerage": 0.0, "taxes": 0.0, "net_pnl": 0.0, "trades_count": 0}

        # Handle Deposits (including INR Fiat transfers)
        if any(k in tx_type for k in ["deposit", "credit", "fund_transfer", "fiat_in"]):
            total_deposits += abs_amount
            monthly_rollup[m_key]["deposits"] += abs_amount
        elif amount > 0 and "pnl" not in tx_type and "fee" not in tx_type and "commission" not in tx_type:
            total_deposits += abs_amount
            monthly_rollup[m_key]["deposits"] += abs_amount

        # Handle Withdrawals
        if any(k in tx_type for k in ["withdrawal", "debit", "fiat_out"]):
            total_withdrawals += abs_amount
            monthly_rollup[m_key]["withdrawals"] += abs_amount
        elif amount < 0 and "pnl" not in tx_type and "fee" not in tx_type and "tax" not in tx_type and "tds" not in tx_type and "gst" not in tx_type:
            total_withdrawals += abs_amount
            monthly_rollup[m_key]["withdrawals"] += abs_amount

        # Handle Taxes
        if "tds" in tx_type: total_taxes_tds += abs_amount
        if "gst" in tx_type: total_taxes_gst += abs_amount

    # 2. PARSE ORDERS (Accurate PnL and Brokerage)
    for order in closed_orders:
        realized_pnl = float(order.get("realized_pnl", 0.0) or 0.0)
        fee = abs(float(order.get("fee", 0.0) or order.get("commission", 0.0) or 0.0))
        
        if realized_pnl == 0 and fee == 0:
            continue

        gross_trade_pnl = realized_pnl
        gst_portion = fee * 0.18
        net_trade_pnl = gross_trade_pnl - fee - gst_portion
        
        total_gross_pnl += gross_trade_pnl
        total_brokerage += fee
        total_net_pnl += net_trade_pnl

        symbol = order.get("symbol", "OPTION")
        side = order.get("side", "buy").upper()
        size = float(order.get("size", 0.0) or 0.0)
        price = float(order.get("average_fill_price", 0.0) or order.get("price", 0.0) or 0.0)
        
        dt = parse_date(order.get("created_at") or order.get("updated_at"))
        d_key = dt.strftime("%Y-%m-%d")
        m_key = dt.strftime("%Y-%m")

        if d_key not in daily_rollup:
            daily_rollup[d_key] = {"date": d_key, "trades": 0, "gross_pnl": 0.0, "brokerage": 0.0, "taxes": 0.0, "net_pnl": 0.0}
        if m_key not in monthly_rollup:
            monthly_rollup[m_key] = {"month": m_key, "deposits": 0.0, "withdrawals": 0.0, "gross_pnl": 0.0, "brokerage": 0.0, "taxes": 0.0, "net_pnl": 0.0, "trades_count": 0}

        daily_rollup[d_key]["trades"] += 1
        daily_rollup[d_key]["gross_pnl"] += gross_trade_pnl
        daily_rollup[d_key]["brokerage"] += fee
        daily_rollup[d_key]["taxes"] += gst_portion
        daily_rollup[d_key]["net_pnl"] += net_trade_pnl

        monthly_rollup[m_key]["trades_count"] += 1
        monthly_rollup[m_key]["gross_pnl"] += gross_trade_pnl
        monthly_rollup[m_key]["brokerage"] += fee
        monthly_rollup[m_key]["taxes"] += gst_portion
        monthly_rollup[m_key]["net_pnl"] += net_trade_pnl

        trade_list.append({
            "timestamp": dt.strftime("%Y-%m-%d %H:%M:%S"),
            "date": d_key,
            "symbol": symbol,
            "side": side,
            "size": size,
            "price": price,
            "gross_pnl": round(gross_trade_pnl, 2),
            "brokerage": round(fee, 2),
            "taxes": round(gst_portion, 2),
            "net_pnl": round(net_trade_pnl, 2),
            "status": "WIN" if net_trade_pnl > 0 else ("LOSS" if net_trade_pnl < 0 else "BE")
        })

    core_capital = total_deposits - total_withdrawals
    reinvested_profits = max(0.0, total_deposits - max(0.0, core_capital))

    payload = {
        "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC"),
        "kpis": {
            "total_deposits": round(total_deposits, 2),
            "total_withdrawals": round(total_withdrawals, 2),
            "net_core_capital": round(core_capital, 2),
            "reinvested_profits": round(reinvested_profits, 2),
            "total_gross_pnl": round(total_gross_pnl, 2),
            "total_brokerage": round(total_brokerage, 2),
            "total_taxes": round(total_taxes_tds + total_taxes_gst, 2),
            "total_net_pnl": round(total_net_pnl, 2),
            "total_trades": len(trade_list)
        },
        "monthly_breakdown": sorted(monthly_rollup.values(), key=lambda x: x["month"], reverse=True),
        "daily_breakdown": daily_rollup,
        "trades": sorted(trade_list, key=lambda x: x["timestamp"], reverse=True)
    }

    with open("data/trade_journal.json", "w") as f:
        json.dump(payload, f, indent=2)

if __name__ == "__main__":
    main()
