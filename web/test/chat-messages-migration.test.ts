// The step that moves a chat's messages out of its JSON into rows of their own (ORR-1100, api/migrations/*/088.sql):
// those kept so far land as rows, by chat, and leave the chat's own JSON.
import {DatabaseSync} from 'node:sqlite'
import {describe, expect, it} from 'vitest'
import {migrate} from '../server/utils/db'

describe('the chat messages step', () => {
    it("moves each chat's messages into rows, and out of its JSON", () => {
        const db = new DatabaseSync(':memory:')
        migrate(db, ':memory:', 87)
        db.exec("INSERT INTO projects (id, name, key, created_by, created_at, updated_at) VALUES ('primes', 'primes', 'PRI', 'agent', 'x', 'x')")
        const kept = (id: string, messages: unknown[]) => JSON.stringify({id, project: 'primes', started_at: '2026-11-01T10:00:00.000Z', messages, issues: 'todo'})
        db.prepare('INSERT INTO chats (id, project, started_at, chat) VALUES (?, ?, ?, ?)').run('c1', 'primes', '2026-11-01T10:00:00.000Z', kept('c1', [
            {id: 3, from: 'owner', text: 'Hi', images: [], at: '2026-11-01T10:01:00.000Z'},
            {id: 5, from: 'claude', text: '', images: [], at: '2026-11-01T10:02:00.000Z', request: {setting: 'tint', from: null, to: 'blue', state: 'asked'}},
        ]))
        db.prepare('INSERT INTO chats (id, project, started_at, chat) VALUES (?, ?, ?, ?)').run('c2', 'primes', '2026-11-02T10:00:00.000Z', kept('c2', []))
        migrate(db, ':memory:', 88)
        const rows = db.prepare('SELECT chat, id, at, message FROM chat_messages ORDER BY id').all() as {chat: string, id: number, at: string, message: string}[]
        expect(rows.map(r => [r.chat, r.id, r.at])).toEqual([['c1', 3, '2026-11-01T10:01:00.000Z'], ['c1', 5, '2026-11-01T10:02:00.000Z']])
        expect(JSON.parse(rows[1]!.message).request).toEqual({setting: 'tint', from: null, to: 'blue', state: 'asked'})
        const chats = db.prepare('SELECT id, chat FROM chats ORDER BY id').all() as {id: string, chat: string}[]
        for (const chat of chats) expect(JSON.parse(chat.chat)).toEqual({id: chat.id, project: 'primes', started_at: expect.any(String), issues: 'todo'})
    })
})
