// Satori uses React-like element trees but we don't need the full React types
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SatoriNode = any;

export interface ClaimRenderData {
  claim: string;
  correctedClaim: string | null;
  verdict: string;
  confidence: number | null;
  summary: string;
  timecode: string | null;
  sources: Array<{ publisher: string; textualRating?: string | null }>;
}

const VERDICT_STYLES: Record<string, { bg: string; text: string; label: string }> = {
  true: { bg: '#166534', text: '#4ade80', label: 'TRUE' },
  false: { bg: '#991b1b', text: '#f87171', label: 'FALSE' },
  misleading: { bg: '#92400e', text: '#fbbf24', label: 'MISLEADING' },
  verified: { bg: '#166534', text: '#4ade80', label: 'VERIFIED' },
  unverified: { bg: '#c2410c', text: '#fb923c', label: 'UNSUPPORTED' },
};

function verdictStyle(verdict: string) {
  return VERDICT_STYLES[verdict.toLowerCase()] ?? VERDICT_STYLES.unverified;
}

function confidenceBar(confidence: number | null): SatoriNode {
  const pct = Math.round(Math.max(0, Math.min(1, confidence ?? 0)) * 100);
  const color = pct >= 70 ? '#4ade80' : pct >= 40 ? '#fbbf24' : '#f87171';
  return {
    type: 'div',
    props: {
      style: { display: 'flex', alignItems: 'center', gap: '12px', marginTop: '8px' },
      children: [
        { type: 'div', props: { style: { color: '#94a3b8', fontSize: '16px', fontWeight: 500 }, children: `${pct}%` } },
        {
          type: 'div',
          props: {
            style: { display: 'flex', width: '200px', height: '8px', backgroundColor: '#1e293b', borderRadius: '4px', overflow: 'hidden' },
            children: { type: 'div', props: { style: { width: `${pct}%`, height: '100%', backgroundColor: color, borderRadius: '4px' } } },
          },
        },
      ],
    },
  };
}

export function buildFactcheckGraphic(data: ClaimRenderData): SatoriNode {
  const vc = verdictStyle(data.verdict);

  const sourceNodes: SatoriNode[] = (data.sources ?? []).slice(0, 3).map((s, i) => ({
    type: 'div',
    key: `src-${i}`,
    props: {
      style: { display: 'flex', alignItems: 'center', gap: '8px' },
      children: [
        { type: 'div', props: { style: { width: '6px', height: '6px', borderRadius: '50%', backgroundColor: '#475569' } } },
        { type: 'div', props: { style: { color: '#94a3b8', fontSize: '18px' }, children: s.publisher } },
        ...(s.textualRating ? [{ type: 'div', props: { style: { color: '#64748b', fontSize: '16px' }, children: `— ${s.textualRating}` } }] : []),
      ],
    },
  }));

  const children: SatoriNode[] = [
    // Header
    {
      type: 'div',
      props: {
        style: { display: 'flex', alignItems: 'center', gap: '16px' },
        children: [
          { type: 'div', props: { style: { color: '#e2e8f0', fontSize: '28px', fontWeight: 700, letterSpacing: '0.08em' }, children: 'FACT CHECKER' } },
          { type: 'div', props: { style: { display: 'flex', padding: '4px 12px', backgroundColor: '#334155', borderRadius: '4px' }, children: { type: 'div', props: { style: { color: '#94a3b8', fontSize: '14px', fontWeight: 600 }, children: 'BETA' } } } },
        ],
      },
    },
    // Subheader
    { type: 'div', props: { style: { color: '#64748b', fontSize: '14px', marginTop: '-4px' }, children: 'POWERED BY GOOGLE FACT CHECK API' } },
    // Divider
    { type: 'div', props: { style: { width: '100%', height: '2px', backgroundColor: '#1e293b', margin: '16px 0' } } },
    // Verdict badge
    {
      type: 'div',
      props: {
        style: { display: 'flex', alignItems: 'center', gap: '16px', marginBottom: '8px' },
        children: [
          { type: 'div', props: { style: { display: 'flex', padding: '6px 20px', backgroundColor: vc.bg, borderRadius: '6px' }, children: { type: 'div', props: { style: { color: vc.text, fontSize: '20px', fontWeight: 700, letterSpacing: '0.05em' }, children: vc.label } } } },
          ...(data.timecode ? [{ type: 'div', props: { style: { color: '#64748b', fontSize: '16px' }, children: data.timecode } }] : []),
        ],
      },
    },
    // Claim card
    {
      type: 'div',
      props: {
        style: { display: 'flex', flexDirection: 'column', padding: '24px 32px', backgroundColor: '#1e293b', borderRadius: '12px', borderLeft: '4px solid #475569', gap: '4px' },
        children: [
          { type: 'div', props: { style: { color: '#94a3b8', fontSize: '14px', fontWeight: 700, letterSpacing: '0.08em' }, children: 'CLAIM' } },
          { type: 'div', props: { style: { color: '#e2e8f0', fontSize: '26px', lineHeight: '1.4' }, children: data.claim.slice(0, 484) } },
        ],
      },
    },
  ];

  // Corrected claim (for false/misleading)
  if (data.correctedClaim && data.verdict.toLowerCase() !== 'true') {
    children.push({
      type: 'div',
      props: {
        style: { display: 'flex', flexDirection: 'column', padding: '24px 32px', backgroundColor: '#1e293b', borderRadius: '12px', borderLeft: '4px solid #22c55e', gap: '4px', marginTop: '12px' },
        children: [
          { type: 'div', props: { style: { color: '#94a3b8', fontSize: '14px', fontWeight: 700, letterSpacing: '0.08em' }, children: 'ACTUAL' } },
          { type: 'div', props: { style: { color: '#e2e8f0', fontSize: '24px', lineHeight: '1.4' }, children: data.correctedClaim.slice(0, 484) } },
        ],
      },
    });
  }

  // Summary
  if (data.summary) {
    children.push({
      type: 'div',
      props: {
        style: { color: '#cbd5e1', fontSize: '20px', lineHeight: '1.5', marginTop: '16px', padding: '0 8px' },
        children: data.summary.slice(0, 484),
      },
    });
  }

  // Confidence bar
  if (data.confidence !== null && data.confidence !== undefined) {
    children.push(confidenceBar(data.confidence));
  }

  // Sources
  if (sourceNodes.length > 0) {
    children.push({
      type: 'div',
      props: {
        style: { display: 'flex', flexDirection: 'column', gap: '6px', marginTop: '16px' },
        children: [
          { type: 'div', props: { style: { color: '#64748b', fontSize: '13px', fontWeight: 700, letterSpacing: '0.08em' }, children: 'SOURCES' } },
          ...sourceNodes,
        ],
      },
    });
  }

  return {
    type: 'div',
    props: {
      style: {
        display: 'flex',
        flexDirection: 'column',
        width: '1920px',
        height: '1080px',
        padding: '60px 80px',
        backgroundColor: '#0f172a',
        fontFamily: 'Roboto, sans-serif',
      },
      children,
    },
  };
}
