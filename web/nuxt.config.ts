import {readFileSync} from 'node:fs'
import {fileURLToPath} from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import {bundleChannel} from './scripts/bundle-channel'
import {writeSpaLoading} from './scripts/spa-loading'

// The version a release sets in package.json, shown at the foot of the sidebar.
const {version} = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as {version: string}

const channelBundle = fileURLToPath(new URL('./.channel-bundle', import.meta.url))

// The start-up screen, made from the logo whenever the config loads (scripts/spa-loading.ts, ORR-815).
const spaLoading = writeSpaLoading(fileURLToPath(new URL('./.spa-loading.html', import.meta.url)), fileURLToPath(new URL('./public/favicon.svg', import.meta.url)))

export default defineNuxtConfig({
    hooks: {
        'build:before': () => bundleChannel(channelBundle, version),
    },

    compatibilityDate: '2026-10-01',
    devtools: {enabled: false},
    // A local, single-user board: the page is drawn in the browser and fed by /api.
    ssr: false,
    spaLoadingTemplate: spaLoading,
    // The host is always given (ORR-849): with none, nuxt 4.6.4 resolves it to `{}`, and the CLI's dev server stops on it
    // (`options.hostname.toLowerCase is not a function`). The dev container's HOST still wins. A checkout that already ran
    // into it keeps `{}` in node_modules/.cache/nuxt/dev-server.json, which the browser specs' servers clear first.
    // `127.0.0.1`, not `localhost`: in the CI image `localhost` binds `::1` alone, while Node's fetch of `localhost` goes
    // to `127.0.0.1`, so the specs' own requests from Node (the seed, `hold`) were refused there.
    devServer: {port: 9000, host: process.env.NUXT_HOST || process.env.NITRO_HOST || process.env.HOST || '127.0.0.1'},

    css: ['~/assets/css/fonts.css', '~/assets/css/main.css'],

    vite: {
        plugins: [tailwindcss()],
    },

    runtimeConfig: {
        // Where the projects, milestones, issues and comments live: a SQLite file (the repo's own .data, wherever the server
        // starts: ORR-596), or a postgres:// URL. Override with NUXT_DATABASE.
        database: fileURLToPath(new URL('../.data/orrery.db', import.meta.url)),
        // A folder to keep a copy of the database in (e.g. in iCloud Drive). Override with NUXT_BACKUP_DIR.
        backupDir: '',
        // Under Docker, what /data and /backup are on the computer: a folder (ORRERY_DATA, ORRERY_BACKUP) or a volume's
        // name, so App settings shows where they are there. Compose sets NUXT_DATA_HOST and NUXT_BACKUP_HOST.
        dataHost: '',
        backupHost: '',
        // Set (NUXT_BACKUP_CHOSEN, from compose) when ORRERY_BACKUP names a folder of the owner's, not the default: the
        // default stays on this computer, which App settings says (ORR-448).
        backupChosen: '',
        // Host names orrery answers to besides localhost and IP addresses, comma-separated (e.g. `orrery.lan`).
        // Override with NUXT_ALLOWED_HOSTS.
        allowedHosts: '',
        // Other sites whose pages may use the API from a browser, for orrery's frontend hosted there (ORR-667): exact
        // origins, comma-separated (`https://app.example.com`). None by default. Override with NUXT_ALLOWED_ORIGINS.
        allowedOrigins: '',
        // `off` serves the API alone, without the pages, for a frontend hosted elsewhere (ORR-667). Override with NUXT_PAGES.
        pages: '',
        // `off` stops anyone counting feature use on this server (ORR-881), whatever App settings says.
        // Override with NUXT_USAGE.
        usage: '',
        // In Docker, the address compose publishes orrery on (ORRERY_HOST): moving the database and setting backups
        // from the app need it to be loopback, as the container can't tell who's connecting. Compose sets NUXT_LISTEN_HOST.
        listenHost: '',
        // The address to open orrery at from a phone, when it's one orrery can't see for itself: an https name, a VPN's
        // (ORR-833). Shown in App settings with a QR code. Override with NUXT_PHONE_URL (ORRERY_PHONE_URL in compose).
        phoneUrl: '',
        // The phone's own port (ORR-837): a second listener that always asks for a login, so the address the sessions use
        // stays trusted. `phoneListen` is the port it listens on (ORRERY_PHONE_LISTEN, in the container 9001; outside it,
        // ORRERY_PHONE_PORT), `phonePort` the one it's published on and `phoneHost` the address (NUXT_PHONE_PORT and
        // NUXT_PHONE_HOST, which compose sets from ORRERY_PHONE_PORT and ORRERY_PHONE_HOST). Empty: no phone port.
        phoneListen: '',
        phonePort: '',
        phoneHost: '',
        // A Postgres database's URL for the backups, in place of the folder (ORR-427). Compose sets NUXT_BACKUP_DATABASE
        // from ORRERY_BACKUP_DATABASE.
        backupDatabase: '',
        // Encrypts the secrets agents use without seeing (a long random string; without it there are none).
        // Override with NUXT_SECRET_KEY (ORRERY_SECRET_KEY in compose).
        secretKey: '',
        // The Rust API (ORR-922, api/), which serves the board's data: its routes here are gone (ORR-1041), so this server
        // needs one. `apiBin`: its binary, which this server starts beside itself on its own database (NUXT_API_BIN, e.g.
        // ../api/target/release/orrery-api; the image sets it, and `nuxt dev` takes ../api/target/debug/orrery-api when
        // it's unset). Or one already running: `apiUrl` where it listens (http://127.0.0.1:9100) and `apiToken` the token
        // both are given (NUXT_API_URL, NUXT_API_TOKEN). Neither: the API's routes fail with a 503.
        apiBin: '',
        apiUrl: '',
        apiToken: '',
        // The swap (ORR-1034): on (NUXT_API_ONLY=1), the few routes the API serves that still have a route here for some
        // requests (a session's or the chat's new issue and edit, `here` in api-router.ts) are its alone too, so with it
        // down, not started yet or on another database they fail (503) instead of falling through. Every other route
        // the API serves fails that way whether it's on or not, as its route here is gone (ORR-1041).
        apiOnly: false,
        // Login and keys (ORR-664): `on` always asks for them; `off` never, for trying people out, and only on loopback.
        // Unset, they're on when the server is reachable from other machines or has a second person. Override with
        // NUXT_AUTH (ORRERY_AUTH in compose).
        auth: '',
        // Any standard OIDC provider, for logging in with no passwords in orrery. Override with NUXT_OIDC_ISSUER,
        // NUXT_OIDC_CLIENT_ID and NUXT_OIDC_CLIENT_SECRET (ORRERY_OIDC_… in compose).
        oidc: {issuer: '', clientId: '', clientSecret: ''},
        // Asks GitHub for orrery's releases at start and every 12 hours, for the sidebar's notice of a newer one
        // (ORR-608). Override with NUXT_UPDATE_CHECK=false (ORRERY_UPDATE_CHECK in compose).
        updateCheck: true,
        public: {
            // Where this repo is on the machine, for a default database in it.
            // Override with NUXT_PUBLIC_REPO_DIR (compose sets it).
            repoDir: '',
            // Which orrery this is, each its own server and database (`personal`, `work`, …): a chip by
            // the name, and the start of every tab's title. Override with NUXT_PUBLIC_ENVIRONMENT.
            environment: 'personal',
            // Where the page sends the API paths under a prefix instead of this server's /api (ORR-943): a JSON object
            // of prefix to base, e.g. {"/projects/atlas/docs": "https://api.example.com/api"}, or {"/": …} for every path,
            // as a frontend hosted on its own does (ORR-667). Empty: all same-origin.
            // Override with NUXT_PUBLIC_API_BASES. See docs/development.md (The Rust API) for what a base must allow.
            apiBases: {} as Record<string, string>,
            version,
        },
    },

    // The channel's own code (`#channel`), bundled into the server, so the context view (ORR-549) shows what the channel
    // sends from the same code.
    alias: {'#channel': fileURLToPath(new URL('../channel', import.meta.url))},

    // docs/API.md is served to agents (/api/guide, /llms-full.txt).
    // Nothing on the page loads from elsewhere by itself, so what an agent writes in Markdown can't send what it read to
    // another server just by being shown (ORR-748), fonts included, which orrery serves itself (ORR-766). A route with a policy of its own replaces this.
    routeRules: {
        '/**': {
            headers: {
                'Content-Security-Policy': "img-src 'self' data: blob:; media-src 'self' data: blob:; font-src 'self' data:; style-src 'self' 'unsafe-inline'; object-src 'none'",
                'X-DNS-Prefetch-Control': 'off',
            },
        },
    },
    nitro: {
        // Its files gzipped and brotli'd at build, served so to a browser that takes it; API answers are by a plugin (ORR-766).
        compressPublicAssets: true,
        // And the bundled channel, hook and launcher are served to the machines that run them (/channel, ORR-435).
        serverAssets: [
            {baseName: 'docs', dir: fileURLToPath(new URL('../docs', import.meta.url))},
            {baseName: 'channel', dir: channelBundle},
            // What an artifact is served with: Tailwind's browser build and the app's theme, one source for both (ORR-677).
            {baseName: 'tailwind-browser', dir: fileURLToPath(new URL('./node_modules/@tailwindcss/browser/dist', import.meta.url))},
            {baseName: 'app-css', dir: fileURLToPath(new URL('./app/assets/css', import.meta.url))},
        ],
        externals: {inline: [fileURLToPath(new URL('../channel', import.meta.url))]},
    },

    app: {
        head: {
            htmlAttrs: {lang: 'en'},
            title: 'orrery',
            meta: [{name: 'description', content: 'Where every app project stands'}],
            link: [
                {rel: 'icon', href: '/favicon.ico', sizes: '32x32'},
                {rel: 'icon', type: 'image/svg+xml', href: '/favicon.svg'},
                {rel: 'apple-touch-icon', href: '/apple-touch-icon.png'},
                {rel: 'manifest', href: '/site.webmanifest'},
                // Fetched with the page rather than once its stylesheet is read: nearly every page's text is in it (ORR-766).
                {rel: 'preload', href: '/fonts/geist-latin.woff2', as: 'font', type: 'font/woff2', crossorigin: ''},
            ],
            // Sets the theme before the first paint, so a light page doesn't flash dark.
            script: [{
                tagPosition: 'head',
                innerHTML: `(()=>{let t='system';try{t=localStorage.getItem('orrery-theme')||t}catch{}const d=t==='dark'||(t==='system'&&!matchMedia('(prefers-color-scheme: light)').matches);document.documentElement.classList.toggle('dark',d)})()`,
            }],
        },
    },
})
