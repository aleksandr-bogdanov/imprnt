// Test infrastructure: a finding as a reader of the record sees it.
//
// THE TESTS' OWN COPY, deliberately, for the reason `units.ts` gives about the
// prefixes: an oracle that imported the shape under test would agree with every
// build, including one that renamed a field away.
export interface Finding {
  id: string;
  kind: string;
  subject: string;
  machine: string;
  says: string;
  fix: string;
}
