
    -- The day a release's features froze: from then on it takes fixes, tests and docs, by preference.
    ALTER TABLE releases ADD COLUMN frozen_on TEXT;
