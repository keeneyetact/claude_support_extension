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

## Install

### 1. Server dependencies

```powershell
cd E:\data\claude_support_extension\server
npm install
```

### 2. Register the MCP server with Claude Code (once, for all projects)

```powershell
claude mcp add --scope user chrome-bridge -- node "E:/data/claude_support_extension/server/index.js"
```

If `claude` isn't on your PATH, use the copy bundled with the VS Code extension:
`& "$env:USERPROFILE\.vscode\extensions\anthropic.claude-code-<version>-win32-x64\resources\native-binary\claude.exe" mcp add ...`

Then restart Claude Code, or start a new session, and check with `/mcp` that **chrome-bridge** is connected.

### 3. Load the extension into each Chrome profile

1. In the profile, open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and pick `E:\data\claude_support_extension\extension`.
4. Pin the extension and click its icon. Under *Settings*, give the profile a name such as `Work` or `Personal`. Claude uses that name to address the profile.

Repeat this for every profile. While a Claude session is running, the toolbar badge shows how many Claude sessions are connected.

## Use

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

### Watching what Claude is doing

Click the toolbar icon to open the dashboard. Click **⇥** to open it in Chrome's **side panel**, where it stays open while you browse. For each connected Claude session you see:

* its number and colour (`C1`, `C2`, …), its project name (the folder Claude Code runs in), and its port and pid;
* **Working…** with the current action, or **idle** with how long ago it last acted;
* its tab's live title and URL. Click it to jump to that tab;
* its latest actions, each marked ✓ or ✗.

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

```powershell
cd server
npm test        # protocol/security tests + full end-to-end test
```

The end-to-end test starts an **isolated** Chrome with a temporary profile, so your real profiles aren't touched. It loads the extension through CDP `Extensions.loadUnpacked`, drives the MCP server through a real MCP client, and checks every tool against a local test page. Set `HEADED=1` to watch it, or `CHROME_PATH` to pick a browser.

After you edit the extension, click **Reload** on its card in `chrome://extensions`.

### Troubleshooting

* **"No Chrome profile is connected"**
  * Open the extension popup. It should say *Connected to N Claude session(s)*.
  * If it says *Waiting…*, make sure the bridge is switched on in the popup and the port ranges match.
  * Make sure `/mcp` in Claude Code shows chrome-bridge as running.
* **"Another debugger is attached"**: close DevTools on that tab.
* **Screenshots of background tabs**: Chrome doesn't draw hidden tabs. The bridge briefly brings the tab to the front, takes the screenshot, and switches back.
* **The extension seems asleep**: the service worker keeps itself alive and rescans every 3 s, and a 30 s alarm wakes it after Chrome restarts.
