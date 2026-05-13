export type ReadableByteSource = {
	name: string
	size: number
	read: (offset: number, length: number) => Promise<Uint8Array>
}

export function byteSourceFromFile(file: File): ReadableByteSource {
	return {
		name: file.name,
		size: file.size,
		read: async (offset, length) => new Uint8Array(await file.slice(offset, offset + length).arrayBuffer())
	}
}
