# Coffee cooling lab — lid or no lid?

An example project for exploring ros.ai: five independent Topics and Activities, three completed local experiments, three plots, saved attempt history, explicit evidence reuse, and an optional canvas proposal. The project was created on September 21, 2026.

The [12 observations](observations.csv) are **synthetic teaching data**, authored for this example. No cups were measured. The metrics, tables and plots are real computations performed by ros.ai's bounded Python runner using the supplied [comparison](compare.py) and [target](target.py) code. Creation made **no paid provider calls**; project conversation used the labelled fixed-rule local helper.

## Five-minute tour

1. Open [local ros.ai](http://127.0.0.1:4310) and select **Coffee cooling lab — lid or no lid?** in the project list.
2. Open **Compare heat retention**. Its workspace contains three plots: the open cup, the lidded cup, and their temperature difference. Click **Open work tools** if the tools are collapsed, select **Experiment**, then inspect **Attempts & results** for the comparison table and metrics. Expand **Captured inputs, authority, runtime & logs** to see the recorded execution. **Load this version for revision** puts the saved CSV, code and parameters into the editor for inspection; loading alone does not run anything.
3. Open **Cooling evidence** to see a Topic and an Activity inside its workspace. **Cooling assumptions** explains the limits of the example. Open **Time above target** and use the **Experiment attempt** selector to compare the two saved attempts: a 70°C target and its 75°C revision. Each retains its own inputs, parameters and results.
4. Open **Real-world evidence → Inputs**. The comparison table was explicitly selected for reuse here. **Time above target → Inputs** similarly holds the selected dataset. The nodes have no connections and remain independent; selecting evidence does not schedule a run or refresh it automatically.
5. Open **Project conversation → Review proposed changes** to inspect the optional **Compare cup materials** Activity. It remains a preview until you choose **Accept changes** or **Dismiss**. Acceptance changes the canvas and does not start research.

The comparison and 70°C experiment were authorized together as a bounded Auto Research group with at most two workers. The 75°C revision was a separate approved attempt. These are completed records, so opening the project does not run them again.

## What the results show

| Result | Computed value |
| --- | ---: |
| Lidded cup advantage at minute 22 | 10.8°C |
| Mean paired temperature advantage | 6.375°C |
| Estimated extra time above 70°C with a lid | 7.07 minutes |
| Estimated extra time above 75°C with a lid | 4.85 minutes |

The time estimates use straight-line fits over 0–22 minutes. They illustrate changing a parameter while preserving an earlier experiment, rather than validating a cooling law. Plot positions follow observation order, with observations two minutes apart. Real-world conclusions would require measured data, controlled conditions, repeated trials and uncertainty estimates.

To try your own revision, select a target attempt, click **Load this version for revision**, change the request and parameters to `{"target_c":72}`, then choose **Preview a new attempt**. Review the captured dataset and code before **Allow & run**. A new attempt preserves both existing results. The runner exposes bounded numerical operations; imports, shell, network, arbitrary files and package installation are unavailable. These are application capability controls, not an OS sandbox.

## Create the example in another local workspace

Start ros.ai using the [root setup instructions](../../README.md#start-locally), then run from the repository root:

```sh
node scripts/create-example-project.mjs --create
```

This adds one project through the running app API and executes its three bounded local programs. Python must be available, and **all provider dollar limits must be zero** so the conversation helper stays local. The script stops before creation if either condition fails. It does not edit provider settings or credentials. For another local port, set `ROS_EXAMPLE_URL`, for example `ROS_EXAMPLE_URL=http://127.0.0.1:4311`.

The exact project title is the duplicate guard: if it already exists, the script leaves it unchanged and performs no new runs. It does not rebuild a partially created example with the same title. The [creation report](../../evidence/example-project/created.json) records project/run IDs, verified output values, unchanged existing projects, and the unchanged provider usage ledger.
