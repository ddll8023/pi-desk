/** 网页元素选择脚本：固定源码在隔离世界运行，不接收页面提供的脚本或桥接能力。 */
export const ELEMENT_PICKER_WORLD = 1001

export const ELEMENT_PICKER_START = String.raw`(() => {
  const key = '__piDeskElementPicker';
  if (window[key]) return { ok: false, error: '当前页面已有元素选取操作。' };
  return new Promise((resolve) => {
    const controller = new AbortController();
    const options = { capture: true, signal: controller.signal };
    const box = document.createElement('div');
    box.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483647;border:2px solid #e11d48;background:rgba(225,29,72,.12);box-sizing:border-box;display:none;margin:0;padding:0';
    (document.documentElement || document.body).appendChild(box);
    let done = false;
    let target = null;
    const state = { cancel: () => finish(null), check: null };
    window[key] = state;
    const remove = () => { controller.abort(); box.remove(); };
    const escape = (s) => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    const selectedAt = (event) => document.elementFromPoint(event.clientX, event.clientY);
    function finish(element) {
      if (done) return;
      done = true;
      remove();
      if (!element || !element.isConnected) {
        delete window[key];
        resolve({ ok: false, error: '元素选择已取消。', cancelled: true });
        return;
      }
      try {
        const bounds = element.getBoundingClientRect();
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        const left = Math.max(0, Math.min(vw, bounds.left));
        const top = Math.max(0, Math.min(vh, bounds.top));
        const right = Math.max(0, Math.min(vw, bounds.right));
        const bottom = Math.max(0, Math.min(vh, bounds.bottom));
        if (!(vw > 0 && vh > 0 && right > left && bottom > top)) throw new Error('所选元素不在可见视口中。');
        const tag = /^[a-z][a-z0-9-]*$/.test(element.localName) ? element.localName : 'element';
        const sensitive = /^(input|textarea|select|option|script|style|iframe|canvas)$/.test(tag) || element.isContentEditable;
        const attrs = ['id', 'class', 'role', 'aria-label'].map(name => {
          const value = element.getAttribute(name);
          return value ? ' ' + name + '="' + escape(value.slice(0, 256)) + '"' : '';
        }).join('');
        const directText = sensitive ? '' : Array.from(element.childNodes).filter(node => node.nodeType === 3)
          .map(node => node.textContent || '').join(' ').trim().slice(0, 512);
        const html = ('<' + tag + attrs + '>' + escape(directText) + '</' + tag + '>').slice(0, 4096);
        const style = getComputedStyle(element);
        const names = ['display','position','width','height','margin','padding','color','background-color',
          'font-family','font-size','font-weight','line-height','border','border-radius','gap','align-items','justify-content'];
        const styles = names.map(name => name + ': ' + style.getPropertyValue(name).slice(0, 160) + ';').join('\n').slice(0, 4096);
        const warning = /^(iframe|canvas)$/.test(tag) ? '只能选取该容器，无法读取其内部元素。' : null;
        let changed = false;
        const observer = new MutationObserver(() => { changed = true; });
        observer.observe(document.documentElement, { attributes: true, characterData: true, childList: true, subtree: true });
        const dirty = () => { changed = true; };
        window.addEventListener('scroll', dirty, true);
        window.addEventListener('resize', dirty, true);
        const initialUrl = location.href;
        const dispose = () => {
          observer.disconnect();
          window.removeEventListener('scroll', dirty, true);
          window.removeEventListener('resize', dirty, true);
          delete window[key];
        };
        state.cancel = () => { changed = true; dispose(); };
        state.check = () => {
          const next = element.getBoundingClientRect();
          const valid = !changed && observer.takeRecords().length === 0 && element.isConnected && location.href === initialUrl
            && window.innerWidth === vw && window.innerHeight === vh
            && Math.abs(next.left - bounds.left) < 0.5 && Math.abs(next.top - bounds.top) < 0.5
            && Math.abs(next.width - bounds.width) < 0.5 && Math.abs(next.height - bounds.height) < 0.5;
          dispose();
          return valid;
        };
        resolve({ ok: true, element: { x: left / vw, y: top / vh, width: (right - left) / vw,
          height: (bottom - top) / vh, html, styles, warning } });
      } catch (error) {
        delete window[key];
        resolve({ ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    }
    document.addEventListener('pointermove', event => {
      if (!event.isTrusted) return;
      target = selectedAt(event);
      if (!target || target === box) { box.style.display = 'none'; return; }
      const r = target.getBoundingClientRect();
      box.style.display = 'block';
      box.style.left = r.left + 'px'; box.style.top = r.top + 'px';
      box.style.width = r.width + 'px'; box.style.height = r.height + 'px';
    }, options);
    document.addEventListener('pointerdown', event => {
      if (event.isTrusted) { event.preventDefault(); event.stopImmediatePropagation(); }
    }, options);
    document.addEventListener('click', event => {
      if (!event.isTrusted) return;
      event.preventDefault(); event.stopImmediatePropagation();
      finish(selectedAt(event));
    }, options);
    document.addEventListener('keydown', event => {
      if (event.isTrusted && event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); finish(null); }
    }, options);
    window.addEventListener('scroll', () => finish(null), options);
    window.addEventListener('resize', () => finish(null), options);
  });
})()`

export const ELEMENT_PICKER_CANCEL = String.raw`(() => { const state = window.__piDeskElementPicker; if (state) state.cancel(); })()`
export const ELEMENT_PICKER_CHECK = String.raw`(() => { const state = window.__piDeskElementPicker; return !!state && typeof state.check === 'function' && state.check(); })()`
