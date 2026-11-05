
    -- An issue's own model and effort (ORR-868): a session for it starts on them, over its kind's. None follows its kind.
    ALTER TABLE issues ADD COLUMN model TEXT;
    ALTER TABLE issues ADD COLUMN effort TEXT;
