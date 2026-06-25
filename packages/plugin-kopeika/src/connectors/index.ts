/**
 * Connector registry: source name -> parse function.
 *
 * A connector takes the raw export text and returns ParsedRow[] (one per kept
 * row, already filtered for non-completed / invalid rows). The import pipeline
 * owns id, FX, dedup, and transfer grouping — connectors only translate the
 * vendor format into the kopeika ParsedRow shape.
 *
 * To add a connector: write src/connectors/<name>.ts exporting
 * `parse<Name>(text: string): ParsedRow[]`, then register it below.
 */

import type { ParsedRow } from "../types.ts";
import { parseRevolut } from "./revolut.ts";
import { parseN26 } from "./n26.ts";
import { parseTrading212 } from "./trading212.ts";
import { parseTbank } from "./tbank.ts";
import { parseAlfa } from "./alfa.ts";

export type ConnectorParseFn = (text: string) => ParsedRow[];

export const CONNECTORS: Readonly<Record<string, ConnectorParseFn>> = {
  revolut: parseRevolut,
  n26: parseN26,
  trading212: parseTrading212,
  tbank: parseTbank,
  alfa: parseAlfa,
};

export function getConnector(name: string): ConnectorParseFn | null {
  return CONNECTORS[name] ?? null;
}

export function connectorNames(): string[] {
  return Object.keys(CONNECTORS);
}
