    -- A board marked as moved (ORR-1225): the address of the orrery it was uploaded to, set by the owner on its Settings.
    -- While it's set, the rails refuse every write a request makes to the board with a 409 saying where it went; reads
    -- still work. Clearing it lifts that.
    ALTER TABLE projects ADD COLUMN moved_to text;
