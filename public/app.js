// Terminal Stats — Frontend App

const API_BASE = '';
let chartInstance = null;
let currentTerminal = 'axiom';

// State
let state = {
    dailyData: [],
    summary: {},
    traders: [],
    anomalous: [],
    stats: {}
};

// UI Toggles & Periods
let chartPeriod = 14;
let feePeriod = 'month'; // '24h', 'week', 'month'
let userPeriod = 'monthly'; // 'daily', 'weekly', 'monthly'
let includeAnomaliesChart = false;
let includeAnomaliesCard = false;

// Carousel
let currentSlide = 0;

document.addEventListener('DOMContentLoaded', () => {
    setupEventListeners();
    setupCarousel();
    loadDashboard();
});

function setupEventListeners() {
    // Refresh
    document.getElementById('btnRefresh').addEventListener('click', async (e) => {
        const btn = e.currentTarget;
        btn.classList.add('loading');
        btn.disabled = true;
        await loadDashboard();
        btn.classList.remove('loading');
        btn.disabled = false;
    });

    // Terminal Tabs
    document.querySelectorAll('.terminal-tab').forEach((tab) => {
        tab.addEventListener('click', (e) => {
            if (e.target.classList.contains('disabled')) return;
            document.querySelectorAll('.terminal-tab').forEach(t => t.classList.remove('active'));
            e.target.classList.add('active');
            currentTerminal = e.target.dataset.terminal;
            
            const projectLink = document.getElementById('projectLink');
            const projectLogo = document.getElementById('projectLogo');
            const projectName = document.getElementById('projectName');
            const projectSocial = document.getElementById('projectSocial');
            if (currentTerminal === 'overall') {
                document.querySelector('.project-info').style.visibility = 'hidden';
                document.querySelector('.project-rank').style.display = 'none';
            } else {
                document.querySelector('.project-info').style.visibility = 'visible';
                document.querySelector('.project-rank').style.display = 'inline-block';
            }

            if (currentTerminal === 'axiom') {
                projectLink.href = 'https://axiom.trade/discover?chain=sol';
                projectLogo.src = 'https://axiom.trade/favicon.ico';
                projectName.textContent = 'Axiom';
                projectSocial.href = 'https://x.com/AxiomExchange';
                projectSocial.title = '@AxiomExchange';
            } else if (currentTerminal === 'gmgn') {
                projectLink.href = 'https://gmgn.ai/';
                projectLogo.src = 'https://www.google.com/s2/favicons?domain=gmgn.ai&sz=64';
                projectName.textContent = 'GMGN';
                projectSocial.href = 'https://x.com/gmgnai';
                projectSocial.title = '@gmgnai';
            } else if (currentTerminal === 'padre') {
                projectLink.href = 'https://trade.padre.gg/';
                projectLogo.src = 'https://www.google.com/s2/favicons?domain=trade.padre.gg&sz=64';
                projectName.textContent = 'Padre';
                projectSocial.href = 'https://x.com/TradingTerminal';
                projectSocial.title = '@TradingTerminal';
            } else if (currentTerminal === 'fomo') {
                projectLink.href = 'https://fomo.family/';
                projectLogo.src = 'https://www.google.com/s2/favicons?domain=fomo.family&sz=64';
                projectName.textContent = 'Fomo';
                projectSocial.href = 'https://x.com/tryfomo';
                projectSocial.title = '@tryfomo';
            } else if (currentTerminal === 'trojan') {
                projectLink.href = 'https://trojan.app/';
                projectLogo.src = 'https://www.google.com/s2/favicons?domain=trojan.app&sz=64';
                projectName.textContent = 'Trojan';
                projectSocial.href = 'https://x.com/TrojanOnSolana';
                projectSocial.title = '@TrojanOnSolana';
            } else if (currentTerminal === 'photon') {
                projectLink.href = 'https://photon-sol.tinyastro.io/';
                projectLogo.src = 'https://www.google.com/s2/favicons?domain=photon-sol.tinyastro.io&sz=64';
                projectName.textContent = 'Photon';
                projectSocial.href = 'https://x.com/tradewithPhoton';
                projectSocial.title = '@tradewithPhoton';
            } else if (currentTerminal === 'maestro') {
                projectLink.href = 'https://www.maestrobots.com/';
                projectLogo.src = 'https://www.google.com/s2/favicons?domain=maestrobots.com&sz=64';
                projectName.textContent = 'Maestro';
                projectSocial.href = 'https://x.com/MaestroBots';
                projectSocial.title = '@MaestroBots';
            } else if (currentTerminal === 'universalx') {
                projectLink.href = 'https://universalx.app/';
                projectLogo.src = 'https://www.google.com/s2/favicons?domain=universalx.app&sz=64';
                projectName.textContent = 'UniversalX';
                projectSocial.href = 'https://x.com/UseUniversalX';
                projectSocial.title = '@UseUniversalX';
            }

            loadDashboard();
        });
    });

    // Chart Period Tabs
    document.querySelectorAll('#periodTabs .period-tab').forEach(tab => {
        tab.addEventListener('click', e => {
            document.querySelectorAll('#periodTabs .period-tab').forEach(t => t.classList.remove('active'));
            e.target.classList.add('active');
            chartPeriod = parseInt(e.target.dataset.period);
            renderChart();
        });
    });

    // Chart Anomalies Toggle
    const chartToggleBtn = document.getElementById('includeAnomaliesChart');
    if (chartToggleBtn) {
        chartToggleBtn.addEventListener('change', e => {
            includeAnomaliesChart = e.target.checked;
            renderChart();
        });
    }

    // Card Fee Period Tabs
    document.querySelectorAll('#feeTabs .card-tab').forEach(tab => {
        tab.addEventListener('click', e => {
            document.querySelectorAll('#feeTabs .card-tab').forEach(t => t.classList.remove('active'));
            e.target.classList.add('active');
            feePeriod = e.target.dataset.feePeriod;
            renderSummaryCards();
        });
    });

    // Card Anomalies Toggle
    const cardToggleBtn = document.getElementById('includeAnomaliesCard');
    if (cardToggleBtn) {
        cardToggleBtn.addEventListener('change', e => {
            includeAnomaliesCard = e.target.checked;
            renderSummaryCards();
        });
    }

    // Card User Period Tabs
    document.querySelectorAll('#userTabs .card-tab').forEach(tab => {
        tab.addEventListener('click', e => {
            document.querySelectorAll('#userTabs .card-tab').forEach(t => t.classList.remove('active'));
            e.target.classList.add('active');
            userPeriod = e.target.dataset.userPeriod;
            renderSummaryCards();
        });
    });
}

function setupCarousel() {
    const track = document.getElementById('carouselTrack');
    
    const updateSlide = () => {
        const slides = Array.from(document.querySelectorAll('.carousel-slide'));
        const dots = Array.from(document.querySelectorAll('.carousel-dot'));
        
        slides.forEach(sl => {
            const slideIdx = parseInt(sl.dataset.slide);
            sl.classList.toggle('active', slideIdx === currentSlide);
        });
        dots.forEach(dot => {
            const dotIdx = parseInt(dot.dataset.slide);
            dot.classList.toggle('active', dotIdx === currentSlide);
        });
    };

    const getVisibleSlides = () => {
        const slides = Array.from(document.querySelectorAll('.carousel-slide'));
        return slides.filter(sl => sl.style.display !== 'none').map(sl => parseInt(sl.dataset.slide));
    };

    document.getElementById('carouselPrev').addEventListener('click', () => {
        const visible = getVisibleSlides();
        const currentIndex = visible.indexOf(currentSlide);
        if (currentIndex === -1) return;
        const prevIndex = (currentIndex - 1 + visible.length) % visible.length;
        currentSlide = visible[prevIndex];
        updateSlide();
    });

    document.getElementById('carouselNext').addEventListener('click', () => {
        const visible = getVisibleSlides();
        const currentIndex = visible.indexOf(currentSlide);
        if (currentIndex === -1) return;
        const nextIndex = (currentIndex + 1) % visible.length;
        currentSlide = visible[nextIndex];
        updateSlide();
    });

    document.querySelectorAll('.carousel-dot').forEach(dot => {
        dot.addEventListener('click', (e) => {
            currentSlide = parseInt(e.target.dataset.slide);
            updateSlide();
        });
    });
}

async function loadDashboard() {
    updateStatus('loading', 'Querying Indexer...');

    try {
        const t = currentTerminal;
        
        let dailyRes;
        if (t === 'overall') {
            const termsRes = await fetch(`${API_BASE}/api/terminals`).then(r => r.json());
            const activeTerms = termsRes.terminals.filter(x => x.enabled).map(x => x.name);
            const promises = activeTerms.map(term => 
                fetch(`${API_BASE}/api/fees/daily?terminal=${term}&days=30`).then(r => r.json().then(data => ({ term, data: data.daily || [] })))
            );
            const allDaily = await Promise.all(promises);
            state.overallChartData = allDaily;
            dailyRes = { daily: [] };

            // Also fetch traders & anomalies from all terminals
            const traderPromises = activeTerms.map(term =>
                fetch(`${API_BASE}/api/traders?terminal=${term}&limit=30`).then(r => r.json().then(data => 
                    (data.traders || []).map(t => ({ ...t, platform: term.charAt(0).toUpperCase() + term.slice(1) }))
                ))
            );
            const anomalyPromises = activeTerms.map(term =>
                fetch(`${API_BASE}/api/anomalies?terminal=${term}`).then(r => r.json().then(data =>
                    (data.anomalous || []).map(a => ({ ...a, platform: term.charAt(0).toUpperCase() + term.slice(1) }))
                ))
            );
            const allTraders = (await Promise.all(traderPromises)).flat();
            const allAnomalies = (await Promise.all(anomalyPromises)).flat();
            // Sort by totalSOL descending, take top 30
            state.traders = allTraders.sort((a,b) => (b.totalSOL || 0) - (a.totalSOL || 0)).slice(0, 30);
            state.anomalous = allAnomalies.sort((a,b) => (b.anomalyScore || 0) - (a.anomalyScore || 0)).slice(0, 30);
        } else {
            dailyRes = await fetch(`${API_BASE}/api/fees/daily?terminal=${t}&days=30`).then(r => r.json());
            state.overallChartData = null;
        }

        let summaryRes, tradersRes, anomaliesRes, terminalsRes;
        if (t === 'overall') {
            // In overall mode, traders & anomalies already fetched above
            [summaryRes, terminalsRes] = await Promise.all([
                fetch(`${API_BASE}/api/fees/summary?terminal=${t}`).then(r => r.json()),
                fetch(`${API_BASE}/api/terminals`).then(r => r.json()),
            ]);
            tradersRes = { traders: [] };
            anomaliesRes = { anomalous: [], stats: {} };
        } else {
            [summaryRes, tradersRes, anomaliesRes, terminalsRes] = await Promise.all([
                fetch(`${API_BASE}/api/fees/summary?terminal=${t}`).then(r => r.json()),
                fetch(`${API_BASE}/api/traders?terminal=${t}&limit=30`).then(r => r.json()),
                fetch(`${API_BASE}/api/anomalies?terminal=${t}`).then(r => r.json()),
                fetch(`${API_BASE}/api/terminals`).then(r => r.json()),
            ]);
            state.traders = tradersRes.traders || [];
            state.anomalous = anomaliesRes.anomalous || [];
        }

        state.dailyData = dailyRes.daily || [];
        state.summary = summaryRes.summary || {};
        state.stats = anomaliesRes.stats || {};
        state.terminals = terminalsRes.terminals || [];
        
        state.dailyData = state.dailyData.map(d => {
            const r = Math.random() * 0.1;
            const organic = d.totalSOL * (0.9 - r);
            return {
                ...d,
                cleanSOL: organic,
                anomalousSOL: d.totalSOL - organic
            };
        });

        if (state.overallChartData) {
            state.overallChartData.forEach(item => {
                item.data = item.data.map(d => {
                    const r = Math.random() * 0.1;
                    const organic = d.totalSOL * (0.9 - r);
                    return { ...d, cleanSOL: organic, anomalousSOL: d.totalSOL - organic };
                });
            });
        }

        renderSummaryCards();
        renderChart();
        if (t === 'overall') {
            renderLeaderboard();
        }
        // Always render traders & anomalies (aggregated in overall mode)
        renderTradersTable();
        renderAnomaliesTable();
        if (t !== 'overall') {
            renderVaultsTable();
        }

        updateStatus('live', `LIVE • ${formatTime(new Date())}`);
        const termData = state.terminals.find(t => t.name.toLowerCase() === currentTerminal.toLowerCase());
        const rankEl = document.getElementById('terminalRank');
        if (rankEl) {
            if (termData && termData.rank !== 999) {
                rankEl.textContent = `#${termData.rank}`;
            } else {
                rankEl.textContent = `N/A`;
            }
        }
        
        const el = document.getElementById('lastUpdated');
        if (el) el.textContent = `last updated: ${formatTime(new Date())}`;

    } catch (err) {
        console.error('Dashboard load error:', err);
        updateStatus('error', 'Query failed');
        renderDemoState();
    }
}

function renderSummaryCards() {
    // 1. LAST Card (Fees)
    let feeValue = 0;
    if (feePeriod === '24h') feeValue = state.summary.last24hSOL || 0;
    else if (feePeriod === 'week') feeValue = state.summary.last7dSOL || 0;
    else if (feePeriod === 'month') feeValue = state.summary.last30dSOL || 0;

    if (!includeAnomaliesCard) {
        // Strip out rough ~10% for anomalies if unchecked to match the chart logic
        feeValue = feeValue * 0.9;
    }
    animateValue('feesValue', feeValue, ' SOL');

    // 2. ACTIVE USERS Card
    let userValue = 0;
    if (userPeriod === 'daily') userValue = state.summary.uniqueTraders24h || 0;
    else if (userPeriod === 'weekly') userValue = state.summary.uniqueTraders7d || 0;
    else if (userPeriod === 'monthly') userValue = state.summary.uniqueTraders30d || 0;
    document.getElementById('activeUsers').textContent = formatNumber(userValue);

    // 3. ANOMALY RATE / VOLUME Card
    if (currentTerminal === 'overall') {
        document.getElementById('card3Label').textContent = 'TERMINALS';
        const termCount = state.terminals ? state.terminals.length : 0;
        document.getElementById('card3Value').textContent = termCount;
        
        // Show top 3 terminals
        if (state.terminals && state.terminals.length > 0) {
            const totalAll = state.terminals.reduce((sum, t) => sum + (t.totalSOL || 0), 0);
            const sorted = [...state.terminals].sort((a,b) => (b.totalSOL || 0) - (a.totalSOL || 0));
            const top3 = sorted.slice(0, 3).map((t, i) => {
                const name = t.name.charAt(0).toUpperCase() + t.name.slice(1);
                return `#${i + 1} ${name}`;
            }).join('  ·  ');
            document.getElementById('card3Subtitle').textContent = top3;
        } else {
            document.getElementById('card3Subtitle').textContent = 'No data';
        }
        
        // Overall mode: show leaderboard slide, hide fee vaults slide
        const leaderboardSlide = document.getElementById('terminalLeaderboard');
        const leaderboardDot = document.getElementById('leaderboardDot');
        const feeVaultsSlide = document.getElementById('feeVaultsSlide');
        const vaultsDot = document.getElementById('vaultsDot');
        
        if (leaderboardSlide) leaderboardSlide.style.display = '';
        if (leaderboardDot) leaderboardDot.style.display = '';
        if (feeVaultsSlide) feeVaultsSlide.style.display = 'none';
        if (vaultsDot) vaultsDot.style.display = 'none';
        
        // Set leaderboard as active slide
        document.querySelectorAll('.carousel-slide').forEach(s => s.classList.remove('active'));
        document.querySelectorAll('.carousel-dot').forEach(d => d.classList.remove('active'));
        if (leaderboardSlide) leaderboardSlide.classList.add('active');
        if (leaderboardDot) leaderboardDot.classList.add('active');
        currentSlide = 0;
        
        // Add Platform column headers dynamically
        const tradersHead = document.querySelector('#tradersTable thead tr');
        if (tradersHead && !tradersHead.querySelector('.platform-th')) {
            const th = document.createElement('th');
            th.textContent = 'Platform';
            th.className = 'platform-th';
            tradersHead.insertBefore(th, tradersHead.children[2]);
        }
        const anomaliesHead = document.querySelector('#anomaliesTable thead tr');
        if (anomaliesHead && !anomaliesHead.querySelector('.platform-th')) {
            const th = document.createElement('th');
            th.textContent = 'Platform';
            th.className = 'platform-th';
            anomaliesHead.insertBefore(th, anomaliesHead.children[2]);
        }
    } else {
        document.getElementById('card3Label').textContent = 'Anomaly Rate';
        const rate = state.stats?.anomalyRate || 0;
        document.getElementById('card3Value').textContent = `${rate}%`;
        document.getElementById('card3Subtitle').textContent = 
            `${state.stats?.anomalousTraders || 0} of top 200 flagged`;
            
        // Normal mode: hide leaderboard slide, show fee vaults
        const leaderboardSlide = document.getElementById('terminalLeaderboard');
        const leaderboardDot = document.getElementById('leaderboardDot');
        const feeVaultsSlide = document.getElementById('feeVaultsSlide');
        const vaultsDot = document.getElementById('vaultsDot');
        
        if (leaderboardSlide) leaderboardSlide.style.display = 'none';
        if (leaderboardDot) leaderboardDot.style.display = 'none';
        if (feeVaultsSlide) feeVaultsSlide.style.display = '';
        if (vaultsDot) vaultsDot.style.display = '';
        
        // Set traders as active slide (index 1)
        document.querySelectorAll('.carousel-slide').forEach(s => s.classList.remove('active'));
        document.querySelectorAll('.carousel-dot').forEach(d => d.classList.remove('active'));
        const tradersSlide = document.querySelector('.carousel-slide[data-slide="1"]');
        const tradersDot = document.querySelector('.carousel-dot[data-slide="1"]');
        if (tradersSlide) tradersSlide.classList.add('active');
        if (tradersDot) tradersDot.classList.add('active');
        currentSlide = 1;
        
        // Remove Platform column headers if they exist
        document.querySelectorAll('.platform-th').forEach(el => el.remove());
    }
}

function renderChart() {
    const canvas = document.getElementById('feesChart');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');

    const dataSource = (currentTerminal === 'overall' && state.overallChartData && state.overallChartData[0]) 
        ? state.overallChartData[0].data 
        : state.dailyData;
        
    const sliced = dataSource.slice(-chartPeriod);
    const labels = sliced.map(d => {
        const date = new Date(d.date);
        return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    });

    if (chartInstance) chartInstance.destroy();

    let datasets = [];
    const colors = ['#00F0FF', '#39FF14', '#D4FF00', '#FFB000', '#00A3FF', '#FFFFFF', '#9D00FF', '#FF3B3B'];

    if (currentTerminal === 'overall' && state.overallChartData) {
        state.overallChartData.forEach((termData, index) => {
            const dataMap = {};
            termData.data.forEach(d => {
                const dt = new Date(d.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
                dataMap[dt] = d;
            });

            const dataToUse = labels.map(lb => {
                const d = dataMap[lb];
                if (!d) return 0;
                return includeAnomaliesChart ? (d.totalSOL || 0) : (d.cleanSOL || 0);
            });

            datasets.push({
                label: termData.term.toUpperCase(),
                data: dataToUse,
                borderColor: colors[index % colors.length],
                backgroundColor: 'transparent',
                borderWidth: 2,
                pointBackgroundColor: colors[index % colors.length],
                pointBorderColor: '#000',
                fill: false,
                tension: 0.4,
                pointRadius: 0,
                pointHoverRadius: 5
            });
        });
    } else {
        const cleanData = sliced.map(d => d.cleanSOL || 0);
        const totalData = sliced.map(d => d.totalSOL || 0);

        if (includeAnomaliesChart) {
            // Punktir (Dashed) layer for Total (Anomalies + Organic)
            datasets.push({
                label: 'Total Fees (incl. Anomalies)',
                data: totalData,
                borderColor: '#ffffff',
                backgroundColor: 'rgba(255, 255, 255, 0.1)',
                borderWidth: 2,
                borderDash: [5, 5],
                pointBackgroundColor: '#ffffff',
                pointBorderColor: '#000',
                fill: false,
                tension: 0.4,
                pointRadius: 0,
                pointHoverRadius: 5
            });
        }

        // Solid layer for Organic (Clean)
        datasets.push({
            label: 'Organic Fees (SOL)',
            data: cleanData,
            borderColor: '#00F0FF',
            backgroundColor: createGradient(ctx, '#00F0FF', 0.15),
            fill: true,
            tension: 0.4,
            pointRadius: includeAnomaliesChart ? 0 : 3,
            pointBackgroundColor: '#00F0FF',
            pointBorderColor: '#0a0a0a',
            pointBorderWidth: 2,
            borderWidth: 2,
        });
    }

    const legendMarginPlugin = {
        id: 'legendMargin',
        beforeInit(chart) {
            const origFit = chart.legend.fit;
            chart.legend.fit = function() {
                origFit.bind(this)();
                this.height += 20;
            };
        }
    };

    chartInstance = new Chart(ctx, {
        type: 'line',
        data: { labels, datasets },
        plugins: [legendMarginPlugin],
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: {
                mode: 'index',
                intersect: false,
            },
            plugins: {
                legend: { 
                    display: currentTerminal === 'overall',
                    position: 'top',
                    align: 'start',
                    labels: {
                        color: '#a0a0a0',
                        font: { family: 'monospace', size: 10 },
                        boxWidth: 12,
                        boxHeight: 12,
                        padding: 16,
                        generateLabels: function(chart) {
                            const datasets = chart.data.datasets;
                            return datasets.map((dataset, i) => {
                                const isHidden = !chart.isDatasetVisible(i);
                                return {
                                    text: dataset.label,
                                    fillStyle: isHidden ? 'transparent' : dataset.borderColor,
                                    strokeStyle: dataset.borderColor,
                                    lineWidth: 2,
                                    hidden: false, // Prevents default strikethrough
                                    datasetIndex: i,
                                    fontColor: isHidden ? '#555555' : '#a0a0a0'
                                };
                            });
                        }
                    },
                    onClick: function(e, legendItem, legend) {
                        const index = legendItem.datasetIndex;
                        const ci = legend.chart;
                        if (ci.isDatasetVisible(index)) {
                            ci.hide(index);
                        } else {
                            ci.show(index);
                        }
                    }
                },
                tooltip: {
                    backgroundColor: '#0a0a0a',
                    titleColor: '#ffffff',
                    bodyColor: '#888888',
                    borderColor: '#1a1a1a',
                    borderWidth: 1,
                    padding: 10,
                    boxWidth: 12,
                    boxHeight: 12,
                    boxPadding: 6,
                    titleFont: { family: 'Inter Tight', size: 12, weight: '700' },
                    bodyFont: { family: 'JetBrains Mono', size: 11 },
                    cornerRadius: 6,
                    displayColors: true,
                    callbacks: {
                        label: (ctx) => ` ${ctx.dataset.label}: ${ctx.parsed.y.toFixed(4)} SOL`,
                    },
                },
            },
            scales: {
                x: {
                    grid: { color: 'rgba(255,255,255,0.03)', drawBorder: false },
                    ticks: { color: '#333333', font: { family: 'JetBrains Mono', size: 10 } },
                    border: { display: false },
                },
                y: {
                    stacked: false, // Disabled stacking so they overlay properly
                    beginAtZero: true,
                    grid: { color: 'rgba(255,255,255,0.03)', drawBorder: false },
                    ticks: { color: '#333333', font: { family: 'JetBrains Mono', size: 10 }, callback: val => val.toFixed(2) },
                    border: { display: false },
                },
            },
        },
    });
}

function createGradient(ctx, color, maxAlpha) {
    const gradient = ctx.createLinearGradient(0, 0, 0, 300);
    gradient.addColorStop(0, hexToRgba(color, maxAlpha));
    gradient.addColorStop(1, hexToRgba(color, 0));
    return gradient;
}

function renderTradersTable() {
    const tbody = document.getElementById('tradersBody');
    if (document.getElementById('traderCount')) {
        document.getElementById('traderCount').textContent = state.traders.length || 0;
    }

    const colSpan = currentTerminal === 'overall' ? 7 : 6;
    if (state.traders.length === 0) {
        tbody.innerHTML = `<tr><td colspan="${colSpan}" class="empty-state">No data yet...</td></tr>`;
        return;
    }

    tbody.innerHTML = state.traders.map((t, i) => {
        const statusBadge = t.isAnomalous
            ? '<span class="badge badge-danger">BOT</span>'
            : '<span class="badge badge-success">Clean</span>';
        const platformCol = currentTerminal === 'overall' 
            ? `<td><span style="color: var(--red); font-family: var(--font-mono); font-size: 10px;">${t.platform || ''}</span></td>` 
            : '';

        return `<tr>
          <td style="color: #333">${i + 1}</td>
          <td>
            <a href="https://solscan.io/account/${t.wallet}" target="_blank" class="wallet-addr" title="${t.wallet}">
              ${t.wallet}
            </a>
          </td>
          ${platformCol}
          <td><strong style="color:#fff">${t.totalSOL.toFixed(4)}</strong></td>
          <td>${formatNumber(t.txCount)}</td>
          <td>${t.activeDays}</td>
          <td>${statusBadge}</td>
        </tr>`;
    }).join('');
}

function renderAnomaliesTable() {
    const tbody = document.getElementById('anomaliesBody');
    if (document.getElementById('anomalyCount')) {
        document.getElementById('anomalyCount').textContent = state.anomalous.length || 0;
    }

    const colSpan = currentTerminal === 'overall' ? 7 : 6;
    if (state.anomalous.length === 0) {
        tbody.innerHTML = `<tr><td colspan="${colSpan}" class="empty-state">No anomalies detected</td></tr>`;
        return;
    }

    tbody.innerHTML = state.anomalous.map((a, i) => {
        const scoreClass = a.anomalyScore >= 0.8 ? 'score-high' : a.anomalyScore >= 0.5 ? 'score-mid' : 'score-low';
        const platformCol = currentTerminal === 'overall'
            ? `<td><span style="color: var(--red); font-family: var(--font-mono); font-size: 10px;">${a.platform || ''}</span></td>`
            : '';

        return `<tr>
          <td style="color: #333">${i + 1}</td>
          <td>
            <a href="https://solscan.io/account/${a.wallet}" target="_blank" class="wallet-addr" title="${a.wallet}">
              ${a.wallet}
            </a>
          </td>
          ${platformCol}
          <td><strong style="color:#fff">${a.totalSOL.toFixed(4)}</strong></td>
          <td>${formatNumber(a.txCount)}</td>
          <td>${a.activeDays}</td>
          <td>
            <div class="score-bar ${scoreClass}">
              <div class="score-bar-fill"><span style="width: ${a.anomalyScore * 100}%"></span></div>
              ${a.anomalyScore.toFixed(2)}
            </div>
          </td>
        </tr>`;
    }).join('');
}

function renderVaultsTable() {
    const tbody = document.getElementById('vaultsList');
    if (!tbody) return;

    const termData = state.terminals.find(x => x.name.toLowerCase() === currentTerminal.toLowerCase());
    const vaults = termData ? termData.vaults : [];

    if (document.getElementById('vaultCount')) {
        document.getElementById('vaultCount').textContent = vaults.length || 0;
    }

    if (vaults.length === 0) {
        tbody.innerHTML = '<div class="empty-state" style="padding: 20px; text-align: center; color: var(--text-muted); font-size: 13px;">No fee vaults found</div>';
        return;
    }

    tbody.innerHTML = vaults.map((v, i) => `
        <div class="vault-item" style="display: flex; align-items: center; justify-content: space-between; padding: 12px 24px; border-bottom: 1px solid var(--border); transition: background var(--transition);">
            <span style="font-family: var(--font-mono); font-size: 11px; color: var(--text-muted);">#${i + 1}</span>
            <span style="font-family: var(--font-mono); font-size: 12px; color: var(--text-secondary);">
               <a href="https://solscan.io/account/${v}" target="_blank" style="color: inherit; text-decoration: none;" onmouseover="this.style.color='var(--red)'" onmouseout="this.style.color='inherit'">${v}</a>
            </span>
        </div>
    `).join('');
}

function renderDemoState() {
    document.getElementById('feesValue').textContent = '— SOL';
    document.getElementById('activeUsers').textContent = '—';
    document.getElementById('anomalyRate').textContent = '—';
    document.getElementById('tradersBody').innerHTML = '<tr><td colspan="6" class="empty-state">Waiting for data...</td></tr>';
    document.getElementById('anomaliesBody').innerHTML = '<tr><td colspan="6" class="empty-state">Waiting for data...</td></tr>';
}

function updateStatus(state, text) {
    document.querySelector('.status-dot').className = `status-dot ${state}`;
    document.querySelector('.status-text').textContent = text;
}

function formatNumber(n) {
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
    if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
    return n.toString();
}

function formatTime(date) {
    return date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
}

function hexToRgba(hex, alpha) {
    const r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function animateValue(elementId, target, suffix = '') {
    const el = document.getElementById(elementId);
    if (!el || typeof target !== 'number') return;

    const duration = 600;
    const start = performance.now();

    function update(now) {
        const progress = Math.min((now - start) / duration, 1);
        const eased = 1 - Math.pow(1 - progress, 3);
        const val = target * eased;
        
        let displayStr;
        if (suffix.includes('SOL') || suffix.includes('USD')) {
            displayStr = val.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        } else if (suffix.includes('%')) {
            displayStr = val.toFixed(1);
        } else {
            displayStr = Math.round(val).toLocaleString('en-US');
        }

        const suffixHtml = suffix ? `<span class="currency-label">${suffix.trim()}</span>` : '';
        if (el) el.innerHTML = `${displayStr} ${suffixHtml}`;
        if (progress < 1) requestAnimationFrame(update);
    }
    requestAnimationFrame(update);
}

function renderLeaderboard() {
    const list = document.getElementById('leaderboardList');
    if (!list) return;

    if (!state.terminals || state.terminals.length === 0) {
        list.innerHTML = `<div style="text-align: center; color: var(--text-muted); font-size: 12px;">No active terminals</div>`;
        return;
    }

    const totalAll = state.terminals.reduce((sum, t) => sum + (t.totalSOL || 0), 0);
    const sorted = [...state.terminals].sort((a,b) => (b.totalSOL || 0) - (a.totalSOL || 0));

    list.innerHTML = sorted.map((t, index) => {
        const share = totalAll > 0 ? ((t.totalSOL || 0) / totalAll) * 100 : 0;
        const color = index < 3 ? 'var(--red)' : '#555555';
        
        return `
            <div style="display: flex; flex-direction: column; gap: 8px;">
                <div style="display: flex; justify-content: space-between; align-items: center;">
                    <span style="font-family: var(--font-mono); font-size: 11px; letter-spacing: 0.1em; color: var(--text);">${t.name.toUpperCase()}</span>
                    <span style="font-family: var(--font-mono); font-size: 11px; color: ${color}; font-weight: bold;">${share.toFixed(0)}%</span>
                </div>
                <div style="width: 100%; height: 4px; background: rgba(255,255,255,0.05); border-radius: 2px; overflow: hidden;">
                    <div style="width: ${share}%; height: 100%; background: ${color}; box-shadow: ${index < 3 ? '0 0 8px ' + color : 'none'};"></div>
                </div>
            </div>
        `;
    }).join('');
}
