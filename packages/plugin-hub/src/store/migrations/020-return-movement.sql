-- Return movement reconciles only a sealed older retained source copy.
create function hub_move_copy_returnable(stale_in text, generation_in integer, conversation_in text, machine_in text, runner_in text)
returns boolean language sql stable security definer set search_path = pg_catalog, public as $$
  select exists (select 1 from public.move_copy cp join public.topic_move old on old.id = cp.move_id
    join public.conversation c on c.id = cp.conversation_id
    where cp.move_id = stale_in and cp.generation = generation_in and cp.kind = 'source_session_retained'
      and (cp.state = 'retained_stale' or (cp.state = 'cleanup_due' and cp.evidence ? 'archive_intent'))
      and cp.conversation_id = conversation_in and old.conversation_id = conversation_in
      and cp.machine = machine_in and old.source_machine = machine_in
      and cp.runner = runner_in and old.source_runner = runner_in and old.stage = 'active'
      and cp.placement_generation = old.source_generation and cp.placement_generation < c.placement_generation
      and c.machine is distinct from cp.machine and cp.native_session = old.snapshot ->> 'native_session'
      and old.manifest -> 'native' ->> 'native_session' = cp.native_session
      and old.manifest -> 'native_export' ->> 'native_session' = cp.native_session
      and old.manifest -> 'native' ->> 'native_manifest_digest' is not null);
$$;
revoke all on function hub_move_copy_returnable(text, integer, text, text, text) from public;
grant execute on function hub_move_copy_returnable(text, integer, text, text, text) to hub_runner, hub_door, hub_hub;

-- Journal the exact directory identities before moving any bytes. The archive is
-- retained, never deleted. A retry must name the same intent; another return move
-- may finish the old archive before claiming its now-free original location.
create function hub_move_copy_archive_intent(move_in text, runner_in text, inc_in text, stale_in text, generation_in integer, intent_in jsonb)
returns text language plpgsql security definer set search_path = pg_catalog, public as $$
declare m public.topic_move%rowtype; cp public.move_copy%rowtype; old public.topic_move%rowtype; c public.conversation%rowtype; planned jsonb;
begin
  if not public.hub_move_enter(move_in) then return 'unknown-move'; end if;
  select * into m from public.topic_move where id = move_in;
  if m.stage <> 'source_released' then return 'stage'; end if;
  if runner_in is distinct from m.dest_runner or not public.hub_move_runner_current(runner_in, inc_in, m.dest_machine) then return 'not-destination'; end if;
  select * into cp from public.move_copy where move_id = stale_in and kind = 'source_session_retained' and generation = generation_in for update;
  if not found or stale_in = move_in or not public.hub_move_copy_returnable(stale_in, generation_in, m.conversation_id, m.dest_machine, runner_in) then return 'copy-conflict'; end if;
  select * into c from public.conversation where id = m.conversation_id;
  if c.machine is distinct from m.source_machine or c.placement_generation <> m.source_generation or public.hub_agent_blocked(m.agent) then return 'placement-changed'; end if;
  if cp.evidence ? 'archive_intent' then
    if cp.evidence -> 'archive_intent' = intent_in then return 'replay'; end if;
    return 'intent-mismatch';
  end if;
  select * into old from public.topic_move where id = stale_in;
  if intent_in is null or jsonb_typeof(intent_in) <> 'object'
    or intent_in ->> 'native_digest' is distinct from old.manifest -> 'native' ->> 'native_manifest_digest'
    or intent_in ->> 'session_dir' is distinct from old.manifest -> 'native_export' -> 'from' ->> 'cwd'
    or jsonb_typeof(intent_in -> 'root') is distinct from 'object'
    or jsonb_typeof(intent_in -> 'archive_root') is distinct from 'object'
    or coalesce(intent_in ->> 'archive_dir', '') = ''
    then return 'intent-invalid'; end if;
  planned := cp.evidence || jsonb_build_object('archive_intent', intent_in,
    'retired', jsonb_build_object('by_move', m.id, 'runner', runner_in, 'incarnation', inc_in, 'at', now()));
  -- Reserve the entire eventual release receipt before any directory is moved.
  if not public.hub_move_bounded(planned || jsonb_build_object('removed', jsonb_build_object(
    'staging', cp.staging_id, 'removed', 'archived', 'archive', intent_in, 'retained', true, 'by', inc_in)), 8192) then return 'intent-invalid'; end if;
  update public.move_copy set state = 'cleanup_due', updated_at = now(), evidence = planned
    where move_id = stale_in and machine = cp.machine and kind = cp.kind and generation = cp.generation;
  return 'recorded';
end $$;
revoke all on function hub_move_copy_archive_intent(text, text, text, text, integer, jsonb) from public;
grant execute on function hub_move_copy_archive_intent(text, text, text, text, integer, jsonb) to hub_runner;
