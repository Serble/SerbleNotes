import './support/dom';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { EditorState } from '@codemirror/state';
import { htmlToMarkdown, inlineHtmlToMarkdown } from '../src/components/htmlToMarkdown';
import { markdownLanguage } from '../src/components/markdownLanguage';
import { pasteMarkdown } from '../src/components/pasteHtml';

/**
 * Turning what an application put on the clipboard into the markdown this app writes.
 *
 * The fixtures below are the real shapes, not tidied ones: Google Docs really does wrap everything
 * in a `<b>` that is not bold and mark emphasis with inline styles, and Word really does write a
 * list as paragraphs carrying `mso-list`. A converter tested only against handwritten HTML passes
 * every test and then loses the formatting of every paste anybody actually makes.
 */

describe('links', () => {
  it('keeps a masked link masked', () => {
    assert.equal(
      htmlToMarkdown('<p>See <a href="https://example.com/docs">the docs</a> first.</p>'),
      'See [the docs](https://example.com/docs) first.',
    );
  });

  it('writes a link whose text is its address as the bare address', () => {
    // `[https://example.com/](https://example.com/)` is nobody's intention, and the parser
    // autolinks the bare form anyway.
    assert.equal(
      htmlToMarkdown('<a href="https://example.com/">https://example.com/</a>'),
      'https://example.com/',
    );
  });

  it('unwraps the redirect Google Docs writes round every link it copies', () => {
    const html =
      '<a href="https://www.google.com/url?q=https%3A%2F%2Fexample.com%2Fa%3Fb%3D1&amp;sa=D&amp;source=docs&amp;ust=17&amp;usg=AOvVaw">example</a>';
    assert.equal(htmlToMarkdown(html), '[example](https://example.com/a?b=1)');
  });

  it('unwraps an Outlook Safe Links address', () => {
    const html =
      '<a href="https://eur01.safelinks.protection.outlook.com/?url=https%3A%2F%2Fexample.com%2Fx&amp;data=05%7C01&amp;reserved=0">x</a>';
    assert.equal(htmlToMarkdown(html), '[x](https://example.com/x)');
  });

  it('keeps the words of a link it will not write down', () => {
    // `javascript:` is not a link here and never becomes one - see linkClicks.ts. Nor is a relative
    // path, which has nothing on the clipboard to resolve it against.
    assert.equal(htmlToMarkdown('<a href="javascript:alert(1)">click me</a>'), 'click me');
    assert.equal(htmlToMarkdown('<a href="/docs/intro">intro</a>'), 'intro');
  });

  it('puts a destination with brackets in it inside angle brackets', () => {
    assert.equal(
      htmlToMarkdown('<a href="https://en.wikipedia.org/wiki/Cat_(disambiguation)">Cat</a>'),
      '[Cat](<https://en.wikipedia.org/wiki/Cat_(disambiguation)>)',
    );
  });

  it('does not underline a link, because every word processor does', () => {
    const html = '<a href="https://example.com"><span style="text-decoration:underline">here</span></a>';
    assert.equal(htmlToMarkdown(html), '[here](https://example.com/)');
  });
});

describe('a google doc', () => {
  // The wrapper is the thing: Docs puts the whole fragment inside one `<b style="font-weight:normal">`
  // and marks the words that are really bold with `font-weight:700` on a span. Reading the tag first
  // renders the entire paste bold and finds no emphasis anywhere in it.
  const docs = (body: string) =>
    `<meta charset="utf-8"><b style="font-weight:normal;" id="docs-internal-guid-1">${body}</b>`;
  const span = (style: string, text: string) =>
    `<span style="font-size:11pt;font-family:Arial;color:#000000;background-color:transparent;${style}vertical-align:baseline;white-space:pre-wrap;">${text}</span>`;

  it('is not entirely bold', () => {
    const html = docs(`<p dir="ltr">${span('font-weight:400;', 'plain words')}</p>`);
    assert.equal(htmlToMarkdown(html), 'plain words');
  });

  it('finds the emphasis that is only in the styles', () => {
    const html = docs(
      `<p dir="ltr">${span('font-weight:400;', 'a ')}${span('font-weight:700;', 'bold')}${span('font-weight:400;', ' and ')}${span('font-style:italic;', 'italic')}${span('font-weight:400;', ' word')}</p>`,
    );
    assert.equal(htmlToMarkdown(html), 'a **bold** and *italic* word');
  });

  it('keeps its paragraphs apart', () => {
    const html = docs(`<p dir="ltr">${span('', 'one')}</p><p dir="ltr">${span('', 'two')}</p>`);
    assert.equal(htmlToMarkdown(html), 'one\n\ntwo');
  });

  it('reads a strikethrough and a highlight out of the styles too', () => {
    const html = docs(
      `<p>${span('text-decoration:line-through;', 'gone')}${span('', ' ')}${span('background-color:#ffff00;', 'kept')}</p>`,
    );
    assert.equal(htmlToMarkdown(html), '~~gone~~ ==kept==');
  });
});

describe('a word document', () => {
  it('throws away the stylesheet it brings with it', () => {
    const html =
      '<html><head><style><!-- p.MsoNormal {margin:0cm; font-size:11.0pt;} --></style></head>' +
      '<body><p class=MsoNormal>Just this.</p></body></html>';
    assert.equal(htmlToMarkdown(html), 'Just this.');
  });

  it('reads a list written as paragraphs carrying mso-list', () => {
    const item = (level: number, marker: string, text: string) =>
      `<p class=MsoListParagraphCxSpMiddle style='margin-left:36.0pt;mso-list:l0 level${level} lfo1'>` +
      `<span style='mso-list:Ignore'>${marker}<span style='font:7.0pt "Times New Roman"'>&nbsp;&nbsp;</span></span>${text}</p>`;

    const html = `<body>${item(1, '1.', 'First')}${item(1, '2.', 'Second')}${item(2, 'o', 'Under it')}</body>`;
    assert.equal(htmlToMarkdown(html), '1. First\n2. Second\n  - Under it');
  });

  it('turns the non-breaking spaces it writes into spaces', () => {
    // Invisible, indistinguishable from a space, and not one. A note is source somebody edits.
    assert.equal(htmlToMarkdown('<p>a&nbsp;&nbsp;b</p>'), 'a b');
  });
});

describe('blocks', () => {
  it('reads headings', () => {
    assert.equal(htmlToMarkdown('<h1>Title</h1><h3>Under it</h3>'), '# Title\n\n### Under it');
  });

  it('reads a blockquote, at whatever depth it was nested', () => {
    assert.equal(
      htmlToMarkdown('<blockquote><p>outer</p><blockquote><p>inner</p></blockquote></blockquote>'),
      '> outer\n>\n> > inner',
    );
  });

  it('reads a rule and keeps paragraphs apart', () => {
    assert.equal(htmlToMarkdown('<p>a</p><hr><p>b</p>'), 'a\n\n---\n\nb');
  });

  it('turns a line break into a line break', () => {
    assert.equal(htmlToMarkdown('<p>one<br>two</p>'), 'one\ntwo');
  });

  it('reads a fenced block and the language it was highlighted as', () => {
    assert.equal(
      htmlToMarkdown('<pre><code class="language-rust">fn main() {\n    ok();\n}\n</code></pre>'),
      '```rust\nfn main() {\n    ok();\n}\n```',
    );
  });

  it('gives a code span enough backticks to hold what is in it', () => {
    assert.equal(htmlToMarkdown('<p>run <code>a ` b</code></p>'), 'run ``a ` b``');
  });
});

describe('lists', () => {
  it('reads an unordered list', () => {
    assert.equal(htmlToMarkdown('<ul><li>one</li><li>two</li></ul>'), '- one\n- two');
  });

  it('numbers an ordered list from where it started', () => {
    assert.equal(htmlToMarkdown('<ol start="3"><li>three</li><li>four</li></ol>'), '3. three\n4. four');
  });

  it('nests a list under the item it was inside, without a blank line between', () => {
    assert.equal(
      htmlToMarkdown('<ul><li>one<ul><li>deeper</li></ul></li><li>two</li></ul>'),
      '- one\n  - deeper\n- two',
    );
  });

  it('leaves a blank line between a list and whatever came before it', () => {
    // Only a *nested* list sits tight against the line above it. Joining every list that way put a
    // list directly under its heading - which happens to parse, and is not what anybody writes.
    assert.equal(htmlToMarkdown('<h2>Heading</h2><ul><li>one</li></ul>'), '## Heading\n\n- one');
    assert.equal(htmlToMarkdown('<p>words</p><ul><li>one</li></ul>'), 'words\n\n- one');
    assert.equal(htmlToMarkdown('<ul><li>one</li></ul><p>after</p>'), '- one\n\nafter');
  });

  it('reads the checkbox a task list is written with', () => {
    assert.equal(
      htmlToMarkdown('<ul><li><input type="checkbox" checked>done</li><li><input type="checkbox">not</li></ul>'),
      '- [x] done\n- [ ] not',
    );
  });
});

describe('tables', () => {
  it('lays a table out with the app own renderer, padded to its columns', () => {
    const html =
      '<table><thead><tr><th>Name</th><th>Size</th></tr></thead>' +
      '<tbody><tr><td>alpha</td><td>1</td></tr><tr><td>b</td><td>22</td></tr></tbody></table>';
    assert.equal(
      htmlToMarkdown(html),
      ['| Name  | Size |', '| ----- | ---- |', '| alpha | 1    |', '| b     | 22   |'].join('\n'),
    );
  });

  it('gives up the first row to be the header when the table has none', () => {
    // A markdown table cannot say "no header", and this is the reading every person makes of such
    // a table anyway.
    assert.equal(
      htmlToMarkdown('<table><tr><td>a</td><td>b</td></tr><tr><td>c</td><td>d</td></tr></table>'),
      ['| a   | b   |', '| --- | --- |', '| c   | d   |'].join('\n'),
    );
  });

  it('keeps every row the same width when a cell was merged', () => {
    const html =
      '<table><tr><th>a</th><th>b</th><th>c</th></tr><tr><td colspan="2">wide</td><td>z</td></tr></table>';
    assert.equal(
      htmlToMarkdown(html),
      ['| a    | b   | c   |', '| ---- | --- | --- |', '| wide |     | z   |'].join('\n'),
    );
  });

  it('carries the alignment the header row was given', () => {
    const html = '<table><tr><th align="right">n</th></tr><tr><td>1</td></tr></table>';
    // The text moves to the side it is aligned to, in the source as well as on the screen - which
    // is the whole reason a table is laid out rather than just rendered.
    assert.equal(htmlToMarkdown(html), ['|   n |', '| --: |', '|   1 |'].join('\n'));
  });

  it('escapes a pipe inside a cell rather than starting a column with it', () => {
    const html = '<table><tr><th>a|b</th></tr><tr><td>c</td></tr></table>';
    assert.equal(htmlToMarkdown(html), ['| a\\|b |', '| ---- |', '| c    |'].join('\n'));
  });

  it('does not take a nested table apart into the one round it', () => {
    const html = '<table><tr><td>outer <table><tr><td>inner</td></tr></table></td></tr></table>';
    assert.equal(htmlToMarkdown(html), ['| outer inner |', '| ----------- |'].join('\n'));
  });
});

describe('escaping', () => {
  it('escapes what would otherwise open markup', () => {
    assert.equal(htmlToMarkdown('<p>2 * 3 [see] &lt;b&gt; and `tick`</p>'), '2 \\* 3 \\[see\\] \\<b> and \\`tick\\`');
  });

  it('leaves an underscore inside a word alone and escapes one at its edge', () => {
    // `snake_case_name` is not emphasis in CommonMark, and escaping every underscore makes source
    // text nobody wants to read on the cursor line.
    assert.equal(htmlToMarkdown('<p>snake_case_name</p>'), 'snake_case_name');
    assert.equal(htmlToMarkdown('<p>_leading and trailing_</p>'), '\\_leading and trailing\\_');
  });

  it('escapes = only where it would mean a highlight', () => {
    assert.equal(htmlToMarkdown('<p>a = b</p>'), 'a = b');
    assert.equal(htmlToMarkdown('<p>a ==b== c</p>'), 'a \\=\\=b\\=\\= c');
  });

  it('escapes what would start a block, only at the start of a line', () => {
    assert.equal(htmlToMarkdown('<p># not a heading</p>'), '\\# not a heading');
    assert.equal(htmlToMarkdown('<p>- not a bullet</p>'), '\\- not a bullet');
    assert.equal(htmlToMarkdown('<p>1. not a list</p>'), '1\\. not a list');
    assert.equal(htmlToMarkdown('<p>a # b</p>'), 'a # b');
  });

  it('does not escape inside a fenced block, where the text means itself', () => {
    assert.equal(htmlToMarkdown('<pre>a * b [c]</pre>'), '```\na * b [c]\n```');
  });
});

describe('emphasis', () => {
  it('keeps the delimiters next to the words', () => {
    // `** bold **` is not bold, and a copied span very often has its spaces inside it.
    assert.equal(htmlToMarkdown('<p>a<strong> bold </strong>b</p>'), 'a **bold** b');
  });

  it('nests', () => {
    assert.equal(htmlToMarkdown('<p><strong>very <em>much</em></strong></p>'), '**very *much***');
  });

  it('reads sub and superscript', () => {
    assert.equal(htmlToMarkdown('<p>H<sub>2</sub>O and x<sup>2</sup></p>'), 'H~2~O and x^2^');
  });

  it('escapes a caret that is only a caret', () => {
    // The delimiters this file writes are markup; the same characters in copied words are not.
    assert.equal(htmlToMarkdown('<p>2^10 and a~b</p>'), '2\\^10 and a\\~b');
  });
});

describe('images', () => {
  it('writes a picture it could show', () => {
    assert.equal(
      htmlToMarkdown('<img src="https://example.com/a.png" alt="a chart">'),
      '![a chart](https://example.com/a.png)',
    );
  });

  it('leaves a pasted screenshot as its description rather than megabytes of base64', () => {
    assert.equal(htmlToMarkdown('<p><img src="data:image/png;base64,AAAA" alt="shot"></p>'), 'shot');
  });
});

describe('a table cell', () => {
  it('takes the inline markup and flattens the rest onto one line', () => {
    assert.equal(
      inlineHtmlToMarkdown('<p>see <a href="https://example.com">this</a></p><p>and that</p>'),
      'see [this](https://example.com/) and that',
    );
  });
});

describe('nothing worth pasting', () => {
  it('is the empty string, so the caller can let the plain text through', () => {
    assert.equal(htmlToMarkdown('<style>p{color:red}</style>'), '');
    assert.equal(htmlToMarkdown(''), '');
  });
});

describe('deciding whether to convert a paste at all', () => {
  const at = (doc: string, cursor: number) =>
    EditorState.create({ doc, selection: { anchor: cursor }, extensions: [markdownLanguage] });

  const HTML = '<h1>Title</h1>';
  const PLAIN = 'Title';

  it('converts in ordinary prose', () => {
    assert.equal(pasteMarkdown(at('some words', 5), HTML, PLAIN), '# Title');
  });

  it('leaves a fenced code block alone', () => {
    // Markdown means nothing in there, so a `#` written into it is markup the document never asked
    // for - and a snippet copied off a documentation page would arrive with the page's formatting
    // baked into the code.
    const doc = '```js\nconst a = 1;\n```';
    assert.equal(pasteMarkdown(at(doc, 10), HTML, PLAIN), null);
  });

  it('leaves an indented code block alone', () => {
    assert.equal(pasteMarkdown(at('    indented code', 8), HTML, PLAIN), null);
  });

  it('leaves a code span alone', () => {
    assert.equal(pasteMarkdown(at('run `the thing` now', 8), HTML, PLAIN), null);
  });

  it('leaves the markdown of a table alone', () => {
    // Those lines are the table. A heading dropped into the middle of them is neither.
    const doc = '| a   | b   |\n| --- | --- |\n| c   | d   |';
    assert.equal(pasteMarkdown(at(doc, 32), HTML, PLAIN), null);
  });

  it('does nothing when there is no HTML flavour on the clipboard', () => {
    // Which is also what Ctrl-Shift-V produces: the browser leaves it off the event.
    assert.equal(pasteMarkdown(at('words', 3), '', 'plain words'), null);
    assert.equal(pasteMarkdown(at('words', 3), '   ', 'plain words'), null);
  });

  it('does nothing when the conversion says the same thing as the plain text', () => {
    // Every paste that was already correct keeps going through CodeMirror's own path.
    assert.equal(pasteMarkdown(at('words', 3), '<p>just a sentence</p>', 'just a sentence'), null);
    assert.equal(pasteMarkdown(at('words', 3), '<p>just a sentence</p>', 'just a sentence\r\n'), null);
  });
});
