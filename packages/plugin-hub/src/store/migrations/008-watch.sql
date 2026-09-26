-- The one job row a hunt writes for its triage master.
--
-- A hunt runs as the hub's role, which holds no insert on `inbound`, and the
-- row has to land in the same transaction as the hunt's state, its notices and
-- its stamp. So the insert goes through a function owned by the role that
-- already writes the table, which is the door's, exactly as `hub_report` is,
-- and it is granted to the hub. It writes the row in the shape the door writes
-- a dispatched job: kind `job`, the provenance carrying the approval digest
-- and the return route, unprojected when the master has a chat, so the
-- runner's own gate admits it and the door projects it. True when the row is
-- new, so a replayed tick lands no second job and no second receipt.
create function hub_watch_job(job_id text, person_id text, agent_id text, task text, provenance jsonb)
returns boolean language plpgsql security definer set search_path = pg_catalog, public as $$
begin
  insert into public.inbound (id, person, agent, body, kind, source, log_ready)
  values (job_id, person_id, agent_id, task, 'job', provenance, false)
  on conflict (id) do nothing;
  if not found then
    return false;
  end if;
  insert into public.ledger_event (stream, subject, kind, actor)
  values ('inbound', job_id, 'received', 'door');
  return true;
end $$;
alter function hub_watch_job(text, text, text, text, jsonb) owner to hub_door;
revoke all on function hub_watch_job(text, text, text, text, jsonb) from public;
grant execute on function hub_watch_job(text, text, text, text, jsonb) to hub_hub;
