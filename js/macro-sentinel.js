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

  // Bullish vs Bearish Sentiment Keywords (Enhanced with Leadership, Tech & Equity Catalysts)
  const BULLISH_KEYWORDS = /\b(cut|cooler|cooling|surged|surge|soars|record inflow|approved|approval|adoption|easing|bullish|reserve bill|inflows hit|returns|reinstates|reinstated|jump|jumps|rally|rebounds|climbs|soaring|partnership|recovery)\b/i;
  const BEARISH_KEYWORDS = /\b(hacked|stolen|drain|drained|hotter|hike|hikes|lawsuit|indictment|depeg|dump|crash|ban|outflow|record outflow|fraud|freeze|probe|investigation|subpoena|breach)\b/i;

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

    // Explicit override for Jensen Huang & Leadership returns (decisively Bullish market catalyst)
    let bias = "NEUTRAL_VOLATILITY";
    let biasLabel = "⚠️ HIGH VOLATILITY EVENT";
    let biasColor = "text-amber-400 bg-amber-500/10 border-amber-500/30";
    let optionsAdvisory = "Elevated implied volatility. Exercise caution with open contracts and ensure tight stop loss orders on Delta India options.";

    const isJensenNvidiaRally = /\b(jensen|jensen huang|nvidia)\b/i.test(text) && /\b(returns|reinstates|reinstated|rally|jump|soar|climbs)\b/i.test(text);

    if (isJensenNvidiaRally) {
      bias = "BULLISH";
      biasLabel = "🟢 BULLISH CATALYST (CALLS FAVORED)";
      biasColor = "text-emerald-400 bg-emerald-500/10 border-emerald-500/30";
      optionsAdvisory = "Mega-cap tech liquidity injection boosts risk appetite and crypto beta. Favor Bullish Call momentum.";
    } else {
      const isBull = BULLISH_KEYWORDS.test(text);
      const isBear = BEARISH_KEYWORDS.test(text);

      if (isBull && !isBear) {
        bias = "BULLISH";
        biasLabel = "🟢 BULLISH CATALYST (CALLS FAVORED)";
        biasColor = "text-emerald-400 bg-emerald-500/10 border-emerald-500/30";
        optionsAdvisory = "Macro tailwinds support upside follow-through. SMC Support Bounces (Calls) have institutional momentum. Favor ATM Calls targeting +50% profit.";
      } else if (isBear && !isBull) {
        bias = "BEARISH";
        biasLabel = "🔴 BEARISH CATALYST (PUTS FAVORED)";
        biasColor = "text-rose-400 bg-rose-500/10 border-rose-500/30";
        optionsAdvisory = "Market downside pressure detected. SMC Resistance Rejections (Puts) have high continuation probability. Tighten stops on long exposure; Put gamma favored.";
      }
    }

    // Parse publication time strictly as UTC (rss2json timestamps like '2026-11-23 14:47:00' are UTC)
    let rawDateStr = item.pubDate || item.published_on;
    let pubTs = Date.now();
    if (rawDateStr) {
      if (typeof rawDateStr === 'string' && !rawDateStr.endsWith('Z') && !rawDateStr.includes('+')) {
        pubTs = new Date(rawDateStr.replace(' ', 'T') + 'Z').getTime();
      } else {
        pubTs = new Date(rawDateStr).getTime();
      }
    }
    const ageHrs = (Date.now() - pubTs) / (1000 * 60 * 60);

    // Only accept news from the last 24 hours
    if (ageHrs > 24 || isNaN(ageHrs)) return null;

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

  // Active tab state: 'NEWS' or 'EVENTS'
  let activeCatalystTab = 'NEWS';

  function setCatalystTab(tab) {
    activeCatalystTab = tab;
    renderMacroBanner();
  }

  /**
   * Renders the Dynamic Market Catalyst & Events Ticker
   * (Strictly on Delta Insights tab #macroCatalystContainer)
   */
  function renderMacroBanner() {
    const el = document.getElementById('macroCatalystContainer');
    if (!el) return;

    // 1. Separate News and Events strictly into their respective categories
    // News: sorted chronologically newest-first (based on pubTs)
    const newsList = [...currentCatalysts]
      .sort((a, b) => (b.pubTs || 0) - (a.pubTs || 0))
      .slice(0, 10)
      .map(item => ({
        title: item.title,
        category: item.category,
        bias: item.bias,
        isEvent: false,
        timeOrDate: item.timeAgoStr,
        link: item.link
      }));

    // Events: sorted chronologically by target date
    const eventsList = [...UPCOMING_MAJOR_EVENTS]
      .map(ev => ({
        title: ev.title,
        category: "Macro Calendar Event",
        bias: ev.bias,
        isEvent: true,
        timeOrDate: ev.dateStr,
        note: ev.note
      }));

    const activeItems = activeCatalystTab === 'NEWS' ? newsList : eventsList;

    if (activeItems.length === 0) {
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

    const tickerItemsHtml = activeItems.map((item) => {
      let bulletBg = "bg-amber-400 shadow-[0_0_8px_rgba(251,191,36,0.6)]";
      let badgeCls = "text-amber-300 bg-amber-500/10 border-amber-500/30";
      let tagText = item.isEvent ? "EVENT" : "CATALYST";

      if (item.bias === "BULLISH") {
        bulletBg = "bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.7)]";
        badgeCls = "text-emerald-300 bg-emerald-500/10 border-emerald-500/30";
      } else if (item.bias === "BEARISH") {
        bulletBg = "bg-rose-500 shadow-[0_0_8px_rgba(244,63,94,0.7)]";
        badgeCls = "text-rose-300 bg-rose-500/10 border-rose-500/30";
      }

      const tagOpen = item.link ? `<a href="${item.link}" target="_blank" rel="noopener noreferrer" class="text-xs text-slate-200 font-sans font-medium hover:text-white cursor-pointer select-none leading-snug break-words">` : `<span class="text-xs text-slate-200 font-sans font-medium select-none leading-snug break-words">`;
      const tagClose = item.link ? `</a>` : `</span>`;

      return `
        <div class="flex items-start gap-2 py-1.5 px-2.5 transition-colors select-none border-b border-borderDark/30 last:border-b-0">
          <span class="h-2 w-2 rounded-full shrink-0 mt-1 ${bulletBg}"></span>
          <span class="text-[8px] sm:text-[9px] font-mono font-bold uppercase tracking-wider px-1.5 py-0.5 rounded border shrink-0 mt-0.5 ${badgeCls}">
            ${tagText}
          </span>
          <span class="text-[9px] sm:text-[10px] text-slate-400 font-mono shrink-0 mt-0.5 whitespace-nowrap">${item.timeOrDate}</span>
          <div class="flex-1 min-w-0">
            ${tagOpen}${item.title}${tagClose}
            ${item.note ? `<span class="block text-[10px] text-slate-400 font-normal mt-0.5">${item.note}</span>` : ''}
          </div>
        </div>
      `;
    }).join('');

    el.innerHTML = `
      <div class="p-2 sm:p-2.5 rounded-2xl bg-gradient-to-r from-cardDark via-brandDark to-cardDark border border-borderDark/80 shadow-md relative overflow-hidden group">
        <!-- Compact, High-Density Header Bar -->
        <div class="flex items-center justify-between pb-1.5 mb-1 border-b border-borderDark/60 px-1 select-none gap-1">
          <!-- Left: Tab Switcher (News vs Events) -->
          <div class="flex items-center bg-brandDark/80 border border-borderDark/80 rounded-lg p-0.5">
            <button onclick="DeltaMacroSentinel.setCatalystTab('NEWS')" class="px-2 py-0.5 text-[10px] font-bold font-mono rounded transition-all ${activeCatalystTab === 'NEWS' ? 'bg-indigo-600 text-white shadow-sm' : 'text-slate-400 hover:text-white'}">
              <i class="fa-solid fa-newspaper text-[9px] mr-1"></i>News (${newsList.length})
            </button>
            <button onclick="DeltaMacroSentinel.setCatalystTab('EVENTS')" class="px-2 py-0.5 text-[10px] font-bold font-mono rounded transition-all ${activeCatalystTab === 'EVENTS' ? 'bg-indigo-600 text-white shadow-sm' : 'text-slate-400 hover:text-white'}">
              <i class="fa-solid fa-calendar-check text-[9px] mr-1"></i>Events (${eventsList.length})
            </button>
          </div>

          <!-- Right: Compact Legend -->
          <div class="flex items-center gap-1.5 text-[9px] font-mono text-slate-400">
            <span class="flex items-center gap-1"><span class="h-1.5 w-1.5 rounded-full bg-emerald-400"></span> Bull</span>
            <span class="flex items-center gap-1"><span class="h-1.5 w-1.5 rounded-full bg-rose-500"></span> Bear</span>
            <span class="flex items-center gap-1"><span class="h-1.5 w-1.5 rounded-full bg-amber-400"></span> Vol</span>
          </div>
        </div>

        <!-- Interactive Drag / Touch / Wheel Scrollable Container -->
        <div id="catalystScrollContainer" class="relative h-[110px] overflow-y-auto no-scrollbar rounded-xl bg-brandDark/50 border border-borderDark/40 cursor-grab active:cursor-grabbing select-none">
          <div id="catalystTrack" class="catalyst-marquee-track space-y-0.5">
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
        .catalyst-marquee-track.paused {
          animation-play-state: paused !important;
        }
      </style>
    `;

    // Interactive Drag / Touch / Wheel Event Handlers
    attachMarqueeInteractivity();
  }

  function attachMarqueeInteractivity() {
    const container = document.getElementById('catalystScrollContainer');
    const track = document.getElementById('catalystTrack');
    if (!container || !track) return;

    let isDown = false;
    let startY = 0;
    let scrollTop = 0;
    let pauseTimer = null;

    function pauseAnimation() {
      clearTimeout(pauseTimer);
      track.classList.add('paused');
    }

    // Hold/touch pauses scroll for at least 5 seconds after release
    function scheduleResume(delay = 5000) {
      clearTimeout(pauseTimer);
      pauseTimer = setTimeout(() => {
        if (!isDown) {
          track.classList.remove('paused');
        }
      }, delay);
    }

    // Hover / mouse enter / leave
    container.addEventListener('mouseenter', pauseAnimation);
    container.addEventListener('mouseleave', () => scheduleResume(2000));

    // Mouse Dragging
    container.addEventListener('mousedown', (e) => {
      isDown = true;
      pauseAnimation();
      container.classList.add('active:cursor-grabbing');
      startY = e.pageY - container.offsetTop;
      scrollTop = container.scrollTop;
    });

    window.addEventListener('mouseup', () => {
      if (isDown) {
        isDown = false;
        container.classList.remove('active:cursor-grabbing');
        scheduleResume(5000);
      }
    });

    container.addEventListener('mousemove', (e) => {
      if (!isDown) return;
      e.preventDefault();
      const y = e.pageY - container.offsetTop;
      const walk = (y - startY) * 1.5;
      container.scrollTop = scrollTop - walk;
    });

    // Mouse Wheel Scroll
    container.addEventListener('wheel', (e) => {
      pauseAnimation();
      container.scrollTop += e.deltaY;
      scheduleResume(5000);
    }, { passive: true });

    // Touch Support for Mobile (6.2 inch phones)
    container.addEventListener('touchstart', (e) => {
      isDown = true;
      pauseAnimation();
      startY = e.touches[0].pageY - container.offsetTop;
      scrollTop = container.scrollTop;
    }, { passive: true });

    container.addEventListener('touchmove', (e) => {
      if (!isDown) return;
      const y = e.touches[0].pageY - container.offsetTop;
      const walk = (y - startY) * 1.5;
      container.scrollTop = scrollTop - walk;
    }, { passive: true });

    container.addEventListener('touchend', () => {
      isDown = false;
      scheduleResume(5000); // Guarantees 5 full seconds of pause upon release
    }, { passive: true });
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
    setCatalystTab,
    getLatestCatalyst: () => currentCatalysts[0] || null
  };
})();
