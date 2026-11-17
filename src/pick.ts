/**
 * The live colour editor: three gradient bars (hue, brightness, saturation) inside a bordered modal.
 *
 * Pure by design: it computes and draws, and reports each change through `onChange`. Sending the value to a
 * light (throttled, and only the last one) is the caller's job, so this file has no network and no timer.
 */
import type { Light } from "./config.ts";

export interface PickState {
	hue: number;
	sat: number;
	dim: number;
}

export interface PickHooks {
	/** Called after any change that should reach the light. */
	onChange?: (state: PickState, hex: string) => void;
}

const MIN_DIM = 10;
const MAX_DIM = 100;
const HUE_STEP = 10;
const PCT_STEP = 5;
const BARS: Array<"hue" | "dim" | "sat"> = ["hue", "dim", "sat"];
const LABEL: Record<"hue" | "dim" | "sat", string> = { hue: "Tono", dim: "Brillo", sat: "Saturación" };
const PAD = 2;
const KEYS = { up: "\x1b[A", down: "\x1b[B", right: "\x1b[C", left: "\x1b[D", enter: "\r", esc: "\x1b" } as const;
export type KeyName = "up" | "down" | "left" | "right" | "enter" | "esc";

/** How the component recognises keys. Pi's own `matchesKey` is injected at runtime; tests use the fallback. */
export interface KeyApi {
	/** Which key this input is, or undefined. */
	which(data: string): KeyName | undefined;
	/** Key-release events (Kitty protocol) must not move anything. */
	isRelease?(data: string): boolean;
	/** Shown in the footer so it is obvious which matcher is active. */
	label?: string;
}

const ARROWS: Record<string, KeyName> = { A: "up", B: "down", C: "right", D: "left" };
const NAMES: Record<string, KeyName> = {
	up: "up", arrowup: "up", down: "down", arrowdown: "down", right: "right", arrowright: "right",
	left: "left", arrowleft: "left", enter: "enter", return: "enter", escape: "esc", esc: "esc",
};

/** Fallback for tests: plain, application-mode and Kitty arrow forms, plus key names. */
export const rawKeys: KeyApi = {
	which(data) {
		if (data === "\r" || data === "\n") return "enter";
		if (data === "\x1b") return "esc";
		const m = /^\x1b(?:\[(?:1;\d+(?::\d+)?)?|O)([ABCD])$/.exec(data);
		if (m) return ARROWS[m[1]];
		return NAMES[data.trim().toLowerCase()];
	},
	isRelease: (data) => /^\x1b\[1;\d+:3[ABCD]$/.test(data),
	label: "crudas",
};

/** Adapts pi-tui's `matchesKey`/`Key`/`isKeyRelease` (passed in, never imported here) to a KeyApi. */
export function piKeys(tui: {
	matchesKey: (data: string, key: unknown) => boolean;
	Key: Record<string, unknown>;
	isKeyRelease?: (data: string) => boolean;
}): KeyApi {
	const table: Array<[KeyName, unknown]> = [
		["up", tui.Key.up], ["down", tui.Key.down], ["left", tui.Key.left],
		["right", tui.Key.right], ["enter", tui.Key.enter], ["esc", tui.Key.escape],
	];
	return {
		which: (data) => table.find(([, key]) => tui.matchesKey(data, key))?.[0],
		isRelease: tui.isKeyRelease,
		label: "pi-tui",
	};
}

export function hslToRgb(h: number, s: number, l: number): [number, number, number] {
	const c = (1 - Math.abs(2 * l - 1)) * s;
	const hp = ((((h % 360) + 360) % 360) / 60);
	const x = c * (1 - Math.abs((hp % 2) - 1));
	const [r1, g1, b1] =
		hp < 1 ? [c, x, 0] : hp < 2 ? [x, c, 0] : hp < 3 ? [0, c, x] : hp < 4 ? [0, x, c] : hp < 5 ? [x, 0, c] : [c, 0, x];
	const m = l - c / 2;
	return [Math.round((r1 + m) * 255), Math.round((g1 + m) * 255), Math.round((b1 + m) * 255)];
}

export function toHex([r, g, b]: [number, number, number]): string {
	return "#" + [r, g, b].map((v) => Math.max(0, Math.min(255, v)).toString(16).padStart(2, "0")).join("");
}

export function pickHex(state: PickState): string {
	return toHex(hslToRgb(state.hue, state.sat / 100, state.dim / 100));
}

/** A name for the current colour, so the UI never shows raw degrees. */
export function colorName(hue: number, sat: number, dim: number): string {
	if (sat < 12) return dim > 70 ? "blanco" : dim < 20 ? "apagado" : "gris";
	if (dim > 88) return "muy claro";
	if (dim < 14) return "casi negro";
	const table: Array<[number, string]> = [
		[15, "rojo"],
		[40, "naranja"],
		[65, "amarillo"],
		[150, "verde"],
		[195, "celeste"],
		[250, "azul"],
		[290, "violeta"],
		[330, "rosa"],
		[361, "rojo"],
	];
	return table.find(([limit]) => hue < limit)?.[1] ?? "rojo";
}

const swatch = ([r, g, b]: [number, number, number], cells: number) =>
	`\x1b[48;2;${r};${g};${b}m${" ".repeat(cells)}\x1b[0m`;

export class BarsComponent {
	state: PickState;
	row = 0;
	/** How many changes were reported (the caller throttles the actual sends). */
	sends = 0;
	/** Last key received, escaped, so the UI can show what actually arrives. */
	lastKey = "";
	private version = 0;
	private done: (value: string | undefined) => void;
	private tui: { requestRender: () => void };
	private hooks: PickHooks;
	private keys: KeyApi;
	constructor(
		tui: { requestRender: () => void },
		done: (value: string | undefined) => void,
		initial: PickState,
		hooks: PickHooks = {},
		keys: KeyApi = rawKeys,
	) {
		this.keys = keys;
		this.tui = tui;
		this.done = done;
		this.state = { ...initial };
		this.hooks = hooks;
	}

	rgb(): [number, number, number] {
		return hslToRgb(this.state.hue, this.state.sat / 100, this.state.dim / 100);
	}

	hex(): string {
		return toHex(this.rgb());
	}

	private ramp(kind: "hue" | "dim" | "sat", cells: number): string {
		const out: string[] = [];
		for (let i = 0; i < cells; i++) {
			const t = cells === 1 ? 0 : i / (cells - 1);
			let h = this.state.hue / 360;
			let s = this.state.sat / 100;
			let l = this.state.dim / 100;
			if (kind === "hue") h = t;
			else if (kind === "sat") s = t;
			else l = 0.05 + t * 0.9;
			out.push(swatch(hslToRgb(h * 360, s, l), 1));
		}
		return out.join("");
	}

	private position(kind: "hue" | "dim" | "sat", cells: number): number {
		const t =
			kind === "hue" ? this.state.hue / 360 : kind === "sat" ? this.state.sat / 100 : (this.state.dim - MIN_DIM) / (MAX_DIM - MIN_DIM);
		return Math.round(Math.max(0, Math.min(1, t)) * (cells - 1));
	}

	private valueText(kind: "hue" | "dim" | "sat"): string {
		if (kind === "hue") return colorName(this.state.hue, this.state.sat, this.state.dim);
		if (kind === "sat") return `${this.state.sat}%`;
		return `${this.state.dim}%`;
	}

	handleInput(data: string): void {
		const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
		if (this.keys.isRelease?.(data)) return; // releasing a key is not another step
		const key = this.keys.which(data);
		const shown = data.replace(/\x1b/g, "\\x1b").replace(/\r/g, "\\r");
		this.lastKey = `${shown} ${key ? `→ ${key}` : "→ ?"}`;
		if (!key) {
			this.touch();
			return;
		}
		const active = BARS[this.row];
		if (key === "up") this.row = (this.row + BARS.length - 1) % BARS.length;
		else if (key === "down") this.row = (this.row + 1) % BARS.length;
		else if (key === "enter") return this.done(this.hex());
		else if (key === "esc") return this.done(undefined);
		else {
			const delta = key === "right" ? 1 : -1;
			if (active === "hue") this.state.hue = (((this.state.hue + delta * HUE_STEP) % 360) + 360) % 360;
			else if (active === "sat") this.state.sat = clamp(this.state.sat + delta * PCT_STEP, 0, 100);
			else this.state.dim = clamp(this.state.dim + delta * PCT_STEP, MIN_DIM, MAX_DIM);
			this.sends++;
			this.hooks.onChange?.({ ...this.state }, this.hex());
		}
		this.touch();
	}

	private touch(): void {
		this.version++;
		this.invalidate();
		this.tui.requestRender();
	}

	invalidate(): void {
		this.version++;
	}

	render(width: number): string[] {
		const dim = (t: string) => `\x1b[2m${t}\x1b[22m`;
		const bold = (t: string) => `\x1b[1m${t}\x1b[22m`;
		const plainLength = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "").length;
		const inner = Math.max(30, width - 2);
		const labelWidth = 11;
		const valueWidth = 6;
		const cells = Math.max(10, inner - PAD * 2 - 3 - labelWidth - 2 - valueWidth);

		// Every row measures its own content, so the border always lines up.
		const row = (content: string) =>
			`│${" ".repeat(PAD)}${content}${" ".repeat(Math.max(0, inner - PAD * 2 - plainLength(content)))}${" ".repeat(PAD)}│`;
		const blank = `│${" ".repeat(inner)}│`;
		const body: string[] = [blank, row(`${swatch(this.rgb(), 12)}  ${this.hex()}`), blank];

		BARS.forEach((kind, index) => {
			const selected = index === this.row;
			const pointer = selected ? bold("▸") : " ";
			const label = (selected ? bold(LABEL[kind]) : LABEL[kind]).padEnd(labelWidth);
			const value = this.valueText(kind).padStart(valueWidth);
			body.push(row(`${pointer} ${label}${this.ramp(kind, cells)}  ${value}`));
			const markerPad = 2 + this.position(kind, cells);
			body.push(row(`${" ".repeat(markerPad)}${selected ? "▲" : " "}${" ".repeat(Math.max(0, cells - markerPad))}`));
		});

		body.push(blank);
		body.push(row(`${dim("↑↓")} fila   ${dim("←→")} valor   ${dim("⏎")} aplica   ${dim("esc")} cancela`));
		body.push(row(`${dim("última tecla:")} ${this.lastKey || dim("—")}  ${dim(`[${this.keys.label ?? "?"}]`)}`));
		body.push(blank);

		return [`┌${"─".repeat(inner)}┐`, ...body, `└${"─".repeat(inner)}┘`];
	}
}

/** Starting point: a light's current colour when known, else a friendly blue. */
export function initialStateFor(_light?: Light): PickState {
	return { hue: 210, sat: 85, dim: 60 };
}
