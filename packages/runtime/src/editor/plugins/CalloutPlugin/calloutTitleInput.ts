/**
 * Edits a callout's title in place: an input swapped into the header. Enter
 * or leaving saves, Escape cancels, and an empty title goes back to the
 * type's name. DOM-only, so the node can use it without importing the menu.
 */

export function openCalloutTitleInput(
  header: HTMLElement,
  current: { title: string; label: string },
  onCommit: (title: string) => void,
): void {
  if (header.querySelector('input')) return;
  const input = document.createElement('input');
  input.className = 'callout-title-input';
  input.value = current.title;
  input.placeholder = current.label;
  input.setAttribute('data-testid', 'callout-title-input');
  let done = false;
  const finish = (commit: boolean) => {
    if (done) return;
    done = true;
    const next = input.value.trim();
    // A saved title redraws the header from the node; otherwise restore it here.
    if (commit && next !== current.title) onCommit(next);
    else header.textContent = current.title || current.label;
  };
  // Clicks in the input are for the text, not the header's handlers.
  input.addEventListener('mousedown', (event) => event.stopPropagation());
  input.addEventListener('click', (event) => event.stopPropagation());
  input.addEventListener('keydown', (event) => {
    event.stopPropagation();
    if (event.key === 'Enter') {
      event.preventDefault();
      finish(true);
    }
    if (event.key === 'Escape') finish(false);
  });
  input.addEventListener('blur', () => finish(true));
  header.replaceChildren(input);
  input.focus();
  input.select();
}
