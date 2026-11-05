
    -- How often each feature got used, a row a day (ORR-881), to find what goes unused: the owner's own use alone, only
    -- once they turn counting on (count_use, off by default). A count, nothing about who or what. Rows over a year go.
    CREATE TABLE feature_use (
        feature TEXT NOT NULL,
        day TEXT NOT NULL,
        count INTEGER NOT NULL,
        PRIMARY KEY (feature, day)
    );
