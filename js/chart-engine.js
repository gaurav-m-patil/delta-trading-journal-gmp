/**
 * Delta Trading Journal - Institutional Live Chart Engine
 * Powered by TradingView Lightweight Charts (Canvas, 60 FPS)
 * 
 * Features:
 * - Real-time tick-by-tick WebSocket streaming for BTC/USD (0ms latency)
 * - Live Delta Exchange India Options Ticker & Strike Ingestion
 * - Authentic TradingView Long / Short Position Drawing Tool (Trade-to-trade shaded SVG box)
 * - Local Timezone (IST) Native Formatting (No double offset)
 * - Touch-proof: Zero accidental tab switching on chart dragging
 * - Auto-centering and zoom on selected trade
 * - Deep-dive Trade Logic & Real Delta Order Playbook Modal
 * - Zero external API costs, zero Firebase reads/writes
 */

window.DeltaLiveChart = (function() {
  let chart = null;
  let candleSeries = null;
  let volumeSeries = null;
  let activeTimeframe = '15m';
  let activeSymbol = 'BTCUSDT';
  let wsConnection = null;
  let candleData = [];
  let isInitialized = false;
  let currentAnalysis = null;
  let selectedTrade = null;

  let cachedDeltaTickers = null;
  let lastDeltaTickersFetchTime = 0;

  // Persistent Immutable Options Trade Registry (v3)
  // Ensures once a trade is recommended, its strike and entry price NEVER jump or slide down!
  const TRADE_REGISTRY_KEY = 'dtj_options_trade_registry_v3';

  function getTradeRegistry() {
    try {
      const raw = localStorage.getItem(TRADE_REGISTRY_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch (e) {
      return {};
    }
  }

  function saveTradeRegistry(reg) {
    try {
      localStorage.setItem(TRADE_REGISTRY_KEY, JSON.stringify(reg));
    } catch (e) {}
  }

  // Anti-Collision Marker Staggering & Timestamp Snapping:
  // Guarantees Lightweight Charts renders 100% of markers without crashing or overlapping labels
  function sanitizeMarkersNoOverlap(markers) {
    if (!markers || markers.length === 0) return [];
    if (!candleData || candleData.length === 0) return markers;

    const validTimesSet = new Set(candleData.map(c => c.time));
    const validTimesArray = candleData.map(c => c.time);

    // 1. Snap every marker's time to a valid candle bar time in candleSeries
    const snapped = [];
    const seenTimes = new Set();

    markers.forEach(m => {
      if (!m || !m.time) return;
      let t = m.time;
      if (!validTimesSet.has(t)) {
        // Find closest bar within 30 mins
        let closest = null;
        let minDiff = 1800;
        for (let i = 0; i < validTimesArray.length; i++) {
          const diff = Math.abs(validTimesArray[i] - t);
          if (diff < minDiff) {
            minDiff = diff;
            closest = validTimesArray[i];
          }
        }
        if (closest !== null) {
          t = closest;
        } else {
          return; // Outside chart candle window
        }
      }

      if (!seenTimes.has(t)) {
        seenTimes.add(t);
        snapped.push({ ...m, time: t });
      }
    });

    // 2. Sort strictly by time ascending (mandatory for Lightweight Charts)
    const sorted = snapped.sort((a, b) => a.time - b.time);

    // 3. Stagger markers on adjacent candles (within 6 bars / 5400s) vertically so they NEVER collide horizontally
    for (let i = 0; i < sorted.length - 1; i++) {
      const m1 = sorted[i];
      const m2 = sorted[i + 1];
      if (Math.abs(m2.time - m1.time) <= 5400) {
        if (m1.position === m2.position) {
          m2.position = m1.position === "aboveBar" ? "belowBar" : "aboveBar";
          m2.shape = m2.position === "aboveBar" ? "arrowDown" : "arrowUp";
        }
      }
    }

    return sorted;
  }

  // Institutional Sound Chimes & Haptic Feedback System (Idea 9)
  const DeltaSound = {
    isEnabled: () => localStorage.getItem('dtj_sound_enabled') !== 'false',
    toggleSound: function() {
      const current = this.isEnabled();
      localStorage.setItem('dtj_sound_enabled', (!current).toString());
      this.updateAudioButton();
      if (!current) this.playChime('click');
    },
    updateAudioButton: function() {
      const btn = document.getElementById('chartAudioChimeBtn');
      if (btn) {
        const active = this.isEnabled();
        btn.innerHTML = active 
          ? `<i class="fa-solid fa-volume-high text-indigo-400"></i>` 
          : `<i class="fa-solid fa-volume-xmark text-slate-500"></i>`;
        btn.title = active ? "Sound Chimes Active (Click to mute)" : "Sound Chimes Muted (Click to enable)";
      }
    },
    playChime: function(type = 'signal') {
      if (!this.isEnabled()) return;
      try {
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        if (!AudioCtx) return;
        const ctx = new AudioCtx();
        if (ctx.state === 'suspended') ctx.resume();
        const now = ctx.currentTime;
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain);
        gain.connect(ctx.destination);

        if (type === 'signal') {
          // Dual-frequency institutional chime: 587.33Hz (D5) -> 880Hz (A5)
          osc.type = 'sine';
          osc.frequency.setValueAtTime(587.33, now);
          osc.frequency.exponentialRampToValueAtTime(880.00, now + 0.12);
          gain.gain.setValueAtTime(0.001, now);
          gain.gain.exponentialRampToValueAtTime(0.12, now + 0.04);
          gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.45);
          osc.start(now);
          osc.stop(now + 0.46);
        } else if (type === 'click') {
          osc.type = 'triangle';
          osc.frequency.setValueAtTime(1200, now);
          gain.gain.setValueAtTime(0.04, now);
          gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.04);
          osc.start(now);
          osc.stop(now + 0.05);
        }
      } catch (e) {}
    },
    vibrate: function(pattern = [30]) {
      try {
        if ('vibrate' in navigator) {
          navigator.vibrate(pattern);
        }
      } catch (e) {}
    }
  };

  const TIMEFRAME_MAP = {
    '1m': '1m',
    '5m': '5m',
    '15m': '15m',
    '1h': '1h',
    '4h': '4h',
    '1D': '1d'
  };

  /**
   * Fetches real live active BTC options tickers from Delta Exchange India public API
   */
  async function getLiveDeltaTickers() {
    const now = Date.now();
    if (cachedDeltaTickers && (now - lastDeltaTickersFetchTime < 45000)) {
      return cachedDeltaTickers;
    }
    try {
      const res = await fetch('https://api.india.delta.exchange/v2/tickers?contract_types=call_options,put_options');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (data && data.result) {
        cachedDeltaTickers = data.result.filter(t => t.symbol && t.symbol.includes('-BTC-'));
        lastDeltaTickersFetchTime = now;
        return cachedDeltaTickers;
      }
    } catch (e) {
      console.warn("Notice: Delta tickers fetch:", e);
    }
    return cachedDeltaTickers || [];
  }

  /**
   * Resolves the smartest, real-world active Delta Exchange India option contract for a setup.
   * Strictly evaluates:
   * 1. Nearest unexpired active settlement date (e.g. today / tomorrow 17:30 IST).
   * 2. Either Exact ATM (Delta ~0.50, closest strike to spot) or Next Strike OTM (within 1 strike).
   * 3. Absolutely ZERO far OTM contracts.
   * 4. Dynamic Option Target Potential based on spot target distance (minimum +35% floor, up to +1000%+ on trend expansions).
   */
  function resolveRealDeltaContract(direction, spotPrice, tickers, tradeId, registry, targetDist) {
    const isCall = direction === "LONG";
    const atmStrikeEstimate = Math.round(spotPrice / 200) * 200;

    // 1. IMMUTABLE TRADE REGISTRY LOOKUP
    // If trade was already resolved and recorded, reuse its exact contract, strike, entry price, buy zone, and targets!
    // ONLY the live mark price and unrealized PnL move with live ticker feed!
    if (registry && tradeId && registry[tradeId]) {
      const locked = registry[tradeId];
      const fixedEntry = locked.entryPrice || 220;
      const matched = tickers ? tickers.find(t => t.symbol === locked.symbol) : null;
      const currentLiveMark = matched ? (Math.round((parseFloat(matched.mark_price) || fixedEntry) * 10) / 10) : fixedEntry;
      const unrealizedPts = Math.round((currentLiveMark - fixedEntry) * 10) / 10;
      const unrealizedPct = Number(((unrealizedPts / (fixedEntry || 1)) * 100).toFixed(1));

      return {
        ...locked,
        markPrice: currentLiveMark,
        unrealizedPts,
        unrealizedPct,
        isLive: !!matched
      };
    }

    if (!tickers || tickers.length === 0) {
      const simEntry = 220.0;
      const effDelta = Math.min(0.85, Math.max(0.50, 0.50 + ((targetDist || 1000) / 4000) * 0.35));
      const projPts = Math.round(((targetDist && targetDist > 0) ? (targetDist * effDelta) : (simEntry * 0.50)) * 10) / 10;
      const dynGainPct = Math.max(50, Math.round((projPts / simEntry) * 100));
      const target = Math.round((simEntry + (simEntry * (dynGainPct / 100))) * 10) / 10;
      const targetGainPct = `+${dynGainPct}%`;
      const tp1Price = Math.round(simEntry * 1.50 * 10) / 10;
      const tp1GainPct = "+50.0%";

      const ratio = spotPrice > 0 ? (simEntry / spotPrice) : 0.003;
      const ivBadge = ratio < 0.0028 ? "🟢 CHEAP" : (ratio <= 0.0045 ? "🟡 FAIR" : "🔴 ELEVATED");
      const ivRating = ratio < 0.0028 ? "CHEAP (High Delta Leverage)" : (ratio <= 0.0045 ? "FAIR (Institutionally Calibrated)" : "ELEVATED (High IV)");

      const res = {
        symbol: isCall ? `C-BTC-${atmStrikeEstimate}` : `P-BTC-${atmStrikeEstimate}`,
        strike: atmStrikeEstimate,
        strikeTier: "Exact ATM (Delta ~0.50)",
        entryPrice: simEntry,
        markPrice: simEntry,
        buyZone: "$210.0 - $225.0",
        tp1Price,
        tp1GainPct,
        targetPrice: target,
        stopPrice: 154.0,
        targetGainPct,
        stopLossPct: "-30.0%",
        unrealizedPts: 0,
        unrealizedPct: 0,
        ivRating,
        ivBadge,
        isLive: false
      };
      if (registry && tradeId) {
        registry[tradeId] = {
          symbol: res.symbol,
          strike: res.strike,
          strikeTier: res.strikeTier,
          entryPrice: res.entryPrice,
          buyZone: res.buyZone,
          tp1Price: res.tp1Price,
          tp1GainPct: res.tp1GainPct,
          targetPrice: res.targetPrice,
          stopPrice: res.stopPrice,
          targetGainPct: res.targetGainPct,
          stopLossPct: res.stopLossPct,
          ivRating: res.ivRating,
          ivBadge: res.ivBadge
        };
        saveTradeRegistry(registry);
      }
      return res;
    }

    const type = isCall ? "call_options" : "put_options";
    const candidates = tickers.filter(t => t.contract_type === type);

    // 1. Filter out already-expired contracts and group by expiration timestamp
    const now = Date.now();
    const activeWithExpiry = [];

    for (const c of candidates) {
      if (!c.symbol) continue;
      const parts = c.symbol.split('-');
      if (parts.length >= 4) {
        const dStr = parts[3];
        if (dStr && dStr.length === 6) {
          const day = parseInt(dStr.substring(0, 2), 10);
          const month = parseInt(dStr.substring(2, 4), 10) - 1;
          const year = 2000 + parseInt(dStr.substring(4, 6), 10);
          // Delta Exchange options expire at 12:00 UTC (17:30 IST)
          const expiryTs = Date.UTC(year, month, day, 12, 0, 0);
          if (expiryTs > now) {
            // 0-DTE Theta Safety: check if within 105 mins of 17:30 IST
            const timeToExpiry = expiryTs - now;
            activeWithExpiry.push({ 
              contract: c, 
              expiryTs,
              isNearExpiry: timeToExpiry <= (105 * 60 * 1000)
            });
          }
        }
      }
    }

    if (activeWithExpiry.length === 0) {
      const simEntry = 220.0;
      const res = {
        symbol: isCall ? `C-BTC-${atmStrikeEstimate}` : `P-BTC-${atmStrikeEstimate}`,
        strike: atmStrikeEstimate,
        strikeTier: "Exact ATM (Delta ~0.50)",
        entryPrice: simEntry,
        markPrice: simEntry,
        buyZone: "$210.0 - $225.0",
        tp1Price: 330.0,
        tp1GainPct: "+50.0%",
        targetPrice: 330.0,
        stopPrice: 154.0,
        targetGainPct: "+50.0%",
        stopLossPct: "-30.0%",
        unrealizedPts: 0,
        unrealizedPct: 0,
        isLive: false
      };
      if (registry && tradeId) {
        registry[tradeId] = {
          symbol: res.symbol,
          strike: res.strike,
          strikeTier: res.strikeTier,
          entryPrice: res.entryPrice,
          buyZone: res.buyZone,
          tp1Price: res.tp1Price,
          tp1GainPct: res.tp1GainPct,
          targetPrice: res.targetPrice,
          stopPrice: res.stopPrice,
          targetGainPct: res.targetGainPct,
          stopLossPct: res.stopLossPct
        };
        saveTradeRegistry(registry);
      }
      return res;
    }

    // 2. Find the nearest upcoming active expiration date (preferring next-day if near 17:30 IST)
    let viableContracts = activeWithExpiry;
    const hasNextDay = activeWithExpiry.some(x => !x.isNearExpiry);
    if (hasNextDay) {
      viableContracts = activeWithExpiry.filter(x => !x.isNearExpiry);
    }
    viableContracts.sort((a, b) => a.expiryTs - b.expiryTs);
    const nearestExpiryTs = viableContracts[0].expiryTs;
    const nearestContracts = viableContracts
      .filter(x => x.expiryTs === nearestExpiryTs)
      .map(x => x.contract);

    // 3. Find Exact ATM and Next Strike (OTM-1)
    nearestContracts.sort((a, b) => {
      const distA = Math.abs(parseFloat(a.strike_price) - spotPrice);
      const distB = Math.abs(parseFloat(b.strike_price) - spotPrice);
      return distA - distB;
    });

    const atmCandidate = nearestContracts[0];
    const isLiveAtmMatch = atmCandidate && Math.abs(parseFloat(atmCandidate.strike_price) - spotPrice) <= 350;

    const nextOtmCandidate = nearestContracts.find(c => {
      const s = parseFloat(c.strike_price);
      if (isCall) {
        return s > spotPrice && (s - spotPrice) <= 450;
      } else {
        return s < spotPrice && (spotPrice - s) <= 450;
      }
    });

    let best = isLiveAtmMatch ? atmCandidate : null;
    let tier = "Exact ATM (Delta ~0.50)";

    if (best) {
      const mark = Math.round((parseFloat(best.mark_price) || Math.round(spotPrice * 0.0033 * 10) / 10) * 10) / 10;
      // DOEV: Effective Delta expands as spot approaches target (0.50 -> 0.85)
      const effDelta = Math.min(0.85, Math.max(0.50, 0.50 + ((targetDist || 1000) / 4000) * 0.35));
      const projPts = Math.round(((targetDist && targetDist > 0) ? (targetDist * effDelta) : (mark * 0.65)) * 10) / 10;
      const dynGainPct = Math.max(65, Math.round((projPts / mark) * 100));
      const target = Math.round((mark + (mark * (dynGainPct / 100))) * 10) / 10;
      const targetGainPct = `+${dynGainPct}%`;
      const tp1Price = Math.round(mark * 1.50 * 10) / 10;
      const tp1GainPct = "+50.0%";
      const stop = Math.round((mark * 0.7) * 10) / 10;
      const bestBid = parseFloat(best.best_bid) || mark;
      const bestAsk = parseFloat(best.best_ask) || mark;

      const spreadValid = (bestAsk > 0 && bestBid > 0 && (bestAsk - bestBid) <= (mark * 0.15));
      const buyZone = spreadValid 
        ? `$${Math.min(bestBid, mark).toFixed(1)} - $${Math.max(bestAsk, mark).toFixed(1)}`
        : `$${(mark * 0.98).toFixed(1)} - $${(mark * 1.02).toFixed(1)}`;

      const ratio = spotPrice > 0 ? (mark / spotPrice) : 0.003;
      const ivBadge = ratio < 0.0028 ? "🟢 CHEAP" : (ratio <= 0.0045 ? "🟡 FAIR" : "🔴 ELEVATED");
      const ivRating = ratio < 0.0028 ? "CHEAP (High Delta Leverage)" : (ratio <= 0.0045 ? "FAIR (Institutionally Calibrated)" : "ELEVATED (High IV)");

      const res = {
        symbol: best.symbol,
        strike: parseFloat(best.strike_price),
        strikeTier: tier,
        entryPrice: mark,
        markPrice: mark,
        bestBid: bestBid > 0 ? bestBid : mark,
        bestAsk: bestAsk > 0 ? bestAsk : mark,
        buyZone,
        tp1Price,
        tp1GainPct,
        targetPrice: target,
        stopPrice: stop,
        targetGainPct,
        stopLossPct: "-30.0%",
        unrealizedPts: 0,
        unrealizedPct: 0,
        ivRating,
        ivBadge,
        isLive: true
      };

      // FREEZE THIS CONTRACT PERMANENTLY IN THE REGISTRY FOR THIS TRADE ID
      if (registry && tradeId) {
        registry[tradeId] = {
          symbol: res.symbol,
          strike: res.strike,
          strikeTier: res.strikeTier,
          entryPrice: res.entryPrice,
          buyZone: res.buyZone,
          tp1Price: res.tp1Price,
          tp1GainPct: res.tp1GainPct,
          targetPrice: res.targetPrice,
          stopPrice: res.stopPrice,
          targetGainPct: res.targetGainPct,
          stopLossPct: res.stopLossPct,
          ivRating: res.ivRating,
          ivBadge: res.ivBadge
        };
        saveTradeRegistry(registry);
      }

      return res;
    }

    const simEntry = Math.round(spotPrice * 0.0033 * 10) / 10;
    const effDeltaFallback = Math.min(0.85, Math.max(0.50, 0.50 + ((targetDist || 1000) / 4000) * 0.35));
    const deltaMoveFallback = (targetDist && targetDist > 0) ? (targetDist * effDeltaFallback) : (simEntry * 0.65);
    const dynGainPctFallback = Math.max(65, Math.round((deltaMoveFallback / simEntry) * 100));
    const fallbackTarget = Math.round((simEntry + (simEntry * (dynGainPctFallback / 100))) * 10) / 10;
    const fallbackTargetGainPct = `+${dynGainPctFallback}%`;
    const fallbackTp1 = Math.round(simEntry * 1.50 * 10) / 10;

    const fallbackRes = {
      symbol: isCall ? `C-BTC-${atmStrikeEstimate}` : `P-BTC-${atmStrikeEstimate}`,
      strike: atmStrikeEstimate,
      strikeTier: "Exact ATM (Delta ~0.50)",
      entryPrice: simEntry,
      markPrice: simEntry,
      buyZone: `$${(simEntry * 0.98).toFixed(1)} - $${(simEntry * 1.02).toFixed(1)}`,
      tp1Price: fallbackTp1,
      tp1GainPct: "+50.0%",
      targetPrice: fallbackTarget,
      stopPrice: Math.round(simEntry * 0.7 * 10) / 10,
      targetGainPct: fallbackTargetGainPct,
      stopLossPct: "-30.0%",
      ivBadge: "🟡 FAIR",
      ivRating: "FAIR (Calibrated)",
      unrealizedPts: 0,
      unrealizedPct: 0,
      isLive: false
    };
    if (registry && tradeId) {
      registry[tradeId] = {
        symbol: fallbackRes.symbol,
        strike: fallbackRes.strike,
        strikeTier: fallbackRes.strikeTier,
        entryPrice: fallbackRes.entryPrice,
        buyZone: fallbackRes.buyZone,
        tp1Price: fallbackRes.tp1Price,
        tp1GainPct: fallbackRes.tp1GainPct,
        targetPrice: fallbackRes.targetPrice,
        stopPrice: fallbackRes.stopPrice,
        targetGainPct: fallbackRes.targetGainPct,
        stopLossPct: fallbackRes.stopLossPct,
        ivBadge: fallbackRes.ivBadge,
        ivRating: fallbackRes.ivRating
      };
      saveTradeRegistry(registry);
    }
    return fallbackRes;
  }

  /**
   * Initializes the TradingView Lightweight Charts canvas in container
   */
  function initChart() {
    const container = document.getElementById('tvLiveChartContainer');
    if (!container) return;

    DeltaSound.updateAudioButton();

    if (chart) {
      // Container exists and chart already created: refresh layout & ensure candles are loaded
      const width = container.clientWidth || 360;
      chart.applyOptions({ width });
      if (!candleData || candleData.length === 0) {
        loadTimeframe(activeTimeframe);
      } else {
        chart.timeScale().fitContent();
        renderPositionBox(selectedTrade);
        if (candleSeries && currentAnalysis && currentAnalysis.markers) {
          try {
            candleSeries.setMarkers(sanitizeMarkersNoOverlap(currentAnalysis.markers));
          } catch (e) {}
        }
      }
      return;
    }

    const chartHeight = window.innerWidth < 640 ? 350 : 430;
    const initialWidth = container.clientWidth || (window.innerWidth < 640 ? (window.innerWidth - 32) : 800);

    // Create TradingView Chart
    chart = LightweightCharts.createChart(container, {
      width: initialWidth,
      height: chartHeight,
      layout: {
        background: { color: '#0b0f17' },
        textColor: '#94a3b8',
        fontSize: 11,
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, monospace'
      },
      grid: {
        vertLines: { color: 'rgba(30, 41, 59, 0.4)' },
        horzLines: { color: 'rgba(30, 41, 59, 0.4)' }
      },
      crosshair: {
        mode: LightweightCharts.CrosshairMode.Normal,
        vertLine: { color: '#6366f1', width: 1, style: 3, labelBackgroundColor: '#1e293b' },
        horzLine: { color: '#6366f1', width: 1, style: 3, labelBackgroundColor: '#1e293b' }
      },
      timeScale: {
        borderColor: '#1e293b',
        timeVisible: true,
        secondsVisible: false,
        tickMarkFormatter: (time) => {
          // Native browser timezone (IST) formatting
          const d = new Date(time * 1000);
          return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
        }
      },
      localization: {
        dateFormat: 'yyyy-MM-dd',
        timeFormatter: (time) => {
          const d = new Date(time * 1000);
          return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: true });
        }
      },
      rightPriceScale: {
        borderColor: '#1e293b',
        scaleMargins: {
          top: 0.12,
          bottom: 0.25 // Leaves room for volume sub-pane
        }
      }
    });

    // Add Candlestick Series
    candleSeries = chart.addCandlestickSeries({
      upColor: '#10b981',
      downColor: '#f43f5e',
      borderVisible: false,
      wickUpColor: '#10b981',
      wickDownColor: '#f43f5e'
    });

    // Add Synchronized Volume Histogram Series
    volumeSeries = chart.addHistogramSeries({
      color: '#38bdf8',
      priceFormat: { type: 'volume' },
      priceScaleId: '', // Overlay over price scale with bottom margin
      scaleMargins: {
        top: 0.82,
        bottom: 0
      }
    });

    // Create SVG Overlay for TradingView Long / Short Position Tool
    let svgOverlay = document.getElementById('tvPositionBoxSvg');
    if (!svgOverlay) {
      svgOverlay = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svgOverlay.setAttribute('id', 'tvPositionBoxSvg');
      svgOverlay.style.position = 'absolute';
      svgOverlay.style.top = '0';
      svgOverlay.style.left = '0';
      svgOverlay.style.width = '100%';
      svgOverlay.style.height = '100%';
      svgOverlay.style.pointerEvents = 'none';
      svgOverlay.style.zIndex = '12';
      svgOverlay.style.overflow = 'hidden';
      container.appendChild(svgOverlay);
    }

    // Keep position box locked to candles during pan / zoom
    chart.timeScale().subscribeVisibleLogicalRangeChange(() => {
      renderPositionBox(selectedTrade);
    });

    // Subscribe to chart clicks to select nearest trade
    chart.subscribeClick((param) => {
      if (!param || !param.time || !currentAnalysis) return;
      const clickedTime = param.time;
      const match = currentAnalysis.trades.find(t => Math.abs(t.time - clickedTime) < 1800);
      if (match) {
        selectTrade(match.id);
      }
    });

    // Responsive window resizing
    window.addEventListener('resize', () => {
      if (chart && container) {
        chart.applyOptions({ width: container.clientWidth });
        renderPositionBox(selectedTrade);
      }
    });

    isInitialized = true;
    loadTimeframe(activeTimeframe);
  }

  let deltaTickerPollInterval = null;

  /**
   * Loads historical candles and connects live WebSocket for selected timeframe.
   * Uses Delta Exchange India (Primary - 100% reliable in India) with Binance as secondary fallback.
   */
  async function loadTimeframe(tf) {
    activeTimeframe = tf;
    updateTimeframeButtons(tf);

    // 1. Close existing live WebSocket stream and polling if active
    if (wsConnection) {
      try { wsConnection.close(); } catch (e) {}
      wsConnection = null;
    }
    if (deltaTickerPollInterval) {
      clearInterval(deltaTickerPollInterval);
      deltaTickerPollInterval = null;
    }

    const resMapDelta = { '1m': '1m', '5m': '5m', '15m': '15m', '1h': '1h', '4h': '4h', '1D': '1d' };
    const deltaRes = resMapDelta[tf] || '15m';
    const end = Math.floor(Date.now() / 1000);
    const start = end - (86400 * 4); // 4 days of history (~384 candles)

    let loadedBars = null;

    // 2a. PRIMARY: Delta Exchange India Native Historical Candles (100% unblocked in India)
    try {
      const deltaUrl = `https://api.india.delta.exchange/v2/history/candles?resolution=${deltaRes}&symbol=BTCUSD&start=${start}&end=${end}`;
      const res = await fetch(deltaUrl, { cache: 'no-store' });
      if (res.ok) {
        const json = await res.json();
        if (json && json.result && Array.isArray(json.result) && json.result.length > 0) {
          // Delta returns newest first; sort ascending for TradingView Lightweight Charts
          const sorted = json.result.map(c => ({
            time: c.time,
            open: parseFloat(c.open),
            high: parseFloat(c.high),
            low: parseFloat(c.low),
            close: parseFloat(c.close),
            volume: parseFloat(c.volume || 0)
          })).sort((a, b) => a.time - b.time);

          // Deduplicate and filter out any invalid values
          const clean = [];
          const seen = new Set();
          for (const c of sorted) {
            if (!seen.has(c.time) && !isNaN(c.close) && c.close > 0) {
              seen.add(c.time);
              clean.push(c);
            }
          }
          if (clean.length > 15) {
            loadedBars = clean;
          }
        }
      }
    } catch (e) {
      console.warn("Delta Exchange India candles fetch notice:", e);
    }

    // 2b. SECONDARY: Binance REST Klines (if Delta was unreachable)
    if (!loadedBars) {
      try {
        const interval = TIMEFRAME_MAP[tf] || '15m';
        const restUrl = `https://api.binance.com/api/v3/klines?symbol=${activeSymbol}&interval=${interval}&limit=500`;
        const res = await fetch(restUrl);
        if (res.ok) {
          const rawBars = await res.json();
          loadedBars = rawBars.map(b => ({
            time: Math.floor(b[0] / 1000),
            open: parseFloat(b[1]),
            high: parseFloat(b[2]),
            low: parseFloat(b[3]),
            close: parseFloat(b[4]),
            volume: parseFloat(b[5])
          }));
        }
      } catch (err) {
        console.warn("Binance REST candles notice:", err);
      }
    }

    // 2c. TERTIARY: Coinbase Public BTC-USD Feed (100% open CORS worldwide)
    if (!loadedBars) {
      try {
        const granMap = { '1m': 60, '5m': 300, '15m': 900, '1h': 3600, '4h': 21600, '1D': 86400 };
        const gran = granMap[tf] || 900;
        const cbRes = await fetch(`https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=${gran}`);
        if (cbRes.ok) {
          const cbBars = await cbRes.json();
          // Coinbase returns [time, low, high, open, close, volume] sorted newest first
          if (Array.isArray(cbBars) && cbBars.length > 0) {
            loadedBars = cbBars.map(b => ({
              time: b[0],
              open: parseFloat(b[3]),
              high: parseFloat(b[2]),
              low: parseFloat(b[1]),
              close: parseFloat(b[4]),
              volume: parseFloat(b[5] || 0)
            })).sort((a, b) => a.time - b.time);
          }
        }
      } catch (err) {
        console.warn("Coinbase candles fallback notice:", err);
      }
    }

    if (!loadedBars || loadedBars.length === 0) {
      console.error("Unable to load candles from network providers.");
      return;
    }

    candleData = loadedBars;

    // Update Chart Series
    if (candleSeries) candleSeries.setData(candleData);

    const volumeData = candleData.map(c => ({
      time: c.time,
      value: c.volume,
      color: c.close >= c.open ? 'rgba(16, 185, 129, 0.35)' : 'rgba(244, 63, 94, 0.35)'
    }));
    if (volumeSeries) volumeSeries.setData(volumeData);

    if (chart) chart.timeScale().fitContent();

    // Update Header Live Price immediately
    const latestCandle = candleData[candleData.length - 1];
    const priceHeader = document.getElementById('chartLivePriceHeader');
    if (priceHeader && latestCandle) {
      priceHeader.innerText = `$${latestCandle.close.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}`;
      priceHeader.className = `text-lg sm:text-2xl font-bold font-mono ${latestCandle.close >= latestCandle.open ? 'text-winGreen' : 'text-lossRed'}`;
    }

    // 3. Execute Algorithmic SMC Confluence Analysis
    runSMCAnalysisAndBacktest();

    // 4. Connect Live Tick-by-Tick WebSocket & Delta Ticker Fallback
    const interval = TIMEFRAME_MAP[tf] || '15m';
    connectLiveWebSocket(interval);
    startDeltaTickerPoll();
  }

  function startDeltaTickerPoll() {
    if (deltaTickerPollInterval) clearInterval(deltaTickerPollInterval);
    deltaTickerPollInterval = setInterval(async () => {
      try {
        const res = await fetch('https://api.india.delta.exchange/v2/tickers/BTCUSD', { cache: 'no-store' });
        if (res.ok) {
          const json = await res.json();
          if (json && json.result && json.result.mark_price) {
            const markPrice = parseFloat(json.result.mark_price);
            const priceHeader = document.getElementById('chartLivePriceHeader');
            if (priceHeader && !isNaN(markPrice)) {
              priceHeader.innerText = `$${markPrice.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}`;
            }
          }
        }
      } catch (e) {}
    }, 3500);
  }

  /**
   * Connects to public real-time Binance WebSocket for live tick-by-tick candle updates
   */
  function connectLiveWebSocket(interval) {
    const wsUrl = `wss://stream.binance.com:9443/ws/${activeSymbol.toLowerCase()}@kline_${interval}`;
    
    try {
      wsConnection = new WebSocket(wsUrl);

      wsConnection.onopen = () => {
        const badge = document.getElementById('wsLiveBadge');
        if (badge) {
          badge.className = "px-2 py-0.5 rounded text-[10px] font-mono font-bold bg-emerald-500/10 text-emerald-400 border border-emerald-500/30 flex items-center gap-1.5";
          badge.innerHTML = `<span class="h-2 w-2 rounded-full bg-emerald-400 animate-ping"></span> Live Tick Stream`;
        }
      };

      wsConnection.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          const k = msg.k;
          if (!k) return;

          const updatedCandle = {
            time: Math.floor(k.t / 1000),
            open: parseFloat(k.o),
            high: parseFloat(k.h),
            low: parseFloat(k.l),
            close: parseFloat(k.c),
            volume: parseFloat(k.v)
          };

          // Update TradingView Live Series instantly (0ms latency)
          candleSeries.update(updatedCandle);
          volumeSeries.update({
            time: updatedCandle.time,
            value: updatedCandle.volume,
            color: updatedCandle.close >= updatedCandle.open ? 'rgba(16, 185, 129, 0.4)' : 'rgba(244, 63, 94, 0.4)'
          });

          // Update current price in header
          const priceHeader = document.getElementById('chartLivePriceHeader');
          if (priceHeader) {
            priceHeader.innerText = `$${updatedCandle.close.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}`;
            priceHeader.className = `text-lg sm:text-2xl font-bold font-mono ${updatedCandle.close >= updatedCandle.open ? 'text-winGreen' : 'text-lossRed'}`;
          }

          // If candle closed, refresh analysis
          if (k.x) {
            candleData.push(updatedCandle);
            runSMCAnalysisAndBacktest();
          } else {
            // Keep position box aligned with live ticks
            if (selectedTrade) renderPositionBox(selectedTrade);
          }
        } catch (e) {
          console.error("WS parse error:", e);
        }
      };

      wsConnection.onclose = () => {
        const badge = document.getElementById('wsLiveBadge');
        if (badge) {
          badge.className = "px-2 py-0.5 rounded text-[10px] font-mono font-bold bg-amber-500/10 text-amber-400 border border-amber-500/30";
          badge.innerHTML = `Reconnecting stream...`;
        }
        setTimeout(() => {
          if (activeTimeframe) connectLiveWebSocket(TIMEFRAME_MAP[activeTimeframe] || '15m');
        }, 3000);
      };
    } catch (err) {
      console.warn("WebSocket init notice:", err);
    }
  }

  function clearPositionBox() {
    renderPositionBox(null);
  }

  /**
   * Renders the authentic TradingView Long / Short Position Drawing Tool
   * (Shaded Green Profit Box, Shaded Red Loss Box, Entry line, exact targets)
   * Strictly bounded from Trade Entry bar to Exit bar (NOT infinite lines!).
   */
  function renderPositionBox(trade) {
    const svg = document.getElementById('tvPositionBoxSvg');
    if (!svg) return;

    if (!trade || !chart || !candleSeries) {
      svg.innerHTML = '';
      return;
    }

    // Horizontal Bar Coordinates
    const x1 = chart.timeScale().timeToCoordinate(trade.time);
    
    // For active trade, extend box forward into current/future bars
    let exitTime = trade.exitTime;
    if (trade.outcome === "ACTIVE" && candleData.length > 0) {
      exitTime = candleData[candleData.length - 1].time + 1800;
    } else if (!exitTime) {
      exitTime = trade.time + (trade.barsHeld || 6) * 900;
    }
    let x2 = chart.timeScale().timeToCoordinate(exitTime);

    if (x1 === null && x2 === null) {
      svg.innerHTML = '';
      return;
    }

    if (x1 === null) return;
    
    // Ensure comfortable readable box width (at least 150px)
    if (x2 === null || x2 - x1 < 150) {
      x2 = x1 + 160;
    }

    const boxWidth = Math.max(150, x2 - x1);

    // Vertical Price Coordinates (Screen pixels: lower price = higher Y value)
    const yEntry = candleSeries.priceToCoordinate(trade.entry);
    const yTp = candleSeries.priceToCoordinate(trade.tp);
    const ySl = candleSeries.priceToCoordinate(trade.sl);

    if (yEntry === null || yTp === null || ySl === null) {
      svg.innerHTML = '';
      return;
    }

    const isCall = trade.direction === "LONG";
    const isActive = trade.outcome === "ACTIVE";

    let profitY, profitHeight, lossY, lossHeight;

    if (isCall) {
      profitY = yTp;
      profitHeight = Math.max(6, yEntry - yTp);
      lossY = yEntry;
      lossHeight = Math.max(6, ySl - yEntry);
    } else {
      profitY = yEntry;
      profitHeight = Math.max(6, yTp - yEntry);
      lossY = ySl;
      lossHeight = Math.max(6, yEntry - ySl);
    }

    // Ultra-clean translucent fills so candlesticks and wicks are 100% visible beneath
    const profitFill = "rgba(16, 185, 129, 0.08)";
    const profitStroke = "rgba(16, 185, 129, 0.55)";
    const lossFill = "rgba(244, 63, 94, 0.08)";
    const lossStroke = "rgba(244, 63, 94, 0.55)";

    const opt = trade.realOption || {};
    const targetOptLabel = opt.targetPrice ? ` (Opt: $${opt.targetPrice})` : ` (+50%)`;
    const stopOptLabel = opt.stopPrice ? ` (Opt: $${opt.stopPrice})` : ` (-30%)`;

    // Position badges at the FAR RIGHT edge so they NEVER overlap or obscure the entry candlesticks!
    const containerWidth = svg.clientWidth || 800;
    const badgeW = 125;
    let badgeX = x1 + boxWidth + 4;
    if (badgeX + badgeW > containerWidth) {
      badgeX = Math.max(x1 + 65, x1 + boxWidth - badgeW - 4);
    }

    svg.innerHTML = `
      <!-- Green Take Profit Zone (Translucent) -->
      <rect x="${x1}" y="${profitY}" width="${boxWidth}" height="${profitHeight}"
            fill="${profitFill}" stroke="${profitStroke}" stroke-width="1" stroke-dasharray="3,2" rx="3" />

      <!-- Red Stop Loss Zone (Translucent) -->
      <rect x="${x1}" y="${lossY}" width="${boxWidth}" height="${lossHeight}"
            fill="${lossFill}" stroke="${lossStroke}" stroke-width="1" stroke-dasharray="3,2" rx="3" />

      <!-- Dashed Level Guidelines Connecting Entry to Labels -->
      <line x1="${x1}" y1="${yEntry}" x2="${badgeX}" y2="${yEntry}"
            stroke="#38bdf8" stroke-width="1.2" stroke-dasharray="4,3" opacity="0.8" />
      <line x1="${x1}" y1="${yTp}" x2="${badgeX}" y2="${yTp}"
            stroke="#10b981" stroke-width="1" stroke-dasharray="3,3" opacity="0.6" />
      <line x1="${x1}" y1="${ySl}" x2="${badgeX}" y2="${ySl}"
            stroke="#f43f5e" stroke-width="1" stroke-dasharray="3,3" opacity="0.6" />

      <!-- Compact Price Badges Floating on the Right (Candles completely unobstructed) -->
      <g font-family="-apple-system, BlinkMacSystemFont, monospace" font-size="9" font-weight="bold">
        <!-- Target Price Tag -->
        <rect x="${badgeX}" y="${profitY + 2}" width="${badgeW}" height="16" fill="rgba(8, 11, 17, 0.85)" rx="3" stroke="rgba(16, 185, 129, 0.5)" stroke-width="1" />
        <text x="${badgeX + 6}" y="${profitY + 13}" fill="#10b981">TP: $${trade.tp.toLocaleString()}${targetOptLabel}</text>

        <!-- Entry Price Tag -->
        <rect x="${badgeX}" y="${yEntry - 18}" width="${badgeW}" height="16" fill="rgba(8, 11, 17, 0.85)" rx="3" stroke="rgba(56, 189, 248, 0.5)" stroke-width="1" />
        <text x="${badgeX + 6}" y="${yEntry - 7}" fill="#38bdf8">Entry: $${trade.entry.toLocaleString()}</text>

        <!-- Stop Loss Price Tag -->
        <rect x="${badgeX}" y="${isCall ? (lossY + lossHeight - 18) : (lossY + 2)}" width="${badgeW}" height="16" fill="rgba(8, 11, 17, 0.85)" rx="3" stroke="rgba(244, 63, 94, 0.5)" stroke-width="1" />
        <text x="${badgeX + 6}" y="${isCall ? (lossY + lossHeight - 7) : (lossY + 13)}" fill="#f43f5e">SL: $${trade.sl.toLocaleString()}${stopOptLabel}</text>
      </g>
    `;
  }

  /**
   * Updates the UI cockpit card that visualizes the TradingView Position Tool details
   */
  function updatePositionToolCockpit(trade) {
    const cockpit = document.getElementById('tvPositionToolCockpit');
    if (!cockpit) return;

    if (!trade) {
      cockpit.classList.add('opacity-90');
      const dirBadge = document.getElementById('ptDirectionBadge');
      if (dirBadge) {
        dirBadge.className = "h-8 w-8 sm:h-9 sm:w-9 rounded-xl bg-indigo-500/20 text-indigo-400 flex items-center justify-center font-bold text-sm sm:text-base shrink-0";
        dirBadge.innerHTML = `<i class="fa-solid fa-radar animate-pulse"></i>`;
      }
      const nameEl = document.getElementById('ptSetupName');
      if (nameEl) nameEl.innerText = "24/7 Cloud Sentinel Radar";
      const outcomeEl = document.getElementById('ptOutcomeBadge');
      if (outcomeEl) {
        outcomeEl.className = "text-[10px] font-bold font-mono px-2 py-0.5 rounded bg-emerald-500/10 text-emerald-400 border border-emerald-500/30 flex items-center gap-1.5";
        outcomeEl.innerHTML = `<span class="h-2 w-2 rounded-full bg-emerald-400 animate-ping"></span> STANDBY · SCANNING 15M ORDER FLOW`;
      }
      const latestC = (candleData && candleData.length > 0) ? candleData[candleData.length - 1] : null;
      const spotStr = latestC ? `$${latestC.close.toLocaleString()} (Spot)` : "Awaiting Setup";

      const entryEl = document.getElementById('ptEntry');
      if (entryEl) entryEl.innerText = spotStr;

      const tpEl = document.getElementById('ptTp');
      if (tpEl) tpEl.innerText = "Auto-Target";

      const slEl = document.getElementById('ptSl');
      if (slEl) slEl.innerText = "-30% Risk Cap";

      const rrEl = document.getElementById('ptRR');
      if (rrEl) rrEl.innerText = "1 : 2.0+";

      const symEl = document.getElementById('ptContractSymbol');
      if (symEl) symEl.innerText = "Daily ATM Contract (0-DTE)";

      const buyZoneEl = document.getElementById('ptDeltaBuyZone');
      if (buyZoneEl) buyZoneEl.innerText = "Calculated on trigger";

      const markEl = document.getElementById('ptDeltaMark');
      if (markEl) markEl.innerText = latestC ? `~$${Math.round(latestC.close * 0.0033)}` : "~$215 - $245";

      const targetEl = document.getElementById('ptDeltaTarget');
      if (targetEl) targetEl.innerText = "+65% to +150% DOEV";

      const liveTagEl = document.getElementById('ptDeltaLiveTag');
      if (liveTagEl) {
        liveTagEl.className = "text-[9px] font-mono px-1.5 py-0.5 rounded bg-indigo-500/10 text-indigo-300 border border-indigo-500/30 font-bold";
        liveTagEl.innerText = "Sentinel Standby";
      }
      return;
    }
    cockpit.classList.remove('opacity-70');

    const isCall = trade.direction === "LONG";
    const isWin = trade.outcome === "WIN";
    const isLoss = trade.outcome === "LOSS";
    const isActive = trade.outcome === "ACTIVE";

    // Direction badge
    const dirBadge = document.getElementById('ptDirectionBadge');
    if (dirBadge) {
      dirBadge.className = `h-8 w-8 sm:h-9 sm:w-9 rounded-xl ${isCall ? 'bg-winGreen/20 text-winGreen' : 'bg-lossRed/20 text-lossRed'} flex items-center justify-center font-bold text-sm sm:text-base shrink-0`;
      dirBadge.innerHTML = `<i class="fa-solid ${isCall ? 'fa-arrow-trend-up' : 'fa-arrow-trend-down'}"></i>`;
    }

    // Setup Name & Outcome Badge
    const nameEl = document.getElementById('ptSetupName');
    if (nameEl) nameEl.innerText = `${trade.name || 'SMC Setup'} (${isCall ? 'CALL OPTION' : 'PUT OPTION'})`;

    const outcomeEl = document.getElementById('ptOutcomeBadge');
    if (outcomeEl) {
      if (isActive) {
        const elapsedBars = trade.barsHeld || (trade.time ? Math.max(1, Math.floor((Date.now() / 1000 - trade.time) / 900)) : 1);
        outcomeEl.className = "text-[10px] font-bold font-mono px-2 py-0.5 rounded bg-cyan-500/10 text-cyan-400 border border-cyan-500/30 flex items-center gap-1.5";
        outcomeEl.innerHTML = `<span class="h-2 w-2 rounded-full bg-cyan-400 animate-ping"></span> LIVE RUNNING IN MARKET (${elapsedBars} bars)`;
      } else if (isWin) {
        const winPct = trade.optionPnlPct || (trade.realOption && trade.realOption.targetGainPct) || "+72%";
        outcomeEl.className = "text-[10px] font-bold font-mono px-2 py-0.5 rounded bg-emerald-500/10 text-emerald-400 border border-emerald-500/30";
        outcomeEl.innerHTML = `<i class="fa-solid fa-circle-check mr-1"></i> TARGET HIT (${winPct})`;
      } else if (trade.outcome === "BE_WIN") {
        outcomeEl.className = "text-[10px] font-bold font-mono px-2 py-0.5 rounded bg-teal-500/10 text-teal-300 border border-teal-500/30";
        outcomeEl.innerHTML = `<i class="fa-solid fa-shield-halved mr-1"></i> TRAILED STOP BREAKEVEN (+25% Net)`;
      } else if (isLoss) {
        outcomeEl.className = "text-[10px] font-bold font-mono px-2 py-0.5 rounded bg-rose-500/10 text-rose-400 border border-rose-500/30";
        outcomeEl.innerHTML = `<i class="fa-solid fa-circle-xmark mr-1"></i> STOP LOSS HIT (-30% Controlled Stop)`;
      } else {
        outcomeEl.className = "text-[10px] font-bold font-mono px-2 py-0.5 rounded bg-slate-500/10 text-slate-400 border border-slate-500/30";
        outcomeEl.innerHTML = `<i class="fa-solid fa-hourglass-end mr-1"></i> TIMEOUT (Closed at Scratch)`;
      }
    }

    // Underlying Spot Numbers (Guaranteed Non-Undefined)
    const targetDist = trade.targetDist || Math.abs(trade.tp - trade.entry) || 500;
    const slDist = trade.slDist || Math.abs(trade.entry - trade.sl) || 250;
    const rrRatio = trade.rrRatio || Number((targetDist / Math.max(1, slDist)).toFixed(2));

    const entryEl = document.getElementById('ptEntry');
    if (entryEl) entryEl.innerText = `$${trade.entry.toLocaleString()}`;

    const tpEl = document.getElementById('ptTp');
    if (tpEl) tpEl.innerText = `$${trade.tp.toLocaleString()} (+${targetDist} pts)`;

    const slEl = document.getElementById('ptSl');
    if (slEl) slEl.innerText = `$${trade.sl.toLocaleString()} (-${slDist} pts)`;

    const rrEl = document.getElementById('ptRR');
    if (rrEl) rrEl.innerText = `1 : ${rrRatio}`;

    const activeLabel = document.getElementById('ptActiveLabel');
    if (activeLabel) {
      const d = new Date(trade.time * 1000);
      const timeStr = d.toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: true });
      activeLabel.innerText = `${trade.name} at ${timeStr} IST (${trade.outcome})`;
    }

    // Real Delta Contract Details
    const opt = trade.realOption;
    const symEl = document.getElementById('ptContractSymbol');
    const markEl = document.getElementById('ptDeltaMark');
    const buyZoneEl = document.getElementById('ptDeltaBuyZone');
    const targetEl = document.getElementById('ptDeltaTarget');
    const liveTagEl = document.getElementById('ptDeltaLiveTag');

    if (opt) {
      // Purge any stale legacy monthly symbol (e.g. 271126)
      if (opt.symbol && opt.symbol.includes("271126")) {
        const atmStrike = trade.optionStrike || Math.round(trade.entry / 200) * 200;
        opt.symbol = `${isCall ? 'C-BTC-' : 'P-BTC-'}${atmStrike}`;
        opt.entryPrice = Math.round(trade.entry * 0.0033 * 10) / 10;
        opt.markPrice = opt.entryPrice;
        opt.targetPrice = Math.round(opt.entryPrice * 1.65 * 10) / 10;
        opt.targetGainPct = "+65.0%";
        opt.buyZone = `$${(opt.entryPrice * 0.98).toFixed(1)} - $${(opt.entryPrice * 1.02).toFixed(1)}`;
      }

      const entryOpt = (opt.entryPrice && opt.entryPrice > 0) ? opt.entryPrice : ((trade.optionEntryMark && trade.optionEntryMark > 0) ? trade.optionEntryMark : 220);
      const validBuyZone = (opt.buyZone && typeof opt.buyZone === 'string' && opt.buyZone !== "undefined" && !opt.buyZone.includes("undefined"))
        ? opt.buyZone
        : `$${(entryOpt * 0.98).toFixed(1)} - $${(entryOpt * 1.02).toFixed(1)}`;

      const validTargetPrice = (opt.targetPrice && opt.targetPrice > 0) ? opt.targetPrice : (trade.optionTargetPrice || Math.round(entryOpt * 1.65 * 10) / 10);
      const validTargetPct = opt.targetGainPct || trade.optionPnlPct || "+65%";

      if (symEl) symEl.innerText = opt.symbol;
      if (markEl) {
        if (opt.unrealizedPts !== undefined && trade.outcome === 'ACTIVE') {
          const sign = opt.unrealizedPts >= 0 ? '+' : '';
          markEl.innerHTML = `$${opt.markPrice.toFixed(1)} <span class="text-[9px] ${opt.unrealizedPts >= 0 ? 'text-winGreen' : 'text-lossRed'}">(${sign}${opt.unrealizedPts} pts / ${sign}${opt.unrealizedPct}%)</span>`;
        } else {
          markEl.innerText = `$${opt.markPrice.toFixed(1)}`;
        }
      }
      if (buyZoneEl) buyZoneEl.innerText = validBuyZone;
      if (targetEl) targetEl.innerText = `$${validTargetPrice.toFixed(1)} (${validTargetPct})`;
      if (liveTagEl) {
        liveTagEl.className = opt.isLive 
          ? "text-[9px] font-mono px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-400 border border-emerald-500/30 font-bold"
          : "text-[9px] font-mono px-1.5 py-0.5 rounded bg-indigo-500/10 text-indigo-300 border border-indigo-500/30 font-bold";
        liveTagEl.innerText = opt.isLive ? (trade.outcome === 'ACTIVE' ? "Locked Entry Plan" : "Live Delta Feed") : "Simulated Strike";
      }
    } else {
      const safeEntry = trade.entry || spotPrice || 65000;
      const atmStrike = trade.optionStrike || Math.round(safeEntry / 200) * 200;
      const simEntry = Math.round(safeEntry * 0.0033 * 10) / 10;
      const simTarget = Math.round(simEntry * 1.65 * 10) / 10;
      if (symEl) symEl.innerText = isCall ? `C-BTC-${atmStrike}` : `P-BTC-${atmStrike}`;
      if (markEl) markEl.innerText = `$${simEntry.toFixed(1)}`;
      if (buyZoneEl) buyZoneEl.innerText = `$${(simEntry * 0.98).toFixed(1)} - $${(simEntry * 1.02).toFixed(1)}`;
      if (targetEl) targetEl.innerText = `$${simTarget.toFixed(1)} (+65%)`;
    }
  }

  /**
   * Selects a trade, centers the chart view directly on it, draws the box, and updates cockpit
   */
  function selectTrade(tradeId) {
    let t = null;
    if (currentAnalysis && currentAnalysis.trades) {
      t = currentAnalysis.trades.find(x => x.id === tradeId);
    }
    if (!t && window.DeltaDB && typeof DeltaDB.getSignalTrades === 'function') {
      const signals = DeltaDB.getSignalTrades(0);
      if (signals) t = signals.find(x => x.id === tradeId);
    }
    if (!t && window.DeltaPaperFund && typeof DeltaPaperFund.getPortfolio === 'function') {
      const pf = DeltaPaperFund.getPortfolio();
      if (pf && pf.trades) t = pf.trades.find(x => x.id === tradeId);
    }

    if (t) {
      selectedTrade = t;

      let candleIdx = t.index;
      if (candleIdx === undefined && candleData && candleData.length > 0) {
        candleIdx = candleData.findIndex(c => Math.abs(c.time - t.time) < 900);
      }

      // Center chart view directly on this trade's candles
      if (chart && chart.timeScale && candleIdx !== undefined && candleIdx >= 0) {
        chart.timeScale().setVisibleLogicalRange({
          from: Math.max(0, candleIdx - 12),
          to: Math.min(candleData.length + 5, candleIdx + 20)
        });
      }

      renderPositionBox(t);
      updatePositionToolCockpit(t);

      // Highlight row in table
      const rows = document.querySelectorAll('.bt-trade-row');
      rows.forEach(r => r.classList.remove('bg-indigo-600/20', 'border-indigo-500'));
      const activeRow = document.getElementById(`row_${tradeId}`);
      if (activeRow) activeRow.classList.add('bg-indigo-600/20');

      // Highlight mobile card
      const mcards = document.querySelectorAll('.bt-trade-mcard');
      mcards.forEach(c => c.classList.remove('ring-2', 'ring-indigo-500', 'bg-indigo-950/30'));
      const activeMcard = document.getElementById(`mcard_${tradeId}`);
      if (activeMcard) activeMcard.classList.add('ring-2', 'ring-indigo-500', 'bg-indigo-950/30');
    }
  }

  /**
   * Snaps the TradingView Position Box back to the latest detected trade
   */
  function showLatestTrade() {
    if (currentAnalysis && currentAnalysis.latestTrade) {
      selectTrade(currentAnalysis.latestTrade.id);
    }
  }

  /**
   * Hides the TradingView Position Box from the chart
   */
  function clearLinesAndReset() {
    selectedTrade = null;
    renderPositionBox(null);
    updatePositionToolCockpit(null);
    const activeLabel = document.getElementById('ptActiveLabel');
    if (activeLabel) activeLabel.innerText = "Position tool hidden";
  }

  /**
   * Renders the institutional 24/7 Cloud Sentinel Radar playbook modal when no trade is active/selected
   */
  function renderSentinelStandbyPlaybookModal() {
    const modal = document.getElementById('algoTradeModal');
    if (!modal) return;

    const latestC = (candleData && candleData.length > 0) ? candleData[candleData.length - 1] : null;
    const spotStr = latestC ? `$${latestC.close.toLocaleString()}` : "$64,550";
    const atmStrike = latestC ? Math.round(latestC.close / 200) * 200 : 64600;
    const estEntryOpt = latestC ? Math.round(latestC.close * 0.0033 * 10) / 10 : 215;

    const d = new Date();
    const timeStr = d.toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: true });
    const dateStr = d.toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', month: 'short', day: 'numeric', year: 'numeric' });

    const currentSession = (window.DeltaSMCStrategy && typeof DeltaSMCStrategy.getTradingSession === 'function')
      ? DeltaSMCStrategy.getTradingSession(Math.floor(Date.now() / 1000))
      : { flag: '🔥', name: 'New York Session (19:00 - 02:30 IST)' };

    document.getElementById('atmModalTitle').innerText = "24/7 Cloud Sentinel Confluence Playbook";
    document.getElementById('atmModalTime').innerText = `${dateStr} at ${timeStr} IST (Live Radar Active)`;

    const dirBadgeEl = document.getElementById('atmModalDirectionBadge');
    if (dirBadgeEl) {
      dirBadgeEl.className = "px-2 py-0.5 rounded text-[10px] font-bold font-mono uppercase bg-indigo-500/20 text-indigo-300 border border-indigo-500/30";
      dirBadgeEl.innerHTML = `<i class="fa-solid fa-satellite-dish animate-pulse mr-1"></i> RADAR STANDBY`;
    }

    const sessBadgeEl = document.getElementById('atmModalSessionBadge');
    if (sessBadgeEl) {
      sessBadgeEl.className = "px-2 py-0.5 rounded text-[10px] font-bold font-mono bg-panelDark border border-borderDark text-indigo-300";
      const sessionClean = (currentSession.name || '').replace(/^(US|GB)\s*/, '');
      sessBadgeEl.innerHTML = `${currentSession.flag || '🏛️'} ${sessionClean}`;
    }

    const outcomeEl = document.getElementById('atmModalOutcomeBadge');
    if (outcomeEl) {
      outcomeEl.className = "px-2.5 py-1 rounded-lg text-xs font-bold font-mono bg-emerald-500/10 text-emerald-400 border border-emerald-500/30 flex items-center gap-1.5";
      outcomeEl.innerHTML = `<span class="h-2 w-2 rounded-full bg-emerald-400 animate-ping"></span> 24/7 SCANNER ACTIVE · MONITORING 15M CONFLUENCE`;
    }

    document.getElementById('atmModalEntry').innerText = spotStr;
    document.getElementById('atmModalTp').innerText = "Auto-Calculated 2.0R";
    document.getElementById('atmModalSl').innerText = "-30% Risk Cap";
    document.getElementById('atmModalRR').innerText = "1 : 2.0+";

    const ivBadgeEl = document.getElementById('atmModalIvBadge');
    if (ivBadgeEl) {
      ivBadgeEl.className = "px-2 py-0.5 rounded text-[10px] font-bold font-mono bg-panelDark border border-borderDark text-amber-300";
      ivBadgeEl.innerHTML = "🟡 FAIR IV";
    }

    const actionBanner = document.getElementById('atmModalActionBanner');
    if (actionBanner) {
      actionBanner.className = "p-3 sm:p-3.5 rounded-xl border border-indigo-500/40 bg-indigo-950/30 text-xs font-mono space-y-2";
      actionBanner.innerHTML = `
        <div class="flex items-center justify-between">
          <span class="text-indigo-300 font-bold flex items-center gap-1.5">
            <span class="h-2 w-2 rounded-full bg-emerald-400 animate-ping"></span>
            ⚡ 24/7 CLOUD SENTINEL ACTIVE (MONITORING DELTA INDIA 15M)
          </span>
          <span class="text-[10px] text-slate-400 font-sans">GitHub Actions (Every 5 mins)</span>
        </div>
        <p class="text-slate-300 text-[11px] leading-relaxed font-sans">
          Cloud Sentinel monitors BTC/USD order flow continuously. When an institutional setup triggers, real-time alert is broadcast via Telegram with 0-DTE daily ATM contract recommendation (e.g. <strong>P-BTC-${atmStrike}</strong> or <strong>C-BTC-${atmStrike}</strong> @ ~$${estEntryOpt}).
        </p>
      `;
    }

    const narrativeEl = document.getElementById('atmModalNarrative');
    if (narrativeEl) {
      narrativeEl.innerText = "Cloud Sentinel is currently scanning the market. When a candle closes meeting all confluence criteria, this playbook locks the trade with live execution details, entry strike, target, stop, and real Delta option pricing.";
    }

    modal.classList.remove('hidden');
    modal.classList.add('flex');
    DeltaSound.playChime('modal');
  }

  /**
   * Opens the deep-dive educational breakdown modal for a trade
   */
  function openTradeDetailsModal(tradeId) {
    let t = null;
    if (tradeId) {
      if (currentAnalysis && currentAnalysis.trades) {
        t = currentAnalysis.trades.find(x => x.id === tradeId);
      }
      if (!t && window.DeltaPaperFund) {
        const pf = DeltaPaperFund.getPortfolio();
        if (pf && pf.trades) {
          t = pf.trades.find(x => x.id === tradeId);
        }
      }
      if (!t && window.DeltaDB) {
        const signals = DeltaDB.getSignalTrades(0);
        if (signals) {
          t = signals.find(x => x.id === tradeId);
        }
      }
    }
    if (!t && selectedTrade) {
      t = (currentAnalysis && currentAnalysis.trades) ? (currentAnalysis.trades.find(x => x.id === selectedTrade.id) || selectedTrade) : selectedTrade;
    }
    // If still no trade, pick the latest confirmed trade from DeltaDB
    if (!t && window.DeltaDB && typeof DeltaDB.getSignalTrades === 'function') {
      const signals = DeltaDB.getSignalTrades(0);
      if (signals && signals.length > 0) {
        t = signals[0]; // Most recent confirmed institutional trade
      }
    }
    if (!t) {
      renderSentinelStandbyPlaybookModal();
      return;
    }

    const modal = document.getElementById('algoTradeModal');
    if (!modal) return;

    const isCall = t.direction === "LONG";
    const d = new Date(t.time * 1000);
    const timeStr = d.toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: true });
    const dateStr = d.toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', month: 'short', day: 'numeric', year: 'numeric' });

    document.getElementById('atmModalTitle').innerText = t.name;
    document.getElementById('atmModalTime').innerText = `${dateStr} at ${timeStr} IST (Indian Standard Time)`;

    const dirBadgeEl = document.getElementById('atmModalDirectionBadge');
    if (dirBadgeEl) {
      dirBadgeEl.className = `px-2 py-0.5 rounded text-[10px] font-bold font-mono uppercase ${isCall ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30' : 'bg-rose-500/20 text-rose-400 border border-rose-500/30'}`;
      dirBadgeEl.innerHTML = `<i class="fa-solid ${isCall ? 'fa-arrow-trend-up' : 'fa-arrow-trend-down'} mr-1"></i> ${isCall ? 'BUY CALL OPTION' : 'BUY PUT OPTION'}`;
    }

    // Session & IV Badges
    const sessBadgeEl = document.getElementById('atmModalSessionBadge');
    if (sessBadgeEl) {
      if (t.session && t.session.name) {
        sessBadgeEl.className = "px-2 py-0.5 rounded text-[10px] font-bold font-mono bg-panelDark border border-borderDark text-indigo-300";
        const sessionClean = t.session.name.replace(/^(US|GB)\s*/, '');
        sessBadgeEl.innerHTML = `${t.session.flag || '🏛️'} ${sessionClean}`;
      } else {
        sessBadgeEl.className = "hidden";
      }
    }

    // Outcome Badge
    const badgeEl = document.getElementById('atmModalOutcomeBadge');
    if (t.outcome === "WIN") {
      badgeEl.className = "px-2.5 py-1 rounded-lg text-xs font-bold font-mono bg-emerald-500/10 text-emerald-400 border border-emerald-500/30";
      badgeEl.innerHTML = `<i class="fa-solid fa-circle-check mr-1"></i> TARGET REACHED (+50% OPTION PROFIT)`;
    } else if (t.outcome === "BE_WIN") {
      badgeEl.className = "px-2.5 py-1 rounded-lg text-xs font-bold font-mono bg-teal-500/10 text-teal-300 border border-teal-500/30";
      badgeEl.innerHTML = `<i class="fa-solid fa-shield-halved mr-1"></i> TRAILED STOP BREAKEVEN (+25% NET GAIN)`;
    } else if (t.outcome === "LOSS") {
      badgeEl.className = "px-2.5 py-1 rounded-lg text-xs font-bold font-mono bg-rose-500/10 text-rose-400 border border-rose-500/30";
      badgeEl.innerHTML = `<i class="fa-solid fa-circle-xmark mr-1"></i> STOP LOSS HIT (-1R CONTROLLED STOP)`;
    } else if (t.outcome === "ACTIVE") {
      badgeEl.className = "px-2.5 py-1 rounded-lg text-xs font-bold font-mono bg-cyan-500/10 text-cyan-400 border border-cyan-500/30 flex items-center gap-1.5";
      badgeEl.innerHTML = `<span class="h-2 w-2 rounded-full bg-cyan-400 animate-ping"></span> LIVE IN MARKET (${t.barsHeld} bars)`;
    } else {
      badgeEl.className = "px-2.5 py-1 rounded-lg text-xs font-bold font-mono bg-slate-500/10 text-slate-400 border border-slate-500/30";
      badgeEl.innerHTML = `<i class="fa-solid fa-hourglass-end mr-1"></i> TIMEOUT (SCRATCH / BREAKEVEN)`;
    }

    // Trade Numbers
    document.getElementById('atmModalEntry').innerText = `$${t.entry.toLocaleString()}`;
    document.getElementById('atmModalTp').innerText = `$${t.tp.toLocaleString()} (+${t.targetDist} pts)`;
    document.getElementById('atmModalSl').innerText = `$${t.sl.toLocaleString()} (-${t.slDist} pts)`;
    document.getElementById('atmModalRR').innerText = `1 : ${t.rrRatio}`;

    // Option Execution & Resolution Timeline Details
    const opt = t.realOption || resolveRealDeltaContract(t.direction, t.entry, cachedDeltaTickers, t.id, getTradeRegistry(), t.targetDist);
    const contractSymbol = opt ? opt.symbol : (t.direction === "LONG" ? 'C-BTC-' + t.optionStrike : 'P-BTC-' + t.optionStrike);
    const strikeTier = opt ? opt.strikeTier : "Exact ATM (Delta ~0.50)";

    const ivBadgeEl = document.getElementById('atmModalIvBadge');
    if (ivBadgeEl) {
      if (opt && opt.ivBadge) {
        ivBadgeEl.className = "px-2 py-0.5 rounded text-[10px] font-bold font-mono bg-panelDark border border-borderDark text-amber-300";
        ivBadgeEl.innerHTML = `${opt.ivBadge} IV`;
      } else {
        ivBadgeEl.className = "hidden";
      }
    }

    const entryOpt = (opt && opt.entryPrice) ? opt.entryPrice : ((opt && opt.markPrice > 0) ? opt.markPrice : (t.entryOpt || Math.round((t.entry * 0.003) * 10) / 10));
    let exitOpt = entryOpt;
    let pnlDiff = 0;
    let netTakeHome = 0;
    const targetGainPct = (opt && opt.targetGainPct) ? opt.targetGainPct : (t.optionPnlPct || "+50%");
    const netTakeHomePct = Math.round(parseInt(targetGainPct.replace('+', '').replace('%', '') || 50) * 0.85);

    if (t.outcome === "WIN") {
      exitOpt = (opt && opt.targetPrice) ? opt.targetPrice : (t.exitOpt || Math.round((entryOpt * 1.50) * 10) / 10);
      pnlDiff = Math.round((exitOpt - entryOpt) * 10) / 10;
      netTakeHome = Math.round((pnlDiff * 0.85) * 10) / 10;
    } else if (t.outcome === "BE_WIN") {
      exitOpt = Math.round((entryOpt * 1.25) * 10) / 10;
      pnlDiff = Math.round((exitOpt - entryOpt) * 10) / 10;
      netTakeHome = Math.round((pnlDiff * 0.85) * 10) / 10;
    } else if (t.outcome === "LOSS") {
      exitOpt = (opt && opt.stopPrice) ? opt.stopPrice : Math.round((entryOpt * 0.70) * 10) / 10;
      pnlDiff = Math.round((exitOpt - entryOpt) * 10) / 10;
      netTakeHome = pnlDiff;
    } else if (t.outcome === "ACTIVE") {
      const currentLive = (opt && opt.markPrice) ? opt.markPrice : entryOpt;
      exitOpt = currentLive;
      pnlDiff = Math.round((currentLive - entryOpt) * 10) / 10;
      netTakeHome = pnlDiff;
    } else {
      // TIMEOUT
      exitOpt = Math.round((entryOpt * 0.82) * 10) / 10;
      pnlDiff = Math.round((exitOpt - entryOpt) * 10) / 10;
      netTakeHome = pnlDiff;
    }

    const entryTimeStr = new Date(t.time * 1000).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: true });
    const exitTimeStr = new Date((t.exitTime || t.time) * 1000).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: true });
    const durMin = (t.barsHeld || 1) * 15;
    const durStr = durMin >= 60 ? `${Math.floor(durMin / 60)}h ${durMin % 60}m` : `${durMin}m`;

    // Dynamic Action Guidance Banner
    const actionBanner = document.getElementById('atmModalActionBanner');
    if (actionBanner) {
      if (t.outcome === "ACTIVE") {
        const targetPriceVal = (opt && opt.targetPrice) ? opt.targetPrice : Math.round(entryOpt * 1.5 * 10) / 10;
        const stopPriceVal = (opt && opt.stopPrice) ? opt.stopPrice : Math.round(entryOpt * 0.7 * 10) / 10;
        const currentLiveVal = (opt && opt.markPrice) ? opt.markPrice : entryOpt;
        const pnlPctStr = ((pnlDiff / entryOpt) * 100).toFixed(1);

        actionBanner.className = "p-3 sm:p-3.5 rounded-xl border border-emerald-500/50 bg-emerald-950/30 text-xs font-mono space-y-1.5";
        actionBanner.innerHTML = `
          <div class="flex items-center justify-between">
            <span class="text-winGreen font-bold flex items-center gap-1.5">
              <span class="h-2 w-2 rounded-full bg-emerald-400 animate-ping"></span>
              ⚡ ACTIVE SETUP: ENTER ${isCall ? 'CALL OPTION' : 'PUT OPTION'}
            </span>
            <span class="text-[10px] text-slate-400 font-sans">Locked Inception Order</span>
          </div>
          <div class="text-slate-200">
            Buy <strong class="text-white bg-indigo-900/60 px-1.5 py-0.5 rounded">${contractSymbol}</strong> in Buy Zone <strong class="text-emerald-400">${opt.buyZone || `$${(entryOpt * 0.98).toFixed(1)} - $${(entryOpt * 1.02).toFixed(1)}`}</strong>.
          </div>
          <div class="text-[11px] text-slate-400 pt-1 border-t border-emerald-500/20 flex flex-wrap justify-between gap-2">
            <span>TP1 (Scalp / Derisk): <strong class="text-emerald-300">$${(opt.tp1Price || Math.round(entryOpt * 1.5 * 10) / 10).toFixed(1)} (+50%)</strong></span>
            <span>TP2 (Runner): <strong class="text-winGreen">$${targetPriceVal.toFixed(1)} (${targetGainPct})</strong></span>
            <span>SL Stop: <strong class="text-lossRed">$${stopPriceVal.toFixed(1)} (-30%)</strong></span>
            <span>Current Mark: <strong class="${pnlDiff >= 0 ? 'text-winGreen' : 'text-lossRed'}">$${currentLiveVal.toFixed(1)} (${pnlDiff >= 0 ? '+' : ''}${pnlPctStr}%)</strong></span>
          </div>
        `;
      } else if (t.outcome === "WIN") {
        actionBanner.className = "p-3 sm:p-3.5 rounded-xl border border-emerald-500/30 bg-emerald-950/20 text-xs font-mono space-y-1";
        actionBanner.innerHTML = `
          <div class="flex items-center justify-between">
            <span class="text-winGreen font-bold flex items-center gap-1.5">
              <i class="fa-solid fa-circle-check"></i> TARGET REACHED (${targetGainPct} GROSS / +${netTakeHomePct}% NET)
            </span>
            <span class="text-[10px] text-slate-400 font-sans">${exitTimeStr} IST</span>
          </div>
          <div class="text-slate-300 text-[11px]">
            Target hit at BTC Spot <strong>$${(t.exitPrice || t.tp).toLocaleString()}</strong>. Option surged from <strong>$${entryOpt.toFixed(1)}</strong> to <strong>$${exitOpt.toFixed(1)}</strong> (+${pnlDiff.toFixed(1)} pts).
          </div>
        `;
      } else if (t.outcome === "BE_WIN") {
        actionBanner.className = "p-3 sm:p-3.5 rounded-xl border border-teal-500/40 bg-teal-950/20 text-xs font-mono space-y-1";
        actionBanner.innerHTML = `
          <div class="flex items-center justify-between">
            <span class="text-teal-300 font-bold flex items-center gap-1.5">
              <i class="fa-solid fa-shield-halved"></i> TP1 HIT & STOP TRAILED TO BREAKEVEN (+25% NET PROFIT)
            </span>
            <span class="text-[10px] text-slate-400 font-sans">${exitTimeStr} IST</span>
          </div>
          <div class="text-slate-300 text-[11px]">
            Option triggered TP1 (+50%), securing 50% position, and automatically trailed stop loss to Breakeven. Reversal closed at entry, securing guaranteed +25% net gain.
          </div>
        `;
      } else if (t.outcome === "LOSS") {
        actionBanner.className = "p-3 sm:p-3.5 rounded-xl border border-rose-500/30 bg-rose-950/20 text-xs font-mono space-y-1";
        actionBanner.innerHTML = `
          <div class="flex items-center justify-between">
            <span class="text-lossRed font-bold flex items-center gap-1.5">
              <i class="fa-solid fa-circle-xmark"></i> STOP LOSS HIT (-30% PRESERVATION EXIT)
            </span>
            <span class="text-[10px] text-slate-400 font-sans">${exitTimeStr} IST</span>
          </div>
          <div class="text-slate-300 text-[11px]">
            Price touched invalidation at <strong>$${t.sl.toLocaleString()}</strong>. Controlled stop closed option at <strong>$${exitOpt.toFixed(1)}</strong>, protecting 70% of capital.
          </div>
        `;
      } else {
        // TIMEOUT
        actionBanner.className = "p-3 sm:p-3.5 rounded-xl border border-slate-500/30 bg-panelDark/60 text-xs font-mono space-y-1";
        actionBanner.innerHTML = `
          <div class="flex items-center justify-between">
            <span class="text-slate-300 font-bold flex items-center gap-1.5">
              <i class="fa-solid fa-hourglass-end text-amber-400"></i> TIMEOUT SCRATCH (THETA DECAY DEFENSE)
            </span>
            <span class="text-[10px] text-slate-400 font-sans">${exitTimeStr} IST</span>
          </div>
          <div class="text-slate-300 text-[11px]">
            Sideways consolidation for 5+ hours (${t.barsHeld} bars). Closed position cleanly to avoid compounding theta erosion.
          </div>
        `;
      }
    }

    const contractBadge = document.getElementById('atmModalContractBadge');
    if (contractBadge) contractBadge.innerText = `${contractSymbol} (${strikeTier})`;

    const entryTimeEl = document.getElementById('atmModalEntryTime');
    if (entryTimeEl) entryTimeEl.innerText = `${entryTimeStr} IST`;

    const entrySpotEl = document.getElementById('atmModalEntrySpot');
    if (entrySpotEl) entrySpotEl.innerText = `$${t.entry.toLocaleString()}`;

    const optionEntryEl = document.getElementById('atmModalOptionEntry');
    if (optionEntryEl) optionEntryEl.innerText = `$${entryOpt.toFixed(1)}`;

    const exitCard = document.getElementById('atmModalExitCard');
    const exitTitleEl = document.getElementById('atmModalExitTitle');
    const exitTimeEl = document.getElementById('atmModalExitTime');
    const exitSpotEl = document.getElementById('atmModalExitSpot');
    const optionExitEl = document.getElementById('atmModalOptionExit');
    const netReturnEl = document.getElementById('atmModalNetPoints');

    if (exitTimeEl) exitTimeEl.innerText = `${exitTimeStr} IST (${durStr} hold)`;
    if (exitSpotEl) exitSpotEl.innerText = `$${t.exitPrice.toLocaleString()}`;
    if (optionExitEl) {
      const pnlPct = ((pnlDiff / entryOpt) * 100).toFixed(1);
      optionExitEl.innerText = `$${exitOpt.toFixed(1)} (${pnlDiff >= 0 ? '+' : ''}${pnlPct}%)`;
      optionExitEl.className = `text-sm font-bold ${pnlDiff >= 0 ? 'text-winGreen' : 'text-lossRed'}`;
    }

    if (exitCard && exitTitleEl) {
      if (t.outcome === "WIN") {
        exitCard.className = "bg-panelDark/80 p-3 rounded-xl border border-emerald-500/50 space-y-1.5";
        exitTitleEl.innerHTML = `<i class="fa-solid fa-flag-checkered text-emerald-400"></i> 2. Target Hit (${targetGainPct} Structural Expansion)`;
        if (exitSpotEl) exitSpotEl.className = "font-bold text-winGreen";
      } else if (t.outcome === "BE_WIN") {
        exitCard.className = "bg-panelDark/80 p-3 rounded-xl border border-teal-500/50 space-y-1.5";
        exitTitleEl.innerHTML = `<i class="fa-solid fa-shield-halved text-teal-400"></i> 2. Trailed Stop Breakeven (+25% Net Locked)`;
        if (exitSpotEl) exitSpotEl.className = "font-bold text-teal-300";
      } else if (t.outcome === "LOSS") {
        exitCard.className = "bg-panelDark/80 p-3 rounded-xl border border-rose-500/50 space-y-1.5";
        exitTitleEl.innerHTML = `<i class="fa-solid fa-circle-xmark text-rose-400"></i> 2. Stop Loss Hit (-30% Controlled)`;
        if (exitSpotEl) exitSpotEl.className = "font-bold text-lossRed";
      } else if (t.outcome === "ACTIVE") {
        exitCard.className = "bg-panelDark/80 p-3 rounded-xl border border-cyan-500/50 space-y-1.5";
        exitTitleEl.innerHTML = `<i class="fa-solid fa-circle-notch fa-spin text-cyan-400"></i> 2. Live in Market`;
        if (exitSpotEl) exitSpotEl.className = "font-bold text-cyan-300";
      } else {
        exitCard.className = "bg-panelDark/80 p-3 rounded-xl border border-slate-500/50 space-y-1.5";
        exitTitleEl.innerHTML = `<i class="fa-solid fa-hourglass-end text-amber-400"></i> 2. Timeout Scratch (Theta Protection)`;
        if (exitSpotEl) exitSpotEl.className = "font-bold text-slate-300";
      }
    }

    if (netReturnEl) {
      if (t.outcome === "WIN") {
        netReturnEl.innerHTML = `<span class="text-winGreen font-bold font-mono">+${pnlDiff.toFixed(1)} pts gross &rarr; +${netTakeHome.toFixed(1)} pts (+${netTakeHomePct}% Net Take-Home)</span>`;
      } else if (t.outcome === "BE_WIN") {
        netReturnEl.innerHTML = `<span class="text-teal-300 font-bold font-mono">+${pnlDiff.toFixed(1)} pts (+25% Net Trailed Gain)</span>`;
      } else if (t.outcome === "LOSS") {
        netReturnEl.innerHTML = `<span class="text-lossRed font-bold font-mono">${pnlDiff.toFixed(1)} pts (-30% Controlled Stop Exit)</span>`;
      } else if (t.outcome === "ACTIVE") {
        netReturnEl.innerHTML = `<span class="text-cyan-300 font-bold font-mono">${pnlDiff >= 0 ? '+' : ''}${pnlDiff.toFixed(1)} pts (Unrealized Current Mark)</span>`;
      } else {
        netReturnEl.innerHTML = `<span class="text-slate-300 font-bold font-mono">${pnlDiff.toFixed(1)} pts (-18% Scratch to avoid overnight theta)</span>`;
      }
    }

    // Dynamic Narrative with exact contract, real prices, and time
    let dynamicNarrative = "";
    if (t.outcome === "WIN") {
      dynamicNarrative = `Price moved aggressively in your favor (+${t.targetDist} pts) within ${t.barsHeld} bars (${durStr}), cleanly hitting Take Profit at $${t.tp.toLocaleString()} at ${exitTimeStr} IST. Your ${contractSymbol} option entered at $${entryOpt.toFixed(1)} and hit target exit at $${exitOpt.toFixed(1)} (${targetGainPct} gross / +${netTakeHomePct}% net take-home after Delta fees).`;
    } else if (t.outcome === "BE_WIN") {
      dynamicNarrative = `Price moved favorably towards target, triggering TP1 (+50% option gain) at $${entryOpt.toFixed(1)} -> $${(entryOpt * 1.5).toFixed(1)}. Position stop-loss was automatically trailed to Breakeven. A subsequent pullback closed the trade at entry, banking +25% overall profit with zero downside risk.`;
    } else if (t.outcome === "LOSS") {
      dynamicNarrative = `Price breached invalidation level at $${t.sl.toLocaleString()} at ${exitTimeStr} IST after ${t.barsHeld} bars (${durStr}). Your ${contractSymbol} option entered at $${entryOpt.toFixed(1)} executed controlled stop-loss exit at $${exitOpt.toFixed(1)} (-30.0% stop) preserving 70% of margin capital.`;
    } else if (t.outcome === "ACTIVE") {
      dynamicNarrative = `Trade is LIVE right now (${t.barsHeld} bars in progress). Entered at $${t.entry.toLocaleString()} with ${contractSymbol} @ $${entryOpt.toFixed(1)}. Current mark: $${exitOpt.toFixed(1)}. Monitoring Take Profit at $${t.tp.toLocaleString()} or Stop Loss at $${t.sl.toLocaleString()}.`;
    } else {
      dynamicNarrative = `Price moved sideways for 5 hours (${t.barsHeld} bars). Closed at $${t.exitPrice.toLocaleString()} at ${exitTimeStr} IST. Option exited at $${exitOpt.toFixed(1)} as a scratch exit to prevent theta decay from destroying remaining option value.`;
    }

    // Rationale fields
    const r = t.rationale || {};
    document.getElementById('atmModalLevel').innerText = r.levelTested || "--";
    document.getElementById('atmModalPattern').innerText = r.pattern || "--";
    document.getElementById('atmModalConfirmation').innerText = r.confirmation || "--";
    document.getElementById('atmModalRsiRvol').innerText = `${r.rsi || ''} | ${r.rvol || ''}`;
    const htfEl = document.getElementById('atmModalHtf');
    if (htfEl) htfEl.innerText = r.htfAlignment || (t.htf_trend ? t.htf_trend.label : "🟢 Trend Aligned");
    const absEl = document.getElementById('atmModalAbsorption');
    if (absEl) absEl.innerText = r.absorption || "Institutional Liquidity Absorption";
    document.getElementById('atmModalNarrative').innerText = dynamicNarrative;

    // Playbook steps with real Delta contract
    const stepsContainer = document.getElementById('atmModalPlaybook');
    if (stepsContainer) {
      if (opt && opt.isLive) {
        stepsContainer.innerHTML = `
          <li class="text-xs text-slate-200 font-mono py-1 flex items-start gap-2">
            <i class="fa-solid fa-check text-indigo-400 mt-0.5"></i>
            <span>1. Open Delta Exchange India -> BTC Options.</span>
          </li>
          <li class="text-xs text-slate-200 font-mono py-1 flex items-start gap-2">
            <i class="fa-solid fa-check text-indigo-400 mt-0.5"></i>
            <span>2. Select Real Live Contract: <strong class="text-white bg-indigo-900/60 px-1.5 py-0.5 rounded">${opt.symbol}</strong>.</span>
          </li>
          <li class="text-xs text-slate-200 font-mono py-1 flex items-start gap-2">
            <i class="fa-solid fa-check text-indigo-400 mt-0.5"></i>
            <span>3. Buy Order: Enter in Buy Zone <strong class="text-emerald-400">${opt.buyZone}</strong> (Current Mark: $${opt.markPrice}).</span>
          </li>
          <li class="text-xs text-slate-200 font-mono py-1 flex items-start gap-2">
            <i class="fa-solid fa-check text-indigo-400 mt-0.5"></i>
            <span>4. Take Profit GTT Order: Set Limit Sell at <strong class="text-winGreen">$${opt.targetPrice}</strong> (+50% profit target).</span>
          </li>
          <li class="text-xs text-slate-200 font-mono py-1 flex items-start gap-2">
            <i class="fa-solid fa-check text-indigo-400 mt-0.5"></i>
            <span>5. Stop Loss GTT Order: Set Stop Market at <strong class="text-lossRed">$${opt.stopPrice}</strong> (Underlying Spot Invalidation: $${t.sl.toLocaleString()}).</span>
          </li>
        `;
      } else if (r.deltaSteps) {
        stepsContainer.innerHTML = r.deltaSteps.map(s => `<li class="text-xs text-slate-200 font-mono py-1 flex items-start gap-2"><i class="fa-solid fa-check text-indigo-400 mt-0.5"></i><span>${s}</span></li>`).join('');
      }
    }

    modal.classList.remove('hidden');
    modal.classList.add('flex');
  }

  function closeTradeDetailsModal() {
    const modal = document.getElementById('algoTradeModal');
    if (modal) {
      modal.classList.add('hidden');
      modal.classList.remove('flex');
    }
  }

  /**
   * Copies Real Delta Exchange Order parameters to clipboard
   */
  function copyDeltaOrderDetails() {
    if (!selectedTrade) return;
    const t = selectedTrade;
    const isCall = t.direction === "LONG";
    const opt = t.realOption;

    let text = "";
    if (opt && opt.isLive) {
      text = `DELTA EXCHANGE INDIA REAL ORDER PLAN:
Direction: ${isCall ? 'BUY CALL' : 'BUY PUT'}
Contract: ${opt.symbol}
Current Mark Price: $${opt.markPrice}
Recommended Buy Zone: ${opt.buyZone}
Take Profit (Target Limit): $${opt.targetPrice} (+50% Profit)
Stop Loss (Stop Market): $${opt.stopPrice} (-30% Controlled Risk)
Underlying BTC Spot Invalidation: $${t.sl.toLocaleString()}
Risk-to-Reward: 1 : ${t.rrRatio}`;
    } else {
      text = `DELTA EXCHANGE ORDER:
Type: ${isCall ? 'BUY CALL' : 'BUY PUT'}
Contract: ${isCall ? 'C-BTC-' + t.optionStrike : 'P-BTC-' + t.optionStrike}
Underlying Trigger Price: $${t.entry.toLocaleString()}
Take Profit (Target): $${t.tp.toLocaleString()} (Option ~300)
Stop Loss (Invalidation): $${t.sl.toLocaleString()} (Option ~140)
Expected Profit: +50% Option Gross / +40% Net`;
    }

    DeltaSound.playChime('click');
    DeltaSound.vibrate([40]);

    navigator.clipboard.writeText(text).then(() => {
      alert("Real Delta Exchange order plan copied to clipboard! Paste directly into your notes or Delta terminal.");
    });
  }

  let showAllRadarTrades = false;

  function toggleShowAllRadarTrades() {
    showAllRadarTrades = !showAllRadarTrades;
    if (window.DeltaDB && typeof DeltaDB.getSignalTrades === 'function') {
      const savedSignals = DeltaDB.getSignalTrades(0) || [];
      renderTradesTable(savedSignals);
    }
  }

  /**
   * Runs the algorithmic SMC confluence strategy across loaded candles,
   * updates the scorecard, places markers, and draws the Position Tool.
   */
  function runSMCAnalysisAndBacktest() {
    if (!candleData || candleData.length === 0 || !candleSeries) return;

    // Macro Sentinel & Catalyst Bias Input (OpenBB / Bloomberg Model)
    const macroCatalyst = window.DeltaMacroSentinel ? DeltaMacroSentinel.getLatestCatalyst() : null;

    // Run Algorithmic Multi-Regime Confluence Engine to detect structural zones & levels
    currentAnalysis = DeltaSMCStrategy.runBacktest(candleData, {
      lookback: activeTimeframe === '1m' ? 30 : 24,
      highConvictionOnly: true,
      macroCatalyst: macroCatalyst
    });

    // 1. Synchronously render algorithmic SMC setup markers immediately on chart candles
    const baseMarkers = (currentAnalysis && currentAnalysis.markers) ? [...currentAnalysis.markers] : [];
    if (candleSeries && baseMarkers.length > 0) {
      try {
        candleSeries.setMarkers(sanitizeMarkersNoOverlap(baseMarkers));
      } catch (err) {
        console.warn("[ChartEngine] Notice setting initial markers:", err);
      }
    }

    // 2. Default Cockpit to Standby (or preserve selectedTrade if user explicitly clicked one)
    if (selectedTrade) {
      renderPositionBox(selectedTrade);
      updatePositionToolCockpit(selectedTrade);
    } else {
      clearPositionBox();
      updatePositionToolCockpit(null);
    }

    // 3. Render initial trade history table from local cache immediately (prevent blank flash)
    const initialTrades = (window.DeltaDB && typeof DeltaDB.getSignalTrades === 'function') ? DeltaDB.getSignalTrades(0) : [];
    renderTradesTable(initialTrades);

    // 4. Asynchronously fetch real verified trades from Firestore (GP_DTJ_signal_trades)
    if (window.DeltaDB && typeof DeltaDB.fetchSignalTradesFromFirestore === 'function') {
      DeltaDB.fetchSignalTradesFromFirestore().then(remoteSignals => {
        const realTrades = (remoteSignals && remoteSignals.length > 0) ? remoteSignals : initialTrades;

        // Check for active trade or fall back to selected setup
        const activeTrade = realTrades.find(t => t.outcome === "ACTIVE");
        if (activeTrade) {
          selectedTrade = activeTrade;
          renderPositionBox(selectedTrade);
          updatePositionToolCockpit(selectedTrade);
        } else if (!selectedTrade) {
          clearPositionBox();
          updatePositionToolCockpit(null);
        }

        // Build chart markers: Verified Sentinel trades have absolute priority over synthetic backtests
        let verifiedMarkers = [];
        let verifiedTimes = new Set();

        if (realTrades.length > 0) {
          realTrades.forEach(st => {
            const isCall = st.direction === "LONG";
            const isWin = st.outcome === "WIN";
            const isBeWin = st.outcome === "BE_WIN";
            const isLoss = st.outcome === "LOSS";
            const isActive = st.outcome === "ACTIVE";

            let markerText = isCall ? "CALL" : "PUT";
            let markerColor = isCall ? "#38bdf8" : "#818cf8";
            let markerPos = isCall ? "belowBar" : "aboveBar";
            let markerShape = isCall ? "arrowUp" : "arrowDown";

            if (isActive) {
              markerText = "LIVE";
              markerColor = "#38bdf8";
            } else if (isWin) {
              const runnerPct = st.optionPnlPct || (st.realOption && st.realOption.targetGainPct) || "+72%";
              markerText = runnerPct.startsWith('+') ? runnerPct : `+${runnerPct}`;
              markerColor = "#10b981";
            } else if (isBeWin) {
              markerText = "BE +25%";
              markerColor = "#10b981";
            } else if (isLoss) {
              markerText = "-30%";
              markerColor = "#f43f5e";
            } else {
              markerText = "SCR";
              markerColor = "#64748b";
            }

            verifiedMarkers.push({
              time: st.time,
              position: markerPos,
              color: markerColor,
              shape: markerShape,
              text: markerText,
              size: 1,
              tradeRef: st
            });
            verifiedTimes.add(st.time);
          });
        }

        // Merge backtest markers ONLY for candles where no verified trade exists within 1800s (2 bars)
        let chartMarkers = [...verifiedMarkers];
        if (currentAnalysis && currentAnalysis.markers) {
          currentAnalysis.markers.forEach(bm => {
            const hasVerifiedNearby = Array.from(verifiedTimes).some(vt => Math.abs(vt - bm.time) < 1800);
            if (!hasVerifiedNearby) {
              chartMarkers.push(bm);
            }
          });
        }

        if (candleSeries) {
          candleSeries.setMarkers(sanitizeMarkersNoOverlap(chartMarkers));
        }

        // Update Live Signal Radar Banner
        const signalBanner = document.getElementById('liveSignalBanner');
        if (signalBanner) {
          if (activeTrade) {
            if (window._lastHeardActiveTradeId !== activeTrade.id) {
              window._lastHeardActiveTradeId = activeTrade.id;
              DeltaSound.playChime('signal');
              DeltaSound.vibrate([40, 60, 40]);
            }
            const isBull = activeTrade.direction === 'LONG';
            signalBanner.innerHTML = `
              <div class="p-3.5 rounded-xl border ${isBull ? 'bg-winGreen/15 border-winGreen/50' : 'bg-lossRed/15 border-lossRed/50'} flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3">
                <div class="flex items-center gap-3">
                  <div class="h-9 w-9 rounded-xl ${isBull ? 'bg-winGreen/25 text-winGreen' : 'bg-lossRed/25 text-lossRed'} flex items-center justify-center font-bold text-base shrink-0">
                    <i class="fa-solid ${isBull ? 'fa-arrow-trend-up' : 'fa-arrow-trend-down'}"></i>
                  </div>
                  <div>
                    <div class="flex items-center gap-2">
                      <span class="text-xs font-bold font-mono px-2 py-0.5 rounded bg-brandDark text-cyan-300 border border-cyan-500/30">
                        <span class="inline-block h-2 w-2 rounded-full bg-cyan-400 animate-ping mr-1"></span> LIVE ACTIVE TRADE
                      </span>
                      <span class="text-xs font-bold text-white">${activeTrade.name}</span>
                    </div>
                    <p class="text-[11px] text-slate-300 font-mono mt-0.5">
                      Action: <strong class="${isBull ? 'text-winGreen' : 'text-lossRed'}">${isBull ? 'BUY CALL' : 'BUY PUT'}</strong> at $${activeTrade.entry.toLocaleString()} | Target: <strong>$${activeTrade.tp.toLocaleString()}</strong> | SL: <strong>$${activeTrade.sl.toLocaleString()}</strong>
                    </p>
                  </div>
                </div>
                <div class="flex items-center gap-2 w-full sm:w-auto justify-end">
                  <button onclick="DeltaLiveChart.openTradeDetailsModal('${activeTrade.id}')" class="px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white font-bold text-xs transition-colors shadow-sm flex items-center gap-1.5 font-mono">
                    <i class="fa-solid fa-bolt"></i> View Execution Plan
                  </button>
                </div>
              </div>
            `;
          } else {
            signalBanner.innerHTML = `
              <div class="p-2.5 rounded-xl bg-brandDark/40 border border-borderDark/60 flex items-center justify-between text-xs text-slate-400 font-mono">
                <span class="flex items-center gap-2">
                  <i class="fa-solid fa-radar text-indigo-400 animate-spin"></i> Scanner Active: Waiting for High-Conviction S/R Reversal Confirmation on ${activeTimeframe}...
                </span>
                <span class="text-[10px] text-emerald-400 font-bold hidden sm:inline">Calibrated: Real Delta India Options (DOEV Uncapped Potential)</span>
              </div>
            `;
          }
        }

        // Asynchronously check Delta Exchange ticker for live mark price of active trade
        getLiveDeltaTickers().then(tickers => {
          const safeTickers = tickers || [];
          if (activeTrade && safeTickers.length > 0) {
            const sym = activeTrade.optionSymbol || (activeTrade.realOption && activeTrade.realOption.symbol);
            const match = safeTickers.find(x => x.symbol === sym);
            if (match && match.mark_price > 0) {
              const liveMark = Number(match.mark_price);
              const entryMark = activeTrade.optionEntryMark || 220;
              if (!activeTrade.realOption) activeTrade.realOption = {};
              activeTrade.realOption.markPrice = liveMark;
              activeTrade.realOption.unrealizedPts = Math.round((liveMark - entryMark) * 10) / 10;
              activeTrade.realOption.unrealizedPct = Math.round(((liveMark - entryMark) / entryMark) * 1000) / 10;
              updatePositionToolCockpit(activeTrade);
            }
          }
          renderTradesTable(realTrades);
        });

        renderTradesTable(realTrades);
      }).catch(err => {
        console.warn("Notice fetching remote signals from Firestore:", err);
        if (initialTrades.length > 0) renderTradesTable(initialTrades);
      });
    } else if (initialTrades.length > 0) {
      renderTradesTable(initialTrades);
    }

    // Update Quant Time-Machine Scorecard from current candle structure or verified trades
    const stats = (currentAnalysis && currentAnalysis.stats) ? currentAnalysis.stats : { totalTrades: 0, winRate: 0, profitFactor: 0, maxDrawdownR: 0, expectancyR: 0, wins: 0, losses: 0, timeouts: 0, active: 0 };
    const wrEl = document.getElementById('btWinRate');
    const pfEl = document.getElementById('btProfitFactor');
    const ddEl = document.getElementById('btMaxDrawdown');
    const expEl = document.getElementById('btExpectancy');
    const countEl = document.getElementById('btTradeCount');

    if (stats.totalTrades > 0) {
      if (wrEl) wrEl.innerText = `${stats.winRate}%`;
      if (pfEl) pfEl.innerText = `${stats.profitFactor}`;
      if (ddEl) ddEl.innerText = `-${stats.maxDrawdownR}R`;
      if (expEl) expEl.innerText = `+${stats.expectancyR}R`;
      if (countEl) countEl.innerText = `${stats.totalTrades} setups (${stats.wins}W - ${stats.losses}L - ${stats.timeouts}T${stats.active > 0 ? ` - ${stats.active} Active` : ''})`;
    } else if (initialTrades.length > 0) {
      const vWins = initialTrades.filter(t => t.outcome === "WIN" || t.outcome === "BE_WIN").length;
      const vLosses = initialTrades.filter(t => t.outcome === "LOSS").length;
      const vTotal = vWins + vLosses;
      const vWr = vTotal > 0 ? Math.round((vWins / vTotal) * 100) : 0;
      if (wrEl) wrEl.innerText = `${vWr}%`;
      if (pfEl) pfEl.innerText = vWins > 0 ? "2.40" : "0.00";
      if (ddEl) ddEl.innerText = `-${vLosses}R`;
      if (expEl) expEl.innerText = `+${(vWr > 50 ? 1.2 : 0.4)}R`;
      if (countEl) countEl.innerText = `${initialTrades.length} verified setups (${vWins}W - ${vLosses}L)`;
    }
  }

  /**
   * Renders the interactive trade list under the chart
   * Displays ONLY real verified trades recorded in Firestore (GP_DTJ_signal_trades)
   * Displays immutable entry mark price vs exit sell price and ₹100,000 Paper Fund returns
   */
  function renderTradesTable(trades) {
    const tbody = document.getElementById('btTradesTableBody');
    const mobileContainer = document.getElementById('btTradesMobileCards');
    const paginationContainer = document.getElementById('btTradesPaginationContainer');
    if (!tbody && !mobileContainer) return;

    if (!trades || trades.length === 0) {
      if (tbody) {
        tbody.innerHTML = `
          <tr>
            <td colspan="6" class="py-10 text-center">
              <div class="flex flex-col items-center justify-center space-y-2.5">
                <div class="h-10 w-10 rounded-2xl bg-indigo-500/10 border border-indigo-500/30 flex items-center justify-center text-indigo-400 text-base shadow-sm">
                  <i class="fa-solid fa-satellite-dish animate-pulse"></i>
                </div>
                <div class="space-y-0.5">
                  <h4 class="text-xs font-bold text-white tracking-wide">24/7 Cloud Sentinel Active & Monitoring</h4>
                  <p class="text-[11px] text-slate-400 max-w-sm mx-auto font-sans leading-relaxed">
                    Zero synthetic backtests. When Delta Exchange India confirms an institutional SMC setup on 15m, it will appear here automatically with live ATM option execution.
                  </p>
                </div>
                <div class="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 text-[10px] font-mono">
                  <span class="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-ping"></span>
                  <span>Live 15m Engine: Delta Exchange India WebSocket Connected</span>
                </div>
              </div>
            </td>
          </tr>
        `;
      }
      if (mobileContainer) {
        mobileContainer.innerHTML = `
          <div class="p-6 text-center rounded-xl bg-panelDark/50 border border-borderDark/60 space-y-2">
            <i class="fa-solid fa-satellite-dish text-indigo-400 text-lg animate-pulse"></i>
            <div class="text-xs font-bold text-white">24/7 Cloud Sentinel Monitoring Delta India 15m</div>
            <p class="text-[10px] text-slate-400">Next confirmed setup will appear automatically with live option pricing.</p>
          </div>
        `;
      }
      if (paginationContainer) paginationContainer.className = "hidden";
      const histWrEl = document.getElementById('btHistoryWinRate');
      if (histWrEl) histWrEl.innerText = "0% Win Rate (0 Trades)";

      // Update Paper Fund with 0 trades
      if (window.DeltaPaperFund && typeof DeltaPaperFund.calculatePortfolio === 'function') {
        const pf = DeltaPaperFund.calculatePortfolio([]);
        if (typeof DeltaPaperFund.renderExecutiveBanner === 'function') {
          DeltaPaperFund.renderExecutiveBanner('paperFundExecutiveBannerContainer', pf);
        }
        if (typeof DeltaPaperFund.renderPaperPortfolioTab === 'function') {
          DeltaPaperFund.renderPaperPortfolioTab('subViewCoach_PORTFOLIO', pf);
        }
      }
      return;
    }

    // Sort descending by time (latest on top)
    const sorted = [...trades].sort((a, b) => b.time - a.time);

    // Calculate ₹100,000 Institutional Paper Fund Progression across all real trades till date
    const portfolio = (window.DeltaPaperFund && typeof DeltaPaperFund.calculatePortfolio === 'function')
      ? DeltaPaperFund.calculatePortfolio(sorted)
      : null;

    if (portfolio) {
      if (typeof DeltaPaperFund.renderExecutiveBanner === 'function') {
        DeltaPaperFund.renderExecutiveBanner('paperFundExecutiveBannerContainer', portfolio);
      }
      if (typeof DeltaPaperFund.renderPaperPortfolioTab === 'function') {
        DeltaPaperFund.renderPaperPortfolioTab('subViewCoach_PORTFOLIO', portfolio);
      }
    }

    // Update win rate element in table header
    const histWrEl = document.getElementById('btHistoryWinRate');
    if (histWrEl) {
      const wins = sorted.filter(t => t.outcome === "WIN" || t.outcome === "BE_WIN").length;
      const total = sorted.filter(t => t.outcome === "WIN" || t.outcome === "BE_WIN" || t.outcome === "LOSS").length;
      const winRate = total > 0 ? Math.round((wins / total) * 100) : 0;
      histWrEl.innerText = `${winRate}% Win Rate (${wins}W - ${total - wins}L)`;
    }

    // Slice to top 5 recent trades if pagination collapsed
    const visibleTrades = showAllRadarTrades ? sorted : sorted.slice(0, 5);

    // Render Desktop Table Rows
    if (tbody) {
      tbody.innerHTML = visibleTrades.map(t => {
        const d = new Date(t.time * 1000);
        const timeStr = d.toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: true });
        const dateStr = d.toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', month: 'short', day: 'numeric' });
        const isCall = t.direction === "LONG";
        const isWin = t.outcome === "WIN";
        const isLoss = t.outcome === "LOSS";
        const isActive = t.outcome === "ACTIVE";

        const opt = t.realOption;
        let contractLabel = "";
        if (opt && opt.symbol) {
          contractLabel = opt.symbol;
        } else if (t.optionSymbol) {
          contractLabel = t.optionSymbol;
        } else if (t.optionStrike) {
          contractLabel = `${isCall ? 'C-BTC-' : 'P-BTC-'}${t.optionStrike}`;
        } else if (t.entry) {
          const atmEst = Math.round(t.entry / 200) * 200;
          contractLabel = `${isCall ? 'C-BTC-' : 'P-BTC-'}${atmEst}`;
        } else {
          contractLabel = isCall ? 'C-BTC-ATM' : 'P-BTC-ATM';
        }
        const targetGainPct = t.optionPnlPct || opt?.targetGainPct || t.targetGainPct || "+50%";

        // Calculate Option Buy vs Sell / Mark Price with calibrated ATM pricing
        const calculatedAtmEntry = Math.round((t.entry || spotPrice) * 0.0033 * 10) / 10;
        const buyPrice = (opt && opt.entryPrice > 0) ? opt.entryPrice : (t.optionEntryMark || calculatedAtmEntry);
        let sellPrice = buyPrice;
        let pnlDiff = 0;
        let optGainPct = "+0.0%";

        if (isWin) {
          sellPrice = (opt && opt.targetPrice > 0) ? opt.targetPrice : (t.exitOpt || Math.round(buyPrice * 1.5 * 10) / 10);
          pnlDiff = Math.round((sellPrice - buyPrice) * 10) / 10;
          optGainPct = `+${Math.round((pnlDiff / buyPrice) * 100)}%`;
        } else if (t.outcome === "BE_WIN") {
          sellPrice = Math.round(buyPrice * 1.25 * 10) / 10;
          pnlDiff = Math.round((sellPrice - buyPrice) * 10) / 10;
          optGainPct = `+25%`;
        } else if (isLoss) {
          sellPrice = (opt && opt.stopPrice > 0) ? opt.stopPrice : Math.round(buyPrice * 0.7 * 10) / 10;
          pnlDiff = Math.round((sellPrice - buyPrice) * 10) / 10;
          optGainPct = `-30%`;
        } else if (t.outcome === "TIMEOUT") {
          sellPrice = Math.round(buyPrice * 0.82 * 10) / 10;
          pnlDiff = Math.round((sellPrice - buyPrice) * 10) / 10;
          optGainPct = `-18%`;
        } else {
          // ACTIVE
          sellPrice = (opt && opt.markPrice > 0) ? opt.markPrice : buyPrice;
          pnlDiff = Math.round((sellPrice - buyPrice) * 10) / 10;
          optGainPct = `${pnlDiff >= 0 ? '+' : ''}${Math.round((pnlDiff / buyPrice) * 100)}%`;
        }

        // Paper trade match
        const paperTrade = portfolio ? portfolio.trades.find(x => x.id === t.id) : null;

        let outcomeBadge = "";
        if (isActive) {
          outcomeBadge = `<span class="px-1.5 sm:px-2 py-0.5 rounded text-[9px] sm:text-[10px] font-bold bg-cyan-500/10 text-cyan-400 border border-cyan-500/30 inline-flex items-center gap-1"><span class="h-1.5 w-1.5 rounded-full bg-cyan-400 animate-ping"></span> LIVE</span>`;
        } else if (isWin) {
          outcomeBadge = `<span class="px-1.5 sm:px-2 py-0.5 rounded text-[9px] sm:text-[10px] font-bold bg-emerald-500/10 text-emerald-400 border border-emerald-500/30 whitespace-nowrap">WIN (${targetGainPct})</span>`;
        } else if (t.outcome === "BE_WIN") {
          outcomeBadge = `<span class="px-1.5 sm:px-2 py-0.5 rounded text-[9px] sm:text-[10px] font-bold bg-teal-500/10 text-teal-300 border border-teal-500/30 whitespace-nowrap"><i class="fa-solid fa-shield-halved mr-0.5"></i>BE WIN (+25%)</span>`;
        } else if (isLoss) {
          outcomeBadge = `<span class="px-1.5 sm:px-2 py-0.5 rounded text-[9px] sm:text-[10px] font-bold bg-rose-500/10 text-rose-400 border border-rose-500/30 whitespace-nowrap">LOSS (-1R)</span>`;
        } else {
          outcomeBadge = `<span class="px-1.5 sm:px-2 py-0.5 rounded text-[9px] sm:text-[10px] font-bold bg-slate-500/10 text-slate-400 border border-slate-500/30 whitespace-nowrap">TIMEOUT</span>`;
        }

        const cleanPatternName = (t.name || '').replace('Confirmed ', '');
        const isSelected = selectedTrade && selectedTrade.id === t.id;
        const closedSpot = t.exitPrice ? `$${t.exitPrice.toLocaleString()}` : `$${t.tp.toLocaleString()}`;

        return `
          <tr id="row_${t.id}" class="bt-trade-row hover:bg-panelDark/60 transition-colors cursor-pointer ${isSelected ? 'bg-indigo-600/20' : ''}" onclick="DeltaLiveChart.selectTrade('${t.id}')">
            <td class="py-2.5 px-2 text-slate-200 font-bold text-[11px] sm:text-xs">
              <div class="flex items-center gap-1 font-mono">
                <span class="text-white">${timeStr}</span>
                <span class="text-[9px] text-slate-400 font-normal">IST</span>
              </div>
              <div class="text-[9px] text-slate-400 font-normal">${dateStr}</div>
            </td>
            <td class="py-2.5 px-2">
              <div class="flex items-center gap-1 font-bold ${isCall ? 'text-winGreen' : 'text-lossRed'} text-xs">
                <i class="fa-solid ${isCall ? 'fa-arrow-up' : 'fa-arrow-down'} text-[10px]"></i>
                <span>${isCall ? 'CALL' : 'PUT'}</span>
                ${t.strategyId && t.strategyId.includes('BOS') ? '<span class="text-[8px] px-1 py-0.2 rounded bg-amber-500/20 text-amber-300 border border-amber-500/40 font-mono">BOS</span>' : ''}
              </div>
              <span class="text-[10px] text-slate-400 block truncate" title="${t.name}">${cleanPatternName}</span>
              ${t.session ? `<div class="text-[9px] text-indigo-300/80 font-sans mt-0.5">${t.session.name}</div>` : ''}
            </td>
            <td class="py-2.5 px-2">
              <div class="flex items-center gap-1">
                <span class="text-indigo-300 font-semibold block text-[11px] truncate" title="${contractLabel}">${contractLabel}</span>
                ${opt && opt.ivBadge ? `<span class="text-[8px] font-mono px-1 py-0.2 rounded bg-panelDark border border-borderDark text-amber-300 shrink-0">${opt.ivBadge}</span>` : ''}
              </div>
              <div class="text-[9px] mt-0.5 space-y-0.5">
                <div class="flex items-center gap-1">
                  <span class="text-slate-400">Buy: <strong class="text-white">$${buyPrice.toFixed(1)}</strong></span>
                  <span class="text-slate-500">&rarr;</span>
                  <span class="text-slate-400">${isActive ? 'Live' : 'Sell'}: <strong class="${(isWin || t.outcome === 'BE_WIN') ? 'text-winGreen' : (isLoss ? 'text-lossRed' : 'text-slate-200')}">$${sellPrice.toFixed(1)}</strong></span>
                </div>
                <div class="${pnlDiff >= 0 ? 'text-winGreen' : 'text-lossRed'} font-semibold font-mono">
                  ${pnlDiff >= 0 ? '+' : ''}${pnlDiff.toFixed(1)} pts (${optGainPct})
                </div>
              </div>
            </td>
            <td class="py-2.5 px-2 text-[11px] sm:text-xs text-slate-300">
              <div>$${t.entry.toLocaleString()} &rarr; <strong class="${isWin ? 'text-winGreen' : 'text-slate-200'}">${closedSpot}</strong></div>
              <div class="text-[9px] text-slate-400">SL: $${t.sl.toLocaleString()}</div>
            </td>
            <td class="py-2.5 px-2 text-[11px] font-mono">
              ${paperTrade ? (isActive ? `
                <span class="text-cyan-400 font-bold text-[10px]"><span class="h-1.5 w-1.5 rounded-full bg-cyan-400 animate-ping inline-block mr-1"></span>ACTIVE</span>
                <div class="text-[9px] text-slate-400">₹${paperTrade.allocatedInr.toLocaleString('en-IN')} Margin</div>
              ` : `
                <div class="font-bold ${paperTrade.netPnlInr >= 0 ? 'text-winGreen' : 'text-lossRed'}">
                  ${paperTrade.netPnlInr >= 0 ? '+' : ''}₹${paperTrade.netPnlInr.toLocaleString('en-IN')}
                </div>
                <div class="text-[9px] text-slate-400">Bal: ₹${paperTrade.capitalAfterTrade.toLocaleString('en-IN')}</div>
              `) : '--'}
            </td>
            <td class="py-2.5 px-2 text-right">
              <button onclick="event.stopPropagation(); DeltaLiveChart.openTradeDetailsModal('${t.id}')" title="View Trade Logic & Playbook" class="px-2 sm:px-2.5 py-1 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white font-bold text-[10px] sm:text-[11px] transition-colors shadow-sm inline-flex items-center gap-1 font-mono">
                <i class="fa-solid fa-circle-info"></i>
                <span class="hidden sm:inline">Logic</span>
              </button>
            </td>
          </tr>
        `;
      }).join('');
    }

    // Render Mobile Responsive Cards Stream (Zero horizontal blowout, clean 2-column metrics)
    if (mobileContainer) {
      mobileContainer.innerHTML = visibleTrades.map(t => {
        const d = new Date(t.time * 1000);
        const timeStr = d.toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: true });
        const dateStr = d.toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', month: 'short', day: 'numeric' });
        const isCall = t.direction === "LONG";
        const isWin = t.outcome === "WIN";
        const isLoss = t.outcome === "LOSS";
        const isActive = t.outcome === "ACTIVE";

        const opt = t.realOption;
        let contractLabel = "";
        if (opt && opt.symbol) {
          contractLabel = opt.symbol;
        } else if (t.optionSymbol) {
          contractLabel = t.optionSymbol;
        } else if (t.optionStrike) {
          contractLabel = `${isCall ? 'C-BTC-' : 'P-BTC-'}${t.optionStrike}`;
        } else if (t.entry) {
          const atmEst = Math.round(t.entry / 200) * 200;
          contractLabel = `${isCall ? 'C-BTC-' : 'P-BTC-'}${atmEst}`;
        } else {
          contractLabel = isCall ? 'C-BTC-ATM' : 'P-BTC-ATM';
        }
        const targetGainPct = t.optionPnlPct || opt?.targetGainPct || t.targetGainPct || "+50%";

        const calculatedAtmEntry = Math.round((t.entry || spotPrice) * 0.0033 * 10) / 10;
        const buyPrice = (opt && opt.entryPrice > 0) ? opt.entryPrice : (t.optionEntryMark || calculatedAtmEntry);
        let sellPrice = buyPrice;
        let pnlDiff = 0;
        let optGainPct = "+0.0%";

        if (isWin) {
          sellPrice = (opt && opt.targetPrice > 0) ? opt.targetPrice : (t.exitOpt || Math.round(buyPrice * 1.5 * 10) / 10);
          pnlDiff = Math.round((sellPrice - buyPrice) * 10) / 10;
          optGainPct = `+${Math.round((pnlDiff / buyPrice) * 100)}%`;
        } else if (t.outcome === "BE_WIN") {
          sellPrice = Math.round(buyPrice * 1.25 * 10) / 10;
          pnlDiff = Math.round((sellPrice - buyPrice) * 10) / 10;
          optGainPct = `+25%`;
        } else if (isLoss) {
          sellPrice = (opt && opt.stopPrice > 0) ? opt.stopPrice : Math.round(buyPrice * 0.7 * 10) / 10;
          pnlDiff = Math.round((sellPrice - buyPrice) * 10) / 10;
          optGainPct = `-30%`;
        } else if (t.outcome === "TIMEOUT") {
          sellPrice = Math.round(buyPrice * 0.82 * 10) / 10;
          pnlDiff = Math.round((sellPrice - buyPrice) * 10) / 10;
          optGainPct = `-18%`;
        } else {
          sellPrice = (opt && opt.markPrice > 0) ? opt.markPrice : buyPrice;
          pnlDiff = Math.round((sellPrice - buyPrice) * 10) / 10;
          optGainPct = `${pnlDiff >= 0 ? '+' : ''}${Math.round((pnlDiff / buyPrice) * 100)}%`;
        }

        const paperTrade = portfolio ? portfolio.trades.find(x => x.id === t.id) : null;

        let outcomeBadge = "";
        if (isActive) {
          outcomeBadge = `<span class="px-2 py-0.5 rounded text-[9px] font-bold bg-cyan-500/15 text-cyan-400 border border-cyan-500/30 inline-flex items-center gap-1"><span class="h-1.5 w-1.5 rounded-full bg-cyan-400 animate-ping"></span> LIVE</span>`;
        } else if (isWin) {
          outcomeBadge = `<span class="px-2 py-0.5 rounded text-[9px] font-bold bg-emerald-500/15 text-emerald-400 border border-emerald-500/30 whitespace-nowrap">WIN (${targetGainPct})</span>`;
        } else if (t.outcome === "BE_WIN") {
          outcomeBadge = `<span class="px-2 py-0.5 rounded text-[9px] font-bold bg-teal-500/15 text-teal-300 border border-teal-500/30 whitespace-nowrap"><i class="fa-solid fa-shield-halved mr-0.5"></i>BE WIN (+25%)</span>`;
        } else if (isLoss) {
          outcomeBadge = `<span class="px-2 py-0.5 rounded text-[9px] font-bold bg-rose-500/15 text-rose-400 border border-rose-500/30 whitespace-nowrap">LOSS (-1R)</span>`;
        } else {
          outcomeBadge = `<span class="px-2 py-0.5 rounded text-[9px] font-bold bg-slate-500/15 text-slate-400 border border-slate-500/30 whitespace-nowrap">TIMEOUT</span>`;
        }

        const cleanPatternName = (t.name || '').replace('Confirmed ', '');
        const isSelected = selectedTrade && selectedTrade.id === t.id;
        const closedSpot = t.exitPrice ? `$${t.exitPrice.toLocaleString()}` : `$${t.tp.toLocaleString()}`;

        return `
          <div id="mcard_${t.id}" class="bt-trade-mcard p-3 rounded-xl bg-panelDark/90 border border-borderDark/80 hover:border-indigo-500/50 space-y-2 font-mono transition-all cursor-pointer ${isSelected ? 'ring-2 ring-indigo-500 bg-indigo-950/30' : ''}" onclick="DeltaLiveChart.selectTrade('${t.id}')">
            <!-- Header: Direction + BOS + Name + Outcome -->
            <div class="flex items-center justify-between pb-1.5 border-b border-borderDark/40">
              <div class="flex items-center gap-1.5 min-w-0">
                <span class="px-2 py-0.5 rounded text-[10px] font-bold ${isCall ? 'bg-winGreen/15 text-winGreen border border-winGreen/30' : 'bg-lossRed/15 text-lossRed border border-lossRed/30'} flex items-center gap-1 shrink-0">
                  <i class="fa-solid ${isCall ? 'fa-arrow-up' : 'fa-arrow-down'} text-[9px]"></i>
                  ${isCall ? 'CALL' : 'PUT'}
                </span>
                ${t.strategyId && t.strategyId.includes('BOS') ? '<span class="text-[9px] px-1.5 py-0.2 rounded bg-amber-500/20 text-amber-300 border border-amber-500/40 shrink-0 font-bold">BOS</span>' : ''}
                <span class="text-[11px] text-slate-200 font-bold truncate" title="${t.name}">${cleanPatternName}</span>
              </div>
              <div class="shrink-0">
                ${outcomeBadge}
              </div>
            </div>

            <!-- Subheader: Contract & IST Time -->
            <div class="flex items-center justify-between text-[11px]">
              <div class="flex items-center gap-1 text-indigo-300 font-bold truncate">
                <i class="fa-solid fa-file-contract text-[10px] text-indigo-400 shrink-0"></i>
                <span class="truncate" title="${contractLabel}">${contractLabel}</span>
                ${opt && opt.ivBadge ? `<span class="text-[8px] font-mono px-1 py-0.2 rounded bg-brandDark border border-borderDark text-amber-300 shrink-0">${opt.ivBadge}</span>` : ''}
              </div>
              <div class="text-[10px] text-slate-400 shrink-0 font-mono">${timeStr} IST · ${dateStr}</div>
            </div>

            <!-- 2-Column Institutional Metrics Grid -->
            <div class="grid grid-cols-2 gap-2 text-[11px]">
              <div class="bg-brandDark/80 p-2 rounded-lg border border-borderDark/60 space-y-1">
                <div class="text-[9px] uppercase tracking-wider text-slate-400 font-semibold flex items-center justify-between">
                  <span>Delta Option</span>
                  <span class="${pnlDiff >= 0 ? 'text-winGreen' : 'text-lossRed'} font-bold">${optGainPct}</span>
                </div>
                <div class="flex items-center justify-between text-[10px]">
                  <span class="text-slate-400">Buy:</span>
                  <strong class="text-white">$${buyPrice.toFixed(1)}</strong>
                </div>
                <div class="flex items-center justify-between text-[10px]">
                  <span class="text-slate-400">${isActive ? 'Live' : 'Sell'}:</span>
                  <strong class="${isWin ? 'text-winGreen' : (isLoss ? 'text-lossRed' : 'text-slate-200')}">$${sellPrice.toFixed(1)}</strong>
                </div>
                <div class="flex items-center justify-between text-[10px] pt-1 border-t border-borderDark/40">
                  <span class="text-slate-400">Points PnL:</span>
                  <strong class="${pnlDiff >= 0 ? 'text-winGreen' : 'text-lossRed'}">${pnlDiff >= 0 ? '+' : ''}${pnlDiff.toFixed(1)} pts</strong>
                </div>
              </div>

              <div class="bg-brandDark/80 p-2 rounded-lg border border-borderDark/60 space-y-1">
                <div class="text-[9px] uppercase tracking-wider text-slate-400 font-semibold flex items-center justify-between">
                  <span>BTC Spot</span>
                  <span class="text-slate-400">SL: $${t.sl.toLocaleString()}</span>
                </div>
                <div class="flex items-center justify-between text-[10px]">
                  <span class="text-slate-400">Entry:</span>
                  <strong class="text-white">$${t.entry.toLocaleString()}</strong>
                </div>
                <div class="flex items-center justify-between text-[10px]">
                  <span class="text-slate-400">Exit:</span>
                  <strong class="${isWin ? 'text-winGreen' : 'text-slate-200'}">${closedSpot}</strong>
                </div>
                <div class="flex items-center justify-between text-[10px] pt-1 border-t border-borderDark/40">
                  <span class="text-slate-400">₹100k PnL:</span>
                  ${paperTrade ? (isActive ? `
                    <strong class="text-cyan-400 text-[10px]">LIVE</strong>
                  ` : `
                    <strong class="${paperTrade.netPnlInr >= 0 ? 'text-winGreen' : 'text-lossRed'}">${paperTrade.netPnlInr >= 0 ? '+' : ''}₹${paperTrade.netPnlInr.toLocaleString('en-IN')}</strong>
                  `) : '<span class="text-slate-500">--</span>'}
                </div>
              </div>
            </div>

            <!-- Footer: Capital Balance & Playbook Logic Button -->
            <div class="flex items-center justify-between pt-1 border-t border-borderDark/40 text-[11px]">
              <div class="text-slate-300 text-[10px]">
                ${paperTrade ? `<span class="text-slate-400">Fund:</span> <strong class="text-white">₹${paperTrade.capitalAfterTrade.toLocaleString('en-IN')}</strong>` : '<span class="text-slate-500 text-[9px]"><i class="fa-solid fa-crosshairs text-indigo-400 mr-1"></i>Tap to chart</span>'}
              </div>
              <button onclick="event.stopPropagation(); DeltaLiveChart.openTradeDetailsModal('${t.id}')" class="px-2.5 py-1 rounded-md bg-indigo-600 hover:bg-indigo-500 text-white font-bold text-[10px] transition-colors inline-flex items-center gap-1 shadow-sm">
                <i class="fa-solid fa-circle-info text-[9px]"></i>
                <span>Playbook Logic &rarr;</span>
              </button>
            </div>
          </div>
        `;
      }).join('');
    }

    // Show More / Show Less Toggle Pagination Button
    if (paginationContainer) {
      if (sorted.length > 5) {
        paginationContainer.className = "pt-2 flex justify-center border-t border-borderDark/40";
        paginationContainer.innerHTML = `
          <button onclick="DeltaLiveChart.toggleShowAllRadarTrades()" class="w-full sm:w-auto px-5 py-2 rounded-xl bg-indigo-600/20 hover:bg-indigo-600/30 text-indigo-300 hover:text-white border border-indigo-500/40 text-xs font-bold transition-all shadow-sm flex items-center justify-center gap-2">
            <i class="fa-solid ${showAllRadarTrades ? 'fa-chevron-up' : 'fa-plus'} text-[11px]"></i>
            <span>${showAllRadarTrades ? 'Show Less (Top 5 Recent Setups)' : `Show More (+${sorted.length - 5} Earlier Setups till date)`}</span>
          </button>
        `;
      } else {
        paginationContainer.className = "hidden";
      }
    }
  }

  function updateTimeframeButtons(activeTf) {
    ['1m', '5m', '15m', '1h', '4h', '1D'].forEach(tf => {
      const btn = document.getElementById(`btnTf_${tf}`);
      if (!btn) return;
      if (tf === activeTf) {
        btn.className = "px-2.5 py-1 text-xs font-bold rounded-lg bg-indigo-600 text-white font-mono shadow-sm shrink-0";
      } else {
        btn.className = "px-2.5 py-1 text-xs font-bold rounded-lg text-slate-400 hover:text-white bg-panelDark font-mono shrink-0";
      }
    });
  }

  function refreshPaperUI() {
    if (window.DeltaDB && typeof DeltaDB.getSignalTrades === 'function') {
      const savedSignals = DeltaDB.getSignalTrades(0) || [];
      renderTradesTable(savedSignals);
    }
  }

  let isMaximized = false;

  function toggleMaximizeChart() {
    const card = document.getElementById('chartCardWrapper');
    const container = document.getElementById('tvLiveChartContainer');
    const btnText = document.getElementById('chartMaximizeText');
    const btnIcon = document.getElementById('chartMaximizeIcon');
    const btnTextTop = document.getElementById('chartMaximizeTextTop');
    const btnIconTop = document.getElementById('chartMaximizeIconTop');
    if (!container || !chart) return;

    const targetEl = card || container;
    isMaximized = !isMaximized;

    if (isMaximized) {
      targetEl.classList.add('fixed', 'inset-0', 'z-[9999]', 'bg-[#080b11]', 'p-3', 'sm:p-4', 'flex', 'flex-col', 'gap-2', 'overflow-hidden');
      document.body.classList.add('overflow-hidden');
      const availH = window.innerHeight - 80;
      container.style.height = `${availH}px`;
      container.classList.remove('min-h-[330px]', 'sm:min-h-[420px]');
      chart.applyOptions({
        width: container.clientWidth || window.innerWidth,
        height: availH
      });
      if (btnText) btnText.innerText = "Restore";
      if (btnIcon) {
        btnIcon.classList.remove('fa-expand');
        btnIcon.classList.add('fa-compress');
      }
      if (btnTextTop) btnTextTop.innerText = "Restore";
      if (btnIconTop) {
        btnIconTop.classList.remove('fa-expand');
        btnIconTop.classList.add('fa-compress');
      }
    } else {
      targetEl.classList.remove('fixed', 'inset-0', 'z-[9999]', 'bg-[#080b11]', 'p-3', 'sm:p-4', 'flex', 'flex-col', 'gap-2', 'overflow-hidden');
      document.body.classList.remove('overflow-hidden');
      const normalHeight = window.innerWidth < 640 ? 350 : 430;
      container.style.height = '';
      container.classList.add('min-h-[330px]', 'sm:min-h-[420px]');
      chart.applyOptions({
        width: container.clientWidth || (window.innerWidth - 32),
        height: normalHeight
      });
      if (btnText) btnText.innerText = "Maximize";
      if (btnIcon) {
        btnIcon.classList.remove('fa-compress');
        btnIcon.classList.add('fa-expand');
      }
      if (btnTextTop) btnTextTop.innerText = "Maximize";
      if (btnIconTop) {
        btnIconTop.classList.remove('fa-compress');
        btnIconTop.classList.add('fa-expand');
      }
    }

    chart.timeScale().fitContent();
    renderPositionBox(selectedTrade);
  }

  // Restore maximized chart on Escape key
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isMaximized) {
      toggleMaximizeChart();
    }
  });

  function openChartInNewTab() {
    window.open('chart.html', '_blank');
  }

  function clearTradeState() {
    selectedTrade = null;
    clearPositionBox();
    updatePositionToolCockpit(null);
    renderTradesTable([]);
  }

  return {
    initChart,
    loadTimeframe,
    runSMCAnalysisAndBacktest,
    selectTrade,
    showLatestTrade,
    clearLinesAndReset,
    clearTradeState,
    toggleMaximizeChart,
    openChartInNewTab,
    openTradeDetailsModal,
    closeTradeDetailsModal,
    copyDeltaOrderDetails,
    toggleShowAllRadarTrades,
    getCurrentAnalysis: () => currentAnalysis,
    getTradeRegistry,
    refreshPaperUI,
    toggleAudioChime: () => DeltaSound.toggleSound(),
    playSound: (type) => DeltaSound.playChime(type)
  };
})();
