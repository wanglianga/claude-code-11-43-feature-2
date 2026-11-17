import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAppState } from '../state/AppState';
import { ImpactView } from '../components/ImpactView';
import { Badge } from '../components/Badges';
import { BATCH_LABEL } from '../lib/schema';
import { shortHash } from '../lib/hash';
import type { BatchRelationsDocument, CorrelationImpact, TransferRecord } from '../types';

/** 批次关系：领料→制作、制作→发餐的明确引用（事件行内）+ 可补录的转供记录 */
export function RelationsPage() {
  const { dataset, relations, saveRelations, previewCorrelation, startCorrelationRun } = useAppState();
  const navigate = useNavigate();
  const [form, setForm] = useState<{ productionRef: string; toWindow: string; toBusinessDay: string; evidence: string; note: string } | null>(null);
  const [impact, setImpact] = useState<CorrelationImpact | null>(null);
  const [draft, setDraft] = useState<BatchRelationsDocument | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const flash = (m: string) => {
    setToast(m);
    window.setTimeout(() => setToast(null), 3000);
  };

  const eventBatches = useMemo(
    () =>
      dataset?.loadedBatches.filter((b) =>
        ['material_issues', 'production_batches', 'serving_events'].includes(b.meta.sourceType),
      ) ?? [],
    [dataset],
  );

  const chains = useMemo(() => {
    if (!dataset) return { issues: [], productions: [], servings: [] };
    const rowsOf = (t: string) =>
      dataset.loadedBatches.filter((b) => b.meta.sourceType === t).flatMap((b) => b.rows);
    return {
      issues: rowsOf('material_issues'),
      productions: rowsOf('production_batches'),
      servings: rowsOf('serving_events'),
    };
  }, [dataset]);

  const productionIds = useMemo(
    () => chains.productions.map((r) => r.values.production_id).filter(Boolean).sort(),
    [chains],
  );

  if (!dataset || !relations) return null;

  const preview = () => {
    if (!form) return;
    const next: BatchRelationsDocument = {
      ...relations.doc,
      transfers: [
        ...relations.doc.transfers,
        {
          transferId: `TR-${form.productionRef.split('-')[1] ?? 'X'}-${String(relations.doc.transfers.length + 1).padStart(2, '0')}`,
          productionRef: form.productionRef,
          toSchoolId: form.productionRef.includes('-B-') ? 'B' : 'A',
          toWindow: form.toWindow,
          toBusinessDay: form.toBusinessDay,
          note: form.note || '剩余制成品跨餐次转供',
          evidence: form.evidence,
          recordedAt: new Date().toISOString(),
        } satisfies TransferRecord,
      ],
    };
    setDraft(next);
    setImpact(previewCorrelation('relations', next));
  };

  const saveAndRun = async () => {
    if (!draft) return;
    await saveRelations(draft);
    setDraft(null);
    setImpact(null);
    setForm(null);
    const taskId = await startCorrelationRun('补录转供后的关联重建');
    flash(`已保存并启动关联任务 ${taskId}`);
    navigate('/correlation');
  };

  const saveOnly = async () => {
    if (!draft) return;
    await saveRelations(draft);
    setDraft(null);
    setImpact(null);
    setForm(null);
    flash('已保存（未生成新运行）');
  };

  return (
    <div>
      <h1 className="page-title">批次关系与明确引用</h1>
      <p className="page-desc">
        领料→制作、制作→发餐的明确引用记录在事件行内；剩余制成品跨餐次使用必须有转供记录为依据
        （原料保质期或在库状态不能代替）。补录转供记录会改变关联结果：先预览影响，再生成新运行；历史运行保持不变。
      </p>

      <div className="card">
        <h2>事件来源批次（资料收到时间可查）</h2>
        <table className="data">
          <thead>
            <tr><th>批次</th><th>类型</th><th className="num">行数</th><th>数据日期</th><th>资料收到时间</th><th>文件哈希</th></tr>
          </thead>
          <tbody>
            {eventBatches.map((b) => (
              <tr key={b.meta.batchId}>
                <td>
                  <b className="mono">{b.meta.batchId}</b>
                  <div className="muted" style={{ fontSize: 12 }}>{BATCH_LABEL(b.meta)}</div>
                </td>
                <td>{b.meta.sourceType}</td>
                <td className="num">{b.rows.length}</td>
                <td className="mono">{b.meta.dataDate}</td>
                <td className="mono nowrap">{b.meta.updatedAt ?? '—'}</td>
                <td className="mono muted">{shortHash(b.fileHash)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="muted" style={{ fontSize: 12, marginBottom: 0 }}>
          供应商成分文件上的日期只是资料生成日期（见「来源时间设置」），不作为任何供餐事件时间参与关联。
        </p>
      </div>

      <div className="card">
        <h2>明确引用链（领料 → 制作 → 发餐）</h2>
        <h3>领料 → 制作</h3>
        <table className="data">
          <thead>
            <tr><th>领料</th><th>原料</th><th>领料时间（原文）</th><th>引用的制作批次</th><th>制作批次回引</th></tr>
          </thead>
          <tbody>
            {chains.issues.map((r) => {
              const ref = r.values.production_ref?.trim();
              const back = ref
                ? chains.productions.find((p) => p.values.production_id === ref)
                : undefined;
              const backRefs = back?.values.issue_refs?.split(';').map((s) => s.trim()) ?? [];
              return (
                <tr key={r.rowId}>
                  <td className="mono">{r.values.issue_id}</td>
                  <td>{r.values.item_text}</td>
                  <td className="mono">{r.values.issued_at}</td>
                  <td className="mono">{ref || <span className="muted">（无引用 → 仅时间邻近候选）</span>}</td>
                  <td>
                    {ref ? (
                      backRefs.includes(r.values.issue_id) ? (
                        <Badge tone="ok">双向一致</Badge>
                      ) : (
                        <Badge tone="candidate">单向引用</Badge>
                      )
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>

        <h3>制作 → 发餐</h3>
        <table className="data">
          <thead>
            <tr><th>制作批次</th><th>开工 — 完成（原文）</th><th>引用该批次的发餐事件</th></tr>
          </thead>
          <tbody>
            {chains.productions.map((p) => {
              const refs = chains.servings.filter((s) => s.values.production_ref?.trim() === p.values.production_id);
              return (
                <tr key={p.rowId}>
                  <td className="mono">{p.values.production_id} · {p.values.dish_name}</td>
                  <td className="mono nowrap">{p.values.start_at} — {p.values.finish_at}</td>
                  <td className="mono">
                    {refs.length > 0 ? refs.map((s) => s.values.event_id).join('、') : <span className="muted">（无发餐引用）</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="card">
        <h2>转供记录（{relations.doc.relationsVersion} · r{relations.revision}）</h2>
        <table className="data">
          <thead>
            <tr><th>转供单</th><th>来源制作批次</th><th>转供去向</th><th>凭证</th><th>记录时间</th></tr>
          </thead>
          <tbody>
            {relations.doc.transfers.map((t) => (
              <tr key={t.transferId}>
                <td className="mono">{t.transferId}</td>
                <td className="mono">{t.productionRef}</td>
                <td>{t.toSchoolId} 校 · {t.toWindow} · 业务日 {t.toBusinessDay}<div className="muted" style={{ fontSize: 12 }}>{t.note}</div></td>
                <td style={{ maxWidth: 260 }}>{t.evidence}</td>
                <td className="mono nowrap">{t.recordedAt}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <div className="filter-bar" style={{ marginTop: 14 }}>
          <button
            className="btn primary"
            onClick={() =>
              setForm({
                productionRef: 'PB-A-0402',
                toWindow: 'lunch',
                toBusinessDay: '2026-09-05',
                evidence: '留样记录 LY-0905-02 + 转供单 ZG-0905-01',
                note: '番茄炒蛋剩余制成品转供次日午餐',
              })
            }
          >
            补录转供记录
          </button>
          <span className="muted" style={{ fontSize: 12 }}>
            补传会改变关联结果：先预览原归属、候选变化与受影响餐次，再生成新运行。
          </span>
        </div>

        {form && (
          <div className="card" style={{ background: 'var(--surface-2)' }}>
            <h2>补录转供记录</h2>
            <div className="filter-bar">
              <label>来源制作批次
                <select value={form.productionRef} onChange={(e) => setForm({ ...form, productionRef: e.target.value })}>
                  {productionIds.map((id) => (
                    <option key={id} value={id}>{id}</option>
                  ))}
                </select>
              </label>
              <label>转供窗口
                <select value={form.toWindow} onChange={(e) => setForm({ ...form, toWindow: e.target.value })}>
                  <option value="breakfast">breakfast</option>
                  <option value="lunch">lunch</option>
                  <option value="dinner">dinner</option>
                  <option value="night">night</option>
                  <option value="express">express</option>
                </select>
              </label>
              <label>业务日 <input type="date" value={form.toBusinessDay} onChange={(e) => setForm({ ...form, toBusinessDay: e.target.value })} /></label>
              <label>凭证 <input value={form.evidence} onChange={(e) => setForm({ ...form, evidence: e.target.value })} style={{ width: 240 }} /></label>
              <label>说明 <input value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} style={{ width: 200 }} /></label>
              <button className="btn primary" onClick={preview}>预览影响</button>
              <button className="btn" onClick={() => { setForm(null); setDraft(null); setImpact(null); }}>取消</button>
            </div>
          </div>
        )}
      </div>

      {impact && (
        <>
          <ImpactView impact={impact} />
          <div className="filter-bar">
            <button className="btn primary" onClick={() => void saveAndRun()}>保存并生成新关联运行</button>
            <button className="btn" onClick={() => void saveOnly()}>仅保存资料</button>
            <button className="btn" onClick={() => { setDraft(null); setImpact(null); }}>放弃</button>
          </div>
        </>
      )}

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
