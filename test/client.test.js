import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';

import {
  AuthError,
  NetworkError,
  ParseError,
  RateLimitError,
  ServerError,
  SolarEdgeClient,
} from '../src/solaredge/client.js';
import { AbortError } from '../src/util/retry.js';

const CALL = 'https://monitoringapi.solaredge.com/site/12345/currentPowerFlow';
const SUCCESS_BODY = {
  siteCurrentPowerFlow: {
    unit: 'W',
    GRID: { status: 'Active', currentPower: 100 },
  },
};

const silentLogger = {
  info: () => {},
  debug: () => {},
  warn: () => {},
  error: () => {},
};

const server = setupServer();

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe('SolarEdgeClient - happy path', () => {
  beforeEach(() => {
    server.use(http.get(CALL, () => HttpResponse.json(SUCCESS_BODY)));
  });

  it('parses a successful response and returns siteCurrentPowerFlow', async () => {
    const client = new SolarEdgeClient(silentLogger, 'KEY');
    const result = await client.getCurrentPowerFlow(12345);
    expect(result).toEqual(SUCCESS_BODY.siteCurrentPowerFlow);
  });

  it('builds the correct URL with api_key query parameter', async () => {
    let observedUrl = null;
    server.resetHandlers(
      http.get(CALL, ({ request }) => {
        observedUrl = request.url;
        return HttpResponse.json(SUCCESS_BODY);
      }),
    );
    const client = new SolarEdgeClient(silentLogger, 'KEY');
    await client.getCurrentPowerFlow(12345);
    expect(observedUrl).toBeDefined();
    const u = new URL(observedUrl);
    expect(u.pathname).toBe('/site/12345/currentPowerFlow');
    expect(u.searchParams.get('api_key')).toBe('KEY');
  });

  it('encodes special characters in the API key', async () => {
    let observedKey = null;
    server.resetHandlers(
      http.get(CALL, ({ request }) => {
        observedKey = new URL(request.url).searchParams.get('api_key');
        return HttpResponse.json(SUCCESS_BODY);
      }),
    );
    const client = new SolarEdgeClient(silentLogger, 'k&y/with=chars');
    await client.getCurrentPowerFlow(12345);
    expect(observedKey).toBe('k&y/with=chars');
  });
});

describe('SolarEdgeClient - authentication errors', () => {
  it('throws AuthError on 401 and does not retry', async () => {
    const handler = vi.fn(() => new HttpResponse('Invalid API key', { status: 401 }));
    server.use(http.get(CALL, handler));
    const client = new SolarEdgeClient(silentLogger, 'KEY', {
      backoffMs: [10, 30, 90],
    });
    await expect(client.getCurrentPowerFlow(12345)).rejects.toBeInstanceOf(AuthError);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('throws AuthError on 403 and does not retry', async () => {
    const handler = vi.fn(() => new HttpResponse('', { status: 403 }));
    server.use(http.get(CALL, handler));
    const client = new SolarEdgeClient(silentLogger, 'KEY', {
      backoffMs: [10, 30, 90],
    });
    await expect(client.getCurrentPowerFlow(12345)).rejects.toBeInstanceOf(AuthError);
    expect(handler).toHaveBeenCalledTimes(1);
  });
});

describe('SolarEdgeClient - rate limiting', () => {
  it('parses Retry-After in seconds', async () => {
    server.use(
      http.get(CALL, () =>
        new HttpResponse('', { status: 429, headers: { 'Retry-After': '5' } }),
      ),
    );
    const client = new SolarEdgeClient(silentLogger, 'KEY');
    const err = await client.getCurrentPowerFlow(12345).catch((e) => e);
    expect(err).toBeInstanceOf(RateLimitError);
    expect(err.retryAfterSeconds).toBe(5);
  });

  it('parses Retry-After as HTTP-date when not numeric', async () => {
    const future = new Date(Date.now() + 10_000).toUTCString();
    server.use(
      http.get(CALL, () =>
        new HttpResponse('', { status: 429, headers: { 'Retry-After': future } }),
      ),
    );
    const client = new SolarEdgeClient(silentLogger, 'KEY');
    const err = await client.getCurrentPowerFlow(12345).catch((e) => e);
    expect(err).toBeInstanceOf(RateLimitError);
    expect(err.retryAfterSeconds).toBeGreaterThanOrEqual(9);
    expect(err.retryAfterSeconds).toBeLessThanOrEqual(11);
  });
});

describe('SolarEdgeClient - 5xx retries', () => {
  it('retries 500 three times then throws ServerError', async () => {
    const handler = vi.fn(() => new HttpResponse('', { status: 500 }));
    server.use(http.get(CALL, handler));
    const client = new SolarEdgeClient(silentLogger, 'KEY', {
      backoffMs: [10, 30, 90],
    });
    await expect(client.getCurrentPowerFlow(12345)).rejects.toBeInstanceOf(ServerError);
    expect(handler).toHaveBeenCalledTimes(4);
  });

  it('retries 503 three times then throws ServerError', async () => {
    const handler = vi.fn(() => new HttpResponse('', { status: 503 }));
    server.use(http.get(CALL, handler));
    const client = new SolarEdgeClient(silentLogger, 'KEY', {
      backoffMs: [10, 30, 90],
    });
    await expect(client.getCurrentPowerFlow(12345)).rejects.toBeInstanceOf(ServerError);
    expect(handler).toHaveBeenCalledTimes(4);
  });

  it('backs off between retries with exponential delays', async () => {
    const timestamps = [];
    server.use(
      http.get(CALL, () => {
        timestamps.push(Date.now());
        return new HttpResponse('', { status: 500 });
      }),
    );
    const client = new SolarEdgeClient(silentLogger, 'KEY', {
      backoffMs: [50, 150, 450],
    });
    const start = Date.now();
    await expect(client.getCurrentPowerFlow(12345)).rejects.toBeInstanceOf(ServerError);
    const elapsed = Date.now() - start;
    expect(timestamps).toHaveLength(4);
    expect(elapsed).toBeGreaterThanOrEqual(50 + 150);
    expect(timestamps[1] - timestamps[0]).toBeGreaterThanOrEqual(45);
    expect(timestamps[2] - timestamps[1]).toBeGreaterThanOrEqual(145);
  });
});

describe('SolarEdgeClient - network errors', () => {
  it('retries network errors and throws NetworkError', async () => {
    let callCount = 0;
    server.use(
      http.get(CALL, () => {
        callCount++;
        return HttpResponse.error();
      }),
    );
    const client = new SolarEdgeClient(silentLogger, 'KEY', {
      backoffMs: [10, 30, 90],
    });
    const err = await client.getCurrentPowerFlow(12345).catch((e) => e);
    expect(err).toBeInstanceOf(NetworkError);
    expect(callCount).toBe(4);
  });
});

describe('SolarEdgeClient - parse errors', () => {
  it('throws ParseError when response is not JSON (no retries)', async () => {
    const handler = vi.fn(() => new HttpResponse('not json', { status: 200 }));
    server.use(http.get(CALL, handler));
    const client = new SolarEdgeClient(silentLogger, 'KEY', {
      backoffMs: [10, 30, 90],
    });
    await expect(client.getCurrentPowerFlow(12345)).rejects.toBeInstanceOf(ParseError);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('throws ParseError when JSON is valid but missing siteCurrentPowerFlow', async () => {
    const handler = vi.fn(() => HttpResponse.json({ foo: 'bar' }));
    server.use(http.get(CALL, handler));
    const client = new SolarEdgeClient(silentLogger, 'KEY', {
      backoffMs: [10, 30, 90],
    });
    await expect(client.getCurrentPowerFlow(12345)).rejects.toBeInstanceOf(ParseError);
    expect(handler).toHaveBeenCalledTimes(1);
  });
});

describe('SolarEdgeClient - abort', () => {
  it('rejects with AbortError when AbortController fires mid-request', async () => {
    const ac = new AbortController();
    server.use(
      http.get(CALL, async () => {
        ac.abort();
        return HttpResponse.json(SUCCESS_BODY);
      }),
    );
    const client = new SolarEdgeClient(silentLogger, 'KEY', {
      backoffMs: [10, 30, 90],
    });
    const err = await client.getCurrentPowerFlow(12345, ac.signal).catch((e) => e);
    expect(err.name === 'AbortError' || err instanceof AbortError).toBe(true);
  });
});

describe('SolarEdgeClient - constructor validation', () => {
  it('throws when apiKey is missing', () => {
    expect(() => new SolarEdgeClient(silentLogger, '')).toThrow(/apiKey/);
  });

  it('throws when siteId is missing on request', async () => {
    const client = new SolarEdgeClient(silentLogger, 'KEY');
    await expect(client.getCurrentPowerFlow()).rejects.toThrow(/siteId/);
  });
});
