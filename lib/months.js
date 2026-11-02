const months = ['ינואר', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני', 'יולי', 'אוגוסט', 'ספטמבר', 'אוקטובר', 'נובמבר', 'דצמבר'];
const english = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const thai = ['มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน', 'กรกฎาคม', 'สิงหาคม', 'กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม'];
export function bangkokMonth(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok', year: 'numeric', month: '2-digit' }).formatToParts(now).filter(p => p.type === 'year' || p.type === 'month').sort((a,b) => (a.type === 'year' ? -1 : 1)).map(p => p.value).join('-');
}
export function parseMonthInstruction(text, now = new Date()) {
  const source = String(text).trim().toLowerCase();
  const current = bangkokMonth(now);
  let [year, month] = current.split('-').map(Number);
  const numeric = source.match(/\b(20\d{2})-(0[1-9]|1[0-2])\b/) || source.match(/\b(0?[1-9]|1[0-2])[/.](20\d{2})\b/);
  if (numeric) return numeric[1].length === 4 ? `${numeric[1]}-${numeric[2]}` : `${numeric[2]}-${numeric[1].padStart(2,'0')}`;
  if (/חודש\s*(?:הקודם|שעבר)|last\s+month|previous\s+month|เดือนที่แล้ว|เดือนก่อน/.test(source)) {
    month--; if (!month) { month = 12; year--; }
  } else if (/החודש|חודש\s*(?:הנוכחי|הזה)|this\s+month|current\s+month|เดือนนี้/.test(source)) {
    // Current Bangkok month.
  } else {
    const index = months.findIndex((name,i) => source.includes(name) || new RegExp(`\\b${english[i]}\\b`).test(source) || source.includes(thai[i]));
    if (index < 0) return null;
    month = index + 1;
    const namedYear = source.match(/\b(20\d{2}|25\d{2})\b/);
    if (namedYear) { year = Number(namedYear[1]); if (year > 2400) year -= 543; }
    // A named month without a year means the most recent occurrence.
    else if (month > Number(current.slice(5))) year--;
  }
  return `${year}-${String(month).padStart(2,'0')}`;
}
export const monthEnd = month => new Date(Date.UTC(Number(month.slice(0,4)), Number(month.slice(5)), 0)).toISOString().slice(0,10);
export const monthName = month => english[Number(month.slice(5))-1].replace(/^./, x => x.toUpperCase());
