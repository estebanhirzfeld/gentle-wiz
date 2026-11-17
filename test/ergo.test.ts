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
const isError = (s: string, lights = L) => parse(s, lights).kind === "error";

// ------------------------------------------------------------------------------------------ names
test("normalize ignores case, accents, hyphens between letters and extra spaces, but keeps a sign", () => {
	assert.equal(normalize("  Cálido   FRÍO "), "calido frio");
	assert.equal(normalize("Wake-up"), "wake up");
	assert.equal(normalize("-10"), "-10");
});

test("each thing has exactly one name", () => {
	assert.equal(resolveColor("azul"), "#3b82f6");
	assert.equal(resolveColor("Celeste"), "#00bfff");
	for (const english of ["blue", "red", "teal", "sky blue", "purple", "pink"]) assert.equal(resolveColor(english), undefined, english);
	assert.equal(resolveTemp("calido"), 2700);
	assert.equal(resolveTemp("Frío"), 6500);
	assert.equal(resolveTemp("neutro"), 4000);
	assert.equal(resolveTemp("vela"), 2200);
	for (const alias of ["blanco", "warm", "cool", "white", "neutral", "candle"]) assert.equal(resolveTemp(alias), undefined, alias);
	assert.equal(resolveScene("cozy"), 6);
	assert.equal(resolveScene("Cool white"), 13);
	assert.equal(resolveScene("wake-up"), 9);
	for (const alias of ["acogedor", "atardecer", "fiesta"]) assert.equal(resolveScene(alias), undefined, alias);
});

test("the name tables are sound and no word means two things", () => {
	assert.equal(SCENES.length, 32);
	assert.deepEqual(SCENES.map(([id]) => id).sort((a, b) => a - b), Array.from({ length: 32 }, (_, i) => i + 1));
	for (const [, hex] of Object.values(COLORS)) assert.match(hex, /^#[0-9a-f]{6}$/);
	const words = new Map<string, string>();
	const claim = (word: string, kind: string) => {
		assert.ok(!words.has(word), `"${word}" is both ${words.get(word)} and ${kind}`);
		words.set(word, kind);
	};
	for (const w of ["on", "off", "toggle", "status", "pick", "discover", "help"]) claim(w, "form");
	for (const name of Object.keys(COLORS)) claim(normalize(name), "color");
	for (const name of ["vela", "calido", "neutro", "frio"]) claim(name, "white");
	for (const [, name] of SCENES) claim(normalize(name), "scene");
});

// ------------------------------------------------------------------------------------------ parser
test("/wiz alone opens the menu, for the light if one is named", () => {
	assert.deepEqual(parse(""), { kind: "menu", name: undefined });
	assert.deepEqual(parse("   "), { kind: "menu", name: undefined });
	assert.deepEqual(parse("foco"), { kind: "menu", name: "foco" });
});

test("the fixed forms are on, off, toggle, status, pick, discover, help", () => {
	for (const f of ["on", "off", "toggle", "status", "pick"] as const) {
		assert.deepEqual(parse(f), { kind: f, name: undefined });
		assert.deepEqual(parse(`foco ${f}`), { kind: f, name: "foco" });
	}
	assert.deepEqual(parse("discover"), { kind: "discover" });
	assert.deepEqual(parse("HELP"), { kind: "help" });
});

test("a number is the brightness and +/- are relative", () => {
	assert.deepEqual(parse("40"), { kind: "dim", value: 40, name: undefined });
	assert.deepEqual(parse("foco 40"), { kind: "dim", value: 40, name: "foco" });
	assert.deepEqual(parse("+10"), { kind: "dimBy", delta: 10, name: undefined });
	assert.deepEqual(parse("-20"), { kind: "dimBy", delta: -20, name: undefined });
	assert.deepEqual(parse("+"), { kind: "dimBy", delta: 10, name: undefined });
	assert.deepEqual(parse("-"), { kind: "dimBy", delta: -10, name: undefined });
	assert.ok(isError("5"));
	assert.match((parse("150") as { message: string }).message, /dim must be from 10 to 100/);
});

test("exact white is Nk", () => {
	assert.deepEqual(parse("3200k"), { kind: "temp", value: 3200, name: undefined });
	assert.deepEqual(parse("3200K"), { kind: "temp", value: 3200, name: undefined });
	assert.match((parse("100k") as { message: string }).message, /2200 to 6500/);
	assert.match((parse("7000k") as { message: string }).message, /2200 to 6500/);
});

test("colours, whites and scenes are bare names", () => {
	assert.deepEqual(parse("azul"), { kind: "color", value: "#3b82f6", name: undefined });
	assert.deepEqual(parse("foco rojo"), { kind: "color", value: "#ff0000", name: "foco" });
	assert.deepEqual(parse("#ff00aa"), { kind: "color", value: "#ff00aa", name: undefined });
	assert.deepEqual(parse("#fc0"), { kind: "color", value: "#fc0", name: undefined });
	assert.deepEqual(parse("calido"), { kind: "temp", value: 2700, name: undefined });
	assert.deepEqual(parse("cozy"), { kind: "scene", value: 6, name: undefined });
	assert.deepEqual(parse("cool white"), { kind: "scene", value: 13, name: undefined });
	assert.deepEqual(parse("foco wake-up"), { kind: "scene", value: 9, name: "foco" });
});

test("the duplicate forms are gone", () => {
	const gone = [
		"prender", "apagar", "alternar", "estado", "ayuda", "buscar", "elegir", "brillo 40", "intensidad 40", "escena cozy",
		"dim 40", "dim +5", "dim", "temp 3200", "temp frio", "temp", "color azul", "color #ff00aa", "color", "scene 6", "scene cozy", "scene",
		"40%", "blue", "blanco", "acogedor", "encender", "enciende", "apaga",
	];
	for (const g of gone) assert.ok(isError(g), `"${g}" must no longer be accepted`);
});

test("forms take no value, and a light named like a colour wins", () => {
	for (const bad of ["on foo", "off 40", "toggle azul", "status x", "pick 40"]) assert.ok(isError(bad), bad);
	assert.match((parse("pick 40") as { message: string }).message, /pick takes no value/);
	assert.deepEqual(parse("azul", ["azul"]), { kind: "menu", name: "azul" });
	assert.deepEqual(parse("azul azul", ["azul"]), { kind: "color", value: "#3b82f6", name: "azul" });
});

test("anything else is rejected with the usage", () => {
	for (const bad of ["banana", "scene 99", "foco foco", "azul rojo"]) {
		const action = parse(bad);
		assert.equal(action.kind, "error", bad);
		assert.match((action as { message: string }).message, /\/wiz/);
	}
	assert.match((parse("discover", L) as { kind: string }).kind, /discover/);
	assert.match((parse("foco discover") as { message: string }).message, /takes no light name/);
});

// ------------------------------------------------------------------------------------------ handler
function rig(initial: Record<string, unknown> = { state: true, dimming: 40, sceneId: 6 }, choose?: (options: string[], call: number) => string | undefined) {
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
	if (choose) ui.select = async (title: string, options: string[]) => (menus.push({ title, options }), choose(options, menus.length - 1));
	const run = (args: string) => commands.get("wiz")!.handler(args, { ui });
	return { run, bulb, writes, notes, menus, commands };
}

/** A chooser that picks, in order, the first option matching each pattern. */
const picks = (...patterns: RegExp[]) => (options: string[], call: number) => options.find((o) => patterns[call]?.test(o));

test("handler: the shortcuts write what they mean", async () => {
	const r = rig();
	await r.run("40");
	assert.equal(r.bulb.dimming, 40);
	await r.run("azul");
	assert.deepEqual([r.bulb.r, r.bulb.g, r.bulb.b], [59, 130, 246]);
	await r.run("calido");
	assert.equal(r.bulb.temp, 2700);
	await r.run("3200k");
	assert.equal(r.bulb.temp, 3200);
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
	assert.equal(r.bulb.dimming, 100);
	await r.run("-500");
	assert.equal(r.bulb.dimming, 10);
});

test("handler: toggle turns an on light off and an off light on", async () => {
	const r = rig({ state: true, dimming: 40 });
	await r.run("toggle");
	assert.equal(r.bulb.state, false);
	await r.run("toggle");
	assert.equal(r.bulb.state, true);
});

test("handler: /wiz alone lists every action with how to type it, and runs what you pick", async () => {
	const r = rig({ state: true, dimming: 40 }, picks(/^Off /));
	await r.run("");
	assert.equal(r.menus.length, 1);
	const labels = r.menus[0].options;
	for (const typed of ["/wiz status", "/wiz on", "/wiz off", "/wiz toggle", "/wiz 40", "/wiz azul", "/wiz calido", "/wiz cozy", "/wiz pick", "/wiz discover", "/wiz help"]) {
		assert.ok(labels.some((l) => l.includes(typed)), `the menu shows ${typed}`);
	}
	assert.equal(new Set(labels).size, labels.length, "no duplicated entries");
	assert.equal(r.bulb.state, false, "Off ran");
});

test("handler: the menu's Color, Brightness, White and Scene open a second list", async () => {
	const r = rig(undefined, picks(/^Color/, /violeta/i, /^Brightness/, /50%/, /^White/, /Neutro/, /^Scene/, /Cozy/));
	await r.run("");
	assert.ok(r.menus[1].options.every((o) => o.includes("\x1b[48;2;")), "every colour shows a swatch");
	assert.deepEqual([r.bulb.r, r.bulb.g, r.bulb.b], [138, 43, 226]);
	await r.run("");
	assert.equal(r.bulb.dimming, 50);
	await r.run("");
	assert.equal(r.bulb.temp, 4000);
	await r.run("");
	assert.equal(r.bulb.sceneId, 6);
	assert.equal(r.menus[7].options.length, 32, "every scene is offered");
});

test("handler: cancelling at either level writes nothing and says so", async () => {
	const first = rig(undefined, () => undefined);
	await first.run("");
	assert.equal(first.writes.length, 0);
	assert.match(first.notes.at(-1)![1], /Cancelled/);
	const second = rig(undefined, (options, call) => (call === 0 ? options.find((o) => /^Color/.test(o)) : undefined));
	await second.run("");
	assert.equal(second.writes.length, 0);
	assert.match(second.notes.at(-1)![1], /Cancelled/);
	assert.equal(second.notes.at(-1)![0], "info");
});

test("handler: without a menu UI, /wiz alone points at /wiz help and writes nothing", async () => {
	const r = rig();
	await r.run("");
	assert.equal(r.writes.length, 0);
	assert.equal(r.notes.at(-1)![0], "error");
	assert.match(r.notes.at(-1)![1], /\/wiz help/);
});

// ------------------------------------------------------------------------------------------ completions
test("completions offer forms, names and lights, ignoring accents", () => {
	const r = rig();
	const complete = r.commands.get("wiz")!.getArgumentCompletions;
	const values = (p: string) => (complete(p) ?? []).map((i) => i.value);
	assert.deepEqual(values(""), ["on", "off", "toggle", "status", "pick", "discover", "help", "foco"]);
	assert.ok(values("az").includes("azul"));
	assert.ok(values("ca").includes("calido"));
	assert.ok(values("co").includes("cozy"));
	assert.ok(values("foco az").includes("foco azul"));
	assert.equal(complete("zzzz"), null);
	assert.equal(new Set(values("")).size, values("").length, "no duplicates in the list");
});
