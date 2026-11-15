
    -- A chat's messages as rows of their own (ORR-1100), the API giving each its id, so a request the chat asks or the
    -- owner answers is a row the API writes rather than a change to the whole chat. The message is kept as the page
    -- reads it, as JSON. Those kept in each chat's JSON so far move here, and leave it.
    CREATE TABLE chat_messages (
        chat text NOT NULL REFERENCES chats(id) ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE,
        id integer NOT NULL,
        at text NOT NULL,
        message text NOT NULL,
        PRIMARY KEY (chat, id)
    );
    INSERT INTO chat_messages (chat, id, at, message)
        SELECT chats.id, (m.value ->> 'id')::integer, COALESCE(m.value ->> 'at', chats.started_at), m.value::text
        FROM chats, jsonb_array_elements(COALESCE(chats.chat::jsonb -> 'messages', '[]'::jsonb)) AS m(value)
        WHERE jsonb_typeof(m.value -> 'id') = 'number'
        ON CONFLICT DO NOTHING;
    UPDATE chats SET chat = (chat::jsonb - 'messages')::text;
