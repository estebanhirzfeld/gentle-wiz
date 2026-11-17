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

## Addendum: el editor en vivo (W5)

- L5 (user): "si podes mostrar los colores no podes hacer algo como rgb dim te desplazas arriba o abajo y a los costados
  para variar la intensidad de colores y dim?" → prototipo inline/overlay; user: "no me gusta como se ve siento que no es
  clara la ui/ux", con "No veo la gama de colores" como causa y "B: barras de control" como dirección.
- L6 (user): "genial, me gusta el pcik como modal, pero agregaria un poquito de padding y un border" → definitivo:
  overlay centrado, marco `┌─┐│└┘`, padding de 2, tres barras con degradado real (tono/brillo/saturación), `▲` de
  posición y nombre de color en lugar de grados.
- **S8**: `src/pick.ts` — componente puro: calcula y dibuja, reporta cada cambio por `onChange`; sin red ni timers.
  Envío al foco con throttle y restauración al cancelar = trabajo del llamador (`/wiz pick`), pendiente.

- L7 (user, verbatim): "veo que ahora muestra la ultima tecla, pero la flechita como los colores y eso no se mueven" —
  keys arrived but were not recognised. Evidence: pi-tui's real `matchesKey` treats `\x1bOA`, `\x1b[1;1A` and
  `\x1b[1;1:1A` as arrows; my raw `\x1b[A` comparison missed them, and Kitty sends key-release events (`:3`) that must not
  step. Fix: injectable `KeyApi` (`piKeys` adapts Pi's matchesKey; `rawKeys` fallback understands application-mode and
  Kitty), releases ignored, footer shows `última tecla: <raw> → <name> [matcher]`. 61 tests.
- L8 (user, verbatim): "muchisimo mejor, pasan 2 cosas 1. que la barra se desplaza al ser elegida ... 2. el valor maximo no
  llega hasta el extremo sino que queda poco desp de la mitad" (two screenshots). Evidence: (1) the selected row's label is
  bold and `padEnd` counted the escape codes, so its bar started 7 columns early (bars at 9,16,16); (2) the marker offset
  omitted the label column, so 100% landed ~70% along the bar. Fixed test-first with column-measuring tests (bars align,
  equal cell count, marker on first/last cell at min/max, middle in between). 65 tests.
- L9 (user, verbatim): chose "Sí, que coincida con el foco" for the Brillo semantics. Decision: the colour is HSV at full value
  (tone + saturation); Brillo is the light's `dimming` (10-100), sent separately. The Brillo bar runs from dark to the
  PURE colour (never white), the swatch and hex are the pure colour, `colorName(hue, sat)` no longer depends on brightness.
  68 tests.
- L10 (T5 done): engine `snapshot`/`applyColor`/`restore` (`src/wiz.ts`) and the injectable throttled live sender
  (`src/live.ts`: leading send, trailing last value, never two in flight, flush surfaces a send error once, cancel waits
  for the in-flight send so a restore cannot be overtaken) landed in `7a139e1`; `/wiz pick` wiring (`src/extension.ts`:
  fixed form + completions, `initialStateFor` from the snapshot, `ctx.ui.custom` overlay `anchor: center, width 62,
  maxHeight 20`, blocked "Pick a color", Enter flush + notify, Esc cancel + restore, `initialStateFor` and `rgbToHsv` in
  `src/pick.ts`) and README in `0b3b352`. 113 tests, all green; the extension still loads under jiti (prints only `wiz`).

- **S9 `/wiz pick` (live).** User: "perfecto" to: real-time while moving, Enter confirms and closes, Esc restores. `/wiz pick`
  (or `/wiz <name> pick`) opens the bordered overlay from `src/pick.ts`. Every ←/→ change is sent to the light, throttled to
  at most 8 sends per second, only the LAST value, never two in flight. Enter flushes the pending value, waits for it, then
  closes with `color #rrggbb, dimming N%`. Esc cancels pending sends and restores what the light had when the modal opened.
  Brillo is the light's `dimming` (10-100); the colour is the pure colour (see L9). Several lights and no name: error that
  lists the names (a live picker must not move every light).

- [x] T5 S9 — `/wiz pick`: snapshot + restore in the engine (`7a139e1`), throttled live sender (`7a139e1`),
  overlay wiring in the extension (`0b3b352`), README (`0b3b352`).
- L11 (evidence, parent review of T5): end-to-end simulation on the real extension with a fake light in scene 6 at 100%
  (TEST-NET address, injected transport): opening = 1 getPilot and 0 writes; 40 key presses over 1 s = 9 sends, at most
  8 in any one second, 1 in flight at a time; Enter leaves the light exactly at the pending colour and dimming; Esc restores
  `{state:true,dimming:100,sceneId:6}` exactly. Two findings fixed test-first: (1) opening and closing without moving a bar
  wrote a pointless "restore" (could restart a scene) and Enter claimed a colour that was never sent; now nothing is written
  and the command says `No changes on <light>`; (2) KNOWN LIMIT, not fixed: a light that was OFF when opened is turned off by
  Esc but keeps the previewed colour/dimming (restore of an off light sends only `{state:false}`); needs the real bulb to
  decide the right payload. Two of the worker's tests encoded the old behaviour and were updated, not weakened. 116 tests.
- L12 (user, verbatim): "la forma de poner los comandos es muy tosca, arreglalo vos". Interpretation (mine, the user left it to me):
  typing hex, kelvin and scene numbers, English-only verbs. Done inline: colour/white/scene NAMES (`src/names.ts`, scene ids and
  names from pywizlight's scenes.py, 1-32 only), bare shortcuts (`40`, `40%`, `+10`, `-`, `#hex`), Spanish verbs, `toggle`,
  menus for a bare `color|dim|temp|scene` through `ctx.ui.select` (colours with swatches), completions that ignore accents.
  Engine gained `toggle` and `dimBy`. A light named like a colour wins. 138 tests (22 new). Three of the worker's tests encoded
  the old usage text / "bare dim is an error" and were updated, not weakened. Unverified: how the menus look in the user's terminal.
