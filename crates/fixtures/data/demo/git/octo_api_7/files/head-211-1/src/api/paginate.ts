export function paginate(items: Item[], cursor: number, limit: number) {
  const page = items.slice(cursor, cursor + limit);
  const next = cursor + limit;
  return { page, next: next < items.length ? next : null };
}
