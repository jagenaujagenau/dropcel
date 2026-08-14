# oxlint plugins

Two plugins, kept apart because they come from different places.

## `dropcel/` — ours

Rules about this codebase's own conventions, chiefly its Effect v4 usage.
Written here, edited here, linted like the rest of the app. Add rules to
`dropcel/rules/`, register them in `dropcel/index.ts`, and switch them on in
`.oxlintrc.json`.

## `anti-slop/` — vendored

Installed by the `install-anti-slop` skill and updated by re-running its
installer over this directory:

```
node <skill-dir>/scripts/install.mjs tools/oxlint/anti-slop
```

Do not edit it. The installer owns the directory and will replace it wholesale,
so local changes are lost on the next update — and `.oxlintrc.json` ignores it
for that reason: vendored source is not ours to restyle.

Disagreements with a rule belong in `.oxlintrc.json` (off, or scoped to the
modules where it misfires) or in an `oxlint-disable-next-line` comment with the
reason at the site. Both are in use — see the overrides for the boundary
modules that parse the outside world, where taking `unknown` and narrowing it
with `typeof` is the job rather than a lapse.
