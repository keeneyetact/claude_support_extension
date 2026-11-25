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
          position: fixed; left: 10px; bottom: 10px; pointer-events: none; display: flex; align-items: center; gap: 6px;
          font: 600 12px/1.3 system-ui, -apple-system, "Segoe UI", sans-serif; color: #fff; background: var(--c);
          padding: 4px 10px; border-radius: 12px; box-shadow: 0 2px 8px rgba(0,0,0,.3); opacity: .92;
          max-width: 60vw; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
        }
        .dot { width: 7px; height: 7px; border-radius: 50%; background: #fff; flex: none; }
        .working .dot { animation: pulse 1s ease-in-out infinite; }
        @keyframes pulse { 50% { opacity: .3; } }
      </style>
      <div class="frame"></div>
      <div class="pill"><span class="dot"></span><span class="txt"></span></div>`;
    parts = { root, pill: root.querySelector('.pill'), txt: root.querySelector('.txt') };
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
    parts.txt.textContent = `Claude C${owner.number} · ${owner.label}${owner.working ? ` · ${owner.working}…` : ''}`;
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
