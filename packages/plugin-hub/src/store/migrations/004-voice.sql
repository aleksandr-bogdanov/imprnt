-- The row's own transcription state, five columns the door owns.
--
-- Every one of them is nullable or defaulted, so an insert that says nothing
-- about them is legal unchanged, and a row that predates this step reads five
-- nulls and a zero rather than being reopened.
alter table inbound add column media_state text
  check (media_state in ('pending', 'done', 'failed'));
alter table inbound add column media_attempts integer not null default 0
  check (media_attempts >= 0);
alter table inbound add column media_retry_at timestamptz;
alter table inbound add column media_failure jsonb;
alter table inbound add column media_done_at timestamptz;

-- The door writes the transcript into the message it belongs to, so it needs
-- the text and the provenance beside the step's own state.
grant update (body, source, media_state, media_attempts, media_retry_at,
              media_failure, media_done_at) on inbound to hub_door;

-- The fence, and the reason it is a trigger. A policy cannot see WHICH columns
-- an update touched, and the door already holds a permissive update policy for
-- the projection, which PostgreSQL ORs with any second one. So the rule lives
-- where a column comparison is possible: once a row has been shown to somebody,
-- its text, its provenance and the step's own state are closed. A transcript
-- can never rewrite a message a person has already read.
create function hub_guard_media_columns() returns trigger
language plpgsql as $$
begin
  if old.log_ready
     and (new.body is distinct from old.body
          or new.source is distinct from old.source
          or new.media_state is distinct from old.media_state
          or new.media_attempts is distinct from old.media_attempts
          or new.media_retry_at is distinct from old.media_retry_at
          or new.media_failure is distinct from old.media_failure
          or new.media_done_at is distinct from old.media_done_at)
  then
    raise exception
      'inbound has been shown to somebody: its text and its transcription state are closed (id %)',
      old.id;
  end if;
  return new;
end $$;

create trigger inbound_media_is_closed_once_shown before update on inbound
  for each row execute function hub_guard_media_columns();

-- What the transcription of one note cost, as a diary stream of its own. A
-- SECOND policy beside the door's clock one rather than a widening of it:
-- PostgreSQL ORs permissive policies, so this is purely additive and each
-- fence stays readable as the one sentence it is.
create policy ledger_event_door_media on ledger_event
  for insert to hub_door
  with check (actor = 'door' and stream = 'media'
    and kind in ('transcribe.started', 'transcribe.done', 'transcribe.failed'));
