import { test } from "node:test";
import assert from "node:assert/strict";
import { createExtension, parseWiz, USAGE, type WizAction } from "../src/extension.ts";
import { WizError, type Light, type Snapshot } from "../src/wiz.ts";
import { hsvToRgb, pickHex } from "../src/pick.ts";

const LIGHTS: Light[] = [
	{ name: "escritorio", ip: "192.0.2.26", mac: "aabbccddee01" },
	{ name: "cocina", ip: "192.0.2.27", mac: "aabbccddeeff" },
];

type Level = "info" | "warning" | "error" | undefined;

function setup(opts: { configThrows?: boolean } = {}) {
	const calls: string[] = [];
	let failWith: Error | undefined;
	const act = (label: string, reply: string) => {
		calls.push(label);
		if (failWith) throw failWith;
		return reply;
	};
	const engine = {
		lights: (): Light[] => {
			calls.push("lights");
			if (opts.configThrows) throw new WizError("No lights configured.");
			return LIGHTS;
		},
		status: (name?: string) => act(`status:${name ?? ""}`, `STATUS ${name ?? "all"}`),
		on: (name?: string) => act(`on:${name ?? ""}`, `ON ${name ?? "all"}`),
		off: (name?: string) => act(`off:${name ?? ""}`, `OFF ${name ?? "all"}`),
		dim: (value: number, name?: string) => act(`dim:${value}:${name ?? ""}`, `DIM ${value}`),
		temp: (value: number, name?: string) => act(`temp:${value}:${name ?? ""}`, `TEMP ${value}`),
		color: (value: string, name?: string) => act(`color:${value}:${name ?? ""}`, `COLOR ${value}`),
		scene: (value: number, name?: string) => act(`scene:${value}:${name ?? ""}`, `SCENE ${value}`),
		discover: () => act("discover", "FOUND LIGHTS + JSON"),
	};

	const commands = new Map<string, { description: string; getArgumentCompletions: (prefix: string) => unknown; handler: (args: string, ctx: unknown) => Promise<void> }>();
	const pi = { registerCommand: (name: string, options: never) => commands.set(name, options), on: () => {} };
	createExtension({ wiz: engine as never })(pi as never);

	const notes: Array<[string, Level]> = [];
	const ctx = { ui: { notify: (m: string, l?: Level) => notes.push([m, l]) } };

	const run = async (args: string) => {
		const handler = commands.get("wiz")!.handler;
		await handler(args, ctx);
		await new Promise((r) => setImmediate(r));
	};

	return {
		calls,
		notes,
		commands,
		fail: (e: Error | undefined) => (failWith = e),
		run,
		complete: (prefix: string) => commands.get("wiz")!.getArgumentCompletions(prefix),
	};
}

// ------------------------------------------------- registration

test("S1: the extension registers exactly one command: wiz", () => {
	const h = setup();
	assert.deepEqual([...h.commands.keys()], ["wiz"]);
	assert.ok(h.commands.get("wiz").description.includes("/wiz"));
});

// ------------------------------------------------- parseWiz (pure, deterministic)

test("S1: parseWiz maps every fixed form", () => {
	assert.deepEqual(parseWiz("", ["escritorio"]), { kind: "status", name: undefined });
	assert.deepEqual(parseWiz("   ", ["escritorio"]), { kind: "status", name: undefined });
	assert.deepEqual(parseWiz("on", ["escritorio"]), { kind: "on", name: undefined });
	assert.deepEqual(parseWiz("OFF", ["escritorio"]), { kind: "off", name: undefined });
	assert.deepEqual(parseWiz("dim  40", ["escritorio"]), { kind: "dim", value: 40, name: undefined });
	assert.deepEqual(parseWiz("TEMP 3200", ["escritorio"]), { kind: "temp", value: 3200, name: undefined });
	assert.deepEqual(parseWiz("color #f80", ["escritorio"]), { kind: "color", value: "#f80", name: undefined });
	assert.deepEqual(parseWiz("scene 6", ["escritorio"]), { kind: "scene", value: 6, name: undefined });
	assert.deepEqual(parseWiz("status", ["escritorio"]), { kind: "status", name: undefined });
	assert.deepEqual(parseWiz("discover", ["escritorio"]), { kind: "discover" });
	assert.deepEqual(parseWiz("help", ["escritorio"]), { kind: "help" });
});

test("S1: parseWiz targets a named light, with a bare name showing its state", () => {
	assert.deepEqual(parseWiz("escritorio", ["escritorio", "cocina"]), { kind: "status", name: "escritorio" });
	assert.deepEqual(parseWiz("  ESCRITORIO  ", ["escritorio", "cocina"]), { kind: "status", name: "escritorio" });
	assert.deepEqual(parseWiz("Cocina ON", ["escritorio", "cocina"]), { kind: "on", name: "cocina" });
	assert.deepEqual(parseWiz("cocina  dim   40", ["escritorio", "cocina"]), { kind: "dim", value: 40, name: "cocina" });
	assert.deepEqual(parseWiz("cocina color #ffcc00", ["escritorio", "cocina"]), {
		kind: "color",
		value: "#ffcc00",
		name: "cocina",
	});
});

test("S1: parseWiz rejects unknown forms and malformed values, naming the valid range", () => {
	for (const [args, pattern] of [
		["bogus", /\/wiz dim <10-100>/],
		["dim", /whole number|needs a number/],
		["dim abc", /whole number|needs a number/],
		["dim 9", /10 to 100/],
		["dim 101", /10 to 100/],
		["temp 2199", /2200 to 6500/],
		["temp 6501", /2200 to 6500/],
		["scene 0", /1 to 32/],
		["scene 33", /1 to 32/],
		["color ff8800", /#rgb or #rrggbb/],
		["color #12345", /#rgb or #rrggbb/],
		["nope dim 40", /\/wiz dim <10-100>/],
		["escritorio bogus", /\/wiz <light>/],
		["escritorio discover", /takes no light name/],
	] as Array<[string, RegExp]>) {
		const action = parseWiz(args, ["escritorio"]);
		assert.equal(action.kind, "error", `parseWiz(${JSON.stringify(args)})`);
		if (action.kind === "error") assert.match(action.message, pattern, `parseWiz(${JSON.stringify(args)})`);
	}
});

test("S1: every parseWiz error shows the usage", () => {
	const action = parseWiz("bogus", []);
	assert.ok(action.kind === "error");
	assert.ok(action.message.includes("/wiz discover"));
	assert.ok(action.message.includes("/wiz dim <10-100>"));
});

// ------------------------------------------------- handler dispatch

test("S1: each form calls the right engine method", async () => {
	const h = setup();
	await h.run("on");
	await h.run("off");
	await h.run("dim 40");
	await h.run("temp 3200");
	await h.run("color #ffcc00");
	await h.run("scene 6");
	await h.run("status");
	await h.run("discover");
	await h.run("help");
	assert.deepEqual(
		h.calls.filter((c) => c !== "lights"),
		["on:", "off:", "dim:40:", "temp:3200:", "color:#ffcc00:", "scene:6:", "status:", "discover"],
	);
	assert.deepEqual(
		h.notes.map(([m]) => m),
		[
			"ON all",
			"OFF all",
			"DIM 40",
			"TEMP 3200",
			"COLOR #ffcc00",
			"SCENE 6",
			"STATUS all",
			"FOUND LIGHTS + JSON",
			USAGE,
		],
	);
	assert.ok(h.notes.every(([, l]) => l === "info"));
});

test("S1: a named form and a bare name reach the engine with the light", async () => {
	const h = setup();
	await h.run("Escritorio dim 40");
	await h.run("cocina");
	assert.deepEqual(h.calls.filter((c) => c !== "lights"), ["dim:40:escritorio", "status:cocina"]);
	assert.deepEqual(
		h.notes.map(([m]) => m),
		["DIM 40", "STATUS cocina"],
	);
});

test("a parse error is an error notify, shows the usage, and never reaches the engine", async () => {
	const h = setup();
	await h.run("bogus");
	assert.equal(h.notes.length, 1);
	assert.equal(h.notes[0][1], "error");
	assert.ok(h.notes[0][0].includes(USAGE));
	assert.deepEqual(h.calls.filter((c) => c !== "lights"), []);
});

test("an engine error becomes an error notify and never escapes the handler", async () => {
	const h = setup();
	h.fail(new WizError("no answer from escritorio (192.0.2.26)"));
	await h.run("on");
	assert.equal(h.notes.length, 1);
	assert.equal(h.notes[0][1], "error");
	assert.match(h.notes[0][0], /no answer from escritorio/);
});

test("a thrown non-Wiz error also becomes an error notify", async () => {
	const h = setup();
	h.fail(new Error("socket blew up"));
	await h.run("dim 40");
	assert.equal(h.notes[0][1], "error");
	assert.match(h.notes[0][0], /socket blew up/);
});

test("with no readable config, help and fixed forms still work", async () => {
	const h = setup({ configThrows: true });
	await h.run("help");
	assert.deepEqual(h.notes.at(-1), [USAGE, "info"]);
	await h.run("on");
	assert.deepEqual(h.calls.filter((c) => c !== "lights").slice(-1), ["on:"]);
});

test("discover reports through notify", async () => {
	const h = setup();
	await h.run("discover");
	assert.deepEqual(h.notes.at(-1), ["FOUND LIGHTS + JSON", "info"]);
});

// ------------------------------------------------- completions

test("S1: completions offer the fixed forms and the configured light names", () => {
	const h = setup();
	const values = (prefix: string) => h.complete(prefix)?.map((i: { value: string }) => i.value) ?? [];
	assert.ok(values("").includes("on"));
	assert.ok(values("").includes("discover"));
	assert.ok(values("").includes("escritorio"));
	assert.ok(values("").includes("cocina"));
	assert.deepEqual(values("dim"), ["dim"]);
	assert.deepEqual(values("ESC"), ["escritorio"]);
	assert.deepEqual(values("zzz"), []);
	assert.deepEqual(values("escritorio d"), ["escritorio dim"]);
	assert.deepEqual(values("escritorio zzz"), []);
});

// ------------------------------------------------- S9: /wiz pick (live colour editor)

const breathe = () => new Promise((r) => setImmediate(r));
/** Settles microtasks until `done()` reports true, bounded so a bug cannot hang the suite. */
async function until(done: () => boolean): Promise<void> {
	for (let i = 0; i < 50; i++) {
		if (done()) return;
		await breathe();
	}
	assert.ok(done(), "condition never became true");
}

const SCENE_SNAPSHOT: Snapshot = {
	light: LIGHTS[0],
	state: true,
	dimming: 100,
	sceneId: 6,
	temp: null,
	r: null,
	g: null,
	b: null,
};

interface PickHarness {
	readonly calls: string[];
	readonly notes: Array<[string, Level]>;
	readonly component: { handleInput(data: string): void; state: { hue: number; sat: number; dim: number }; hex(): string } | null;
	readonly openOptions: unknown;
	run(args: string): Promise<void>;
	readonly runPromise: Promise<void> | undefined;
	complete(prefix: string): unknown;
}

/** The pick-specific harness: wraps the original engine fake with snapshot/applyColor/restore and a real custom(). */
function pickSetup(
	opts: { snapshot?: Snapshot; customThrows?: boolean; noCustom?: boolean; restoreFails?: boolean; several?: boolean } = {},
): PickHarness {
	const calls: string[] = [];
	const engine = {
		lights: (): Light[] => {
			calls.push("lights");
			return opts.several ? LIGHTS : [LIGHTS[0]];
		},
		status: () => "STATUS",
		on: () => "ON",
		off: () => "OFF",
		dim: () => "DIM",
		temp: () => "TEMP",
		color: () => "COLOR",
		scene: () => "SCENE",
		discover: () => "DISCOVER",
		snapshot: (name?: string) => {
			calls.push(`snapshot:${name ?? ""}`);
			const snap = opts.snapshot ?? SCENE_SNAPSHOT;
			if (opts.several && name === undefined) {
				throw new WizError("Several lights are configured (escritorio, cocina). Name one, e.g. /wiz escritorio dim 40.");
			}
			return snap;
		},
		applyColor: (rgb: { r: number; g: number; b: number }, dimming: number, name?: string) => {
			calls.push(`applyColor:${rgb.r},${rgb.g},${rgb.b}:${dimming}:${name ?? ""}`);
			return "APPLIED";
		},
		restore: (snap: Snapshot) => {
			if (opts.restoreFails) throw new WizError(`no answer from ${snap.light.name} (${snap.light.ip})`);
			calls.push(`restore:${snap.light.name}`);
			return "RESTORED";
		},
	} as never;

	const commands = new Map<
		string,
		{ description: string; getArgumentCompletions: (prefix: string) => unknown; handler: (args: string, ctx: unknown) => Promise<void> }
	>();
	const pi = { registerCommand: (name: string, options: never) => commands.set(name, options), on: () => {} };
	createExtension({ wiz: engine })(pi as never);

	const notes: Array<[string, Level]> = [];
	let component: PickHarness["component"] = null;
	let openOptions: unknown = null;
	let lastRun: Promise<void> | undefined;
	const custom = opts.noCustom
		? undefined
		: (factory: (tui: unknown, theme: unknown, keybindings: unknown, done: (v: string | undefined) => void) => unknown, options: unknown) => {
				if (opts.customThrows) throw new Error("custom ui is not available here");
				openOptions = options;
				return new Promise<string | undefined>((resolve) => {
					component = factory({ requestRender() {} }, {}, {}, resolve) as PickHarness["component"];
				});
			};
	const ctx = { ui: { notify: (m: string, l?: Level) => notes.push([m, l]), custom } };
	const handler = commands.get("wiz")!.handler;

	return {
		calls,
		notes,
		get component() {
			return component;
		},
		get openOptions() {
			return openOptions;
		},
		get runPromise() {
			return lastRun;
		},
		run: (args: string) => {
			const p = (async () => {
				await handler(args, ctx);
				await breathe();
			})();
			lastRun = p;
			return p;
		},
		complete: (prefix: string) => commands.get("wiz")!.getArgumentCompletions(prefix),
	};
}

/**
 * Opens the overlay without closing it. The returned `finish()` resolves when
 * the test later closes the modal through its keys (Enter/Esc); never calling
 * it is fine for tests that only look at the opened editor.
 */
async function openPick(h: PickHarness, args = "pick"): Promise<() => Promise<void>> {
	void h.run(args);
	await until(() => h.component !== null);
	return () => h.runPromise ?? Promise.resolve();
}

test("S9: parseWiz accepts pick, alone and after a light name, but takes no value", () => {
	assert.deepEqual(parseWiz("pick", ["escritorio"]), { kind: "pick", name: undefined });
	assert.deepEqual(parseWiz("PICK", ["escritorio"]), { kind: "pick", name: undefined });
	assert.deepEqual(parseWiz("cocina pick", ["escritorio", "cocina"]), { kind: "pick", name: "cocina" });
	for (const args of ["pick 40", "escritorio pick now"]) {
		assert.equal(parseWiz(args, ["escritorio"]).kind, "error");
	}
});

test("S9: completions offer pick and the usage mentions it", () => {
	const h = pickSetup();
	const values = (prefix: string) => (h.complete(prefix) as Array<{ value: string }> | null)?.map((i) => i.value) ?? [];
	assert.ok(values("").includes("pick"));
	assert.deepEqual(values("escritorio pic"), ["escritorio pick"]);
	assert.ok(USAGE.includes("pick"));
});

test("S9: pick reads the snapshot first and opening the modal sends only getPilot", async () => {
	const h = pickSetup();
	await openPick(h);
	assert.deepEqual(h.calls.filter((c) => c !== "lights"), ["snapshot:"], "nothing beyond the snapshot read");
	assert.ok(h.component, "the overlay opened");
});

test("S9: the overlay opens centered, 62 wide, with the blocked question", async () => {
	const h = pickSetup();
	await openPick(h);
	assert.deepEqual(h.openOptions, {
		overlay: true,
		overlayOptions: { anchor: "center", width: 62, maxHeight: 20 },
		blocked: { kind: "question", message: "Pick a color" },
	});
});

test("S9: the editor starts from the light's current state (scene 6 at 100% -> dim 100)", async () => {
	const h = pickSetup();
	await openPick(h);
	assert.deepEqual(h.component!.state, { hue: 210, sat: 85, dim: 100 });
});

test("S9: a change sends applyColor with the pure colour and the light's dimming", async () => {
	const h = pickSetup();
	await openPick(h);
	h.component!.handleInput("\x1b[C"); // hue +10
	const applied = h.calls.filter((c) => c.startsWith("applyColor:"));
	assert.equal(applied.length, 1);
	const expected = hsvToRgb(220, 85 / 100, 1);
	assert.ok(
		applied[0].startsWith(`applyColor:${expected[0]},${expected[1]},${expected[2]}:100:`),
		`pure colour at hue 220 with the light's dimming: ${applied[0]}`,
	);
});

test("S9: Enter without any change says so and sends nothing", async () => {
	const h = pickSetup();
	const finish = await openPick(h);
	h.component!.handleInput("\r"); // no changes: nothing pending, so nothing is sent
	await finish();
	assert.equal(h.calls.filter((c) => c.startsWith("applyColor:")).length, 0, "opening alone never sent a colour");
	assert.deepEqual(h.notes.map(([m]) => m), ["No changes on escritorio"], "it must not claim a colour was applied");
	assert.ok(h.notes.every(([, l]) => l === "info"));
});

test("S9: a change then Enter flushes the last value before notifying", async () => {
	const h = pickSetup();
	const finish = await openPick(h);
	h.component!.handleInput("\x1b[C"); // one change: leading send
	h.component!.handleInput("\r"); // Enter while that send is in flight
	await finish();
	assert.deepEqual(h.notes.map(([m]) => m), [`Color ${pickHex({ hue: 220, sat: 85, dim: 100 })}, dimming 100% on escritorio`]);
	assert.equal(h.calls.filter((c) => c.startsWith("applyColor:")).length, 1, "exactly one live send; the change WAS it");
});

test("S9: Esc cancels and restores the exact snapshot (scene 6 at 100%)", async () => {
	const h = pickSetup();
	const finish = await openPick(h);
	h.component!.handleInput("\x1b[C"); // one change
	h.component!.handleInput("\x1b"); // Esc: cancel, then restore
	await finish();
	assert.deepEqual(h.calls.filter((c) => c.startsWith("applyColor:")).length, 1, "the live change itself was sent");
	assert.deepEqual(h.calls.filter((c) => c.startsWith("restore:")), ["restore:escritorio"]);
	// The restore itself is asserted in wiz.test.ts; here the caller wired it.
	assert.deepEqual(
		h.notes.map(([m]) => m),
		["Restored escritorio to how it was"],
	);
	assert.ok(h.notes.every(([, l]) => l === "info"));
});

test("S9: a light that was off is turned on by the first change and off again by Esc", async () => {
	const h = pickSetup({ snapshot: { ...SCENE_SNAPSHOT, state: false } });
	const finish = await openPick(h);
	assert.deepEqual(h.component!.state, { hue: 210, sat: 85, dim: 100 });
	h.component!.handleInput("\x1b[C"); // first change: turns the light on
	await breathe();
	assert.ok(h.calls.some((c) => c.startsWith("applyColor:")), "the change was applied (the light turned on)");
	h.component!.handleInput("\x1b");
	await finish();
	assert.ok(h.calls.some((c) => c.startsWith("restore:")), "Esc restored");
	assert.match(h.notes.map(([m]) => m)[0], /Restored escritorio/);
});

test("S9: several lights and no name is an error with nothing sent and no overlay", async () => {
	const h = pickSetup({ several: true });
	await h.run("pick"); // the engine's target() throws before any send
	assert.equal(h.component, null, "no overlay without a target");
	assert.deepEqual(
		h.notes.map(([, l]) => l),
		["error"],
	);
	assert.match(h.notes[0][0], /Several lights are configured \(escritorio, cocina\)/);
	assert.deepEqual(h.calls.filter((c) => c.startsWith("applyColor:")), []);
});

test("S9: ctx.ui.custom throwing before opening notifies an error and sends nothing", async () => {
	const h = pickSetup({ customThrows: true });
	await h.run("pick");
	assert.equal(h.notes[0][1], "error");
	assert.deepEqual(h.calls.filter((c) => c !== "lights" && !c.startsWith("snapshot")), [], "the light was not touched");
});

test("S9: without ctx.ui.custom at all, an error is notified and nothing is sent", async () => {
	const h = pickSetup({ noCustom: true });
	await h.run("pick");
	assert.equal(h.notes[0][1], "error");
	assert.deepEqual(h.calls.filter((c) => c !== "lights" && !c.startsWith("snapshot")), []);
});

test("S9: a failing restore is an error notify that names the light and the snapshot", async () => {
	const h = pickSetup({ restoreFails: true });
	const finish = await openPick(h);
	h.component!.handleInput("\x1b[C"); // a real change, so there is something to restore
	h.component!.handleInput("\x1b");
	await finish();
	const [msg, level] = h.notes[0];
	assert.equal(level, "error");
	assert.match(msg, /escritorio/);
	assert.match(msg, /scene 6/, "says what the snapshot was, so the user can fix it by hand");
});
