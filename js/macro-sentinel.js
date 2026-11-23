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
    // 1. Central Banks, Macro, Tech & Mega-Cap Catalysts
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
    {
      pattern: /\b(nvidia|jensen|jensen huang|nasdaq|semiconductor|ai chip|mag 7|magnificent 7)\b/i,
      category: "Tech & Macro Liquidity Catalyst",
      baseScore: 9,
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
    },
    {
      pattern: /\b(bitcoin|btc|crypto|etf|options|liquidation|liquidations|rally|rebound|soar)\b/i,
      category: "Crypto Market Action",
      baseScore: 7,
      type: "MARKET"
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

    // Automated background news alerts are handled 24/7 by Cloud Sentinel Bot (GitHub Actions).
    // Client-side auto-dispatch is disabled to eliminate duplicate alerts upon opening the web app.

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

    // Automated background Telegram catalyst alerts are handled exclusively by 24/7 Cloud Sentinel (GitHub Actions)
    // to prevent duplicate messages when opening the app on mobile.
    localStorage.setItem('dtj_last_alerted_catalyst_guid', catalyst.guid);
    console.log(`[MacroSentinel] High-impact catalyst detected: ${catalyst.title} (Cloud Sentinel handles Telegram dispatch).`);
  }

  // Key Macro Calendar Events Calendar for crypto/equities
  const UPCOMING_MAJOR_EVENTS = [
    {
      title: "FOMC Federal Reserve Interest Rate Decision & Powell Press Conference",
      dateStr: "Dec 18, 2026",
      impact: "HIGH",
      bias: "NEUTRAL",
      type: "EVENT",
      note: "Markets pricing high volatility on 2027 rate path guidance"
    },
    {
      title: "US Core PCE Price Index (Fed's Preferred Inflation Gauge)",
      dateStr: "Nov 27, 2026",
      impact: "HIGH",
      bias: "NEUTRAL",
      type: "EVENT",
      note: "Critical catalyst for rate cut odds"
    },
    {
      title: "US Nonfarm Payrolls (NFP) & Unemployment Rate",
      dateStr: "Dec 06, 2026",
      impact: "HIGH",
      bias: "NEUTRAL",
      type: "EVENT",
      note: "Major labor market trigger for global liquidity"
    },
    {
      title: "Delta Exchange & Deribit Monthly BTC/ETH Options Expiry ($6.2B Notional)",
      dateStr: "Nov 27, 2026",
      impact: "HIGH",
      bias: "BULLISH",
      type: "EVENT",
      note: "Max-pain pin at $61,500; post-expiry volatility expansion expected"
    }
  ];

  /**
   * Renders the Dynamic Market Catalyst & Events Ticker
   * (Strictly on Delta Insights tab #macroCatalystCoachContainer)
   */
  function renderMacroBanner() {
    const el = document.getElementById('macroCatalystCoachContainer');
    if (!el) return;

    // Filter catalysts: up to 7 major news items + 3 major upcoming events
    const newsList = currentCatalysts.slice(0, 7);
    const eventsList = UPCOMING_MAJOR_EVENTS.slice(0, 10 - newsList.length);

    // Merge into combined 10 dynamic items
    const combinedItems = [];
    newsList.forEach(item => {
      combinedItems.push({
        title: item.title,
        category: item.category,
        bias: item.bias,
        isEvent: false,
        timeOrDate: item.timeAgoStr,
        link: item.link
      });
    });

    eventsList.forEach(ev => {
      combinedItems.push({
        title: ev.title,
        category: "Upcoming Macro Event",
        bias: ev.bias,
        isEvent: true,
        timeOrDate: ev.dateStr,
        note: ev.note
      });
    });

    if (combinedItems.length === 0) {
      el.innerHTML = `
        <div class="px-3 py-2 rounded-xl bg-cardDark/60 border border-borderDark/60 flex items-center justify-between text-xs font-mono text-slate-400">
          <span class="flex items-center gap-2">
            <span class="h-2 w-2 rounded-full bg-emerald-400 animate-pulse"></span>
            <span>Market Catalyst Radar: Scanning live global macro and institutional crypto feeds...</span>
          </span>
          <span class="text-[10px] text-slate-500">Live Sentinel</span>
        </div>
      `;
      return;
    }

    // Build the dynamic ticker with colored impact bullets:
    // Green bullet = Bullish / Upside trigger
    // Red bullet = Bearish / Downside trigger
    // Amber / Cyan = Neutral / High Volatility Event
    const tickerItemsHtml = combinedItems.map((item, idx) => {
      let bulletBg = "bg-amber-400 shadow-[0_0_8px_rgba(251,191,36,0.5)]";
      let badgeCls = "text-amber-300 bg-amber-500/10 border-amber-500/30";
      let tagText = item.isEvent ? "CALENDAR EVENT" : "CATALYST";

      if (item.bias === "BULLISH") {
        bulletBg = "bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.7)]";
        badgeCls = "text-emerald-300 bg-emerald-500/10 border-emerald-500/30";
      } else if (item.bias === "BEARISH") {
        bulletBg = "bg-rose-500 shadow-[0_0_8px_rgba(244,63,94,0.7)]";
        badgeCls = "text-rose-300 bg-rose-500/10 border-rose-500/30";
      }

      const linkAttr = item.link ? `href="${item.link}" target="_blank" rel="noopener noreferrer"` : '';
      const cursorCls = item.link ? 'hover:text-white cursor-pointer' : '';

      return `
        <div class="flex items-center gap-2.5 py-1.5 px-3 min-w-0 transition-colors">
          <span class="h-2 w-2 rounded-full shrink-0 ${bulletBg}"></span>
          <span class="text-[9px] font-mono font-bold uppercase tracking-wider px-1.5 py-0.5 rounded border shrink-0 ${badgeCls}">
            ${tagText}
          </span>
          <span class="text-[10px] text-slate-400 font-mono shrink-0">${item.timeOrDate}</span>
          <${item.link ? 'a' : 'span'} ${linkAttr} class="text-xs text-slate-200 font-sans font-medium truncate ${cursorCls}">
            ${item.title} ${item.note ? `<span class="text-[10px] text-slate-400 font-normal">(${item.note})</span>` : ''}
          </${item.link ? 'a'}>
        </div>
      `;
    }).join('');

    // Duplicate ticker items for smooth seamless vertical infinite scroll marquee
    el.innerHTML = `
      <div class="p-2 sm:p-2.5 rounded-2xl bg-gradient-to-r from-cardDark via-brandDark to-cardDark border border-borderDark/80 shadow-md relative overflow-hidden group">
        <div class="flex items-center justify-between pb-1.5 mb-1 border-b border-borderDark/60 px-2">
          <div class="flex items-center gap-2">
            <span class="relative flex h-2 w-2">
              <span class="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
              <span class="relative inline-flex rounded-full h-2 w-2 bg-emerald-500"></span>
            </span>
            <h3 class="text-xs font-bold text-white font-sans uppercase tracking-wider flex items-center gap-1.5">
              Market Catalyst Sentinel <span class="text-[9px] font-normal text-slate-400 font-mono">(Live Macro & High-Impact Events)</span>
            </h3>
          </div>
          <div class="flex items-center gap-2 text-[10px] font-mono text-slate-400">
            <span class="flex items-center gap-1"><span class="h-1.5 w-1.5 rounded-full bg-emerald-400"></span> Bullish</span>
            <span class="flex items-center gap-1"><span class="h-1.5 w-1.5 rounded-full bg-rose-500"></span> Bearish</span>
            <span class="flex items-center gap-1"><span class="h-1.5 w-1.5 rounded-full bg-amber-400"></span> Event</span>
          </div>
        </div>

        <!-- Vertical Slow Auto-Scrolling Marquee Container -->
        <div class="relative h-[95px] overflow-hidden rounded-xl bg-brandDark/40 border border-borderDark/40">
          <div class="catalyst-marquee-track space-y-0.5">
            ${tickerItemsHtml}
            ${tickerItemsHtml}
          </div>
        </div>
      </div>

      <style>
        @keyframes catalystScroll {
          0% { transform: translateY(0); }
          100% { transform: translateY(-50%); }
        }
        .catalyst-marquee-track {
          animation: catalystScroll 28s linear infinite;
        }
        .catalyst-marquee-track:hover {
          animation-play-state: paused;
        }
      </style>
    `;
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
