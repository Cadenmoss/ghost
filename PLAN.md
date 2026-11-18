# Plan: on-device location control (the cellular problem)

## Why this exists

ghost works wherever the phone joins Wi-Fi, and nowhere else. The reason is
narrow and measured: **iOS runs lockdownd's TCP listener only while the phone is
associated with a Wi-Fi network.** On cellular the phone answers ping in under
200ms and refuses port 62078, because nothing is listening.

That gates a *remote* host reaching the phone. It says nothing about a host
running **on the phone itself** — which needs no network at all. That is the
whole idea here: stop trying to reach the device, and become the device.

## What we established the hard way

| Fact | How we know |
|---|---|
| Location needs a live session | Set, killed session, phone reverted |
| A dead session's location lingers briefly | Looked like persistence; it is display lag until the next GPS fix |
| Listener requires *joined* Wi-Fi | Cellular refused; Wi-Fi radio on but unjoined refused; Personal Hotspot refused |
| A live session does not survive losing Wi-Fi | iOS tears the socket down at the moment of the drop |
| Pair records must be *regenerated*, not copied | Byte-identical records failed; re-pairing fixed it instantly |
| Writing to `com.apple.mobile.wireless_lockdown` breaks developer access | Cost us hours; survived a reboot; only a re-pair fixed it |
| **The legacy simple path is gone** | On iOS 26.2.1, `com.apple.dt.simulatelocation` and `DVTSecureSocketProxy` both return `InvalidService` |

That last row matters most for design. There is no lightweight service left. Any
implementation must do the full modern chain:

```
pair record → lockdown → CoreDeviceProxy → RSD tunnel (IPv6) → DVT/DTX
            → simulateLocationWithLatitude:longitude:
```

## MEASURED: the sandbox blocks apps from talking to lockdownd

Tested on-device with [a-Shell](https://apps.apple.com/us/app/a-shell/id1473805438)
(free App Store terminal, native networking, no signing required):

| Port | Result | Reading |
|---|---|---|
| **62078** (lockdown) | `EPERM` — Operation not permitted | **connection denied before any packet** |
| 62077 | `ECONNREFUSED` | allowed, nothing there |
| 62079 | `ECONNREFUSED` | allowed, nothing there |
| 22 | `EPERM` | also blocked |
| 80, 9999 | `ECONNREFUSED` | allowed |
| 49152 | **connected**, then reset | allowed, and *something is listening* |

`EPERM` and `ECONNREFUSED` are different failures. The neighbours of 62078 are
reachable; 62078 itself is denied. This is a deliberate Apple rule protecting
lockdownd from apps — not a port range, not a privilege boundary.

### What this costs us

**The clever part of this plan is dead.** The idea was to run a userspace TCP
stack (`smoltcp`) so no NetworkExtension — and therefore no $99 entitlement —
was needed. But the entitlement was never about building the tunnel. It is about
getting past this sandbox rule. A NetworkExtension routes packets from extension
context instead of an app's `connect()`, which is precisely why StikDebug depends
on LocalDevVPN. A userspace stack removes nothing.

**So the on-device route has a hard floor:**

* the working app must be *sideloaded* (Apple rejects this functionality from the
  App Store and TestFlight), and
* it needs a NetworkExtension — a paid account, or piggybacking LocalDevVPN.

There is no third door. Every path runs through sideloading, paying, or both.

### One loose thread worth noting

Port **49152** accepted a connection and reset when sent HTTP. That is the base
of the dynamic range lockdown allocates service ports from. If lockdown service
ports are reachable by apps while the control port is not, a split design becomes
conceivable: the Mac asks lockdownd for a service (over Wi-Fi) and an on-device
client uses the resulting local port. Whether such a port survives the network
dropping is untested and probably not — service ports are usually torn down with
their client. Recorded, not recommended.

## The one unknown that decides everything

**Does lockdownd accept a connection from the device itself when Wi-Fi is off?**

Every fact above concerns the listener on *network* interfaces. Nobody has
tested loopback, and the answer splits the project in two:

- **Yes** → an on-device app works on cellular. Build it.
- **No** → iOS gates the listener globally, and an on-device app fails on
  cellular exactly like ghost does. The project is dead and no amount of
  cleverness revives it.

Circumstantial evidence points both ways. StikDebug requires a loopback VPN
(LocalDevVPN) and its docs push you toward Wi-Fi, which hints the listener is not
plainly reachable. But the most detailed field writeup claims Wi-Fi, cellular and
even airplane mode all work. Unresolved.

### Phase 0 — answer it for £0 and 30 minutes, before writing any code

Install **StikDebug** (free, open source) + LocalDevVPN, import the pair record
ghost already generates, set a location, then **turn Wi-Fi off and set another
one.**

That is the entire premise of this project, tested with someone else's
implementation. If StikDebug cannot set a location on cellular, ours cannot
either — same services, same OS gate. Building first and discovering this later
would waste weeks.

**Do not skip this.** Everything below is conditional on it.

## Architecture (if Phase 0 passes)

Three layers. The interesting engineering is in the middle one.

### 1. Core: a Rust `idevice` client, compiled for `aarch64-apple-ios`

The [`idevice`](https://github.com/jkcoxson/idevice) crate already implements
lockdown, CoreDeviceProxy, RSD and DTX in Rust and is what StikDebug is built
on. Reuse it rather than porting pymobiledevice3's Python to Swift. Expose it to
Swift through UniFFI.

### 2. The tunnel, without a NetworkExtension entitlement

This is the crux, and where the free-account constraint bites.

The RSD tunnel carries **raw IPv6 packets**. The obvious way to use them is a
`utun` device — on iOS that means a Packet Tunnel Provider, and
`com.apple.developer.networking.networkextension` **requires a paid developer
account**. That is precisely why LocalDevVPN exists as a separate App Store app:
somebody with a paid account published the tunnel so unpaid apps can borrow it.

**Do not borrow it. Eliminate the need.**

pymobiledevice3 already proves the alternative: it runs a *userspace* TCP/IP
stack (PyTCP) so its tunnel needs no root and no `utun`. The same trick removes
the entitlement problem on iOS. Use [`smoltcp`](https://github.com/smoltcp-rs/smoltcp)
— a mature, allocation-light Rust TCP/IP stack built for exactly this:

```
CoreDeviceProxy socket  ⇄  smoltcp (in-process)  ⇄  RSD/DTX client
```

Packets never touch the OS network stack, so there is no interface to create, no
entitlement to request, and no dependency on a third-party VPN app. If this
works it is strictly better than what StikDebug does — fewer moving parts, no
App Store dependency, and nothing to break when LocalDevVPN changes.

**Risk:** if the app cannot open a plain TCP connection to lockdownd's port on
the loopback/local interface, this collapses and you are back to needing the
VPN — which means a paid account or depending on LocalDevVPN. Phase 0 tells you.

### 3. App: SwiftUI, porting ghost's feature set

MapKit instead of Leaflet. Port what already works and is proven useful: search,
saved spots, drawn routes with great-circle interpolation, address→address trips
with a duration, jitter, sticky locations, the 12-hour auto-revert.

`route.js` and `plan.js` are the reference implementations — the maths is tested
(13 passing tests) and translates directly.

## The four hard problems

### A. Staying alive in the background

The session dies when the app is suspended, and iOS suspends aggressively. This
is the difference between a toy and something you can put in your pocket.

**Use the `location` background mode.** An app with `UIBackgroundModes:
[location]` and `allowsBackgroundLocationUpdates = true`, holding an active
`CLLocationManager`, runs indefinitely in the background. It is the one
background mode with no wall-clock limit, and an app that simulates location
asking for location permission is not even incongruous.

Fallback if that proves flaky: a silent-audio session. Ugly, effective, and
irrelevant to App Store review since this is sideloaded.

### B. The developer disk image unmounts on every reboot

Mounting needs `mobile_image_mounter` plus a personalized image fetched from
Apple. On-device this means a download and an ~11 MB+ image per iOS build.

**Split it:** the app mounts the DDI itself when it has any network; ghost on the
Mac keeps doing it over USB/Wi-Fi as a fallback. A phone that reboots on cellular
with no DDI is simply broken until it sees a network — document that rather than
engineer around it.

### C. The 7-day signature

A free Apple ID signs for 7 days, 3 apps. Options in increasing effort:

1. **Refresh at home.** The Mac mini is always on. AltServer-style refresh runs
   whenever the phone is on home Wi-Fi. Fine if you are home weekly; if you are
   away for 8 days the app is dead.
2. **Self-refresh on device.** Once the app can talk to lockdownd it can also
   drive `installation_proxy` — the same machinery SideStore uses. Substantial
   work (Apple developer API auth, certificate issuance, provisioning profiles)
   and it must handle your Apple ID credentials, so it is yours to configure.
3. **Paid account** — one line of the plan and $99. Ruled out.

Start with (1). Revisit only if the weekly window actually bites.

### D. Pair record lifecycle

Ours already works: ghost writes `.pair/device.plist` on every USB/Wi-Fi connect.
Export it into the app over AirDrop, zipped so iOS does not mangle the extension.
**Hard-won rule: if developer services start failing, re-pair. Do not trust a
record just because it matches the one usbmuxd holds — ours were byte-identical
and still rejected.**

## Build order

| Milestone | Deliverable | Proves |
|---|---|---|
| **0** | StikDebug on cellular | the premise. Stop here if it fails |
| **1** | Rust core on macOS: lockdown → RSD → DVT → set location | the crate does what we need, before iOS complexity |
| **2** | Same core cross-compiled, run on-device, hardcoded coordinate, foreground only, Wi-Fi | the on-device path works at all |
| **3** | Repeat milestone 2 **on cellular** | the actual goal. Second decision point |
| **4** | `smoltcp` replaces any VPN dependency | no entitlement, no LocalDevVPN |
| **5** | Background mode: hold a session with the app backgrounded and screen locked | usable in a pocket |
| **6** | Port ghost's UI and features | the product |
| **7** | Signing/refresh workflow | it survives past day 7 |

Milestones 0 and 3 are decision points. Everything after 3 is ordinary work;
everything before it is a question dressed as a task.

## Honest assessment

**The idea is sound.** Making the phone its own host is the correct answer to the
constraint we hit, and a working implementation (StikDebug) proves the chain runs
on-device.

**The premise is still unverified**, and now harder to verify: the sandbox blocks
the direct test, so the only way to know whether lockdownd answers on loopback
without Wi-Fi is to already have the NetworkExtension in place.

**The novel part is dead.** `smoltcp` would have removed the paid entitlement if
the entitlement existed for tunnel plumbing. It exists to get past a sandbox
rule, which a userspace stack cannot do. Measured, not theorised.

**Effort:** milestones 1–3 are a weekend for someone comfortable with Rust FFI
and iOS. Milestones 4–7 are a few weeks. The App Store is never involved.

**Cheapest sane path:** run Phase 0. If it works, decide then whether you want a
better StikDebug or just StikDebug.
