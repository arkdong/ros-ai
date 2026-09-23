"""Actual ros.ai Docker Python analysis of captured CBS aggregate observations.

Author: coding assistant; no application-model inference. Run with phase=overview
then phase=challenge, selecting the exact dataset and prior result explicitly.
"""
phase = params.get('phase', 'overview')
assert phase in ['overview', 'challenge']
data = df.sort_values('size_order').reset_index(drop=True)
expected = ['10-19', '20-49', '50-99', '100-249', '250-499', '500+']
assert data['size_group'].tolist() == expected
assert len(data) == 6 and data['year'].eq(2024).all()
assert data['minimum_persons'].eq(10).all() and data['provisional'].eq(1).all()
fields = ['ai_enterprise_percent', 'published_ci_low', 'published_ci_high', 'adopter_turnover_percent', 'nonadopter_turnover_percent']
assert not data[fields].isna().any().any()
assert ((data[fields] >= 0) & (data[fields] <= 100)).all().all()
assert (data.published_ci_low <= data.ai_enterprise_percent).all()
assert (data.published_ci_high >= data.ai_enterprise_percent).all()
assert np.allclose(data.adopter_turnover_percent + data.nonadopter_turnover_percent, 100)
data['turnover_minus_enterprise_pp'] = data.adopter_turnover_percent - data.ai_enterprise_percent
data['enterprise_gap_to_smallest_pp'] = data.ai_enterprise_percent - data.ai_enterprise_percent.iloc[0]
gap = float(data.ai_enterprise_percent.iloc[-1] - data.ai_enterprise_percent.iloc[0])
assert np.isclose(gap, 41.4)
plt.rcParams.update({'font.family': 'DejaVu Sans', 'font.size': 12, 'axes.spines.top': False, 'axes.spines.right': False,
                     'svg.fonttype': 'none', 'figure.facecolor': 'white', 'axes.facecolor': 'white'})
source = 'CBS AI monitor 2024, tables 2.1.3 / 2.2.1 · Netherlands · 2024 provisional'
coverage = 'Enterprises with 10+ persons employed; NACE C–N and Q. Six size bins, not six firms.'
if phase == 'overview':
    metric('Largest–smallest size gap · percentage points', round(gap, 1))
    metric('Smallest observed group using AI · percent', float(data.ai_enterprise_percent.iloc[0]))
    metric('Largest observed group using AI · percent', float(data.ai_enterprise_percent.iloc[-1]))
    table('Published adoption by company size · exact CBS estimates', data[['size_group', 'year', 'ai_enterprise_percent', 'published_ci_low', 'published_ci_high']])
    fig, ax = plt.subplots(figsize=(10.5, 6))
    x = np.arange(len(data))
    bars = ax.bar(x, data.ai_enterprise_percent, color='#28786e', width=.64)
    ax.errorbar(x, data.ai_enterprise_percent, yerr=[data.ai_enterprise_percent-data.published_ci_low, data.published_ci_high-data.ai_enterprise_percent], fmt='none', ecolor='#243d38', capsize=4)
    for i, v in enumerate(data.ai_enterprise_percent): ax.text(i, data.published_ci_high.iloc[i]+1.6, f'{v:.1f}%', ha='center')
    ax.set_xticks(x, expected)
    ax.set_xlabel('Company size (persons employed)')
    ax.set_ylabel('Enterprises using at least one AI technology (%)')
    ax.set_ylim(0, 72)
    ax.set_title('Larger enterprises report more AI use', loc='left', pad=16)
    ax.grid(axis='y', alpha=.18); ax.set_axisbelow(True)
    fig.subplots_adjust(left=.10, right=.98, top=.88, bottom=.27)
    fig.text(.10, .04, source+'\n'+coverage+'\nWhiskers reproduce CBS published 95% intervals; no new interval or significance test.', fontsize=9)
    plot('AI adoption by company size · CBS 2024', fig)
    conclusion(f'The observed adoption share rises from 17.8% in the 10–19 group to 59.2% in the 500+ group: a {gap:.1f} percentage-point gap. This is a descriptive comparison of published provisional estimates, not evidence that size causes adoption. Initial question for challenge: does this mean smaller Dutch businesses generally lag in AI value creation? The data do not directly measure value creation and omit businesses below ten persons employed. Next compare the turnover denominator and audit that population claim.')
else:
    assert np.isclose(data.turnover_minus_enterprise_pp.iloc[-1], 20.3)
    assert (data.turnover_minus_enterprise_pp < 0).sum() == 2
    metric('500+ group: turnover share minus firm share · pp', round(float(data.turnover_minus_enterprise_pp.iloc[-1]), 1))
    metric('Size bins where turnover share is below firm share', int((data.turnover_minus_enterprise_pp < 0).sum()))
    table('Denominator challenge · same size bins, different questions', data[['size_group', 'ai_enterprise_percent', 'adopter_turnover_percent', 'turnover_minus_enterprise_pp']].round(1))
    fig, ax = plt.subplots(figsize=(10.5, 6.1))
    y = np.arange(len(data))
    for i, row in data.iterrows(): ax.plot([row.ai_enterprise_percent, row.adopter_turnover_percent], [i, i], color='#c3ccc9', lw=2)
    ax.scatter(data.ai_enterprise_percent, y, color='#28786e', s=80, label='Share of enterprises using AI', zorder=3)
    ax.scatter(data.adopter_turnover_percent, y, color='#b35f32', marker='D', s=65, label='Turnover share belonging to AI users', zorder=3)
    for i, row in data.iterrows():
        ax.annotate(f'{row.ai_enterprise_percent:.1f}', (row.ai_enterprise_percent, i), xytext=(0, -16), textcoords='offset points', ha='center', fontsize=9, color='#175047')
        ax.annotate(f'{row.adopter_turnover_percent:.1f}', (row.adopter_turnover_percent, i), xytext=(0, 9), textcoords='offset points', ha='center', fontsize=9, color='#8a451e')
    ax.set_yticks(y, expected); ax.set_ylim(-.65, 5.85); ax.invert_yaxis()
    ax.set_xlim(0, 100); ax.set_xlabel('Share (%) — each series uses its own denominator')
    ax.set_ylabel('Company size (persons employed)')
    ax.set_title('AI adoption is not the same as AI-generated revenue', loc='left', pad=18)
    ax.legend(loc='upper left', bbox_to_anchor=(0, -.17), frameon=False, fontsize=10)
    ax.grid(axis='x', alpha=.18); ax.set_axisbelow(True)
    fig.subplots_adjust(left=.12, right=.98, top=.87, bottom=.32)
    fig.text(.12, .03, source+'\n'+coverage+'\nRevenue belongs to AI-using firms; it is not revenue caused or produced by AI.', fontsize=9)
    plot('Challenge the denominator · adoption versus turnover', fig)
    conclusion('CHALLENGE CHANGES THE DRAFT. In the 500+ group, AI users are 59.2% of enterprises and account for 79.5% of turnover, a 20.3-point difference between different denominators. This does not mean AI generated 79.5% of sales. The turnover share is slightly below the firm share in two size bins (20–49 and 50–99), so revenue overrepresentation is not universal within size groups. Businesses below ten persons employed are absent, not zero adopters. Replace the broad claim about all small Dutch firms or AI value creation with: within the surveyed sectors and 10+ population, reported AI use rises with company size; aggregate adoption and turnover associations do not establish productivity, profitability, causality or the position of microbusinesses. Banking applications remain hypotheses requiring client-specific evidence.')
