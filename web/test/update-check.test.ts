import {describe, expect, it} from 'vitest'
import type {EventEntry} from '../server/utils/event-log'
import {RELEASES, UpdateCheck, compareVersions, newerThan} from '../server/utils/update-check'

// A notice when a newer orrery is out (ORR-608): its releases on GitHub against the version running.
const release = (tag: string, more: {draft?: boolean, prerelease?: boolean} = {}) =>
    ({tag_name: tag, html_url: `https://github.com/steffendybvik/orrery/releases/tag/${tag}`, prerelease: tag.includes('-'), ...more})

describe('versions', () => {
    it('go in semver order, a pre-release before its release and its numbers as numbers', () => {
        const order = ['0.9.0', '1.0.0-alpha', '1.0.0-rc.2', '1.0.0-rc.9', '1.0.0-rc.13', '1.0.0-rc.14', '1.0.0', '1.0.1', '1.1.0-rc.1', '1.1.0']
        for (let i = 1; i < order.length; i++) expect(compareVersions(order[i - 1]!, order[i]!), `${order[i - 1]} < ${order[i]}`).toBeLessThan(0)
        expect(compareVersions('v1.0.0-rc.13', '1.0.0-rc.13')).toBe(0)
        expect(compareVersions('1.0.0-rc', '1.0.0-rc.1')).toBeLessThan(0)
        expect(compareVersions('dev', '1.0.0')).toBeNull()
    })
})

describe('the newest release past the one running', () => {
    it('is the highest, wherever GitHub lists it', () => {
        const releases = [release('v1.0.0-rc.14'), release('v1.0.0-rc.16'), release('v1.0.0-rc.15'), release('v1.0.0-rc.12')]
        expect(newerThan('1.0.0-rc.13', releases)).toEqual({version: '1.0.0-rc.16', url: releases[1]!.html_url})
    })

    it('is none when the one running is the newest, or newer', () => {
        expect(newerThan('1.0.0-rc.13', [release('v1.0.0-rc.13'), release('v1.0.0-rc.12')])).toBeNull()
        expect(newerThan('1.0.0-rc.14', [release('v1.0.0-rc.13')])).toBeNull()
    })

    it('leaves out drafts, and pre-releases for an orrery on a release', () => {
        expect(newerThan('1.0.0-rc.13', [release('v1.0.0-rc.14', {draft: true})])).toBeNull()
        expect(newerThan('1.0.0', [release('v1.1.0-rc.1'), release('v1.0.1')])).toMatchObject({version: '1.0.1'})
        expect(newerThan('1.0.0', [release('v1.1.0-rc.1')])).toBeNull()
        expect(newerThan('1.0.0-rc.13', [release('v1.0.0')])).toMatchObject({version: '1.0.0'})
    })

    it("skips a tag that isn't a version", () => {
        expect(newerThan('1.0.0-rc.13', [release('nightly'), release('v1.0.0-rc.14')])).toMatchObject({version: '1.0.0-rc.14'})
    })
})

describe('the check', () => {
    it("asks GitHub for orrery's releases and keeps the answer", async () => {
        const asked: string[] = []
        const check = new UpdateCheck('1.0.0-rc.13', async url => {
            asked.push(url)
            return Response.json([release('v1.0.0-rc.14')])
        }, () => {})
        expect(check.newer).toBeNull()
        expect(await check.check()).toMatchObject({version: '1.0.0-rc.14'})
        expect(asked).toEqual([RELEASES])
        expect(check.newer).toMatchObject({version: '1.0.0-rc.14'})
    })

    it('keeps what it knew when GitHub fails, and says so in the event log only', async () => {
        const noted: EventEntry[] = []
        let answer = (): Response => Response.json([release('v1.0.0-rc.14')])
        const check = new UpdateCheck('1.0.0-rc.13', async () => answer(), entry => noted.push(entry))
        await check.check()
        answer = () => new Response('rate limited', {status: 403})
        expect(await check.check()).toMatchObject({version: '1.0.0-rc.14'})
        answer = () => { throw new Error('offline') }
        expect(await check.check()).toMatchObject({version: '1.0.0-rc.14'})
        expect(noted.map(n => [n.level, n.kind, n.message])).toEqual([
            ['warn', 'update.failed', "Couldn't check for a newer orrery: GitHub answered 403"],
            ['warn', 'update.failed', "Couldn't check for a newer orrery: offline"],
        ])
    })
})
