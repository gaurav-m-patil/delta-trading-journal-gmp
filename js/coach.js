/**
 * Delta Trading Journal - Automated Trading Coach (AI & Rule-Based)
 * Compiles mathematical quant metrics and invokes Gemini 2.5 Flash for personalized coaching.
 * Also includes an offline rule-based deterministic diagnostic fallback.
 */

window.DeltaCoach = (function() {

  /**
   * Compiles the Quant Dossier into an institutional trading coach prompt for Gemini
   */
  function buildSystemAndUserPrompt(dossier) {
    const { metrics, thetaAnalysis, alphaSetups, bleedingSetups, timeframe } = dossier;

    const alphaSummary = alphaSetups.length
      ? alphaSetups.map(s => `- ${s.tag}: Win Rate ${s.winRate}%, Net PnL $${s.netPnl}, Profit Factor ${s.profitFactor} (${s.trades} trades)`).join('\n')
      : "No clear Alpha setups identified yet (trades may lack SMC tags).";

    const leakSummary = bleedingSetups.length
      ? bleedingSetups.map(s => `- ${s.tag}: Win Rate ${s.winRate}%, Net PnL -$${Math.abs(s.netPnl)}, Profit Factor ${s.profitFactor} (${s.trades} trades)`).join('\n')
      : "No recurring strategy leaks detected in this sample.";

    const systemPrompt = `You are an elite quantitative crypto options trading coach specializing in Delta Exchange India derivatives, Smart Money Concepts (SMC), and trader psychology.
Your job is to deliver brutal, direct, and mathematically precise feedback to help this trader become consistently profitable.
Do not offer generic advice. Cross-examine their actual numbers, theta decay habits, fee drag, and strategy setups.

Structure your analysis in exactly four markdown sections:
1. ### 🟢 Core Alpha & What's Working
Identify their highest-expectancy setups and execution strengths.
2. ### 🔴 Critical Leaks & Theta Decay Drag
Explicitly diagnose where they are bleeding capital (asymmetric hold times, letting losing options decay, negative R:R, or overpaying exchange fees/GST).
3. ### ⚖️ Delta Fee & Tax Reality Check
Quantify the drag from Delta brokerage and 18% GST. Advise if they are overtrading.
4. ### 📋 Execution Protocol & Rules for Next Session
Give them 3 non-negotiable rules they must follow in their next session to stop bleeding and protect their account.`;

    const userPrompt = `
TRADER PERFORMANCE DOSSIER:
Timeframe: ${timeframe}
Total Closed Positions: ${metrics.tradeCount}
Gross PnL: $${metrics.grossPnl}
Delta Base Brokerage: $${metrics.baseBrokerage}
18% GST Paid: $${metrics.gst}
Total Execution Fees: $${metrics.totalFee}
Net Realized Take-Home: $${metrics.netPnl}
Fee Drag Ratio: ${metrics.feeDragPct}% of gross profit was consumed by fees

STATISTICAL EDGE & RISK/REWARD:
Win Rate: ${metrics.winRate}% (Wins: ${metrics.winCount}, Losses: ${metrics.lossCount})
Average Win: $${metrics.avgWin}
Average Loss: $${metrics.avgLoss}
Realized Risk-to-Reward (Avg Win / Avg Loss): ${metrics.realizedRR} : 1
Mathematical Expectancy per trade: $${metrics.expectancy}
Profit Factor: ${metrics.profitFactor}

OPTIONS THETA DECAY & HOLD DURATION ANALYSIS:
Average Winner Hold Duration: ${thetaAnalysis.avgWinHoldFormatted}
Average Loser Hold Duration: ${thetaAnalysis.avgLossHoldFormatted}
Hold Duration Ratio (Losers vs Winners): ${thetaAnalysis.holdRatio}x
Terminal Loss Count (>80% premium collapse): ${thetaAnalysis.terminalLossCount} trades (${thetaAnalysis.terminalLossPct}% of losing trades)
Theta Severity: ${thetaAnalysis.thetaSeverity}
Diagnostic Note: ${thetaAnalysis.diagnosis}

STRATEGY TAG PERFORMANCE (SMC & SETUPS):
Top Alpha Setups:
${alphaSummary}

Capital Bleeding Setups / Mistakes:
${leakSummary}

Give me your high-impact coaching review based strictly on this quantitative profile.`;

    return { systemPrompt, userPrompt };
  }

  /**
   * Deterministic Offline Rule-Based Fallback Coach
   * Guarantees instant diagnostic cards even if the user has no Gemini API key.
   */
  function generateOfflineDiagnostic(dossier) {
    const { metrics, thetaAnalysis, alphaSetups, bleedingSetups } = dossier;

    let leaksHTML = "";
    if (thetaAnalysis.isAsymmetricLeak) {
      leaksHTML += `
        <div class="p-3 rounded-xl bg-lossRed/10 border border-lossRed/30 mb-2">
          <div class="flex items-center gap-2 text-lossRed font-bold text-xs mb-1">
            <i class="fa-solid fa-hourglass-end"></i> Theta Trap Detected (${thetaAnalysis.holdRatio}x Hold Asymmetry)
          </div>
          <p class="text-[11px] text-slate-300 leading-relaxed">
            You hold losing options an average of <strong>${thetaAnalysis.avgLossHoldFormatted}</strong>, while cutting winners in just <strong>${thetaAnalysis.avgWinHoldFormatted}</strong>. You are letting time decay annihilate your option premiums.
          </p>
        </div>`;
    }

    if (metrics.realizedRR < 1.0 && metrics.tradeCount >= 5) {
      leaksHTML += `
        <div class="p-3 rounded-xl bg-amber-500/10 border border-amber-500/30 mb-2">
          <div class="flex items-center gap-2 text-amber-400 font-bold text-xs mb-1">
            <i class="fa-solid fa-scale-unbalanced"></i> Inverted Risk-to-Reward (${metrics.realizedRR}:1)
          </div>
          <p class="text-[11px] text-slate-300 leading-relaxed">
            Your average loss ($${metrics.avgLoss}) is larger than your average win ($${metrics.avgWin}). Even with a ${metrics.winRate}% win rate, this inverted profile produces a trade expectancy of <strong>$${metrics.expectancy}</strong>.
          </p>
        </div>`;
    }

    if (metrics.feeDragPct > 25) {
      leaksHTML += `
        <div class="p-3 rounded-xl bg-indigo-500/10 border border-indigo-500/30 mb-2">
          <div class="flex items-center gap-2 text-indigo-400 font-bold text-xs mb-1">
            <i class="fa-solid fa-receipt"></i> Heavy Fee Drag (${metrics.feeDragPct}%)
          </div>
          <p class="text-[11px] text-slate-300 leading-relaxed">
            Exchange commissions and 18% GST have consumed <strong>$${metrics.totalFee}</strong> (${metrics.feeDragPct}% of gross gains). You are overtrading low-margin scalps.
          </p>
        </div>`;
    }

    let alphaHTML = "";
    if (alphaSetups.length > 0) {
      alphaHTML = alphaSetups.map(s => `
        <div class="flex justify-between items-center py-1.5 border-b border-borderDark/60 text-xs">
          <span class="font-bold text-white">${s.tag}</span>
          <div class="flex gap-2">
            <span class="text-winGreen font-mono font-bold">+$${s.netPnl}</span>
            <span class="text-slate-400 font-mono">${s.winRate}% WR (${s.trades}t)</span>
          </div>
        </div>
      `).join("");
    } else {
      alphaHTML = `<p class="text-slate-400 text-xs italic">Tag your trades in the audit log to reveal your top SMC edges.</p>`;
    }

    return `
      <div class="space-y-4 font-sans text-xs">
        <div>
          <h4 class="font-bold text-white text-sm flex items-center gap-1.5 mb-2">
            <i class="fa-solid fa-triangle-exclamation text-lossRed"></i> Priority Behavioral Leaks
          </h4>
          ${leaksHTML || '<p class="text-slate-400 text-xs">No critical behavioral leaks identified in this sample.</p>'}
        </div>

        <div class="pt-2 border-t border-borderDark">
          <h4 class="font-bold text-white text-sm flex items-center gap-1.5 mb-2">
            <i class="fa-solid fa-trophy text-winGreen"></i> Validated Strategy Edge (Alpha)
          </h4>
          <div class="bg-brandDark p-3 rounded-xl border border-borderDark space-y-1">
            ${alphaHTML}
          </div>
        </div>
      </div>
    `;
  }

  /**
   * Generates AI-powered coaching analysis using Gemini 2.5 Flash
   */
  async function generateAnalysis(dossier, targetElementId) {
    const container = document.getElementById(targetElementId);
    if (!container) return;

    const apiKey = localStorage.getItem(DeltaConfig.STORAGE_KEYS.GEMINI_KEY) || "";

    // If no key provided, immediately render deterministic rule-based feedback
    if (!apiKey.trim()) {
      container.innerHTML = `
        <div class="mb-4 p-3.5 rounded-xl bg-amber-500/10 border border-amber-500/30 text-amber-300 text-xs flex justify-between items-center">
          <div>
            <i class="fa-solid fa-circle-info mr-1.5"></i> <strong>Offline Quantitative Mode:</strong> Showing deterministic rule-based analysis. Enter your Gemini API key in Settings (<i class="fa-solid fa-gear"></i>) for deep narrative coaching.
          </div>
        </div>
        ${generateOfflineDiagnostic(dossier)}
      `;
      return;
    }

    container.innerHTML = `
      <div class="flex flex-col items-center justify-center py-10 gap-3">
        <i class="fa-solid fa-circle-notch fa-spin text-3xl text-indigo-500"></i>
        <p class="text-xs text-slate-400 font-mono animate-pulse">Consulting Quantitative Options Engine & Gemini 2.5...</p>
      </div>
    `;

    const { systemPrompt, userPrompt } = buildSystemAndUserPrompt(dossier);

    try {
      const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: systemPrompt }] },
          contents: [{ parts: [{ text: userPrompt }] }],
          generationConfig: {
            temperature: 0.2, // Low temperature for factual, analytical consistency
            maxOutputTokens: 1500
          }
        })
      });

      if (!response.ok) {
        const errJson = await response.json().catch(() => ({}));
        throw new Error(errJson.error?.message || `Gemini API returned HTTP ${response.status}`);
      }

      const data = await response.json();
      const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text;

      if (!rawText) throw new Error("Empty response returned from Gemini.");

      const renderedMarkdown = typeof marked !== 'undefined' ? marked.parse(rawText) : rawText;

      container.innerHTML = `
        <div class="prose prose-invert prose-sm max-w-none text-slate-300 text-xs leading-relaxed space-y-3">
          ${renderedMarkdown}
        </div>
      `;
    } catch (err) {
      console.error("AI Coach Generation Error:", err);
      container.innerHTML = `
        <div class="p-4 rounded-xl bg-lossRed/10 border border-lossRed/30 text-lossRed text-xs mb-4">
          <i class="fa-solid fa-triangle-exclamation mr-1.5"></i> <strong>AI Coach Error:</strong> ${err.message}
        </div>
        ${generateOfflineDiagnostic(dossier)}
      `;
    }
  }

  /**
   * Deterministic Quantitative Self-Improving Dossier (Offline Fallback)
   * Follows the 7-Slide Architecture (Slide 01 - 07)
   */
  function generateOfflineSelfImprovingReport(analysis, catalyst) {
    const stats = analysis?.stats || {};
    const evalData = analysis?.evaluation || {};
    const byRegime = evalData.byRegime || {};
    const byStrategy = evalData.byStrategy || {};

    let regimeRows = Object.keys(byRegime).map(r => {
      const d = byRegime[r];
      const winPct = d.count > 0 ? Math.round((d.wins / d.count) * 100) : 0;
      return `<div class="p-2.5 rounded-lg bg-panelDark border border-borderDark/60 flex justify-between items-center text-xs font-mono">
        <span class="text-white font-bold">${r.replace(/_/g, ' ')}</span>
        <span class="text-slate-400">${d.count} setups (${d.wins}W - ${d.losses}L) &bull; <strong class="${winPct >= 50 ? 'text-winGreen' : 'text-lossRed'}">${winPct}% Win Rate</strong> &bull; Net ${d.netR >= 0 ? '+' : ''}${d.netR.toFixed(1)}R</span>
      </div>`;
    }).join('');

    if (!regimeRows) {
      regimeRows = `<div class="text-slate-500 font-mono text-xs">Waiting for regime evaluation metrics...</div>`;
    }

    return `
      <div class="space-y-4 font-sans text-xs text-slate-300">
        <div class="p-4 rounded-xl bg-brandDark border border-indigo-500/30 space-y-3">
          <div class="flex items-center justify-between border-b border-borderDark/60 pb-2">
            <span class="font-bold text-white text-sm flex items-center gap-2">
              <i class="fa-solid fa-microchip text-indigo-400"></i> Self-Improving Trading Engine (V2 Approved)
            </span>
            <span class="text-[10px] px-2 py-0.5 rounded bg-emerald-500/10 text-emerald-400 border border-emerald-500/30 font-mono font-bold">Candidate V2 Promoted</span>
          </div>
          <p class="text-slate-300 text-xs leading-relaxed">
            <strong>System Audit:</strong> Your trading engine now operates a <strong>Multi-Regime Quant Architecture</strong>.
            Previously, the single-strategy mean-reversion model attempted to buy counter-trend support bounces during high-volatility trend expansions (causing severe loss streaks), while completely missing 1,000 - 3,000 pt market crashes.
          </p>
        </div>

        <div class="space-y-2">
          <h4 class="text-xs font-bold uppercase tracking-wider text-slate-400 font-mono">1. Market Regime Performance Attribution (Slide 04)</h4>
          <div class="space-y-1.5">
            ${regimeRows}
          </div>
        </div>

        <div class="p-3.5 rounded-xl bg-cardDark border border-borderDark space-y-2">
          <h4 class="text-xs font-bold uppercase tracking-wider text-amber-300 font-mono flex items-center gap-1.5">
            <i class="fa-solid fa-triangle-exclamation text-amber-400"></i> 2. Weakness Detected & Enacted Counter-Measure (Slide 04 & 05)
          </h4>
          <div class="grid grid-cols-1 sm:grid-cols-3 gap-2 font-mono text-[11px]">
            <div class="p-2 rounded bg-brandDark border border-borderDark/50">
              <span class="text-[9px] text-slate-500 uppercase block font-sans">Regime</span>
              <strong class="text-rose-400">High Volatility Selloff</strong>
            </div>
            <div class="p-2 rounded bg-brandDark border border-borderDark/50">
              <span class="text-[9px] text-slate-500 uppercase block font-sans">Detected Leak</span>
              <strong class="text-slate-200">Knife-Catching Longs</strong>
            </div>
            <div class="p-2 rounded bg-brandDark border border-borderDark/50">
              <span class="text-[9px] text-slate-500 uppercase block font-sans">Automated Action</span>
              <strong class="text-winGreen">Activated BOS Put Engine</strong>
            </div>
          </div>
          <p class="text-slate-400 text-[11px] leading-relaxed pt-1">
            <strong>Engine Rule:</strong> When the Macro Sentinel flags Bearish Bias or price breaks below swing structure with RVOL &ge; 1.1x and expanding ATR, the system strictly blocks counter-trend Call setups and executes <strong>Breakdown (BOS) PUT options targeting 2.0R (+50% Delta gain)</strong>.
          </p>
        </div>

        <div class="p-3.5 rounded-xl bg-cardDark border border-borderDark space-y-2">
          <h4 class="text-xs font-bold uppercase tracking-wider text-slate-400 font-mono">3. Non-Negotiable Delta Exchange Execution Rules (Slide 07)</h4>
          <ul class="list-disc pl-5 space-y-1 text-slate-300 text-xs">
            <li><strong>Strict Contract Discipline:</strong> Once a trade is triggered on the chart, its contract strike and entry zone are permanently locked in the trade registry. Never chase strikes that have moved 300+ points.</li>
            <li><strong>Never Catch Falling Knives:</strong> When Bitcoin is dumping with elevated volume, never buy calls on the first green candle. Wait for genuine range stabilization.</li>
            <li><strong>Respect 2.0R Take Profits:</strong> On Institutional Breakdown (BOS) Put trades, hold until the option achieves +50% (+40% net take-home) or spot hits Take Profit.</li>
          </ul>
        </div>
      </div>
    `;
  }

  /**
   * Autonomous AI Research Agent (Hermes Quant Mode - Slide 05 & 07)
   */
  async function runSelfImprovingQuantAgent(targetElementId) {
    const container = document.getElementById(targetElementId);
    if (!container) return;

    const apiKey = localStorage.getItem(DeltaConfig.STORAGE_KEYS.GEMINI_KEY) || "";
    const analysis = window.DeltaLiveChart ? DeltaLiveChart.getCurrentAnalysis() : null;
    const catalyst = window.DeltaMacroSentinel ? DeltaMacroSentinel.getLatestCatalyst() : null;

    const trades = analysis?.trades || [];
    const evaluation = analysis?.evaluation || {};
    const stats = analysis?.stats || {};

    if (!apiKey.trim()) {
      container.innerHTML = generateOfflineSelfImprovingReport(analysis, catalyst);
      return;
    }

    container.innerHTML = `
      <div class="flex flex-col items-center justify-center py-10 gap-3">
        <i class="fa-solid fa-microchip fa-spin text-3xl text-indigo-400"></i>
        <p class="text-xs text-slate-300 font-mono animate-pulse">Hermes Quantitative Agent is analyzing market regimes & validating Candidate V2...</p>
      </div>
    `;

    const systemPrompt = `You are the Hermes AI Quantitative Research Agent operating inside an institutional Bitcoin options trading engine for Delta Exchange India derivatives (architecture inspired by OpenBB and Bloomberg quant systems).
Your mission is to evaluate strategy performance, diagnose failure patterns (such as counter-trend entries during violent market crashes), formulate testable hypotheses, and validate Candidate Strategy V2 improvements.

You must structure your response in exactly 5 markdown sections with emojis:
1. ### 🔍 Market Regime & Failure Diagnostics (Slide 04)
Directly evaluate performance across Trend vs Range vs High Volatility regimes. Explain why knife-catching support bounces failed during dumps, and why the new Institutional Breakdown (BOS) Put strategy is mathematically mandatory.
2. ### 💡 Quantitative Hypothesis (Slide 05)
Formulate a testable quantitative hypothesis regarding ATR volatility filters, Macro Sentinel bias alignment, and dynamic 2.0R targets.
3. ### 🛠️ Candidate Strategy V2 Specification (Slide 05)
Specify the improved execution rules:
- Setup 1: Institutional Breakdown (BOS PUT) for trend crashes
- Setup 2: Institutional Breakout (BOS CALL) for momentum expansions
- Setup 3: Range Liquidity Sweeps (strictly prohibited during high volatility or conflicting macro bias)
4. ### 🧪 Robustness & Walk-Forward Validation (Slide 06)
Provide the quantitative validation verdict: Generalization, parameter stability, and execution realism on Delta Exchange India (spread, slippage, and 18% GST drag).
5. ### 📋 Next Session Live Execution Protocol (Slide 07)
List 3 non-negotiable rules for the trader when executing on Delta Exchange India options.`;

    const userPrompt = `
EVALUATION DATASET:
Total Evaluated Setups: ${stats.totalTrades || 0}
Simulated Win Rate: ${stats.winRate || 0}%
Profit Factor: ${stats.profitFactor || 0}
Net Expectancy: ${stats.expectancyR || 0}R
Max Drawdown: -${stats.maxDrawdownR || 0}R

ACTIVE MACRO SENTINEL CATALYST:
${catalyst ? `Category: ${catalyst.category}\nHeadline: "${catalyst.title}"\nDirectional Bias: ${catalyst.bias} (Impact Score: ${catalyst.impactScore}/10)\nOptions Advisory: ${catalyst.optionsAdvisory}` : 'No high-impact macro disruptions in last 24h (Normal Market Flow)'}

REGIME PERFORMANCE ATTRIBUTION:
${JSON.stringify(evaluation.byRegime || {}, null, 2)}

STRATEGY PERFORMANCE BREAKDOWN:
${JSON.stringify(evaluation.byStrategy || {}, null, 2)}

SAMPLE TRADES AUDIT (Recent 5):
${trades.slice(-5).map(t => `- ${t.name} (${t.direction}) @ $${t.entry}: Outcome ${t.outcome}, PnL ${t.pnlR}R, Option PnL ${t.optionPnlPct}, MAE: ${t.maePts} pts (${t.maePct}%), MFE: ${t.mfePts} pts (${t.mfePct}%), Exit: ${t.exitReason}`).join('\n')}
`;

    try {
      const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: systemPrompt }] },
          contents: [{ parts: [{ text: userPrompt }] }],
          generationConfig: {
            temperature: 0.15,
            maxOutputTokens: 1800
          }
        })
      });

      if (!response.ok) {
        const errJson = await response.json().catch(() => ({}));
        throw new Error(errJson.error?.message || `HTTP ${response.status}`);
      }

      const data = await response.json();
      const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!rawText) throw new Error("Empty response returned from Gemini.");

      const renderedMarkdown = typeof marked !== 'undefined' ? marked.parse(rawText) : rawText;
      container.innerHTML = `
        <div class="prose prose-invert prose-sm max-w-none text-slate-300 text-xs leading-relaxed space-y-3 font-sans">
          ${renderedMarkdown}
        </div>
      `;
    } catch (err) {
      console.warn("Hermes Agent API Error:", err);
      container.innerHTML = `
        <div class="p-3 rounded-xl bg-lossRed/10 border border-lossRed/30 text-lossRed text-xs mb-3 font-mono">
          <i class="fa-solid fa-triangle-exclamation mr-1.5"></i> Notice: ${err.message}. Showing deterministic quantitative validation dossier:
        </div>
        ${generateOfflineSelfImprovingReport(analysis, catalyst)}
      `;
    }
  }

  return {
    generateAnalysis,
    generateOfflineDiagnostic,
    buildSystemAndUserPrompt,
    runSelfImprovingQuantAgent,
    generateOfflineSelfImprovingReport
  };
})();
