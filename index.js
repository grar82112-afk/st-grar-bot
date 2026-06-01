require('dotenv').config();

const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');

const bot = new TelegramBot(process.env.BOT_TOKEN, {
  polling: {
    interval: 300,
    autoStart: true,
    params: { timeout: 10 }
  }
});

const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;
const DECISION_GROUP_ID = process.env.DECISION_GROUP_ID;
const SIGNALS_CHAT_ID = process.env.SIGNALS_CHAT_ID || DECISION_GROUP_ID;

const FINNHUB_API_KEY = process.env.FINNHUB_API_KEY;
const MASSIVE_API_KEY = process.env.MASSIVE_API_KEY;
const MASSIVE_BASE_URL = process.env.MASSIVE_BASE_URL || 'https://api.massive.com';

const MATCH_WINDOW_MS = Number(process.env.MATCH_WINDOW_MS || 20 * 60 * 1000);
const PRICE_CHECK_MS = Number(process.env.PRICE_CHECK_MS || 30 * 1000);
const SETUP_EXPIRE_MS = Number(process.env.SETUP_EXPIRE_MS || 45 * 60 * 1000);

const MIN_SCORE = Number(process.env.MIN_SCORE || 6);

const MIN_CONTRACT_PRICE = Number(process.env.MIN_CONTRACT_PRICE || 0.80);
const MAX_CONTRACT_PRICE = Number(process.env.MAX_CONTRACT_PRICE || 4.00);

const CONTRACT_UPDATE_STEP = Number(process.env.CONTRACT_UPDATE_STEP || 0.10);
const CONTRACT_STOP_DROP = Number(process.env.CONTRACT_STOP_DROP || 0.30);

const HISTORY_LIMIT = Number(process.env.HISTORY_LIMIT || 5);

const recentGexMessages = [];
const recentRadarMessages = [];

const activeSetups = new Map();
const activeTrades = new Map();
const sentSetupKeys = new Set();

console.log('🚀 ST Decision Bot Started');

bot.sendMessage(ADMIN_CHAT_ID, '✅ ST Decision Bot Started').catch(() => {});

// =====================
// Helpers
// =====================

function now() {
  return Date.now();
}

function fmtPrice(n) {
  if (n === null || n === undefined || isNaN(Number(n))) return 'غير متوفر';
  return Number(n).toFixed(2);
}

function fmtNum(n) {
  if (n === null || n === undefined || isNaN(Number(n))) return 'غير متوفر';
  return Number(n).toLocaleString('en-US');
}

function cleanText(text) {
  return String(text || '').trim();
}

function pushGlobalHistory(arr, item, limit = HISTORY_LIMIT) {
  const existingIndex = arr.findIndex(x => x.symbol === item.symbol);

  if (existingIndex !== -1) {
    arr.splice(existingIndex, 1);
  }

  arr.unshift(item);

  if (arr.length > limit) {
    arr.length = limit;
  }
}

function isFresh(item) {
  return item && now() - item.time <= MATCH_WINDOW_MS;
}

function getSymbolFromText(text) {
  const patterns = [
    /📊\s*السهم:\s*([A-Z]{1,8})/i,
    /رادار السوق\s*—\s*([A-Z]{1,8})/i,
    /السهم الحالي:\s*([A-Z]{1,8})/i,
    /Symbol:\s*([A-Z]{1,8})/i
  ];

  for (const p of patterns) {
    const m = text.match(p);
    if (m) return m[1].toUpperCase();
  }

  return null;
}

function isGexMessage(text) {
  return (
    text.includes('ST Smart Flow Alert') ||
    text.includes('Gamma Regime') ||
    text.includes('Gamma Flip') ||
    text.includes('CALL BIAS') ||
    text.includes('PUT BIAS')
  );
}

function isRadarMessage(text) {
  return (
    text.includes('رادار السوق') ||
    text.includes('قراءة السيولة المتقدمة') ||
    text.includes('خلاصة المتابعة') ||
    text.includes('اتجاه تدفق العقود')
  );
}

function extractNumberAfter(label, text) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`${escaped}\\s*:?\\s*\\$?([0-9]+(?:\\.[0-9]+)?)`, 'i');
  const m = text.match(re);
  return m ? Number(m[1]) : null;
}

function extractScore(text) {
  const m =
    text.match(/Score:\s*([0-9]+(?:\.[0-9]+)?)\s*\/\s*10/i) ||
    text.match(/الثقة:\s*([0-9]+(?:\.[0-9]+)?)\s*\/\s*10/i) ||
    text.match(/قوة السيطرة:\s*([0-9]+(?:\.[0-9]+)?)\s*\/\s*10/i);

  return m ? Number(m[1]) : 0;
}
function extractBiasFromGex(text) {
  if (text.includes('CALL BIAS')) return 'CALL';
  if (text.includes('PUT BIAS')) return 'PUT';
  return 'NEUTRAL';
}

function extractRadarSide(text) {
  if (
    text.includes('تابع الكول') ||
    text.includes('مراقبة كول') ||
    text.includes('سيطرة الكول') ||
    text.includes('المشترون يسيطرون') ||
    text.includes('الكول يسيطر')
  ) {
    return 'CALL';
  }

  if (
    text.includes('تابع البوت') ||
    text.includes('مراقبة بوت') ||
    text.includes('سيطرة البوت') ||
    text.includes('البائعون يضغطون') ||
    text.includes('البوت يسيطر')
  ) {
    return 'PUT';
  }

  return 'NEUTRAL';
}

function extractEntry(text, side) {
  if (side === 'CALL') {
    const m =
      text.match(/اختراق\s+([0-9]+(?:\.[0-9]+)?)/) ||
      text.match(/فوق\s+([0-9]+(?:\.[0-9]+)?)/) ||
      text.match(/الدخول\s*[:：]?\s*([0-9]+(?:\.[0-9]+)?)/) ||
      text.match(/Entry\s*[:：]?\s*\$?([0-9]+(?:\.[0-9]+)?)/i) ||
      text.match(/Activation\s*[:：]?\s*\$?([0-9]+(?:\.[0-9]+)?)/i);

    if (m) return Number(m[1]);
  }

  if (side === 'PUT') {
    const m =
      text.match(/كسر\s+([0-9]+(?:\.[0-9]+)?)/) ||
      text.match(/تحت\s+([0-9]+(?:\.[0-9]+)?)/) ||
      text.match(/الدخول\s*[:：]?\s*([0-9]+(?:\.[0-9]+)?)/) ||
      text.match(/Entry\s*[:：]?\s*\$?([0-9]+(?:\.[0-9]+)?)/i) ||
      text.match(/Activation\s*[:：]?\s*\$?([0-9]+(?:\.[0-9]+)?)/i);

    if (m) return Number(m[1]);
  }

  const m =
    text.match(/الدخول\s*[:：]?\s*([0-9]+(?:\.[0-9]+)?)/) ||
    text.match(/Entry\s*[:：]?\s*\$?([0-9]+(?:\.[0-9]+)?)/i);

  return m ? Number(m[1]) : null;
}

function extractCurrentPriceFromText(text) {
  const patterns = [
    /سعر السهم الحالي:\s*([0-9]+(?:\.[0-9]+)?)/,
    /السعر الحالي:\s*([0-9]+(?:\.[0-9]+)?)/,
    /💰\s*سعر السهم الحالي:\s*([0-9]+(?:\.[0-9]+)?)/,
    /💵\s*السعر الحالي:\s*([0-9]+(?:\.[0-9]+)?)/,
    /Current Price:\s*\$?([0-9]+(?:\.[0-9]+)?)/i,
    /Price:\s*\$?([0-9]+(?:\.[0-9]+)?)/i
  ];

  for (const p of patterns) {
    const m = text.match(p);
    if (m) return Number(m[1]);
  }

  return null;
}

function isReadyText(text) {
  return (
    text.includes('جاهزة') ||
    text.includes('جاهز') ||
    text.includes('دخول الآن') ||
    text.includes('دخول الان') ||
    text.includes('ادخل الآن') ||
    text.includes('ادخل الان') ||
    text.includes('تفعيل الآن') ||
    text.includes('تفعيل الان') ||
    text.includes('Ready Now') ||
    text.includes('READY NOW') ||
    text.includes('Entry Now') ||
    text.includes('ENTRY NOW') ||
    text.includes('NOW')
  );
}

function extractTargets(text) {
  return {
    tp1: extractNumberAfter('TP1', text),
    tp2: extractNumberAfter('TP2', text),
    tp3: extractNumberAfter('TP3', text)
  };
}

function extractStop(text) {
  const m =
    text.match(/الوقف الفني:\s*\n?\s*([0-9]+(?:\.[0-9]+)?)/) ||
    text.match(/الوقف:\s*\n?\s*([0-9]+(?:\.[0-9]+)?)/) ||
    text.match(/SL:\s*\$?([0-9]+(?:\.[0-9]+)?)/i);

  return m ? Number(m[1]) : null;
}

function buildAutoStop(entry, side) {
  if (!entry || !['CALL', 'PUT'].includes(side)) return null;

  if (side === 'CALL') return entry * 0.995;
  if (side === 'PUT') return entry * 1.005;

  return null;
}

function extractSuggestedExpiration(text) {
  const m =
    text.match(/الانتهاء المقترح:\s*\n?\s*([0-9]{4}-[0-9]{2}-[0-9]{2})/) ||
    text.match(/الانتهاء المسيطر:\s*([0-9]{4}-[0-9]{2}-[0-9]{2})/) ||
    text.match(/Expiration:\s*([0-9]{4}-[0-9]{2}-[0-9]{2})/i);

  return m ? m[1] : null;
}

function extractDominantExpiration(text) {
  const matches = [...text.matchAll(/الانتهاء المسيطر:\s*([0-9]{4}-[0-9]{2}-[0-9]{2})/g)];
  if (!matches.length) return null;
  return matches[0][1];
}
function getStrikeStep(price) {
  if (price >= 1000) return 10;
  if (price >= 500) return 5;
  if (price >= 100) return 2.5;
  return 1;
}

function getStrikeFromEntry(entry, side) {
  if (!entry) return null;

  const step = getStrikeStep(entry);

  if (side === 'CALL') {
    return Math.ceil(entry / step) * step;
  }

  if (side === 'PUT') {
    return Math.floor(entry / step) * step;
  }

  return null;
}

function getOptionMid(snap) {
  const q = snap?.last_quote || {};
  const t = snap?.last_trade || {};

  const bid = Number(q.bid || q.bp || 0);
  const ask = Number(q.ask || q.ap || 0);
  const last = Number(t.price || t.p || 0);

  let mid = 0;

  if (bid > 0 && ask > 0) {
    mid = (bid + ask) / 2;
  } else if (last > 0) {
    mid = last;
  } else if (ask > 0) {
    mid = ask;
  } else if (bid > 0) {
    mid = bid;
  }

  return {
    bid,
    ask,
    last,
    mid,
    volume: snap?.day?.volume || snap?.day?.v || null,
    oi: snap?.open_interest || null,
    delta: snap?.greeks?.delta ?? null,
    gamma: snap?.greeks?.gamma ?? null
  };
}

// =====================
// API
// =====================

async function getFinnhubPrice(symbol) {
  if (!FINNHUB_API_KEY) {
    throw new Error('Missing FINNHUB_API_KEY');
  }

  const url =
    `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(symbol)}&token=${FINNHUB_API_KEY}`;

  const res = await axios.get(url, { timeout: 15000 });
  const price = Number(res.data?.c || 0);

  if (!price) {
    throw new Error(`No Finnhub price for ${symbol}`);
  }

  return price;
}

async function getMassiveOptionSnapshot(symbol, optionTicker) {
  if (!MASSIVE_API_KEY) {
    throw new Error('Missing MASSIVE_API_KEY');
  }

  const url =
    `${MASSIVE_BASE_URL}/v3/snapshot/options/${encodeURIComponent(symbol)}/${encodeURIComponent(optionTicker)}?apiKey=${MASSIVE_API_KEY}`;

  const res = await axios.get(url, { timeout: 15000 });
  const result = res.data?.results;

  if (!result) {
    throw new Error(`No Massive option snapshot for ${optionTicker}`);
  }

  return result;
}

async function getMassiveOptionChain(symbol, expiration, side) {
  if (!MASSIVE_API_KEY) {
    throw new Error('Missing MASSIVE_API_KEY');
  }

  const contractType = side === 'CALL' ? 'call' : 'put';

  let url =
    `${MASSIVE_BASE_URL}/v3/snapshot/options/${encodeURIComponent(symbol)}` +
    `?expiration_date=${encodeURIComponent(expiration)}` +
    `&contract_type=${encodeURIComponent(contractType)}` +
    `&limit=250` +
    `&apiKey=${MASSIVE_API_KEY}`;

  const all = [];

  while (url) {
    const res = await axios.get(url, { timeout: 20000 });
    const results = Array.isArray(res.data?.results) ? res.data.results : [];

    all.push(...results);

    url = res.data?.next_url
      ? `${res.data.next_url}&apiKey=${MASSIVE_API_KEY}`
      : null;
  }

  return all;
}

// =====================
// Option Selection
// =====================

function normalizeChainContract(item) {
  const details = item?.details || {};
  const optionData = getOptionMid(item);

  return {
    optionTicker: details.ticker || item.ticker || null,
    strike: Number(details.strike_price || item.strike_price || 0),
    expiration: details.expiration_date || null,
    contractType: details.contract_type || null,

    bid: optionData.bid,
    ask: optionData.ask,
    last: optionData.last,
    mid: optionData.mid,

    volume: optionData.volume,
    oi: optionData.oi,
    delta: optionData.delta,
    gamma: optionData.gamma
  };
}

function scoreOptionContract(c, preferredStrike, side) {
  const distance = Math.abs(c.strike - preferredStrike);

  const volumeScore = Math.min(Number(c.volume || 0) / 1000, 3);
  const oiScore = Math.min(Number(c.oi || 0) / 3000, 3);

  let deltaScore = 0;
  const delta = Number(c.delta);

  if (!isNaN(delta)) {
    if (side === 'CALL') {
      if (delta >= 0.25 && delta <= 0.65) deltaScore = 3;
      else if (delta >= 0.15 && delta <= 0.75) deltaScore = 1.5;
    }

    if (side === 'PUT') {
      if (delta <= -0.25 && delta >= -0.65) deltaScore = 3;
      else if (delta <= -0.15 && delta >= -0.75) deltaScore = 1.5;
    }
  }

  const spread = Number(c.ask || 0) - Number(c.bid || 0);
  let spreadPenalty = 0;

  if (c.bid > 0 && c.ask > 0) {
    spreadPenalty = Math.min(spread / 0.20, 2);
  }

  const distancePenalty = distance * 0.10;

  return volumeScore + oiScore + deltaScore - distancePenalty - spreadPenalty;
}

async function findBestOptionContract(symbol, expiration, side, preferredStrike) {
  if (!preferredStrike || !expiration) return null;

  let chain = [];

  try {
    chain = await getMassiveOptionChain(symbol, expiration, side);
  } catch (err) {
    console.error('OPTION CHAIN ERROR:', symbol, expiration, side, err.message);
    return null;
  }

  const normalized = chain
    .map(normalizeChainContract)
    .filter(c =>
      c.optionTicker &&
      c.strike > 0 &&
      c.mid >= MIN_CONTRACT_PRICE &&
      c.mid <= MAX_CONTRACT_PRICE
    );

  if (!normalized.length) {
    console.log(`NO CHAIN CONTRACT IN RANGE ${symbol} ${expiration} ${side}`);
    return null;
  }

  normalized.sort((a, b) => {
    const scoreB = scoreOptionContract(b, preferredStrike, side);
    const scoreA = scoreOptionContract(a, preferredStrike, side);

    if (scoreB !== scoreA) return scoreB - scoreA;

    return Math.abs(a.strike - preferredStrike) - Math.abs(b.strike - preferredStrike);
  });

  return normalized[0];
}
// =====================
// Parsers
// =====================

function parseGex(text) {
  const symbol = getSymbolFromText(text);
  if (!symbol) return null;

  const side = extractBiasFromGex(text);
  const score = extractScore(text);

  const explicitEntry = extractEntry(text, side);
  const messagePrice = extractCurrentPriceFromText(text);
  const readyText = isReadyText(text);

  const entry = explicitEntry || (readyText ? messagePrice : null);

  const targets = extractTargets(text);

  let stop = extractStop(text);
  let autoStop = false;

  if (!stop && entry) {
    stop = buildAutoStop(entry, side);
    autoStop = !!stop;
  }

  const strike = getStrikeFromEntry(entry, side);

  return {
    source: 'GEX',
    symbol,
    side,
    score,
    entry,
    explicitEntry,
    messagePrice,
    readyText,
    stop,
    autoStop,
    strike,
    tp1: targets.tp1,
    tp2: targets.tp2,
    tp3: targets.tp3,
    raw: text,
    time: now()
  };
}

function parseRadar(text) {
  const symbol = getSymbolFromText(text);
  if (!symbol) return null;

  const side = extractRadarSide(text);
  const score = extractScore(text);

  const suggestedExpiration =
    extractSuggestedExpiration(text) ||
    extractDominantExpiration(text);

  const buyers =
    text.includes('المشترون') ||
    text.includes('Ask Flow');

  const sellers =
    text.includes('البائعون') ||
    text.includes('Bid Flow');

  return {
    source: 'RADAR',
    symbol,
    side,
    score,
    suggestedExpiration,
    buyers,
    sellers,
    raw: text,
    time: now()
  };
}

// =====================
// Global Match Logic
// =====================

function buildSetupKey(symbol, side, entry, expiration, optionTicker) {
  return `${symbol}:${side}:${entry}:${expiration || 'NA'}:${optionTicker || 'NA'}`;
}

function findMatchingPairs() {
  const pairs = [];

  const freshGex = recentGexMessages.filter(isFresh);
  const freshRadar = recentRadarMessages.filter(isFresh);

  for (const gex of freshGex) {
    const radar = freshRadar.find(r =>
      r.symbol === gex.symbol &&
      r.side === gex.side &&
      ['CALL', 'PUT'].includes(r.side)
    );

    if (radar) {
      pairs.push({ symbol: gex.symbol, gex, radar });
    }
  }

  return pairs;
}

function canCreateDecision(gex, radar) {
  if (!isFresh(gex) || !isFresh(radar)) {
    return {
      ok: false,
      reason: 'البيانات غير متزامنة'
    };
  }

  if (!['CALL', 'PUT'].includes(gex.side)) {
    return {
      ok: false,
      reason: 'القاما لا يعطي اتجاه واضح'
    };
  }

  if (!['CALL', 'PUT'].includes(radar.side)) {
    return {
      ok: false,
      reason: 'الرادار لا يعطي اتجاه واضح'
    };
  }

  if (gex.symbol !== radar.symbol) {
    return {
      ok: false,
      reason: `الشركة مختلفة: GEX=${gex.symbol}, RADAR=${radar.symbol}`
    };
  }

  if (gex.side !== radar.side) {
    return {
      ok: false,
      reason: `تعارض الاتجاه: GEX=${gex.side}, RADAR=${radar.side}`
    };
  }

  if (gex.score < MIN_SCORE) {
    return {
      ok: false,
      reason: `Score ضعيف: ${gex.score}/10`
    };
  }

  if (!gex.entry && !gex.readyText) {
    return {
      ok: false,
      reason: 'لا يوجد مستوى دخول واضح ولا إشارة جاهزة'
    };
  }

  if (!gex.stop && gex.entry) {
    gex.stop = buildAutoStop(gex.entry, gex.side);
    gex.autoStop = true;
  }

  if (!gex.stop) {
    return {
      ok: false,
      reason: 'لا يوجد وقف ولا يمكن حساب وقف تلقائي'
    };
  }

  if (!gex.strike && gex.entry) {
    gex.strike = getStrikeFromEntry(gex.entry, gex.side);
  }

  if (!gex.strike && !gex.entry && !gex.readyText) {
    return {
      ok: false,
      reason: 'لا يوجد سترايك أو دخول واضح'
    };
  }

  return {
    ok: true,
    reason: 'توافق كامل'
  };
}

async function scanGlobalMatches() {
  const pairs = findMatchingPairs();

  if (!pairs.length) {
    console.log('NO GLOBAL MATCHES YET');
    return;
  }

  for (const pair of pairs) {
    await createWatchSetup(pair.symbol, pair.gex, pair.radar);
  }
}

async function createWatchSetup(symbol, gex, radar) {
  const decision = canCreateDecision(gex, radar);

  if (!decision.ok) {
    console.log(`NO DECISION ${symbol}:`, decision.reason);

    if (ADMIN_CHAT_ID) {
      bot.sendMessage(
        ADMIN_CHAT_ID,
        `⚠️ رفض قرار — ${symbol}\nالسبب: ${decision.reason}`
      ).catch(() => {});
    }

    return;
  }

  const expiration = radar.suggestedExpiration || 'غير متوفر';

  if (expiration === 'غير متوفر') {
    console.log(`NO DECISION ${symbol}: لا يوجد انتهاء مقترح`);

    if (ADMIN_CHAT_ID) {
      bot.sendMessage(
        ADMIN_CHAT_ID,
        `⚠️ رفض قرار — ${symbol}\nالسبب: لا يوجد انتهاء مقترح من الرادار`
      ).catch(() => {});
    }

    return;
  }
    let currentPrice = null;

  try {
    currentPrice = await getFinnhubPrice(symbol);
  } catch (err) {
    console.error('FINNHUB PRICE ERROR:', symbol, err.message);
    return;
  }

  if (!gex.entry && gex.readyText) {
    gex.entry = currentPrice;
  }

  if (!gex.strike && gex.entry) {
    gex.strike = getStrikeFromEntry(gex.entry, gex.side);
  }

  if (!gex.stop && gex.entry) {
    gex.stop = buildAutoStop(gex.entry, gex.side);
    gex.autoStop = true;
  }

  if (!gex.entry || !gex.strike) {
    console.log(`NO DECISION ${symbol}: لا يوجد دخول أو سترايك بعد فحص السعر`);
    return;
  }

  let optionData = null;

  try {
    optionData = await findBestOptionContract(
      symbol,
      expiration,
      gex.side,
      gex.strike
    );
  } catch (err) {
    console.error('FIND OPTION ERROR:', err.message);
  }

  if (
    !optionData ||
    !optionData.mid ||
    optionData.mid < MIN_CONTRACT_PRICE ||
    optionData.mid > MAX_CONTRACT_PRICE
  ) {
    console.log(`NO CONTRACT IN PRICE RANGE ${symbol}:`, optionData?.mid || 'NA');

    if (ADMIN_CHAT_ID) {
      bot.sendMessage(
        ADMIN_CHAT_ID,
        `⚠️ رفض عقد — ${symbol}
السبب: لا يوجد عقد داخل النطاق ${MIN_CONTRACT_PRICE} - ${MAX_CONTRACT_PRICE}
السعر المتوفر: ${fmtPrice(optionData?.mid)}`
      ).catch(() => {});
    }

    return;
  }

  const setupKey = buildSetupKey(
    symbol,
    gex.side,
    gex.entry,
    expiration,
    optionData.optionTicker
  );

  if (sentSetupKeys.has(setupKey)) {
    console.log('DUPLICATE SETUP:', setupKey);
    return;
  }

  sentSetupKeys.add(setupKey);

  const setup = {
    key: setupKey,
    symbol,
    side: gex.side,
    entry: gex.entry,
    stop: gex.stop,
    autoStop: gex.autoStop || false,
    readyText: gex.readyText,

    preferredStrike: gex.strike,
    strike: optionData.strike,

    expiration,
    optionTicker: optionData.optionTicker,

    optionEntry: optionData.mid,
    optionBid: optionData.bid,
    optionAsk: optionData.ask,
    optionLast: optionData.last,
    optionVolume: optionData.volume,
    optionOi: optionData.oi,
    optionDelta: optionData.delta,
    optionGamma: optionData.gamma,
    optionStop: Math.max(optionData.mid - CONTRACT_STOP_DROP, 0.01),
    lastContractUpdatePrice: optionData.mid,

    tp1: gex.tp1,
    tp2: gex.tp2,
    tp3: gex.tp3,
    score: gex.score,
    currentPrice,
    createdAt: now(),
    status: 'WATCHING'
  };

  const readyNow =
    setup.readyText ||
    (setup.side === 'CALL'
      ? setup.currentPrice >= setup.entry
      : setup.currentPrice <= setup.entry);

  if (readyNow) {
    console.log('READY NOW SETUP:', setupKey);
    await sendActivatedMessage(setup, setup.currentPrice);
    return;
  }

  activeSetups.set(setupKey, setup);

  await sendWatchMessage(setup, gex, radar);

  console.log('NEW WATCH SETUP:', setupKey);
}

// =====================
// Messages
// =====================

async function sendWatchMessage(setup, gex, radar) {
  const sideEmoji = setup.side === 'CALL' ? '🟢' : '🔴';
  const sideArabic = setup.side === 'CALL' ? 'كول' : 'بوت';

  const contractText =
    setup.strike
      ? `${setup.symbol} ${setup.strike}${setup.side === 'CALL' ? 'C' : 'P'}`
      : 'غير متوفر';

  const activationText =
    setup.side === 'CALL'
      ? `اختراق ${setup.entry} والثبات فوقه`
      : `كسر ${setup.entry} والثبات تحته`;

  const stopNote = setup.autoStop
    ? 'وقف تلقائي محسوب لأن رسالة القاما لا تحتوي وقف واضح'
    : 'وقف من رسالة القاما';

  const text = `🚨 صفقة مراقبة — ST Decision

📊 السهم: ${setup.symbol}
${sideEmoji} النوع: ${sideArabic}
📅 الانتهاء: ${setup.expiration}

🎯 العقد المختار:
${contractText}
${setup.optionTicker}

💰 سعر السهم الحالي: ${fmtPrice(setup.currentPrice)}

💵 سعر العقد وقت الاختيار: ${fmtPrice(setup.optionEntry)}
📉 وقف العقد: ${fmtPrice(setup.optionStop)}

📍 التفعيل:
${activationText}

🎯 أهداف السهم:
TP1: ${setup.tp1 || 'غير متوفر'}
TP2: ${setup.tp2 || 'غير متوفر'}
TP3: ${setup.tp3 || 'غير متوفر'}

🛑 وقف السهم:
${fmtPrice(setup.stop)}
📌 نوع الوقف: ${stopNote}

━━━━━━━━━━━━━━
📊 بيانات العقد

Bid: ${fmtPrice(setup.optionBid)}
Ask: ${fmtPrice(setup.optionAsk)}
Last: ${fmtPrice(setup.optionLast)}
OI: ${fmtNum(setup.optionOi)}
Volume: ${fmtNum(setup.optionVolume)}
Delta: ${setup.optionDelta ?? 'غير متوفر'}
Gamma: ${setup.optionGamma ?? 'غير متوفر'}

━━━━━━━━━━━━━━
📊 سبب الصفقة

✅ GEX: ${setup.side} BIAS
✅ Score القاما: ${setup.score} / 10
✅ Radar: ${radar.side}
✅ انتهاء مقترح/مسيطر: ${setup.expiration}

⏳ الحالة:
مراقبة فقط — لم تتفعل بعد

⚠️ ليست توصية شراء أو بيع`;

  await bot.sendMessage(SIGNALS_CHAT_ID, text);
}

async function sendActivatedMessage(setup, price) {
  const sideEmoji = setup.side === 'CALL' ? '🟢' : '🔴';
  const sideArabic = setup.side === 'CALL' ? 'كول' : 'بوت';

  let optionData = null;

  try {
    if (setup.optionTicker) {
      const snap = await getMassiveOptionSnapshot(setup.symbol, setup.optionTicker);
      optionData = getOptionMid(snap);
    }
  } catch (err) {
    console.error('ACTIVATION OPTION ERROR:', err.message);
  }

  const optionEntry = optionData?.mid || setup.optionEntry || null;
    if (
    !optionEntry ||
    optionEntry < MIN_CONTRACT_PRICE ||
    optionEntry > MAX_CONTRACT_PRICE
  ) {
    activeSetups.delete(setup.key);
    activeTrades.delete(setup.key);

    await bot.sendMessage(
      SIGNALS_CHAT_ID,
      `❌ تم إلغاء تفعيل الصفقة — ST Decision

📊 السهم: ${setup.symbol}
النوع: ${sideArabic}
📅 الانتهاء: ${setup.expiration}

🎯 العقد:
${setup.optionTicker || 'غير متوفر'}

💵 سعر العقد الحالي: ${fmtPrice(optionEntry)}

📌 السبب:
سعر العقد خرج عن النطاق المطلوب ${MIN_CONTRACT_PRICE} - ${MAX_CONTRACT_PRICE}

⚠️ ليست توصية شراء أو بيع`
    );

    return;
  }

  const optionStop = Math.max(optionEntry - CONTRACT_STOP_DROP, 0.01);

  setup.optionEntry = optionEntry;
  setup.optionStop = optionStop;
  setup.optionBid = optionData?.bid || setup.optionBid;
  setup.optionAsk = optionData?.ask || setup.optionAsk;
  setup.optionLast = optionData?.last || setup.optionLast;
  setup.optionVolume = optionData?.volume || setup.optionVolume;
  setup.optionOi = optionData?.oi || setup.optionOi;
  setup.optionDelta = optionData?.delta ?? setup.optionDelta;
  setup.optionGamma = optionData?.gamma ?? setup.optionGamma;

  setup.lastContractUpdatePrice = optionEntry;
  setup.activatedAt = now();
  setup.status = 'ACTIVE';

  activeTrades.set(setup.key, setup);

  const stopNote = setup.autoStop ? 'وقف تلقائي محسوب' : 'وقف من رسالة القاما';

  const text = `✅ تم تفعيل الصفقة — ST Decision

📊 السهم: ${setup.symbol}
${sideEmoji} النوع: ${sideArabic}
📅 الانتهاء: ${setup.expiration}

🎯 العقد:
${setup.optionTicker || 'غير متوفر'}

💰 سعر السهم الحالي: ${fmtPrice(price)}
📍 مستوى الدخول: ${fmtPrice(setup.entry)}

💵 دخول العقد: ${fmtPrice(optionEntry)}
🛑 وقف العقد: ${fmtPrice(optionStop)}
🛑 وقف السهم: ${fmtPrice(setup.stop)}
📌 نوع الوقف: ${stopNote}

🎯 أهداف السهم:
TP1: ${setup.tp1 || 'غير متوفر'}
TP2: ${setup.tp2 || 'غير متوفر'}
TP3: ${setup.tp3 || 'غير متوفر'}

📦 OI: ${fmtNum(setup.optionOi)}
📊 Volume: ${fmtNum(setup.optionVolume)}

🔔 سيتم إرسال تحديث كلما ارتفع العقد +${CONTRACT_UPDATE_STEP.toFixed(2)}

⚠️ ليست توصية شراء أو بيع`;

  await bot.sendMessage(SIGNALS_CHAT_ID, text);
}

async function sendCancelledMessage(setup, price, reason) {
  const text = `❌ تم إلغاء صفقة المراقبة — ST Decision

📊 السهم: ${setup.symbol}
النوع: ${setup.side}
💰 السعر الحالي: ${fmtPrice(price)}

🎯 العقد:
${setup.optionTicker || 'غير متوفر'}

📌 السبب:
${reason}`;

  await bot.sendMessage(SIGNALS_CHAT_ID, text);
}

// =====================
// Monitors
// =====================

async function monitorSetups() {
  for (const [key, setup] of activeSetups.entries()) {
    try {
      if (setup.status !== 'WATCHING') continue;

      if (now() - setup.createdAt > SETUP_EXPIRE_MS) {
        setup.status = 'EXPIRED';
        activeSetups.delete(key);

        await sendCancelledMessage(
          setup,
          setup.currentPrice,
          'انتهت مدة المراقبة بدون تفعيل'
        );

        continue;
      }

      const price = await getFinnhubPrice(setup.symbol);
      setup.currentPrice = price;

      if (setup.side === 'CALL') {
        if (price >= setup.entry) {
          activeSetups.delete(key);
          await sendActivatedMessage(setup, price);
          continue;
        }

        if (price <= setup.stop) {
          setup.status = 'CANCELLED';
          activeSetups.delete(key);

          await sendCancelledMessage(
            setup,
            price,
            'السعر كسر وقف السهم قبل التفعيل'
          );

          continue;
        }
      }

      if (setup.side === 'PUT') {
        if (price <= setup.entry) {
          activeSetups.delete(key);
          await sendActivatedMessage(setup, price);
          continue;
        }

        if (price >= setup.stop) {
          setup.status = 'CANCELLED';
          activeSetups.delete(key);

          await sendCancelledMessage(
            setup,
            price,
            'السعر اخترق وقف السهم قبل التفعيل'
          );

          continue;
        }
      }
    } catch (err) {
      console.error('MONITOR SETUP ERROR:', key, err.message);
    }
  }
}

async function monitorActiveTrades() {
  for (const [key, trade] of activeTrades.entries()) {
    try {
      if (!trade.optionTicker) continue;

      const snap = await getMassiveOptionSnapshot(trade.symbol, trade.optionTicker);
      const optionData = getOptionMid(snap);

      const optionPrice = optionData.mid;
      if (!optionPrice) continue;

      trade.optionBid = optionData.bid || trade.optionBid;
      trade.optionAsk = optionData.ask || trade.optionAsk;
      trade.optionLast = optionData.last || trade.optionLast;
      trade.optionVolume = optionData.volume || trade.optionVolume;
      trade.optionOi = optionData.oi || trade.optionOi;
      trade.optionDelta = optionData.delta ?? trade.optionDelta;
      trade.optionGamma = optionData.gamma ?? trade.optionGamma;

      if (trade.optionStop && optionPrice <= trade.optionStop) {
        activeTrades.delete(key);

        await bot.sendMessage(
          SIGNALS_CHAT_ID,
          `🛑 ضرب وقف العقد — ST Decision

📊 السهم: ${trade.symbol}
🎯 العقد:
${trade.optionTicker}

💵 دخول العقد: ${fmtPrice(trade.optionEntry)}
💵 سعر العقد الحالي: ${fmtPrice(optionPrice)}
🛑 وقف العقد: ${fmtPrice(trade.optionStop)}

📌 تم إيقاف المتابعة.`
        );

        continue;
      }

      const lastUpdate = trade.lastContractUpdatePrice || trade.optionEntry || optionPrice;

      if (optionPrice >= lastUpdate + CONTRACT_UPDATE_STEP) {
        trade.lastContractUpdatePrice = optionPrice;

        await bot.sendMessage(
          SIGNALS_CHAT_ID,
          `📈 تحديث العقد — ST Decision

📊 السهم: ${trade.symbol}
🎯 العقد:
${trade.optionTicker}

💵 دخول العقد: ${fmtPrice(trade.optionEntry)}
💵 السعر الحالي: ${fmtPrice(optionPrice)}
✅ الربح الحالي: +${fmtPrice(optionPrice - trade.optionEntry)}

🛑 وقف العقد: ${fmtPrice(trade.optionStop)}
📦 OI: ${fmtNum(trade.optionOi)}
📊 Volume: ${fmtNum(trade.optionVolume)}`
        );
      }
    } catch (err) {
      console.error('ACTIVE TRADE MONITOR ERROR:', key, err.message);
    }
  }
}

// =====================
// Telegram Handlers
// =====================

bot.on('message', async (msg) => {
  try {
    const chatId = String(msg.chat?.id || '');

    if (chatId !== String(DECISION_GROUP_ID)) {
      return;
    }

    const text = cleanText(msg.text);
    if (!text) return;

    if (text === '/ping') {
      return bot.sendMessage(
        msg.chat.id,
        '✅ ST Decision Bot يعمل ويقرأ المجموعة'
      );
    }

    if (text === '/status') {
      const gexList = recentGexMessages.map(x => `${x.symbol}:${x.side}`).join(' | ') || 'لا يوجد';
      const radarList = recentRadarMessages.map(x => `${x.symbol}:${x.side}`).join(' | ') || 'لا يوجد';

      return bot.sendMessage(
        msg.chat.id,
        `📊 حالة ST Decision Bot

✅ يعمل

آخر شركات القاما:
${gexList}

آخر شركات الرادار:
${radarList}

صفقات المراقبة: ${activeSetups.size}
الصفقات المفعلة: ${activeTrades.size}

عدد الشركات المحفوظة من كل مصدر:
${HISTORY_LIMIT}

نافذة المطابقة:
${Math.round(MATCH_WINDOW_MS / 60000)} دقيقة

أقل Score:
${MIN_SCORE} / 10

نطاق سعر العقد:
${MIN_CONTRACT_PRICE} إلى ${MAX_CONTRACT_PRICE}

طريقة القرار:
يطابق آخر ${HISTORY_LIMIT} شركات من القاما مع آخر ${HISTORY_LIMIT} شركات من الرادار
ثم يبحث عن نفس الشركة ونفس الاتجاه

طريقة الوقف:
وقف القاما، وإذا غير موجود يتم حساب وقف تلقائي 0.5%`
      );
    }

    let parsed = null;

    if (isGexMessage(text)) {
      parsed = parseGex(text);
    } else if (isRadarMessage(text)) {
      parsed = parseRadar(text);
    }

    if (!parsed || !parsed.symbol) {
      return;
    }

    if (parsed.source === 'GEX') {
      pushGlobalHistory(recentGexMessages, parsed, HISTORY_LIMIT);
      console.log(`GEX SAVED GLOBAL: ${parsed.symbol} ${parsed.side} | Count: ${recentGexMessages.length}`);
    }

    if (parsed.source === 'RADAR') {
      pushGlobalHistory(recentRadarMessages, parsed, HISTORY_LIMIT);
      console.log(`RADAR SAVED GLOBAL: ${parsed.symbol} ${parsed.side} | Count: ${recentRadarMessages.length}`);
    }

    await scanGlobalMatches();
  } catch (err) {
    console.error('MESSAGE ERROR:', err.message);
  }
});

bot.on('polling_error', (err) => {
  console.error('POLLING ERROR:', err.message);
});

setInterval(monitorSetups, PRICE_CHECK_MS);
setInterval(monitorActiveTrades, PRICE_CHECK_MS);
