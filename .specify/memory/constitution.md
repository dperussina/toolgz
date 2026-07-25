# ToolCompression Constitution

Non-negotiable principles for this codebase. Specs, plans, and tasks are
checked against these at `/speckit-plan`.

## Core Principles

### I. This is a library, not an application

Consumers install it and wrap it around their own tool definitions.

- The public API is small, typed, and stable. Internals may churn freely.
- No global state, no singletons, no required init step, no ambient config.
- **The library core makes no network calls.** A `fetch` in `src/render/` or
  `src/runtime/` is a defect. Network belongs to `bench/`.
- No runtime dependencies. If one seems necessary, the scope is wrong.
- `compress()` is referentially transparent: same tools in, byte-identical
  payload out.

### II. Determinism is a correctness property

Prompt caching is a prefix match. Any byte that changes between two otherwise
identical requests silently destroys the cache and the savings this library
exists to deliver.

- Tool ordering is sorted, never insertion- or iteration-order dependent.
- No `Date.now()`, no `Math.random()`, no unsorted iteration, no
  locale-dependent formatting anywhere in output.
- A test asserts `compress(x)` twice produces identical bytes. It does not get
  deleted.

### III. Measured, not asserted (NON-NEGOTIABLE)

No performance or accuracy claim ships without a row in `bench/results/`.

- "Should save roughly 40%" is a guess, not a claim. Do not write it.
- Every default traces to a benchmark result recorded in `brain.db` as a
  decision with an evidence pointer.
- Losing results are published alongside winning ones. A losing arm is a
  finding, not an embarrassment.
- When a test encodes an assumption that measurement contradicts, **the test is
  wrong**. Fix the test to describe reality, and say so in the commit.

### IV. Accuracy is the constraint; tokens are the objective

Nobody installs a compressor that quietly makes their agent worse.

- Any level that trades accuracy for tokens is **opt-in** and documented as
  such. `recommendLevel()` never returns it.
- Argument validation runs against the *original* schema before dispatch at
  every level. Losing provider-side constrained decoding is a real cost; the
  middleware must catch what the sampler no longer can.
- Error strings returned to the model are written for the model to read: name
  the tool, name the parameter, state the recovery path.

### V. Test-driven

- Write the failing test first; it must fail for the stated reason.
- Every level round-trips: encode a call, resolve it, get the original tool and
  arguments back. Table-driven across all levels, not bespoke per level.
- Error paths are tested as thoroughly as happy paths — hallucinated names,
  missing and unknown parameters, wrong types, stringified argument bags.
- Provider adapters are tested against constraints the provider actually
  enforces, verified against the live API, not against what we assume.

### VI. Honest documentation

- Document the crossover, not just the best case. A level that wins at 100
  tools and loses at 10 says so where the reader will see it.
- State what the library does *not* do.
- Every number in the README carries the scenario and model it came from.

## Governance

Amendments require a recorded decision in `brain.db` with rationale and
evidence. A spec that violates a principle is rejected at `/speckit-plan`, not
patched at review.

**Version**: 1.0.0 | **Ratified**: 2026-07-25 | **Last Amended**: 2026-07-25
