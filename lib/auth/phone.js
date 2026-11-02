// Indian mobile numbers: +91 followed by 10 digits starting 6-9. Normalised on the server only.
export function normalizeIndianMobile(input) {
  if (typeof input !== 'string' && typeof input !== 'number') return null;
  let digits = String(input).trim().replace(/[\s\-().]/g, '');
  if (digits.startsWith('+')) {
    if (!digits.startsWith('+91')) return null;
    digits = digits.slice(3);
  } else if (digits.length === 12 && digits.startsWith('91')) {
    digits = digits.slice(2);
  } else if (digits.length === 11 && digits.startsWith('0')) {
    digits = digits.slice(1);
  }
  return /^[6-9]\d{9}$/.test(digits) ? `+91${digits}` : null;
}

export const maskPhone = (e164) => (e164 ? `+91 ${e164.slice(3, 5)}XXXXXX${e164.slice(-2)}` : '');
