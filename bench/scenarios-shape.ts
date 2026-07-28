/**
 * Does the model get CONTAINER-TYPED arguments right?
 *
 * Every other suite here measures tool *selection*. This one measures argument shape,
 * because an external team measured every level-4 argument rejection across two providers
 * and two independent compiled artifacts and found only two causes: **77% container-type
 * errors** (`must be an object` / `must be an array`) and **23% bad enum values**, with
 * nothing else.
 *
 * That is a testable claim about the map, not about the model: a map that shows a parameter
 * as a bare name gives the model no way to know it wants `[{...}]` rather than a string.
 *
 * So each scenario names its tool outright — selection is deliberately trivial — and the
 * only way to fail is to send the wrong SHAPE. Arms whose map carries shapes should pass;
 * arms whose map does not should produce container-type rejections.
 */
import { realSubset } from "./fixtures/real.js";
import type { Scenario } from "./scenarios.js";

const ALL = realSubset();
const R = (o: Record<string, string>) => o;

export const SHAPE_SCENARIOS: Scenario[] = [
  {
    id: "shape-array-of-objects",
    note: "shipments is an array of objects, truckSpecs an object. Both bare names in a name+required map.",
    tools: ALL,
    prompt:
      "Use analyze_consolidation to check consolidation opportunities. Two shipments: one from Dallas " +
      "weighing 1200 lb, one from Fort Worth weighing 800 lb. The truck is a 53ft dry van with a " +
      "45000 lb capacity.",
    expected: [{ name: "analyze_consolidation" }],
    results: R({ analyze_consolidation: '{"groups":1,"savings":320}' }),
    maxTurns: 6,
  },
  {
    id: "shape-nested-objects",
    note: "origin and destination are objects, not strings — the most natural wrong guess.",
    tools: ALL,
    prompt:
      "Use compute_route to get the route from origin latitude 32.7767 longitude -96.7970 to " +
      "destination latitude 32.7555 longitude -97.3308.",
    expected: [{ name: "compute_route" }],
    results: R({ compute_route: '{"miles":32.4,"minutes":41}' }),
    maxTurns: 6,
  },
  {
    id: "shape-array-of-strings",
    note: "addresses is an array; a single string is the obvious wrong shape.",
    tools: ALL,
    prompt:
      "Use batch_geocode on these three addresses: 1 Main St Dallas TX, 500 Commerce St Fort Worth TX, " +
      "and 9 Elm Ave Arlington TX.",
    expected: [{ name: "batch_geocode" }],
    results: R({ batch_geocode: '{"geocoded":3}' }),
    maxTurns: 6,
  },
  {
    id: "shape-rows-array",
    note: "values is an array of arrays. Sheets APIs are commonly mis-called with a flat string.",
    tools: ALL,
    prompt:
      "Use gdrive_sheets_append_rows to append two rows to spreadsheet 1AbC on range Log!A1:B2. " +
      "First row: 2026-07-28 and 412. Second row: 2026-07-29 and 517.",
    expected: [{ name: "gdrive_sheets_append_rows" }],
    results: R({ gdrive_sheets_append_rows: '{"updatedRows":2}' }),
    maxTurns: 6,
  },
  {
    id: "shape-waypoints",
    note: "start and end are objects, waypoints an array — three containers in one call.",
    tools: ALL,
    prompt:
      "Use optimize_waypoints starting at latitude 32.77 longitude -96.79, ending at latitude 32.75 " +
      "longitude -97.33, visiting waypoints at 32.80/-96.80 and 32.72/-97.10.",
    expected: [{ name: "optimize_waypoints" }],
    results: R({ optimize_waypoints: '{"order":[1,0]}' }),
    maxTurns: 6,
  },
  {
    id: "shape-enum-value",
    note: "analysis_type is an enum. A plausible-but-wrong value is the 23% failure class.",
    tools: ALL,
    prompt:
      "Use analyze_blob_with_gemini on the external URL https://example.com/invoice.pdf to read the " +
      "invoice total. Prompt it with 'extract the total'.",
    expected: [{ name: "analyze_blob_with_gemini" }],
    results: R({ analyze_blob_with_gemini: '{"total":"$1,204.00"}' }),
    maxTurns: 6,
  },
];
