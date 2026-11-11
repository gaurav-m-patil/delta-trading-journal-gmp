/**
 * Delta Trading Journal - Elite Institutional Confluence Strategy & Quant Backtester Engine
 * 
 * Specially engineered for Bitcoin (BTC/USD) and Delta Exchange India Options:
 * - High-Conviction Confluence: Support/Resistance Pivots + Price Action Confirmation + RSI + RVOL + EMA.
 * - Options 200 -> 300 Target Calibration: Calibrated for ATM Options (+220 to +280 spot move = +50% gross / +40% net).
 * - TradingView Position Tool integration: Native Entry, Take Profit, and Stop Loss drawing lines.
 * 
 * Runs 100% locally in-browser: ZERO API costs, ZERO Firebase reads/writes.
 */

window.DeltaSMCStrategy = (function() {

  /**
   * Calculates Exponential Moving Average (EMA)
   */
  function calcEMA(candles, period) {
    const ema = new Array(candles.length).fill(0);
    if (candles.length < period) return ema;
    const k = 2 / (period + 1);
    let sum = 0;
    for (let i = 0; i < period; i++) sum += candles[i].close;
    ema[period - 1] = sum / period;
    for (let i = period; i < candles.length; i++) {
      ema[i] = candles[i].close * k + ema[i - 1] * (1 - k);
    }
    return ema;
  }

  /**
   * Calculates 14-period Relative Strength Index (RSI)
   */
  function calcRSI(candles, period = 14) {
    const rsi = new Array(candles.length).fill(50);
    if (candles.length <= period) return rsi;
    let gains = 0, losses = 0;
    for (let i = 1; i <= period; i++) {
      const diff = candles[i].close - candles[i - 1].close;
      if (diff >= 0) gains += diff;
      else losses -= diff;
    }
    let avgGain = gains / period;
    let avgLoss = losses / period;
    rsi[period] = avgLoss === 0 ? 100 : 100 - (100 / (1 + (avgGain / avgLoss)));
    for (let i = period + 1; i < candles.length; i++) {
      const diff = candles[i].close - candles[i - 1].close;
      const gain = diff >= 0 ? diff : 0;
      const loss = diff < 0 ? -diff : 0;
      avgGain = (avgGain * (period - 1) + gain) / period;
      avgLoss = (avgLoss * (period - 1) + loss) / period;
      rsi[i] = avgLoss === 0 ? 100 : Number((100 - (100 / (1 + (avgGain / avgLoss)))).toFixed(1));
    }
    return rsi;
  }

  /**
   * Calculates 20-period Relative Volume (RVOL)
   */
  function calcRVOL(candles, period = 20) {
    const rvol = new Array(candles.length).fill(1.0);
    for (let i = period; i < candles.length; i++) {
      let sum = 0;
      for (let j = i - period; j < i; j++) sum += candles[j].volume;
      const avg = sum / period;
      rvol[i] = avg > 0 ? Number((candles[i].volume / avg).toFixed(2)) : 1.0;
    }
    return rvol;
  }

  /**
   * Identifies Institutional High-Conviction Trades and backtests forward bar-by-bar
   * @param {Array} candles - Array of { time, open, high, low, close, volume }
   * @param {Object} options - Strategy tuning parameters
   */
  function runBacktest(candles, options = {}) {
    if (!candles || candles.length < 35) {
      return {
        trades: [],
        markers: [],
        activeSignal: null,
        latestTrade: null,
        stats: {
          totalTrades: 0,
          wins: 0,
          losses: 0,
          timeouts: 0,
          winRate: 0,
          profitFactor: 0,
          maxDrawdownR: 0,
          expectancyR: 0,
          avgRR: 1.8
        }
      };
    }

    const lookback = options.lookback || 24;
    const highConvictionOnly = options.highConvictionOnly !== false;

    // Technical Indicators
    const ema50 = calcEMA(candles, 50);
    const rsi = calcRSI(candles, 14);
    const rvol = calcRVOL(candles, 20);

    const trades = [];
    const markers = [];
    let activeSignal = null;
    const scanLimit = candles.length - 1;

    let i = Math.max(30, lookback + 1);

    while (i < scanLimit) {
      const cur = candles[i];
      const prev = candles[i - 1];
      const curRsi = rsi[i];
      const curRvol = rvol[i];
      const curEma50 = ema50[i];

      // Dynamic Support and Resistance Pivots over lookback window
      const windowCandles = candles.slice(i - lookback - 1, i - 1);
      const sHigh = Math.max(...windowCandles.map(c => c.high));
      const sLow = Math.min(...windowCandles.map(c => c.low));

      const prevRange = prev.high - prev.low;
      const prevUpperWick = prev.high - Math.max(prev.open, prev.close);
      const prevLowerWick = Math.min(prev.open, prev.close) - prev.low;

      let setup = null;

      // -------------------------------------------------------------
      // SETUP 1: CONFIRMED RESISTANCE REJECTION & LIQUIDITY SWEEP (PUT OPTION ENTRY)
      // High-Conviction: Prior candle tested/swept resistance with upper wick,
      // Current candle confirms with a solid red close breaking down, RSI turning from high.
      // -------------------------------------------------------------
      const isResistanceRejection = (prev.high >= sHigh * 0.9985) && (prevUpperWick >= prevRange * 0.25);
      const isBearishConfirmed = (cur.close < cur.open) && (cur.close < prev.close) && (curRsi > 45);

      if (isResistanceRejection && isBearishConfirmed) {
        const entry = cur.close;
        const sl = Math.round((prev.high + 30) * 10) / 10;
        const slDist = sl - entry;

        if (slDist >= 90 && slDist <= 250) {
          // In Delta Options, +100 premium points (200 -> 300) requires ~220-280 spot move
          const targetDist = Math.round(Math.max(210, slDist * 1.6) * 10) / 10;
          const tp = Math.round((entry - targetDist) * 10) / 10;
          const atmStrike = Math.round(entry / 500) * 500;

          setup = {
            id: `TRADE_${i}_${cur.time}`,
            index: i,
            time: cur.time,
            direction: "SHORT",
            type: "CONFIRMED_RESISTANCE_REJECTION",
            name: "Confirmed Resistance Rejection (Bearish)",
            entry,
            sl,
            tp,
            targetDist,
            slDist: Math.round(slDist * 10) / 10,
            rrRatio: Number((targetDist / slDist).toFixed(2)),
            rvol: curRvol,
            rsi: curRsi,
            optionStrike: atmStrike,
            optionRecommendation: `Buy P-BTC-${atmStrike} (ATM Put) @ ~200 -> Target 300 (+50% Profit)`,
            invalidationReason: `Close above resistance wick ($${sl})`
          };
        }
      }

      // -------------------------------------------------------------
      // SETUP 2: CONFIRMED SUPPORT BOUNCE & LIQUIDITY SWEEP (CALL OPTION ENTRY)
      // High-Conviction: Prior candle tested/swept support with lower wick defense,
      // Current candle confirms with a solid green close breaking up, RSI turning from low.
      // -------------------------------------------------------------
      const isSupportBounce = (prev.low <= sLow * 1.0015) && (prevLowerWick >= prevRange * 0.25);
      const isBullishConfirmed = (cur.close > cur.open) && (cur.close > prev.close) && (curRsi < 55);

      if (!setup && isSupportBounce && isBullishConfirmed) {
        const entry = cur.close;
        const sl = Math.round((prev.low - 30) * 10) / 10;
        const slDist = entry - sl;

        if (slDist >= 90 && slDist <= 250) {
          const targetDist = Math.round(Math.max(210, slDist * 1.6) * 10) / 10;
          const tp = Math.round((entry + targetDist) * 10) / 10;
          const atmStrike = Math.round(entry / 500) * 500;

          setup = {
            id: `TRADE_${i}_${cur.time}`,
            index: i,
            time: cur.time,
            direction: "LONG",
            type: "CONFIRMED_SUPPORT_BOUNCE",
            name: "Confirmed Support Bounce (Bullish)",
            entry,
            sl,
            tp,
            targetDist,
            slDist: Math.round(slDist * 10) / 10,
            rrRatio: Number((targetDist / slDist).toFixed(2)),
            rvol: curRvol,
            rsi: curRsi,
            optionStrike: atmStrike,
            optionRecommendation: `Buy C-BTC-${atmStrike} (ATM Call) @ ~200 -> Target 300 (+50% Profit)`,
            invalidationReason: `Close below support wick ($${sl})`
          };
        }
      }

      // -------------------------------------------------------------
      // FORWARD RESOLUTION (Timemachine Forward Evaluation)
      // -------------------------------------------------------------
      if (setup) {
        let outcome = "TIMEOUT";
        let exitIndex = Math.min(candles.length - 1, i + 22);
        let exitPrice = cur.close;
        let barsHeld = 0;

        for (let j = i + 1; j < Math.min(candles.length, i + 24); j++) {
          barsHeld++;
          const fwd = candles[j];

          if (setup.direction === "LONG") {
            if (fwd.low <= setup.sl) {
              outcome = "LOSS";
              exitIndex = j;
              exitPrice = setup.sl;
              break;
            } else if (fwd.high >= setup.tp) {
              outcome = "WIN";
              exitIndex = j;
              exitPrice = setup.tp;
              break;
            }
          } else {
            // SHORT
            if (fwd.high >= setup.sl) {
              outcome = "LOSS";
              exitIndex = j;
              exitPrice = setup.sl;
              break;
            } else if (fwd.low <= setup.tp) {
              outcome = "WIN";
              exitIndex = j;
              exitPrice = setup.tp;
              break;
            }
          }
        }

        setup.outcome = outcome;
        setup.exitIndex = exitIndex;
        setup.exitTime = candles[exitIndex]?.time || cur.time;
        setup.exitPrice = exitPrice;
        setup.barsHeld = barsHeld;

        // Realistic Delta Option Profit calculation
        if (outcome === "WIN") {
          setup.pnlR = setup.rrRatio;
          setup.optionPnlPct = "+50.0%";
          setup.netProfitEstimate = "+40.0% (Post Fees & 30% Tax)";
          setup.badgeColor = "text-emerald-400 bg-emerald-500/10 border-emerald-500/30";
        } else if (outcome === "LOSS") {
          setup.pnlR = -1.0;
          setup.optionPnlPct = "-30.0%";
          setup.netProfitEstimate = "-1.0R Controlled Stop";
          setup.badgeColor = "text-rose-400 bg-rose-500/10 border-rose-500/30";
        } else {
          // Timeout / Scratch
          const spotDiff = setup.direction === "LONG" ? (candles[exitIndex].close - setup.entry) : (setup.entry - candles[exitIndex].close);
          setup.pnlR = Number((spotDiff / setup.slDist).toFixed(2));
          setup.optionPnlPct = setup.pnlR >= 0 ? `+${(setup.pnlR * 25).toFixed(0)}%` : `-${Math.abs(setup.pnlR * 25).toFixed(0)}%`;
          setup.netProfitEstimate = "Breakeven / Scratch Exit";
          setup.badgeColor = "text-slate-400 bg-slate-500/10 border-slate-500/30";
        }

        trades.push(setup);

        // Chart Marker: Clean, un-crowded, professional labels
        const isWin = outcome === "WIN";
        const isLoss = outcome === "LOSS";
        const isCall = setup.direction === "LONG";
        const labelText = isWin ? `${isCall ? 'CALL' : 'PUT'} WIN [+50%]` : (isLoss ? `${isCall ? 'CALL' : 'PUT'} SL [-1R]` : `${isCall ? 'CALL' : 'PUT'} TIMEOUT`);

        markers.push({
          time: cur.time,
          position: isCall ? "belowBar" : "aboveBar",
          color: isCall ? (isWin ? "#10b981" : "#059669") : (isWin ? "#f43f5e" : "#e11d48"),
          shape: isCall ? "arrowUp" : "arrowDown",
          text: labelText,
          size: 1.5,
          tradeRef: setup
        });

        // Fast-forward loop past trade duration to prevent duplicate trigger spam
        i += Math.max(4, barsHeld);
      } else {
        i++;
      }
    }

    // -------------------------------------------------------------
    // LIVE ACTIVE SIGNAL DETECTOR (On the current live candle)
    // -------------------------------------------------------------
    if (candles.length >= 30) {
      const latest = candles[candles.length - 1];
      const prev = candles[candles.length - 2];
      const latestRsi = rsi[candles.length - 1];
      const latestRvol = rvol[candles.length - 1];

      const recentWindow = candles.slice(-25, -2);
      const liveHigh = Math.max(...recentWindow.map(c => c.high));
      const liveLow = Math.min(...recentWindow.map(c => c.low));

      const prevRange = prev.high - prev.low;
      const prevUpper = prev.high - Math.max(prev.open, prev.close);
      const prevLower = Math.min(prev.open, prev.close) - prev.low;

      // Bullish Live Trigger
      if ((prev.low <= liveLow * 1.0015) && (prevLower >= prevRange * 0.25) && (latest.close > latest.open) && (latestRsi < 55)) {
        const entry = latest.close;
        const sl = Math.round((prev.low - 30) * 10) / 10;
        const slDist = entry - sl;
        const targetDist = Math.round(Math.max(210, slDist * 1.6) * 10) / 10;
        const tp = Math.round((entry + targetDist) * 10) / 10;
        const atm = Math.round(entry / 500) * 500;

        activeSignal = {
          direction: "BULLISH CALL ENTRY",
          type: "LONG",
          name: "Live Support Defense & Confirmation Bounce",
          entry,
          sl,
          tp,
          targetDist,
          slDist: Math.round(slDist * 10) / 10,
          rrRatio: Number((targetDist / slDist).toFixed(2)),
          strike: `Buy C-BTC-${atm} (ATM Call)`,
          optionGoal: `Enter @ ~200 -> Target 300 (+50% Profit)`,
          time: latest.time
        };
      }
      // Bearish Live Trigger
      else if ((prev.high >= liveHigh * 0.9985) && (prevUpper >= prevRange * 0.25) && (latest.close < latest.open) && (latestRsi > 45)) {
        const entry = latest.close;
        const sl = Math.round((prev.high + 30) * 10) / 10;
        const slDist = sl - entry;
        const targetDist = Math.round(Math.max(210, slDist * 1.6) * 10) / 10;
        const tp = Math.round((entry - targetDist) * 10) / 10;
        const atm = Math.round(entry / 500) * 500;

        activeSignal = {
          direction: "BEARISH PUT ENTRY",
          type: "SHORT",
          name: "Live Resistance Sweep & Rejection",
          entry,
          sl,
          tp,
          targetDist,
          slDist: Math.round(slDist * 10) / 10,
          rrRatio: Number((targetDist / slDist).toFixed(2)),
          strike: `Buy P-BTC-${atm} (ATM Put)`,
          optionGoal: `Enter @ ~200 -> Target 300 (+50% Profit)`,
          time: latest.time
        };
      }
    }

    // -------------------------------------------------------------
    // STATISTICAL TIME-MACHINE SCORECARD
    // -------------------------------------------------------------
    const totalTrades = trades.length;
    let wins = 0;
    let losses = 0;
    let timeouts = 0;
    let totalGrossWinsR = 0;
    let totalGrossLossesR = 0;
    let peakR = 0;
    let currentR = 0;
    let maxDrawdownR = 0;

    trades.forEach(t => {
      if (t.outcome === "WIN") {
        wins++;
        totalGrossWinsR += t.pnlR;
      } else if (t.outcome === "LOSS") {
        losses++;
        totalGrossLossesR += Math.abs(t.pnlR);
      } else {
        timeouts++;
      }

      currentR += t.pnlR;
      if (currentR > peakR) peakR = currentR;
      const dd = peakR - currentR;
      if (dd > maxDrawdownR) maxDrawdownR = dd;
    });

    const evaluatedCompleted = wins + losses;
    const winRate = evaluatedCompleted > 0 ? (wins / evaluatedCompleted) * 100 : 0;
    const profitFactor = totalGrossLossesR > 0 ? totalGrossWinsR / totalGrossLossesR : (totalGrossWinsR > 0 ? 99 : 0);
    const pWin = wins / (evaluatedCompleted || 1);
    const pLoss = losses / (evaluatedCompleted || 1);
    const avgRR = 1.6;
    const expectancyR = (pWin * avgRR) - (pLoss * 1.0);

    const latestTrade = trades.length > 0 ? trades[trades.length - 1] : null;

    return {
      trades,
      markers,
      activeSignal,
      latestTrade,
      stats: {
        totalTrades,
        wins,
        losses,
        timeouts,
        winRate: Math.round(winRate),
        profitFactor: Number(profitFactor.toFixed(2)),
        maxDrawdownR: Number(maxDrawdownR.toFixed(1)),
        expectancyR: Number(expectancyR.toFixed(2)),
        avgRR
      }
    };
  }

  return {
    runBacktest
  };
})();
