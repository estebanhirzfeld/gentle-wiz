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
import { COLOR_MENU, DIM_MENU, SCENE_MENU, SUGGESTIONS, TEMP_MENU, normalize, resolveColor, resolveScene, resolveTemp } from "./names.ts";
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
	ui: UI & {
		custom?: (factory: CustomFactory, options?: unknown) => Promise<string | undefined>;
		select?: (title: string, options: string[]) => Promise<string | undefined>;
	};
}

export interface ExtensionOptions {
	/** Defaults to ~/.config/gentle-wiz. */
	configDir?: string;
	/** Injectable engine (tests); defaults to the real UDP transport. */
	wiz?: Wiz;
}

export const USAGE = `/wiz — WiZ lights
  /wiz                  menu with every action (Enter picks, Esc cancels)
  /wiz on | off | toggle | status
  /wiz 40               brightness 10-100 (+10 / -10: relative to now)
  /wiz azul             colour: rojo naranja amarillo verde turquesa celeste azul violeta rosa magenta, or #ffcc00
  /wiz calido           white: vela calido neutro frio, or exact kelvin: 3200k (2200-6500)
  /wiz cozy             scene by its WiZ name (the menu lists them all)
  /wiz pick             live colour editor
  /wiz discover | help  find lights / this help
  /wiz <light> <any of the above>      e.g. /wiz escritorio azul
temp and color take the light out of its scene.`;

const FORMS = ["on", "off", "toggle", "status", "pick", "discover", "help"] as const;
/** Forms that make sense for one named light. */
const NAME_FORMS = ["on", "off", "toggle", "status", "pick"] as const;

const RANGES = { dim: [10, 100], temp: [2200, 6500] } as const;
const HEX = /^#[0-9a-f]{3}(?:[0-9a-f]{3})?$/i;

export type WizAction =
	| { kind: "status" | "on" | "off" | "toggle"; name?: string }
	| { kind: "dim" | "temp" | "scene"; value: number; name?: string }
	| { kind: "dimBy"; delta: number; name?: string }
	| { kind: "color"; value: string; name?: string }
	| { kind: "menu"; name?: string }
	| { kind: "pick"; name?: string }
	| { kind: "discover" | "help" }
	| { kind: "error"; message: string };

function fail(message: string): WizAction {
	return { kind: "error", message: `${message}\n${USAGE}` };
}

function inRange(kind: "dim" | "temp", value: number, name?: string): WizAction {
	const [min, max] = RANGES[kind];
	if (value < min || value > max) return fail(`${kind} must be from ${min} to ${max}.`);
	return { kind, value, name };
}

/**
 * Deterministic: the argument is normalised (case, accents, spaces), an optional configured light name
 * is taken off the front, and what is left must be exactly one of: nothing (the menu), a fixed form, or a
 * shortcut (`40`, `+10`, `3200k`, `#hex`, a colour, white or scene name). Anything else is rejected with
 * the usage. There is one way to say each thing. A light named like a colour wins over the colour.
 */
export function parseWiz(args: string, lights: string[]): WizAction {
	const tokens = normalize(args ?? "").split(" ").filter(Boolean);
	let name: string | undefined;
	let rest = tokens;
	if (tokens.length > 0) {
		const matched = lights.find((l) => normalize(l) === tokens[0]);
		if (matched) {
			name = matched;
			rest = tokens.slice(1);
		}
	}
	if (rest.length === 0) return { kind: "menu", name };

	const phrase = rest.join(" ");
	const form = (FORMS as readonly string[]).includes(rest[0]) ? (rest[0] as (typeof FORMS)[number]) : undefined;
	if (form) {
		if (rest.length > 1) {
			return fail(
				form === "pick"
					? "pick takes no value; open it with /wiz pick or /wiz <light> pick."
					: `${form} takes no value.`,
			);
		}
		if (form === "discover" || form === "help") {
			return name ? fail(`${form} takes no light name.`) : { kind: form };
		}
		return { kind: form, name };
	}

	const relative = /^([+-])(\d*)$/.exec(phrase);
	if (relative) return { kind: "dimBy", delta: (relative[1] === "-" ? -1 : 1) * (relative[2] ? Number(relative[2]) : 10), name };
	const absolute = /^(\d+)$/.exec(phrase);
	if (absolute) return inRange("dim", Number(absolute[1]), name);
	const kelvin = /^(\d+)k$/.exec(phrase);
	if (kelvin) return inRange("temp", Number(kelvin[1]), name);
	if (HEX.test(phrase)) return { kind: "color", value: phrase, name };
	const colour = resolveColor(phrase);
	if (colour) return { kind: "color", value: colour, name };
	const white = resolveTemp(phrase);
	if (white !== undefined) return { kind: "temp", value: white, name };
	const scene = resolveScene(phrase);
	if (scene !== undefined) return { kind: "scene", value: scene, name };
	return fail(`I don't understand "/wiz ${phrase}".`);
}

/** The top-level menu: what each action is, and how to type it next time. */
const MAIN_MENU = [
	{ id: "status", label: "Status               /wiz status" },
	{ id: "on", label: "On                   /wiz on" },
	{ id: "off", label: "Off                  /wiz off" },
	{ id: "toggle", label: "Toggle               /wiz toggle" },
	{ id: "dim", label: "Brightness…          /wiz 40  ·  +10  ·  -10" },
	{ id: "color", label: "Color…               /wiz azul  ·  #ffcc00" },
	{ id: "temp", label: "White…               /wiz calido  ·  3200k" },
	{ id: "scene", label: "Scene…               /wiz cozy" },
	{ id: "pick", label: "Live color editor    /wiz pick" },
	{ id: "discover", label: "Discover lights      /wiz discover" },
	{ id: "help", label: "Help                 /wiz help" },
] as const;

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
			let changed = false; // nothing is written to the light until the first real change
			const result = await ui.custom(
				(tui, _theme, _keybindings, done) =>
					new BarsComponent(tui, done, initial, {
						onChange: (state) => {
							last = { ...state };
							changed = true;
							// The pure colour (full value) plus the light's dimming, at most 8 sends/s.
							live.push({ rgb: hsvToRgb(state.hue, state.sat / 100, 1), dim: state.dim });
						},
					}, keys),
				PICK_UI,
			);
			if (!changed) {
				// Opened and closed without moving a bar: writing a "restore" could restart a scene, and
				// Enter must not claim a colour that was never sent.
				await live.cancel();
				ui.notify(`No changes on ${snapshot.light.name}`, "info");
				return;
			}
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

		/** `/wiz` alone: pick an action; the ones that need a value open a second list. */
		async function menu(action: Extract<WizAction, { kind: "menu" }>, ui: Ctx["ui"]): Promise<void> {
			if (typeof ui.select !== "function") {
				ui.notify("This interface has no menus. Type /wiz help to see the commands.", "error");
				return;
			}
			const name = action.name;
			const first = await ui.select(name ? `/wiz ${name}` : "/wiz", MAIN_MENU.map((m) => m.label));
			const entry = MAIN_MENU.find((m) => m.label === first);
			let chosen: WizAction | undefined;
			if (entry?.id === "pick") return pick(name, ui);
			if (entry?.id === "status" || entry?.id === "on" || entry?.id === "off" || entry?.id === "toggle") {
				chosen = { kind: entry.id, name };
			} else if (entry?.id === "discover" || entry?.id === "help") {
				chosen = { kind: entry.id };
			} else if (entry?.id === "color") {
				const label = await ui.select("Color", COLOR_MENU.map((c) => c.label));
				const item = COLOR_MENU.find((c) => c.label === label);
				if (item) chosen = { kind: "color", value: item.hex, name };
			} else if (entry?.id === "dim") {
				const label = await ui.select("Brightness", DIM_MENU.map((n) => `${n}%`));
				const value = DIM_MENU.find((n) => `${n}%` === label);
				if (value !== undefined) chosen = { kind: "dim", value, name };
			} else if (entry?.id === "temp") {
				const label = await ui.select("White", TEMP_MENU.map(([text, kelvin]) => `${text} ${kelvin}K`));
				const item = TEMP_MENU.find(([text, kelvin]) => `${text} ${kelvin}K` === label);
				if (item) chosen = { kind: "temp", value: item[1], name };
			} else if (entry?.id === "scene") {
				const label = await ui.select("Scene", SCENE_MENU.map((s) => s.label));
				const item = SCENE_MENU.find((s) => s.label === label);
				if (item) chosen = { kind: "scene", value: item.id, name };
			}
			ui.notify(chosen ? await dispatch(chosen) : "Cancelled.", "info");
		}

		async function dispatch(action: WizAction): Promise<string> {
			switch (action.kind) {
				case "status":
					return wiz.status(action.name);
				case "on":
					return wiz.on(action.name);
				case "off":
					return wiz.off(action.name);
				case "toggle":
					return wiz.toggle(action.name);
				case "dimBy":
					return wiz.dimBy(action.delta, action.name);
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
			description: "WiZ lights: /wiz (menu), on|off|toggle, 40, azul, calido, cozy, pick, help",
			getArgumentCompletions: (prefix: string) => {
				const names = lightNames();
				// Accents and case do not matter; a trailing space does (it means "start the next word").
				const typed = (prefix ?? "").normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/^\s+/, "");
				const unique = (items: string[]) => [...new Set(items)];
				// After a light name: suggest what can follow it.
				const afterName = /^(\S+)\s+(.*)$/.exec(typed);
				if (afterName) {
					const light = names.find((n) => normalize(n) === afterName[1]);
					if (light) {
						const pool = afterName[2] === "" ? [...NAME_FORMS] : [...NAME_FORMS, ...SUGGESTIONS];
						const items = unique(pool)
							.filter((f) => f.startsWith(afterName[2]))
							.map((f) => ({ value: `${light} ${f}`, label: `${light} ${f}` }));
						return items.length > 0 ? items : null;
					}
				}
				// Nothing typed yet: the forms and the lights; the long name lists only appear once you start a word.
				const pool = typed === "" ? [...FORMS, ...names] : [...FORMS, ...names, ...SUGGESTIONS];
				const items = unique(pool)
					.filter((c) => normalize(c).startsWith(typed))
					.map((c) => ({ value: c, label: c }));
				return items.length > 0 ? items : null;
			},
			handler: async (args: string, ctx: unknown): Promise<void> => {
				const { ui } = ctx as Ctx;
				const action = parseWiz(args ?? "", lightNames());
				try {
					if (action.kind === "error") ui.notify(action.message, "error");
					else if (action.kind === "pick") await pick(action.name, ui);
					else if (action.kind === "menu") await menu(action, ui);
					else ui.notify(await dispatch(action), "info");
				} catch (error) {
					ui.notify(message(error), "error");
				}
			},
		});
	};
}

export default createExtension();
