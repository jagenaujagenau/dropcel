# Dropcel

The domain of a folder-as-deploy-surface desktop app: every top-level
directory in the user's ~/Vercel folder is a project that deploys to
production when its contents change. Terms here name the concepts the code
is organized around; ARCHITECTURE.md explains the mechanisms behind them.

## Language

### The folder

**Project**:
A top-level directory in the root folder, linked 1:1 to a Vercel project.
_Avoid_: site, app, deployment target

**Root folder**:
The single watched directory (~/Vercel) whose contents ARE the set of projects.
_Avoid_: workspace, sync folder

**Reconcile**:
Comparing the root folder's directories against the project rows and resolving
every difference (add, remove, rename, adopt).
_Avoid_: sync, scan, refresh

**Reconciler**:
The module that owns reconcile and fs-change interpretation — the meaning of
"folder = truth" lives here.

**Adoption**:
Wrapping a loose file dropped at the root (e.g. an .html) into a project of
its own.

**Legit rename**:
A vanished+appeared directory pair whose travelling `.vercel/project.json`
id matches the stored link; only then does history follow the folder.

### Deploying

**Deployment**:
One attempt to put a project's current contents live; advances monotonically
through the state machine (queued → preparing → uploading → building →
ready/failed/canceled).

**Queue**:
The per-project serializer: debounces changes, coalesces mid-deploy edits
into exactly one follow-up, and applies the retry policy.

**Deployer**:
The seam hiding deploy transport; `api-deployer` is the REST adapter, tests
script a mock adapter.

**Guard (content-digest)**:
The check that skips an auto-deploy when the recomputed content digest
matches the last successful deploy. Never consulted for manual deploys.

**Gate (git)**:
The check that holds auto-deploys while a git operation is mid-flight or a
branch lock is violated. Manual deploys always bypass gates.
_Avoid_: using "guard" and "gate" interchangeably — guards compare content,
gates inspect repository state.

**AutoDeployGate**:
The module owning the Gate: the account-switch/git-operation branching, the
held-changes marking, and the 15s timer that re-checks a project stuck
mid-git-operation until it clears (or the project vanishes). Its one entry
point, `notifyChangeGitGated`, hides all of that from callers.

**Hold**:
A named reason a project's auto-deploys are suspended: `offline`,
`account-switch`, or `git-operation`. Holds accumulate changes instead of
deploying them.

**Held changes**:
The single ledger of projects with active holds (module `held-changes`);
releasing a project's last hold drains it exactly once.
_Avoid_: dirty set, held set, pending changes (older names for its parts)

**Drain**:
Deploying each previously-held project exactly once after its holds clear.

### Identity

**Account session**:
The module owning the token lifecycle (keychain, CLI import, OAuth refresh,
single-flight renewal) and the owner-identity check behind it.

**Account switch**:
A detected change of token-owner uid; unresolvable by the app, so it holds
auto-deploys until the user chooses Keep Links or Start Fresh.

**Link**:
The stored association project → Vercel project id (+ team id), mirrored
into `.vercel/project.json` so it travels with the folder.

### Effects

**Effects seams**:
The injected ports for user-visible side effects — Notifier, ClipboardPort,
TrayPort, Connectivity — so policy modules never import a plugin directly.

**Public URL**:
The stable alias URL users share (custom domain > project alias), as opposed
to the per-deployment `dpl_…` URL.
_Avoid_: deployment URL when the shareable one is meant

**ReadyEffects**:
The module (`core/ready-effects.ts`) owning what a **Deployment** does once
it reaches a terminal state: persist the transition, and — on ready —
resolve the **Public URL**, persist it, capture a dashboard snapshot, copy
it to the clipboard, and notify. Two entry points (`onTransition`,
`onReady`) hide that whole ordering, the same way **Reconciler** exposes
`reconcile`/`handleFsChanges` instead of every internal step.

## Relationships

- The **Reconciler** turns fs events into **Project** changes and asks the **Queue** to deploy.
- The **Queue** consults the **Guard**, and **AutoDeployGate** consults the **Gate**, before an auto **Deployment**.
- Any **Hold** routes a project's changes into **Held changes**; releasing the last hold **drains** it.
- The **Account session** raises **Account switch**, which places an `account-switch` **Hold** on every project.
- A **Deployment** that reaches ready is handed to **ReadyEffects**, which resolves the **Public URL** and refreshes the effects seams (tray, notification, clipboard).

## Example dialogue

> **Dev:** "The user went offline mid-rebase — do we deploy twice when both clear?"
> **Domain expert:** "No. Both are just **holds** on the same project in **held changes**; when the last one releases, the project **drains** — one deployment, current contents."

## Flagged ambiguities

- "dirty" historically meant only the offline hold's persisted set; it is now
  one reason within **Held changes** — resolved: say "held (offline)".
- "guard" vs "gate" were used loosely — resolved: guards compare content,
  gates inspect git state.
