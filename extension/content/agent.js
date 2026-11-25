// In-page helper injected into the extension's ISOLATED world (never visible to the page's own scripts).
// Idempotent: re-injecting only replaces it when the version changes.
(() => {
  const VERSION = 5;
  if (window.__claudeBridge && window.__claudeBridge.version === VERSION) return;

  // ---------------------------------------------------------------- element refs
  const refToEl = new Map(); // ref -> WeakRef<Element>
  const elToRef = new WeakMap(); // Element -> ref
  let counter = window.__claudeBridge && typeof window.__claudeBridge.counter === 'function' ? window.__claudeBridge.counter() : 0;

  function refFor(el) {
    let ref = elToRef.get(el);
    if (!ref) {
      ref = 'e' + ++counter;
      elToRef.set(el, ref);
      refToEl.set(ref, new WeakRef(el));
    }
    return ref;
  }

  function byRef(ref) {
    const w = refToEl.get(String(ref).replace(/^\[?ref=|\]$/g, ''));
    const el = w && w.deref();
    if (!el || !el.isConnected) {
      throw new Error(`Element ref "${ref}" not found or no longer attached to the page. Take a new snapshot (or use find) to get fresh refs.`);
    }
    return el;
  }

  // ---------------------------------------------------------------- DOM traversal helpers
  function shadowOf(el) {
    if (el.shadowRoot) return el.shadowRoot;
    try {
      if (chrome?.dom?.openOrClosedShadowRoot) return chrome.dom.openOrClosedShadowRoot(el) || null;
    } catch (_) { /* ignore */ }
    return null;
  }

  function frameDoc(iframe) {
    try {
      const d = iframe.contentDocument;
      if (d && d.documentElement) return d;
    } catch (_) { /* cross-origin */ }
    return null;
  }

  function childrenOf(node) {
    if (node.nodeType === 1) {
      const sr = shadowOf(node);
      if (sr) return sr.childNodes;
      if (node.tagName === 'SLOT') {
        const assigned = node.assignedNodes({ flatten: true });
        return assigned.length ? assigned : node.childNodes;
      }
    }
    return node.childNodes;
  }

  function deepQuerySelector(selector, root = document) {
    let found = null;
    try {
      found = root.querySelector(selector);
    } catch (e) {
      throw new Error(`Invalid CSS selector "${selector}": ${e.message}`);
    }
    if (found) return found;
    // search shadow roots and same-origin iframes
    const all = root.querySelectorAll('*');
    for (const el of all) {
      const sr = shadowOf(el);
      if (sr) {
        const f = deepQuerySelector(selector, sr);
        if (f) return f;
      }
      if (el.tagName === 'IFRAME' || el.tagName === 'FRAME') {
        const d = frameDoc(el);
        if (d) {
          const f = deepQuerySelector(selector, d);
          if (f) return f;
        }
      }
    }
    return null;
  }

  function resolve({ ref, selector } = {}) {
    if (ref) return byRef(ref);
    if (selector) {
      const el = deepQuerySelector(selector);
      if (!el) throw new Error(`No element matches selector "${selector}".`);
      return el;
    }
    throw new Error('Provide either "ref" (from snapshot/find) or "selector".');
  }

  // ---------------------------------------------------------------- text helpers
  function clean(s, max = 100) {
    if (s == null) return '';
    s = String(s).replace(/\s+/g, ' ').trim();
    return s.length > max ? s.slice(0, max - 1) + '…' : s;
  }
  const q = (s) => '"' + s.replace(/"/g, '\\"') + '"';

  function describe(el) {
    if (!el || el.nodeType !== 1) return String(el);
    let d = el.tagName.toLowerCase();
    if (el.id) d += '#' + el.id;
    const cls = typeof el.className === 'string' ? el.className.trim().split(/\s+/).filter(Boolean).slice(0, 2) : [];
    if (cls.length) d += '.' + cls.join('.');
    const t = clean(el.innerText || el.textContent || '', 40);
    if (t) d += ' ' + q(t);
    return d;
  }

  // ---------------------------------------------------------------- geometry
  // Rect relative to the TOP frame's viewport (CSS px), accounting for same-origin iframes.
  function viewportRect(el) {
    const r = el.getBoundingClientRect();
    let x = r.left, y = r.top;
    let win = el.ownerDocument.defaultView;
    while (win && win !== window) {
      let fe = null;
      try { fe = win.frameElement; } catch (_) { break; }
      if (!fe) break;
      const fr = fe.getBoundingClientRect();
      const cs = fe.ownerDocument.defaultView.getComputedStyle(fe);
      x += fr.left + fe.clientLeft + parseFloat(cs.paddingLeft || 0);
      y += fr.top + fe.clientTop + parseFloat(cs.paddingTop || 0);
      win = fe.ownerDocument.defaultView;
    }
    return { x, y, width: r.width, height: r.height };
  }

  function hasBox(el) {
    const rects = el.getClientRects();
    for (const r of rects) if (r.width > 0 && r.height > 0) return true;
    return false;
  }

  function inViewport(rect) {
    return rect.x + rect.width > 0 && rect.y + rect.height > 0 && rect.x < window.innerWidth && rect.y < window.innerHeight;
  }

  function deepElementFromPoint(doc, x, y) {
    let el = doc.elementFromPoint(x, y);
    while (el) {
      const sr = shadowOf(el);
      if (sr && sr.elementFromPoint) {
        const inner = sr.elementFromPoint(x, y);
        if (inner && inner !== el) { el = inner; continue; }
      }
      if (el.tagName === 'IFRAME' || el.tagName === 'FRAME') {
        const d = frameDoc(el);
        if (d) {
          const fr = el.getBoundingClientRect();
          const inner = deepElementFromPoint(d, x - fr.left - el.clientLeft, y - fr.top - el.clientTop);
          if (inner) return inner;
        }
      }
      break;
    }
    return el;
  }

  function composedContains(ancestor, node) {
    while (node) {
      if (node === ancestor) return true;
      node = node.parentNode || node.host || (node.nodeType === 9 && node.defaultView && node.defaultView.frameElement) || null;
    }
    return false;
  }

  // ---------------------------------------------------------------- roles & names
  const INTERACTIVE = new Set([
    'link', 'button', 'checkbox', 'radio', 'textbox', 'searchbox', 'combobox', 'listbox', 'slider', 'spinbutton',
    'switch', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option', 'treeitem', 'file-input', 'clickable',
    'gridcell-clickable', 'color-input', 'date-input',
  ]);
  const STRUCTURAL = new Set([
    'navigation', 'main', 'banner', 'contentinfo', 'complementary', 'search', 'form', 'region', 'dialog', 'alertdialog',
    'list', 'listitem', 'table', 'row', 'tablist', 'tabpanel', 'menu', 'menubar', 'tree', 'grid', 'toolbar', 'alert',
    'heading', 'img', 'iframe', 'article', 'status',
  ]);
  const NAME_FROM_CONTENT = new Set([
    'link', 'button', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option', 'treeitem', 'heading',
    'clickable', 'gridcell-clickable', 'checkbox', 'radio', 'switch',
  ]);
  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'META', 'LINK', 'HEAD', 'TITLE', 'BASE']);
  const BLOCK_DISPLAY = /^(block|flex|grid|list-item|table|table-row|table-cell|flow-root|table-caption)/;

  function implicitRole(el) {
    const tag = el.tagName;
    switch (tag) {
      case 'A': case 'AREA': return el.hasAttribute('href') ? 'link' : null;
      case 'BUTTON': return 'button';
      case 'SUMMARY': return 'button';
      case 'INPUT': {
        const t = (el.getAttribute('type') || 'text').toLowerCase();
        switch (t) {
          case 'hidden': return null;
          case 'checkbox': return el.getAttribute('role') === 'switch' ? 'switch' : 'checkbox';
          case 'radio': return 'radio';
          case 'button': case 'submit': case 'reset': case 'image': return 'button';
          case 'range': return 'slider';
          case 'number': return 'spinbutton';
          case 'search': return 'searchbox';
          case 'file': return 'file-input';
          case 'color': return 'color-input';
          case 'date': case 'datetime-local': case 'month': case 'time': case 'week': return 'date-input';
          default: return 'textbox';
        }
      }
      case 'SELECT': return el.multiple || el.size > 1 ? 'listbox' : 'combobox';
      case 'TEXTAREA': return 'textbox';
      case 'IMG': return (el.getAttribute('alt') || el.getAttribute('aria-label') || el.getAttribute('title')) ? 'img' : null;
      case 'H1': case 'H2': case 'H3': case 'H4': case 'H5': case 'H6': return 'heading';
      case 'NAV': return 'navigation';
      case 'MAIN': return 'main';
      case 'ASIDE': return 'complementary';
      case 'FORM': return 'form';
      case 'DIALOG': return el.open ? 'dialog' : null;
      case 'UL': case 'OL': return 'list';
      case 'LI': return 'listitem';
      case 'TABLE': return 'table';
      case 'TR': return 'row';
      case 'IFRAME': case 'FRAME': return 'iframe';
      case 'ARTICLE': return 'article';
      case 'OPTION': return 'option';
    }
    if (el.isContentEditable && el.getAttribute('contenteditable') !== null && el.getAttribute('contenteditable') !== 'false') return 'textbox';
    return null;
  }

  function roleOf(el, style, parentStyle) {
    const explicit = (el.getAttribute('role') || '').trim().split(/\s+/)[0];
    if (explicit && explicit !== 'presentation' && explicit !== 'none' && explicit !== 'generic') {
      return explicit === 'gridcell' && style.cursor === 'pointer' ? 'gridcell-clickable' : explicit;
    }
    const r = implicitRole(el);
    if (r) return r;
    // Heuristic: JS-handled clickable elements (cursor:pointer that isn't inherited, onclick, tabindex)
    if (style.cursor === 'pointer' && (!parentStyle || parentStyle.cursor !== 'pointer')) return 'clickable';
    if (el.hasAttribute('onclick')) return 'clickable';
    const ti = el.getAttribute('tabindex');
    if (ti !== null && Number(ti) >= 0 && el.tagName !== 'BODY' && el.tagName !== 'HTML') return 'clickable';
    return null;
  }

  function textById(doc, ids) {
    return ids.split(/\s+/).map((id) => {
      const n = doc.getElementById(id);
      return n ? n.innerText || n.textContent || '' : '';
    }).join(' ');
  }

  function nameOf(el, role) {
    const al = el.getAttribute('aria-label');
    if (al && al.trim()) return clean(al);
    const lb = el.getAttribute('aria-labelledby');
    if (lb) {
      const t = textById(el.ownerDocument, lb);
      if (t.trim()) return clean(t);
    }
    const tag = el.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
      const type = (el.type || '').toLowerCase();
      if (type === 'button' || type === 'submit' || type === 'reset') {
        return clean(el.value || (type === 'submit' ? 'Submit' : type === 'reset' ? 'Reset' : ''));
      }
      if (type === 'image') return clean(el.alt || el.value || 'Submit');
      if (el.labels && el.labels.length) {
        const t = Array.from(el.labels).map((l) => l.innerText || l.textContent).join(' ');
        if (t.trim()) return clean(t);
      }
      const ph = el.getAttribute('placeholder') || el.getAttribute('aria-placeholder');
      if (ph) return clean(ph);
      return clean(el.getAttribute('title') || el.getAttribute('name') || '');
    }
    if (tag === 'IMG' || tag === 'AREA') return clean(el.getAttribute('alt') || el.getAttribute('title') || '');
    if (tag === 'IFRAME' || tag === 'FRAME') return clean(el.getAttribute('title') || el.getAttribute('name') || '');
    if (NAME_FROM_CONTENT.has(role)) {
      let t = clean(el.innerText || '', 100);
      if (!t) {
        for (const img of el.querySelectorAll('img[alt],img[title],[aria-label]')) {
          t = clean(img.getAttribute('alt') || img.getAttribute('aria-label') || img.getAttribute('title'));
          if (t) break;
        }
      }
      if (!t) {
        const svgTitle = el.querySelector('svg title');
        if (svgTitle) t = clean(svgTitle.textContent);
      }
      if (!t) t = clean(el.getAttribute('title') || el.textContent || '');
      return t;
    }
    if (role === 'dialog' || role === 'alertdialog' || role === 'region' || role === 'form' || role === 'navigation') {
      return clean(el.getAttribute('title') || '');
    }
    return clean(el.getAttribute('title') || '');
  }

  function stateOf(el, role) {
    const s = [];
    const tag = el.tagName;
    if (role === 'heading') {
      const lvl = el.getAttribute('aria-level') || (/^H(\d)$/.exec(tag) || [])[1];
      if (lvl) s.push(`level=${lvl}`);
    }
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') s.push('disabled');
    if (tag === 'INPUT' && (el.type === 'checkbox' || el.type === 'radio')) {
      s.push(el.indeterminate ? 'mixed' : el.checked ? 'checked' : 'unchecked');
    } else {
      const ac = el.getAttribute('aria-checked');
      if (ac) s.push(ac === 'true' ? 'checked' : ac === 'mixed' ? 'mixed' : 'unchecked');
    }
    const ap = el.getAttribute('aria-pressed');
    if (ap) s.push(ap === 'true' ? 'pressed' : 'not-pressed');
    const ae = el.getAttribute('aria-expanded');
    if (ae) s.push(ae === 'true' ? 'expanded' : 'collapsed');
    if (el.getAttribute('aria-selected') === 'true') s.push('selected');
    if (el.getAttribute('aria-current') && el.getAttribute('aria-current') !== 'false') s.push('current');
    if (el.required || el.getAttribute('aria-required') === 'true') s.push('required');
    if (el.readOnly) s.push('readonly');
    if (el.getAttribute('aria-invalid') === 'true') s.push('invalid');
    if (isFocused(el)) s.push('focused');
    return s;
  }

  function isFocused(el) {
    let a = document.activeElement;
    while (a) {
      if (a === el) return true;
      const sr = shadowOf(a);
      if (sr && sr.activeElement) { a = sr.activeElement; continue; }
      if ((a.tagName === 'IFRAME' || a.tagName === 'FRAME') && frameDoc(a)) { a = frameDoc(a).activeElement; continue; }
      break;
    }
    return false;
  }

  function extraOf(el, role) {
    const tag = el.tagName;
    const parts = [];
    if (role === 'link') {
      const href = el.getAttribute('href') || '';
      if (href && !href.startsWith('javascript:')) parts.push('-> ' + clean(href, 80));
    }
    if (tag === 'INPUT' || tag === 'TEXTAREA') {
      const t = (el.type || '').toLowerCase();
      if (!['checkbox', 'radio', 'button', 'submit', 'reset', 'image', 'file'].includes(t)) {
        if (el.value) parts.push('value=' + q(t === 'password' ? '•'.repeat(Math.min(el.value.length, 8)) : clean(el.value, 100)));
      }
      if (t === 'file' && el.files && el.files.length) parts.push('files=' + q(Array.from(el.files).map((f) => f.name).join(', ')));
      if (t && t !== 'text' && t !== 'textarea' && role === 'textbox') parts.push(`type=${t}`);
    } else if (tag === 'SELECT') {
      const sel = Array.from(el.selectedOptions).map((o) => clean(o.text, 40));
      parts.push('selected=' + q(sel.join(', ')));
      const opts = Array.from(el.options).slice(0, 25).map((o) => clean(o.text, 40));
      parts.push('options=[' + opts.map(q).join(', ') + (el.options.length > 25 ? `, …+${el.options.length - 25}` : '') + ']');
    } else if (role === 'textbox' && el.isContentEditable) {
      const t = clean(el.innerText, 100);
      if (t) parts.push('value=' + q(t));
    } else if (role === 'slider' || role === 'spinbutton') {
      const v = el.getAttribute('aria-valuenow');
      if (v) parts.push(`value=${v}`);
    }
    return parts;
  }

  // ---------------------------------------------------------------- snapshot
  function snapshot({ interactiveOnly = false, viewportOnly = false, maxChars = 25000, selector, ref } = {}) {
    const lines = [];
    let chars = 0;
    let truncated = false;
    let nodes = 0;
    const MAX_NODES = 40000;
    let pendingText = [];
    let pendingDepth = 0;

    const push = (line) => {
      if (truncated) return;
      if (chars + line.length + 1 > maxChars) { truncated = true; return; }
      lines.push(line);
      chars += line.length + 1;
    };
    const flush = () => {
      if (!pendingText.length) return;
      const t = clean(pendingText.join(' '), 300);
      pendingText = [];
      if (t) push('  '.repeat(pendingDepth) + '- text: ' + t);
    };

    function walk(node, depth, covered, parentStyle, parentVisible = true) {
      if (truncated || ++nodes > MAX_NODES) { truncated = true; return; }
      if (node.nodeType === 3) {
        if (interactiveOnly || covered || !parentVisible) return;
        const t = node.nodeValue;
        if (!t || !t.trim()) return;
        const parent = node.parentElement;
        if (viewportOnly && parent && !inViewport(viewportRect(parent))) return;
        if (!pendingText.length) pendingDepth = depth;
        pendingText.push(t);
        return;
      }
      if (node.nodeType === 11) { // shadow root / fragment
        for (const c of node.childNodes) walk(c, depth, covered, parentStyle, parentVisible);
        return;
      }
      if (node.nodeType !== 1) return;
      const el = node;
      if (SKIP_TAGS.has(el.tagName)) return;
      const style = el.ownerDocument.defaultView.getComputedStyle(el);
      if (style.display === 'none') return;
      if (el.getAttribute('aria-hidden') === 'true' && el.tagName !== 'BODY') return;
      if (el.tagName === 'svg' || el.tagName === 'SVG' || el.namespaceURI === 'http://www.w3.org/2000/svg') {
        // treat svg as atomic (only emit if it is itself interactive / labelled)
        if (el.tagName.toLowerCase() !== 'svg') return;
      }
      const visible = style.visibility === 'visible' && (style.display === 'contents' || hasBox(el));
      const block = BLOCK_DISPLAY.test(style.display);
      if (block) flush();

      let role = roleOf(el, style, parentStyle);
      if (role === 'clickable' && el.tagName.toLowerCase() === 'svg' && !el.getAttribute('aria-label')) role = null;
      let childDepth = depth;
      let childCovered = covered;
      const isInteractive = role && INTERACTIVE.has(role);
      const rect = visible ? viewportRect(el) : null;
      const inView = rect ? inViewport(rect) : false;

      if (role && visible && (!viewportOnly || inView)) {
        const emit = isInteractive || (!interactiveOnly && STRUCTURAL.has(role)) || (interactiveOnly && role === 'heading');
        if (emit) {
          const name = nameOf(el, role);
          // skip nameless, purely structural noise
          const skipNoise = !isInteractive && !name && ['region', 'img', 'article', 'status', 'form'].includes(role);
          if (!skipNoise) {
            flush();
            let line = '  '.repeat(interactiveOnly ? 0 : depth) + '- ' + role.replace('-clickable', '');
            if (name) line += ' ' + q(name);
            if (isInteractive || role === 'iframe' || role === 'dialog' || role === 'alertdialog' || role === 'tabpanel') line += ` [ref=${refFor(el)}]`;
            const st = stateOf(el, role);
            if (st.length) line += ' [' + st.join(', ') + ']';
            const ex = extraOf(el, role);
            if (ex.length) line += ' ' + ex.join(' ');
            if (!inView && !viewportOnly && isInteractive) line += ' (offscreen)';
            push(line);
            if (!interactiveOnly) childDepth = depth + 1;
            if (NAME_FROM_CONTENT.has(role) || role === 'textbox' || role === 'combobox' || role === 'listbox') childCovered = true;
          }
        }
      }

      // A <label> whose control is listed already supplied that control's name; don't repeat its text.
      if (el.tagName === 'LABEL' && el.control && el.control !== el && hasBox(el.control)) childCovered = true;
      if (role === 'listbox' && el.tagName === 'SELECT') { if (block) flush(); return; } // options already listed
      if (el.tagName === 'IFRAME' || el.tagName === 'FRAME') {
        const d = frameDoc(el);
        if (d && d.body) walk(d.body, childDepth, childCovered, null, visible);
        else if (visible && !interactiveOnly) push('  '.repeat(childDepth) + `- (cross-origin frame: ${clean(el.src, 80)} — content not accessible; use screenshot + coordinate clicks)`);
        return;
      }
      if (el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.tagName === 'INPUT') { if (block) flush(); return; }
      for (const c of childrenOf(el)) walk(c, childDepth, childCovered, style, visible);
      if (block) flush();
    }

    let root = document.body || document.documentElement;
    if (ref || selector) root = resolve({ ref, selector });
    walk(root, 0, false, null);
    flush();

    const se = document.scrollingElement || document.documentElement;
    const header = [
      `URL: ${location.href}`,
      `Title: ${document.title}`,
      `Viewport: ${window.innerWidth}x${window.innerHeight} CSS px, scroll ${Math.round(window.scrollX)},${Math.round(window.scrollY)} of ${se.scrollWidth}x${se.scrollHeight}`,
    ];
    if (lines.length === 0) lines.push('(no visible content matched)');
    if (truncated) {
      lines.push(`… [snapshot truncated at ${maxChars} chars — use viewportOnly:true, interactiveOnly:true, a ref/selector to scope it, find, or get_text]`);
    }
    return header.join('\n') + '\n\n' + lines.join('\n');
  }

  // ---------------------------------------------------------------- find
  function find({ query, limit = 20, includeText = true } = {}) {
    const needle = clean(query, 500).toLowerCase();
    if (!needle) throw new Error('find: "query" is required.');
    const results = [];
    let nodes = 0;
    function walk(node, parentStyle) {
      if (++nodes > 60000) return;
      if (node.nodeType === 11) { for (const c of node.childNodes) walk(c, parentStyle); return; }
      if (node.nodeType !== 1) return;
      const el = node;
      if (SKIP_TAGS.has(el.tagName)) return;
      const style = el.ownerDocument.defaultView.getComputedStyle(el);
      if (style.display === 'none') return;
      const visible = style.visibility === 'visible' && hasBox(el);
      if (visible) {
        const role = roleOf(el, style, parentStyle);
        if (role) {
          const name = nameOf(el, role);
          const hay = [name, el.getAttribute('placeholder'), el.getAttribute('name'), el.getAttribute('id'), el.getAttribute('title'), el.value && typeof el.value === 'string' ? el.value : '']
            .filter(Boolean).join(' ').toLowerCase();
          if (hay.includes(needle)) {
            const interactive = INTERACTIVE.has(role);
            const exact = name.toLowerCase() === needle;
            results.push({ el, role, name, score: (interactive ? 2 : 0) + (exact ? 2 : 0) });
          }
        } else if (includeText) {
          // leaf-ish text containers
          let own = '';
          for (const c of el.childNodes) if (c.nodeType === 3) own += c.nodeValue;
          own = clean(own, 200);
          if (own && own.toLowerCase().includes(needle)) {
            results.push({ el, role: 'text', name: own, score: own.toLowerCase() === needle ? 1 : 0 });
          }
        }
      }
      if (el.tagName === 'IFRAME' || el.tagName === 'FRAME') {
        const d = frameDoc(el);
        if (d && d.body) walk(d.body, null);
        return;
      }
      for (const c of childrenOf(el)) walk(c, style);
    }
    walk(document.body || document.documentElement, null);
    results.sort((a, b) => b.score - a.score);
    const out = results.slice(0, limit).map(({ el, role, name }) => {
      const rect = viewportRect(el);
      let line = `- ${role} ${q(name)} [ref=${refFor(el)}]`;
      const st = role === 'text' ? [] : stateOf(el, role);
      if (st.length) line += ' [' + st.join(', ') + ']';
      line += inViewport(rect) ? ` at (${Math.round(rect.x + rect.width / 2)},${Math.round(rect.y + rect.height / 2)})` : ' (offscreen)';
      return line;
    });
    if (!out.length) return `No visible elements match ${q(query)}.`;
    return `${results.length} match(es) for ${q(query)}${results.length > limit ? ` (showing ${limit})` : ''}:\n` + out.join('\n');
  }

  // ---------------------------------------------------------------- actions support
  // Scrolls the target into view and returns the point (top-viewport CSS px) to click.
  function point({ ref, selector, scroll = true } = {}) {
    const el = resolve({ ref, selector });
    if (scroll) {
      try { el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }); } catch (_) { el.scrollIntoView(); }
    }
    let target = el;
    let rect = viewportRect(el);
    if (rect.width === 0 || rect.height === 0) {
      // e.g. display:contents or a hidden checkbox: try its label or first child with a box
      const alt = (el.labels && el.labels[0]) || Array.from(el.children).find((c) => hasBox(c));
      if (alt) { target = alt; rect = viewportRect(alt); }
    }
    if (rect.width === 0 || rect.height === 0) {
      throw new Error(`Element ${describe(el)} has no visible size, so it can't be clicked. It may be hidden; take a new snapshot.`);
    }
    // visible portion of the rect, clamped to the viewport
    const x1 = Math.max(rect.x, 0), y1 = Math.max(rect.y, 0);
    const x2 = Math.min(rect.x + rect.width, window.innerWidth), y2 = Math.min(rect.y + rect.height, window.innerHeight);
    if (x2 <= x1 || y2 <= y1) throw new Error(`Element ${describe(el)} is outside the viewport and could not be scrolled into view.`);
    const x = (x1 + x2) / 2, y = (y1 + y2) / 2;
    let warning = null;
    const hit = deepElementFromPoint(document, x, y);
    if (hit && !composedContains(target, hit) && !composedContains(el, hit) && !(target.tagName === 'LABEL' && composedContains(target, hit))) {
      warning = `Target may be covered by another element: ${describe(hit)}. The click lands on whatever is on top.`;
    }
    return { x, y, warning, description: describe(el), tag: el.tagName, editable: isEditable(el) };
  }

  function isEditable(el) {
    if (el.tagName === 'TEXTAREA') return true;
    if (el.tagName === 'INPUT') {
      return !['checkbox', 'radio', 'button', 'submit', 'reset', 'image', 'file', 'range', 'color', 'hidden'].includes((el.type || '').toLowerCase());
    }
    return !!el.isContentEditable;
  }

  // Focus an element and optionally select its current content so typed text replaces it.
  function focus({ ref, selector, clear = false } = {}) {
    const el = resolve({ ref, selector });
    try { el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }); } catch (_) { /* ignore */ }
    el.focus({ preventScroll: true });
    const focused = isFocused(el);
    if (clear && focused) {
      if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
        try { el.select(); } catch (_) { /* some input types don't support select() */ }
      } else if (el.isContentEditable) {
        const doc = el.ownerDocument;
        const range = doc.createRange();
        range.selectNodeContents(el);
        const sel = doc.defaultView.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
      }
    }
    return { focused, editable: isEditable(el), description: describe(el), hasValue: !!(el.value || (el.isContentEditable && el.innerText.trim())) };
  }

  function clearValue({ ref, selector } = {}) {
    const el = resolve({ ref, selector });
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
      const proto = el.tagName === 'INPUT' ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, '');
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }
    return true;
  }

  function selectOption({ ref, selector, values } = {}) {
    const el = resolve({ ref, selector });
    if (el.tagName !== 'SELECT') {
      throw new Error(`Element ${describe(el)} is not a <select>. For custom dropdowns, click it and then click the option.`);
    }
    const wanted = (Array.isArray(values) ? values : [values]).map(String);
    const opts = Array.from(el.options);
    const matched = [];
    for (const w of wanted) {
      const lw = w.trim().toLowerCase();
      const o = opts.find((o) => o.value === w) || opts.find((o) => o.text.trim() === w.trim()) ||
        opts.find((o) => o.text.trim().toLowerCase() === lw) || opts.find((o) => o.text.trim().toLowerCase().includes(lw));
      if (!o) throw new Error(`No option matching ${q(w)}. Options: ${opts.map((o) => q(clean(o.text, 40))).join(', ')}`);
      matched.push(o);
      if (!el.multiple) break;
    }
    el.focus();
    if (el.multiple) for (const o of opts) o.selected = matched.includes(o);
    else {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(el, matched[0].value);
    }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return Array.from(el.selectedOptions).map((o) => o.text.trim());
  }

  function getText({ ref, selector, offset = 0, maxChars = 20000 } = {}) {
    const el = ref || selector ? resolve({ ref, selector }) : document.body || document.documentElement;
    const full = (el.innerText || el.textContent || '').replace(/\n{3,}/g, '\n\n').trim();
    const chunk = full.slice(offset, offset + maxChars);
    const end = offset + chunk.length;
    let head = `URL: ${location.href}\nTitle: ${document.title}\nText chars ${offset}-${end} of ${full.length}`;
    if (end < full.length) head += ` (call again with offset=${end} for more)`;
    return head + '\n\n' + chunk;
  }

  function scrollInfo() {
    const se = document.scrollingElement || document.documentElement;
    return {
      x: Math.round(window.scrollX), y: Math.round(window.scrollY),
      width: se.scrollWidth, height: se.scrollHeight,
      viewportWidth: window.innerWidth, viewportHeight: window.innerHeight,
      dpr: window.devicePixelRatio,
    };
  }

  function rect({ ref, selector } = {}) {
    const el = resolve({ ref, selector });
    try { el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }); } catch (_) { /* ignore */ }
    const r = viewportRect(el);
    if (!r.width || !r.height) throw new Error(`Element ${describe(el)} has no visible size.`);
    return { ...r, description: describe(el) };
  }

  function scrollIntoView({ ref, selector } = {}) {
    const el = resolve({ ref, selector });
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    return describe(el);
  }

  function check({ text, textGone, selector, selectorGone } = {}) {
    const body = document.body ? document.body.innerText || '' : '';
    const visibleSel = (s) => {
      const el = deepQuerySelector(s);
      return !!(el && hasBox(el) && getComputedStyle(el).visibility === 'visible');
    };
    if (text != null && !body.includes(text)) return false;
    if (textGone != null && body.includes(textGone)) return false;
    if (selector != null && !visibleSel(selector)) return false;
    if (selectorGone != null && visibleSel(selectorGone)) return false;
    return true;
  }

  // Temporarily tag an element so CDP (main world) can locate it.
  function tag({ ref, selector, token } = {}) {
    const el = resolve({ ref, selector });
    el.setAttribute('data-claude-bridge-tag', token);
    return { tag: el.tagName, type: el.type || null, description: describe(el), sameDoc: el.ownerDocument === document };
  }
  function untag({ token } = {}) {
    for (const el of document.querySelectorAll(`[data-claude-bridge-tag="${token}"]`)) el.removeAttribute('data-claude-bridge-tag');
    return true;
  }

  const api = { snapshot, find, point, rect, focus, clearValue, selectOption, getText, scrollInfo, scrollIntoView, check, tag, untag };

  window.__claudeBridge = {
    version: VERSION,
    counter: () => counter,
    // minCounter: highest ref number handed out on this tab so far (kept by the extension), so refs
    // stay unique across navigations and a stale ref can never silently match a new element.
    call(method, args, minCounter) {
      if (typeof minCounter === 'number' && counter < minCounter) counter = minCounter;
      try {
        const fn = api[method];
        if (!fn) throw new Error(`Unknown page method ${method}`);
        const value = fn(args || {});
        return { ok: true, value, counter };
      } catch (e) {
        return { ok: false, error: e && e.message ? e.message : String(e), counter };
      }
    },
  };
})();
