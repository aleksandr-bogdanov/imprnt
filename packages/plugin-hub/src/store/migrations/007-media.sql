-- The bytes of every attachment a person sent, beside the row that carries it.
--
-- The door saves a photo, a file or a voice note under its own state directory
-- and the row's body names that path. A runner on another machine has no such
-- file, and one database is the ledger, so the door writes the bytes here in
-- the same transaction as the receipt, and a runner elsewhere writes them into
-- its own person inbox before it feeds the row, checking the hash. Capped by
-- the door's own `door.media_max_bytes`, which it enforces before the save.
create table media (
  inbound_id text    not null references inbound (id),
  index      integer not null check (index >= 0),
  sha256     text    not null,
  kind       text    not null,
  name       text    not null,
  bytes      bytea   not null,
  primary key (inbound_id, index)
);

grant select, insert on media to hub_door;
grant select on media to hub_runner;
