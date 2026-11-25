// On-page marker shown while a Claude session controls this tab: a coloured frame around the
// viewport and a small label. It asks the extension every couple of seconds who controls the tab
// and removes itself when nobody does (session ended, tab released, extension reloaded).
// pointer-events: none everywhere, so it never intercepts the user's or Claude's clicks.
(() => {
  // Replace any earlier copy (it may belong to a reloaded, no longer reachable extension).
  try { window.__claudeBridgeIndicator?.remove(); } catch (_) { /* ignore */ }
  document.querySelectorAll('claude-bridge-indicator').forEach((n) => n.remove());
  const TAG = 'claude-bridge-indicator';
  const POLL_MS = 2000;
  let host = null;
  let parts = null;
  let timer = null;
  let hidden = false;
  let removed = false; // set once replaced or released; a check still in flight must not rebuild it

  function build() {
    host = document.createElement(TAG);
    host.setAttribute('aria-hidden', 'true');
    host.style.cssText = 'all: initial; position: fixed; inset: 0; pointer-events: none; z-index: 2147483647; display: block;';
    const root = host.attachShadow({ mode: 'closed' });
    root.innerHTML = `
      <style>
        .frame { position: fixed; inset: 0; pointer-events: none; box-shadow: inset 0 0 0 3px var(--c); }
        .pill {
          position: fixed; left: 12px; bottom: 12px; pointer-events: none; display: flex; align-items: center; gap: 8px;
          font: 13px/1.3 system-ui, -apple-system, "Segoe UI", sans-serif; color: #fff; background: var(--c);
          padding: 6px 12px 6px 10px; border-radius: 16px; box-shadow: 0 2px 10px rgba(0,0,0,.35);
          max-width: min(70vw, 560px); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
        }
        .dot { width: 8px; height: 8px; border-radius: 50%; background: #fff; flex: none; }
        .working .dot { animation: pulse 1s ease-in-out infinite; }
        @keyframes pulse { 50% { opacity: .3; } }
        .main { font-weight: 700; }
        .who { opacity: .85; overflow: hidden; text-overflow: ellipsis; }
        .badge { font-weight: 700; font-size: 11px; background: rgba(255,255,255,.25); padding: 0 5px; border-radius: 5px; flex: none; }
      </style>
      <div class="frame"></div>
      <div class="pill"><span class="dot"></span><span class="main"></span><span class="badge"></span><span class="who"></span></div>`;
    parts = {
      pill: root.querySelector('.pill'), main: root.querySelector('.main'),
      badge: root.querySelector('.badge'), who: root.querySelector('.who'),
    };
  }

  function remove() {
    removed = true;
    clearInterval(timer);
    timer = null;
    if (host) host.remove();
    host = null;
    if (window.__claudeBridgeIndicator === api) delete window.__claudeBridgeIndicator;
  }

  function render(owner) {
    if (removed) return;
    if (!owner) return remove();
    if (!host) build();
    if (!host.isConnected) document.documentElement.append(host);
    host.style.display = hidden ? 'none' : 'block';
    host.style.setProperty('--c', owner.color);
    parts.pill.classList.toggle('working', !!owner.working);
    parts.main.textContent = owner.working ? `Claude is ${owner.working}…` : 'Claude is controlling this tab';
    parts.badge.textContent = 'C' + owner.number;
    parts.who.textContent = owner.label;
  }

  async function check() {
    let owner = null;
    try {
      owner = (await chrome.runtime.sendMessage({ type: 'indicatorState' }))?.owner || null;
    } catch (_) {
      owner = null; // extension reloaded or gone
    }
    render(owner);
  }

  const api = {
    check,
    remove,
    setHidden(h) {
      hidden = !!h;
      if (host) host.style.display = hidden ? 'none' : 'block';
    },
  };
  window.__claudeBridgeIndicator = api;
  timer = setInterval(check, POLL_MS);
  check();
})();
