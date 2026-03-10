export function tokenize(text: string): string[] {
  return Array.from(text.toLowerCase().matchAll(/[a-z0-9_]+/g), (match) => match[0]).filter(Boolean);
}
