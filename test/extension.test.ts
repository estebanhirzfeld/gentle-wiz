import { test } from "node:test";
import assert from "node:assert/strict";
import { createExtension, parseWiz, USAGE, type WizAction } from "../src/extension.ts";
import { WizError, type Light } from "../src/wiz.ts";

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
