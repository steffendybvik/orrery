// Written by test/rust-migrations.test.ts from api/migrations (ORR-931): don't edit it, run that.
// The Rust API's steps after the frozen ones in sqlite.ts and postgres.ts, for this server to run without the binary.

/** SQLite's steps after sqlite.ts's. */
export const SQLITE_FROM_API: string[] = [
    "\n    -- A chat's messages as rows of their own (ORR-1100), the API giving each its id, so a request the chat asks or the\n    -- owner answers is a row the API writes rather than a change to the whole chat. The message is kept as the page\n    -- reads it, as JSON. Those kept in each chat's JSON so far move here, and leave it.\n    CREATE TABLE chat_messages (\n        chat TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,\n        id INTEGER NOT NULL,\n        at TEXT NOT NULL,\n        message TEXT NOT NULL,\n        PRIMARY KEY (chat, id)\n    );\n    INSERT OR IGNORE INTO chat_messages (chat, id, at, message)\n        SELECT chats.id, json_extract(m.value, '$.id'), COALESCE(json_extract(m.value, '$.at'), chats.started_at), m.value\n        FROM chats, json_each(chats.chat, '$.messages') AS m\n        WHERE json_type(m.value, '$.id') = 'integer';\n    UPDATE chats SET chat = json_remove(chat, '$.messages');\n",
]

/** Postgres's steps after postgres.ts's. */
export const POSTGRES_FROM_API: string[] = [
    "\n    -- A chat's messages as rows of their own (ORR-1100), the API giving each its id, so a request the chat asks or the\n    -- owner answers is a row the API writes rather than a change to the whole chat. The message is kept as the page\n    -- reads it, as JSON. Those kept in each chat's JSON so far move here, and leave it.\n    CREATE TABLE chat_messages (\n        chat text NOT NULL REFERENCES chats(id) ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE,\n        id integer NOT NULL,\n        at text NOT NULL,\n        message text NOT NULL,\n        PRIMARY KEY (chat, id)\n    );\n    INSERT INTO chat_messages (chat, id, at, message)\n        SELECT chats.id, (m.value ->> 'id')::integer, COALESCE(m.value ->> 'at', chats.started_at), m.value::text\n        FROM chats, jsonb_array_elements(COALESCE(chats.chat::jsonb -> 'messages', '[]'::jsonb)) AS m(value)\n        WHERE jsonb_typeof(m.value -> 'id') = 'number'\n        ON CONFLICT DO NOTHING;\n    UPDATE chats SET chat = (chat::jsonb - 'messages')::text;\n",
]
