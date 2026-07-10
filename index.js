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
const UNIFIED_BOT_URL = process.env.UNIFIED_BOT_URL;
const DECISION_ALERT_SECRET = process.env.DECISION_ALERT_SECRET;

// Smart Stop Review APIs
const GAMMA_API_URL = process.env.GAMMA_API_URL;
const GAMMA_API_SECRET = process.env.GAMMA_API_SECRET;
const RADAR_API_URL = process.env.RADAR_API_URL;
const RADAR_API_SECRET = process.env.RADAR_API_SECRET;

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
const TP3_PROTECT_PROFIT_AMOUNT = Number(process.env.TP3_PROTECT_PROFIT_AMOUNT || 20);

// Smart stop timings
const STOP_REVIEW_RETRY_MS = Number(process.env.STOP_REVIEW_RETRY_MS || 30 * 1000);
const STOP_REVIEW_CONTINUE_MS = Number(process.env.STOP_REVIEW_CONTINUE_MS || 2 * 60 * 1000);
const STOP_REVIEW_HTTP_TIMEOUT_MS = Number(process.env.STOP_REVIEW_HTTP_TIMEOUT_MS || 45 * 1000);
const STOP_REVIEW_REQUEST_ATTEMPTS = Number(process.env.STOP_REVIEW_REQUEST_ATTEMPTS || 3);

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

  async function sendUnifiedPrivateAlert(payload) {
  if (!UNIFIED_BOT_URL || !DECISION_ALERT_SECRET) {
    console.error('Missing UNIFIED_BOT_URL or DECISION_ALERT_SECRET');
    return;
  }

  try {
    await axios.post(
      `${String(UNIFIED_BOT_URL).replace(/\/+$/, '')}/decision-alert`,
      {
        secret: DECISION_ALERT_SECRET,
        ...payload
      },
      { timeout: 15000 }
    );
  } catch (err) {
    console.error('UNIFIED PRIVATE ALERT ERROR:', err.response?.data || err.message);
  }
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

console.log('ð ST Decision Bot Started');

bot.sendMessage(ADMIN_CHAT_ID, 'â ST Decision Bot Started').catch(() => {});

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
    ? 'Ø§ÙØµÙÙ: 4:30 Ù Ø¥ÙÙ 11:00 Ù Ø¨ØªÙÙÙØª Ø§ÙØ³Ø¹ÙØ¯ÙØ©'
    : 'Ø§ÙØ´ØªØ§Ø¡: 5:30 Ù Ø¥ÙÙ 12:00 Øµ Ø¨ØªÙÙÙØª Ø§ÙØ³Ø¹ÙØ¯ÙØ©';
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
  if (n === null || n === undefined || isNaN(Number(n))) return 'ØºÙØ± ÙØªÙÙØ±';
  return Number(n).toFixed(2);
}

function fmtNum(n) {
  if (n === null || n === undefined || isNaN(Number(n))) return 'ØºÙØ± ÙØªÙÙØ±';
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
    /ð\s*Ø§ÙØ³ÙÙ:\s*([A-Z]{1,8})/i,
    /Ø±Ø§Ø¯Ø§Ø± Ø§ÙØ³ÙÙ\s*â\s*([A-Z]{1,8})/i,
    /Ø§ÙØ³ÙÙ Ø§ÙØ­Ø§ÙÙ:\s*([A-Z]{1,8})/i,
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
    text.includes('Ø±Ø§Ø¯Ø§Ø± Ø§ÙØ³ÙÙ') ||
    text.includes('ÙØ±Ø§Ø¡Ø© Ø§ÙØ³ÙÙÙØ© Ø§ÙÙØªÙØ¯ÙØ©') ||
    text.includes('Ø®ÙØ§ØµØ© Ø§ÙÙØªØ§Ø¨Ø¹Ø©') ||
    text.includes('Ø§ØªØ¬Ø§Ù ØªØ¯ÙÙ Ø§ÙØ¹ÙÙØ¯')
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
    text.match(/Ø§ÙØ«ÙØ©:\s*([0-9]+(?:\.[0-9]+)?)\s*\/\s*10/i) ||
    text.match(/ÙÙØ© Ø§ÙØ³ÙØ·Ø±Ø©:\s*([0-9]+(?:\.[0-9]+)?)\s*\/\s*10/i);

  return m ? Number(m[1]) : 0;
}

function extractBiasFromGex(text) {
  if (text.includes('CALL BIAS')) return 'CALL';
  if (text.includes('PUT BIAS')) return 'PUT';
  return 'NEUTRAL';
}

function extractRadarSide(text) {
  if (
    text.includes('Ø­Ø³Ø¨ Ø§ÙÙØ¹Ø·ÙØ§Øª Ø§ÙØ­Ø§ÙÙØ©: Ø§ÙØªØ¸Ø±') ||
    text.includes('Ø§ÙØªØ¸Ø±') ||
    text.includes('ÙØ§ ÙÙØ¬Ø¯ ØªÙØ§ÙÙ ÙØ§Ù') ||
    text.includes('ØªØ¯ÙÙ Ø§ÙØ¹ÙÙØ¯ ØºÙØ± Ø­Ø§Ø³Ù')
  ) {
    return 'NEUTRAL';
  }

  if (
    text.includes('ÙØ±Ø§ÙØ¨Ø© ÙÙÙ') ||
    text.includes('ØªØ§Ø¨Ø¹ Ø§ÙÙÙÙ') ||
    text.includes('ÙØªØ§Ø¨Ø¹Ø© ÙÙÙ') ||
    text.includes('Ø¯Ø®ÙÙ ÙÙÙ')
  ) {
    return 'CALL';
  }

  if (
    text.includes('ÙØ±Ø§ÙØ¨Ø© Ø¨ÙØª') ||
    text.includes('ØªØ§Ø¨Ø¹ Ø§ÙØ¨ÙØª') ||
    text.includes('ÙØªØ§Ø¨Ø¹Ø© Ø¨ÙØª') ||
    text.includes('Ø¯Ø®ÙÙ Ø¨ÙØª')
  ) {
    return 'PUT';
  }

  if (
    text.includes('Ø³ÙØ·Ø±Ø© Ø§ÙÙÙÙ') ||
    text.includes('Ø§ÙÙÙÙ ÙØ³ÙØ·Ø±') ||
    text.includes('Ø§ÙÙØ´ØªØ±ÙÙ ÙØ³ÙØ·Ø±ÙÙ') ||
    text.includes('Ø§ÙÙØ´ØªØ±ÙÙ ÙØ³ÙØ·Ø±ÙÙ Ø¹ÙÙ Ø§ÙÙ Ask') ||
    text.includes('Ø§ÙØªØ­ÙØ· Ø§ÙØ´Ø±Ø§Ø¦Ù ÙØ³ÙØ·Ø±')
  ) {
    return 'CALL';
  }

  if (
    text.includes('Ø³ÙØ·Ø±Ø© Ø§ÙØ¨ÙØª') ||
    text.includes('Ø§ÙØ¨ÙØª ÙØ³ÙØ·Ø±') ||
    text.includes('Ø§ÙØ¨Ø§Ø¦Ø¹ÙÙ ÙØ¶ØºØ·ÙÙ') ||
    text.includes('Ø§ÙØ¨Ø§Ø¦Ø¹ÙÙ ÙØ¶ØºØ·ÙÙ Ø¹ÙÙ Ø§ÙÙ Bid') ||
    text.includes('Ø§ÙØªØ­ÙØ· Ø§ÙØ¨ÙØ¹Ù ÙØ³ÙØ·Ø±')
  ) {
    return 'PUT';
  }

  return 'NEUTRAL';
}

function extractEntry(text, side) {
  if (side === 'CALL') {
    const m =
      text.match(/Ø§Ø®ØªØ±Ø§Ù\s+([0-9]+(?:\.[0-9]+)?)/) ||
      text.match(/ÙÙÙ\s+([0-9]+(?:\.[0-9]+)?)/) ||
      text.match(/Ø§ÙØ¯Ø®ÙÙ\s*[:ï¼]?\s*([0-9]+(?:\.[0-9]+)?)/) ||
      text.match(/Entry\s*[:ï¼]?\s*\$?([0-9]+(?:\.[0-9]+)?)/i) ||
      text.match(/Activation\s*[:ï¼]?\s*\$?([0-9]+(?:\.[0-9]+)?)/i);

    if (m) return Number(m[1]);
  }

  if (side === 'PUT') {
    const m =
      text.match(/ÙØ³Ø±\s+([0-9]+(?:\.[0-9]+)?)/) ||
      text.match(/ØªØ­Øª\s+([0-9]+(?:\.[0-9]+)?)/) ||
      text.match(/Ø§ÙØ¯Ø®ÙÙ\s*[:ï¼]?\s*([0-9]+(?:\.[0-9]+)?)/) ||
      text.match(/Entry\s*[:ï¼]?\s*\$?([0-9]+(?:\.[0-9]+)?)/i) ||
      text.match(/Activation\s*[:ï¼]?\s*\$?([0-9]+(?:\.[0-9]+)?)/i);

    if (m) return Number(m[1]);
  }

  const m =
    text.match(/Ø§ÙØ¯Ø®ÙÙ\s*[:ï¼]?\s*([0-9]+(?:\.[0-9]+)?)/) ||
    text.match(/Entry\s*[:ï¼]?\s*\$?([0-9]+(?:\.[0-9]+)?)/i);

  return m ? Number(m[1]) : null;
}

function extractCurrentPriceFromText(text) {
  const patterns = [
    /Ø³Ø¹Ø± Ø§ÙØ³ÙÙ Ø§ÙØ­Ø§ÙÙ:\s*([0-9]+(?:\.[0-9]+)?)/,
    /Ø§ÙØ³Ø¹Ø± Ø§ÙØ­Ø§ÙÙ:\s*([0-9]+(?:\.[0-9]+)?)/,
    /ð°\s*Ø³Ø¹Ø± Ø§ÙØ³ÙÙ Ø§ÙØ­Ø§ÙÙ:\s*([0-9]+(?:\.[0-9]+)?)/,
    /ðµ\s*Ø§ÙØ³Ø¹Ø± Ø§ÙØ­Ø§ÙÙ:\s*([0-9]+(?:\.[0-9]+)?)/,
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
    text.includes('Ø¬Ø§ÙØ²Ø©') ||
    text.includes('Ø¬Ø§ÙØ²') ||
    text.includes('Ø¯Ø®ÙÙ Ø§ÙØ¢Ù') ||
    text.includes('Ø¯Ø®ÙÙ Ø§ÙØ§Ù') ||
    text.includes('Ø§Ø¯Ø®Ù Ø§ÙØ¢Ù') ||
    text.includes('Ø§Ø¯Ø®Ù Ø§ÙØ§Ù') ||
    text.includes('ØªÙØ¹ÙÙ Ø§ÙØ¢Ù') ||
    text.includes('ØªÙØ¹ÙÙ Ø§ÙØ§Ù') ||
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
    text.match(/Ø§ÙÙÙÙ Ø§ÙÙÙÙ:\s*\n?\s*([0-9]+(?:\.[0-9]+)?)/) ||
    text.match(/Ø§ÙÙÙÙ:\s*\n?\s*([0-9]+(?:\.[0-9]+)?)/) ||
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
    text.match(/Ø§ÙØ§ÙØªÙØ§Ø¡ Ø§ÙÙÙØªØ±Ø­:\s*\n?\s*([0-9]{4}-[0-9]{2}-[0-9]{2})/) ||
    text.match(/Ø§ÙØ§ÙØªÙØ§Ø¡ Ø§ÙÙØ³ÙØ·Ø±:\s*([0-9]{4}-[0-9]{2}-[0-9]{2})/) ||
    text.match(/Expiration:\s*([0-9]{4}-[0-9]{2}-[0-9]{2})/i);

  return m ? m[1] : null;
}

function extractDominantExpiration(text) {
  const matches = [...text.matchAll(/Ø§ÙØ§ÙØªÙØ§Ø¡ Ø§ÙÙØ³ÙØ·Ø±:\s*([0-9]{4}-[0-9]{2}-[0-9]{2})/g)];
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
    return 'ØºÙØ± ÙØªÙÙØ±';
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

function getProtectPriceAfterTp3(trade) {
  const entry = Number(trade.optionEntry || 0);
  if (!entry) return null;

  return entry + (TP3_PROTECT_PROFIT_AMOUNT / (100 * CONTRACT_QTY));
}

function isTradeExpirationPassed(trade) {
  if (!trade.expiration || trade.expiration === 'ØºÙØ± ÙØªÙÙØ±') return false;

  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Riyadh',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(new Date());

  return today > trade.expiration;
}

// =====================
// Gamma Support Ratio Addition
// =====================

function parseSignedNumber(v) {
  if (v === null || v === undefined) return null;
  const n = Number(String(v).replace(/,/g, ''));
  return isNaN(n) ? null : n;
}

function extractGammaLevelPower(text, label) {
  const re = new RegExp(`${label}[^\\n]*\\n\\s*Ø§ÙÙÙØ©:\\s*([+-]?[0-9,]+(?:\\.[0-9]+)?)`, 'i');
  const m = text.match(re);
  return m ? parseSignedNumber(m[1]) : null;
}

function calculateGammaSupportBonus(text, side) {
  const r1 = extractGammaLevelPower(text, 'R1ï¸â£');
  const r2 = extractGammaLevelPower(text, 'R2ï¸â£');
  const r3 = extractGammaLevelPower(text, 'R3ï¸â£');

  const s1 = extractGammaLevelPower(text, 'S1ï¸â£');
  const s2 = extractGammaLevelPower(text, 'S2ï¸â£');
  const s3 = extractGammaLevelPower(text, 'S3ï¸â£');

  if (side === 'CALL') {
    const supports = [s1, s2, s3]
      .filter(x => x !== null && x > 0)
      .map(x => Math.abs(x));

    const resistance = Math.abs(r1 || 0);

    if (!supports.length || !resistance) {
      return { bonus: 0, ratio: 0 };
    }

    const bestSupport = Math.max(...supports);
    const ratio = bestSupport / resistance;

    if (ratio >= 10) return { bonus: 2, ratio };
    if (ratio >= 5) return { bonus: 1, ratio };
    return { bonus: 0, ratio };
  }

  if (side === 'PUT') {
    const resistances = [r1, r2, r3]
      .filter(x => x !== null && x < 0)
      .map(x => Math.abs(x));

    const support = Math.abs(s1 || 0);

    if (!resistances.length || !support) {
      return { bonus: 0, ratio: 0 };
    }

    const bestResistance = Math.max(...resistances);
    const ratio = bestResistance / support;

    if (ratio >= 10) return { bonus: 2, ratio };
    if (ratio >= 5) return { bonus: 1, ratio };
    return { bonus: 0, ratio };
  }

  return { bonus: 0, ratio: 0 };
}

// =====================
// Smart Stop Review
// =====================

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function toIsoOrNull(value) {
  if (!value) return null;
  const d = new Date(Number(value));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function fromDbTime(value) {
  if (!value) return 0;
  const t = new Date(value).getTime();
  return Number.isFinite(t) ? t : 0;
}

function isStockStopBroken(trade, stockPrice) {
  const stop = Number(trade.stop || 0);
  const price = Number(stockPrice || 0);

  if (!stop || !price) return false;
  if (trade.side === 'CALL') return price <= stop;
  if (trade.side === 'PUT') return price >= stop;
  return false;
}

function unwrapReviewResponse(data) {
  if (!data || data.ok !== true) return null;
  return data.result || data.data || data;
}

function reviewSupportsTrade(result, expectedSide) {
  if (!result) return false;

  const side = String(
    result.side || result.bias || result.requestedSide || result.winnerSide || ''
  ).toUpperCase();

  const explicitSupport =
    result.supportsTrade === true ||
    result.supports_trade === true ||
    result.continueTrade === true;

  return explicitSupport && side === String(expectedSide).toUpperCase();
}

async function requestReviewSource({ name, baseUrl, secret, path, symbol, side }) {
  if (!baseUrl || !secret) {
    throw new Error(`${name}_API_CONFIG_MISSING`);
  }

  const url = `${String(baseUrl).replace(/\/+$/, '')}${path}`;
  let lastError = null;

  for (let attempt = 1; attempt <= STOP_REVIEW_REQUEST_ATTEMPTS; attempt++) {
    try {
      const response = await axios.get(url, {
        params: {
          key: secret,
          symbol,
          side
        },
        timeout: STOP_REVIEW_HTTP_TIMEOUT_MS
      });

      const result = unwrapReviewResponse(response.data);
      if (!result) {
        throw new Error(`${name}_INVALID_RESPONSE`);
      }

      return result;
    } catch (err) {
      lastError = err;
      console.error(`${name} STOP REVIEW ATTEMPT ${attempt} ERROR:`, err.response?.data || err.message);

      if (attempt < STOP_REVIEW_REQUEST_ATTEMPTS) {
        await sleep(5000);
      }
    }
  }

  throw lastError || new Error(`${name}_STOP_REVIEW_FAILED`);
}

async function requestFreshStopReviews(trade) {
  const [gammaResult, radarResult] = await Promise.all([
    requestReviewSource({
      name: 'GAMMA',
      baseUrl: GAMMA_API_URL,
      secret: GAMMA_API_SECRET,
      path: '/api/gamma/stop-review',
      symbol: trade.symbol,
      side: trade.side
    }),
    requestReviewSource({
      name: 'RADAR',
      baseUrl: RADAR_API_URL,
      secret: RADAR_API_SECRET,
      path: '/api/radar/stop-review',
      symbol: trade.symbol,
      side: trade.side
    })
  ]);

  return { gammaResult, radarResult };
}

async function sendStopReviewContinuationMessage(trade, optionPrice, stockPrice) {
  const text = `ð¡ ØªØ­Ø¯ÙØ« Ø§ÙØµÙÙØ© â ST Decision

ð Ø§ÙØ³ÙÙ: ${trade.symbol}
ð¯ Ø§ÙØ¹ÙØ¯:
${getContractDisplay(trade)}
${trade.optionTicker}

ðµ Ø¯Ø®ÙÙ Ø§ÙØ¹ÙØ¯: ${fmtPrice(trade.optionEntry)}
ðµ Ø³Ø¹Ø± Ø§ÙØ¹ÙØ¯ Ø§ÙØ­Ø§ÙÙ: ${fmtPrice(optionPrice)}
ð ÙÙÙ Ø§ÙØ¹ÙØ¯: ${fmtPrice(trade.optionStop)}

ð° Ø³Ø¹Ø± Ø§ÙØ³ÙÙ Ø§ÙØ­Ø§ÙÙ: ${fmtPrice(stockPrice)}
ð ÙÙÙ Ø§ÙØ³ÙÙ: ${fmtPrice(trade.stop)}

ÙØµÙ Ø§ÙØ¹ÙØ¯ Ø¥ÙÙ ÙØ³ØªÙÙ Ø§ÙÙÙÙ Ø§ÙØ³Ø¹Ø±ÙØ ÙÙÙ Ø¨Ø¹Ø¯ Ø¥Ø¹Ø§Ø¯Ø© ØªØ­ÙÙÙ Ø§ÙÙØ§ÙØ§ ÙØ§ÙØ³ÙÙÙØ© ØªØ¨ÙÙ Ø£Ù Ø£Ø³Ø¨Ø§Ø¨ Ø§ÙØ¯Ø®ÙÙ ÙØ§ Ø²Ø§ÙØª ÙØ§Ø¦ÙØ©.

â ØªØ³ØªÙØ± ÙØªØ§Ø¨Ø¹Ø© Ø§ÙØµÙÙØ© ÙÙÙÙØ§ ÙÙØ¹Ø·ÙØ§ØªÙØ§ Ø§ÙØ­Ø§ÙÙØ©.

ð¡ Ø³ÙØªÙ ÙØ±Ø§ÙØ¨Ø© Ø§ÙØµÙÙØ© Ø¨Ø´ÙÙ ÙØ­Ø¸ÙØ ÙØ³ÙØªÙ Ø¥Ø±Ø³Ø§Ù Ø£Ù ØªØ­Ø¯ÙØ« Ø£Ù ÙÙÙ ÙÙØ§Ø¦Ù Ø¹ÙØ¯ ØªØºÙØ± Ø§ÙÙØ¹Ø·ÙØ§Øª.

â ï¸ Ø¥Ø°Ø§ ÙÙØª ØªÙØ¶Ù Ø§ÙØ§ÙØªØ²Ø§Ù Ø¨ÙÙÙ Ø§ÙØ¹ÙØ¯ Ø£Ù Ø¥Ø¯Ø§Ø±Ø© ÙØ®Ø§Ø·Ø±ØªÙ Ø¨Ø´ÙÙ Ø£ÙØ«Ø± ØªØ­ÙØ¸ÙØ§Ø ÙÙØ±Ø§Ø± Ø§ÙØ®Ø±ÙØ¬ ÙØ¹ÙØ¯ ÙÙ.

â ï¸ ÙÙØ³Øª ØªÙØµÙØ© Ø´Ø±Ø§Ø¡ Ø£Ù Ø¨ÙØ¹`;

  await sendSignalMessage(text);

  await sendUnifiedPrivateAlert({
    event: 'review_passed',
    symbol: trade.symbol,
    side: trade.side,
    optionTicker: trade.optionTicker,
    contract: `${getContractDisplay(trade)}\n${trade.optionTicker || ''}`,
    text
  });
}

async function finalizeTradeStop(key, trade, optionPrice, closeReason = 'SL') {
  trade.slHit = true;
  trade.stopReviewInProgress = false;
  trade.stopReviewStatus = 'FINAL_STOP';
  trade.nextStopReviewAt = 0;

  activeTrades.delete(key);
  sentSetupKeys.delete(trade.key);

  await closeActiveTradeInDb(key, closeReason, {
    tp1_hit: !!trade.tp1Hit,
    tp2_hit: !!trade.tp2Hit,
    tp3_hit: !!trade.tp3Hit,
    sl_hit: true,
    option_high: trade.optionHigh,
    option_stop_breached: !!trade.optionStopBreached,
    stop_review_status: trade.stopReviewStatus,
    stop_review_continuation_sent: !!trade.stopReviewContinuationSent,
    last_stop_review_at: toIsoOrNull(trade.lastStopReviewAt),
    next_stop_review_at: null,
    stop_review_attempts: Number(trade.stopReviewAttempts || 0),
    stop_review_error: trade.stopReviewError || null,
    gamma_review_result: trade.gammaReviewResult || null,
    radar_review_result: trade.radarReviewResult || null
  });

  await closeTradeHistory(trade, closeReason, optionPrice);
  await sendBetterStopMessage(trade, optionPrice);

  await sendUnifiedPrivateAlert({
    event: 'stop',
    symbol: trade.symbol,
    side: trade.side,
    optionTicker: trade.optionTicker,
    contract: `${getContractDisplay(trade)}\n${trade.optionTicker || ''}`,
    text: `ð ÙÙÙ ÙÙØ§Ø¦Ù ÙÙØµÙÙØ© â ST Decision

ð Ø§ÙØ³ÙÙ: ${trade.symbol}
ð¯ Ø§ÙØ¹ÙØ¯:
${getContractDisplay(trade)}
${trade.optionTicker}

ðµ Ø¯Ø®ÙÙ Ø§ÙØ¹ÙØ¯: ${fmtPrice(trade.optionEntry)}
ðµ Ø³Ø¹Ø± Ø§ÙØ¹ÙØ¯ Ø§ÙØ­Ø§ÙÙ: ${fmtPrice(optionPrice)}
ð ÙÙÙ Ø§ÙØ¹ÙØ¯: ${fmtPrice(trade.optionStop)}

ð ØªÙ ØªØ£ÙÙØ¯ Ø§ÙÙÙÙ Ø§ÙÙÙØ§Ø¦Ù ÙØ¥ÙÙØ§Ù Ø§ÙÙØªØ§Ø¨Ø¹Ø©.`
  });
}

async function handleSmartStopBreach(key, trade, optionPrice, stockPrice) {
  if (trade.stopReviewInProgress) return;

  const nowMs = now();
  const nextReviewAt = Number(trade.nextStopReviewAt || 0);
  if (nextReviewAt && nowMs < nextReviewAt) return;

  trade.optionStopBreached = true;
  trade.stopReviewInProgress = true;
  trade.stopReviewStatus = 'PENDING';
  trade.lastStopReviewAt = nowMs;
  trade.stopReviewAttempts = Number(trade.stopReviewAttempts || 0) + 1;
  trade.stopReviewError = null;

  await saveActiveTradeToDb(trade);

  try {
    if (isStockStopBroken(trade, stockPrice)) {
      trade.stopReviewStatus = 'STOCK_STOP_BROKEN';
      await saveActiveTradeToDb(trade);
      await finalizeTradeStop(key, trade, optionPrice, 'SL_STOCK_STOP');
      return;
    }

    const { gammaResult, radarResult } = await requestFreshStopReviews(trade);

    trade.gammaReviewResult = gammaResult;
    trade.radarReviewResult = radarResult;

    const gammaSupports = reviewSupportsTrade(gammaResult, trade.side);
    const radarSupports = reviewSupportsTrade(radarResult, trade.side);

    if (gammaSupports && radarSupports) {
      trade.stopReviewStatus = 'CONTINUING';
      trade.nextStopReviewAt = now() + STOP_REVIEW_CONTINUE_MS;
      trade.stopReviewError = null;

      if (!trade.stopReviewContinuationSent) {
        trade.stopReviewContinuationSent = true;
        await sendStopReviewContinuationMessage(trade, optionPrice, stockPrice);
      }

      await saveActiveTradeToDb(trade);
      return;
    }

    trade.stopReviewStatus = 'REJECTED';
    await saveActiveTradeToDb(trade);
    await finalizeTradeStop(key, trade, optionPrice, 'SL_REVIEW_REJECTED');
  } catch (err) {
    trade.stopReviewStatus = 'FAILED_RETRY';
    trade.stopReviewError = String(err.response?.data?.error || err.message || err);
    trade.nextStopReviewAt = now() + STOP_REVIEW_RETRY_MS;

    console.error('SMART STOP REVIEW ERROR:', trade.key, trade.stopReviewError);
    await saveActiveTradeToDb(trade);
  } finally {
    trade.stopReviewInProgress = false;
  }
}

async function sendTargetHitMessage(trade, targetName, stockPrice, optionPrice) {
  const isFinal = targetName === 'TP3';

  const entry = Number(trade.optionEntry || 0);
  const current = Number(optionPrice || 0);
  const high = Number(trade.optionHigh || trade.optionEntry || 0);

  const profitAmount = entry && current
    ? (current - entry) * 100 * CONTRACT_QTY
    : 0;

  const maxProfitAmount = entry && high
    ? (high - entry) * 100 * CONTRACT_QTY
    : 0;

  const profitText = profitAmount >= 0
    ? `+$${fmtPrice(profitAmount)}`
    : `-$${fmtPrice(Math.abs(profitAmount))}`;

  const maxProfitText = maxProfitAmount >= 0
    ? `+$${fmtPrice(maxProfitAmount)}`
    : `-$${fmtPrice(Math.abs(maxProfitAmount))}`;

  const profitIcon = profitAmount >= 0 ? 'ð' : 'ð';

  const targetNote = profitAmount > 0
    ? `ð ØªØ­ÙÙ ÙØ¯Ù Ø§ÙØ³ÙÙ ÙØ§ÙØ¹ÙØ¯ Ø­Ø§ÙÙØ§Ù ÙÙÙ Ø§ÙØ¯Ø®ÙÙ.
ØªØ§Ø¨Ø¹ ÙÙÙÙ ÙÙØ§ ØªØ®ÙÙ Ø§ÙØ±Ø¨Ø­ ÙØªØ­ÙÙ Ø®Ø³Ø§Ø±Ø©.`
    : `â ï¸ ØªØ­ÙÙ ÙØ¯Ù Ø§ÙØ³ÙÙØ ÙÙÙ Ø§ÙØ¹ÙØ¯ Ø­Ø§ÙÙØ§Ù Ø£ÙÙ ÙÙ Ø³Ø¹Ø± Ø§ÙØ¯Ø®ÙÙ.
ÙØ§ ØªØ¹ØªØ¨Ø±ÙØ§ Ø±Ø¨Ø­ Ø­ØªÙ ÙØªØ­ÙÙ Ø§ÙØ¹ÙØ¯ ÙÙÙ Ø§ÙØ¯Ø®ÙÙ.`;

  const text = isFinal
    ? `ð¯ð¥ ØªØ­ÙÙ Ø§ÙÙØ¯Ù Ø§ÙØ«Ø§ÙØ« â ST Decision

ð Ø§ÙØ³ÙÙ: ${trade.symbol}

ð¯ Ø§ÙØ¹ÙØ¯:
${getContractDisplay(trade)}
${trade.optionTicker}

â ØªØ­ÙÙ: ${targetName}

ð° Ø³Ø¹Ø± Ø§ÙØ³ÙÙ Ø§ÙØ­Ø§ÙÙ: ${fmtPrice(stockPrice)}

ðµ Ø³Ø¹Ø± Ø§ÙØ¹ÙØ¯ Ø§ÙØ­Ø§ÙÙ: ${fmtPrice(optionPrice)}
ðµ Ø¯Ø®ÙÙ Ø§ÙØ¹ÙØ¯: ${fmtPrice(trade.optionEntry)}

${profitIcon} ÙØªÙØ¬Ø© Ø§ÙØ¹ÙØ¯ Ø§ÙØ­Ø§ÙÙØ©:
${profitText}

ð¥ Ø£Ø¹ÙÙ Ø±Ø¨Ø­ ÙØµÙ ÙÙ Ø§ÙØ¹ÙØ¯:
${maxProfitText}

ââââââââââââââ

ð ØªÙ ØªØ­ÙÙÙ Ø§ÙÙØ¯Ù Ø§ÙØ«Ø§ÙØ« Ø¨ÙØ¬Ø§Ø­.

ð Ø³ÙØªÙ Ø§Ø³ØªÙØ±Ø§Ø± ÙØªØ§Ø¨Ø¹Ø© Ø§ÙØ¹ÙØ¯ ÙÙÙØ³ØªÙØ±ÙÙ.

ð Ø³ÙØªÙ Ø¥Ø±Ø³Ø§Ù ØªØ­Ø¯ÙØ«Ø§Øª Ø¬Ø¯ÙØ¯Ø© Ø¹ÙØ¯ ØªØ³Ø¬ÙÙ ÙÙÙ Ø¬Ø¯ÙØ¯Ø© ÙÙØ¹ÙØ¯.

â ï¸ ÙÙØ³Øª ØªÙØµÙØ© Ø´Ø±Ø§Ø¡ Ø£Ù Ø¨ÙØ¹`
    : `ð¯ ØªØ­ÙÙ ÙØ¯Ù Ø§ÙØ³ÙÙ ${targetName} â ST Decision

ð Ø§ÙØ³ÙÙ: ${trade.symbol}
ð¯ Ø§ÙØ¹ÙØ¯:
${getContractDisplay(trade)}
${trade.optionTicker}

ð° Ø³Ø¹Ø± Ø§ÙØ³ÙÙ Ø§ÙØ­Ø§ÙÙ: ${fmtPrice(stockPrice)}
ðµ Ø³Ø¹Ø± Ø§ÙØ¹ÙØ¯ Ø§ÙØ­Ø§ÙÙ: ${fmtPrice(optionPrice)}
ðµ Ø¯Ø®ÙÙ Ø§ÙØ¹ÙØ¯: ${fmtPrice(trade.optionEntry)}
${profitIcon} ÙØªÙØ¬Ø© Ø§ÙØ¹ÙØ¯ Ø§ÙØ­Ø§ÙÙØ©: ${profitText}
ð¥ Ø£Ø¹ÙÙ Ø±Ø¨Ø­ ÙØµÙ ÙÙ Ø§ÙØ¹ÙØ¯: ${maxProfitText}

${targetNote}

â ï¸ ÙÙØ³Øª ØªÙØµÙØ© Ø´Ø±Ø§Ø¡ Ø£Ù Ø¨ÙØ¹`;

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
    await sendSignalMessage(`ð¡ ØªÙØ¨ÙÙ ÙÙÙØ³ØªÙØ±ÙÙ â ST Decision

ð Ø§ÙØ³ÙÙ: ${trade.symbol}
ð¯ Ø§ÙØ¹ÙØ¯:
${getContractDisplay(trade)}
${trade.optionTicker}

ðµ Ø¯Ø®ÙÙ Ø§ÙØ¹ÙØ¯: ${fmtPrice(entry)}
ð Ø£Ø¹ÙÙ Ø³Ø¹Ø± ÙØµÙ ÙÙ Ø§ÙØ¹ÙØ¯: ${fmtPrice(high)}
ð¥ Ø£Ø¹ÙÙ Ø±Ø¨Ø­ ØªØ­ÙÙ: +$${fmtPrice(maxProfitAmount)}
ð Ø£Ø¹ÙÙ ÙØ³Ø¨Ø© Ø±Ø¨Ø­: +${fmtPrice(maxProfitPct)}%

ðµ Ø³Ø¹Ø± Ø§ÙØ¹ÙØ¯ Ø§ÙØ­Ø§ÙÙ: ${fmtPrice(current)}
ð ÙÙÙ Ø§ÙØ¹ÙØ¯: ${fmtPrice(trade.optionStop)}

ð Ø§ÙØ¹ÙØ¯ Ø¹Ø§Ø¯ Ø§ÙØ¢Ù ØªØ­Øª Ø§ÙÙÙÙ ÙØªÙ Ø¥ÙÙØ§Ù Ø§ÙÙØªØ§Ø¨Ø¹Ø©.
â Ø§ÙØµÙÙØ© Ø­ÙÙØª Ø±Ø¨Ø­ ÙØ¨Ù Ø§ÙØ±Ø¬ÙØ¹Ø ÙÙÙØ³Øª ØµÙÙØ© ÙØ§Ø´ÙØ©.

â ï¸ ÙÙØ³Øª ØªÙØµÙØ© Ø´Ø±Ø§Ø¡ Ø£Ù Ø¨ÙØ¹`);
    return;
  }

  await sendSignalMessage(`ð Ø¶Ø±Ø¨ ÙÙÙ Ø§ÙØ¹ÙØ¯ â ST Decision

ð Ø§ÙØ³ÙÙ: ${trade.symbol}
ð¯ Ø§ÙØ¹ÙØ¯:
${getContractDisplay(trade)}
${trade.optionTicker}

ðµ Ø¯Ø®ÙÙ Ø§ÙØ¹ÙØ¯: ${fmtPrice(entry)}
ðµ Ø³Ø¹Ø± Ø§ÙØ¹ÙØ¯ Ø§ÙØ­Ø§ÙÙ: ${fmtPrice(current)}
ð ÙÙÙ Ø§ÙØ¹ÙØ¯: ${fmtPrice(trade.optionStop)}

ð ØªÙ Ø¥ÙÙØ§Ù Ø§ÙÙØªØ§Ø¨Ø¹Ø©.`);
}

async function getFinnhubPrice(symbol) {
  if (!FINNHUB_API_KEY) {
    throw new Error('Missing FINNHUB_API_KEY');
  }

  const url =
    `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(symbol)}&token=${FINNHUB_API_KEY}`;

  const res = await axios.get(url, { timeout: 18000 });
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

  const res = await axios.get(url, { timeout:30000 });
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

async function findAlternativeOptionContract(symbol, expiration, side, currentPrice, oldStrike) {
  const newPreferredStrike = getStrikeFromEntry(currentPrice, side);

  if (!newPreferredStrike) return null;

  const alternative = await findBestOptionContract(
    symbol,
    expiration,
    side,
    newPreferredStrike
  );

  if (!alternative) return null;

  return {
    ...alternative,
    oldStrike,
    newPreferredStrike,
    strikeChanged: Number(alternative.strike) !== Number(oldStrike)
  };
}

function parseGex(text) {
  const symbol = getSymbolFromText(text);
  if (!symbol) return null;

  const side = extractBiasFromGex(text);
  const score = extractScore(text);

  const gammaSupport = calculateGammaSupportBonus(text, side);
  const decisionScore = Math.min(10, score + gammaSupport.bonus);

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
    decisionScore,
    gammaSupportBonus: gammaSupport.bonus,
    gammaSupportRatio: gammaSupport.ratio,
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
    text.includes('Ø§ÙÙØ´ØªØ±ÙÙ') ||
    text.includes('Ask Flow');

  const sellers =
    text.includes('Ø§ÙØ¨Ø§Ø¦Ø¹ÙÙ') ||
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
      reason: 'Ø§ÙØ¨ÙØ§ÙØ§Øª ØºÙØ± ÙØªØ²Ø§ÙÙØ©'
    };
  }

  if (!['CALL', 'PUT'].includes(gex.side)) {
    return {
      ok: false,
      reason: 'Ø§ÙÙØ§ÙØ§ ÙØ§ ÙØ¹Ø·Ù Ø§ØªØ¬Ø§Ù ÙØ§Ø¶Ø­'
    };
  }

  if (!['CALL', 'PUT'].includes(radar.side)) {
    return {
      ok: false,
      reason: 'Ø§ÙØ±Ø§Ø¯Ø§Ø± ÙØ§ ÙØ¹Ø·Ù Ø§ØªØ¬Ø§Ù ÙØ§Ø¶Ø­ Ø£Ù Ø®ÙØ§ØµØ© Ø§ÙØ±Ø§Ø¯Ø§Ø± ØªÙÙÙ Ø§ÙØªØ¸Ø±'
    };
  }

  if (gex.symbol !== radar.symbol) {
    return {
      ok: false,
      reason: `Ø§ÙØ´Ø±ÙØ© ÙØ®ØªÙÙØ©: GEX=${gex.symbol}, RADAR=${radar.symbol}`
    };
  }

  if (gex.side !== radar.side) {
    return {
      ok: false,
      reason: `ØªØ¹Ø§Ø±Ø¶ Ø§ÙØ§ØªØ¬Ø§Ù: GEX=${gex.side}, RADAR=${radar.side}`
    };
  }

  if ((gex.decisionScore || gex.score) < MIN_SCORE) {
    return {
      ok: false,
      reason: `Score Ø¶Ø¹ÙÙ: ${gex.decisionScore || gex.score}/10`
    };
  }

  if (!gex.entry && !gex.readyText) {
    return {
      ok: false,
      reason: 'ÙØ§ ÙÙØ¬Ø¯ ÙØ³ØªÙÙ Ø¯Ø®ÙÙ ÙØ§Ø¶Ø­ ÙÙØ§ Ø¥Ø´Ø§Ø±Ø© Ø¬Ø§ÙØ²Ø©'
    };
  }

  if (!gex.stop && gex.entry) {
    gex.stop = buildAutoStop(gex.entry, gex.side);
    gex.autoStop = true;
  }

  if (!gex.stop) {
    return {
      ok: false,
      reason: 'ÙØ§ ÙÙØ¬Ø¯ ÙÙÙ ÙÙØ§ ÙÙÙÙ Ø­Ø³Ø§Ø¨ ÙÙÙ ØªÙÙØ§Ø¦Ù'
    };
  }

  if (!gex.strike && gex.entry) {
    gex.strike = getStrikeFromEntry(gex.entry, gex.side);
  }

  if (!gex.strike && !gex.entry && !gex.readyText) {
    return {
      ok: false,
      reason: 'ÙØ§ ÙÙØ¬Ø¯ Ø³ØªØ±Ø§ÙÙ Ø£Ù Ø¯Ø®ÙÙ ÙØ§Ø¶Ø­'
    };
  }

  return {
    ok: true,
    reason: 'ØªÙØ§ÙÙ ÙØ§ÙÙ'
  };
}
async function notifyAdminReject(symbol, reason) {
  if (!ADMIN_CHAT_ID) return;

  bot.sendMessage(
    ADMIN_CHAT_ID,
    `â ï¸ Ø±ÙØ¶ ÙØ±Ø§Ø± â ${symbol}\nØ§ÙØ³Ø¨Ø¨: ${reason}`
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
      `Ø®Ø§Ø±Ø¬ ÙÙØª Ø§ÙØµÙÙØ§Øª Ø§ÙÙØ³ÙÙØ­: ${tradingTimeText()}`
    );
    return;
  }

  const decision = canCreateDecision(gex, radar);

  if (!decision.ok) {
    console.log(`NO DECISION ${symbol}:`, decision.reason);
    await notifyAdminReject(symbol, decision.reason);
    return;
  }

  const expiration = radar.suggestedExpiration || 'ØºÙØ± ÙØªÙÙØ±';

  if (expiration === 'ØºÙØ± ÙØªÙÙØ±') {
    const reason = 'ÙØ§ ÙÙØ¬Ø¯ Ø§ÙØªÙØ§Ø¡ ÙÙØªØ±Ø­ ÙÙ Ø§ÙØ±Ø§Ø¯Ø§Ø±';
    console.log(`NO DECISION ${symbol}: ${reason}`);
    await notifyAdminReject(symbol, reason);
    return;
  }

  let currentPrice = null;

  try {
    currentPrice = await getFinnhubPrice(symbol);
  } catch (err) {
    console.error('FINNHUB PRICE ERROR:', symbol, err.message);
    await notifyAdminReject(symbol, `Ø®Ø·Ø£ Ø³Ø¹Ø± Finnhub: ${err.message}`);
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
    const reason = 'ÙØ§ ÙÙØ¬Ø¯ Ø¯Ø®ÙÙ Ø£Ù Ø³ØªØ±Ø§ÙÙ Ø¨Ø¹Ø¯ ÙØ­Øµ Ø§ÙØ³Ø¹Ø±';
    console.log(`NO DECISION ${symbol}: ${reason}`);
    await notifyAdminReject(symbol, reason);
    return;
  }

  const distancePct = Math.abs(currentPrice - gex.entry) / currentPrice * 100;

  if (distancePct > MAX_ENTRY_DISTANCE_PCT) {
    const reason =
      `Ø§ÙØ¯Ø®ÙÙ Ø¨Ø¹ÙØ¯ Ø¹Ù Ø§ÙØ³Ø¹Ø± Ø§ÙØ­Ø§ÙÙ: ${distancePct.toFixed(2)}% ` +
      `(Ø§ÙØ­Ø¯ ${MAX_ENTRY_DISTANCE_PCT}%)`;

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
      `ÙØ§ ÙÙØ¬Ø¯ Ø¹ÙØ¯ Ø¯Ø§Ø®Ù Ø§ÙÙØ·Ø§Ù ${MIN_CONTRACT_PRICE} - ${MAX_CONTRACT_PRICE}. ` +
      `Ø§ÙØ³Ø¹Ø± Ø§ÙÙØªÙÙØ±: ${fmtPrice(optionData?.mid)}`;

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

    optionStopBreached: false,
    stopReviewInProgress: false,
    stopReviewStatus: 'NONE',
    stopReviewContinuationSent: false,
    lastStopReviewAt: 0,
    nextStopReviewAt: 0,
    stopReviewAttempts: 0,
    stopReviewError: null,
    gammaReviewResult: null,
    radarReviewResult: null,

    score: gex.decisionScore || gex.score,
    baseScore: gex.score,
    gammaSupportBonus: gex.gammaSupportBonus || 0,
    gammaSupportRatio: gex.gammaSupportRatio || 0,

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
  const sideEmoji = setup.side === 'CALL' ? 'ð¢' : 'ð´';
  const sideArabic = setup.side === 'CALL' ? 'ÙÙÙ' : 'Ø¨ÙØª';

  const contractText = getContractDisplay(setup);

  const activationText =
    setup.side === 'CALL'
      ? `Ø§Ø®ØªØ±Ø§Ù ${setup.entry} ÙØ§ÙØ«Ø¨Ø§Øª ÙÙÙÙ`
      : `ÙØ³Ø± ${setup.entry} ÙØ§ÙØ«Ø¨Ø§Øª ØªØ­ØªÙ`;

  const stopNote = setup.autoStop
    ? 'ÙÙÙ ØªÙÙØ§Ø¦Ù ÙØ­Ø³ÙØ¨ ÙØ£Ù Ø±Ø³Ø§ÙØ© Ø§ÙÙØ§ÙØ§ ÙØ§ ØªØ­ØªÙÙ ÙÙÙ ÙØ§Ø¶Ø­'
    : 'ÙÙÙ ÙÙ Ø±Ø³Ø§ÙØ© Ø§ÙÙØ§ÙØ§';

  const text = `ð¨ ØµÙÙØ© ÙØ±Ø§ÙØ¨Ø© â ST Decision

ð Ø§ÙØ³ÙÙ: ${setup.symbol}
${sideEmoji} Ø§ÙÙÙØ¹: ${sideArabic}
ð Ø§ÙØ§ÙØªÙØ§Ø¡: ${setup.expiration}

ð¯ Ø§ÙØ¹ÙØ¯ Ø§ÙÙØ®ØªØ§Ø±:
${contractText}
${setup.optionTicker}

ð° Ø³Ø¹Ø± Ø§ÙØ³ÙÙ Ø§ÙØ­Ø§ÙÙ: ${fmtPrice(setup.currentPrice)}

${setup.autoStop
  ? `ðµ Ø³Ø¹Ø± Ø§ÙØ¹ÙØ¯ ÙÙØª Ø§ÙØ§Ø®ØªÙØ§Ø±: ${fmtPrice(setup.optionEntry)}
ð ÙÙÙ Ø§Ø­ØªÙØ§Ø·Ù ÙÙØ¹ÙØ¯ Ø§Ø°Ø§ ÙÙ ÙÙÙ ÙÙØ§Ù ÙÙÙ ÙØ§ÙØ§: ${fmtPrice(setup.optionStop)}`
  : `ðµ Ø³Ø¹Ø± Ø§ÙØ¹ÙØ¯ ÙÙØª Ø§ÙØ§Ø®ØªÙØ§Ø±: ${fmtPrice(setup.optionEntry)}`}

ð Ø§ÙØªÙØ¹ÙÙ:
${activationText}

ð¯ Ø£ÙØ¯Ø§Ù Ø§ÙØ³ÙÙ:
TP1: ${setup.tp1 || 'ØºÙØ± ÙØªÙÙØ±'}
TP2: ${setup.tp2 || 'ØºÙØ± ÙØªÙÙØ±'}
TP3: ${setup.tp3 || 'ØºÙØ± ÙØªÙÙØ±'}

ð ÙÙÙ Ø§ÙØ³ÙÙ:
${fmtPrice(setup.stop)}
ð ÙÙØ¹ Ø§ÙÙÙÙ: ${stopNote}

ââââââââââââââ
ð Ø¨ÙØ§ÙØ§Øª Ø§ÙØ¹ÙØ¯

Bid: ${fmtPrice(setup.optionBid)}
Ask: ${fmtPrice(setup.optionAsk)}
Last: ${fmtPrice(setup.optionLast)}
OI: ${fmtNum(setup.optionOi)}
Volume: ${fmtNum(setup.optionVolume)}
Delta: ${setup.optionDelta ?? 'ØºÙØ± ÙØªÙÙØ±'}
Gamma: ${setup.optionGamma ?? 'ØºÙØ± ÙØªÙÙØ±'}

ââââââââââââââ
ð Ø³Ø¨Ø¨ Ø§ÙØµÙÙØ©

â GEX: ${setup.side} BIAS
â Score Ø§ÙÙØ§ÙØ§: ${setup.baseScore} / 10
â Ø¯Ø¹Ù Ø§ÙØ¬Ø§ÙØ§ Ø£Ø¶Ø§Ù: +${setup.gammaSupportBonus}
â Score Ø§ÙÙØ±Ø§Ø±: ${setup.score} / 10
â Radar: ${radar.side}
â Ø§ÙØªÙØ§Ø¡ ÙÙØªØ±Ø­/ÙØ³ÙØ·Ø±: ${setup.expiration}

â³ Ø§ÙØ­Ø§ÙØ©:
ÙØ±Ø§ÙØ¨Ø© ÙÙØ· â ÙÙ ØªØªÙØ¹Ù Ø¨Ø¹Ø¯

â ï¸ ÙÙØ³Øª ØªÙØµÙØ© Ø´Ø±Ø§Ø¡ Ø£Ù Ø¨ÙØ¹`;

  await sendSignalMessage(text);
}

async function sendActivatedMessage(setup, price) {
  if (!isDecisionTradingTime()) {
    console.log(`ACTIVATION OUTSIDE TRADING TIME - BLOCKED: ${setup.symbol}`);
    activeSetups.delete(setup.key);
    sentSetupKeys.delete(setup.key);

    await notifyAdminReject(
      setup.symbol,
      `ØªÙ ÙÙØ¹ Ø§ÙØªÙØ¹ÙÙ Ø®Ø§Ø±Ø¬ ÙÙØª Ø§ÙØµÙÙØ§Øª Ø§ÙÙØ³ÙÙØ­: ${tradingTimeText()}`
    );

    return;
  }

  const sideEmoji = setup.side === 'CALL' ? 'ð¢' : 'ð´';
  const sideArabic = setup.side === 'CALL' ? 'ÙÙÙ' : 'Ø¨ÙØª';

  let optionData = null;

  try {
    if (setup.optionTicker) {
      const snap = await getMassiveOptionSnapshot(setup.symbol, setup.optionTicker);
      optionData = getOptionMid(snap);
    }
  } catch (err) {
    console.error('ACTIVATION OPTION ERROR:', err.message);
  }

  let optionEntry = optionData?.mid || setup.optionEntry || null;
  let strikeChanged = false;
  let oldContractText = getContractDisplay(setup);
  let oldOptionTicker = setup.optionTicker;
  let oldOptionPrice = optionEntry;

  if (
    !optionEntry ||
    optionEntry < MIN_CONTRACT_PRICE ||
    optionEntry > MAX_CONTRACT_PRICE
  ) {
    let alternative = null;

    try {
      alternative = await findAlternativeOptionContract(
        setup.symbol,
        setup.expiration,
        setup.side,
        price,
        setup.strike
      );
    } catch (err) {
      console.error('ALTERNATIVE OPTION ERROR:', err.message);
    }

    if (
      alternative &&
      alternative.mid &&
      alternative.mid >= MIN_CONTRACT_PRICE &&
      alternative.mid <= MAX_CONTRACT_PRICE
    ) {
      strikeChanged = alternative.strikeChanged;

      setup.strike = alternative.strike;
      setup.optionTicker = alternative.optionTicker;
      setup.optionEntry = alternative.mid;
      setup.optionBid = alternative.bid;
      setup.optionAsk = alternative.ask;
      setup.optionLast = alternative.last;
      setup.optionVolume = alternative.volume;
      setup.optionOi = alternative.oi;
      setup.optionDelta = alternative.delta;
      setup.optionGamma = alternative.gamma;

      optionData = alternative;
      optionEntry = alternative.mid;
    } else {
      activeSetups.delete(setup.key);
      activeTrades.delete(setup.key);
      sentSetupKeys.delete(setup.key);

      await closeActiveTradeInDb(setup.key, 'CANCELLED_PRICE_RANGE');

      await sendSignalMessage(`â ØªÙ Ø¥ÙØºØ§Ø¡ ØªÙØ¹ÙÙ Ø§ÙØµÙÙØ© â ST Decision

ð Ø§ÙØ³ÙÙ: ${setup.symbol}
Ø§ÙÙÙØ¹: ${sideArabic}
ð Ø§ÙØ§ÙØªÙØ§Ø¡: ${setup.expiration}

ð¯ Ø§ÙØ¹ÙØ¯:
${oldContractText}
${oldOptionTicker || 'ØºÙØ± ÙØªÙÙØ±'}

ðµ Ø³Ø¹Ø± Ø§ÙØ¹ÙØ¯ Ø§ÙØ­Ø§ÙÙ: ${fmtPrice(oldOptionPrice)}

ð Ø§ÙØ³Ø¨Ø¨:
Ø³Ø¹Ø± Ø§ÙØ¹ÙØ¯ Ø®Ø±Ø¬ Ø¹Ù Ø§ÙÙØ·Ø§Ù Ø§ÙÙØ·ÙÙØ¨ ${MIN_CONTRACT_PRICE} - ${MAX_CONTRACT_PRICE}
ÙÙÙ ÙØªÙ Ø§ÙØ¹Ø«ÙØ± Ø¹ÙÙ Ø¹ÙØ¯ Ø¨Ø¯ÙÙ ÙÙØ§Ø³Ø¨ Ø¯Ø§Ø®Ù Ø§ÙÙØ·Ø§Ù.

â ï¸ ÙÙØ³Øª ØªÙØµÙØ© Ø´Ø±Ø§Ø¡ Ø£Ù Ø¨ÙØ¹`);

      return;
    }
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

  const stopNote = setup.autoStop ? 'ÙÙÙ ØªÙÙØ§Ø¦Ù ÙØ­Ø³ÙØ¨' : 'ÙÙÙ ÙÙ Ø±Ø³Ø§ÙØ© Ø§ÙÙØ§ÙØ§';

  const strikeChangedNote = strikeChanged
    ? `

â ï¸ ØªÙØ¨ÙÙ ÙÙÙ

ØªÙ ØªØºÙÙØ± Ø§ÙØ¹ÙØ¯ Ø£Ø«ÙØ§Ø¡ Ø§ÙØªÙØ¹ÙÙ ÙØ£Ù Ø§ÙØ¹ÙØ¯ Ø§ÙØ£ØµÙÙ ØªØ¬Ø§ÙØ² Ø§ÙØ­Ø¯ Ø§ÙØ³Ø¹Ø±Ù Ø§ÙÙØ³ÙÙØ­.

Ø§ÙØ¹ÙØ¯ Ø§ÙØ£ØµÙÙ:
${oldContractText}
${oldOptionTicker || 'ØºÙØ± ÙØªÙÙØ±'}
Ø³Ø¹Ø±Ù ÙÙØª Ø§ÙØªÙØ¹ÙÙ: ${fmtPrice(oldOptionPrice)}

Ø§ÙØ¹ÙØ¯ Ø§ÙØ­Ø§ÙÙ:
${getContractDisplay(setup)}
${setup.optionTicker || 'ØºÙØ± ÙØªÙÙØ±'}

â ØªÙ Ø§Ø¹ØªÙØ§Ø¯ Ø§ÙØ¹ÙØ¯ Ø§ÙØ­Ø§ÙÙ ÙÙÙØªØ§Ø¨Ø¹Ø©.

ââââââââââââââ`
    : '';

  const text = `â ØªÙ ØªÙØ¹ÙÙ Ø§ÙØµÙÙØ© â ST Decision
${strikeChangedNote}

ð Ø§ÙØ³ÙÙ: ${setup.symbol}
${sideEmoji} Ø§ÙÙÙØ¹: ${sideArabic}
ð Ø§ÙØ§ÙØªÙØ§Ø¡: ${setup.expiration}

ð¯ Ø§ÙØ¹ÙØ¯:
${getContractDisplay(setup)}
${setup.optionTicker || 'ØºÙØ± ÙØªÙÙØ±'}

ð° Ø³Ø¹Ø± Ø§ÙØ³ÙÙ Ø§ÙØ­Ø§ÙÙ: ${fmtPrice(price)}
ð ÙØ³ØªÙÙ Ø§ÙØ¯Ø®ÙÙ: ${fmtPrice(setup.entry)}

ðµ Ø¯Ø®ÙÙ Ø§ÙØ¹ÙØ¯: ${fmtPrice(optionEntry)}
ð ÙÙÙ Ø§ÙØ¹ÙØ¯: ${fmtPrice(optionStop)}
ð ÙÙÙ Ø§ÙØ³ÙÙ: ${fmtPrice(setup.stop)}
ð ÙÙØ¹ Ø§ÙÙÙÙ: ${stopNote}

ð¯ Ø£ÙØ¯Ø§Ù Ø§ÙØ³ÙÙ:
TP1: ${setup.tp1 || 'ØºÙØ± ÙØªÙÙØ±'}
TP2: ${setup.tp2 || 'ØºÙØ± ÙØªÙÙØ±'}
TP3: ${setup.tp3 || 'ØºÙØ± ÙØªÙÙØ±'}

ð¦ OI: ${fmtNum(setup.optionOi)}
ð Volume: ${fmtNum(setup.optionVolume)}

ð Ø³ÙØªÙ Ø¥Ø±Ø³Ø§Ù ØªØ­Ø¯ÙØ« ÙÙÙØ§ Ø§Ø±ØªÙØ¹ Ø§ÙØ¹ÙØ¯ +${CONTRACT_UPDATE_STEP.toFixed(2)}

â ï¸ ÙÙØ³Øª ØªÙØµÙØ© Ø´Ø±Ø§Ø¡ Ø£Ù Ø¨ÙØ¹`;

  await sendSignalMessage(text);

await sendUnifiedPrivateAlert({
  event: 'activation',
  symbol: setup.symbol,
  side: setup.side,
  optionTicker: setup.optionTicker,
  contract: `${getContractDisplay(setup)} ${setup.optionTicker || ''}`,
  text
});
  
}
async function sendCancelledMessage(setup, price, reason) {
  const text = `â ØªÙ Ø¥ÙØºØ§Ø¡ ØµÙÙØ© Ø§ÙÙØ±Ø§ÙØ¨Ø© â ST Decision

ð Ø§ÙØ³ÙÙ: ${setup.symbol}
Ø§ÙÙÙØ¹: ${setup.side}
ð° Ø§ÙØ³Ø¹Ø± Ø§ÙØ­Ø§ÙÙ: ${fmtPrice(price)}

ð¯ Ø§ÙØ¹ÙØ¯:
${getContractDisplay(setup)}
${setup.optionTicker || 'ØºÙØ± ÙØªÙÙØ±'}

ð Ø§ÙØ³Ø¨Ø¨:
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

        option_stop_breached: !!trade.optionStopBreached,
        stop_review_status: trade.stopReviewStatus || 'NONE',
        stop_review_continuation_sent: !!trade.stopReviewContinuationSent,
        last_stop_review_at: toIsoOrNull(trade.lastStopReviewAt),
        next_stop_review_at: toIsoOrNull(trade.nextStopReviewAt),
        stop_review_attempts: Number(trade.stopReviewAttempts || 0),
        stop_review_error: trade.stopReviewError || null,
        gamma_review_result: trade.gammaReviewResult || null,
        radar_review_result: trade.radarReviewResult || null,

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
        status: reason === 'EXPIRED' || reason === 'EXPIRED_AFTER_TP3' ? 'EXPIRED' : 'CLOSED',
        close_reason: reason,
        closed_at: new Date().toISOString(),
        expired_at: reason === 'EXPIRED' || reason === 'EXPIRED_AFTER_TP3' ? new Date().toISOString() : null,
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

        optionStopBreached: !!row.option_stop_breached,
        stopReviewInProgress: false,
        stopReviewStatus: row.stop_review_status || 'NONE',
        stopReviewContinuationSent: !!row.stop_review_continuation_sent,
        lastStopReviewAt: fromDbTime(row.last_stop_review_at),
        nextStopReviewAt: fromDbTime(row.next_stop_review_at),
        stopReviewAttempts: Number(row.stop_review_attempts || 0),
        stopReviewError: row.stop_review_error || null,
        gammaReviewResult: row.gamma_review_result || null,
        radarReviewResult: row.radar_review_result || null,

        activatedAt: row.activated_at ? new Date(row.activated_at).getTime() : now(),
        createdAt: row.created_at ? new Date(row.created_at).getTime() : now()
      };

      // Ø­ÙØ§ÙØ© ÙÙØµÙÙØ§Øª Ø§ÙÙØ¯ÙÙØ©: Ø¥Ø°Ø§ ÙÙ ÙÙÙ ÙÙØ§Ù ÙÙÙ Ø³ÙÙ ÙØ­ÙÙØ¸Ø
      // ÙØªÙ Ø¥ÙØ´Ø§Ø¡ ÙÙÙ ØªÙÙØ§Ø¦Ù ÙÙ ÙØ³ØªÙÙ Ø§ÙØ¯Ø®ÙÙ ÙØ­ÙØ¸Ù ÙÙ Supabase.
      if (!trade.stop && trade.entry && ['CALL', 'PUT'].includes(trade.side)) {
        trade.stop = buildAutoStop(trade.entry, trade.side);
        trade.autoStop = true;

        console.log(
          `AUTO STOCK STOP RESTORED: ${trade.symbol} ${trade.side} -> ${fmtPrice(trade.stop)}`
        );

        await saveActiveTradeToDb(trade);
      }

      trade.tradeUid = buildTradeUid(trade);

      if (['PENDING', 'FAILED_RETRY'].includes(trade.stopReviewStatus)) {
        trade.stopReviewInProgress = false;
        trade.nextStopReviewAt = 0;
      }

      activeTrades.set(trade.key, trade);
      sentSetupKeys.add(trade.key);
    }

    console.log(`â LOADED ACTIVE TRADES FROM DB: ${activeTrades.size}`);
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
    closeReason === 'TP3_PROTECT_20' ||
    closeReason === 'EXPIRED_AFTER_TP3' ||
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
          'Ø§ÙØªÙØª ÙØ¯Ø© Ø§ÙÙØ±Ø§ÙØ¨Ø© Ø¨Ø¯ÙÙ ØªÙØ¹ÙÙ'
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
        await saveActiveTradeToDb(trade);
        await updateTradeHigh(trade);
      }

      if (trade.tp3Hit) {
        const protectPrice = getProtectPriceAfterTp3(trade);

        if (isTradeExpirationPassed(trade)) {
          activeTrades.delete(key);
          sentSetupKeys.delete(trade.key);

          await closeActiveTradeInDb(key, 'EXPIRED_AFTER_TP3', {
            tp1_hit: !!trade.tp1Hit,
            tp2_hit: !!trade.tp2Hit,
            tp3_hit: true,
            sl_hit: false,
            option_high: trade.optionHigh
          });

          await closeTradeHistory(trade, 'EXPIRED_AFTER_TP3', optionPrice);

          await sendSignalMessage(`ð Ø§ÙØªÙØ§Ø¡ ÙØªØ§Ø¨Ø¹Ø© Ø§ÙØµÙÙØ© â ST Decision

ð Ø§ÙØ³ÙÙ: ${trade.symbol}

ð¯ Ø§ÙØ¹ÙØ¯:
${getContractDisplay(trade)}
${trade.optionTicker}

â ØªÙ ØªØ­ÙÙÙ Ø§ÙÙØ¯Ù Ø§ÙØ«Ø§ÙØ« Ø³Ø§Ø¨ÙØ§Ù

ðµ Ø¯Ø®ÙÙ Ø§ÙØ¹ÙØ¯: ${fmtPrice(trade.optionEntry)}
ðµ Ø¢Ø®Ø± Ø³Ø¹Ø± ÙÙØ¹ÙØ¯: ${fmtPrice(optionPrice)}

ð¥ Ø£Ø¹ÙÙ Ø³Ø¹Ø± ÙØµÙ ÙÙ Ø§ÙØ¹ÙØ¯: ${fmtPrice(trade.optionHigh)}
ð¥ Ø£Ø¹ÙÙ Ø±Ø¨Ø­ ØªØ­ÙÙ: +$${fmtPrice((Number(trade.optionHigh || 0) - Number(trade.optionEntry || 0)) * 100 * CONTRACT_QTY)}

ð ØªÙ Ø¥ØºÙØ§Ù Ø§ÙÙØªØ§Ø¨Ø¹Ø© Ø¨Ø³Ø¨Ø¨ Ø§ÙØªÙØ§Ø¡ ØªØ§Ø±ÙØ® Ø§ÙØ¹ÙØ¯.

â ï¸ ÙÙØ³Øª ØªÙØµÙØ© Ø´Ø±Ø§Ø¡ Ø£Ù Ø¨ÙØ¹`);

          continue;
        }

        if (protectPrice && optionPrice <= protectPrice) {
          activeTrades.delete(key);
          sentSetupKeys.delete(trade.key);

          await closeActiveTradeInDb(key, 'TP3_PROTECT_20', {
            tp1_hit: !!trade.tp1Hit,
            tp2_hit: !!trade.tp2Hit,
            tp3_hit: true,
            sl_hit: false,
            option_high: trade.optionHigh
          });

          await closeTradeHistory(trade, 'TP3_PROTECT_20', optionPrice);

          await sendSignalMessage(`ð¡ ØªÙØ¨ÙÙ ÙÙÙØ³ØªÙØ±ÙÙ â ST Decision

ð Ø§ÙØ³ÙÙ: ${trade.symbol}

ð¯ Ø§ÙØ¹ÙØ¯:
${getContractDisplay(trade)}
${trade.optionTicker}

ðµ Ø¯Ø®ÙÙ Ø§ÙØ¹ÙØ¯: ${fmtPrice(trade.optionEntry)}
ðµ Ø§ÙØ³Ø¹Ø± Ø§ÙØ­Ø§ÙÙ: ${fmtPrice(optionPrice)}

ð¥ Ø£Ø¹ÙÙ Ø³Ø¹Ø± ÙØµÙ ÙÙ Ø§ÙØ¹ÙØ¯: ${fmtPrice(trade.optionHigh)}
ð¥ Ø£Ø¹ÙÙ Ø±Ø¨Ø­ ØªØ­ÙÙ: +$${fmtPrice((Number(trade.optionHigh || 0) - Number(trade.optionEntry || 0)) * 100 * CONTRACT_QTY)}

ð Ø¹Ø§Ø¯ Ø§ÙØ¹ÙØ¯ ÙÙÙØ·ÙØ© Ø§ÙØ­ÙØ§ÙØ© Ø§ÙÙØ­Ø¯Ø¯Ø©.

â Ø£ÙØµØ­ Ø¨Ø§ÙØ®Ø±ÙØ¬ ÙÙÙØ³ØªÙØ±ÙÙ.

â ï¸ ÙÙØ³Øª ØªÙØµÙØ© Ø´Ø±Ø§Ø¡ Ø£Ù Ø¨ÙØ¹`);

          continue;
        }
      }

      if (trade.optionStop && optionPrice <= trade.optionStop) {
        await handleSmartStopBreach(key, trade, optionPrice, stockPrice);

        if (!activeTrades.has(key)) {
          continue;
        }
      } else if (trade.optionStopBreached && trade.stopReviewStatus === 'CONTINUING') {
        // Ø§ÙØ¹ÙØ¯ ØªØ¹Ø§ÙÙ ÙÙÙ Ø§ÙÙÙÙØ ÙÙØ¨ÙÙ Ø³Ø¬Ù Ø§ÙÙØ±Ø§Ø¬Ø¹Ø© ÙØ­ÙÙØ¸ÙØ§ Ø¯ÙÙ ØªÙØ±Ø§Ø± Ø§ÙØ±Ø³Ø§ÙØ©.
        trade.nextStopReviewAt = 0;
        await saveActiveTradeToDb(trade);
      }

      const lastUpdate = trade.lastContractUpdatePrice || trade.optionEntry || optionPrice;

      if (optionPrice >= lastUpdate + CONTRACT_UPDATE_STEP) {
        trade.lastContractUpdatePrice = optionPrice;

        await saveActiveTradeToDb(trade);
        await updateTradeHigh(trade);

        if (trade.tp3Hit) {
          await sendSignalMessage(`ð ÙÙØ© Ø¬Ø¯ÙØ¯Ø© ÙÙØ¹ÙØ¯ â ST Decision

ð Ø§ÙØ³ÙÙ: ${trade.symbol}

ð¯ Ø§ÙØ¹ÙØ¯:
${getContractDisplay(trade)}
${trade.optionTicker}

ðµ Ø¯Ø®ÙÙ Ø§ÙØ¹ÙØ¯: ${fmtPrice(trade.optionEntry)}
ðµ Ø§ÙØ³Ø¹Ø± Ø§ÙØ­Ø§ÙÙ: ${fmtPrice(optionPrice)}

ð¥ Ø£Ø¹ÙÙ Ø³Ø¹Ø± ÙØµÙ ÙÙ Ø§ÙØ¹ÙØ¯:
${fmtPrice(trade.optionHigh)}

ð¥ Ø£Ø¹ÙÙ Ø±Ø¨Ø­ ØªØ­ÙÙ:
+$${fmtPrice((Number(trade.optionHigh || 0) - Number(trade.optionEntry || 0)) * 100 * CONTRACT_QTY)}

â ØªÙ ØªØ­ÙÙÙ Ø§ÙÙØ¯Ù Ø§ÙØ«Ø§ÙØ« ÙØ³Ø¨ÙØ§Ù

ð ØªÙ ØªØ³Ø¬ÙÙ ÙÙØ© Ø¬Ø¯ÙØ¯Ø© ÙÙØ¹ÙØ¯
ð Ø§ÙÙØªØ§Ø¨Ø¹Ø© ÙØ³ØªÙØ±Ø© ÙÙÙØ³ØªÙØ±ÙÙ

â ï¸ ÙÙØ³Øª ØªÙØµÙØ© Ø´Ø±Ø§Ø¡ Ø£Ù Ø¨ÙØ¹`);
        } else {
          await sendSignalMessage(`ð ØªØ­Ø¯ÙØ« Ø§ÙØ¹ÙØ¯ â ST Decision

ð Ø§ÙØ³ÙÙ: ${trade.symbol}
ð¯ Ø§ÙØ¹ÙØ¯:
${getContractDisplay(trade)}
${trade.optionTicker}

ðµ Ø¯Ø®ÙÙ Ø§ÙØ¹ÙØ¯: ${fmtPrice(trade.optionEntry)}
ðµ Ø§ÙØ³Ø¹Ø± Ø§ÙØ­Ø§ÙÙ: ${fmtPrice(optionPrice)}
ð Ø£Ø¹ÙÙ Ø³Ø¹Ø± ÙØµÙÙ Ø§ÙØ¹ÙØ¯: ${fmtPrice(trade.optionHigh)}
â Ø§ÙØ±Ø¨Ø­ Ø§ÙØ­Ø§ÙÙ: +${fmtPrice(optionPrice - trade.optionEntry)}
ð¥ Ø£Ø¹ÙÙ Ø±Ø¨Ø­ ÙØµÙ ÙÙ Ø§ÙØ¹ÙØ¯: +${fmtPrice(trade.optionHigh - trade.optionEntry)}

ð¯ Ø­Ø§ÙØ© Ø§ÙØ£ÙØ¯Ø§Ù:
TP1: ${trade.tp1Hit ? 'â ØªØ­ÙÙ' : 'â³ ÙÙ ÙØªØ­ÙÙ'}
TP2: ${trade.tp2Hit ? 'â ØªØ­ÙÙ' : 'â³ ÙÙ ÙØªØ­ÙÙ'}
TP3: ${trade.tp3Hit ? 'â ØªØ­ÙÙ' : 'â³ ÙÙ ÙØªØ­ÙÙ'}

ð ÙÙÙ Ø§ÙØ¹ÙØ¯: ${fmtPrice(trade.optionStop)}
ð¦ OI: ${fmtNum(trade.optionOi)}
ð Volume: ${fmtNum(trade.optionVolume)}`);
        }
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
        'â ST Decision Bot ÙØ¹ÙÙ ÙÙÙØ±Ø£ Ø§ÙÙØ¬ÙÙØ¹Ø©',
        msg.message_thread_id ? { message_thread_id: msg.message_thread_id } : {}
      );
    }

    if (text === '/status' || text === '/botstatus') {
      const gexList = recentGexMessages.map(x => `${x.symbol}:${x.side}`).join(' | ') || 'ÙØ§ ÙÙØ¬Ø¯';
      const radarList = recentRadarMessages.map(x => `${x.symbol}:${x.side}`).join(' | ') || 'ÙØ§ ÙÙØ¬Ø¯';

      return bot.sendMessage(
        msg.chat.id,
        `ð Ø­Ø§ÙØ© ST Decision Bot

â ÙØ¹ÙÙ

Ø¢Ø®Ø± Ø´Ø±ÙØ§Øª Ø§ÙÙØ§ÙØ§:
${gexList}

Ø¢Ø®Ø± Ø´Ø±ÙØ§Øª Ø§ÙØ±Ø§Ø¯Ø§Ø±:
${radarList}

ØµÙÙØ§Øª Ø§ÙÙØ±Ø§ÙØ¨Ø©: ${activeSetups.size}
Ø§ÙØµÙÙØ§Øª Ø§ÙÙÙØ¹ÙØ©: ${activeTrades.size}

Ø¹Ø¯Ø¯ Ø§ÙØ´Ø±ÙØ§Øª Ø§ÙÙØ­ÙÙØ¸Ø© ÙÙ ÙÙ ÙØµØ¯Ø±:
${HISTORY_LIMIT}

ÙØ§ÙØ°Ø© Ø§ÙÙØ·Ø§Ø¨ÙØ©:
${Math.round(MATCH_WINDOW_MS / 60000)} Ø¯ÙÙÙØ©

Ø£ÙÙ Score:
${MIN_SCORE} / 10

ÙØ·Ø§Ù Ø³Ø¹Ø± Ø§ÙØ¹ÙØ¯:
${MIN_CONTRACT_PRICE} Ø¥ÙÙ ${MAX_CONTRACT_PRICE}

Ø£ÙØµÙ Ø¨ÙØ¹Ø¯ ÙÙØ¯Ø®ÙÙ Ø¹Ù Ø§ÙØ³Ø¹Ø± Ø§ÙØ­Ø§ÙÙ:
${MAX_ENTRY_DISTANCE_PCT}%

ÙÙØª Ø§ÙØµÙÙØ§Øª Ø§ÙÙØ³ÙÙØ­:
${tradingTimeText()}

Ø­Ø§ÙØ© Ø§ÙÙÙØª Ø§ÙØ¢Ù:
${isDecisionTradingTime() ? 'â Ø¯Ø§Ø®Ù ÙÙØª Ø§ÙØµÙÙØ§Øª' : 'â Ø®Ø§Ø±Ø¬ ÙÙØª Ø§ÙØµÙÙØ§Øª'}

Ø·Ø±ÙÙØ© ÙÙØ¹ Ø§ÙØªÙØ±Ø§Ø±:
ÙÙÙØ¹ ØªÙØ±Ø§Ø± ÙÙØ³ Ø§ÙØ´Ø±ÙØ© ÙÙÙØ³ Ø§ÙØ§ØªØ¬Ø§Ù.
ÙØ«Ø§Ù: TSLA CALL ÙØ§ ÙØªÙØ±Ø± Ø­ØªÙ ÙÙ ØªØºÙØ± Ø§ÙØ³ØªØ±Ø§ÙÙ.

Ø­ÙØ¸ Ø§ÙØµÙÙØ§Øª:
Ø§ÙØµÙÙØ§Øª Ø§ÙÙÙØ¹ÙØ© ØªØ­ÙØ¸ ÙÙ Supabase ÙØªØ¹ÙØ¯ Ø¨Ø¹Ø¯ Restart Ø£Ù Deploy.
ÙØ§ÙØµÙÙØ§Øª ØªØ­ÙØ¸ ÙÙ decision_trade_history ÙØ¹ trade_uid ÙØ±ÙØ¯ ÙÙÙ ØµÙÙØ© Ø­ØªÙ ÙØ§ ÙØªÙ Ø§Ø³ØªØ¨Ø¯Ø§Ù Ø§ÙØ¹ÙÙØ¯ Ø§ÙÙØªÙØ±Ø±Ø©.
ÙØ§ÙØ¥Ø­ØµØ§Ø¦ÙØ§Øª Ø§ÙØ£Ø³Ø¨ÙØ¹ÙØ© ØªØ­ÙØ¸ ÙÙ decision_weekly_stats.

ÙØªØ§Ø¨Ø¹Ø© Ø§ÙØ£ÙØ¯Ø§Ù:
Ø§ÙØ¨ÙØª ÙØ±Ø§ÙØ¨ TP1 Ù TP2 Ù TP3 Ø¹ÙÙ Ø³Ø¹Ø± Ø§ÙØ³ÙÙ.
Ø¥Ø°Ø§ ØªØ­ÙÙ TP3 ØªØ³ØªÙØ± Ø§ÙÙØªØ§Ø¨Ø¹Ø© ÙÙÙØ³ØªÙØ±ÙÙ ÙÙØªÙ Ø¥Ø±Ø³Ø§Ù ØªØ­Ø¯ÙØ«Ø§Øª Ø¹ÙØ¯ ØªØ³Ø¬ÙÙ ÙÙÙ Ø¬Ø¯ÙØ¯Ø© ÙÙØ¹ÙØ¯.
Ø¥Ø°Ø§ Ø¹Ø§Ø¯ Ø§ÙØ¹ÙØ¯ ÙÙÙØ·ÙØ© Ø§ÙØ­ÙØ§ÙØ© Ø¨Ø¹Ø¯ TP3 ÙØªÙ Ø¥Ø±Ø³Ø§Ù ØªÙØ¨ÙÙ ÙÙÙØ³ØªÙØ±ÙÙ ÙØ¥ØºÙØ§Ù Ø§ÙÙØªØ§Ø¨Ø¹Ø©.

Ø·Ø±ÙÙØ© Ø§ÙÙØ±Ø§Ø±:
ÙØ·Ø§Ø¨Ù Ø¢Ø®Ø± ${HISTORY_LIMIT} Ø´Ø±ÙØ§Øª ÙÙ Ø§ÙÙØ§ÙØ§ ÙØ¹ Ø¢Ø®Ø± ${HISTORY_LIMIT} Ø´Ø±ÙØ§Øª ÙÙ Ø§ÙØ±Ø§Ø¯Ø§Ø±
Ø«Ù ÙØ¨Ø­Ø« Ø¹Ù ÙÙØ³ Ø§ÙØ´Ø±ÙØ© ÙÙÙØ³ Ø§ÙØ§ØªØ¬Ø§Ù

ÙÙØ·Ù Ø§ÙØ±Ø§Ø¯Ø§Ø±:
Ø£ÙÙÙÙØ© ÙØ®ÙØ§ØµØ© Ø§ÙÙØªØ§Ø¨Ø¹Ø©. Ø¥Ø°Ø§ Ø§ÙØ®ÙØ§ØµØ© ØªÙÙÙ Ø§ÙØªØ¸Ø± = ÙØ§ ØµÙÙØ©.

ØªØ¹Ø¯ÙÙ Gamma Support:
Ø¨ÙØª Ø§ÙÙØ±Ø§Ø± ÙØ¶ÙÙ ÙÙØ§Ø· Ø¥Ø¶Ø§ÙÙØ© Ø¥Ø°Ø§ ÙØ§Ù Ø¯Ø¹Ù Ø§ÙØ¬Ø§ÙØ§ Ø®ÙÙ Ø§ÙØµÙÙØ© Ø£ÙÙÙ ÙÙ Ø§ÙÙÙØ§ÙÙØ© Ø£ÙØ§ÙÙØ§.

ØªØ¹Ø¯ÙÙ Ø§ÙØ¹ÙØ¯ Ø§ÙØ¨Ø¯ÙÙ:
Ø¥Ø°Ø§ ØªØ¬Ø§ÙØ² Ø³Ø¹Ø± Ø§ÙØ¹ÙØ¯ Ø§ÙØ­Ø¯ ÙÙØª Ø§ÙØªÙØ¹ÙÙØ ÙØ¨Ø­Ø« Ø§ÙØ¨ÙØª Ø¹Ù Ø¹ÙØ¯ Ø¨Ø¯ÙÙ Ø¯Ø§Ø®Ù Ø§ÙÙØ·Ø§Ù.
Ø¥Ø°Ø§ ØªØºÙØ± Ø§ÙØ³ØªØ±Ø§ÙÙ ÙØ¸ÙØ± ØªÙØ¨ÙÙ Ø¯Ø§Ø®Ù Ø±Ø³Ø§ÙØ© Ø§ÙØªÙØ¹ÙÙ.

Ø·Ø±ÙÙØ© Ø§ÙÙÙÙ:
ÙÙÙ Ø§ÙÙØ§ÙØ§Ø ÙØ¥Ø°Ø§ ØºÙØ± ÙÙØ¬ÙØ¯ ÙØªÙ Ø­Ø³Ø§Ø¨ ÙÙÙ ØªÙÙØ§Ø¦Ù 1.5%`,
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
