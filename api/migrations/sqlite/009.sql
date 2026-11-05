
    -- An agent's comment the owner cleared from the bell: it stays on its issue, out of the notices.
    ALTER TABLE comments ADD COLUMN cleared INTEGER NOT NULL DEFAULT 0;
