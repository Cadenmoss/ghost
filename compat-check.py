#!/usr/bin/env python3
"""
Upgrade canary.

ghost leans on pymobiledevice3 internals — most riskily, it swaps out a
module-level factory inside `userspace_tunnel` to force the tunnel onto a
transport of our choosing. That is a shim, not a public API, so an upgrade can
remove it without warning. This verifies every symbol and signature ghost
depends on, so breakage surfaces here instead of at connect time.
"""
import importlib, inspect, json, sys

CHECKS = [
    # (module, attribute, kind, required keyword arguments)
    ("pymobiledevice3.lockdown", "create_using_usbmux", "func", ["serial", "connection_type"]),
    ("pymobiledevice3.lockdown", "create_using_tcp", "func",
     ["hostname", "identifier", "pair_record", "autopair", "keep_alive"]),
    # The patch target. If this name ever moves, the tailnet transport dies.
    ("pymobiledevice3.remote.userspace_tunnel", "create_using_usbmux", "func", []),
    ("pymobiledevice3.remote.userspace_tunnel", "UserspaceRsdTunnel", "class", []),
    ("pymobiledevice3.remote.tunnel_service", "CoreDeviceTunnelProxy", "class", []),
    ("pymobiledevice3.services.dvt.instruments.dvt_provider", "DvtProvider", "class", []),
    ("pymobiledevice3.services.dvt.instruments.location_simulation", "LocationSimulation", "class", []),
    ("pymobiledevice3.services.mobile_image_mounter", "auto_mount", "func", []),
    ("pymobiledevice3.services.simulate_location", "DtSimulateLocation", "class", []),
    ("pymobiledevice3.usbmux", "list_devices", "func", []),
    ("pymobiledevice3.exceptions", "AlreadyMountedError", "class", []),
    ("pymobiledevice3.exceptions", "DeveloperModeIsNotEnabledError", "class", []),
    ("pymobiledevice3.exceptions", "NoDeviceConnectedError", "class", []),
    ("pymobiledevice3.exceptions", "PasswordRequiredError", "class", []),
]

# Methods ghost calls on the location channel.
METHODS = [
    ("pymobiledevice3.services.dvt.instruments.location_simulation", "LocationSimulation", ["set", "clear"]),
]

def main() -> int:
    problems = []
    for mod_name, attr, kind, kwargs in CHECKS:
        try:
            mod = importlib.import_module(mod_name)
        except Exception as e:
            problems.append(f"module missing: {mod_name} ({e.__class__.__name__})")
            continue
        obj = getattr(mod, attr, None)
        if obj is None:
            problems.append(f"missing: {mod_name}.{attr}")
            continue
        if kind == "class" and not inspect.isclass(obj):
            problems.append(f"{mod_name}.{attr} is no longer a class")
        if kwargs:
            try:
                params = inspect.signature(obj).parameters
                for k in kwargs:
                    if k not in params:
                        problems.append(f"{mod_name}.{attr}() lost argument '{k}'")
            except (TypeError, ValueError):
                pass

    for mod_name, cls_name, methods in METHODS:
        try:
            cls = getattr(importlib.import_module(mod_name), cls_name)
            for m in methods:
                if not hasattr(cls, m):
                    problems.append(f"{cls_name}.{m}() is gone")
        except Exception as e:
            problems.append(f"{cls_name}: {e.__class__.__name__}")

    try:
        import importlib.metadata as md
        version = md.version("pymobiledevice3")
    except Exception:
        version = "unknown"

    print(json.dumps({"version": version, "problems": problems}))
    return 1 if problems else 0

sys.exit(main())
