import os
import time
import json
import hmac
import hashlib
import base64
import requests
from datetime import datetime, timezone, timedelta

API_KEY = os.environ.get("DELTA_API_KEY", "").strip()
API_SECRET = os.environ.get("DELTA_API_SECRET", "").strip()
PROXY = os.environ.get("PROXY_URL", "").strip()
BASE_URL = "https://api.india.delta.exchange"
PROXIES = {"http": PROXY, "https": PROXY} if PROXY else None
RAW_DATA_FILE = "data/raw_data.json"

# Firebase Spark Free-Tier Configuration (Standard physio-clinic-730a1)
FIREBASE_KEY = base64.b64decode("QUl6YVN5RGRwcUFIRlJCQWliN3dYRmczZmcySUNrWFVFZTlIV184").decode("utf-8")
FIREBASE_PROJECT = "physio-clinic-730a1"
FIRESTORE_COMMIT_URL = f"https://firestore.googleapis.com/v1/projects/{FIREBASE_PROJECT}/databases/(default)/documents:commit?key={FIREBASE_KEY}"

# Free-Tier Protection: Incremental active window (default last 4 days)
FORCE_FULL_SYNC = os.environ.get("FORCE_FULL_SYNC", "false").lower() in ("true", "1")
SYNC_WINDOW_DAYS = int(os.environ.get("SYNC_WINDOW_DAYS", "4"))

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

def extract_api_data(path, existing_items=None):
    """
    Incremental API Fetcher:
    Stops pagination as soon as it encounters already-known records.
    Reduces Delta Exchange API calls from 25+ requests to 1-2 per run.
    """
    results = []
    existing_items = existing_items or []
    seen_ids = set(str(item.get("id")) for item in existing_items if item.get("id"))
    current_end = int(time.time() * 1000000)
    cutoff_time = 1704067200000000 # Stop at Jan 1, 2024
    
    print(f"Incremental sync for {path} (cached records: {len(seen_ids)})...")
    
    while current_end >= cutoff_time:
        query = f"page_size=100&end_time={current_end}"
        url = f"{BASE_URL}{path}?{query}"
        sig, ts = get_signature(API_SECRET, "GET", path, query)
        headers = {"api-key": API_KEY, "signature": sig, "timestamp": ts}
        
        try:
            res = requests.get(url, headers=headers, proxies=PROXIES, timeout=20)
            if res.status_code != 200:
                break
                
            batch = res.json().get("result", [])
            if not batch: break
                
            new_in_batch = [b for b in batch if str(b.get("id")) not in seen_ids]
            results.extend(new_in_batch)
            for b in new_in_batch:
                seen_ids.add(str(b.get("id")))
            
            # If batch contains known items, we have caught up to previous sync!
            if len(new_in_batch) < len(batch) and len(existing_items) > 0:
                print(f"Encountered existing history boundary for {path}. Halting pagination safely.")
                break
                
            if len(batch) < 100: break
                
            oldest_in_batch = min(get_ts_us(b) for b in batch)
            current_end = (current_end - 1000) if oldest_in_batch >= current_end else (oldest_in_batch - 1)
            time.sleep(0.15)
        except Exception as e:
            print(f"Fetch error: {e}")
            break
            
    # Combine newly fetched items with existing records and deduplicate
    combined = results + existing_items
    deduped = []
    seen_final = set()
    for item in combined:
        iid = str(item.get("id"))
        if iid and iid not in seen_final:
            seen_final.add(iid)
            deduped.append(item)
            
    print(f"Sync complete for {path}: {len(results)} new items fetched, total {len(deduped)} records.")
    return deduped

def parse_delta_symbol(symbol):
    if not symbol:
        return {"underlying": "BTC", "strike": 0.0, "expiry": "", "isCall": False}
    parts = symbol.split("-")
    if len(parts) >= 4:
        is_call = parts[0].upper() == "C"
        underlying = parts[1].upper()
        try:
            strike = float(parts[2])
        except:
            strike = 0.0
        expiry_raw = parts[3]
        expiry = ""
        if len(expiry_raw) == 6:
            expiry = f"20{expiry_raw[4:6]}-{expiry_raw[2:4]}-{expiry_raw[0:2]}"
        return {"underlying": underlying, "strike": strike, "expiry": expiry, "isCall": is_call}
    return {"underlying": "BTC", "strike": 0.0, "expiry": "", "isCall": symbol.startswith("C-")}

def sync_trades_to_firestore(orders, force_full=False, window_days=4):
    """
    Incremental Zero-Cost Firestore Sync:
    Only commits trades from the last `window_days` (default 4 days) to stay well under
    the Firebase Spark Free Tier limit of 20,000 writes/day.
    Historical closed trades already in Firestore are safely preserved and untouched.
    """
    valid_orders = []
    for o in orders:
        size = float(o.get("size") or 0)
        unfilled = float(o.get("unfilled_size") or 0)
        filled_size = size if o.get("state") == "closed" else max(0.0, size - unfilled)
        comm = float(o.get("paid_commission") or 0)
        gross_pnl = 0.0
        if o.get("meta_data") and o.get("meta_data", {}).get("pnl"):
            try: gross_pnl = float(o["meta_data"]["pnl"])
            except: pass
            
        if filled_size > 0 or comm > 0 or gross_pnl != 0:
            raw_ts = o.get("updated_at") or o.get("created_at") or ""
            try:
                dt = datetime.fromisoformat(raw_ts.replace("Z", "+00:00"))
            except:
                dt = datetime.now(timezone.utc)
            valid_orders.append({
                "filled_size": filled_size,
                "comm": comm,
                "gross_pnl": gross_pnl,
                "dt": dt,
                "symbol": o.get("product_symbol") or (o.get("product", {}).get("symbol") if o.get("product") else "OPTION"),
                "side": (o.get("side") or "").lower(),
                "avg_price": float(o.get("average_fill_price") or o.get("meta_data", {}).get("avg_exit_price") or o.get("limit_price") or 0)
            })

    valid_orders.sort(key=lambda x: x["dt"])
    
    open_positions = {}
    closed_trades = []
    daily_map = {}

    for vo in valid_orders:
        sym = vo["symbol"]
        if sym not in open_positions:
            open_positions[sym] = {
                "symbol": sym,
                "net_pos": 0.0,
                "buy_size": 0.0,
                "buy_val": 0.0,
                "sell_size": 0.0,
                "sell_val": 0.0,
                "gross_pnl": 0.0,
                "total_fee": 0.0,
                "start_time": vo["dt"],
                "last_time": vo["dt"]
            }
        pos = open_positions[sym]
        pos["last_time"] = vo["dt"]
        pos["gross_pnl"] += vo["gross_pnl"]
        pos["total_fee"] += vo["comm"]
        
        if vo["side"] == "buy":
            pos["net_pos"] += vo["filled_size"]
            pos["buy_size"] += vo["filled_size"]
            pos["buy_val"] += (vo["filled_size"] * vo["avg_price"])
        elif vo["side"] == "sell":
            pos["net_pos"] -= vo["filled_size"]
            pos["sell_size"] += vo["filled_size"]
            pos["sell_val"] += (vo["filled_size"] * vo["avg_price"])

        if abs(pos["net_pos"]) < 1e-5 or (pos["buy_size"] > 0 and pos["sell_size"] >= pos["buy_size"]):
            base_brokerage = pos["total_fee"] / 1.18
            gst = pos["total_fee"] - base_brokerage
            net_pnl = pos["gross_pnl"] - pos["total_fee"]
            closed_size = max(pos["buy_size"], pos["sell_size"])
            hold_sec = max(0, int((pos["last_time"] - pos["start_time"]).total_seconds()))
            avg_entry = (pos["buy_val"] / pos["buy_size"]) if pos["buy_size"] > 0 else 0.0
            avg_exit = (pos["sell_val"] / pos["sell_size"]) if pos["sell_size"] > 0 else 0.0
            
            parsed = parse_delta_symbol(sym)
            trade_id = f"trd_{sym.replace('-', '_')}_{int(pos['last_time'].timestamp() * 1000)}"
            date_key = pos["last_time"].strftime("%Y-%m-%d")
            month_key = pos["last_time"].strftime("%Y-%m")
            
            if date_key not in daily_map:
                daily_map[date_key] = {
                    "dateKey": date_key, "gross_pnl": 0.0, "base_brokerage": 0.0, "gst": 0.0,
                    "total_fee": 0.0, "net_pnl": 0.0, "trades": 0, "wins": 0, "losses": 0
                }
            d = daily_map[date_key]
            d["gross_pnl"] += pos["gross_pnl"]
            d["base_brokerage"] += base_brokerage
            d["gst"] += gst
            d["total_fee"] += pos["total_fee"]
            d["net_pnl"] += net_pnl
            d["trades"] += 1
            if net_pnl > 0: d["wins"] += 1
            elif net_pnl < 0: d["losses"] += 1

            closed_trades.append({
                "id": trade_id, "symbol": sym, "underlying": parsed["underlying"],
                "strike": parsed["strike"], "expiry": parsed["expiry"], "isCall": parsed["isCall"],
                "size": closed_size, "avgEntry": avg_entry, "avgExit": avg_exit,
                "gross_pnl": pos["gross_pnl"], "base_brokerage": base_brokerage, "gst": gst,
                "total_fee": pos["total_fee"], "net_pnl": net_pnl,
                "status": "WIN" if net_pnl > 0 else ("LOSS" if net_pnl < 0 else "BE"),
                "dateKey": date_key, "monthKey": month_key,
                "timestamp": pos["last_time"].strftime("%d %b %Y, %I:%M %p"),
                "holdDurationSec": hold_sec
            })
            del open_positions[sym]

    # Free-Tier Cutoff Filter
    if not force_full:
        cutoff_date = (datetime.now(timezone.utc) - timedelta(days=window_days)).strftime("%Y-%m-%d")
        trades_to_sync = [t for t in closed_trades if t["dateKey"] >= cutoff_date]
        daily_to_sync = {k: v for k, v in daily_map.items() if k >= cutoff_date}
        print(f"Free-Tier Delta Mode: Syncing {len(trades_to_sync)} active trades (since {cutoff_date}) out of {len(closed_trades)} total.")
    else:
        trades_to_sync = closed_trades
        daily_to_sync = daily_map
        print(f"Full-Sync Mode: Syncing all {len(trades_to_sync)} trades to Firestore.")

    if not trades_to_sync:
        print("No trades in active window to sync. 0 Firestore writes consumed.")
        return

    batch_size = 50
    for i in range(0, len(trades_to_sync), batch_size):
        chunk = trades_to_sync[i:i + batch_size]
        writes = []
        for t in chunk:
            doc_path = f"projects/{FIREBASE_PROJECT}/databases/(default)/documents/GP_DTJ_trades/{t['id']}"
            writes.append({
                "update": {
                    "name": doc_path,
                    "fields": {
                        "id": {"stringValue": str(t["id"])},
                        "symbol": {"stringValue": str(t["symbol"])},
                        "underlying": {"stringValue": str(t["underlying"])},
                        "strike": {"doubleValue": float(t["strike"])},
                        "expiry": {"stringValue": str(t["expiry"])},
                        "isCall": {"booleanValue": bool(t["isCall"])},
                        "size": {"doubleValue": float(t["size"])},
                        "avgEntry": {"doubleValue": float(t["avgEntry"])},
                        "avgExit": {"doubleValue": float(t["avgExit"])},
                        "gross_pnl": {"doubleValue": float(t["gross_pnl"])},
                        "base_brokerage": {"doubleValue": float(t["base_brokerage"])},
                        "gst": {"doubleValue": float(t["gst"])},
                        "total_fee": {"doubleValue": float(t["total_fee"])},
                        "net_pnl": {"doubleValue": float(t["net_pnl"])},
                        "status": {"stringValue": str(t["status"])},
                        "rawDate": {"stringValue": str(t["dateKey"])},
                        "monthKey": {"stringValue": str(t["monthKey"])},
                        "timestamp": {"stringValue": str(t["timestamp"])},
                        "holdDurationSec": {"integerValue": int(t["holdDurationSec"])},
                        "lastSynced": {"stringValue": datetime.now(timezone.utc).isoformat()}
                    }
                },
                "updateMask": {
                    "fieldPaths": [
                        "id", "symbol", "underlying", "strike", "expiry", "isCall",
                        "size", "avgEntry", "avgExit", "gross_pnl", "base_brokerage",
                        "gst", "total_fee", "net_pnl", "status", "rawDate", "monthKey",
                        "timestamp", "holdDurationSec", "lastSynced"
                    ]
                }
            })
        try:
            res = requests.post(FIRESTORE_COMMIT_URL, json={"writes": writes}, timeout=20)
            if res.status_code == 200:
                print(f"Firestore batch committed: {i + len(chunk)}/{len(trades_to_sync)} trades.")
            else:
                print(f"Firestore batch error: HTTP {res.status_code} - {res.text[:100]}")
        except Exception as e:
            print(f"Firestore batch warning: {e}")

    # Commit active daily metrics (usually 1-4 writes)
    daily_writes = []
    for dk, item in daily_to_sync.items():
        doc_path = f"projects/{FIREBASE_PROJECT}/databases/(default)/documents/GP_DTJ_daily_metrics/{dk}"
        daily_writes.append({
            "update": {
                "name": doc_path,
                "fields": {
                    "dateKey": {"stringValue": str(dk)},
                    "gross_pnl": {"doubleValue": float(item["gross_pnl"])},
                    "base_brokerage": {"doubleValue": float(item["base_brokerage"])},
                    "gst": {"doubleValue": float(item["gst"])},
                    "total_fee": {"doubleValue": float(item["total_fee"])},
                    "net_pnl": {"doubleValue": float(item["net_pnl"])},
                    "trades": {"integerValue": int(item["trades"])},
                    "wins": {"integerValue": int(item["wins"])},
                    "losses": {"integerValue": int(item["losses"])}
                }
            }
        })
    if daily_writes:
        try:
            requests.post(FIRESTORE_COMMIT_URL, json={"writes": daily_writes}, timeout=20)
            print(f"Active daily metrics ({len(daily_to_sync)} days) committed to GP_DTJ_daily_metrics.")
        except Exception as e:
            print(f"Daily metrics sync notice: {e}")

def main():
    os.makedirs("data", exist_ok=True)
    
    # Load existing cached data to enable incremental Delta fetching
    existing_raw = {}
    if os.path.exists(RAW_DATA_FILE):
        try:
            with open(RAW_DATA_FILE, "r") as f:
                existing_raw = json.load(f)
        except Exception:
            existing_raw = {}
            
    existing_txs = existing_raw.get("wallet_txs", [])
    existing_orders = existing_raw.get("orders", [])
    
    raw_dump = {"generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")}
    
    # 1. Incremental extraction from Delta Exchange API
    wallet_txs = extract_api_data("/v2/wallet/transactions", existing_txs)
    
    for tx in wallet_txs:
        raw_ts = tx.get("created_at") or tx.get("updated_at") or tx.get("timestamp")
        if raw_ts:
            try:
                if isinstance(raw_ts, (int, float)):
                    sec = raw_ts / 1000000 if raw_ts > 10**12 else raw_ts / 1000 if raw_ts > 10**10 else raw_ts
                    tx["created_at"] = datetime.fromtimestamp(sec, tz=timezone.utc).isoformat()
                else:
                    tx["created_at"] = str(raw_ts)
            except Exception:
                tx["created_at"] = datetime.now(timezone.utc).isoformat()
        else:
            tx["created_at"] = datetime.now(timezone.utc).isoformat()

    orders = extract_api_data("/v2/orders/history", existing_orders)
    raw_dump["wallet_txs"] = wallet_txs
    raw_dump["orders"] = orders

    # 2. Save local bootstrap JSON
    with open(RAW_DATA_FILE, "w") as f:
        json.dump(raw_dump, f, indent=2)

    # 3. Incremental Zero-Cost Sync to Firebase Firestore (last 4 days active window)
    if orders:
        sync_trades_to_firestore(orders, force_full=FORCE_FULL_SYNC, window_days=SYNC_WINDOW_DAYS)

if __name__ == "__main__":
    main()
