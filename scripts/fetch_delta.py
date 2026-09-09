import os
import time
import json
import hmac
import hashlib
import requests
from datetime import datetime, timezone

API_KEY = os.environ.get("DELTA_API_KEY", "").strip()
API_SECRET = os.environ.get("DELTA_API_SECRET", "").strip()
PROXY = os.environ.get("PROXY_URL", "").strip()
BASE_URL = "https://api.india.delta.exchange"
PROXIES = {"http": PROXY, "https": PROXY} if PROXY else None

def get_signature(secret, method, path, query=""):
    timestamp = str(int(time.time()))
    query_str = f"?{query}" if query else ""
    message = method + timestamp + path + query_str
    return hmac.new(secret.encode('utf-8'), message.encode('utf-8'), hashlib.sha256).hexdigest(), timestamp

def fetch_full_dump(path):
    print(f"Executing full data extraction for {path}...")
    results = []
    after_cursor = ""
    seen_ids = set()
    
    while True:
        query = "page_size=100"
        if after_cursor:
            query += f"&after={after_cursor}"
            
        url = f"{BASE_URL}{path}?{query}"
        sig, ts = get_signature(API_SECRET, "GET", path, query)
        headers = {"api-key": API_KEY, "signature": sig, "timestamp": ts}
        
        try:
            res = requests.get(url, headers=headers, proxies=PROXIES, timeout=20)
            if res.status_code != 200:
                print(f"API Error {res.status_code}: {res.text}")
                break
                
            data = res.json()
            batch = data.get("result", [])
            if not batch:
                break
                
            new_records = [item for item in batch if str(item.get("id")) not in seen_ids]
            results.extend(new_records)
            for item in new_records:
                seen_ids.add(str(item.get("id")))
                
            print(f"  -> Pulled {len(new_records)} records (Total: {len(results)})")
            
            after_cursor = data.get("meta", {}).get("after")
            if not after_cursor or len(batch) < 100:
                break
            time.sleep(0.2)
        except Exception as e:
            print(f"Request failed: {str(e)}")
            break
            
    return results

def parse_date(ts_val):
    if not ts_val: return datetime.now(timezone.utc)
    ts_str = str(ts_val)
    if "T" in ts_str: return datetime.fromisoformat(ts_str.replace("Z", "+00:00"))
    try:
        num = int(ts_str)
        return datetime.fromtimestamp(num / 1000000 if num > 10**12 else num, tz=timezone.utc)
    except:
        return datetime.now(timezone.utc)

def main():
    os.makedirs("data", exist_ok=True)
    
    wallet_txs = fetch_full_dump("/v2/wallet/transactions")
    orders = fetch_full_dump("/v2/orders/history")
    
    total_deposits, total_withdrawals, total_brokerage = 0.0, 0.0, 0.0
    total_taxes_tds, total_taxes_gst, total_gross_pnl, total_net_pnl = 0.0, 0.0, 0.0, 0.0
    daily_rollup, monthly_rollup, trade_list = {}, {}, []

    for tx in wallet_txs:
        tx_type = str(tx.get("transaction_type", "")).lower()
        amount = float(tx.get("amount", 0.0) or 0.0)
        abs_amt = abs(amount)
        m_key = parse_date(tx.get("created_at")).strftime("%Y-%m")

        if m_key not in monthly_rollup:
            monthly_rollup[m_key] = {"month": m_key, "deposits": 0.0, "withdrawals": 0.0, "gross_pnl": 0.0, "brokerage": 0.0, "taxes": 0.0, "net_pnl": 0.0, "trades_count": 0}

        if any(k in tx_type for k in ["deposit", "credit", "fiat_in"]) or (amount > 0 and "pnl" not in tx_type and "fee" not in tx_type):
            total_deposits += abs_amt
            monthly_rollup[m_key]["deposits"] += abs_amt
        elif any(k in tx_type for k in ["withdrawal", "debit", "fiat_out"]) or (amount < 0 and "pnl" not in tx_type and "fee" not in tx_type and "tax" not in tx_type):
            total_withdrawals += abs_amt
            monthly_rollup[m_key]["withdrawals"] += abs_amt

        if "tds" in tx_type: total_taxes_tds += abs_amt
        if "gst" in tx_type: total_taxes_gst += abs_amt

    for order in orders:
        if str(order.get("state")).lower() not in ["closed", "filled"]:
            continue
            
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

    with open("data/trade_journal.json", "w") as f:
        json.dump(payload, f, indent=2)

if __name__ == "__main__":
    main()
