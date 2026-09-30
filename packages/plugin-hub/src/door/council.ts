/**
 * The old council: one question typed in a chat, answered by every council seat of that person and
 * merged once by the door. It is gone. A council is now a durable object with an explicit roster, its
 * rounds and its own events (`src/council/`), started by the agent's tool and never by the door alone.
 *
 * What is left here is the name of the sheet the old design kept its open councils on. Migration 14 read
 * every row of it into the council tables and deleted them, and nothing writes or reads this sheet any more.
 * It is kept as a constant so a check can say if a row of it is ever found again.
 */
export const COUNCIL_SHEET = "council";
