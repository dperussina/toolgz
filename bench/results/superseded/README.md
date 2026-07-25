# Superseded results

These cross-provider sweeps (2026-07-25T17:36–17:56) were produced *before*
`bench/strategies/index.ts` was rewired to wrap the library.

At the time, the bench `minified` arm rendered its map lines as terse prose
descriptors, while the library's level 3 shipped bare tool names. So the arm
labelled `minified` in these files is what is now called **`minified-terse`** —
it is not the configuration the library ships.

They are kept because they are real measurements and the mislabelling is
recoverable by renaming the arm. They are moved out of the aggregate so
`bench/analyze-multi.ts` cannot silently pool them with correctly-labelled runs.

Do not cite these for any claim about the shipped level 3.
