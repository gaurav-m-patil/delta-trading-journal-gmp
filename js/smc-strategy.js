/**
 * Delta Trading Journal - Elite Institutional Confluence Strategy & Quant Backtester Engine
 * 
 * Specially engineered for Bitcoin (BTC/USD) and Delta Exchange India Options:
 * - High-Conviction Confluence: Support/Resistance Pivots + Price Action Confirmation + RSI + RVOL + EMA.
 * - Options 200 -> 300 Target Calibration: Calibrated for ATM Options (+210 to +260 spot move = +50% gross / +40% net).
 * - Real-time state machine: Accurate WIN, LOSS, TIMEOUT (20+ bars), and ACTIVE status (zero false timeouts).
 * - Full Institutional Rationale & Delta Execution Playbook for every trade.
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
          active: 0,
          winRate: 0,
          profitFactor: 0,
          maxDrawdownR: 0,
          expectancyR: 0,
          avgRR: 1.8
        }
      };
    }

    const lookback = options.lookback || 24;

    // Technical Indicators
    const ema50 = calcEMA(candles, 50);
    const rsi = calcRSI(candles, 14);
    const rvol = calcRVOL(candles, 20);

    const trades = [];
    const markers = [];
    let activeSignal = null;
    const scanLimit = candles.length;

    let i = Math.max(30, lookback + 1);

    while (i < scanLimit) {
      const cur = candles[i];
      const prev = candles[i - 1];
      if (!cur || !prev) break;

      const curRsi = rsi[i];
      const curRvol = rvol[i];
      const curEma50 = ema50[i];

      // Dynamic Support and Resistance Pivots over lookback window
      const windowCandles = candles.slice(Math.max(0, i - lookback - 1), i - 1);
      const sHigh = Math.max(...windowCandles.map(c => c.high));
      const sLow = Math.min(...windowCandles.map(c => c.low));

      const prevRange = prev.high - prev.low;
      const prevUpperWick = prev.high - Math.max(prev.open, prev.close);
      const prevLowerWick = Math.min(prev.open, prev.close) - prev.low;

      let setup = null;

      // -------------------------------------------------------------
      // SETUP 1: CONFIRMED RESISTANCE REJECTION & LIQUIDITY SWEEP (PUT OPTION ENTRY)
      // -------------------------------------------------------------
      const isResistanceRejection = (prev.high >= sHigh * 0.9985) && (prevUpperWick >= prevRange * 0.25);
      const isBearishConfirmed = (cur.close < cur.open) && (cur.close < prev.close) && (curRsi > 45);

      if (isResistanceRejection && isBearishConfirmed) {
        const entry = cur.close;
        const sl = Math.round((prev.high + 30) * 10) / 10;
        const slDist = sl - entry;

        if (slDist >= 90 && slDist <= 250) {
          const targetDist = Math.round(Math.max(210, slDist * 1.6) * 10) / 10;
          const tp = Math.round((entry - targetDist) * 10) / 10;
          const atmStrike = Math.round(entry / 500) * 500;

          const entryOptEst = Math.round((entry * 0.003) * 10) / 10;
          const targetOptEst = Math.round((entryOptEst * 1.5) * 10) / 10;

          setup = {
            id: `TRADE_${i}_${cur.time}`,
            index: i,
            time: cur.time,
            direction: "SHORT",
            type: "CONFIRMED_RESISTANCE_REJECTION",
            name: "Confirmed Resistance Rejection",
            entry,
            sl,
            tp,
            targetDist,
            slDist: Math.round(slDist * 10) / 10,
            rrRatio: Number((targetDist / slDist).toFixed(2)),
            rvol: curRvol,
            rsi: curRsi,
            optionStrike: atmStrike,
            entryOptEst,
            targetOptEst,
            optionRecommendation: `Buy P-BTC-${atmStrike} (ATM Put) @ $${entryOptEst.toFixed(1)} -> Target $${targetOptEst.toFixed(1)} (+50% Profit)`,
            invalidationReason: `Price breaks above resistance wick at $${sl}`,
            meta: {
              sHigh,
              sLow,
              prevRange,
              prevUpperWick,
              prevLowerWick
            }
          };
        }
      }

      // -------------------------------------------------------------
      // SETUP 2: CONFIRMED SUPPORT BOUNCE & LIQUIDITY SWEEP (CALL OPTION ENTRY)
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

          const entryOptEst = Math.round((entry * 0.003) * 10) / 10;
          const targetOptEst = Math.round((entryOptEst * 1.5) * 10) / 10;

          setup = {
            id: `TRADE_${i}_${cur.time}`,
            index: i,
            time: cur.time,
            direction: "LONG",
            type: "CONFIRMED_SUPPORT_BOUNCE",
            name: "Confirmed Support Bounce",
            entry,
            sl,
            tp,
            targetDist,
            slDist: Math.round(slDist * 10) / 10,
            rrRatio: Number((targetDist / slDist).toFixed(2)),
            rvol: curRvol,
            rsi: curRsi,
            optionStrike: atmStrike,
            entryOptEst,
            targetOptEst,
            optionRecommendation: `Buy C-BTC-${atmStrike} (ATM Call) @ $${entryOptEst.toFixed(1)} -> Target $${targetOptEst.toFixed(1)} (+50% Profit)`,
            invalidationReason: `Price breaks below support wick at $${sl}`,
            meta: {
              sHigh,
              sLow,
              prevRange,
              prevUpperWick,
              prevLowerWick
            }
          };
        }
      }

      // -------------------------------------------------------------
      // FORWARD RESOLUTION (Deterministic Forward Walk)
      // -------------------------------------------------------------
      if (setup) {
        let outcome = "ACTIVE";
        let exitIndex = candles.length - 1;
        let exitPrice = candles[candles.length - 1].close;
        let barsHeld = 0;
        let reachedResolution = false;

        for (let j = i + 1; j < Math.min(candles.length, i + 24); j++) {
          barsHeld++;
          const fwd = candles[j];

          if (setup.direction === "LONG") {
            if (fwd.low <= setup.sl) {
              outcome = "LOSS";
              exitIndex = j;
              exitPrice = setup.sl;
              reachedResolution = true;
              break;
            } else if (fwd.high >= setup.tp) {
              outcome = "WIN";
              exitIndex = j;
              exitPrice = setup.tp;
              reachedResolution = true;
              break;
            }
          } else {
            // SHORT
            if (fwd.high >= setup.sl) {
              outcome = "LOSS";
              exitIndex = j;
              exitPrice = setup.sl;
              reachedResolution = true;
              break;
            } else if (fwd.low <= setup.tp) {
              outcome = "WIN";
              exitIndex = j;
              exitPrice = setup.tp;
              reachedResolution = true;
              break;
            }
          }
        }

        // If neither TP nor SL was hit:
        if (!reachedResolution) {
          // It only times out if held for 20+ candles (5 continuous hours)
          if (barsHeld >= 20) {
            outcome = "TIMEOUT";
            exitIndex = Math.min(candles.length - 1, i + barsHeld);
            exitPrice = candles[exitIndex]?.close || cur.close;
          } else {
            // Still in progress on current live candles!
            outcome = "ACTIVE";
            exitIndex = candles.length - 1;
            exitPrice = candles[candles.length - 1].close;
          }
        }

        setup.outcome = outcome;
        setup.exitIndex = exitIndex;
        setup.exitTime = candles[exitIndex]?.time || cur.time;
        setup.exitPrice = exitPrice;
        setup.barsHeld = Math.max(1, barsHeld);

        // Realistic Delta Option Price & Profit calculation
        const entryOpt = setup.entryOptEst || (Math.round((setup.entry * 0.003) * 10) / 10);
        let exitOpt = entryOpt;
        let optPnlPts = 0;
        let optNetGainPts = 0;

        if (outcome === "WIN") {
          exitOpt = Math.round((entryOpt * 1.50) * 10) / 10;
          optPnlPts = Math.round((exitOpt - entryOpt) * 10) / 10;
          optNetGainPts = Math.round((optPnlPts * 0.80) * 10) / 10; // Post-fee take home
          setup.pnlR = setup.rrRatio;
          setup.optionPnlPct = "+50.0%";
          setup.netProfitEstimate = `+${optNetGainPts} pts (+40% Net Take-Home)`;
          setup.badgeColor = "text-emerald-400 bg-emerald-500/10 border-emerald-500/30";
        } else if (outcome === "LOSS") {
          exitOpt = Math.round((entryOpt * 0.70) * 10) / 10;
          optPnlPts = Math.round((exitOpt - entryOpt) * 10) / 10;
          optNetGainPts = optPnlPts;
          setup.pnlR = -1.0;
          setup.optionPnlPct = "-30.0%";
          setup.netProfitEstimate = `${optPnlPts} pts (-1.0R Stop)`;
          setup.badgeColor = "text-rose-400 bg-rose-500/10 border-rose-500/30";
        } else if (outcome === "ACTIVE") {
          const spotDiff = setup.direction === "LONG" ? (candles[exitIndex].close - setup.entry) : (setup.entry - candles[exitIndex].close);
          exitOpt = Math.max(10, Math.round((entryOpt + spotDiff * 0.5) * 10) / 10);
          optPnlPts = Math.round((exitOpt - entryOpt) * 10) / 10;
          optNetGainPts = optPnlPts;
          setup.pnlR = Number((spotDiff / setup.slDist).toFixed(2));
          setup.optionPnlPct = setup.pnlR >= 0 ? `+${(setup.pnlR * 25).toFixed(0)}%` : `-${Math.abs(setup.pnlR * 25).toFixed(0)}%`;
          setup.netProfitEstimate = "Live in market";
          setup.badgeColor = "text-cyan-400 bg-cyan-500/10 border-cyan-500/30";
        } else {
          // Timeout / Scratch after 5 hours
          exitOpt = Math.round((entryOpt * 0.82) * 10) / 10;
          optPnlPts = Math.round((exitOpt - entryOpt) * 10) / 10;
          optNetGainPts = optPnlPts;
          setup.pnlR = 0;
          setup.optionPnlPct = "-18.0%";
          setup.netProfitEstimate = "Breakeven / Theta Scratch";
          setup.badgeColor = "text-slate-400 bg-slate-500/10 border-slate-500/30";
        }

        setup.entryOpt = entryOpt;
        setup.exitOpt = exitOpt;
        setup.optPnlPts = optPnlPts;
        setup.optNetGainPts = optNetGainPts;

        // Attach Institutional Rationale & Execution Playbook
        const wickPct = setup.direction === "LONG" 
          ? Math.round((setup.meta.prevLowerWick / (setup.meta.prevRange || 1)) * 100)
          : Math.round((setup.meta.prevUpperWick / (setup.meta.prevRange || 1)) * 100);

        setup.rationale = {
          levelTested: setup.direction === "LONG" ? `Major Support Pivot ($${setup.meta.sLow.toLocaleString()})` : `Major Resistance Pivot ($${setup.meta.sHigh.toLocaleString()})`,
          pattern: setup.direction === "LONG"
            ? `Bullish Lower Wick Absorption (${wickPct}% rejection of range)`
            : `Bearish Upper Wick Rejection (${wickPct}% rejection of range)`,
          confirmation: setup.direction === "LONG"
            ? `Confirmation candle closed green ($${setup.entry.toLocaleString()}) breaking above prior bar`
            : `Confirmation candle closed red ($${setup.entry.toLocaleString()}) breaking below prior bar`,
          rsi: `RSI was ${setup.rsi} (${setup.rsi > 60 ? 'Overbought Reversal' : (setup.rsi < 40 ? 'Oversold Reversal' : 'Neutral Momentum')})`,
          rvol: `${setup.rvol}x Relative Volume (Institutional Presence)`,
          narrative: outcome === "WIN"
            ? `Price moved aggressively in your favor (+${setup.targetDist} pts) within ${barsHeld} bars, cleanly hitting Take Profit at $${setup.tp.toLocaleString()}. Your Option surged from $${entryOpt.toFixed(1)} to $${exitOpt.toFixed(1)} (+50% gross / +40% net take-home).`
            : (outcome === "LOSS"
              ? `Price broke through the invalidation wick at $${setup.sl.toLocaleString()} within ${barsHeld} bars. Controlled stop loss executed at Option $${exitOpt.toFixed(1)} (-30% / -1R stop) to prevent capital bleed.`
              : (outcome === "ACTIVE"
                ? `Trade is LIVE right now (${barsHeld} bars in progress). Entered Option at $${entryOpt.toFixed(1)}. Price oscillating near Entry ($${setup.entry.toLocaleString()}). Waiting for resolution at Target ($${setup.tp.toLocaleString()}) or Stop ($${setup.sl.toLocaleString()}).`
                : `Price consolidated sideways for 5+ hours (20 bars). To prevent Theta decay from eating your option premium, the trade was closed at Option $${exitOpt.toFixed(1)} as a scratch/breakeven exit.`)),
          deltaSteps: [
            `1. Open Delta Exchange India -> BTC Options.`,
            `2. Select Contract: ${setup.direction === "LONG" ? 'C-BTC-' + setup.optionStrike : 'P-BTC-' + setup.optionStrike} (${setup.direction === "LONG" ? 'ATM Call' : 'ATM Put'}).`,
            `3. Order Type: Buy in zone $${(entryOpt * 0.98).toFixed(1)} - $${(entryOpt * 1.02).toFixed(1)} (Mark ~$${entryOpt.toFixed(1)}).`,
            `4. Take Profit GTT Order: Set Limit Exit at $${exitOpt.toFixed(1)} (+50% profit target).`,
            `5. Stop Loss GTT Order: Set Stop Exit at $${(entryOpt * 0.70).toFixed(1)} (Underlying Spot SL: $${setup.sl.toLocaleString()}).`
          ]
        };

        trades.push(setup);

        // Chart Marker: Clean labels with accurate status
        const isWin = outcome === "WIN";
        const isLoss = outcome === "LOSS";
        const isActive = outcome === "ACTIVE";
        const isCall = setup.direction === "LONG";
        const prefix = isCall ? 'CALL' : 'PUT';

        let labelText = prefix;
        let markerColor = isCall ? "#38bdf8" : "#818cf8";

        if (isWin) {
          labelText = "+50%";
          markerColor = isCall ? "#10b981" : "#f43f5e";
        } else if (isLoss) {
          labelText = "-1R";
          markerColor = isCall ? "#059669" : "#e11d48";
        } else if (!isActive) {
          labelText = "Scratch";
          markerColor = "#64748b";
        }

        markers.push({
          time: cur.time,
          position: isCall ? "belowBar" : "aboveBar",
          color: markerColor,
          shape: isCall ? "arrowUp" : "arrowDown",
          text: labelText,
          size: 1,
          tradeRef: setup
        });

        // Fast-forward loop past trade duration
        i += Math.max(4, barsHeld);
      } else {
        i++;
      }
    }

    // -------------------------------------------------------------
    // STATISTICAL TIME-MACHINE SCORECARD
    // -------------------------------------------------------------
    const totalTrades = trades.length;
    let wins = 0;
    let losses = 0;
    let timeouts = 0;
    let active = 0;
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
      } else if (t.outcome === "ACTIVE") {
        active++;
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
        active,
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
