// `check` opens every credential and asks whether it still
// works, a second copy of one is a finding, and a preset that names none is
// reported rather than refused.
//
// SPEC §6's Forbidden carries "a health check that does not open the
// credential" and "a copied credential". L10 rule 2: "check opens every
// credential and asks whether it still works. Blank, expired, unreadable, each
// a named finding. Presence is not health." Rule 1: "A copy anywhere is a
// finding, because the thing that owns the file rewrites it and copies
// diverge." The incident behind all of it: a login died, thirteen turns failed
// over 31 hours, and `check` was green throughout because it never opened the
// file.
//
// NO CHECK HERE REACHES A NETWORK. The two bot kinds answer with the platform's
// own identity call, which no check can make, so the prober is a seam in the
// style of `os` and `kernel` and a fixture stands in it. The one thing the REAL
// prober is asked to do below is open a FILE, which needs nothing.
//
// NOTHING HERE WRITES A SECRET ANYWHERE. Every planted credential carries an
// obviously fake token built at run time, every assertion about the copy
// finding is about a PATH, and the copy check asserts that the secret reaches
// neither the finding nor the sheet.
//
// THE CREDENTIAL FINDINGS ARE DRIVEN THROUGH `runCheck`, whose shape the seam
// contract pins (`credentials?: CredentialProber`), rather than through
// `credentialFindings(args)` and `copyFindings(args)`, whose argument shapes it
// deliberately leaves to the build. Both exports are still asserted to exist,
// so a build that never wrote them is red here.
//
// The measured `claude-login` file, by FIELD NAMES only, from the hub box on
// 2026-09-16 (mode 600, 971 bytes): `claudeAiOauth` carrying `accessToken`,
// `refreshToken`, `expiresAt`, `refreshTokenExpiresAt`, `scopes`,
// `subscriptionType` and `rateLimitTier`. On that box `expiresAt` is `0` while
// v2 answers real people off the same file, so the refresh token is what keeps
// a login alive and a rule that read `expiresAt` alone would report the working
// household dead.
//
// Red reasons: import missing, `src/check/credentials.ts`, for the first two,
// export missing, `copyFindings`, for the third, and behaviour absent for the
// fourth (`runCheck` reports nothing about credentials at all).

import { test, expect, beforeAll, afterAll } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startCluster, seam, type Cluster } from "./helpers/cluster.ts";
import { fakeProber, type CredentialHealth } from "./helpers/prober.ts";
import {
  AGENT,
  AGENT2,
  CHAT,
  DOOR,
  PERSON,
  PERSON2,
  stageHub,
  superStore,
} from "./helpers/hub-fixture.ts";

let cluster: Cluster;

const SLOW = 90_000;
const RUNNER_PI = "runner-pi";
const DOOR_TELEGRAM = "door-telegram";

interface Finding {
  id: string;
  kind: string;
  subject: string;
  machine: string;
  says: string;
  fix: string;
}

let dir: string;

beforeAll(async () => {
  cluster = await startCluster();
  dir = mkdtempSync(join(tmpdir(), "hub-credentials-check-"));
});

afterAll(async () => {
  if (cluster) await cluster.stop();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

/** A credential file under the scratch dir. The token is built at run time. */
function plantFile(name: string, body: string): string {
  const file = join(dir, name);
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, body, "utf8");
  return file;
}

function credentialFindings(findings: Finding[]): Finding[] {
  return findings.filter((one) => one.kind.startsWith("credential-"));
}

test(
  "RUN-17 a health check that does not open the credential is absent: four states of one login give four different findings and a healthy one gives none, every declared credential and every door's token file is opened exactly once, and a finding clears on the sheet when the credential is well again (SPEC §6 Forbidden, L10 rule 2)",
  async () => {
    const { realProber, credentialFindings: findingsOf } = await seam(
      "src/check/credentials.ts",
    );
    expect(typeof realProber).toBe("function");
    expect(typeof findingsOf).toBe("function");
    const { runCheck, CHECK_SHEET } = await seam("src/check/run.ts");

    const files = {
      blank: plantFile("four/blank.json", "{}"),
      expired: plantFile("four/expired.json", "{}"),
      unreadable: plantFile("four/unreadable.json", "{}"),
      healthy: plantFile("four/healthy.json", "{}"),
      telegram: plantFile("four/telegram.token", "a-token-built-by-the-check"),
      door: plantFile("four/door.token", "a-door-token-built-by-the-check"),
    };

    const it = await stageHub(cluster, {
      machines: [{ id: "pi", os: "linux" }],
      people: [
        { id: PERSON, language: "en" },
        { id: PERSON2, language: "en" },
      ],
      credentials: [
        { id: "login-blank", kind: "claude-login", file: files.blank, owner: "household" },
        { id: "login-expired", kind: "claude-login", file: files.expired, owner: "household" },
        {
          id: "login-unreadable",
          kind: "claude-login",
          file: files.unreadable,
          owner: "household",
        },
        { id: "login-healthy", kind: "claude-login", file: files.healthy, owner: "household" },
        { id: "bot-telegram", kind: "telegram", file: files.telegram, owner: PERSON },
      ],
      preset: { credential: "login-healthy" },
      agents: [
        {
          id: AGENT2,
          person: PERSON2,
          preset: "daily",
          chat: `${CHAT}1`,
          door: DOOR_TELEGRAM,
          runner: RUNNER_PI,
        },
      ],
      run: [
        {
          id: DOOR,
          kind: "door",
          machine: "pi",
          platform: "fake",
          person: PERSON,
          token_file: "/dev/null",
          schedule: "always",
          memory_limit_mb: 192,
        },
        {
          id: DOOR_TELEGRAM,
          kind: "door",
          machine: "pi",
          platform: "telegram",
          person: PERSON2,
          token_file: files.door,
          schedule: "always",
          memory_limit_mb: 192,
        },
        {
          id: RUNNER_PI,
          kind: "runner",
          machine: "pi",
          schedule: "always",
          memory_limit_mb: 512,
          child_memory_limit_mb: 512,
        },
      ],
      registry: (base) => ({
        ...base,
        agents: (base.agents ?? []).map((agent) =>
          agent.id === AGENT ? { ...agent, runner: RUNNER_PI } : agent,
        ),
      }),
    });

    try {
      const store = await superStore(cluster, it.db);
      const answers: Record<string, CredentialHealth> = {
        "login-blank": { ok: false, kind: "blank", says: "the file holds no token at all" },
        "login-expired": {
          ok: false,
          kind: "expired",
          says: "its refresh token expired on 2026-09-01",
        },
        "login-unreadable": { ok: false, kind: "unreadable", says: "this is not JSON" },
        "login-healthy": { ok: true },
        "bot-telegram": {
          ok: false,
          kind: "refused",
          says: "the platform answered 401 Unauthorized",
        },
        // The door's token file is a credential without being an entry.
        // It is keyed by its FILE, because no id for it is pinned
        // anywhere and a guess would silently fall through to the fixture's
        // "nobody told me" answer.
        [files.door]: { ok: true },
      };
      const prober = fakeProber(answers);

      const found = credentialFindings(
        (await (runCheck as Function)({
          machine: "pi",
          registryFile: it.registryFile,
          store,
          os: null,
          kernel: null,
          credentials: prober,
        })) as Finding[],
      );
      const bySubject = new Map(found.map((one) => [`${one.kind}:${one.subject}`, one]));

      // --- four states, four DIFFERENT findings. A build that reported one
      //     finding for every unhealthy credential passes nothing here.
      for (const [id, kind] of [
        ["login-blank", "credential-blank"],
        ["login-expired", "credential-expired"],
        ["login-unreadable", "credential-unreadable"],
        ["bot-telegram", "credential-refused"],
      ] as [string, string][]) {
        const one = bySubject.get(`${kind}:${id}`);
        expect(one).toBeDefined();
        expect(one!.id).toBe(`pi/${kind}:${id}`);
        expect(one!.machine).toBe("pi");
        expect(one!.says).toContain(id);
        expect(one!.fix.length).toBeGreaterThan(0);
      }
      // The three file-shaped ones name the file and the kind, because that is
      // what a person has to go and look at.
      expect(bySubject.get("credential-blank:login-blank")!.says).toContain(files.blank);
      expect(bySubject.get("credential-blank:login-blank")!.says).toContain("claude-login");
      expect(bySubject.get("credential-blank:login-blank")!.fix).toContain(files.blank);
      // The refused one carries the platform's OWN sentence, which is the one
      // that needs a network in production and is why the seam exists.
      expect(bySubject.get("credential-refused:bot-telegram")!.says).toContain(
        "401 Unauthorized",
      );

      // --- the healthy one produces NO finding of any kind.
      expect(found.some((one) => one.subject === "login-healthy")).toBe(false);

      // --- THE ASSERTION THAT MAKES THE FORBIDDEN LINE A BEHAVIOUR. A `check`
      //     that produced the right findings out of a table it never opened
      //     passes everything above and fails this. It is the difference
      //     between reading the registry and opening the credential.
      const asked = prober.calls();
      for (const id of [
        "login-blank",
        "login-expired",
        "login-unreadable",
        "login-healthy",
        "bot-telegram",
      ]) {
        expect(asked.filter((one) => one.id === id).length).toBe(1);
      }
      // A door's `token_file` is a credential of the door's own platform kind,
      // so "opens every credential" reaches the two bot tokens with
      // no registry edit.
      const doorsAsked = asked.filter((one) => one.file === files.door);
      expect(doorsAsked.length).toBe(1);
      expect(doorsAsked[0].kind).toBe("telegram");
      // THE PINNED ID: the contract says a door's token file is probed under
      // `door:<door id>`, so the check binds the id and not only the file. A
      // build that invented another id would report a finding whose subject no
      // household could match against its own registry.
      expect(doorsAsked[0].id).toBe(`door:${DOOR_TELEGRAM}`);
      // ITS CONTROL: a door whose platform is neither telegram nor discord is
      // NOT asked about, which is what keeps every fixture
      // (all of them `platform = "fake"`) free of a finding.
      expect(asked.some((one) => one.file === "/dev/null")).toBe(false);

      // --- the door's own finding carries that subject too. The prober is
      //     answered by FILE, so this needs no guess at the id, and the
      //     finding's subject is what a household reads.
      prober.setAnswer(files.door, {
        ok: false,
        kind: "refused",
        says: "the platform answered 401 Unauthorized for the door's token",
      });
      const withDoor = credentialFindings(
        (await (runCheck as Function)({
          machine: "pi",
          registryFile: it.registryFile,
          store,
          os: null,
          kernel: null,
          credentials: prober,
        })) as Finding[],
      );
      const doorFinding = withDoor.find((one) => one.subject === `door:${DOOR_TELEGRAM}`);
      expect(doorFinding).toBeDefined();
      expect(doorFinding!.kind).toBe("credential-refused");
      expect(doorFinding!.id).toBe(`pi/credential-refused:door:${DOOR_TELEGRAM}`);
      prober.setAnswer(files.door, { ok: true });

      // --- the clear, on the sheet as well as in the list.
      prober.setAnswer("login-blank", { ok: true });
      const after = credentialFindings(
        (await (runCheck as Function)({
          machine: "pi",
          registryFile: it.registryFile,
          store,
          os: null,
          kernel: null,
          credentials: prober,
        })) as Finding[],
      );
      expect(after.some((one) => one.subject === "login-blank")).toBe(false);
      expect(after.some((one) => one.subject === "login-expired")).toBe(true);
      const sheet = await it.read.sheet(String(CHECK_SHEET));
      expect(sheet.some((row) => row.id === "pi/credential-blank:login-blank")).toBe(false);
      expect(sheet.some((row) => row.id === "pi/credential-expired:login-expired")).toBe(true);

      await store.close();
    } finally {
      await it.stop();
    }

    // --- THE DEFAULT PROBER IS WIRED. Every
    //     assertion above injects a fake, so a `runCheck` that honoured an
    //     injected prober and otherwise only stat'ed the file would pass all of
    //     them while a household's real `check` stayed green through a dead
    //     login, which is L10's incident exactly. This stage passes NO prober,
    //     and it declares ONLY `claude-login` credentials and a `fake` door, so
    //     the default has nothing it could dial: the one thing it can do is
    //     open a file, which is all it does.
    const blank = plantFile("wired/blank.json", "{}");
    const live = plantFile(
      "wired/live.json",
      JSON.stringify({
        claudeAiOauth: {
          accessToken: `access-${crypto.randomUUID()}`,
          refreshToken: `refresh-${crypto.randomUUID()}`,
          expiresAt: 0,
          refreshTokenExpiresAt: Date.now() + 30 * 24 * 3_600_000,
        },
      }),
    );
    const wiredStage = await stageHub(cluster, {
      machines: [{ id: "pi", os: "linux" }],
      people: [{ id: PERSON, language: "en" }],
      credentials: [
        { id: "login-blank", kind: "claude-login", file: blank, owner: "household" },
        { id: "login-live", kind: "claude-login", file: live, owner: "household" },
      ],
      preset: { credential: "login-live" },
      run: [
        {
          id: DOOR,
          kind: "door",
          machine: "pi",
          platform: "fake",
          person: PERSON,
          token_file: "/dev/null",
          schedule: "always",
          memory_limit_mb: 192,
        },
        {
          id: RUNNER_PI,
          kind: "runner",
          machine: "pi",
          schedule: "always",
          memory_limit_mb: 512,
          child_memory_limit_mb: 512,
        },
      ],
      registry: (base) => ({
        ...base,
        agents: (base.agents ?? []).map((agent) => ({ ...agent, runner: RUNNER_PI })),
      }),
    });
    try {
      const store = await superStore(cluster, wiredStage.db);
      const started = Date.now();
      const found = credentialFindings(
        (await (runCheck as Function)({
          machine: "pi",
          registryFile: wiredStage.registryFile,
          store,
          os: null,
          kernel: null,
        })) as Finding[],
      );
      // The blank one is reported, by the reader `check` reaches for when
      // nobody hands it one.
      expect(
        found.some(
          (one) => one.kind === "credential-blank" && one.subject === "login-blank",
        ),
      ).toBe(true);
      // And the live one is NOT, so a default that called every file unhealthy
      // fails beside a default that called every file fine.
      expect(found.some((one) => one.subject === "login-live")).toBe(false);
      // Nothing was dialled: two files is not a network round trip.
      expect(Date.now() - started).toBeLessThan(5000);
      await store.close();
    } finally {
      await wiredStage.stop();
    }
  },
  SLOW,
);

test(
  "RUN-17 the shipped prober really opens the file and the expiry rule is the one the hub box measured: a file with expiresAt 0 and a live refresh token is HEALTHY, both expired routes are not, and a missing file is unreadable with nothing dialled (SPEC §6, L10 rule 2)",
  async () => {
    const { realProber } = await seam("src/check/credentials.ts");
    expect(typeof realProber).toBe("function");
    const prober = (realProber as Function)() as {
      open(entry: { id: string; kind: string; file: string; owner: string }): Promise<CredentialHealth>;
      secrets(entry: { id: string; kind: string; file: string; owner: string }): Promise<string[]>;
    };

    const hour = 3_600_000;
    const access = `access-${crypto.randomUUID()}`;
    const refresh = `refresh-${crypto.randomUUID()}`;
    const login = (body: Record<string, unknown>) => JSON.stringify(body);

    const cases: [string, string, string][] = [
      // [name, contents, expected kind or "ok"]
      ["real/missing.json", "", "unreadable"],
      ["real/not-json.json", "this is not JSON at all", "unreadable"],
      ["real/no-object.json", login({ mcpOAuth: {} }), "blank"],
      [
        "real/empty-tokens.json",
        login({ claudeAiOauth: { accessToken: "", refreshToken: "" } }),
        "blank",
      ],
      [
        "real/live.json",
        login({
          claudeAiOauth: {
            accessToken: access,
            refreshToken: refresh,
            expiresAt: 0,
            refreshTokenExpiresAt: Date.now() + 30 * 24 * hour,
            scopes: ["a", "b", "c", "d", "e"],
            subscriptionType: "max",
            rateLimitTier: "a-tier",
          },
        }),
        "ok",
      ],
      [
        "real/refresh-gone.json",
        login({
          claudeAiOauth: {
            accessToken: access,
            refreshToken: refresh,
            expiresAt: Date.now() + hour,
            refreshTokenExpiresAt: Date.now() - hour,
          },
        }),
        "expired",
      ],
      [
        "real/no-refresh-expiry.json",
        login({
          claudeAiOauth: {
            accessToken: access,
            refreshToken: refresh,
            expiresAt: Date.now() - hour,
          },
        }),
        "expired",
      ],
    ];

    for (const [name, body, want] of cases) {
      const file = name.endsWith("missing.json")
        ? join(dir, name)
        : plantFile(name, body);
      const started = Date.now();
      const health = await prober.open({
        id: name,
        kind: "claude-login",
        file,
        owner: "household",
      });
      if (want === "ok") {
        // THE ONE THE HUB BOX FORCED. `expiresAt` is 0 on a login that answers
        // real people right now, so a build reading it alone reports the
        // working household dead, and this assertion is the only thing
        // standing between that build and a household that stops trusting
        // `check`.
        expect(health.ok).toBe(true);
      } else {
        expect(health.ok).toBe(false);
        expect((health as { kind: string }).kind).toBe(want);
        expect((health as { says: string }).says.length).toBeGreaterThan(0);
      }
      // Nothing was dialled: a file is a file, and the bound is far under any
      // network round trip.
      expect(Date.now() - started).toBeLessThan(1000);
    }

    // --- the two bot kinds, as far as they go with no network. The identity
    //     call itself belongs to the cutover.
    const missingToken = await prober.open({
      id: "bot",
      kind: "telegram",
      file: join(dir, "real/no-token-here"),
      owner: "household",
    });
    expect(missingToken.ok).toBe(false);
    expect((missingToken as { kind: string }).kind).toBe("unreadable");
    const emptyToken = await prober.open({
      id: "bot",
      kind: "telegram",
      file: plantFile("real/empty.token", "   \n"),
      owner: "household",
    });
    expect(emptyToken.ok).toBe(false);
    expect((emptyToken as { kind: string }).kind).toBe("blank");

    // --- THE TWO BOT KINDS' IDENTITY CALL, through a transport the check
    //     supplies (the synthetic-message rule
    //     forbids sending a person a message, not standing in for an HTTP
    //     round trip). `realProber` takes an optional `fetch`, and with one
    //     supplied NOTHING reaches a network: the check answers 401 and reads
    //     the finding kind back.
    //
    //     The seam contract does not carry this argument, so it is pinned
    //     here instead.
    const asked: { url: string; auth: string }[] = [];
    const refusing = (async (url: unknown, init?: { headers?: Record<string, string> }) => {
      asked.push({
        url: String(url),
        auth: String(init?.headers?.Authorization ?? init?.headers?.authorization ?? ""),
      });
      return new Response(JSON.stringify({ ok: false, description: "Unauthorized" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    const dialled = (realProber as Function)({ fetch: refusing }) as typeof prober;

    // THE TOKEN IN THE REQUEST IS THE TOKEN IN THE FILE, and the endpoint is
    // the identity one (a URL that merely contained
    // the platform's name and some `Bot ` header passed, so a prober sending a
    // hard-coded token would have too).
    const telegramToken = `token-${crypto.randomUUID()}`;
    const discordToken = `token-${crypto.randomUUID()}`;
    const telegramFile = plantFile("real/telegram.token", telegramToken);
    const discordFile = plantFile("real/discord.token", discordToken);

    const telegramHealth = await dialled.open({
      id: "bot-telegram",
      kind: "telegram",
      file: telegramFile,
      owner: "household",
    });
    expect(telegramHealth.ok).toBe(false);
    expect((telegramHealth as { kind: string }).kind).toBe("refused");
    expect((telegramHealth as { says: string }).says.length).toBeGreaterThan(0);

    const discordHealth = await dialled.open({
      id: "bot-discord",
      kind: "discord",
      file: discordFile,
      owner: "household",
    });
    expect(discordHealth.ok).toBe(false);
    expect((discordHealth as { kind: string }).kind).toBe("refused");

    expect(asked.length).toBe(2);
    // Telegram carries its token in the path, and the method is the identity
    // one: `https://api.telegram.org/bot<token>/getMe`.
    const toTelegram = asked.find((one) => one.url.includes("telegram"))!;
    expect(toTelegram).toBeDefined();
    expect(toTelegram.url).toContain(`/bot${telegramToken}/getMe`);
    // Discord carries its token in the header, and the path is its own
    // identity endpoint.
    const toDiscord = asked.find((one) => one.url.includes("discord"))!;
    expect(toDiscord).toBeDefined();
    expect(toDiscord.auth).toBe(`Bot ${discordToken}`);
    expect(toDiscord.url.endsWith("/users/@me")).toBe(true);

    // And a transport that answers as a live platform does gives `ok`, FOR
    // BOTH, so a prober that calls one platform's tokens dead by construction
    // fails. Telegram answers `{ ok: true, result: <user> }` and Discord
    // answers the user object itself with a 200.
    const accepting = (async (url: unknown) =>
      String(url).includes("telegram")
        ? new Response(JSON.stringify({ ok: true, result: { id: 1, is_bot: true } }), {
            status: 200,
            headers: { "content-type": "application/json" },
          })
        : new Response(JSON.stringify({ id: "1", username: "a-bot", bot: true }), {
            status: 200,
            headers: { "content-type": "application/json" },
          })) as unknown as typeof fetch;
    const live = (realProber as Function)({ fetch: accepting }) as typeof prober;
    expect(
      (
        await live.open({
          id: "bot-telegram",
          kind: "telegram",
          file: plantFile("real/telegram-ok.token", `token-${crypto.randomUUID()}`),
          owner: "household",
        })
      ).ok,
    ).toBe(true);
    expect(
      (
        await live.open({
          id: "bot-discord",
          kind: "discord",
          file: plantFile("real/discord-ok.token", `token-${crypto.randomUUID()}`),
          owner: "household",
        })
      ).ok,
    ).toBe(true);

    // --- `secrets`, which is what the copy scan holds in memory and never
    //     writes down.
    const held = await prober.secrets({
      id: "live",
      kind: "claude-login",
      file: join(dir, "real/live.json"),
      owner: "household",
    });
    expect([...held].sort()).toEqual([access, refresh].sort());
    expect(
      await prober.secrets({
        id: "none",
        kind: "claude-login",
        file: join(dir, "real/no-object.json"),
        owner: "household",
      }),
    ).toEqual([]);
  },
  SLOW,
);

test(
  "RUN-16 a second copy of a credential is a finding: a file inside the roots the registry names that holds a declared secret is reported by PATH with the secret written nowhere, the scan stays inside its roots and its bounds, and with no copy anywhere it reports nothing (SPEC §6, L10 rule 1)",
  async () => {
    const { copyFindings, SCAN_MAX_DEPTH, SCAN_MAX_BYTES } = await seam(
      "src/check/credentials.ts",
    );
    expect(typeof copyFindings).toBe("function");
    expect(SCAN_MAX_DEPTH).toBe(4);
    expect(SCAN_MAX_BYTES).toBe(1048576);
    const { runCheck, CHECK_SHEET } = await seam("src/check/run.ts");

    // A household's own shape, under one scratch directory.
    const home = mkdtempSync(join(tmpdir(), "hub-household-"));
    const at = (...parts: string[]) => join(home, ...parts);
    for (const one of ["p1", "p2", "state", "credentials", "elsewhere"]) {
      mkdirSync(at(one), { recursive: true });
    }
    // The shared zone is a checkout inside each person's own vault, so it is
    // swept by that person's tree and is not a root of its own.
    const zoneOf = (person: string) => at(person, "vault", "shared-notes");
    for (const person of [PERSON, PERSON2]) mkdirSync(zoneOf(person), { recursive: true });
    // The secret is generated at run time, so "this file holds that secret"
    // can only be true by copying.
    const secret = `token-${crypto.randomUUID()}${crypto.randomUUID()}`;
    const second = `token-${crypto.randomUUID()}`;
    const declared = at("credentials", "claude.json");
    writeFileSync(
      declared,
      JSON.stringify({
        claudeAiOauth: {
          accessToken: secret,
          refreshToken: second,
          expiresAt: 0,
          refreshTokenExpiresAt: Date.now() + 3_600_000,
        },
      }),
      "utf8",
    );

    const it = await stageHub(cluster, {
      machines: [{ id: "pi", os: "linux" }],
      hub: { state_dir: at("state") },
      people: [
        { id: PERSON, language: "en", tree: at("p1") },
        { id: PERSON2, language: "en", tree: at("p2") },
      ],
      credentials: [
        { id: "household-claude", kind: "claude-login", file: declared, owner: "household" },
      ],
      preset: { credential: "household-claude" },
      run: [
        {
          id: DOOR,
          kind: "door",
          machine: "pi",
          platform: "fake",
          person: PERSON,
          token_file: "/dev/null",
          schedule: "always",
          memory_limit_mb: 192,
        },
        {
          id: RUNNER_PI,
          kind: "runner",
          machine: "pi",
          schedule: "always",
          memory_limit_mb: 512,
          child_memory_limit_mb: 512,
        },
      ],
      registry: (base) => ({
        ...base,
        agents: (base.agents ?? []).map((agent) => ({ ...agent, runner: RUNNER_PI })),
      }),
    });

    const store = await superStore(cluster, it.db);
    const prober = fakeProber(
      { "household-claude": { ok: true } },
      { "household-claude": [secret, second] },
    );
    const copies = async (): Promise<Finding[]> =>
      ((await (runCheck as Function)({
        machine: "pi",
        registryFile: it.registryFile,
        store,
        os: null,
        kernel: null,
        credentials: prober,
      })) as Finding[]).filter((one) => one.kind === "credential-copy");

    // TWO DECOYS, planted before anything else.
    // Without them a scan that reported every eligible JSON file except the
    // declared one passes every positive below, because every positive file
    // holds the secret AND is eligible. One decoy carries the declared file's
    // own NAME and a different secret, which is what a matcher keying on the
    // basename reports; the other is an ordinary JSON file of the household's,
    // which is what a scan with no comparison at all reports.
    const sameName = at("p1", "notes", "claude.json");
    mkdirSync(join(sameName, ".."), { recursive: true });
    writeFileSync(
      sameName,
      JSON.stringify({ claudeAiOauth: { accessToken: `other-${crypto.randomUUID()}` } }),
      "utf8",
    );
    const unrelated = join(zoneOf(PERSON), "shopping.json");
    writeFileSync(unrelated, JSON.stringify({ milk: 2, bread: 1 }), "utf8");

    try {
      // --- the control FIRST: with no copy anywhere, nothing is reported, and
      //     the two decoys are sitting inside the roots while it answers. A
      //     scan that reported every file it read passes everything below and
      //     fails this.
      expect(await copies()).toEqual([]);

      // --- 1 and 2. one copy in each of the roots, four findings, four paths.
      //     The declared file's own directory is a root too, and one copy sits
      //     inside a person's zone checkout, which the tree's own root reaches.
      const planted = [
        at("p1", "notes", "old-login.json"),
        at("p2", "backup", "login.json"),
        join(zoneOf(PERSON2), "handover.json"),
        at("state", "stray.json"),
      ];
      for (const file of planted) {
        mkdirSync(join(file, ".."), { recursive: true });
        writeFileSync(file, `{"token": "${secret}"}`, "utf8");
      }
      const found = await copies();
      // Exactly the four, so neither decoy is in the answer.
      expect(found.map((one) => one.subject).sort()).toEqual([...planted].sort());
      expect(found.some((one) => one.subject === sameName)).toBe(false);
      expect(found.some((one) => one.subject === unrelated)).toBe(false);
      for (const one of found) {
        expect(one.kind).toBe("credential-copy");
        expect(one.says).toContain("household-claude");
        expect(one.says).toContain(one.subject);
        expect(one.fix).toContain(declared);
        // The secret reaches NOTHING a person or a file can read.
        expect(one.says).not.toContain(secret);
        expect(one.fix).not.toContain(secret);
      }
      const sheet = await it.read.sheet(String(CHECK_SHEET));
      expect(JSON.stringify(sheet)).not.toContain(secret);

      // --- 3. the declared file is not a copy of itself. A scan that reported
      //     it reports a finding nobody can fix.
      expect(found.some((one) => one.subject === declared)).toBe(false);

      // --- 5. the bounds, each asserted as a NEGATIVE, which is what keeps
      //     this a check a household runs rather than one it dreads.
      const deep = at("p1", "a", "b", "c", "d", "e", "too-deep.json");
      mkdirSync(join(deep, ".."), { recursive: true });
      writeFileSync(deep, secret, "utf8");
      const allowed = at("p1", "a", "b", "c", "just-deep-enough.json");
      writeFileSync(allowed, secret, "utf8");
      const big = at("p2", "huge.json");
      writeFileSync(big, `${"x".repeat(1_200_000)}${secret}`, "utf8");
      const git = at("p1", ".git", "config");
      mkdirSync(join(git, ".."), { recursive: true });
      writeFileSync(git, secret, "utf8");
      const modules = at("p1", "node_modules", "something", "index.js");
      mkdirSync(join(modules, ".."), { recursive: true });
      writeFileSync(modules, secret, "utf8");
      const outside = at("elsewhere", "out-of-every-root.json");
      writeFileSync(outside, secret, "utf8");
      symlinkSync(outside, at("p2", "a-link-out.json"));
      const wholeDiskWould = join(tmpdir(), `hub-copy-${crypto.randomUUID()}.json`);
      writeFileSync(wholeDiskWould, secret, "utf8");

      try {
        const bounded = await copies();
        const paths = bounded.map((one) => one.subject);
        expect(paths).toContain(allowed);
        expect(paths).not.toContain(deep);
        expect(paths).not.toContain(big);
        expect(paths).not.toContain(git);
        expect(paths).not.toContain(modules);
        expect(paths).not.toContain(outside);
        expect(paths).not.toContain(at("p2", "a-link-out.json"));
        // THE ONE A FILESYSTEM CRAWL FAILS: a copy outside every root the
        // registry names is not this scan's business.
        expect(paths).not.toContain(wholeDiskWould);
        // The decoys are still not copies, with the bounds' files beside them.
        expect(paths).not.toContain(sameName);
        expect(paths).not.toContain(unrelated);
      } finally {
        rmSync(wholeDiskWould, { force: true });
      }

      // --- 4. two DECLARED entries holding one secret are the same finding,
      //     reported against the second, which is rule 1 in its other shape.
      const twin = at("credentials", "claude-copy.json");
      writeFileSync(twin, `{"accessToken": "${secret}"}`, "utf8");
      const withTwin = await copies();
      expect(withTwin.map((one) => one.subject)).toContain(twin);

      // --- 6. the clear. Delete the copies and the findings go, from the list
      //     and from the sheet.
      for (const file of [...planted, allowed, twin]) rmSync(file, { force: true });
      // The decoys stay where they are, so the empty answer is an answer about
      // secrets and not about the directory being empty.
      expect(existsSync(sameName) && existsSync(unrelated)).toBe(true);
      expect(await copies()).toEqual([]);
      const cleared = await it.read.sheet(String(CHECK_SHEET));
      expect(cleared.some((row) => row.id.includes("credential-copy"))).toBe(false);
    } finally {
      await store.close();
      await it.stop();
      rmSync(home, { recursive: true, force: true });
    }
  },
  SLOW,
);

test(
  "RUN-16 a plan preset that names no credential is reported rather than refused: the finding names the PRESET, a per-token key preset draws none, a preset no agent on this machine uses draws none, and a declared credential's own finding still stands beside it (SPEC §6, L10 rule 1)",
  async () => {
    const { runCheck, CHECK_SHEET } = await seam("src/check/run.ts");

    const blank = plantFile("undeclared/blank.json", "{}");
    const it = await stageHub(cluster, {
      machines: [{ id: "pi", os: "linux" }],
      people: [
        { id: PERSON, language: "en" },
        { id: PERSON2, language: "en" },
      ],
      credentials: [
        { id: "login-blank", kind: "claude-login", file: blank, owner: "household" },
      ],
      agents: [
        {
          id: AGENT2,
          person: PERSON2,
          preset: "metered",
          chat: `${CHAT}1`,
          door: DOOR,
          runner: RUNNER_PI,
        },
      ],
      run: [
        {
          id: DOOR,
          kind: "door",
          machine: "pi",
          platform: "fake",
          person: PERSON,
          token_file: "/dev/null",
          schedule: "always",
          memory_limit_mb: 192,
        },
        {
          id: RUNNER_PI,
          kind: "runner",
          machine: "pi",
          schedule: "always",
          memory_limit_mb: 512,
          child_memory_limit_mb: 512,
        },
      ],
      registry: (base) => ({
        ...base,
        presets: {
          // A plan preset naming NO credential, which is every shipped fixture.
          ...base.presets,
          // A per-token key has no shared login file for this rule to be about.
          metered: {
            adapter: String(base.presets?.daily?.adapter ?? ""),
            model: "a-model-name",
            provider: "a-provider",
            effort: "medium",
            paid: "key",
          },
          // A plan preset no agent on this machine points at.
          unused: {
            adapter: String(base.presets?.daily?.adapter ?? ""),
            model: "another-model-name",
            provider: "a-provider",
            effort: "medium",
            paid: "plan",
          },
        },
        agents: (base.agents ?? []).map((agent) =>
          agent.id === AGENT ? { ...agent, runner: RUNNER_PI } : agent,
        ),
      }),
    });

    try {
      const store = await superStore(cluster, it.db);
      const prober = fakeProber({
        "login-blank": { ok: false, kind: "blank", says: "the file holds no token at all" },
      });
      const ask = async (): Promise<Finding[]> =>
        (await (runCheck as Function)({
          machine: "pi",
          registryFile: it.registryFile,
          store,
          os: null,
          kernel: null,
          credentials: prober,
        })) as Finding[];

      const found = await ask();
      const undeclared = found.filter((one) => one.kind === "credential-undeclared");
      // 1. The subject is the PRESET name, because one preset serves many
      //    agents and one line fixes all of them.
      expect(undeclared.map((one) => one.subject)).toEqual(["daily"]);
      expect(undeclared[0].id).toBe("pi/credential-undeclared:daily");
      expect(undeclared[0].says).toContain("daily");
      expect(undeclared[0].fix).toContain("credential");
      expect(undeclared[0].fix).toContain("[[credentials]]");

      // 2 and 3: a key preset draws none, and a plan preset no agent on this
      // machine uses draws none.
      expect(undeclared.some((one) => one.subject === "metered")).toBe(false);
      expect(undeclared.some((one) => one.subject === "unused")).toBe(false);

      // 5. It does not hide the others: the declared credential that is blank
      //    still reports its own finding in the same run.
      expect(
        found.some(
          (one) => one.kind === "credential-blank" && one.subject === "login-blank",
        ),
      ).toBe(true);

      // 4. The clear: name a credential and the finding goes, from the list
      //    and from the sheet.
      const text = await Bun.file(it.registryFile).text();
      await Bun.write(
        it.registryFile,
        text.replace('paid = "plan"', 'paid = "plan"\ncredential = "login-blank"'),
      );
      const after = await ask();
      expect(after.some((one) => one.kind === "credential-undeclared")).toBe(false);
      const sheet = await it.read.sheet(String(CHECK_SHEET));
      expect(sheet.some((row) => row.id === "pi/credential-undeclared:daily")).toBe(false);

      await store.close();
    } finally {
      await it.stop();
    }
  },
  SLOW,
);
