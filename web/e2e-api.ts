// The Rust API for a browser run's server (ORR-1196): the board's data is the API's alone, and `nuxt dev` starts the
// repo's debug build beside itself only once there is one, so a fresh checkout's server answered 503 and Playwright
// waited out its timeout. Unless a binary or an API is named (CI hands its jobs the `api` job's), the server's command
// builds it first: quick once built, and again after a change in `api/`, so a run never meets a stale API.
const named = Boolean(process.env.NUXT_API_BIN || process.env.NUXT_API_URL)

/** What goes before `nuxt dev` in a webServer command. */
export const apiBuild = named ? '' : 'cargo build --quiet --manifest-path ../api/Cargo.toml && '

/** A webServer's timeout: room for a first build when it builds. */
export function serverTimeout(ms: number): number {
    return named ? ms : ms + 600_000
}
