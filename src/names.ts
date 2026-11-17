/**
 * Names for the things `/wiz` takes: colours, white temperatures and scenes.
 *
 * Pure data and lookups, so every name is a fixed, testable fact. Matching ignores case, accents,
 * hyphens and extra spaces, in Spanish or English. Scene ids and names are the ones published by
 * pywizlight (scenes.py); ids above 32 and the sync scenes are left out on purpose, because the
 * engine only accepts 1-32.
 */

/** Lowercase, no accents, hyphens between letters as spaces (not a leading "-10"), single spaces. */
export function normalize(text: string): string {
	return text
		.normalize("NFD")
		.replace(/\p{M}/gu, "")
		.toLowerCase()
		.replace(/(?<=\p{L})-(?=\p{L})/gu, " ")
		.replace(/\s+/g, " ")
		.trim();
}

// ---------------------------------------------------------------------------------------- colours

/** Canonical Spanish name → [display name, hex]. Picked to look good on a bulb, not the CSS primaries. */
export const COLORS: Record<string, [string, string]> = {
	rojo: ["Rojo", "#ff0000"],
	naranja: ["Naranja", "#ff8000"],
	amarillo: ["Amarillo", "#ffd400"],
	verde: ["Verde", "#00c853"],
	turquesa: ["Turquesa", "#00d9c0"],
	celeste: ["Celeste", "#00bfff"],
	azul: ["Azul", "#3b82f6"],
	violeta: ["Violeta", "#8a2be2"],
	rosa: ["Rosa", "#ff69b4"],
	magenta: ["Magenta", "#ff00aa"],
};

const COLOR_ALIASES: Record<string, string> = {
	red: "rojo",
	orange: "naranja",
	yellow: "amarillo",
	green: "verde",
	teal: "turquesa",
	turquoise: "turquesa",
	cyan: "celeste",
	"sky blue": "celeste",
	blue: "azul",
	purple: "violeta",
	violet: "violeta",
	pink: "rosa",
};

export function resolveColor(word: string): string | undefined {
	const key = normalize(word);
	const canonical = COLOR_ALIASES[key] ?? key;
	return COLORS[canonical]?.[1];
}

// ---------------------------------------------------------------------------------- white temperature

const TEMPS: Record<string, number> = {
	vela: 2200,
	candle: 2200,
	calido: 2700,
	warm: 2700,
	neutro: 4000,
	neutral: 4000,
	blanco: 4000,
	white: 4000,
	frio: 6500,
	cool: 6500,
};

export function resolveTemp(word: string): number | undefined {
	return TEMPS[normalize(word)];
}

/** What the temperature menu offers, in order. */
export const TEMP_MENU: Array<[string, number]> = [
	["Vela", 2200],
	["Cálido", 2700],
	["Neutro", 4000],
	["Frío", 6500],
];

// ------------------------------------------------------------------------------------------ scenes

export const SCENES: Array<[number, string]> = [
	[1, "Ocean"],
	[2, "Romance"],
	[3, "Sunset"],
	[4, "Party"],
	[5, "Fireplace"],
	[6, "Cozy"],
	[7, "Forest"],
	[8, "Pastel colors"],
	[9, "Wake-up"],
	[10, "Bedtime"],
	[11, "Warm white"],
	[12, "Daylight"],
	[13, "Cool white"],
	[14, "Night light"],
	[15, "Focus"],
	[16, "Relax"],
	[17, "True colors"],
	[18, "TV time"],
	[19, "Plantgrowth"],
	[20, "Spring"],
	[21, "Summer"],
	[22, "Fall"],
	[23, "Deep dive"],
	[24, "Jungle"],
	[25, "Mojito"],
	[26, "Club"],
	[27, "Christmas"],
	[28, "Halloween"],
	[29, "Candlelight"],
	[30, "Golden white"],
	[31, "Pulse"],
	[32, "Steampunk"],
];

/** Spanish names for the scenes whose translation is obvious. */
const SCENE_ALIASES: Record<string, number> = {
	oceano: 1,
	atardecer: 3,
	fiesta: 4,
	chimenea: 5,
	acogedor: 6,
	bosque: 7,
	pastel: 8,
	despertar: 9,
	dormir: 10,
	"luz del dia": 12,
	noche: 14,
	enfoque: 15,
	primavera: 20,
	verano: 21,
	otono: 22,
	selva: 24,
	navidad: 27,
	pulso: 31,
};

export function resolveScene(word: string): number | undefined {
	const key = normalize(word);
	return SCENES.find(([, name]) => normalize(name) === key)?.[0] ?? SCENE_ALIASES[key];
}

// ------------------------------------------------------------------------------------------- menus

const swatch = (hex: string) => {
	const n = parseInt(hex.slice(1), 16);
	return `\x1b[48;2;${(n >> 16) & 255};${(n >> 8) & 255};${n & 255}m      \x1b[0m`;
};

/** `██████  Azul  #3b82f6` */
export function colorLabel(name: string, hex: string): string {
	return `${swatch(hex)}  ${name}  ${hex}`;
}

export const COLOR_MENU: Array<{ label: string; hex: string }> = Object.values(COLORS).map(([name, hex]) => ({
	label: colorLabel(name, hex),
	hex,
}));

export const DIM_MENU = [10, 25, 50, 75, 100];

export const SCENE_MENU: Array<{ label: string; id: number }> = [...SCENES]
	.sort((a, b) => a[1].localeCompare(b[1]))
	.map(([id, name]) => ({ label: `${name} (${id})`, id }));

/** Words worth completing after `/wiz `, besides the forms and the light names. */
export const SUGGESTIONS: string[] = [
	...Object.keys(COLORS),
	"calido",
	"neutro",
	"frio",
	"blanco",
	...SCENES.map(([, name]) => normalize(name)),
];
