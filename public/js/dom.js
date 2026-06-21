export const $ = (id) => document.getElementById(id);

export function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.add('hidden'), 1800);
}

export function button(text, onclick, cls = '') {
  const b = document.createElement('button');
  b.className = 'btn ' + cls;
  b.textContent = text;
  b.onclick = onclick;
  return b;
}

export function escapeHtml(str) {
  return String(str).replace(/[&<>"]/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
  }[c]));
}
