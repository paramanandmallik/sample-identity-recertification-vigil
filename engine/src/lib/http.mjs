/**
 * HTTP response helpers and structured logging.
 * @module lib/http
 */

const CORS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
};

/** Successful API response. */
export const ok = (statusCode, data) => ({
  statusCode,
  headers: CORS,
  body: JSON.stringify({ success: true, data }),
});

/** Error API response (message must be safe for external consumers). */
export const fail = (statusCode, error) => ({
  statusCode,
  headers: CORS,
  body: JSON.stringify({ success: false, error }),
});

/** Structured JSON log line. */
export const log = (level, code, fields = {}) => {
  const line = JSON.stringify({ level, code, ...fields, ts: new Date().toISOString() });
  if (level === 'error') console.error(line);
  else console.log(line);
};
