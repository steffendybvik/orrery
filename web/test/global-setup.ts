// Before a unit run, the Rust API that `test/api.ts` starts for a test (ORR-1163): `cargo build` in api/, which takes a
// moment when it's built already. Skipped with ORRERY_API_BIN set (CI builds it in a step of its own) or with no cargo
// here, when a test that needs the API says so itself.
import {spawnSync} from 'node:child_process'
import {fileURLToPath} from 'node:url'

export default function setup() {
    if (process.env.ORRERY_API_BIN) return
    const built = spawnSync('cargo', ['build', '--quiet'], {cwd: fileURLToPath(new URL('../../api', import.meta.url)), stdio: 'inherit'})
    if ((built.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') {
        console.warn('[orrery] no cargo here, so the tests that run the Rust API fail: install Rust, or set ORRERY_API_BIN')
        return
    }
    if (built.status !== 0) throw new Error(`cargo build in api/ stopped (${built.status ?? built.signal})`)
}
