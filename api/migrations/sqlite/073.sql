
    -- Read notices (ORR-785): what its reader has opened, apart from what the bell has counted as seen. The owner's on the
    -- comment, as with clearing, and a member's their own. What came before counts as read, so an upgrade brings none back.
    ALTER TABLE comments ADD COLUMN was_read INTEGER NOT NULL DEFAULT 0;
    UPDATE comments SET was_read = 1;
    CREATE TABLE notice_reads (
        comment INTEGER NOT NULL REFERENCES comments(id) ON DELETE CASCADE,
        person TEXT NOT NULL REFERENCES people(id) ON UPDATE CASCADE,
        PRIMARY KEY (comment, person)
    );
