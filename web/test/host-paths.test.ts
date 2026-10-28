import {describe, expect, it} from 'vitest'
import {onHost} from '../server/utils/host-paths'

describe('a path inside Docker, on the computer', () => {
    it('is the folder ORRERY_DATA names, the rest of the path after it', () => {
        expect(onHost('/data/orrery.db', '/data', '/Users/ada/orrery/', '/Users/ada/orrery')).toEqual({host: '/Users/ada/orrery/orrery.db'})
        expect(onHost('/backup', '/backup', '~/Library/Mobile Documents/com~apple~CloudDocs/orrery', '')).toEqual({host: '~/Library/Mobile Documents/com~apple~CloudDocs/orrery'})
    })

    it('reads a relative folder from the compose folder, as compose does', () => {
        expect(onHost('/data/orrery.db', '/data', './.playground/data', '/Users/ada/orrery')).toEqual({host: '/Users/ada/orrery/.playground/data/orrery.db'})
    })

    it('is a Docker volume when compose was given a name, not a folder', () => {
        expect(onHost('/data/orrery.db', '/data', 'orrery-data', '/Users/ada/orrery')).toEqual({volume: 'orrery-data'})
    })

    it('is unknown outside Docker, and for a path not under the mount', () => {
        expect(onHost('/Users/ada/orrery/.data/orrery.db', '/data', '', '')).toEqual({})
        expect(onHost('/database/other.db', '/data', '/Users/ada/orrery', '')).toEqual({})
        expect(onHost('/tmp/moved.db', '/data', 'orrery-data', '')).toEqual({})
    })
})
