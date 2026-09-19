/**
 * The icons the editor draws without React.
 *
 * `components/Icons.tsx` is the set, and everything in the app that can use a component does. The
 * table widget and the button that gets you back from a table's markdown are built out of elements
 * rather than JSX - they live inside CodeMirror's DOM, not React's - so they need the same marks in
 * a form they can append. These are the same drawings on the same 24 grid at the same 2.2 weight;
 * change one of them and change its twin in `Icons.tsx`.
 */

const SVG = 'http://www.w3.org/2000/svg';

function svg(size: number): SVGElement {
  const element = document.createElementNS(SVG, 'svg');
  element.setAttribute('width', String(size));
  element.setAttribute('height', String(size));
  element.setAttribute('viewBox', '0 0 24 24');
  element.setAttribute('fill', 'none');
  element.setAttribute('stroke', 'currentColor');
  element.setAttribute('stroke-width', '2.2');
  element.setAttribute('stroke-linecap', 'round');
  element.setAttribute('stroke-linejoin', 'round');
  element.setAttribute('aria-hidden', 'true');
  return element;
}

function path(parent: SVGElement, d: string): void {
  const element = document.createElementNS(SVG, 'path');
  element.setAttribute('d', d);
  parent.appendChild(element);
}

function rect(parent: SVGElement, x: number, y: number, width: number, height: number, r: number): void {
  const element = document.createElementNS(SVG, 'rect');
  element.setAttribute('x', String(x));
  element.setAttribute('y', String(y));
  element.setAttribute('width', String(width));
  element.setAttribute('height', String(height));
  element.setAttribute('rx', String(r));
  parent.appendChild(element);
}

/** Twin of `PlusIcon`. */
export function plusIcon(size = 14): SVGElement {
  const element = svg(size);
  path(element, 'M12 5v14M5 12h14');
  return element;
}

/** Twin of `TextIcon`: a serif T on its baseline, the mark for the source behind something. */
export function textIcon(size = 14): SVGElement {
  const element = svg(size);
  path(element, 'M5 6.4V4.6h14v1.8');
  path(element, 'M12 4.6v14.8');
  path(element, 'M9 19.4h6');
  return element;
}

/**
 * Two panes side by side: the mark for the conflict card, and the way back to it.
 *
 * Only two strokes plus the boxes, because at 14px anything busier fills in solid at the 2.2 weight
 * every icon here is drawn on. It has no twin in `Icons.tsx`: nothing in React draws a conflict, and
 * a copy nobody renders is a copy that goes stale.
 */
export function choicesIcon(size = 14): SVGElement {
  const element = svg(size);
  rect(element, 3, 5, 7.5, 14, 1.5);
  rect(element, 13.5, 5, 7.5, 14, 1.5);
  return element;
}

/** Twin of `TableIcon`: the box, the rule under its header, one division between columns. */
export function tableIcon(size = 14): SVGElement {
  const element = svg(size);
  rect(element, 3.5, 4.5, 17, 15, 2.5);
  path(element, 'M3.5 9.8h17');
  path(element, 'M10 9.8v9.7');
  return element;
}

/** Twin of `GripIcon`: the dotted handle a row is dragged by, two columns of three. */
export function gripIcon(size = 12): SVGElement {
  const element = svg(size);
  path(element, 'M9.5 6h.01M14.5 6h.01M9.5 12h.01M14.5 12h.01M9.5 18h.01M14.5 18h.01');
  return element;
}
