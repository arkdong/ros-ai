# Short-window linear approximation on synthetic data; no physical validation.
time = column("minutes")
open_fit = linear_fit(time, column("open_c"))
lid_fit = linear_fit(time, column("lid_c"))
target = params["target_c"]
open_minutes = (target-open_fit["intercept"])/open_fit["slope"]
lid_minutes = (target-lid_fit["intercept"])/lid_fit["slope"]
metric("Target temperature (C)", target)
metric("Extra minutes above target with lid (model)", round(lid_minutes-open_minutes, 2))
table("Target crossing estimates - synthetic linear fit", [{"cup":"Open", "target_c":target, "estimated_minutes":round(open_minutes, 2), "slope_c_per_min":round(open_fit["slope"], 4), "r_squared":round(open_fit["r_squared"], 4)}, {"cup":"With lid", "target_c":target, "estimated_minutes":round(lid_minutes, 2), "slope_c_per_min":round(lid_fit["slope"], 4), "r_squared":round(lid_fit["r_squared"], 4)}])
table("Interpretation boundaries", [{"item":"Data", "meaning":"Synthetic teaching data; no real cups measured."}, {"item":"Model", "meaning":"Straight-line approximation over 0-22 minutes. A high R squared does not establish a physical model."}, {"item":"Target", "meaning":"70 C and 75 C lie within both sampled temperature ranges. Avoid distant extrapolation."}])
