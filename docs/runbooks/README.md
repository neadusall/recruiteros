# `runbooks/` — operational runbooks

Concrete, execute-it-now playbooks for **specific campaigns or sourcing runs**, kept together with
the data files they use. Unlike `playbooks/` (general reference), these are tied to a real, named job.

| File | What it is |
|---|---|
| **jaggaer-vp-sales-east.md** | Runbook for the Jaggaer "VP Sales, East" sourcing run — the steps to execute it. |
| **jaggaer-vp-sales-east-sourcing.csv** | The candidate/sourcing data the runbook above loads. Keep it next to its runbook. |

> When you add a new run, drop both the `.md` runbook and any `.csv`/data it needs in here together.
