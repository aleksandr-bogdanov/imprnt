# knowful

A deterministic-first, plain-markdown knowledge vault you own. Deterministic code does the
bulk transform at ~zero token cost; the LLM is spent only on the irreducibly-semantic ~20%
(clean, extract, synthesize). Retrieval is native grep — **no MCP, no vector DB, no embeddings
over the vault.** Open the same folder in Obsidian for a human graph view.

> Sibling to [Whenful](https://whenful.com): Whenful answers *when* do I do my tasks; knowful
> holds *what* I know.

## Why

A knowledge base for an LLM agent does not need a database the agent queries through a
protocol. It needs a folder of markdown the agent greps directly. Grep over the vault costs
~100 tokens; an MCP/vector layer over the same files costs orders of magnitude more and goes
stale on every edit. So the storage is commodity. The discipline is the product:

- **Deterministic-first.** `ingest` parses a raw transcript into a structured note with no LLM
  call. The LLM only fills the parts that genuinely require judgment.
- **Opt-in, composable.** Tiny core. Every part is a self-contained directory you can
  `rm -rf` with zero cross-dependencies. You add the modules *you* need; nothing is wired in
  by default.
- **Owned.** Plain files on your disk. Can't 404, can't bloat, can't hold your context hostage.

## Install

```sh
git clone https://github.com/aleksandr-bogdanov/knowful.git
cd knowful
bun install            # no runtime deps; this just links the CLI
bun scripts/cli.ts init   # scaffold ./vault and ./raw from templates/
```

Requires [Bun](https://bun.sh) ≥ 1.3.

## The loop

```sh
# 1. capture — drop a raw transcript in raw/, then parse it deterministically (no LLM)
knowful ingest raw/2026-06-02-sts2-1on1.txt

# 2. clean — let the agent fill the Summary and extend people/ + workstreams/ (the only LLM step)

# 3. recall — tiered grep over the vault (or just use rg)
knowful recall "STS2 BigQuery"

# 4. plan — feed the retrieved context to the agent to draft an implementation plan
```

A complete worked example lives in [`examples/sts2-demo/`](examples/sts2-demo/): a synthetic
1:1 transcript, the note `ingest` produces from it, the people/workstream/mistake notes, and
the implementation plan drafted from a `recall`.

## Commands

| Command | What it does | LLM? |
|---------|--------------|------|
| `knowful init` | Scaffold `vault/` + `raw/` from `templates/` | no |
| `knowful ingest <file> [--vault DIR]` | Parse a raw transcript → structured meeting note; update delta-manifest | no |
| `knowful recall "<query>" [--vault DIR]` | Tiered grep (title → tags → body), ranked | no |
| `knowful hot [--vault DIR]` | Print `vault/hot.md` (the session primer) | no |

The vault contract — note formats, conventions, the deterministic-first rule — is in
[`CLAUDE.md`](CLAUDE.md), which an agent auto-loads when working in the vault.

## License

MIT © 2026 Aleksandr Bogdanov
