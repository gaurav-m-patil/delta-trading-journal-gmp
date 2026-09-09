import os
import time
import json
import hmac
import hashlib
import requests
from datetime import datetime, timezone, timedelta

API_KEY = os.environ.get("DELTA_API_KEY", "").strip()
API_SECRET = os.environ.get("DELTA_API_SECRET", "").strip()
PROXY = os.environ.get("PROXY_URL", "").strip()
BASE_URL = "https://api.india.delta.exchange"
PROXIES = {"http": PROXY, "https": PROXY} if PROXY else None

RAW_DUMP_FILE = "data/raw_dump.json"
UI_JSON_FILE = "data/trade_journal.json"

def get_signature(secret, method, path, query=""):
    timestamp = str(int(time.time()))
    query_str = f"?{query}" if query else ""
    message = method + timestamp + path + query_str
    return hmac.new(secret.encode('utf-8'), message.encode('utf-8'), hashlib.sha256).hexdigest(), timestamp

def get_ts_us(item):
    ts_str = str(item.get("created_at") or item.get("updated_at") or "")
    if "T" in ts_str: return int(datetime.fromisoformat(ts_str.replace("Z", "+00:00")).timestamp() * 1000000)
    try:
        num = int(ts_str)
        return num * 1000000 if num < 10**12 else num
    except:
        return int(time.time() * 1000000)

def parse_date(ts_val):
    if not ts_val: return datetime.now(timezone.utc)
    ts_str = str(ts_val)
    if "T" in ts_str: return datetime.fromisoformat(ts_str.replace("Z", "+00:00"))
    try:
        num = int(ts_str)
        return datetime.fromtimestamp(num / 1000000 if num > 10**12 else num, tz=timezone.utc)
    except:
        return datetime.now(timezone.utc)

def extract_api_data(path, cutoff_us, extra_params=""):
    """Extracts raw data strictly moving backwards until the cutoff microsecond."""
    results = []
    current_end = int(time.time() * 1000000)
    
    print(f"Extracting {path} back to timestamp {cutoff_us}...")
    
    while current_end >= cutoff_us:
        query = f"page_size=100&end_time={current_end}"
        if extra_params: query += f"&{extra_params}"
            
        url = f"{BASE_URL}{path}?{query}"
        sig, ts = get_signature(API_SECRET, "GET", path, query)
        headers = {"api-key": API_KEY, "signature": sig, "timestamp": ts}
        
        try:
            res = requests.get(url, headers=headers, proxies=PROXIES, timeout=20)
            if res.status_code != 200:
                print(f"  -> API Error {res.status_code}. Halting extraction.")
                break
                
            batch = res.json().get("result", [])
            if not batch:
                break
                
            results.extend(batch)
            print(f"  -> Extracted {len(batch)} records in this block.")
            
            if len(batch) < 100:
                break 
                
            oldest_in_batch = min(get_ts_us(b) for b in batch)
            current_end = (current_end - 1000) if oldest_in_batch >= current_end else (oldest_in_batch - 1)
            time.sleep(0.15)
            
        except Exception as e:
            print(f"  -> Request failed: {str(e)}")
            break
            
    return results

def main():
    os.makedirs("data", exist_ok=True)
    
    # ---------------------------------------------------------
    # PHASE 1: EXTRACT & DEDUPLICATE (The Data Warehouse)
    # ---------------------------------------------------------
    raw_dump = {"wallet_txs": [], "orders": []}
    is_initial_run = not os.path.exists(RAW_DUMP_FILE)
    
    if not is_initial_run:
        with open(RAW_DUMP_FILE, "r") as f:
            raw_dump = json.load(f)
        print("Loaded existing raw dump.")

    # Determine cutoff: 365 days if fresh, 45 days if appending
    days_back = 365 if is_initial_run else 45
    cutoff_datetime = datetime.now(timezone.utc) - timedelta(days=days_back)
    cutoff_us = int(cutoff_datetime.timestamp() * 1000000)
    
    new_wallet = extract_api_data("/v2/wallet/transactions", cutoff_us)
    new_orders = extract_api_data("/v2/orders/history", cutoff_us, "state=closed")
    
    # Absolute Deduplication: Using dictionaries keyed by the exchange's ID
    all_wallet = raw_dump.get("wallet_txs", []) + new_wallet
    all_orders = raw_dump.get("orders", []) + new_orders
    
    deduped_wallet = {str(tx["id"]): tx for tx in all_wallet if "id" in tx}
    deduped_orders = {str(o["id"]): o for o in all_orders if "id" in o}
    
    raw_dump["wallet_txs"] = sorted(list(deduped_wallet.values()), key=lambda x: get_ts_us(x), reverse=True)
    raw_dump["orders"] = sorted(list(deduped_orders.values()), key=lambda x: get_ts_us(x), reverse=True)
    
    with open(RAW_DUMP_FILE, "w") as f:
        json.dump(raw_dump, f, indent=2)
    print(f"Raw Dump Secured: {len(raw_dump['wallet_txs'])} total wallet records, {len(raw_dump['orders'])} total orders.")

    # ---------------------------------------------------------
    # PHASE 2: TRANSFORM & LOAD (The UI Dashboard Math)
    # ---------------------------------------------------------
    total_deposits, total_withdrawals, total_brokerage = 0.0, 0.0, 0.0
    total_taxes_tds, total_taxes_gst, total_gross_pnl, total_net_pnl = 0.0, 0.0, 0.0, 0.0
    daily_rollup, monthly_rollup, trade_list = {}, {}, []

    for tx in raw_dump["wallet_txs"]:
        tx_type = str(tx.get("transaction_type", "")).lower()
        amount = float(tx.get("amount", 0.0) or 0.0)
        abs_amt = abs(amount)
        m_key = parse_date(tx.get("created_at")).strftime("%Y-%m")

        if m_key not in monthly_rollup:
            monthly_rollup[m_key] = {"month": m_key, "deposits": 0.0, "withdrawals": 0.0, "gross_pnl": 0.0, "brokerage": 0.0, "taxes": 0.0, "net_pnl": 0.0, "trades_count": 0}

        if any(k in tx_type for k in ["deposit", "credit", "fiat_in"]) or (amount > 0 and "pnl" not in tx_type and "fee" not in tx_type and "commission" not in tx_type):
            total_deposits += abs_amt
            monthly_rollup[m_key]["deposits"] += abs_amt
        elif any(k in tx_type for k in ["withdrawal", "debit", "fiat_out"]) or (amount < 0 and "pnl" not in tx_type and "fee" not in tx_type and "tax" not in tx_type and "tds" not in tx_type and "gst" not in tx_type):
            total_withdrawals += abs_amt
            monthly_rollup[m_key]["withdrawals"] += abs_amt

        if "tds" in tx_type: total_taxes_tds += abs_amt
        if "gst" in tx_type: total_taxes_gst += abs_amt

    for order in raw_dump["orders"]:
        realized_pnl = float(order.get("realized_pnl", 0.0) or 0.0)
        fee = abs(float(order.get("fee", 0.0) or order.get("commission", 0.0) or 0.0))
        
        if realized_pnl == 0 and fee == 0:
            continue

        gst = fee * 0.18
        net = realized_pnl - fee - gst
        
        total_gross_pnl += realized_pnl
        total_brokerage += fee
        total_net_pnl += net

        dt = parse_date(order.get("created_at") or order.get("updated_at"))
        d_key, m_key = dt.strftime("%Y-%m-%d"), dt.strftime("%Y-%m")

        if d_key not in daily_rollup: daily_rollup[d_key] = {"date": d_key, "trades": 0, "gross_pnl": 0.0, "brokerage": 0.0, "taxes": 0.0, "net_pnl": 0.0}
        if m_key not in monthly_rollup: monthly_rollup[m_key] = {"month": m_key, "deposits": 0.0, "withdrawals": 0.0, "gross_pnl": 0.0, "brokerage": 0.0, "taxes": 0.0, "net_pnl": 0.0, "trades_count": 0}

        for rollup in [daily_rollup[d_key], monthly_rollup[m_key]]:
            rollup["gross_pnl"] += realized_pnl
            rollup["brokerage"] += fee
            rollup["taxes"] += gst
            rollup["net_pnl"] += net
        
        daily_rollup[d_key]["trades"] += 1
        monthly_rollup[m_key]["trades_count"] += 1

        trade_list.append({
            "timestamp": dt.strftime("%Y-%m-%d %H:%M:%S"),
            "date": d_key,
            "symbol": order.get("symbol", "OPTION"),
            "side": order.get("side", "buy").upper(),
            "size": float(order.get("size", 0.0) or 0.0),
            "price": float(order.get("average_fill_price", 0.0) or order.get("price", 0.0) or 0.0),
            "gross_pnl": round(realized_pnl, 2),
            "brokerage": round(fee, 2),
            "taxes": round(gst, 2),
            "net_pnl": round(net, 2),
            "status": "WIN" if net > 0 else ("LOSS" if net < 0 else "BE")
        })

    payload = {
        "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC"),
        "kpis": {
            "total_deposits": round(total_deposits, 2),
            "total_withdrawals": round(total_withdrawals, 2),
            "net_core_capital": round(total_deposits - total_withdrawals, 2),
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

    with open(UI_JSON_FILE, "w") as f:
        json.dump(payload, f, indent=2)

if __name__ == "__main__":
    main()
