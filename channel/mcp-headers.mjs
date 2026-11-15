#!/usr/bin/env node
// The install line's `/mcp` entry's `headersHelper` (ORR-1102): Claude Code runs it as it connects to orrery's `/mcp`,
// and sends what it prints as the connection's headers. It finds the `claude` that started it, waits up to 5s for the
// headers that `claude`'s channel wrote (session-file.mjs), and adds this machine's key. Without them (no channel, or
// one too old to write them) it still says who's calling, without the session, so `/mcp` works but isn't tied to it.
import {authHeaders} from './credentials.mjs'
import {sessionHeaders} from './mcp-beside.mjs'
import {claudeWindow} from './session.mjs'
import {waitForSessionFile} from './session-file.mjs'

const base = (process.env.ORRERY_URL ?? 'http://localhost:9000').replace(/\/+$/, '')
const {pid} = claudeWindow()
const written = pid ? await waitForSessionFile(pid) : undefined
const person = process.env.ORRERY_PERSON?.trim() || undefined
process.stdout.write(JSON.stringify({...written ?? sessionHeaders({person}), ...authHeaders(base)}))
