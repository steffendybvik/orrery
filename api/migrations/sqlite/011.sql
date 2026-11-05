
    -- An agent's comment that waits on the owner: a decision to make, or feedback to give.
    ALTER TABLE comments ADD COLUMN asks TEXT CHECK (asks IN ('decision', 'feedback'));
