import { RecipeRunner } from '../core/runner.ts'
import { BenchError } from '../core/errors.ts'

/** Start the recipe runtime for one command, and always dispose it. */
export async function withRunner<T>(root: string, use: (runner: RecipeRunner) => Promise<T>): Promise<T> {
  const runner = new RecipeRunner(root)
  try {
    await runner.start()
    return await use(runner)
  } catch (error) {
    // A refusal is not a runtime failure. Wrapping one would bury its kind — and a mistyped dataset
    // would surface as "the analysis runtime cannot modify the log", which is a true sentence about
    // the wrong thing.
    if (error instanceof BenchError) throw error
    // The interpreter is a separate process with no write access to the log, so a failure here can
    // never damage the data. Say so, because "analysis broke" reads as "data is at risk".
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`${message} — the analysis runtime cannot modify the log, so nothing was lost`)
  } finally {
    await runner.dispose()
  }
}
