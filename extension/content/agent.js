// In-page helper injected into the extension's ISOLATED world (never visible to the page's own scripts).
// Idempotent: re-injecting only replaces it when the version changes.
(() => {
  const VERSION = 7;
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
  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'META', 'LINK', 'HEAD', 'TITLE', 'BASE', 'CLAUDE-BRIDGE-INDICATOR']);
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

  // ---------------------------------------------------------------- input (no debugger)
  // Mouse and keyboard input are DOM events dispatched to the element under the point / the focused
  // element. Events alone don't make the browser act (no focus, no caret, no scrolling, no Tab), so
  // those default actions are done here by hand, the way the browser would do them.

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const parentOf = (n) => n.parentNode || n.host || null; // crosses shadow roots

  /** Element under a top-viewport point, through shadow roots and same-origin iframes. */
  function hitAt(x, y) {
    let doc = document, cx = x, cy = y, el = null;
    for (let depth = 0; depth < 10; depth++) {
      el = doc.elementFromPoint(cx, cy);
      if (!el) return null;
      for (let i = 0; i < 30; i++) {
        const sr = shadowOf(el);
        const inner = sr && sr.elementFromPoint ? sr.elementFromPoint(cx, cy) : null;
        if (!inner || inner === el) break;
        el = inner;
      }
      if (el.tagName === 'IFRAME' || el.tagName === 'FRAME') {
        const fr = el.getBoundingClientRect();
        const cs = el.ownerDocument.defaultView.getComputedStyle(el);
        const nx = cx - fr.left - el.clientLeft - parseFloat(cs.paddingLeft || 0);
        const ny = cy - fr.top - el.clientTop - parseFloat(cs.paddingTop || 0);
        const d = frameDoc(el);
        if (d) { doc = d; cx = nx; cy = ny; continue; }
        // Cross-origin frame: the extension repeats the action inside that frame.
        return { el, cx, cy, frame: { src: el.src, name: el.name || '', x: nx, y: ny } };
      }
      break;
    }
    return { el, cx, cy };
  }

  /** The focused element, through shadow roots and same-origin iframes. */
  function deepActive() {
    let a = document.activeElement || document.body;
    for (let i = 0; i < 30 && a; i++) {
      const sr = shadowOf(a);
      if (sr && sr.activeElement) { a = sr.activeElement; continue; }
      if (a.tagName === 'IFRAME' || a.tagName === 'FRAME') {
        const d = frameDoc(a);
        if (d) { a = d.activeElement || d.body; continue; }
        return { frame: { src: a.src, name: a.name || '' } };
      }
      break;
    }
    return { el: a || document.body };
  }

  const modInit = (m = {}) => ({ ctrlKey: !!m.ctrl, shiftKey: !!m.shift, altKey: !!m.alt, metaKey: !!m.meta });
  const NO_BUBBLE = new Set(['mouseenter', 'mouseleave', 'pointerenter', 'pointerleave']);

  /** Dispatch a mouse/pointer event; returns false when a listener called preventDefault(). */
  function mouse(el, type, cx, cy, o = {}) {
    const view = el.ownerDocument.defaultView;
    const init = {
      bubbles: !NO_BUBBLE.has(type), cancelable: !NO_BUBBLE.has(type), composed: true, view,
      clientX: cx, clientY: cy, screenX: cx + (view.screenX || 0), screenY: cy + (view.screenY || 0),
      button: o.button || 0, buttons: o.buttons || 0, detail: o.detail || 0, relatedTarget: o.related || null,
      ...modInit(o.modifiers),
    };
    let ev;
    if (type.startsWith('pointer')) {
      ev = new PointerEvent(type, { ...init, pointerId: 1, pointerType: 'mouse', isPrimary: true, width: 1, height: 1, pressure: init.buttons ? 0.5 : 0 });
    } else {
      ev = new MouseEvent(type, init);
    }
    return el.dispatchEvent(ev);
  }

  function chain(el) {
    const out = [];
    for (let n = el; n && n.nodeType === 1; n = parentOf(n)) out.push(n);
    return out;
  }

  function commonAncestor(a, b) {
    const ca = new Set(chain(a));
    for (const n of chain(b)) if (ca.has(n)) return n;
    return b;
  }

  let hovered = null; // WeakRef of the element the mouse is over

  /** Move the mouse onto el: over/out, enter/leave for each ancestor that changed, then move. */
  function moveTo(el, cx, cy, o = {}) {
    const prev = hovered && hovered.deref();
    if (prev !== el) {
      const before = prev && prev.isConnected ? chain(prev) : [];
      const after = chain(el);
      const stay = new Set(after);
      if (before.length) {
        mouse(prev, 'pointerout', cx, cy, { ...o, related: el });
        mouse(prev, 'mouseout', cx, cy, { ...o, related: el });
        for (const n of before) if (!stay.has(n)) { mouse(n, 'pointerleave', cx, cy, { ...o, related: el }); mouse(n, 'mouseleave', cx, cy, { ...o, related: el }); }
      }
      mouse(el, 'pointerover', cx, cy, { ...o, related: prev || null });
      mouse(el, 'mouseover', cx, cy, { ...o, related: prev || null });
      const was = new Set(before);
      for (const n of after.reverse()) if (!was.has(n)) { mouse(n, 'pointerenter', cx, cy, { ...o, related: prev || null }); mouse(n, 'mouseenter', cx, cy, { ...o, related: prev || null }); }
      hovered = new WeakRef(el);
    }
    mouse(el, 'pointermove', cx, cy, o);
    mouse(el, 'mousemove', cx, cy, o);
  }

  const FOCUSABLE = 'a[href],area[href],button,input:not([type=hidden]),select,textarea,iframe,summary,[tabindex],[contenteditable]:not([contenteditable=false]),audio[controls],video[controls]';

  function focusableAncestor(el) {
    for (let n = el; n && n.nodeType === 1; n = parentOf(n)) {
      if (n.matches && n.matches(FOCUSABLE) && !n.disabled) return n;
      if (n.isContentEditable) {
        // the editing host is the outermost contenteditable element
        let host = n;
        for (let p = parentOf(n); p && p.nodeType === 1 && p.isContentEditable; p = parentOf(p)) host = p;
        return host;
      }
    }
    return null;
  }

  /** What a real mousedown does by default: move focus, and put the caret where the click is. */
  function focusOnPress(el, cx, cy) {
    const target = focusableAncestor(el);
    const act = deepActive().el;
    if (!target) {
      if (act && act !== document.body && act.blur) act.blur();
      return;
    }
    if (target !== act) target.focus({ preventScroll: true });
    const doc = target.ownerDocument;
    if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') {
      if (target !== act) { try { const n = target.value.length; target.setSelectionRange(n, n); } catch (_) { /* email, number… */ } }
    } else if (target.isContentEditable && doc.caretRangeFromPoint) {
      const r = doc.caretRangeFromPoint(cx, cy);
      if (r && composedContains(target, r.startContainer)) {
        const sel = doc.defaultView.getSelection();
        sel.removeAllRanges();
        sel.addRange(r);
      }
    }
  }

  /**
   * Dispatch click. A link that should open in a new tab can't do so from a synthetic click (no user
   * activation, so Chrome blocks it), so it is cancelled here and the extension opens the tab.
   */
  function fireClick(el, cx, cy, detail, modifiers) {
    const view = el.ownerDocument.defaultView;
    let link = null;
    const guard = (e) => {
      if (e.defaultPrevented) return; // the page (e.g. a client-side router) handled it
      const a = e.composedPath().find((n) => n.tagName === 'A' || n.tagName === 'AREA');
      if (!a || !a.href || !/^https?:/i.test(a.href) || a.hasAttribute('download')) return;
      const t = (a.getAttribute('target') || '').toLowerCase();
      if (t === '_blank' || modifiers.ctrl || modifiers.meta || modifiers.shift) {
        e.preventDefault();
        link = { url: a.href, newTab: true, active: !(modifiers.ctrl || modifiers.meta) || !!modifiers.shift };
      } else if ((!t || t === '_self' || t === '_top' || t === '_parent') && view === view.top && !modifiers.alt) {
        // Chrome marks history entries made without a real click as skippable, so Back would
        // jump over this page. Navigating the tab from the extension keeps history normal.
        e.preventDefault();
        link = { url: a.href, newTab: false };
      }
    };
    view.addEventListener('click', guard);
    try { mouse(el, 'click', cx, cy, { detail, modifiers }); } finally { view.removeEventListener('click', guard); }
    return link;
  }

  function clickAt({ x, y, button = 'left', clickCount = 1, modifiers = {} } = {}) {
    let h = hitAt(x, y);
    if (!h) throw new Error(`Nothing at (${Math.round(x)}, ${Math.round(y)}): the point is outside the page.`);
    if (h.frame) return { frame: h.frame };
    const b = { left: 0, middle: 1, right: 2 }[button] ?? 0;
    const bits = { left: 1, middle: 4, right: 2 }[button] ?? 1;
    const o = { modifiers };
    moveTo(h.el, h.cx, h.cy, o);
    let link = null;
    for (let i = 1; i <= Math.max(1, Math.min(clickCount, 3)); i++) {
      const downEl = h.el;
      mouse(downEl, 'pointerdown', h.cx, h.cy, { ...o, button: b, buttons: bits });
      const down = mouse(downEl, 'mousedown', h.cx, h.cy, { ...o, button: b, buttons: bits, detail: i });
      if (down && i === 1 && downEl.isConnected) focusOnPress(downEl, h.cx, h.cy);
      // mousedown handlers often re-render; the mouseup lands on whatever is there now
      const up = hitAt(x, y);
      const upEl = up && !up.frame ? up.el : downEl;
      mouse(upEl, 'pointerup', h.cx, h.cy, { ...o, button: b });
      mouse(upEl, 'mouseup', h.cx, h.cy, { ...o, button: b, detail: i });
      const target = downEl.isConnected ? commonAncestor(downEl, upEl) : upEl;
      if (b === 0) link = fireClick(target, h.cx, h.cy, i, modifiers) || link;
      else mouse(target, 'auxclick', h.cx, h.cy, { ...o, button: b, detail: i });
      if (b === 2) mouse(target, 'contextmenu', h.cx, h.cy, { ...o, button: 2 });
      if (i === 2 && b === 0) mouse(target, 'dblclick', h.cx, h.cy, { ...o, detail: 2 });
      h = { ...h, el: target };
    }
    return { link, target: describe(h.el) };
  }

  function hoverAt({ x, y } = {}) {
    const h = hitAt(x, y);
    if (!h) throw new Error(`Nothing at (${Math.round(x)}, ${Math.round(y)}).`);
    if (h.frame) return { frame: h.frame };
    moveTo(h.el, h.cx, h.cy);
    return { target: describe(h.el) };
  }

  function drag(el, type, cx, cy, dt) {
    const view = el.ownerDocument.defaultView;
    return el.dispatchEvent(new DragEvent(type, {
      bubbles: true, cancelable: type !== 'dragleave' && type !== 'dragend', composed: true, view,
      clientX: cx, clientY: cy, buttons: type === 'dragend' || type === 'drop' ? 0 : 1, dataTransfer: dt,
    }));
  }

  /** Mouse drag, plus HTML5 drag and drop when the source is draggable. */
  async function dragAt({ from, to, steps = 12 } = {}) {
    const a = hitAt(from.x, from.y);
    if (!a) throw new Error('Nothing at the drag source point.');
    if (a.frame) throw new Error('The drag source is inside a cross-origin frame, which can only be dragged inside itself.');
    moveTo(a.el, a.cx, a.cy);
    mouse(a.el, 'pointerdown', a.cx, a.cy, { buttons: 1 });
    mouse(a.el, 'mousedown', a.cx, a.cy, { buttons: 1, detail: 1 });
    focusOnPress(a.el, a.cx, a.cy);
    const src = a.el.closest ? a.el.closest('[draggable="true"]') : null;
    const dt = src ? new DataTransfer() : null;
    let dnd = !!src && drag(src, 'dragstart', a.cx, a.cy, dt);
    let over = null, droppable = false, last = a;
    for (let i = 1; i <= steps; i++) {
      const x = from.x + ((to.x - from.x) * i) / steps;
      const y = from.y + ((to.y - from.y) * i) / steps;
      const h = hitAt(x, y);
      if (!h || h.frame) continue;
      last = h;
      if (dnd) {
        drag(src, 'drag', h.cx, h.cy, dt);
        if (h.el !== over) {
          drag(h.el, 'dragenter', h.cx, h.cy, dt);
          if (over) drag(over, 'dragleave', h.cx, h.cy, dt);
          over = h.el;
        }
        droppable = !drag(h.el, 'dragover', h.cx, h.cy, dt);
      } else {
        mouse(h.el, 'pointermove', h.cx, h.cy, { buttons: 1 });
        mouse(h.el, 'mousemove', h.cx, h.cy, { buttons: 1 });
      }
      await sleep(16);
    }
    if (dnd) {
      if (over && droppable) drag(over, 'drop', last.cx, last.cy, dt);
      else if (over) drag(over, 'dragleave', last.cx, last.cy, dt);
      drag(src, 'dragend', last.cx, last.cy, dt);
      return { html5: true, dropped: !!(over && droppable) };
    }
    mouse(last.el, 'pointerup', last.cx, last.cy, {});
    mouse(last.el, 'mouseup', last.cx, last.cy, { detail: 1 });
    hovered = new WeakRef(last.el);
    return { html5: false };
  }

  function canScroll(n, dx, dy) {
    const cs = n.ownerDocument.defaultView.getComputedStyle(n);
    const y = dy && /(auto|scroll|overlay)/.test(cs.overflowY) && n.scrollHeight > n.clientHeight &&
      (dy > 0 ? n.scrollTop + n.clientHeight < n.scrollHeight - 1 : n.scrollTop > 0);
    const x = dx && /(auto|scroll|overlay)/.test(cs.overflowX) && n.scrollWidth > n.clientWidth &&
      (dx > 0 ? n.scrollLeft + n.clientWidth < n.scrollWidth - 1 : n.scrollLeft > 0);
    return !!(x || y);
  }

  /** Mouse wheel: a wheel event, then scroll the nearest container (or page) that can move that way. */
  function wheelAt({ x, y, dx = 0, dy = 0 } = {}) {
    const h = hitAt(x, y);
    if (!h) throw new Error(`Nothing at (${Math.round(x)}, ${Math.round(y)}).`);
    if (h.frame) return { frame: h.frame };
    const view = h.el.ownerDocument.defaultView;
    const ok = h.el.dispatchEvent(new WheelEvent('wheel', {
      bubbles: true, cancelable: true, composed: true, view, clientX: h.cx, clientY: h.cy, deltaX: dx, deltaY: dy, deltaMode: 0,
    }));
    if (!ok) return { prevented: true };
    for (let n = h.el; n;) {
      const doc = n.ownerDocument;
      if (n.nodeType === 1 && n !== doc.documentElement && n !== doc.body && canScroll(n, dx, dy)) {
        n.scrollBy({ left: dx, top: dy, behavior: 'instant' });
        return { scrolled: describe(n) };
      }
      const p = parentOf(n);
      if (p && p.nodeType === 1) { n = p; continue; }
      // reached the document: scroll its window if it can move, otherwise continue in the parent frame
      const w = doc.defaultView;
      const se = doc.scrollingElement || doc.documentElement;
      const canY = dy && (dy > 0 ? w.scrollY + w.innerHeight < se.scrollHeight - 1 : w.scrollY > 0);
      const canX = dx && (dx > 0 ? w.scrollX + w.innerWidth < se.scrollWidth - 1 : w.scrollX > 0);
      if (canX || canY || w === window) { w.scrollBy({ left: dx, top: dy, behavior: 'instant' }); return { scrolled: 'page' }; }
      try { n = w.frameElement; } catch (_) { n = null; }
    }
    return { scrolled: null };
  }

  // -- keyboard

  function nativeSetValue(el, v) {
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v);
  }

  /**
   * Insert text at the caret. execCommand('insertText') makes Chrome do a real edit (beforeinput and
   * input events, undo history), which React, Vue, Angular and rich-text editors all understand.
   */
  function insertText(el, text) {
    const doc = el.ownerDocument;
    let ok = false;
    try { ok = doc.execCommand('insertText', false, text); } catch (_) { ok = false; }
    if (ok) return true;
    const ev = (t, cancelable) => new InputEvent(t, { bubbles: true, cancelable, composed: true, inputType: 'insertText', data: text });
    if (!el.dispatchEvent(ev('beforeinput', true))) return false;
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
      let s = null, e = null;
      try { s = el.selectionStart; e = el.selectionEnd; } catch (_) { /* no selection API */ }
      const v = el.value;
      const nv = s == null ? v + text : v.slice(0, s) + text + v.slice(e);
      nativeSetValue(el, nv);
      if (s != null) { try { el.setSelectionRange(s + text.length, s + text.length); } catch (_) { /* ignore */ } }
      el.dispatchEvent(ev('input', false));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }
    if (el.isContentEditable) {
      const sel = doc.defaultView.getSelection();
      if (!sel.rangeCount) return false;
      const r = sel.getRangeAt(0);
      r.deleteContents();
      const node = doc.createTextNode(text);
      r.insertNode(node);
      r.setStartAfter(node);
      r.collapse(true);
      sel.removeAllRanges();
      sel.addRange(r);
      el.dispatchEvent(ev('input', false));
      return true;
    }
    return false;
  }

  function charDef(ch) {
    if (/^[a-z]$/i.test(ch)) return { key: ch, code: 'Key' + ch.toUpperCase(), keyCode: ch.toUpperCase().charCodeAt(0), text: ch };
    if (/^[0-9]$/.test(ch)) return { key: ch, code: 'Digit' + ch, keyCode: ch.charCodeAt(0), text: ch };
    if (ch === ' ') return { key: ' ', code: 'Space', keyCode: 32, text: ' ' };
    return { key: ch, code: '', keyCode: 0, text: ch };
  }

  function key(el, type, d, m = {}) {
    const view = el.ownerDocument.defaultView;
    const charCode = type === 'keypress' && d.text ? d.text.charCodeAt(0) : 0;
    return el.dispatchEvent(new KeyboardEvent(type, {
      bubbles: true, cancelable: true, composed: true, view,
      key: d.key, code: d.code || '', location: d.location || 0,
      keyCode: type === 'keypress' ? charCode : d.keyCode || 0, which: type === 'keypress' ? charCode : d.keyCode || 0, charCode,
      ...modInit(m),
    }));
  }

  /** Focus target for keyboard input, or a cross-origin frame to forward to. */
  function keyTarget() {
    const a = deepActive();
    return a.frame ? a : { el: a.el || document.body };
  }

  async function typeText({ text = '', slowly = false } = {}) {
    const t = keyTarget();
    if (t.frame) return { frame: t.frame };
    const el = t.el;
    const editable = isEditable(el);
    if (!slowly && editable) {
      insertText(el, text);
      return { typed: text.length, editable };
    }
    for (const ch of text) {
      if (ch === '\n') { pressKey({ def: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' } }); continue; }
      const cur = keyTarget().el || el;
      const d = charDef(ch);
      let go = key(cur, 'keydown', d);
      if (go) go = key(cur, 'keypress', d);
      if (go && isEditable(cur)) insertText(cur, ch);
      key(cur, 'keyup', d);
      if (slowly) await sleep(25);
    }
    return { typed: text.length, editable };
  }

  function tabbables(doc) {
    const out = [];
    const walk = (root) => {
      for (const el of root.querySelectorAll('*')) {
        if (el.matches(FOCUSABLE) && !el.disabled && el.tabIndex >= 0 && hasBox(el) &&
          el.ownerDocument.defaultView.getComputedStyle(el).visibility === 'visible' && !el.closest('[inert]')) out.push(el);
        const sr = shadowOf(el);
        if (sr) walk(sr);
      }
    };
    walk(doc);
    const pos = out.filter((e) => e.tabIndex > 0).sort((a, b) => a.tabIndex - b.tabIndex);
    return [...pos, ...out.filter((e) => e.tabIndex === 0)];
  }

  function moveFocus(el, dir) {
    const list = tabbables(el.ownerDocument);
    if (!list.length) return 'no focusable elements';
    const i = list.indexOf(el);
    const next = list[(i < 0 ? (dir > 0 ? 0 : list.length - 1) : (i + dir + list.length) % list.length)];
    next.focus();
    if (next.select && (next.tagName === 'INPUT' || next.tagName === 'TEXTAREA')) { try { next.select(); } catch (_) { /* ignore */ } }
    return 'focus moved to ' + describe(next);
  }

  function selectAll(el) {
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') { try { el.select(); return; } catch (_) { /* fall through */ } }
    const host = el.isContentEditable ? focusableAncestor(el) : null;
    const doc = el.ownerDocument;
    if (host) {
      const r = doc.createRange();
      r.selectNodeContents(host);
      const sel = doc.defaultView.getSelection();
      sel.removeAllRanges();
      sel.addRange(r);
    } else {
      doc.execCommand('selectAll');
    }
  }

  function moveCaret(el, k, m) {
    const extend = !!m.shift;
    const word = !!(m.ctrl || m.alt);
    if ((el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') && el.selectionStart != null && k !== 'ArrowUp' && k !== 'ArrowDown') {
      const len = el.value.length;
      let s = el.selectionStart, e = el.selectionEnd;
      const back = el.selectionDirection === 'backward';
      let caret = back ? s : e;
      const anchor = back ? e : s;
      if (k === 'Home') caret = 0;
      else if (k === 'End') caret = len;
      else if (!extend && s !== e) caret = k === 'ArrowLeft' ? s : e;
      else if (word) {
        const v = el.value;
        if (k === 'ArrowLeft') { caret = Math.max(0, caret - 1); while (caret > 0 && /\w/.test(v[caret - 1])) caret--; }
        else { while (caret < len && !/\w/.test(v[caret])) caret++; while (caret < len && /\w/.test(v[caret])) caret++; }
      } else caret = Math.max(0, Math.min(len, caret + (k === 'ArrowLeft' ? -1 : 1)));
      if (extend) el.setSelectionRange(Math.min(anchor, caret), Math.max(anchor, caret), caret < anchor ? 'backward' : 'forward');
      else el.setSelectionRange(caret, caret);
      return;
    }
    const sel = el.ownerDocument.defaultView.getSelection();
    const [dir, gran] = {
      ArrowLeft: ['backward', word ? 'word' : 'character'], ArrowRight: ['forward', word ? 'word' : 'character'],
      ArrowUp: ['backward', 'line'], ArrowDown: ['forward', 'line'],
      Home: ['backward', 'lineboundary'], End: ['forward', 'lineboundary'],
    }[k];
    if (sel.modify) sel.modify(extend ? 'extend' : 'move', dir, gran);
  }

  function scrollPage(el, k, m) {
    const w = el.ownerDocument.defaultView;
    const h = w.innerHeight * 0.85;
    const by = { ArrowDown: 40, ArrowUp: -40, PageDown: h, PageUp: -h, ' ': m.shift ? -h : h }[k];
    if (k === 'Home') w.scrollTo({ top: 0, behavior: 'instant' });
    else if (k === 'End') w.scrollTo({ top: (w.document.scrollingElement || w.document.documentElement).scrollHeight, behavior: 'instant' });
    else if (by) w.scrollBy({ top: by, behavior: 'instant' });
    else if (k === 'ArrowLeft' || k === 'ArrowRight') w.scrollBy({ left: k === 'ArrowLeft' ? -40 : 40, behavior: 'instant' });
    return 'scrolled';
  }

  const ACTIVATES = 'button,summary,a[href],input[type=button],input[type=submit],input[type=reset],input[type=checkbox],input[type=radio],[role=button],[role=link],[role=checkbox],[role=switch],[role=tab],[role=menuitem],[role=option]';

  /** What the browser would do for a key nobody cancelled. Returns a short note for the agent. */
  function keyDefault(el, d, m) {
    const k = d.key;
    const editable = isEditable(el);
    const doc = el.ownerDocument;
    const exec = (c, v) => { try { return doc.execCommand(c, false, v); } catch (_) { return false; } };
    if ((m.ctrl || m.meta) && !m.alt) {
      switch (k.toLowerCase()) {
        case 'a': selectAll(el); return 'selected all';
        case 'z': exec(m.shift ? 'redo' : 'undo'); return m.shift ? 'redo' : 'undo';
        case 'y': exec('redo'); return 'redo';
        case 'x': return exec('cut') ? 'cut' : '';
        case 'c': return exec('copy') ? 'copied' : '';
        case 'v': return 'paste needs real keyboard input; use type with the text instead';
        case 'backspace': if (editable) { doc.defaultView.getSelection().modify?.('extend', 'backward', 'word'); exec('delete'); } return '';
        case 'delete': if (editable) { doc.defaultView.getSelection().modify?.('extend', 'forward', 'word'); exec('forwardDelete'); } return '';
        case 'arrowleft': case 'arrowright': if (editable) moveCaret(el, k, m); return '';
        case 'home': case 'end': if (!editable) scrollPage(el, k, m); else moveCaret(el, k, m); return '';
      }
      return '';
    }
    switch (k) {
      case 'Enter': {
        if (el.tagName === 'TEXTAREA') { insertText(el, '\n'); return ''; }
        if (el.isContentEditable) { exec(m.shift ? 'insertLineBreak' : 'insertParagraph'); return ''; }
        if (el.tagName === 'INPUT' && el.form && !/^(button|submit|reset|checkbox|radio|file|image)$/i.test(el.type)) {
          const form = el.form;
          const def = Array.from(form.elements).find((e) => (e.type === 'submit' || e.type === 'image') && !e.disabled);
          if (def) def.click(); else form.requestSubmit();
          return 'submitted the form';
        }
        if (el.matches && el.matches('button,summary,a[href],input[type=button],input[type=submit],input[type=reset],[role=button],[role=link],[role=menuitem],[role=option],[role=tab]')) { el.click(); return 'activated ' + describe(el); }
        return '';
      }
      case ' ':
        if (editable) { insertText(el, ' '); return ''; }
        if (el.matches && el.matches(ACTIVATES) && !(el.tagName === 'A')) { el.click(); return 'activated ' + describe(el); }
        return scrollPage(el, k, m);
      case 'Tab': return moveFocus(el, m.shift ? -1 : 1);
      case 'Backspace': if (editable) exec('delete'); return '';
      case 'Delete': if (editable) exec('forwardDelete'); return '';
      case 'ArrowUp': case 'ArrowDown':
        if (el.tagName === 'SELECT' && !el.multiple) {
          const i = Math.max(0, Math.min(el.options.length - 1, el.selectedIndex + (k === 'ArrowDown' ? 1 : -1)));
          if (i !== el.selectedIndex) { el.selectedIndex = i; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); }
          return 'selected ' + clean(el.options[i]?.text || '', 40);
        }
      // falls through
      case 'ArrowLeft': case 'ArrowRight': case 'Home': case 'End':
        if (editable) { moveCaret(el, k, m); return ''; }
        return scrollPage(el, k, m);
      case 'PageUp': case 'PageDown': return scrollPage(el, k, m);
    }
    if (d.text && d.text.length === 1 && !m.alt && editable) insertText(el, d.text);
    return '';
  }

  /** One key or combo: modifier keydowns, keydown, keypress, the default action, keyups. */
  function pressKey({ def, mods = [], modifiers = {} } = {}) {
    const t = keyTarget();
    if (t.frame) return { frame: t.frame };
    const el = t.el;
    const held = {};
    for (const md of mods) { held[md.flag] = true; key(el, 'keydown', md, held); }
    let note = '';
    const down = key(el, 'keydown', def, modifiers);
    let go = down;
    if (go && def.text && !modifiers.ctrl && !modifiers.alt && !modifiers.meta) go = key(el, 'keypress', def, modifiers);
    if (go) note = keyDefault(el, def, modifiers);
    else note = 'the page handled the key (preventDefault)';
    key(keyTarget().el || el, 'keyup', def, modifiers);
    for (const md of [...mods].reverse()) { delete held[md.flag]; key(el, 'keyup', md, held); }
    return { note };
  }

  // -- files

  /** Put files on an <input type=file> the way a file picker would. */
  function setFiles({ ref, selector, files = [] } = {}) {
    const el = resolve({ ref, selector });
    if (el.tagName !== 'INPUT' || String(el.type).toLowerCase() !== 'file') {
      throw new Error(`Element ${describe(el)} is not an <input type="file">. Find the file input (it is often hidden; try find "file" or selector 'input[type=file]').`);
    }
    const dt = new DataTransfer();
    for (const f of files) {
      const bin = atob(f.data);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      dt.items.add(new File([bytes], f.name, { type: f.type || '', lastModified: f.lastModified || Date.now() }));
    }
    if (!el.multiple && dt.files.length > 1) throw new Error(`${describe(el)} accepts only one file.`);
    el.files = dt.files;
    el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    el.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
    return { description: describe(el), names: Array.from(el.files).map((f) => f.name) };
  }

  // -- full-page screenshots

  let hiddenFixed = [];
  /** Hide fixed/sticky elements so they don't repeat in every slice of a stitched screenshot. */
  function hideFixed() {
    for (const el of document.querySelectorAll('body *')) {
      const p = getComputedStyle(el).position;
      if ((p === 'fixed' || p === 'sticky') && el.tagName !== 'CLAUDE-BRIDGE-INDICATOR') {
        hiddenFixed.push([el, el.style.getPropertyValue('visibility'), el.style.getPropertyPriority('visibility')]);
        el.style.setProperty('visibility', 'hidden', 'important');
      }
    }
    return hiddenFixed.length;
  }
  function restoreFixed() {
    for (const [el, v, p] of hiddenFixed) {
      if (v) el.style.setProperty('visibility', v, p); else el.style.removeProperty('visibility');
    }
    hiddenFixed = [];
    return true;
  }
  function scrollToXY({ x = 0, y = 0 } = {}) {
    window.scrollTo({ left: x, top: y, behavior: 'instant' });
    return { x: window.scrollX, y: window.scrollY };
  }

  const api = {
    snapshot, find, point, rect, focus, clearValue, selectOption, getText, scrollInfo, scrollIntoView, check,
    clickAt, hoverAt, dragAt, wheelAt, typeText, pressKey, setFiles, hideFixed, restoreFixed, scrollToXY,
  };

  window.__claudeBridge = {
    version: VERSION,
    counter: () => counter,
    // minCounter: highest ref number handed out on this tab so far (kept by the extension), so refs
    // stay unique across navigations and a stale ref can never silently match a new element.
    call(method, args, minCounter) {
      if (typeof minCounter === 'number' && counter < minCounter) counter = minCounter;
      const fail = (e) => ({ ok: false, error: e && e.message ? e.message : String(e), counter });
      try {
        const fn = api[method];
        if (!fn) throw new Error(`Unknown page method ${method}`);
        const value = fn(args || {});
        // executeScript waits for a returned promise
        if (value && typeof value.then === 'function') return value.then((v) => ({ ok: true, value: v, counter }), fail);
        return { ok: true, value, counter };
      } catch (e) {
        return fail(e);
      }
    },
  };
})();
