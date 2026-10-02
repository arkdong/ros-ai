"""One historical risk baseline; actual saved local Python execution."""
prices = df.copy()
prices['date'] = pd.to_datetime(prices['observation_date'],format='%Y-%m-%d')
assert prices['date'].is_unique
prices['price'] = pd.to_numeric(prices['SP500'],errors='coerce')
missing = int(prices['price'].isna().sum())
prices = prices.sort_values('date').dropna(subset=['price']).reset_index(drop=True)
assert prices['date'].iloc[0] == pd.Timestamp('2018-01-02') and prices['date'].iloc[-1] == pd.Timestamp('2021-12-31')
assert prices['price'].gt(0).all()
prices['return'] = prices['price'].pct_change(fill_method=None)
prices['loss'] = -prices['return']
# At row t, shift(1) excludes today's loss before a complete 252-loss window.
prices['threshold'] = prices['loss'].shift(1).rolling(252,min_periods=252).quantile(.95,interpolation='linear')
prices['drawdown'] = prices['price']/prices['price'].cummax()-1
eligible = prices['threshold'].notna() & prices['date'].between('2019-01-01','2021-12-31')
evaluation = prices.loc[eligible].copy()
evaluation['exceedance'] = evaluation['loss'] > evaluation['threshold']
assert evaluation['date'].min() == pd.Timestamp('2019-01-04')
checks=[]
for idx in [int(evaluation.index[0]),int(evaluation.loc[evaluation['date'].eq('2020-03-16')].index[0]),int(evaluation.index[-1])]:
    prior=prices.loc[idx-252:idx-1,'loss']
    assert len(prior)==252 and prior.notna().all()
    expected=float(np.quantile(prior.to_numpy(),.95,method='linear'))
    assert np.isclose(expected,prices.loc[idx,'threshold'],rtol=0,atol=1e-14)
    # Perturb the current outcome; its own threshold must not move.
    changed=prices['loss'].copy(); changed.loc[idx]=123.456
    check=changed.shift(1).rolling(252,min_periods=252).quantile(.95,interpolation='linear').loc[idx]
    assert float(check)==float(prices.loc[idx,'threshold'])
    checks.append({'evaluation_date':str(prices.loc[idx,'date'].date()),'oldest_input':str(prices.loc[idx-252,'date'].date()),'latest_input':str(prices.loc[idx-1,'date'].date()),'prior_losses':252,'independent_quantile':expected,'current_day_perturbation_changes_threshold':False})
rows=[]
for label, group in [('All eligible days',evaluation)]+[(str(y),evaluation[evaluation['date'].dt.year.eq(y)]) for y in [2019,2020,2021]]:
    rows.append({'period':label,'observations':len(group),'exceedances':int(group['exceedance'].sum()),'exceedance_percent':float(group['exceedance'].mean()*100),'nominal_expected_count_5pct':len(group)*.05,'daily_return_sd_percent':float(group['return'].std(ddof=1)*100),'median_loss_threshold_percent':float(group['threshold'].median()*100),'max_loss_threshold_percent':float(group['threshold'].max()*100)})
summary=pd.DataFrame(rows)
metric('Evaluation observations · 2019–2021',len(evaluation))
metric('Loss threshold exceedances',f"{int(evaluation['exceedance'].sum())}/{len(evaluation)} ({evaluation['exceedance'].mean()*100:.2f}%)")
metric('Worst price drawdown · 2018–2021',f"{prices['drawdown'].min()*100:.2f}%")
table('Exceedances · strictly preceding 252 daily losses',summary.round(4))
table('No-look-ahead checks · three exact windows',pd.DataFrame(checks))
table('Input and evaluation audit',pd.DataFrame([{'raw_weekday_rows':len(df),'blank_price_rows_excluded':missing,'observed_prices':len(prices),'evaluation_start':str(evaluation['date'].min().date()),'evaluation_end':str(evaluation['date'].max().date()),'duplicate_dates':0,'quantile':'linear','window':252,'percentile':.95,'price_convention':'S&P 500 price index; dividends excluded'}]))
plt.rcParams.update({'font.family':'DejaVu Sans','font.size':11,'axes.spines.top':False,'axes.spines.right':False,'svg.fonttype':'none'})
fig,ax=plt.subplots(figsize=(11,5.8))
ax.plot(evaluation['date'],100*evaluation['return'],color='#829ca6',linewidth=.7,label='Observed daily simple return')
ax.plot(evaluation['date'],-100*evaluation['threshold'],color='#274f5b',linewidth=1.7,label='Negative 95% loss threshold, prior 252 days')
breaches=evaluation[evaluation['exceedance']]
ax.scatter(breaches['date'],100*breaches['return'],color='#b85a38',s=15,zorder=3,label=f'Exceedances (n={len(breaches)})')
ax.axvspan(pd.Timestamp('2020-01-01'),pd.Timestamp('2020-12-31'),color='#c9c6b8',alpha=.18,label='Preselected 2020 comparison')
ax.set(title='A historical threshold meets subsequent daily returns',ylabel='Daily simple return (%)',xlabel='Observation date · 2019–2021')
ax.legend(frameon=False,fontsize=8,loc='lower left');ax.grid(axis='y',alpha=.18)
fig.subplots_adjust(left=.09,right=.98,top=.88,bottom=.22)
fig.text(.09,.045,'S&P Dow Jones Indices LLC via FRED · SP500 price index; dividends excluded\nEvery threshold uses 252 strictly preceding losses. Nominal 5% is a reference, not a guarantee of future calibration.',fontsize=9)
plot('Realized returns and prior-loss threshold · S&P 500',fig)
fig,ax=plt.subplots(figsize=(11,5.4))
ax.fill_between(prices['date'],100*prices['drawdown'],0,color='#d4dfe2')
ax.plot(prices['date'],100*prices['drawdown'],color='#274f5b',linewidth=1.3)
ax.axvspan(pd.Timestamp('2020-01-01'),pd.Timestamp('2020-12-31'),color='#c9c6b8',alpha=.18)
ax.set(title='Price drawdown from the running observed high',ylabel='Drawdown (%)',xlabel='Observation date · 2018–2021');ax.grid(axis='y',alpha=.18)
fig.subplots_adjust(left=.09,right=.98,top=.88,bottom=.22)
fig.text(.09,.045,'S&P Dow Jones Indices LLC via FRED · running maximum starts with the first retained price in January 2018\nPrice-only drawdown excludes dividends; an index is not a directly investable portfolio and trading costs are absent.',fontsize=9)
plot('Drawdown · declared price convention',fig)
export_csv('Daily calculation audit · observed prices only',prices.assign(date=prices['date'].dt.strftime('%Y-%m-%d'))[['date','price','return','loss','threshold','drawdown']].round(10))
y2020=rows[2]; y2019=rows[1]; y2021=rows[3]
conclusion(f"The 95% historical loss threshold was exceeded on {rows[0]['exceedances']} of {rows[0]['observations']} eligible days ({rows[0]['exceedance_percent']:.2f}%). Yearly counts were {y2019['exceedances']}/{y2019['observations']} in 2019, {y2020['exceedances']}/{y2020['observations']} in 2020 and {y2021['exceedances']}/{y2021['observations']} in 2021. Daily-return standard deviation was {y2019['daily_return_sd_percent']:.2f}%, {y2020['daily_return_sd_percent']:.2f}% and {y2021['daily_return_sd_percent']:.2f}%, respectively, confirming greater observed variability in the preselected 2020 comparison. Worst price drawdown over the input period was {prices['drawdown'].min()*100:.2f}%. The rolling threshold changes as older observations leave its window; sudden large losses can arrive before history reflects them. Exceedances are dependent market observations, not independent calibration trials. This retrospective baseline does not establish future risk calibration, statistical significance, a trading strategy or proprietary Earthian AI performance. Figures are saved calculations; no app-model inference was used.")
