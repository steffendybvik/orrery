
    -- A message the owner's chat sent for them (ORR-397): `chat`, so it's shown as relayed.
    ALTER TABLE signals ADD COLUMN via TEXT;
