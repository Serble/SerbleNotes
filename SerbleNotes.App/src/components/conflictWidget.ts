import { WidgetType, type EditorView } from '@codemirror/view';
import {
  resolveConflict,
  toggleConflictText,
  type Conflict,
  type Resolution,
} from './conflicts';
import { choicesIcon, textIcon } from './domIcons';

/**
 * A merge conflict, drawn as the choice it actually is.
 *
 * Two versions of the same passage, side by side, and a button under each that keeps it. What the
 * markers were asking for was that somebody read a notation from a version control tool and then
 * deleted exactly the right seven characters in three places without deleting anything else. This
 * asks them to point at the paragraph they want.
 *
 * Three things about it are decisions rather than details:
 *
 * - **Nothing is preselected and nothing is recommended.** The app has no idea which version is the
 *   one the person wanted, and a highlighted "suggested" side would be a guess dressed as an
 *   answer. See "Inform, never forbid" - both sides are shown equally and the user chooses.
 * - **"Keep both" exists** because it is what people actually want surprisingly often, and doing it
 *   by hand means resolving the conflict and then retyping the half that was thrown away.
 * - **The markers are always reachable.** The "Text" button puts the region back to what it says,
 *   the same control a table has for the same reason: a drawn thing that cannot be seen as its
 *   source is a thing you cannot check or fix by hand.
 */
export class ConflictWidget extends WidgetType {
  constructor(readonly conflict: Conflict) {
    super();
  }

  eq(other: ConflictWidget): boolean {
    return (
      other.conflict.from === this.conflict.from &&
      other.conflict.ours === this.conflict.ours &&
      other.conflict.theirs === this.conflict.theirs &&
      other.conflict.original === this.conflict.original
    );
  }

  toDOM(view: EditorView): HTMLElement {
    const card = document.createElement('div');
    card.className = 'cm-conflict';
    // The document is contenteditable and this is not part of it: without this the caret can be put
    // between two sides of a choice, where there is no text for it to be in.
    card.contentEditable = 'false';
    card.dataset.from = String(this.conflict.from);

    const head = document.createElement('div');
    head.className = 'cm-conflict-head';

    const title = document.createElement('span');
    title.className = 'cm-conflict-title';
    title.textContent = 'Edited in two places';
    head.appendChild(title);

    const explain = document.createElement('span');
    explain.className = 'cm-conflict-note';
    explain.textContent = 'Pick the version to keep.';
    head.appendChild(explain);

    head.appendChild(this.textButton(view));
    card.appendChild(head);

    const sides = document.createElement('div');
    sides.className = 'cm-conflict-sides';
    sides.appendChild(this.side(view, 'This device', this.conflict.ours, 'ours'));
    sides.appendChild(this.side(view, 'Other device', this.conflict.theirs, 'theirs'));
    card.appendChild(sides);

    const foot = document.createElement('div');
    foot.className = 'cm-conflict-foot';
    foot.appendChild(this.action(view, 'Keep both', 'both', 'Keep this device\'s version, then the other one.'));

    if (this.conflict.original !== null) {
      foot.appendChild(
        this.action(
          view,
          'Keep neither',
          'original',
          'Go back to what both versions started from, discarding both edits.',
        ),
      );
    }

    card.appendChild(foot);
    return card;
  }

  /** One side of the choice: what it says, and a button that keeps it. */
  private side(view: EditorView, label: string, text: string, choice: Resolution): HTMLElement {
    const side = document.createElement('div');
    side.className = 'cm-conflict-side';

    const heading = document.createElement('div');
    heading.className = 'cm-conflict-label';
    heading.textContent = label;
    side.appendChild(heading);

    const body = document.createElement('pre');
    body.className = 'cm-conflict-text';
    // An empty side means that version deleted the passage, which is a real answer to the question
    // and has to be legible as one rather than as an empty box.
    if (text === '') {
      body.classList.add('cm-conflict-empty');
      body.textContent = '(nothing - this version deleted it)';
    } else {
      body.textContent = text;
    }
    side.appendChild(body);

    side.appendChild(this.action(view, 'Keep this', choice, `Replace the conflict with the ${label.toLowerCase()} version.`));
    return side;
  }

  private action(view: EditorView, label: string, choice: Resolution, title: string): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'cm-conflict-button';
    button.textContent = label;
    button.title = title;
    // Unlike the floating controls elsewhere in the editor this does not preventDefault on
    // mousedown: there is no cell being typed in whose blur has to land first, and letting the
    // button take focus normally is what makes it reachable by keyboard.
    button.addEventListener('click', (event) => {
      event.preventDefault();
      resolveConflict(view, this.conflict, choice);
    });
    return button;
  }

  /** The way back to the markers, the twin of a table's "Text" button. */
  private textButton(view: EditorView): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'cm-conflict-button cm-conflict-text-toggle';
    button.title = 'Show the conflict markers as they are written in the note.';
    button.appendChild(textIcon());
    const label = document.createElement('span');
    label.textContent = 'Text';
    button.appendChild(label);

    button.addEventListener('click', (event) => {
      event.preventDefault();
      view.dispatch({ effects: toggleConflictText.of(this.conflict.from) });
      view.focus();
    });
    return button;
  }

  /**
   * Everything in here is the widget's own. CodeMirror does not deliver events it has been told to
   * ignore, which is why the buttons above listen for themselves.
   */
  ignoreEvent(): boolean {
    return true;
  }
}

/**
 * The way back from a conflict's markers to the card.
 *
 * The "Text" button lives in the card's header, and once the card is gone so is the button - which
 * left the source with no way out of it at all. This is the same control in its other state, and it
 * sits in the same place: a bar directly above the region, its button on the right, where the one
 * that got you here was.
 *
 * A block widget rather than something floating over the text, unlike the button that gets you back
 * from a table's markdown. That one has to be positioned because it sits *on* the last line of the
 * band; this has a line of its own, so there is nothing to measure and nothing to keep in step when
 * the region moves.
 */
export class ConflictSourceBar extends WidgetType {
  constructor(readonly from: number) {
    super();
  }

  eq(other: ConflictSourceBar): boolean {
    return other.from === this.from;
  }

  toDOM(view: EditorView): HTMLElement {
    const bar = document.createElement('div');
    bar.className = 'cm-conflict-bar';
    bar.contentEditable = 'false';

    const label = document.createElement('span');
    label.className = 'cm-conflict-note';
    label.textContent = 'Conflict, as it is written in the note.';
    bar.appendChild(label);

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'cm-conflict-button';
    button.title = 'Go back to picking a version to keep.';
    button.appendChild(choicesIcon());
    const text = document.createElement('span');
    text.textContent = 'Resolve';
    button.appendChild(text);

    button.addEventListener('click', (event) => {
      event.preventDefault();
      view.dispatch({ effects: toggleConflictText.of(this.from) });
      view.focus();
    });

    bar.appendChild(button);
    return bar;
  }

  ignoreEvent(): boolean {
    return true;
  }
}
