/**
 * Household pins: per-row decisions that outrank every rule, the household twin of
 * the tax pins. data/pins.csv: id,category,mandatory,note. `category` empty keeps
 * the rule's category, `mandatory` is yes|no|empty (empty = the category default),
 * `note` is the human's one line. Written by the retag loop, read by categorize
 * (category) and by the tier lookup (mandatory).
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { parseCsv } from "./csv.ts";
import type { Tier } from "./categories.ts";

export interface Pin {
  id: string;
  category: string;
  mandatory: Tier | null;
  note: string;
}

export function loadPins(path: string): Map<string, Pin> {
  const out = new Map<string, Pin>();
  if (!existsSync(path)) return out;
  const text = readFileSync(path, "utf8");
  if (text.trim() === "") return out;
  const { records } = parseCsv(text);
  records.forEach((rec, i) => {
    const id = rec.get("id").trim();
    if (id === "") return;
    const m = rec.get("mandatory").trim().toLowerCase();
    if (m !== "" && m !== "yes" && m !== "no") {
      throw new Error(`pins.csv row ${i + 2}: mandatory must be yes|no|empty (got "${m}")`);
    }
    out.set(id, {
      id,
      category: rec.get("category").trim(),
      mandatory: m === "yes" ? "mandatory" : m === "no" ? "optional" : null,
      note: rec.get("note").trim(),
    });
  });
  return out;
}

export function savePins(path: string, pins: Map<string, Pin>): void {
  const q = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  const lines = ["id,category,mandatory,note"];
  for (const p of [...pins.values()].sort((a, b) => a.id.localeCompare(b.id))) {
    lines.push([p.id, p.category, p.mandatory === "mandatory" ? "yes" : p.mandatory === "optional" ? "no" : "", q(p.note)].join(","));
  }
  writeFileSync(path, lines.join("\n") + "\n", "utf8");
}
