-- The confirmation is the immutable message revision. Only a door that observed
-- its owner's reaction can enqueue delivery; runners can inspect but cannot send.
create table outbound_delivery (
  confirmation_id text primary key references confirmation(id) on delete cascade,
  door text not null,
  state text not null default 'queued' check (state in ('queued','sending','sent','uncertain')),
  attempt_id text,
  receipt jsonb,
  notified boolean not null default false,
  cause text,
  updated_at timestamptz not null default now()
);
grant select on outbound_delivery to hub_runner, hub_door, hub_hub;
grant insert, update on outbound_delivery to hub_door;

create table outbound_read (
  account text primary key,
  person text not null,
  config_hash text not null,
  next_at timestamptz not null default now(),
  hot_until timestamptz,
  findings jsonb not null default '[]',
  cause text,
  updated_at timestamptz not null default now()
);
grant select on outbound_read to hub_runner, hub_door, hub_hub;
grant insert, update on outbound_read to hub_door;
