/** Puts the resolver in `hooks.mjs` in front of node's own, for the test run only. */
import { register } from 'node:module';

register('./hooks.mjs', import.meta.url);
