(() => {
  if (window.__vipseeHostAgentInstalled) {
    notifyReady();
    return;
  }
  window.__vipseeHostAgentInstalled = true;

  const cursorRootId = '__vipsee_remote_cursor_root';
  const vendorPattern = /(1password|lastpass|dashlane|bitwarden)/i;
  const directSelectors = [
    'iframe[src^="chrome-extension://"]',
    'iframe[src^="moz-extension://"]',
    'iframe[src^="safari-web-extension://"]',
    'com-1password-button',
    'com-1password-inline-menu',
    'com-1password-notification',
    '[data-lastpass-root]',
    '[data-lastpass-icon-root]',
    '[data-dashlanecreated]',
    '[data-bitwarden-watching]'
  ];
  const nonTextInputTypes = new Set([
    'button', 'checkbox', 'color', 'file', 'hidden', 'image', 'radio',
    'range', 'reset', 'submit'
  ]);
  const state = {
    pointerX: 0,
    pointerY: 0,
    lastDownTarget: null,
    lastHoverTarget: null
  };

  const inputValueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  const textareaValueSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
  const selectValueSetter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;

  function getModifiers(bitmask = 0) {
    return {
      altKey: Boolean(bitmask & 1),
      ctrlKey: Boolean(bitmask & 2),
      metaKey: Boolean(bitmask & 4),
      shiftKey: Boolean(bitmask & 8)
    };
  }

  function getViewport() {
    const vv = window.visualViewport;
    return {
      width: window.innerWidth || document.documentElement.clientWidth || 0,
      height: window.innerHeight || document.documentElement.clientHeight || 0,
      devicePixelRatio: window.devicePixelRatio || 1,
      visualViewportWidth: vv ? vv.width : null,
      visualViewportHeight: vv ? vv.height : null,
      visualViewportOffsetLeft: vv ? vv.offsetLeft : null,
      visualViewportOffsetTop: vv ? vv.offsetTop : null,
      visualViewportScale: vv ? vv.scale : null
    };
  }

  function notifyReady() {
    chrome.runtime.sendMessage({
      action: 'pageAgentReady',
      ...getViewport()
    }).catch(() => {});
  }

  function notifyViewport() {
    chrome.runtime.sendMessage({
      action: 'pageAgentViewport',
      ...getViewport()
    }).catch(() => {});
  }

  function getClassName(el) {
    return typeof el?.className === 'string' ? el.className : '';
  }

  function shouldSuppress(el) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;

    const tagName = String(el.tagName || '').toLowerCase();
    if (tagName.startsWith('com-1password')) return true;

    if (tagName === 'iframe') {
      const src = String(el.getAttribute('src') || '');
      if (/^(chrome-extension|moz-extension|safari-web-extension):/i.test(src)) {
        return true;
      }
    }

    const idText = String(el.id || '');
    if (vendorPattern.test(idText) || vendorPattern.test(getClassName(el))) {
      return true;
    }

    if (!el.getAttributeNames) return false;
    for (const attrName of el.getAttributeNames()) {
      const attrValue = String(el.getAttribute(attrName) || '');
      if (vendorPattern.test(attrName) || vendorPattern.test(attrValue)) {
        return true;
      }
    }

    return false;
  }

  function suppressElement(el) {
    if (!shouldSuppress(el)) return false;
    el.style?.setProperty('display', 'none', 'important');
    el.style?.setProperty('visibility', 'hidden', 'important');
    el.style?.setProperty('opacity', '0', 'important');
    el.style?.setProperty('pointer-events', 'none', 'important');
    el.setAttribute('data-vipsee-suppressed', '1');
    return true;
  }

  function scanForInjectedUi(root) {
    if (!root) return 0;
    const seen = new Set();
    let suppressed = 0;

    const visit = (el) => {
      if (!el || seen.has(el)) return;
      seen.add(el);
      if (suppressElement(el)) suppressed++;
    };

    if (root.nodeType === Node.ELEMENT_NODE) {
      visit(root);
    }

    if (!root.querySelectorAll) return suppressed;

    for (const selector of directSelectors) {
      for (const el of root.querySelectorAll(selector)) {
        visit(el);
      }
    }

    for (const el of root.querySelectorAll('iframe, [id], [class]')) {
      visit(el);
    }

    return suppressed;
  }

  function ensureCursor() {
    if (!document.documentElement) return null;

    let root = document.getElementById(cursorRootId);
    if (root) return root;

    root = document.createElement('div');
    root.id = cursorRootId;
    root.setAttribute('aria-hidden', 'true');
    root.style.position = 'fixed';
    root.style.left = '0';
    root.style.top = '0';
    root.style.width = '18px';
    root.style.height = '18px';
    root.style.pointerEvents = 'none';
    root.style.zIndex = '2147483647';
    root.style.opacity = '0';
    root.style.transform = 'translate(-9999px, -9999px)';
    root.style.transition = 'opacity 80ms linear';
    root.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 18 18"><circle cx="9" cy="9" r="4.5" fill="rgba(255,255,255,0.92)" stroke="#111111" stroke-width="1.5"/><circle cx="9" cy="9" r="1.6" fill="#ff4d4f"/><path d="M9 1.5v3M9 13.5v3M1.5 9h3M13.5 9h3" stroke="#111111" stroke-width="1.4" stroke-linecap="round"/></svg>';
    document.documentElement.appendChild(root);
    return root;
  }

  function updateCursor(x, y, visible = true) {
    const root = ensureCursor();
    if (!root) return;
    root.style.transform = `translate(${Math.round(x - 9)}px, ${Math.round(y - 9)}px)`;
    root.style.opacity = visible ? '1' : '0';
  }

  function normalizeTarget(target) {
    if (!target) return null;
    if (target.nodeType === Node.TEXT_NODE) return target.parentElement;
    return target;
  }

  function elementFromPointDeep(x, y) {
    let target = normalizeTarget(document.elementFromPoint(x, y));
    let previous = null;

    while (target?.shadowRoot && target !== previous) {
      previous = target;
      const inner = normalizeTarget(target.shadowRoot.elementFromPoint(x, y));
      if (!inner || inner === target) break;
      target = inner;
    }

    return target;
  }

  function getInteractiveTarget(target) {
    return normalizeTarget(target)?.closest(
      'button, a[href], input, select, textarea, label, summary, [role="button"], [contenteditable=""], [contenteditable="true"]'
    ) || normalizeTarget(target);
  }

  function isEditable(target) {
    if (!target || target.disabled || target.readOnly) return false;
    if (target.isContentEditable) return true;
    const tagName = String(target.tagName || '').toLowerCase();
    if (tagName === 'textarea') return true;
    if (tagName === 'input') {
      const type = String(target.type || 'text').toLowerCase();
      return !nonTextInputTypes.has(type);
    }
    return false;
  }

  function focusElement(target) {
    if (!target || typeof target.focus !== 'function') return;
    try {
      target.focus({ preventScroll: true });
    } catch (e) {
      try {
        target.focus();
      } catch (err) {}
    }
  }

  function setElementValue(target, value) {
    const tagName = String(target.tagName || '').toLowerCase();
    if (tagName === 'textarea' && textareaValueSetter) {
      textareaValueSetter.call(target, value);
      return true;
    }
    if (tagName === 'input' && inputValueSetter) {
      inputValueSetter.call(target, value);
      return true;
    }
    if (tagName === 'select' && selectValueSetter) {
      selectValueSetter.call(target, value);
      return true;
    }
    return false;
  }

  function dispatchInputEvent(target, inputType, data = null) {
    let evt;
    try {
      evt = new InputEvent('input', {
        bubbles: true,
        cancelable: true,
        data,
        inputType
      });
    } catch (e) {
      evt = new Event('input', { bubbles: true, cancelable: true });
    }
    target.dispatchEvent(evt);
  }

  function dispatchChangeEvent(target) {
    target.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function insertTextIntoEditable(target, text) {
    if (!target || typeof text !== 'string') return false;
    focusElement(target);

    if (target.isContentEditable) {
      const selection = window.getSelection();
      if (!selection) return false;
      if (!selection.rangeCount) {
        const range = document.createRange();
        range.selectNodeContents(target);
        range.collapse(false);
        selection.removeAllRanges();
        selection.addRange(range);
      }
      const range = selection.getRangeAt(0);
      range.deleteContents();
      const node = document.createTextNode(text);
      range.insertNode(node);
      range.setStartAfter(node);
      range.setEndAfter(node);
      selection.removeAllRanges();
      selection.addRange(range);
      dispatchInputEvent(target, 'insertText', text);
      return true;
    }

    const value = String(target.value || '');
    const start = typeof target.selectionStart === 'number' ? target.selectionStart : value.length;
    const end = typeof target.selectionEnd === 'number' ? target.selectionEnd : start;
    const nextValue = value.slice(0, start) + text + value.slice(end);
    if (!setElementValue(target, nextValue)) return false;

    const cursor = start + text.length;
    try {
      target.setSelectionRange(cursor, cursor);
    } catch (e) {}

    dispatchInputEvent(target, 'insertText', text);
    return true;
  }

  function deleteSelectionFromEditable(target, direction) {
    if (!target || !isEditable(target)) return false;
    focusElement(target);

    if (target.isContentEditable) {
      const selection = window.getSelection();
      if (!selection || !selection.rangeCount) return false;
      const range = selection.getRangeAt(0);
      if (range.collapsed) {
        return false;
      }
      range.deleteContents();
      dispatchInputEvent(target, direction === 'backward' ? 'deleteContentBackward' : 'deleteContentForward', null);
      return true;
    }

    const value = String(target.value || '');
    let start = typeof target.selectionStart === 'number' ? target.selectionStart : value.length;
    let end = typeof target.selectionEnd === 'number' ? target.selectionEnd : start;

    if (start === end) {
      if (direction === 'backward' && start > 0) {
        start -= 1;
      } else if (direction === 'forward' && end < value.length) {
        end += 1;
      } else {
        return false;
      }
    }

    const nextValue = value.slice(0, start) + value.slice(end);
    if (!setElementValue(target, nextValue)) return false;
    try {
      target.setSelectionRange(start, start);
    } catch (e) {}
    dispatchInputEvent(target, direction === 'backward' ? 'deleteContentBackward' : 'deleteContentForward', null);
    return true;
  }

  function moveCaret(target, key, shiftKey) {
    if (!target || !isEditable(target) || target.isContentEditable) return false;
    const value = String(target.value || '');
    const start = typeof target.selectionStart === 'number' ? target.selectionStart : value.length;
    const end = typeof target.selectionEnd === 'number' ? target.selectionEnd : start;
    const anchor = shiftKey ? start : end;
    let cursor = end;

    if (key === 'ArrowLeft') cursor = Math.max(0, end - 1);
    if (key === 'ArrowRight') cursor = Math.min(value.length, end + 1);
    if (key === 'Home') cursor = 0;
    if (key === 'End') cursor = value.length;

    try {
      if (shiftKey) {
        target.setSelectionRange(anchor, cursor);
      } else {
        target.setSelectionRange(cursor, cursor);
      }
      return true;
    } catch (e) {
      return false;
    }
  }

  function getTabbableElements() {
    return Array.from(document.querySelectorAll([
      'a[href]',
      'button:not([disabled])',
      'input:not([disabled]):not([type="hidden"])',
      'select:not([disabled])',
      'textarea:not([disabled])',
      '[contenteditable="true"]',
      '[contenteditable=""]',
      '[tabindex]:not([tabindex="-1"])'
    ].join(','))).filter((el) => {
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && getComputedStyle(el).visibility !== 'hidden';
    });
  }

  function focusNextTabbable(reverse) {
    const tabbables = getTabbableElements();
    if (!tabbables.length) return false;

    const active = document.activeElement;
    let index = tabbables.indexOf(active);
    if (index === -1) {
      index = reverse ? 0 : -1;
    }

    const nextIndex = reverse
      ? (index <= 0 ? tabbables.length - 1 : index - 1)
      : (index + 1) % tabbables.length;

    focusElement(tabbables[nextIndex]);
    return true;
  }

  function getKeyboardTarget() {
    const active = document.activeElement;
    if (active && active !== document.body && active !== document.documentElement) {
      return active;
    }

    const pointed = getInteractiveTarget(elementFromPointDeep(state.pointerX, state.pointerY));
    if (pointed) {
      focusElement(pointed);
      return pointed;
    }

    return document.body;
  }

  function getSelectionText() {
    const active = document.activeElement;
    if (isEditable(active) && !active.isContentEditable) {
      const value = String(active.value || '');
      const start = typeof active.selectionStart === 'number' ? active.selectionStart : 0;
      const end = typeof active.selectionEnd === 'number' ? active.selectionEnd : start;
      return value.slice(start, end);
    }
    return window.getSelection()?.toString() || '';
  }

  function cutSelectionText() {
    const text = getSelectionText();
    const target = getKeyboardTarget();
    if (text && isEditable(target)) {
      deleteSelectionFromEditable(target, 'backward');
    }
    return text;
  }

  function triggerFormSubmit(target) {
    const form = target?.form || target?.closest?.('form');
    if (!form) return false;
    if (typeof form.requestSubmit === 'function') {
      form.requestSubmit();
      return true;
    }
    if (typeof form.submit === 'function') {
      form.submit();
      return true;
    }
    return false;
  }

  function activateElement(target) {
    const interactive = getInteractiveTarget(target);
    if (!interactive) return false;

    const tagName = String(interactive.tagName || '').toLowerCase();
    if (tagName === 'label' && interactive.control) {
      focusElement(interactive.control);
      interactive.control.click();
      return true;
    }

    focusElement(interactive);

    if (tagName === 'input') {
      const type = String(interactive.type || 'text').toLowerCase();
      if (type === 'checkbox' || type === 'radio' || type === 'button' || type === 'submit' || type === 'reset') {
        interactive.click();
      }
      return true;
    }

    if (tagName === 'button' || tagName === 'a' || tagName === 'summary' || interactive.getAttribute('role') === 'button') {
      interactive.click();
      return true;
    }

    if (isEditable(interactive) || tagName === 'select') {
      return true;
    }

    interactive.click?.();
    return true;
  }

  function dispatchMouseEvent(target, type, x, y, button = 0, buttons = 0, detail = 1, modifiers = {}) {
    if (!target) return true;
    return target.dispatchEvent(new MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      composed: true,
      clientX: x,
      clientY: y,
      button,
      buttons,
      detail,
      ...modifiers
    }));
  }

  function findScrollable(target) {
    let node = normalizeTarget(target);
    while (node && node !== document.body && node !== document.documentElement) {
      const style = getComputedStyle(node);
      const canScrollY = /(auto|scroll|overlay)/.test(style.overflowY) && node.scrollHeight > node.clientHeight + 1;
      const canScrollX = /(auto|scroll|overlay)/.test(style.overflowX) && node.scrollWidth > node.clientWidth + 1;
      if (canScrollX || canScrollY) return node;
      node = node.parentElement || node.getRootNode()?.host || null;
    }
    return document.scrollingElement || document.documentElement;
  }

  function handleMouse(evt) {
    const modifiers = getModifiers(evt.modifiers);
    state.pointerX = evt.x;
    state.pointerY = evt.y;
    updateCursor(evt.x, evt.y, true);

    const target = elementFromPointDeep(evt.x, evt.y);

    if (evt.action === 'move') {
      if (target) {
        dispatchMouseEvent(target, 'mousemove', evt.x, evt.y, 0, 0, 0, modifiers);
      }
      state.lastHoverTarget = target;
      return { handled: true };
    }

    if (evt.action === 'down') {
      const button = evt.button === 'middle' ? 1 : evt.button === 'right' ? 2 : 0;
      const interactive = getInteractiveTarget(target);
      if (interactive) {
        focusElement(interactive);
        dispatchMouseEvent(interactive, 'mousedown', evt.x, evt.y, button, 1 << button, evt.clickCount || 1, modifiers);
      }
      state.lastDownTarget = interactive;
      return { handled: true };
    }

    if (evt.action === 'up') {
      const button = evt.button === 'middle' ? 1 : evt.button === 'right' ? 2 : 0;
      const interactive = getInteractiveTarget(target);
      if (interactive) {
        dispatchMouseEvent(interactive, 'mouseup', evt.x, evt.y, button, 0, evt.clickCount || 1, modifiers);
      }
      if (interactive && state.lastDownTarget && (interactive === state.lastDownTarget || interactive.contains(state.lastDownTarget) || state.lastDownTarget.contains(interactive))) {
        activateElement(interactive);
      }
      state.lastDownTarget = null;
      return { handled: true };
    }

    if (evt.action === 'wheel') {
      const wheelTarget = target || document.scrollingElement || document.documentElement;
      const wheelEvent = new WheelEvent('wheel', {
        bubbles: true,
        cancelable: true,
        composed: true,
        clientX: evt.x,
        clientY: evt.y,
        deltaX: evt.deltaX || 0,
        deltaY: evt.deltaY || 0,
        ...modifiers
      });
      const allowed = wheelTarget.dispatchEvent(wheelEvent);
      if (allowed) {
        findScrollable(target).scrollBy({
          left: evt.deltaX || 0,
          top: evt.deltaY || 0,
          behavior: 'auto'
        });
      }
      return { handled: true };
    }

    return { handled: false };
  }

  function handleKey(evt) {
    const target = getKeyboardTarget();
    const modifiers = getModifiers(evt.modifiers);
    const keyboardTarget = target || document.body;

    if (evt.action === 'up') {
      keyboardTarget.dispatchEvent(new KeyboardEvent('keyup', {
        bubbles: true,
        cancelable: true,
        composed: true,
        key: evt.key,
        code: evt.code,
        ...modifiers
      }));
      return { handled: true };
    }

    const keydownAllowed = keyboardTarget.dispatchEvent(new KeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true,
      composed: true,
      key: evt.key,
      code: evt.code,
      ...modifiers
    }));

    if (!keydownAllowed) {
      return { handled: true };
    }

    if (modifiers.ctrlKey || modifiers.metaKey || modifiers.altKey) {
      return { handled: true };
    }

    switch (evt.key) {
      case 'Tab':
        return { handled: focusNextTabbable(modifiers.shiftKey) };
      case 'Backspace':
        return { handled: deleteSelectionFromEditable(keyboardTarget, 'backward') };
      case 'Delete':
        return { handled: deleteSelectionFromEditable(keyboardTarget, 'forward') };
      case 'ArrowLeft':
      case 'ArrowRight':
      case 'Home':
      case 'End':
        return { handled: moveCaret(keyboardTarget, evt.key, modifiers.shiftKey) };
      case 'Enter':
        if (isEditable(keyboardTarget)) {
          const tagName = String(keyboardTarget.tagName || '').toLowerCase();
          if (keyboardTarget.isContentEditable || tagName === 'textarea') {
            return { handled: insertTextIntoEditable(keyboardTarget, '\n') };
          }
          return { handled: triggerFormSubmit(keyboardTarget) || activateElement(keyboardTarget) };
        }
        return { handled: triggerFormSubmit(keyboardTarget) || activateElement(keyboardTarget) };
      case ' ':
        if (!isEditable(keyboardTarget)) {
          return { handled: activateElement(keyboardTarget) };
        }
        break;
    }

    if (evt.text) {
      return { handled: insertTextIntoEditable(keyboardTarget, evt.text) };
    }

    return { handled: true };
  }

  function handleClipboard(evt) {
    if (evt.action === 'pasteText') {
      let target = getKeyboardTarget();
      if (!isEditable(target)) {
        const pointed = getInteractiveTarget(elementFromPointDeep(state.pointerX, state.pointerY));
        if (isEditable(pointed)) {
          target = pointed;
          focusElement(target);
        }
      }
      return {
        handled: insertTextIntoEditable(target, evt.text || ''),
        text: evt.text || ''
      };
    }

    if (evt.action === 'copySelection') {
      return {
        handled: true,
        text: getSelectionText()
      };
    }

    if (evt.action === 'cutSelection') {
      return {
        handled: true,
        text: cutSelectionText()
      };
    }

    return { handled: false };
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.action !== 'pageAgentInput') return false;

    try {
      let response = { handled: false };
      if (msg.event?.type === 'mouse') {
        response = handleMouse(msg.event);
      } else if (msg.event?.type === 'key') {
        response = handleKey(msg.event);
      } else if (msg.event?.type === 'clipboard') {
        response = handleClipboard(msg.event);
      }
      sendResponse(response);
    } catch (error) {
      sendResponse({ handled: false, error: error.message || String(error) });
    }
    return true;
  });

  ensureCursor();
  scanForInjectedUi(document);

  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node?.nodeType === Node.ELEMENT_NODE) {
          scanForInjectedUi(node);
        }
      }
    }
  });

  observer.observe(document.documentElement || document, {
    childList: true,
    subtree: true
  });

  window.addEventListener('resize', notifyViewport);
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', notifyViewport);
    window.visualViewport.addEventListener('scroll', notifyViewport);
  }
  window.addEventListener('pagehide', () => observer.disconnect(), { once: true });

  notifyReady();
})();
