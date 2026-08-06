"use strict";

const marketLabels = {
  aShare: "A股",
  hongKong: "港股",
  unitedStates: "美股",
};

let state = null;
let status = null;
let quotes = {};
let searchResults = [];
let availableUpdate = null;

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

function escapeHTML(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function switchPage(name) {
  $$(".nav-item").forEach((item) => item.classList.toggle("active", item.dataset.page === name));
  $$(".page").forEach((page) => page.classList.toggle("active", page.id === `page-${name}`));
}

function renderStocks() {
  if (!state) return;
  $("#stock-count").textContent = `${state.symbols.length} 只`;
  $("#current-stocks").innerHTML = state.symbols.length
    ? state.symbols.map((symbol, index) => `
        <div class="stock-item">
          <div>
            <div class="stock-name">${escapeHTML(symbol.name)}</div>
            <div class="stock-meta">${escapeHTML(symbol.code)} · ${marketLabels[symbol.market]}</div>
          </div>
          <div class="stock-actions">
            <button data-action="up" data-id="${escapeHTML(symbol.quoteID)}" ${index === 0 ? "disabled" : ""} title="上移">↑</button>
            <button data-action="down" data-id="${escapeHTML(symbol.quoteID)}" ${index === state.symbols.length - 1 ? "disabled" : ""} title="下移">↓</button>
            <button class="remove" data-action="remove" data-id="${escapeHTML(symbol.quoteID)}" title="删除">×</button>
          </div>
        </div>
      `).join("")
    : '<div class="empty-list">桌面上还没有股票</div>';
}

function formatCny(value) {
  if (!Number.isFinite(value)) return "—";
  const sign = value > 0 ? "+" : value < 0 ? "−" : "";
  return `${sign}¥${Math.abs(value).toLocaleString("zh-CN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function positionProfit(symbol, quote, position) {
  const price = Number(quote?.lastPrice);
  const costPrice = Number(position?.costPrice);
  const quantity = Number(position?.quantity);
  const exchangeRate = Number(position?.exchangeRate);
  if (!(price > 0) || !(costPrice > 0) || !(quantity > 0) || !(exchangeRate > 0)) return null;
  return (price - costPrice) * quantity * exchangeRate;
}

function renderPositions() {
  if (!state) return;
  const profits = [];
  const list = $("#positions-list");
  list.innerHTML = state.symbols.length
    ? state.symbols.map((symbol) => {
        const position = state.positions[symbol.quoteID] || {};
        const quote = quotes[symbol.quoteID];
        const profit = positionProfit(symbol, quote, position);
        if (Number.isFinite(profit)) profits.push(profit);
        const defaultRate = symbol.market === "aShare" ? 1 : "";
        const currentValue = Number(quote?.lastPrice) > 0
          ? formatLivePrice(symbol, quote.lastPrice)
          : "等待实时价";
        return `
          <div class="position-item" data-position-id="${escapeHTML(symbol.quoteID)}">
            <div class="position-heading">
              <div>
                <div class="stock-name">${escapeHTML(symbol.name)}</div>
                <div class="stock-meta">${escapeHTML(symbol.code)} · ${marketLabels[symbol.market]} · ${currentValue}</div>
              </div>
              <strong class="position-profit ${profit > 0 ? "positive" : profit < 0 ? "negative" : ""}">${formatCny(profit)}</strong>
            </div>
            <div class="position-fields">
              <label>成本价
                <input data-position-field="costPrice" type="number" min="0" step="0.0001" value="${position.costPrice || ""}" placeholder="原币种" />
              </label>
              <label>持仓数量
                <input data-position-field="quantity" type="number" min="0" step="0.0001" value="${position.quantity || ""}" />
              </label>
              <label>汇率（兑人民币）
                <input data-position-field="exchangeRate" type="number" min="0" step="0.0001" value="${position.exchangeRate || defaultRate}" placeholder="如 USD→CNY" />
              </label>
            </div>
          </div>
        `;
      }).join("")
    : '<div class="empty-list">请先在“桌面股票”中添加股票</div>';
  const total = profits.reduce((sum, value) => sum + value, 0);
  $("#portfolio-profit").textContent = profits.length ? formatCny(total) : "—";
  $("#portfolio-profit").className = total > 0 ? "positive" : total < 0 ? "negative" : "";
  $("#portfolio-profit-note").textContent = profits.length
    ? `已按 ${profits.length} 只已配置持仓计算`
    : "请为持仓填写成本价、数量和汇率";
}

function renderSearchResults() {
  $("#search-results").innerHTML = searchResults.map((symbol, index) => `
    <div class="search-result">
      <div>
        <div class="result-name">${escapeHTML(symbol.name)}</div>
        <div class="result-meta">${escapeHTML(symbol.code)} · ${marketLabels[symbol.market]}</div>
      </div>
      <button class="small-button" data-add-index="${index}">添加</button>
    </div>
  `).join("");
}

function formatLivePrice(symbol, price) {
  if (!(Number(price) > 0)) return "等待实时价";
  const currency = symbol.market === "aShare" ? "¥" : symbol.market === "hongKong" ? "HK$" : "$";
  return `现价 ${currency}${Number(price).toFixed(2)}`;
}

function renderPriceAlerts() {
  if (!state) return;
  const list = $("#price-alert-list");
  list.innerHTML = state.symbols.length
    ? state.symbols.map((symbol) => {
        const quote = quotes[symbol.quoteID];
        const targets = state.priceAlertTargets[symbol.quoteID] || {
          risingPrice: 0,
          fallingPrice: 0,
        };
        const enabled = targets.risingPrice > 0 || targets.fallingPrice > 0;
        return `
          <div class="price-alert-item" data-price-alert-id="${escapeHTML(symbol.quoteID)}">
            <div class="price-alert-heading">
              <input class="switch price-alert-enabled" type="checkbox" ${enabled ? "checked" : ""} ${quote?.lastPrice > 0 || enabled ? "" : "disabled"} />
              <div>
                <div class="stock-name">${escapeHTML(symbol.name)}</div>
                <div class="stock-meta">${escapeHTML(symbol.code)} · ${marketLabels[symbol.market]}</div>
              </div>
              <div class="live-price">${formatLivePrice(symbol, quote?.lastPrice)}</div>
            </div>
            <div class="price-target-fields">
              <label class="price-target-field">🐂 小牛价 ≥
                <input class="rising-price-target" type="number" min="0" step="0.01" value="${enabled ? targets.risingPrice.toFixed(2) : ""}" ${enabled ? "" : "disabled"} />
              </label>
              <label class="price-target-field">🐻 小熊价 ≤
                <input class="falling-price-target" type="number" min="0" step="0.01" value="${enabled ? targets.fallingPrice.toFixed(2) : ""}" ${enabled ? "" : "disabled"} />
              </label>
            </div>
          </div>
        `;
      }).join("")
    : '<div class="empty-list">请先在“桌面股票”中添加股票</div>';
}

function syncControls() {
  if (!state) return;
  const ranges = {
    displayScale: `${Math.round(state.displayScale * 100)}%`,
    lineOpacity: `${Math.round(state.lineOpacity * 100)}%`,
    chartWidth: `${Math.round(state.chartWidth)} px`,
    labelOpacity: `${Math.round(state.labelOpacity * 100)}%`,
    fontScale: `${Math.round(state.fontScale * 100)}%`,
    backgroundOpacity: `${Math.round(state.backgroundOpacity * 100)}%`,
    alertOpacity: `${Math.round(state.alertOpacity * 100)}%`,
  };
  for (const [id, text] of Object.entries(ranges)) {
    const input = $(`#${id}`);
    input.value = state[id];
    input.parentElement.querySelector("output").textContent = text;
  }
  for (const id of [
    "alwaysOnTop",
    "clickThrough",
    "showStockMeta",
    "bullSoundEnabled",
    "bearSoundEnabled",
    "alertsEnabled",
    "shortcutEnabled",
  ]) {
    $(`#${id}`).checked = state[id];
  }
  $("#shortcutModifier").value = state.shortcutModifier;
  $("#shortcutKey").value = state.shortcutKey;
  $("#shortcut-options").classList.toggle("disabled", !state.shortcutEnabled);
  $("#shortcutModifier").disabled = !state.shortcutEnabled;
  $("#shortcutKey").disabled = !state.shortcutEnabled;
  $("#alertBasis").value = state.alertBasis;
  const targetMode = state.alertBasis === "targetPrice";
  $("#percentage-alert-controls").hidden = targetMode;
  $("#price-alert-controls").hidden = !targetMode;
  $("#alert-basis-description").textContent = targetMode
    ? "为每只股票设置小牛价和小熊价，触达目标价格时提醒"
    : "涨跌幅以昨收为基准，每次越过阈值只提醒一次";
  $("#alert-rearm-tip").textContent = targetMode
    ? "目标价提醒触发后，价格回到目标内侧至少 0.15% 才会重新布防。行情按刷新频率持续更新。"
    : "股票回到阈值内至少 0.15 个百分点后会重新布防，避免价格在边缘波动时连续提醒。";
  $("#risingThreshold").value = state.risingThreshold;
  $("#fallingThreshold").value = state.fallingThreshold;
  $("#refreshInterval").value = String(state.refreshInterval);
  renderStocks();
  renderPositions();
  renderPriceAlerts();
  for (const control of $$("#page-alerts input, #page-alerts select, #page-alerts button")) {
    if (control.id === "alertsEnabled") continue;
    const item = control.closest("[data-price-alert-id]");
    const ruleEnabled = item?.querySelector(".price-alert-enabled")?.checked ?? true;
    const quoteID = item?.dataset.priceAlertId;
    const hasLivePrice = quoteID ? quotes[quoteID]?.lastPrice > 0 : true;
    const unavailable = control.classList.contains("price-alert-enabled")
      ? !hasLivePrice && !ruleEnabled
      : (control.classList.contains("rising-price-target")
        || control.classList.contains("falling-price-target"))
        ? !ruleEnabled
        : false;
    control.disabled = !state.alertsEnabled || unavailable;
  }
}

function renderStatus() {
  if (!status) return;
  $("#data-source").textContent = status.source || "腾讯秒级报价 · 腾讯分时 · 东方财富备用";
  $("#last-refresh").textContent = status.lastRefresh
    ? new Date(status.lastRefresh).toLocaleString("zh-CN")
    : "尚未刷新";
  const error = $("#source-error");
  error.hidden = !status.sourceError;
  error.textContent = status.sourceError || "";
}

async function updateState(patch) {
  state = await window.stockPet.updateState(patch);
  syncControls();
}

$$(".nav-item").forEach((item) => {
  item.addEventListener("click", () => switchPage(item.dataset.page));
});

$("#search-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const query = $("#search-input").value.trim();
  if (!query) return;
  $("#search-message").textContent = "正在搜索…";
  searchResults = [];
  renderSearchResults();
  try {
    searchResults = await window.stockPet.search(query);
    $("#search-message").textContent = searchResults.length ? "" : "没有找到可添加的 A 股、港股或美股";
  } catch (error) {
    $("#search-message").textContent = error.message || "搜索暂时不可用";
  }
  renderSearchResults();
});

$("#search-results").addEventListener("click", async (event) => {
  const button = event.target.closest("[data-add-index]");
  if (!button) return;
  const symbol = searchResults[Number(button.dataset.addIndex)];
  if (!symbol) return;
  const result = await window.stockPet.addSymbol(symbol);
  $("#search-message").textContent = result.ok ? `已添加 ${symbol.name}` : result.message;
});

$("#current-stocks").addEventListener("click", async (event) => {
  const button = event.target.closest("[data-action]");
  if (!button) return;
  const { action, id } = button.dataset;
  if (action === "remove") await window.stockPet.removeSymbol(id);
  if (action === "up") await window.stockPet.moveSymbol(id, -1);
  if (action === "down") await window.stockPet.moveSymbol(id, 1);
});

$("#positions-list").addEventListener("change", async (event) => {
  const input = event.target.closest("[data-position-field]");
  const item = event.target.closest("[data-position-id]");
  if (!input || !item) return;
  const positions = { ...state.positions };
  const current = positions[item.dataset.positionId] || {};
  positions[item.dataset.positionId] = {
    ...current,
    [input.dataset.positionField]: Number(input.value),
  };
  await updateState({ positions });
});

for (const id of ["displayScale", "lineOpacity", "chartWidth", "labelOpacity", "fontScale", "backgroundOpacity", "alertOpacity"]) {
  const input = $(`#${id}`);
  input.addEventListener("input", () => {
    const value = Number(input.value);
    input.parentElement.querySelector("output").textContent = id === "chartWidth"
      ? `${Math.round(value)} px`
      : `${Math.round(value * 100)}%`;
  });
  input.addEventListener("change", () => updateState({ [id]: Number(input.value) }));
}

for (const id of [
  "alwaysOnTop",
  "clickThrough",
  "showStockMeta",
  "bullSoundEnabled",
  "bearSoundEnabled",
  "alertsEnabled",
  "shortcutEnabled",
]) {
  $(`#${id}`).addEventListener("change", (event) => updateState({ [id]: event.target.checked }));
}

for (const id of ["shortcutModifier", "shortcutKey"]) {
  $(`#${id}`).addEventListener("change", (event) => updateState({ [id]: event.target.value }));
}

$("#alertBasis").addEventListener("change", (event) => {
  updateState({ alertBasis: event.target.value });
});

for (const id of ["risingThreshold", "fallingThreshold"]) {
  $(`#${id}`).addEventListener("change", (event) => updateState({ [id]: Number(event.target.value) }));
}

$("#refreshInterval").addEventListener("change", (event) => {
  updateState({ refreshInterval: Number(event.target.value) });
});

$("#reset-appearance").addEventListener("click", () => updateState({
  displayScale: 1,
  lineOpacity: 0.92,
  chartWidth: 430,
  labelOpacity: 0.92,
  fontScale: 1,
  showStockMeta: false,
  backgroundOpacity: 0.16,
}));

$("#preview-bull").addEventListener("click", () => window.stockPet.previewAlert("rising"));
$("#preview-bear").addEventListener("click", () => window.stockPet.previewAlert("falling"));
$("#github-author").addEventListener("click", () => window.stockPet.openAuthor());
function showAvailableUpdate(update) {
  availableUpdate = update;
  $("#update-message").textContent = `发现 v${update.version}，可自动下载、校验并重启安装。`;
  $("#check-custom-update").textContent = "自动更新";
}
function formatUpdateSize(bytes) {
  return `${(Number(bytes || 0) / 1024 / 1024).toFixed(1)} MB`;
}
function setUpdateProgress(received, total, label) {
  const progress = $("#update-progress");
  const percent = total > 0 ? Math.min(100, (received / total) * 100) : 0;
  progress.hidden = false;
  $("#update-progress-bar").style.width = `${percent}%`;
  $("#update-progress-value").textContent = total > 0 ? `${Math.round(percent)}%` : "";
  $("#update-progress-label").textContent = label || (total > 0
    ? `${formatUpdateSize(received)} / ${formatUpdateSize(total)}`
    : `已下载 ${formatUpdateSize(received)}`);
}
function hideUpdateProgress() {
  $("#update-progress").hidden = true;
  $("#update-progress-bar").style.width = "0";
}
$("#check-custom-update").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  const message = $("#update-message");
  button.disabled = true;
  message.textContent = availableUpdate ? `正在下载 v${availableUpdate.version}…` : "正在检查 StockPet P&L 定制版更新…";
  try {
    const result = availableUpdate
      ? { status: "available", update: availableUpdate }
      : await window.stockPet.checkForUpdate();
    if (result.status === "upToDate") {
      message.textContent = "当前已是最新版本。";
    } else if (result.status === "available") {
      showAvailableUpdate(result.update);
      const install = window.confirm(`发现 v${result.update.version}，现在自动下载并安装吗？`);
      if (install) {
        setUpdateProgress(0, Number(result.update.size) || 0, "正在准备下载…");
        message.textContent = `正在下载 v${result.update.version}，完成后会自动重启…`;
        await window.stockPet.installUpdate();
      }
    } else {
      message.textContent = result.message || "更新检查暂不可用。";
    }
  } catch (error) {
    message.textContent = error?.message || "检查更新失败，请稍后重试。";
  } finally {
    button.disabled = false;
  }
});

$("#price-alert-list").addEventListener("change", async (event) => {
  const item = event.target.closest("[data-price-alert-id]");
  if (!item) return;
  const quoteID = item.dataset.priceAlertId;
  const symbol = state.symbols.find((candidate) => candidate.quoteID === quoteID);
  if (!symbol) return;
  const nextTargets = { ...state.priceAlertTargets };
  const quote = quotes[quoteID];

  if (event.target.classList.contains("price-alert-enabled")) {
    if (!event.target.checked) {
      delete nextTargets[quoteID];
    } else if (quote?.lastPrice > 0) {
      nextTargets[quoteID] = {
        risingPrice: quote.lastPrice * (1 + state.risingThreshold / 100),
        fallingPrice: quote.lastPrice * (1 - state.fallingThreshold / 100),
      };
    }
  } else {
    const current = nextTargets[quoteID] || { risingPrice: 0, fallingPrice: 0 };
    if (event.target.classList.contains("rising-price-target")) {
      current.risingPrice = Number(event.target.value);
    }
    if (event.target.classList.contains("falling-price-target")) {
      current.fallingPrice = Number(event.target.value);
    }
    nextTargets[quoteID] = current;
  }
  await updateState({ priceAlertTargets: nextTargets });
});

$("#refresh-alert-prices").addEventListener("click", async () => {
  $("#price-alert-message").textContent = "正在刷新实时价格…";
  const snapshot = await window.stockPet.refresh();
  quotes = snapshot.quotes || {};
  status = snapshot.status;
  $("#price-alert-message").textContent = "实时价格已刷新";
  renderPriceAlerts();
  renderStatus();
});

$("#generate-price-targets").addEventListener("click", async () => {
  $("#price-alert-message").textContent = "正在刷新并生成目标…";
  const snapshot = await window.stockPet.refresh();
  quotes = snapshot.quotes || {};
  status = snapshot.status;
  const nextTargets = { ...state.priceAlertTargets };
  let count = 0;
  for (const symbol of state.symbols) {
    const quote = quotes[symbol.quoteID];
    if (!(quote?.lastPrice > 0)) continue;
    nextTargets[symbol.quoteID] = {
      risingPrice: quote.lastPrice * (1 + state.risingThreshold / 100),
      fallingPrice: quote.lastPrice * (1 - state.fallingThreshold / 100),
    };
    count += 1;
  }
  await updateState({ priceAlertTargets: nextTargets });
  $("#price-alert-message").textContent = `已按当前价为 ${count} 只股票生成目标`;
  renderStatus();
});

$("#refresh-now").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  button.disabled = true;
  button.textContent = "正在刷新…";
  const snapshot = await window.stockPet.refresh();
  status = snapshot.status;
  renderStatus();
  button.disabled = false;
  button.textContent = "立即刷新全部股票";
});

window.stockPet.on("state-changed", (nextState) => {
  state = nextState;
  syncControls();
});
window.stockPet.on("refresh-status", (nextStatus) => {
  status = nextStatus;
  renderStatus();
});
window.stockPet.on("quotes-updated", (nextQuotes) => {
  quotes = nextQuotes || {};
  renderPositions();
  renderPriceAlerts();
});
window.stockPet.on("update-available", showAvailableUpdate);
window.stockPet.on("update-download-progress", ({ received, total }) => {
  const percent = total > 0 ? Math.min(100, (received / total) * 100) : 0;
  setUpdateProgress(received, total);
  $("#update-message").textContent = total > 0
    ? `正在下载更新：${formatUpdateSize(received)} / ${formatUpdateSize(total)}（${Math.round(percent)}%）`
    : `正在下载更新：${formatUpdateSize(received)}`;
});
window.stockPet.on("update-complete", (result) => {
  hideUpdateProgress();
  $("#update-message").textContent = result.status === "success"
    ? (result.message || `已更新到 v${result.version}`)
    : `更新未完成：${result.message || "请从发布页手动下载。"}`;
});
window.stockPet.bootstrap().then((snapshot) => {
  state = snapshot.state;
  quotes = snapshot.quotes || {};
  status = snapshot.status;
  if (snapshot.appInfo) {
    $("#app-version").textContent = `Windows x64 · 定制版 v${snapshot.appInfo.customVersion} · 基于原版 v${snapshot.appInfo.upstreamBaseVersion}`;
  }
  if (snapshot.update) showAvailableUpdate(snapshot.update);
  syncControls();
  renderStatus();
});
