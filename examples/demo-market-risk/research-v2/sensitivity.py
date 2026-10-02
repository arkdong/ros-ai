"""Prepared sensitivity: one shorter history, fixed common evaluation, no fitted choices."""
p = df.copy()
p['date'] = pd.to_datetime(p['observation_date'], format='%Y-%m-%d')
p['price'] = pd.to_numeric(p['SP500'], errors='coerce')
p = p.sort_values('date').dropna(subset=['price']).reset_index(drop=True)
p['return'] = p['price'].pct_change(fill_method=None)
p['loss'] = -p['return']
for w in [126, 252]:
    p[f'q{w}'] = p['loss'].shift(1).rolling(w, min_periods=w).quantile(.95, interpolation='linear')
    p[f'breach{w}'] = p['loss'] > p[f'q{w}']
e = p[p['q252'].notna() & p['date'].between('2019-01-01', '2021-12-31')].copy()
assert len(e) == 755
assert int(e['breach252'].sum()) == 31
assert [int(e[e['date'].dt.year.eq(y)]['breach252'].sum()) for y in [2019,2020,2021]] == [4,21,6]
rows = []
for label,g in [('2019–2021', e)] + [(str(y), e[e['date'].dt.year.eq(y)]) for y in [2019,2020,2021]]:
    for w in [126,252]:
        rows.append({'period':label, 'prior_sessions':w, 'observations':len(g), 'exceedances':int(g[f'breach{w}'].sum()), 'exceedance_percent':100*float(g[f'breach{w}'].mean()), 'median_threshold_percent':100*float(g[f'q{w}'].median())})
checks=[]
for idx in [int(e.index[0]), int(e[e['date'].eq('2020-03-16')].index[0]), int(e.index[-1])]:
    for w in [126,252]:
        expected=float(np.quantile(p.loc[idx-w:idx-1,'loss'].to_numpy(), .95, method='linear'))
        assert abs(expected - float(p.loc[idx,f'q{w}'])) < 1e-14
        changed=p['loss'].copy(); changed.loc[idx:]=123.456
        actual=float(changed.shift(1).rolling(w,min_periods=w).quantile(.95,interpolation='linear').loc[idx])
        assert abs(actual-expected)<1e-14
        checks.append({'evaluated_date':str(p.loc[idx,'date'].date()),'window':w,'first_input':str(p.loc[idx-w,'date'].date()),'last_input':str(p.loc[idx-1,'date'].date()),'threshold_percent':100*expected,'current_and_future_changes_leave_threshold_unchanged':True})
quarters=[]
for quarter,g in e[e['date'].dt.year.eq(2020)].groupby(e['date'].dt.quarter):
    for w in [126,252]:
        quarters.append({'quarter':f'2020 Q{quarter}','prior_sessions':w,'observations':len(g),'exceedances':int(g[f'breach{w}'].sum()),'exceedance_percent':100*float(g[f'breach{w}'].mean())})
table('Window sensitivity · identical evaluation observations',pd.DataFrame(rows).round(6))
table('When breaches occurred · descriptive 2020 quarters',pd.DataFrame(quarters).round(6))
table('Prior-information check · two windows, three dates',pd.DataFrame(checks))
metric('Common evaluation observations',len(e))
metric('126-session threshold breaches',f"{int(e['breach126'].sum())}/{len(e)} ({e['breach126'].mean()*100:.2f}%)")
metric('252-session threshold breaches',f"{int(e['breach252'].sum())}/{len(e)} ({e['breach252'].mean()*100:.2f}%)")
plt.rcParams.update({'font.family':'DejaVu Sans','font.size':11,'axes.spines.top':False,'axes.spines.right':False,'svg.fonttype':'none'})
fig,ax=plt.subplots(figsize=(11,5.6))
s=e[e['date'].dt.year.eq(2020)]
ax.plot(s['date'],s['loss']*100,color='#b1bbc1',lw=.85,label='Realized loss (negative = gain)')
ax.plot(s['date'],s['q252']*100,color='#214e65',lw=1.7,label='Prior 252 sessions · baseline')
ax.plot(s['date'],s['q126']*100,color='#a85d34',lw=1.7,ls='--',label='Prior 126 sessions · sensitivity')
ax.set(title='Two historical windows meet the same 2020 outcomes',ylabel='One-session loss / threshold (%)',xlabel='Observation date · calendar 2020')
ax.legend(frameon=False,fontsize=9,loc='lower right');ax.grid(axis='y',alpha=.18)
fig.subplots_adjust(left=.09,right=.98,top=.89,bottom=.24)
fig.text(.09,.06,'S&P Dow Jones Indices LLC via FRED · price index, dividends excluded\n95th-percentile thresholds use strictly earlier losses. This retrospective comparison is not a forecasting contest.',fontsize=9)
plot('Sensitivity · prior windows and 2020 losses',fig)
fig,ax=plt.subplots(figsize=(10,5.5))
x=np.arange(3)
for w,offset,color in [(252,-.17,'#214e65'),(126,.17,'#a85d34')]:
    chosen=[r for r in rows if r['prior_sessions']==w and r['period']!='2019–2021']
    heights=[r['exceedance_percent'] for r in chosen]
    bars=ax.bar(x+offset,heights,width=.31,color=color,label=f'{w} preceding sessions',hatch='//' if w==126 else None)
    for bar,r in zip(bars,chosen):
        ax.text(bar.get_x()+bar.get_width()/2,bar.get_height()+.18,f"{r['exceedances']}/{r['observations']}",ha='center',fontsize=10)
ax.axhline(5,color='#555',ls=':',lw=1.4,label='Nominal 5% reference')
ax.set_xticks(x,['2019','2020','2021']);ax.set_ylim(0,max(r['exceedance_percent'] for r in rows)+2)
ax.set(title='An aggregate rate hides differences between calendar years',ylabel='Observed exceedance rate (%)',xlabel='Common evaluation sessions in each year')
ax.legend(frameon=False,fontsize=9);ax.grid(axis='y',alpha=.15)
fig.subplots_adjust(left=.1,right=.98,top=.88,bottom=.24)
fig.text(.1,.06,'Counts above bars use identical observed-session denominators for both windows.\nS&P Dow Jones Indices LLC via FRED · dependent observations; descriptive rates, no significance or calibration claim.',fontsize=9)
plot('Sensitivity · yearly rates with exact denominators',fig)
export_csv('Window sensitivity · daily audit',e.assign(date=e['date'].dt.strftime('%Y-%m-%d'))[['date','price','return','loss','q126','q252','breach126','breach252']])
base=rows[1];short=rows[0]
conclusion(f"On identical {len(e)} evaluation sessions, the 252-session baseline has {base['exceedances']} breaches ({base['exceedance_percent']:.2f}%) and the 126-session sensitivity has {short['exceedances']} ({short['exceedance_percent']:.2f}%). Both use only preceding observations. The baseline reproduces its original yearly counts 4, 21 and 6. Inspect yearly and quarterly counts before interpreting the aggregate rate. A shorter window is a sensitivity choice made after the original baseline was known; it is not optimized, independently validated, or selected as a superior risk model. Calendar-year differences and the response after losses do not certify future calibration, statistical significance or causal effects.")
