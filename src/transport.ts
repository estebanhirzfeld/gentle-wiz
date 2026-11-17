/**
 * gentle-wiz transport: WiZ lights speak JSON in single UDP datagrams on port
 * 38899. One datagram out, one datagram back. Datagram loss is normal, so the
 * engine retries; this layer only does one attempt (1 s timeout) and one
 * broadcast collection window.
 *
 * Everything here is only wired in the extension; the engine takes `send` and
 * `broadcast` as injected deps, so tests never touch the network.
 */
import { createSocket } from "node:dgram";
import { networkInterfaces } from "node:os";

export const WIZ_PORT = 38899;

/** Sends one JSON datagram and waits for the JSON answer. Rejects on timeout or error. */
export function udpSend(json: object, ip: string, timeoutMs = 1000): Promise<object> {
	return new Promise((resolve, reject) => {
		const socket = createSocket("udp4");
		let settled = false;
		const finish = (settle: () => void): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			socket.close();
			settle();
		};
		const timer = setTimeout(
			() => finish(() => reject(new Error(`no answer within ${timeoutMs} ms from ${ip}`))),
			timeoutMs,
		);
		socket.on("message", (data) =>
			finish(() => {
				try {
					resolve(JSON.parse(data.toString("utf8")));
				} catch {
					reject(new Error(`${ip} sent a reply that is not JSON`));
				}
			}),
		);
		socket.on("error", (error) => finish(() => reject(error)));
		socket.send(Buffer.from(JSON.stringify(json)), WIZ_PORT, ip, (error) => {
			if (error) finish(() => reject(error));
		});
	});
}

export interface BroadcastAnswer {
	ip: string;
	reply: object;
}

/** The /24 broadcast of every IPv4 interface, plus the global 255.255.255.255. */
export function broadcastAddresses(): string[] {
	const addresses = new Set<string>(["255.255.255.255"]);
	for (const list of Object.values(networkInterfaces())) {
		for (const item of list ?? []) {
			const family = item.family;
			if (item.internal || (family !== 4 && family !== "ipv4") || !item.cidr) continue;
			const [ip, mask] = item.cidr.split("/");
			if (mask !== "24") continue;
			const octets = ip.split(".");
			addresses.set(`${octets[0]}.${octets[1]}.${octets[2]}.255`);
		}
	}
	return [...addresses];
}

/**
 * Broadcasts one JSON datagram and collects every answer that arrives within
 * timeoutMs, deduplicated by source ip. Broadcasts are best-effort: answers
 * that are lost are just lights that do not appear in the result.
 */
export function udpBroadcast(json: object, timeoutMs = 2000): Promise<BroadcastAnswer[]> {
	return new Promise((resolve) => {
		const socket = createSocket("udp4");
		const answers = new Map<string, object>();
		socket.on("error", () => {
			// A broadcast to an interface that cannot send must not crash discovery.
		});
		socket.on("message", (data, rinfo) => {
			if (answers.has(rinfo.address)) return;
			try {
				answers.set(rinfo.address, JSON.parse(data.toString("utf8")));
			} catch {
				// Not a WiZ light (or a lost fragment): ignore.
			}
		});
		socket.bind(() => {
			socket.setBroadcast(true);
			const payload = Buffer.from(JSON.stringify(json));
			for (const address of broadcastAddresses()) socket.send(payload, WIZ_PORT, address);
			setTimeout(() => {
				socket.close();
				resolve([...answers].map(([ip, reply]) => ({ ip, reply })));
			}, timeoutMs);
		});
	});
}
