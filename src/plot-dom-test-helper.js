/** Minimal ordinary DOM for renderer/inspector workflow tests, without GPU/server. */
export function plotDOM() {
  class Element {
    constructor(tag, doc) { this.tagName = tag.toUpperCase(); this.ownerDocument = doc; this.children = []; this.listeners = new Map(); this.attributes = {}; this.dataset = {}; this.style = {}; this.value = ''; this.checked = false; this.open = false; this.hidden = false; this.clientWidth = 600; this.className = ''; this.classList = { toggle: (name, force) => { const list = new Set(this.className.split(' ')); const value = force ?? !list.has(name); value ? list.add(name) : list.delete(name); this.className = [...list].join(' '); return value; } }; }
    append(...nodes) { for (const node of nodes) { node.parentElement = this; this.children.push(node); } }
    replaceChildren(...nodes) { this.children.forEach(node => node.parentElement = null); this.children = []; this.append(...nodes); }
    setAttribute(key, value) { this.attributes[key] = String(value); }
    getAttribute(key) { return this.attributes[key]; }
    addEventListener(type, fn) { const list = this.listeners.get(type) || []; list.push(fn); this.listeners.set(type, list); }
    async emit(type, event = {}) { const ev = { target: this, preventDefault() {}, stopPropagation() {}, ...event }; for (const fn of this.listeners.get(type) || []) await fn(ev); }
    matches(selector) { if (selector === '[data-instance]') return this.dataset.instance != null; if (selector.startsWith('.')) return this.className.split(' ').includes(selector.slice(1)); return this.tagName.toLowerCase() === selector; }
    closest(selector) { return this.matches(selector) ? this : this.parentElement?.closest(selector); }
    querySelectorAll(selector) { return this.children.flatMap(child => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]); }
    querySelector(selector) { return this.querySelectorAll(selector)[0]; }
    getBoundingClientRect() { return { left: 0, top: 0, width: 600, height: 200 }; }
    show() { this.open = true; this.method = 'show'; }
    showModal() { this.open = true; this.method = 'showModal'; }
    close() { this.open = false; this.emit('close'); }
    remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(item => item !== this); this.parentElement = null; }
    focus() { this.ownerDocument.activeElement = this; }
  }
  const doc = { createElement: tag => new Element(tag, doc), createElementNS: (_ns, tag) => new Element(tag, doc) };
  doc.body = doc.createElement('body'); doc.activeElement = doc.body;
  return { document: doc, Element, find: (root, tag, text) => root.querySelectorAll(tag).find(item => item.textContent === text) };
}
