/**
 * Delta Trading Journal - Local-First High-Performance Persistence Engine
 * Powers Instant Offline Boot (IndexedDB) & Zero-Cost Firebase Firestore Synchronization
 * Standardized Collections: GP_DTJ_trades, GP_DTJ_daily_metrics, GP_DTJ_tags, GP_DTJ_settings
 */

window.DeltaDB = (function() {
  const DB_NAME = "DeltaJournalDB";
  const DB_VERSION = 1;
  const STORE_TRADES = "trades";
  const STORE_DAILY = "daily_metrics";
  const STORE_TAGS = "tags";
  const STORE_META = "meta";

  let dbInstance = null;
  let inMemoryTrades = [];
  let inMemoryDailyMap = {};
  let inMemoryMonthlyMap = {};
  let firestoreDb = null;
  let listeners = [];
  let isSyncing = false;

  // -------------------------------------------------------------
  // 1. INDEXEDDB LOCAL-FIRST BOOTSTRAP
  // -------------------------------------------------------------
  function openDatabase() {
    return new Promise((resolve, reject) => {
      if (dbInstance) return resolve(dbInstance);

      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = function(e) {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(STORE_TRADES)) {
          const tradeStore = db.createObjectStore(STORE_TRADES, { keyPath: "id" });
          tradeStore.createIndex("rawDate", "rawDate", { unique: false });
          tradeStore.createIndex("symbol", "symbol", { unique: false });
          tradeStore.createIndex("status", "status", { unique: false });
          tradeStore.createIndex("isCall", "isCall", { unique: false });
          tradeStore.createIndex("sortTime", "sortTime", { unique: false });
        }
        if (!db.objectStoreNames.contains(STORE_DAILY)) {
          db.createObjectStore(STORE_DAILY, { keyPath: "dateKey" });
        }
        if (!db.objectStoreNames.contains(STORE_TAGS)) {
          db.createObjectStore(STORE_TAGS, { keyPath: "name" });
        }
        if (!db.objectStoreNames.contains(STORE_META)) {
          db.createObjectStore(STORE_META, { keyPath: "key" });
        }
      };

      request.onsuccess = function(e) {
        dbInstance = e.target.result;
        resolve(dbInstance);
      };

      request.onerror = function(e) {
        console.error("DeltaJournalDB open error:", e);
        reject(e);
      };
    });
  }

  // -------------------------------------------------------------
  // 2. DELTA OPTIONS SYMBOL PARSER (Fixes Call/Put & Strike Extraction)
  // -------------------------------------------------------------
  function parseDeltaSymbol(symbol) {
    if (!symbol) return { symbol: "UNKNOWN", type: "OTHER", isCall: false, isPut: false, underlying: "BTC", strike: 0, expiry: "" };

    const parts = symbol.split('-');
    if (parts.length >= 4) {
      const typeCode = parts[0].toUpperCase();
      const isCall = typeCode === 'C';
      const isPut = typeCode === 'P';
      const underlying = parts[1].toUpperCase();
      const strike = parseFloat(parts[2]) || 0;
      const expiryRaw = parts[3]; // DDMMYY format (e.g. 191026 -> 19-Oct-2026)
      let expiryFormatted = "";
      if (expiryRaw.length === 6) {
        const day = expiryRaw.substring(0, 2);
        const month = expiryRaw.substring(2, 4);
        const year = "20" + expiryRaw.substring(4, 6);
        expiryFormatted = `${year}-${month}-${day}`;
      }
      return {
        symbol,
        type: isCall ? 'CALL' : (isPut ? 'PUT' : 'OTHER'),
        isCall,
        isPut,
        underlying,
        strike,
        expiry: expiryFormatted
      };
    }

    // Fallback for non-standard option or perp symbols
    const isCall = symbol.startsWith('C-');
    const isPut = symbol.startsWith('P-');
    return {
      symbol,
      type: isCall ? 'CALL' : (isPut ? 'PUT' : 'PERP'),
      isCall,
      isPut,
      underlying: symbol.includes('BTC') ? 'BTC' : (symbol.includes('ETH') ? 'ETH' : 'CRYPTO'),
      strike: 0,
      expiry: ""
    };
  }

  // -------------------------------------------------------------
  // 3. RAW DELTA DATA NORMALIZATION ENGINE
  // -------------------------------------------------------------
  function processRawDumpToTrades(rawDump) {
    const istFormatter = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' });
    const getIstDayKey = (dateObj) => {
      if (!dateObj || isNaN(dateObj.getTime())) dateObj = new Date();
      const parts = istFormatter.formatToParts(dateObj);
      const y = parts.find(p => p.type === 'year')?.value || dateObj.getFullYear();
      const m = parts.find(p => p.type === 'month')?.value || String(dateObj.getMonth() + 1).padStart(2, '0');
      const d = parts.find(p => p.type === 'day')?.value || String(dateObj.getDate()).padStart(2, '0');
      return { dayKey: `${y}-${m}-${d}`, monthKey: `${y}-${m}` };
    };

    const validOrders = [];
    (rawDump.orders || []).forEach(order => {
      const totalSize = parseFloat(order.size || 0);
      const unfilled = parseFloat(order.unfilled_size || 0);
      const filledSize = order.state === 'closed' ? totalSize : Math.max(0, totalSize - unfilled);
      const commission = parseFloat(order.paid_commission || 0);
      const grossPnl = parseFloat(order.meta_data?.pnl || 0);

      if (filledSize <= 0 && commission === 0 && grossPnl === 0) return;

      validOrders.push({
        ...order,
        filledSize,
        commission,
        grossPnl,
        execTime: new Date(order.updated_at || order.created_at || Date.now())
      });
    });

    validOrders.sort((a, b) => a.execTime - b.execTime);

    const openPositions = {};
    const closedTrades = [];

    validOrders.forEach(order => {
      const symbol = order.product_symbol || order.product?.symbol || "OPTION";
      const side = (order.side || "").toLowerCase();
      const fillPrice = parseFloat(order.average_fill_price || order.meta_data?.avg_exit_price || order.limit_price || 0);
      const parsedSym = parseDeltaSymbol(symbol);

      if (!openPositions[symbol]) {
        openPositions[symbol] = {
          symbol,
          parsedSym,
          isCall: parsedSym.isCall,
          isPut: parsedSym.isPut,
          underlying: parsedSym.underlying,
          strike: parsedSym.strike,
          expiry: parsedSym.expiry,
          netPosition: 0,
          buySize: 0,
          buyValue: 0,
          sellSize: 0,
          sellValue: 0,
          gross_pnl: 0,
          total_fee: 0,
          startTime: order.execTime,
          lastTime: order.execTime,
          fillsCount: 0
        };
      }

      const pos = openPositions[symbol];
      pos.lastTime = order.execTime;
      pos.fillsCount++;

      if (!isNaN(order.grossPnl)) pos.gross_pnl += order.grossPnl;
      if (!isNaN(order.commission)) pos.total_fee += order.commission;

      if (side === 'buy') {
        pos.netPosition += order.filledSize;
        pos.buySize += order.filledSize;
        pos.buyValue += (order.filledSize * fillPrice);
      } else if (side === 'sell') {
        pos.netPosition -= order.filledSize;
        pos.sellSize += order.filledSize;
        pos.sellValue += (order.filledSize * fillPrice);
      }

      // Check if position closed
      if (Math.abs(pos.netPosition) < 1e-6 || (pos.buySize > 0 && pos.sellSize >= pos.buySize)) {
        const { dayKey, monthKey } = getIstDayKey(pos.lastTime);
        const baseBrokerage = pos.total_fee / 1.18;
        const gst = pos.total_fee - baseBrokerage;
        const netPnl = pos.gross_pnl - pos.total_fee;
        const closedSize = Math.max(pos.buySize, pos.sellSize);
        const holdDurationSec = Math.max(0, Math.round((pos.lastTime - pos.startTime) / 1000));
        const avgEntry = pos.buySize > 0 ? (pos.buyValue / pos.buySize) : 0;
        const avgExit = pos.sellSize > 0 ? (pos.sellValue / pos.sellSize) : 0;

        const tradeId = `trd_${pos.symbol}_${pos.lastTime.getTime()}`;

        closedTrades.push({
          id: tradeId,
          timestamp: pos.lastTime.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: true }),
          sortTime: pos.lastTime.getTime(),
          openedAt: pos.startTime.toISOString(),
          closedAt: pos.lastTime.toISOString(),
          holdDurationSec: holdDurationSec,
          rawDate: dayKey,
          monthKey: monthKey,
          symbol: pos.symbol,
          underlying: pos.underlying,
          strike: pos.strike,
          expiry: pos.expiry,
          isCall: pos.isCall,
          isPut: pos.isPut,
          size: closedSize,
          avgEntry: avgEntry,
          avgExit: avgExit,
          gross_pnl: pos.gross_pnl,
          base_brokerage: baseBrokerage,
          gst: gst,
          total_fee: pos.total_fee,
          net_pnl: netPnl,
          status: netPnl > 0 ? 'WIN' : (netPnl < 0 ? 'LOSS' : 'BE'),
          tags: [],             // Enriched SMC tags
          notes: "",            // Journal narrative
          screenshots: [],      // Image attachments
          executionDiscipline: 5 // Default rating 1-5
        });

        delete openPositions[symbol];
      }
    });

    // Residual positions
    Object.values(openPositions).forEach(pos => {
      if (pos.gross_pnl !== 0 || pos.total_fee !== 0) {
        const { dayKey, monthKey } = getIstDayKey(pos.lastTime);
        const baseBrokerage = pos.total_fee / 1.18;
        const gst = pos.total_fee - baseBrokerage;
        const netPnl = pos.gross_pnl - pos.total_fee;
        const holdDurationSec = Math.max(0, Math.round((pos.lastTime - pos.startTime) / 1000));
        const tradeId = `trd_${pos.symbol}_${pos.lastTime.getTime()}`;

        closedTrades.push({
          id: tradeId,
          timestamp: pos.lastTime.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: true }),
          sortTime: pos.lastTime.getTime(),
          openedAt: pos.startTime.toISOString(),
          closedAt: pos.lastTime.toISOString(),
          holdDurationSec: holdDurationSec,
          rawDate: dayKey,
          monthKey: monthKey,
          symbol: pos.symbol,
          underlying: pos.underlying,
          strike: pos.strike,
          expiry: pos.expiry,
          isCall: pos.isCall,
          isPut: pos.isPut,
          size: Math.max(pos.buySize, pos.sellSize),
          avgEntry: pos.buySize > 0 ? (pos.buyValue / pos.buySize) : 0,
          avgExit: pos.sellSize > 0 ? (pos.sellValue / pos.sellSize) : 0,
          gross_pnl: pos.gross_pnl,
          base_brokerage: baseBrokerage,
          gst: gst,
          total_fee: pos.total_fee,
          net_pnl: netPnl,
          status: netPnl > 0 ? 'WIN' : (netPnl < 0 ? 'LOSS' : 'BE'),
          tags: [],
          notes: "",
          screenshots: [],
          executionDiscipline: 5
        });
      }
    });

    return closedTrades.sort((a, b) => b.sortTime - a.sortTime);
  }

  // -------------------------------------------------------------
  // 4. DAILY & MONTHLY AGGREGATIONS BUILDER
  // -------------------------------------------------------------
  function buildAggregations(trades) {
    const dailyMap = {};
    const monthlyMap = {};

    trades.forEach(trade => {
      const { rawDate: dayKey, monthKey, net_pnl: netPnl, gross_pnl: grossPnl, base_brokerage: brok, gst, total_fee: fee } = trade;

      if (!dailyMap[dayKey]) {
        dailyMap[dayKey] = {
          dateKey: dayKey,
          gross_pnl: 0,
          base_brokerage: 0,
          gst: 0,
          total_fee: 0,
          net_pnl: 0,
          trades: 0,
          wins: 0,
          losses: 0,
          be: 0
        };
      }
      dailyMap[dayKey].gross_pnl += grossPnl;
      dailyMap[dayKey].base_brokerage += brok;
      dailyMap[dayKey].gst += gst;
      dailyMap[dayKey].total_fee += fee;
      dailyMap[dayKey].net_pnl += netPnl;
      dailyMap[dayKey].trades += 1;
      if (netPnl > 0) dailyMap[dayKey].wins += 1;
      else if (netPnl < 0) dailyMap[dayKey].losses += 1;
      else dailyMap[dayKey].be += 1;

      if (!monthlyMap[monthKey]) {
        monthlyMap[monthKey] = {
          month: monthKey,
          gross_pnl: 0,
          base_brokerage: 0,
          gst: 0,
          total_fee: 0,
          net_pnl: 0,
          trades: 0,
          wins: 0,
          losses: 0
        };
      }
      monthlyMap[monthKey].gross_pnl += grossPnl;
      monthlyMap[monthKey].base_brokerage += brok;
      monthlyMap[monthKey].gst += gst;
      monthlyMap[monthKey].total_fee += fee;
      monthlyMap[monthKey].net_pnl += netPnl;
      monthlyMap[monthKey].trades += 1;
      if (netPnl > 0) monthlyMap[monthKey].wins += 1;
      else if (netPnl < 0) monthlyMap[monthKey].losses += 1;
    });

    return { dailyMap, monthlyMap };
  }

  // -------------------------------------------------------------
  // 5. DATABASE INITIALIZATION & CONTINUOUS HYDRATION
  // -------------------------------------------------------------
  async function init() {
    await openDatabase();

    // 1. Instantly load existing records from local IndexedDB (zero network latency!)
    let localTrades = await getAllFromStore(STORE_TRADES);

    if (localTrades.length > 0) {
      inMemoryTrades = localTrades.sort((a, b) => b.sortTime - a.sortTime);
      const { dailyMap, monthlyMap } = buildAggregations(inMemoryTrades);
      inMemoryDailyMap = dailyMap;
      inMemoryMonthlyMap = monthlyMap;
      notifyListeners({ type: "ready", count: inMemoryTrades.length });
    }

    // 2. Continuous Hydration: Check raw_data.json to merge any new trades from recent sync runs!
    await syncFromRawData(localTrades.length === 0);

    // 3. Initialize Firebase in background if configured
    const fbConfig = getFirebaseConfig();
    if (fbConfig && fbConfig.projectId) {
      initFirebase(fbConfig);
    }

    return inMemoryTrades;
  }

  /**
   * Fetches the latest data/raw_data.json (bypassing cache) and merges newly synced trades into IndexedDB
   */
  async function syncFromRawData(forceNotify = false) {
    try {
      console.log("Checking raw_data.json for new trades...");
      const res = await fetch(DeltaConfig.RAW_DATA_URL + "?t=" + Date.now(), {
        cache: 'no-store'
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const rawDump = await res.json();
      const freshTrades = processRawDumpToTrades(rawDump);

      if (!freshTrades || freshTrades.length === 0) return 0;

      let localTrades = await getAllFromStore(STORE_TRADES);
      const localMap = new Map();
      localTrades.forEach(t => localMap.set(t.id, t));

      let newlyAdded = 0;
      let updatedCount = 0;

      for (const t of freshTrades) {
        const existing = localMap.get(t.id);
        if (!existing) {
          // Brand new trade (e.g. today's newly synced trade)
          await putToStore(STORE_TRADES, t);
          localMap.set(t.id, t);
          newlyAdded++;
        } else {
          // Check if status or PnL was updated from an open to closed position
          if (existing.status !== t.status || Math.abs((existing.net_pnl || 0) - (t.net_pnl || 0)) > 0.01) {
            const merged = {
              ...t,
              tags: existing.tags || [],
              notes: existing.notes || "",
              screenshots: existing.screenshots || [],
              executionDiscipline: existing.executionDiscipline || 5
            };
            await putToStore(STORE_TRADES, merged);
            localMap.set(t.id, merged);
            updatedCount++;
          }
        }
      }

      if (newlyAdded > 0 || updatedCount > 0 || forceNotify || inMemoryTrades.length === 0) {
        inMemoryTrades = Array.from(localMap.values()).sort((a, b) => b.sortTime - a.sortTime);
        const { dailyMap, monthlyMap } = buildAggregations(inMemoryTrades);
        inMemoryDailyMap = dailyMap;
        inMemoryMonthlyMap = monthlyMap;

        console.log(`[DeltaDB] Sync complete: ${newlyAdded} new trades added, ${updatedCount} updated. Total: ${inMemoryTrades.length}`);
        notifyListeners({ type: "ready", count: inMemoryTrades.length, newlyAdded, updatedCount });
      }

      return newlyAdded + updatedCount;
    } catch (err) {
      console.warn("Raw data hydration notice:", err);
      return 0;
    }
  }

  // -------------------------------------------------------------
  // 6. INDEXEDDB PRIMITIVE HELPERS
  // -------------------------------------------------------------
  function getAllFromStore(storeName) {
    return new Promise((resolve) => {
      if (!dbInstance) return resolve([]);
      const tx = dbInstance.transaction(storeName, "readonly");
      const store = tx.objectStore(storeName);
      const req = store.getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => resolve([]);
    });
  }

  function getFromStore(storeName, key) {
    return new Promise((resolve) => {
      if (!dbInstance) return resolve(null);
      const tx = dbInstance.transaction(storeName, "readonly");
      const store = tx.objectStore(storeName);
      const req = store.get(key);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
    });
  }

  function putToStore(storeName, record) {
    return new Promise((resolve, reject) => {
      if (!dbInstance) return resolve();
      const tx = dbInstance.transaction(storeName, "readwrite");
      const store = tx.objectStore(storeName);
      const req = store.put(record);
      req.onsuccess = () => resolve();
      req.onerror = (e) => reject(e);
    });
  }

  function bulkInsertTrades(trades) {
    return new Promise((resolve, reject) => {
      if (!dbInstance) return resolve();
      const tx = dbInstance.transaction([STORE_TRADES, STORE_DAILY], "readwrite");
      const tradeStore = tx.objectStore(STORE_TRADES);
      const dailyStore = tx.objectStore(STORE_DAILY);

      trades.forEach(t => tradeStore.put(t));

      const { dailyMap } = buildAggregations(trades);
      Object.values(dailyMap).forEach(d => dailyStore.put(d));

      tx.oncomplete = () => resolve();
      tx.onerror = (e) => reject(e);
    });
  }

  // -------------------------------------------------------------
  // 7. FIREBASE FIRESTORE SYNC ENGINE (GP_DTJ_* Standard)
  // -------------------------------------------------------------
  function getFirebaseConfig() {
    try {
      const cfg = localStorage.getItem(DeltaConfig.STORAGE_KEYS.FIREBASE_CONFIG);
      return cfg ? JSON.parse(cfg) : DeltaConfig.FIREBASE_CONFIG;
    } catch (e) {
      return DeltaConfig.FIREBASE_CONFIG;
    }
  }

  function initFirebase(config) {
    if (!config || !config.projectId || typeof firebase === 'undefined') return false;
    try {
      if (!firebase.apps.length) {
        firebase.initializeApp(config);
      }
      firestoreDb = firebase.firestore();
      firestoreDb.enablePersistence({ synchronizeTabs: true }).catch(() => {});
      return true;
    } catch (err) {
      console.warn("Firestore initialization notice:", err.message);
      try {
        firestoreDb = firebase.firestore();
        return true;
      } catch (e) {
        return false;
      }
    }
  }

  /**
   * Syncs user-enriched records (tags, notes, screenshots) to Firestore
   * Strictly limits operations to batches of 50-500 to stay well within free-tier quotas.
   */
  async function syncToFirestore(progressCallback) {
    const config = getFirebaseConfig();
    if (!firestoreDb) {
      const ok = initFirebase(config);
      if (!ok) throw new Error("Firebase is not initialized. Please verify configuration in Settings.");
    }

    if (inMemoryTrades.length === 0) throw new Error("No trade records available to sync.");

    const batchSize = 100;
    const total = inMemoryTrades.length;
    let committed = 0;

    for (let i = 0; i < total; i += batchSize) {
      const chunk = inMemoryTrades.slice(i, i + batchSize);
      const batch = firestoreDb.batch();

      chunk.forEach(t => {
        const docRef = firestoreDb.collection(DeltaConfig.FIRESTORE_COLLECTIONS.TRADES).doc(t.id);
        batch.set(docRef, {
          id: t.id,
          symbol: t.symbol,
          underlying: t.underlying || "BTC",
          strike: t.strike || 0,
          expiry: t.expiry || "",
          isCall: t.isCall || false,
          isPut: t.isPut || false,
          size: t.size || 0,
          avgEntry: t.avgEntry || 0,
          avgExit: t.avgExit || 0,
          gross_pnl: t.gross_pnl || 0,
          base_brokerage: t.base_brokerage || 0,
          gst: t.gst || 0,
          total_fee: t.total_fee || 0,
          net_pnl: t.net_pnl || 0,
          status: t.status || "BE",
          rawDate: t.rawDate,
          monthKey: t.monthKey,
          timestamp: t.timestamp,
          sortTime: t.sortTime,
          holdDurationSec: t.holdDurationSec || 0,
          tags: t.tags || [],
          notes: t.notes || "",
          screenshots: t.screenshots || [],
          executionDiscipline: t.executionDiscipline || 5,
          updatedAt: new Date().toISOString()
        }, { merge: true });
      });

      await batch.commit();
      committed += chunk.length;
      if (progressCallback) progressCallback(committed, total);
    }

    // Also commit aggregated daily summaries for fast 0-cost reads
    const dailyBatch = firestoreDb.batch();
    Object.values(inMemoryDailyMap).forEach(d => {
      const docRef = firestoreDb.collection(DeltaConfig.FIRESTORE_COLLECTIONS.DAILY_METRICS).doc(d.dateKey);
      dailyBatch.set(docRef, d, { merge: true });
    });
    await dailyBatch.commit();

    localStorage.setItem(DeltaConfig.STORAGE_KEYS.LAST_SYNC, new Date().toISOString());
    return committed;
  }

  // -------------------------------------------------------------
  // 8. TRADE ENRICHMENT APIS (SMC Tags, Notes, Screenshots)
  // -------------------------------------------------------------
  async function updateTradeEnrichment(tradeId, updates) {
    const trade = inMemoryTrades.find(t => t.id === tradeId);
    if (!trade) return false;

    if (updates.tags !== undefined) trade.tags = updates.tags;
    if (updates.notes !== undefined) trade.notes = updates.notes;
    if (updates.screenshots !== undefined) trade.screenshots = updates.screenshots;
    if (updates.executionDiscipline !== undefined) trade.executionDiscipline = updates.executionDiscipline;

    // Update in local IndexedDB
    await putToStore(STORE_TRADES, trade);

    // If Firestore is available, sync single document update (1 write)
    if (firestoreDb) {
      try {
        const docRef = firestoreDb.collection(DeltaConfig.FIRESTORE_COLLECTIONS.TRADES).doc(tradeId);
        await docRef.set({
          tags: trade.tags,
          notes: trade.notes,
          screenshots: trade.screenshots,
          executionDiscipline: trade.executionDiscipline,
          updatedAt: new Date().toISOString()
        }, { merge: true });
      } catch (err) {
        console.warn("Async Firestore update queued locally:", err);
      }
    }

    notifyListeners({ type: "trade_updated", tradeId, trade });
    return true;
  }

  async function addTagToTrade(tradeId, tagName) {
    const trade = inMemoryTrades.find(t => t.id === tradeId);
    if (!trade) return;
    if (!trade.tags) trade.tags = [];
    if (!trade.tags.includes(tagName)) {
      trade.tags.push(tagName);
      await updateTradeEnrichment(tradeId, { tags: trade.tags });
    }
  }

  async function removeTagFromTrade(tradeId, tagName) {
    const trade = inMemoryTrades.find(t => t.id === tradeId);
    if (!trade || !trade.tags) return;
    trade.tags = trade.tags.filter(t => t !== tagName);
    await updateTradeEnrichment(tradeId, { tags: trade.tags });
  }

  async function attachScreenshot(tradeId, imageDataUrl, caption = "") {
    const trade = inMemoryTrades.find(t => t.id === tradeId);
    if (!trade) return;
    if (!trade.screenshots) trade.screenshots = [];
    trade.screenshots.push({
      id: "img_" + Date.now(),
      dataUrl: imageDataUrl,
      caption: caption,
      createdAt: new Date().toISOString()
    });
    await updateTradeEnrichment(tradeId, { screenshots: trade.screenshots });
  }

  // -------------------------------------------------------------
  // 9. EXPORT & BACKUP TOOLS
  // -------------------------------------------------------------
  function exportJSONBackup() {
    const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify({
      appName: DeltaConfig.APP_NAME,
      exportedAt: new Date().toISOString(),
      trades: inMemoryTrades,
      dailySummaries: inMemoryDailyMap
    }, null, 2));
    const dlAnchorElem = document.createElement('a');
    dlAnchorElem.setAttribute("href", dataStr);
    dlAnchorElem.setAttribute("download", `delta_journal_backup_${new Date().toISOString().split('T')[0]}.json`);
    dlAnchorElem.click();
  }

  function exportCSV() {
    if (inMemoryTrades.length === 0) return;
    const headers = ["Timestamp", "Symbol", "Type", "Strike", "Expiry", "Size", "AvgEntry", "AvgExit", "GrossPnL", "Brokerage", "GST_18pct", "TotalFee", "NetPnL", "Status", "HoldDurationSec", "Tags", "Notes"];
    const rows = inMemoryTrades.map(t => [
      `"${t.timestamp}"`,
      `"${t.symbol}"`,
      `"${t.isCall ? 'CALL' : (t.isPut ? 'PUT' : 'PERP')}"`,
      t.strike || 0,
      `"${t.expiry || ''}"`,
      t.size || 0,
      t.avgEntry || 0,
      t.avgExit || 0,
      t.gross_pnl || 0,
      t.base_brokerage || 0,
      t.gst || 0,
      t.total_fee || 0,
      t.net_pnl || 0,
      `"${t.status}"`,
      t.holdDurationSec || 0,
      `"${(t.tags || []).join('; ')}"`,
      `"${(t.notes || '').replace(/"/g, '""')}"`
    ]);
    const csvContent = "data:text/csv;charset=utf-8," + [headers.join(","), ...rows.map(e => e.join(","))].join("\n");
    const dlAnchorElem = document.createElement('a');
    dlAnchorElem.setAttribute("href", encodeURI(csvContent));
    dlAnchorElem.setAttribute("download", `delta_trades_${new Date().toISOString().split('T')[0]}.csv`);
    dlAnchorElem.click();
  }

  // -------------------------------------------------------------
  // 10. LISTENER SUBSCRIPTION PATTERN
  // -------------------------------------------------------------
  function addListener(fn) {
    if (typeof fn === 'function') listeners.push(fn);
  }

  function notifyListeners(event) {
    listeners.forEach(fn => {
      try { fn(event); } catch (e) { console.error("Listener error:", e); }
    });
  }

  // -------------------------------------------------------------
  // 11. INSTITUTIONAL SIGNAL TRADES & FIRESTORE REGISTRY
  // -------------------------------------------------------------
  const SIGNAL_STORAGE_KEY = 'dtj_signal_trades_v1';

  async function syncSignalTrades(trades) {
    if (!trades || !Array.isArray(trades) || trades.length === 0) return {};

    let registry = {};
    try {
      const raw = localStorage.getItem(SIGNAL_STORAGE_KEY);
      if (raw) registry = JSON.parse(raw);
    } catch (e) {}

    const updatedDocs = [];

    trades.forEach(t => {
      const existing = registry[t.id];

      // Keep entry mark price and strike STRICTLY IMMUTABLE once recorded!
      const entryOpt = existing?.optionEntryMark || t.realOption?.entryPrice || t.entryOpt || 220;
      const strike = existing?.optionStrike || t.realOption?.strike || t.optionStrike || Math.round(t.entry / 200) * 200;
      const symbol = existing?.optionSymbol || t.realOption?.symbol || `${t.direction === 'LONG' ? 'C' : 'P'}-BTC-${strike}`;
      const buyZone = existing?.buyZone || t.realOption?.buyZone || `$${(entryOpt * 0.98).toFixed(1)} - $${(entryOpt * 1.02).toFixed(1)}`;
      const targetGainPct = existing?.optionTargetGainPct || t.realOption?.targetGainPct || t.targetGainPct || "+50.0%";
      const targetPrice = existing?.optionTargetPrice || t.realOption?.targetPrice || (entryOpt * 1.5);
      const stopPrice = existing?.optionStopPrice || t.realOption?.stopPrice || (entryOpt * 0.7);

      const docData = {
        id: t.id,
        time: t.time,
        timeIST: new Date(t.time * 1000).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true }),
        name: t.name,
        strategyId: t.strategyId,
        direction: t.direction,
        regime: t.regime,
        btcEntry: t.entry,
        btcTp: t.tp,
        btcSl: t.sl,
        targetDist: t.targetDist,
        slDist: t.slDist,
        rrRatio: t.rrRatio,
        optionSymbol: symbol,
        optionStrike: strike,
        optionEntryMark: entryOpt, // IMMUTABLE FROZEN ENTRY PRICE
        optionBuyPrice: entryOpt,
        optionSellPrice: t.outcome === 'WIN' ? targetPrice : (t.outcome === 'LOSS' ? stopPrice : (t.outcome === 'TIMEOUT' ? Math.round(entryOpt * 0.82 * 10) / 10 : (t.realOption?.markPrice || entryOpt))),
        buyZone: buyZone,
        optionTargetPrice: targetPrice,
        optionTargetGainPct: targetGainPct,
        optionStopPrice: stopPrice,
        optionStopLossPct: "-30.0%",
        outcome: t.outcome, // ACTIVE, WIN, LOSS, THETA_TIMEOUT
        exitTime: t.exitTime || null,
        exitBtcPrice: t.exitPrice || null, // BTC close price when TP/SL hit
        exitOptionPrice: t.exitOpt || (t.outcome === 'WIN' ? targetPrice : (t.outcome === 'LOSS' ? stopPrice : entryOpt)),
        optionPnlPct: t.optionPnlPct || (t.outcome === 'WIN' ? targetGainPct : (t.outcome === 'LOSS' ? '-30.0%' : '0%')),
        liveMarkPrice: t.realOption?.markPrice || entryOpt,
        unrealizedPts: t.realOption?.unrealizedPts || 0,
        unrealizedPct: t.realOption?.unrealizedPct || 0,
        exitReason: t.exitReason || t.outcome,
        barsHeld: t.barsHeld || 1,
        maePts: t.maePts || 0,
        mfePts: t.mfePts || 0,
        updatedAt: Date.now()
      };

      registry[t.id] = docData;
      updatedDocs.push(docData);
    });

    try {
      localStorage.setItem(SIGNAL_STORAGE_KEY, JSON.stringify(registry));
    } catch (e) {}

    // Async merge to Firestore collection (GP_DTJ_signal_trades) if online
    if (firestoreDb && updatedDocs.length > 0) {
      try {
        const batch = firestoreDb.batch();
        const col = DeltaConfig.FIRESTORE_COLLECTIONS.SIGNALS || "GP_DTJ_signal_trades";
        updatedDocs.slice(0, 50).forEach(docData => {
          const docRef = firestoreDb.collection(col).doc(docData.id);
          batch.set(docRef, docData, { merge: true });
        });
        batch.commit().catch(err => console.warn("Async signal batch write queued:", err));
      } catch (err) {
        console.warn("Firestore signal sync notice:", err);
      }
    }

    return registry;
  }

  function getSignalTrades(lastDays = 0) {
    try {
      const raw = localStorage.getItem(SIGNAL_STORAGE_KEY);
      if (!raw) return [];
      const registry = JSON.parse(raw);
      let list = Object.values(registry);
      if (lastDays && lastDays > 0) {
        const cutoff = Math.floor(Date.now() / 1000) - (lastDays * 86400);
        list = list.filter(t => t.time >= cutoff);
      }
      return list.sort((a, b) => b.time - a.time);
    } catch (e) {
      return [];
    }
  }

  async function fetchSignalTradesFromFirestore(allTime = true) {
    const config = getFirebaseConfig();
    if (!firestoreDb) initFirebase(config);
    if (!firestoreDb) return getSignalTrades(0);

    try {
      const col = DeltaConfig.FIRESTORE_COLLECTIONS.SIGNALS || "GP_DTJ_signal_trades";
      let query = firestoreDb.collection(col);
      if (!allTime) {
        const cutoff = Math.floor(Date.now() / 1000) - (2 * 86400); // Last 48 hours
        query = query.where("time", ">=", cutoff);
      }
      const snapshot = await query.get();
      
      let registry = {};
      try {
        const raw = localStorage.getItem(SIGNAL_STORAGE_KEY);
        if (raw) registry = JSON.parse(raw);
      } catch (e) {}

      snapshot.forEach(doc => {
        const data = doc.data();
        if (data && data.id) {
          registry[data.id] = Object.assign(registry[data.id] || {}, data);
        }
      });

      localStorage.setItem(SIGNAL_STORAGE_KEY, JSON.stringify(registry));
      console.log(`[DeltaDB] Fetched & synced ${snapshot.size} signal trades from Firestore (Zero State Drift).`);
      return Object.values(registry).sort((a, b) => b.time - a.time);
    } catch (err) {
      console.warn("Notice fetching remote signals from Firestore:", err);
      return getSignalTrades(0);
    }
  }

  return {
    init,
    syncFromRawData,
    getTrades: () => inMemoryTrades,
    getDailyMap: () => inMemoryDailyMap,
    getMonthlyMap: () => inMemoryMonthlyMap,
    getTradeById: (id) => inMemoryTrades.find(t => t.id === id),
    updateTradeEnrichment,
    addTagToTrade,
    removeTagFromTrade,
    attachScreenshot,
    syncToFirestore,
    syncSignalTrades,
    getSignalTrades,
    fetchSignalTradesFromFirestore,
    exportJSONBackup,
    exportCSV,
    addListener,
    parseDeltaSymbol
  };
})();
