/**
 * Delta Trading Journal - Algorithmic SMC Strategy & Quant Backtester Engine
 * Inspired by Jake Schincariol's Day Trader Skill (trader-entry / trader-exit / trader-timemachine)
 * Tailored specifically for Bitcoin (BTC/USD) and Delta Exchange Options.
 *
 * Runs 100% locally in-browser: ZERO API costs, ZERO Firebase reads/writes.
 */

window.DeltaSMCStrategy = (function() {

  /**
   * Identifies Smart Money Concepts (SMC) Setups and Backtests them across historical bars
   * @param {Array} candles - Array of { time, open, high, low, close, volume }
   * @param {Object} options - Strategy tuning parameters
   */
  function runBacktest(candles, options = {}) {
    if (!candles || candles.length < 30) {
      return {
        trades: [],
        markers: [],
        activeSignal: null,
        stats: {
          totalTrades: 0,
          winRate: 0,
          profitFactor: 0,
          maxDrawdownPct: 0,
          expectancyR: 0,
          avgRR: 0,
          longWins: 0,
          shortWins: 0
        }
      };
    }

    const lookback = options.lookback || 15;
    const rvolThreshold = options.rvolThreshold || 1.35;
    const targetRR = options.targetRR || 2.0; // 2R default target

    const trades = [];
    const markers = [];
    let activeSignal = null;

    // Calculate 20-period Simple Moving Average of Volume for RVOL
    const volumes = candles.map(c => c.volume);
    const rvol = [];
    for (let i = 0; i < candles.length; i++) {
      if (i < 20) {
        rvol.push(1.0);
      } else {
        const sumVol = volumes.slice(i - 20, i).reduce((a, b) => a + b, 0);
        const avgVol = sumVol / 20;
        rvol.push(avgVol > 0 ? volumes[i] / avgVol : 1.0);
      }
    }

    // Scan bars (leaving 20 bars buffer for forward backtest resolution)
    const scanLimit = candles.length - 1;

    for (let i = lookback; i < scanLimit; i++) {
      const cur = candles[i];
      const prev = candles[i - 1];
      const curRvol = rvol[i];

      // Local swing high & low over lookback window (excluding current bar)
      const windowCandles = candles.slice(i - lookback, i);
      const swingHigh = Math.max(...windowCandles.map(c => c.high));
      const swingLow = Math.min(...windowCandles.map(c => c.low));

      let setup = null;

      // -------------------------------------------------------------
      // SETUP 1: LIQUIDITY SWEEP & RECLAIM (Judas Swing / Session Sweep)
      // -------------------------------------------------------------
      // Bearish Sweep: High breached swing high, but close ended back below with high volume
      if (cur.high > swingHigh && cur.close < swingHigh && cur.close < cur.open && curRvol >= rvolThreshold) {
        const entryPrice = cur.close;
        const stopLoss = cur.high + (cur.high - cur.low) * 0.15; // Invalidation at sweep wick
        const risk = stopLoss - entryPrice;
        if (risk > 0) {
          const target = entryPrice - (risk * targetRR);
          setup = {
            index: i,
            time: cur.time,
            type: "BEARISH_SWEEP",
            direction: "SHORT",
            name: "Liquidity Sweep (Bearish)",
            entryPrice,
            stopLoss,
            target,
            risk,
            rvol: curRvol
          };
        }
      }
      // Bullish Sweep: Low breached swing low, but close ended back above with high volume
      else if (cur.low < swingLow && cur.close > swingLow && cur.close > cur.open && curRvol >= rvolThreshold) {
        const entryPrice = cur.close;
        const stopLoss = cur.low - (cur.high - cur.low) * 0.15; // Invalidation at sweep wick
        const risk = entryPrice - stopLoss;
        if (risk > 0) {
          const target = entryPrice + (risk * targetRR);
          setup = {
            index: i,
            time: cur.time,
            type: "BULLISH_SWEEP",
            direction: "LONG",
            name: "Liquidity Sweep (Bullish)",
            entryPrice,
            stopLoss,
            target,
            risk,
            rvol: curRvol
          };
        }
      }

      // -------------------------------------------------------------
      // SETUP 2: 3-BAR FAIR VALUE GAP (FVG) MITIGATION DISPLACEMENT
      // -------------------------------------------------------------
      if (!setup && i >= 3) {
        const c1 = candles[i - 2];
        const c2 = candles[i - 1]; // Displacement candle
        const c3 = cur;

        // Bullish FVG: Low of c3 > High of c1 (Gap between c1 and c3)
        if (c2.close > c2.open && c3.low > c1.high && (c3.low - c1.high) > (cur.close * 0.001)) {
          const entryPrice = cur.close;
          const stopLoss = c2.low;
          const risk = entryPrice - stopLoss;
          if (risk > 0) {
            setup = {
              index: i,
              time: cur.time,
              type: "BULLISH_FVG",
              direction: "LONG",
              name: "15m FVG Displacement",
              entryPrice,
              stopLoss,
              target: entryPrice + (risk * targetRR),
              risk,
              rvol: curRvol
            };
          }
        }
        // Bearish FVG: High of c3 < Low of c1
        else if (c2.close < c2.open && c3.high < c1.low && (c1.low - c3.high) > (cur.close * 0.001)) {
          const entryPrice = cur.close;
          const stopLoss = c2.high;
          const risk = stopLoss - entryPrice;
          if (risk > 0) {
            setup = {
              index: i,
              time: cur.time,
              type: "BEARISH_FVG",
              direction: "SHORT",
              name: "15m FVG Displacement",
              entryPrice,
              stopLoss,
              target: entryPrice - (risk * targetRR),
              risk,
              rvol: curRvol
            };
          }
        }
      }

      // If a setup was identified, simulate forward execution bar-by-bar (Timemachine Backtest)
      if (setup) {
        let outcome = "OPEN";
        let exitIndex = scanLimit;
        let exitPrice = cur.close;
        let pnlR = 0;
        let barsHeld = 0;

        // Walk forward to evaluate Target vs Stop Loss
        for (let j = i + 1; j < candles.length; j++) {
          const fwd = candles[j];
          barsHeld++;

          if (setup.direction === "LONG") {
            if (fwd.low <= setup.stopLoss) {
              outcome = "LOSS";
              exitIndex = j;
              exitPrice = setup.stopLoss;
              pnlR = -1.0;
              break;
            } else if (fwd.high >= setup.target) {
              outcome = "WIN";
              exitIndex = j;
              exitPrice = setup.target;
              pnlR = targetRR;
              break;
            }
          } else {
            // SHORT
            if (fwd.high >= setup.stopLoss) {
              outcome = "LOSS";
              exitIndex = j;
              exitPrice = setup.stopLoss;
              pnlR = -1.0;
              break;
            } else if (fwd.low <= setup.target) {
              outcome = "WIN";
              exitIndex = j;
              exitPrice = setup.target;
              pnlR = targetRR;
              break;
            }
          }

          // Timeout after 30 bars if neither hit (market stale)
          if (barsHeld >= 30) {
            outcome = fwd.close > setup.entryPrice ? (setup.direction === "LONG" ? "WIN" : "LOSS") : (setup.direction === "SHORT" ? "WIN" : "LOSS");
            exitIndex = j;
            exitPrice = fwd.close;
            const priceDiff = setup.direction === "LONG" ? (exitPrice - setup.entryPrice) : (setup.entryPrice - exitPrice);
            pnlR = priceDiff / setup.risk;
            break;
          }
        }

        setup.outcome = outcome;
        setup.exitIndex = exitIndex;
        setup.exitTime = candles[exitIndex]?.time || cur.time;
        setup.exitPrice = exitPrice;
        setup.pnlR = Number(pnlR.toFixed(2));
        setup.barsHeld = barsHeld;

        // Delta Options recommendation mapping
        const atmStrike = Math.round(setup.entryPrice / 500) * 500;
        if (setup.direction === "LONG") {
          setup.optionRecommendation = `Buy C-BTC-${atmStrike} (ATM Call) or Sell P-BTC-${atmStrike - 1000} (Credit Spread)`;
        } else {
          setup.optionRecommendation = `Buy P-BTC-${atmStrike} (ATM Put) or Sell C-BTC-${atmStrike + 1000} (Credit Spread)`;
        }

        trades.push(setup);

        // Add visual chart marker (Keep chart clean: only entry arrow on the trigger candle)
        const isWin = outcome === "WIN";
        markers.push({
          time: cur.time,
          position: setup.direction === "LONG" ? "belowBar" : "aboveBar",
          color: setup.direction === "LONG" ? "#10b981" : "#f43f5e",
          shape: setup.direction === "LONG" ? "arrowUp" : "arrowDown",
          text: `${setup.name.split(' ')[0]} [${isWin ? '+2R' : '-1R'}]`,
          size: 1.5,
          tradeRef: setup
        });

        // Fast-forward loop past this trade to prevent overlapping signal spam
        i += Math.min(barsHeld, 4);
      }
    }

    // -------------------------------------------------------------
    // LIVE SIGNAL DETECTOR (Latest 1-2 bars)
    // -------------------------------------------------------------
    if (candles.length > 2) {
      const latest = candles[candles.length - 1];
      const prev = candles[candles.length - 2];
      const latestRvol = rvol[candles.length - 1] || 1.0;

      const recentWindow = candles.slice(-20, -1);
      const sHigh = Math.max(...recentWindow.map(c => c.high));
      const sLow = Math.min(...recentWindow.map(c => c.low));

      if (latest.high > sHigh && latest.close < sHigh && latestRvol >= 1.3) {
        const atm = Math.round(latest.close / 500) * 500;
        const sl = latest.high * 1.002;
        const tp = latest.close - (sl - latest.close) * targetRR;
        activeSignal = {
          direction: "BEARISH PUT SETUP",
          name: "Live Asian/Session High Liquidity Sweep",
          price: latest.close,
          stopLoss: Number(sl.toFixed(1)),
          target: Number(tp.toFixed(1)),
          rvol: Number(latestRvol.toFixed(1)),
          strike: `Buy P-BTC-${atm} (ATM Put)`,
          action: "Delta Put Entry / Short Delta",
          time: latest.time
        };
      } else if (latest.low < sLow && latest.close > sLow && latestRvol >= 1.3) {
        const atm = Math.round(latest.close / 500) * 500;
        const sl = latest.low * 0.998;
        const tp = latest.close + (latest.close - sl) * targetRR;
        activeSignal = {
          direction: "BULLISH CALL SETUP",
          name: "Live Asian/Session Low Liquidity Sweep",
          price: latest.close,
          stopLoss: Number(sl.toFixed(1)),
          target: Number(tp.toFixed(1)),
          rvol: Number(latestRvol.toFixed(1)),
          strike: `Buy C-BTC-${atm} (ATM Call)`,
          action: "Delta Call Entry / Long Delta",
          time: latest.time
        };
      }
    }

    // -------------------------------------------------------------
    // STATISTICAL TIME-MACHINE AGGREGATION
    // -------------------------------------------------------------
    const totalTrades = trades.length;
    let wins = 0;
    let losses = 0;
    let longWins = 0;
    let shortWins = 0;
    let totalGrossWinsR = 0;
    let totalGrossLossesR = 0;
    let peakR = 0;
    let currentR = 0;
    let maxDrawdownR = 0;

    trades.forEach(t => {
      if (t.outcome === "WIN") {
        wins++;
        totalGrossWinsR += t.pnlR;
        if (t.direction === "LONG") longWins++;
        else shortWins++;
      } else {
        losses++;
        totalGrossLossesR += Math.abs(t.pnlR);
      }

      currentR += t.pnlR;
      if (currentR > peakR) peakR = currentR;
      const dd = peakR - currentR;
      if (dd > maxDrawdownR) maxDrawdownR = dd;
    });

    const winRate = totalTrades > 0 ? (wins / totalTrades) * 100 : 0;
    const profitFactor = totalGrossLossesR > 0 ? totalGrossWinsR / totalGrossLossesR : (totalGrossWinsR > 0 ? 99 : 0);
    const pWin = wins / (totalTrades || 1);
    const pLoss = losses / (totalTrades || 1);
    const expectancyR = (pWin * targetRR) - (pLoss * 1.0);

    return {
      trades,
      markers,
      activeSignal,
      stats: {
        totalTrades,
        wins,
        losses,
        winRate: Math.round(winRate),
        profitFactor: Number(profitFactor.toFixed(2)),
        maxDrawdownR: Number(maxDrawdownR.toFixed(1)),
        expectancyR: Number(expectancyR.toFixed(2)),
        avgRR: targetRR,
        longWins,
        shortWins
      }
    };
  }

  return {
    runBacktest
  };
})();
