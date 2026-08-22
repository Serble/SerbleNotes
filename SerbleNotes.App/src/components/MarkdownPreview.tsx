import DOMPurify from 'dompurify';
import { marked } from 'marked';
import { useEffect, useMemo, useRef } from 'react';
import { copyText } from '../services/clipboard';

marked.setOptions({ breaks: true, gfm: true });

/** Long enough to be read, short enough that it is gone before you look again. */
const CONFIRM_MS = 1400;

/**
 * Notes are markdown written by the user, so the rendered HTML is sanitised before it goes near the
 * DOM. The content is decrypted locally, which makes this the one place it becomes markup.
 */
export function MarkdownPreview({ text }: { text: string }) {
  const html = useMemo(() => DOMPurify.sanitize(marked.parse(text) as string), [text]);
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

  return <div className="markdown" ref={host} dangerouslySetInnerHTML={{ __html: html }} />;
}
