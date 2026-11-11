/** A stable, case-insensitive key whose byte order compares digit runs numerically. */
export function naturalSortKey(value: string): string {
  return value.toLocaleLowerCase().replace(/\d+/gu, (digits) => {
    const significant = digits.replace(/^0+(?=\d)/u, '');
    return `${String(significant.length).padStart(5, '0')}:${significant}:${String(digits.length).padStart(5, '0')}`;
  });
}

const naturalCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
export function compareNaturalNames(left: string, right: string): number {
  return naturalCollator.compare(left, right) || left.localeCompare(right);
}
