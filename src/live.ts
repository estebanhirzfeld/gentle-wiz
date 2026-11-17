/**
 * Throttled live sender: turns a stream of pushed values into at most 8 sends
 * per second (one every `intervalMs`, 125 by default) without ever overlapping
 * sends. Used by `/wiz pick` so dragging a bar does not flood the light.
 *
 * Pure and injectable: `send`, `now`, `setTimer` and `clearTimer` all come in,
 * so tests run on a fake clock with no timers and no network. Leading send
 * when idle, trailing send of ONLY the latest value, never two sends in
 * flight. A send that rejects is kept (surfaced once by `flush`) and never
 * blocks later pushes. `cancel()` drops the pending value and its timer and
 * waits for an in-flight send to settle, so whatever comes next (a restore)
 * cannot be overtaken.
 */

const DEFAULT_INTERVAL_MS = 125; // at most 8 sends per second

export interface LiveSenderDeps<T> {
	/** One send of one value. Rejecting is fine: the error is kept for flush. */
	send: (value: T) => Promise<void>;
	/** Minimum space between two send starts. Defaults to 125 ms. */
	intervalMs?: number;
	now?: () => number;
	setTimer?: (callback: () => void, ms: number) => unknown;
	clearTimer?: (handle: unknown) => void;
}

export interface LiveSender<T> {
	/** Records the latest value; sends it now if idle and due, else queues it for the trailing send. */
	push(value: T): void;
	/** Sends any pending value now and resolves once everything settled. Rejects with a kept send error, once. */
	flush(): Promise<void>;
	/** Drops the pending value and its timer and waits for an in-flight send to settle. */
	cancel(): Promise<void>;
}

export function createLiveSender<T>(deps: LiveSenderDeps<T>): LiveSender<T> {
	const send = deps.send;
	const intervalMs = deps.intervalMs ?? DEFAULT_INTERVAL_MS;
	const now = deps.now ?? ((): number => Date.now());
	const setTimer = deps.setTimer ?? ((callback: () => void, ms: number) => setTimeout(callback, ms));
	const clearTimer = deps.clearTimer ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));

	let pending: T | undefined;
	let hasPending = false;
	let inFlight: Promise<void> | null = null;
	let timer: unknown = null;
	let lastSendAt = Number.NEGATIVE_INFINITY;
	const errors: unknown[] = [];

	function clearScheduledTimer(): void {
		if (timer !== null) {
			clearTimer(timer);
			timer = null;
		}
	}

	async function run(value: T): Promise<void> {
		try {
			await send(value);
		} catch (error) {
			// A lost send is not fatal: keep it for flush and keep the sender alive.
			errors.push(error);
		}
	}

	function startSend(): void {
		const value = pending as T;
		pending = undefined;
		hasPending = false;
		clearScheduledTimer();
		lastSendAt = now();
		inFlight = run(value);
		void inFlight.then(() => {
			inFlight = null;
			pump();
		});
	}

	/** Sends the pending value now if the interval allows, else arms the trailing timer. */
	function pump(): void {
		if (!hasPending || inFlight) return;
		const elapsed = now() - lastSendAt;
		if (elapsed >= intervalMs) {
			startSend();
			return;
		}
		if (timer === null) timer = setTimer(pump, Math.max(0, intervalMs - elapsed));
	}

	return {
		push(value: T): void {
			pending = value;
			hasPending = true;
			if (inFlight) return; // the running send settles into pump(), which sends the latest value
			if (timer !== null) return; // trailing timer already armed; the pushed value replaced the pending one
			if (now() - lastSendAt >= intervalMs) startSend();
			else timer = setTimer(pump, Math.max(0, intervalMs - (now() - lastSendAt)));
		},

		async flush(): Promise<void> {
			clearScheduledTimer();
			while (hasPending || inFlight) {
				if (hasPending && !inFlight) startSend();
				if (inFlight) await inFlight;
			}
			if (errors.length > 0) {
				const error = errors[0];
				errors.length = 0; // surfaced once
				throw error;
			}
		},

		async cancel(): Promise<void> {
			pending = undefined;
			hasPending = false;
			clearScheduledTimer();
			errors.length = 0; // whatever a cancelled send failed with is moot: the caller restores next
			const flight = inFlight;
			if (flight) await flight;
		},
	};
}
