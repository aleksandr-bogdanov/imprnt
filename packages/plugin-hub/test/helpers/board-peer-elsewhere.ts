// Test infrastructure: a preload that makes the board's program take every
// request as coming from another machine.
//
// The board refuses an act whose peer is one of its own machine's addresses,
// and a check running on that machine can reach it from nowhere else, so the
// real program could never be seen accepting an act. This preload replaces the
// one function that answers "is this address mine" with one that says no, for
// the process it is loaded into and nothing else. The shipped rule itself is
// asserted by the checks that run the program without it.
import { plugin } from "bun"

plugin({
  name: "board-peer-elsewhere",
  setup(build) {
    build.onLoad({ filter: /\/src\/net\/address\.ts$/ }, async (args) => {
      const text = await Bun.file(args.path).text()
      const shipped = "export function isLocalAddress("
      if (!text.includes(shipped)) throw new Error(`${args.path} no longer defines isLocalAddress`)
      return {
        contents: text.replace(shipped,
          "export function isLocalAddress(..._: unknown[]): boolean { return false }\nfunction shippedIsLocalAddress("),
        loader: "ts",
      }
    })
  },
})
