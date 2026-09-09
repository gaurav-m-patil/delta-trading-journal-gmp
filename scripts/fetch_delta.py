import os
import time
import json
import hmac
import hashlib
import requests
from datetime import datetime, timezone

API_KEY = os.environ.get("DELTA_API_KEY", "").strip()
API_SECRET = os.environ.get("DELTA_API_SECRET", "").strip()
BASE_URL = "https://api.india.delta.exchange"
CACHE_FILE = "data/raw_cache.json"

def get_signature(secret, method, path, query=""):
    timestamp = str(int(time.time()))
    query_str = f"?{query}" if query else ""
    message = method + timestamp + path + query_str
    sig = hmac.new(secret.encode('utf-8'), message.encode('utf-8'), hashlib.sha256).hexdigest()
    return sig, timestamp

def fetch_new_records(path, existing_records):
    """
    Utilizes Delta's Cursor-Based Pagination (`after` metadata)
    to accurately pull new data without looping.
    """
    existing_ids = {str(r.get("id")) for r in existing_records if r.get("id")}
    new_results = []
    after_cursor = ""
    
    print(f"Syncing {path}...")
    
    while True:
        query = "page_size=100"
        if after_cursor:
            query += f"&after={after_cursor}"
            
        url = f"{BASE_URL}{path}?{query}"
        sig, ts = get_signature(API_SECRET, "GET", path, query)
        headers = {"api-key": API_KEY, "signature": sig, "timestamp": ts}
        
        try:
            res = requests.get(url, headers=headers, timeout=15)
            if res.status_code != 200:
                print(f"API Error {res.status_code}: {res.text}")
                break
                
            data = res.json()
            batch = data.get("result", [])
            if not batch:
                break
                
            new_in_batch = []
            hit_existing = False
            for item in batch:
                if str(item.get("id")) in existing_ids:
                    hit_existing = True
                    break
                new_in_batch.append(item)
                
            new_results.extend(new_in_batch)
            print(f"  -> Downloaded {len(new_in_batch)} new unique records.")
            
            if hit_existing or len(batch) < 100:
                break
                
            after_cursor = data.get("meta", {}).get("after")
            if not after_cursor:
                break
                
            time.sleep(0.15)
        except Exception as e:
            print(f"  -> Error: {str(e)}")
            break
            
    # Return newest data first, followed by older cached data
    return new_results + existing_records

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
    
    # 1. INDEPENDENT DATA EXTRACTION
    cache = {"wallet_txs": [], "orders": []}
    if os.path.exists(CACHE_FILE):
        try:
            with open(CACHE_FILE, "r") as f:
                cache = json.load(f)
            print(f"Loaded existing cache: {len(cache.get('wallet_txs', []))} wallet txs, {len(cache.get('orders', []))} orders.")
        except:
            pass

    # Update cache with only brand new records from API
    cache["wallet_txs"] = fetch_new_records("/v2/wallet/transactions", cache.get("wallet_txs", []))
    cache["orders"] = fetch_new_records("/v2/orders/history", cache.get("orders", []))
    
    with open(CACHE_FILE, "w") as f:
        json.dump(cache, f)

    # 2. COMPUTATION LOGIC (Runs strictly off the cache)
    total_deposits, total_withdrawals, total_brokerage = 0.0, 0.0, 0.0
    total_taxes_tds, total_taxes_gst, total_gross_pnl, total_net_pnl = 0.0, 0.0, 0.0, 0.0
    daily_rollup, monthly_rollup, trade_list = {}, {}, []

    for tx in cache["wallet_txs"]:
        tx_type = str(tx.get("transaction_type", "")).lower()
        amount = float(tx.get("amount", 0.0) or 0.0)
        abs_amount = abs(amount)
        dt = parse_date(tx.get("created_at"))
        m_key = dt.strftime("%Y-%m")

        if m_key not in monthly_rollup:
            monthly_rollup[m_key] = {"month": m_key, "deposits": 0.0, "withdrawals": 0.0, "gross_pnl": 0.0, "brokerage": 0.0, "taxes": 0.0, "net_pnl": 0.0, "trades_count": 0}

        if any(k in tx_type for k in ["deposit", "credit", "fund_transfer", "fiat_in"]) or (amount > 0 and "pnl" not in tx_type and "fee" not in tx_type):
            total_deposits += abs_amount
            monthly_rollup[m_key]["deposits"] += abs_amount
        elif any(k in tx_type for k in ["withdrawal", "debit", "fiat_out"]) or (amount < 0 and "pnl" not in tx_type and "fee" not in tx_type and "tax" not in tx_type and "tds" not in tx_type and "gst" not in tx_type):
            total_withdrawals += abs_amount
            monthly_rollup[m_key]["withdrawals"] += abs_amount

        if "tds" in tx_type: total_taxes_tds += abs_amount
        if "gst" in tx_type: total_taxes_gst += abs_amount

    for order in cache["orders"]:
        if str(order.get("state")).lower() not in ["closed", "filled"]:
            continue
            
        realized_pnl = float(order.get("realized_pnl", 0.0) or 0.0)
        fee = abs(float(order.get("fee", 0.0) or order.get("commission", 0.0) or 0.0))
        
        if realized_pnl == 0 and fee == 0:
            continue

        gst_portion = fee * 0.18
        net_trade_pnl = realized_pnl - fee - gst_portion
        
        total_gross_pnl += realized_pnl
        total_brokerage += fee
        total_net_pnl += net_trade_pnl

        dt = parse_date(order.get("created_at") or order.get("updated_at"))
        d_key = dt.strftime("%Y-%m-%d")
        m_key = dt.strftime("%Y-%m")

        if d_key not in daily_rollup:
            daily_rollup[d_key] = {"date": d_key, "trades": 0, "gross_pnl": 0.0, "brokerage": 0.0, "taxes": 0.0, "net_pnl": 0.0}
        if m_key not in monthly_rollup:
            monthly_rollup[m_key] = {"month": m_key, "deposits": 0.0, "withdrawals": 0.0, "gross_pnl": 0.0, "brokerage": 0.0, "taxes": 0.0, "net_pnl": 0.0, "trades_count": 0}

        daily_rollup[d_key]["trades"] += 1
        daily_rollup[d_key]["gross_pnl"] += realized_pnl
        daily_rollup[d_key]["brokerage"] += fee
        daily_rollup[d_key]["taxes"] += gst_portion
        daily_rollup[d_key]["net_pnl"] += net_trade_pnl
        monthly_rollup[m_key]["trades_count"] += 1
        monthly_rollup[m_key]["gross_pnl"] += realized_pnl
        monthly_rollup[m_key]["brokerage"] += fee
        monthly_rollup[m_key]["taxes"] += gst_portion
        monthly_rollup[m_key]["net_pnl"] += net_trade_pnl

        trade_list.append({
            "timestamp": dt.strftime("%Y-%m-%d %H:%M:%S"),
            "date": d_key,
            "symbol": order.get("symbol", "OPTION"),
            "side": order.get("side", "buy").upper(),
            "size": float(order.get("size", 0.0) or 0.0),
            "price": float(order.get("average_fill_price", 0.0) or order.get("price", 0.0) or 0.0),
            "gross_pnl": round(realized_pnl, 2),
            "brokerage": round(fee, 2),
            "taxes": round(gst_portion, 2),
            "net_pnl": round(net_trade_pnl, 2),
            "status": "WIN" if net_trade_pnl > 0 else ("LOSS" if net_trade_pnl < 0 else "BE")
        })

    core_capital = total_deposits - total_withdrawals
    payload = {
        "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC"),
        "kpis": {
            "total_deposits": round(total_deposits, 2),
            "total_withdrawals": round(total_withdrawals, 2),
            "net_core_capital": round(core_capital, 2),
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
