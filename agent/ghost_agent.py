#!/usr/bin/env python3
"""
ghost_agent — persistent iOS location-simulation session.

Why a long-lived process: iOS ties the simulated location to the *open*
developer session. Close it and the phone reverts to real GPS within seconds.

Three transports, tried in order ("the ladder"):

  usb      usbmux over the cable
  wifi     usbmux over the local network (Apple's Wi-Fi sync, IPv6 link-local)
  tailnet  lockdown straight to an IP, e.g. over Tailscale — works from anywhere

All three end at the same place: a CoreDeviceProxy tunnel carrying DVT, which is
what actually moves the blue dot on iOS 17+.

Known limit, measured rather than assumed: iOS only runs the lockdown TCP
listener while the phone is JOINED to a Wi-Fi network. On cellular — even with
the Wi-Fi radio on but not joined — the phone answers ping but refuses port
62078, because nothing is listening.

That gates *opening* a session, not keeping one. An already-established socket
needs no listener, and a tailnet address survives the phone roaming between
networks, so a session opened on Wi-Fi may keep working on cellular. Hence the
ladder puts `tailnet` first and a heartbeat re-applies the location over the
channel that is already open — never by dialling a new connection, which is
exactly what cellular cannot do.

Protocol: newline-delimited JSON on stdin/stdout.
"""
import asyncio
import json
import os
import plistlib
import sys
import traceback
from contextlib import AsyncExitStack, asynccontextmanager

from pymobiledevice3.exceptions import (
    AlreadyMountedError,
    DeveloperModeIsNotEnabledError,
    NoDeviceConnectedError,
    PasswordRequiredError,
)
from pymobiledevice3.lockdown import create_using_tcp, create_using_usbmux
from pymobiledevice3.services.dvt.instruments.dvt_provider import DvtProvider
from pymobiledevice3.services.dvt.instruments.location_simulation import LocationSimulation
from pymobiledevice3.services.mobile_image_mounter import auto_mount
from pymobiledevice3.services.simulate_location import DtSimulateLocation

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PAIR_FILE = os.path.join(ROOT, ".pair", "device.plist")
CONFIG_FILE = os.path.join(ROOT, "ghost.config.json")


def config() -> dict:
    try:
        with open(CONFIG_FILE) as f:
            return json.load(f)
    except Exception:
        return {}


def out(obj: dict) -> None:
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def log(msg: str) -> None:
    out({"event": "log", "message": str(msg)})


LABELS = {
    "usb": "USB cable",
    "wifi": "Wi-Fi (local network)",
    "tailnet": "Tailscale (remote)",
}


def save_pair_record(lockdown) -> None:
    """Keep the pair record so the tailnet rung can authenticate later.

    macOS stores it under /var/db/lockdown, readable only by _usbmuxd; a
    usbmux-backed lockdown hands us a copy. It holds private keys — mode 600.
    """
    record = getattr(lockdown, "pair_record", None)
    if not record:
        return
    try:
        os.makedirs(os.path.dirname(PAIR_FILE), exist_ok=True)
        tmp = PAIR_FILE + ".tmp"
        with open(os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), "wb") as f:
            plistlib.dump(dict(record), f)
        os.replace(tmp, PAIR_FILE)
    except Exception as e:
        log(f"could not save pair record: {e}")


async def make_lockdown(kind: str, cfg: dict):
    """Open a lockdown connection over one specific transport."""
    udid = cfg.get("udid")
    if kind == "usb":
        ld = await create_using_usbmux(serial=udid, connection_type="USB")
        save_pair_record(ld)
        return ld
    if kind == "wifi":
        ld = await create_using_usbmux(serial=udid, connection_type="Network")
        save_pair_record(ld)
        return ld
    if kind == "tailnet":
        host = cfg.get("tailnetHost")
        if not host:
            raise RuntimeError("no tailnetHost in ghost.config.json")
        # iOS 27 accepts a TCP connection over Tailscale and then resets it on the
        # first request. pymobiledevice3 11.12.5 answers that by retrying without
        # limit until Python's recursion limit trips. Ask first, cheaply.
        await probe_lockdown_answers(host)
        if not os.path.exists(PAIR_FILE):
            raise RuntimeError("no saved pair record; connect once over USB or Wi-Fi first")
        with open(PAIR_FILE, "rb") as f:
            record = plistlib.load(f)
        return await create_using_tcp(
            hostname=host, identifier=udid, pair_record=record, autopair=False, keep_alive=True
        )
    raise ValueError(f"unknown transport: {kind}")


class LockdownRefused(RuntimeError):
    pass


async def probe_lockdown_answers(host: str, timeout: float = 6.0) -> None:
    """Send one unauthenticated QueryType and require a reply.

    Measured on iOS 27.0.1: over the home LAN this answers; over Tailscale the
    phone resets the connection. Failing here, in a second, beats the library's
    unbounded reconnect loop.
    """
    body = plistlib.dumps({"Label": "ghost", "Request": "QueryType"})
    try:
        reader, writer = await asyncio.wait_for(asyncio.open_connection(host, 62078), timeout)
    except Exception as e:
        raise LockdownRefused(f"cannot reach lockdown at {host}: {e.__class__.__name__}") from None
    try:
        writer.write(len(body).to_bytes(4, "big") + body)
        await writer.drain()
        hdr = await asyncio.wait_for(reader.readexactly(4), timeout)
        await asyncio.wait_for(reader.readexactly(int.from_bytes(hdr, "big")), timeout)
    except Exception:
        raise LockdownRefused(
            f"the phone reset lockdown over Tailscale ({host}) — iOS 27 refuses "
            "lockdown on the VPN interface"
        ) from None
    finally:
        writer.close()


@asynccontextmanager
async def tunnel_over(lockdown_factory):
    """Build the iOS 17+ RSD tunnel on a lockdown connection *we* chose.

    pymobiledevice3's UserspaceRsdTunnel always opens its own usbmux lockdown and
    exposes no injection point, so the module-level factory is swapped for the
    duration. Contained and restored in `finally` — but it is a shim, so if the
    library grows a real parameter for this, use that instead.
    """
    import pymobiledevice3.remote.userspace_tunnel as ut
    from pymobiledevice3.remote.userspace_tunnel import UserspaceRsdTunnel

    original = ut.create_using_usbmux

    async def chosen(serial=None, autopair=True, **kw):
        return await lockdown_factory()

    ut.create_using_usbmux = chosen
    try:
        async with UserspaceRsdTunnel() as rsd:
            yield rsd
    finally:
        ut.create_using_usbmux = original


class Session:
    def __init__(self) -> None:
        self.stack = None
        self.location = None
        self.cfg = config()
        self.udid = self.cfg.get("udid")
        self.name = None
        self.ios = None
        self.transport = None
        self.last = None          # last coordinate we set, for resuming
        # The location the user actually wants, independent of any one session.
        # Survives drops so it can be re-asserted the moment a link comes back.
        self.desired = None
        self.reconnecting = False
        self.lock = asyncio.Lock()
        self.kind = None          # which rung of the ladder is in use
        # Whether a NEW session could be opened right now. False means the phone
        # has left Wi-Fi: the live session keeps working, but losing it is final
        # until the phone rejoins a network. These look identical without this.
        self.reconnectable = True
        self.heartbeat_task = None

    @property
    def connected(self) -> bool:
        return self.location is not None

    def info(self) -> dict:
        return {
            "connected": self.connected,
            "reconnecting": self.reconnecting,
            "reconnectable": self.reconnectable,
            "held": self.connected and not self.reconnectable,
            "transportKind": self.kind,
            "udid": self.udid,
            "name": self.name,
            "ios": self.ios,
            "transport": self.transport,
            "lat": self.last[0] if self.last else None,
            "lon": self.last[1] if self.last else None,
            "desiredLat": self.desired[0] if self.desired else None,
            "desiredLon": self.desired[1] if self.desired else None,
        }

    def emit(self) -> None:
        out({"event": "state", "state": self.info()})

    async def probe_listener(self) -> bool:
        """Could we open a *new* session right now?

        A plain TCP connect to lockdown's port — no handshake, no side effects.
        On cellular this is refused, which is precisely the signal we need.
        """
        if self.kind is None:
            # Not connected: judge by the remote listener, since that is what
            # decides whether a new session can be opened at all.
            host = self.cfg.get("tailnetHost")
            if not host:
                return True
            try:
                fut = asyncio.open_connection(host, 62078)
                _, w = await asyncio.wait_for(fut, timeout=6)
                w.close()
                return True
            except Exception:
                return False

        if self.kind in ("usb", "wifi"):
            # For local transports the real question is whether usbmux still
            # sees the device: an unplugged cable must not keep reading as
            # "connected", which it did until this check existed.
            from pymobiledevice3 import usbmux
            want = "USB" if self.kind == "usb" else "Network"
            try:
                devs = await usbmux.list_devices()
            except Exception:
                return False
            return any(d.serial == self.udid and d.connection_type == want for d in devs)

        host = self.cfg.get("tailnetHost")
        if not host:
            return True
        try:
            fut = asyncio.open_connection(host, 62078)
            reader, writer = await asyncio.wait_for(fut, timeout=6)
            writer.close()
            try:
                await writer.wait_closed()
            except Exception:
                pass
            return True
        except Exception:
            return False

    async def heartbeat(self) -> None:
        """Keep the open channel warm and notice the moment it dies.

        Re-applies the last coordinate over the EXISTING DVT channel. It must
        never dial a new connection: on cellular that is impossible, and this
        loop is the only thing holding the session together there.
        """
        every = float(self.cfg.get("heartbeatSeconds") or 0)
        if every <= 0:
            return
        while self.connected:
            await asyncio.sleep(every)
            if not self.connected:
                return
            was = self.reconnectable
            self.reconnectable = await self.probe_listener()
            if was != self.reconnectable:
                if self.kind in ("usb", "wifi") and not self.reconnectable:
                    # The cable/network went away: unlike the tailnet case there
                    # is nothing to hold open, so the session is simply over.
                    log(f"{self.transport} disappeared — session ended")
                    await self.disconnect()
                    asyncio.create_task(self.recover())
                    return
                log("phone left Wi-Fi — session is being held open"
                    if not self.reconnectable else "phone is back on Wi-Fi")
                self.emit()
            if self.last is None:
                continue
            try:
                async with self.lock:
                    await self.location.set(*self.last)   # idempotent
            except Exception as e:
                log(f"heartbeat lost the session: {e.__class__.__name__}")
                asyncio.create_task(self.recover())
                return

    async def _open(self, kind: str) -> None:
        stack = AsyncExitStack()
        try:
            ld = await make_lockdown(kind, self.cfg)
            self.udid = ld.udid or self.udid
            self.name = ld.short_info.get("DeviceName")
            self.ios = ld.product_version
            major = int(str(self.ios).split(".")[0])

            try:
                await auto_mount(ld)
            except AlreadyMountedError:
                pass

            if major >= 17:
                rsd = await stack.enter_async_context(
                    tunnel_over(lambda: make_lockdown(kind, self.cfg))
                )
                dvt = await stack.enter_async_context(DvtProvider(rsd))
                self.location = await stack.enter_async_context(LocationSimulation(dvt))
            else:
                self.location = DtSimulateLocation(ld)

            self.stack = stack
            self.kind = kind
            self.transport = LABELS.get(kind, kind)
            self.reconnectable = await self.probe_listener()
            if self.heartbeat_task:
                self.heartbeat_task.cancel()
            self.heartbeat_task = asyncio.create_task(self.heartbeat())
        except BaseException:
            await stack.aclose()
            self.location = None
            self.stack = None
            raise

    async def connect(self, only: str | None = None) -> dict:
        await self.disconnect(quiet=True)
        ladder = [only] if only else self.cfg.get("ladder", ["usb", "wifi", "tailnet"])
        errors = []
        for kind in ladder:
            log(f"trying {LABELS.get(kind, kind)}…")
            try:
                await self._open(kind)
                log(f"connected over {self.transport} — {self.name}, iOS {self.ios}")
                self.emit()
                return self.info()
            except Exception as e:
                msg = f"{e.__class__.__name__}: {e}"
                errors.append(f"{kind}: {msg}")
                log(f"  {LABELS.get(kind, kind)} unavailable — {msg}")
        # A failed connect must refresh this too, or the UI keeps claiming a new
        # session is possible when the phone is off Wi-Fi and it plainly isn't.
        self.reconnectable = await self.probe_listener()
        self.emit()
        raise RuntimeError("no transport worked → " + " | ".join(errors))

    async def set(self, lat: float, lon: float) -> dict:
        if not self.connected:
            raise RuntimeError("not connected")
        async with self.lock:
            try:
                await self.location.set(lat, lon)
            except Exception:
                self.last = (lat, lon)      # remember it so a reconnect can resume
                asyncio.create_task(self.recover())
                raise
            self.last = (lat, lon)
            self.desired = (lat, lon)
        return {"lat": lat, "lon": lon}

    async def recover(self) -> None:
        """Re-establish after a drop and put the location back where it was."""
        if self.reconnecting:
            return
        self.reconnecting = True
        self.emit()
        target = self.desired or self.last
        delay = 2
        # With a location still wanted, keep trying indefinitely: the phone may
        # simply be in transit, and it should snap back the moment it lands on
        # any Wi-Fi. Without one, a few attempts is enough.
        attempt = 0
        while True:
            attempt += 1
            if self.desired is None and attempt > 7:
                break
            self.reconnectable = await self.probe_listener()
            self.emit()
            log(f"reconnecting (attempt {attempt})…"
                + ("" if self.reconnectable else " — phone is not on Wi-Fi, this will fail"))
            try:
                await self.connect()
                if target:
                    await self.location.set(*target)
                    self.last = target
                    log("reconnected and location restored")
                self.reconnecting = False
                self.emit()
                return
            except Exception as e:
                log(f"  retry in {delay}s — {e.__class__.__name__}")
                await asyncio.sleep(delay)
                delay = min(delay * 2, 60 if self.desired else 30)
                if self.desired is None and attempt >= 7:
                    break
        self.reconnecting = False
        self.reconnectable = await self.probe_listener()
        log("cannot reconnect: the phone is not on a Wi-Fi network. It has to "
            "rejoin one before a new session can be opened."
            if not self.reconnectable else "giving up reconnecting")
        self.emit()

    async def clear(self) -> dict:
        self.desired = None   # stop trying to hold anything
        if self.connected:
            async with self.lock:
                await self.location.clear()
            self.last = None
        self.emit()
        return self.info()

    async def disconnect(self, quiet: bool = False) -> dict:
        self.desired = None
        if self.heartbeat_task:
            self.heartbeat_task.cancel()
            self.heartbeat_task = None
        if self.stack is not None:
            try:
                await self.location.clear()
            except Exception:
                pass
            try:
                await self.stack.aclose()
            except Exception:
                pass
        self.stack = None
        self.location = None
        self.last = None
        self.transport = None
        self.kind = None
        if not quiet:
            self.emit()
        return {"connected": False}


HINTS = [
    (NoDeviceConnectedError, "No iPhone found. Connect it by USB, or join it to this network."),
    (DeveloperModeIsNotEnabledError,
     "Developer Mode is off: Settings > Privacy & Security > Developer Mode, then reboot."),
    (PasswordRequiredError,
     "The iPhone is locked. Unlock it — iOS refuses developer services on a locked device."),
]


def hint_for(exc: BaseException) -> str | None:
    for cls, hint in HINTS:
        if isinstance(exc, cls):
            return hint
    if isinstance(exc, LockdownRefused):
        return ("Remote access over Tailscale is refused by iOS 27. ghost still works on "
                "the same Wi-Fi as the Mac or over USB; away from home, use StikDebug.")
    text = str(exc).lower()
    if "passwordprotected" in text.replace(" ", ""):
        return HINTS[2][1]
    if "connect call failed" in text or "refused" in text:
        return ("Nothing is listening on the phone. iOS only runs that listener while "
                "Wi-Fi is ON — check Wi-Fi is enabled on the phone.")
    if "pair" in text or "trust" in text:
        return "Device not trusted. Unlock the iPhone and tap Trust."
    return None


async def list_devices() -> list[dict]:
    from pymobiledevice3 import usbmux
    found = []
    for dev in await usbmux.list_devices():
        entry = {"udid": dev.serial, "connection": dev.connection_type}
        try:
            ld = await create_using_usbmux(serial=dev.serial)
            entry["name"] = ld.short_info.get("DeviceName")
            entry["ios"] = ld.product_version
        except Exception as e:
            entry["name"] = "(unavailable)"
            entry["error"] = str(e)
        found.append(entry)
    return found


async def handle(session: Session, req: dict):
    cmd, args = req.get("cmd"), (req.get("args") or {})
    if cmd == "ping":
        return {"pong": True}
    if cmd == "devices":
        return {"devices": await list_devices()}
    if cmd == "status":
        return session.info()
    if cmd == "connect":
        return await session.connect(args.get("transport"))
    if cmd == "set":
        return await session.set(float(args["lat"]), float(args["lon"]))
    if cmd == "clear":
        return await session.clear()
    if cmd == "disconnect":
        return await session.disconnect()
    raise ValueError(f"unknown command: {cmd}")


async def main() -> None:
    session = Session()
    loop = asyncio.get_running_loop()
    reader = asyncio.StreamReader()
    await loop.connect_read_pipe(lambda: asyncio.StreamReaderProtocol(reader), sys.stdin)
    out({"event": "ready"})

    while True:
        line = (await reader.readline()).strip()
        if not line:
            if reader.at_eof():
                break
            continue
        try:
            req = json.loads(line)
        except json.JSONDecodeError:
            continue
        rid = req.get("id")
        try:
            out({"id": rid, "ok": True, "data": await handle(session, req)})
        except Exception as e:
            out({"id": rid, "ok": False, "error": f"{e.__class__.__name__}: {e}",
                 "hint": hint_for(e), "trace": traceback.format_exc(limit=3)})

    await session.disconnect()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
