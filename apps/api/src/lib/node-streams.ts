import { Readable } from "node:stream"

/** Bridge Web ReadableStream (fetch body) to Node Readable. */
export function nodeReadableFromWeb(body: ReadableStream<Uint8Array> | null): Readable {
	if (!body) {
		throw new Error("Response has no body")
	}
	return Readable.fromWeb(body as import("node:stream/web").ReadableStream)
}

/**
 * Line iterator over a Node Readable (file, HTTP body, etc.).
 * Avoids `readline.createInterface` + `for await` on web-backed streams, which can throw
 * `ERR_USE_AFTER_CLOSE` when the input ends or is destroyed mid-iteration.
 */
export async function* readLinesFromReadable(stream: Readable): AsyncGenerator<string> {
	stream.setEncoding("utf8")
	let buf = ""
	for await (const chunk of stream) {
		const s = typeof chunk === "string" ? chunk : chunk.toString("utf8")
		buf += s
		while (true) {
			const idx = buf.indexOf("\n")
			if (idx === -1) break
			yield buf.slice(0, idx).replace(/\r$/, "")
			buf = buf.slice(idx + 1)
		}
	}
	if (buf.length > 0) {
		yield buf.replace(/\r$/, "")
	}
}
