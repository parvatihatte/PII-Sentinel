import { useEffect, useMemo, useRef, useState } from 'react';
import { applyRedactions, scanText } from './detection/engine.ts';
import type { Finding, RedactionRange, RiskLevel, TextSpan } from './detection/types.ts';
import './App.css';

const DEMO_TEXT = `Weekly Operations & Triage Note

Prepared by Alice Chen (Operations Coordinator).
General reminder: hypertension awareness materials are available in Lobby B.

Patient ID: P-4821
Patient Name: Elena Rostova
Diagnosis: Type 2 Diabetes
Contact: care.team@example.com

Patient ID: P-9012
Diagnosis: Pending
Notes: Follow-up call scheduled for Tuesday.

Integration config:
API_KEY: demo_fake_secret_00000000`;

interface HighlightSegment {
  text: string;
  start: number;
  end: number;
  role: TextSpan['role'] | null;
  risk: RiskLevel | null;
  isActive: boolean;
  findingId: string | null;
}

function buildHighlightSegments(
  text: string,
  findings: Finding[],
  selectedFindingId: string | null,
): HighlightSegment[] {
  if (!text) return [];

  const boundaries = new Set<number>([0, text.length]);
  for (const finding of findings) {
    for (const span of finding.spans) {
      if (span.start >= 0 && span.end <= text.length && span.start < span.end) {
        boundaries.add(span.start);
        boundaries.add(span.end);
      }
    }
  }

  const sorted = Array.from(boundaries).sort((a, b) => a - b);
  const segments: HighlightSegment[] = [];

  for (let i = 0; i < sorted.length - 1; i++) {
    const start = sorted[i];
    const end = sorted[i + 1];
    if (start >= end) continue;

    let matchedRole: TextSpan['role'] | null = null;
    let matchedRisk: RiskLevel | null = null;
    let matchedFindingId: string | null = null;
    let isActive = false;

    for (const finding of findings) {
      for (const span of finding.spans) {
        if (span.start <= start && span.end >= end) {
          const findingIsSelected = finding.id === selectedFindingId;
          if (findingIsSelected || matchedRole === null) {
            matchedRole = span.role;
            matchedRisk = finding.risk;
            matchedFindingId = finding.id;
          }
          if (findingIsSelected) {
            isActive = true;
          }
        }
      }
    }

    segments.push({
      text: text.slice(start, end),
      start,
      end,
      role: matchedRole,
      risk: matchedRisk,
      isActive,
      findingId: matchedFindingId,
    });
  }

  return segments;
}

function riskBadgeClass(level: RiskLevel): string {
  if (level === 'high') return 'badge badge-high';
  if (level === 'medium') return 'badge badge-medium';
  return 'badge badge-low';
}

function highlightClassForSegment(seg: HighlightSegment): string {
  if (seg.role === 'evidence') return 'span-evidence';
  if (seg.role === 'manual') return 'span-manual';
  if (seg.role === 'identifier' && seg.risk === 'high') return 'span-high-risk';
  return 'span-identifier';
}

function renderSanitizedPreview(sanitizedText: string) {
  const parts = sanitizedText.split('[REDACTED]');
  return parts.map((part, idx) => (
    <span key={idx}>
      {part}
      {idx < parts.length - 1 && (
        <span className="redacted-token">[REDACTED]</span>
      )}
    </span>
  ));
}

export function App() {
  const [text, setText] = useState<string>('');
  const [hasScanned, setHasScanned] = useState<boolean>(false);
  const [findings, setFindings] = useState<Finding[]>([]);
  const [checkedIds, setCheckedIds] = useState<Set<string>>(new Set());
  const [selectedFindingId, setSelectedFindingId] = useState<string | null>(null);
  const [showPreview, setShowPreview] = useState<boolean>(false);
  const [copied, setCopied] = useState<boolean>(false);
  const [selectionNotice, setSelectionNotice] = useState<string>('');

  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const activeSpanRef = useRef<HTMLSpanElement | null>(null);

  useEffect(() => {
    if (selectedFindingId && activeSpanRef.current) {
      activeSpanRef.current.scrollIntoView({
        behavior: 'smooth',
        block: 'nearest',
      });
    }
  }, [selectedFindingId, hasScanned]);

  const lineCount = useMemo(() => {
    if (!text) return 0;
    return text.split('\n').length;
  }, [text]);

  const handleTextChange = (nextText: string) => {
    setText(nextText);
    setHasScanned(false);
    setFindings([]);
    setCheckedIds(new Set());
    setSelectedFindingId(null);
    setShowPreview(false);
    setCopied(false);
    setSelectionNotice('');
  };

  const handleScan = () => {
    const detected = scanText(text);
    const initialChecked = new Set(
      detected.filter((f) => f.preselected).map((f) => f.id),
    );
    setFindings(detected);
    setCheckedIds(initialChecked);
    setSelectedFindingId(detected[0]?.id ?? null);
    setHasScanned(true);
    setShowPreview(false);
    setCopied(false);
    setSelectionNotice('');
  };

  const handleLoadDemo = () => {
    handleTextChange(DEMO_TEXT);
  };

  const handleClear = () => {
    handleTextChange('');
  };

  const handleToggleFinding = (id: string) => {
    setCheckedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
    setCopied(false);
  };

  const handleAddManualRedaction = () => {
    const el = textareaRef.current;
    if (!el) return;

    const start = el.selectionStart;
    const end = el.selectionEnd;

    if (start === end) {
      setSelectionNotice('Select a range in the input text first to redact it manually.');
      return;
    }

    const snippet = text.slice(start, end);
    const newId = `manual-${Date.now()}-${findings.length + 1}`;
    const manualFinding: Finding = {
      id: newId,
      type: 'Manual Selection',
      evidence: 'Likely sensitive',
      confidence: 'high',
      risk: 'medium',
      proposedAction: 'redact',
      preselected: true,
      spans: [{ start, end, role: 'manual' }],
      redactionSpans: [{ start, end, role: 'manual' }],
      maskedValue: snippet.length > 32 ? `${snippet.slice(0, 29)}...` : snippet,
      explanation: `Manually selected range (offsets ${start}–${end}) marked for full redaction.`,
    };

    setFindings((prev) => [...prev, manualFinding]);
    setCheckedIds((prev) => {
      const next = new Set(prev);
      next.add(newId);
      return next;
    });
    setSelectedFindingId(newId);
    setHasScanned(true);
    setSelectionNotice('');
    setCopied(false);
  };

  const activeRedactionRanges = useMemo<RedactionRange[]>(() => {
    const ranges: RedactionRange[] = [];
    for (const finding of findings) {
      if (checkedIds.has(finding.id)) {
        for (const span of finding.redactionSpans) {
          ranges.push({ start: span.start, end: span.end });
        }
      }
    }
    return ranges;
  }, [findings, checkedIds]);

  const sanitizedText = useMemo(
    () => applyRedactions(text, activeRedactionRanges),
    [text, activeRedactionRanges],
  );

  const selectedFinding = useMemo(
    () => findings.find((f) => f.id === selectedFindingId) ?? null,
    [findings, selectedFindingId],
  );

  const highlightSegments = useMemo(
    () => (hasScanned ? buildHighlightSegments(text, findings, selectedFindingId) : []),
    [hasScanned, text, findings, selectedFindingId],
  );

  const unredactedCount = useMemo(
    () => findings.filter((f) => !checkedIds.has(f.id)).length,
    [findings, checkedIds],
  );

  const handlePreview = () => {
    setShowPreview(true);
    setCopied(false);
  };

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(sanitizedText);
      setCopied(true);
    } catch {
      setSelectionNotice('Clipboard copy failed. Please copy from the preview box.');
    }
  };

  const firstActiveSegmentIndex = useMemo(
    () => highlightSegments.findIndex((s) => s.isActive),
    [highlightSegments],
  );

  return (
    <div className="sentinel-shell">
      <header className="sentinel-header">
        <div className="brand">
          <svg
            className="brand-icon"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.75"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M12 2.5L4.5 5.5v6.2c0 4.6 3.2 8.8 7.5 9.8 4.3-1 7.5-5.2 7.5-9.8V5.5L12 2.5z" />
            <path d="M9.5 12.2l1.8 1.8 3.4-3.6" />
          </svg>
          <span className="brand-wordmark">PII Sentinel</span>
        </div>
        <div className="header-status">
          <span className="status-dot" aria-hidden="true" />
          <span>Local Processing</span>
        </div>
      </header>

      <section className="hero-section">
        <h1 className="hero-heading">
          Your data.
          <br />
          Your control.
        </h1>
        <p className="hero-subtitle">
          Inspect sensitive information before sharing it.
        </p>
      </section>

      <main className="workspace-grid">
        <section className="column-section" aria-label="Document Input and Inspection">
          <div className="section-header">
            <h2 className="section-label">Source Document</h2>
            <div className="toolbar">
              <button type="button" className="btn btn-ghost" onClick={handleLoadDemo}>
                Load Demo
              </button>
              <button
                type="button"
                className="btn btn-ghost"
                onClick={handleClear}
                disabled={text.length === 0}
              >
                Clear
              </button>
              <button
                type="button"
                className="btn"
                onClick={handleAddManualRedaction}
                disabled={text.length === 0}
              >
                Redact Selection
              </button>
              <button
                type="button"
                className="btn btn-primary"
                onClick={handleScan}
                disabled={text.trim().length === 0}
              >
                Scan Text
              </button>
            </div>
          </div>

          <div className="document-surface">
            <textarea
              ref={textareaRef}
              className="input-textarea"
              value={text}
              onChange={(e) => handleTextChange(e.target.value)}
              placeholder="Paste text containing patient records, emails, phone numbers, or secrets..."
              aria-label="Source text to sanitize"
            />
          </div>

          <div className="meta-row">
            <span>
              {lineCount} {lineCount === 1 ? 'line' : 'lines'} · {text.length} characters · Editing clears stale findings
            </span>
            {selectionNotice && (
              <span className="notice-inline">{selectionNotice}</span>
            )}
          </div>

          {hasScanned && (
            <div className="inspection-block">
              <div className="section-header">
                <h2 className="section-label">Highlighted Inspection (Read-Only)</h2>
              </div>
              <div className="highlighted-box" aria-label="Highlighted source text">
                {highlightSegments.map((seg, segIndex) => {
                  if (!seg.role) {
                    return <span key={`${seg.start}-${seg.end}`}>{seg.text}</span>;
                  }

                  const refProp =
                    segIndex === firstActiveSegmentIndex
                      ? (el: HTMLSpanElement | null) => {
                          activeSpanRef.current = el;
                        }
                      : undefined;

                  return (
                    <span
                      key={`${seg.start}-${seg.end}-${seg.isActive ? 'active' : 'idle'}`}
                      ref={refProp}
                      className={`span-highlight ${highlightClassForSegment(seg)} ${seg.isActive ? 'span-active' : ''}`}
                      onClick={() => {
                        if (seg.findingId) setSelectedFindingId(seg.findingId);
                      }}
                    >
                      {seg.text}
                    </span>
                  );
                })}
              </div>
              <div className="legend-row">
                <span className="legend-item">
                  <span className="legend-swatch" style={{ background: 'var(--hl-identifier-bg)', border: '1px solid var(--hl-identifier-border)' }} />
                  Identifier
                </span>
                <span className="legend-item">
                  <span className="legend-swatch" style={{ background: 'var(--hl-high-risk-bg)', border: '1px solid var(--hl-high-risk-border)' }} />
                  High-risk span
                </span>
                <span className="legend-item">
                  <span className="legend-swatch" style={{ background: 'var(--hl-evidence-bg)', border: '1px solid var(--hl-evidence-border)' }} />
                  Health evidence
                </span>
              </div>
            </div>
          )}
        </section>

        <section className="column-section" aria-label="Evidence Report and Sanitization">
          <div className="section-header">
            <h2 className="section-label">
              Evidence Report {hasScanned ? `(${findings.length})` : ''}
            </h2>
            <div className="toolbar">
              <button
                type="button"
                className="btn"
                onClick={handlePreview}
                disabled={!hasScanned}
              >
                Preview Sanitized
              </button>
            </div>
          </div>

          {!hasScanned ? (
            <div className="empty-state">
              Paste text or load the demo, then click <strong>Scan Text</strong> to review contextual and pattern findings.
            </div>
          ) : findings.length === 0 ? (
            <div className="empty-state">
              No sensitive findings detected under the current rules. You can still select text in the input and click <strong>Redact Selection</strong>.
            </div>
          ) : (
            <div className="findings-surface">
              <div className="findings-list">
                {findings.map((finding) => {
                  const isChecked = checkedIds.has(finding.id);
                  const isSelected = selectedFindingId === finding.id;
                  const healthEvidenceText = finding.spans
                    .filter((s) => s.role === 'evidence')
                    .map((s) => text.slice(s.start, s.end))
                    .join(', ');

                  return (
                    <div
                      key={finding.id}
                      role="button"
                      tabIndex={0}
                      className={`finding-row ${isSelected ? 'is-selected' : ''}`}
                      onClick={() => setSelectedFindingId(finding.id)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          setSelectedFindingId(finding.id);
                        }
                      }}
                    >
                      <div className="finding-row-top">
                        <label
                          className="finding-check-label"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <input
                            type="checkbox"
                            checked={isChecked}
                            onChange={() => handleToggleFinding(finding.id)}
                          />
                          <span>{finding.type}</span>
                        </label>
                        <div className="finding-badges">
                          <span className={riskBadgeClass(finding.risk)}>
                            {finding.risk} risk
                          </span>
                          <span className="badge badge-neutral">
                            {finding.confidence} conf
                          </span>
                          <span className="badge badge-neutral">
                            {finding.evidence}
                          </span>
                        </div>
                      </div>

                      {finding.type === 'Contextual Health Link' && healthEvidenceText ? (
                        <div className="contextual-link-pill">
                          <span>{finding.maskedValue}</span>
                          <span className="contextual-arrow" aria-hidden="true">→</span>
                          <span>{healthEvidenceText}</span>
                        </div>
                      ) : null}

                      <div className="finding-meta-line">
                        <span className="finding-value">{finding.maskedValue}</span>
                        <span className={`redaction-status ${isChecked ? 'is-active' : ''}`}>
                          {isChecked ? 'Will redact' : 'Keep'}
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {selectedFinding && (
            <div className="explanation-panel">
              <div className="explanation-heading">
                <span>Contextual Explanation</span>
                <span>Proposed: {selectedFinding.proposedAction}</span>
              </div>
              <p className="explanation-body">{selectedFinding.explanation}</p>
            </div>
          )}

          {hasScanned && (
            <div className="editorial-notice">
              <strong>Privacy notice:</strong> Redaction removes selected identifiers and secrets, but other indirect clues in surrounding prose may remain.
            </div>
          )}

          {showPreview && hasScanned && (
            <div className="column-section">
              <div className="section-header">
                <h2 className="section-label">Sanitized Preview</h2>
              </div>
              <div className="preview-box" aria-label="Sanitized output preview">
                {renderSanitizedPreview(sanitizedText)}
              </div>
              <div className="copy-row">
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={handleCopy}
                >
                  Copy Sanitized Text
                </button>
                {copied && <span className="copy-status">Copied to clipboard</span>}
              </div>
              {unredactedCount > 0 && (
                <div className="editorial-notice editorial-notice-warn">
                  {unredactedCount} detected {unredactedCount === 1 ? 'item remains' : 'items remain'} unredacted. Review unchecked findings before sharing.
                </div>
              )}
            </div>
          )}
        </section>
      </main>
    </div>
  );
}

export default App;
