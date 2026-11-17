import type {
  BatchRelationsDocument,
  LoadedBatch,
  Manifest,
  MappingDocument,
  RawRow,
  ServingCalendarDocument,
  StandardIngredient,
  TimeSettingsDocument,
} from '../types';
import { parseCsv } from './csv';
import { sha256 } from './hash';

export const DATA_BASE = '/sample-data';

export interface Dataset {
  manifest: Manifest;
  standards: StandardIngredient[];
  seedMapping: MappingDocument;
  /** 时间关联分析三份独立维护的资料（种子版本，进入 IndexedDB 后各自修订） */
  timeSettingsSeed: TimeSettingsDocument;
  calendarSeed: ServingCalendarDocument;
  relationsSeed: BatchRelationsDocument;
  loadedBatches: LoadedBatch[];
  /** batchId -> 原始行（PENDING 批次为空数组） */
  rowsByBatch: Record<string, RawRow[]>;
  /** 饮食限制 JSON 展开后的统一行结构 */
  dietRows: RawRow[];
  /** batchId -> 文件哈希；PENDING 批次无哈希 */
  hashes: Record<string, string>;
  /** 清单文件与参考数据自身的哈希，运行口径一并固定 */
  metaHashes: Record<string, string>;
}

async function fetchText(path: string): Promise<string> {
  const resp = await fetch(`${DATA_BASE}/${path}`);
  if (!resp.ok) throw new Error(`无法加载样例文件 ${path}: HTTP ${resp.status}`);
  return resp.text();
}

/** 把饮食限制 JSON 展开成与 CSV 一致的 RawRow，字段检查可统一处理 */
function flattenDiet(json: { restrictions: Array<Record<string, unknown>> }, batchId: string): RawRow[] {
  return json.restrictions.map((r, i) => {
    const avoid = Array.isArray(r.avoidAllergens) ? (r.avoidAllergens as string[]).join(';') : '';
    const values: Record<string, string> = {
      studentAnonId: String(r.studentAnonId ?? ''),
      schoolId: String(r.schoolId ?? ''),
      avoidAllergens: avoid,
      note: String(r.note ?? ''),
      effectiveFrom: r.effectiveFrom == null ? '' : String(r.effectiveFrom),
      effectiveTo: r.effectiveTo == null ? '' : String(r.effectiveTo),
    };
    return { rowId: `${batchId}#L${i + 1}`, batchId, lineNo: i + 1, values };
  });
}

export async function loadDataset(): Promise<Dataset> {
  const manifestText = await fetchText('manifest.json');
  const manifest: Manifest = JSON.parse(manifestText);
  const standardsText = await fetchText('standard_ingredients.json');
  const standards: StandardIngredient[] = JSON.parse(standardsText);
  const seedMappingText = await fetchText('seed_mappings.json');
  const seedMapping: MappingDocument = JSON.parse(seedMappingText);
  const timeSettingsText = await fetchText('time/source_time_settings.json');
  const timeSettingsSeed: TimeSettingsDocument = JSON.parse(timeSettingsText);
  const calendarText = await fetchText('time/serving_calendar.json');
  const calendarSeed: ServingCalendarDocument = JSON.parse(calendarText);
  const relationsText = await fetchText('time/batch_relations.json');
  const relationsSeed: BatchRelationsDocument = JSON.parse(relationsText);

  const loadedBatches: LoadedBatch[] = [];
  const rowsByBatch: Record<string, RawRow[]> = {};
  const hashes: Record<string, string> = {};
  let dietRows: RawRow[] = [];

  for (const meta of manifest.batches) {
    rowsByBatch[meta.batchId] = [];
    if (meta.status === 'PENDING') continue;

    const text = await fetchText(meta.fileName);
    const fileHash = await sha256(text);
    hashes[meta.batchId] = fileHash;

    if (meta.sourceType === 'diet_restrictions') {
      const json = JSON.parse(text) as { restrictions: Array<Record<string, unknown>> };
      dietRows = flattenDiet(json, meta.batchId);
      const headers = ['studentAnonId', 'schoolId', 'avoidAllergens', 'note', 'effectiveFrom', 'effectiveTo'];
      rowsByBatch[meta.batchId] = dietRows;
      loadedBatches.push({ meta, headers, rows: dietRows, fileHash });
    } else {
      const { headers, rows } = parseCsv(text, meta.batchId);
      rowsByBatch[meta.batchId] = rows;
      loadedBatches.push({ meta, headers, rows, fileHash });
    }
  }

  const metaHashes = {
    manifest: await sha256(manifestText),
    standard_ingredients: await sha256(standardsText),
    seed_mappings: await sha256(seedMappingText),
    source_time_settings: await sha256(timeSettingsText),
    serving_calendar: await sha256(calendarText),
    batch_relations: await sha256(relationsText),
  };

  return {
    manifest,
    standards,
    seedMapping,
    timeSettingsSeed,
    calendarSeed,
    relationsSeed,
    loadedBatches,
    rowsByBatch,
    dietRows,
    hashes,
    metaHashes,
  };
}
