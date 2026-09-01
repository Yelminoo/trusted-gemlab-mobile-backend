// Mirrors web-internal/gv-certificate/src/lib/memberId.ts exactly — kept in
// sync manually. Member ID is derived from Customer.id, not a stored column.
const PREFIX = 'TGL-';
const PAD_LENGTH = 6;

export function formatMemberId(customerId: number): string {
  return `${PREFIX}${String(customerId).padStart(PAD_LENGTH, '0')}`;
}

// Returns the numeric customer id if the string is a valid member ID
// ("TGL-000007" or bare "7"/"000007"), otherwise null.
export function parseMemberId(value: string): number | null {
  const trimmed = value.trim();
  const withoutPrefix = trimmed.toUpperCase().startsWith(PREFIX)
    ? trimmed.slice(PREFIX.length)
    : trimmed;
  if (!/^\d+$/.test(withoutPrefix)) {
    return null;
  }
  const id = parseInt(withoutPrefix, 10);
  return Number.isInteger(id) && id > 0 ? id : null;
}
