/**
 * DELTA TRADING JOURNAL - HIGH-IMPACT MACRO & BREAKING NEWS SENTINEL
 * 
 * Continuously monitors global macro catalysts, CPI releases, Fed rate decisions,
 * major crypto security exploits/hacks, and institutional regulatory filings.
 * 
 * STRICT QUALITY FILTER:
 * Only processes events with institutional market-moving weight (Impact Score >= 7).
 * Filters out low-conviction noise, memes, and routine commentary.
 */

window.DeltaMacroSentinel = (function() {
  'use strict';

  let currentCatalysts = [];
  let isScanning = false;
  let lastScanTime = 0;

  // High-Impact Macro & Security Dictionaries
  const HIGH_IMPACT_DICTIONARY = [
    // 1. Central Banks & Macro
    {
      pattern: /\b(cpi|inflation|consumer price index)\b/i,
      category: "US Inflation / CPI Release",
      baseScore: 9,
      type: "MACRO"
    },
    {
      pattern: /\b(fomc|fed rate|interest rate cut|interest rate hike|jerome powell|federal reserve rate)\b/i,
      category: "Federal Reserve / FOMC Decision",
      baseScore: 9,
      type: "MACRO"
    },
    {
      pattern: /\b(nonfarm payroll|non-farm payroll|nfp|us jobs report|unemployment rate)\b/i,
      category: "US Labor & Employment Data",
      baseScore: 8,
      type: "MACRO"
    },

    // 2. Black Swan, Security Breaches & Hacks
    {
      pattern: /\b(hack|hacked|exploited|exploit|stolen|security breach|funds drained)\b/i,
      category: "Critical Security / Exploit Event",
      baseScore: 9,
      type: "SECURITY"
    },
    {
      pattern: /\b(depeg|depegged|tether probe|usdt depeg|insolvent|insolvency|chapter 11|bankruptcy)\b/i,
      category: "Solvency & Liquidity Shock",
      baseScore: 10,
      type: "LIQUIDITY"
    },
    {
      pattern: /\b(mt gox|mt\. gox|silk road btc|government dump|seized bitcoin)\b/i,
      category: "Supply Overhang / Sovereign Dump",
      baseScore: 8,
      type: "SUPPLY"
    },

    // 3. Institutional Mega-Catalysts & Government
    {
      pattern: /\b(strategic bitcoin reserve|strategic reserve bill|bitcoin reserve act)\b/i,
      category: "Sovereign Strategic BTC Reserve",
      baseScore: 9,
      type: "POLICY"
    },
    {
      pattern: /\b(spot etf approval|etf approved|etf inflow record|record net inflow)\b/i,
      category: "Institutional ETF Flow Surge",
      baseScore: 8,
      type: "INSTITUTIONAL"
    },
    {
      pattern: /\b(sec lawsuit|doj indictment|cftc probe|criminal charges|crypto ban)\b/i,
      category: "Regulatory / Enforcement Action",
      baseScore: 8,
      type: "REGULATORY"
    }
  ];

  // Bullish vs Bearish Sentiment Keywords
  const BULLISH_KEYWORDS = /\b(cut|cooler|cooling|surged|surge|soars|record inflow|approved|approval|adoption|easing|bullish|reserve bill|inflows hit)\b/i;
  const BEARISH_KEYWORDS = /\b(hacked|stolen|drain|drained|hotter|hike|hikes|lawsuit|indictment|probe|depeg|dump|crash|ban|outflow|record outflow|fraud|freeze)\b/i;

  /**
   * Evaluates raw news text and extracts institutional relevance
   */
  function scoreNewsItem(item) {
    const text = `${item.title || ''} ${item.description || ''}`;
    let highestScore = 0;
    let matchedRule = null;

    for (const rule of HIGH_IMPACT_DICTIONARY) {
      if (rule.pattern.test(text)) {
        if (rule.baseScore > highestScore) {
          highestScore = rule.baseScore;
          matchedRule = rule;
        }
      }
    }

    if (!matchedRule || highestScore < 7) return null;

    // Determine Directional Bias
    const isBull = BULLISH_KEYWORDS.test(text);
    const isBear = BEARISH_KEYWORDS.test(text);

    let bias = "NEUTRAL_VOLATILITY";
    let biasLabel = "⚠️ HIGH VOLATILITY EVENT";
    let biasColor = "text-amber-400 bg-amber-500/10 border-amber-500/30";
    let optionsAdvisory = "Elevated implied volatility. Exercise caution with open contracts and ensure tight stop loss orders on Delta India options.";

    if (isBull && !isBear) {
      bias = "BULLISH";
      biasLabel = "🟢 BULLISH CATALYST (CALLS FAVORED)";
      biasColor = "text-emerald-400 bg-emerald-500/10 border-emerald-500/30";
      optionsAdvisory = "Macro tailwinds support upside follow-through. SMC Support Bounces (Calls) have institutional momentum. Favor ATM Calls targeting +50% profit.";
    } else if (isBear) {
      bias = "BEARISH";
      biasLabel = "🔴 BEARISH CATALYST (PUTS FAVORED)";
      biasColor = "text-rose-400 bg-rose-500/10 border-rose-500/30";
      optionsAdvisory = "Market downside pressure detected. SMC Resistance Rejections (Puts) have high continuation probability. Tighten stops on long exposure; Put gamma favored.";
    }

    // Parse publication time
    const pubTs = new Date(item.pubDate || item.published_on || Date.now()).getTime();
    const ageHrs = (Date.now() - pubTs) / (1000 * 60 * 60);

    // Only accept news from the last 18 hours
    if (ageHrs > 18) return null;

    return {
      guid: item.guid || item.link || item.title,
      title: item.title,
      link: item.link,
      source: item.author || "Global Crypto Feed",
      category: matchedRule.category,
      type: matchedRule.type,
      impactScore: highestScore,
      bias,
      biasLabel,
      biasColor,
      optionsAdvisory,
      pubTs,
      timeAgoStr: formatTimeAgo(pubTs)
    };
  }

  function formatTimeAgo(ts) {
    const diffSec = Math.floor((Date.now() - ts) / 1000);
    if (diffSec < 60) return "Just now";
    const diffMin = Math.floor(diffSec / 60);
    if (diffMin < 60) return `${diffMin}m ago`;
    const diffHr = Math.floor(diffMin / 60);
    return `${diffHr}h ago`;
  }

  /**
   * Fetches real-time feeds from CoinTelegraph and CoinDesk via CORS-ready rss2json
   */
  async function fetchBreakingCatalysts() {
    const now = Date.now();
    if (now - lastScanTime < 120000 && currentCatalysts.length > 0) {
      return currentCatalysts;
    }

    isScanning = true;
    const feeds = [
      'https://api.rss2json.com/v1/api.json?rss_url=https://cointelegraph.com/rss',
      'https://api.rss2json.com/v1/api.json?rss_url=https://www.coindesk.com/arc/outboundfeeds/rss/'
    ];

    const results = [];

    for (const url of feeds) {
      try {
        const res = await fetch(url);
        if (res.ok) {
          const data = await res.json();
          if (data && data.items && Array.isArray(data.items)) {
            for (const item of data.items) {
              const scored = scoreNewsItem(item);
              if (scored) {
                // Deduplicate by title similarity
                const exists = results.some(r => r.title.substring(0, 30) === scored.title.substring(0, 30));
                if (!exists) results.push(scored);
              }
            }
          }
        }
      } catch (err) {
        console.warn("[MacroSentinel] Feed fetch notice:", err.message);
      }
    }

    // Sort by impact score (highest first), then by newest
    results.sort((a, b) => (b.impactScore - a.impactScore) || (b.pubTs - a.pubTs));

    currentCatalysts = results;
    lastScanTime = Date.now();
    isScanning = false;

    // Check if newest high-impact catalyst should be sent to Telegram
    if (currentCatalysts.length > 0) {
      checkAndSendTelegramNews(currentCatalysts[0]);
    }

    renderMacroBanner();
    return currentCatalysts;
  }

  /**
   * Dispatches real-time Telegram alert for verified high-impact catalysts
   */
  function checkAndSendTelegramNews(catalyst) {
    if (!catalyst || catalyst.impactScore < 8) return;

    const lastAlertedGuid = localStorage.getItem('dtj_last_alerted_catalyst_guid');
    if (lastAlertedGuid === catalyst.guid) return;

    if (!window.DeltaApp || typeof DeltaApp.getTelegramConfig !== 'function') return;
    const cfg = DeltaApp.getTelegramConfig();
    if (!cfg.enabled || !cfg.botToken || !cfg.chatId) return;

    const timeIST = new Date(catalyst.pubTs).toLocaleTimeString('en-IN', {
      timeZone: 'Asia/Kolkata',
      hour: '2-digit',
      minute: '2-digit',
      hour12: true
    });

    const msg = `🚨 <b>HIGH-IMPACT MARKET CATALYST DETECTED</b>
━━━━━━━━━━━━━━━━━━━━━━
📢 <b>Headline:</b> ${catalyst.title}
📰 <b>Category:</b> <b>${catalyst.category}</b>
⏰ <b>Time:</b> ${timeIST} IST (${catalyst.timeAgoStr})

🔥 <b>Market Bias:</b> <b>${catalyst.biasLabel}</b>

🧠 <b>Delta Options Trading Advisory:</b>
${catalyst.optionsAdvisory}

⚡ <i>Institutional note: Sudden macro catalysts can trigger sharp volatility expansion. Stick strictly to confirmed SMC triggers & Stop Loss limits.</i>
🔗 <a href="https://delta-trading-journal-gmp.vercel.app/">View Live Terminal & Setups</a>`;

    if (typeof DeltaApp.sendTelegramMessage === 'function') {
      DeltaApp.sendTelegramMessage(msg).then(ok => {
        if (ok) {
          localStorage.setItem('dtj_last_alerted_catalyst_guid', catalyst.guid);
          console.log(`[MacroSentinel] Telegram catalyst alert dispatched: ${catalyst.title}`);
        }
      });
    }
  }

  /**
   * Renders the Macro Sentinel banner into the UI
   */
  function renderMacroBanner() {
    const containers = [
      document.getElementById('macroCatalystContainer'),
      document.getElementById('macroCatalystCoachContainer')
    ];

    const active = currentCatalysts.length > 0 ? currentCatalysts[0] : null;

    containers.forEach(el => {
      if (!el) return;

      if (!active) {
        el.innerHTML = `
          <div class="px-3.5 py-2 rounded-xl bg-cardDark border border-borderDark/60 flex items-center justify-between text-xs font-mono text-slate-400">
            <span class="flex items-center gap-2">
              <span class="h-2 w-2 rounded-full bg-emerald-400"></span>
              <span>Macro Sentinel: <strong>Normal Market Flow</strong> (No black swans or emergency CPI/Fed disruptions in last 18h)</span>
            </span>
            <span class="text-[10px] text-slate-500 font-sans hidden sm:inline">Scanner Active</span>
          </div>
        `;
        return;
      }

      const isBull = active.bias === "BULLISH";
      const isBear = active.bias === "BEARISH";
      const borderCls = isBull ? "border-winGreen/50 bg-winGreen/10" : (isBear ? "border-rose-500/50 bg-rose-950/20" : "border-amber-500/50 bg-amber-950/20");
      const icon = isBull ? "fa-arrow-trend-up text-winGreen" : (isBear ? "fa-triangle-exclamation text-rose-400" : "fa-bolt text-amber-400");

      el.innerHTML = `
        <div class="p-3.5 rounded-2xl border ${borderCls} shadow-lg space-y-2 font-mono">
          <div class="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-1.5 pb-2 border-b border-borderDark/40">
            <div class="flex items-center gap-2">
              <i class="fa-solid ${icon} text-sm"></i>
              <span class="text-xs font-bold text-white tracking-wide">MARKET CATALYST: ${active.category}</span>
              <span class="text-[9px] px-2 py-0.5 rounded font-bold ${active.biasColor}">
                ${active.biasLabel}
              </span>
            </div>
            <span class="text-[10px] text-slate-400">${active.timeAgoStr}</span>
          </div>

          <div class="text-xs text-slate-200 font-sans font-medium leading-relaxed">
            "${active.title}"
          </div>

          <div class="p-2.5 rounded-xl bg-brandDark/80 border border-borderDark/60 flex flex-col sm:flex-row justify-between items-start sm:items-center gap-2 text-[11px]">
            <div class="text-slate-300">
              <span class="text-indigo-300 font-bold">Options Advisory:</span> ${active.optionsAdvisory}
            </div>
            <a href="${active.link}" target="_blank" rel="noopener noreferrer" class="text-[10px] font-bold text-indigo-400 hover:text-white shrink-0 flex items-center gap-1">
              Read Source <i class="fa-solid fa-arrow-up-right-from-square text-[9px]"></i>
            </a>
          </div>
        </div>
      `;
    });
  }

  // Auto-scan on load and every 3 minutes
  setTimeout(() => {
    fetchBreakingCatalysts();
    setInterval(fetchBreakingCatalysts, 180000);
  }, 2000);

  return {
    fetchBreakingCatalysts,
    renderMacroBanner,
    checkAndSendTelegramNews,
    getLatestCatalyst: () => currentCatalysts[0] || null
  };
})();
