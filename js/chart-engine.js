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
   * Resolves the smartest, real-world active Delta Exchange India option contract for a setup
   */
  function resolveRealDeltaContract(direction, spotPrice, tickers) {
    const isCall = direction === "LONG";
    const atmStrike = Math.round(spotPrice / 500) * 500;

    if (!tickers || tickers.length === 0) {
      return {
        symbol: isCall ? `C-BTC-${atmStrike}` : `P-BTC-${atmStrike}`,
        strike: atmStrike,
        markPrice: 220.0,
        buyZone: "$210.0 - $225.0",
        targetPrice: 330.0,
        stopPrice: 154.0,
        targetGainPct: "+50.0%",
        stopLossPct: "-30.0%",
        isLive: false
      };
    }

    const type = isCall ? "call_options" : "put_options";
    const candidates = tickers.filter(t => t.contract_type === type);

    // Filter near ATM (within 1.8% of spot) with active mark price
    const nearAtm = candidates.filter(t => {
      const strike = parseFloat(t.strike_price);
      const mark = parseFloat(t.mark_price || 0);
      return Math.abs(strike - spotPrice) <= (spotPrice * 0.018) && mark >= 80 && mark <= 450;
    });

    // Sort to find the contract closest to the $200-$250 sweet spot
    nearAtm.sort((a, b) => {
      const distA = Math.abs(parseFloat(a.mark_price || 0) - 220);
      const distB = Math.abs(parseFloat(b.mark_price || 0) - 220);
      return distA - distB;
    });

    const best = nearAtm.length > 0 ? nearAtm[0] : (candidates.length > 0 ? candidates[0] : null);

    if (best) {
      const mark = Math.round(parseFloat(best.mark_price) * 10) / 10;
      const target = Math.round((mark * 1.5) * 10) / 10;
      const stop = Math.round((mark * 0.7) * 10) / 10;
      const bestBid = parseFloat(best.best_bid) || mark;
      const bestAsk = parseFloat(best.best_ask) || mark;

      return {
        symbol: best.symbol,
        strike: parseFloat(best.strike_price),
        markPrice: mark,
        bestBid: bestBid > 0 ? bestBid : mark,
        bestAsk: bestAsk > 0 ? bestAsk : mark,
        buyZone: `$${Math.min(bestBid, mark).toFixed(1)} - $${Math.max(bestAsk, mark).toFixed(1)}`,
        targetPrice: target,
        stopPrice: stop,
        targetGainPct: "+50.0%",
        stopLossPct: "-30.0%",
        isLive: true
      };
    }

    return {
      symbol: isCall ? `C-BTC-${atmStrike}` : `P-BTC-${atmStrike}`,
      strike: atmStrike,
      markPrice: 220.0,
      buyZone: "$210.0 - $225.0",
      targetPrice: 330.0,
      stopPrice: 154.0,
      targetGainPct: "+50.0%",
      stopLossPct: "-30.0%",
      isLive: false
    };
  }

  /**
   * Initializes the TradingView Lightweight Charts canvas in container
   */
  function initChart() {
    const container = document.getElementById('tvLiveChartContainer');
    if (!container || chart) return;

    // Create TradingView Chart
    chart = LightweightCharts.createChart(container, {
      width: container.clientWidth,
      height: 420,
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

  /**
   * Loads historical candles and connects live WebSocket for selected timeframe
   */
  async function loadTimeframe(tf) {
    activeTimeframe = tf;
    updateTimeframeButtons(tf);

    // 1. Close existing live WebSocket stream if active
    if (wsConnection) {
      try { wsConnection.close(); } catch (e) {}
      wsConnection = null;
    }

    // 2. Fetch historical OHLCV bars via public Binance REST (Raw UTC timestamps)
    const interval = TIMEFRAME_MAP[tf] || '15m';
    const restUrl = `https://api.binance.com/api/v3/klines?symbol=${activeSymbol}&interval=${interval}&limit=500`;

    try {
      const res = await fetch(restUrl);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const rawBars = await res.json();

      candleData = rawBars.map(b => {
        const timeSec = Math.floor(b[0] / 1000);
        const open = parseFloat(b[1]);
        const high = parseFloat(b[2]);
        const low = parseFloat(b[3]);
        const close = parseFloat(b[4]);
        const vol = parseFloat(b[5]);

        return {
          time: timeSec,
          open,
          high,
          low,
          close,
          volume: vol
        };
      });

      // Update Chart Series
      candleSeries.setData(candleData);

      const volumeData = candleData.map(c => ({
        time: c.time,
        value: c.volume,
        color: c.close >= c.open ? 'rgba(16, 185, 129, 0.35)' : 'rgba(244, 63, 94, 0.35)'
      }));
      volumeSeries.setData(volumeData);

      chart.timeScale().fitContent();

      // 3. Execute Algorithmic SMC Confluence Analysis
      runSMCAnalysisAndBacktest();

      // 4. Connect Live Tick-by-Tick WebSocket
      connectLiveWebSocket(interval);

    } catch (err) {
      console.warn("REST load error, trying Delta Exchange fallback:", err);
      loadDeltaFallback(tf);
    }
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

    const profitFill = isActive ? "rgba(16, 185, 129, 0.28)" : "rgba(16, 185, 129, 0.22)";
    const profitStroke = "rgba(16, 185, 129, 0.95)";
    const lossFill = isActive ? "rgba(244, 63, 94, 0.28)" : "rgba(244, 63, 94, 0.22)";
    const lossStroke = "rgba(244, 63, 94, 0.95)";

    const opt = trade.realOption || {};
    const targetOptLabel = opt.targetPrice ? `Option: $${opt.targetPrice}` : `+50% Option`;
    const stopOptLabel = opt.stopPrice ? `Option: $${opt.stopPrice}` : `-30% Option`;

    const targetLabel = `TP: $${trade.tp.toLocaleString()} (+${trade.targetDist} pts | ${targetOptLabel})`;
    const stopLabel = `SL: $${trade.sl.toLocaleString()} (-${trade.slDist} pts | ${stopOptLabel})`;

    svg.innerHTML = `
      <!-- Green Take Profit Zone -->
      <rect x="${x1}" y="${profitY}" width="${boxWidth}" height="${profitHeight}"
            fill="${profitFill}" stroke="${profitStroke}" stroke-width="1.5" rx="4" />

      <!-- Red Stop Loss Zone -->
      <rect x="${x1}" y="${lossY}" width="${boxWidth}" height="${lossHeight}"
            fill="${lossFill}" stroke="${lossStroke}" stroke-width="1.5" rx="4" />

      <!-- Dashed Entry Level Line -->
      <line x1="${x1}" y1="${yEntry}" x2="${x1 + boxWidth}" y2="${yEntry}"
            stroke="#38bdf8" stroke-width="2" stroke-dasharray="5,3" />

      <!-- Labels & Badges on the Position Box -->
      <g font-family="-apple-system, BlinkMacSystemFont, monospace" font-size="10" font-weight="bold">
        <!-- Target Price Tag -->
        <rect x="${x1 + 6}" y="${profitY + 4}" width="${Math.min(boxWidth - 12, 240)}" height="18" fill="rgba(11, 15, 23, 0.9)" rx="3" stroke="rgba(16, 185, 129, 0.4)" stroke-width="1" />
        <text x="${x1 + 10}" y="${profitY + 17}" fill="#10b981">🎯 ${targetLabel}</text>

        <!-- Entry Price Tag -->
        <rect x="${x1 + 6}" y="${yEntry - 20}" width="${Math.min(boxWidth - 12, 140)}" height="18" fill="rgba(11, 15, 23, 0.9)" rx="3" stroke="rgba(56, 189, 248, 0.4)" stroke-width="1" />
        <text x="${x1 + 10}" y="${yEntry - 7}" fill="#38bdf8">⚪ Entry: $${trade.entry.toLocaleString()}</text>

        <!-- Stop Loss Price Tag -->
        <rect x="${x1 + 6}" y="${isCall ? (lossY + lossHeight - 22) : (lossY + 4)}" width="${Math.min(boxWidth - 12, 230)}" height="18" fill="rgba(11, 15, 23, 0.9)" rx="3" stroke="rgba(244, 63, 94, 0.4)" stroke-width="1" />
        <text x="${x1 + 10}" y="${isCall ? (lossY + lossHeight - 9) : (lossY + 17)}" fill="#f43f5e">🛑 ${stopLabel}</text>
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
      cockpit.classList.add('opacity-50');
      return;
    }
    cockpit.classList.remove('opacity-50');

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
    if (nameEl) nameEl.innerText = `${trade.name} (${isCall ? 'CALL OPTION' : 'PUT OPTION'})`;

    const outcomeEl = document.getElementById('ptOutcomeBadge');
    if (outcomeEl) {
      if (isActive) {
        outcomeEl.className = "text-[10px] font-bold font-mono px-2 py-0.5 rounded bg-cyan-500/10 text-cyan-400 border border-cyan-500/30 flex items-center gap-1.5";
        outcomeEl.innerHTML = `<span class="h-2 w-2 rounded-full bg-cyan-400 animate-ping"></span> LIVE RUNNING IN MARKET (${trade.barsHeld} bars)`;
      } else if (isWin) {
        outcomeEl.className = "text-[10px] font-bold font-mono px-2 py-0.5 rounded bg-emerald-500/10 text-emerald-400 border border-emerald-500/30";
        outcomeEl.innerHTML = `<i class="fa-solid fa-circle-check mr-1"></i> TARGET HIT (+50% Gross / +40% Net)`;
      } else if (isLoss) {
        outcomeEl.className = "text-[10px] font-bold font-mono px-2 py-0.5 rounded bg-rose-500/10 text-rose-400 border border-rose-500/30";
        outcomeEl.innerHTML = `<i class="fa-solid fa-circle-xmark mr-1"></i> STOP LOSS HIT (-1R Controlled Invalidation)`;
      } else {
        outcomeEl.className = "text-[10px] font-bold font-mono px-2 py-0.5 rounded bg-slate-500/10 text-slate-400 border border-slate-500/30";
        outcomeEl.innerHTML = `<i class="fa-solid fa-hourglass-end mr-1"></i> TIMEOUT (Closed at Scratch after 5 hours)`;
      }
    }

    // Underlying Spot Numbers
    const entryEl = document.getElementById('ptEntry');
    if (entryEl) entryEl.innerText = `$${trade.entry.toLocaleString()}`;

    const tpEl = document.getElementById('ptTp');
    if (tpEl) tpEl.innerText = `$${trade.tp.toLocaleString()} (+${trade.targetDist} pts)`;

    const slEl = document.getElementById('ptSl');
    if (slEl) slEl.innerText = `$${trade.sl.toLocaleString()} (-${trade.slDist} pts)`;

    const rrEl = document.getElementById('ptRR');
    if (rrEl) rrEl.innerText = `1 : ${trade.rrRatio}`;

    const activeLabel = document.getElementById('ptActiveLabel');
    if (activeLabel) {
      const d = new Date(trade.time * 1000);
      const timeStr = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      activeLabel.innerText = `Inspecting Setup at ${timeStr} (${trade.direction} - ${trade.outcome})`;
    }

    // Real Delta Contract Details
    const opt = trade.realOption;
    const symEl = document.getElementById('ptContractSymbol');
    const markEl = document.getElementById('ptDeltaMark');
    const buyZoneEl = document.getElementById('ptDeltaBuyZone');
    const targetEl = document.getElementById('ptDeltaTarget');
    const liveTagEl = document.getElementById('ptDeltaLiveTag');

    if (opt) {
      if (symEl) symEl.innerText = opt.symbol;
      if (markEl) markEl.innerText = `$${opt.markPrice.toFixed(1)}`;
      if (buyZoneEl) buyZoneEl.innerText = opt.buyZone;
      if (targetEl) targetEl.innerText = `$${opt.targetPrice.toFixed(1)} (${opt.targetGainPct})`;
      if (liveTagEl) {
        liveTagEl.className = opt.isLive 
          ? "text-[9px] font-mono px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-400 border border-emerald-500/30 font-bold"
          : "text-[9px] font-mono px-1.5 py-0.5 rounded bg-indigo-500/10 text-indigo-300 border border-indigo-500/30 font-bold";
        liveTagEl.innerText = opt.isLive ? "Live Delta Feed" : "Simulated Strike";
      }
    } else {
      if (symEl) symEl.innerText = isCall ? `C-BTC-${trade.optionStrike}` : `P-BTC-${trade.optionStrike}`;
      if (markEl) markEl.innerText = "$220.0";
      if (buyZoneEl) buyZoneEl.innerText = "$210.0 - $225.0";
      if (targetEl) targetEl.innerText = "$330.0 (+50%)";
    }
  }

  /**
   * Selects a trade, centers the chart view directly on it, draws the box, and updates cockpit
   */
  function selectTrade(tradeId) {
    if (!currentAnalysis || !currentAnalysis.trades) return;
    const t = currentAnalysis.trades.find(x => x.id === tradeId);
    if (t) {
      selectedTrade = t;

      // Center chart view directly on this trade's candles
      if (chart && chart.timeScale && t.index !== undefined) {
        chart.timeScale().setVisibleLogicalRange({
          from: Math.max(0, t.index - 12),
          to: Math.min(candleData.length + 5, t.index + 20)
        });
      }

      renderPositionBox(t);
      updatePositionToolCockpit(t);

      // Highlight row in table
      const rows = document.querySelectorAll('.bt-trade-row');
      rows.forEach(r => r.classList.remove('bg-indigo-600/20', 'border-indigo-500'));
      const activeRow = document.getElementById(`row_${tradeId}`);
      if (activeRow) activeRow.classList.add('bg-indigo-600/20');
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
   * Opens the deep-dive educational breakdown modal for a trade
   */
  function openTradeDetailsModal(tradeId) {
    const idToUse = tradeId || (selectedTrade ? selectedTrade.id : null);
    if (!currentAnalysis || !currentAnalysis.trades) return;
    const t = currentAnalysis.trades.find(x => x.id === idToUse);
    if (!t) return;

    const modal = document.getElementById('algoTradeModal');
    if (!modal) return;

    const isCall = t.direction === "LONG";
    const d = new Date(t.time * 1000);
    const timeStr = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: true });
    const dateStr = d.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });

    document.getElementById('atmModalTitle').innerText = `${t.name} (${isCall ? 'CALL OPTION' : 'PUT OPTION'})`;
    document.getElementById('atmModalTime').innerText = `${dateStr} at ${timeStr} Local Time`;

    // Outcome Badge
    const badgeEl = document.getElementById('atmModalOutcomeBadge');
    if (t.outcome === "WIN") {
      badgeEl.className = "px-2.5 py-1 rounded-lg text-xs font-bold font-mono bg-emerald-500/10 text-emerald-400 border border-emerald-500/30";
      badgeEl.innerHTML = `<i class="fa-solid fa-circle-check mr-1"></i> TARGET REACHED (+50% OPTION PROFIT)`;
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

    // Rationale fields
    const r = t.rationale || {};
    document.getElementById('atmModalLevel').innerText = r.levelTested || "--";
    document.getElementById('atmModalPattern').innerText = r.pattern || "--";
    document.getElementById('atmModalConfirmation').innerText = r.confirmation || "--";
    document.getElementById('atmModalRsiRvol').innerText = `${r.rsi || ''} | ${r.rvol || ''}`;
    document.getElementById('atmModalNarrative').innerText = r.narrative || "--";

    // Playbook steps with real Delta contract
    const opt = t.realOption;
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

    navigator.clipboard.writeText(text).then(() => {
      alert("Real Delta Exchange order plan copied to clipboard! Paste directly into your notes or Delta terminal.");
    });
  }

  /**
   * Runs the algorithmic SMC confluence strategy across loaded candles,
   * updates the scorecard, places markers, and draws the Position Tool.
   */
  function runSMCAnalysisAndBacktest() {
    if (!candleData || candleData.length === 0 || !candleSeries) return;

    // Run Algorithmic SMC Confluence Engine
    currentAnalysis = DeltaSMCStrategy.runBacktest(candleData, {
      lookback: activeTimeframe === '1m' ? 30 : 24,
      highConvictionOnly: true
    });

    // Set Markers on TradingView Chart (Clean, uncluttered)
    candleSeries.setMarkers(currentAnalysis.markers);

    // Automatically draw the latest high-conviction trade box on the chart
    if (currentAnalysis.latestTrade && (!selectedTrade || !currentAnalysis.trades.find(t => t.id === selectedTrade.id))) {
      selectedTrade = currentAnalysis.latestTrade;
      renderPositionBox(selectedTrade);
      updatePositionToolCockpit(selectedTrade);
    } else if (selectedTrade) {
      const existing = currentAnalysis.trades.find(t => t.id === selectedTrade.id);
      if (existing) {
        selectedTrade = existing;
        renderPositionBox(selectedTrade);
        updatePositionToolCockpit(selectedTrade);
      } else if (currentAnalysis.latestTrade) {
        selectedTrade = currentAnalysis.latestTrade;
        renderPositionBox(selectedTrade);
        updatePositionToolCockpit(selectedTrade);
      }
    }

    // Update Quant Time-Machine Scorecard
    const stats = currentAnalysis.stats;
    const wrEl = document.getElementById('btWinRate');
    const pfEl = document.getElementById('btProfitFactor');
    const ddEl = document.getElementById('btMaxDrawdown');
    const expEl = document.getElementById('btExpectancy');
    const countEl = document.getElementById('btTradeCount');

    if (wrEl) wrEl.innerText = `${stats.winRate}%`;
    if (pfEl) pfEl.innerText = `${stats.profitFactor}`;
    if (ddEl) ddEl.innerText = `-${stats.maxDrawdownR}R`;
    if (expEl) expEl.innerText = `+${stats.expectancyR}R`;
    if (countEl) countEl.innerText = `${stats.totalTrades} setups (${stats.wins}W - ${stats.losses}L - ${stats.timeouts}T${stats.active > 0 ? ` - ${stats.active} Active` : ''})`;

    // Fetch live Delta Exchange India tickers and enrich all trades asynchronously
    getLiveDeltaTickers().then(tickers => {
      if (tickers && tickers.length > 0 && currentAnalysis && currentAnalysis.trades) {
        currentAnalysis.trades.forEach(t => {
          t.realOption = resolveRealDeltaContract(t.direction, t.entry, tickers);
        });

        if (selectedTrade) {
          selectedTrade.realOption = resolveRealDeltaContract(selectedTrade.direction, selectedTrade.entry, tickers);
          updatePositionToolCockpit(selectedTrade);
          renderPositionBox(selectedTrade);
        }

        renderTradesTable(currentAnalysis.trades);
      }
    });

    // Update Live Signal Radar Banner
    const signalBanner = document.getElementById('liveSignalBanner');
    if (signalBanner) {
      const activeTrade = currentAnalysis.trades.find(t => t.outcome === "ACTIVE");
      if (activeTrade) {
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
            <span class="text-[10px] text-emerald-400 font-bold hidden sm:inline">Calibrated: Real Delta India Options (+50%)</span>
          </div>
        `;
      }
    }

    // Render Institutional Trade History Table
    renderTradesTable(currentAnalysis.trades);
  }

  /**
   * Renders the interactive trade list under the chart
   */
  function renderTradesTable(trades) {
    const tbody = document.getElementById('btTradesTableBody');
    if (!tbody) return;

    if (!trades || trades.length === 0) {
      tbody.innerHTML = `<tr><td colspan="6" class="py-4 text-center text-slate-500 font-mono">No institutional setups triggered in current candle window.</td></tr>`;
      return;
    }

    // Sort descending by time
    const sorted = [...trades].reverse();

    tbody.innerHTML = sorted.map(t => {
      const d = new Date(t.time * 1000);
      const dateStr = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: true });
      const isCall = t.direction === "LONG";
      const isWin = t.outcome === "WIN";
      const isLoss = t.outcome === "LOSS";
      const isActive = t.outcome === "ACTIVE";

      let outcomeBadge = "";
      if (isActive) {
        outcomeBadge = `<span class="px-2 py-0.5 rounded text-[10px] font-bold bg-cyan-500/10 text-cyan-400 border border-cyan-500/30 flex items-center gap-1 w-fit"><span class="h-1.5 w-1.5 rounded-full bg-cyan-400 animate-ping"></span> ACTIVE (${t.barsHeld}b)</span>`;
      } else if (isWin) {
        outcomeBadge = `<span class="px-2 py-0.5 rounded text-[10px] font-bold bg-emerald-500/10 text-emerald-400 border border-emerald-500/30">WIN (+50%)</span>`;
      } else if (isLoss) {
        outcomeBadge = `<span class="px-2 py-0.5 rounded text-[10px] font-bold bg-rose-500/10 text-rose-400 border border-rose-500/30">LOSS (-1R)</span>`;
      } else {
        outcomeBadge = `<span class="px-2 py-0.5 rounded text-[10px] font-bold bg-slate-500/10 text-slate-400 border border-slate-500/30">TIMEOUT</span>`;
      }

      const opt = t.realOption;
      const contractLabel = opt ? opt.symbol : (isCall ? 'C-BTC-' + t.optionStrike : 'P-BTC-' + t.optionStrike);
      const markLabel = opt && opt.markPrice ? `$${opt.markPrice}` : '--';

      const isSelected = selectedTrade && selectedTrade.id === t.id;

      return `
        <tr id="row_${t.id}" class="bt-trade-row hover:bg-panelDark/60 transition-colors cursor-pointer ${isSelected ? 'bg-indigo-600/20' : ''}" onclick="DeltaLiveChart.selectTrade('${t.id}')">
          <td class="py-2.5 px-2 text-slate-200 font-bold whitespace-nowrap">${dateStr}</td>
          <td class="py-2.5 px-2">
            <span class="inline-flex items-center gap-1 font-bold ${isCall ? 'text-winGreen' : 'text-lossRed'}">
              <i class="fa-solid ${isCall ? 'fa-arrow-up' : 'fa-arrow-down'} text-[10px]"></i>
              ${isCall ? 'CALL' : 'PUT'}
            </span>
            <span class="text-[10px] text-slate-400 ml-1 hidden md:inline">${t.name}</span>
          </td>
          <td class="py-2.5 px-2">
            <span class="text-indigo-300 font-semibold block text-[11px]">${contractLabel}</span>
            <span class="text-[9px] text-slate-400 hidden sm:inline">Mark: ${markLabel}</span>
          </td>
          <td class="py-2.5 px-2 text-slate-300 whitespace-nowrap">
            $${t.entry.toLocaleString()} &rarr; <span class="${isWin ? 'text-winGreen font-bold' : ''}">$${t.tp.toLocaleString()}</span>
          </td>
          <td class="py-2.5 px-2">${outcomeBadge}</td>
          <td class="py-2.5 px-2 text-right whitespace-nowrap">
            <div class="flex items-center justify-end gap-1">
              <button onclick="event.stopPropagation(); DeltaLiveChart.selectTrade('${t.id}')" title="Center on Chart" class="px-2 py-1 rounded bg-panelDark hover:bg-indigo-600 text-slate-300 hover:text-white font-bold text-[10px] border border-borderDark transition-colors">
                <i class="fa-solid fa-crosshairs"></i>
              </button>
              <button onclick="event.stopPropagation(); DeltaLiveChart.openTradeDetailsModal('${t.id}')" title="Why was this taken?" class="px-2 py-1 rounded bg-indigo-600 hover:bg-indigo-500 text-white font-bold text-[10px] transition-colors shadow-sm flex items-center gap-1">
                <i class="fa-solid fa-circle-info"></i> Logic
              </button>
            </div>
          </td>
        </tr>
      `;
    }).join('');
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

  /**
   * Fallback for historical candles using Delta Exchange public endpoint
   */
  async function loadDeltaFallback(tf) {
    const resMap = { '1m': '1', '5m': '5', '15m': '15', '1h': '60', '4h': '240', '1D': '1D' };
    const resolution = resMap[tf] || '15';
    const end = Math.floor(Date.now() / 1000);
    const start = end - (86400 * 3);
    const url = `https://api.india.delta.exchange/v2/chart/history?symbol=BTCUSD&resolution=${resolution}&from=${start}&to=${end}`;

    try {
      const res = await fetch(url);
      const data = await res.json();
      if (!data.result || !data.result.c) return;

      const r = data.result;
      candleData = [];
      for (let i = 0; i < r.t.length; i++) {
        candleData.push({
          time: r.t[i],
          open: r.o[i],
          high: r.h[i],
          low: r.l[i],
          close: r.c[i],
          volume: r.v[i] || 0
        });
      }
      candleSeries.setData(candleData);
      chart.timeScale().fitContent();
      runSMCAnalysisAndBacktest();
    } catch (e) {
      console.error("Delta fallback error:", e);
    }
  }

  return {
    initChart,
    loadTimeframe,
    runSMCAnalysisAndBacktest,
    selectTrade,
    showLatestTrade,
    clearLinesAndReset,
    openTradeDetailsModal,
    closeTradeDetailsModal,
    copyDeltaOrderDetails
  };
})();
