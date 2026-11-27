export const CONDITION_TERMS: readonly string[] = [
  'asthma',
  'diabetes',
  'type 1 diabetes',
  'type 2 diabetes',
  'hypertension',
  'depression',
  'anxiety',
  'epilepsy',
  'migraine',
  'arthritis',
  'cancer',
  'pneumonia',
  'bronchitis',
  'anemia',
  'hypothyroidism',
  'hyperthyroidism',
  'copd',
  'heart disease',
  'coronary artery disease',
  'kidney disease',
  'chronic kidney disease',
  'atrial fibrillation',
  'bipolar disorder',
  'ptsd',
  'lupus',
  'multiple sclerosis',
  'osteoporosis',
  'tuberculosis',
  'hepatitis',
  'hiv',
];

export const PLACEHOLDER_DIAGNOSES = new Set([
  'n/a',
  'na',
  'none',
  'pending',
  'tbd',
  'unknown',
  'null',
  '-',
  '--',
  'nil',
]);

export const EMAIL_REGEX = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;

/**
 * Matches common phone number formats:
 * +1-555-123-4567, (555) 123-4567, 555-123-4567, 555.123.4567, 555 123 4567
 */
export const PHONE_REGEX =
  /(?<![A-Za-z0-9-])(?:\+?\d{1,3}[\s.-]?)?(?:\(\d{3}\)|\d{3})[\s.-]\d{3}[\s.-]\d{4}(?![A-Za-z0-9-])/g;

/**
 * Matches order or invoice labels immediately before a phone-like number.
 */
export const ORDER_INVOICE_PREFIX_REGEX =
  /(?:order|invoice|inv|po|receipt)\s*(?:no\.?|number|id|#|:)?\s*[:#-]?\s*$/i;

/**
 * Matches labeled secrets: label + separator (: or =) + non-empty value on the same line.
 */
export const SECRET_LABEL_REGEX =
  /\b(api[_\s-]?key|secret[_\s-]?key|client[_\s-]?secret|access[_\s-]?key|auth[_\s-]?token|access[_\s-]?token|refresh[_\s-]?token|private[_\s-]?key|password|passwd|pwd|secret|token|bearer)\b([ \t]*[:=][ \t]*)([^\s\r\n][^\r\n]*)/gi;

export function maskSecretValue(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length <= 4) {
    return '****';
  }
  const visiblePrefix = trimmed.slice(0, 2);
  const visibleSuffix = trimmed.slice(-2);
  return `${visiblePrefix}${'*'.repeat(Math.min(8, trimmed.length - 4))}${visibleSuffix}`;
}

export function isPlaceholderDiagnosis(value: string): boolean {
  const normalized = value.trim().toLowerCase().replace(/[.;,]+$/, '');
  return normalized.length === 0 || PLACEHOLDER_DIAGNOSES.has(normalized);
}
