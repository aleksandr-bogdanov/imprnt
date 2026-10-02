-- Explicit owner-authorized context reset. Old inputs remain excluded by the
-- existing execution predicate; an earlier queued continuation is gated separately.
alter table replay_hold drop constraint replay_hold_choice_check;
alter table replay_hold add constraint replay_hold_choice_check
  check (choice in ('continue', 'keep_held', 'fresh_context'));
grant update (native_session, native_state, placement_generation) on conversation to hub_door;

create or replace function hub_hold_choice(attempt_id text, agent_id text, expected_revision integer,
                                picked text, who text, proof jsonb, body text)
returns text language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  h public.replay_hold%rowtype;
begin
  -- Serialize with attempt opening before locking the hold or resetting native state.
  perform public.hub_gate_order(agent_id);
  select r.* into h from public.replay_hold r
    join public.execution e on e.id = r.execution_id
   where r.execution_id = attempt_id and e.agent = agent_id
   for update of r;
  if not found then return 'unknown-attempt'; end if;
  if picked not in ('continue', 'keep_held', 'fresh_context') then return 'invalid-choice'; end if;
  if h.revision <> expected_revision then return 'stale-revision'; end if;
  if h.state = 'released' then return 'closed'; end if;
  if picked = 'fresh_context' then
    -- A terminal label alone is insufficient: require positive process/descendant
    -- exit evidence, and exclude another active/uncertain execution of the agent.
    perform 1 from public.execution e where e.id = attempt_id
      and e.state in ('interrupted', 'stopped')
      and e.evidence -> 'exit' ->> 'confirmed' = 'true';
    if not found or public.hub_agent_blocked(agent_id) then return 'ownership-unresolved'; end if;
    -- Revoke an earlier queued continuation as part of choosing fresh context.
    -- A permanent row gate keeps it excluded even though this hold is released.
    if h.continuation_id is not null then
      perform public.hub_gate_place('fresh-context:' || attempt_id, 'row', h.continuation_id,
        'fresh-context', jsonb_build_object('attempt', attempt_id, 'by', who));
    end if;
    update public.conversation set native_session = gen_random_uuid()::text,
      native_state = 'new', placement_generation = placement_generation + 1
      where id = h.conversation_id;
    update public.replay_hold set choice = picked, chosen_by = who, chosen_at = now(), evidence = proof,
      state = 'released', revision = revision + 1, continuation_body = null, native_context = null, updated_at = now()
      where inbound_id = h.inbound_id;
    insert into public.ledger_event (stream, subject, kind, actor, detail)
    values ('execution', attempt_id, 'hold.choice', 'door',
      jsonb_build_object('choice', picked, 'by', who, 'revision', h.revision, 'inbound', h.inbound_id));
    return 'fresh_context';
  end if;
  if h.state = 'continuing' then return 'closed'; end if;
  update public.replay_hold
     set choice = picked, chosen_by = who, chosen_at = now(), evidence = proof,
         continuation_body = case when picked = 'continue' then body else null end,
         state = case when picked = 'continue' then 'continue_pending' else 'keep_held' end,
         updated_at = now()
   where inbound_id = h.inbound_id;
  insert into public.ledger_event (stream, subject, kind, actor, detail)
  values ('execution', attempt_id, 'hold.choice', 'door',
          jsonb_build_object('choice', picked, 'by', who, 'revision', h.revision, 'inbound', h.inbound_id));
  if picked = 'continue' then
    return hub_hold_advance(h.inbound_id);
  end if;
  return 'keep_held';
end $$;
alter function hub_hold_choice(text, text, integer, text, text, jsonb, text) owner to hub_door;
revoke all on function hub_hold_choice(text, text, integer, text, text, jsonb, text) from public;
grant execute on function hub_hold_choice(text, text, integer, text, text, jsonb, text)
  to hub_door, hub_runner, hub_hub;
