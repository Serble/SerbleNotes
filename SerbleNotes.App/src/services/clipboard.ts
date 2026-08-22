/**
 * Putting text on the clipboard, wherever the app is running.
 *
 * `navigator.clipboard` is the right answer and is not always available: it needs a secure context,
 * which a plain-http deployment is not, and WebKit refuses it outright in some embeddings. The old
 * `execCommand` route still works in all of them, so a client that cannot copy at all is not a state
 * anybody has to end up in. The caller is told which happened rather than being left to assume.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Fall through to the old way rather than giving up.
  }

  try {
    const holder = document.createElement('textarea');
    holder.value = text;
    // Off-screen rather than hidden: a display:none element cannot be selected, and selecting it is
    // the whole mechanism. `readOnly` keeps the mobile keyboard from appearing for the instant it
    // holds focus.
    holder.setAttribute('readonly', '');
    holder.style.position = 'fixed';
    holder.style.top = '-1000px';
    holder.style.opacity = '0';

    document.body.appendChild(holder);
    holder.select();
    const copied = document.execCommand('copy');
    holder.remove();

    return copied;
  } catch {
    return false;
  }
}

/**
 * Reading the clipboard back, which is a harder thing to be allowed to do than writing to it: the
 * page is asking for something the user put there for somebody else, so browsers gate it behind a
 * secure context and, in some of them, a permission prompt. There is no old `execCommand` route to
 * fall back on - it was removed for exactly that reason.
 *
 * Null therefore means "this app cannot read the clipboard here", not "the clipboard is empty", and
 * the caller has to say so: the keyboard shortcut and the platform's own paste still work, and
 * telling somebody that is more use than a menu item that quietly does nothing.
 */
export async function readText(): Promise<string | null> {
  try {
    return await navigator.clipboard.readText();
  } catch {
    return null;
  }
}
