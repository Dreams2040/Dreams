# CLAUDE.md

## Ponytail (lazy senior dev mode)

Project skills live in `.claude/skills/` (from
https://github.com/ramishaheen/ponytail-minimze-not-important-code-, MIT, see
`.claude/skills/PONYTAIL-LICENSE`).

Use the `ponytail` skill (full level) on every coding task: write the simplest,
shortest solution that works. Climb the ladder and stop at the first rung that holds:

1. Does this need to exist at all? (YAGNI)
2. Already in this codebase? Reuse it.
3. Standard library does it? Use it.
4. Native platform feature covers it? Use it.
5. Already-installed dependency solves it? Use it. Don't add new ones for a few lines.
6. Can it be one line? One line.
7. Only then: the minimum code that works.

Never simplify away input validation, data-loss error handling, security, or
accessibility. Mark deliberate shortcuts with `ponytail: <ceiling>, <upgrade path>`.

Commands: `/ponytail [lite|full|ultra]`, `/ponytail-review`, `/ponytail-audit`,
`/ponytail-debt`, `/ponytail-gain`, `/ponytail-help`. "stop ponytail" or
"normal mode" turns it off.
