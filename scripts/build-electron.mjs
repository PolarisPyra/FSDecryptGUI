import { copyFile, mkdir, rm } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { spawn } from "node:child_process"

const root = dirname(fileURLToPath(new URL("../package.json", import.meta.url)))
const outDir = join(root, "dist-electron")

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

await rm(outDir, { recursive: true, force: true })
await run("tsc", ["-p", "tsconfig.electron.json"])
await mkdir(outDir, { recursive: true })
await copyFile(join(root, "src/electron/preload.cjs"), join(outDir, "preload.cjs"))
