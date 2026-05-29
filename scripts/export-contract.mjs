// Export the realtime protocol contract from @remote-dj/shared into qa/contract.json.
//
// WHY: the Python black-box harness (qa/server) must NOT import TS from
// @remote-dj/shared — that would couple the tester to the implementation and
// let drift/bias leak in. Instead the harness reads this JSON snapshot. This
// script is the single bridge: run it (npm run contract:export) whenever the
// shared event names / limits change so the contract stays fresh.

import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { C2S, LIMITS, S2C } from '@remote-dj/shared';

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(here, '..', 'qa', 'contract.json');

const contract = {
  c2s: { ...C2S },
  s2c: { ...S2C },
  limits: { ...LIMITS },
};

writeFileSync(out, `${JSON.stringify(contract, null, 2)}\n`, 'utf8');
console.log(`wrote ${out}`);
