#!/usr/bin/env node
/** `toolgz <command>`. Only `compile` exists; everything else is library API. */
const [, , command, ...rest] = process.argv;

if (command === "compile") {
  process.argv = [process.argv[0], process.argv[1], ...rest];
  await import("./compile.js");
} else {
  console.log(`toolgz — compress LLM tool definitions

  toolgz compile --tools <path>   compile a catalogue into a Python map for level 4
  toolgz compile --help           options

Everything else is library API: https://github.com/dperussina/toolgz#readme`);
  process.exit(command ? 1 : 0);
}
