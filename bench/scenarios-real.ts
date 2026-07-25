/**
 * Accuracy suite built on real MCP tools.
 *
 * Every scenario exposes the ENTIRE 149-tool catalogue harvested from 14 live
 * servers, because that is the condition compression has to survive: a model
 * picking one tool out of a real deployment, not out of a curated shortlist.
 * Uncompressed that block is ~68,500 prompt tokens on claude-opus-5.
 *
 * The confusable pairs here were not invented — they already existed in the
 * catalogue, which is what makes them worth testing:
 *
 *   scorecard_lf            vs scorecard_lf_daily          (weekly vs daily grain)
 *   scorecard_edemand       vs scorecard_edemand_detail    (rollup vs row-level)
 *   accessorial_revenue_summary vs ..._details             (roll-up vs detail)
 *   order_path              vs order_path_financial        (ops vs financial variant)
 *   gdrive_sheets_update_range vs gdrive_sheets_append_rows (overwrite vs append)
 *   gdrive_search           vs gdrive_search_by_name       (content vs name match)
 *   geocode_address         vs reverse_geocode             (opposite directions)
 *   coding_task_status      vs coding_task_result          (progress vs output)
 *   get_document            vs get_label_data              (URLs vs raw label data)
 *   query_model             vs query_all_models            (one vs all)
 *
 * Ten of the fifty-one data-sources tools are weekly/daily twins distinguished
 * only by a `_daily` suffix. That is the hardest case for name minification: the
 * entire signal is in the suffix, and a compressed map must preserve it.
 *
 * Each `expected` entry was checked against the tool's own advertised
 * description, not guessed from its name.
 */
import { realSubset } from "./fixtures/real.js";
import type { Scenario } from "./scenarios.js";

/** The full real catalogue. Every scenario sees all of it. */
const ALL = realSubset();

const R = (o: Record<string, string>) => o;

export const REAL_SCENARIOS: Scenario[] = [
  {
    id: "real-daily-vs-weekly",
    note: "The whole distinction is a _daily suffix. Ten such twins exist in the catalogue.",
    tools: ALL,
    prompt:
      "I need the day-by-day Lost Freight rollup for each FC, not the weekly one. Pull that data source.",
    expected: [{ name: "scorecard_lf_daily" }],
    results: R({ scorecard_lf_daily: '{"rows":412,"grain":"daily"}' }),
    maxTurns: 6,
  },
  {
    id: "real-rollup-vs-detail",
    note: "Row-level vs per-FC rollup for the same metric; only 'detail' separates them.",
    tools: ALL,
    prompt:
      "Give me the row-level eDemand records, one row per order — not the weekly summary numbers.",
    expected: [{ name: "scorecard_edemand_detail" }],
    results: R({ scorecard_edemand_detail: '{"rows":9081}' }),
    maxTurns: 6,
  },
  {
    id: "real-summary-vs-details",
    note: "Accessorial revenue: per-year roll-up vs invoice-level detail.",
    tools: ALL,
    prompt:
      "I want the per-year roll-up of accessorial charges for the Control Tower sync, not the line-item breakdown.",
    expected: [{ name: "accessorial_revenue_summary" }],
    results: R({ accessorial_revenue_summary: '{"years":4}' }),
    maxTurns: 6,
  },
  {
    id: "real-financial-variant",
    note: "order_path vs order_path_financial: same domain, one is the financial variant.",
    tools: ALL,
    prompt:
      "Sync the financial variant of the network planning order path data source into Control Tower.",
    expected: [{ name: "order_path_financial" }],
    results: R({ order_path_financial: '{"rows":22140}' }),
    maxTurns: 6,
  },
  {
    id: "real-overwrite-vs-append",
    note: "Destructive vs additive Sheets write. Picking wrong destroys data.",
    tools: ALL,
    prompt:
      "Add three new rows to the bottom of the 'Log' tab in spreadsheet 1AbC without touching the existing rows. The range is Log!A1:C1 and the values are [[\"a\",\"b\",\"c\"]].",
    expected: [{ name: "gdrive_sheets_append_rows", args: { spreadsheet_id: "1AbC" } }],
    results: R({ gdrive_sheets_append_rows: '{"appended":3}' }),
    maxTurns: 6,
  },
  {
    id: "real-search-by-name",
    note: "gdrive_search (content/properties) vs gdrive_search_by_name (partial name match).",
    tools: ALL,
    prompt:
      'Find Google Drive files whose filename partially matches "Q3 forecast". Match on the name only.',
    expected: [{ name: "gdrive_search_by_name" }],
    results: R({ gdrive_search_by_name: '{"files":[{"id":"f1","name":"Q3 forecast v2"}]}' }),
    maxTurns: 6,
  },
  {
    id: "real-reverse-geocode",
    note: "Opposite directions of the same conversion; also a batch variant to avoid.",
    tools: ALL,
    prompt: "Turn latitude 32.7767 and longitude -96.7970 into a street address.",
    expected: [{ name: "reverse_geocode" }],
    results: R({ reverse_geocode: '{"address":"500 S Ervay St, Dallas, TX"}' }),
    maxTurns: 6,
  },
  {
    id: "real-status-vs-result",
    note: "coding_task_status (progress) vs coding_task_result (finished output).",
    tools: ALL,
    prompt:
      "Task abc-123 has finished. Fetch its full output so I can read what it produced.",
    expected: [{ name: "coding_task_result", args: { taskId: "abc-123" } }],
    results: R({ coding_task_result: '{"status":"complete","output":"…"}' }),
    maxTurns: 6,
  },
  {
    id: "real-label-data-vs-document",
    note: "get_document returns URLs/PDF/ZPL; get_label_data returns data for custom label generation.",
    tools: ALL,
    prompt:
      "For tracking number FP12345 I need the electronic label data so we can generate our own label in-house — not a link to a PDF or ZPL file.",
    expected: [{ name: "get_label_data", args: { trackingNumber: "FP12345" } }],
    results: R({ get_label_data: '{"zpl_fields":{"to":"…"}}' }),
    maxTurns: 6,
  },
  {
    id: "real-one-vs-all-models",
    note: "query_model (single, requires model arg) vs query_all_models (all four in parallel).",
    tools: ALL,
    prompt:
      'Ask all four AI models the same question in parallel: "what is the capital of France?"',
    expected: [{ name: "query_all_models" }],
    results: R({ query_all_models: '{"grok":"Paris","gemini":"Paris","claude":"Paris","openai":"Paris"}' }),
    maxTurns: 6,
  },
  {
    id: "real-two-step-scheduling",
    note: "Ordering dependency: options must be fetched before a resource ID can be chosen.",
    tools: ALL,
    prompt:
      "Order FP99887 needs a delivery slot booked for zip 75201. Find the available slots, then schedule it using the first resource ID you get back.",
    expected: [
      { name: "get_scheduling_options", args: { zipCode: "75201" } },
      { name: "schedule_order", args: { resourceId: "RES-7" } },
    ],
    results: R({
      get_scheduling_options: '{"slots":[{"resourceId":"RES-7","window":"2026-08-03 08:00-12:00"}]}',
      schedule_order: '{"scheduled":true,"resourceId":"RES-7"}',
    }),
    maxTurns: 8,
  },
  {
    id: "real-transit-vs-route",
    note: "get_transit_time (zip-to-zip business days) vs compute_route (maps routing).",
    tools: ALL,
    prompt:
      "How many days will a FragilePAK shipment take between zip 75201 and zip 30301? I want the transit time in days, not a driving route.",
    expected: [{ name: "get_transit_time" }],
    results: R({ get_transit_time: '{"days":3}' }),
    maxTurns: 6,
  },
];
