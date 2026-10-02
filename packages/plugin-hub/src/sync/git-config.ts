import { TransferError } from "../transfer/bundle.ts";

// The scopes git names a config entry's origin by. Keys always hold a dot and no scope does, so the two never read as each other.
const CONFIG_SCOPES = new Set(["system", "global", "local", "worktree", "command", "submodule", "unknown"]);

/**
 * `config --list --show-scope --name-only -z`, as (scope, key) pairs. Every
 * field ends in a NUL, so a tab or any other character inside a subsection can
 * neither split a key nor hide one. (An older git that joins the scope to the
 * key with a tab even under `-z` is read too: no key starts with a scope and a
 * tab.) Anything else is a git this reader does not understand, refused.
 */
export function configEntries(buffer: Buffer): { scope: string; key: string }[] {
  const tokens = buffer.toString("utf8").split("\0");
  if (tokens[tokens.length - 1] === "") tokens.pop();
  const out: { scope: string; key: string }[] = [];
  for (let n = 0; n < tokens.length;) {
    const token = tokens[n];
    const tab = token.indexOf("\t");
    if (CONFIG_SCOPES.has(token) && n + 1 < tokens.length) { out.push({ scope: token, key: tokens[n + 1] }); n += 2; }
    else if (tab > 0 && CONFIG_SCOPES.has(token.slice(0, tab))) { out.push({ scope: token.slice(0, tab), key: token.slice(tab + 1) }); n += 1; }
    else throw new TransferError("repo-git-failed", "config");
  }
  return out;
}

