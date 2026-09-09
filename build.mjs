/**
 * 台股盤後重點 — 資料產生器
 * 由 GitHub Actions 每個交易日收盤後執行。
 *
 * 讀寫的檔案（都在 repo 根目錄，會自動建立）：
 *   history.csv   累積的每日行情，保留 90 個交易日
 *   report.json   前端讀的成果檔
 *
 * 不需要安裝任何套件，Node 20 內建的 fetch 就夠。
 */

import { readFile, writeFile } from 'node:fs/promises';

// ====== 可調參數 ======
const KEEP_DAYS = 90;
const TOP_N = 30;
const MIN_TRADE_VALUE = 5e7;   // 成交值門檻 5000 萬，濾掉冷門股
const VOL_SURGE = 1.5;         // 轉強訊號的量增倍數，想寬鬆一點改 1.2

const QUOTES_URL  = 'https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL';
const PROFILE_URL = 'https://openapi.twse.com.tw/v1/opendata/t187ap03_L';

// 掛掉的來源直接從這裡刪掉
const NEWS_FEEDS = [
  'https://tw.stock.yahoo.com/rss?category=news',
  'https://news.cnyes.com/rss/news/tw_stock'
];

const INDUSTRY = {
  '01':'水泥','02':'食品','03':'塑膠','04':'紡織纖維','05':'電機機械',
  '06':'電器電纜','08':'玻璃陶瓷','09':'造紙','10':'鋼鐵','11':'橡膠',
  '12':'汽車','14':'建材營造','15':'航運','16':'觀光餐旅','17':'金融保險',
  '18':'貿易百貨','19':'綜合','20':'其他','21':'化學','22':'生技醫療',
  '23':'油電燃氣','24':'半導體','25':'電腦及週邊','26':'光電','27':'通信網路',
  '28':'電子零組件','29':'電子通路','30':'資訊服務','31':'其他電子',
  '32':'文化創意','33':'農業科技','34':'電子商務','35':'綠能環保',
  '36':'數位雲端','37':'運動休閒','38':'居家生活','80':'管理股票'
};

// ====== 主流程 ======
main().catch(err => { console.error(err); process.exit(1); });

async function main() {
  const quotes = await fetchQuotes();
  if (!quotes.length) {
    console.log('今天沒有行情資料（假日或尚未收盤），不做任何事');
    return;
  }

  const history = await loadHistory();
  const today = quotes[0].date;

  if (history.length && history[history.length - 1].date === today) {
    console.log(`${today} 已經抓過了，只重算一次報告`);
  } else {
    history.push(...quotes);
  }

  const pruned = pruneHistory(history);
  await saveHistory(pruned);

  const industryMap = await fetchIndustries();
  const report = buildReport(pruned, industryMap, await fetchNews());
  await writeFile('report.json', JSON.stringify(report, null, 1));

  console.log(
    `${report.date} 完成｜資料 ${report.dataDays} 日｜` +
    `重點股 ${report.focus.length}｜轉強 ${report.reversal.length}｜類股 ${report.sectors.length}`
  );
}

// ====== 抓資料 ======
async function fetchQuotes() {
  const raw = await getJson(QUOTES_URL);
  return raw
    .filter(r => /^\d{4}$/.test(r.Code) && num(r.ClosingPrice) > 0)
    .map(r => ({
      date: rocToIso(r.Date),
      code: r.Code,
      name: r.Name,
      high: num(r.HighestPrice),
      low: num(r.LowestPrice),
      close: num(r.ClosingPrice),
      change: num(r.Change),
      volume: num(r.TradeVolume),
      value: num(r.TradeValue)
    }));
}

async function fetchIndustries() {
  const map = {};
  try {
    const raw = await getJson(PROFILE_URL);
    for (const r of raw) {
      const code = r['公司代號'] || r.Code;
      const ind = String(r['產業別'] ?? r.IndustryCode ?? '').trim().padStart(2, '0');
      if (code) map[code] = INDUSTRY[ind] || '其他';
    }
  } catch (err) {
    console.warn('產業別抓取失敗，全部歸為「其他」：', err.message);
  }
  return map;
}

async function getJson(url) {
  const res = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0' } });
  if (!res.ok) throw new Error(`${url} 回應 ${res.status}`);
  return res.json();
}

// ====== 歷史檔 ======
const COLS = ['date','code','name','high','low','close','change','volume','value'];

async function loadHistory() {
  let text;
  try {
    text = await readFile('history.csv', 'utf8');
  } catch {
    return [];
  }
  const lines = text.trim().split('\n');
  lines.shift();                                    // 標題列
  return lines.filter(Boolean).map(line => {
    const p = line.split(',');
    return {
      date: p[0], code: p[1], name: p[2],
      high: +p[3], low: +p[4], close: +p[5],
      change: +p[6], volume: +p[7], value: +p[8]
    };
  });
}

function pruneHistory(rows) {
  const dates = [...new Set(rows.map(r => r.date))].sort();
  if (dates.length <= KEEP_DAYS) return rows;
  const cutoff = dates[dates.length - KEEP_DAYS];
  return rows.filter(r => r.date >= cutoff);
}

async function saveHistory(rows) {
  const body = rows.map(r => COLS.map(c => r[c]).join(',')).join('\n');
  await writeFile('history.csv', COLS.join(',') + '\n' + body + '\n');
}

// ====== 訊號計算 ======
function buildReport(history, industryMap, news) {
  const byCode = new Map();
  const dateSet = new Set();
  for (const r of history) {
    dateSet.add(r.date);
    if (!byCode.has(r.code)) byCode.set(r.code, []);
    byCode.get(r.code).push(r);
  }
  const dates = [...dateSet].sort();
  const today = dates[dates.length - 1];

  const list = [];
  for (const [code, series] of byCode) {
    series.sort((a, b) => a.date.localeCompare(b.date));
    const last = series[series.length - 1];
    if (last.date !== today || last.value < MIN_TRADE_VALUE) continue;

    const closes = series.map(x => x.close);
    const vols = series.map(x => x.volume);
    const prev = last.close - last.change;

    list.push({
      code, name: last.name,
      industry: industryMap[code] || '其他',
      close: last.close, change: last.change,
      pct: prev ? round(last.change / prev * 100, 2) : 0,
      value: last.value, volume: last.volume,
      ma5: ma(closes, 5), ma20: ma(closes, 20),
      ma5p: ma(closes.slice(0, -1), 5), ma20p: ma(closes.slice(0, -1), 20),
      volRatio: ratio(last.volume, ma(vols.slice(0, -1), 20)),
      rsi: rsi(closes, 14), rsiP: rsi(closes.slice(0, -1), 14),
      bars: series.length,
      pos: posInRange(series.slice(-20), last.close)
    });
  }

  return {
    date: today,
    generatedAt: taipeiNow(),
    dataDays: dates.length,
    ready: dates.length >= 25,
    market: marketSummary(list),
    focus: pickFocus(list),
    reversal: pickReversal(list),
    sectors: pickSectors(list),
    news
  };
}

/** 1. 當日重點股：成交值大 + 帶量 + 有漲幅 */
function pickFocus(list) {
  return list
    .map(s => ({
      ...s,
      score: round(
        Math.log10(Math.max(s.value, 1)) * 10 +
        Math.min(s.volRatio, 6) * 8 +
        Math.max(s.pct, -3) * 3 +
        (s.ma20 && s.close > s.ma20 ? 6 : 0), 1)
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, TOP_N)
    .map(tidy);
}

/** 2. 由弱轉強：先前偏弱，今天帶量站上 5MA 且 RSI 低檔翻揚 */
function pickReversal(list) {
  return list
    .filter(s => s.bars >= 25 && s.ma5 && s.ma20 && s.ma5p)
    .filter(s =>
      s.close > s.ma5 && (s.close - s.change) <= s.ma5p &&   // 今日首度站上 5MA
      (s.ma5p < s.ma20p || s.pos < 0.55) &&                  // 先前確實偏弱
      s.volRatio >= VOL_SURGE &&                             // 帶量
      s.rsiP !== null && s.rsiP < 50 && s.rsi > s.rsiP &&    // RSI 低檔翻揚
      s.pct > 0 && s.pct < 9.5                               // 排除已鎖漲停
    )
    .map(s => ({
      ...s,
      score: round(s.volRatio * 10 + (s.rsi - s.rsiP) + (1 - s.pos) * 15, 1),
      why: [
        '收盤站上 5MA',
        `量能 ${s.volRatio.toFixed(1)} 倍`,
        `RSI ${Math.round(s.rsiP)}→${Math.round(s.rsi)}`,
        s.close > s.ma20 ? '同步突破 20MA' : '20MA 尚未突破'
      ]
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, TOP_N)
    .map(tidy);
}

/** 3. 強勢類股：上漲家數比 + 平均漲幅 + 資金佔比 */
function pickSectors(list) {
  const g = new Map();
  let totalValue = 0;
  for (const s of list) {
    if (!g.has(s.industry)) {
      g.set(s.industry, { name: s.industry, n: 0, up: 0, sumPct: 0, value: 0, members: [] });
    }
    const x = g.get(s.industry);
    x.n++;
    if (s.pct > 0) x.up++;
    x.sumPct += s.pct;
    x.value += s.value;
    x.members.push(s);
    totalValue += s.value;
  }

  return [...g.values()]
    .filter(x => x.n >= 3)
    .map(x => {
      const upRatio = x.up / x.n;
      const avgPct = x.sumPct / x.n;
      const share = totalValue ? x.value / totalValue : 0;
      return {
        name: x.name,
        count: x.n,
        upRatio: round(upRatio * 100, 1),
        avgPct: round(avgPct, 2),
        valueShare: round(share * 100, 1),
        score: round(upRatio * 40 + avgPct * 8 + share * 100, 1),
        leaders: x.members
          .sort((a, b) => b.value - a.value)
          .slice(0, 3)
          .map(s => ({ code: s.code, name: s.name, pct: s.pct }))
      };
    })
    .sort((a, b) => b.score - a.score);
}

function marketSummary(list) {
  const up = list.filter(s => s.pct > 0).length;
  const down = list.filter(s => s.pct < 0).length;
  const value = list.reduce((a, s) => a + s.value, 0);
  return {
    up, down, flat: list.length - up - down,
    breadth: list.length ? round(up / list.length * 100, 1) : 0,
    totalValue: Math.round(value / 1e8)   // 億元
  };
}

// ====== 新聞 ======
async function fetchNews() {
  const out = [];
  for (const url of NEWS_FEEDS) {
    try {
      const res = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0' } });
      if (!res.ok) throw new Error(`回應 ${res.status}`);
      const xml = await res.text();
      const items = xml.match(/<item[\s\S]*?<\/item>/g) || [];
      for (const it of items.slice(0, 12)) {
        const title = tag(it, 'title');
        const link = tag(it, 'link');
        if (title && link) out.push({ title, link, time: tag(it, 'pubDate') });
      }
    } catch (err) {
      console.warn(`RSS 失敗 ${url}：${err.message}`);
    }
  }
  return out.slice(0, 20);
}

function tag(xml, name) {
  const m = xml.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`));
  if (!m) return '';
  return m[1]
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .trim();
}

// ====== 工具 ======
function num(x) {
  const n = parseFloat(String(x).replace(/,/g, ''));
  return Number.isNaN(n) ? 0 : n;
}

function rocToIso(d) {
  const s = String(d);
  if (s.length !== 7) return s;
  return `${+s.slice(0, 3) + 1911}-${s.slice(3, 5)}-${s.slice(5)}`;
}

function round(n, p) { return +n.toFixed(p); }

function ma(arr, n) {
  if (arr.length < n) return null;
  return round(arr.slice(-n).reduce((a, b) => a + b, 0) / n, 2);
}

function ratio(a, b) { return b ? round(a / b, 2) : 0; }

function rsi(closes, n) {
  if (closes.length < n + 1) return null;
  let gain = 0, loss = 0;
  const s = closes.slice(-(n + 1));
  for (let i = 1; i < s.length; i++) {
    const d = s[i] - s[i - 1];
    if (d > 0) gain += d; else loss -= d;
  }
  if (loss === 0) return 100;
  return round(100 - 100 / (1 + gain / loss), 1);
}

/** 收盤價在近 N 日高低區間的位置，0 = 最低，1 = 最高 */
function posInRange(series, close) {
  const hi = Math.max(...series.map(x => x.high));
  const lo = Math.min(...series.map(x => x.low));
  return hi === lo ? 0.5 : round((close - lo) / (hi - lo), 2);
}

function taipeiNow() {
  return new Date().toLocaleString('zh-TW', {
    timeZone: 'Asia/Taipei', month: 'numeric', day: 'numeric',
    hour: '2-digit', minute: '2-digit'
  });
}

function tidy(s) {
  return {
    code: s.code, name: s.name, industry: s.industry,
    close: s.close, pct: s.pct,
    value: round(s.value / 1e8, 2),
    volRatio: s.volRatio, rsi: s.rsi,
    ma5: s.ma5, ma20: s.ma20,
    score: s.score,
    why: s.why || null
  };
}
