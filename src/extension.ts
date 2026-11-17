/**
 * gentle-wiz: Pi / Gentle Shell extension.
 *
 * One slash command, /wiz, handled here — never by the model — so it is
 * deterministic and costs no tokens. The whole argument must match one of the
 * fixed forms (case-insensitive, extra spaces ignored); anything else is an
 * error that shows the usage. There is no background work: no timers, no
 * polling, no sidebar row.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { homedir } from "node:os";
import { join } from "node:path";
import { createLiveSender } from "./live.ts";
import { BarsComponent, hsvToRgb, initialStateFor, piKeys, pickHex, rawKeys, type KeyApi, type PickState } from "./pick.ts";
import { createWiz, type Light, type Snapshot, type Wiz } from "./wiz.ts";
import { udpBroadcast, udpSend } from "./transport.ts";

type Level = "info" | "warning" | "error";
interface UI {
	notify(message: string, level?: Level): void;
}
/** The factory pi hands to `ctx.ui.custom`; `tui` is only used for `requestRender`. */
type CustomFactory = (
	tui: { requestRender: () => void },
	theme: unknown,
	keybindings: unknown,
	done: (value: string | undefined) => void,
) => unknown;
/** The fixed options `/wiz pick` opens the overlay with. */
const PICK_UI = {
	overlay: true,
	overlayOptions: { anchor: "center" as const, width: 62, maxHeight: 20 },
	blocked: { kind: "question" as const, message: "Pick a color" },
};
interface Ctx {
	ui: UI & { custom?: (factory: CustomFactory, options?: unknown) => Promise<string | undefined> };
}

export interface ExtensionOptions {
	/** Defaults to ~/.config/gentle-wiz. */
	configDir?: string;
	/** Injectable engine (tests); defaults to the real UDP transport. */
	wiz?: Wiz;
}

export const USAGE = `/wiz — WiZ lights:
  /wiz                          status of every light
  /wiz on | /wiz off            all lights, or one: /wiz escritorio on
  /wiz dim <10-100>             brightness, e.g. /wiz dim 40
  /wiz temp <2200-6500>         white temperature in kelvin, e.g. /wiz temp 3200
  /wiz color <#rgb|#rrggbb>     color, e.g. /wiz color #ffcc00
  /wiz scene <1-32>             play a scene, e.g. /wiz scene 6
  /wiz pick                     live colour editor for one light: /wiz <light> pick
  /wiz status                   same as /wiz
  /wiz discover                 find lights and print the JSON for lights.json
  /wiz help                     this help
  /wiz <light>                  that light's state, e.g. /wiz escritorio
temp and color take the light out of its scene.`;

const FORMS = ["on", "off", "dim", "temp", "color", "scene", "pick", "status", "discover", "help"] as const;
/** Forms that make sense for one named light. */
const NAME_FORMS = ["on", "off", "dim", "temp", "color", "scene", "pick", "status"] as const;

const RANGES = { dim: [10, 100], temp: [2200, 6500], scene: [1, 32] } as const;
const EXAMPLES = { dim: "40", temp: "3200", scene: "6" } as const;

export type WizAction =
	| { kind: "status" | "on" | "off"; name?: string }
	| { kind: "dim" | "temp" | "scene"; value: number; name?: string }
	| { kind: "color"; value: string; name?: string }
	| { kind: "pick"; name?: string }
	| { kind: "discover" | "help" }
	| { kind: "error"; message: string };

function fail(message: string): WizAction {
	return { kind: "error", message: `${message}\n${USAGE}` };
}

/**
 * Fixed whole-argument forms, matched against the case-insensitive,
 * space-normalized argument. A form preceded by a configured light name
 * targets that light; the light name alone shows its state. Malformed values
 * are rejected here with the valid range, before anything is sent.
 */
export function parseWiz(args: string, lights: string[]): WizAction {
	const text = (args ?? "").trim().toLowerCase().replace(/\s+/g, " ");
	const tokens = text ? text.split(" ") : [];
	let name: string | undefined;
	let rest = tokens;
	if (tokens.length > 0) {
		const matched = lights.find((l) => l.toLowerCase() === tokens[0]);
		if (matched) {
			name = matched;
			rest = tokens.slice(1);
		}
	}
	if (rest.length === 0) return { kind: "status", name };

	const [head, ...tail] = rest;
	const value = tail.join(" ");
	switch (head) {
		case "on":
		case "off":
			return { kind: head, name };
		case "status":
			return { kind: "status", name };
		case "dim":
		case "temp":
		case "scene": {
			if (!/^\d+$/.test(value)) {
				return fail(`${head} needs a whole number, e.g. /wiz ${head} ${EXAMPLES[head]}.`);
			}
			const number = Number(value);
			const [min, max] = RANGES[head];
			if (number < min || number > max) return fail(`${head} must be from ${min} to ${max}.`);
			return { kind: head, value: number, name };
		}
		case "color":
			if (!/^#[0-9a-f]{3}(?:[0-9a-f]{3})?$/i.test(value)) {
				return fail("color must be #rgb or #rrggbb, e.g. /wiz color #ffcc00.");
			}
			return { kind: "color", value, name };
		case "pick":
			if (value) return fail("pick takes no value; open it with /wiz pick or /wiz <light> pick.");
			return { kind: "pick", name };
		case "discover":
			return name ? fail("discover takes no light name.") : { kind: "discover" };
		case "help":
			return name ? fail("help takes no light name.") : { kind: "help" };
		default:
			return fail(`I don't understand "/wiz ${rest.join(" ")}".`);
	}
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** What a snapshot held, in words, for the restore-failed message. */
function describeSnapshot(s: Snapshot): string {
	const bits = [s.state ? "on" : "off"];
	if (s.dimming != null) bits.push(`dimming ${s.dimming}%`);
	if (s.sceneId != null) bits.push(`scene ${s.sceneId}`);
	if (s.temp != null) bits.push(`${s.temp}K`);
	const hex = (n: number) => n.toString(16).padStart(2, "0");
	if (s.r != null && s.g != null && s.b != null) bits.push(`#${hex(s.r)}${hex(s.g)}${hex(s.b)}`);
	return bits.join(", ");
}

/** pi-tui inside Gentle Shell; anywhere else (tests, other hosts) the raw keys still work. */
async function keyMatcher(): Promise<KeyApi> {
	try {
		return piKeys(await import("@earendil-works/pi-tui"));
	} catch {
		return rawKeys;
	}
}

export function defaultConfigDir(): string {
	return join(homedir(), ".config", "gentle-wiz");
}

export function createExtension(options: ExtensionOptions = {}) {
	return function gentleWiz(pi: ExtensionAPI): void {
		const wiz: Wiz =
			options.wiz ??
			createWiz({
				configDir: options.configDir ?? defaultConfigDir(),
				send: (json, ip) => udpSend(json, ip),
				broadcast: (json) => udpBroadcast(json),
			});

		/** Light names for parsing and completions; empty when lights.json is missing or corrupt. */
		function lightNames(): string[] {
			try {
				return wiz.lights().map((l: Light) => l.name);
			} catch {
				return [];
			}
		}

		/** The live colour editor: read once, move live (throttled), Enter confirms, Esc restores. */
		async function pick(name: string | undefined, ui: Ctx["ui"]): Promise<void> {
			// The only thing sent before the modal opens: one getPilot. If it fails
			// (or the light cannot be named) nothing else happens and nothing is sent.
			const snapshot = await wiz.snapshot(name);
			if (typeof ui.custom !== "function") {
				ui.notify("This interface has no custom UI, so the colour editor cannot open here.", "error");
				return;
			}
			const initial = initialStateFor(snapshot);
			const keys = await keyMatcher();
			const live = createLiveSender<{ rgb: [number, number, number]; dim: number }>({
				send: async ({ rgb, dim }) => {
					await wiz.applyColor({ r: rgb[0], g: rgb[1], b: rgb[2] }, dim, snapshot.light.name);
				},
			});
			let last: PickState = { ...initial };
			const result = await ui.custom(
				(tui, _theme, _keybindings, done) =>
					new BarsComponent(tui, done, initial, {
						onChange: (state) => {
							last = { ...state };
							// The pure colour (full value) plus the light's dimming, at most 8 sends/s.
							live.push({ rgb: hsvToRgb(state.hue, state.sat / 100, 1), dim: state.dim });
						},
					}, keys),
				PICK_UI,
			);
			if (result === undefined) {
				// Esc: drop pending sends (and let an in-flight one settle, so the
				// restore cannot be overtaken), then put the light back how it was.
				await live.cancel();
				try {
					await wiz.restore(snapshot);
					ui.notify(`Restored ${snapshot.light.name} to how it was`, "info");
				} catch (error) {
					ui.notify(
						`Could not restore ${snapshot.light.name} (${message(error)}). Put it back by hand: ${describeSnapshot(snapshot)}.`,
						"error",
					);
				}
				return;
			}
			// Enter: wait for the last value to reach the light, then say which colour it is.
			try {
				await live.flush();
				ui.notify(`Color ${pickHex(last)}, dimming ${last.dim}% on ${snapshot.light.name}`, "info");
			} catch (error) {
				ui.notify(message(error), "error");
			}
		}

		async function dispatch(action: WizAction): Promise<string> {
			switch (action.kind) {
				case "status":
					return wiz.status(action.name);
				case "on":
					return wiz.on(action.name);
				case "off":
					return wiz.off(action.name);
				case "dim":
					return wiz.dim(action.value, action.name);
				case "temp":
					return wiz.temp(action.value, action.name);
				case "color":
					return wiz.color(action.value, action.name);
				case "scene":
					return wiz.scene(action.value, action.name);
				case "discover":
					return wiz.discover();
				case "help":
					return USAGE;
			}
		}

		pi.registerCommand("wiz", {
			description: "WiZ lights: /wiz on|off|dim|temp|color|scene|status|discover, /wiz <light> <form>, help",
			getArgumentCompletions: (prefix: string) => {
				const names = lightNames();
				const typed = (prefix ?? "").toLowerCase();
				// Completing after a light name: suggest the forms for that light.
				const afterName = /^(\S+)\s+(.*)$/.exec(typed);
				if (afterName) {
					const light = names.find((n) => n.toLowerCase() === afterName[1]);
					if (light) {
						const items = NAME_FORMS.filter((f) => f.startsWith(afterName[2])).map((f) => ({
							value: `${light} ${f}`,
							label: `${light} ${f}`,
						}));
						return items.length > 0 ? items : null;
					}
				}
				const items = [...FORMS, ...names]
					.filter((c) => c.toLowerCase().startsWith(typed))
					.map((c) => ({ value: c, label: c }));
				return items.length > 0 ? items : null;
			},
			handler: async (args: string, ctx: unknown): Promise<void> => {
				const { ui } = ctx as Ctx;
				const action = parseWiz(args ?? "", lightNames());
				try {
					if (action.kind === "error") ui.notify(action.message, "error");
					else if (action.kind === "pick") await pick(action.name, ui);
					else ui.notify(await dispatch(action), "info");
				} catch (error) {
					ui.notify(message(error), "error");
				}
			},
		});
	};
}

export default createExtension();
