import {existsSync} from 'node:fs'
import {fileURLToPath} from 'node:url'
import {describe, expect, it} from 'vitest'
import {SYNCED, pointLinks, titleOf} from '../scripts/docs-sync-links'

// `pnpm docs:sync` (ORR-296): which files it copies, and how their links are pointed once they're a project's docs.
const repo = fileURLToPath(new URL('../..', import.meta.url))
const to = (path: string, image: boolean) => image ? `/api/uploads/${path}` : SYNCED[path] ? `/p/orrery/docs/${SYNCED[path]}` : path === 'LICENSE' ? `gh/${path}` : null

describe('docs:sync', () => {
    it('copies files the repo has', () => {
        for (const file of Object.keys(SYNCED)) expect(existsSync(`${repo}${file}`), file).toBe(true)
    })

    it('points links from the repo root and from docs/ at the doc pages, keeping the part', () => {
        expect(pointLinks('See [the API](docs/API.md#chats) and [it](CHANGELOG.md).', 'README.md', to))
            .toBe('See [the API](/p/orrery/docs/api#chats) and [it](/p/orrery/docs/changelog).')
        expect(pointLinks('[security](../SECURITY.md#bringing-in-what-others-wrote), [using](using.md)', 'docs/connect.md', to))
            .toBe('[security](/p/orrery/docs/security#bringing-in-what-others-wrote), [using](/p/orrery/docs/using)')
    })

    it('points other files where it is told, and leaves the rest as written', () => {
        expect(pointLinks('[MIT](LICENSE) [x](nowhere.md) [web](https://example.com/a.md) [part](#the-bell) [root](/p/x)', 'README.md', to))
            .toBe('[MIT](gh/LICENSE) [x](nowhere.md) [web](https://example.com/a.md) [part](#the-bell) [root](/p/x)')
    })

    it('points images, as tags or Markdown, but nothing in a code block', () => {
        expect(pointLinks('<img alt="The board" src="images/board-light.png">\n![Chat](images/chat.png)', 'docs/using.md', to))
            .toBe('<img alt="The board" src="/api/uploads/docs/images/board-light.png">\n![Chat](/api/uploads/docs/images/chat.png)')
        const fenced = '```md\n[the API](docs/API.md)\n```\n[the API](docs/API.md)'
        expect(pointLinks(fenced, 'README.md', to)).toBe('```md\n[the API](docs/API.md)\n```\n[the API](/p/orrery/docs/api)')
    })

    it('titles a doc by its first heading', () => {
        expect(titleOf('Intro\n# Running orrery\n\n## Docker', 'docs/running.md')).toBe('Running orrery')
        expect(titleOf('No heading', 'docs/running.md')).toBe('running')
    })
})
