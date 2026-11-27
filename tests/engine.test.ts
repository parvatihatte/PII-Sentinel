import assert from 'node:assert/strict';
import test from 'node:test';
import { applyRedactions, scanText } from '../src/detection/engine.ts';

test('1. Positive contextual link via sentence construction', () => {
  const input = 'Patient ID P-4821 was diagnosed with asthma last month.';
  const findings = scanText(input);

  assert.equal(findings.length, 1);
  const f = findings[0];
  assert.equal(f.type, 'Contextual Health Link');
  assert.equal(f.evidence, 'Contextual');
  assert.equal(f.confidence, 'high');
  assert.equal(f.risk, 'high');
  assert.equal(f.proposedAction, 'redact');
  assert.equal(f.preselected, true);

  // Redacts identifier only, not the diagnosis itself
  const redacted = applyRedactions(input, f.redactionSpans);
  assert.equal(redacted, 'Patient ID [REDACTED] was diagnosed with asthma last month.');
});

test('2. Positive contextual link via labeled record Diagnosis field', () => {
  const input = [
    'Patient ID: P-4821',
    'Patient Name: Elena Rostova',
    'Diagnosis: Type 2 Diabetes',
  ].join('\n');

  const findings = scanText(input);
  assert.equal(findings.length, 1);
  const f = findings[0];
  assert.equal(f.type, 'Contextual Health Link');
  assert.equal(f.confidence, 'high');
  assert.equal(f.risk, 'high');
  assert.equal(f.preselected, true);
  assert.equal(f.redactionSpans.length, 2);

  const redacted = applyRedactions(input, f.redactionSpans);
  assert.equal(
    redacted,
    ['Patient ID: [REDACTED]', 'Patient Name: [REDACTED]', 'Diagnosis: Type 2 Diabetes'].join(
      '\n',
    ),
  );
});

test('3. No contextual link despite co-occurrence', () => {
  const input =
    'Patient ID: P-4821 called to confirm appointment time. Dr. Rivera is researching asthma trends.';
  const findings = scanText(input);

  assert.equal(findings.length, 1);
  assert.equal(findings[0].type, 'Patient ID');
  assert.equal(findings[0].risk, 'medium');
  assert.equal(findings[0].proposedAction, 'review');
  assert.equal(findings[0].preselected, false);
});

test('4. Ordinary name and doctor discussing research are not flagged', () => {
  const input = 'Alice Chen met with Dr. Rivera to review diabetes research papers.';
  const findings = scanText(input);
  assert.equal(findings.length, 0);
});

test('5. Standalone medical term and placeholder diagnosis are not flagged', () => {
  const input = [
    'Hypertension awareness week starts Monday.',
    '',
    'Patient ID: P-9012',
    'Diagnosis: Pending',
  ].join('\n');

  const findings = scanText(input);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].type, 'Patient ID');
  assert.equal(findings[0].proposedAction, 'review');
  assert.equal(findings[0].preselected, false);
});

test('6. Adjacent records do not inherit diagnoses', () => {
  const input = [
    'Patient ID: P-4821',
    'Diagnosis: Asthma',
    'Patient ID: P-9012',
    'Notes: Routine check-in',
  ].join('\n');

  const findings = scanText(input);
  assert.equal(findings.length, 2);

  assert.equal(findings[0].type, 'Contextual Health Link');
  assert.equal(findings[0].maskedValue, 'P-4821');
  assert.equal(findings[0].preselected, true);

  assert.equal(findings[1].type, 'Patient ID');
  assert.equal(findings[1].maskedValue, 'P-9012');
  assert.equal(findings[1].preselected, false);
});

test('7. Email, phone, and order-number downgrade detection', () => {
  const input =
    'Contact: jordan.hayes@example.com or 555-234-5678. Order #555-987-6543 is ready.';
  const findings = scanText(input);

  assert.equal(findings.length, 3);
  assert.equal(findings[0].type, 'Email Address');
  assert.equal(findings[0].preselected, true);

  assert.equal(findings[1].type, 'Phone Number');
  assert.equal(findings[1].preselected, true);

  assert.equal(findings[2].type, 'Order/Invoice Number');
  assert.equal(findings[2].proposedAction, 'review');
  assert.equal(findings[2].preselected, false);
});

test('8. Secret detection masks value and redacts only value', () => {
  const input = 'API_KEY: sk_test_demo_9988776655\nSecret:';
  const findings = scanText(input);

  assert.equal(findings.length, 1);
  const f = findings[0];
  assert.equal(f.type, 'Secret');
  assert.equal(f.risk, 'high');
  assert.equal(f.preselected, true);
  assert.equal(f.maskedValue.includes('9988776655'), false);
  assert.equal(f.explanation.includes('9988776655'), false);

  const redacted = applyRedactions(input, f.redactionSpans);
  assert.equal(redacted, 'API_KEY: [REDACTED]\nSecret:');
});

test('9. Negated, suspected, and family-history statements require review without claiming condition', () => {
  const input = [
    'Patient ID P-101 does not have asthma.',
    'Patient ID P-102 has a family history of diabetes.',
  ].join('\n');

  const findings = scanText(input);
  assert.equal(findings.length, 2);
  for (const f of findings) {
    assert.equal(f.type, 'Contextual Health Link');
    assert.equal(f.proposedAction, 'review');
    assert.equal(f.preselected, false);
    assert.equal(f.explanation.includes('does not claim'), true);
  }
});

test('10. Overlapping redaction ranges are merged cleanly', () => {
  const input = 'abcdefg';
  const redacted = applyRedactions(input, [
    { start: 1, end: 4 },
    { start: 2, end: 5 },
  ]);
  assert.equal(redacted, 'a[REDACTED]fg');
});
