import { z } from 'zod';

// ─────────────────────────────────────────────────────────────────────────────
// Technical indicators (RSI, EMA, MACD, Bollinger Bands, VWAP), shared by
// getPoolIndicator and getTokenIndicator so both build the same request.
//
// Upstream: GET /networks/{network}/pools/{pool_address}/indicators and
// GET /networks/{network}/tokens/{token_address}/indicators, with the indicator
// picked by ?indicator=. A parameter that belongs to another indicator is
// refused with 400 (fast_period on rsi, say), so only what the caller set is
// sent, and no default is filled in here.
//
// Pure module on purpose: the request building is unit-tested in
// test/indicators.test.js without starting a server or touching the network.
// ─────────────────────────────────────────────────────────────────────────────

export const INDICATORS = ['rsi', 'ema', 'macd', 'bbands', 'vwap'];
export const INDICATOR_INTERVALS = ['1m', '5m', '10m', '15m', '30m', '1h', '6h', '12h', '24h', '1d'];

/** Query parameters in the order they are sent. */
const QUERY_KEYS = [
  'indicator', 'interval', 'limit', 'start', 'end', 'cursor',
  'period', 'fast_period', 'slow_period', 'signal_period', 'std_dev',
];

export const INDICATOR_PARAM_HELP =
  "indicator (required): 'rsi', 'ema', 'macd', 'bbands' or 'vwap'; interval (pass it every time: '1m','5m','10m','15m','30m','1h','6h','12h','24h' or '1d'); start (optional; a relative offset such as '-24h' or '-7d', Unix seconds, RFC3339 or yyyy-mm-dd; without it you get the last `limit` values); end (optional, exclusive); limit (default 100, max 1000); cursor (next_cursor of the previous page, not with start); period for rsi (default 14), ema (20), bbands (20) and vwap (14); fast_period (12), slow_period (26) and signal_period (9) for macd only; std_dev (2) for bbands only. A parameter that belongs to another indicator is refused.";

export const INDICATOR_READING_HELP =
  'Values come oldest first, one per completed candle: rsi, ema and vwap return `value`; macd returns `macd`, `signal` and `histogram`; bbands returns `upper`, `middle` and `lower`. RSI over 70 is commonly read as overbought and under 30 as oversold; a MACD histogram that changes sign means MACD crossed its signal line. RSI, EMA and MACD are smoothed, so start at least ten periods before the first value you rely on.';

/** Zod input fields after the address, shared by both tools. */
export function indicatorInputShape() {
  return {
    indicator: z.enum(INDICATORS).describe("REQUIRED: 'rsi', 'ema', 'macd', 'bbands' (Bollinger Bands) or 'vwap'"),
    interval: z.enum(INDICATOR_INTERVALS).optional().describe("Candle interval the indicator is computed on. Pass it every time; '1d' equals '24h'"),
    start: z.string().optional().describe("OPTIONAL: First candle. A relative offset from now is simplest: '-24h', '-7d' (units s, m, h, d). Also Unix seconds, RFC3339 or YYYY-MM-DD. Without it you get the last `limit` values"),
    end: z.string().optional().describe('OPTIONAL: End of the range, exclusive, same formats as start. Defaults to now'),
    limit: z.coerce.number().int().min(1).max(1000).optional().describe('OPTIONAL: Values per response (default 100, max 1000)'),
    cursor: z.string().optional().describe('OPTIONAL: next_cursor from the previous page. Do not combine with start'),
    period: z.coerce.number().int().min(1).max(200).optional().describe('OPTIONAL: rsi (default 14), ema (default 20), bbands (default 20), vwap (default 14). Not for macd'),
    fast_period: z.coerce.number().int().min(1).max(200).optional().describe('OPTIONAL, macd only: fast EMA period (default 12)'),
    slow_period: z.coerce.number().int().min(2).max(200).optional().describe('OPTIONAL, macd only: slow EMA period (default 26), must be above fast_period'),
    signal_period: z.coerce.number().int().min(1).max(200).optional().describe('OPTIONAL, macd only: signal line period (default 9)'),
    std_dev: z.coerce.number().positive().max(10).optional().describe('OPTIONAL, bbands only: band width in standard deviations (default 2)'),
  };
}

/**
 * `?indicator=...&...` with only the parameters the caller set.
 *
 * @param {Record<string, unknown>} args
 * @returns {string}
 */
export function indicatorQuery(args) {
  const parts = [];
  for (const key of QUERY_KEYS) {
    const v = args[key];
    if (v === undefined || v === null || v === '') continue;
    parts.push(`${key}=${encodeURIComponent(String(v))}`);
  }
  return parts.length ? `?${parts.join('&')}` : '';
}

export function poolIndicatorPath(network, poolAddress, args) {
  return `/networks/${network}/pools/${poolAddress}/indicators${indicatorQuery(args)}`;
}

export function tokenIndicatorPath(network, tokenAddress, args) {
  return `/networks/${network}/tokens/${tokenAddress}/indicators${indicatorQuery(args)}`;
}
