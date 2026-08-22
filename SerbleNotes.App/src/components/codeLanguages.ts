import { LanguageDescription, LanguageSupport, StreamLanguage } from '@codemirror/language';
import type { StreamParser } from '@codemirror/language';

/**
 * The languages a fenced code block can be highlighted in.
 *
 * **Every one of these loads on demand.** The `load` callbacks are dynamic imports, so a note that
 * has no code in it downloads no parsers, and a note with one Rust block downloads one. This is not
 * a micro-optimisation: `@codemirror/lang-html` alone drags in the whole JavaScript and CSS parsers,
 * which is why the markdown parser is assembled by hand rather than taken from
 * `@codemirror/lang-markdown` (see markdownLanguage.ts). Keeping them behind imports is what lets us
 * have both - a small initial bundle and highlighting for real languages.
 *
 * While a parser is still downloading the block renders as plain code and re-highlights itself when
 * it arrives; `ParseContext.getSkippingParser` in markdownLanguage.ts is what schedules that.
 *
 * ## Adding a language
 *
 * Add a `LanguageDescription`. `name` is what shows on the block's chip, `alias` is what someone can
 * write after the backticks, and both are matched case-insensitively. Nothing else needs to change.
 *
 * ## TextMate grammars
 *
 * A user-supplied TextMate pack is the same shape of thing: something that resolves to a
 * `LanguageSupport` when asked. A grammar runner (vscode-textmate over its WASM regex engine, or
 * similar) wrapped as a `StreamLanguage` fits this list without the editor, the live preview or the
 * markdown parser knowing about it - which is the point of routing every language through here. What
 * is missing today is only the loader and somewhere to keep the packs, not a place to put them.
 */

/** Wraps a CodeMirror 5 mode, which is how the less mainstream languages are still shipped. */
function legacy(load: () => Promise<StreamParser<unknown>>): () => Promise<LanguageSupport> {
  return () => load().then((mode) => new LanguageSupport(StreamLanguage.define(mode)));
}

export const codeLanguages: LanguageDescription[] = [
  LanguageDescription.of({
    name: 'JavaScript',
    alias: ['js', 'node', 'mjs', 'cjs'],
    load: () => import('@codemirror/lang-javascript').then((m) => m.javascript()),
  }),
  LanguageDescription.of({
    name: 'JSX',
    load: () => import('@codemirror/lang-javascript').then((m) => m.javascript({ jsx: true })),
  }),
  LanguageDescription.of({
    name: 'TypeScript',
    alias: ['ts'],
    load: () => import('@codemirror/lang-javascript').then((m) => m.javascript({ typescript: true })),
  }),
  LanguageDescription.of({
    name: 'TSX',
    load: () =>
      import('@codemirror/lang-javascript').then((m) => m.javascript({ jsx: true, typescript: true })),
  }),
  LanguageDescription.of({
    name: 'Python',
    alias: ['py', 'python3'],
    load: () => import('@codemirror/lang-python').then((m) => m.python()),
  }),
  LanguageDescription.of({
    name: 'Rust',
    alias: ['rs'],
    load: () => import('@codemirror/lang-rust').then((m) => m.rust()),
  }),
  LanguageDescription.of({
    name: 'Go',
    alias: ['golang'],
    load: () => import('@codemirror/lang-go').then((m) => m.go()),
  }),
  LanguageDescription.of({
    name: 'Java',
    load: () => import('@codemirror/lang-java').then((m) => m.java()),
  }),
  LanguageDescription.of({
    name: 'C',
    load: () => import('@codemirror/lang-cpp').then((m) => m.cpp()),
  }),
  LanguageDescription.of({
    name: 'C++',
    alias: ['cpp', 'cc', 'cxx', 'hpp'],
    load: () => import('@codemirror/lang-cpp').then((m) => m.cpp()),
  }),
  LanguageDescription.of({
    name: 'C#',
    alias: ['csharp', 'cs'],
    load: legacy(() => import('@codemirror/legacy-modes/mode/clike').then((m) => m.csharp)),
  }),
  LanguageDescription.of({
    name: 'PHP',
    load: () => import('@codemirror/lang-php').then((m) => m.php()),
  }),
  LanguageDescription.of({
    name: 'Ruby',
    alias: ['rb'],
    load: legacy(() => import('@codemirror/legacy-modes/mode/ruby').then((m) => m.ruby)),
  }),
  LanguageDescription.of({
    name: 'Swift',
    load: legacy(() => import('@codemirror/legacy-modes/mode/swift').then((m) => m.swift)),
  }),
  LanguageDescription.of({
    name: 'Kotlin',
    alias: ['kt', 'kts'],
    load: legacy(() => import('@codemirror/legacy-modes/mode/clike').then((m) => m.kotlin)),
  }),
  LanguageDescription.of({
    name: 'Scala',
    load: legacy(() => import('@codemirror/legacy-modes/mode/clike').then((m) => m.scala)),
  }),
  LanguageDescription.of({
    name: 'Groovy',
    load: legacy(() => import('@codemirror/legacy-modes/mode/groovy').then((m) => m.groovy)),
  }),
  LanguageDescription.of({
    name: 'Haskell',
    alias: ['hs'],
    load: legacy(() => import('@codemirror/legacy-modes/mode/haskell').then((m) => m.haskell)),
  }),
  LanguageDescription.of({
    name: 'Lua',
    load: legacy(() => import('@codemirror/legacy-modes/mode/lua').then((m) => m.lua)),
  }),
  LanguageDescription.of({
    name: 'Perl',
    alias: ['pl'],
    load: legacy(() => import('@codemirror/legacy-modes/mode/perl').then((m) => m.perl)),
  }),
  LanguageDescription.of({
    name: 'R',
    load: legacy(() => import('@codemirror/legacy-modes/mode/r').then((m) => m.r)),
  }),
  LanguageDescription.of({
    name: 'SQL',
    load: () => import('@codemirror/lang-sql').then((m) => m.sql()),
  }),
  LanguageDescription.of({
    name: 'HTML',
    alias: ['htm'],
    load: () => import('@codemirror/lang-html').then((m) => m.html()),
  }),
  LanguageDescription.of({
    name: 'CSS',
    load: () => import('@codemirror/lang-css').then((m) => m.css()),
  }),
  LanguageDescription.of({
    name: 'XML',
    alias: ['svg', 'xsl', 'xslt'],
    load: () => import('@codemirror/lang-xml').then((m) => m.xml()),
  }),
  LanguageDescription.of({
    name: 'JSON',
    alias: ['jsonc'],
    load: () => import('@codemirror/lang-json').then((m) => m.json()),
  }),
  LanguageDescription.of({
    name: 'YAML',
    alias: ['yml'],
    load: () => import('@codemirror/lang-yaml').then((m) => m.yaml()),
  }),
  LanguageDescription.of({
    name: 'TOML',
    load: legacy(() => import('@codemirror/legacy-modes/mode/toml').then((m) => m.toml)),
  }),
  LanguageDescription.of({
    name: 'INI',
    alias: ['cfg', 'conf', 'properties'],
    load: legacy(() => import('@codemirror/legacy-modes/mode/properties').then((m) => m.properties)),
  }),
  LanguageDescription.of({
    name: 'Shell',
    alias: ['sh', 'bash', 'zsh', 'fish', 'console', 'shell-session'],
    load: legacy(() => import('@codemirror/legacy-modes/mode/shell').then((m) => m.shell)),
  }),
  LanguageDescription.of({
    name: 'PowerShell',
    alias: ['ps1', 'pwsh'],
    load: legacy(() => import('@codemirror/legacy-modes/mode/powershell').then((m) => m.powerShell)),
  }),
  LanguageDescription.of({
    name: 'Dockerfile',
    alias: ['docker'],
    load: legacy(() => import('@codemirror/legacy-modes/mode/dockerfile').then((m) => m.dockerFile)),
  }),
  LanguageDescription.of({
    name: 'Diff',
    alias: ['patch'],
    load: legacy(() => import('@codemirror/legacy-modes/mode/diff').then((m) => m.diff)),
  }),
];

/**
 * The name to show on a code block, for an info string the user typed. Returns what they wrote when
 * nothing matches, because an unknown language is still worth labelling - it just will not colour.
 */
export function languageLabel(info: string): string {
  const word = info.trim().split(/\s+/)[0];
  if (word === '') {
    return '';
  }
  return LanguageDescription.matchLanguageName(codeLanguages, word, true)?.name ?? word;
}
