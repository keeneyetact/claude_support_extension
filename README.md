# Claude Browser Bridge

Lets a **Claude Code** agent see and control your **real Chrome profiles**: your logins, cookies, open tabs and extensions. It doesn't launch a separate automation browser.

```
Claude Code ──stdio(MCP)──► server/index.js ──ws://127.0.0.1:18765──► Chrome extension (in each profile)
                                                                          │
                                                       chrome.debugger (CDP) + chrome.scripting
```

* **`extension/`** is a Manifest V3 Chrome extension. Install it in every Chrome profile you want Claude to use. Its service worker connects *out* to the local bridge and runs the commands.
* **`server/`** is a Node MCP server. Claude Code starts it automatically, and it exposes browser tools to the agent.

Several Chrome profiles can connect at the same time, and Claude picks one by name. Several Claude Code sessions can also run at once: each one binds the next free port in 18765–18774, and the extension connects to all of them.

## Install (about 2 minutes)

You need **Google Chrome**, **[Claude Code](https://claude.com/claude-code)** (terminal, VS Code, Cursor or the desktop app) and **[Node.js](https://nodejs.org) 18 or newer**.

### 1. Run one command

```
npx -y claude-browser-bridge-mcp setup
```

This works the same on Windows, macOS and Linux, in any terminal. It:

* installs the bridge in `~/.claude-browser-bridge`, so it keeps working after npx clears its cache;
* registers it with Claude Code for all your projects (`claude mcp add --scope user chrome-bridge`). If `claude` isn't on your PATH, setup uses the copy bundled with the VS Code, Cursor or Windsurf extension;
* opens Chrome on `chrome://extensions`, opens the extension folder, and copies the folder path to your clipboard.

### 2. Add the extension to Chrome

On the `chrome://extensions` page that setup opened:

1. Turn on **Developer mode** (top right).
2. Click **Load unpacked**, paste the folder path from your clipboard, and choose the folder.
3. Pin the extension (puzzle icon → pin).

Do this once in **each Chrome profile** you want Claude to use. Claude knows each profile by its signed-in email. To use a shorter name such as `Work`, set one in the extension's *Settings*.

### 3. Use it

Restart Claude Code, or start a new session. Then, in Chrome, click the extension icon → **Copy prompt for Claude** and paste the prompt into Claude Code. Or just ask Claude, for example *"In Chrome, summarise the page I have open."*

**Update:** run the same `setup` command again, then click **Reload** on the extension in `chrome://extensions`.
**Uninstall:** `npx -y claude-browser-bridge-mcp uninstall`, then remove the extension in each profile.
**No pop-ups** (over SSH, for example): `setup --no-open` only prints the steps.

### Install from a clone (for developers)

```
git clone <this repo> claude-browser-bridge
cd claude-browser-bridge/server
npm run setup
```

`npm run setup` installs the dependencies and registers this folder's `server/index.js` with Claude Code. Load `extension/` unpacked, as in step 2. After you edit the extension, click **Reload** on its card in `chrome://extensions` (or ask Claude to run `extension_reload`).

To register by hand instead: `claude mcp add --scope user chrome-bridge -- node "<absolute path>/server/index.js"`.

## Use

### Give a tab to a Claude session (easiest)

1. In Chrome, go to the tab you want Claude to work in.
2. Click the extension icon. Optionally, type what Claude should do.
3. Click **Copy prompt for Claude** and paste it into any Claude Code session.

The prompt tells the session which profile and tab to use (`select_profile`, then `tab_select`), what to do if the tab id has changed, and to stay in that tab. If another session holds the tab, the prompt says you're handing it over (`takeOver: true`). If the session doesn't have the chrome-bridge tools yet, the prompt includes the command that adds them, and the session then asks you to restart. When the bridge is installed on this computer, that's the exact `claude mcp add` command for your install: the server writes it to `extension/server-path.json` each time it starts, and a connected server reports it too. The extension uses that file only if it was written for its own folder, so a copied project never shows another machine's path. Before anything is installed, the prompt gives the one-line `npx -y claude-browser-bridge-mcp setup`.

To have several sessions work at once, copy a prompt from a different tab for each one.

### Find the Claude session behind a tab

Each session card in the popup is named after the session's conversation title, the same title as its VS Code tab (for example *Dayforce Senior DevOps Engineer job page*). Under the title you see the project folder, where the session runs and whether Claude is busy or waiting for you. For sessions in VS Code, **Go to session ↗** focuses the VS Code window for that folder and shows the chat. The button is on the session card, and on the *This tab* box when a session controls the current tab. The server reads the title and status from Claude Code's own files under `~/.claude` (`sessions/<pid>.json` and the session transcript).

### Or just ask

Just ask Claude, for example:

> Using my Work Chrome profile, open my Gmail and summarise unread mail from today.

> In Chrome, go to the GitHub tab I have open and approve the PR's pending workflow run.

### Tools the agent gets

| Tool | What it does |
|---|---|
| `list_profiles`, `select_profile` | See and choose the connected Chrome profiles |
| `tabs_list`, `tab_new`, `tab_select`, `tab_close` | Work with windows and tabs (`tabs_list` marks the session's own tab and tabs other sessions control) |
| `navigate` | Go to a URL, or `back` / `forward` / `reload`, and wait for the page to load |
| `snapshot` | Page outline (headings, text, links, buttons, inputs with values and states) where every interactive element gets a `[ref=eN]` |
| `find` | Search visible elements by label or text and get their refs |
| `get_text` | Page or element text, paginated |
| `screenshot` | Viewport, full page or a single element, scaled so the reported coordinates are usable for clicks |
| `click`, `hover`, `drag` | Real (trusted) mouse events, by ref, CSS selector or x/y |
| `type`, `press_key` | Real keyboard input: insert text or type key by key, with combos like `Control+A` |
| `select_option` | Pick options in native `<select>` elements |
| `scroll` | Mouse-wheel scrolling (also inside nested scroll areas), or scroll an element into view |
| `upload_file` | Set local files on `<input type=file>` |
| `handle_dialog` | Accept or dismiss `alert` / `confirm` / `prompt` / `beforeunload` |
| `wait_for` | Wait for text or a selector to appear or disappear, or for a set time |
| `evaluate` | Run JavaScript in the page (bypasses CSP; supports `await` and `return`) |
| `console_messages` | Console logs, errors and navigations captured on the tab |
| `extension_reload` | Reload an unpacked extension from disk after editing it (lists unpacked extensions when no name is given). Needs the `management` permission |

It also handles:
* Same-origin iframes and open **and closed** shadow DOM, both in snapshots and for clicking.
* Refs that stay unique across navigations, so a stale ref is reported as an error instead of matching the wrong element.
* Clicks that open new tabs or dialogs. Claude is told what happened.

### One tab per Claude session

Each Claude Code session works in **its own agent tab**. That's the last tab the session opened, selected or used, and at first it's the active tab. When you switch tabs yourself, Claude keeps working in its own tab instead of following you.

You can run several Claude sessions at once, each driving a different tab:

* A tab can be controlled by only **one session at a time**. If session B tries to use session A's tab, it gets an error and is told to open its own with `tab_new`. It can take the tab over (`tab_select` with `takeOver: true`) only when you ask it to.
* Tabs a session opens go into a **coloured tab group** named `Claude · <project>`. When the session ends, the group is greyed out and marked *(ended)*. You can turn grouping off in Settings.
* On a tab that a session controls, the toolbar icon shows that session's badge (`C1`, `C2`, …) in its colour.
* The page itself gets a thin frame in the session's colour and a label in the bottom-left corner: **Claude is controlling this tab** (or **Claude is clicking…**, **Claude is typing…** while it acts), with the session's badge and project name. The label ignores the mouse, is hidden while Claude takes screenshots, and is left out of what Claude reads from the page. It disappears as soon as the tab is released or the session ends. **If a tab has no frame, no Claude session is controlling it.**

### Watching what Claude is doing

Click the toolbar icon to open the dashboard. Click **⇥** to open it in Chrome's **side panel**, where it stays open while you browse and follows the tab you switch to.

**This tab**, at the top, answers "is Claude controlling the tab I'm looking at?":

* **Controlled by Claude**, in the session's colour, with its badge, project name and what it is doing. *Show session* jumps to its card.
* **Not controlled by Claude**, with *Give this tab to a Claude session* open below it.
* **Claude can't control this page** on `chrome://` pages and the Web Store.

**Claude sessions** has one card per session that is using a tab:

* its badge and colour (`C1`, `C2`, …, the same badge as on the toolbar icon and the page) and its project name (the folder Claude Code runs in);
* **Working: <action>…**, or **Idle**;
* its tab's live title and URL, marked **This tab** when it's the one you're on. Click it to jump to that tab;
* its latest actions, each marked ✓ or ✗ (failures in red);
* **Details**: tab and window ids, folder, port, pid, server version, when it connected and how many commands it has run or failed.

Sessions that are connected but not using a tab are folded into *N sessions without a tab*.

*All activity* is one combined log of every session.

To give a session a nicer name, add `--env CHROME_BRIDGE_SESSION_NAME=<name>` to the `claude mcp add` command. Otherwise the project folder name is used.

## Security model

* The server listens on **127.0.0.1 only**.
* Only connections whose `Origin` is a `chrome-extension://…` are accepted. Web pages can't forge that header, so a website can't drive your browser through the bridge.
* **Optional shared token** (recommended if other people or untrusted software use this computer):
  * Add `--env CHROME_BRIDGE_TOKEN=<random string>` to the `claude mcp add` command.
  * Enter the same string in the extension's *Settings → Shared token*.
  * Both sides then prove they know the token through an HMAC challenge/response, and the token itself is never sent.
* While Claude controls a tab, Chrome shows its standard **"Claude Browser Bridge started debugging this browser"** bar. That bar is your signal that the agent is in control. *Release all tabs* in the popup detaches the debugger, and the switch in the popup turns the bridge off for that profile.
* The dashboard shows each session's tab and every command it ran.

Chrome doesn't let any extension control `chrome://` pages, the Chrome Web Store or other extensions' pages.

## Configuration

| Server env var | Default | Meaning |
|---|---|---|
| `CHROME_BRIDGE_PORT_START` | `18765` | First port to try |
| `CHROME_BRIDGE_PORT_COUNT` | `10` | How many ports to try. This must match the extension's *Port count* |
| `CHROME_BRIDGE_TOKEN` | *(none)* | Shared secret. When set, the extension must have the same token |
| `CHROME_BRIDGE_CONNECT_WAIT_MS` | `12000` | How long a tool call waits for a profile to connect |
| `CHROME_BRIDGE_SESSION_NAME` | project folder name | The session's name in the dashboard and in tab-group titles |

## Development

```
cd server
npm test        # protocol/security tests + full end-to-end test
```

The end-to-end test starts an **isolated** Chrome with a temporary profile, so your real profiles aren't touched. It loads the extension through CDP `Extensions.loadUnpacked`, drives the MCP server through a real MCP client, and checks every tool against a local test page. Set `HEADED=1` to watch it, or `CHROME_PATH` to pick a browser.

### Releasing

The server and the extension share a version. Bump it in `server/package.json` and `extension/manifest.json` together.

* **npm:** `cd server && npm publish`. `prepack` copies `extension/` into the package, so `npx … setup` installs the extension that matches the server.
* **Chrome Web Store:** `npm run pack-extension` writes `dist/claude-browser-bridge-<version>.zip`. Upload it in the [developer dashboard](https://chrome.google.com/webstore/devconsole). Once the extension is listed, set `WEB_STORE_URL` in `server/setup.js`. Setup then opens the store page ("Add to Chrome") instead of walking people through Developer mode, and Chrome keeps the extension up to date.

### Troubleshooting

* **Setup says it can't find Claude Code**: install Claude Code, then run setup again, or run the `claude mcp add …` command it prints.
* **"No Chrome profile is connected"**
  * Open the extension popup. It should say *Connected to N Claude session(s)*.
  * If it says *Waiting…*, make sure the bridge is switched on in the popup and the port ranges match.
  * Make sure `/mcp` in Claude Code shows chrome-bridge as running.
* **"Another debugger is attached"**: close DevTools on that tab.
* **Screenshots of background tabs**: Chrome doesn't draw hidden tabs. The bridge briefly brings the tab to the front, takes the screenshot, and switches back.
* **The extension seems asleep**: the service worker keeps itself alive and rescans every 3 s, and a 30 s alarm wakes it after Chrome restarts.
