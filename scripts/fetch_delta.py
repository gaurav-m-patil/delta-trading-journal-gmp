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
RAW_DATA_FILE = "data/raw_data.json"

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

def extract_api_data(path):
    results = []
    seen_ids = set()
    current_end = int(time.time() * 1000000)
    cutoff_time = 1704067200000000 # Stop at Jan 1, 2024
    
    print(f"Extracting raw dump for {path}...")
    
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
                
            unique_batch = [b for b in batch if str(b.get("id")) not in seen_ids]
            results.extend(unique_batch)
            for b in unique_batch: seen_ids.add(str(b.get("id")))
            
            if len(batch) < 100: break
                
            oldest_in_batch = min(get_ts_us(b) for b in batch)
            current_end = (current_end - 1000) if oldest_in_batch >= current_end else (oldest_in_batch - 1)
            time.sleep(0.15)
        except Exception:
            break
            
    return results

def main():
    os.makedirs("data", exist_ok=True)
    raw_dump = {"generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")}
    
    # Extract everything raw. The HTML/JavaScript will do the math later.
    raw_dump["wallet_txs"] = extract_api_data("/v2/wallet/transactions")
    raw_dump["orders"] = extract_api_data("/v2/orders/history")

    # Bundle the Gemini API key silently into the JSON
    raw_dump["gemini_api_key"] = os.environ.get("GEMINI_API_KEY", "").strip()
    
    with open(RAW_DATA_FILE, "w") as f:
        json.dump(raw_dump, f, indent=2)

if __name__ == "__main__":
    main()
