// script.js
// Data source: CoinGecko public API (no API key required)

// Config
const API_BASE = 'https://api.coingecko.com/api/v3';
const REFRESH_SECONDS = 30;           
const COIN_COUNT = 40;                
let vsCurrency = localStorage.getItem('cp_currency') || 'usd';
let coinsData = [];                   // cached coins list
let refreshTimer = null;
let charts = {};                      // small sparkline charts
let detailChart = null;

// Chart data cache: key = `${coinId}-${vsCurrency}-${days}`, value = { data, timestamp }
let chartCache = new Map();
const CACHE_TTL = 60_000; // 1 minute

// Coin detail cache: key = `${coinId}-${vsCurrency}`, value = { data, timestamp }
let coinDetailCache = new Map();

// ---- Request queue + retry-with-backoff ----
// The free CoinGecko tier allows only a handful of calls per minute.
// Firing several requests back-to-back (e.g. clicking through coins fast)
// causes 429s even with caching in place. This wrapper:
//   1. Spaces every API call out by a minimum gap (MIN_GAP_MS)
//   2. Automatically retries on 429 with exponential backoff
let requestQueue = Promise.resolve();
let lastRequestTime = 0;
const MIN_GAP_MS = 1500;      // minimum time between any two API calls
const MAX_RETRIES = 3;
const BASE_BACKOFF_MS = 2000; // first retry waits ~2s, then ~4s, then ~8s

function sleep(ms){ return new Promise(res => setTimeout(res, ms)); }

// Queued, auto-retrying fetch. Use this for every CoinGecko API call.
function apiFetch(url){
  // Chain onto the queue so calls never overlap/burst.
  const run = requestQueue.then(async () => {
    const wait = Math.max(0, MIN_GAP_MS - (Date.now() - lastRequestTime));
    if (wait > 0) await sleep(wait);
    lastRequestTime = Date.now();

    let lastErr;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++){
      const r = await fetch(url);

      if (r.status === 429){
        lastErr = new Error('RATE_LIMITED');
        if (attempt < MAX_RETRIES){
          const backoff = BASE_BACKOFF_MS * Math.pow(2, attempt);
          console.warn(`429 on ${url} — retrying in ${backoff}ms (attempt ${attempt + 1}/${MAX_RETRIES})`);
          await sleep(backoff);
          lastRequestTime = Date.now();
          continue;
        }
        throw lastErr;
      }

      if (!r.ok){
        throw new Error(`HTTP_${r.status}`);
      }

      return r.json();
    }
    throw lastErr;
  });

  // Keep the queue chain alive even if this call fails, so later calls
  // still wait their turn instead of piling up.
  requestQueue = run.catch(() => {});
  return run;
}

// DOM
const statusEl = document.getElementById('status');
const cardsGrid = document.getElementById('cardsGrid');
const searchInput = document.getElementById('search');
const currencySelect = document.getElementById('currency');
const themeToggle = document.getElementById('themeToggle');
const watchlistBtn = document.getElementById('watchlistBtn');
const modal = document.getElementById('modal');
const modalBody = document.getElementById('modalBody');
const modalClose = document.getElementById('modalClose');
const globalStats = document.getElementById('globalStats');
const refreshIntervalSpan = document.getElementById('refreshInterval');

refreshIntervalSpan.textContent = REFRESH_SECONDS;
currencySelect.value = vsCurrency;

// Helpers
const formatPrice = (n) => {
  if (n === null || n === undefined) return '—';
  const opts = { maximumFractionDigits: 2 };
  if (vsCurrency === 'inr') return new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2 }).format(n);
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 }).format(n);
};
const formatNumber = (n) => n ? Intl.NumberFormat().format(Math.round(n)) : '—';
const isPositive = (v) => Number(v) >= 0;

// Watchlist helpers
const watchlistKey = 'cp_watchlist_v1';
const getWatchlist = () => JSON.parse(localStorage.getItem(watchlistKey) || '[]');
const toggleWatch = (coinId) => {
  const list = getWatchlist();
  const i = list.indexOf(coinId);
  if (i === -1) list.push(coinId); else list.splice(i, 1);
  localStorage.setItem(watchlistKey, JSON.stringify(list));
  renderCards(filterCoins());
};
const inWatchlist = (coinId) => getWatchlist().includes(coinId);

// UI: set status
function setStatus(msg){
  statusEl.textContent = msg;
}

// Fetch global market data + coins list
let lastUpdated = "";

async function fetchData() {
  try {
    setStatus("Fetching market data...");

    // Global Stats
    const gJson = await apiFetch(`${API_BASE}/global`);
    renderGlobal(gJson.data);

    // Coins
    const coinsJson = await apiFetch(
      `${API_BASE}/coins/markets?vs_currency=${vsCurrency}&order=market_cap_desc&per_page=${COIN_COUNT}&page=1&sparkline=true&price_change_percentage=24h`
    );

    coinsData = coinsJson;

    lastUpdated = new Date().toLocaleTimeString();

    setStatus(`Updated ${lastUpdated}`);

    renderCards(filterCoins());

    } catch (err) {

      console.error(err);

      if (err.message === 'RATE_LIMITED') {
        setStatus(lastUpdated ? `Last updated: ${lastUpdated} • Rate limited, will retry...` : 'Rate limited — please wait...');
      } else if (lastUpdated) {
        setStatus(`Last updated: ${lastUpdated} • Retrying...`);
      } else {
        setStatus("Unable to fetch data. Retrying...");
      }
    }
  }

// Render global stats
function renderGlobal(data){
  if(!data) return;
  globalStats.innerHTML = `
    <div class="stat">
      <div class="label">Active Cryptos</div>
      <div class="value">${formatNumber(data.active_cryptocurrencies)}</div>
    </div>
    <div class="stat">
      <div class="label">Markets</div>
      <div class="value">${formatNumber(data.markets)}</div>
    </div>
    <div class="stat">
      <div class="label">Total Market Cap (USD)</div>
      <div class="value">${formatPrice(data.total_market_cap.usd || 0)}</div>
    </div>
    <div class="stat">
      <div class="label">BTC Dominance</div>
      <div class="value">${(data.market_cap_percentage.btc || 0).toFixed(2)}%</div>
    </div>
  `;
}

// Filter based on search input
function filterCoins(){
  const q = searchInput.value.trim().toLowerCase();
  if (!q) return coinsData.slice();
  return coinsData.filter(c => (c.name + ' ' + c.symbol).toLowerCase().includes(q));
}

// Render cards
function renderCards(list){
  // Clear any existing small charts
  Object.values(charts).forEach(ch => ch.destroy?.());
  charts = {};
  cardsGrid.innerHTML = '';

  if (!list || list.length === 0){
    cardsGrid.innerHTML = `<div style="grid-column:1/-1;color:var(--muted)">No coins found</div>`;
    return;
  }

  // sort such that watchlist coins appear first
  list.sort((a,b) => (inWatchlist(b.id)?1:0) - (inWatchlist(a.id)?1:0));

  const frag = document.createDocumentFragment();
  list.forEach(coin => {
    const c = createCardElement(coin);
    frag.appendChild(c);
  });
  cardsGrid.appendChild(frag);

  // create small sparklines for each visible canvas
  document.querySelectorAll('.smallchart canvas').forEach(canvas => {
    const prices = JSON.parse(canvas.dataset.spark || '[]');
    if (!prices || prices.length === 0) return;
    const ctx = canvas.getContext('2d');
    const chart = new Chart(ctx, {
      type: 'line',
      data: { labels: prices.map((_, i) => i), datasets: [{ data: prices, borderWidth: 1, pointRadius: 0 }] },
      options: {
        responsive: true, maintainAspectRatio: false, elements: { line: { borderColor: 'rgba(127,86,255,0.9)' } },
        plugins: { legend: { display: false } }, scales: { x: { display: false }, y: { display: false } }
      }
    });
    charts[canvas.id] = chart;
  });
}

function createCardElement(coin){
  const el = document.createElement('article');
  el.className = 'card';
  el.innerHTML = `
    <div class="top">
      <div class="coin">
        <img src="${coin.image}" alt="${coin.name} logo" loading="lazy" />
        <div>
          <div class="name">${coin.name}</div>
          <div class="sym">${coin.symbol.toUpperCase()} • Rank ${coin.market_cap_rank}</div>
        </div>
      </div>
      <div style="text-align:right">
        <div class="price">${formatPrice(coin.current_price)}</div>
        <div class="sym" style="font-weight:600">${formatNumber(coin.market_cap)}</div>
      </div>
    </div>

    <div style="display:flex;gap:0.6rem;align-items:center;justify-content:space-between">
      <div class="change ${isPositive(coin.price_change_percentage_24h) ? 'pos' : 'neg'}" style="background:${isPositive(coin.price_change_percentage_24h) ? 'rgba(16,185,129,0.09)' : 'rgba(239,68,68,0.06)'};color:${isPositive(coin.price_change_percentage_24h)?'var(--success)':'var(--danger)'}">
        ${coin.price_change_percentage_24h ? coin.price_change_percentage_24h.toFixed(2) + '%' : '—'}
      </div>
      <div style="flex:1;padding-left:0.6rem" class="smallchart"><canvas id="spark-${coin.id}" data-spark='${JSON.stringify((coin.sparkline_in_7d && coin.sparkline_in_7d.price) || [])}'></canvas></div>
    </div>

    <div class="actions">
      <div>
        <button class="btn btn-details" data-id="${coin.id}">Details</button>
        <button class="btn btn-watch" data-id="${coin.id}">${inWatchlist(coin.id) ? '★' : '☆'} Watch</button>
      </div>
      <div class="sym">Vol: ${formatNumber(coin.total_volume)}</div>
    </div>
  `;

  // listeners
  el.querySelector('.btn-details').addEventListener('click', () => openDetails(coin.id));
  el.querySelector('.btn-watch').addEventListener('click', (e) => {
    toggleWatch(coin.id);
  });

  return el;
}

// Debounce helper (simple)
function debounce(fn, wait=300){
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(()=>fn(...args), wait); };
}

// Open coin details modal
async function openDetails(coinId){
  modal.setAttribute('aria-hidden','false');
  modal.style.display = 'flex';
  modalBody.innerHTML = `<div style="padding:1rem">Loading details…</div>`;

  // Pause background auto-refresh while modal is open so it doesn't
  // compete for rate-limit budget with the chart requests below.
  if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }

  const cacheKey = `${coinId}-${vsCurrency}`;
  const cached = coinDetailCache.get(cacheKey);
  if (cached && (Date.now() - cached.timestamp) < CACHE_TTL) {
    renderModal(cached.data);
    return;
  }

  try {
    // Only fetch coin metadata here — the chart is loaded separately
    // by loadDetailChart() once the modal is rendered, so we don't
    // waste a duplicate market_chart call on every open.
    // apiFetch queues this call and auto-retries on 429, so switching
    // between coins quickly no longer just fails outright.
    const coin = await apiFetch(`${API_BASE}/coins/${coinId}?localization=false&tickers=false&market_data=true&community_data=false&developer_data=false&sparkline=false`);

    coinDetailCache.set(cacheKey, { data: coin, timestamp: Date.now() });
    renderModal(coin);
  } catch (err) {
    console.error(err);
    modalBody.innerHTML = err.message === 'RATE_LIMITED'
      ? `<div style="padding:1rem;color:var(--danger)">Rate limited — retrying automatically didn't help this time. Please wait ~10s and try again.</div>`
      : `<div style="padding:1rem;color:var(--danger)">Failed to load details.</div>`;
  }
}

function renderModal(coin){
  const market = coin.market_data || {};
  modalBody.innerHTML = `
    <div style="display:flex;gap:1rem;align-items:center;margin-bottom:0.5rem">
      <img src="${coin.image.small}" width="48" height="48" alt="${coin.name}"/>
      <div>
        <div style="font-weight:800;font-size:1.15rem">${coin.name} <span style="color:var(--muted)">(${coin.symbol.toUpperCase()})</span></div>
        <div style="color:var(--muted)">Rank ${coin.market_cap_rank} • ${coin.genesis_date || ''}</div>
      </div>
      <div style="margin-left:auto;text-align:right">
        <div style="font-weight:800">${formatPrice(market.current_price?.[vsCurrency])}</div>
        <div style="color:var(--muted)">24h: ${market.price_change_percentage_24h?.toFixed(2) || '—'}%</div>
      </div>
    </div>

    <div style="display:grid;grid-template-columns:1fr 280px;gap:1rem">
      <div style="background:var(--glass);padding:0.6rem;border-radius:10px;">
        <canvas id="detailChart" style="width:100%;height:280px"></canvas>
        <div style="display:flex;gap:0.4rem;margin-top:0.6rem">
          <button class="btn timeframe" data-days="1">1D</button>
          <button class="btn timeframe" data-days="7">7D</button>
          <button class="btn timeframe" data-days="30">30D</button>
        </div>
      </div>
      <div style="background:var(--glass);padding:0.6rem;border-radius:10px;">
        <div style="font-size:0.9rem;color:var(--muted)">Market Cap</div>
        <div style="font-weight:800">${formatPrice(market.market_cap?.[vsCurrency] || 0)}</div>
        <div style="margin-top:0.6rem;color:var(--muted)">Total Volume</div>
        <div style="font-weight:700">${formatNumber(market.total_volume?.[vsCurrency] || 0)}</div>

        <div style="margin-top:1rem;color:var(--muted)">Circulating / Total Supply</div>
        <div style="font-weight:700">${market.circulating_supply ? formatNumber(market.circulating_supply) : '—'} / ${market.total_supply ? formatNumber(market.total_supply) : '—'}</div>

        <div style="margin-top:1rem">
          <button class="btn btn-watch" data-id="${coin.id}">${inWatchlist(coin.id) ? '★' : '☆'} Watch</button>
        </div>
      </div>
    </div>
  `;

  // attach watch listener in modal
  modalBody.querySelectorAll('.btn-watch').forEach(b => {
    b.addEventListener('click', ()=> {
      toggleWatch(coin.id);
      // update label
      b.textContent = inWatchlist(coin.id) ? '★ Watch' : '☆ Watch';
      renderCards(filterCoins());
    });
  });

  // timeframe buttons — debounced so rapid clicking doesn't spam the API
  const debouncedLoadChart = debounce((days) => loadDetailChart(coin.id, days), 400);
  modalBody.querySelectorAll('.timeframe').forEach(btn => {
    btn.addEventListener('click', () => {
      // visually mark active button
      modalBody.querySelectorAll('.timeframe').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      debouncedLoadChart(btn.dataset.days);
    });
  });

  // show 30-day by default
  const defaultBtn = modalBody.querySelector('.timeframe[data-days="30"]');
  if (defaultBtn) defaultBtn.classList.add('active');
  loadDetailChart(coin.id, 30);
}

// Load & draw detail chart (with caching + real error handling)
async function loadDetailChart(coinId, days=30){
  const canvas = document.getElementById('detailChart');
  if(!canvas) return;

  const cacheKey = `${coinId}-${vsCurrency}-${days}`;
  const cached = chartCache.get(cacheKey);

  // Serve from cache if fresh — avoids re-hitting the API when switching
  // back to a range (or coin) already loaded recently.
  if (cached && (Date.now() - cached.timestamp) < CACHE_TTL) {
    drawDetailChart(canvas, cached.data);
    return;
  }

  showChartMessage(canvas, 'Loading…');

  try {
    // apiFetch queues this call (min gap between any two API calls) and
    // retries automatically with backoff if it gets a 429.
    const data = await apiFetch(`${API_BASE}/coins/${coinId}/market_chart?vs_currency=${vsCurrency}&days=${days}&interval=hourly`);

    if (!data.prices || data.prices.length === 0) {
      throw new Error('NO_DATA');
    }

    chartCache.set(cacheKey, { data, timestamp: Date.now() });
    drawDetailChart(canvas, data);
  } catch (err) {
    console.error(err);
    if (detailChart) { detailChart.destroy(); detailChart = null; }

    const msg = err.message === 'RATE_LIMITED'
      ? 'Still rate limited after retrying — wait ~10s and click again'
      : err.message === 'NO_DATA'
        ? 'No chart data available for this range'
        : 'Failed to load chart';

    showChartMessage(canvas, msg);
  }
}

function drawDetailChart(canvas, data){
  const prices = data.prices || [];
  const labels = prices.map(p => new Date(p[0]).toLocaleString());
  const vals = prices.map(p => p[1]);

  if(detailChart) detailChart.destroy();
  detailChart = new Chart(canvas.getContext('2d'), {
    type: 'line',
    data: { labels, datasets: [{ label: 'Price', data: vals, borderWidth: 2, tension: 0.15 }] },
    options: {
      plugins:{ legend:{display:false} }, scales: { x:{ display:false }, y:{ ticks:{ callback: (v)=>formatPrice(v) } } }, interaction:{mode:'index', intersect:false}
    }
  });
}

// Show a plain text message on the canvas (loading / error states)
function showChartMessage(canvas, msg){
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#888';
  ctx.font = '14px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(msg, canvas.width / 2 || 140, canvas.height / 2 || 140);
  ctx.textAlign = 'left';
}

// Modal close
modalClose.addEventListener('click', closeModal);
modal.addEventListener('click', (e)=> {
  if (e.target === modal) closeModal();
});
function closeModal(){
  modal.setAttribute('aria-hidden','true');
  modal.style.display = 'none';
  if(detailChart) { detailChart.destroy(); detailChart = null; }
  // resume background auto-refresh now that the modal is closed
  startAutoRefresh();
}

// Search debounce
searchInput.addEventListener('input', debounce(()=>renderCards(filterCoins()), 300));

// Currency change
currencySelect.addEventListener('change', () => {
  vsCurrency = currencySelect.value;
  localStorage.setItem('cp_currency', vsCurrency);
  chartCache.clear();       // cached chart data was for the old currency
  coinDetailCache.clear();  // cached coin details include currency-specific prices
  fetchData();
});

// Theme toggle
themeToggle.addEventListener('click', ()=> {
  const root = document.documentElement;
  if (root.classList.contains('light')){
    root.classList.remove('light'); themeToggle.textContent = '🌙';
  } else { root.classList.add('light'); themeToggle.textContent = '🌞'; }
});

// watchlist button (shows only watchlist)
watchlistBtn.addEventListener('click', ()=> {
  const list = getWatchlist();
  if (!list || list.length === 0){
    setStatus('Watchlist empty');
    return;
  }
  // Show watchlist coins only (fetch details from existing coinsData or refetch)
  const subset = coinsData.filter(c => list.includes(c.id));
  if (subset.length>0) renderCards(subset); else setStatus('Watchlist items not in current list (try refresh).');
});

// Auto refresh
function startAutoRefresh(){
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = setInterval(()=>fetchData(), REFRESH_SECONDS * 1000);
}

// Init
(async function init(){
  // show skeleton loaders
  cardsGrid.innerHTML = Array.from({length:8}).map(_ => `
    <div class="card skeleton" style="height:120px"></div>
  `).join('');

  await fetchData();
  startAutoRefresh();
})();

// keyboard shortcuts
window.addEventListener('keydown', (e)=>{
  if (e.key === 'Escape') closeModal();
  if (e.ctrlKey && e.key.toLowerCase() === 'k') { e.preventDefault(); searchInput.focus(); }
});