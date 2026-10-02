df = df.copy()
df['observation_date'] = pd.to_datetime(df['observation_date'])
df['SP500'] = pd.to_numeric(df['SP500'], errors='coerce')
df = df.dropna(subset=['SP500']).sort_values('observation_date').reset_index(drop=True)
df['loss'] = -(df['SP500'] / df['SP500'].shift(1) - 1)

eligible = df[(df['observation_date'] >= '2019-01-04') & (df['observation_date'] <= '2021-12-31')].copy()

for w in [252, 126]:
    eligible[f'thresh_{w}'] = eligible['loss'].rolling(w, min_periods=w).apply(lambda x: np.percentile(x, 95), raw=True).shift(1)
    eligible[f'exceed_{w}'] = eligible['loss'] > eligible[f'thresh_{w}']

eligible['year'] = eligible['observation_date'].dt.year
eligible['quarter'] = eligible['observation_date'].dt.to_period('Q')

yearly = eligible.groupby('year').agg(
    n_252=('exceed_252', 'sum'),
    n_126=('exceed_126', 'sum'),
    total=('loss', 'count')
).reset_index()

overall = pd.DataFrame({
    'year': ['Overall'],
    'n_252': [eligible['exceed_252'].sum()],
    'n_126': [eligible['exceed_126'].sum()],
    'total': [len(eligible)]
})

yearly = pd.concat([yearly, overall], ignore_index=True)

q2020 = eligible[eligible['year'] == 2020].groupby('quarter').agg(
    n_252=('exceed_252', 'sum'),
    n_126=('exceed_126', 'sum'),
    total=('loss', 'count')
).reset_index()

table('Yearly Exceedances', yearly)
table('2020 Quarterly Exceedances', q2020)
