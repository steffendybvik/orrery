import {execFileSync} from 'node:child_process'
import {mkdtempSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {describe, expect, it} from 'vitest'
// @ts-expect-error: the launcher is plain JavaScript, run by node on the host
import {plist, readConfig, systemdUnit, withProject, withoutProject} from '../../channel/launcher-service.mjs'

const larder = {url: 'http://localhost:9000', project: 'larder', dir: '/code/larder'}
const opts = {node: '/opt/homebrew/bin/node', script: '/code/orrery/channel/orrery-launcher.mjs', path: '/opt/homebrew/bin:/usr/bin', log: '/Users/me/Library/Logs/orrery-launcher.log'}

describe("the launcher's list", () => {
    it('has each project of each Orrery once, in the repo it was last installed from', () => {
        let config = withProject({projects: []}, larder)
        config = withProject(config, {...larder, dir: '/moved/larder'})
        config = withProject(config, {...larder, url: 'http://localhost:9010'})
        expect(config.projects).toEqual([{...larder, dir: '/moved/larder'}, {...larder, url: 'http://localhost:9010'}])
        expect(withoutProject(config, larder).projects).toEqual([{...larder, url: 'http://localhost:9010'}])
    })

    it('is empty when its file is missing or broken', () => {
        const dir = mkdtempSync(join(tmpdir(), 'orrery-launcher-'))
        expect(readConfig(join(dir, 'none.json'))).toEqual({projects: []})
        writeFileSync(join(dir, 'broken.json'), '{')
        expect(readConfig(join(dir, 'broken.json'))).toEqual({projects: []})
        writeFileSync(join(dir, 'ok.json'), JSON.stringify({projects: [larder]}))
        expect(readConfig(join(dir, 'ok.json'))).toEqual({projects: [larder]})
    })
})

describe("the service's file", () => {
    it('runs the launcher for the list, with the PATH it was installed from, back if it dies', () => {
        const file = plist({...opts, path: '/a & b:/usr/bin'})
        expect(file).toContain('<string>/code/orrery/channel/orrery-launcher.mjs</string><string>--service</string>')
        expect(file).toContain('<string>/a &amp; b:/usr/bin</string>')
        expect(file).toContain('<key>SuccessfulExit</key><false/>')
        if (process.platform === 'darwin') {
            const at = join(mkdtempSync(join(tmpdir(), 'orrery-launcher-')), 'orrery.launcher.plist')
            writeFileSync(at, file)
            expect(execFileSync('plutil', ['-lint', at], {encoding: 'utf8'})).toContain('OK')
        }
        expect(systemdUnit({...opts, path: '/my "bin"'})).toContain('ExecStart="/opt/homebrew/bin/node" "/code/orrery/channel/orrery-launcher.mjs" --service\nEnvironment="PATH=/my \\"bin\\""\nRestart=on-failure')
    })
})
