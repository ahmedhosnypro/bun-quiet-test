export function capitalize(text: string): string {
  if (text.length === 0) return text;
  return text[0]!.toUpperCase() + text.slice(1).toLowerCase();
}

export function truncate(text: string, maxLength: number): string {
  if (maxLength <= 0) throw new Error("maxLength must be positive");
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 1)}…`;
}

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
