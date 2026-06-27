/**
 * ServiceIcon - AWS-style service glyphs in the official AWS category colors.
 * Recognizable, dependency-free SVGs (no emoji). For pixel-exact official marks,
 * vendor the AWS Architecture Icons package and swap the glyph paths here.
 * @module components/ServiceIcon
 */

// AWS Architecture category colors
const STORAGE = '#7AA116';     // green
const COMPUTE = '#ED7100';     // orange
const SECURITY = '#DD344C';    // red
const DATABASE = '#527FFF';    // blue
const INTEGRATION = '#E7157B'; // pink
const GENERAL = '#5F6B7A';     // grey

const META = {
  s3: { color: STORAGE, label: 'S3' },
  ec2: { color: COMPUTE, label: 'EC2' },
  lambda: { color: COMPUTE, label: 'λ' },
  iam: { color: SECURITY, label: 'IAM' },
  rds: { color: DATABASE, label: 'RDS' },
  dynamodb: { color: DATABASE, label: 'DDB' },
  sns: { color: INTEGRATION, label: 'SNS' },
  sqs: { color: INTEGRATION, label: 'SQS' },
};

const ServiceIcon = ({ service, size = 22 }) => {
  const m = META[service] || { color: GENERAL, label: (service || '?').slice(0, 3).toUpperCase() };
  const fontSize = m.label.length > 2 ? size * 0.38 : size * 0.5;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 40 40"
      role="img"
      aria-label={`${service || 'resource'} icon`}
      style={{ flexShrink: 0, verticalAlign: 'middle' }}
    >
      <defs>
        <linearGradient id={`g-${service}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={m.color} stopOpacity="0.92" />
          <stop offset="100%" stopColor={m.color} />
        </linearGradient>
      </defs>
      <rect x="1" y="1" width="38" height="38" rx="7" fill={`url(#g-${service})`} />
      <text
        x="20" y="21"
        textAnchor="middle"
        dominantBaseline="central"
        fontFamily="'Amazon Ember', Arial, sans-serif"
        fontWeight="700"
        fontSize={fontSize}
        fill="#ffffff"
      >
        {m.label}
      </text>
    </svg>
  );
};

export default ServiceIcon;
