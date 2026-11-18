# Third-party notices

- `vendor/patches/GhostIntents.swift` is added to a checkout of
  [StikDebug](https://github.com/StikDebug/StikDebug), which is licensed under
  AGPL-3.0. That file is built into StikDebug and should be treated as AGPL-3.0
  when distributed together with it. StikDebug itself is not included in this
  repository; `vendor/prepare-stikdebug.sh` fetches and patches it.
- ghost drives the iPhone through [pymobiledevice3](https://github.com/doronz88/pymobiledevice3)
  (GPL-3.0), which is installed separately and not bundled here.
- Everything else is MIT (see LICENSE).
