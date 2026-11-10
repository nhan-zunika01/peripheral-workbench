export function el(tag, className, text, attrs = {}) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = text;
  for (const [key, value] of Object.entries(attrs)) {
    if (key === 'disabled') node.disabled = !!value;
    else node.setAttribute(key, value);
  }
  return node;
}
export function button(text, action, className = 'secondary') {
  const node = el('button', className, text, { type: 'button' });
  node.addEventListener('click', action); return node;
}
export function link(text, href, className = 'text-link') { return el('a', className, text, { href }); }
export function panel(title, className = '') {
  const node = el('section', `panel ${className}`); const heading = el('h2', '', title);
  node.append(heading); return node;
}
