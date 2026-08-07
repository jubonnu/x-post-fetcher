const LABEL_BY_STATUS: Record<string, string> = {
  approved: "承認済み",
  rejected: "却下済み",
  extracted: "要確認",
  conflicting: "要確認（矛盾あり）",
  needs_review: "要確認",
};

const CLASS_BY_STATUS: Record<string, string> = {
  approved: "approved",
  rejected: "rejected",
};

export function VerificationBadge({ status }: { status: string | null }) {
  const key = status ?? "extracted";
  const label = LABEL_BY_STATUS[key] ?? "要確認";
  const className = CLASS_BY_STATUS[key] ?? "needs-review";
  return <span className={`badge ${className}`}>{label}</span>;
}
