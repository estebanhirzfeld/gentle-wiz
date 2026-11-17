/**
 * WiZ engine: read and write the state of the configured lights over the local
 * network (JSON in single UDP datagrams to port 38899), plus discovery.
 *
 * Everything that touches the outside world is injected through WizDeps —
 * `send(json, ip) -> reply` for unicast and `broadcast(json)` for discovery —
 * so the whole engine runs under tests without a network or a real light.
 *
 * UDP drops datagrams, so every call retries (3 tries, each with its own 1 s
 * timeout inside the transport) and then reports "no answer from <name> (<ip>)"
 * instead of pretending the command worked.
 */
import { loadLights, lightsPath, WizError, type Light } from "./config.ts";

export { WizError, lightsPath } from "./config.ts";
export type { Light } from "./config.ts";

// ---------------------------------------------------------------- types

export interface Pilot {
	mac?: string | null;
	state?: boolean | null;
	dimming?: number | null;
	sceneId?: number | null;
	temp?: number | null;
	r?: number | null;
	g?: number | null;
	b?: number | null;
}

export interface BroadcastAnswer {
	ip: string;
	reply: object;
}

export interface WizDeps {
	/** One unicast attempt: JSON datagram out, JSON reply back. Throwing or timing out is a failed attempt. */
	send: (json: object, ip: string) => Promise<object>;
	/** Discovery transport: broadcasts a JSON datagram and collects what answered. */
	broadcast: (json: object) => Promise<BroadcastAnswer[]>;
	/** Holds `lights.json`. */
	configDir: string;
	/** Injectable clock (reserved for future scheduling); nothing polls today. */
	now?: () => number;
	sleep?: (ms: number) => Promise<void>;
}

// ---------------------------------------------------------------- constants

const DIM_MIN = 10;
const DIM_MAX = 100;
const TEMP_MIN = 2200;
const TEMP_MAX = 6500;
const SCENE_MIN = 1;
const SCENE_MAX = 32;
const RETRIES = 3;
const RETRY_PAUSE_MS = 1000;

// ---------------------------------------------------------------- engine

export function createWiz(deps: WizDeps) {
	const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

	/** Sends with retries; a lost datagram is retried, and only after the last one we give up. */
	async function call(light: Light, json: object): Promise<object> {
		for (let attempt = 1; attempt <= RETRIES; attempt++) {
			if (attempt > 1) await sleep(RETRY_PAUSE_MS);
			try {
				return await deps.send(json, light.ip);
			} catch {
				// UDP drops datagrams; the next attempt may answer.
			}
		}
		throw new WizError(`no answer from ${light.name} (${light.ip})`);
	}

	async function read(light: Light): Promise<Pilot> {
		const reply = (await call(light, { method: "getPilot", params: {} })) as { result?: Pilot };
		if (!reply.result || typeof reply.result !== "object") {
			throw new WizError(`${light.name} sent a malformed reply.`);
		}
		return reply.result;
	}

	async function write(light: Light, params: Record<string, unknown>): Promise<void> {
		const reply = (await call(light, { method: "setPilot", params })) as {
			result?: { success?: boolean };
			error?: { code?: number; message?: string };
		};
		if (reply.error) {
			const code = reply.error.code;
			throw new WizError(
				`${light.name} rejected the change: ${reply.error.message ?? "unknown error"}${
					code !== undefined ? ` (code ${code})` : ""
				}.`,
			);
		}
		if (reply.result?.success !== true) {
			throw new WizError(`${light.name} did not apply the change (success: false).`);
		}
	}

	function configured(): Light[] {
		return loadLights(deps.configDir);
	}

	function findLight(lights: Light[], name: string): Light {
		const light = lights.find((l) => l.name.toLowerCase() === name.toLowerCase());
		if (!light) {
			throw new WizError(`No light named "${name}". Configured lights: ${lights.map((l) => l.name).join(", ")}.`);
		}
		return light;
	}

	/** Exactly one light: the configured one when it is the only light, or the named one. */
	function target(name?: string): Light {
		const lights = configured();
		if (name === undefined) {
			if (lights.length === 1) return lights[0];
			throw new WizError(
				`Several lights are configured (${lights.map((l) => l.name).join(", ")}). Name one, e.g. /wiz ${lights[0]?.name} dim 40.`,
			);
		}
		return findLight(lights, name);
	}

	/** One light or, when the name is omitted and there are several, all of them (on/off/status). */
	function targets(name?: string): Light[] {
		const lights = configured();
		if (name === undefined) return lights;
		return [findLight(lights, name)];
	}

	function checkRange(kind: string, value: number, min: number, max: number): void {
		if (!Number.isInteger(value) || value < min || value > max) {
			throw new WizError(`${kind} must be an integer from ${min} to ${max}.`);
		}
	}

	/** `#rgb`/`#rrggbb` → r/g/b ints; anything else is rejected before anything is sent. */
	function parseColor(value: string): { r: number; g: number; b: number } {
		const match = /^#([0-9a-f]{3}(?:[0-9a-f]{3})?)$/i.exec(value.trim());
		if (!match) throw new WizError("color must be #rgb or #rrggbb.");
		const hex = match[1].length === 3 ? [...match[1]].map((c) => c + c).join("") : match[1];
		const byte = (i: number) => parseInt(hex.slice(i, i + 2), 16);
		return { r: byte(0), g: byte(2), b: byte(4) };
	}

	function hex(n: number): string {
		return n.toString(16).padStart(2, "0");
	}

	/** `▶ escritorio on, 40%, scene 6` / `■ cocina off`. */
	function describe(name: string, p: Pilot): string {
		const on = p.state !== false;
		const bits = [on ? "on" : "off"];
		if (p.dimming != null) bits.push(`${p.dimming}%`);
		if (p.sceneId != null) bits.push(`scene ${p.sceneId}`);
		if (p.temp != null) bits.push(`${p.temp}K`);
		if (p.r != null && p.g != null && p.b != null) bits.push(`#${hex(p.r)}${hex(p.g)}${hex(p.b)}`);
		return `${on ? "▶" : "■"} ${name} ${bits.join(", ")}`;
	}

	function sceneNote(before: Pilot, after: Pilot): string {
		return before.sceneId != null && after.sceneId == null ? ` (left scene ${before.sceneId})` : "";
	}

	async function readAll(name?: string): Promise<string> {
		const lines: string[] = [];
		for (const light of targets(name)) lines.push(describe(light.name, await read(light)));
		return lines.join("\n");
	}

	async function setAll(state: boolean, name?: string): Promise<string> {
		const lines: string[] = [];
		for (const light of targets(name)) {
			await write(light, { state });
			lines.push(describe(light.name, await read(light)));
		}
		return lines.join("\n");
	}

	return {
		/** The configured lights; throws a user-facing WizError when lights.json is missing or corrupt. */
		lights: (): Light[] => configured(),

		/** State of one light (or every light when the name is omitted). */
		async status(name?: string): Promise<string> {
			return readAll(name);
		},

		/** Turns on one light, or every light when the name is omitted. */
		async on(name?: string): Promise<string> {
			return setAll(true, name);
		},

		/** Turns off one light, or every light when the name is omitted. */
		async off(name?: string): Promise<string> {
			return setAll(false, name);
		},

		/** Brightness 10-100; on the verified device dimming keeps the scene. */
		async dim(value: number, name?: string): Promise<string> {
			checkRange("dim", value, DIM_MIN, DIM_MAX);
			const light = target(name);
			await write(light, { state: true, dimming: value });
			return describe(light.name, await read(light));
		},

		/** White temperature 2200-6500 K; takes the light out of its scene and says so. */
		async temp(value: number, name?: string): Promise<string> {
			checkRange("temp", value, TEMP_MIN, TEMP_MAX);
			const light = target(name);
			const before = await read(light);
			await write(light, { temp: value });
			const after = await read(light);
			return `${describe(light.name, after)}${sceneNote(before, after)}`;
		},

		/** Color `#rgb`/`#rrggbb`; takes the light out of its scene and says so. */
		async color(value: string, name?: string): Promise<string> {
			const { r, g, b } = parseColor(value);
			const light = target(name);
			const before = await read(light);
			await write(light, { r, g, b });
			const after = await read(light);
			return `${describe(light.name, after)}${sceneNote(before, after)}`;
		},

		/** Plays a scene 1-32. */
		async scene(value: number, name?: string): Promise<string> {
			checkRange("scene", value, SCENE_MIN, SCENE_MAX);
			const light = target(name);
			await write(light, { sceneId: value });
			return describe(light.name, await read(light));
		},

		/**
		 * Broadcasts getPilot to the network and prints what answered, plus the
		 * JSON to paste into lights.json. Never writes the config itself.
		 */
		async discover(): Promise<string> {
			const answers = await deps.broadcast({ method: "getPilot", params: {} });
			const seen = new Map<string, string>();
			for (const { ip, reply } of answers) {
				if (seen.has(ip)) continue;
				const mac = (reply as { result?: { mac?: unknown } })?.result?.mac;
				seen.set(ip, typeof mac === "string" && mac.trim() ? mac : "?");
			}
			if (seen.size === 0) {
				return "No lights answered the discovery broadcast. Make sure they are on and connected to the same network, then try again.";
			}
			const entries = [...seen.entries()];
			const json = JSON.stringify({
				lights: entries.map(([ip, mac], i) => ({ name: `light-${i + 1}`, ip, mac })),
			});
			return [
				`Found ${entries.length} light${entries.length === 1 ? "" : "s"}:`,
				...entries.map(([ip, mac]) => `  ${ip}  mac ${mac}`),
				`Paste into ${lightsPath(deps.configDir)} (edit the names):`,
				json,
			].join("\n");
		},
	};
}

export type Wiz = ReturnType<typeof createWiz>;
