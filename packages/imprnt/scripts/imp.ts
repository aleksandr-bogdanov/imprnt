// The `imp` bin — the human front door. Same dispatcher as `imprnt`; this entry only marks the
// invoked name, so bare invocation opens a Claude session instead of printing help. A second
// entry file instead of argv[1] sniffing because npm's Windows shims rewrite argv[1] to the
// bundled .js path, and "imprnt" starts with "imp" anyway.
//
// The DYNAMIC import is load-bearing: cli.ts reads the flag at module top level, so this
// assignment must execute before cli.ts does. "Simplifying" to a static `import "./cli.ts"`
// hoists the import above the assignment and silently turns bare `imp` into help-printing.
(globalThis as Record<string, unknown>).__IMPRNT_IMP__ = true;
await import("./cli.ts");
