/**
 * gentle-wiz configuration: the list of lights the user discovered.
 *
 * lights.json is written by hand (the /wiz discover output is pasted into it),
 * so every failure here is a user-facing message, never a stack trace.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** The error type for every user-facing failure in this package. */
export class WizError extends Error {
	override name = "WizError";
}

export interface Light {
	name: string;
	ip: string;
	mac?: string;
}

export function lightsPath(configDir: string): string {
	return join(configDir, "lights.json");
}

const SHAPE_EXAMPLE = '{"lights":[{"name":"escritorio","ip":"192.0.2.26","mac":"aabbccddee01"}]}';

/**
 * Loads and validates `<configDir>/lights.json`. Missing or corrupt files throw
 * a WizError that tells the user what to do; nothing ever crashes the command.
 */
export function loadLights(configDir: string): Light[] {
	const file = lightsPath(configDir);
	if (!existsSync(file)) {
		throw new WizError(
			`No lights configured: ${file} is missing. Run /wiz discover, then paste the printed JSON into ${file}.`,
		);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(file, "utf8"));
	} catch (error) {
		throw new WizError(
			`${file} is not valid JSON (${(error as Error).message}). Fix it or delete it, then run /wiz discover.`,
		);
	}
	const lights = (parsed as { lights?: unknown } | null)?.lights;
	if (!Array.isArray(lights) || lights.length === 0) {
		throw new WizError(`${file} must contain ${SHAPE_EXAMPLE}`);
	}
	return lights.map((raw, index) => {
		const entry = raw as { name?: unknown; ip?: unknown; mac?: unknown };
		if (typeof entry.name !== "string" || !entry.name.trim() || typeof entry.ip !== "string" || !entry.ip.trim()) {
			throw new WizError(`${file}: light #${index + 1} needs at least a "name" and an "ip".`);
		}
		const light: Light = { name: entry.name, ip: entry.ip };
		if (typeof entry.mac === "string" && entry.mac.trim()) light.mac = entry.mac;
		return light;
	});
}
