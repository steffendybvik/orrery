
    -- What a login is and when it was made and last used (ORR-838), so App settings lists them with End on each. name is
    -- set on a phone's QR login; older logins have none of the three.
    ALTER TABLE logins ADD COLUMN name text;
    ALTER TABLE logins ADD COLUMN created_at text;
    ALTER TABLE logins ADD COLUMN last_used_at text;
