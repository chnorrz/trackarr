import extTo from './ext-to.js';
import x1337 from './1337x.js';
import eztv from './eztv.js';

const providers = [extTo, x1337, eztv];

export const providerMap = Object.fromEntries(providers.map((p) => [p.id, p]));
