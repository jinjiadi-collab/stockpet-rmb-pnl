"use strict";

const { net } = require("electron");
const {
  changePercent,
  hasDrawableIntradayData,
  instrumentTypeForSearchItem,
  marketSession,
  marketForSearchItem,
  parseCnbcExtended,
  parseEastmoneyLatest,
  parseNasdaqChart,
  parseTencentMinute,
  parseTencentRealtime,
  parseTrend,
  tencentCode,
  tencentRealtimeCode,
} = require("./lib");

const SEARCH_TOKEN = "D43BF722C8E33DA55D5C6812C6C46";
const cnbcPointCache = new Map();

async function requestJSON(url, headers = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await net.fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        Referer: "https://quote.eastmoney.com/",
        ...headers,
      },
    });
    if (!response.ok) throw new Error(`行情服务返回 ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

async function requestText(url, timeoutMilliseconds = 2000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMilliseconds);
  try {
    const response = await net.fetch(url, {
      signal: controller.signal,
      cache: "no-store",
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" },
    });
    if (!response.ok) throw new Error(`行情服务返回 ${response.status}`);
    return Buffer.from(await response.arrayBuffer()).toString("latin1");
  } finally {
    clearTimeout(timeout);
  }
}

async function searchStocks(query) {
  const clean = String(query || "").trim();
  if (!clean) return [];
  const params = new URLSearchParams({
    input: clean,
    type: "14",
    token: SEARCH_TOKEN,
    count: "20",
  });
  const response = await requestJSON(`https://searchapi.eastmoney.com/api/suggest/get?${params}`);
  const table = response.QuotationCodeTable;
  if (!table || table.Status !== 0) throw new Error(table?.Message || "搜索服务暂不可用");
  const seen = new Set();
  return (table.Data || []).flatMap((item) => {
    const market = marketForSearchItem(item);
    if (!market) return [];
    const quoteID = item.QuoteID || `${item.MktNum}.${item.Code}`;
    if (seen.has(quoteID)) return [];
    seen.add(quoteID);
    return [{
      code: item.Code,
      name: item.Name,
      market,
      quoteID,
      instrumentType: instrumentTypeForSearchItem(item),
    }];
  });
}

async function fetchTencent(symbol) {
  const code = tencentCode(symbol);
  const response = await requestJSON(
    `https://web.ifzq.gtimg.cn/appstock/app/minute/query?code=${encodeURIComponent(code)}`,
  );
  const payload = response?.data?.[code];
  const quoteFields = payload?.qt?.[code];
  if (response?.code !== 0 || !payload || !Array.isArray(quoteFields) || quoteFields.length <= 5) {
    throw new Error("腾讯分时返回格式异常");
  }
  const rawDate = payload.data?.date || String(quoteFields[30] || "").slice(0, 10);
  const points = (payload.data?.data || [])
    .map((item) => parseTencentMinute(item, rawDate))
    .filter(Boolean);
  if (!hasDrawableIntradayData(points)) throw new Error("今天暂无完整分时数据");
  const lastPoint = points.at(-1);
  const dayOpen = Number(quoteFields[5]) > 0 ? Number(quoteFields[5]) : points[0].price;
  const previousClose = Number(quoteFields[4]) > 0 ? Number(quoteFields[4]) : dayOpen;
  const lastPrice = Number(quoteFields[3]) > 0 ? Number(quoteFields[3]) : lastPoint.price;
  return {
    symbol,
    points,
    dayOpen,
    previousClose,
    lastPrice,
    changePercent: changePercent(lastPrice, previousClose),
    updatedAt: lastPoint.time,
    isStale: false,
    source: "腾讯分时",
  };
}

async function fetchEastmoney(symbol) {
  const params = new URLSearchParams({
    secid: symbol.quoteID,
    fields1: "f1,f2,f3,f4,f5,f6,f7,f8,f9,f10,f11,f12,f13",
    fields2: "f51,f52,f53,f54,f55,f56,f57,f58",
    iscr: "0",
    ndays: "1",
  });
  const response = await requestJSON(
    `https://push2delay.eastmoney.com/api/qt/stock/trends2/get?${params}`,
  );
  if (response?.rc !== 0 || !response.data) throw new Error("东方财富分时暂不可用");
  const points = (response.data.trends || []).map(parseTrend).filter(Boolean);
  if (!hasDrawableIntradayData(points)) throw new Error("今天暂无完整分时数据");
  const dayOpen = points[0].open > 0 ? points[0].open : points[0].price;
  const previousClose = Number(response.data.preClose) > 0
    ? Number(response.data.preClose)
    : dayOpen;
  const lastPrice = points.at(-1).price;
  return {
    symbol,
    points,
    dayOpen,
    previousClose,
    lastPrice,
    changePercent: changePercent(lastPrice, previousClose),
    updatedAt: points.at(-1).time,
    isStale: false,
    source: "东方财富备用",
  };
}

async function fetchNasdaqExtended(symbol) {
  const ticker = encodeURIComponent(String(symbol.code || "").toUpperCase());
  const response = await requestJSON(
    `https://api.nasdaq.com/api/quote/${ticker}/chart?assetclass=stocks`,
    {
      Accept: "application/json, text/plain, */*",
      Origin: "https://www.nasdaq.com",
      Referer: `https://www.nasdaq.com/market-activity/stocks/${ticker.toLowerCase()}`,
    },
  );
  const quote = parseNasdaqChart(response, symbol);
  if (!quote) throw new Error("Nasdaq 盘前盘后数据暂不可用");
  return quote;
}

async function fetchCnbcExtended(symbol) {
  const ticker = encodeURIComponent(String(symbol.code || "").toUpperCase());
  const response = await requestJSON(
    `https://quote.cnbc.com/quote-html-webservice/restQuote/symbolType/symbol?symbols=${ticker}&requestMethod=quick&noform=1&partnerId=2&fund=1&exthrs=1&output=json`,
    {
      Accept: "application/json, text/plain, */*",
      Referer: `https://www.cnbc.com/quotes/${ticker}`,
    },
  );
  const quote = parseCnbcExtended(response, symbol);
  if (!quote) throw new Error("CNBC 盘前盘后数据暂不可用");
  const cached = cnbcPointCache.get(symbol.quoteID) || [];
  const points = cached.at(-1)?.time === quote.sourceTimestamp
    ? cached
    : [...cached, quote.points[0]].slice(-480);
  cnbcPointCache.set(symbol.quoteID, points);
  return { ...quote, points, dayOpen: points[0].price };
}

async function fetchExtendedUS(symbol) {
  const session = marketSession("unitedStates");
  try {
    return { ...await fetchNasdaqExtended(symbol), session };
  } catch {
    return { ...await fetchCnbcExtended(symbol), session };
  }
}

async function fetchIntraday(symbol) {
  const session = marketSession(symbol.market);
  if (symbol.market === "unitedStates"
      && symbol.instrumentType !== "index"
      && ["preMarket", "afterHours"].includes(session)) {
    return fetchExtendedUS(symbol);
  }
  if (symbol.instrumentType === "index") return fetchEastmoney(symbol);
  try {
    return await fetchTencent(symbol);
  } catch {
    return await fetchEastmoney(symbol);
  }
}

async function fetchLatestQuotes(symbols) {
  const updates = [];
  let lastError = null;
  const stocks = symbols.filter((symbol) => symbol.instrumentType !== "index");
  const indices = symbols.filter((symbol) => symbol.instrumentType === "index");
  const now = new Date();
  const extendedUS = stocks.filter((symbol) => (
    symbol.market === "unitedStates"
      && ["preMarket", "afterHours"].includes(marketSession(symbol.market, now))
  ));
  const extendedIDs = new Set(extendedUS.map((symbol) => symbol.quoteID));
  const standardStocks = stocks.filter((symbol) => !extendedIDs.has(symbol.quoteID));
  for (let start = 0; start < standardStocks.length; start += 40) {
    const batch = standardStocks.slice(start, start + 40);
    const codes = batch.map(tencentRealtimeCode).join(",");
    try {
      const text = await requestText(
        `https://qt.gtimg.cn/q=${encodeURIComponent(codes)}&_=${Date.now()}`,
      );
      updates.push(...parseTencentRealtime(text, batch));
    } catch (error) {
      lastError = error;
    }
  }
  const extendedResults = await Promise.allSettled(extendedUS.map(fetchExtendedUS));
  extendedResults.forEach((result) => {
    if (result.status === "fulfilled") {
      const quote = result.value;
      updates.push({
        symbol: quote.symbol,
        lastPrice: quote.lastPrice,
        previousClose: quote.previousClose,
        sourceTimestamp: quote.sourceTimestamp,
        source: quote.source,
        session: quote.session,
      });
    } else {
      lastError = result.reason;
    }
  });
  for (let start = 0; start < indices.length; start += 40) {
    const batch = indices.slice(start, start + 40);
    const params = new URLSearchParams({
      secids: batch.map((symbol) => symbol.quoteID).join(","),
      fields: "f12,f13,f14,f2,f18,f124,f152",
    });
    try {
      const response = await requestJSON(`https://push2delay.eastmoney.com/api/qt/ulist.np/get?${params}`);
      updates.push(...parseEastmoneyLatest(response, batch));
    } catch (error) {
      lastError = error;
    }
  }
  if (!updates.length && lastError) throw lastError;
  return updates;
}

module.exports = {
  fetchExtendedUS,
  fetchIntraday,
  fetchLatestQuotes,
  searchStocks,
};
