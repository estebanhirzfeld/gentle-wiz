# gentle-wiz

Control WiZ smart lights from Gentle Shell / Pi with one slash command, over the local network:
JSON in single UDP datagrams, no cloud, no account, no credentials.

Same shape as gentle-spotify: a testable engine (`src/wiz.ts`) with every external effect
injected, a thin extension (`src/extension.ts`) that registers exactly one command, and no
background work — no timers, no polling, no sidebar row.

## Install

```
pi install git:github.com/<owner>/gentle-wiz
```

Restart Gentle Shell and `/wiz` is available. It is never handled by the model: the whole
argument is parsed locally, deterministically, and costs no tokens.

## Configure your lights

Lights are configured by hand in `~/.config/gentle-wiz/lights.json`. The easiest way to
build it: run `/wiz discover`, then paste the printed JSON and edit the names.

```json
{"lights":[{"name":"escritorio","ip":"192.0.2.26","mac":"aabbccddee01"}]}
```

## Usage

```
/wiz                          status of every light
/wiz on | /wiz off            all lights, or one: /wiz escritorio on
/wiz dim <10-100>             brightness, e.g. /wiz dim 40
/wiz temp <2200-6500>         white temperature in kelvin, e.g. /wiz temp 3200
/wiz color <#rgb|#rrggbb>     color, e.g. /wiz color #ffcc00
/wiz scene <1-32>             play a scene, e.g. /wiz scene 6
/wiz pick                     live colour editor (see below), e.g. /wiz pick or /wiz escritorio pick
/wiz status                   same as /wiz
/wiz discover                 find lights and print the JSON for lights.json
/wiz help                     this help
/wiz <light>                  that light's state, e.g. /wiz escritorio
/wiz <light> <form>           target one light, e.g. /wiz escritorio dim 40
```

Forms are case-insensitive and ignore extra spaces. With a single configured light the name
is optional; with several, `/wiz on` and `/wiz off` hit every light and the other forms ask
you to name one. Every result reports the state read back from the light, e.g.
`▶ escritorio on, 40%`.

**Note:** `temp` and `color` take the light out of its scene — the command tells you, e.g.
`... (left scene 6)`. Changing `dimming` keeps the scene.

## Live colour editor (`/wiz pick`)

`/wiz pick` (or `/wiz <light> pick`) opens a bordered overlay with three bars: **Tono** (hue),
**Brillo** (brightness) and **Saturación**. It starts from the light's current colour and
brightness; a light in a scene or with tunable white starts from a friendly blue.

- ↑↓ move between bars, ←→ change the selected value.
- The colour is the pure colour: tone + saturation at full value. Brillo is the light's
  own `dimming` (10–100), sent separately — exactly how the bulb understands it.
- Every change is sent to the light in real time, throttled to at most 8 sends per second
  and only the last value; two sends never overlap.
- **Enter** confirms: the pending value is flushed and the command reports
  `Color #rrggbb, dimming N% on <light>`.
- **Esc** cancels: pending sends are dropped, any send in flight is allowed to settle, and
  the light is restored to exactly how it was when the editor opened (scene, temperature,
  colour, brightness, or off). If the light was off, the first change turns it on and Esc
  turns it back off.
- With several lights configured, name one (`/wiz escritorio pick`); a live editor must
  not move every light at once.

## Protocol

WiZ lights speak JSON in single UDP datagrams on port 38899 of each device: `getPilot`
reads the state, `setPilot` writes it and answers `{"success": true}`. Discovery broadcasts
`getPilot` to the /24 broadcast address of every IPv4 interface plus `255.255.255.255`.
Everything is local — no cloud, no account, no credentials.

UDP drops datagrams, so every call retries (3 tries, each with a 1 s timeout) and, if
nothing answers, reports `no answer from <name> (<ip>)` instead of pretending it worked.

## Verified hardware

Verified against one device: a WiZ **ESP25_SHRGB_01** (RGB + tunable white), firmware
**1.38.0** — `getPilot` reads, `setPilot` writes (`state`, `dimming`, `temp`, `r`/`g`/`b`,
`sceneId`), dimming keeps `sceneId`, and `temp`/`color` leave the scene. Other WiZ models
or firmware versions may behave differently.

## Development

```
npm test    # node --test test/*.test.ts — everything runs on fakes, no network, no real light
```

The UDP transport is injected (`send(json, ip) -> reply`, plus a broadcast transport for
discovery), so the suite never sends a datagram and never touches a real device.
