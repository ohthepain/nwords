declare module "unbzip2-stream" {
	import type { Transform } from "node:stream"
	export default function bz2(): Transform
}
