import type { Page } from 'playwright-core';

export interface FakePageOptions {
  content?: string;
  /** Return value for page.evaluate() calls (ext.to's magnet POST, EZTV's
   * wlinks reveal) - the real callback runs fetch() inside a live browser
   * page, which isn't meaningful to actually execute in a test, so the mock
   * just returns whatever the test configures. */
  evaluateResult?: unknown;
}

/**
 * Minimal fake Playwright Page satisfying just what providers/*.ts actually
 * use (content/evaluate/close) - cast to Page since a real Page has dozens
 * of members test doubles have no business implementing.
 */
export function fakePage(opts: FakePageOptions = {}): Page {
  const page = {
    content: async () => opts.content ?? '',
    evaluate: async () => opts.evaluateResult,
    close: async () => {}
  };
  return page as unknown as Page;
}
