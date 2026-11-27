import { isPlaceholderDiagnosis } from './patterns.ts';

export type RecordFieldKind = 'patient_id' | 'patient_name' | 'diagnosis' | 'other';

export interface RecordField {
  kind: RecordFieldKind;
  label: string;
  value: string;
  valueStart: number;
  valueEnd: number;
  lineStart: number;
  lineEnd: number;
}

export interface LabeledRecord {
  id: string;
  start: number;
  end: number;
  fields: RecordField[];
  patientIds: RecordField[];
  patientNames: RecordField[];
  diagnoses: RecordField[];
}

interface LineSlice {
  text: string;
  start: number;
  end: number;
}

const PATIENT_ID_LINE_RE =
  /^([ \t]*(?:patient\s*id|patient\s*#|mrn|medical\s*record\s*(?:number|id|#))[ \t]*[:=][ \t]*)(.+?)[ \t]*$/i;

const PATIENT_NAME_LINE_RE =
  /^([ \t]*(?:patient\s*name|patient)[ \t]*[:=][ \t]*)(.+?)[ \t]*$/i;

const DIAGNOSIS_LINE_RE =
  /^([ \t]*(?:diagnosis|primary\s*diagnosis|dx|condition)[ \t]*[:=][ \t]*)(.+?)[ \t]*$/i;

const GENERIC_LABELED_LINE_RE =
  /^([ \t]*[A-Za-z][A-Za-z0-9 _/#-]{1,30}[ \t]*[:=][ \t]*)(.+?)[ \t]*$/;

export function splitLinesWithOffsets(text: string): LineSlice[] {
  const lines: LineSlice[] = [];
  let index = 0;

  while (index <= text.length) {
    const nextNewline = text.indexOf('\n', index);
    if (nextNewline === -1) {
      lines.push({
        text: text.slice(index),
        start: index,
        end: text.length,
      });
      break;
    }

    const lineEnd =
      nextNewline > index && text[nextNewline - 1] === '\r'
        ? nextNewline - 1
        : nextNewline;

    lines.push({
      text: text.slice(index, lineEnd),
      start: index,
      end: lineEnd,
    });
    index = nextNewline + 1;
  }

  return lines;
}

function parseRecordField(line: LineSlice): RecordField | null {
  const matchers: Array<{ kind: RecordFieldKind; regex: RegExp }> = [
    { kind: 'patient_id', regex: PATIENT_ID_LINE_RE },
    { kind: 'patient_name', regex: PATIENT_NAME_LINE_RE },
    { kind: 'diagnosis', regex: DIAGNOSIS_LINE_RE },
    { kind: 'other', regex: GENERIC_LABELED_LINE_RE },
  ];

  for (const { kind, regex } of matchers) {
    const match = regex.exec(line.text);
    if (!match) continue;

    const prefix = match[1];
    const rawValue = match[2];
    const valueStart = line.start + prefix.length;
    const valueEnd = valueStart + rawValue.length;

    if (kind === 'diagnosis' && isPlaceholderDiagnosis(rawValue)) {
      return {
        kind: 'other',
        label: prefix.trim().replace(/[:=]+$/, '').trim(),
        value: rawValue,
        valueStart,
        valueEnd,
        lineStart: line.start,
        lineEnd: line.end,
      };
    }

    return {
      kind,
      label: prefix.trim().replace(/[:=]+$/, '').trim(),
      value: rawValue,
      valueStart,
      valueEnd,
      lineStart: line.start,
      lineEnd: line.end,
    };
  }

  return null;
}

export function parseLabeledRecords(text: string): LabeledRecord[] {
  const lines = splitLinesWithOffsets(text);
  const records: LabeledRecord[] = [];
  let current: LabeledRecord | null = null;

  const flush = () => {
    if (current && current.fields.length > 0) {
      records.push(current);
    }
    current = null;
  };

  for (const line of lines) {
    if (line.text.trim().length === 0) {
      flush();
      continue;
    }

    const field = parseRecordField(line);
    if (!field) {
      flush();
      continue;
    }

    const startsRepeatedSubject =
      current !== null &&
      ((field.kind === 'patient_id' && current.patientIds.length > 0) ||
        (field.kind === 'patient_name' && current.patientNames.length > 0));

    if (startsRepeatedSubject) {
      flush();
    }

    if (!current) {
      current = {
        id: `record-${records.length + 1}`,
        start: field.lineStart,
        end: field.lineEnd,
        fields: [],
        patientIds: [],
        patientNames: [],
        diagnoses: [],
      };
    }

    current.end = field.lineEnd;
    current.fields.push(field);

    if (field.kind === 'patient_id') {
      current.patientIds.push(field);
    } else if (field.kind === 'patient_name') {
      current.patientNames.push(field);
    } else if (field.kind === 'diagnosis') {
      current.diagnoses.push(field);
    }
  }

  flush();
  return records;
}
