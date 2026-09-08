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
CACHE_FILE = "data/raw_cache.json"

def get_signature(secret, method, path, query="", payload=""):
    timestamp = str(int(time.time()))
    query_str = f"?{query}" if query else ""
    message = method + timestamp + path + query_str + payload
    sig = hmac.new(secret.encode('utf-8'), message.encode('utf-8'), hashlib.sha256).hexdigest()
    return sig, timestamp

def delta_api_get(path, query=""):
    url = f"{BASE_URL}{path}"
    if query:
        url += f"?{query}"
    signature, timestamp = get_signature(API_SECRET, "GET", path, query)
    headers = {
        "api-key": API_KEY,
        "signature": signature,
        "timestamp": timestamp,
        "User-Agent": "TradingJournalEngine/5.0"
    }
    try:
        res = requests.get(url, headers=headers, proxies=PROXIES, timeout=15)
        if res.status_code == 200:
            return res.json().get("result", [])
        return []
    except Exception:
        return []

def get_ts_us(item):
    ts_str = str(item.get("created_at") or item.get("updated_at") or "")
    if "T" in ts_str:
        return int(datetime.fromisoformat(ts_str.replace("Z", "+00:00")).timestamp() * 1000000)
    try:
        raw_num = int(ts_str)
        return raw_num * 1000000 if raw_num < 10**12 else raw_num
    except:
        return 0

def fetch_incremental(path, cache_list):
    """Fetches records up to the 1-year API Cold Storage limit"""
    base_us = 1704067200000000 
    if cache_list:
        base_us = max(get_ts_us(item) for item in cache_list)

    current_us = int(time.time() * 1000000)
    chunk_size = 30 * 24 * 60 * 60 * 1000000
    
    new_records = []
    existing_ids = {item.get("id") for item in cache_list if item.get("id")}
    
    chunk_start = base_us
    while chunk_start < current_us:
        chunk_end = min(chunk_start + chunk_size, current_us)
        inner_end = chunk_end
        
        while True:
            query = f"page_size=100&start_time={chunk_start}&end_time={inner_end}"
            batch = delta_api_get(path, query)
            
            if not batch or len(batch) == 0:
                break
                
            unique_batch = [b for b in batch if b.get("id") not in existing_ids]
            new_records.extend(unique_batch)
            for b in unique_batch:
                existing_ids.add(b.get("id"))
            
            if len(batch) < 100:
                break
                
            oldest_in_batch = min(get_ts_us(b) for b in batch)
            inner_end = oldest_in_batch - 1
            time.sleep(0.15)
            
        chunk_start += chunk_size
        time.sleep(0.15)

    cache_list.extend(new_records)
    return len(new_records)

def parse_delta_date(ts_val):
    if not ts_val:
        return datetime.now(timezone.utc)
    ts_str = str(ts_val)
    if "T" in ts_str:
        return datetime.fromisoformat(ts_str.replace("Z", "+00:00"))
    try:
        raw_num = int(ts_str)
        if raw_num > 10**12:
            return datetime.fromtimestamp(raw_num / 1000000, tz=timezone.utc)
        return datetime.fromtimestamp(raw_num, tz=timezone.utc)
    except:
        return datetime.now(timezone.utc)

def main():
    os.makedirs("data", exist_ok=True)
    cache = {"wallet_txs": [], "fills": []}
    
    if os.path.exists(CACHE_FILE):
        try:
            with open(CACHE_FILE, "r") as f:
                cache = json.load(f)
        except Exception:
            pass

    fetch_incremental("/v2/wallet/transactions", cache["wallet_txs"])
    fetch_incremental("/v2/fills", cache["fills"])
    
    with open(CACHE_FILE, "w") as f:
        json.dump(cache, f)

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
    
    unique_tx_types = set()

    # 1. PARSE WALLET FOR PENNY-PERFECT MATH & INR TRANSFERS
    for tx in cache["wallet_txs"]:
        tx_type = str(tx.get("transaction_type", "")).lower()
        unique_tx_types.add(tx_type)
        
        raw_amount = float(tx.get("amount", 0.0) or 0.0)
        abs_amount = abs(raw_amount)
        
        dt = parse_delta_date(tx.get("created_at"))
        d_key = dt.strftime("%Y-%m-%d")
        m_key = dt.strftime("%Y-%m")

        if m_key not in monthly_rollup:
            monthly_rollup[m_key] = {"month": m_key, "deposits": 0.0, "withdrawals": 0.0, "gross_pnl": 0.0, "brokerage": 0.0, "taxes": 0.0, "net_pnl": 0.0, "trades_count": 0}
        if d_key not in daily_rollup:
            daily_rollup[d_key] = {"date": d_key, "trades": 0, "gross_pnl": 0.0, "brokerage": 0.0, "taxes": 0.0, "net_pnl": 0.0}

        # Categorize Wallet Ledger Entries
        if "tds" in tx_type: 
            total_taxes_tds += abs_amount
            monthly_rollup[m_key]["taxes"] += abs_amount
            daily_rollup[d_key]["taxes"] += abs_amount
        elif "gst" in tx_type: 
            total_taxes_gst += abs_amount
            monthly_rollup[m_key]["taxes"] += abs_amount
            daily_rollup[d_key]["taxes"] += abs_amount
        elif "commission" in tx_type or "fee" in tx_type:
            total_brokerage += abs_amount
            monthly_rollup[m_key]["brokerage"] += abs_amount
            daily_rollup[d_key]["brokerage"] += abs_amount
        elif "pnl" in tx_type or "settlement" in tx_type:
            # Positive PNL is gain, negative is loss
            total_gross_pnl += raw_amount 
            monthly_rollup[m_key]["gross_pnl"] += raw_amount
            daily_rollup[d_key]["gross_pnl"] += raw_amount
            total_net_pnl += raw_amount
            monthly_rollup[m_key]["net_pnl"] += raw_amount
            daily_rollup[d_key]["net_pnl"] += raw_amount
        elif any(k in tx_type for k in ["deposit", "transfer", "fiat", "buy"]) and raw_amount > 0:
            total_deposits += abs_amount
            monthly_rollup[m_key]["deposits"] += abs_amount
        elif any(k in tx_type for k in ["withdrawal", "transfer", "fiat", "sell"]) and raw_amount < 0:
            total_withdrawals += abs_amount
            monthly_rollup[m_key]["withdrawals"] += abs_amount
            
    print(f"DEBUG: Delta India Wallet Tx Types Found -> {unique_tx_types}")

    # 2. PARSE FILLS JUST FOR THE TRADE EXECUTION TABLE
    sorted_fills = sorted(cache["fills"], key=lambda x: get_ts_us(x), reverse=True)

    for fill in sorted_fills:
        fee = abs(float(fill.get("fee", 0.0) or fill.get("commission", 0.0) or 0.0))
        realized_pnl = float(fill.get("realized_pnl", 0.0) or fill.get("pnl", 0.0) or 0.0)
        
        symbol = fill.get("symbol", fill.get("product_symbol", "OPTION"))
        size = float(fill.get("size", 0.0) or 0.0)
        price = float(fill.get("price", 0.0) or fill.get("average_fill_price", 0.0) or 0.0)
        side = fill.get("side", "buy").upper()
        
        dt = parse_delta_date(fill.get("created_at") or fill.get("updated_at"))
        m_key = dt.strftime("%Y-%m")
        d_key = dt.strftime("%Y-%m-%d")
        
        if m_key in monthly_rollup: monthly_rollup[m_key]["trades_count"] += 1
        if d_key in daily_rollup: daily_rollup[d_key]["trades"] += 1

        net_trade_pnl = realized_pnl - fee - (fee * 0.18)

        trade_list.append({
            "timestamp": dt.strftime("%Y-%m-%d %H:%M:%S"),
            "date": d_key,
            "symbol": symbol,
            "side": side,
            "size": size,
            "price": price,
            "gross_pnl": round(realized_pnl, 2),
            "brokerage": round(fee, 2),
            "taxes": round(fee * 0.18, 2),
            "net_pnl": round(net_trade_pnl, 2),
            "status": "WIN" if net_trade_pnl > 0 else ("LOSS" if net_trade_pnl < 0 else "BE")
        })

    # Subtract fees and taxes from the global Net PnL (since they are separated in the wallet)
    total_net_pnl = total_gross_pnl - total_brokerage - total_taxes_gst - total_taxes_tds
    core_capital = total_deposits - total_withdrawals
    reinvested_capital = max(0.0, total_deposits - max(0.0, core_capital))

    summary_payload = {
        "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC"),
        "kpis": {
            "total_deposits": round(total_deposits, 2),
            "total_withdrawals": round(total_withdrawals, 2),
            "net_core_capital": round(core_capital, 2),
            "reinvested_profits": round(reinvested_capital, 2),
            "total_gross_pnl": round(total_gross_pnl, 2),
            "total_brokerage": round(total_brokerage, 2),
            "total_taxes": round(total_taxes_tds + total_taxes_gst, 2),
            "total_net_pnl": round(total_net_pnl, 2),
            "total_trades": len(trade_list)
        },
        "monthly_breakdown": sorted(monthly_rollup.values(), key=lambda x: x["month"], reverse=True),
        "daily_breakdown": daily_rollup,
        "trades": trade_list[:15000] # Expanded from 2000 to prevent cutoff
    }

    with open("data/trade_journal.json", "w") as f:
        json.dump(summary_payload, f, indent=2)

if __name__ == "__main__":
    main()
