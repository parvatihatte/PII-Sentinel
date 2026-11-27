import {
  CONDITION_TERMS,
  EMAIL_REGEX,
  ORDER_INVOICE_PREFIX_REGEX,
  PHONE_REGEX,
  SECRET_LABEL_REGEX,
  maskSecretValue,
} from './patterns.ts';
import { parseLabeledRecords } from './records.ts';
import type { Finding, RedactionRange, TextSpan } from './types.ts';

interface SubjectOccurrence {
  kind: 'patient_id' | 'patient_name';
  value: string;
  start: number;
  end: number;
}

interface SentenceSlice {
  text: string;
  start: number;
  end: number;
}

interface ConditionMatch {
  term: string;
  start: number;
  end: number;
}

const ABBREVIATIONS_BEFORE_DOT =
  /(?:Dr|Mr|Mrs|Ms|Prof|Sr|Jr|St|No|vs|e\.g|i\.e)$/i;

const NEGATION_RE =
  /\b(?:no|not|never|denies|denied|without|negative\s+for|ruled\s+out|rule\s+out|free\s+of|no\s+history\s+of|does\s+not\s+have|did\s+not\s+have|doesn't\s+have|didn't\s+have)\b/i;

const SUSPECTED_RE =
  /\b(?:suspected|suspect|possible|possibly|probable|probably|likely|may\s+have|might\s+have|could\s+have|question\s+of|evaluation\s+for|evaluated\s+for|screened\s+for|pending|differential)\b/i;

const FAMILY_HISTORY_RE =
  /\b(?:family\s+history|mother|father|parent|sister|brother|sibling|grandmother|grandfather|aunt|uncle)\b/i;

const INLINE_PATIENT_ID_RE =
  /\b(?:patient\s*id|patient\s*#|mrn|medical\s*record\s*(?:number|id|#))\s*[:=#]?\s*([A-Za-z0-9][A-Za-z0-9-]{1,20})\b/gi;

const INLINE_PATIENT_NAME_RE =
  /\b(?:patient\s+name\s*[:=]\s*|patient\s+(?!id\b|#|name\b|record\b))([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})\b/g;

const SORTED_CONDITIONS = [...CONDITION_TERMS].sort((a, b) => b.length - a.length);

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function spansOverlap(
  a: { start: number; end: number },
  b: { start: number; end: number },
): boolean {
  return a.start < b.end && b.start < a.end;
}

function sameSpan(
  a: { start: number; end: number },
  b: { start: number; end: number },
): boolean {
  return a.start === b.start && a.end === b.end;
}

export function splitSentencesWithOffsets(text: string): SentenceSlice[] {
  const sentences: SentenceSlice[] = [];
  let start = 0;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (ch === '\n') {
      if (i > start) {
        sentences.push({ text: text.slice(start, i), start, end: i });
      }
      start = i + 1;
      continue;
    }

    if (ch === '.' || ch === '!' || ch === '?') {
      if (ch === '.') {
        const beforeDot = text.slice(Math.max(0, i - 10), i);
        if (ABBREVIATIONS_BEFORE_DOT.test(beforeDot)) {
          continue;
        }
      }

      const next = text[i + 1];
      if (next === undefined || /\s/.test(next)) {
        const end = i + 1;
        if (end > start) {
          sentences.push({ text: text.slice(start, end), start, end });
        }
        start = end;
        while (start < text.length && text[start] === ' ') {
          start++;
        }
        i = start - 1;
      }
    }
  }

  if (start < text.length) {
    sentences.push({ text: text.slice(start), start, end: text.length });
  }

  return sentences;
}

function findConditionsInRange(
  text: string,
  rangeStart: number,
  rangeEnd: number,
): ConditionMatch[] {
  const slice = text.slice(rangeStart, rangeEnd);
  const matches: ConditionMatch[] = [];

  for (const term of SORTED_CONDITIONS) {
    const re = new RegExp(`\\b${escapeRegex(term)}\\b`, 'gi');
    let m: RegExpExecArray | null;
    while ((m = re.exec(slice)) !== null) {
      const start = rangeStart + m.index;
      const end = start + m[0].length;
      if (!matches.some((existing) => spansOverlap(existing, { start, end }))) {
        matches.push({ term: m[0], start, end });
      }
    }
  }

  return matches.sort((a, b) => a.start - b.start);
}

function hasExplicitSentenceConnection(
  sentenceText: string,
  subjectLocalEnd: number,
  conditionLocalStart: number,
  conditionLocalEnd: number,
  subjectLocalStart: number,
): boolean {
  if (subjectLocalEnd <= conditionLocalStart) {
    const between = sentenceText.slice(subjectLocalEnd, conditionLocalStart);
    return /\b(?:was\s+diagnosed\s+with|is\s+diagnosed\s+with|has\s+been\s+diagnosed\s+with|diagnosed\s+with|was\s+treated\s+for|is\s+being\s+treated\s+for|treated\s+for|suffers\s+from|presents\s+with|living\s+with|history\s+of|tested\s+positive\s+for|positive\s+for|negative\s+for|evaluated\s+for|screened\s+for|denies|has|have|had)\b/i.test(
      between,
    );
  }

  if (conditionLocalEnd <= subjectLocalStart) {
    const between = sentenceText.slice(conditionLocalEnd, subjectLocalStart);
    return /\b(?:diagnosed\s+in|confirmed\s+for|reported\s+for)\b/i.test(between);
  }

  return false;
}

function classifyContextQualifier(textSlice: string): {
  isUncertainOrNegated: boolean;
  reason: string;
} {
  if (FAMILY_HISTORY_RE.test(textSlice)) {
    return {
      isUncertainOrNegated: true,
      reason: 'family-history statement',
    };
  }
  if (NEGATION_RE.test(textSlice)) {
    return {
      isUncertainOrNegated: true,
      reason: 'negated statement',
    };
  }
  if (SUSPECTED_RE.test(textSlice)) {
    return {
      isUncertainOrNegated: true,
      reason: 'suspected or uncertain statement',
    };
  }
  return { isUncertainOrNegated: false, reason: '' };
}

export function scanText(text: string): Finding[] {
  if (!text || text.trim().length === 0) {
    return [];
  }

  const findings: Finding[] = [];
  let counter = 1;
  const nextId = () => `finding-${counter++}`;

  const coveredIdentifierSpans: Array<{ start: number; end: number }> = [];
  const isIdentifierCovered = (span: { start: number; end: number }) =>
    coveredIdentifierSpans.some(
      (covered) => sameSpan(covered, span) || spansOverlap(covered, span),
    );

  // 1. Parse labeled records
  const records = parseLabeledRecords(text);
  const allSubjects: SubjectOccurrence[] = [];

  for (const record of records) {
    for (const idField of record.patientIds) {
      allSubjects.push({
        kind: 'patient_id',
        value: idField.value,
        start: idField.valueStart,
        end: idField.valueEnd,
      });
    }
    for (const nameField of record.patientNames) {
      allSubjects.push({
        kind: 'patient_name',
        value: nameField.value,
        start: nameField.valueStart,
        end: nameField.valueEnd,
      });
    }

    const recordSubjects = [...record.patientIds, ...record.patientNames];
    if (recordSubjects.length > 0 && record.diagnoses.length > 0) {
      const diagText = record.diagnoses.map((d) => d.value).join(' ');
      const qualifier = classifyContextQualifier(diagText);

      const redactionSpans: TextSpan[] = recordSubjects.map((s) => ({
        start: s.valueStart,
        end: s.valueEnd,
        role: 'identifier',
        label: s.label,
      }));

      const evidenceSpans: TextSpan[] = record.diagnoses.map((d) => ({
        start: d.valueStart,
        end: d.valueEnd,
        role: 'evidence',
        label: d.label,
      }));

      for (const s of redactionSpans) {
        coveredIdentifierSpans.push({ start: s.start, end: s.end });
      }

      const subjectLabels = recordSubjects.map((s) => s.value).join(', ');

      if (qualifier.isUncertainOrNegated) {
        findings.push({
          id: nextId(),
          type: 'Contextual Health Link',
          evidence: 'Contextual',
          confidence: 'low',
          risk: 'medium',
          proposedAction: 'review',
          preselected: false,
          spans: [...redactionSpans, ...evidenceSpans],
          redactionSpans,
          maskedValue: subjectLabels,
          explanation: `Patient identifier (${subjectLabels}) appears in the same record as a Diagnosis field containing a ${qualifier.reason}. Review before redacting; this does not confirm the subject has the condition.`,
        });
      } else {
        findings.push({
          id: nextId(),
          type: 'Contextual Health Link',
          evidence: 'Contextual',
          confidence: 'high',
          risk: 'high',
          proposedAction: 'redact',
          preselected: true,
          spans: [...redactionSpans, ...evidenceSpans],
          redactionSpans,
          maskedValue: subjectLabels,
          explanation: `Patient identifier (${subjectLabels}) is linked to a Diagnosis field in the same labeled record. Redacting all identifiers for this subject while preserving the diagnosis text.`,
        });
      }
    }
  }

  // 2. Collect inline labeled subjects not already captured by records
  let inlineMatch: RegExpExecArray | null;
  INLINE_PATIENT_ID_RE.lastIndex = 0;
  while ((inlineMatch = INLINE_PATIENT_ID_RE.exec(text)) !== null) {
    const full = inlineMatch[0];
    const value = inlineMatch[1];
    const valueOffset = full.lastIndexOf(value);
    const start = inlineMatch.index + valueOffset;
    const end = start + value.length;
    if (!allSubjects.some((s) => spansOverlap(s, { start, end }))) {
      allSubjects.push({ kind: 'patient_id', value, start, end });
    }
  }

  INLINE_PATIENT_NAME_RE.lastIndex = 0;
  while ((inlineMatch = INLINE_PATIENT_NAME_RE.exec(text)) !== null) {
    const full = inlineMatch[0];
    const value = inlineMatch[1];
    const valueOffset = full.lastIndexOf(value);
    const start = inlineMatch.index + valueOffset;
    const end = start + value.length;
    if (!allSubjects.some((s) => spansOverlap(s, { start, end }))) {
      allSubjects.push({ kind: 'patient_name', value, start, end });
    }
  }

  // 3. Sentence-level contextual detection
  const sentences = splitSentencesWithOffsets(text);
  for (const sentence of sentences) {
    const sentenceSubjects = allSubjects.filter(
      (s) =>
        s.start >= sentence.start &&
        s.end <= sentence.end &&
        !isIdentifierCovered(s),
    );
    if (sentenceSubjects.length === 0) continue;

    const conditions = findConditionsInRange(text, sentence.start, sentence.end);
    if (conditions.length === 0) continue;

    const linkedPairs: Array<{
      subject: SubjectOccurrence;
      condition: ConditionMatch;
    }> = [];

    for (const subject of sentenceSubjects) {
      for (const condition of conditions) {
        if (
          hasExplicitSentenceConnection(
            sentence.text,
            subject.end - sentence.start,
            condition.start - sentence.start,
            condition.end - sentence.start,
            subject.start - sentence.start,
          )
        ) {
          linkedPairs.push({ subject, condition });
        }
      }
    }

    if (linkedPairs.length === 0) {
      continue;
    }

    const distinctSubjects = sentenceSubjects.filter((subj, idx, arr) =>
      arr.findIndex((other) => sameSpan(other, subj)) === idx,
    );

    const redactionSpans: TextSpan[] = distinctSubjects.map((s) => ({
      start: s.start,
      end: s.end,
      role: 'identifier',
    }));

    const evidenceSpans: TextSpan[] = conditions.map((c) => ({
      start: c.start,
      end: c.end,
      role: 'evidence',
    }));

    for (const s of redactionSpans) {
      coveredIdentifierSpans.push({ start: s.start, end: s.end });
    }

    const subjectLabels = distinctSubjects.map((s) => s.value).join(', ');
    const qualifier = classifyContextQualifier(sentence.text);

    if (distinctSubjects.length > 1) {
      findings.push({
        id: nextId(),
        type: 'Contextual Health Link',
        evidence: 'Contextual',
        confidence: 'low',
        risk: 'medium',
        proposedAction: 'review',
        preselected: false,
        spans: [...redactionSpans, ...evidenceSpans],
        redactionSpans,
        maskedValue: subjectLabels,
        explanation: `Multiple patient identifiers (${subjectLabels}) appear in the same sentence with health information, making subject assignment ambiguous. Review before redacting.`,
      });
    } else if (qualifier.isUncertainOrNegated) {
      findings.push({
        id: nextId(),
        type: 'Contextual Health Link',
        evidence: 'Contextual',
        confidence: 'low',
        risk: 'medium',
        proposedAction: 'review',
        preselected: false,
        spans: [...redactionSpans, ...evidenceSpans],
        redactionSpans,
        maskedValue: subjectLabels,
        explanation: `Patient identifier (${subjectLabels}) appears in a ${qualifier.reason} alongside a medical condition. Review before sharing; this does not claim the subject has the condition.`,
      });
    } else {
      findings.push({
        id: nextId(),
        type: 'Contextual Health Link',
        evidence: 'Contextual',
        confidence: 'high',
        risk: 'high',
        proposedAction: 'redact',
        preselected: true,
        spans: [...redactionSpans, ...evidenceSpans],
        redactionSpans,
        maskedValue: subjectLabels,
        explanation: `Sentence explicitly connects patient identifier (${subjectLabels}) to a medical condition. Redacting the identifier while keeping the clinical context.`,
      });
    }
  }

  // 4. Standalone Patient IDs and Patient Names not merged into contextual findings
  for (const subject of allSubjects) {
    if (isIdentifierCovered(subject)) continue;
    coveredIdentifierSpans.push({ start: subject.start, end: subject.end });

    const span: TextSpan = {
      start: subject.start,
      end: subject.end,
      role: 'identifier',
    };

    if (subject.kind === 'patient_id') {
      findings.push({
        id: nextId(),
        type: 'Patient ID',
        evidence: 'Likely sensitive',
        confidence: 'medium',
        risk: 'medium',
        proposedAction: 'review',
        preselected: false,
        spans: [span],
        redactionSpans: [span],
        maskedValue: subject.value,
        explanation: `Labeled patient ID (${subject.value}) detected without linked health information in its record or sentence. Review whether it should be redacted.`,
      });
    } else {
      findings.push({
        id: nextId(),
        type: 'Patient Name',
        evidence: 'Likely sensitive',
        confidence: 'medium',
        risk: 'medium',
        proposedAction: 'review',
        preselected: false,
        spans: [span],
        redactionSpans: [span],
        maskedValue: subject.value,
        explanation: `Labeled patient name (${subject.value}) detected without linked health information. Review whether it should be redacted.`,
      });
    }
  }

  // 5. Email addresses
  EMAIL_REGEX.lastIndex = 0;
  let emailMatch: RegExpExecArray | null;
  while ((emailMatch = EMAIL_REGEX.exec(text)) !== null) {
    const start = emailMatch.index;
    const end = start + emailMatch[0].length;
    const span: TextSpan = { start, end, role: 'identifier' };
    findings.push({
      id: nextId(),
      type: 'Email Address',
      evidence: 'Pattern',
      confidence: 'high',
      risk: 'medium',
      proposedAction: 'redact',
      preselected: true,
      spans: [span],
      redactionSpans: [span],
      maskedValue: emailMatch[0],
      explanation: 'Email address detected by pattern matching.',
    });
  }

  // 6. Phone numbers & downgraded order/invoice numbers
  PHONE_REGEX.lastIndex = 0;
  let phoneMatch: RegExpExecArray | null;
  while ((phoneMatch = PHONE_REGEX.exec(text)) !== null) {
    const start = phoneMatch.index;
    const end = start + phoneMatch[0].length;
    const lineStart = text.lastIndexOf('\n', start - 1) + 1;
    const prefix = text.slice(Math.max(lineStart, start - 40), start);
    const span: TextSpan = { start, end, role: 'identifier' };

    if (ORDER_INVOICE_PREFIX_REGEX.test(prefix)) {
      findings.push({
        id: nextId(),
        type: 'Order/Invoice Number',
        evidence: 'Pattern',
        confidence: 'low',
        risk: 'low',
        proposedAction: 'review',
        preselected: false,
        spans: [span],
        redactionSpans: [span],
        maskedValue: phoneMatch[0],
        explanation:
          'Phone-like number is preceded by an order or invoice label, so it was downgraded for manual review.',
      });
    } else {
      findings.push({
        id: nextId(),
        type: 'Phone Number',
        evidence: 'Pattern',
        confidence: 'high',
        risk: 'medium',
        proposedAction: 'redact',
        preselected: true,
        spans: [span],
        redactionSpans: [span],
        maskedValue: phoneMatch[0],
        explanation: 'Phone number detected by pattern matching.',
      });
    }
  }

  // 7. Labeled secret values (label + separator + value)
  SECRET_LABEL_REGEX.lastIndex = 0;
  let secretMatch: RegExpExecArray | null;
  while ((secretMatch = SECRET_LABEL_REGEX.exec(text)) !== null) {
    const label = secretMatch[1];
    const separator = secretMatch[2];
    const rawValue = secretMatch[3].trim();
    if (!rawValue) continue;

    const valueStart =
      secretMatch.index + label.length + separator.length;
    const valueEnd = valueStart + rawValue.length;
    const masked = maskSecretValue(rawValue);
    const span: TextSpan = { start: valueStart, end: valueEnd, role: 'identifier' };

    findings.push({
      id: nextId(),
      type: 'Secret',
      evidence: 'Pattern',
      confidence: 'high',
      risk: 'high',
      proposedAction: 'redact',
      preselected: true,
      spans: [span],
      redactionSpans: [span],
      maskedValue: `${label}: ${masked}`,
      explanation: `Labeled secret detected (${label}: ${masked}). Secret value is masked here and preselected for redaction.`,
    });
  }

  return findings.sort((a, b) => {
    const aStart = a.spans[0]?.start ?? 0;
    const bStart = b.spans[0]?.start ?? 0;
    return aStart - bStart;
  });
}

export function mergeRedactionRanges(ranges: RedactionRange[]): RedactionRange[] {
  const valid = ranges
    .filter((r) => r.start >= 0 && r.end > r.start)
    .sort((a, b) => a.start - b.start || a.end - b.end);

  if (valid.length === 0) return [];

  const merged: RedactionRange[] = [{ ...valid[0] }];
  for (let i = 1; i < valid.length; i++) {
    const prev = merged[merged.length - 1];
    const curr = valid[i];
    if (curr.start <= prev.end) {
      prev.end = Math.max(prev.end, curr.end);
    } else {
      merged.push({ ...curr });
    }
  }
  return merged;
}

export function applyRedactions(
  text: string,
  ranges: RedactionRange[],
  replacement = '[REDACTED]',
): string {
  const merged = mergeRedactionRanges(ranges);
  if (merged.length === 0) return text;

  let result = '';
  let cursor = 0;

  for (const range of merged) {
    if (range.start > cursor) {
      result += text.slice(cursor, range.start);
    }
    result += replacement;
    cursor = range.end;
  }

  if (cursor < text.length) {
    result += text.slice(cursor);
  }

  return result;
}
