export function formatRelativeTimeShort(dateInput: string | Date) {
  const date = typeof dateInput === "string" ? new Date(dateInput) : dateInput;
  const diffMs = Date.now() - date.getTime();
  if (!Number.isFinite(diffMs)) {
    return "";
  }
  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 60) return 'now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  const weeks = Math.floor(days / 7);
  if (weeks < 4) return `${weeks}w`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo`;
  const years = Math.floor(days / 365);
  return `${years}y`;
}

// Drive-style timestamp: relative within the last day (now/12m/5h), then an
// exact calendar date once older than a day ("Jun 1", or "Apr 15, 2025" when
// the year differs from now).
export function formatDriveDate(dateInput: string | Date) {
  const date = typeof dateInput === 'string' ? new Date(dateInput) : dateInput;
  const ms = date.getTime();
  if (!Number.isFinite(ms)) return '';
  const diffMs = Date.now() - ms;
  const oneDay = 24 * 60 * 60 * 1000;
  if (diffMs < oneDay) return formatRelativeTimeShort(date);
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' }),
  });
}

export function formatCompactNumber(value?: number | null) {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return "0";
  }
  return new Intl.NumberFormat("en-US", {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(value);
}
