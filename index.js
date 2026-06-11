require('dotenv').config();

const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');

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
const SIGNALS_THREAD_ID = process.env.SIGNALS_THREAD_ID
  ? Number(process.env.SIGNALS_THREAD_ID)
  : null;

const FINNHUB_API_KEY = process.env.FINNHUB_API_KEY;
const MASSIVE_API_KEY = process.env.MASSIVE_API_KEY;
const MASSIVE_BASE_URL = process.env.MASSIVE_BASE_URL || 'https://api.massive.com';

const decisionSupabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

const MATCH_WINDOW_MS = Number(process.env.MATCH_WINDOW_MS || 20 * 60 * 1000);
const PRICE_CHECK_MS = Number(process.env.PRICE_CHECK_MS || 30 * 1000);
const SETUP_EXPIRE_MS = Number(process.env.SETUP_EXPIRE_MS || 3 * 60 * 60 * 1000);

const MIN_SCORE = Number(process.env.MIN_SCORE || 6);

const MIN_CONTRACT_PRICE = Number(process.env.MIN_CONTRACT_PRICE || 1.00);
const MAX_CONTRACT_PRICE = Number(process.env.MAX_CONTRACT_PRICE || 2.70);

const CONTRACT_UPDATE_STEP = Number(process.env.CONTRACT_UPDATE_STEP || 0.10);
const CONTRACT_STOP_DROP = Number(process.env.CONTRACT_STOP_DROP || 0.65);

const HISTORY_LIMIT = Number(process.env.HISTORY_LIMIT || 5);

const MAX_ENTRY_DISTANCE_PCT = Number(process.env.MAX_ENTRY_DISTANCE_PCT || 5);

const CONTRACT_QTY = Number(process.env.CONTRACT_QTY || 1);

const recentGexMessages = [];
const recentRadarMessages = [];

const activeSetups = new Map();
const activeTrades = new Map();
const sentSetupKeys = new Set();

async function sendSignalMessage(text) {
  const options = {};

  if (SIGNALS_THREAD_ID) {
    options.message_thread_id = SIGNALS_THREAD_ID;
  }

  return bot.sendMessage(SIGNALS_CHAT_ID, text, options);
}

async function loadDecisionMessages() {
  try {
    const { data, error } = await decisionSupabase
      .from('decision_messages')
      .select('*')
      .eq('processed', false)
      .order('created_at', { ascending: true })
      .limit(50);

    if (error) {
      console.error('LOAD DECISION MESSAGES ERROR:', error.message);
      return [];
    }

    return data || [];
  } catch (err) {
    console.error('LOAD DECISION MESSAGES ERROR:', err.message);
    return [];
  }
}

async function markDecisionProcessed(id) {
  try {
    await decisionSupabase
      .from('decision_messages')
      .update({ processed: true })
      .eq('id', id);
  } catch (err) {
    console.error('MARK DECISION ERROR:', err.message);
  }
}

async function processDecisionMessages() {
  const messages = await loadDecisionMessages();

  if (!messages.length) return;

  for (const row of messages) {
    const text = cleanText(row.message);

    let parsed = null;

    if (isGexMessage(text)) {
      parsed = parseGex(text);
    } else if (isRadarMessage(text)) {
      parsed = parseRadar(text);
    }

    if (parsed && parsed.symbol) {
      if (parsed.source === 'GEX') {
        pushGlobalHistory(recentGexMessages, parsed, HISTORY_LIMIT);
        console.log(`GEX SAVED FROM SUPABASE: ${parsed.symbol} ${parsed.side}`);
      }

      if (parsed.source === 'RADAR') {
        pushGlobalHistory(recentRadarMessages, parsed, HISTORY_LIMIT);
        console.log(`RADAR SAVED FROM SUPABASE: ${parsed.symbol} ${parsed.side}`);
      }

      await scanGlobalMatches();
    }

    await markDecisionProcessed(row.id);
  }
}

console.log('🚀 ST Decision Bot Started');

bot.sendMessage(ADMIN_CHAT_ID, '✅ ST Decision Bot Started').catch(() => {});

// =====================
// Helpers
// =====================

function now() {
  return Date.now();
}

function getSaudiTimeParts() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Riyadh',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).formatToParts(new Date());

  const obj = {};

  for (const p of parts) {
    obj[p.type] = p.value;
  }

  return {
    year: Number(obj.year),
    month: Number(obj.month),
    day: Number(obj.day),
    hour: Number(obj.hour),
    minute: Number(obj.minute)
  };
}

function getUsDstRangeUtc(year) {
  function nthSunday(monthIndex, nth) {
    const d = new Date(Date.UTC(year, monthIndex, 1));
    const firstSunday = 1 + ((7 - d.getUTCDay()) % 7);
    return firstSunday + (nth - 1) * 7;
  }

  const dstStartDay = nthSunday(2, 2);
  const dstEndDay = nthSunday(10, 1);

  const dstStartUtc = Date.UTC(year, 2, dstStartDay, 7, 0, 0);
  const dstEndUtc = Date.UTC(year, 10, dstEndDay, 6, 0, 0);

  return { dstStartUtc, dstEndUtc };
}

function isUsDstNow() {
  const d = new Date();
  const year = d.getUTCFullYear();
  const { dstStartUtc, dstEndUtc } = getUsDstRangeUtc(year);
  const t = d.getTime();

  return t >= dstStartUtc && t < dstEndUtc;
}

function minutesNowSaudi() {
  const t = getSaudiTimeParts();
  return t.hour * 60 + t.minute;
}

function isDecisionTradingTime() {
  const m = minutesNowSaudi();
  const summer = isUsDstNow();

  const start = summer ? (16 * 60 + 30) : (17 * 60 + 30);
  const end = summer ? (23 * 60) : (24 * 60);

  return m >= start && m <= end;
}

function tradingTimeText() {
  return isUsDstNow()
    ? 'الصيف: 4:30 م إلى 11:00 م بتوقيت السعودية'
    : 'الشتاء: 5:30 م إلى 12:00 ص بتوقيت السعودية';
}

function getIsoWeekNumber(date) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNum = d.getUTCDay() || 7;

  d.setUTCDate(d.getUTCDate() + 4 - dayNum);

  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);

  return String(weekNo).padStart(2, '0');
}

function getWeekKey() {
  const d = new Date();

  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Riyadh',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(d);

  const obj = {};
  for (const p of parts) {
    obj[p.type] = p.value;
  }

  return `${obj.year}-W${getIsoWeekNumber(d)}`;
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
    text.includes('حسب المعطيات الحالية: انتظر') ||
    text.includes('انتظر') ||
    text.includes('لا يوجد توافق كاف') ||
    text.includes('تدفق العقود غير حاسم')
  ) {
    return 'NEUTRAL';
  }

  if (
    text.includes('مراقبة كول') ||
    text.includes('تابع الكول') ||
    text.includes('متابعة كول') ||
    text.includes('دخول كول')
  ) {
    return 'CALL';
  }

  if (
    text.includes('مراقبة بوت') ||
    text.includes('تابع البوت') ||
    text.includes('متابعة بوت') ||
    text.includes('دخول بوت')
  ) {
    return 'PUT';
  }

  if (
    text.includes('سيطرة الكول') ||
    text.includes('الكول يسيطر') ||
    text.includes('المشترون يسيطرون') ||
    text.includes('المشترون يسيطرون على الـ Ask') ||
    text.includes('التحوط الشرائي مسيطر')
  ) {
    return 'CALL';
  }

  if (
    text.includes('سيطرة البوت') ||
    text.includes('البوت يسيطر') ||
    text.includes('البائعون يضغطون') ||
    text.includes('البائعون يضغطون على الـ Bid') ||
    text.includes('التحوط البيعي مسيطر')
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

  if (side === 'CALL') return entry * 0.985;
  if (side === 'PUT') return entry * 1.015;

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

function getContractDisplay(data) {
  if (!data || !data.symbol || !data.strike || !data.side) {
    return 'غير متوفر';
  }

  return `${data.symbol} ${data.strike}${data.side === 'CALL' ? 'C' : 'P'}`;
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

function hasTargetHit(trade, stockPrice, tp) {
  if (!tp || !stockPrice) return false;

  if (trade.side === 'CALL') {
    return stockPrice >= Number(tp);
  }

  if (trade.side === 'PUT') {
    return stockPrice <= Number(tp);
  }

  return false;
}

function getBestHitTarget(trade) {
  if (trade.tp3Hit) return 'TP3';
  if (trade.tp2Hit) return 'TP2';
  if (trade.tp1Hit) return 'TP1';
  return null;
}

async function sendTargetHitMessage(trade, targetName, stockPrice, optionPrice) {
  const isFinal = targetName === 'TP3';

  const entry = Number(trade.optionEntry || 0);
  const current = Number(optionPrice || 0);
  const high = Number(trade.optionHigh || trade.optionEntry || 0);

  const profit = current - entry;
  const maxProfit = high - entry;

  const profitText = profit >= 0
    ? `+${fmtPrice(profit)}`
    : `-${fmtPrice(Math.abs(profit))}`;

  const maxProfitText = maxProfit >= 0
    ? `+${fmtPrice(maxProfit)}`
    : `-${fmtPrice(Math.abs(maxProfit))}`;

  const profitIcon = profit >= 0 ? '📈' : '📉';

  const targetNote = profit > 0
    ? `📌 تحقق هدف السهم والعقد حالياً فوق الدخول.
تابع وقفك ولا تخلي الربح يتحول خسارة.`
    : `⚠️ تحقق هدف السهم، لكن العقد حالياً أقل من سعر الدخول.
لا تعتبرها ربح حتى يتحول العقد فوق الدخول.`;

  const text = isFinal
    ? `🎯🔥 تحقق الهدف الثالث — ST Decision

📊 السهم: ${trade.symbol}
🎯 العقد:
${getContractDisplay(trade)}
${trade.optionTicker}

✅ تحقق: ${targetName}
💰 سعر السهم الحالي: ${fmtPrice(stockPrice)}
💵 سعر العقد الحالي: ${fmtPrice(optionPrice)}
💵 دخول العقد: ${fmtPrice(trade.optionEntry)}
${profitIcon} نتيجة العقد الحالية: ${profitText}
🔥 أعلى ربح وصل له العقد: ${maxProfitText}

━━━━━━━━━━━━━━
🏁 انتهت المتابعة رسميًا

${targetNote}

⚠️ ليست توصية شراء أو بيع`
    : `🎯 تحقق هدف السهم ${targetName} — ST Decision

📊 السهم: ${trade.symbol}
🎯 العقد:
${getContractDisplay(trade)}
${trade.optionTicker}

💰 سعر السهم الحالي: ${fmtPrice(stockPrice)}
💵 سعر العقد الحالي: ${fmtPrice(optionPrice)}
💵 دخول العقد: ${fmtPrice(trade.optionEntry)}
${profitIcon} نتيجة العقد الحالية: ${profitText}
🔥 أعلى ربح وصل له العقد: ${maxProfitText}

${targetNote}

⚠️ ليست توصية شراء أو بيع`;

  await sendSignalMessage(text);
}

async function sendBetterStopMessage(trade, optionPrice) {
  const entry = Number(trade.optionEntry || 0);
  const high = Number(trade.optionHigh || entry || 0);
  const current = Number(optionPrice || 0);

  const maxProfitAmount = entry && high
    ? (high - entry) * 100 * CONTRACT_QTY
    : 0;

  const maxProfitPct = entry && high
    ? ((high - entry) / entry) * 100
    : 0;

  if (high > entry) {
    await sendSignalMessage(`🟡 تنبيه للمستمرين — ST Decision

📊 السهم: ${trade.symbol}
🎯 العقد:
${getContractDisplay(trade)}
${trade.optionTicker}

💵 دخول العقد: ${fmtPrice(entry)}
📈 أعلى سعر وصل له العقد: ${fmtPrice(high)}
🔥 أعلى ربح تحقق: +$${fmtPrice(maxProfitAmount)}
📊 أعلى نسبة ربح: +${fmtPrice(maxProfitPct)}%

💵 سعر العقد الحالي: ${fmtPrice(current)}
🛑 وقف العقد: ${fmtPrice(trade.optionStop)}

📌 العقد عاد الآن تحت الوقف وتم إيقاف المتابعة.
✅ الصفقة حققت ربح قبل الرجوع، وليست صفقة فاشلة.

⚠️ ليست توصية شراء أو بيع`);
    return;
  }

  await sendSignalMessage(`🛑 ضرب وقف العقد — ST Decision

📊 السهم: ${trade.symbol}
🎯 العقد:
${getContractDisplay(trade)}
${trade.optionTicker}

💵 دخول العقد: ${fmtPrice(entry)}
💵 سعر العقد الحالي: ${fmtPrice(current)}
🛑 وقف العقد: ${fmtPrice(trade.optionStop)}

📌 تم إيقاف المتابعة.`);
}
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

  if (stop && entry) {
    const stopDistancePct = Math.abs(stop - entry) / entry * 100;

    if (stopDistancePct > 10) {
      stop = null;
    }
  }

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

function buildSetupKey(symbol, side) {
  return `${symbol}:${side}`;
}

function buildTradeUid(trade) {
  const activatedAt = trade.activatedAt || now();
  const optionTicker = trade.optionTicker || 'NO_OPTION';
  return `${trade.symbol}:${trade.side}:${optionTicker}:${activatedAt}`;
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
      reason: 'الرادار لا يعطي اتجاه واضح أو خلاصة الرادار تقول انتظر'
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
async function notifyAdminReject(symbol, reason) {
  if (!ADMIN_CHAT_ID) return;

  bot.sendMessage(
    ADMIN_CHAT_ID,
    `⚠️ رفض قرار — ${symbol}\nالسبب: ${reason}`
  ).catch(() => {});
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
  if (!isDecisionTradingTime()) {
    console.log(`OUTSIDE TRADING TIME - BLOCKED: ${symbol}`);
    await notifyAdminReject(
      symbol,
      `خارج وقت الصفقات المسموح: ${tradingTimeText()}`
    );
    return;
  }

  const decision = canCreateDecision(gex, radar);

  if (!decision.ok) {
    console.log(`NO DECISION ${symbol}:`, decision.reason);
    await notifyAdminReject(symbol, decision.reason);
    return;
  }

  const expiration = radar.suggestedExpiration || 'غير متوفر';

  if (expiration === 'غير متوفر') {
    const reason = 'لا يوجد انتهاء مقترح من الرادار';
    console.log(`NO DECISION ${symbol}: ${reason}`);
    await notifyAdminReject(symbol, reason);
    return;
  }

  let currentPrice = null;

  try {
    currentPrice = await getFinnhubPrice(symbol);
  } catch (err) {
    console.error('FINNHUB PRICE ERROR:', symbol, err.message);
    await notifyAdminReject(symbol, `خطأ سعر Finnhub: ${err.message}`);
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
    const reason = 'لا يوجد دخول أو سترايك بعد فحص السعر';
    console.log(`NO DECISION ${symbol}: ${reason}`);
    await notifyAdminReject(symbol, reason);
    return;
  }

  const distancePct = Math.abs(currentPrice - gex.entry) / currentPrice * 100;

  if (distancePct > MAX_ENTRY_DISTANCE_PCT) {
    const reason =
      `الدخول بعيد عن السعر الحالي: ${distancePct.toFixed(2)}% ` +
      `(الحد ${MAX_ENTRY_DISTANCE_PCT}%)`;

    console.log(`NO DECISION ${symbol}: ${reason}`);
    await notifyAdminReject(symbol, reason);
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
    const reason =
      `لا يوجد عقد داخل النطاق ${MIN_CONTRACT_PRICE} - ${MAX_CONTRACT_PRICE}. ` +
      `السعر المتوفر: ${fmtPrice(optionData?.mid)}`;

    console.log(`NO CONTRACT IN PRICE RANGE ${symbol}:`, optionData?.mid || 'NA');
    await notifyAdminReject(symbol, reason);
    return;
  }

  const setupKey = buildSetupKey(symbol, gex.side);

  const alreadyWatching = activeSetups.has(setupKey);
  const alreadyActive = activeTrades.has(setupKey);
  const alreadySent = sentSetupKeys.has(setupKey);

  if (alreadyWatching || alreadyActive || alreadySent) {
    console.log('DUPLICATE SYMBOL/SIDE BLOCKED:', setupKey);
    return;
  }

  sentSetupKeys.add(setupKey);

  const setup = {
    key: setupKey,
    tradeUid: null,
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
    optionHigh: optionData.mid,
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
    tp1Hit: false,
    tp2Hit: false,
    tp3Hit: false,
    slHit: false,

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

async function sendWatchMessage(setup, gex, radar) {
  const sideEmoji = setup.side === 'CALL' ? '🟢' : '🔴';
  const sideArabic = setup.side === 'CALL' ? 'كول' : 'بوت';

  const contractText = getContractDisplay(setup);

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

${setup.autoStop
  ? `💵 سعر العقد وقت الاختيار: ${fmtPrice(setup.optionEntry)}
🛑 وقف احتياطي للعقد اذا لم يكن هناك وقف قاما: ${fmtPrice(setup.optionStop)}`
  : `💵 سعر العقد وقت الاختيار: ${fmtPrice(setup.optionEntry)}`}

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

  await sendSignalMessage(text);
}

async function sendActivatedMessage(setup, price) {
  if (!isDecisionTradingTime()) {
    console.log(`ACTIVATION OUTSIDE TRADING TIME - BLOCKED: ${setup.symbol}`);
    activeSetups.delete(setup.key);
    sentSetupKeys.delete(setup.key);

    await notifyAdminReject(
      setup.symbol,
      `تم منع التفعيل خارج وقت الصفقات المسموح: ${tradingTimeText()}`
    );

    return;
  }

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
    sentSetupKeys.delete(setup.key);

    await closeActiveTradeInDb(setup.key, 'CANCELLED_PRICE_RANGE');

    await sendSignalMessage(`❌ تم إلغاء تفعيل الصفقة — ST Decision

📊 السهم: ${setup.symbol}
النوع: ${sideArabic}
📅 الانتهاء: ${setup.expiration}

🎯 العقد:
${getContractDisplay(setup)}
${setup.optionTicker || 'غير متوفر'}

💵 سعر العقد الحالي: ${fmtPrice(optionEntry)}

📌 السبب:
سعر العقد خرج عن النطاق المطلوب ${MIN_CONTRACT_PRICE} - ${MAX_CONTRACT_PRICE}

⚠️ ليست توصية شراء أو بيع`);

    return;
  }

  const optionStop = Math.max(optionEntry - CONTRACT_STOP_DROP, 0.01);

  setup.optionEntry = optionEntry;
  setup.optionHigh = optionEntry;
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
  setup.tradeUid = buildTradeUid(setup);
  setup.status = 'ACTIVE';

  setup.tp1Hit = setup.tp1Hit || false;
  setup.tp2Hit = setup.tp2Hit || false;
  setup.tp3Hit = setup.tp3Hit || false;
  setup.slHit = setup.slHit || false;

  activeTrades.set(setup.key, setup);
  sentSetupKeys.add(setup.key);

  await saveActiveTradeToDb(setup);
  await saveTradeHistoryOpen(setup);

  const stopNote = setup.autoStop ? 'وقف تلقائي محسوب' : 'وقف من رسالة القاما';

  const text = `✅ تم تفعيل الصفقة — ST Decision

📊 السهم: ${setup.symbol}
${sideEmoji} النوع: ${sideArabic}
📅 الانتهاء: ${setup.expiration}

🎯 العقد:
${getContractDisplay(setup)}
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

  await sendSignalMessage(text);
}

async function sendCancelledMessage(setup, price, reason) {
  const text = `❌ تم إلغاء صفقة المراقبة — ST Decision

📊 السهم: ${setup.symbol}
النوع: ${setup.side}
💰 السعر الحالي: ${fmtPrice(price)}

🎯 العقد:
${getContractDisplay(setup)}
${setup.optionTicker || 'غير متوفر'}

📌 السبب:
${reason}`;

  await sendSignalMessage(text);
}
async function saveActiveTradeToDb(trade) {
  try {
    await decisionSupabase
      .from('decision_active_trades')
      .upsert({
        id: trade.key,
        symbol: trade.symbol,
        side: trade.side,
        status: trade.status || 'ACTIVE',
        entry: trade.entry,
        stop: trade.stop,
        strike: trade.strike,
        expiration: trade.expiration,
        option_ticker: trade.optionTicker,
        option_entry: trade.optionEntry,
        option_high: trade.optionHigh,
        option_stop: trade.optionStop,
        last_contract_update_price: trade.lastContractUpdatePrice,

        tp1: trade.tp1 || null,
        tp2: trade.tp2 || null,
        tp3: trade.tp3 || null,
        tp1_hit: !!trade.tp1Hit,
        tp2_hit: !!trade.tp2Hit,
        tp3_hit: !!trade.tp3Hit,
        sl_hit: !!trade.slHit,

        activated_at: trade.activatedAt
          ? new Date(trade.activatedAt).toISOString()
          : new Date().toISOString(),
        updated_at: new Date().toISOString()
      });
  } catch (err) {
    console.error('SAVE ACTIVE TRADE DB ERROR:', err.message);
  }
}

async function closeActiveTradeInDb(id, reason, extra = {}) {
  try {
    await decisionSupabase
      .from('decision_active_trades')
      .update({
        status: reason === 'EXPIRED' ? 'EXPIRED' : 'CLOSED',
        close_reason: reason,
        closed_at: new Date().toISOString(),
        expired_at: reason === 'EXPIRED' ? new Date().toISOString() : null,
        updated_at: new Date().toISOString(),
        ...extra
      })
      .eq('id', id);
  } catch (err) {
    console.error('CLOSE ACTIVE TRADE DB ERROR:', err.message);
  }
}

async function loadActiveTradesFromDb() {
  try {
    const { data, error } = await decisionSupabase
      .from('decision_active_trades')
      .select('*')
      .eq('status', 'ACTIVE');

    if (error) {
      console.error('LOAD ACTIVE TRADES DB ERROR:', error.message);
      return;
    }

    for (const row of data || []) {
      if (!row.id || !row.symbol || !row.option_ticker) continue;

      const trade = {
        key: row.id,
        symbol: row.symbol,
        side: row.side,
        status: row.status || 'ACTIVE',

        entry: Number(row.entry),
        stop: Number(row.stop),
        strike: Number(row.strike),
        expiration: row.expiration,

        optionTicker: row.option_ticker,
        optionEntry: Number(row.option_entry),
        optionHigh: Number(row.option_high || row.option_entry),
        optionStop: Number(row.option_stop),
        lastContractUpdatePrice: Number(row.last_contract_update_price),

        optionBid: null,
        optionAsk: null,
        optionLast: null,
        optionVolume: null,
        optionOi: null,
        optionDelta: null,
        optionGamma: null,

        tp1: row.tp1 ? Number(row.tp1) : null,
        tp2: row.tp2 ? Number(row.tp2) : null,
        tp3: row.tp3 ? Number(row.tp3) : null,
        tp1Hit: !!row.tp1_hit,
        tp2Hit: !!row.tp2_hit,
        tp3Hit: !!row.tp3_hit,
        slHit: !!row.sl_hit,

        activatedAt: row.activated_at ? new Date(row.activated_at).getTime() : now(),
        createdAt: row.created_at ? new Date(row.created_at).getTime() : now()
      };

      trade.tradeUid = buildTradeUid(trade);

      activeTrades.set(trade.key, trade);
      sentSetupKeys.add(trade.key);
    }

    console.log(`✅ LOADED ACTIVE TRADES FROM DB: ${activeTrades.size}`);
  } catch (err) {
    console.error('LOAD ACTIVE TRADES DB ERROR:', err.message);
  }
}

async function saveTradeHistoryOpen(trade) {
  if (!trade.tradeUid) {
    trade.tradeUid = buildTradeUid(trade);
  }

  const entry = Number(trade.optionEntry || 0);
  const high = Number(trade.optionHigh || trade.optionEntry || 0);

  const maxProfitAmount = entry && high
    ? (high - entry) * 100 * CONTRACT_QTY
    : 0;

  const maxProfitPct = entry && high
    ? ((high - entry) / entry) * 100
    : 0;

  try {
    const { error } = await decisionSupabase
      .from('decision_trade_history')
      .insert({
        id: trade.tradeUid,
        trade_uid: trade.tradeUid,
        week_key: getWeekKey(),
        symbol: trade.symbol,
        side: trade.side,
        status: 'ACTIVE',

        entry: trade.entry,
        stop: trade.stop,
        strike: trade.strike,
        expiration: trade.expiration,
        option_ticker: trade.optionTicker,

        option_entry: trade.optionEntry,
        option_exit: null,
        option_high: high,
        option_stop: trade.optionStop,

        profit_amount: maxProfitAmount,
        profit_pct: maxProfitPct,
        max_profit_amount: maxProfitAmount,
        max_profit_pct: maxProfitPct,
        is_win: false,

        tp1: trade.tp1 || null,
        tp2: trade.tp2 || null,
        tp3: trade.tp3 || null,
        tp1_hit: !!trade.tp1Hit,
        tp2_hit: !!trade.tp2Hit,
        tp3_hit: !!trade.tp3Hit,
        sl_hit: !!trade.slHit,

        activated_at: trade.activatedAt
          ? new Date(trade.activatedAt).toISOString()
          : new Date().toISOString()
      });

    if (error) console.error('SAVE TRADE HISTORY OPEN ERROR:', error.message);
  } catch (err) {
    console.error('SAVE TRADE HISTORY OPEN ERROR:', err.message);
  }
}

async function updateTradeHigh(trade) {
  if (!trade.tradeUid) {
    trade.tradeUid = buildTradeUid(trade);
  }

  const entry = Number(trade.optionEntry || 0);
  const high = Number(trade.optionHigh || trade.optionEntry || 0);

  const maxProfitAmount = entry && high
    ? (high - entry) * 100 * CONTRACT_QTY
    : 0;

  const maxProfitPct = entry && high
    ? ((high - entry) / entry) * 100
    : 0;

  try {
    const { error } = await decisionSupabase
      .from('decision_trade_history')
      .update({
        option_high: high,
        profit_amount: maxProfitAmount,
        profit_pct: maxProfitPct,
        max_profit_amount: maxProfitAmount,
        max_profit_pct: maxProfitPct,
        tp1_hit: !!trade.tp1Hit,
        tp2_hit: !!trade.tp2Hit,
        tp3_hit: !!trade.tp3Hit,
        sl_hit: !!trade.slHit
      })
      .eq('trade_uid', trade.tradeUid);

    if (error) console.error('UPDATE TRADE HIGH ERROR:', error.message);
  } catch (err) {
    console.error('UPDATE TRADE HIGH ERROR:', err.message);
  }
}

async function closeTradeHistory(trade, closeReason, optionExit) {
  if (!trade.tradeUid) {
    trade.tradeUid = buildTradeUid(trade);
  }

  const entry = Number(trade.optionEntry || 0);
  const exit = Number(optionExit || 0);
  const high = Number(trade.optionHigh || optionExit || trade.optionEntry || 0);

  const maxProfitAmount = entry && high
    ? (high - entry) * 100 * CONTRACT_QTY
    : 0;

  const maxProfitPct = entry && high
    ? ((high - entry) / entry) * 100
    : 0;

  const isWin =
    closeReason === 'TP3' ||
    trade.tp1Hit ||
    trade.tp2Hit ||
    trade.tp3Hit ||
    maxProfitAmount >= 20;

  try {
    const { error } = await decisionSupabase
      .from('decision_trade_history')
      .update({
        status: 'CLOSED',
        close_reason: closeReason,

        entry: trade.entry,
        stop: trade.stop,
        strike: trade.strike,
        expiration: trade.expiration,
        option_ticker: trade.optionTicker,

        option_entry: trade.optionEntry,
        option_exit: exit,
        option_high: high,
        option_stop: trade.optionStop,

        profit_amount: maxProfitAmount,
        profit_pct: maxProfitPct,
        max_profit_amount: maxProfitAmount,
        max_profit_pct: maxProfitPct,
        is_win: isWin,

        tp1: trade.tp1 || null,
        tp2: trade.tp2 || null,
        tp3: trade.tp3 || null,
        tp1_hit: !!trade.tp1Hit,
        tp2_hit: !!trade.tp2Hit,
        tp3_hit: !!trade.tp3Hit,
        sl_hit: !!trade.slHit,

        closed_at: new Date().toISOString()
      })
      .eq('trade_uid', trade.tradeUid);

    if (error) console.error('CLOSE TRADE HISTORY ERROR:', error.message);
  } catch (err) {
    console.error('CLOSE TRADE HISTORY ERROR:', err.message);
  }

  await rebuildWeeklyStats(getWeekKey());
}

async function rebuildWeeklyStats(weekKey) {
  try {
    const { data, error } = await decisionSupabase
      .from('decision_trade_history')
      .select('*')
      .eq('week_key', weekKey)
      .eq('status', 'CLOSED');

    if (error) {
      console.error('LOAD WEEKLY HISTORY ERROR:', error.message);
      return;
    }

    const rows = data || [];
    const total = rows.length;
    const wins = rows.filter(x => x.is_win).length;
    const losses = rows.filter(x => !x.is_win).length;

    const totalProfit = rows.reduce(
      (sum, x) => sum + Number(x.max_profit_amount || x.profit_amount || 0),
      0
    );

    const avgProfitPct = total
      ? rows.reduce(
          (sum, x) => sum + Number(x.max_profit_pct || x.profit_pct || 0),
          0
        ) / total
      : 0;

    const winRate = total ? (wins / total) * 100 : 0;

    const { error: upsertError } = await decisionSupabase
      .from('decision_weekly_stats')
      .upsert({
        week_key: weekKey,
        total_trades: total,
        winning_trades: wins,
        losing_trades: losses,
        win_rate: winRate,
        total_profit_amount: totalProfit,
        avg_profit_pct: avgProfitPct,
        updated_at: new Date().toISOString()
      });

    if (upsertError) console.error('SAVE WEEKLY STATS ERROR:', upsertError.message);
  } catch (err) {
    console.error('REBUILD WEEKLY STATS ERROR:', err.message);
  }
}

async function monitorSetups() {
  for (const [key, setup] of activeSetups.entries()) {
    try {
      if (setup.status !== 'WATCHING') continue;

      if (!isDecisionTradingTime()) {
        continue;
      }

      if (now() - setup.createdAt > SETUP_EXPIRE_MS) {
        setup.status = 'EXPIRED';
        activeSetups.delete(key);
        sentSetupKeys.delete(setup.key);

        await sendCancelledMessage(
          setup,
          setup.currentPrice,
          'انتهت مدة المراقبة بدون تفعيل'
        );

        continue;
      }

      const price = await getFinnhubPrice(setup.symbol);
      setup.currentPrice = price;

      if (setup.side === 'CALL' && price >= setup.entry) {
        activeSetups.delete(key);
        await sendActivatedMessage(setup, price);
        continue;
      }

      if (setup.side === 'PUT' && price <= setup.entry) {
        activeSetups.delete(key);
        await sendActivatedMessage(setup, price);
        continue;
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

      trade.optionHigh = Math.max(
        Number(trade.optionHigh || trade.optionEntry || 0),
        Number(optionPrice || 0)
      );

      trade.optionBid = optionData.bid || trade.optionBid;
      trade.optionAsk = optionData.ask || trade.optionAsk;
      trade.optionLast = optionData.last || trade.optionLast;
      trade.optionVolume = optionData.volume || trade.optionVolume;
      trade.optionOi = optionData.oi || trade.optionOi;
      trade.optionDelta = optionData.delta ?? trade.optionDelta;
      trade.optionGamma = optionData.gamma ?? trade.optionGamma;

      await updateTradeHigh(trade);

      const stockPrice = await getFinnhubPrice(trade.symbol);

      if (!trade.tp1Hit && hasTargetHit(trade, stockPrice, trade.tp1)) {
        trade.tp1Hit = true;
        await sendTargetHitMessage(trade, 'TP1', stockPrice, optionPrice);
        await saveActiveTradeToDb(trade);
        await updateTradeHigh(trade);
      }

      if (!trade.tp2Hit && hasTargetHit(trade, stockPrice, trade.tp2)) {
        trade.tp2Hit = true;
        await sendTargetHitMessage(trade, 'TP2', stockPrice, optionPrice);
        await saveActiveTradeToDb(trade);
        await updateTradeHigh(trade);
      }

      if (!trade.tp3Hit && hasTargetHit(trade, stockPrice, trade.tp3)) {
        trade.tp3Hit = true;
        await sendTargetHitMessage(trade, 'TP3', stockPrice, optionPrice);

        activeTrades.delete(key);
        sentSetupKeys.delete(trade.key);

        await closeActiveTradeInDb(key, 'TP3', {
          tp1_hit: !!trade.tp1Hit,
          tp2_hit: !!trade.tp2Hit,
          tp3_hit: true,
          sl_hit: false
        });

        await closeTradeHistory(trade, 'TP3', optionPrice);

        continue;
      }

      if (trade.optionStop && optionPrice <= trade.optionStop) {
        trade.slHit = true;

        activeTrades.delete(key);
        sentSetupKeys.delete(trade.key);

        await closeActiveTradeInDb(key, 'SL', {
          tp1_hit: !!trade.tp1Hit,
          tp2_hit: !!trade.tp2Hit,
          tp3_hit: !!trade.tp3Hit,
          sl_hit: true,
          option_high: trade.optionHigh
        });

        await closeTradeHistory(trade, 'SL', optionPrice);
        await sendBetterStopMessage(trade, optionPrice);

        continue;
      }

      const lastUpdate = trade.lastContractUpdatePrice || trade.optionEntry || optionPrice;

      if (optionPrice >= lastUpdate + CONTRACT_UPDATE_STEP) {
        trade.lastContractUpdatePrice = optionPrice;

        await saveActiveTradeToDb(trade);
        await updateTradeHigh(trade);

        await sendSignalMessage(`📈 تحديث العقد — ST Decision

📊 السهم: ${trade.symbol}
🎯 العقد:
${getContractDisplay(trade)}
${trade.optionTicker}

💵 دخول العقد: ${fmtPrice(trade.optionEntry)}
💵 السعر الحالي: ${fmtPrice(optionPrice)}
📈 أعلى سعر وصله العقد: ${fmtPrice(trade.optionHigh)}
✅ الربح الحالي: +${fmtPrice(optionPrice - trade.optionEntry)}
🔥 أعلى ربح وصل له العقد: +${fmtPrice(trade.optionHigh - trade.optionEntry)}

🎯 حالة الأهداف:
TP1: ${trade.tp1Hit ? '✅ تحقق' : '⏳ لم يتحقق'}
TP2: ${trade.tp2Hit ? '✅ تحقق' : '⏳ لم يتحقق'}
TP3: ${trade.tp3Hit ? '✅ تحقق' : '⏳ لم يتحقق'}

🛑 وقف العقد: ${fmtPrice(trade.optionStop)}
📦 OI: ${fmtNum(trade.optionOi)}
📊 Volume: ${fmtNum(trade.optionVolume)}`);
      }
    } catch (err) {
      console.error('ACTIVE TRADE MONITOR ERROR:', key, err.message);
    }
  }
}

bot.on('message', async (msg) => {
  try {
    const chatId = String(msg.chat?.id || '');

    console.log('MESSAGE RECEIVED:', {
      chatId: msg.chat?.id,
      title: msg.chat?.title,
      type: msg.chat?.type,
      messageThreadId: msg.message_thread_id,
      fromBot: msg.from?.is_bot,
      from: msg.from?.username || msg.from?.first_name,
      text: String(msg.text || '').slice(0, 80)
    });

    if (chatId !== String(DECISION_GROUP_ID)) {
      return;
    }

    const text = cleanText(msg.text);
    if (!text) return;

    if (
      text !== '/ping' &&
      text !== '/status' &&
      text !== '/botstatus'
    ) {
      return;
    }

    if (text === '/ping') {
      return bot.sendMessage(
        msg.chat.id,
        '✅ ST Decision Bot يعمل ويقرأ المجموعة',
        msg.message_thread_id ? { message_thread_id: msg.message_thread_id } : {}
      );
    }

    if (text === '/status' || text === '/botstatus') {
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

أقصى بُعد للدخول عن السعر الحالي:
${MAX_ENTRY_DISTANCE_PCT}%

وقت الصفقات المسموح:
${tradingTimeText()}

حالة الوقت الآن:
${isDecisionTradingTime() ? '✅ داخل وقت الصفقات' : '⛔ خارج وقت الصفقات'}

طريقة منع التكرار:
يمنع تكرار نفس الشركة ونفس الاتجاه.
مثال: TSLA CALL لا يتكرر حتى لو تغير السترايك.

حفظ الصفقات:
الصفقات المفعلة تحفظ في Supabase وتعود بعد Restart أو Deploy.
والصفقات تحفظ في decision_trade_history مع trade_uid فريد لكل صفقة حتى لا يتم استبدال العقود المتكررة.
والإحصائيات الأسبوعية تحفظ في decision_weekly_stats.

متابعة الأهداف:
البوت يراقب TP1 و TP2 و TP3 على سعر السهم.
إذا تحقق TP3 تنتهي المتابعة تلقائيًا.
إذا حقق العقد ربح ثم رجع تحت وقف العقد تظهر الرسالة كتنبيه للمستمرين مع أعلى ربح تحقق.

طريقة القرار:
يطابق آخر ${HISTORY_LIMIT} شركات من القاما مع آخر ${HISTORY_LIMIT} شركات من الرادار
ثم يبحث عن نفس الشركة ونفس الاتجاه

منطق الرادار:
أولوية لخلاصة المتابعة. إذا الخلاصة تقول انتظر = لا صفقة.

طريقة الوقف:
وقف القاما، وإذا غير موجود يتم حساب وقف تلقائي 1.5%`,
        msg.message_thread_id ? { message_thread_id: msg.message_thread_id } : {}
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

loadActiveTradesFromDb();

setInterval(monitorSetups, PRICE_CHECK_MS);
setInterval(monitorActiveTrades, PRICE_CHECK_MS);
setInterval(processDecisionMessages, 15 * 1000);
