import {readFileSync} from 'node:fs'
import {describe, expect, it} from 'vitest'
import {faviconHref, faviconSvg} from '../app/utils/favicon'

// The tab's icon in the workspace's colour (ORR-1104).
const favicon = readFileSync(new URL('../public/favicon.svg', import.meta.url), 'utf8')
const mark = (svg: string) => svg.slice(svg.indexOf('<g transform="translate(400 400)"'))

describe('faviconSvg', () => {
    it('draws public/favicon.svg\'s mark, so it follows the logo', () => {
        expect(mark(faviconSvg('#2563eb'))).toBe(mark(favicon).trim())
    })

    it('fills the tile with the workspace\'s colour', () => {
        expect(faviconSvg('#2563eb')).toContain('<rect width="800" height="800" rx="176" fill="#2563eb"/>')
    })

    it('keeps a colour from breaking out of its attribute', () => {
        expect(faviconSvg('red"/><script>x</script>')).not.toMatch(/<script|"\/>red/)
    })
})

describe('faviconHref', () => {
    it('is a data address that decodes to the SVG', () => {
        const href = faviconHref('#16a34a')
        expect(href.startsWith('data:image/svg+xml,')).toBe(true)
        expect(decodeURIComponent(href.slice('data:image/svg+xml,'.length))).toBe(faviconSvg('#16a34a'))
    })
})
