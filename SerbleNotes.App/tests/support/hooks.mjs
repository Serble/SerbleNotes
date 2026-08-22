/**
 * Lets node resolve the client's own imports.
 *
 * The app is bundled by Vite, so a module here says `from './tableFormat'` with no extension, the
 * way every other file in `src/` does. Node will not guess at an extension - correctly, for anything
 * it is asked to run in production - so this puts the `.ts` back for relative paths only, and only
 * when there was not an extension there already.
 *
 * The alternative was writing `.ts` into the imports of the files that happen to have tests, which
 * would make two import styles in one directory and put the reason in a comment nobody reads before
 * copying the file next to it.
 */
export async function resolve(specifier, context, next) {
  if (specifier.startsWith('.') && !/\.[cm]?[jt]sx?$/.test(specifier)) {
    try {
      return await next(`${specifier}.ts`, context);
    } catch {
      // Not a TypeScript module after all; let node answer for itself below.
    }
  }
  return next(specifier, context);
}
