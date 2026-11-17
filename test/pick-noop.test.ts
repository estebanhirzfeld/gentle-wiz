import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createExtension } from "../src/extension.ts";
import { createWiz } from "../src/wiz.ts";

const tick = () => new Promise((r) => setTimeout(r, 5));

/** A fake light in scene 6 at 100%, and the real extension on top of it. Nothing touches a network. */
function rig() {
	const dir = mkdtempSync(join(tmpdir(), "wiz-noop-"));
	writeFileSync(join(dir, "lights.json"), JSON.stringify({ lights: [{ name: "escritorio", ip: "203.0.113.9", mac: "aabbccddee01" }] }));
	const sent: Array<{ method: string; params: Record<string, unknown> }> = [];
	const send = async (json: { method: string; params: Record<string, unknown> }) => {
		sent.push({ method: json.method, params: json.params });
		return json.method === "getPilot"
			? { method: "getPilot", result: { mac: "aabbccddee01", state: true, dimming: 100, sceneId: 6 } }
			: { method: "setPilot", result: { success: true } };
	};
	const wiz = createWiz({ configDir: dir, send, broadcast: async () => [] });
	const commands = new Map<string, { handler: (a: string, c: unknown) => Promise<void> }>();
	createExtension({ configDir: dir, wiz })({ registerCommand: (n: string, o: never) => commands.set(n, o), on() {} } as never);
	const notes: Array<[string, string]> = [];
	let comp: { handleInput: (d: string) => void } | undefined;
	const ctx = {
		ui: {
			notify: (m: string, l?: string) => notes.push([l ?? "info", m]),
			setStatus() {},
			custom: (factory: (...a: unknown[]) => unknown) =>
				new Promise((resolve) => {
					comp = factory({ requestRender() {} }, {}, {}, resolve) as typeof comp;
				}),
		},
	};
	const open = async () => {
		const running = commands.get("wiz")!.handler("pick", ctx);
		while (!comp) await tick();
		return running;
	};
	const writes = () => sent.filter((s) => s.method === "setPilot");
	return { open, writes, notes, press: (k: string) => comp!.handleInput(k), sent };
}

test("Esc without moving anything writes nothing to the light", async () => {
	const r = rig();
	const running = r.open();
	await tick();
	r.press("\x1b");
	await running;
	assert.equal(r.writes().length, 0, "no restore when nothing changed");
	assert.match(r.notes.at(-1)![1], /No changes/);
	assert.equal(r.notes.at(-1)![0], "info");
});

test("Enter without moving anything does not claim a colour was applied", async () => {
	const r = rig();
	const running = r.open();
	await tick();
	r.press("\r");
	await running;
	assert.equal(r.writes().length, 0);
	assert.match(r.notes.at(-1)![1], /No changes/);
	assert.ok(!/Color #/.test(r.notes.at(-1)![1]));
});

test("after a real change, Esc still restores the exact snapshot", async () => {
	const r = rig();
	const running = r.open();
	await tick();
	r.press("\x1b[C"); // one change
	await tick();
	r.press("\x1b");
	await running;
	assert.deepEqual(r.writes().at(-1)!.params, { state: true, dimming: 100, sceneId: 6 });
	assert.match(r.notes.at(-1)![1], /Restored escritorio/);
});
