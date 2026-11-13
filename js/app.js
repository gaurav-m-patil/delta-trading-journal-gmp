/**
 * Delta Trading Journal & AI Coach - Main Application Controller
 * Orchestrates Tabs (Insights, Planner, Coach), Filters, Charts, Calendar,
 * Slide-over Trade Drawer, Clipboard Screenshots, and Firebase Synchronization.
 */

window.DeltaApp = (function() {
  let currentMainTab = 'INSIGHTS';
  let currentPreset = 'CURRENT_MONTH';
  let currentFilteredTrades = [];
  let currentTradePage = 1;
  const TRADES_PER_PAGE = 25;

  let apexChartInstance = null;
  let callPutChart = null;
  let buySellChart = null;
  let activeDrawerTradeId = null;

  const formatUSD = (val) => {
    const num = Number(val) || 0;
    return (num < 0 ? "-$" : "$") + Math.abs(num).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  };

  const compactUSD = (val) => {
    const num = Number(val) || 0;
    const absNum = Math.abs(num);
    if (absNum >= 1000) return (num < 0 ? "-$" : "$") + (absNum / 1000).toFixed(1) + "k";
    return (num < 0 ? "-$" : "$") + absNum.toFixed(0);
  };

  // -------------------------------------------------------------
  // 1. LIFECYCLE & BOOTSTRAP
  // -------------------------------------------------------------
  document.addEventListener("DOMContentLoaded", async () => {
    loadSavedSettings();
    initSwipeNavigation();
    initClipboardPaste();

    // Set default date for calculator
    const todayISO = new Date().toISOString().split('T')[0];
    const calcStartInput = document.getElementById('calcStartDate');
    if (calcStartInput) calcStartInput.value = todayISO;
    DeltaPlanner.onCalcModeInput('PCT');

    // Subscribe to DB changes
    DeltaDB.addListener(onDatabaseEvent);

    // Boot database (IndexedDB -> raw_data.json fallback)
    try {
      const trades = await DeltaDB.init();
      checkSyncFreshness();
      applyGlobalFilter();
    } catch (err) {
      console.error("Initialization failed:", err);
      const lastUp = document.getElementById('lastUpdated');
      if (lastUp) lastUp.innerText = "Error loading database.";
    }
  });

  function loadSavedSettings() {
    const savedToken = localStorage.getItem(DeltaConfig.STORAGE_KEYS.GH_PAT);
    const savedOwner = localStorage.getItem(DeltaConfig.STORAGE_KEYS.GH_OWNER);
    const savedRepo = localStorage.getItem(DeltaConfig.STORAGE_KEYS.GH_REPO);
    const savedGeminiKey = localStorage.getItem(DeltaConfig.STORAGE_KEYS.GEMINI_KEY);

    if (savedToken && document.getElementById('ghTokenInput')) document.getElementById('ghTokenInput').value = savedToken;
    if (savedOwner && document.getElementById('ghOwnerInput')) document.getElementById('ghOwnerInput').value = savedOwner;
    if (savedRepo && document.getElementById('ghRepoInput')) document.getElementById('ghRepoInput').value = savedRepo;
    if (savedGeminiKey && document.getElementById('geminiKeyInput')) document.getElementById('geminiKeyInput').value = savedGeminiKey;
    updateTelegramBadge();
  }

  function onDatabaseEvent(event) {
    if (event.type === 'ready' || event.type === 'trade_updated') {
      applyGlobalFilter();
    }
  }

  function checkSyncFreshness() {
    const lastSync = localStorage.getItem(DeltaConfig.STORAGE_KEYS.LAST_SYNC);
    const badge = document.getElementById('syncStatusBadge');
    const lastUp = document.getElementById('lastUpdated');
    const staleWarn = document.getElementById('staleWarningText');

    if (!lastUp) return;

    if (lastSync) {
      const d = new Date(lastSync);
      const istTime = d.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true });
      lastUp.innerText = `Synced: ${istTime} (IST)`;
    } else {
      lastUp.innerText = `Database Ready`;
    }

    if (badge) {
      badge.innerText = "Live";
      badge.className = "px-2 py-0.5 rounded text-[10px] font-semibold bg-emerald-500/10 text-emerald-400 border border-emerald-500/20";
    }
    if (staleWarn) staleWarn.classList.add('hidden');
  }

  // -------------------------------------------------------------
  // 2. TAB NAVIGATION (Insights, Planner, Coach)
  // -------------------------------------------------------------
  function switchMainTab(tab) {
    if (currentMainTab === tab) return;
    currentMainTab = tab;

    const views = {
      INSIGHTS: document.getElementById('view_INSIGHTS'),
      CALCULATOR: document.getElementById('view_CALCULATOR'),
      COACH: document.getElementById('view_COACH')
    };

    const buttons = {
      INSIGHTS: document.getElementById('tabBtn_INSIGHTS'),
      CALCULATOR: document.getElementById('tabBtn_CALCULATOR'),
      COACH: document.getElementById('tabBtn_COACH')
    };

    // Toggle View Visibilities
    Object.keys(views).forEach(k => {
      if (!views[k]) return;
      if (k === tab) {
        views[k].classList.remove('hidden');
      } else {
        views[k].classList.add('hidden');
      }
    });

    // Update Bottom Nav Button States
    const activeClass = "flex-1 py-2.5 px-2 sm:px-3 text-xs font-bold rounded-xl transition-all bg-indigo-600 text-white flex items-center justify-center gap-1.5 shadow-lg shadow-indigo-600/25";
    const inactiveClass = "flex-1 py-2.5 px-2 sm:px-3 text-xs font-bold rounded-xl transition-all text-slate-400 hover:text-white flex items-center justify-center gap-1.5";

    Object.keys(buttons).forEach(k => {
      if (!buttons[k]) return;
      buttons[k].className = (k === tab) ? activeClass : inactiveClass;
    });

    if (tab === 'CALCULATOR') {
      DeltaPlanner.runInrCalculator();
    } else if (tab === 'COACH') {
      renderCoachTab();
      setTimeout(() => { if (window.DeltaLiveChart) DeltaLiveChart.initChart(); }, 60);
    }

    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  // -------------------------------------------------------------
  // SUB-TAB NAVIGATION (Unified Views - Reduced Vertical Scrolling)
  // -------------------------------------------------------------
  let currentInsightsSubTab = 'CHARTS';
  function switchInsightsSubTab(tab) {
    currentInsightsSubTab = tab;
    const subViews = {
      CHARTS: document.getElementById('subView_CHARTS'),
      EDGE: document.getElementById('subView_EDGE'),
      LOG: document.getElementById('subView_LOG')
    };

    const subBtns = {
      CHARTS: document.getElementById('subTabBtn_CHARTS'),
      EDGE: document.getElementById('subTabBtn_EDGE'),
      LOG: document.getElementById('subTabBtn_LOG')
    };

    const activeCls = "flex-1 py-2 px-3 text-xs font-bold rounded-xl transition-all bg-indigo-600 text-white flex items-center justify-center gap-1.5 shadow-md shrink-0";
    const inactiveCls = "flex-1 py-2 px-3 text-xs font-bold rounded-xl transition-all text-slate-400 hover:text-white bg-transparent flex items-center justify-center gap-1.5 shrink-0";

    Object.keys(subViews).forEach(k => {
      if (!subViews[k]) return;
      if (k === tab) subViews[k].classList.remove('hidden');
      else subViews[k].classList.add('hidden');
    });

    Object.keys(subBtns).forEach(k => {
      if (!subBtns[k]) return;
      subBtns[k].className = (k === tab) ? activeCls : inactiveCls;
    });

    if (tab === 'CHARTS') {
      setTimeout(() => { window.dispatchEvent(new Event('resize')); }, 60);
    }
  }

  let currentCoachSubTab = 'RADAR';
  function switchCoachSubTab(tab) {
    currentCoachSubTab = tab;
    const views = {
      RADAR: document.getElementById('subViewCoach_RADAR'),
      PORTFOLIO: document.getElementById('subViewCoach_PORTFOLIO'),
      ENGINE: document.getElementById('subViewCoach_ENGINE'),
      AI: document.getElementById('subViewCoach_AI')
    };
    const btns = {
      RADAR: document.getElementById('subTabCoachBtn_RADAR'),
      PORTFOLIO: document.getElementById('subTabCoachBtn_PORTFOLIO'),
      ENGINE: document.getElementById('subTabCoachBtn_ENGINE'),
      AI: document.getElementById('subTabCoachBtn_AI')
    };

    const activeCls = "flex-1 py-2 px-2.5 sm:px-3 text-xs font-bold rounded-xl transition-all bg-indigo-600 text-white flex items-center justify-center gap-1.5 shadow-md shrink-0 whitespace-nowrap";
    const inactiveCls = "flex-1 py-2 px-2.5 sm:px-3 text-xs font-bold rounded-xl transition-all text-slate-400 hover:text-white bg-transparent flex items-center justify-center gap-1.5 shrink-0 whitespace-nowrap";

    Object.keys(views).forEach(k => {
      if (!views[k]) return;
      if (k === tab) views[k].classList.remove('hidden');
      else views[k].classList.add('hidden');
    });

    Object.keys(btns).forEach(k => {
      if (!btns[k]) return;
      btns[k].className = (k === tab) ? activeCls : inactiveCls;
    });

    if (tab === 'ENGINE') {
      populateSelfImprovingEngineUI();
    } else if (tab === 'PORTFOLIO') {
      if (window.DeltaLiveChart && typeof DeltaLiveChart.refreshPaperUI === 'function') {
        DeltaLiveChart.refreshPaperUI();
      }
    }
  }

  function populateSelfImprovingEngineUI() {
    const analysis = window.DeltaLiveChart ? DeltaLiveChart.getCurrentAnalysis() : null;
    const catalyst = window.DeltaMacroSentinel ? DeltaMacroSentinel.getLatestCatalyst() : null;

    const regimeEl = document.getElementById('engineRegimeStatus');
    const macroEl = document.getElementById('engineMacroStatus');
    const dossierCont = document.getElementById('selfImprovingDossierContainer');

    if (regimeEl && analysis && analysis.latestTrade) {
      const r = analysis.latestTrade.regime || "RANGE_BOUND";
      const isBear = r.includes("BEAR");
      const isBull = r.includes("BULL");
      const color = isBear ? "text-lossRed" : (isBull ? "text-winGreen" : "text-indigo-300");
      regimeEl.innerHTML = `<span class="${color}">${r.replace(/_/g, ' ')}</span>`;
    } else if (regimeEl) {
      regimeEl.innerText = "Range Bound (Consolidation)";
    }

    if (macroEl) {
      if (catalyst && (catalyst.impactScore || 0) >= 7) {
        macroEl.innerHTML = `Catalyst: <strong class="text-white">${catalyst.category}</strong> (${catalyst.bias})`;
      } else {
        macroEl.innerHTML = `Macro Sentinel: <span class="text-emerald-400">Normal Flow (Score &lt; 7)</span>`;
      }
    }

    if (dossierCont && dossierCont.innerHTML.trim() === '') {
      if (window.DeltaCoach && typeof DeltaCoach.generateOfflineSelfImprovingReport === 'function') {
        dossierCont.innerHTML = DeltaCoach.generateOfflineSelfImprovingReport(analysis, catalyst);
      }
    }
  }

  async function triggerSelfImprovingAgent() {
    if (window.DeltaCoach && typeof DeltaCoach.runSelfImprovingQuantAgent === 'function') {
      await DeltaCoach.runSelfImprovingQuantAgent('selfImprovingDossierContainer');
    }
  }

  // -------------------------------------------------------------
  // TELEGRAM INSTANT TRADE ALERTS INTEGRATION
  // -------------------------------------------------------------
  function getTelegramConfig() {
    return {
      botToken: localStorage.getItem(DeltaConfig.STORAGE_KEYS.TELEGRAM_BOT_TOKEN) || '',
      chatId: localStorage.getItem(DeltaConfig.STORAGE_KEYS.TELEGRAM_CHAT_ID) || '',
      enabled: localStorage.getItem(DeltaConfig.STORAGE_KEYS.TELEGRAM_ENABLED) === 'true'
    };
  }

  function openTelegramModal() {
    const modal = document.getElementById('telegramConfigModal');
    if (!modal) return;
    const cfg = getTelegramConfig();
    const tokenInput = document.getElementById('inputTgToken');
    const chatInput = document.getElementById('inputTgChatId');
    const toggle = document.getElementById('toggleTgEnabled');
    const statusEl = document.getElementById('tgTestStatus');

    if (tokenInput) tokenInput.value = cfg.botToken;
    if (chatInput) chatInput.value = cfg.chatId;
    if (toggle) toggle.checked = cfg.enabled;
    if (statusEl) statusEl.innerText = '';

    modal.classList.remove('hidden');
    modal.classList.add('flex');
  }

  function closeTelegramModal() {
    const modal = document.getElementById('telegramConfigModal');
    if (modal) {
      modal.classList.add('hidden');
      modal.classList.remove('flex');
    }
  }

  function saveTelegramConfig() {
    const tokenInput = document.getElementById('inputTgToken');
    const chatInput = document.getElementById('inputTgChatId');
    const toggle = document.getElementById('toggleTgEnabled');

    const token = (tokenInput?.value || '').trim();
    const chatId = (chatInput?.value || '').trim();
    const enabled = toggle ? toggle.checked : false;

    localStorage.setItem(DeltaConfig.STORAGE_KEYS.TELEGRAM_BOT_TOKEN, token);
    localStorage.setItem(DeltaConfig.STORAGE_KEYS.TELEGRAM_CHAT_ID, chatId);
    localStorage.setItem(DeltaConfig.STORAGE_KEYS.TELEGRAM_ENABLED, enabled ? 'true' : 'false');

    closeTelegramModal();
    updateTelegramBadge();
  }

  function updateTelegramBadge() {
    const badge = document.getElementById('tgStatusBadge');
    if (!badge) return;
    const cfg = getTelegramConfig();
    if (cfg.enabled && cfg.botToken && cfg.chatId) {
      badge.className = "px-2 py-0.5 rounded text-[10px] font-bold bg-[#229ED9]/20 text-[#229ED9] border border-[#229ED9]/40 flex items-center gap-1 font-mono";
      badge.innerHTML = `<span class="h-1.5 w-1.5 rounded-full bg-[#229ED9] animate-ping"></span> Telegram Active`;
    } else {
      badge.className = "hidden";
    }
  }

  async function sendTelegramMessage(textHtml) {
    const cfg = getTelegramConfig();
    if (!cfg.enabled || !cfg.botToken || !cfg.chatId) return false;

    try {
      const url = `https://api.telegram.org/bot${cfg.botToken}/sendMessage`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: cfg.chatId,
          text: textHtml,
          parse_mode: 'HTML',
          disable_web_page_preview: true
        })
      });
      return res.ok;
    } catch (e) {
      console.warn("Telegram alert notice:", e);
      return false;
    }
  }

  async function sendTestTelegramAlert() {
    const tokenInput = document.getElementById('inputTgToken');
    const chatInput = document.getElementById('inputTgChatId');
    const statusEl = document.getElementById('tgTestStatus');

    const token = (tokenInput?.value || '').trim();
    const chatId = (chatInput?.value || '').trim();

    if (!token || !chatId) {
      if (statusEl) {
        statusEl.className = "text-xs font-mono text-lossRed";
        statusEl.innerText = "Please enter both Bot Token and Chat ID first.";
      }
      return;
    }

    if (statusEl) {
      statusEl.className = "text-xs font-mono text-indigo-300";
      statusEl.innerText = "Sending test message to Telegram...";
    }

    const testMsg = `🚀 <b>Delta Trading Journal: Connected Successfully!</b>\n━━━━━━━━━━━━━━━━━━━━━━\nYour Telegram trade signal alerts are active.\nWhenever an institutional SMC reversal setup triggers on Delta Exchange India, you will receive real-time execution orders directly on your phone.\n\n⏰ <b>Time:</b> ${new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' })} IST\n🔗 <a href="https://delta-trading-journal-gmp.vercel.app/">Open Delta Live Terminal</a>`;

    try {
      const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: testMsg,
          parse_mode: 'HTML'
        })
      });

      if (res.ok) {
        if (statusEl) {
          statusEl.className = "text-xs font-mono text-winGreen font-bold";
          statusEl.innerHTML = `<i class="fa-solid fa-circle-check mr-1"></i> Success! Check your Telegram app.`;
        }
      } else {
        const errJson = await res.json();
        if (statusEl) {
          statusEl.className = "text-xs font-mono text-lossRed";
          statusEl.innerText = `Telegram Error: ${errJson.description || 'Invalid credentials'}`;
        }
      }
    } catch (err) {
      if (statusEl) {
        statusEl.className = "text-xs font-mono text-lossRed";
        statusEl.innerText = "Network error connecting to Telegram API.";
      }
    }
  }

  function checkAndSendTelegramSignal(trade) {
    if (!trade || trade.outcome !== 'ACTIVE') return;
    const lastAlertedId = localStorage.getItem('dtj_last_alerted_trade_id');
    if (lastAlertedId === trade.id) return;

    const cfg = getTelegramConfig();
    if (!cfg.enabled || !cfg.botToken || !cfg.chatId) return;

    const isCall = trade.direction === "LONG";
    const opt = trade.realOption;
    const contract = opt ? opt.symbol : (isCall ? `C-BTC-${trade.optionStrike}` : `P-BTC-${trade.optionStrike}`);
    const buyZone = opt ? opt.buyZone : `$${(trade.entryOpt || 200).toFixed(1)} - $${((trade.entryOpt || 200) * 1.05).toFixed(1)}`;
    const targetOpt = opt ? `$${opt.targetPrice.toFixed(1)} (+50%)` : '+50% Target';
    const stopOpt = opt ? `$${opt.stopPrice.toFixed(1)} (-30%)` : '-30% Stop';
    const timeStr = new Date(trade.time * 1000).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: true });

    const keyPivot = trade.rationale?.levelTested || (isCall ? `Support Pivot ($${trade.sl.toLocaleString()})` : `Resistance Pivot ($${trade.sl.toLocaleString()})`);
    const patternDetail = trade.rationale?.pattern || (isCall ? 'Bullish Lower Wick Absorption' : 'Bearish Upper Wick Rejection');
    const confirmation = trade.rationale?.confirmation || 'Confirmed candle close breaking prior bar';
    const flowRsi = trade.rsi ? `RSI ${trade.rsi}` : 'Neutral Momentum';
    const flowRvol = trade.rvol ? `${trade.rvol}x Relative Volume` : '1.2x RVOL';
    const whyEnter = isCall 
      ? 'Institutional liquidity swept below support; aggressive buyer defense confirms reversal upside.'
      : 'Institutional liquidity swept above resistance; sellers absorbing bids confirms rejection downside.';

    const msg = `⚡ <b>DELTA INDIA SMC TRADE SIGNAL</b>
━━━━━━━━━━━━━━━━━━━━━━
🎯 <b>Action:</b> ${isCall ? '🟢 BUY CALL OPTION' : '🔴 BUY PUT OPTION'}
📌 <b>Setup Pattern:</b> ${trade.name}
🏷️ <b>Delta Contract:</b> <code>${contract}</code>

💵 <b>Recommended Buy Zone:</b> <b>${buyZone}</b>
🎯 <b>Option Target (+50%):</b> <b>${targetOpt}</b>
🛑 <b>Option Stop Loss (-30%):</b> <b>${stopOpt}</b>

📊 <b>Underlying BTC Spot:</b>
• Entry Trigger: $${trade.entry.toLocaleString()}
• Take Profit: $${trade.tp.toLocaleString()} (+${trade.targetDist} pts)
• Invalidation Stop: $${trade.sl.toLocaleString()} (-${trade.slDist} pts)
• Risk-to-Reward: 1 : ${trade.rrRatio}

🧠 <b>Trade Logic & Institutional Confluence:</b>
• <b>Key Pivot Level:</b> ${keyPivot}
• <b>Price Action:</b> ${patternDetail}
• <b>Confirmation:</b> ${confirmation}
• <b>Order Flow & Volume:</b> ${flowRsi} | ${flowRvol}
• <b>Execution Logic:</b> ${whyEnter}

⏰ <b>Triggered:</b> ${timeStr} IST
🔗 <a href="https://delta-trading-journal-gmp.vercel.app/">View Live Position on Delta Terminal</a>`;

    sendTelegramMessage(msg).then(ok => {
      if (ok) {
        localStorage.setItem('dtj_last_alerted_trade_id', trade.id);
        console.log(`[Telegram] Signal alert dispatched for ${trade.id} (${contract})`);
      }
    });
  }

  function checkAndSendTelegramOutcome(trade, allTrades) {
    if (!trade || trade.outcome === 'ACTIVE') return;

    // Only send outcome alert if this trade was actually signaled as an active trade on Telegram!
    const lastAlertedId = localStorage.getItem('dtj_last_alerted_trade_id');
    if (lastAlertedId !== trade.id) return;

    // Check if we already alerted this outcome
    let sentOutcomes = [];
    try {
      sentOutcomes = JSON.parse(localStorage.getItem('dtj_sent_outcome_alerts') || '[]');
    } catch (e) {}

    if (sentOutcomes.includes(trade.id)) return;

    const cfg = getTelegramConfig();
    if (!cfg.enabled || !cfg.botToken || !cfg.chatId) return;

    const isWin = trade.outcome === 'WIN';
    const isLoss = trade.outcome === 'LOSS';
    const isTimeout = trade.outcome === 'TIMEOUT';
    const isCall = trade.direction === "LONG";
    const opt = trade.realOption;
    const contract = opt ? opt.symbol : (isCall ? `C-BTC-${trade.optionStrike}` : `P-BTC-${trade.optionStrike}`);
    const entryOpt = (opt && opt.entryPrice) ? opt.entryPrice : (trade.entryOpt || 220);
    const exitOpt = (opt && opt.targetPrice && isWin) 
      ? opt.targetPrice 
      : ((opt && opt.stopPrice && isLoss) ? opt.stopPrice : (trade.exitOpt || entryOpt));

    const pnlPts = isWin ? (exitOpt - entryOpt) : (isLoss ? (exitOpt - entryOpt) : ((exitOpt - entryOpt) || -15));
    const pnlSign = pnlPts >= 0 ? '+' : '';

    // Calculate Today's Daily Trade Counter (Strictly in IST / Asia/Kolkata)
    const todayIST = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
    const todayTrades = (allTrades || []).filter(t => {
      const tDate = new Date(t.time * 1000).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
      return tDate === todayIST;
    });

    const todayTotal = todayTrades.length;
    const todayWins = todayTrades.filter(t => t.outcome === 'WIN').length;
    const todayLosses = todayTrades.filter(t => t.outcome === 'LOSS').length;
    const todayTimeouts = todayTrades.filter(t => t.outcome === 'TIMEOUT').length;
    const resolvedCount = todayWins + todayLosses;
    const todayWinRate = resolvedCount > 0 ? Math.round((todayWins / resolvedCount) * 100) : 0;

    let todayNetPts = 0;
    todayTrades.forEach(t => {
      if (t.outcome === 'WIN') todayNetPts += (t.optNetGainPts || 100);
      else if (t.outcome === 'LOSS') todayNetPts -= (t.entryOpt * 0.3 || 66);
      else if (t.outcome === 'TIMEOUT') todayNetPts -= 15;
    });

    const todayDateFormatted = new Date().toLocaleDateString('en-IN', {
      timeZone: 'Asia/Kolkata',
      day: 'numeric',
      month: 'short',
      year: 'numeric'
    });

    const msg = `${isWin ? '🎯 <b>TRADE RESOLUTION: TAKE PROFIT HIT! (+50%)</b>' : (isLoss ? '🛑 <b>TRADE RESOLUTION: STOP LOSS HIT (-30%)</b>' : '⏳ <b>TRADE RESOLUTION: TIMEOUT (SCRATCH)</b>')}
━━━━━━━━━━━━━━━━━━━━━━
📌 <b>Setup Pattern:</b> ${trade.name}
🏷️ <b>Delta Contract:</b> <code>${contract}</code>
🏁 <b>Official Outcome:</b> <b>${isWin ? '✅ WIN (+50% Gross / +40% Net Take-Home)' : (isLoss ? '❌ STOP LOSS (-30% / -1R Controlled Exit)' : '⚠️ TIMEOUT (5h Breakeven Scratch)')}</b>

💵 <b>Option Entry:</b> $${entryOpt.toFixed(1)}
🏁 <b>Option Exit:</b> $${exitOpt.toFixed(1)} (${pnlSign}${pnlPts.toFixed(1)} pts)
📊 <b>Spot Price Move:</b> $${trade.entry.toLocaleString()} ➔ $${(trade.exitPrice || trade.tp).toLocaleString()}

📊 <b>TODAY\'S DAILY TRADE COUNTER (IST):</b>
• Total Setups Today (${todayDateFormatted}): <b>${todayTotal}</b>
• Today\'s Record: <b>${todayWins} Wins | ${todayLosses} Losses | ${todayTimeouts} Timeouts</b>
• Today\'s Win Rate: <b>${todayWinRate}%</b>
• Today\'s Option Net: <b>${todayNetPts >= 0 ? '+' : ''}${todayNetPts.toFixed(1)} pts</b>

⏰ <b>Resolution Time:</b> ${new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: true })} IST
🔗 <a href="https://delta-trading-journal-gmp.vercel.app/">View Complete Performance Audit Log</a>`;

    sendTelegramMessage(msg).then(ok => {
      if (ok) {
        sentOutcomes.push(trade.id);
        localStorage.setItem('dtj_sent_outcome_alerts', JSON.stringify(sentOutcomes.slice(-50)));
        localStorage.removeItem('dtj_locked_active_plan');
        console.log(`[Telegram] Outcome alert dispatched for ${trade.id} (${trade.outcome})`);
      }
    });
  }

  function initSwipeNavigation() {
    let touchStartX = 0;
    let touchStartY = 0;

    document.addEventListener('touchstart', (e) => {
      if (e.touches.length !== 1) return;
      // Do not initiate tab swipe if touching the chart canvas, modals, tables, or scrollable containers
      if (e.target.closest('#tvLiveChartContainer') || e.target.closest('#tvPositionBoxSvg') || e.target.closest('#algoTradeModal') || e.target.closest('.tv-lightweight-charts') || e.target.closest('.overflow-x-auto') || e.target.closest('table')) {
        touchStartX = 0;
        touchStartY = 0;
        return;
      }
      touchStartX = e.touches[0].clientX;
      touchStartY = e.touches[0].clientY;
    }, { passive: true });

    document.addEventListener('touchend', (e) => {
      if (e.changedTouches.length !== 1 || touchStartX === 0) return;

      const drawerOpen = document.getElementById('tradeDrawer')?.classList.contains('drawer-open');
      const settingsOpen = !document.getElementById('ghSettingsModal')?.classList.contains('opacity-0');
      const algoModalOpen = !document.getElementById('algoTradeModal')?.classList.contains('hidden');
      const tag = (e.target.tagName || '').toLowerCase();
      if (drawerOpen || settingsOpen || algoModalOpen || tag === 'input' || tag === 'textarea' || tag === 'select') return;

      // Never switch tabs if touching within the Coach / Live Chart tab, interactive components, tables, or scrollable elements
      if (currentMainTab === 'COACH' || e.target.closest('#mainTab_COACH') || e.target.closest('#tvLiveChartContainer') || e.target.closest('#tvPositionBoxSvg') || e.target.closest('.tv-lightweight-charts') || e.target.closest('.overflow-x-auto') || e.target.closest('table')) return;

      const dx = e.changedTouches[0].clientX - touchStartX;
      const dy = e.changedTouches[0].clientY - touchStartY;

      if (Math.abs(dx) > 70 && Math.abs(dx) > Math.abs(dy) * 1.8) {
        if (dx < 0) {
          // Swipe Left -> Next Tab
          if (currentMainTab === 'INSIGHTS') switchMainTab('CALCULATOR');
          else if (currentMainTab === 'CALCULATOR') switchMainTab('COACH');
        } else {
          // Swipe Right -> Prev Tab
          if (currentMainTab === 'COACH') switchMainTab('CALCULATOR');
          else if (currentMainTab === 'CALCULATOR') switchMainTab('INSIGHTS');
        }
      }
    }, { passive: true });
  }

  // -------------------------------------------------------------
  // 3. FILTERING & KPI RESOLUTION
  // -------------------------------------------------------------
  function setPreset(preset) {
    currentPreset = preset;
    ['CURRENT_MONTH', 'CUSTOM', 'ALL_TIME'].forEach(p => {
      const btn = document.getElementById(`btn_${p}`);
      if (!btn) return;
      if (p === preset) {
        btn.className = "flex-1 sm:flex-none px-3 py-1.5 text-xs font-semibold rounded-lg transition-colors bg-indigo-600 text-white text-center";
      } else {
        btn.className = "flex-1 sm:flex-none px-3 py-1.5 text-xs font-semibold rounded-lg transition-colors text-slate-400 hover:text-white text-center";
      }
    });

    const customBox = document.getElementById('customDateContainer');
    if (customBox) {
      if (preset === 'CUSTOM') {
        customBox.classList.remove('hidden');
        customBox.classList.add('flex');
      } else {
        customBox.classList.add('hidden');
        customBox.classList.remove('flex');
      }
    }

    applyGlobalFilter();
  }

  function resolveFilterBounds() {
    const allTrades = DeltaDB.getTrades();
    let refYear = new Date().getFullYear();
    let refMonth = new Date().getMonth();

    if (allTrades.length > 0) {
      const latestMonthParts = allTrades[0].monthKey.split('-');
      refYear = parseInt(latestMonthParts[0]);
      refMonth = parseInt(latestMonthParts[1]) - 1;
    }

    let startDate = "", endDate = "", isSingleMonth = false, targetMonthStr = "", displayLabel = "";

    if (currentPreset === 'CURRENT_MONTH') {
      isSingleMonth = true;
      targetMonthStr = `${refYear}-${String(refMonth + 1).padStart(2, '0')}`;
      startDate = `${targetMonthStr}-01`;
      endDate = `${targetMonthStr}-${String(new Date(refYear, refMonth + 1, 0).getDate()).padStart(2, '0')}`;
      displayLabel = new Date(refYear, refMonth, 1).toLocaleString('default', { month: 'long', year: 'numeric' });
    } else if (currentPreset === 'CUSTOM') {
      startDate = document.getElementById('customStartDate')?.value || "2024-01-01";
      endDate = document.getElementById('customEndDate')?.value || "2030-12-31";
      displayLabel = `${startDate} to ${endDate}`;
      const diffDays = Math.ceil(Math.abs(new Date(endDate) - new Date(startDate)) / (1000 * 60 * 60 * 24));
      if (diffDays <= 31 && startDate.slice(0, 7) === endDate.slice(0, 7)) {
        isSingleMonth = true;
        targetMonthStr = startDate.slice(0, 7);
      }
    } else {
      startDate = "2020-01-01";
      endDate = "2030-12-31";
      displayLabel = "All-Time";
    }

    return { startDate, endDate, isSingleMonth, targetMonthStr, displayLabel };
  }

  function applyGlobalFilter() {
    const allTrades = DeltaDB.getTrades();
    if (!allTrades || allTrades.length === 0) return;

    const { startDate, endDate, isSingleMonth, targetMonthStr, displayLabel } = resolveFilterBounds();

    currentFilteredTrades = allTrades.filter(t => t.rawDate >= startDate && t.rawDate <= endDate);
    currentTradePage = 1;

    // Use DeltaQuant for exact calculations
    const metrics = DeltaQuant.calculateMetrics(currentFilteredTrades);

    // Update KPI Scorecard
    const grossEl = document.getElementById('kpiGross');
    const netEl = document.getElementById('kpiNet');
    const brokEl = document.getElementById('kpiBrokerage');
    const gstEl = document.getElementById('kpiGst');
    const feeSubEl = document.getElementById('kpiTotalFeeSub');
    const winRateEl = document.getElementById('kpiWinRate');
    const tradeCountEl = document.getElementById('kpiTradeCount');
    const activityEl = document.getElementById('kpiActivity');

    if (grossEl) {
      grossEl.innerText = formatUSD(metrics.grossPnl);
      grossEl.className = `text-base font-bold font-mono ${metrics.grossPnl >= 0 ? 'text-winGreen' : 'text-lossRed'}`;
    }
    if (netEl) {
      netEl.innerText = formatUSD(metrics.netPnl);
      netEl.className = `text-base font-bold font-mono ${metrics.netPnl >= 0 ? 'text-winGreen' : 'text-lossRed'}`;
    }
    if (brokEl) brokEl.innerText = formatUSD(metrics.baseBrokerage);
    if (gstEl) gstEl.innerText = formatUSD(metrics.gst);
    if (feeSubEl) feeSubEl.innerText = `Total Fee: ${formatUSD(metrics.totalFee)} (${metrics.feeDragPct}% drag)`;
    if (winRateEl) winRateEl.innerText = `${metrics.winRate}%`;
    if (tradeCountEl) tradeCountEl.innerText = `${metrics.tradeCount} closed positions`;
    if (activityEl) activityEl.innerText = displayLabel;

    // Tier 2: Institutional Edge & Risk Metrics (Idea 3)
    const pfEl = document.getElementById('kpiProfitFactor');
    const rrEl = document.getElementById('kpiRealizedRR');
    const ddEl = document.getElementById('kpiMaxDrawdown');
    const avgWlEl = document.getElementById('kpiAvgWinLoss');

    if (pfEl) {
      pfEl.innerText = metrics.profitFactor >= 99 ? '∞' : metrics.profitFactor.toFixed(2);
      pfEl.className = `text-sm sm:text-base font-bold font-mono ${metrics.profitFactor >= 1.5 ? 'text-winGreen' : (metrics.profitFactor < 1 ? 'text-lossRed' : 'text-white')}`;
    }
    if (rrEl) {
      rrEl.innerText = metrics.realizedRR >= 99 ? '∞' : `1 : ${metrics.realizedRR.toFixed(2)}`;
    }
    if (ddEl) {
      ddEl.innerText = formatUSD(metrics.maxDrawdown);
    }
    if (avgWlEl) {
      avgWlEl.innerText = `+${formatUSD(metrics.avgWin)} / -${formatUSD(metrics.avgLoss)}`;
    }

    // Call/Put metrics
    let callPnl = 0, putPnl = 0, callTrades = 0, putTrades = 0;
    currentFilteredTrades.forEach(t => {
      if (t.isCall) { callPnl += t.gross_pnl; callTrades++; }
      else { putPnl += t.gross_pnl; putTrades++; }
    });

    renderTrajectoryChart(currentFilteredTrades, isSingleMonth);
    renderInstrumentCharts(callPnl, putPnl, callTrades, putTrades);
    renderMiddleSection(isSingleMonth, targetMonthStr, startDate, endDate, displayLabel);
    renderSessionAndDayMatrix(currentFilteredTrades);
    renderHoldDurationDiagnostic(currentFilteredTrades);
    renderRiskSentinel(allTrades);
    renderPaginatedTrades();

    // If Coach Tab is active, re-render it
    if (currentMainTab === 'COACH') {
      renderCoachTab();
    }
  }

  // -------------------------------------------------------------
  // 4. CHARTS & CALENDAR RENDERING
  // -------------------------------------------------------------
  function renderTrajectoryChart(trades, isSingleMonth) {
    const chronological = [...trades].sort((a, b) => a.sortTime - b.sortTime);
    const cat = [], netSeries = [], grossSeries = [];
    let runningNet = 0, runningGross = 0;

    if (isSingleMonth) {
      const dailyAgg = {};
      chronological.forEach(t => {
        if (!dailyAgg[t.rawDate]) dailyAgg[t.rawDate] = { net: 0, gross: 0 };
        dailyAgg[t.rawDate].net += t.net_pnl;
        dailyAgg[t.rawDate].gross += t.gross_pnl;
      });
      Object.keys(dailyAgg).sort().forEach(day => {
        runningNet += dailyAgg[day].net;
        runningGross += dailyAgg[day].gross;
        cat.push(day.slice(8));
        netSeries.push(Number(runningNet.toFixed(2)));
        grossSeries.push(Number(runningGross.toFixed(2)));
      });
    } else {
      const monthlyAgg = {};
      chronological.forEach(t => {
        if (!monthlyAgg[t.monthKey]) monthlyAgg[t.monthKey] = { net: 0, gross: 0 };
        monthlyAgg[t.monthKey].net += t.net_pnl;
        monthlyAgg[t.monthKey].gross += t.gross_pnl;
      });
      Object.keys(monthlyAgg).sort().forEach(month => {
        runningNet += monthlyAgg[month].net;
        runningGross += monthlyAgg[month].gross;
        cat.push(new Date(month + "-01").toLocaleString('default', { month: 'short', year: '2-digit' }));
        netSeries.push(Number(runningNet.toFixed(2)));
        grossSeries.push(Number(runningGross.toFixed(2)));
      });
    }

    const chartEl = document.querySelector("#equityChart");
    if (!chartEl) return;

    if (apexChartInstance) apexChartInstance.destroy();
    apexChartInstance = new ApexCharts(chartEl, {
      series: [{ name: 'Net Take-Home', data: netSeries }, { name: 'Gross Outcome', data: grossSeries }],
      chart: { type: 'area', height: 260, width: '100%', background: 'transparent', toolbar: { show: false }, zoom: { enabled: false } },
      dataLabels: { enabled: false },
      markers: { size: 3, strokeWidth: 0, hover: { size: 5 } },
      colors: ['#10b981', '#6366f1'],
      stroke: { curve: 'smooth', width: 2 },
      fill: { type: 'gradient', gradient: { shadeIntensity: 1, opacityFrom: 0.25, opacityTo: 0.0 } },
      xaxis: { categories: cat, labels: { style: { colors: '#64748b', fontSize: '9px' }, hideOverlappingLabels: true } },
      yaxis: { labels: { style: { colors: '#64748b', fontSize: '10px' }, formatter: (v) => compactUSD(v) } },
      grid: { padding: { left: 10, right: 10 }, borderColor: '#1e293b', strokeDashArray: 3 },
      tooltip: { theme: 'dark' }
    });
    apexChartInstance.render();
  }

  function renderInstrumentCharts(callPnl, putPnl, callTrades, putTrades) {
    const pnlContainer = document.querySelector("#callPutChart");
    const countContainer = document.querySelector("#buySellChart");
    if (!pnlContainer || !countContainer) return;

    const pnlOpts = {
      chart: { type: 'bar', height: 180, background: 'transparent', toolbar: { show: false } },
      series: [{ name: 'Gross PnL', data: [Number(callPnl.toFixed(2)), Number(putPnl.toFixed(2))] }],
      xaxis: { categories: ['Calls', 'Puts'], labels: { style: { colors: '#94a3b8', fontSize: '10px' } }, axisBorder: { show: false }, axisTicks: { show: false } },
      yaxis: { labels: { style: { colors: '#94a3b8', fontSize: '10px' }, formatter: (v) => compactUSD(v) } },
      colors: [function({ value }) { return value >= 0 ? '#10b981' : '#f43f5e'; }],
      plotOptions: { bar: { borderRadius: 4, columnWidth: '40%', distributed: true } },
      dataLabels: { enabled: false },
      legend: { show: false },
      grid: { borderColor: '#1e293b', strokeDashArray: 3 },
      tooltip: { theme: 'dark', y: { formatter: (v) => formatUSD(v) } }
    };

    if (callPutChart) callPutChart.destroy();
    callPutChart = new ApexCharts(pnlContainer, pnlOpts);
    callPutChart.render();

    const countOpts = {
      chart: { type: 'donut', height: 180, background: 'transparent' },
      plotOptions: {
        pie: {
          donut: {
            size: '75%',
            labels: {
              show: true,
              value: { color: '#fff', fontSize: '16px' },
              total: { show: true, color: '#94a3b8', label: 'Trades', formatter: (w) => w.globals.seriesTotals.reduce((a, b) => a + b, 0) }
            }
          }
        }
      },
      stroke: { show: false },
      dataLabels: { enabled: false },
      legend: { show: false },
      tooltip: { theme: 'dark' },
      series: [callTrades, putTrades],
      labels: ['Calls', 'Puts'],
      colors: ['#6366f1', '#f59e0b']
    };

    if (buySellChart) buySellChart.destroy();
    buySellChart = new ApexCharts(countContainer, countOpts);
    buySellChart.render();
  }

  function renderMiddleSection(isSingleMonth, targetMonthStr, startDate, endDate, displayLabel) {
    const container = document.getElementById('middleSectionContainer');
    const badge = document.getElementById('calendarBadge');
    if (!container) return;
    if (badge) badge.innerText = displayLabel;

    const dailyMap = DeltaDB.getDailyMap();
    const monthlyMap = DeltaDB.getMonthlyMap();

    if (isSingleMonth && targetMonthStr) {
      document.getElementById('middleSectionTitle').innerText = `Daily Journal Calendar`;
      document.getElementById('middleSectionSubtitle').innerText = `7-Day week on Mobile • 10-Column compact grid on Desktop`;

      const parts = targetMonthStr.split('-');
      const year = parseInt(parts[0]), month = parseInt(parts[1]) - 1;
      const firstDayOfWeek = new Date(year, month, 1).getDay();
      const daysInMonth = new Date(year, month + 1, 0).getDate();

      let calHTML = `
        <div class="w-full max-w-5xl mx-auto">
          <div class="grid grid-cols-7 sm:hidden gap-1.5 mb-1.5 text-center text-[9px] font-semibold text-slate-400 uppercase tracking-wider">
            <div>Sun</div><div>Mon</div><div>Tue</div><div>Wed</div><div>Thu</div><div>Fri</div><div>Sat</div>
          </div>
          <div class="hidden sm:grid sm:grid-cols-10 gap-2 mb-1.5 text-center text-[10px] font-semibold text-slate-400 uppercase tracking-wider">
            <div>D1</div><div>D2</div><div>D3</div><div>D4</div><div>D5</div><div>D6</div><div>D7</div><div>D8</div><div>D9</div><div>D10</div>
          </div>
          <div class="grid grid-cols-7 sm:grid-cols-10 gap-1.5 sm:gap-2">`;

      for (let i = 0; i < firstDayOfWeek; i++) {
        calHTML += `<div class="sm:hidden aspect-square rounded-lg border border-borderDark/30 bg-brandDark/20"></div>`;
      }

      for (let day = 1; day <= daysInMonth; day++) {
        const fullDateKey = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        const dayData = dailyMap[fullDateKey];

        if (dayData && dayData.trades > 0) {
          const isWin = dayData.net_pnl >= 0;
          const cardBorder = isWin ? 'bg-winGreen/10 border-winGreen/40 text-winGreen' : 'bg-lossRed/10 border-lossRed/40 text-lossRed';

          calHTML += `
            <div class="relative aspect-square rounded-lg border ${cardBorder} flex flex-col justify-center items-center cursor-pointer transition-transform active:scale-95 no-select"
                 onmouseenter="DeltaApp.showPeek('${fullDateKey}')" onmouseleave="DeltaApp.hidePeek()" ontouchstart="DeltaApp.showPeek('${fullDateKey}')" ontouchend="DeltaApp.hidePeek()">
              <span class="absolute top-1 left-1.5 text-[9px] font-bold text-white/80 pointer-events-none">${day}</span>
              <span class="absolute top-1 right-1.5 px-1 rounded bg-brandDark/60 text-[7px] font-mono text-slate-300 hidden sm:block pointer-events-none">${dayData.trades}t</span>
              <div class="text-[9px] sm:text-xs font-bold font-mono mt-2 pointer-events-none">${isWin ? '+' : ''}${compactUSD(dayData.net_pnl)}</div>
            </div>`;
        } else {
          calHTML += `<div class="relative aspect-square rounded-lg border border-borderDark/40 bg-panelDark/25 flex flex-col justify-center items-center"><span class="absolute top-1 left-1.5 text-[9px] font-bold text-slate-600">${day}</span></div>`;
        }
      }
      container.innerHTML = calHTML + `</div></div>`;
    } else {
      document.getElementById('middleSectionTitle').innerText = `Monthly Performance Overview`;
      document.getElementById('middleSectionSubtitle').innerText = `Aggregated monthly cashflows and net trajectory`;

      const matchingMonths = Object.keys(monthlyMap).filter(m => `${m}-01` >= startDate.slice(0, 7) && `${m}-01` <= endDate.slice(0, 7)).sort().reverse();
      if (matchingMonths.length === 0) return container.innerHTML = `<div class="p-8 text-center text-slate-500 text-xs">No trade history found.</div>`;

      let gridHTML = `<div class="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-2.5 sm:gap-3">`;
      matchingMonths.forEach(mKey => {
        const mData = monthlyMap[mKey];
        gridHTML += `
          <div class="border border-borderDark bg-panelDark/40 p-3 rounded-xl flex flex-col justify-between">
            <div class="flex justify-between items-center mb-1.5">
              <span class="font-bold text-xs sm:text-sm text-white">${new Date(mKey + "-01").toLocaleString('default', { month: 'short', year: '2-digit' })}</span>
              <span class="text-[9px] px-1.5 py-0.5 rounded bg-cardDark text-slate-400 border border-borderDark">${mData.trades}t</span>
            </div>
            <div class="my-1.5">
              <span class="text-[9px] text-slate-400 block uppercase">Net Profit</span>
              <h4 class="text-sm sm:text-base font-bold font-mono ${mData.net_pnl >= 0 ? 'text-winGreen' : 'text-lossRed'}">${mData.net_pnl >= 0 ? '+' : ''}${formatUSD(mData.net_pnl)}</h4>
            </div>
            <div class="flex justify-between items-center pt-1.5 border-t border-borderDark/60 text-[9px] text-slate-400 font-mono">
              <span>Gross: ${compactUSD(mData.gross_pnl)}</span>
              <span class="text-lossRed">Fee: ${compactUSD(mData.total_fee)}</span>
            </div>
          </div>`;
      });
      container.innerHTML = gridHTML + `</div>`;
    }
  }

  // -------------------------------------------------------------
  // 4b. MARKET SESSION & DAY-OF-WEEK EDGE MATRIX (IDEA 6)
  // -------------------------------------------------------------
  function renderSessionAndDayMatrix(trades) {
    const dayContainer = document.getElementById('dayOfWeekContainer');
    const sessionContainer = document.getElementById('marketSessionContainer');
    if (!dayContainer || !sessionContainer) return;

    if (!trades || trades.length === 0) {
      dayContainer.innerHTML = `<div class="col-span-full text-center py-4 text-slate-500 text-xs font-sans">No trades recorded in this period.</div>`;
      sessionContainer.innerHTML = `<div class="col-span-full text-center py-4 text-slate-500 text-xs font-sans">No trades recorded in this period.</div>`;
      return;
    }

    const dayMap = {
      'Mon': { name: 'Monday', trades: 0, wins: 0, netPnl: 0 },
      'Tue': { name: 'Tuesday', trades: 0, wins: 0, netPnl: 0 },
      'Wed': { name: 'Wednesday', trades: 0, wins: 0, netPnl: 0 },
      'Thu': { name: 'Thursday', trades: 0, wins: 0, netPnl: 0 },
      'Fri': { name: 'Friday', trades: 0, wins: 0, netPnl: 0 },
      'Sat': { name: 'Saturday', trades: 0, wins: 0, netPnl: 0 },
      'Sun': { name: 'Sunday', trades: 0, wins: 0, netPnl: 0 }
    };

    const sessionMap = {
      'Asian': { name: 'Asian Morning (09-14 IST)', trades: 0, wins: 0, netPnl: 0, icon: 'fa-sun text-amber-400' },
      'London': { name: 'London Open (14-18 IST)', trades: 0, wins: 0, netPnl: 0, icon: 'fa-landmark text-sky-400' },
      'NY': { name: 'NY Evening (18-24 IST)', trades: 0, wins: 0, netPnl: 0, icon: 'fa-bolt text-indigo-400' },
      'Night': { name: 'Overnight (00-09 IST)', trades: 0, wins: 0, netPnl: 0, icon: 'fa-moon text-indigo-300' }
    };

    const DAY_KEYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

    trades.forEach(t => {
      const d = new Date(t.sortTime || t.closed_at || t.rawDate);
      const dayKey = DAY_KEYS[d.getDay()] || 'Mon';
      const hour = d.getHours();

      const net = t.net_pnl || 0;
      const isWin = net > 0.0001;

      if (dayMap[dayKey]) {
        dayMap[dayKey].trades++;
        if (isWin) dayMap[dayKey].wins++;
        dayMap[dayKey].netPnl += net;
      }

      let sessKey = 'Night';
      if (hour >= 9 && hour < 14) sessKey = 'Asian';
      else if (hour >= 14 && hour < 18) sessKey = 'London';
      else if (hour >= 18 && hour < 24) sessKey = 'NY';

      if (sessionMap[sessKey]) {
        sessionMap[sessKey].trades++;
        if (isWin) sessionMap[sessKey].wins++;
        sessionMap[sessKey].netPnl += net;
      }
    });

    // Render Days of Week
    const activeDays = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    dayContainer.innerHTML = activeDays.map(k => {
      const data = dayMap[k];
      const winRate = data.trades > 0 ? Math.round((data.wins / data.trades) * 100) : 0;
      const pnlColor = data.netPnl > 0 ? 'text-winGreen' : (data.netPnl < 0 ? 'text-lossRed' : 'text-slate-400');
      const badgeBorder = data.netPnl > 0 ? 'border-emerald-500/20 bg-emerald-500/5' : (data.netPnl < 0 ? 'border-rose-500/20 bg-rose-500/5' : 'border-borderDark/40 bg-panelDark/30');

      return `
        <div class="p-2.5 rounded-xl border ${badgeBorder} flex flex-col justify-between font-mono">
          <div class="flex justify-between items-center text-[10px]">
            <span class="font-bold text-slate-300 font-sans">${k}</span>
            <span class="text-[9px] text-slate-400">${data.trades} tr</span>
          </div>
          <div class="mt-1 flex items-baseline justify-between">
            <span class="text-xs font-bold ${pnlColor}">${data.netPnl >= 0 ? '+' : ''}${formatUSD(data.netPnl)}</span>
            <span class="text-[9px] text-indigo-300 font-bold">${data.trades > 0 ? winRate + '%' : '--'}</span>
          </div>
        </div>
      `;
    }).join('');

    // Render Market Sessions
    const sessKeys = ['Asian', 'London', 'NY', 'Night'];
    sessionContainer.innerHTML = sessKeys.map(k => {
      const data = sessionMap[k];
      const winRate = data.trades > 0 ? Math.round((data.wins / data.trades) * 100) : 0;
      const pnlColor = data.netPnl > 0 ? 'text-winGreen' : (data.netPnl < 0 ? 'text-lossRed' : 'text-slate-400');
      const isPrime = k === 'NY'; // High-volatility session for Delta BTC options

      return `
        <div class="p-3 rounded-xl border ${isPrime ? 'border-indigo-500/30 bg-indigo-950/20' : 'border-borderDark/60 bg-panelDark/40'} flex flex-col justify-between gap-1 font-mono">
          <div class="flex justify-between items-start">
            <div class="flex items-center gap-1.5 text-xs font-bold text-white font-sans">
              <i class="fa-solid ${data.icon}"></i> ${data.name}
            </div>
            ${isPrime ? '<span class="text-[8px] uppercase tracking-wider font-bold px-1.5 py-0.5 rounded bg-indigo-500/20 text-indigo-300 border border-indigo-500/30 font-sans">Delta Peak</span>' : ''}
          </div>
          <div class="flex justify-between items-end mt-1">
            <div>
              <span class="text-[9px] text-slate-400 block font-sans">Net PnL</span>
              <span class="text-xs sm:text-sm font-bold ${pnlColor}">${data.netPnl >= 0 ? '+' : ''}${formatUSD(data.netPnl)}</span>
            </div>
            <div class="text-right">
              <span class="text-[9px] text-slate-400 block font-sans">${data.trades} trades</span>
              <span class="text-xs font-bold text-indigo-300">${data.trades > 0 ? winRate + '% win' : '--'}</span>
            </div>
          </div>
        </div>
      `;
    }).join('');
  }

  // -------------------------------------------------------------
  // 4c. CAPITAL DEFENSE SENTINEL & TILT BREAKER ALERT (FEATURE 4)
  // -------------------------------------------------------------
  function renderRiskSentinel(allTrades) {
    const container = document.getElementById('riskSentinelContainer');
    if (!container) return;

    if (!allTrades || allTrades.length === 0) {
      container.innerHTML = '';
      return;
    }

    const savedMaxLoss = parseFloat(localStorage.getItem(DeltaConfig.STORAGE_KEYS.MAX_DAILY_LOSS)) || 200;
    const savedMaxConsec = parseInt(localStorage.getItem(DeltaConfig.STORAGE_KEYS.MAX_CONSEC_LOSSES), 10) || 2;
    const isAcknowledged = localStorage.getItem(DeltaConfig.STORAGE_KEYS.SENTINEL_ACKNOWLEDGED) === 'true';

    // Sentinel strictly audits TODAY'S live trading session
    const todayIst = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }); // YYYY-MM-DD
    const todayTrades = allTrades.filter(t => t.rawDate === todayIst);

    // If NO trades were taken today: clean slate, 100% risk budget available, zero warnings!
    if (todayTrades.length === 0) {
      container.innerHTML = `
        <div class="rounded-2xl border border-emerald-500/30 bg-gradient-to-r from-cardDark via-brandDark to-cardDark p-4 sm:p-5 shadow-lg shadow-black/40">
          <div class="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-2 pb-3 border-b border-borderDark/60">
            <div class="flex items-center gap-2.5">
              <span class="inline-block w-2.5 h-2.5 rounded-full bg-emerald-400 animate-pulse shrink-0"></span>
              <div>
                <h3 class="text-sm sm:text-base font-bold text-white font-sans flex items-center gap-2">
                  <i class="fa-solid fa-shield-halved text-emerald-400"></i>
                  Capital Defense Sentinel: <span class="text-emerald-400 font-bold">READY (Zero Trades Today)</span>
                </h3>
                <p class="text-[11px] text-slate-400 font-mono">
                  Today (${todayIst}): Clean slate. Full daily risk budget intact.
                </p>
              </div>
            </div>
            <div class="flex items-center gap-2 self-end sm:self-auto">
              <span class="text-[10px] font-mono text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 px-2 py-0.5 rounded font-bold">
                Daily Loss Limit: $${savedMaxLoss} | Stop-Outs: ${savedMaxConsec}
              </span>
              <button onclick="DeltaApp.openSentinelConfigModal()" class="px-2.5 py-1 text-[11px] font-bold rounded-lg bg-panelDark hover:bg-cardDark text-slate-300 hover:text-white border border-borderDark transition-colors">
                <i class="fa-solid fa-gear mr-1"></i> Edit Limits
              </button>
            </div>
          </div>

          <!-- Standby Metrics Grid -->
          <div class="grid grid-cols-2 sm:grid-cols-4 gap-2.5 mt-3 font-mono">
            <div class="bg-panelDark/50 border border-borderDark/60 p-2.5 rounded-xl">
              <span class="text-[9px] uppercase tracking-wider text-slate-400 block font-sans">Today's Realized</span>
              <span class="text-sm sm:text-base font-bold text-white">$0.00</span>
              <span class="text-[9px] text-slate-500 block mt-0.5">0 closed positions</span>
            </div>
            <div class="bg-panelDark/50 border border-borderDark/60 p-2.5 rounded-xl">
              <span class="text-[9px] uppercase tracking-wider text-slate-400 block font-sans">Available Risk Budget</span>
              <span class="text-sm sm:text-base font-bold text-emerald-300">$${savedMaxLoss}.00</span>
              <span class="text-[9px] text-slate-500 block mt-0.5">100% budget intact</span>
            </div>
            <div class="bg-panelDark/50 border border-borderDark/60 p-2.5 rounded-xl">
              <span class="text-[9px] uppercase tracking-wider text-slate-400 block font-sans">Consecutive Losses</span>
              <span class="text-sm sm:text-base font-bold text-slate-300">0 / ${savedMaxConsec}</span>
              <span class="text-[9px] text-slate-500 block mt-0.5">${savedMaxConsec} stop-outs allowed</span>
            </div>
            <div class="bg-panelDark/50 border border-borderDark/60 p-2.5 rounded-xl">
              <span class="text-[9px] uppercase tracking-wider text-slate-400 block font-sans">Desk Status</span>
              <span class="text-sm sm:text-base font-bold text-emerald-400">CLEAN SLATE</span>
              <span class="text-[9px] text-slate-500 block mt-0.5">Wait for A+ 15m S/R confirmation</span>
            </div>
          </div>
        </div>
      `;
      return;
    }

    // Today has trades: evaluate chronological loss streak and today's Net PnL
    const chronological = [...todayTrades].sort((a, b) => (a.sortTime || 0) - (b.sortTime || 0));
    let netPnl = 0;
    let wins = 0;
    let losses = 0;
    let consecutiveLosses = 0;

    chronological.forEach(t => {
      const pnl = t.net_pnl || 0;
      netPnl += pnl;
      if (pnl > 0.0001) {
        wins++;
        consecutiveLosses = 0;
      } else if (pnl < -0.0001) {
        losses++;
        consecutiveLosses++;
      }
    });

    const isBreakerHit = (netPnl <= -savedMaxLoss) || (consecutiveLosses >= savedMaxConsec);
    const remainingRiskBudget = Math.max(0, savedMaxLoss + netPnl);
    const sessionLabel = `Today (${todayIst})`;

    if (isBreakerHit && !isAcknowledged) {
      // DANGER ALERT STATE
      const triggerReason = (netPnl <= -savedMaxLoss && consecutiveLosses >= savedMaxConsec)
        ? `Daily Loss Ceiling (-$${formatUSD(Math.abs(netPnl))}) & ${consecutiveLosses} Consecutive Losses`
        : (netPnl <= -savedMaxLoss
            ? `Daily Loss Ceiling (-$${formatUSD(Math.abs(netPnl))} vs max -$${savedMaxLoss})`
            : `${consecutiveLosses} Consecutive Stop-Outs (Max allowed: ${savedMaxConsec})`);

      container.innerHTML = `
        <div class="relative overflow-hidden rounded-2xl border-2 border-rose-500/80 bg-rose-950/40 p-4 sm:p-5 shadow-2xl shadow-rose-950/60 ring-1 ring-rose-500/50">
          <div class="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3 pb-3 border-b border-rose-500/30">
            <div class="flex items-center gap-3">
              <span class="relative flex h-3.5 w-3.5 shrink-0">
                <span class="animate-ping absolute inline-flex h-full w-full rounded-full bg-rose-400 opacity-75"></span>
                <span class="relative inline-flex rounded-full h-3.5 w-3.5 bg-rose-500"></span>
              </span>
              <div>
                <h3 class="text-sm sm:text-base font-bold text-rose-200 font-sans tracking-wide flex items-center gap-2">
                  <i class="fa-solid fa-triangle-exclamation text-rose-400"></i>
                  TILT BREAKER TRIGGERED — TERMINAL LOCK RECOMMENDED
                </h3>
                <p class="text-xs text-rose-300/90 font-mono mt-0.5">
                  ${sessionLabel}: <strong class="text-rose-200">${triggerReason}</strong>
                </p>
              </div>
            </div>
            <div class="flex items-center gap-2 self-end sm:self-auto">
              <button onclick="DeltaApp.openSentinelConfigModal()" class="px-2.5 py-1 text-[11px] font-bold rounded-lg bg-cardDark/80 hover:bg-cardDark text-slate-300 hover:text-white border border-borderDark transition-colors">
                <i class="fa-solid fa-gear mr-1"></i> Limits
              </button>
              <button onclick="DeltaApp.acknowledgeSentinel()" class="px-3 py-1 text-[11px] font-bold rounded-lg bg-rose-600 hover:bg-rose-500 text-white transition-colors shadow-md shadow-rose-600/30">
                Acknowledge & Stand Down
              </button>
            </div>
          </div>

          <!-- Alert Metrics Grid -->
          <div class="grid grid-cols-2 sm:grid-cols-4 gap-2.5 my-3 font-mono">
            <div class="bg-black/40 border border-rose-500/30 p-2.5 rounded-xl">
              <span class="text-[9px] uppercase tracking-wider text-rose-300/80 block font-sans">Session Realized</span>
              <span class="text-sm sm:text-base font-bold text-rose-400">-${formatUSD(Math.abs(netPnl))}</span>
              <span class="text-[9px] text-rose-400/70 block mt-0.5">Limit: -$${savedMaxLoss}</span>
            </div>
            <div class="bg-black/40 border border-rose-500/30 p-2.5 rounded-xl">
              <span class="text-[9px] uppercase tracking-wider text-rose-300/80 block font-sans">Consecutive Stop-Outs</span>
              <span class="text-sm sm:text-base font-bold text-rose-400">${consecutiveLosses} / ${savedMaxConsec} Max</span>
              <span class="text-[9px] text-rose-400/70 block mt-0.5">Ceiling breached</span>
            </div>
            <div class="bg-black/40 border border-rose-500/30 p-2.5 rounded-xl">
              <span class="text-[9px] uppercase tracking-wider text-rose-300/80 block font-sans">Discipline Verdict</span>
              <span class="text-sm sm:text-base font-bold text-rose-300">HALT TRADING</span>
              <span class="text-[9px] text-rose-400/70 block mt-0.5">Prevent revenge tilt</span>
            </div>
            <div class="bg-black/40 border border-rose-500/30 p-2.5 rounded-xl">
              <span class="text-[9px] uppercase tracking-wider text-rose-300/80 block font-sans">Session Record</span>
              <span class="text-sm sm:text-base font-bold text-white">${todayTrades.length} Trades (${wins}W - ${losses}L)</span>
              <span class="text-[9px] text-slate-400 block mt-0.5">Save capital for tomorrow</span>
            </div>
          </div>

          <!-- Quant Advice -->
          <div class="text-xs text-rose-200/90 leading-relaxed font-sans flex items-start gap-2 bg-rose-950/60 p-2.5 rounded-xl border border-rose-500/20">
            <i class="fa-solid fa-hand text-rose-400 shrink-0 mt-0.5"></i>
            <span><strong>Desk Risk Officer Rule:</strong> In BTC options, taking additional trades after 2 consecutive stop-outs or hitting your daily loss ceiling is the #1 cause of catastrophic account drawdowns. Step away from Delta Exchange, take a mental reset, and preserve your ammunition for the next high-probability session.</span>
          </div>
        </div>
      `;
    } else {
      // SAFE / DISCIPLINED STATE
      const pnlColor = netPnl > 0 ? 'text-winGreen' : (netPnl < 0 ? 'text-lossRed' : 'text-slate-300');
      const budgetPct = Math.round((remainingRiskBudget / savedMaxLoss) * 100);

      container.innerHTML = `
        <div class="rounded-2xl border border-emerald-500/30 bg-gradient-to-r from-cardDark via-brandDark to-cardDark p-4 sm:p-5 shadow-lg shadow-black/40">
          <div class="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-2 pb-3 border-b border-borderDark/60">
            <div class="flex items-center gap-2.5">
              <span class="inline-block w-2.5 h-2.5 rounded-full bg-emerald-400 animate-pulse shrink-0"></span>
              <div>
                <h3 class="text-sm sm:text-base font-bold text-white font-sans flex items-center gap-2">
                  <i class="fa-solid fa-shield-halved text-emerald-400"></i>
                  Capital Defense Sentinel: <span class="text-emerald-400 font-bold">DISCIPLINED (Safe)</span>
                </h3>
                <p class="text-[11px] text-slate-400 font-mono">
                  ${sessionLabel}: Real-time desk risk sentinel monitoring capital preservation
                </p>
              </div>
            </div>
            <div class="flex items-center gap-2 self-end sm:self-auto">
              <span class="text-[10px] font-mono text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 px-2 py-0.5 rounded font-bold">
                Max Loss: $${savedMaxLoss} | Stop-Outs: ${savedMaxConsec}
              </span>
              <button onclick="DeltaApp.openSentinelConfigModal()" class="px-2.5 py-1 text-[11px] font-bold rounded-lg bg-panelDark hover:bg-cardDark text-slate-300 hover:text-white border border-borderDark transition-colors">
                <i class="fa-solid fa-gear mr-1"></i> Edit
              </button>
            </div>
          </div>

          <!-- Safe Metrics Grid -->
          <div class="grid grid-cols-2 sm:grid-cols-4 gap-2.5 mt-3 font-mono">
            <div class="bg-panelDark/50 border border-borderDark/60 p-2.5 rounded-xl">
              <span class="text-[9px] uppercase tracking-wider text-slate-400 block font-sans">Session Realized</span>
              <span class="text-sm sm:text-base font-bold ${pnlColor}">${netPnl >= 0 ? '+' : ''}${formatUSD(netPnl)}</span>
              <span class="text-[9px] text-slate-500 block mt-0.5">${todayTrades.length} trades (${wins}W - ${losses}L)</span>
            </div>
            <div class="bg-panelDark/50 border border-borderDark/60 p-2.5 rounded-xl">
              <span class="text-[9px] uppercase tracking-wider text-slate-400 block font-sans">Remaining Risk Buffer</span>
              <span class="text-sm sm:text-base font-bold text-emerald-300">${formatUSD(remainingRiskBudget)}</span>
              <span class="text-[9px] text-slate-500 block mt-0.5">${budgetPct}% daily budget intact</span>
            </div>
            <div class="bg-panelDark/50 border border-borderDark/60 p-2.5 rounded-xl">
              <span class="text-[9px] uppercase tracking-wider text-slate-400 block font-sans">Consecutive Losses</span>
              <span class="text-sm sm:text-base font-bold ${consecutiveLosses > 0 ? 'text-amber-400' : 'text-slate-200'}">${consecutiveLosses} / ${savedMaxConsec}</span>
              <span class="text-[9px] text-slate-500 block mt-0.5">${savedMaxConsec - consecutiveLosses} stop-outs allowed</span>
            </div>
            <div class="bg-panelDark/50 border border-borderDark/60 p-2.5 rounded-xl">
              <span class="text-[9px] uppercase tracking-wider text-slate-400 block font-sans">Desk Status</span>
              <span class="text-sm sm:text-base font-bold text-emerald-400">ACTIVE / GREEN</span>
              <span class="text-[9px] text-slate-500 block mt-0.5">Selective execution only</span>
            </div>
          </div>
        </div>
      `;
    }
  }

  // -------------------------------------------------------------
  // 4d. TRADE DURATION & SCALP EFFICIENCY DIAGNOSTIC (FEATURE 3)
  // -------------------------------------------------------------
  function renderHoldDurationDiagnostic(trades) {
    const bucketsContainer = document.getElementById('holdDurationBucketsContainer');
    const bannerContainer = document.getElementById('holdDurationInsightBanner');
    if (!bucketsContainer || !bannerContainer) return;

    if (!trades || trades.length === 0) {
      bucketsContainer.innerHTML = `<div class="col-span-full text-center py-6 text-slate-500 text-xs font-sans">No trades recorded in this period for duration analysis.</div>`;
      bannerContainer.innerHTML = `<span class="text-slate-500 text-xs">No closed positions available for hold duration quantification.</span>`;
      return;
    }

    const bucketDefs = [
      { id: 'b1', name: '⚡ Lightning Scalp (< 15m)', sub: 'Momentum & Gamma expansion', filter: d => d < 900, icon: 'fa-bolt text-amber-400' },
      { id: 'b2', name: '🎯 Intraday Momentum (15–60m)', sub: '15m Order block expansion', filter: d => d >= 900 && d < 3600, icon: 'fa-bullseye text-indigo-400' },
      { id: 'b3', name: '⏳ Swing Hold (1–4 hrs)', sub: 'Theta decay accelerating', filter: d => d >= 3600 && d < 14400, icon: 'fa-hourglass-half text-sky-400' },
      { id: 'b4', name: '⚠️ Prolonged Hold (> 4 hrs)', sub: 'Severe theta erosion risk', filter: d => d >= 14400, icon: 'fa-triangle-exclamation text-rose-400' }
    ];

    let bestBucket = null;
    let worstBucket = null;
    let maxPnl = -Infinity;
    let minPnl = Infinity;

    const cardsHtml = bucketDefs.map(b => {
      const bTrades = trades.filter(t => b.filter(t.holdDurationSec || 0));
      const count = bTrades.length;
      const sharePct = trades.length > 0 ? Math.round((count / trades.length) * 100) : 0;
      const wins = bTrades.filter(t => (t.net_pnl || 0) > 0.0001).length;
      const losses = bTrades.filter(t => (t.net_pnl || 0) < -0.0001).length;
      const winRate = count > 0 ? Math.round((wins / count) * 100) : 0;
      const netPnl = bTrades.reduce((acc, t) => acc + (t.net_pnl || 0), 0);
      const avgTrade = count > 0 ? (netPnl / count) : 0;

      const grossWins = bTrades.filter(t => (t.net_pnl || 0) > 0).reduce((acc, t) => acc + t.net_pnl, 0);
      const grossLosses = Math.abs(bTrades.filter(t => (t.net_pnl || 0) < 0).reduce((acc, t) => acc + t.net_pnl, 0));
      const profitFactor = grossLosses > 0 ? (grossWins / grossLosses).toFixed(2) : (grossWins > 0 ? '∞' : '0.00');

      if (count > 0) {
        if (netPnl > maxPnl) { maxPnl = netPnl; bestBucket = { ...b, netPnl, winRate, count }; }
        if (netPnl < minPnl) { minPnl = netPnl; worstBucket = { ...b, netPnl, winRate, count }; }
      }

      // Edge status badge
      let badgeHtml = '';
      let borderClass = 'border-borderDark/70 bg-panelDark/40';
      if (count === 0) {
        badgeHtml = `<span class="text-[9px] font-sans font-semibold text-slate-500 bg-panelDark border border-borderDark/40 px-2 py-0.5 rounded">0 Trades</span>`;
      } else if (netPnl > 0 && winRate >= 60) {
        borderClass = 'border-emerald-500/30 bg-emerald-950/15';
        badgeHtml = `<span class="text-[9px] font-sans font-bold text-emerald-300 bg-emerald-500/20 border border-emerald-500/40 px-2 py-0.5 rounded">🎯 Prime Edge</span>`;
      } else if (netPnl > 0) {
        borderClass = 'border-emerald-500/20 bg-emerald-500/5';
        badgeHtml = `<span class="text-[9px] font-sans font-bold text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 px-2 py-0.5 rounded">🟢 Profitable</span>`;
      } else if (b.id === 'b4' || b.id === 'b3') {
        borderClass = 'border-rose-500/30 bg-rose-950/20';
        badgeHtml = `<span class="text-[9px] font-sans font-bold text-rose-300 bg-rose-500/20 border border-rose-500/40 px-2 py-0.5 rounded">🚨 Theta Trap</span>`;
      } else {
        borderClass = 'border-rose-500/20 bg-rose-500/5';
        badgeHtml = `<span class="text-[9px] font-sans font-bold text-rose-400 bg-rose-500/10 border border-rose-500/20 px-2 py-0.5 rounded">Negative Edge</span>`;
      }

      const pnlColor = netPnl > 0 ? 'text-winGreen' : (netPnl < 0 ? 'text-lossRed' : 'text-slate-400');
      const avgColor = avgTrade > 0 ? 'text-emerald-400' : (avgTrade < 0 ? 'text-rose-400' : 'text-slate-400');

      return `
        <div class="p-3.5 rounded-xl border ${borderClass} flex flex-col justify-between gap-3 font-mono transition-all hover:border-indigo-500/40">
          <div>
            <div class="flex justify-between items-start gap-1">
              <span class="text-xs font-bold text-white font-sans flex items-center gap-1.5">
                <i class="fa-solid ${b.icon}"></i> ${b.name}
              </span>
              ${badgeHtml}
            </div>
            <p class="text-[10px] text-slate-400 font-sans mt-0.5">${b.sub}</p>
          </div>

          <div class="space-y-1.5 pt-2 border-t border-borderDark/40">
            <div class="flex justify-between items-baseline">
              <span class="text-[10px] text-slate-400 font-sans">Net PnL</span>
              <span class="text-xs sm:text-sm font-bold ${pnlColor}">${netPnl >= 0 ? '+' : ''}${formatUSD(netPnl)}</span>
            </div>
            <div class="flex justify-between items-baseline">
              <span class="text-[10px] text-slate-400 font-sans">Win Rate</span>
              <span class="text-xs font-bold text-indigo-300">${count > 0 ? `${winRate}% (${wins}W - ${losses}L)` : '--'}</span>
            </div>
            <div class="flex justify-between items-baseline">
              <span class="text-[10px] text-slate-400 font-sans">Volume</span>
              <span class="text-[11px] text-slate-300">${count} trades <span class="text-slate-500">(${sharePct}%)</span></span>
            </div>
            <div class="flex justify-between items-baseline">
              <span class="text-[10px] text-slate-400 font-sans">Avg Trade</span>
              <span class="text-[11px] font-bold ${avgColor}">${count > 0 ? `${avgTrade >= 0 ? '+' : ''}${formatUSD(avgTrade)}` : '--'}</span>
            </div>
            <div class="flex justify-between items-baseline">
              <span class="text-[10px] text-slate-400 font-sans">Profit Factor</span>
              <span class="text-[11px] text-white font-bold">${count > 0 ? profitFactor : '--'}</span>
            </div>
          </div>
        </div>
      `;
    }).join('');

    bucketsContainer.innerHTML = cardsHtml;

    // Run theta leaks analysis using DeltaQuant
    const leakAnalysis = DeltaQuant.detectThetaLeaks(trades);

    let verdictText = '';
    if (bestBucket && bestBucket.netPnl > 0) {
      verdictText = `Your mathematical alpha is concentrated in <strong>${bestBucket.name}</strong> (${bestBucket.netPnl >= 0 ? '+' : ''}${formatUSD(bestBucket.netPnl)} Net, ${bestBucket.winRate}% Win Rate over ${bestBucket.count} trades). `;
    } else {
      verdictText = `Review your hold durations to establish a positive risk expectancy. `;
    }

    if (leakAnalysis.isAsymmetricLeak) {
      verdictText += `⚠️ <strong>Theta Warning:</strong> You hold losing options on average <strong>${leakAnalysis.holdRatio}x longer</strong> than winners (Avg Loss Hold: ${leakAnalysis.avgLossHoldFormatted} vs Avg Win Hold: ${leakAnalysis.avgWinHoldFormatted}). In Delta BTC options, prolonged holds rapidly suffer theta decay. Cut losing contracts cleanly!`;
    } else {
      verdictText += `🛡️ <strong>Discipline Check:</strong> Your average win hold is ${leakAnalysis.avgWinHoldFormatted} and average loss hold is ${leakAnalysis.avgLossHoldFormatted}. You maintain controlled exits and avoid letting options premium decay into terminal losses.`;
    }

    bannerContainer.innerHTML = `
      <div class="flex items-start gap-3">
        <div class="p-2 rounded-xl bg-indigo-600/20 text-indigo-400 border border-indigo-500/30 shrink-0 mt-0.5">
          <i class="fa-solid fa-brain text-sm"></i>
        </div>
        <div class="space-y-1">
          <h4 class="text-xs font-bold text-white flex items-center gap-2 font-sans">
            Institutional Quant Verdict: Scalp Duration & Theta Profile
          </h4>
          <p class="text-xs text-slate-300 leading-relaxed font-sans">
            ${verdictText}
          </p>
        </div>
      </div>
    `;
  }

  // Sentinel Configuration Modal Handlers
  function openSentinelConfigModal() {
    const modal = document.getElementById('sentinelConfigModal');
    if (!modal) return;
    const savedMaxLoss = localStorage.getItem(DeltaConfig.STORAGE_KEYS.MAX_DAILY_LOSS) || 200;
    const savedMaxConsec = localStorage.getItem(DeltaConfig.STORAGE_KEYS.MAX_CONSEC_LOSSES) || 2;

    const lossInput = document.getElementById('inputMaxDailyLoss');
    const consecInput = document.getElementById('inputMaxConsecLosses');

    if (lossInput) lossInput.value = savedMaxLoss;
    if (consecInput) consecInput.value = savedMaxConsec;

    modal.classList.remove('hidden');
  }

  function closeSentinelConfigModal() {
    const modal = document.getElementById('sentinelConfigModal');
    if (modal) modal.classList.add('hidden');
  }

  function saveSentinelConfig() {
    const lossInput = document.getElementById('inputMaxDailyLoss');
    const consecInput = document.getElementById('inputMaxConsecLosses');

    const maxLoss = parseFloat(lossInput?.value) || 200;
    const maxConsec = parseInt(consecInput?.value, 10) || 2;

    localStorage.setItem(DeltaConfig.STORAGE_KEYS.MAX_DAILY_LOSS, maxLoss);
    localStorage.setItem(DeltaConfig.STORAGE_KEYS.MAX_CONSEC_LOSSES, maxConsec);
    localStorage.removeItem(DeltaConfig.STORAGE_KEYS.SENTINEL_ACKNOWLEDGED);

    closeSentinelConfigModal();
    applyGlobalFilter();
  }

  function acknowledgeSentinel() {
    localStorage.setItem(DeltaConfig.STORAGE_KEYS.SENTINEL_ACKNOWLEDGED, 'true');
    applyGlobalFilter();
  }

  // -------------------------------------------------------------
  // 5. TRADE AUDIT LOG & SLIDE-OVER DRAWER (COLLAPSIBLE & FILTERABLE - IDEA 4)
  // -------------------------------------------------------------
  let currentTradeFilter = 'ALL';
  let currentTradeSort = 'NEWEST';
  let isTradeLogCollapsed = true;

  function toggleTradeLogCollapse() {
    isTradeLogCollapsed = !isTradeLogCollapsed;
    const content = document.getElementById('tradeLogCollapseContent');
    const chevron = document.getElementById('tradeLogChevron');
    const toggleText = document.getElementById('tradeLogToggleText');

    if (!content) return;

    if (isTradeLogCollapsed) {
      content.classList.add('hidden');
      if (chevron) chevron.className = 'fa-solid fa-chevron-down';
      if (toggleText) toggleText.innerText = 'Show Trades';
    } else {
      content.classList.remove('hidden');
      if (chevron) chevron.className = 'fa-solid fa-chevron-up';
      if (toggleText) toggleText.innerText = 'Hide Trades';
      renderPaginatedTrades();
    }
  }

  function setTradeFilter(filter) {
    currentTradeFilter = filter;
    currentTradePage = 1;
    ['ALL', 'CALLS', 'PUTS', 'WINNERS', 'LOSSES'].forEach(f => {
      const btn = document.getElementById(`btnTradeFilter_${f}`);
      if (btn) {
        if (f === filter) {
          btn.className = "px-2.5 py-1 text-xs font-bold rounded-lg bg-indigo-600 text-white font-mono shadow-sm shrink-0";
        } else {
          btn.className = "px-2.5 py-1 text-xs font-bold rounded-lg text-slate-400 hover:text-white bg-panelDark font-mono shrink-0";
        }
      }
    });
    renderPaginatedTrades();
  }

  function setTradeSort(sort) {
    currentTradeSort = sort;
    currentTradePage = 1;
    renderPaginatedTrades();
  }

  function getFilteredAndSortedTrades() {
    let list = [...currentFilteredTrades];

    // Filter
    if (currentTradeFilter === 'CALLS') {
      list = list.filter(t => t.isCall);
    } else if (currentTradeFilter === 'PUTS') {
      list = list.filter(t => !t.isCall);
    } else if (currentTradeFilter === 'WINNERS') {
      list = list.filter(t => t.net_pnl > 0.0001);
    } else if (currentTradeFilter === 'LOSSES') {
      list = list.filter(t => t.net_pnl < -0.0001);
    }

    // Sort
    if (currentTradeSort === 'NEWEST') {
      list.sort((a, b) => (b.sortTime || 0) - (a.sortTime || 0));
    } else if (currentTradeSort === 'OLDEST') {
      list.sort((a, b) => (a.sortTime || 0) - (b.sortTime || 0));
    } else if (currentTradeSort === 'PNL_HIGH') {
      list.sort((a, b) => (b.net_pnl || 0) - (a.net_pnl || 0));
    } else if (currentTradeSort === 'PNL_LOW') {
      list.sort((a, b) => (a.net_pnl || 0) - (b.net_pnl || 0));
    } else if (currentTradeSort === 'SIZE_HIGH') {
      const parseSize = s => parseFloat(String(s).replace(/,/g, '')) || 0;
      list.sort((a, b) => parseSize(b.size) - parseSize(a.size));
    }

    return list;
  }

  function changeTradePage(delta) {
    const activeList = getFilteredAndSortedTrades();
    const totalPages = Math.max(1, Math.ceil(activeList.length / TRADES_PER_PAGE));
    currentTradePage = Math.min(totalPages, Math.max(1, currentTradePage + delta));
    renderPaginatedTrades();
  }

  function renderPaginatedTrades() {
    const tbody = document.getElementById('tradeLogBody');
    const mobileContainer = document.getElementById('tradeLogMobileCards');
    const pagControls = document.getElementById('paginationControls');

    // Update summary badge on the collapsible header
    const sumNet = currentFilteredTrades.reduce((acc, t) => acc + (t.net_pnl || 0), 0);
    const summaryBadge = document.getElementById('tradeLogSummaryBadge');
    if (summaryBadge) {
      summaryBadge.innerText = `${currentFilteredTrades.length} trades | ${sumNet >= 0 ? '+' : ''}${formatUSD(sumNet)} Net`;
      summaryBadge.className = `text-xs font-mono font-bold px-2.5 py-1 rounded-xl ${sumNet >= 0 ? 'bg-emerald-500/10 text-winGreen border border-emerald-500/20' : 'bg-rose-500/10 text-lossRed border border-rose-500/20'}`;
    }

    if (!tbody || !mobileContainer) return;

    const activeList = getFilteredAndSortedTrades();
    const totalTrades = activeList.length;

    const badge = document.getElementById('tradeCountBadge');
    if (badge) badge.innerText = `Showing ${totalTrades} of ${currentFilteredTrades.length} positions`;

    if (totalTrades === 0) {
      tbody.innerHTML = `<tr><td colspan="10" class="text-center py-8 text-slate-500 font-sans">No matching trades found for the selected filter.</td></tr>`;
      mobileContainer.innerHTML = `<div class="text-center py-8 text-slate-500 text-xs">No matching trades found for the selected filter.</div>`;
      if (pagControls) {
        pagControls.classList.add('hidden');
        pagControls.classList.remove('flex');
      }
      return;
    }

    const totalPages = Math.ceil(totalTrades / TRADES_PER_PAGE);
    const startIdx = (currentTradePage - 1) * TRADES_PER_PAGE;
    const pageTrades = activeList.slice(startIdx, startIdx + TRADES_PER_PAGE);

    if (pagControls) {
      if (totalPages > 1) {
        pagControls.classList.remove('hidden');
        pagControls.classList.add('flex');
        document.getElementById('pageIndicator').innerText = `Page ${currentTradePage} of ${totalPages}`;
        document.getElementById('prevPageBtn').disabled = (currentTradePage === 1);
        document.getElementById('nextPageBtn').disabled = (currentTradePage === totalPages);
      } else {
        pagControls.classList.add('hidden');
        pagControls.classList.remove('flex');
      }
    }

    let tableHTML = '';
    let cardsHTML = '';

    pageTrades.forEach(t => {
      const isWin = t.status === 'WIN';
      const badgeClass = isWin ? 'bg-winGreen/10 text-winGreen border border-winGreen/20' : 'bg-lossRed/10 text-lossRed border border-lossRed/20';
      const tagCount = (t.tags && t.tags.length > 0) ? t.tags.length : 0;
      const ssCount = (t.screenshots && t.screenshots.length > 0) ? t.screenshots.length : 0;

      tableHTML += `
        <tr class="hover:bg-panelDark/60 border-b border-borderDark/50 cursor-pointer transition-colors" onclick="DeltaApp.openTradeDrawer('${t.id}')">
          <td class="py-2.5 px-3 text-slate-400">${t.timestamp}</td>
          <td class="py-2.5 px-3 font-semibold text-white">
            <div class="flex items-center gap-1.5">
              <span>${t.symbol}</span>
              ${tagCount > 0 ? `<span class="px-1.5 py-0.2 rounded bg-indigo-500/10 text-indigo-400 border border-indigo-500/20 text-[9px] font-sans font-bold">${tagCount} tag${tagCount > 1 ? 's' : ''}</span>` : ''}
              ${ssCount > 0 ? `<i class="fa-solid fa-camera text-slate-400 text-[10px]" title="${ssCount} screenshot(s)"></i>` : ''}
            </div>
          </td>
          <td class="py-2.5 px-3 text-right">${t.size}</td>
          <td class="py-2.5 px-3 text-right text-slate-400">$${t.avgEntry.toFixed(1)} → $${t.avgExit.toFixed(1)}</td>
          <td class="py-2.5 px-3 text-right ${t.gross_pnl >= 0 ? 'text-winGreen' : 'text-lossRed'}">${formatUSD(t.gross_pnl)}</td>
          <td class="py-2.5 px-3 text-right text-lossRed">${formatUSD(t.base_brokerage)}</td>
          <td class="py-2.5 px-3 text-right text-amber-400">${formatUSD(t.gst)}</td>
          <td class="py-2.5 px-3 text-right font-bold ${t.net_pnl >= 0 ? 'text-winGreen' : 'text-lossRed'}">${formatUSD(t.net_pnl)}</td>
          <td class="py-2.5 px-3 text-center"><span class="px-2 py-0.5 rounded-full text-[9px] font-semibold ${badgeClass}">${t.status}</span></td>
          <td class="py-2.5 px-2 text-center text-slate-500 hover:text-white"><i class="fa-solid fa-pen-to-square"></i></td>
        </tr>`;

      cardsHTML += `
        <div class="bg-brandDark border border-borderDark hover:border-indigo-500/40 rounded-xl p-3.5 flex flex-col gap-2 font-mono cursor-pointer transition-all active:scale-[0.99]" onclick="DeltaApp.openTradeDrawer('${t.id}')">
          <div class="flex justify-between items-start">
            <div>
              <div class="flex items-center gap-1.5">
                <span class="font-bold text-white text-xs">${t.symbol}</span>
                ${tagCount > 0 ? `<span class="px-1.5 py-0.2 rounded bg-indigo-500/10 text-indigo-400 border border-indigo-500/20 text-[8px] font-sans font-bold">${tagCount} tag</span>` : ''}
                ${ssCount > 0 ? `<i class="fa-solid fa-camera text-slate-400 text-[9px]"></i>` : ''}
              </div>
              <span class="text-[10px] text-slate-400">${t.timestamp} • Size: ${t.size}</span>
            </div>
            <div class="text-right">
              <span class="font-bold text-sm ${t.net_pnl >= 0 ? 'text-winGreen' : 'text-lossRed'} block">${t.net_pnl >= 0 ? '+' : ''}${formatUSD(t.net_pnl)}</span>
              <span class="text-[9px] text-slate-400">$${t.avgEntry.toFixed(1)} → $${t.avgExit.toFixed(1)}</span>
            </div>
          </div>
          <div class="grid grid-cols-3 gap-2 pt-2 border-t border-borderDark/60 text-[10px]">
            <div><span class="text-slate-500 block">Gross</span><span class="${t.gross_pnl >= 0 ? 'text-winGreen' : 'text-lossRed'}">${formatUSD(t.gross_pnl)}</span></div>
            <div><span class="text-slate-500 block">Brokerage</span><span class="text-lossRed">${formatUSD(t.base_brokerage)}</span></div>
            <div class="text-right"><span class="text-slate-500 block">18% GST</span><span class="text-amber-400">${formatUSD(t.gst)}</span></div>
          </div>
        </div>`;
    });

    tbody.innerHTML = tableHTML;
    mobileContainer.innerHTML = cardsHTML;
  }

  // -------------------------------------------------------------
  // 6. SLIDE-OVER TRADE DRAWER & ENRICHMENT
  // -------------------------------------------------------------
  function openTradeDrawer(tradeId) {
    const trade = DeltaDB.getTradeById(tradeId);
    if (!trade) return;
    activeDrawerTradeId = tradeId;

    const drawer = document.getElementById('tradeDrawer');
    const overlay = document.getElementById('tradeDrawerOverlay');
    if (!drawer) return;

    // Header info
    document.getElementById('drawerSymbol').innerText = trade.symbol;
    document.getElementById('drawerTime').innerText = `${trade.timestamp} (${DeltaQuant.formatDuration(trade.holdDurationSec)})`;
    document.getElementById('drawerStatusBadge').innerText = trade.status;
    document.getElementById('drawerStatusBadge').className = `px-2 py-0.5 rounded text-[10px] font-bold ${trade.status === 'WIN' ? 'bg-winGreen/10 text-winGreen border border-winGreen/30' : 'bg-lossRed/10 text-lossRed border border-lossRed/30'}`;

    // Metrics
    document.getElementById('drawerNetPnl').innerText = `${trade.net_pnl >= 0 ? '+' : ''}${formatUSD(trade.net_pnl)}`;
    document.getElementById('drawerNetPnl').className = `text-xl font-bold font-mono ${trade.net_pnl >= 0 ? 'text-winGreen' : 'text-lossRed'}`;
    document.getElementById('drawerGrossPnl').innerText = formatUSD(trade.gross_pnl);
    document.getElementById('drawerFee').innerText = formatUSD(trade.total_fee);
    document.getElementById('drawerPrices').innerText = `$${trade.avgEntry.toFixed(2)} → $${trade.avgExit.toFixed(2)}`;
    document.getElementById('drawerSize').innerText = `${trade.size} contracts`;
    document.getElementById('drawerStrike').innerText = trade.strike ? `$${trade.strike.toLocaleString()}` : 'N/A';
    document.getElementById('drawerExpiry').innerText = trade.expiry || 'N/A';

    // Render Tag Selector
    renderDrawerTags(trade);

    // Notes
    document.getElementById('drawerNotesInput').value = trade.notes || '';

    // Render Screenshots
    renderDrawerScreenshots(trade);

    drawer.classList.add('drawer-open');
    if (overlay) {
      overlay.classList.remove('opacity-0', 'pointer-events-none');
      overlay.classList.add('opacity-100');
    }
  }

  function closeTradeDrawer() {
    activeDrawerTradeId = null;
    const drawer = document.getElementById('tradeDrawer');
    const overlay = document.getElementById('tradeDrawerOverlay');
    if (drawer) drawer.classList.remove('drawer-open');
    if (overlay) {
      overlay.classList.remove('opacity-100');
      overlay.classList.add('opacity-0', 'pointer-events-none');
    }
  }

  function renderDrawerTags(trade) {
    const container = document.getElementById('drawerTagContainer');
    if (!container) return;

    const tradeTags = trade.tags || [];
    let html = '';

    DeltaConfig.SMC_TAG_PRESETS.forEach(preset => {
      const isSelected = tradeTags.includes(preset.name);
      const bgStyle = isSelected
        ? `background-color: ${preset.color}25; color: ${preset.color}; border: 1px solid ${preset.color}80;`
        : `background-color: #0f172a; color: #94a3b8; border: 1px solid #1e293b;`;

      html += `
        <button onclick="DeltaApp.toggleTradeTag('${preset.name}')" class="smc-tag-pill ${isSelected ? 'active' : ''}" style="${bgStyle}">
          ${isSelected ? '<i class="fa-solid fa-check text-[9px]"></i>' : ''} ${preset.name}
        </button>
      `;
    });

    // Custom user tags
    tradeTags.forEach(t => {
      if (!DeltaConfig.SMC_TAG_PRESETS.some(p => p.name === t)) {
        html += `
          <button onclick="DeltaApp.toggleTradeTag('${t}')" class="smc-tag-pill active" style="background-color: #6366f125; color: #a5b4fc; border: 1px solid #6366f180;">
            <i class="fa-solid fa-check text-[9px]"></i> ${t}
          </button>
        `;
      }
    });

    container.innerHTML = html;
  }

  async function toggleTradeTag(tagName) {
    if (!activeDrawerTradeId) return;
    const trade = DeltaDB.getTradeById(activeDrawerTradeId);
    if (!trade) return;

    const tags = trade.tags || [];
    if (tags.includes(tagName)) {
      await DeltaDB.removeTagFromTrade(activeDrawerTradeId, tagName);
    } else {
      await DeltaDB.addTagToTrade(activeDrawerTradeId, tagName);
    }
    renderDrawerTags(DeltaDB.getTradeById(activeDrawerTradeId));
  }

  function addCustomTagPrompt() {
    const custom = prompt("Enter custom SMC tag or setup name (e.g. 'Asian Low Sweep', 'Breaker Block'):");
    if (custom && custom.trim() && activeDrawerTradeId) {
      DeltaDB.addTagToTrade(activeDrawerTradeId, custom.trim()).then(() => {
        renderDrawerTags(DeltaDB.getTradeById(activeDrawerTradeId));
      });
    }
  }

  async function saveDrawerNotes() {
    if (!activeDrawerTradeId) return;
    const notes = document.getElementById('drawerNotesInput').value.trim();
    await DeltaDB.updateTradeEnrichment(activeDrawerTradeId, { notes });
    alert("Trade notes saved!");
  }

  function renderDrawerScreenshots(trade) {
    const container = document.getElementById('drawerScreenshotGrid');
    if (!container) return;

    const list = trade.screenshots || [];
    if (list.length === 0) {
      container.innerHTML = `<div class="col-span-2 p-4 text-center text-slate-500 text-xs border border-dashed border-borderDark rounded-xl">No charts attached. Paste with Ctrl+V or upload below.</div>`;
      return;
    }

    let html = '';
    list.forEach((img, idx) => {
      html += `
        <div class="screenshot-thumb" onclick="DeltaApp.viewFullScreenshot('${trade.id}', ${idx})">
          <img src="${img.dataUrl}" alt="Chart Screenshot">
          <span class="absolute bottom-1 right-1.5 px-1.5 py-0.5 rounded bg-brandDark/80 text-[8px] text-slate-300 font-mono">Chart ${idx + 1}</span>
        </div>
      `;
    });
    container.innerHTML = html;
  }

  function initClipboardPaste() {
    window.addEventListener('paste', async (e) => {
      if (!activeDrawerTradeId) return;
      const items = (e.clipboardData || e.originalEvent?.clipboardData)?.items;
      if (!items) return;

      for (let i = 0; i < items.length; i++) {
        if (items[i].type.indexOf('image') !== -1) {
          const blob = items[i].getAsFile();
          const reader = new FileReader();
          reader.onload = async (event) => {
            const dataUrl = event.target.result;
            await DeltaDB.attachScreenshot(activeDrawerTradeId, dataUrl, "Pasted from Clipboard");
            renderDrawerScreenshots(DeltaDB.getTradeById(activeDrawerTradeId));
          };
          reader.readAsDataURL(blob);
          break;
        }
      }
    });
  }

  function triggerScreenshotUpload() {
    const input = document.getElementById('screenshotFileInput');
    if (input) input.click();
  }

  function handleScreenshotFileUpload(event) {
    if (!activeDrawerTradeId || !event.target.files?.[0]) return;
    const file = event.target.files[0];
    const reader = new FileReader();
    reader.onload = async (e) => {
      await DeltaDB.attachScreenshot(activeDrawerTradeId, e.target.result, file.name);
      renderDrawerScreenshots(DeltaDB.getTradeById(activeDrawerTradeId));
    };
    reader.readAsDataURL(file);
  }

  function viewFullScreenshot(tradeId, idx) {
    const trade = DeltaDB.getTradeById(tradeId);
    if (!trade || !trade.screenshots?.[idx]) return;
    const imgModal = document.getElementById('imageViewerModal');
    const modalImg = document.getElementById('viewerModalImg');
    if (imgModal && modalImg) {
      modalImg.src = trade.screenshots[idx].dataUrl;
      imgModal.classList.remove('opacity-0', 'pointer-events-none');
      imgModal.classList.add('opacity-100');
    }
  }

  function closeImageViewer() {
    const imgModal = document.getElementById('imageViewerModal');
    if (imgModal) {
      imgModal.classList.remove('opacity-100');
      imgModal.classList.add('opacity-0', 'pointer-events-none');
    }
  }

  // -------------------------------------------------------------
  // 7. TAB 3: AI COACH & EDGE ANALYTICS SCREEN
  // -------------------------------------------------------------
  function renderCoachTab() {
    const dossier = DeltaQuant.generateQuantDossier(currentFilteredTrades, document.getElementById('kpiActivity')?.innerText || "Selected Timeframe");

    // Render Metrics Banner
    const rrEl = document.getElementById('coachRealizedRR');
    const expEl = document.getElementById('coachExpectancy');
    const feeEl = document.getElementById('coachFeeDrag');
    const thetaRatioEl = document.getElementById('coachThetaRatio');
    const thetaDiagEl = document.getElementById('coachThetaDiagnosis');

    if (rrEl) rrEl.innerText = `${dossier.metrics.realizedRR} : 1`;
    if (expEl) expEl.innerText = formatUSD(dossier.metrics.expectancy);
    if (feeEl) feeEl.innerText = `${dossier.metrics.feeDragPct}%`;
    if (thetaRatioEl) thetaRatioEl.innerText = `${dossier.thetaAnalysis.holdRatio}x`;
    if (thetaDiagEl) thetaDiagEl.innerText = dossier.thetaAnalysis.diagnosis;

    // Render Strategy Edge Table
    const tbody = document.getElementById('coachStrategyBody');
    if (tbody) {
      if (dossier.strategyMatrix.length === 0) {
        tbody.innerHTML = `<tr><td colspan="6" class="text-center py-6 text-slate-500">No strategy tags assigned yet. Tag trades in the audit log to reveal your edge!</td></tr>`;
      } else {
        let html = '';
        dossier.strategyMatrix.forEach(s => {
          const badge = s.tier === 'ALPHA'
            ? `<span class="px-2 py-0.5 rounded text-[9px] font-bold tier-badge-alpha">ALPHA EDGE</span>`
            : (s.tier === 'LEAK' ? `<span class="px-2 py-0.5 rounded text-[9px] font-bold tier-badge-leak">LEAK</span>` : `<span class="px-2 py-0.5 rounded text-[9px] font-bold tier-badge-neutral">NEUTRAL</span>`);

          html += `
            <tr class="border-b border-borderDark/40 hover:bg-panelDark/50 font-mono text-xs">
              <td class="py-2.5 px-3 font-semibold text-white font-sans">${s.tag}</td>
              <td class="py-2.5 px-3 text-center">${badge}</td>
              <td class="py-2.5 px-3 text-right">${s.trades}</td>
              <td class="py-2.5 px-3 text-right font-bold ${s.winRate >= 50 ? 'text-winGreen' : 'text-slate-300'}">${s.winRate}%</td>
              <td class="py-2.5 px-3 text-right font-bold ${s.netPnl >= 0 ? 'text-winGreen' : 'text-lossRed'}">${s.netPnl >= 0 ? '+' : ''}${formatUSD(s.netPnl)}</td>
              <td class="py-2.5 px-3 text-right font-bold ${s.expectancy >= 0 ? 'text-winGreen' : 'text-lossRed'}">${formatUSD(s.expectancy)}</td>
            </tr>
          `;
        });
        tbody.innerHTML = html;
      }
    }

    // Auto-render offline analysis preview if AI area empty
    const aiChat = document.getElementById('coachAIArea');
    if (aiChat && aiChat.children.length <= 1) {
      aiChat.innerHTML = DeltaCoach.generateOfflineDiagnostic(dossier);
    }
  }

  function triggerCoachGeneration() {
    const dossier = DeltaQuant.generateQuantDossier(currentFilteredTrades, document.getElementById('kpiActivity')?.innerText || "Selected Timeframe");
    DeltaCoach.generateAnalysis(dossier, 'coachAIArea');
  }

  // -------------------------------------------------------------
  // 8. SETTINGS & CLOUD SYNC MODAL
  // -------------------------------------------------------------
  function toggleGhSettings() {
    const modal = document.getElementById('ghSettingsModal');
    if (!modal) return;
    if (modal.classList.contains('opacity-0')) {
      modal.classList.remove('opacity-0', 'pointer-events-none');
      modal.classList.add('opacity-100');
    } else {
      modal.classList.remove('opacity-100');
      modal.classList.add('opacity-0', 'pointer-events-none');
    }
  }

  function saveAppSettings() {
    const token = document.getElementById('ghTokenInput')?.value.trim();
    const owner = document.getElementById('ghOwnerInput')?.value.trim();
    const repo = document.getElementById('ghRepoInput')?.value.trim();
    const geminiKey = document.getElementById('geminiKeyInput')?.value.trim();

    if (token) localStorage.setItem(DeltaConfig.STORAGE_KEYS.GH_PAT, token);
    if (owner) localStorage.setItem(DeltaConfig.STORAGE_KEYS.GH_OWNER, owner);
    if (repo) localStorage.setItem(DeltaConfig.STORAGE_KEYS.GH_REPO, repo);
    if (geminiKey) localStorage.setItem(DeltaConfig.STORAGE_KEYS.GEMINI_KEY, geminiKey);

    toggleGhSettings();
    alert("Settings saved locally!");
  }

  async function triggerFirebaseSync() {
    const btn = document.getElementById('btnSyncFirestore');
    if (btn) {
      btn.disabled = true;
      btn.innerHTML = `<i class="fa-solid fa-circle-notch fa-spin mr-1.5"></i> Syncing to GP_DTJ_*...`;
    }

    try {
      const count = await DeltaDB.syncToFirestore((done, total) => {
        if (btn) btn.innerHTML = `<i class="fa-solid fa-circle-notch fa-spin mr-1.5"></i> ${done} / ${total} synced...`;
      });
      alert(`Success! ${count} trade positions and daily metrics synced to Firestore (${DeltaConfig.FIRESTORE_COLLECTIONS.TRADES}).`);
      checkSyncFreshness();
    } catch (err) {
      alert(`Firestore Sync Error: ${err.message}`);
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = `<i class="fa-solid fa-fire mr-1.5"></i> Sync to Firestore (GP_DTJ_*)`;
      }
    }
  }

  async function triggerGitHubWorkflow() {
    const token = localStorage.getItem(DeltaConfig.STORAGE_KEYS.GH_PAT);
    const owner = localStorage.getItem(DeltaConfig.STORAGE_KEYS.GH_OWNER);
    const repo = localStorage.getItem(DeltaConfig.STORAGE_KEYS.GH_REPO);

    const btn = document.getElementById('syncWorkflowBtn');
    if (btn) {
      btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Checking Cloud...`;
      btn.disabled = true;
    }

    // Step 1: Immediately pull latest raw_data.json into local database
    try {
      const count = await DeltaDB.syncFromRawData(true);
      if (count > 0) {
        applyGlobalFilter();
        console.log(`[Sync] Loaded ${count} new/updated trades immediately.`);
      }
    } catch (e) {
      console.warn("Pre-sync check notice:", e);
    }

    if (!token || !owner || !repo) {
      if (btn) {
        btn.innerHTML = `<i class="fa-solid fa-play"></i> Run Sync`;
        btn.disabled = false;
      }
      toggleGhSettings();
      alert("Local data updated from cloud! To run automated live API ingestion from Delta Exchange, please ensure your GitHub PAT is saved in Settings.");
      return;
    }

    try {
      if (btn) {
        btn.innerHTML = `<i class="fa-solid fa-circle-notch fa-spin"></i> Triggering Action...`;
      }

      const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/actions/workflows/daily_sync.yml/dispatches`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Accept': 'application/vnd.github+json',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ ref: 'main' })
      });

      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`GitHub API Error: ${res.status} - ${errText}`);
      }

      // Automated countdown & auto-refresh
      let secondsLeft = 35;
      const interval = setInterval(async () => {
        secondsLeft -= 5;
        if (btn) {
          btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Ingesting (${secondsLeft}s)...`;
        }
        if (secondsLeft <= 0) {
          clearInterval(interval);
          if (btn) btn.innerHTML = `<i class="fa-solid fa-cloud-arrow-down fa-bounce"></i> Pulling...`;
          const synced = await DeltaDB.syncFromRawData(true);
          applyGlobalFilter();
          if (btn) {
            btn.innerHTML = `<i class="fa-solid fa-circle-check text-emerald-400"></i> Synced!`;
            setTimeout(() => {
              btn.innerHTML = `<i class="fa-solid fa-play"></i> Run Sync`;
              btn.disabled = false;
            }, 3000);
          }
        }
      }, 5000);
    } catch (err) {
      alert(`Failed to trigger workflow: ${err.message}`);
      if (btn) {
        btn.innerHTML = `<i class="fa-solid fa-play"></i> Run Sync`;
        btn.disabled = false;
      }
    }
  }

  async function forceSyncFromRawData() {
    const btn = document.getElementById('btnForcePull');
    if (btn) {
      btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Pulling...`;
      btn.disabled = true;
    }
    try {
      const count = await DeltaDB.syncFromRawData(true);
      applyGlobalFilter();
      alert(`Local Journal Updated! Loaded ${count} new/updated trades from cloud repository.`);
    } catch (err) {
      alert(`Sync notice: ${err.message}`);
    } finally {
      if (btn) {
        btn.innerHTML = `<i class="fa-solid fa-arrows-rotate"></i> Pull Latest Trades from Cloud`;
        btn.disabled = false;
      }
    }
  }

  function showPeek(dateKey) {
    const dailyMap = DeltaDB.getDailyMap();
    if (!dailyMap || !dailyMap[dateKey]) return;
    const data = dailyMap[dateKey];
    if (data.trades === 0) return;

    const dObj = new Date(dateKey + "T00:00:00");
    const displayDate = dObj.toLocaleDateString('en-IN', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
    const isWin = data.net_pnl >= 0;

    const html = `
      <div class="text-center mb-4">
        <p class="text-slate-400 text-[11px] font-semibold uppercase tracking-wider">${displayDate}</p>
        <h2 class="text-3xl font-bold font-mono mt-1.5 ${isWin ? 'text-winGreen' : 'text-lossRed'}">${isWin ? '+' : ''}${formatUSD(data.net_pnl)}</h2>
        <div class="flex justify-center gap-2 mt-3 text-xs font-mono">
          <span class="px-2 py-0.5 rounded bg-brandDark border border-borderDark text-slate-300">${data.trades} ${data.trades === 1 ? 'Trade' : 'Trades'}</span>
          <span class="px-2 py-0.5 rounded bg-winGreen/10 border border-winGreen/20 text-winGreen">${data.wins}W</span>
          <span class="px-2 py-0.5 rounded bg-lossRed/10 border border-lossRed/20 text-lossRed">${data.losses}L</span>
        </div>
      </div>
      <div class="bg-brandDark rounded-xl p-3.5 border border-borderDark/50 space-y-2 text-xs font-mono text-slate-300">
        <div class="flex justify-between items-center"><span>Gross PnL</span><span class="font-bold ${data.gross_pnl >= 0 ? 'text-winGreen' : 'text-lossRed'}">${formatUSD(data.gross_pnl)}</span></div>
        <div class="flex justify-between items-center"><span>Base Brokerage</span><span class="text-lossRed">${formatUSD(data.base_brokerage)}</span></div>
        <div class="flex justify-between items-center"><span>18% GST</span><span class="text-amber-400">${formatUSD(data.gst)}</span></div>
        <div class="flex justify-between items-center pt-1.5 border-t border-borderDark/60"><span>Total Fee Paid</span><span class="text-lossRed font-bold">${formatUSD(data.total_fee)}</span></div>
        <div class="flex justify-between items-center pt-1.5 border-t border-borderDark/60"><span>Net Take-Home</span><span class="font-bold ${data.net_pnl >= 0 ? 'text-winGreen' : 'text-lossRed'}">${formatUSD(data.net_pnl)}</span></div>
      </div>`;

    const peekCard = document.getElementById('peekCard');
    const peekOverlay = document.getElementById('peekOverlay');
    if (peekCard && peekOverlay) {
      peekCard.innerHTML = html;
      peekOverlay.classList.remove('opacity-0', 'pointer-events-none');
      peekOverlay.classList.add('opacity-100');
    }
  }

  function hidePeek() {
    const overlay = document.getElementById('peekOverlay');
    if (overlay) {
      overlay.classList.remove('opacity-100');
      overlay.classList.add('opacity-0', 'pointer-events-none');
    }
  }

  return {
    switchMainTab,
    setPreset,
    applyGlobalFilter,
    changeTradePage,
    openTradeDrawer,
    closeTradeDrawer,
    toggleTradeTag,
    addCustomTagPrompt,
    saveDrawerNotes,
    triggerScreenshotUpload,
    handleScreenshotFileUpload,
    viewFullScreenshot,
    closeImageViewer,
    triggerCoachGeneration,
    toggleGhSettings,
    saveAppSettings,
    triggerFirebaseSync,
    triggerGitHubWorkflow,
    forceSyncFromRawData,
    showPeek,
    hidePeek,
    toggleTradeLogCollapse,
    setTradeFilter,
    setTradeSort,
    openSentinelConfigModal,
    closeSentinelConfigModal,
    saveSentinelConfig,
    acknowledgeSentinel,
    switchInsightsSubTab,
    switchCoachSubTab,
    populateSelfImprovingEngineUI,
    triggerSelfImprovingAgent,
    openTelegramModal,
    closeTelegramModal,
    saveTelegramConfig,
    sendTestTelegramAlert,
    sendTelegramMessage,
    checkAndSendTelegramSignal,
    checkAndSendTelegramOutcome,
    getTelegramConfig
  };
})();
