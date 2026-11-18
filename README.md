# ghost

Set your iPhone's GPS location by clicking a map on your Mac. Teleport to a
point, or walk a route at a realistic speed.

It drives the same developer location-simulation service Xcode uses, through
[pymobiledevice3](https://github.com/doronz88/pymobiledevice3) — so **no Xcode
install, no jailbreak, and nothing installed on the phone.**

**Double-click `Start ghost.command`** in this folder. It starts the server and
opens the map in your browser.

Leave that Terminal window open — it *is* the session. Close it, or press
Ctrl-C, and the iPhone goes straight back to its real GPS.

From a terminal instead:

```bash
npm run doctor   # check prerequisites
npm start        # then open http://localhost:4577
```

## Setup, once

1. **Install the backend**

   ```bash
   brew install pipx && pipx install pymobiledevice3
   ```

2. **Turn on Developer Mode** on the iPhone
   Settings → Privacy & Security → Developer Mode → **On**, then reboot.

   **Don't see Developer Mode?** It's hidden, not missing — iOS only shows the
   row once a computer has asked the device for a developer service. With the
   phone plugged in and unlocked:

   ```bash
   npm run reveal
   ```

   Then look again. `npm run doctor` also does this automatically whenever it
   finds Developer Mode switched off.

3. **Plug the iPhone in over USB**, unlock it, tap **Trust**.

Then `npm run doctor` — it names anything still missing and how to fix it.

## Using it

| | |
|---|---|
| **Connect** | Opens the developer session. First connect is slow — it downloads and mounts a developer disk image. |
| **Click the map** | Drops a pin and fills in the coordinates. |
| **Teleport here** | Pushes that coordinate to the phone. |
| **Search** | Find a place by name. |
| **Save spot** | Keeps a coordinate in the sidebar (stored in your browser). |
| **Real GPS** | Clears the override; the phone goes back to its true location. |
| **Trip** | Type a start address, an end address, and how long it should take. ghost looks up both places, routes them along real roads, and works out the speed so the drive lasts exactly that long. |
| **Draw route on map** | Click to drop waypoints, then **Start** to move along them at the chosen speed. Click a waypoint to delete it. |

**Wander** adds a few metres of random drift so a route doesn't trace a
suspiciously perfect line. **Reverse at the end** turns a route into a loop you
can leave running.

Durations are read loosely: `45`, `45 min`, `1h30m`, `1.5h` and `2 hours` all work
(a bare number means minutes). The road shape comes from OSRM and the geocoding
from Nominatim, both keyless public services — so a trip needs the Mac online.

### Sticky locations

A location you set is treated as an intention, not a one-off command. If the
link drops — you left the network, the phone moved, Wi-Fi blipped — ghost keeps
trying to restore it and re-applies it the moment the phone is reachable again.

So: set Fenway Park on one network, travel, join Wi-Fi somewhere else, and your
location returns to Fenway without you opening anything. It cannot hold during
the journey (see the cellular section — nothing can), but it does come back on
its own at the other end.

**Real GPS** cancels the intention; so does Disconnect and the auto-revert below.

### Auto-revert

A spoofed location should not outlive your attention, so ghost puts the phone
back on real GPS after **12 hours** — change `autoRevertHours` in
`ghost.config.json`, or set it to `0` to switch it off.

The countdown restarts whenever you deliberately set a location or start a trip.
It is *not* restarted by a route's own movement, so a looping route can't keep
the phone spoofed forever — which is the exact case the timer exists for.
**Keep until I stop** disables it for the current session if you really want it
to run indefinitely.

Route playback runs on the server, not in the page, so you can close the browser
tab and the phone keeps moving.

## Using it from your phone

Start ghost with `--lan` so it listens on the network instead of loopback only:

```bash
node server.js --lan
```

It prints a URL per interface with a key attached:

```
phone  →  http://<your-mac-lan-ip>:4577/?k=<key>
```

Easier: open **http://localhost:4577/qr** on the Mac. It shows a scannable code
per address — the Tailscale one first, since that works away from home too.
Point the iPhone camera at it and tap the banner.

### Making it an app

Once it opens on the phone, **Share → Add to Home Screen**. You get a ghost icon
that launches full-screen with no Safari chrome and behaves like an app. The
layout switches to a full-screen map with a sheet you tap to raise.

There is also a **Web Clip configuration profile** (`node webclip.js` writes
`ghost.mobileconfig`, and the setup page shows a QR for it). It produces the same
icon, but it installs a configuration profile, so Add to Home Screen is the
lighter option. Note that iOS will not let a profile install itself over USB —
it has to be downloaded and approved on the phone, by design.

The key exists because `--lan` exposes control of your phone's location to
everything on the network. It lives in `.ghost-token` — delete that file to
revoke every saved link. Without `--lan`, ghost binds to loopback and needs no key.

### Two files here are credentials

| File | What it is |
|---|---|
| `.ghost-token` | The shared key for `--lan`. Delete it to invalidate every saved phone link. |
| `.pair/device.plist` | The device **pair record** — host private keys and the EscrowBag. This is persistent authority over your iPhone: it is what lets a computer start developer services against it, including while it is locked. |
| `ghost.mobileconfig` | The Web Clip profile. Embeds the key in its URL, so treat it like the token. |

Both are `.gitignore`d and mode `600`. Treat `.pair/device.plist` like an SSH
private key: never commit, share, or sync it. To revoke it, unpair the phone
(Settings → General → Transfer or Reset iPhone → Reset → Reset Location & Privacy,
or `pymobiledevice3 lockdown unpair`), which invalidates the record everywhere.

**Reaching it from outside your home** needs a tunnel to the Mac — Tailscale on
both the Mac and the phone. That covers the web UI *and* the device link; see
"Using it away from home".

## Using it away from home

ghost can set your location while you and the phone are somewhere else, with the
Mac left running at home. It needs Tailscale on both, and the phone's tailnet IP
in `ghost.config.json`:

```json
{ "udid": "…", "tailnetHost": "100.x.y.z", "ladder": ["usb", "wifi", "tailnet"] }
```

### Cellular: settled, and the answer is no

Tested directly, not assumed:

| Attempt | Result |
|---|---|
| Open a session on cellular | refused — nothing listening on 62078 |
| Set a location, then kill the session abruptly (no `clear`) | phone reverts to real GPS anyway |
| Keep a live session across Wi-Fi → cellular | **iOS tears the connection down at the moment Wi-Fi drops** |
| Personal Hotspot on, cellular | listener stays closed |
| Wi-Fi radio on but not joined | listener stays closed |

Throughout all of these the phone answers ping in well under 200ms over
Tailscale, so it is not a reachability problem. iOS will neither accept nor keep
developer connections unless the phone is joined to a Wi-Fi network, and no
amount of code changes a daemon that hangs up on you.

**ghost works anywhere the phone has joined a Wi-Fi network — and not on
cellular alone.** That is an Apple constraint, not a limitation of this tool.

There is no "set it and walk away" either: the simulated location exists only
while a session is held open. Killing the session without clearing does not
leave the location behind — tested directly, the phone reverts.

On-device apps (StikDebug + SideStore) were investigated as a way to make the
phone its own host and remove the Wi-Fi requirement. Workable in principle, but
it needs sideloading, a weekly re-signing dance on a free Apple ID, and a
loopback VPN — more moving parts than the problem is worth. Not pursued.

The design still reflects the attempt, and usefully so: the `tailnet` rung comes
first because its address is stable, and the heartbeat notices a dead session
promptly instead of letting the UI claim everything is fine.

### How the cellular attempt was structured

Opening a session needs the listener, and the listener needs Wi-Fi. But an
**already-open** session needs no listener, and a tailnet address stays the same
when the phone changes networks. So the open question is not "can ghost reach a
phone on cellular" (it can — ping works fine) but "does a live session survive
the phone roaming off Wi-Fi".

The reasoning was sound even though the answer came back no — opening a session
needs the listener, but an already-open socket does not, and a tailnet address
survives a change of network. It failed because iOS closes those sockets itself.
What the attempt left behind is still worth having:

* the ladder tries `tailnet` **first**, because a session anchored to a LAN or
  link-local address cannot survive a roam, while a tailnet address can;
* a heartbeat re-applies the current location over the channel that is already
  open, every `heartbeatSeconds`, and never dials a new connection;
* the UI separates **live** (all good) from **holding** (session alive, phone
  off Wi-Fi — losing it is final) from **dropped** (needs Wi-Fi to reopen).
  Those mean very different things when you are standing on a street.

`./roam-test.sh` reproduces the experiment if you want to retest after an iOS
update — the behaviour could change.

### The rule: the phone must be JOINED to a Wi-Fi network (to OPEN a session)

This is the whole constraint, and it was measured, not guessed:

| Phone state | lockdown listener | Works? |
|---|---|---|
| Joined to any Wi-Fi network | open | **yes** — including remotely over Tailscale |
| Cellular only | connection refused | no |
| Wi-Fi switched on but not joined | connection refused | no |

iOS runs the lockdown TCP listener only while the phone is actually associated
with a Wi-Fi network. On cellular the phone stays perfectly reachable — ping
answers in well under a second — but nothing accepts the connection, and no
amount of code changes that.

In practice: on any café, hotel, office or home Wi-Fi, ghost reaches your phone
from anywhere. On cellular alone, it can't.

### Testing the roam

```bash
./roam-test.sh arm      # phone unlocked, on Wi-Fi: opens a session, sets Tokyo
#   -> now turn Wi-Fi OFF on the phone
./roam-test.sh check    # pushes a new coordinate through the held session
#   -> wait 2+ minutes
./roam-test.sh check    # run it again — this one is the real test
```

The second `check` matters more than the first: a TCP flow often survives one
write over a stale path and fails on the next. Verify in Maps each time, since
the Mac's side reporting success is not proof the phone moved.

Result on iOS 26.2.1: `check` fails immediately with the connection closed by
the device. Personal Hotspot was also tried and does not help.

`EnableWifiDebugging` was tried and is **not** the answer — tested `true` and
`false`, both refuse the tunnel; it is back at its original `false`. Writing to
`com.apple.mobile.wireless_lockdown` also kills any live session, so don't touch
that domain while connected.

### Open problem: developer services over the network stopped working

Symptoms, over Tailscale (USB unplugged):

| Works | Fails |
|---|---|
| lockdown session, reading device values | the CoreDeviceProxy tunnel handshake |
| `heartbeat` service | Developer Mode query |
| `CoreDeviceProxy` **opening** | mounted-images query |
| raw TCP to the dynamic service port | every developer service, once used |

Ruled out by direct test: Developer Mode (reads `true` over USB), a locked phone
(`PasswordProtected: false`, and services open — a locked device raises
`PasswordRequired`), a stale pair record (refreshed by a USB connect, no change),
a competing tunnel (service stopped, agents killed, 90s quiet, same failure), and
the agent's own process state (a fresh process fails identically).

Everything works over USB, so the developer subsystem itself is healthy.

**Important when testing this:** iOS disables wireless developer connections
while a USB cable is attached. Any network test run with the phone plugged in is
meaningless — unplug first.

### How it connects: the ladder

`connect` tries transports in order and reports which one won:

| Rung | How | When it applies |
|---|---|---|
| `usb` | usbmux over the cable | Cable plugged in |
| `wifi` | usbmux over the local network | Same network as the Mac, no cable |
| `tailnet` | lockdown straight to an IP | Anywhere, via Tailscale |

The `tailnet` rung authenticates with the saved pair record, which ghost writes
automatically whenever you connect over USB or Wi-Fi. **Connect locally once
before relying on the remote path.**

Force one rung with `{"transport": "tailnet"}` on `/api/connect`.

### When the link drops

Changing networks kills the session. The agent reconnects with backoff and
restores the coordinate it last set, showing "reconnecting" while it works. If
it gives up, the phone returns to its real GPS.

## On cellular: StikDebug + Shortcuts

ghost can't reach the phone away from home (above). For that, the phone does it
itself: StikDebug (built from `vendor/`, signed with a free Apple ID) talks to the
phone's own developer services through LocalDevVPN's loopback "VPN". iOS won't
*build* that link while Cellular Data is on, but a built link survives, so the
shortcuts briefly turn Cellular Data off around the one step that builds it.

Shortcuts (built by `shortcuts/build.py`, actions in `vendor/patches/GhostIntents.swift`):

| Shortcut | Does |
|---|---|
| **Spoof** | Menu of saved places + "Somewhere else…" → look up → LocalDevVPN on → Cellular off → set location → Cellular on |
| **Real Location** | Stop spoofing |
| **Save Place** | Name a spot ("My Dorm") from where you are now or an address |
| **Forget Place** | Delete a saved place |

Saved places live in StikDebug's storage on the phone and survive reinstalls.
Names match loosely ("My Dorm" = "dorm"). They need no internet, and typing a
saved name in "Somewhere else…" works too. "Where I am now" saves the phone's
current position, which is the fake one while you're spoofed.

There is no auto-revert on this path: it holds until Real Location, a restart,
or StikDebug being swiped closed.

**Every 7 days** (free Apple ID): at home on the same Wi-Fi as the Mac, run
`vendor/reinstall-stikdebug.sh`. To change the shortcuts: edit `shortcuts/build.py`,
run it, `shortcuts sign --mode anyone`, open the `.shortcut` on the Mac and
Replace. It copies your LocalDevVPN choice from the existing Spoof. Replace
leaves the old copy behind as "Spoof 2"; delete it.

## Running it as a service

So you don't have to start anything before leaving the house:

```bash
./service.sh install
```

That installs a launchd agent (`~/Library/LaunchAgents/dev.ghost.server.plist`)
which starts ghost at login, restarts it if it ever crashes, and logs to
`~/Library/Logs/ghost.log`.

```bash
./service.sh status      # is it running, and will the Mac stay awake?
./service.sh logs        # recent output
./service.sh restart
./service.sh uninstall   # stop starting on its own
```

ghost runs under `caffeinate -s`, which holds a "prevent system sleep" assertion
for exactly as long as the server lives. Without it this Mac sleeps after a
minute idle and is unreachable the moment you walk out — and the assertion goes
away by itself when ghost stops, so nothing is left permanently changed.

### Locked screen vs. asleep

These are different, and only one of them matters:

| State | ghost |
|---|---|
| Screen locked, password needed to wake | **works** — locking does not stop processes |
| Display off (after 10 min) | **works** — only the monitor sleeps |
| Logged in, Mac awake | works |
| System asleep | dead — a sleeping Mac runs nothing (this is what `caffeinate` prevents) |
| You choose Apple menu → Sleep | dead — a deliberate sleep overrides the assertions |
| Logged out / restarted | dead until someone logs back in |

So leaving the Mac locked is completely fine. Just don't put it to sleep by hand.

### Two things the service can't do for itself

**Tailscale has to start on its own.** Check `TailscaleStartOnLogin`; if it is
`0`, remote access dies after any reboot even though ghost is up. Enable it from
the Tailscale menu bar icon, along with "Run unattended" if offered.

**A launchd *agent* starts at login, not at boot.** If this Mac reboots and
nobody logs in, ghost stays down. Note that FileVault is on here, which means
automatic login cannot help: the disk must be unlocked at the pre-boot screen by
a human before any user session exists. A reboot therefore always needs someone
physically at the machine. Nothing to fix — just know that "it rebooted while I
was out" means ghost is down until you get home.

## The one thing to know

**The spoofed location lasts exactly as long as the session is open.** Quit
ghost, unplug the cable, or hit Disconnect, and the phone goes back to its real
GPS.

One wrinkle worth knowing, because it looks like persistence and isn't: for a
short while after the session ends the phone keeps *showing* the fake location.
That is iOS displaying the last fix it received until Location Services gets a
fresh one — the simulation is already over. Don't rely on it; it is a display
lag, not a hold, and its length is not something you control. This is how iOS works — the simulated location is tied to
the live developer session, not written to the device. Leave the Mac connected
and `npm start` running for as long as you want the fake location to hold.

A few other things worth knowing:

- **No cable needed.** Wi-Fi works once `EnableWifiConnections` is on; remote
  works over Tailscale. The phone must be joined to a Wi-Fi network either way.
- **The phone must be unlocked** to open a session. iOS refuses the developer
  service with `PasswordProtected` on a locked device — over USB as well as Wi-Fi.
- **The whole system follows the fake location** — Maps, Weather, Find My, and
  any app using Core Location.
- **Some apps detect simulation.** Certain games and banking apps check the
  `simulated` flag on a location and will ignore or flag it. Nothing to be done
  about that from here.
- **On iOS 17+** ghost opens a RemoteXPC tunnel. On macOS this uses Apple's
  native tunnel, so it does **not** need sudo.

## Layout

```
Start ghost.command   double-click launcher (Finder)
server.js        HTTP API, static files, supervises the agent
route.js         great-circle interpolation + the route runner
plan.js          address -> address trips (geocoding, road routing, speed)
agent/           long-lived Python process holding the device session open
public/          the map UI (Leaflet, no build step)
doctor.js        prerequisite checks
reveal.js        unhides the Developer Mode row on the phone
webclip.js       builds the Home Screen profile (ghost.mobileconfig)
service.sh       install/remove the launchd background service
roam-test.sh     does a live session survive Wi-Fi -> cellular?
icon.png         the app icon
ghost.config.json  udid, tailnet host, transport ladder
test-route.js    tests for the movement maths
```

The Python agent exists because the session must stay open. Shelling out to the
CLI per coordinate would both reset the location and be far too slow for route
playback — so `server.js` keeps one agent alive and streams coordinates into it
over a JSON protocol on stdin/stdout.

## Will an update break this?

Run `npm run doctor` after any update — it checks everything below automatically,
including whether pymobiledevice3 still exposes the internals ghost relies on.
Known-good versions live in `tested-with.json`.

### Measured: what iOS 27 broke

Moving from iOS 26.2.1 to 27.0.1 (new phone, Nov 2026) narrowed ghost's paths:

| Path from the Mac | iOS 26 | iOS 27 |
|---|---|---|
| USB | works | works |
| Home Wi-Fi through usbmuxd (`wifi` rung) | works | works *when usbmuxd lists the phone* — intermittent |
| Home Wi-Fi, direct TCP to the phone | works | lockdown answers; every developer service is terminated |
| **Tailscale (away from home)** | works | **the phone resets lockdown on the first request** |

The Tailscale result is the one that matters. A raw, unauthenticated
`QueryType` sent to the same phone at the same moment is answered on its LAN
addresses and reset over Tailscale. iOS 27 is refusing lockdown that arrives on
the VPN interface. It is not credentials (the pair records are byte-identical to
usbmuxd's) and not the library (pymobiledevice3 11.50.0 behaves the same).

So **on iOS 27, ghost is a home-network and USB tool.** Away from home, use
StikDebug (built and installed from `vendor/`; see PLAN.md). The `tailnet` rung
stays last in the ladder and now fails in milliseconds with a clear message.
Before, pymobiledevice3 retried the reset without limit until Python's recursion
limit tripped.

**Upgrading pymobiledevice3 also needs a code change.** 11.50.0 passes the
compatibility canary but refuses to mount the disk image over plain lockdown on
iOS 17+ (`RSDRequiredError`). It wants the RSD tunnel first. ghost mounts before
building the tunnel, so it stays pinned at 11.12.5 until that order is swapped.

### Ranked by how likely it is to bite

**1. Upgrading pymobiledevice3 — the most likely breakage, and the one you control.**
ghost swaps out a module-level function inside `userspace_tunnel` to force the
tunnel onto a chosen transport. That is a shim, not a public API, and an upgrade
can move or rename it. `compat-check.py` verifies every symbol and signature
ghost depends on; doctor runs it. If it complains:

```bash
pipx install pymobiledevice3==11.12.5 --force
```

Don't upgrade it casually. There is no feature you are missing.

**2. An iOS update — moderate risk, usually self-healing.**
- The developer disk image unmounts; ghost re-mounts it automatically (the first
  connect afterwards is slower while it downloads the image for the new build).
- Developer Mode normally survives. If it doesn't: `npm run reveal`, then enable
  it in Settings.
- **If developer services start failing in strange ways — services that open then
  terminate, tunnels that hang — re-pair over USB.** This cost hours to learn:
  a pair record can be byte-identical to the one usbmuxd holds and still be
  rejected, because the phone invalidated it on its side. Regenerating is the
  only fix.
- Real risk, no mitigation: Apple removing the API. iOS 26 already deleted
  `com.apple.dt.simulatelocation` and the old DVT proxy. If the DVT location
  channel goes the same way, ghost stops working and nothing in this repo can
  bring it back.

**3. A macOS major upgrade — low risk, occasionally noisy.**
- Command Line Tools usually need reinstalling: `xcode-select --install`
- Homebrew's Python can break, which takes the pipx venv with it. Repair:
  `brew reinstall python@3.14 && pipx reinstall pymobiledevice3` (then re-pin
  the version above).
- The launchd agent survives; confirm with `./service.sh status`.
- If Tailscale stops running unattended after the upgrade, remote access dies
  quietly — check `TailscaleStartOnLogin`.

**4. Node, Tailscale — negligible.** ghost uses only stable Node APIs and
Tailscale is just transport.

### After any update, in order

```bash
npm run doctor        # catches all of the above
./service.sh status   # service alive, Mac staying awake
node test-route.js    # movement maths still correct
```

Then set a location and confirm on the phone. The Mac reporting success is not
proof the phone moved — that distinction has bitten us more than once.

## Troubleshooting

| Symptom | Fix |
|---|---|
| "no iPhone detected" | Different cable/port; unlock and tap Trust; `npm run doctor`. |
| "Developer Mode is off" | Settings → Privacy & Security → Developer Mode, then reboot. |
| No Developer Mode row at all | `npm run reveal` with the phone plugged in and unlocked, then look again. |
| "Device is not connected" | Phone asleep or cable dropped. Unlock it and replug. |
| A `pymobiledevice3` command hangs | ghost holds the device session while connected. Disconnect in the UI (or stop ghost) before running other tooling against the phone. |
| Connect hangs the first time | It's fetching a developer disk image. Give it a few minutes on the first run. |
| Location snaps back | Expected if ghost stopped — see above. |
| Double-click does nothing | Right-click → Open the first time, or check Node is installed (`node -v`). |
| Tunnel errors on iOS 17+ | Unplug, replug, reconnect. |

## Tests

```bash
node test-route.js
```
