import { copyFile, mkdir, readdir, rm } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { spawn } from "node:child_process"

const root = dirname(fileURLToPath(new URL("../package.json", import.meta.url)))
const outDir = join(root, "dist-electron")
const electronSrc = join(root, "src/electron")
const isWatch = process.argv.includes("--watch")
const tscBin = join(root, "node_modules/.bin", process.platform === "win32" ? "tsc.cmd" : "tsc")

function run(command, args) {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, { cwd: root, stdio: "inherit", shell: process.platform === "win32" })
		child.on("exit", code => {
			if (code === 0) {
				resolve()
			} else {
				reject(new Error(`${command} ${args.join(" ")} exited with ${code}`))
			}
		})
		child.on("error", reject)
	})
}

async function electronEntries(directory) {
	const entries = await readdir(directory, { withFileTypes: true })
	const files = await Promise.all(
		entries.map(entry => {
			const target = join(directory, entry.name)
			return entry.isDirectory() ? electronEntries(target) : entry.name.endsWith(".ts") ? [target] : []
		})
	)
	return files.flat()
}

const electronBuildArgs = [
	"--target",
	"ES2022",
	"--lib",
	"ES2022",
	"--module",
	"NodeNext",
	"--moduleResolution",
	"NodeNext",
	"--strict",
	"--esModuleInterop",
	"--skipLibCheck",
	"--types",
	"node",
	"--rootDir",
	"src/electron",
	"--outDir",
	"dist-electron",
	...(isWatch ? ["--watch", "--preserveWatchOutput"] : []),
	...(await electronEntries(electronSrc))
]

if (!isWatch) {
	await rm(outDir, { recursive: true, force: true })
}

await mkdir(outDir, { recursive: true })
await copyFile(join(root, "src/electron/preload.cjs"), join(outDir, "preload.cjs"))
await run(tscBin, electronBuildArgs)
