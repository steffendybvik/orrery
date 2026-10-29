import {readFileSync} from 'node:fs'
import {fileURLToPath} from 'node:url'
import tailwindcss from '@tailwindcss/vite'

// The version a release sets in package.json, shown at the foot of the sidebar.
const {version} = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as {version: string}

export default defineNuxtConfig({
    compatibilityDate: '2026-10-01',
    devtools: {enabled: false},
    // A local, single-user board: the page is drawn in the browser and fed by /api.
    ssr: false,
    devServer: {port: 9000},

    css: ['~/assets/css/main.css'],

    vite: {
        plugins: [tailwindcss()],
    },

    runtimeConfig: {
        // Where the projects, chunks, issues and comments live: a SQLite file (from web/, so in the repo's own
        // .data), or a postgres:// URL. Override with NUXT_DATABASE.
        database: '../.data/orrery.db',
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
        // In Docker, the address compose publishes orrery on (ORRERY_HOST): moving the database and setting backups
        // from the app need it to be loopback, as the container can't tell who's connecting. Compose sets NUXT_LISTEN_HOST.
        listenHost: '',
        // A Postgres database's URL for the backups, in place of the folder (ORR-427). Compose sets NUXT_BACKUP_DATABASE
        // from ORRERY_BACKUP_DATABASE.
        backupDatabase: '',
        // Encrypts the secrets agents use without seeing (a long random string; without it there are none).
        // Override with NUXT_SECRET_KEY (ORRERY_SECRET_KEY in compose).
        secretKey: '',
        public: {
            // Where this repo is on the machine, for the channel setup the Connect page hands out.
            // Override with NUXT_PUBLIC_REPO_DIR (compose sets it).
            repoDir: '',
            // Which orrery this is, each its own server and database (`personal`, `work`, …): a chip by
            // the name, and the start of every tab's title. Override with NUXT_PUBLIC_ENVIRONMENT.
            environment: 'personal',
            version,
        },
    },

    // The channel's own code (`#channel`), bundled into the server, so the context view (ORR-549) shows what the channel
    // sends from the same code.
    alias: {'#channel': fileURLToPath(new URL('../channel', import.meta.url))},

    // docs/API.md is served to agents (/api/guide, /llms-full.txt).
    nitro: {
        serverAssets: [{baseName: 'docs', dir: fileURLToPath(new URL('../docs', import.meta.url))}],
        externals: {inline: [fileURLToPath(new URL('../channel', import.meta.url))]},
    },

    app: {
        head: {
            title: 'orrery',
            meta: [{name: 'description', content: 'Where every app project stands'}],
            link: [
                {rel: 'icon', href: '/favicon.ico', sizes: '32x32'},
                {rel: 'icon', type: 'image/svg+xml', href: '/favicon.svg'},
                {rel: 'apple-touch-icon', href: '/apple-touch-icon.png'},
                {rel: 'manifest', href: '/site.webmanifest'},
                {rel: 'preconnect', href: 'https://fonts.googleapis.com'},
                {rel: 'preconnect', href: 'https://fonts.gstatic.com', crossorigin: ''},
                {
                    rel: 'stylesheet',
                    href: 'https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600;700&family=Geist+Mono:wght@400;500&display=swap',
                },
            ],
            // Sets the theme before the first paint, so a light page doesn't flash dark.
            script: [{
                tagPosition: 'head',
                innerHTML: `(()=>{let t='system';try{t=localStorage.getItem('orrery-theme')||t}catch{}const d=t==='dark'||(t==='system'&&!matchMedia('(prefers-color-scheme: light)').matches);document.documentElement.classList.toggle('dark',d)})()`,
            }],
        },
    },
})
