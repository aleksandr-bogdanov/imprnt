# Fidelity fix — re-process the lossy notes (preserve the data)

> The vault rebuild dropped structured data from ~30 notes (kept the prose summary, left tables/IDs/records in `raw/`, which `recall` can't reach). Root cause + the standing guardrail are now in `CLAUDE.md` (the "Fidelity: the data IS the knowledge" section) and `plugins/anti-slop/agent.md` (data-exempt note). This is the recovery worklist.
> METHOD per item: read the FULL `raw/pai/...` source, rewrite the vault note to CONTAIN the structured payload (tables as tables, IDs/numbers/legal-text verbatim), keep/add the summary + tags + links, apply the lookup test. The raw file is the source of truth — read it, do not work from the lossy note. Run `imprint check` after each area. Anti-slop on prose only.

## Start here (the guardrail proof)
- **life/beer.md** ← `raw/pai/USER/LIFE/beer.md` — restore the 40-row S/A/B/C/D/F "Tried" table, the calibration-anchors table, the tier-behavior table, both next-pickup lists, the where-to-buy + where-to-drink (Lemke addresses) tables, the Lemke task wd:15672, the Bamberg quest. **If the 40-row table lands IN the note, the guardrail works — then continue.**

## LIFE
- **life/energy-drinks.md** — two rating tables (sugar-free 11, sugar 8), calibration, brand-parents, next-pickups, the caffeine-free DE retail research, wd:15273.
- **life/style-and-wardrobe.md** ← wardrobe.md — sock brand-tier table, locked merino/boxer SKUs, sock-sampler hierarchy, fit-check list, fabric reference, the Charlottenburg store-run protocol (the 4 German questions), Berlin store-tier list, sport-coat order, tasks id:14539/id:13545.
- **life/shoe-care.md** — rotation/lifetime tables, decontamination protocols, insoles, the full maintenance routine, the product stack (Saphir kit + prices), the €233.50 locked cart, the 10 lessons.
- **life/documents.md** — Arbeitsagentur Kundennummer `962D677858`, Sozialversicherungsnummer `65300793B050` (these exist NOWHERE else), the per-folder application table, the open-follow-ups checklist.
- **life/housing.md** (+ orgs/deutsche-wohnen) — DW ticket history (Auftrag A00113753892/...886, subletting refs, Briefkasten A00314151935), handover-gap inventory, contact Robert Melitz, cellar plan, tasks wd:3851/6600/13352/14546, the Stakendecke/Schilfrohr ceiling finding.
- **people/leo** or finances — Leo's Kita Gutschein `GB-83743619742-08` + Vertrag `VK-13232512100-09`, Kinderzuschlag denial reasoning, Kindergeld IBANs.

## HEALTH + FINANCES (highest specificity — verbatim figures + legal text)
- **finances/bu-insurance + holdings/generali + holdings/tk-membership + rlv-term-life + estate-end-of-life** ← `insurance-policies.md` — the per-insurer BU AVB verbatim clauses (Hannoversche/HDI/AXA/Stuttgarter/Barmenia NVG triggers), the full Generali Unfall schedule (Mehrleistung/Krankenhaus-Tagegeld/Zahnersatz/Bergungskosten/Sofortleistung amounts), TK financial detail (IBAN, Säumniszuschlag rule, Osteopathy reimbursement), the BU therapist 7-item ask + forbidden-requests list, the Hybrid Safety Net 4-layer strategy, Anna scenarios A/B/C payout mechanics, the Russia-payout operational block (SEPA/SWIFT, crypto, DBA double-tax ~15% haircut), Vitiligo clinical detail, the §18 GenDG Genotek panel, ADVOCARD claim dates.
- **finances/insurance-optimization.md** — the **"Catches, Risks & Safe Operating Parameters"** section is the must-recover part (HIS shared-insurer database, §111 VVG 1-month rule, the investigation-trigger-by-claim-size table, the safe-cadence table, Deckungszusage/Stichentscheid, the ROI math, the Golden Rule). The 130-strategy list itself may stay in `raw/` (the one defensible exception — grey-area brainstorm), but the guardrails are durable knowledge and must come in.
- **finances/tax-overview** — Finanzamt Steglitz address + phone (Schloßstr. 58/59, 12165, 030 90 24-20700), the §6 AStG Wegzugsbesteuerung + suspended Germany-Russia DBA exposure on Whenful equity.
- **finances/tk-membership** — TK contribution breakdown (KV 14.60%/848.63, Zusatz 2.69%/156.36, PV 3.60%/209.25, Bemessung 5,812.50, Widerspruchsfrist 21.06.2026).
- **finances/wohngeld** — Sachbearbeiterin Frau Lipsius 90299-5517 / wohnen@ba-sz.berlin.de, the monthly BWZ Anna EÜR figures, the Widerspruch draft paragraph, the anlagen list.
- **finances/anna-bookkeeping** — the 2024 Steuerbescheid numbers (Einkünfte -1,998; Gesamtbetrag 79,526; ESt 12,030; Soli 107.58; zu zahlen 76.58; 27.08.2025), the audit counts (4,183 tx / 864 bookings / 180 pairs / 19,408), the named Class A/B items, artifact paths.
- minor: **holdings/sertraline** (Atomoxetine 100mg dose + why-blocked), **finances/tax-return-2025** (Trading212 13.16+22.78+0.35, Five01/SO1 basis docs, ~734 tooling).

## WORK + BUSINESS + PROJECTS
- **CREATE holdings/ for the two Voronezh flats** + fix **projects/voronezh-house**: Лизюкова 70А кв117 (50/50, 3.0M→6.0M, §217.1) and Берёзовая роща 8 кв15 (cadastral 36:34:0603025:3620, 30.6m², bought 20.09.2023 2.6M = 30k cash + 586,946.72 маткапитал cert №МК-Э-046-2023 + 1,983,053.28 ВТБ mortgage №V623/2421-0001998 242mo@10.6%, ~905k left, seller Сысоева Т.В.), the sale-sequencing tax strategy, the маткапитал kid-share obligation (ФЗ 256-ФЗ), discovery-channels, move-logistics.
- **projects/bogdanov-wtf** — the 12-item publishable-content inventory, the failure-modes kill-list, the 6-step optimized→post workflow.
- **work/dh-contract** — §11.4 moral-rights waiver, the Entreicherung-excluded repayment clause, the action items + Einschreiben address (Delivery Hero SE, z.H. Hero Support, Oranienburger Str. 70, 10117 Berlin).
- **CREATE people/alistair** (DH decision-maker), **people/michael-galkov** (ex-cofounder, London, the SO1-lesson subject).
- optional (Alex's call): **razum/INSIGHTS** PAI token measurements + the 8-tool competitor survey → a reference note or fold into projects/imprint.

## KNOWLEDGE
- **people/vadim-proskurin** — the mature-Proskurin reading plan (~67h, books + hours), the 7 conceptual breakthroughs, the authorial-trajectory table, per-book breakdowns. (Was an already-enriched note — restore it.)
- **(idea note) autonomous-audit-loop** — convergence curve, token budgets, scaling math.
- **work/corporate-narrative-craft** — techniques #8 Vendor Lunch / #9 Strategic Meeting Avoidance / #10 Email Timestamp + Budget Theater, the mentor/mafia name-lists.
- **(idea note) shannon-pentest** — the completed-runs evidence log (PR #1335-1344, #1404/1405, finding counts).
- **health/cognitive-enhancement-modafinil** — the adjacent-compounds research list, risk specifics, the cycle.
- minor: germany-dui (vehicle-class table + consequence ladder + Widmark math), hormonal-stack (TRT/peptide doses + bloodwork panel), shell-setup (tool tail + gotchas).
- **CREATE a reference note** for knowledge-base-tooling's arscontexta competitive intel + the Logseq/Tana/Reflect/Roam table (or fold into projects/imprint).

## TELOS + identity
- **life/music-taste** ← BANDS.md — the full multi-cluster artist catalog (~10 clusters), persona/performance models, video-aesthetic refs, audience DNA, the year-by-year arc, the 3,827-liked-songs figure.
- **life/gaming** ← GAMING.md — the Shortlist+Longlist backlog tables (~30 games incl. the Pathologic 2 slider recipe), the played-and-loved table (~14), competitive history (Dota 2 3k hrs/300 MMR, LoL, The Finals), storage/BIOS history.
- **life/movies** ← MOVIES.md — named favorites with meaning (Inception, The Place Beyond the Pines, Walter Mitty, Cruella), the music-films cluster, the full series-verdicts block.
- **life/reading-queue** ← READING_QUEUE.md — the ~15 dropped titles + reasons (Zuckerman, Stat 110 + Wasserman, Wolpert, Carroll/Everett, Greene, Kurzweil, Parfit, Williams, Singer, MacIntyre, Sandel, Sterling, Stross, Levy).
- **identity (lessons)** ← LEARNED.md — the Warp markdown-fork lesson (#10574/#10575, 2-week walk-away), the granular German exit mechanics (12mo fresh ALG1, contractor months don't count, 12-week Sperrzeit, Aufhebungsvertrag-as-employer-initiated).
- **identity/opinions** — the dated 2026-05-06 political critique themes (AfD-Verbot, immigration-without-integration-capacity, energy policy, Berlin night-safety, demographic geriatrocracy).
- **CREATE people/ for the named friends** (Egor Pilipenko, Sergey Miroshnichenko, Nikita Galkovskiy, Alexey Zakrzhevskiy, Michael Galkov) + restore IDEAL_STATE specifics (sleep-deprioritized, Kita €23/mo, Anna €310/mo).
- minor: **identity/definitions** (альтушки, alkogolichka, music-debt-vs-spark, handles).
- **CREATE a note for the Folder Register** ← LOCATIONS.md (artifacts → ~/Documents/artifacts/, visuals staging, the original+.md correspondence-archive convention).

## After
- `imprint check --vault ~/imprint-vault/vault` (or knowful-vault) clean.
- Lookup test on a sample: recall + answer "what tier is Hasseröder", "my Sozialversicherungsnummer", "the Berezovaya Roscha cadastral number", "the Generali Unfall schedule" — each answerable from the VAULT note alone.
