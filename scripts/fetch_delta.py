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

# Configure static proxy dictionary if provided
PROXIES = {"http": PROXY_URL, "https": PROXY_URL} if PROXY_URL else None

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
        "User-Agent": "TradingJournalEngine/1.0"
    }
    try:
        res = requests.get(url, headers=headers, proxies=PROXIES, timeout=25)
        print(f"DEBUG: GET {path}{'?' + query if query else ''} -> HTTP {res.status_code}")
        
        try:
            data = res.json()
        except Exception:
            print(f"DEBUG: Response not JSON: {res.text[:200]}")
            return []
            
        if not data.get("success", False) and "result" not in data:
            print(f"DEBUG: API Error response: {data}")
            return []
            
        result = data.get("result", [])
        print(f"DEBUG: Found {len(result) if isinstance(result, list) else 'non-list'} records in {path}")
        return result if isinstance(result, list) else []
    except Exception as e:
        print(f"DEBUG: Exception requesting {path}: {str(e)}")
        return []

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
    print(f"Target URL: {BASE_URL}")
    print(f"Proxy Active: {'Yes' if PROXY_URL else 'No'}")
    print(f"API Key present: {'Yes' if API_KEY else 'No'}, Secret present: {'Yes' if API_SECRET else 'No'}")

    # Verify IP being used
    if PROXY_URL:
        try:
            ip_check = requests.get("https://api.ipify.org?format=json", proxies=PROXIES, timeout=10).json()
            print(f"DEBUG: Current outbound proxy IP is {ip_check.get('ip')}")
        except Exception as e:
            print(f"DEBUG: Could not verify outbound IP: {str(e)}")

    print("\n--- Pulling Wallet Transactions ---")
    raw_wallet_txs = delta_api_get("/v2/wallet/transactions", "page_size=100")

    print("\n--- Pulling Fills ---")
    raw_fills = delta_api_get("/v2/fills", "page_size=100")
    
    if not raw_fills:
        print("\n--- Checking /v2/orders/history ---")
        raw_fills = delta_api_get("/v2/orders/history", "state=closed&page_size=100")

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

    for tx in raw_wallet_txs:
        tx_type = str(tx.get("transaction_type", "")).lower()
        amount = abs(float(tx.get("amount", 0.0) or 0.0))
        dt = parse_delta_date(tx.get("created_at"))
        d_key = dt.strftime("%Y-%m-%d")
        m_key = dt.strftime("%Y-%m")

        if "deposit" in tx_type:
            total_deposits += amount
        elif "withdrawal" in tx_type:
            total_withdrawals += amount
        elif "tds" in tx_type:
            total_taxes_tds += amount
        elif "gst" in tx_type:
            total_taxes_gst += amount

        if m_key not in monthly_rollup:
            monthly_rollup[m_key] = {
                "month": m_key, "deposits": 0.0, "withdrawals": 0.0,
                "gross_pnl": 0.0, "brokerage": 0.0, "taxes": 0.0, "net_pnl": 0.0, "trades_count": 0
            }
        if "deposit" in tx_type:
            monthly_rollup[m_key]["deposits"] += amount
        elif "withdrawal" in tx_type:
            monthly_rollup[m_key]["withdrawals"] += amount

    for fill in raw_fills:
        fee = abs(float(fill.get("fee", 0.0) or fill.get("commission", 0.0) or 0.0))
        realized_pnl = float(fill.get("realized_pnl", 0.0) or fill.get("pnl", 0.0) or 0.0)
        symbol = fill.get("symbol", fill.get("product_symbol", "OPTION"))
        size = float(fill.get("size", 0.0) or 0.0)
        price = float(fill.get("price", 0.0) or fill.get("average_fill_price", 0.0) or 0.0)
        side = fill.get("side", "buy").upper()
        dt = parse_delta_date(fill.get("created_at") or fill.get("updated_at"))
        d_key = dt.strftime("%Y-%m-%d")
        m_key = dt.strftime("%Y-%m")

        gst_portion = fee * 0.18
        gross_trade_pnl = realized_pnl + fee
        net_trade_pnl = realized_pnl - gst_portion

        total_brokerage += fee
        total_taxes_gst += gst_portion
        total_gross_pnl += gross_trade_pnl
        total_net_pnl += net_trade_pnl

        if d_key not in daily_rollup:
            daily_rollup[d_key] = {
                "date": d_key, "trades": 0, "gross_pnl": 0.0,
                "brokerage": 0.0, "taxes": 0.0, "net_pnl": 0.0
            }
        daily_rollup[d_key]["trades"] += 1
        daily_rollup[d_key]["gross_pnl"] += gross_trade_pnl
        daily_rollup[d_key]["brokerage"] += fee
        daily_rollup[d_key]["taxes"] += gst_portion
        daily_rollup[d_key]["net_pnl"] += net_trade_pnl

        if m_key not in monthly_rollup:
            monthly_rollup[m_key] = {
                "month": m_key, "deposits": 0.0, "withdrawals": 0.0,
                "gross_pnl": 0.0, "brokerage": 0.0, "taxes": 0.0, "net_pnl": 0.0, "trades_count": 0
            }
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
        "trades": trade_list[:200]
    }

    os.makedirs("data", exist_ok=True)
    with open("data/trade_journal.json", "w") as f:
        json.dump(summary_payload, f, indent=2)
    print("Done writing data/trade_journal.json.")

if __name__ == "__main__":
    main()
