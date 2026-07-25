# Spec 001 — Core compression

**Status**: implemented · **Evidence**: sweep `2026-07-25T15-07-49-579Z`

## Problem

An agent wired to many MCP servers spends 30–50k context tokens on tool
definitions before the conversation starts. Prompt caching makes those tokens
cheap to re-read; it does not make them take up less room. The scarce resource
is context-window occupancy.

## Users

Developers building agents who already have tool definitions in MCP shape and
want them smaller without changing anything downstream.

## Requirements

### Functional
- **FR1** Accept tools in MCP shape (`name`, `description`, `inputSchema`),
  tolerating `input_schema` as an alias.
- **FR2** Emit provider-ready tool definitions at four levels of compression,
  each a superset of the one below.
- **FR3** Translate any raw model tool call back to the original tool name and
  arguments (`resolve`).
- **FR4** Validate arguments against the *original* schema before dispatch;
  return a model-readable error naming tool, parameter, and recovery path.
- **FR5** Expose meta-calls so the model can recover a full definition from a
  compressed reference (`describe_op` at L2, `q` at L3).
- **FR6** Recommend a level from the shape of the tool set, never returning a
  level that trades accuracy for tokens.
- **FR7** Provide provider adapters that place cache breakpoints correctly.

### Non-functional
- **NFR1** Zero runtime dependencies; no network calls from the core.
- **NFR2** Byte-identical output for identical input (cache prefix stability).
- **NFR3** Levels 0 and 1 preserve provider-side constrained decoding.
- **NFR4** Every published number traces to a row in `bench/results/`.

## Success criteria

- **SC1** L1 reduces prompt tokens with no measurable accuracy or turn penalty.
  → **met**: −28% prompt, 0 malformed, 4.1 turns vs 4.1 control.
- **SC2** The highest level reduces context occupancy by >70%.
  → **met**: L3 −79% (12,512 vs 58,950 avg prompt tokens).
- **SC3** No level silently degrades task completion.
  → **met in round 1** (28/28 every arm); accuracy probe run separately because
  round 1 could not discriminate.

## Out of scope

- Rewriting tool semantics or merging tools.
- Runtime tool discovery from a live MCP server.
- Anything that requires the library to make a network call.
