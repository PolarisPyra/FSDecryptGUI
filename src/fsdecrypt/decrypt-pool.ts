import { decryptFscryptPagesLocal } from "./crypto"

const MIN_WORKER_BYTES = Number.MAX_SAFE_INTEGER
const MAX_WORKERS = 0

type DecryptRequest = {
	id: number
	keyHex: string
	fileIv: number[]
	pageOffset: number
	pageSize: number
	encrypted: ArrayBuffer
}

type DecryptResponse = {
	id: number
	decrypted?: ArrayBuffer
	error?: string
}

type WorkerSlot = {
	worker: Worker
	busy: boolean
	current?: QueuedTask
}

type QueuedTask = {
	request: DecryptRequest
	resolve: (value: ArrayBuffer) => void
	reject: (error: Error) => void
}

/** Minimal task queue for browser Worker-based page decryption. */
class DecryptWorkerPool {
	private nextId = 1
	private readonly workers: WorkerSlot[]
	private readonly queue: QueuedTask[] = []

	constructor(size: number) {
		this.workers = Array.from({ length: size }, () => {
			const slot: WorkerSlot = {
				worker: new Worker(new URL("./decrypt-worker.ts", import.meta.url), { type: "module" }),
				busy: false
			}
			slot.worker.onmessage = (event: MessageEvent<DecryptResponse>) => this.handleMessage(slot, event.data)
			slot.worker.onerror = event => {
				const task = slot.current
				slot.current = undefined
				slot.busy = false
				task?.reject(new Error(event.message || "Decrypt worker failed"))
				this.assignNext()
			}
			return slot
		})
	}

	get size() {
		return this.workers.length
	}

	run(request: Omit<DecryptRequest, "id">) {
		return new Promise<ArrayBuffer>((resolve, reject) => {
			this.queue.push({ request: { ...request, id: this.nextId++ }, resolve, reject })
			this.assignNext()
		})
	}

	private handleMessage(slot: WorkerSlot, response: DecryptResponse) {
		const task = slot.current
		slot.current = undefined
		slot.busy = false

		if (!task || response.id !== task.request.id) {
			this.assignNext()
			return
		}

		if (response.error || !response.decrypted) {
			task.reject(new Error(response.error || "Decrypt worker returned no data"))
		} else {
			task.resolve(response.decrypted)
		}

		this.assignNext()
	}

	private assignNext() {
		const slot = this.workers.find(worker => !worker.busy)
		const task = this.queue.shift()
		if (!slot || !task) {
			return
		}

		slot.busy = true
		slot.current = task
		slot.worker.postMessage(task.request, [task.request.encrypted])
	}
}

let pool: DecryptWorkerPool | undefined

/** Returns the configured browser worker count; zero keeps decryption inline. */
function workerCount() {
	return 0
}

function decryptPool() {
	if (!pool) {
		const size = workerCount()
		pool = size > 0 ? new DecryptWorkerPool(size) : undefined
	}

	return pool
}

function transferableBuffer(bytes: Uint8Array): ArrayBuffer {
	if (bytes.buffer instanceof ArrayBuffer) {
		return bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
			? bytes.buffer
			: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
	}

	const copy = new Uint8Array(bytes.byteLength)
	copy.set(bytes)
	return copy.buffer
}

/** Reports the active worker count so the UI can log the selected decrypt path. */
export function getDecryptWorkerCount() {
	return decryptPool()?.size ?? 0
}

/** Decrypts fscrypt pages, using workers only when the pool is enabled and the range is large enough. */
export async function decryptFscryptPages(
	keyHex: string,
	fileIv: Uint8Array,
	firstPageOffset: number,
	encrypted: Uint8Array,
	pageSize: number
) {
	const activePool = decryptPool()
	if (!activePool || encrypted.length < MIN_WORKER_BYTES) {
		return decryptFscryptPagesLocal(keyHex, fileIv, firstPageOffset, encrypted, pageSize)
	}

	const pageCount = Math.ceil(encrypted.length / pageSize)
	const taskCount = Math.min(activePool.size, pageCount)
	const pagesPerTask = Math.ceil(pageCount / taskCount)
	const decrypted = new Uint8Array(encrypted.length)

	await Promise.all(
		Array.from({ length: taskCount }, async (_, taskIndex) => {
			const startPage = taskIndex * pagesPerTask
			const endPage = Math.min(pageCount, startPage + pagesPerTask)
			if (startPage >= endPage) {
				return
			}

			const byteStart = startPage * pageSize
			const byteEnd = Math.min(encrypted.length, endPage * pageSize)
			const encryptedSlice = encrypted.slice(byteStart, byteEnd)
			const result = await activePool.run({
				keyHex,
				fileIv: Array.from(fileIv),
				pageOffset: firstPageOffset + byteStart,
				pageSize,
				encrypted: transferableBuffer(encryptedSlice)
			})
			decrypted.set(new Uint8Array(result), byteStart)
		})
	)

	return decrypted
}
