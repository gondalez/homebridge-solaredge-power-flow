import { sleep, AbortError } from '../util/retry.js';

const DEFAULT_BASE_URL = 'https://monitoringapi.solaredge.com';
const DEFAULT_BACKOFF_MS = [1000, 3000, 9000];
const MAX_RETRIES = 3;

export class SolarEdgeError extends Error {
  constructor(message, { cause } = {}) {
    super(message);
    this.name = 'SolarEdgeError';
    if (cause) this.cause = cause;
  }
}

export class AuthError extends SolarEdgeError {
  constructor(message, { cause } = {}) {
    super(message, { cause });
    this.name = 'AuthError';
  }
}

export class RateLimitError extends SolarEdgeError {
  constructor(message, { retryAfterSeconds, cause } = {}) {
    super(message, { cause });
    this.name = 'RateLimitError';
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export class ServerError extends SolarEdgeError {
  constructor(message, { status, cause } = {}) {
    super(message, { cause });
    this.name = 'ServerError';
    this.status = status;
  }
}

export class NetworkError extends SolarEdgeError {
  constructor(message, { cause } = {}) {
    super(message, { cause });
    this.name = 'NetworkError';
  }
}

export class ParseError extends SolarEdgeError {
  constructor(message, { cause } = {}) {
    super(message, { cause });
    this.name = 'ParseError';
  }
}

export class SolarEdgeClient {
  constructor(log, apiKey, options = {}) {
    if (!apiKey) throw new Error('SolarEdgeClient: apiKey is required');
    this.log = log;
    this.apiKey = apiKey;
    this.baseUrl = options.baseUrl || DEFAULT_BASE_URL;
    this.backoffMs = options.backoffMs || DEFAULT_BACKOFF_MS;
    this.maxRetries = options.maxRetries != null ? options.maxRetries : MAX_RETRIES;
    this.fetch = options.fetch || globalThis.fetch;
    this.endpoint = options.endpoint || '/currentPowerFlow';
  }

  async getCurrentPowerFlow(siteId, signal) {
    if (!siteId) throw new Error('SolarEdgeClient.getCurrentPowerFlow: siteId is required');
    const url = this.buildUrl(siteId);
    return this.request(url, signal);
  }

  buildUrl(siteId) {
    const u = new URL(`${this.baseUrl}/site/${encodeURIComponent(siteId)}${this.endpoint}`);
    u.searchParams.set('api_key', this.apiKey);
    return u.toString();
  }

  async request(url, signal) {
    let lastError;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        return await this.attempt(url, signal);
      } catch (err) {
        lastError = err;
        if (err instanceof AuthError || err instanceof ParseError || err instanceof RateLimitError) throw err;
        if (err instanceof AbortError) throw err;
        if (attempt === this.maxRetries) break;
        const backoff = this.backoffMs[Math.min(attempt, this.backoffMs.length - 1)];
        this.log.debug?.(`SolarEdgeClient retry ${attempt + 1}/${this.maxRetries} in ${backoff}ms after ${err.name}`);
        try {
          await sleep(backoff, signal);
        } catch (sleepErr) {
          if (sleepErr instanceof AbortError) throw sleepErr;
          throw sleepErr;
        }
      }
    }
    throw lastError;
  }

  async attempt(url, signal) {
    let response;
    try {
      response = await this.fetch(url, { signal });
    } catch (err) {
      if (err?.name === 'AbortError') throw new AbortError(err.message, { cause: err });
      throw new NetworkError(`Network error fetching ${url}: ${err.message}`, { cause: err });
    }

    if (response.status === 401 || response.status === 403) {
      const body = await safeText(response);
      throw new AuthError(`Authentication failed (${response.status}): ${body}`);
    }

    if (response.status === 429) {
      const retryAfterSeconds = parseRetryAfter(response.headers.get('Retry-After'));
      throw new RateLimitError(`Rate limit exceeded (${response.status})`, { retryAfterSeconds });
    }

    if (response.status >= 500) {
      const body = await safeText(response);
      throw new ServerError(`Server error (${response.status}): ${body}`, { status: response.status });
    }

    if (!response.ok) {
      const body = await safeText(response);
      throw new SolarEdgeError(`Unexpected status (${response.status}): ${body}`);
    }

    let json;
    try {
      json = await response.json();
    } catch (err) {
      throw new ParseError(`Failed to parse JSON response: ${err.message}`, { cause: err });
    }

    if (!json || typeof json !== 'object' || !json.siteCurrentPowerFlow) {
      throw new ParseError('Response missing required "siteCurrentPowerFlow" key');
    }

    return json.siteCurrentPowerFlow;
  }
}

async function safeText(response) {
  try {
    return await response.text();
  } catch {
    return '';
  }
}

function parseRetryAfter(headerValue) {
  if (!headerValue) return null;
  const seconds = Number.parseInt(headerValue, 10);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds;
  const date = Date.parse(headerValue);
  if (Number.isFinite(date)) {
    return Math.max(0, Math.round((date - Date.now()) / 1000));
  }
  return null;
}
