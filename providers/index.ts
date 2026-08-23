import extTo from './ext-to.js';
import x1337 from './1337x.js';
import eztv from './eztv.js';
import { registerDomainCookies } from '../lib/browser.js';
import type { Provider } from '../lib/types.js';

const providers: Provider[] = [extTo, x1337, eztv];

for (const p of providers) {
  if (p.cookies?.length) registerDomainCookies(p.cookies);
}

export const providerMap: Record<string, Provider> = Object.fromEntries(providers.map((p) => [p.id, p]));
