alter table inbound add column source jsonb;
alter table inbound add column log_ready boolean not null default true;
alter table outbox add column route jsonb;
alter table outbox add column delivery_state text not null default 'pending'
  check (delivery_state in ('pending', 'delivered', 'failed'));
alter table outbox add column attempts integer not null default 0 check (attempts >= 0);
alter table outbox add column retry_at timestamptz;
alter table outbox add column failure jsonb;
update outbox set delivery_state = 'delivered' where delivered_at is not null;

grant update (log_ready) on inbound to hub_door;
create policy inbound_door_projects on inbound
  for update to hub_door using (true) with check (true);
grant update (route, delivery_state, attempts, retry_at, failure) on outbox to hub_door;

create function hub_guard_outbox_route() returns trigger
language plpgsql as $$
begin
  if new.route is distinct from old.route
     and (old.route is not null or old.attempts > 0 or old.delivered_at is not null)
  then
    raise exception 'outbox.route is pinned before delivery (id %)', old.id;
  end if;
  return new;
end $$;
create trigger outbox_route_is_pinned before update of route on outbox
  for each row execute function hub_guard_outbox_route();

create or replace function hub_notify_work() returns trigger
language plpgsql as $$
begin
  if new.log_ready then
    perform pg_notify('hub_work', new.agent);
  end if;
  return null;
end $$;
create trigger inbound_projection_ready after update of log_ready on inbound
  for each row when (new.log_ready and not old.log_ready)
  execute function hub_notify_work();
