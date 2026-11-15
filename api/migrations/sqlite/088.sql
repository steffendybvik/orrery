
    -- A chat's messages as rows of their own (ORR-1100), the API giving each its id, so a request the chat asks or the
    -- owner answers is a row the API writes rather than a change to the whole chat. The message is kept as the page
    -- reads it, as JSON. Those kept in each chat's JSON so far move here, and leave it.
    CREATE TABLE chat_messages (
        chat TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
        id INTEGER NOT NULL,
        at TEXT NOT NULL,
        message TEXT NOT NULL,
        PRIMARY KEY (chat, id)
    );
    INSERT OR IGNORE INTO chat_messages (chat, id, at, message)
        SELECT chats.id, json_extract(m.value, '$.id'), COALESCE(json_extract(m.value, '$.at'), chats.started_at), m.value
        FROM chats, json_each(chats.chat, '$.messages') AS m
        WHERE json_type(m.value, '$.id') = 'integer';
    UPDATE chats SET chat = json_remove(chat, '$.messages');
