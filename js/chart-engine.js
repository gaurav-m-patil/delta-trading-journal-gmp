/**
 * Delta Trading Journal - Institutional Live Chart Engine
 * Powered by TradingView Lightweight Charts (Canvas, 60 FPS)
 * Connects to public real-time WebSocket feeds for tick-by-tick live BTC/USD streaming.
 * Zero API keys, Zero Firebase reads, Zero external cost.
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

  const TIMEFRAME_MAP = {
    '1m': '1m',
    '5m': '5m',
    '15m': '15m',
    '1h': '1h',
    '4h': '4h',
    '1D': '1d'
  };

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
        secondsVisible: false
      },
      rightPriceScale: {
        borderColor: '#1e293b',
        scaleMargins: {
          top: 0.1,
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
        top: 0.8,
        bottom: 0
      }
    });

    // Responsive window resizing
    window.addEventListener('resize', () => {
      if (chart && container) {
        chart.applyOptions({ width: container.clientWidth });
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

    const banner = document.getElementById('chartStatusBanner');
    if (banner) banner.innerText = `Loading ${tf} historical candles...`;

    // 1. Close existing live WebSocket stream if active
    if (wsConnection) {
      try { wsConnection.close(); } catch (e) {}
      wsConnection = null;
    }

    // 2. Fetch historical OHLCV bars via public Binance REST
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

      // 3. Execute Algorithmic SMC Backtest & Place Setup Markers
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

          // If candle closed, refresh backtest & live signals
          if (k.x) {
            candleData.push(updatedCandle);
            runSMCAnalysisAndBacktest();
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
   * Runs the algorithmic SMC strategy across loaded candles,
   * places clean markers on the chart for trades the system would have taken,
   * and renders the Time-Machine backtest stats.
   */
  function runSMCAnalysisAndBacktest() {
    if (!candleData || candleData.length === 0 || !candleSeries) return;

    // Run Algorithmic SMC Engine
    const analysis = DeltaSMCStrategy.runBacktest(candleData, {
      lookback: activeTimeframe === '1m' ? 20 : 15,
      rvolThreshold: 1.35,
      targetRR: 2.0
    });

    // Set Markers on TradingView Chart (Clean, uncluttered)
    candleSeries.setMarkers(analysis.markers);

    // Update Quant Time-Machine Scorecard
    const stats = analysis.stats;
    const wrEl = document.getElementById('btWinRate');
    const pfEl = document.getElementById('btProfitFactor');
    const ddEl = document.getElementById('btMaxDrawdown');
    const expEl = document.getElementById('btExpectancy');
    const countEl = document.getElementById('btTradeCount');

    if (wrEl) wrEl.innerText = `${stats.winRate}%`;
    if (pfEl) pfEl.innerText = `${stats.profitFactor}`;
    if (ddEl) ddEl.innerText = `-${stats.maxDrawdownR}R`;
    if (expEl) expEl.innerText = `+${stats.expectancyR}R`;
    if (countEl) countEl.innerText = `${stats.totalTrades} setups (${stats.wins}W - ${stats.losses}L)`;

    // Update Live Signal Radar Banner
    const signalBanner = document.getElementById('liveSignalBanner');
    if (signalBanner) {
      if (analysis.activeSignal) {
        const sig = analysis.activeSignal;
        const isBull = sig.direction.includes('BULLISH');
        signalBanner.innerHTML = `
          <div class="p-4 rounded-xl border ${isBull ? 'bg-winGreen/10 border-winGreen/40' : 'bg-lossRed/10 border-lossRed/40'} flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3">
            <div class="flex items-center gap-3">
              <div class="h-9 w-9 rounded-xl ${isBull ? 'bg-winGreen/20 text-winGreen' : 'bg-lossRed/20 text-lossRed'} flex items-center justify-center font-bold text-base shrink-0">
                <i class="fa-solid ${isBull ? 'fa-arrow-trend-up' : 'fa-arrow-trend-down'}"></i>
              </div>
              <div>
                <div class="flex items-center gap-2">
                  <span class="text-xs font-bold font-mono px-2 py-0.5 rounded bg-brandDark text-white">${sig.direction}</span>
                  <span class="text-xs font-bold text-white">${sig.name}</span>
                </div>
                <p class="text-[11px] text-slate-300 font-mono mt-0.5">
                  Trigger: <strong>$${sig.price}</strong> | Invalidation (SL): <strong class="text-lossRed">$${sig.stopLoss}</strong> | Target (2R): <strong class="text-winGreen">$${sig.target}</strong>
                </p>
              </div>
            </div>
            <div class="bg-brandDark/80 border border-borderDark px-3 py-1.5 rounded-lg text-right w-full sm:w-auto">
              <span class="text-[9px] uppercase tracking-wider text-slate-400 block">Delta Option Suggestion</span>
              <span class="text-xs font-bold font-mono text-indigo-300">${sig.strike}</span>
            </div>
          </div>
        `;
      } else {
        signalBanner.innerHTML = `
          <div class="p-3 rounded-xl bg-brandDark/40 border border-borderDark/60 flex items-center justify-between text-xs text-slate-400 font-mono">
            <span class="flex items-center gap-2">
              <i class="fa-solid fa-radar text-indigo-400 animate-spin"></i> Scanner Active: No active A+ institutional setups triggered on current bar. Waiting for sweep/displacement...
            </span>
            <span class="text-[10px] text-slate-500 hidden sm:inline">Active Timeframe: ${activeTimeframe}</span>
          </div>
        `;
      }
    }
  }

  function updateTimeframeButtons(activeTf) {
    ['1m', '5m', '15m', '1h', '4h', '1D'].forEach(tf => {
      const btn = document.getElementById(`btnTf_${tf}`);
      if (!btn) return;
      if (tf === activeTf) {
        btn.className = "px-2.5 py-1 text-xs font-bold rounded-lg bg-indigo-600 text-white font-mono shadow-sm";
      } else {
        btn.className = "px-2.5 py-1 text-xs font-bold rounded-lg text-slate-400 hover:text-white bg-panelDark font-mono";
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
    runSMCAnalysisAndBacktest
  };
})();
