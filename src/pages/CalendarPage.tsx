import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAppState } from '../state/AppState';
import { ImpactView } from '../components/ImpactView';
import { Badge } from '../components/Badges';
import { formatMs } from '../engine/correlation/timeNorm';
import { DISPLAY_OFFSET_MINUTES, DISPLAY_TZ_LABEL } from '../lib/display';
import type {
  ClockCorrectionSegment,
  CorrelationImpact,
  ServingCalendarDocument,
  ServingPeriod,
  TimeSettingsDocument,
} from '../types';

const MEANING_LABEL: Record<string, string> = {
  ISSUE_TIME: '领料时间',
  PRODUCTION_START: '制作开工时间',
  PRODUCTION_FINISH: '制作完成时间',
  SERVING_TIME: '实际发餐时间',
  FILE_GENERATED_AT: '资料生成日期（非事件时间）',
};

const PRECISION_LABEL: Record<string, string> = {
  date: '仅日期',
  minute: '分钟',
  second: '秒',
  instant: '完整时间戳（带偏移）',
};

function toIsoLocal(v: string): string {
  // datetime-local → 学校当地墙钟时间（+08:00），不借用浏览器时区
  return v.length === 16 ? `${v}:00+08:00` : `${v}+08:00`;
}

export function CalendarPage() {
  const {
    calendar,
    timeSettings,
    saveCalendar,
    saveTimeSettings,
    previewCorrelation,
    startCorrelationRun,
  } = useAppState();
  const navigate = useNavigate();
  const [tab, setTab] = useState<'calendar' | 'time'>('calendar');

  // 日历修订表单
  const [extendForm, setExtendForm] = useState<{ periodId: string; newClose: string; note: string; approvedBy: string } | null>(null);
  const [addForm, setAddForm] = useState<{ schoolId: string; window: string; mealType: string; businessDay: string; openAt: string; closeAt: string } | null>(null);
  // 校时区段表单
  const [corrForm, setCorrForm] = useState<{ sourceId: string; device: string; validFrom: string; validTo: string; offsetMinutes: string; evidence: string } | null>(null);

  const [impact, setImpact] = useState<CorrelationImpact | null>(null);
  const [draft, setDraft] = useState<ServingCalendarDocument | TimeSettingsDocument | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const flash = (m: string) => {
    setToast(m);
    window.setTimeout(() => setToast(null), 3000);
  };

  const grouped = useMemo(() => {
    const g = new Map<string, Map<string, ServingPeriod[]>>();
    calendar?.doc.periods.forEach((p) => {
      if (!g.has(p.schoolId)) g.set(p.schoolId, new Map());
      const byDay = g.get(p.schoolId)!;
      if (!byDay.has(p.businessDay)) byDay.set(p.businessDay, []);
      byDay.get(p.businessDay)!.push(p);
    });
    return g;
  }, [calendar]);

  if (!calendar || !timeSettings) return null;

  const resetDrafts = () => {
    setImpact(null);
    setDraft(null);
    setExtendForm(null);
    setAddForm(null);
    setCorrForm(null);
  };

  // ---------- 日历修订 ----------

  const previewExtend = () => {
    if (!extendForm) return;
    const next: ServingCalendarDocument = {
      ...calendar.doc,
      periods: calendar.doc.periods.map((p) =>
        p.periodId === extendForm.periodId
          ? {
              ...p,
              closeAt: toIsoLocal(extendForm.newClose),
              adjustment: {
                type: 'EXTEND',
                note: extendForm.note || '临时延长',
                approvedBy: extendForm.approvedBy || '后勤处',
                originalCloseAt: p.adjustment?.originalCloseAt ?? p.closeAt,
                recordedAt: new Date().toISOString(),
              },
            }
          : p,
      ),
    };
    setDraft(next);
    setImpact(previewCorrelation('calendar', next));
  };

  const previewAddPeriod = () => {
    if (!addForm) return;
    const pid = `P-${addForm.schoolId}-${addForm.businessDay.slice(5, 7)}${addForm.businessDay.slice(8, 10)}-${addForm.window.toUpperCase()}`;
    const next: ServingCalendarDocument = {
      ...calendar.doc,
      periods: [
        ...calendar.doc.periods,
        {
          periodId: pid,
          schoolId: addForm.schoolId,
          window: addForm.window,
          mealType: addForm.mealType,
          businessDay: addForm.businessDay,
          openAt: toIsoLocal(addForm.openAt),
          closeAt: toIsoLocal(addForm.closeAt),
          adjustment: { type: 'SPECIAL_OPEN', note: '临时增设窗口', approvedBy: '后勤处', recordedAt: new Date().toISOString() },
        },
      ],
    };
    setDraft(next);
    setImpact(previewCorrelation('calendar', next));
  };

  // ---------- 校时区段 ----------

  const previewCorrection = () => {
    if (!corrForm) return;
    const seg: ClockCorrectionSegment = {
      segmentId: `CC-${corrForm.device.replace(/[^A-Z0-9]/gi, '').toUpperCase()}-${Date.now().toString(36).toUpperCase()}`,
      device: corrForm.device,
      validFrom: toIsoLocal(corrForm.validFrom),
      validTo: toIsoLocal(corrForm.validTo),
      offsetMinutes: Number(corrForm.offsetMinutes),
      evidence: corrForm.evidence,
    };
    const next: TimeSettingsDocument = {
      ...timeSettings.doc,
      sources: timeSettings.doc.sources.map((s) =>
        s.sourceId === corrForm.sourceId
          ? { ...s, clockCorrections: [...s.clockCorrections, seg] }
          : s,
      ),
    };
    setDraft(next);
    setImpact(previewCorrelation('timeSettings', next));
  };

  const saveAndRun = async () => {
    if (!draft || !impact) return;
    if (impact.kind === 'calendar') await saveCalendar(draft as ServingCalendarDocument);
    else if (impact.kind === 'timeSettings') await saveTimeSettings(draft as TimeSettingsDocument);
    else return;
    const kindLabel = impact.kind === 'calendar' ? '日历修订' : '时间解释更正';
    resetDrafts();
    const taskId = await startCorrelationRun(`${kindLabel}后的关联重建`);
    flash(`已保存并启动关联任务 ${taskId}`);
    navigate('/correlation');
  };

  const saveOnly = async () => {
    if (!draft || !impact) return;
    if (impact.kind === 'calendar') await saveCalendar(draft as ServingCalendarDocument);
    else if (impact.kind === 'timeSettings') await saveTimeSettings(draft as TimeSettingsDocument);
    resetDrafts();
    flash('已保存（未生成新运行，可稍后在「时间关联运行」页手动生成）');
  };

  return (
    <div>
      <h1 className="page-title">供餐日历与来源时间设置</h1>
      <p className="page-desc">
        供餐日历（学校 / 窗口 / 餐别 / 业务日 / 实际开放区间 / 临时调整）与来源时间设置（字段含义 / 时区 / 精度 / 校时区段）
        分别独立维护、各自带修订号；修改一个窗口的日历不会悄悄改写其他学校已完成的分析——每次关联运行固定引用当时版本。
      </p>

      <div className="tabs">
        <button className={`tab ${tab === 'calendar' ? 'active' : ''}`} onClick={() => setTab('calendar')}>
          供餐日历（{calendar.doc.calendarVersion} · r{calendar.revision}）
        </button>
        <button className={`tab ${tab === 'time' ? 'active' : ''}`} onClick={() => setTab('time')}>
          来源时间设置（{timeSettings.doc.settingsVersion} · r{timeSettings.revision}）
        </button>
      </div>

      {tab === 'calendar' && (
        <>
          <div className="filter-bar">
            <button
              className="btn primary"
              onClick={() => {
                resetDrafts();
                setExtendForm({ periodId: 'P-A-0904-N', newClose: '2026-09-05T00:40', note: '考试周夜宵延长至 00:40', approvedBy: '后勤处' });
              }}
            >
              记录临时调整（如夜宵延长）
            </button>
            <button
              className="btn"
              onClick={() => {
                resetDrafts();
                setAddForm({ schoolId: 'A', window: 'night', mealType: '夜宵', businessDay: '2026-09-05', openAt: '2026-09-05T21:00', closeAt: '2026-09-05T23:30' });
              }}
            >
              新增供餐周期
            </button>
            <span className="muted" style={{ fontSize: 12 }}>
              开放区间允许跨午夜与重叠；仅因重叠不会判错，也不会为唯一归属裁掉真实窗口。显示时区统一 {DISPLAY_TZ_LABEL}，不改变归属。
            </span>
          </div>

          {extendForm && (
            <div className="card">
              <h2>记录临时调整（延长开放）</h2>
              <div className="filter-bar">
                <label>供餐周期
                  <select value={extendForm.periodId} onChange={(e) => setExtendForm({ ...extendForm, periodId: e.target.value })}>
                    {calendar.doc.periods.map((p) => (
                      <option key={p.periodId} value={p.periodId}>{p.periodId}（{p.schoolId}校 {p.mealType} {p.businessDay}）</option>
                    ))}
                  </select>
                </label>
                <label>延长后关闭时间
                  <input type="datetime-local" value={extendForm.newClose} onChange={(e) => setExtendForm({ ...extendForm, newClose: e.target.value })} />
                </label>
                <label>调整说明
                  <input value={extendForm.note} onChange={(e) => setExtendForm({ ...extendForm, note: e.target.value })} style={{ width: 220 }} />
                </label>
                <label>批准人
                  <input value={extendForm.approvedBy} onChange={(e) => setExtendForm({ ...extendForm, approvedBy: e.target.value })} style={{ width: 100 }} />
                </label>
                <button className="btn primary" onClick={previewExtend}>预览影响</button>
                <button className="btn" onClick={resetDrafts}>取消</button>
              </div>
              <p className="muted" style={{ fontSize: 12, margin: 0 }}>
                当前关闭时间：<span className="mono">{calendar.doc.periods.find((p) => p.periodId === extendForm.periodId)?.closeAt}</span>
                ；延长可跨午夜，业务日不变（不按午夜机械切割）。
              </p>
            </div>
          )}

          {addForm && (
            <div className="card">
              <h2>新增供餐周期</h2>
              <div className="filter-bar">
                <label>学校
                  <select value={addForm.schoolId} onChange={(e) => setAddForm({ ...addForm, schoolId: e.target.value })}>
                    <option value="A">A</option>
                    <option value="B">B</option>
                  </select>
                </label>
                <label>窗口 <input value={addForm.window} onChange={(e) => setAddForm({ ...addForm, window: e.target.value })} style={{ width: 100 }} /></label>
                <label>餐别 <input value={addForm.mealType} onChange={(e) => setAddForm({ ...addForm, mealType: e.target.value })} style={{ width: 90 }} /></label>
                <label>业务日 <input type="date" value={addForm.businessDay} onChange={(e) => setAddForm({ ...addForm, businessDay: e.target.value })} /></label>
                <label>开放 <input type="datetime-local" value={addForm.openAt} onChange={(e) => setAddForm({ ...addForm, openAt: e.target.value })} /></label>
                <label>关闭 <input type="datetime-local" value={addForm.closeAt} onChange={(e) => setAddForm({ ...addForm, closeAt: e.target.value })} /></label>
                <button className="btn primary" onClick={previewAddPeriod}>预览影响</button>
                <button className="btn" onClick={resetDrafts}>取消</button>
              </div>
            </div>
          )}

          {Array.from(grouped.entries()).map(([school, byDay]) => (
            <div className="card" key={school}>
              <h2>{school} 校供餐日历</h2>
              {Array.from(byDay.entries()).sort(([a], [b]) => a.localeCompare(b)).map(([day, periods]) => (
                <div key={day} style={{ marginBottom: 14 }}>
                  <h3>业务日 {day}</h3>
                  <table className="data">
                    <thead>
                      <tr>
                        <th>周期</th><th>窗口</th><th>餐别</th><th>实际开放区间</th><th>临时调整</th>
                      </tr>
                    </thead>
                    <tbody>
                      {periods.map((p) => {
                        const cross = p.closeAt.slice(0, 10) !== p.openAt.slice(0, 10);
                        return (
                          <tr key={p.periodId}>
                            <td className="mono">{p.periodId}</td>
                            <td>{p.window}</td>
                            <td>{p.mealType}</td>
                            <td className="mono nowrap">
                              {formatMs(Date.parse(p.openAt), DISPLAY_OFFSET_MINUTES)} — {formatMs(Date.parse(p.closeAt), DISPLAY_OFFSET_MINUTES)}
                              {cross && <Badge tone="candidate">跨午夜</Badge>}
                            </td>
                            <td>
                              {p.adjustment ? (
                                <span>
                                  <Badge tone="candidate">{p.adjustment.type === 'EXTEND' ? '延长' : '临时增设'}</Badge>{' '}
                                  {p.adjustment.note}（{p.adjustment.approvedBy}）
                                  {p.adjustment.originalCloseAt && (
                                    <span className="muted mono" style={{ fontSize: 11 }}> 原关闭 {formatMs(Date.parse(p.adjustment.originalCloseAt), DISPLAY_OFFSET_MINUTES)}</span>
                                  )}
                                </span>
                              ) : (
                                <span className="muted">—</span>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              ))}
            </div>
          ))}
        </>
      )}

      {tab === 'time' && (
        <>
          <div className="banner info">
            口径：只写日期的记录按全天区间处理，不补成午夜整点；未声明时区的本地时间按学校当地时区解释，<b>不借用浏览器设置</b>；
            带明确偏移的时间按原值使用、<b>不再重复换算</b>；一次校时作用于有凭证的整段记录，<b>同一区段不为每行挑不同偏差，跨设备不共用同一偏差</b>。
          </div>

          <div className="filter-bar">
            <button
              className="btn primary"
              onClick={() => {
                resetDrafts();
                setCorrForm({ sourceId: 'window-log', device: 'WT-A-2', validFrom: '2026-09-04T00:00', validTo: '2026-09-06T23:59', offsetMinutes: '-8', evidence: '维修单 WX-20260906-01：WT-A-2 终端时钟偏快 8 分钟' });
              }}
            >
              新增校时区段（有凭证）
            </button>
          </div>

          {corrForm && (
            <div className="card">
              <h2>新增校时区段</h2>
              <div className="filter-bar">
                <label>来源
                  <select value={corrForm.sourceId} onChange={(e) => setCorrForm({ ...corrForm, sourceId: e.target.value })}>
                    {timeSettings.doc.sources.map((s) => (
                      <option key={s.sourceId} value={s.sourceId}>{s.label}</option>
                    ))}
                  </select>
                </label>
                <label>设备 <input value={corrForm.device} onChange={(e) => setCorrForm({ ...corrForm, device: e.target.value })} style={{ width: 100 }} /></label>
                <label>区段起 <input type="datetime-local" value={corrForm.validFrom} onChange={(e) => setCorrForm({ ...corrForm, validFrom: e.target.value })} /></label>
                <label>区段止 <input type="datetime-local" value={corrForm.validTo} onChange={(e) => setCorrForm({ ...corrForm, validTo: e.target.value })} /></label>
                <label>偏差（分钟，负值=终端偏快）
                  <input type="number" value={corrForm.offsetMinutes} onChange={(e) => setCorrForm({ ...corrForm, offsetMinutes: e.target.value })} style={{ width: 90 }} />
                </label>
                <label>凭证 <input value={corrForm.evidence} onChange={(e) => setCorrForm({ ...corrForm, evidence: e.target.value })} style={{ width: 260 }} /></label>
                <button className="btn primary" onClick={previewCorrection}>预览影响</button>
                <button className="btn" onClick={resetDrafts}>取消</button>
              </div>
            </div>
          )}

          {timeSettings.doc.sources.map((s) => (
            <div className="card" key={s.sourceId}>
              <h2>{s.label} <span className="muted mono" style={{ fontSize: 12 }}>{s.sourceId}</span></h2>
              <table className="data">
                <thead>
                  <tr><th>字段</th><th>业务含义</th><th>精度</th><th>时区声明</th></tr>
                </thead>
                <tbody>
                  {s.fields.map((f) => (
                    <tr key={f.field}>
                      <td className="mono">{f.field}</td>
                      <td>{MEANING_LABEL[f.meaning] ?? f.meaning}</td>
                      <td>{PRECISION_LABEL[f.precision] ?? f.precision}</td>
                      <td>{f.timezone ? <span className="mono">{f.timezone}</span> : <span className="muted">未声明（按学校当地时区）</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <h3>校时区段（{s.clockCorrections.length}）</h3>
              {s.clockCorrections.length === 0 ? (
                <p className="muted" style={{ margin: 0 }}>无校时记录，按原始时间使用。</p>
              ) : (
                <table className="data">
                  <thead>
                    <tr><th>区段</th><th>设备</th><th>有效范围</th><th className="num">偏差（分钟）</th><th>凭证</th></tr>
                  </thead>
                  <tbody>
                    {s.clockCorrections.map((c) => (
                      <tr key={c.segmentId}>
                        <td className="mono">{c.segmentId}</td>
                        <td className="mono">{c.device}</td>
                        <td className="mono nowrap">{formatMs(Date.parse(c.validFrom), DISPLAY_OFFSET_MINUTES)} — {formatMs(Date.parse(c.validTo), DISPLAY_OFFSET_MINUTES)}</td>
                        <td className="num">{c.offsetMinutes}</td>
                        <td style={{ maxWidth: 360 }}>{c.evidence}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          ))}
        </>
      )}

      {impact && (
        <>
          <ImpactView impact={impact} />
          <div className="filter-bar">
            <button className="btn primary" onClick={() => void saveAndRun()}>保存并生成新关联运行</button>
            <button className="btn" onClick={() => void saveOnly()}>仅保存资料</button>
            <button className="btn" onClick={resetDrafts}>放弃更正</button>
          </div>
        </>
      )}

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
