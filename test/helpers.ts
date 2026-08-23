import type { Page } from 'playwright-core';

export interface FakePageOptions {
  content?: string;
  evaluateResult?: unknown;
}

export function fakePage(opts: FakePageOptions = {}): Page {
  const page = {
    content: async () => opts.content ?? '',
    evaluate: async () => opts.evaluateResult,
    close: async () => {}
  };
  return page as unknown as Page;
}
