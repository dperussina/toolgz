# Round 4 — cross-provider, pre-hardening

The 360-run sweep published in the first cross-provider version of
`docs/RESULTS.md`. Adapters were verified against current provider docs, so
these numbers are sound.

They are archived out of the top-level glob so `bench/analyze-multi.ts` cannot
pool them with round 5, which measures the hardened resolver
(near-miss argument hints, code-as-tool-name recovery, the `signature` map
style). Pooling two different library versions would produce a number that
describes neither.

Analyse explicitly with:

    npx tsx bench/analyze-multi.ts --dir=bench/results/round4
