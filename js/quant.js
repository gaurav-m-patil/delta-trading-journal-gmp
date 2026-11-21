/**
 * Delta Trading Journal - Quantitative Analytics & Leak Detection Engine
 * Computes deterministic mathematical metrics: Expectancy, R:R, Theta Trap Hold Durations,
 * Fee Drag Ratios, and Smart Money Concepts (SMC) Strategy Edge Attribution.
 */

window.DeltaQuant = (function() {

  /**
   * Calculates foundational quantitative trading metrics across a set of trades
   */
  function calculateMetrics(trades) {
    if (!trades || trades.length === 0) {
      return {
        tradeCount: 0,
        winCount: 0,
        lossCount: 0,
        beCount: 0,
        winRate: 0,
        lossRate: 0,
        grossPnl: 0,
        netPnl: 0,
        totalFee: 0,
        baseBrokerage: 0,
        gst: 0,
        avgWin: 0,
        avgLoss: 0,
        maxWin: 0,
        maxLoss: 0,
        realizedRR: 0,
        profitFactor: 0,
        expectancy: 0,
        feeDragPct: 0
      };
    }

    let grossCents = 0;
    let netCents = 0;
    let totalFeeCents = 0;
    let baseBrokerageCents = 0;
    let gstCents = 0;

    let wins = [];
    let losses = [];
    let beCount = 0;

    trades.forEach(t => {
      grossCents += Math.round((t.gross_pnl || 0) * 100);
      netCents += Math.round((t.net_pnl || 0) * 100);
      totalFeeCents += Math.round((t.total_fee || 0) * 100);
      baseBrokerageCents += Math.round((t.base_brokerage || 0) * 100);
      gstCents += Math.round((t.gst || 0) * 100);

      const netPnlVal = t.net_pnl || 0;
      if (netPnlVal > 0.0001) wins.push(netPnlVal);
      else if (netPnlVal < -0.0001) losses.push(Math.abs(netPnlVal));
      else beCount++;
    });

    const grossPnl = grossCents / 100;
    const netPnl = netCents / 100;
    const totalFee = totalFeeCents / 100;
    const baseBrokerage = baseBrokerageCents / 100;
    const gst = gstCents / 100;

    const tradeCount = trades.length;
    const winCount = wins.length;
    const lossCount = losses.length;
    const winRate = tradeCount > 0 ? (winCount / tradeCount) * 100 : 0;
    const lossRate = tradeCount > 0 ? (lossCount / tradeCount) * 100 : 0;

    const totalWinVal = wins.reduce((a, b) => a + b, 0);
    const totalLossVal = losses.reduce((a, b) => a + b, 0);

    const avgWin = winCount > 0 ? totalWinVal / winCount : 0;
    const avgLoss = lossCount > 0 ? totalLossVal / lossCount : 0;
    const maxWin = wins.length > 0 ? Math.max(...wins) : 0;
    const maxLoss = losses.length > 0 ? Math.max(...losses) : 0;

    // Realized Risk-to-Reward: Average Win / Average Loss
    const realizedRR = avgLoss > 0 ? avgWin / avgLoss : (avgWin > 0 ? 99 : 0);

    // Profit Factor: Total Gross Wins / Total Gross Losses
    const profitFactor = totalLossVal > 0 ? totalWinVal / totalLossVal : (totalWinVal > 0 ? 99 : 0);

    // Mathematical Expectancy per trade: (P_win * AvgWin) - (P_loss * AvgLoss)
    const pWin = winCount / (tradeCount || 1);
    const pLoss = lossCount / (tradeCount || 1);
    const expectancy = (pWin * avgWin) - (pLoss * avgLoss);

    // Fee Drag Ratio: Total Fees / Gross Realized Profits
    const grossWinsTotal = trades.filter(t => t.gross_pnl > 0).reduce((a, t) => a + t.gross_pnl, 0);
    const feeDragPct = grossWinsTotal > 0 ? (totalFee / grossWinsTotal) * 100 : 0;

    return {
      tradeCount,
      winCount,
      lossCount,
      beCount,
      winRate: Math.round(winRate),
      lossRate: Math.round(lossRate),
      grossPnl: Number(grossPnl.toFixed(2)),
      netPnl: Number(netPnl.toFixed(2)),
      totalFee: Number(totalFee.toFixed(2)),
      baseBrokerage: Number(baseBrokerage.toFixed(2)),
      gst: Number(gst.toFixed(2)),
      avgWin: Number(avgWin.toFixed(2)),
      avgLoss: Number(avgLoss.toFixed(2)),
      maxWin: Number(maxWin.toFixed(2)),
      maxLoss: Number(maxLoss.toFixed(2)),
      realizedRR: Number(realizedRR.toFixed(2)),
      profitFactor: Number(profitFactor.toFixed(2)),
      expectancy: Number(expectancy.toFixed(2)),
      feeDragPct: Number(feeDragPct.toFixed(1))
    };
  }

  /**
   * The "Theta Trap" & Behavioral Hold Duration Leak Detector
   * Evaluates if the trader cuts winners too fast while letting losing options decay to zero.
   */
  function detectThetaLeaks(trades) {
    if (!trades || trades.length === 0) {
      return {
        avgWinHoldSec: 0,
        avgLossHoldSec: 0,
        holdRatio: 0,
        isAsymmetricLeak: false,
        terminalLossCount: 0,
        terminalLossPct: 0,
        thetaSeverity: "LOW",
        diagnosis: "No closed trades available for hold duration analysis."
      };
    }

    const winHolds = [];
    const lossHolds = [];
    let terminalLossCount = 0; // Trades with > 80% loss of entry value

    trades.forEach(t => {
      const dur = t.holdDurationSec || 0;
      if (t.net_pnl > 0) {
        winHolds.push(dur);
      } else if (t.net_pnl < 0) {
        lossHolds.push(dur);
        // Check for near-total loss of option premium
        if (t.avgEntry > 0 && t.avgExit >= 0) {
          const drop = (t.avgEntry - t.avgExit) / t.avgEntry;
          if (drop >= 0.8) terminalLossCount++;
        }
      }
    });

    const avgWinHoldSec = winHolds.length ? winHolds.reduce((a, b) => a + b, 0) / winHolds.length : 0;
    const avgLossHoldSec = lossHolds.length ? lossHolds.reduce((a, b) => a + b, 0) / lossHolds.length : 0;

    // Hold Ratio: How much longer losers are held compared to winners
    const holdRatio = avgWinHoldSec > 0 ? avgLossHoldSec / avgWinHoldSec : 0;
    const terminalLossPct = lossHolds.length > 0 ? (terminalLossCount / lossHolds.length) * 100 : 0;

    let thetaSeverity = "NORMAL";
    let isAsymmetricLeak = false;
    let diagnosis = "Your trade durations are balanced. You are not holding losers excessively.";

    if (holdRatio >= 2.5 || (lossHolds.length >= 3 && avgLossHoldSec > 3600 && avgWinHoldSec < 900)) {
      isAsymmetricLeak = true;
      thetaSeverity = holdRatio >= 4.0 ? "CRITICAL" : "HIGH";
      diagnosis = `Severe Theta Decay Trap: You hold losing options ${holdRatio.toFixed(1)}x longer than winning trades. Average losing hold is ${formatDuration(avgLossHoldSec)} vs winning hold of ${formatDuration(avgWinHoldSec)}. Letting theta decay compound losses is destroying your capital.`;
    } else if (terminalLossPct >= 40) {
      thetaSeverity = "HIGH";
      isAsymmetricLeak = true;
      diagnosis = `Terminal Loss Leak: ${Math.round(terminalLossPct)}% of your losing options suffered >80% premium erosion before you exited. Implement hard stop-loss exits to preserve trading margin.`;
    }

    return {
      avgWinHoldSec: Math.round(avgWinHoldSec),
      avgLossHoldSec: Math.round(avgLossHoldSec),
      avgWinHoldFormatted: formatDuration(avgWinHoldSec),
      avgLossHoldFormatted: formatDuration(avgLossHoldSec),
      holdRatio: Number(holdRatio.toFixed(2)),
      isAsymmetricLeak,
      terminalLossCount,
      terminalLossPct: Math.round(terminalLossPct),
      thetaSeverity,
      diagnosis
    };
  }

  /**
   * Smart Money Concepts (SMC) Strategy Attribution Matrix
   * Cross-references user tags against Win Rate, Profit Factor, Net PnL, and Expectancy.
   */
  function calculateStrategyAttribution(trades) {
    const tagMap = {};

    trades.forEach(t => {
      const tags = (t.tags && t.tags.length > 0) ? t.tags : ["Untagged / Discretionary"];

      tags.forEach(tag => {
        if (!tagMap[tag]) {
          tagMap[tag] = {
            tag,
            trades: 0,
            wins: 0,
            losses: 0,
            grossPnl: 0,
            netPnl: 0,
            totalFee: 0,
            winList: [],
            lossList: []
          };
        }

        const item = tagMap[tag];
        item.trades += 1;
        item.grossPnl += t.gross_pnl || 0;
        item.netPnl += t.net_pnl || 0;
        item.totalFee += t.total_fee || 0;

        if (t.net_pnl > 0.0001) {
          item.wins += 1;
          item.winList.push(t.net_pnl);
        } else if (t.net_pnl < -0.0001) {
          item.losses += 1;
          item.lossList.push(Math.abs(t.net_pnl));
        }
      });
    });

    const strategies = Object.values(tagMap).map(item => {
      const winRate = item.trades > 0 ? (item.wins / item.trades) * 100 : 0;
      const totalWinVal = item.winList.reduce((a, b) => a + b, 0);
      const totalLossVal = item.lossList.reduce((a, b) => a + b, 0);
      const avgWin = item.wins > 0 ? totalWinVal / item.wins : 0;
      const avgLoss = item.losses > 0 ? totalLossVal / item.losses : 0;
      const profitFactor = totalLossVal > 0 ? totalWinVal / totalLossVal : (totalWinVal > 0 ? 99 : 0);

      const pWin = item.wins / (item.trades || 1);
      const pLoss = item.losses / (item.trades || 1);
      const expectancy = (pWin * avgWin) - (pLoss * avgLoss);

      // Classification: Alpha vs Leak
      let tier = "NEUTRAL";
      if (item.netPnl > 0 && winRate >= 50 && profitFactor >= 1.5) {
        tier = "ALPHA"; // Edge setup
      } else if (item.netPnl < 0 || winRate < 40 || profitFactor < 0.8) {
        tier = "LEAK"; // Capital bleed
      }

      return {
        tag: item.tag,
        trades: item.trades,
        wins: item.wins,
        losses: item.losses,
        winRate: Math.round(winRate),
        netPnl: Number(item.netPnl.toFixed(2)),
        grossPnl: Number(item.grossPnl.toFixed(2)),
        totalFee: Number(item.totalFee.toFixed(2)),
        profitFactor: Number(profitFactor.toFixed(2)),
        avgWin: Number(avgWin.toFixed(2)),
        avgLoss: Number(avgLoss.toFixed(2)),
        expectancy: Number(expectancy.toFixed(2)),
        tier
      };
    });

    // Sort by Net PnL descending
    return strategies.sort((a, b) => b.netPnl - a.netPnl);
  }

  /**
   * Compiles the comprehensive Quantitative Diagnostic Dossier
   * This structured object powers the Tab 3 visual cards and feeds Gemini LLM.
   */
  function generateQuantDossier(trades, timeframeLabel = "Selected Timeframe") {
    const metrics = calculateMetrics(trades);
    const thetaAnalysis = detectThetaLeaks(trades);
    const strategyMatrix = calculateStrategyAttribution(trades);

    const alphaSetups = strategyMatrix.filter(s => s.tier === "ALPHA");
    const bleedingSetups = strategyMatrix.filter(s => s.tier === "LEAK" && s.trades >= 2);

    return {
      timeframe: timeframeLabel,
      metrics,
      thetaAnalysis,
      strategyMatrix,
      alphaSetups,
      bleedingSetups,
      generatedAt: new Date().toISOString()
    };
  }

  function formatDuration(sec) {
    if (!sec || isNaN(sec) || sec <= 0) return "< 1 min";
    const minutes = Math.floor(sec / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (days > 0) return `${days}d ${hours % 24}h`;
    if (hours > 0) return `${hours}h ${minutes % 60}m`;
    return `${minutes} min`;
  }

  return {
    calculateMetrics,
    detectThetaLeaks,
    calculateStrategyAttribution,
    generateQuantDossier,
    formatDuration
  };
})();
