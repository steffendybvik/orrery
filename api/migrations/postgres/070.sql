
    -- Whose words (ORR-658): the person on a comment, whether an agent of theirs wrote it, and the person a signal is
    -- for when it isn't the owner's. The owned flag stays the owner's alone. A member's own clears of the bell: the owner's
    -- stay in comments.cleared.
    ALTER TABLE comments ADD COLUMN person text;
    ALTER TABLE comments ADD COLUMN by_agent integer NOT NULL DEFAULT 0;
    ALTER TABLE signals ADD COLUMN person text;
    CREATE TABLE notice_clears (
        comment integer NOT NULL REFERENCES comments(id) ON DELETE CASCADE,
        person text NOT NULL REFERENCES people(id) ON UPDATE CASCADE,
        PRIMARY KEY (comment, person)
    );
