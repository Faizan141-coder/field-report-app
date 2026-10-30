import {Report} from '../core/types';
import {Tone} from './theme';

export interface Status {
  tone: Tone;
  title: string;
  detail: string;
}

/**
 * The only place that decides what the user is told. "Uploaded" is reserved for the single
 * phase where the server has committed the report; everything before that is "saved on this
 * device", and the two never share a sentence.
 */
export function reportStatus(r: Report, online: boolean): Status {
  const sent = r.images.filter(i => i.uploaded).length;
  const n = r.images.length;
  switch (r.phase) {
    case 'uploaded':
      return {tone: 'ok', title: 'Uploaded', detail: `On the server · ${time(r.committedAt)}`};
    case 'uploading':
      return {tone: 'busy', title: 'Uploading', detail: `${sent} of ${n} photos sent`};
    case 'needsAttention':
      return {tone: 'bad', title: 'Needs attention', detail: r.lastError?.message ?? 'Upload stopped'};
    case 'queued':
    default:
      if (!online) {
        return {tone: 'wait', title: 'Saved on this device', detail: 'Not uploaded · waiting for a connection'};
      }
      if (r.lastError?.retrying) {
        return {tone: 'wait', title: 'Saved on this device', detail: `Not uploaded · ${r.lastError.message}. Retrying automatically`};
      }
      return {tone: 'wait', title: 'Saved on this device', detail: 'Not uploaded yet · up next'};
  }
}

export interface Summary {
  tone: Tone;
  title: string;
  detail: string;
}

/** One-glance answer for the whole device: is my work safe, moving, or lost? */
export function summarize(reports: readonly Report[], online: boolean): Summary {
  const attention = reports.filter(r => r.phase === 'needsAttention').length;
  const pending = reports.filter(r => r.phase === 'queued' || r.phase === 'uploading');
  const active = reports.some(r => r.phase === 'uploading');
  if (attention) {
    return {
      tone: 'bad',
      title: `${attention} report${attention > 1 ? 's' : ''} need${attention > 1 ? '' : 's'} attention`,
      detail: 'Upload stopped. Open it below to try again.',
    };
  }
  if (pending.length) {
    const n = pending.length;
    const saved = `${n} report${n > 1 ? 's are' : ' is'} saved on this device`;
    if (!online) return {tone: 'wait', title: 'No connection', detail: `${saved}. They will upload automatically.`};
    return active
      ? {tone: 'busy', title: `Uploading ${n} report${n > 1 ? 's' : ''}`, detail: 'Safe on this device until the server confirms.'}
      : {tone: 'wait', title: 'Waiting to upload', detail: `${saved}.`};
  }
  if (!reports.length) {
    return {tone: 'idle', title: 'No reports yet', detail: online ? 'Nothing waiting to upload.' : 'Offline. Nothing waiting to upload.'};
  }
  if (!online) return {tone: 'idle', title: 'Offline', detail: 'Everything you saved is already uploaded.'};
  return {tone: 'ok', title: 'All reports uploaded', detail: 'Everything is on the server.'};
}

function time(ms?: number) {
  if (!ms) return '';
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
