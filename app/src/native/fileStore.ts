import ReactNativeBlobUtil from 'react-native-blob-util';
import {Report, ReportStore} from '../core/types';

const fs = ReactNativeBlobUtil.fs;
const DIR = `${fs.dirs.DocumentDir}/reports`;
const file = (id: string) => `${DIR}/${id}.json`;
const tmp = (id: string) => `${DIR}/${id}.json.tmp`;

/**
 * One JSON file per report, so one damaged file can never take the others down.
 * Writes go tmp -> unlink -> move. The only crash window is between unlink and move,
 * where the complete tmp file exists and loadAll() promotes it. A partial tmp (crash
 * mid-write) always coexists with the intact previous file, which wins.
 */
export const fileStore: ReportStore = {
  async loadAll() {
    await fs.mkdir(DIR).catch(() => {});
    const names = await fs.ls(DIR);
    const out: Report[] = [];
    for (const name of names) {
      const id = name.replace(/\.json(\.tmp)?$/, '');
      if (name.endsWith('.json.tmp')) {
        if (await fs.exists(file(id))) {
          await fs.unlink(`${DIR}/${name}`).catch(() => {});
          continue;
        }
        await fs.mv(`${DIR}/${name}`, file(id)).catch(() => {});
        // fall through: the promoted file is read when its own name comes up, or below
        if (!names.includes(`${id}.json`)) {
          const r = await read(id);
          if (r) out.push(r);
        }
        continue;
      }
      if (name.endsWith('.json')) {
        const r = await read(id);
        if (r) out.push(r);
      }
    }
    return out;
  },

  async save(report) {
    await fs.mkdir(DIR).catch(() => {});
    await fs.writeFile(tmp(report.id), JSON.stringify(report), 'utf8');
    if (await fs.exists(file(report.id))) await fs.unlink(file(report.id));
    await fs.mv(tmp(report.id), file(report.id));
  },

  async remove(id) {
    await fs.unlink(file(id)).catch(() => {});
    await fs.unlink(tmp(id)).catch(() => {});
  },
};

async function read(id: string): Promise<Report | null> {
  try {
    return JSON.parse(await fs.readFile(file(id), 'utf8')) as Report;
  } catch {
    console.warn('[store] unreadable report file', id);
    return null;
  }
}
