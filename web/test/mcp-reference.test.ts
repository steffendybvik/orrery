import {readFileSync, readdirSync} from 'node:fs'
import {join} from 'node:path'
import {describe, expect, it} from 'vitest'
import {MCP_ENV, MCP_ENV_INTERNAL} from '#shared/mcp'
import {mcpReference} from '../server/utils/mcp-reference'

// The MCP server tab on Connect against the channel's code, so a new tool or variable can't go unlisted (ORR-772).
const tool = (name: string) => mcpReference().groups.flatMap(group => group.tools).find(t => t.name === name)

describe('the MCP server reference', () => {
    it('places every tool in a group, each with one line', () => {
        const {groups} = mcpReference()
        expect(groups.map(group => group.title)).not.toContain('Other')
        for (const {tools} of groups) for (const {name, description} of tools) {
            expect(description, name).toMatch(/\S/)
            expect(description, name).not.toMatch(/\.\s+\S/)
        }
    })

    it('says who gets a tool, from what the channel gives each', () => {
        expect(tool('start_issue')).toMatchObject({work: true, chat: false, untrusted: false})
        expect(tool('comment')).toMatchObject({work: true, chat: true, untrusted: true})
        expect(tool('reply')).toMatchObject({work: false, chat: true, untrusted: false})
        expect(tool('github_issues')).toMatchObject({work: false, chat: true, untrusted: true})
    })

    it('marks what a work session asks for with more_tools by its group', () => {
        expect(tool('egress')?.work).toBe('secrets')
        expect(tool('events')?.work).toBe('debug')
        expect(tool('create_schedule')?.work).toBe('schedules')
    })

    it('lists what the chat asks the owner first', () => {
        expect(mcpReference().requests.map(r => r.name)).toEqual(expect.arrayContaining(['start_session', 'update_settings', 'create_schedule']))
    })

    it('accounts for every variable the channel names', () => {
        const dir = join(process.cwd(), '../channel')
        const named = new Set(readdirSync(dir).filter(file => file.endsWith('.mjs')).flatMap(file => readFileSync(join(dir, file), 'utf8').match(/ORRERY_[A-Z_]+/g) ?? []))
        const accounted = new Set([...MCP_ENV.map(v => v.name), ...MCP_ENV_INTERNAL])
        expect([...named].filter(name => !accounted.has(name))).toEqual([])
        expect([...accounted].filter(name => !named.has(name))).toEqual([])
    })
})
