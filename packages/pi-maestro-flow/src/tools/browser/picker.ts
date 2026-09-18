/**
 * In-page element/component picker, adapted from Devin's browser_preview
 * ElementSelector (see devin-re/BROWSER_PREVIEW.md). Unlike Devin, pi already
 * controls the page (puppeteer evaluate / bridge exec in the MAIN world), so no
 * reverse proxy or RPC channel is needed: the script keeps state on
 * window.__piElementPick and the host polls PICKER_POLL_JS to drain captures.
 *
 * All UI uses inline styles inside a closed shadow root so strict CSP pages
 * cannot block it and page CSS cannot leak in. Injected code avoids template
 * literals entirely so the constants below stay plain TS template strings.
 */

/**
 * PICKER_INJECT_JS: idempotent installer. Re-running while a pick is active
 * resets state and rebuilds the toolbar instead of double-registering
 * listeners. Returns a small status string for the evaluate call.
 */
export const PICKER_INJECT_JS = `(function () {
  var PREV = window.__piElementPick;
  if (PREV && typeof PREV.cleanup === 'function') { try { PREV.cleanup(); } catch (e) {} }

  var state = {
    captures: [],
    errors: [],
    done: null,
    selected: [],
    hoverEl: null,
    cleanup: null
  };
  window.__piElementPick = state;

  var MAX_ERRORS = 100;
  var MAX_OUTER_HTML = 4096;
  var MAX_TEXT = 240;
  var MAX_ERROR_TEXT = 500;

  function cssPath(el) {
    if (el.id) return '#' + CSS.escape(el.id);
    var parts = [];
    var current = el;
    while (current && current !== document.body) {
      var parent = current.parentElement;
      if (!parent) break;
      var siblings = Array.prototype.filter.call(parent.children, function (item) { return item.tagName === current.tagName; });
      var index = siblings.indexOf(current) + 1;
      parts.unshift(current.tagName.toLowerCase() + (siblings.length > 1 ? ':nth-of-type(' + index + ')' : ''));
      current = parent;
    }
    return 'body > ' + parts.join(' > ');
  }

  function fiberOf(el) {
    var keys = Object.keys(el);
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      if (k.indexOf('__reactFiber$') === 0 || k.indexOf('__reactInternalInstance$') === 0) return el[k];
    }
    return null;
  }

  function fiberDisplayName(fiber) {
    var type = fiber.type;
    if (!type) return null;
    if (typeof type === 'string') return null;
    if (typeof type === 'function') return type.displayName || type.name || null;
    // forwardRef / memo / lazy wrappers.
    if (typeof type === 'object') {
      if (type.render) return type.render.displayName || type.render.name || null;
      if (type.type) return type.type.displayName || type.type.name || null;
    }
    return null;
  }

  function fiberSource(fiber) {
    // React <=18 dev: fiber._debugSource / element type __source = {fileName,lineNumber,columnNumber}.
    var src = fiber._debugSource || (fiber.type && fiber.type.__source) || null;
    if (src && src.fileName) {
      return { filePath: src.fileName, line: src.lineNumber || null, column: src.columnNumber || null };
    }
    // React 19 dev: fiber._debugStack is an Error captured at the JSX callsite;
    // its first user frame is the component's source location.
    var stack = fiber._debugStack && fiber._debugStack.stack;
    if (typeof stack === 'string') {
      var lines = stack.split('\\n');
      for (var i = 0; i < lines.length; i++) {
        var m = lines[i].match(/\\(?((?:file:\\/\\/\\/|https?:|\\/|[A-Za-z]:)[^()\\s]*?):(\\d+):(\\d+)\\)?\\s*$/);
        if (m) return { filePath: m[1], line: Number(m[2]), column: Number(m[3]) };
      }
    }
    return null;
  }

  function componentInfo(el) {
    var current = el;
    while (current && current !== document.documentElement) {
      var fiber = fiberOf(current);
      while (fiber) {
        var name = fiberDisplayName(fiber);
        if (name) {
          var src = fiberSource(fiber);
          return {
            reactComponentName: name,
            filePath: src ? src.filePath : null,
            line: src ? src.line : null
          };
        }
        fiber = fiber.return;
      }
      // Vue dev builds attach the component instance to the root DOM node.
      var vue = current.__vueParentComponent;
      if (vue && vue.type) {
        return {
          reactComponentName: null,
          vueComponentName: vue.type.name || vue.type.__name || null,
          filePath: vue.type.__file || null,
          line: null
        };
      }
      current = current.parentElement;
    }
    return { reactComponentName: null, vueComponentName: null, filePath: null, line: null };
  }

  function describe(el) {
    var info = componentInfo(el);
    var html = el.outerHTML || '';
    if (html.length > MAX_OUTER_HTML) html = html.slice(0, MAX_OUTER_HTML) + '…';
    var text = (el.innerText || '').trim();
    if (text.length > MAX_TEXT) text = text.slice(0, MAX_TEXT) + '…';
    return {
      kind: 'element',
      tagName: el.tagName ? el.tagName.toLowerCase() : 'unknown',
      id: el.id || null,
      selector: cssPath(el),
      outerHtml: html,
      text: text,
      reactComponentName: info.reactComponentName,
      vueComponentName: info.vueComponentName || null,
      filePath: info.filePath,
      line: info.line
    };
  }

  // ---- overlay + toolbar (all inline styles; shadow root isolates page CSS) ----
  var overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483646;border:2px solid #3b82f6;background:rgba(59,130,246,.12);display:none;box-sizing:border-box;';
  var label = document.createElement('div');
  label.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483646;background:#1e293b;color:#f8fafc;font:12px/1.4 monospace;padding:2px 6px;border-radius:3px;display:none;white-space:nowrap;';
  var markers = [];

  var host = document.createElement('div');
  host.id = '__pi-pick-toolbar';
  host.style.cssText = 'position:fixed;right:12px;bottom:12px;z-index:2147483647;';
  var shadow = host.attachShadow({ mode: 'open' });
  var bar = document.createElement('div');
  bar.style.cssText = 'display:flex;gap:6px;background:#1e293b;border:1px solid #475569;border-radius:8px;padding:6px;font:12px/1.4 system-ui,sans-serif;box-shadow:0 4px 16px rgba(0,0,0,.4);';
  var btnStyle = 'background:#334155;color:#f8fafc;border:1px solid #64748b;border-radius:5px;padding:4px 10px;cursor:pointer;font:inherit;';
  var sendBtn = document.createElement('button');
  sendBtn.textContent = 'Send element';
  sendBtn.style.cssText = btnStyle;
  var errBtn = document.createElement('button');
  errBtn.textContent = 'Send errors (0)';
  errBtn.style.cssText = btnStyle;
  var quitBtn = document.createElement('button');
  quitBtn.textContent = '✕';
  quitBtn.style.cssText = btnStyle;
  bar.appendChild(sendBtn);
  bar.appendChild(errBtn);
  bar.appendChild(quitBtn);
  shadow.appendChild(bar);
  document.documentElement.appendChild(overlay);
  document.documentElement.appendChild(label);
  document.documentElement.appendChild(host);

  function inToolbar(target) {
    return target === host || target === overlay || target === label || markers.indexOf(target) >= 0;
  }

  function labelFor(el) {
    var info = componentInfo(el);
    var name = info.reactComponentName || info.vueComponentName;
    return name ? '<' + name + ' />' : '<' + (el.tagName || '?').toLowerCase() + '>';
  }

  function placeOverlay(el) {
    var rect = el.getBoundingClientRect();
    overlay.style.display = 'block';
    overlay.style.left = rect.left + 'px';
    overlay.style.top = rect.top + 'px';
    overlay.style.width = rect.width + 'px';
    overlay.style.height = rect.height + 'px';
    label.style.display = 'block';
    label.textContent = labelFor(el);
    var lx = rect.left;
    var ly = rect.top - 22;
    if (ly < 0) ly = rect.bottom + 2;
    label.style.left = lx + 'px';
    label.style.top = ly + 'px';
  }

  function hideOverlay() {
    overlay.style.display = 'none';
    label.style.display = 'none';
  }

  function addMarker(el) {
    var rect = el.getBoundingClientRect();
    var marker = document.createElement('div');
    marker.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483645;border:2px dashed #22c55e;background:rgba(34,197,94,.08);box-sizing:border-box;left:' + rect.left + 'px;top:' + rect.top + 'px;width:' + rect.width + 'px;height:' + rect.height + 'px;';
    document.documentElement.appendChild(marker);
    markers.push(marker);
  }

  function clearMarkers() {
    for (var i = 0; i < markers.length; i++) markers[i].remove();
    markers.length = 0;
  }

  function finish(reason) {
    state.done = reason;
  }

  function sendElements() {
    var items = state.selected.length > 0 ? state.selected : (state.hoverEl ? [state.hoverEl] : []);
    for (var i = 0; i < items.length; i++) state.captures.push(describe(items[i]));
    state.selected.length = 0;
    clearMarkers();
    finish('sent');
  }

  function sendErrors() {
    state.captures.push({ kind: 'console', errors: state.errors.slice() });
    state.errors.length = 0;
    finish('sent');
  }

  function onMouseOver(event) {
    if (inToolbar(event.target)) { hideOverlay(); return; }
    var el = event.target;
    if (!el || el.nodeType !== 1) return;
    state.hoverEl = el;
    placeOverlay(el);
  }

  function onClick(event) {
    if (inToolbar(event.target)) return;
    event.preventDefault();
    event.stopPropagation();
    var el = event.target;
    if (!el || el.nodeType !== 1) return;
    if (event.ctrlKey || event.metaKey || event.shiftKey) {
      if (state.selected.indexOf(el) < 0) {
        state.selected.push(el);
        addMarker(el);
      }
    } else {
      state.selected.length = 0;
      clearMarkers();
      state.selected.push(el);
      addMarker(el);
    }
  }

  function onKeydown(event) {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      finish('escape');
    } else if (event.key === 'Enter') {
      event.preventDefault();
      event.stopPropagation();
      sendElements();
    }
  }

  function suppress(event) {
    if (inToolbar(event.target)) return;
    event.preventDefault();
    event.stopPropagation();
  }

  sendBtn.addEventListener('click', function (e) { e.stopPropagation(); sendElements(); });
  errBtn.addEventListener('click', function (e) { e.stopPropagation(); sendErrors(); });
  quitBtn.addEventListener('click', function (e) { e.stopPropagation(); finish('escape'); });

  var suppressed = ['mousedown', 'mouseup', 'pointerdown', 'pointerup', 'dblclick', 'contextmenu'];
  document.addEventListener('mouseover', onMouseOver, true);
  document.addEventListener('click', onClick, true);
  document.addEventListener('keydown', onKeydown, true);
  for (var i = 0; i < suppressed.length; i++) document.addEventListener(suppressed[i], suppress, true);

  var origError = console.error;
  console.error = function () {
    try {
      var parts = [];
      for (var i = 0; i < arguments.length; i++) {
        var v = arguments[i];
        var s = typeof v === 'string' ? v : (v && v.stack) ? String(v.stack) : String(v);
        if (s.length > MAX_ERROR_TEXT) s = s.slice(0, MAX_ERROR_TEXT) + '…';
        parts.push(s);
      }
      if (state.errors.length < MAX_ERRORS) {
        state.errors.push(parts.join(' '));
        errBtn.textContent = 'Send errors (' + state.errors.length + ')';
      }
    } catch (e) {}
    return origError.apply(this, arguments);
  };

  state.cleanup = function () {
    document.removeEventListener('mouseover', onMouseOver, true);
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('keydown', onKeydown, true);
    for (var i = 0; i < suppressed.length; i++) document.removeEventListener(suppressed[i], suppress, true);
    console.error = origError;
    overlay.remove();
    label.remove();
    clearMarkers();
    host.remove();
  };

  return 'pi-element-picker active';
})()`;

/**
 * PICKER_POLL_JS: drains pending captures and reports status. The live
 * console.error buffer is NOT drained here — it belongs to the in-page
 * "Send errors" button, which copies it into a console capture. Returns
 * { missing: true } after navigation wiped the injected state so the host can
 * end the pick as "navigated" instead of polling forever.
 */
export const PICKER_POLL_JS = `(function () {
  var s = window.__piElementPick;
  if (!s) return { missing: true };
  var captures = s.captures.splice(0, s.captures.length);
  return { captures: captures, errorCount: s.errors.length, done: s.done, selected: s.selected.length };
})()`;

/**
 * PICKER_TEARDOWN_JS: removes listeners, overlays, toolbar, restores
 * console.error, and deletes the state object. Safe to run when the pick
 * already ended or the state was wiped by navigation.
 */
export const PICKER_TEARDOWN_JS = `(function () {
  var s = window.__piElementPick;
  if (s && typeof s.cleanup === 'function') { try { s.cleanup(); } catch (e) {} }
  try { delete window.__piElementPick; } catch (e) { window.__piElementPick = undefined; }
  return 'pi-element-picker removed';
})()`;
