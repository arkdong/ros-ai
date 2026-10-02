# Synthetic teaching data. These are real computations, not real cup measurements.
open_c = column("open_c")
lid_c = column("lid_c")
advantage = [lid_c[0]-open_c[0], lid_c[1]-open_c[1], lid_c[2]-open_c[2], lid_c[3]-open_c[3], lid_c[4]-open_c[4], lid_c[5]-open_c[5], lid_c[6]-open_c[6], lid_c[7]-open_c[7], lid_c[8]-open_c[8], lid_c[9]-open_c[9], lid_c[10]-open_c[10], lid_c[11]-open_c[11]]
metric("Lid advantage at 22 minutes (C)", round(advantage[11], 2))
metric("Mean paired lid advantage (C)", round(mean(advantage), 3))
table("Synthetic cooling comparison", [{"cup": "Open", "start_c": open_c[0], "end_c": open_c[11], "drop_c": round(open_c[0]-open_c[11], 2), "mean_c": round(mean(open_c), 2)}, {"cup": "With lid", "start_c": lid_c[0], "end_c": lid_c[11], "drop_c": round(lid_c[0]-lid_c[11], 2), "mean_c": round(mean(lid_c), 2)}])
plot("Lid advantage (C) - observations every 2 min", advantage)
plot("Open cup (C) - observations every 2 min", open_c)
plot("Lidded cup (C) - observations every 2 min", lid_c)
