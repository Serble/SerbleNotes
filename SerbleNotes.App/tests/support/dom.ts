/**
 * A DOM for the tests that need one.
 *
 * `htmlToMarkdown` is handed a document rather than a string of markdown, so unlike everything else
 * in this directory it cannot be tested without a parser. jsdom is a dev dependency for exactly
 * this: the alternative was checking a converter by hand in a browser, and its failures are the
 * quiet kind - a list that comes out as paragraphs, a link that keeps a tracking wrapper - which is
 * precisely what nobody notices in review.
 *
 * Importing this module installs `DOMParser` globally, which is the one thing the converter reaches
 * for. It takes nothing else from the page: styles are read from the `style` attribute rather than
 * through the CSSOM, and every node check is `nodeType` rather than `instanceof`, so there is no
 * second set of globals for a test to get wrong.
 */
import { JSDOM } from 'jsdom';

const { window } = new JSDOM('');

(globalThis as unknown as { DOMParser: typeof window.DOMParser }).DOMParser = window.DOMParser;
