# gentle-wiz

Pi / Gentle Shell package that controls WiZ smart lights over the local network (JSON over UDP, no cloud),
with one slash command `/wiz`. Same shape as gentle-spotify: a testable engine with everything external
injected, plus a thin extension.

## Specs

- **S1 One command.** User asked "y puedo controlar mis focos de wiz desde comandos aca?" and, like `/sp`, the
  lights live behind one command with fixed whole-argument forms (case-insensitive, extra spaces ignored):
  `` (empty) → status of every light; `on`, `off`, `dim <10-100>`, `temp <2200-6500>`, `color <#rgb|#rrggbb>`,
  `scene <1-32>`, `status`, `discover`, `help`. Anything else is a light name followed by one of those forms
  (`/wiz escritorio dim 40`). `/wiz <name>` alone shows that light's state. Unknown names and malformed values
  fail with a clear message and send nothing.
- **S2 Local only.** WiZ speaks JSON in single UDP datagrams to port 38899 of each device: `getPilot` reads,
  `setPilot` writes, `{"success": true}` on success. Discovery broadcasts `getPilot` to the /24 broadcast and
  255.255.255.255. No cloud, no account, no credentials. Datagrams are lost sometimes, so every call retries
  (3 tries, 1 s timeout) and reports "no answer from <name> (<ip>)" instead of pretending.
- **S3 Verified device.** 192.0.2.26, mac aabbccddee01, model ESP25_SHRGB_01 (RGB + tunable white),
  firmware 1.38.0, scene 6 at 100%. `setPilot {"state":true,"dimming":20}` answered `{"success":true}` and the
  state read back 20%; restoring `{"state":true,"dimming":100,"sceneId":6}` matched the original exactly.
  Changing `dimming` KEEPS `sceneId`; `temp` and `color` take the light out of its scene, so those two commands
  must say so in their result.
- **S4 Testable and publishable.** The UDP send is injected (`send(json, ip) -> reply`), so every test runs on
  fakes with no network. Light names live in `~/.config/gentle-wiz/lights.json`:
  `{"lights":[{"name":"escritorio","ip":"192.0.2.26","mac":"aabbccddee01"}]}`; with a single light, commands
  may omit the name. `discover` prints what answered and the JSON to paste. package.json carries the `pi`
  manifest and the `pi-package` keyword; README documents install, config and every form. Publishing to
  GitHub/Gentle Hub is the user's decision.

## Tasks

- [ ] T1 S4 — scaffold: manifest, LICENSE, .gitignore, this document. inline.
- [ ] T2 S2,S3,S4 — engine `src/wiz.ts`: UDP transport, retries, config load, discovery, get/set, formatting. test-first.
- [ ] T3 S1,S2,S4 — extension `src/extension.ts`: one `/wiz` command, completions, errors as notifies. test-first.
- [ ] T4 S4 — README, local install in Gentle Shell, live check against the real light.

## Log

- L1 (user, verbatim): "y puedo controlar mis focos de wiz desde comandos aca ?"
- L2 (user): chose "Sí, descubrí los focos en mi red" → one device answered at 192.0.2.26 (getPilot and
  getSystemConfig only; nothing was switched).
- L3 (user): chose "Probá escritura primero" and said it is the only light in the network. Write test:
  dimming 20% then restored to 100% + scene 6, read back identical.
- L4 (decision): separate package `gentle-wiz` in ~/Desktop/gentle-wiz; lights do not belong in gentle-spotify.
