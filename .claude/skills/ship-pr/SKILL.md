---
name: ship-pr
description: Ship a change on PropLync.mx the way this repo does it: branch, test, commit, PR, then merge and verify only when the user says so. Use when the user asks to open, merge or verify a PR here.
---

# ship-pr

1. **Branch** off an up-to-date `main` (`git checkout main && git pull`, then `git checkout -b <short-name>`). Never push to `main`.
2. **Stage by name** (`git add <files>`), never `git add -A`: the working tree has untracked files that aren't ours (`proplync-mx/`, plan `.md` files, `skills-lock.json`, `.claude/skills/grill*`).
3. **Test:** `npm test`. For UI, check 390 px with gstack `/browse`. Note what was not tested.
4. **Commit** with a message that explains why. End it with the two attribution lines the session's system reminder gives (`Co-Authored-By: …` and `Claude-Session: …`).
5. **PR:** `git push -u origin <branch>` then `gh pr create`. The body has Summary, Why, Tested, Not tested, and ends with `🤖 Generated with [Claude Code](https://claude.com/claude-code)` plus the session link.
6. **Stop.** Merge only when the user says so ("merge #N").
7. **Merge:** `gh pr merge N --squash --subject "<title> (#N)"`; confirm with `gh pr view N --json state`.
8. **Verify production:** the Vercel deployment for the merge commit reaches READY, then probe the changed page or endpoint. Report plainly what was checked.
9. Back to `main`, pull, and tell the user about any production rows or leftovers.
