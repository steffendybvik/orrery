import {fileURLToPath} from 'node:url'
import tailwindcss from '@tailwindcss/vite'

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
        // Host names Orrery answers to besides localhost and IP addresses, comma-separated (e.g. `orrery.lan`).
        // Override with NUXT_ALLOWED_HOSTS.
        allowedHosts: '',
        public: {
            // Where this repo is on the machine, for the channel setup the Connect page hands out.
            // Override with NUXT_PUBLIC_REPO_DIR (compose sets it).
            repoDir: '',
            // Which Orrery this is, each its own server and database (`personal`, `work`, …): a chip by
            // the name, and the start of every tab's title. Override with NUXT_PUBLIC_ENVIRONMENT.
            environment: 'personal',
        },
    },

    // docs/API.md is served to agents (/api/guide, /llms-full.txt).
    nitro: {
        serverAssets: [{baseName: 'docs', dir: fileURLToPath(new URL('../docs', import.meta.url))}],
    },

    app: {
        head: {
            title: 'Orrery',
            meta: [{name: 'description', content: 'Where every app project stands'}],
            link: [
                {rel: 'icon', type: 'image/svg+xml', href: '/favicon.svg'},
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
