import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createExtension, parseWiz } from "../src/extension.ts";
import { createWiz } from "../src/wiz.ts";
import { COLORS, SCENES, normalize, resolveColor, resolveScene, resolveTemp } from "../src/names.ts";

const L = ["foco"];
const parse = (s: string, lights = L) => parseWiz(s, lights);

// ------------------------------------------------------------------------------------------ names
test("normalize ignores case, accents, hyphens and extra spaces", () => {
	assert.equal(normalize("  Cálido   FRÍO "), "calido frio");
	assert.equal(normalize("Wake-up"), "wake up");
});

test("colours resolve by Spanish or English name", () => {
	assert.equal(resolveColor("azul"), "#3b82f6");
	assert.equal(resolveColor("BLUE"), "#3b82f6");
	assert.equal(resolveColor("Celeste"), "#00bfff");
	assert.equal(resolveColor("sky blue"), "#00bfff");
	assert.equal(resolveColor("banana"), undefined);
});

test("white temperatures resolve by name", () => {
	assert.equal(resolveTemp("calido"), 2700);
	assert.equal(resolveTemp("Cálido"), 2700);
	assert.equal(resolveTemp("neutro"), 4000);
	assert.equal(resolveTemp("frío"), 6500);
	assert.equal(resolveTemp("blanco"), 4000);
	assert.equal(resolveTemp("warm"), 2700);
	assert.equal(resolveTemp("vela"), 2200);
	assert.equal(resolveTemp("xyz"), undefined);
});

test("scenes resolve by WiZ name or a Spanish alias (ids as published by pywizlight)", () => {
	assert.equal(resolveScene("cozy"), 6);
	assert.equal(resolveScene("Cool white"), 13);
	assert.equal(resolveScene("wake-up"), 9);
	assert.equal(resolveScene("acogedor"), 6);
	assert.equal(resolveScene("atardecer"), 3);
	assert.equal(resolveScene("6"), undefined, "numbers are not names");
});

test("the name tables are sound", () => {
	assert.equal(SCENES.length, 32);
	assert.deepEqual(SCENES.map(([id]) => id).sort((a, b) => a - b), Array.from({ length: 32 }, (_, i) => i + 1));
	for (const [, hex] of Object.values(COLORS)) assert.match(hex, /^#[0-9a-f]{6}$/);
	// No word may mean two things, or `/wiz <word>` would be ambiguous.
	const words = new Map<string, string>();
	const claim = (word: string, kind: string) => {
		assert.ok(!words.has(word) || words.get(word) === kind, `"${word}" is both ${words.get(word)} and ${kind}`);
		words.set(word, kind);
	};
	for (const w of ["on", "off", "toggle", "status", "dim", "temp", "color", "scene", "pick", "discover", "help", "prender", "apagar", "alternar", "estado", "brillo", "escena", "ayuda", "buscar", "elegir"]) claim(w, "verb");
	for (const name of Object.keys(COLORS)) claim(normalize(name), "color");
	for (const name of ["calido", "neutro", "frio", "blanco", "warm", "neutral", "cool", "white", "vela", "candle"]) claim(name, "temp");
	for (const [, name] of SCENES) claim(normalize(name), "scene");
});

// ------------------------------------------------------------------------------------------ parser
test("a bare number is the brightness", () => {
	assert.deepEqual(parse("40"), { kind: "dim", value: 40, name: undefined });
	assert.deepEqual(parse("40%"), { kind: "dim", value: 40, name: undefined });
	assert.deepEqual(parse("foco 40"), { kind: "dim", value: 40, name: "foco" });
	assert.equal(parse("5").kind, "error");
	assert.match((parse("150%") as { message: string }).message, /dim must be from 10 to 100/);
});

test("+/- change the brightness relative to now", () => {
	assert.deepEqual(parse("+10"), { kind: "dimBy", delta: 10, name: undefined });
	assert.deepEqual(parse("-20"), { kind: "dimBy", delta: -20, name: undefined });
	assert.deepEqual(parse("+"), { kind: "dimBy", delta: 10, name: undefined });
	assert.deepEqual(parse("-"), { kind: "dimBy", delta: -10, name: undefined });
	assert.deepEqual(parse("dim +5"), { kind: "dimBy", delta: 5, name: undefined });
	assert.deepEqual(parse("brillo 40"), { kind: "dim", value: 40, name: undefined });
});

test("colour names work bare, after color, and with a light", () => {
	assert.deepEqual(parse("azul"), { kind: "color", value: "#3b82f6", name: undefined });
	assert.deepEqual(parse("color azul"), { kind: "color", value: "#3b82f6", name: undefined });
	assert.deepEqual(parse("foco rojo"), { kind: "color", value: "#ff0000", name: "foco" });
	assert.deepEqual(parse("BLUE"), { kind: "color", value: "#3b82f6", name: undefined });
	assert.deepEqual(parse("color #ff00aa"), { kind: "color", value: "#ff00aa", name: undefined });
});

test("white names set the temperature", () => {
	assert.deepEqual(parse("calido"), { kind: "temp", value: 2700, name: undefined });
	assert.deepEqual(parse("temp frio"), { kind: "temp", value: 6500, name: undefined });
	assert.deepEqual(parse("blanco"), { kind: "temp", value: 4000, name: undefined });
	assert.deepEqual(parse("temp 3200"), { kind: "temp", value: 3200, name: undefined });
});

test("scene names work bare and after scene/escena", () => {
	assert.deepEqual(parse("cozy"), { kind: "scene", value: 6, name: undefined });
	assert.deepEqual(parse("scene cozy"), { kind: "scene", value: 6, name: undefined });
	assert.deepEqual(parse("escena acogedor"), { kind: "scene", value: 6, name: undefined });
	assert.deepEqual(parse("cool white"), { kind: "scene", value: 13, name: undefined });
	assert.deepEqual(parse("scene 6"), { kind: "scene", value: 6, name: undefined });
});

test("a bare category opens a menu", () => {
	for (const category of ["color", "dim", "temp", "scene"] as const) {
		assert.deepEqual(parse(category), { kind: "menu", of: category, name: undefined });
		assert.deepEqual(parse(`foco ${category}`), { kind: "menu", of: category, name: "foco" });
	}
	assert.deepEqual(parse("brillo"), { kind: "menu", of: "dim", name: undefined });
});

test("Spanish verbs work like the English ones", () => {
	assert.deepEqual(parse("prender"), { kind: "on", name: undefined });
	assert.deepEqual(parse("apaga"), { kind: "off", name: undefined });
	assert.deepEqual(parse("foco apagar"), { kind: "off", name: "foco" });
	assert.deepEqual(parse("alternar"), { kind: "toggle", name: undefined });
	assert.deepEqual(parse("toggle"), { kind: "toggle", name: undefined });
	assert.deepEqual(parse("foco toggle"), { kind: "toggle", name: "foco" });
	assert.deepEqual(parse("estado"), { kind: "status", name: undefined });
	assert.deepEqual(parse("ayuda"), { kind: "help" });
	assert.deepEqual(parse("buscar"), { kind: "discover" });
	assert.deepEqual(parse("elegir"), { kind: "pick", name: undefined });
});

test("a light named like a colour wins over the colour", () => {
	assert.deepEqual(parse("azul", ["azul"]), { kind: "status", name: "azul" });
	assert.deepEqual(parse("azul azul", ["azul"]), { kind: "color", value: "#3b82f6", name: "azul" });
});

test("things that make no sense are still rejected, with the usage", () => {
	for (const bad of ["banana", "dim abc", "color nada", "scene 99", "temp 100", "pick 40"]) {
		const action = parse(bad);
		assert.equal(action.kind, "error", bad);
		assert.match((action as { message: string }).message, /\/wiz/);
	}
});

// ------------------------------------------------------------------------------------------ handler
function rig(initial: Record<string, unknown> = { state: true, dimming: 40, sceneId: 6 }, choose?: (options: string[]) => string | undefined) {
	const dir = mkdtempSync(join(tmpdir(), "wiz-ergo-"));
	writeFileSync(join(dir, "lights.json"), JSON.stringify({ lights: [{ name: "foco", ip: "203.0.113.9", mac: "aabbccddee01" }] }));
	const bulb: Record<string, unknown> = { ...initial };
	const writes: Array<Record<string, unknown>> = [];
	const send = async (json: { method: string; params: Record<string, unknown> }) => {
		if (json.method === "getPilot") return { method: "getPilot", result: { mac: "aabbccddee01", ...bulb } };
		writes.push(json.params);
		Object.assign(bulb, json.params);
		return { method: "setPilot", result: { success: true } };
	};
	const wiz = createWiz({ configDir: dir, send, broadcast: async () => [] });
	const commands = new Map<string, { handler: (a: string, c: unknown) => Promise<void>; getArgumentCompletions: (p: string) => Array<{ value: string }> | null }>();
	createExtension({ configDir: dir, wiz })({ registerCommand: (n: string, o: never) => commands.set(n, o), on() {} } as never);
	const notes: Array<[string, string]> = [];
	const menus: Array<{ title: string; options: string[] }> = [];
	const ui: Record<string, unknown> = { notify: (m: string, l?: string) => notes.push([l ?? "info", m]), setStatus() {} };
	if (choose) ui.select = async (title: string, options: string[]) => (menus.push({ title, options }), choose(options));
	const run = (args: string) => commands.get("wiz")!.handler(args, { ui });
	return { run, bulb, writes, notes, menus, commands, withoutSelect: () => delete ui.select };
}

test("handler: /wiz 40, /wiz azul and /wiz calido write what they mean", async () => {
	const r = rig();
	await r.run("40");
	assert.equal(r.bulb.dimming, 40);
	await r.run("azul");
	assert.deepEqual([r.bulb.r, r.bulb.g, r.bulb.b], [59, 130, 246]);
	await r.run("calido");
	assert.equal(r.bulb.temp, 2700);
	await r.run("cozy");
	assert.equal(r.bulb.sceneId, 6);
});

test("handler: +10 and -10 are relative and clamp to 10..100", async () => {
	const r = rig({ state: true, dimming: 40 });
	await r.run("+10");
	assert.equal(r.bulb.dimming, 50);
	await r.run("-");
	assert.equal(r.bulb.dimming, 40);
	await r.run("+100");
	assert.equal(r.bulb.dimming, 100, "clamped to the top");
	await r.run("-500");
	assert.equal(r.bulb.dimming, 10, "clamped to the bottom");
	assert.ok(r.notes.every(([l]) => l === "info"));
});

test("handler: toggle turns an on light off and an off light on", async () => {
	const r = rig({ state: true, dimming: 40 });
	await r.run("toggle");
	assert.equal(r.bulb.state, false);
	await r.run("alternar");
	assert.equal(r.bulb.state, true);
});

test("handler: /wiz color opens a menu with swatches and applies the choice", async () => {
	const r = rig(undefined, (options) => options.find((o) => /violeta/i.test(o)));
	await r.run("color");
	assert.match(r.menus[0].title, /[Cc]olor/);
	assert.ok(r.menus[0].options.some((o) => /rojo/i.test(o) && o.includes("#ff0000")));
	assert.ok(r.menus[0].options.every((o) => o.includes("\x1b[48;2;")), "every colour shows a swatch");
	assert.deepEqual([r.bulb.r, r.bulb.g, r.bulb.b], [138, 43, 226]);
});

test("handler: /wiz dim, temp and scene menus apply the choice", async () => {
	const r = rig(undefined, (options) => options.find((o) => /50%|Neutro|Cozy/.test(o)));
	await r.run("dim");
	assert.equal(r.bulb.dimming, 50);
	await r.run("temp");
	assert.equal(r.bulb.temp, 4000);
	await r.run("scene");
	assert.equal(r.bulb.sceneId, 6);
	assert.equal(r.menus[2].options.length, 32, "every scene is offered");
});

test("handler: cancelling a menu writes nothing and says so", async () => {
	const r = rig(undefined, () => undefined);
	await r.run("color");
	assert.equal(r.writes.length, 0);
	assert.match(r.notes.at(-1)![1], /Cancelled/);
	assert.equal(r.notes.at(-1)![0], "info");
});

test("handler: without a menu UI the bare form explains how to pass a value", async () => {
	const r = rig();
	await r.run("color");
	assert.equal(r.writes.length, 0);
	assert.equal(r.notes.at(-1)![0], "error");
	assert.match(r.notes.at(-1)![1], /\/wiz color azul/);
});

// ------------------------------------------------------------------------------------------ completions
test("completions offer forms, names and lights, ignoring accents", () => {
	const r = rig();
	const complete = r.commands.get("wiz")!.getArgumentCompletions;
	const values = (p: string) => (complete(p) ?? []).map((i) => i.value);
	assert.ok(values("").includes("toggle"));
	assert.ok(values("").includes("foco"));
	assert.ok(values("az").includes("azul"));
	assert.ok(values("ca").includes("calido"));
	assert.ok(values("co").includes("cozy"));
	assert.ok(values("foco az").includes("foco azul"));
	assert.equal(complete("zzzz"), null);
});
