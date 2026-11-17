import { test } from "node:test";
import assert from "node:assert/strict";
import { createLiveSender, type LiveSender, type LiveSenderDeps } from "../src/live.ts";

/** Deterministic clock: no real timers, time moves only when the test advances it. */
function fakeClock() {
	let t = 0;
	let nextId = 1;
	const timers = new Map<number, { at: number; fn: () => void }>();
	return {
		now: (): number => t,
		setTimer(fn: () => void, ms: number): number {
			const id = nextId++;
			timers.set(id, { at: t + ms, fn });
			return id;
		},
		clearTimer(handle: unknown): void {
			timers.delete(handle as number);
		},
		pendingTimers: (): number => timers.size,
		/** Runs every timer due within `ms`, in order, settling microtasks after each. */
		async advance(ms: number): Promise<void> {
			const end = t + ms;
			for (;;) {
				const due = [...timers.entries()].filter(([, x]) => x.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
				if (!due) break;
				t = due[1].at;
				timers.delete(due[0]);
				due[1].fn();
				await breathe();
			}
			t = end;
		},
	};
}

const breathe = () => new Promise((r) => setImmediate(r));

/**
 * Sends are observable and controllable: every send is recorded, and unless it
 * is made to fail the test releases it by hand (`release()`), so "in flight"
 * is a state the test decides.
 */
function senderSetup(opts: { intervalMs?: number; holdSends?: boolean } = {}) {
	const clock = fakeClock();
	const sent: unknown[] = [];
	let failNext: Error | null = null;
	const waiting: Array<() => void> = [];

	const send = (value: unknown): Promise<void> => {
		sent.push(value);
		if (failNext) {
			const error = failNext;
			failNext = null;
			return Promise.reject(error);
		}
		return new Promise<void>((resolve) => {
			if (opts.holdSends) waiting.push(resolve);
			else resolve();
		});
	};

	const deps: LiveSenderDeps<unknown> = {
		send,
		now: clock.now,
		setTimer: clock.setTimer,
		clearTimer: clock.clearTimer,
		...(opts.intervalMs !== undefined ? { intervalMs: opts.intervalMs } : {}),
	};
	const sender: LiveSender<unknown> = createLiveSender(deps);

	return {
		sender,
		sent,
		clock,
		failNextWith: (error: Error) => (failNext = error),
		/** Resolves the oldest unreleased send (when holdSends is on). */
		release: async () => {
			waiting.shift()?.();
			await breathe();
		},
		runningSends: (): number => waiting.length,
	};
}

test("the first push after idle sends immediately (leading send)", async () => {
	const h = senderSetup();
	h.sender.push("a");
	assert.deepEqual(h.sent, ["a"]);
	await h.release();
	assert.equal(h.runningSends(), 0);
});

test("a value pushed while the send is in flight replaces the pending one, and only the latest goes out", async () => {
	const h = senderSetup({ holdSends: true });
	h.sender.push("a"); // leading send, in flight
	h.sender.push("b");
	h.sender.push("c");
	assert.deepEqual(h.sent, ["a"], "no second send while one is in flight");
	assert.equal(h.runningSends(), 1);
	await h.release();
	await h.clock.advance(200);
	assert.deepEqual(h.sent, ["a", "c"], "only the latest value was sent, exactly once");
});

test("the trailing send honours the interval on the fake clock", async () => {
	const h = senderSetup({ intervalMs: 125 });
	h.sender.push("a");
	assert.deepEqual(h.sent, ["a"]);
	h.sender.push("b"); // would be the 2nd send within 125 ms: must wait
	assert.deepEqual(h.sent, ["a"]);
	await h.clock.advance(124);
	assert.deepEqual(h.sent, ["a"], "not before the interval elapsed");
	await h.clock.advance(1);
	assert.deepEqual(h.sent, ["a", "b"]);
});

test("sends never overlap: nothing new starts until the in-flight send settles", async () => {
	const h = senderSetup({ holdSends: true });
	h.sender.push("a"); // in flight, held by the test
	h.sender.push("b");
	h.sender.push("c");
	await h.clock.advance(1000);
	assert.deepEqual(h.sent, ["a"], "a full second passes and still nothing overlaps");
	await h.release();
	await h.clock.advance(200);
	assert.deepEqual(h.sent, ["a", "c"], "after it settles, exactly one trailing send of the latest value");
});

test("a failing send is kept, never thrown at push, and never blocks the next one", async () => {
	const h = senderSetup();
	h.failNextWith(new Error("send blew up"));
	assert.doesNotThrow(() => h.sender.push("a")); // the rejected send must not propagate here
	await h.clock.advance(500);
	h.sender.push("b");
	await h.clock.advance(500);
	assert.deepEqual(h.sent, ["a", "b"], "the failure did not block the next push");
});

test("flush rejects with the kept error exactly once", async () => {
	const h = senderSetup();
	h.failNextWith(new Error("send blew up"));
	h.sender.push("a");
	await h.clock.advance(500);
	await assert.rejects(() => h.sender.flush(), /send blew up/);
	await h.sender.flush(); // surfaced once; a second flush is clean
});

test("flush sends the pending value now and resolves only after it settles", async () => {
	const h = senderSetup({ holdSends: true });
	h.sender.push("a"); // in flight
	h.sender.push("b"); // pending, replaces whatever came before
	let flushed = false;
	const flushing = h.sender.flush().then(() => (flushed = true));
	await breathe();
	assert.deepEqual(h.sent, ["a"], "flush first waits for the in-flight send");
	assert.equal(flushed, false, "flush does not resolve while a send is pending");
	await h.release(); // the in-flight send settles; flush now sends the pending value
	await breathe();
	assert.deepEqual(h.sent, ["a", "b"], "the pending value went out");
	assert.equal(flushed, false, "flush is still waiting for that send to settle");
	await h.release(); // it settles
	await flushing;
	assert.equal(flushed, true, "flush resolves only after the send settled");
});

test("flush with nothing pending and no send in flight resolves immediately", async () => {
	const h = senderSetup();
	await h.sender.flush();
	h.sender.push("a");
	await h.clock.advance(200);
	await h.sender.flush();
	assert.deepEqual(h.sent, ["a"]);
});

test("cancel drops the pending value, clears the timer, and still sends nothing after", async () => {
	const h = senderSetup({ holdSends: true });
	h.sender.push("a"); // in flight
	h.sender.push("b"); // pending
	let done = false;
	const cancelling = h.sender.cancel().then(() => (done = true));
	await breathe();
	assert.equal(done, false, "cancel waits for the in-flight send");
	await h.release();
	await cancelling;
	assert.equal(h.clock.pendingTimers(), 0, "the trailing timer was cleared");
	await h.clock.advance(1000);
	assert.deepEqual(h.sent, ["a"], "the pending value was dropped");
});

test("cancel waits for the in-flight send to settle, so a restore cannot be overtaken", async () => {
	const h = senderSetup({ holdSends: true });
	h.sender.push("a"); // in flight, held
	h.sender.push("b");
	let cancelDone = false;
	const cancelled = h.sender.cancel().then(() => (cancelDone = true));
	await breathe();
	assert.equal(cancelDone, false, "cancel does not resolve while a send is still in flight");
	await h.release();
	await cancelled;
	assert.equal(cancelDone, true);
	assert.deepEqual(h.sent, ["a"]);
	await h.clock.advance(1000);
	assert.deepEqual(h.sent, ["a"], "nothing was sent after cancel");
});
