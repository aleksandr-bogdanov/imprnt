import { test, expect } from "bun:test";
import { sessionToken, hostAlive } from "./client.ts";

// The whole point of the client is graceful degradation: when the warm host isn't running, a consumer
// must get a clean null (and fall back), never an exception. We point at a port with nothing on it.
test("sessionToken returns null when the host is down (no throw)", async () => {
  process.env.SESSION_HOST_PORT = "59999"; // nothing listening here
  const tok = await sessionToken("kleinanzeigen.de", 500);
  expect(tok).toBeNull();
});

test("hostAlive returns false when the host is down (no throw)", async () => {
  process.env.SESSION_HOST_PORT = "59999";
  expect(await hostAlive(500)).toBe(false);
});
