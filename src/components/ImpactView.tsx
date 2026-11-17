import type { CorrelationImpact } from '../types';
import { CorrelationBadge } from './Badges';

const KIND_LABEL: Record<CorrelationImpact['kind'], string> = {
  calendar: '日历修订',
  timeSettings: '时间解释更正',
  relations: '补录转供记录',
};

/** 更正影响预览：原归属、候选变化与受影响餐次（同时检查原位置与更正后位置） */
export function ImpactView({ impact }: { impact: CorrelationImpact }) {
  const totalChanged = impact.changed.length;
  return (
    <div className="card" style={{ border: '1px solid var(--primary)' }}>
      <h2>影响预览（{KIND_LABEL[impact.kind]} · 尚未保存）</h2>
      <div className="grid cols-4" style={{ marginBottom: 12 }}>
        {(Object.keys(impact.beforeCounts) as Array<keyof typeof impact.beforeCounts>).map((k) => (
          <div className="stat" key={k}>
            <div className="label">
              <CorrelationBadge status={k} />
            </div>
            <div className="value" style={{ fontSize: 20 }}>
              {impact.beforeCounts[k]} → {impact.afterCounts[k]}
            </div>
          </div>
        ))}
      </div>

      {totalChanged === 0 ? (
        <p className="muted">本次更正不改变任何事件的归属与状态。</p>
      ) : (
        <>
          <h3>归属变化（{totalChanged} 条事件，原归属 → 新归属）</h3>
          <table className="data">
            <thead>
              <tr>
                <th>事件</th>
                <th>更正前</th>
                <th>更正后</th>
              </tr>
            </thead>
            <tbody>
              {impact.changed.map((c) => (
                <tr key={c.eventKey}>
                  <td>{c.label}</td>
                  <td>
                    <CorrelationBadge status={c.before.status} />{' '}
                    <span className="mono muted">{c.before.periodIds.join('、') || '（无归属）'}</span>
                  </td>
                  <td>
                    <CorrelationBadge status={c.after.status} />{' '}
                    <span className="mono muted">{c.after.periodIds.join('、') || '（无归属）'}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <h3>受影响餐次（原位置与新位置两侧计数都更新）</h3>
          <table className="data">
            <thead>
              <tr>
                <th>供餐周期</th>
                <th className="num">确认 前→后</th>
                <th className="num">候选 前→后</th>
                <th className="num">冲突 前→后</th>
                <th className="num">未知 前→后</th>
              </tr>
            </thead>
            <tbody>
              {impact.affectedPeriods.map((p) => (
                <tr key={p.periodId}>
                  <td className="mono">{p.periodId}</td>
                  <td className="num">{p.before.confirmed} → {p.after.confirmed}</td>
                  <td className="num">{p.before.candidate} → {p.after.candidate}</td>
                  <td className="num">{p.before.conflict} → {p.after.conflict}</td>
                  <td className="num">{p.before.ungrounded} → {p.after.ungrounded}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      {impact.newlyCandidate.length > 0 && (
        <div className="banner info" style={{ marginTop: 12 }}>
          <b>{impact.newlyCandidate.length} 条记录此前没有任何候选，更正后首次进入范围：</b>
          <span className="mono"> {impact.newlyCandidate.join('、')}</span>
        </div>
      )}
    </div>
  );
}
