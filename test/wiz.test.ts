import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWiz, WizError, type Pilot } from "../src/wiz.ts";

type FakeLight = { name: string; ip: string; mac: string };

const ESCRITORIO: FakeLight = { name: "escritorio", ip: "192.0.2.26", mac: "aabbccddee01" };
const COCINA: FakeLight = { name: "cocina", ip: "192.0.2.27", mac: "aabbccddeeff" };

interface SetupOptions {
	lights?: FakeLight[];
	/** Raw lights.json contents; overrides `lights` (use for a corrupt file). */
	rawConfig?: string;
	/** Skip writing lights.json at all (missing config). */
	noConfig?: boolean;
	/** Initial state of the fake device (single shared pilot). */
	pilot?: Partial<Pilot>;
	/** First N unicast send attempts throw (UDP datagram lost). */
	failFirst?: number;
	/** Every unicast send attempt throws. */
	failAll?: boolean;
	/** The next unicast attempt answers with this (error / success:false replies). */
	replies?: object[];
	/** setPilot answers success:false. */
	writeFails?: boolean;
	broadcastAnswers?: Array<{ ip: string; reply: object }>;
}

function setup(opts: SetupOptions = {}) {
	const dir = mkdtempSync(join(tmpdir(), "gentle-wiz-"));
	const lights = opts.lights ?? [ESCRITORIO];
	if (opts.rawConfig !== undefined) writeFileSync(join(dir, "lights.json"), opts.rawConfig);
	else if (!opts.noConfig) writeFileSync(join(dir, "lights.json"), JSON.stringify({ lights }));

	const sent: Array<{ json: Record<string, unknown>; ip: string }> = [];
	const broadcasts: object[] = [];
	const pilot: Record<string, unknown> = {
		mac: lights[0]?.mac ?? null,
		state: true,
		dimming: 100,
		sceneId: 6,
		temp: null,
		r: null,
		g: null,
		b: null,
		...opts.pilot,
	};
	let failsLeft = opts.failFirst ?? 0;
	let replies = [...(opts.replies ?? [])];

	const send = async (json: Record<string, unknown>, ip: string) => {
		sent.push({ json, ip });
		if (opts.failAll) throw new Error("udp timeout");
		if (failsLeft > 0) {
			failsLeft--;
			throw new Error("udp timeout");
		}
		if (replies.length > 0) return replies.shift();
		if (json.method === "setPilot") {
			const params = (json.params ?? {}) as Record<string, unknown>;
			for (const key of ["state", "dimming", "temp", "r", "g", "b", "sceneId"]) {
				if (key in params) pilot[key] = params[key];
			}
			// Like the real device: temp and color take the light out of its scene.
			if ("temp" in params || ("r" in params && "g" in params && "b" in params)) pilot.sceneId = null;
			if (opts.writeFails) return { method: "setPilot", result: { success: false } };
			return { method: "setPilot", result: { success: true } };
		}
		return { method: "getPilot", result: { ...pilot } };
	};
	const broadcast = async (json: object) => {
		broadcasts.push(json);
		return opts.broadcastAnswers ?? [];
	};

	const wiz = createWiz({ send, broadcast, configDir: dir, sleep: async () => {} });
	return { wiz, sent, broadcasts, dir, pilot, lights };
}

const file = (dir: string) => join(dir, "lights.json");

// ------------------------------------------------- config loading

test("a missing lights.json is an error that says to run /wiz discover, and sends nothing", async () => {
	const h = setup({ noConfig: true });
	await assert.rejects(
		() => h.wiz.status(),
		(error: unknown) => {
			assert.ok(error instanceof WizError);
			assert.match(error.message, new RegExp(file(h.dir)));
			assert.match(error.message, /\/wiz discover/);
			return true;
		},
	);
	assert.equal(h.sent.length, 0);
});

test("a corrupt lights.json is a clear error, never a crash", async () => {
	const h = setup({ rawConfig: "{not json" });
	await assert.rejects(
		() => h.wiz.on(),
		(error: unknown) => {
			assert.ok(error instanceof WizError);
			assert.match(error.message, /not valid JSON/);
			assert.match(error.message, new RegExp(file(h.dir)));
			return true;
		},
	);
	assert.equal(h.sent.length, 0);
});

test("a lights.json without a proper lights array is a clear error", async () => {
	for (const raw of ['{"lights":"no"}', "{}", '{"lights":[]}']) {
		const h = setup({ rawConfig: raw });
		await assert.rejects(
			() => h.wiz.status(),
			(error: unknown) => {
				assert.ok(error instanceof WizError);
				assert.match(error.message, new RegExp(file(h.dir)));
				return true;
			},
		);
		assert.equal(h.sent.length, 0);
	}
});

test("an entry without name and ip is a clear error", async () => {
	const h = setup({ rawConfig: '{"lights":[{"name":"escritorio"}]}' });
	await assert.rejects(() => h.wiz.status(), /needs at least a "name" and an "ip"/);
});

// ------------------------------------------------- status and formatting

test("status reads the pilot once and formats it", async () => {
	const h = setup();
	const message = await h.wiz.status();
	assert.deepEqual(h.sent, [{ json: { method: "getPilot", params: {} }, ip: "192.0.2.26" }]);
	assert.equal(message, "▶ escritorio on, 100%, scene 6");
});

test("status shows an off light with ■ (it still reports dimming and scene)", async () => {
	const h = setup({ pilot: { state: false } });
	assert.equal(await h.wiz.status(), "■ escritorio off, 100%, scene 6");
});

test("status shows a tunable-white light in kelvin", async () => {
	const h = setup({ pilot: { sceneId: null, temp: 3200 } });
	assert.equal(await h.wiz.status(), "▶ escritorio on, 100%, 3200K");
});

test("status shows a colored light as hex", async () => {
	const h = setup({ pilot: { sceneId: null, r: 255, g: 8, b: 0 } });
	assert.equal(await h.wiz.status(), "▶ escritorio on, 100%, #ff0800");
});

test("status of an unknown light lists the configured names", async () => {
	const h = setup();
	await assert.rejects(() => h.wiz.status("nope"), /No light named "nope". Configured lights: escritorio\./);
	assert.equal(h.sent.length, 0);
});

// ------------------------------------------------- on / off / dim

test("on sends state:true and reports the state read back", async () => {
	const h = setup({ pilot: { state: false } });
	const message = await h.wiz.on();
	assert.deepEqual(h.sent[0].json, { method: "setPilot", params: { state: true } });
	assert.equal(message, "▶ escritorio on, 100%, scene 6");
});

test("off sends state:false", async () => {
	const h = setup({ pilot: { state: true, dimming: 40, sceneId: null } });
	const message = await h.wiz.off();
	assert.deepEqual(h.sent[0].json, { method: "setPilot", params: { state: false } });
	assert.equal(message, "■ escritorio off, 40%");
});

test("dim sends dimming (which keeps the scene) and reports the new brightness", async () => {
	const h = setup();
	const message = await h.wiz.dim(40);
	assert.deepEqual(h.sent[0].json, { method: "setPilot", params: { state: true, dimming: 40 } });
	assert.equal(h.pilot.sceneId, 6, "dimming kept the scene");
	assert.equal(message, "▶ escritorio on, 40%, scene 6");
});

test("dim outside 10-100 is rejected with the valid range and nothing is sent", async () => {
	for (const bad of [9, 101, 40.5]) {
		const h = setup();
		await assert.rejects(() => h.wiz.dim(bad), /dim must be an integer from 10 to 100\./);
		assert.equal(h.sent.length, 0);
	}
});

// ------------------------------------------------- temp / color / scene

test("temp sends temp and says the light left its scene", async () => {
	const h = setup();
	const message = await h.wiz.temp(3200);
	assert.deepEqual(h.sent[0].json, { method: "getPilot", params: {} }, "read before, to know the scene");
	assert.deepEqual(h.sent[1].json, { method: "setPilot", params: { temp: 3200 } });
	assert.equal(message, "▶ escritorio on, 100%, 3200K (left scene 6)");
});

test("temp on a light that had no scene does not mention leaving one", async () => {
	const h = setup({ pilot: { sceneId: null } });
	const message = await h.wiz.temp(3200);
	assert.ok(!message.includes("scene"));
	assert.equal(message, "▶ escritorio on, 100%, 3200K");
});

test("temp outside 2200-6500 is rejected and nothing is sent", async () => {
	for (const bad of [2199, 6501]) {
		const h = setup();
		await assert.rejects(() => h.wiz.temp(bad), /temp must be an integer from 2200 to 6500\./);
		assert.equal(h.sent.length, 0);
	}
});

test("color accepts #rgb and #rrggbb, normalizes to r/g/b, and says the light left its scene", async () => {
	for (const value of ["#f80", "#FF8800"]) {
		const h = setup();
		const message = await h.wiz.color(value);
		assert.deepEqual(h.sent[1].json, { method: "setPilot", params: { r: 255, g: 136, b: 0 } });
		assert.equal(h.pilot.sceneId, null, "color left the scene");
		assert.equal(message, "▶ escritorio on, 100%, #ff8800 (left scene 6)");
	}
});

test("a malformed color is rejected and nothing is sent", async () => {
	for (const bad of ["f80", "#12345", "#gggggg", "#1234", ""]) {
		const h = setup();
		await assert.rejects(() => h.wiz.color(bad), /color must be #rgb or #rrggbb\./);
		assert.equal(h.sent.length, 0);
	}
});

test("scene sends sceneId and reports it", async () => {
	const h = setup();
	const message = await h.wiz.scene(3);
	assert.deepEqual(h.sent[0].json, { method: "setPilot", params: { sceneId: 3 } });
	assert.equal(message, "▶ escritorio on, 100%, scene 3");
});

test("scene outside 1-32 is rejected and nothing is sent", async () => {
	for (const bad of [0, 33, 6.5]) {
		const h = setup();
		await assert.rejects(() => h.wiz.scene(bad), /scene must be an integer from 1 to 32\./);
		assert.equal(h.sent.length, 0);
	}
});

// ------------------------------------------------- several lights

test("with several lights, on/off without a name hits all of them", async () => {
	const h = setup({ lights: [ESCRITORIO, COCINA] });
	const message = await h.wiz.on();
	assert.deepEqual(
		h.sent.map((s) => s.ip),
		["192.0.2.26", "192.0.2.26", "192.0.2.27", "192.0.2.27"],
		"write plus state read back, per light, one light at a time",
	);
	assert.deepEqual(h.sent[0].json, { method: "setPilot", params: { state: true } });
	assert.ok(message.includes("▶ escritorio"));
	assert.ok(message.includes("▶ cocina"));
});

test("with several lights, dim without a name is an error that lists the names and sends nothing", async () => {
	const h = setup({ lights: [ESCRITORIO, COCINA] });
	await assert.rejects(
		() => h.wiz.dim(40),
		/Several lights are configured \(escritorio, cocina\)\. Name one, e\.g\. \/wiz escritorio dim 40\./,
	);
	assert.equal(h.sent.length, 0);
});

test("with several lights, temp without a name is an error and nothing is sent", async () => {
	const h = setup({ lights: [ESCRITORIO, COCINA] });
	await assert.rejects(() => h.wiz.temp(3200), /escritorio, cocina/);
	assert.equal(h.sent.length, 0);
});

test("with several lights, status without a name reports every light", async () => {
	const h = setup({ lights: [ESCRITORIO, COCINA] });
	const message = await h.wiz.status();
	assert.equal(h.sent.length, 2);	assert.equal(message, "▶ escritorio on, 100%, scene 6\n▶ cocina on, 100%, scene 6");
});

test("a named command targets exactly that light", async () => {
	const h = setup({ lights: [ESCRITORIO, COCINA] });
	await h.wiz.dim(40, "cocina");
	assert.equal(h.sent.length, 2, "write plus state read back, both to cocina");
	assert.deepEqual(h.sent.map((s) => s.ip), ["192.0.2.27", "192.0.2.27"]);
});

// ------------------------------------------------- UDP reality: retries and error replies

test("a lost datagram is retried: first attempt throws, second succeeds", async () => {
	const h = setup({ failFirst: 1 });
	const message = await h.wiz.on();
	assert.equal(h.sent.length, 3, "write retried once, then the state was read back");
	assert.equal(message, "▶ escritorio on, 100%, scene 6");
});

test("after three tries with no answer, the error names the light and its ip", async () => {
	const h = setup({ failAll: true });
	await assert.rejects(
		() => h.wiz.on("escritorio"),
		(error: unknown) => {
			assert.ok(error instanceof WizError);
			assert.equal(error.message, "no answer from escritorio (192.0.2.26)");
			return true;
		},
	);
	assert.equal(h.sent.length, 3);
});

test("an error reply from the light is surfaced as a message", async () => {
	const h = setup({ replies: [{ error: { code: -32601, message: "Method not found" } }] });
	await assert.rejects(
		() => h.wiz.on(),
		(error: unknown) => {
			assert.ok(error instanceof WizError);
			assert.match(error.message, /Method not found/);
			assert.match(error.message, /-32601/);
			assert.match(error.message, /escritorio/);
			return true;
		},
	);
});

test("a success:false reply is surfaced as an error", async () => {
	const h = setup({ writeFails: true });
	await assert.rejects(() => h.wiz.on(), /escritorio did not apply the change/);
});

test("a reply without a pilot result is an error", async () => {
	const h = setup({ replies: [{ method: "getPilot" }] });
	await assert.rejects(() => h.wiz.status(), /malformed/);
});

// ------------------------------------------------- pick: snapshot / applyColor / restore (S9)

const KNOWN: Pilot = { state: true, dimming: 100, sceneId: 6, temp: null, r: null, g: null, b: null };

function snapshotOf(pilot: Partial<Pilot> = {}): import("../src/wiz.ts").Snapshot {
	return { light: { name: "escritorio", ip: "192.0.2.26", mac: "aabbccddee01" }, ...KNOWN, ...pilot } as import("../src/wiz.ts").Snapshot;
}

test("snapshot reads the light once and carries light, state, dimming, scene, temp and rgb", async () => {
	const h = setup();
	const snap = await h.wiz.snapshot();
	assert.deepEqual(h.sent, [{ json: { method: "getPilot", params: {} }, ip: "192.0.2.26" }], "exactly one getPilot");
	assert.deepEqual(snap.light, ESCRITORIO);
	assert.deepEqual(
		{ state: snap.state, dimming: snap.dimming, sceneId: snap.sceneId, temp: snap.temp, r: snap.r, g: snap.g, b: snap.b },
		{ state: true, dimming: 100, sceneId: 6, temp: null, r: null, g: null, b: null },
	);
});

test("snapshot of an off light keeps its dimming and scene", async () => {
	const h = setup({ pilot: { state: false } });
	const snap = await h.wiz.snapshot();
	assert.equal(snap.state, false);
	assert.equal(snap.dimming, 100);
	assert.equal(snap.sceneId, 6);
});

test("snapshot works with a name among several lights", async () => {
	const h = setup({ lights: [ESCRITORIO, COCINA] });
	const snap = await h.wiz.snapshot("cocina");
	assert.equal(snap.light.name, "cocina");
	assert.equal(h.sent[0].ip, "192.0.2.27");
});

test("snapshot without a name and several lights is the which-light error, and sends nothing", async () => {
	const h = setup({ lights: [ESCRITORIO, COCINA] });
	await assert.rejects(
		() => h.wiz.snapshot(),
		/Several lights are configured \(escritorio, cocina\)\. Name one/,
	);
	assert.equal(h.sent.length, 0);
});

test("applyColor sends state:true with the pure colour and dimming in one datagram", async () => {
	const h = setup();
	await h.wiz.applyColor({ r: 255, g: 136, b: 0 }, 40);
	assert.deepEqual(h.sent, [
		{ json: { method: "setPilot", params: { state: true, r: 255, g: 136, b: 0, dimming: 40 } }, ip: "192.0.2.26" },
	]);
	assert.equal(h.pilot.r, 255);
	assert.equal(h.pilot.dimming, 40);
});

test("applyColor targets the named light among several without touching the others", async () => {
	const h = setup({ lights: [ESCRITORIO, COCINA] });
	await h.wiz.applyColor({ r: 0, g: 0, b: 255 }, 20, "cocina");
	assert.deepEqual(h.sent.map((s) => s.ip), ["192.0.2.27"]);
});

test("applyColor validates dimming and the rgb bytes before sending anything", async () => {
	for (const [rgb, dim] of [
		[{ r: 0, g: 0, b: 300 }, 50],
		[{ r: -1, g: 0, b: 0 }, 50],
		[{ r: 1.5, g: 0, b: 0 }, 50],
		[{ r: 0, g: 0, b: 0 }, 9],
		[{ r: 0, g: 0, b: 0 }, 101],
	] as Array<[{ r: number; g: number; b: number }, number]>) {
		const h = setup();
		await assert.rejects(() => h.wiz.applyColor(rgb, dim), /must be/);
		assert.equal(h.sent.length, 0);
	}
});

test("applyColor retries lost datagrams and reports no answer naming the light", async () => {
	const h = setup({ failAll: true });
	await assert.rejects(
		() => h.wiz.applyColor({ r: 1, g: 2, b: 3 }, 50),
		(error: unknown) => {
			assert.ok(error instanceof WizError);
			assert.equal(error.message, "no answer from escritorio (192.0.2.26)");
			return true;
		},
	);
	assert.equal(h.sent.length, 3, "three tries");
});

test("restore on a scene light sends state, dimming and sceneId exactly (the verified S3 round trip)", async () => {
	const h = setup();
	await h.wiz.restore(snapshotOf());
	assert.deepEqual(h.sent, [
		{ json: { method: "setPilot", params: { state: true, dimming: 100, sceneId: 6 } }, ip: "192.0.2.26" },
	]);
});

test("restore on an off light sends only state:false", async () => {
	const h = setup({ pilot: { state: false, dimming: 40, r: 255, g: 0, b: 0, sceneId: null } });
	const snap = await h.wiz.snapshot();
	assert.equal(snap.state, false);
	await h.wiz.restore(snap);
	assert.deepEqual(h.sent[1].json, { method: "setPilot", params: { state: false } });
});

test("restore prefers temp when there is no scene", async () => {
	const h = setup({ pilot: { sceneId: null, temp: 3200 } });
	const snap = await h.wiz.snapshot();
	await h.wiz.restore(snap);
	assert.deepEqual(h.sent[1].json, { method: "setPilot", params: { state: true, dimming: 100, temp: 3200 } });
});

test("restore falls back to rgb when there is no scene and no temp", async () => {
	const h = setup({ pilot: { sceneId: null, r: 255, g: 8, b: 0 } });
	const snap = await h.wiz.snapshot();
	await h.wiz.restore(snap);
	assert.deepEqual(h.sent[1].json, { method: "setPilot", params: { state: true, dimming: 100, r: 255, g: 8, b: 0 } });
});

test("restore prefers the scene even when temp and rgb are also present", async () => {
	const h = setup({ pilot: { temp: 3200, r: 255, g: 8, b: 0 } });
	const snap = await h.wiz.snapshot();
	await h.wiz.restore(snap);
	assert.deepEqual(h.sent[1].json, { method: "setPilot", params: { state: true, dimming: 100, sceneId: 6 } });
});

test("restore targets the light stored in the snapshot, even with several lights configured", async () => {
	const h = setup({ lights: [ESCRITORIO, COCINA] });
	await h.wiz.restore({ ...snapshotOf(), light: COCINA });
	assert.deepEqual(h.sent.map((s) => s.ip), ["192.0.2.27"]);
});

test("a restore write is retried and fails with the usual no-answer error", async () => {
	const h = setup({ lights: [ESCRITORIO, COCINA], failAll: true });
	await assert.rejects(() => h.wiz.restore({ ...snapshotOf(), light: COCINA }), /no answer from cocina \(192\.0\.2\.27\)/);
	assert.equal(h.sent.length, 3);
});

// ------------------------------------------------- discovery

test("discover broadcasts getPilot and prints what answered plus the JSON to paste", async () => {
	const h = setup({
		noConfig: true,
		broadcastAnswers: [
			{ ip: "192.0.2.26", reply: { method: "getPilot", result: { mac: "aabbccddee01" } } },
			{ ip: "192.0.2.27", reply: { method: "getPilot", result: { mac: "aabbccddeeff" } } },
		],
	});
	const message = await h.wiz.discover();
	assert.deepEqual(h.broadcasts, [{ method: "getPilot", params: {} }]);
	assert.match(message, /Found 2 lights/);
	assert.match(message, /192\.0\.2\.26\s+mac aabbccddee01/);
	assert.match(message, /192\.0\.2\.27\s+mac aabbccddeeff/);
	assert.ok(
		message.includes(
			'{"lights":[{"name":"light-1","ip":"192.0.2.26","mac":"aabbccddee01"},{"name":"light-2","ip":"192.0.2.27","mac":"aabbccddeeff"}]}',
		),
		`prints the paste-ready JSON:\n${message}`,
	);
	assert.match(message, new RegExp(file(h.dir)));
});

test("discover with no answers says so plainly", async () => {
	const h = setup({ noConfig: true });
	const message = await h.wiz.discover();
	assert.deepEqual(h.broadcasts, [{ method: "getPilot", params: {} }]);
	assert.match(message, /No lights answered/);
});
