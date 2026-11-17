import { test } from "node:test";
import assert from "node:assert/strict";
import { BarsComponent, colorName, hsvToRgb, pickHex, piKeys } from "../src/pick.ts";

const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
const make = () => {
	let out: string | undefined | "unset" = "unset";
	const rendered: number[] = [];
	const c = new BarsComponent({ requestRender: () => rendered.push(1) }, (v) => (out = v), { hue: 210, sat: 85, dim: 60 });
	return { c, rendered, result: () => out as string | undefined };
};

test("the modal has a border and padding", () => {
	const { c } = make();
	const lines = c.render(60).map(plain);
	assert.match(lines[0], /^┌─+┐$/, "top border");
	assert.match(lines.at(-1)!, /^└─+┘$/, "bottom border");
	for (const line of lines.slice(1, -1)) assert.match(line, /^│.*│$/, "side borders");
	assert.ok(lines.some((l) => /^│ {2}\S/.test(l)), "content is padded inside the border");
});

test("every line is the same width, borders included", () => {
	const { c } = make();
	const widths = new Set(c.render(60).map((l) => plain(l).length));
	assert.equal(widths.size, 1, `uneven widths: ${[...widths].join(",")}`);
});

test("the modal fits the requested width", () => {
	const { c } = make();
	const wide = plain(c.render(60)[0]).length;
	const narrow = plain(c.render(44)[0]).length;
	assert.equal(wide, 60);
	assert.equal(narrow, 44);
});

test("arrows pick a row and change its value; enter returns the hex", () => {
	const { c, result } = make();
	c.handleInput("\x1b[B"); // row: Brillo
	c.handleInput("\x1b[C"); // +5
	c.handleInput("\x1b[C"); // +5
	assert.equal(c.state.dim, 70);
	c.handleInput("\r");
	assert.equal(result(), pickHex(c.state));
});

test("rows cycle and escape cancels", () => {
	const { c, result } = make();
	c.handleInput("\x1b[A"); // wraps to Saturación
	c.handleInput("\x1b[D"); // -5
	assert.equal(c.state.sat, 80);
	c.handleInput("\x1b");
	assert.equal(result(), undefined);
});

test("limits hold: dim never below 10 or above 100, sat in 0..100, hue wraps", () => {
	const { c } = make();
	for (let i = 0; i < 40; i++) c.handleInput("\x1b[B"); // row Brillo
	for (let i = 0; i < 40; i++) c.handleInput("\x1b[D");
	assert.equal(c.state.dim, 10);
	for (let i = 0; i < 60; i++) c.handleInput("\x1b[C");
	assert.equal(c.state.dim, 100);
	const { c: c2 } = make();
	c2.handleInput("\x1b[D"); // 210 - 10 = 200
	for (let i = 0; i < 36; i++) c2.handleInput("\x1b[C"); // a full turn brings it back
	assert.equal(c2.state.hue, 200, "hue wraps around 360");
});

test("changing a value counts as a send; moving rows does not", () => {
	const { c } = make();
	c.handleInput("\x1b[B");
	c.handleInput("\x1b[A");
	assert.equal(c.sends, 0, "row moves send nothing");
	c.handleInput("\x1b[C");
	assert.equal(c.sends, 1);
});

test("colour names are human, not degrees", () => {
	assert.equal(colorName(210, 85), "azul");
	assert.equal(colorName(0, 90), "rojo");
	assert.equal(colorName(210, 5), "blanco", "no saturation is white at full value");
});

test("the colour is pure: tone and saturation only, brightness never changes it", () => {
	assert.equal(pickHex({ hue: 0, sat: 100, dim: 10 }), "#ff0000");
	assert.equal(pickHex({ hue: 0, sat: 100, dim: 100 }), "#ff0000", "brightness is the light's dimming, not part of the colour");
	assert.equal(pickHex({ hue: 210, sat: 0, dim: 50 }), "#ffffff");
	assert.deepEqual(hsvToRgb(120, 1, 1), [0, 255, 0]);
	assert.match(pickHex({ hue: 360, sat: 100, dim: 100 }), /^#[0-9a-f]{6}$/);
});

test("arrows work with key names as well as raw sequences", () => {
	const { c } = make();
	c.handleInput("down");
	assert.equal(c.row, 1, "named key moves the row");
	c.handleInput("right");
	assert.equal(c.state.dim, 65);
	const { c: c2 } = make();
	c2.handleInput("\x1b[C");
	assert.equal(c2.state.hue, 220, "raw sequence still works");
});

test("the last key is shown escaped, and unknown keys repaint without changing state", () => {
	const { c, rendered } = make();
	const before = { ...c.state };
	c.handleInput("\x1b[A");
	assert.equal(c.lastKey, "\\x1b[A → up");
	c.handleInput("z");
	assert.deepEqual(c.state, before, "an unknown key changes nothing");
	assert.ok(rendered.length >= 2, "but it still asks for a repaint");
});

test("application-mode and Kitty arrow forms move the bars (the real-terminal bug)", () => {
	for (const up of ["\x1b[A", "\x1bOA", "\x1b[1;1A", "\x1b[1;1:1A"]) {
		const { c } = make();
		c.handleInput(up);
		assert.equal(c.row, 2, `up as ${JSON.stringify(up)} wraps to the last row`);
	}
	for (const right of ["\x1b[C", "\x1bOC", "\x1b[1;1C", "\x1b[1;1:1C"]) {
		const { c } = make();
		c.handleInput(right);
		assert.equal(c.state.hue, 220, `right as ${JSON.stringify(right)} steps the hue`);
	}
});

test("key release events change nothing", () => {
	const { c } = make();
	c.handleInput("\x1b[1;1:3C");
	assert.equal(c.state.hue, 210);
	assert.equal(c.sends, 0);
});

test("an injected key API (pi's matchesKey) decides what a key is", () => {
	let out: string | undefined | "unset" = "unset";
	const keys = { which: (d: string) => (d === "ZZ" ? ("right" as const) : undefined), isRelease: () => false };
	const c = new BarsComponent({ requestRender() {} }, (v) => (out = v), { hue: 210, sat: 85, dim: 60 }, {}, keys);
	c.handleInput("ZZ");
	assert.equal(c.state.hue, 220);
	c.handleInput("\x1b[A"); // the injected API does not know it: ignored, but shown as unknown
	assert.equal(c.row, 0);
	assert.match(c.lastKey, /→ \?$/);
	assert.equal(out, "unset");
});

test("the footer shows the last key and what it was understood as", () => {
	const { c } = make();
	c.handleInput("\x1bOB");
	const text = c.render(60).map(plain).join("\n");
	assert.match(text, /última tecla: \\x1bOB → down/);
});

test("piKeys adapts matchesKey and shows its label", () => {
	const Key = { up: "UP", down: "DOWN", left: "LEFT", right: "RIGHT", enter: "ENTER", escape: "ESC" };
	const matchesKey = (data: string, key: unknown) => data === `<${String(key)}>`;
	const c = new BarsComponent({ requestRender() {} }, () => {}, { hue: 210, sat: 85, dim: 60 }, {}, piKeys({ matchesKey, Key }));
	c.handleInput("<RIGHT>");
	assert.equal(c.state.hue, 220);
	assert.match(c.render(60).map(plain).join("\n"), /\[pi-tui\]/);
});

// --- layout: measure real columns, ignoring colour codes -------------------------------------------------
const visible = (s: string) => plain(s).length;
/** Visible column where a row's colour bar starts, and how many cells it has. */
const bar = (line: string) => {
	const first = line.indexOf("\x1b[48;2;");
	return { start: first < 0 ? -1 : visible(line.slice(0, first)), cells: (line.match(/\x1b\[48;2;/g) ?? []).length };
};
const barRows = (c: BarsComponent) => c.render(60).filter((l) => /Tono|Brillo|Saturación/.test(plain(l)));

test("layout: the bars start in the same column whichever row is selected", () => {
	const { c } = make();
	for (let step = 0; step < 3; step++) {
		const starts = barRows(c).map((l) => bar(l).start);
		assert.equal(new Set(starts).size, 1, `row ${c.row} selected: bars start at ${starts.join(", ")}`);
		c.handleInput("\x1b[B");
	}
});

test("layout: every bar has the same number of cells", () => {
	const { c } = make();
	const cells = barRows(c).map((l) => bar(l).cells);
	assert.equal(new Set(cells).size, 1, `cells: ${cells.join(", ")}`);
	assert.ok(cells[0] >= 10);
});

/** Visible column of the ▲ under the selected row. */
const markerColumn = (c: BarsComponent) => {
	const lines = c.render(60);
	const at = lines.findIndex((l) => plain(l).includes("▲"));
	assert.ok(at > 0, "marker is drawn");
	return visible(lines[at].slice(0, lines[at].indexOf("▲")));
};

test("layout: the marker sits on the bar's first cell at the minimum and its last cell at the maximum", () => {
	// Saturación 0 / 100 (third row), Brillo 10 / 100 (second row).
	for (const [row, key, min, max] of [[2, "sat", 0, 100], [1, "dim", 10, 100]] as const) {
		const { c } = make();
		c.row = row;
		const { start, cells } = bar(barRows(c)[row]);
		c.state[key] = min;
		assert.equal(markerColumn(c), start, `${key} at ${min} is under the first cell`);
		c.state[key] = max;
		assert.equal(markerColumn(c), start + cells - 1, `${key} at ${max} is under the last cell`);
	}
});

test("layout: the marker follows the value in between", () => {
	const { c } = make();
	c.row = 2;
	const { start, cells } = bar(barRows(c)[2]);
	c.state.sat = 50;
	const col = markerColumn(c);
	assert.ok(Math.abs(col - (start + (cells - 1) / 2)) <= 1, `50% is in the middle (col ${col})`);
});

const cells = (line: string) => [...line.matchAll(/\x1b\[48;2;(\d+);(\d+);(\d+)m/g)].map((m) => [Number(m[1]), Number(m[2]), Number(m[3])]);

test("brightness bar runs from dark to the PURE colour, never to white", () => {
	const c = new BarsComponent({ requestRender() {} }, () => {}, { hue: 0, sat: 100, dim: 35 });
	const row = c.render(60).find((l) => plain(l).includes("Brillo"))!;
	const colours = cells(row);
	assert.deepEqual(colours.at(-1), [255, 0, 0], "last cell is the pure colour");
	assert.ok(colours[0][0] < 40 && colours[0][1] === 0 && colours[0][2] === 0, "first cell is dark");
	assert.ok(colours.every(([, g, b]) => g === 0 && b === 0), "never washes out toward white");
});

test("the swatch shows the colour that will be sent, not a darkened one", () => {
	const c = new BarsComponent({ requestRender() {} }, () => {}, { hue: 0, sat: 100, dim: 10 });
	const swatchRow = c.render(60)[2];
	assert.deepEqual(cells(swatchRow)[0], [255, 0, 0]);
});

test("the tone and saturation bars always show full-value colours", () => {
	const c = new BarsComponent({ requestRender() {} }, () => {}, { hue: 120, sat: 100, dim: 20 });
	const tone = cells(c.render(60).find((l) => plain(l).includes("Tono"))!);
	assert.ok(tone.every((rgb) => Math.max(...rgb) === 255), "every tone cell is at full value");
	const sat = cells(c.render(60).find((l) => plain(l).includes("Saturación"))!);
	assert.deepEqual(sat[0], [255, 255, 255], "no saturation = white");
	assert.deepEqual(sat.at(-1), [0, 255, 0], "full saturation = pure tone");
});
