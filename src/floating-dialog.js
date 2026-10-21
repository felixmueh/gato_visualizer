/** A reusable movable dialog. Callers own body content, search and actions. */
export function createFloatingDialog({ id, title, modal = false, content, onClose = () => {} } = {}) {
  if (!id || !title) throw new Error('A floating dialog needs an id and title.');
  const element = document.createElement('dialog'); element.id = id; element.className = 'floating-dialog';
  element.setAttribute('aria-labelledby', `${id}-title`);
  const header = document.createElement('header'); header.className = 'floating-dialog-header';
  const heading = document.createElement('h2'); heading.id = `${id}-title`; heading.textContent = title;
  const closeButton = document.createElement('button'); closeButton.type = 'button'; closeButton.className = 'floating-dialog-close';
  closeButton.textContent = '×'; closeButton.setAttribute('aria-label', `Close ${title}`); closeButton.title = 'Close';
  const body = document.createElement('div'); body.className = 'floating-dialog-body';
  if (content) body.append(content);
  header.append(heading, closeButton); element.append(header, body); document.body.append(element);
  let previousFocus, drag;
  function close() { if (element.open) element.close(); }
  closeButton.addEventListener('click', close);
  element.addEventListener('cancel', event => { event.preventDefault(); close(); });
  element.addEventListener('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); close(); } });
  element.addEventListener('close', () => { previousFocus?.focus?.(); onClose(); });
  header.addEventListener('pointerdown', event => {
    if (event.target.closest('button') || event.button !== 0) return;
    const rect = element.getBoundingClientRect(); drag = { x: event.clientX - rect.left, y: event.clientY - rect.top };
    header.setPointerCapture(event.pointerId); event.preventDefault();
  });
  header.addEventListener('pointermove', event => {
    if (!drag) return;
    element.style.margin = '0';
    element.style.left = `${Math.max(0, Math.min(innerWidth - 80, event.clientX - drag.x))}px`;
    element.style.top = `${Math.max(0, Math.min(innerHeight - 44, event.clientY - drag.y))}px`;
  });
  const endDrag = () => { drag = null; };
  header.addEventListener('pointerup', endDrag); header.addEventListener('lostpointercapture', endDrag);
  return { element, body, close, get isOpen() { return element.open; },
    open() { if (!element.open) { previousFocus = document.activeElement; modal ? element.showModal() : element.show(); } },
    destroy() { close(); element.remove(); },
  };
}
