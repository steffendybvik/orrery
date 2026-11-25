    -- Whose session a record is (ORR-1402): the credential's person when the Nuxt server records it. The rails count a
    -- record's chat and project only for that person, so naming another person's session id gets nothing of it. One
    -- kept before this step has none, and counts only with login off.
    ALTER TABLE session_records ADD COLUMN person TEXT;
