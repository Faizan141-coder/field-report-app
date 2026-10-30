export const colors = {
  bg: '#F6F7F9',
  card: '#FFFFFF',
  text: '#14181F',
  muted: '#5B6573',
  line: '#E1E5EA',
  primary: '#1F5FD1',
  ok: '#1B7F4B',
  okBg: '#E5F4EB',
  busy: '#1F5FD1',
  busyBg: '#E6EEFB',
  wait: '#8A5A00',
  waitBg: '#FFF1D6',
  bad: '#B3261E',
  badBg: '#FBE7E5',
};

export type Tone = 'ok' | 'busy' | 'wait' | 'bad' | 'idle';

export const toneColors: Record<Tone, {fg: string; bg: string}> = {
  ok: {fg: colors.ok, bg: colors.okBg},
  busy: {fg: colors.busy, bg: colors.busyBg},
  wait: {fg: colors.wait, bg: colors.waitBg},
  bad: {fg: colors.bad, bg: colors.badBg},
  idle: {fg: colors.muted, bg: colors.line},
};

export const HIT = 48;
