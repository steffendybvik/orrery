
    -- A focus on an epic (ORR-987): one signal per project it has open issues in, narrowed to the epic's issues as a
    -- release narrows a milestone's. No key to the epic: deleting one leaves its old signals pointing at nothing.
    ALTER TABLE signals ADD COLUMN epic integer;
