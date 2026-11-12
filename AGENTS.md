# Code guidelines

- Follow existing code practices and naming conventions in the surrounding files.
- Treat readability and understandability as part of correctness. Prefer clear,
  direct code over compact expressions or clever abstractions.
- Use consistent indentation, braces around control flow, and one statement per
  line. Use blank lines to separate logical steps and avoid long, dense lines.
- Add a short function-level summary explaining intent. Add inline comments for
  non-obvious decisions, security boundaries, or invariants; avoid narrating code.
- Give variables and functions descriptive names. Extract small helpers when they
  represent a distinct responsibility or reusable operation. Avoid abstractions
  that add indirection without making the caller easier to understand.
- Keep HTML, CSS, configuration, and tests readable too. Format nested markup and
  objects across lines; group test setup, actions, and assertions logically.
- Preserve behavior during readability refactors. Run `npm test` after changing
  authentication or upload logic. For proxy/container changes, also build the
  image and run the disposable smoke checks described in README.md.
- Keep model links public and private auth data outside the served directories.
  Maintain one app instance per file-based account store.
