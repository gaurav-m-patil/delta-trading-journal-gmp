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

  function initSwipeNavigation() {
    let touchStartX = 0;
    let touchStartY = 0;

    document.addEventListener('touchstart', (e) => {
      if (e.touches.length !== 1) return;
      touchStartX = e.touches[0].clientX;
      touchStartY = e.touches[0].clientY;
    }, { passive: true });

    document.addEventListener('touchend', (e) => {
      if (e.changedTouches.length !== 1) return;

      const drawerOpen = document.getElementById('tradeDrawer')?.classList.contains('drawer-open');
      const settingsOpen = !document.getElementById('ghSettingsModal')?.classList.contains('opacity-0');
      const tag = (e.target.tagName || '').toLowerCase();
      if (drawerOpen || settingsOpen || tag === 'input' || tag === 'textarea' || tag === 'select') return;

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

    // Call/Put metrics
    let callPnl = 0, putPnl = 0, callTrades = 0, putTrades = 0;
    currentFilteredTrades.forEach(t => {
      if (t.isCall) { callPnl += t.gross_pnl; callTrades++; }
      else { putPnl += t.gross_pnl; putTrades++; }
    });

    renderTrajectoryChart(currentFilteredTrades, isSingleMonth);
    renderInstrumentCharts(callPnl, putPnl, callTrades, putTrades);
    renderMiddleSection(isSingleMonth, targetMonthStr, startDate, endDate, displayLabel);
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
  // 5. TRADE AUDIT LOG & SLIDE-OVER DRAWER
  // -------------------------------------------------------------
  function changeTradePage(delta) {
    const totalPages = Math.max(1, Math.ceil(currentFilteredTrades.length / TRADES_PER_PAGE));
    currentTradePage = Math.min(totalPages, Math.max(1, currentTradePage + delta));
    renderPaginatedTrades();
  }

  function renderPaginatedTrades() {
    const tbody = document.getElementById('tradeLogBody');
    const mobileContainer = document.getElementById('tradeLogMobileCards');
    const pagControls = document.getElementById('paginationControls');

    const totalTrades = currentFilteredTrades.length;
    const badge = document.getElementById('tradeCountBadge');
    if (badge) badge.innerText = `Showing ${totalTrades} positions`;

    if (!tbody || !mobileContainer) return;

    if (totalTrades === 0) {
      tbody.innerHTML = `<tr><td colspan="10" class="text-center py-8 text-slate-500 font-sans">No closed trades recorded in this period.</td></tr>`;
      mobileContainer.innerHTML = `<div class="text-center py-8 text-slate-500 text-xs">No closed trades recorded in this period.</div>`;
      if (pagControls) {
        pagControls.classList.add('hidden');
        pagControls.classList.remove('flex');
      }
      return;
    }

    const totalPages = Math.ceil(totalTrades / TRADES_PER_PAGE);
    const startIdx = (currentTradePage - 1) * TRADES_PER_PAGE;
    const pageTrades = currentFilteredTrades.slice(startIdx, startIdx + TRADES_PER_PAGE);

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

    if (!token || !owner || !repo) {
      toggleGhSettings();
      alert("Please configure your GitHub PAT, Username, and Repo Name in Settings first.");
      return;
    }

    const btn = document.getElementById('syncWorkflowBtn');
    if (btn) {
      btn.innerHTML = `<i class="fa-solid fa-circle-notch fa-spin"></i> Triggering...`;
      btn.disabled = true;
    }

    try {
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
      alert("Workflow triggered! Wait ~45 seconds, then click Refresh.");
    } catch (err) {
      alert(`Failed to trigger workflow: ${err.message}`);
    } finally {
      if (btn) {
        btn.innerHTML = `<i class="fa-solid fa-play"></i> Run Sync`;
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
    showPeek,
    hidePeek
  };
})();
