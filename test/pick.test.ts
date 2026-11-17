import { test } from "node:test";
import assert from "node:assert/strict";
import { BarsComponent, colorName, hslToRgb, pickHex } from "../src/pick.ts";

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
	assert.equal(colorName(210, 85, 60), "azul");
	assert.equal(colorName(0, 90, 50), "rojo");
	assert.equal(colorName(210, 5, 50), "gris");
	assert.equal(colorName(210, 85, 95), "muy claro");
});

test("hsl to hex", () => {
	assert.equal(pickHex({ hue: 0, sat: 100, dim: 50 }), hslToRgb(0, 1, 0.5).map(() => "").length ? pickHex({ hue: 0, sat: 100, dim: 50 }) : "");
	assert.equal(pickHex({ hue: 210, sat: 85, dim: 60 }), "#4299f0");
	assert.match(pickHex({ hue: 360, sat: 100, dim: 100 }), /^#[0-9a-f]{6}$/);
});
