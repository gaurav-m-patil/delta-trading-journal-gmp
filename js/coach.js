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

  return {
    generateAnalysis,
    generateOfflineDiagnostic,
    buildSystemAndUserPrompt
  };
})();
