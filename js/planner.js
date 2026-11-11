/**
 * Delta Trading Journal - 3-Month Step-Up Profit Planner Module
 * Preserves 100% of the compounding capital calculator (1x -> 2x -> 3x)
 */

window.DeltaPlanner = (function() {
  let allMonthsExpanded = false;

  const formatINR = (val, decimals = 0) => {
    const num = Number(val) || 0;
    return (num < 0 ? "-₹" : "₹") + Math.abs(num).toLocaleString('en-IN', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
  };

  function formatCalcDate(d) {
    const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const dd = String(d.getDate()).padStart(2, '0');
    const mmm = months[d.getMonth()];
    const yy = String(d.getFullYear()).slice(-2);
    const ddd = days[d.getDay()];
    return { formatted: `${dd}-${mmm}-${yy}`, weekday: ddd, mmmYY: `${mmm} '${yy}` };
  }

  function onCalcModeInput(source) {
    const pctInput = document.getElementById('calcPct');
    const amtInput = document.getElementById('calcAmt');
    const boxPct = document.getElementById('boxCalcPct');
    const boxAmt = document.getElementById('boxCalcAmt');

    if (!pctInput || !amtInput) return;

    if (source === 'PCT') {
      if (pctInput.value.trim() !== '') {
        amtInput.value = '';
        amtInput.disabled = true;
        boxAmt.classList.add('opacity-40');
        pctInput.disabled = false;
        boxPct.classList.remove('opacity-40');
      } else {
        amtInput.disabled = false;
        boxAmt.classList.remove('opacity-40');
      }
    } else if (source === 'AMT') {
      if (amtInput.value.trim() !== '') {
        pctInput.value = '';
        pctInput.disabled = true;
        boxPct.classList.add('opacity-40');
        amtInput.disabled = false;
        boxAmt.classList.remove('opacity-40');
      } else {
        pctInput.disabled = false;
        boxPct.classList.remove('opacity-40');
      }
    }
    runInrCalculator();
  }

  function resetCalculatorInputs() {
    const startInput = document.getElementById('calcStartDate');
    const capInput = document.getElementById('calcCapital');
    const pctInput = document.getElementById('calcPct');
    const amtInput = document.getElementById('calcAmt');
    const boxPct = document.getElementById('boxCalcPct');
    const boxAmt = document.getElementById('boxCalcAmt');
    const btnToggle = document.getElementById('btnToggleAllMonths');

    if (startInput) startInput.value = new Date().toISOString().split('T')[0];
    if (capInput) capInput.value = '100000';
    if (pctInput) {
      pctInput.value = '5';
      pctInput.disabled = false;
    }
    if (amtInput) {
      amtInput.value = '';
      amtInput.disabled = true;
    }
    if (boxPct) boxPct.classList.remove('opacity-40');
    if (boxAmt) boxAmt.classList.add('opacity-40');
    allMonthsExpanded = false;
    if (btnToggle) btnToggle.innerText = 'Expand All Days';
    runInrCalculator();
  }

  function toggleMonthAccordion(idx) {
    const body = document.getElementById(`calcMonthBody_${idx}`);
    const icon = document.getElementById(`calcMonthIcon_${idx}`);
    if (!body) return;
    if (body.classList.contains('hidden')) {
      body.classList.remove('hidden');
      if (icon) icon.classList.add('rotate-180');
    } else {
      body.classList.add('hidden');
      if (icon) icon.classList.remove('rotate-180');
    }
  }

  function toggleAllCalcMonths() {
    allMonthsExpanded = !allMonthsExpanded;
    const btn = document.getElementById('btnToggleAllMonths');
    if (btn) btn.innerText = allMonthsExpanded ? 'Collapse All Days' : 'Expand All Days';
    [0, 1, 2].forEach(idx => {
      const body = document.getElementById(`calcMonthBody_${idx}`);
      const icon = document.getElementById(`calcMonthIcon_${idx}`);
      if (!body) return;
      if (allMonthsExpanded) {
        body.classList.remove('hidden');
        if (icon) icon.classList.add('rotate-180');
      } else {
        body.classList.add('hidden');
        if (icon) icon.classList.remove('rotate-180');
      }
    });
  }

  function runInrCalculator() {
    const capEl = document.getElementById('calcCapital');
    const pctEl = document.getElementById('calcPct');
    const amtEl = document.getElementById('calcAmt');
    const startEl = document.getElementById('calcStartDate');
    const capFmtEl = document.getElementById('calcCapitalFormatted');

    if (!capEl || !startEl) return;

    const baseCap = parseFloat(capEl.value) || 0;
    const pctRaw = pctEl ? pctEl.value.trim() : '';
    const amtRaw = amtEl ? amtEl.value.trim() : '';
    const startStr = startEl.value;

    if (capFmtEl) capFmtEl.innerText = formatINR(baseCap, 0);

    let baseDailyProfit = 0;
    let dailyProfitPct = 0;

    if (pctRaw !== '') {
      dailyProfitPct = parseFloat(pctRaw) || 0;
      baseDailyProfit = baseCap * (dailyProfitPct / 100);
    } else if (amtRaw !== '') {
      baseDailyProfit = parseFloat(amtRaw) || 0;
      dailyProfitPct = baseCap > 0 ? (baseDailyProfit / baseCap) * 100 : 0;
    }

    const hasDecimals = (baseDailyProfit % 1 !== 0);
    const decPlaces = hasDecimals ? 2 : 0;

    let startDate = startStr ? new Date(startStr + "T00:00:00") : new Date();
    if (isNaN(startDate.getTime())) startDate = new Date();

    const sYear = startDate.getFullYear();
    const sMonth = startDate.getMonth();
    const sDay = startDate.getDate();

    const m1Offset = (sDay >= 25) ? 1 : 0;
    const m1End = new Date(sYear, sMonth + m1Offset + 1, 0);
    const m2End = new Date(sYear, sMonth + m1Offset + 2, 0);
    const m3End = new Date(sYear, sMonth + m1Offset + 3, 0);

    const m1LabelDate = new Date(sYear, sMonth + m1Offset, 1);
    const m2LabelDate = new Date(sYear, sMonth + m1Offset + 1, 1);
    const m3LabelDate = new Date(sYear, sMonth + m1Offset + 2, 1);

    const monthsMeta = [
      {
        index: 0,
        title: `Month 1 • ${formatCalcDate(m1LabelDate).mmmYY}`,
        multiplier: 1,
        capital: baseCap * 1,
        dailyProfit: baseDailyProfit * 1,
        endDate: m1End,
        days: [],
        monthProfit: 0
      },
      {
        index: 1,
        title: `Month 2 • ${formatCalcDate(m2LabelDate).mmmYY}`,
        multiplier: 2,
        capital: baseCap * 2,
        dailyProfit: baseDailyProfit * 2,
        endDate: m2End,
        days: [],
        monthProfit: 0
      },
      {
        index: 2,
        title: `Month 3 • ${formatCalcDate(m3LabelDate).mmmYY}`,
        multiplier: 3,
        capital: baseCap * 3,
        dailyProfit: baseDailyProfit * 3,
        endDate: m3End,
        days: [],
        monthProfit: 0
      }
    ];

    let curDate = new Date(startDate.getTime());
    let globalDayCount = 0;
    let runningTotalProfit = 0;
    let firstTradingDateStr = '--';
    let lastTradingDateStr = '--';

    while (curDate <= m3End) {
      const dow = curDate.getDay();
      if (dow !== 0 && dow !== 6) {
        globalDayCount++;
        let bucketIdx = 0;
        if (curDate <= m1End) bucketIdx = 0;
        else if (curDate <= m2End) bucketIdx = 1;
        else bucketIdx = 2;

        const bucket = monthsMeta[bucketIdx];
        bucket.monthProfit += bucket.dailyProfit;
        runningTotalProfit += bucket.dailyProfit;

        const { formatted, weekday } = formatCalcDate(curDate);
        if (globalDayCount === 1) firstTradingDateStr = formatted;
        lastTradingDateStr = formatted;

        bucket.days.push({
          dayNum: globalDayCount,
          monthDayNum: bucket.days.length + 1,
          formattedDate: formatted,
          weekday,
          dailyProfit: bucket.dailyProfit,
          monthCumProfit: bucket.monthProfit,
          totalCumProfit: runningTotalProfit
        });
      }
      curDate.setDate(curDate.getDate() + 1);
    }

    const badgeDailyPct = document.getElementById('sumDailyPctBadge');
    const badgeDays = document.getElementById('sumTotalDays');
    const badgeSpan = document.getElementById('sumDateSpan');
    const sumProfit = document.getElementById('sumTotal3MProfit');

    if (badgeDailyPct) badgeDailyPct.innerText = `${dailyProfitPct.toFixed(2)}% / day`;
    if (badgeDays) badgeDays.innerText = `${globalDayCount} days`;
    if (badgeSpan) badgeSpan.innerText = globalDayCount > 0 ? `(${firstTradingDateStr} → ${lastTradingDateStr})` : '';
    if (sumProfit) sumProfit.innerText = formatINR(runningTotalProfit, decPlaces);

    let unifiedHTML = '';

    monthsMeta.forEach((m, idx) => {
      let rowsHTML = '';
      m.days.forEach(d => {
        rowsHTML += `
          <tr class="hover:bg-panelDark/40 transition-colors">
            <td class="py-2.5 sm:py-3 px-4">
              <div class="flex items-center gap-2">
                <span class="font-bold text-xs sm:text-sm text-white">${d.formattedDate} | Day ${d.dayNum}</span>
                <span class="text-[10px] sm:text-xs px-1.5 py-0.5 rounded bg-brandDark border border-borderDark text-slate-400">${d.weekday}</span>
              </div>
            </td>
            <td class="py-2.5 sm:py-3 px-4 text-right">
              <span class="font-bold text-xs sm:text-sm text-winGreen block">${formatINR(d.totalCumProfit, decPlaces)}</span>
              <span class="text-[10px] sm:text-xs text-slate-400 block">M${idx + 1} Cum: ${formatINR(d.monthCumProfit, decPlaces)} (+${formatINR(d.dailyProfit, decPlaces)})</span>
            </td>
          </tr>`;
      });

      const bodyHiddenClass = allMonthsExpanded ? '' : 'hidden';
      const iconRotateClass = allMonthsExpanded ? 'rotate-180' : '';

      unifiedHTML += `
        <div class="bg-brandDark border border-borderDark hover:border-indigo-500/40 rounded-2xl overflow-hidden transition-all shadow-sm">
          <button onclick="DeltaPlanner.toggleMonthAccordion(${idx})" class="w-full p-4 sm:p-5 flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3 hover:bg-panelDark/40 transition-colors text-left">
            <div class="flex items-center gap-3.5">
              <div class="h-10 w-10 rounded-xl bg-indigo-500/10 border border-indigo-500/20 flex items-center justify-center text-indigo-400 font-bold font-mono text-xs sm:text-sm shrink-0">
                ${m.multiplier}x
              </div>
              <div>
                <div class="flex items-center gap-2">
                  <h4 class="font-bold text-sm sm:text-base text-white">${m.title}</h4>
                  <span class="text-[10px] sm:text-xs px-2 py-0.5 rounded-md bg-cardDark border border-borderDark text-slate-300 font-mono">${m.days.length} Trading Days</span>
                </div>
                <div class="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-400 font-mono mt-1">
                  <span>Base Capital: <strong class="text-slate-200">${formatINR(m.capital, 0)}</strong></span>
                  <span>Daily Profit: <strong class="text-emerald-400">${formatINR(m.dailyProfit, decPlaces)}/day</strong></span>
                </div>
              </div>
            </div>

            <div class="flex items-center justify-between sm:justify-end w-full sm:w-auto gap-4 pt-2.5 sm:pt-0 border-t sm:border-t-0 border-borderDark/60 font-mono">
              <div class="text-left sm:text-right">
                <span class="text-[10px] text-slate-400 uppercase block font-sans">Month ${idx + 1} Profit</span>
                <span class="font-bold text-base sm:text-xl text-winGreen">+${formatINR(m.monthProfit, decPlaces)}</span>
              </div>
              <div class="h-8 w-8 rounded-lg bg-cardDark border border-borderDark flex items-center justify-center text-slate-400">
                <i id="calcMonthIcon_${idx}" class="fa-solid fa-chevron-down text-xs transition-transform duration-200 ${iconRotateClass}"></i>
              </div>
            </div>
          </button>
          <div id="calcMonthBody_${idx}" class="${bodyHiddenClass} border-t border-borderDark bg-cardDark/60">
            <table class="w-full text-left border-collapse">
              <thead class="bg-brandDark/90 text-slate-400 border-b border-borderDark uppercase tracking-wider text-[10px] sm:text-xs">
                <tr>
                  <th class="py-2.5 px-4">Date & Day</th>
                  <th class="py-2.5 px-4 text-right">Cumulative Profit (₹)</th>
                </tr>
              </thead>
              <tbody class="divide-y divide-borderDark/60 font-mono text-xs sm:text-sm">
                ${rowsHTML || '<tr><td colspan="2" class="text-center py-5 text-slate-500">No weekdays in range</td></tr>'}
              </tbody>
            </table>
          </div>
        </div>`;
    });

    const container = document.getElementById('calcUnifiedMonthsContainer');
    if (container) container.innerHTML = unifiedHTML;
  }

  return {
    runInrCalculator,
    onCalcModeInput,
    resetCalculatorInputs,
    toggleMonthAccordion,
    toggleAllCalcMonths
  };
})();
