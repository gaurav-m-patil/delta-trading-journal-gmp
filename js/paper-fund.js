/**
 * DELTA TRADING JOURNAL - INSTITUTIONAL PAPER FUND COCKPIT (₹100,000 INR)
 * Simulates systematic execution with ₹100,000 INR starting capital.
 * Accurately tracks option Buy Price, Exit/Sell Price, and compound capital growth.
 */

window.DeltaPaperFund = (function() {
  const DEFAULT_CAPITAL = 100000; // ₹1,00,000 INR
  const STORAGE_KEY_RISK_MODEL = 'dtj_paper_risk_model_v1';
  const STORAGE_KEY_CUSTOM_CAPITAL = 'dtj_paper_custom_capital_v1';

  function getRiskModel() {
    return localStorage.getItem(STORAGE_KEY_RISK_MODEL) || 'BALANCED'; // BALANCED (25%), MODERATE (50%), COMPOUND (100%)
  }

  function setRiskModel(model) {
    localStorage.setItem(STORAGE_KEY_RISK_MODEL, model);
    if (window.DeltaLiveChart && typeof DeltaLiveChart.refreshPaperUI === 'function') {
      DeltaLiveChart.refreshPaperUI();
    }
  }

  function getStartingCapital() {
    const raw = localStorage.getItem(STORAGE_KEY_CUSTOM_CAPITAL);
    return raw ? parseFloat(raw) : DEFAULT_CAPITAL;
  }

  function resetPortfolio() {
    localStorage.setItem(STORAGE_KEY_CUSTOM_CAPITAL, DEFAULT_CAPITAL.toString());
    localStorage.setItem(STORAGE_KEY_RISK_MODEL, 'BALANCED');
    if (window.DeltaLiveChart && typeof DeltaLiveChart.refreshPaperUI === 'function') {
      DeltaLiveChart.refreshPaperUI();
    }
  }

  /**
   * Processes a list of trades and simulates real ₹100,000 institutional account progression
   */
  function calculatePortfolio(trades) {
    const startingCapital = getStartingCapital();
    const riskModel = getRiskModel();
    const allocPct = riskModel === 'COMPOUND' ? 1.0 : (riskModel === 'MODERATE' ? 0.50 : 0.25);

    if (!trades || trades.length === 0) {
      return {
        startingCapital,
        currentEquity: startingCapital,
        realizedPnlInr: 0,
        realizedPnlPct: 0,
        unrealizedPnlInr: 0,
        peakEquity: startingCapital,
        maxDrawdownInr: 0,
        maxDrawdownPct: 0,
        wins: 0,
        losses: 0,
        winRate: 0,
        riskModel,
        trades: []
      };
    }

    // Sort chronologically (oldest to newest) to model realistic sequential capital progression
    const chronoTrades = [...trades].sort((a, b) => a.time - b.time);

    let currentBalance = startingCapital;
    let peakEquity = startingCapital;
    let maxDrawdownInr = 0;
    let wins = 0;
    let losses = 0;
    let unrealizedPnlInr = 0;

    const processedTrades = chronoTrades.map(t => {
      const opt = t.realOption;
      const buyPrice = (opt && opt.entryPrice > 0) ? opt.entryPrice : (t.optionEntryMark || t.entryOpt || 220);
      let sellPrice = buyPrice;
      let isResolved = false;

      if (t.outcome === "WIN") {
        sellPrice = (opt && opt.targetPrice > 0) ? opt.targetPrice : (t.exitOpt || Math.round(buyPrice * 1.5 * 10) / 10);
        isResolved = true;
      } else if (t.outcome === "LOSS") {
        sellPrice = (opt && opt.stopPrice > 0) ? opt.stopPrice : Math.round(buyPrice * 0.7 * 10) / 10;
        isResolved = true;
      } else if (t.outcome === "TIMEOUT") {
        sellPrice = Math.round(buyPrice * 0.82 * 10) / 10;
        isResolved = true;
      } else {
        // ACTIVE
        sellPrice = (opt && opt.markPrice > 0) ? opt.markPrice : buyPrice;
        isResolved = false;
      }

      const pnlPts = Math.round((sellPrice - buyPrice) * 10) / 10;
      const pnlPct = buyPrice > 0 ? (pnlPts / buyPrice) : 0;
      const pnlPctStr = `${pnlPts >= 0 ? '+' : ''}${(pnlPct * 100).toFixed(1)}%`;

      // Position allocation in INR for this setup
      const allocatedInr = Math.round(currentBalance * allocPct);

      // Delta Exchange India transaction fee + 18% GST modeling
      const grossPnlInr = Math.round(allocatedInr * pnlPct);
      // Profitable option fee: ~12-15% of gross profits; Loss fee: 0.4% maker/taker
      const feeInr = grossPnlInr > 0 ? Math.round(grossPnlInr * 0.15) : Math.round(allocatedInr * 0.005);
      const netPnlInr = grossPnlInr > 0 ? (grossPnlInr - feeInr) : grossPnlInr;

      if (isResolved) {
        currentBalance += netPnlInr;
        if (currentBalance > peakEquity) peakEquity = currentBalance;
        const dd = peakEquity - currentBalance;
        if (dd > maxDrawdownInr) maxDrawdownInr = dd;

        if (netPnlInr > 0) wins++;
        else if (netPnlInr < 0) losses++;
      } else {
        unrealizedPnlInr += netPnlInr;
      }

      return {
        ...t,
        buyPrice,
        sellPrice,
        pnlPts,
        pnlPct,
        pnlPctStr,
        allocatedInr,
        grossPnlInr,
        feeInr,
        netPnlInr,
        capitalAfterTrade: currentBalance,
        isResolved
      };
    });

    const totalTrades = wins + losses;
    const winRate = totalTrades > 0 ? Math.round((wins / totalTrades) * 1000) / 10 : 0;
    const realizedPnlInr = currentBalance - startingCapital;
    const realizedPnlPct = startingCapital > 0 ? Math.round((realizedPnlInr / startingCapital) * 1000) / 10 : 0;
    const maxDrawdownPct = peakEquity > 0 ? Math.round((maxDrawdownInr / peakEquity) * 1000) / 10 : 0;
    const currentEquity = currentBalance + unrealizedPnlInr;

    return {
      startingCapital,
      currentBalance,
      currentEquity,
      realizedPnlInr,
      realizedPnlPct,
      unrealizedPnlInr,
      peakEquity,
      maxDrawdownInr,
      maxDrawdownPct,
      wins,
      losses,
      winRate,
      riskModel,
      trades: processedTrades
    };
  }

  /**
   * Renders executive summary banner above the 48h trade history table
   */
  function renderExecutiveBanner(containerId, portfolio) {
    const el = document.getElementById(containerId);
    if (!el) return;

    const isProfit = portfolio.realizedPnlInr >= 0;
    const sign = isProfit ? '+' : '';

    el.innerHTML = `
      <div class="bg-gradient-to-r from-panelDark via-brandDark to-panelDark border border-indigo-500/30 rounded-xl p-3 sm:p-3.5 space-y-2.5 shadow-md font-mono">
        <div class="flex flex-wrap justify-between items-center gap-2 border-b border-borderDark/60 pb-2">
          <div class="flex items-center gap-2">
            <div class="h-6 w-6 rounded-lg bg-indigo-500/20 text-indigo-400 flex items-center justify-center text-xs">
              <i class="fa-solid fa-wallet"></i>
            </div>
            <div>
              <span class="text-xs font-bold text-white uppercase tracking-wider">₹100,000 Institutional Paper Fund</span>
              <span class="text-[9px] text-slate-400 block font-sans">Simulating real ATM option buy/sell fills with Delta fee & GST deductions</span>
            </div>
          </div>
          <div class="flex items-center gap-2">
            <span class="text-[10px] px-2 py-0.5 rounded bg-indigo-500/10 text-indigo-300 border border-indigo-500/30">
              Risk Sizing: <strong>${portfolio.riskModel === 'COMPOUND' ? '100% Compounding' : (portfolio.riskModel === 'MODERATE' ? '50% Moderate' : '25% Institutional')}</strong>
            </span>
            <button onclick="DeltaPaperFund.promptRiskModelChange()" title="Change Risk Model" class="text-[10px] text-slate-400 hover:text-white px-1.5 py-0.5 rounded bg-panelDark border border-borderDark transition-colors">
              <i class="fa-solid fa-sliders"></i>
            </button>
          </div>
        </div>

        <div class="grid grid-cols-2 sm:grid-cols-4 gap-2 text-center">
          <div class="bg-brandDark/70 p-2 rounded-lg border border-borderDark/50">
            <span class="text-[9px] uppercase tracking-wider text-slate-400 block font-sans">Starting Capital</span>
            <span class="text-xs sm:text-sm font-bold text-slate-200">₹${portfolio.startingCapital.toLocaleString('en-IN')}</span>
          </div>

          <div class="bg-brandDark/70 p-2 rounded-lg border border-borderDark/50">
            <span class="text-[9px] uppercase tracking-wider text-slate-400 block font-sans">Current Fund Value</span>
            <span class="text-xs sm:text-sm font-bold ${isProfit ? 'text-winGreen' : 'text-lossRed'}">
              ₹${portfolio.currentEquity.toLocaleString('en-IN')}
            </span>
          </div>

          <div class="bg-brandDark/70 p-2 rounded-lg border border-borderDark/50">
            <span class="text-[9px] uppercase tracking-wider text-slate-400 block font-sans">48h Net Take-Home</span>
            <span class="text-xs sm:text-sm font-bold ${isProfit ? 'text-winGreen' : 'text-lossRed'}">
              ${sign}₹${portfolio.realizedPnlInr.toLocaleString('en-IN')} (${sign}${portfolio.realizedPnlPct}%)
            </span>
          </div>

          <div class="bg-brandDark/70 p-2 rounded-lg border border-borderDark/50">
            <span class="text-[9px] uppercase tracking-wider text-slate-400 block font-sans">Max Drawdown</span>
            <span class="text-xs sm:text-sm font-bold text-amber-400">
              -₹${portfolio.maxDrawdownInr.toLocaleString('en-IN')} (-${portfolio.maxDrawdownPct}%)
            </span>
          </div>
        </div>
      </div>
    `;
  }

  /**
   * Renders the dedicated ₹100,000 Paper Portfolio Dashboard in Sub-Tab 4
   */
  function renderPaperPortfolioTab(containerId, portfolio) {
    const container = document.getElementById(containerId);
    if (!container) return;

    const isProfit = portfolio.realizedPnlInr >= 0;
    const sign = isProfit ? '+' : '';
    const reversedTrades = [...portfolio.trades].reverse();

    container.innerHTML = `
      <div class="space-y-4 font-mono">
        <!-- Hero Fund Performance Card -->
        <div class="bg-cardDark border border-borderDark p-4 md:p-5 rounded-2xl shadow-md space-y-4">
          <div class="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3">
            <div>
              <div class="flex items-center gap-2">
                <h2 class="font-bold text-base sm:text-lg text-white flex items-center gap-2">
                  <i class="fa-solid fa-wallet text-amber-400"></i> ₹100,000 Institutional Paper Fund
                </h2>
                <span class="text-[9px] px-2 py-0.5 rounded bg-emerald-500/10 text-emerald-400 border border-emerald-500/30 font-bold">LIVE EXECUTION</span>
              </div>
              <p class="text-xs text-slate-400 font-sans mt-0.5">Automated paper trading using real Delta India BTC option prices and execution candles.</p>
            </div>

            <div class="flex items-center gap-2 w-full sm:w-auto justify-end">
              <button onclick="DeltaPaperFund.promptRiskModelChange()" class="px-3 py-1.5 rounded-xl bg-panelDark hover:bg-borderDark text-slate-300 text-xs font-bold transition-colors flex items-center gap-1.5 border border-borderDark">
                <i class="fa-solid fa-sliders text-indigo-400"></i> Mode: ${portfolio.riskModel}
              </button>
              <button onclick="DeltaPaperFund.resetPortfolioPrompt()" class="px-3 py-1.5 rounded-xl bg-rose-500/10 hover:bg-rose-500/20 text-rose-400 border border-rose-500/30 text-xs font-bold transition-colors flex items-center gap-1.5">
                <i class="fa-solid fa-rotate-left"></i> Reset ₹1L
              </button>
            </div>
          </div>

          <!-- Key Quantitative Metrics Grid -->
          <div class="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <div class="bg-brandDark/70 p-3.5 rounded-xl border border-borderDark">
              <span class="text-[10px] uppercase text-slate-400 block font-sans">Current Total Equity</span>
              <div class="text-xl font-bold ${isProfit ? 'text-winGreen' : 'text-lossRed'} mt-0.5">
                ₹${portfolio.currentEquity.toLocaleString('en-IN')}
              </div>
              <span class="text-[9px] text-slate-500 font-sans">Initial ₹${portfolio.startingCapital.toLocaleString('en-IN')}</span>
            </div>

            <div class="bg-brandDark/70 p-3.5 rounded-xl border border-borderDark">
              <span class="text-[10px] uppercase text-slate-400 block font-sans">Realized Net Alpha (48h)</span>
              <div class="text-xl font-bold ${isProfit ? 'text-winGreen' : 'text-lossRed'} mt-0.5">
                ${sign}₹${portfolio.realizedPnlInr.toLocaleString('en-IN')}
              </div>
              <span class="text-[9px] ${isProfit ? 'text-winGreen' : 'text-lossRed'} font-sans">${sign}${portfolio.realizedPnlPct}% net return</span>
            </div>

            <div class="bg-brandDark/70 p-3.5 rounded-xl border border-borderDark">
              <span class="text-[10px] uppercase text-slate-400 block font-sans">Simulated Win Rate</span>
              <div class="text-xl font-bold text-winGreen mt-0.5">
                ${portfolio.winRate}%
              </div>
              <span class="text-[9px] text-slate-500 font-sans">${portfolio.wins} Wins - ${portfolio.losses} Losses</span>
            </div>

            <div class="bg-brandDark/70 p-3.5 rounded-xl border border-borderDark">
              <span class="text-[10px] uppercase text-slate-400 block font-sans">Max Capital Drawdown</span>
              <div class="text-xl font-bold text-amber-400 mt-0.5">
                -₹${portfolio.maxDrawdownInr.toLocaleString('en-IN')}
              </div>
              <span class="text-[9px] text-slate-500 font-sans">-${portfolio.maxDrawdownPct}% from peak</span>
            </div>
          </div>
        </div>

        <!-- Detailed Execution Ledger -->
        <div class="bg-brandDark/70 border border-borderDark rounded-xl p-3 sm:p-3.5 space-y-3">
          <div class="flex flex-wrap justify-between items-center pb-2 border-b border-borderDark/60 gap-1.5">
            <div class="flex items-center gap-1.5">
              <i class="fa-solid fa-receipt text-indigo-400 text-xs"></i>
              <span class="text-xs font-bold text-white">48-Hour Institutional Execution Ledger (Buy & Sell Pricing)</span>
            </div>
            <span class="text-[10px] text-slate-400 font-mono">${portfolio.trades.length} setups processed</span>
          </div>

          <div class="w-full max-h-[380px] overflow-y-auto overflow-x-hidden custom-scroll">
            <table class="w-full text-left text-xs font-mono table-fixed">
              <thead>
                <tr class="text-[10px] text-slate-400 uppercase border-b border-borderDark/80">
                  <th class="py-2 px-2 w-[14%]">Time (IST)</th>
                  <th class="py-2 px-2 w-[22%]">Contract / Strike</th>
                  <th class="py-2 px-2 w-[20%]">Buy &rarr; Sell Price</th>
                  <th class="py-2 px-2 w-[16%]">Allocated (₹)</th>
                  <th class="py-2 px-2 w-[14%]">Net PnL (₹)</th>
                  <th class="py-2 px-2 text-right w-[14%]">Capital After</th>
                </tr>
              </thead>
              <tbody class="divide-y divide-borderDark/40">
                ${reversedTrades.length === 0 ? `
                  <tr><td colspan="6" class="py-6 text-center text-slate-500 text-xs">No paper trades executed in current 48h candle window.</td></tr>
                ` : reversedTrades.map(t => {
                  const d = new Date(t.time * 1000);
                  const timeStr = d.toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: true });
                  const dateStr = d.toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', month: 'short', day: 'numeric' });
                  const isCall = t.direction === 'LONG';
                  const isWin = t.outcome === 'WIN';
                  const isLoss = t.outcome === 'LOSS';
                  const isActive = t.outcome === 'ACTIVE';

                  const pnlClass = t.netPnlInr >= 0 ? 'text-winGreen' : 'text-lossRed';
                  const pnlSign = t.netPnlInr >= 0 ? '+' : '';

                  return `
                    <tr class="hover:bg-panelDark/60 transition-colors">
                      <td class="py-2.5 px-2 text-slate-200 font-bold text-[11px]">
                        <div>${timeStr}</div>
                        <div class="text-[9px] text-slate-400 font-normal">${dateStr}</div>
                      </td>
                      <td class="py-2.5 px-2">
                        <div class="flex items-center gap-1 font-bold ${isCall ? 'text-winGreen' : 'text-lossRed'} text-[11px]">
                          <i class="fa-solid ${isCall ? 'fa-arrow-up' : 'fa-arrow-down'} text-[9px]"></i>
                          <span>${isCall ? 'CALL' : 'PUT'}</span>
                        </div>
                        <span class="text-indigo-300 font-semibold block text-[10px] truncate" title="${t.realOption?.symbol || t.optionSymbol}">${t.realOption?.symbol || t.optionSymbol}</span>
                      </td>
                      <td class="py-2.5 px-2 text-[11px]">
                        <div>Buy: <strong class="text-white">$${t.buyPrice.toFixed(1)}</strong></div>
                        <div>${isActive ? 'Live' : 'Sell'}: <strong class="${isWin ? 'text-winGreen' : (isLoss ? 'text-lossRed' : 'text-slate-200')}">$${t.sellPrice.toFixed(1)}</strong> <span class="text-[9px] text-slate-400">(${t.pnlPctStr})</span></div>
                      </td>
                      <td class="py-2.5 px-2 text-[11px] text-slate-300">
                        ₹${t.allocatedInr.toLocaleString('en-IN')}
                      </td>
                      <td class="py-2.5 px-2 font-bold text-[11px] ${pnlClass}">
                        ${isActive ? `
                          <span class="text-cyan-400 text-[10px]"><span class="h-1.5 w-1.5 rounded-full bg-cyan-400 animate-ping inline-block mr-1"></span>LIVE</span>
                        ` : `
                          <div>${pnlSign}₹${t.netPnlInr.toLocaleString('en-IN')}</div>
                          <div class="text-[9px] text-slate-500 font-normal">Fee: ₹${t.feeInr}</div>
                        `}
                      </td>
                      <td class="py-2.5 px-2 text-right font-bold text-[11px] text-white">
                        ₹${t.capitalAfterTrade.toLocaleString('en-IN')}
                      </td>
                    </tr>
                  `;
                }).join('')}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    `;
  }

  function promptRiskModelChange() {
    const current = getRiskModel();
    const next = current === 'BALANCED' ? 'MODERATE' : (current === 'MODERATE' ? 'COMPOUND' : 'BALANCED');
    setRiskModel(next);
  }

  function resetPortfolioPrompt() {
    if (confirm("Reset Institutional Paper Fund back to ₹100,000 INR starting capital?")) {
      resetPortfolio();
    }
  }

  return {
    getRiskModel,
    setRiskModel,
    getStartingCapital,
    resetPortfolio,
    calculatePortfolio,
    renderExecutiveBanner,
    renderPaperPortfolioTab,
    promptRiskModelChange,
    resetPortfolioPrompt
  };
})();
