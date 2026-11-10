export function accessibleExpenseGroupFilter(userId: string, participantGroupIds: readonly string[]) {
  const ownerFilter = `user_id.eq.${userId}`;
  const ids = [...new Set(participantGroupIds)];
  return ids.length ? `${ownerFilter},id.in.(${ids.join(",")})` : ownerFilter;
}
