/** As many as are worth reading before the list stops being information and starts being noise. */
const LIMIT = 8;

/**
 * The list both archive dialogs use to say what happened to individual files: what was left alone,
 * what could not be read, what was not a note. Each line is the name and the reason, because a count
 * on its own ("3 skipped") tells the user something went wrong without telling them what.
 */
export function EntryList({
  title,
  items,
}: {
  title: string;
  items: { name: string; reason: string }[];
}) {
  if (items.length === 0) {
    return null;
  }

  return (
    <>
      <p className="small">{title}</p>
      <ul className="modal-list archive-list">
        {items.slice(0, LIMIT).map((item) => (
          <li key={item.name}>
            <code>{item.name}</code> <span className="muted">- {item.reason}</span>
          </li>
        ))}
        {items.length > LIMIT && <li className="muted">and {items.length - LIMIT} more</li>}
      </ul>
    </>
  );
}
