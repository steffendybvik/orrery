
    -- The API's fields are snake_case, as the columns are: the orrery's own prompt settings follow.
    UPDATE settings SET key = 'focus_prompt' WHERE key = 'focusPrompt';
    UPDATE settings SET key = 'chunk_prompt' WHERE key = 'chunkPrompt';
