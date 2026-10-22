/** A reusable movable dialog. Callers own body content, search and actions. */
export function createFloatingDialog({ id, title, modal = false, content, tabs, storage = globalThis.localStorage, onClose = () => {} } = {}) {
  if (!id || !title) throw new Error('A floating dialog needs an id and title.');
  const element = document.createElement('dialog'); element.id = id; element.className = 'floating-dialog';
  element.setAttribute('aria-labelledby', `${id}-title`);
  const header = document.createElement('header'); header.className = 'floating-dialog-header';
  const heading = document.createElement('h2'); heading.id = `${id}-title`; heading.textContent = title;
  const closeButton = document.createElement('button'); closeButton.type = 'button'; closeButton.className = 'floating-dialog-close';
  closeButton.textContent = '×'; closeButton.setAttribute('aria-label', `Close ${title}`); closeButton.title = 'Close';
  const body = document.createElement('div'); body.className = 'floating-dialog-body';
  if (content) body.append(content);
  const panels = tabs?.length ? createTabs({ id, tabs, body, storage }) : null;
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
  return { element, body, panels: panels?.panels || {}, selectTab: panels?.select || (() => {}), get activeTab() { return panels?.active; }, close, get isOpen() { return element.open; },
    open() { if (!element.open) { previousFocus = document.activeElement; modal ? element.showModal() : element.show(); } },
    destroy() { close(); element.remove(); },
  };
}

/** Tab bar plus one panel per tab; the last tab per dialog persists per viewer. */
function createTabs({ id, tabs, body, storage }) {
  const key = `floating-dialog-tab:${id}`;
  const bar = document.createElement('div'); bar.className = 'mode-tabs floating-dialog-tabs'; bar.setAttribute('role', 'tablist');
  const panels = {}, buttons = {};
  for (const tab of tabs) {
    const button = document.createElement('button'); button.type = 'button'; button.textContent = tab.label;
    button.id = `${id}-tab-${tab.id}`; button.setAttribute('role', 'tab'); if (tab.title) button.title = tab.title;
    const panel = document.createElement('div'); panel.className = 'floating-dialog-panel'; panel.id = `${id}-panel-${tab.id}`;
    panel.setAttribute('role', 'tabpanel'); panel.setAttribute('aria-labelledby', button.id); button.setAttribute('aria-controls', panel.id);
    button.addEventListener('click', () => select(tab.id));
    bar.append(button); buttons[tab.id] = button; panels[tab.id] = panel;
  }
  body.append(bar, ...Object.values(panels));
  const state = { panels, active: null, select };
  function select(tabId, { remember = true } = {}) {
    if (!panels[tabId]) return;
    state.active = tabId;
    for (const [name, panel] of Object.entries(panels)) {
      const active = name === tabId; panel.hidden = !active;
      buttons[name].classList?.toggle('active', active); buttons[name].setAttribute('aria-selected', String(active)); buttons[name].tabIndex = active ? 0 : -1;
    }
    if (remember) { try { storage?.setItem(key, tabId); } catch { /* Per-viewer convenience only. */ } }
  }
  let saved; try { saved = storage?.getItem(key); } catch { saved = null; }
  select(panels[saved] ? saved : tabs[0].id, { remember: false });
  bar.addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
    const ids = tabs.map(tab => tab.id), next = ids[(ids.indexOf(state.active) + (event.key === 'ArrowRight' ? 1 : ids.length - 1)) % ids.length];
    event.preventDefault(); select(next); buttons[next].focus?.();
  });
  return state;
}
