import {describe, expect, it} from 'vitest'
import {baseFor} from '../app/utils/api'

// Where the page sends each API path (ORR-943): same-origin /api unless a prefix in `apiBases` says otherwise.
describe('the API base', () => {
    const bases = {'/projects/atlas/docs': 'https://api.example.com/api/', '/projects': 'http://127.0.0.1:9100/api', '/events': '/live'}

    it('stays on /api with nothing set, or nothing that matches', () => {
        expect(baseFor('/projects/atlas/issues', undefined)).toBe('/api')
        expect(baseFor('/projects/atlas/issues', {})).toBe('/api')
        expect(baseFor('/settings', bases)).toBe('/api')
    })

    it('takes the longest prefix the path is under, without its trailing slash', () => {
        expect(baseFor('/projects/atlas/docs', bases)).toBe('https://api.example.com/api')
        expect(baseFor('/projects/atlas/docs/readme', bases)).toBe('https://api.example.com/api')
        expect(baseFor('/projects/atlas/docs?q=x', bases)).toBe('https://api.example.com/api')
        expect(baseFor('/projects/atlas/issues', bases)).toBe('http://127.0.0.1:9100/api')
        expect(baseFor('/events?patch=1', bases)).toBe('/live')
    })

    it('matches whole segments only, and ignores a prefix that isn\'t a path', () => {
        expect(baseFor('/projects-archive', bases)).toBe('/api')
        expect(baseFor('/projects/atlas/docsx', bases)).toBe('http://127.0.0.1:9100/api')
        expect(baseFor('/settings', {settings: 'https://elsewhere/api'})).toBe('/api')
    })
})
