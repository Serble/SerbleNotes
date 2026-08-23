import { marked } from 'marked';
import { findConflicts } from './conflicts';
import { useEffect, useMemo, useRef } from 'react';
import { copyText } from '../services/clipboard';
import { bindLinks, cssIn, sanitiseHtml, scopeCss } from './noteHtml';

marked.setOptions({ breaks: true, gfm: true });

/**
 * A task list's box, drawn rather than being an `<input>`.
 *
 * marked renders `- [x]` as a disabled checkbox, and a form control is exactly what a note is not
 * allowed to put on this page - noteHtml.ts refuses `<input>`, so left alone the box would simply
 * vanish and the list would read as an ordinary one. This is the same span the editor draws
 * (`TaskWidget` in livePreview.ts), styled to match by `.md-task` in index.css: no font needed, no
 * focus to take, and the same shape on every device.
 *
 * It is not tickable here. The preview shows a *version* of a note - what it said at a point in the
 * past - and ticking a box in a document you are only reading would either do nothing or edit
 * history. The editor is where a task gets finished.
 */
marked.use({
  renderer: {
    checkbox: ({ checked }) => `<span class="md-task${checked ? ' md-task-done' : ''}"></span>`,
  },
});

/** A list item that is a checkbox and nothing else. */
const EMPTY_TASK = /^(\s*(?:[-*+]|\d+[.)])\s+\[[ xX]\])$/;
const FENCE = /^\s*(```|~~~)/;

/**
 * Gives an empty checkbox the trailing space both parsers want.
 *
 * `- [ ]` with nothing after it is not a task list item to marked, exactly as it is not one to
 * `@lezer/markdown` - both ask for a space after the `]`. The editor's parser was relaxed to accept
 * the end of the line instead (see the Tasks extension in markdownLanguage.ts), because the empty
 * box is the first thing anyone types; this is the same relaxation for the one renderer this app
 * does not own. Doing it as text rather than as a tokenizer keeps the two parsers' rules in one
 * shape each rather than one shape and one fork.
 *
 * Fenced blocks are skipped, because a line inside one is not a list item however it reads.
 */
function completeEmptyTasks(text: string): string {
  let fenced = false;

  return text
    .split('\n')
    .map((line) => {
      if (FENCE.test(line)) {
        fenced = !fenced;
        return line;
      }
      return !fenced && EMPTY_TASK.test(line) ? `${line} ` : line;
    })
    .join('\n');
}

/**
 * Marks up a conflict so it reads as one rather than as a heading.
 *
 * This renderer shows what a note said at a point in the past, and a version written during a merge
 * has conflict markers in it. Left alone they are bad markdown: a lone `=======` under a line of
 * prose is a setext heading, so the note draws half of the conflict as a title, at the size a title
 * gets. The editor replaces the whole region with a card offering the choice (`conflictView.ts`);
 * nothing can be resolved *here*, because this is a version that has already happened, so the region
 * is just wrapped in a block that renders it as the literal text it is.
 *
 * Every line is kept exactly as written, markers included. An old version showing something other
 * than what it said would be worse than one that renders plainly.
 */
function fenceConflicts(text: string): string {
  const conflicts = findConflicts(text);
  if (conflicts.length === 0) {
    return text;
  }

  let out = '';
  let at = 0;
  for (const conflict of conflicts) {
    out += text.slice(at, conflict.from);
    out += `\n\`\`\`conflict\n${text.slice(conflict.from, conflict.to)}\n\`\`\`\n`;
    at = conflict.to;
  }

  return out + text.slice(at);
}

/** Long enough to be read, short enough that it is gone before you look again. */
const CONFIRM_MS = 1400;

let scopes = 0;

/**
 * Notes are markdown written by the user, so the rendered HTML is sanitised before it goes near the
 * DOM. The content is decrypted locally, which makes this the one place it becomes markup.
 *
 * What a note may say here is what it may say in the editor - noteHtml.ts decides for both, so a
 * version read in the history panel is the same document it was while it was being written. That
 * includes its own CSS, which is scoped to this preview: a note in a panel does not restyle the app
 * around it, and two notes on screen at once do not reach each other.
 */
export function MarkdownPreview({ text }: { text: string }) {
  const scope = useMemo(() => `preview-${(scopes += 1)}`, []);
  const rendered = useMemo(() => {
    const raw = marked.parse(fenceConflicts(completeEmptyTasks(text))) as string;
    return {
      html: sanitiseHtml(raw),
      css: scopeCss(cssIn(raw), `[data-note-css="${scope}"]`),
    };
  }, [text, scope]);
  const html = rendered.html;
  const host = useRef<HTMLDivElement>(null);

  /**
   * A copy button on every code block, the same one the editor puts on the block you are looking at.
   *
   * It is added afterwards rather than by the markdown renderer, because everything the renderer
   * produces goes through the sanitiser and a button is exactly the sort of thing that has no
   * business surviving it. Building it here keeps the rule simple: markup from a note is inert, and
   * anything interactive on the page was put there by this app.
   */
  useEffect(() => {
    const container = host.current;
    if (!container) {
      return;
    }

    // A link in a note opens in a browser. Left alone it would replace this app with the page it
    // points at, and there is no back button in a webview.
    bindLinks(container);

    const timers: number[] = [];
    /** Worked out from the first button and reused: every one of them is the same size. */
    let gutter: number | null = null;

    for (const block of container.querySelectorAll('pre')) {
      // Read the code before the button is anywhere near it, or "Copy" ends up on the clipboard too.
      const source = block.textContent ?? '';
      if (source === '') {
        continue;
      }

      // `pre` scrolls sideways, so a button inside it would slide off with the code. The wrapper is
      // what the button sits in the corner of.
      const wrapper = document.createElement('div');
      wrapper.className = 'code-block';
      block.replaceWith(wrapper);
      wrapper.appendChild(block);

      const button = document.createElement('button');
      button.className = 'copy-code';
      button.type = 'button';
      button.textContent = 'Copy';

      button.addEventListener('click', () => {
        void copyText(source).then((copied) => {
          button.textContent = copied ? 'Copied' : 'Cannot copy';
          button.classList.toggle('done', copied);
          button.classList.toggle('failed', !copied);

          timers.push(
            window.setTimeout(() => {
              button.textContent = 'Copy';
              button.classList.remove('done', 'failed');
            }, CONFIRM_MS),
          );
        });
      });

      wrapper.appendChild(button);

      // Room for the button along the right of the block, so it is never sitting on top of the code.
      // It has to be padding rather than a minimum width: the card is as wide as its widest line, so
      // without this the line simply runs underneath the button. Padding is part of what `max-content`
      // measures, so reserving it also makes the card that much wider.
      //
      // In the editor the button has the block's opening fence line to itself and needs no gutter;
      // here there is no such row, and adding one would be a header the note does not have.
      if (gutter === null) {
        const inset = parseFloat(getComputedStyle(button).right) || 0;
        const label = button.textContent;
        // Measured at the longest thing it ever says, so the card does not move when it says it.
        button.textContent = 'Cannot copy';
        gutter = Math.ceil(button.getBoundingClientRect().width + inset * 3);
        button.textContent = label;
      }
      block.style.paddingRight = `${gutter}px`;
    }

    return () => timers.forEach((timer) => window.clearTimeout(timer));
  }, [html]);

  return (
    <>
      {rendered.css !== '' && <style>{rendered.css}</style>}
      <div
        className="markdown"
        data-note-css={scope}
        ref={host}
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </>
  );
}
