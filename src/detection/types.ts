export type Confidence = 'low' | 'medium' | 'high';
export type RiskLevel = 'low' | 'medium' | 'high';
export type EvidenceCategory = 'Pattern' | 'Likely sensitive' | 'Contextual';
export type ProposedAction = 'redact' | 'review';

export type FindingType =
  | 'Contextual Health Link'
  | 'Patient ID'
  | 'Patient Name'
  | 'Email Address'
  | 'Phone Number'
  | 'Order/Invoice Number'
  | 'Secret'
  | 'Manual Selection';

export interface TextSpan {
  start: number;
  end: number;
  role: 'identifier' | 'evidence' | 'manual';
  label?: string;
}

export interface Finding {
  id: string;
  type: FindingType;
  evidence: EvidenceCategory;
  confidence: Confidence;
  risk: RiskLevel;
  proposedAction: ProposedAction;
  preselected: boolean;
  /** All relevant spans to highlight when this finding is selected (includes identifier + evidence). */
  spans: TextSpan[];
  /** Spans that will actually be replaced with [REDACTED] when this finding is confirmed for redaction. */
  redactionSpans: TextSpan[];
  /** Masked display label for the detected value (never raw secrets). */
  maskedValue: string;
  explanation: string;
}

export interface RedactionRange {
  start: number;
  end: number;
}
