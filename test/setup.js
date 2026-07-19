import { beforeEach, afterEach, vi } from 'vitest';

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ['setTimeout', 'setInterval', 'Date'],
  });
});

afterEach(() => {
  vi.useRealTimers();
});
