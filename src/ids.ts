export function isId(id: string): boolean {
  return /^[A-Za-z0-9_-]{1,80}$/.test(id);
}

export function isMeterId(meterId: string): boolean {
  return /^[A-Za-z0-9_.-]{1,80}$/.test(meterId);
}
