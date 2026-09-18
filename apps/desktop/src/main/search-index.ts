export function normalizeSearchText(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase().replace(/\s+/gu, ' ').trim();
}

export function tokenizeSearchText(value: string): string[] {
  const tokens = new Set<string>();
  for (const segment of normalizeSearchText(value).match(/[\p{Letter}\p{Number}]+/gu) ?? []) {
    if (/\p{Script=Han}/u.test(segment)) {
      const characters = [...segment];
      for (let size = 1; size <= Math.min(4, characters.length); size += 1) {
        for (let index = 0; index <= characters.length - size; index += 1) {
          tokens.add(characters.slice(index, index + size).join(''));
        }
      }
    } else {
      tokens.add(segment);
    }
  }
  return [...tokens];
}
